/**
 * GLSL (fragmenty) efektu `speedpaint`: nagłówek z uniformami/hashami/czasem lokalnym oraz
 * ewaluacja warstwy pociągnięć. Składane w `shaders.ts` → SP_FRAG.
 *
 * Czas LOKALNY (v2, po krytyce): etap k zaczyna się w danym miejscu w
 *   start_k(uv) = hold + T(uv)·spread + k·delay,  trwa lokalnie dur (detal 1.4×),
 * gdzie T = wyrównane histogramem pole kolejności (order.ts). Żaden etap nie jest globalny.
 */

export const SP_HEAD = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_sketch;
uniform sampler2D u_painted;
uniform sampler2D u_field;   // rg orientacja (podwójny kąt), b krawędzie, a światło
uniform sampler2D u_kuwA;    // Kuwahara ¼ (duże formy)
uniform sampler2D u_kuwB;    // Kuwahara ½ (średnie formy)
uniform sampler2D u_order;   // r = T (wyrównane), g = min T w zasięgu pociągnięć (wczesny odrzut)
uniform vec2 u_view;
uniform vec2 u_res;
uniform float u_p;
uniform int u_stages;
uniform float u_brush;
uniform float u_elong;
uniform float u_dir;
uniform float u_flat;
uniform float u_detailLag;   // opóźnienie świateł w lokalnym etapie detalu
uniform float u_lineErase;   // siła linii szkicu na podmalówce
uniform float u_rhythm;
uniform float u_seed;
uniform float u_texture;
uniform float u_hold;
uniform float u_spread;
uniform float u_delay;
uniform float u_dur;
uniform sampler2D u_tabA;    // tablica pociągnięć (strokeTable.ts): jitter, kąt, T
uniform sampler2D u_tabB;    // hl, hw, id, seria
uniform sampler2D u_orderMin; // min T w zasięgu warstwy: r = detal, g = N−2, b = N−3, a = N−4 (order.ts)
uniform int u_rowOff[6];
uniform int u_cols[6];
uniform int u_rows[6];
const int TAB_MARGIN = 3;
out vec4 o;

const float PI = 3.14159265;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + u_seed * 0.0137);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + u_seed * 0.0219);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise1(float x, float s) {
  float i = floor(x), f = fract(x);
  float a = hash12(vec2(i, s)), b = hash12(vec2(i + 1.0, s));
  return mix(a, b, f * f * (3.0 - 2.0 * f));
}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Nierówny rytm: monotoniczna deformacja czasu (pochodna >= 1 - 0.8·rhythm > 0), warp(1) = 1.
float warpTime(float p) {
  float r = 0.8 * u_rhythm;
  float ph = fract(u_seed * 0.371) * 6.2831;
  float f = 7.0;
  return p + r * (sin(2.0 * PI * f * p + ph) - sin(ph)) / (2.0 * PI * f);
}

// Front blokowania jest szybszy (0.55·spread) niż front detalu (spread): płótno szybciej pokryte plamami,
// detal i tak idzie lokalnie za formami. Monotoniczne w k → etapy nigdy się nie wyprzedzają.
float stageSpread(int k) { return u_spread * mix(0.55, 1.0, float(k) / max(1.0, float(u_stages - 1))); }
float stageStart(float T, int k) { return u_hold + T * stageSpread(k) + float(k) * u_delay; }
float stageDur(int k) { return k == u_stages - 1 ? u_dur * 1.4 : u_dur; }
float layerCell(int k) { return max(u_brush * pow(0.5, float(k)), 5.0); }
`;

export const SP_LAYER = /* glsl */ `
// Kolor pociągnięcia warstwy podmalówki (k < N-1): JEDEN na pociągnięcie (+ gradient wzdłuż osi).
vec3 strokeColor(int k, vec2 site, vec2 ax, float hl, float nu, out vec3 raw) {
  float c = layerCell(k);
  vec2 suv = site / u_res;
  vec3 flatC = textureLod(u_painted, suv, log2(c) - 0.3).rgb;
  vec2 a = (site - ax * hl * 0.6) / u_res, b = (site + ax * hl * 0.6) / u_res;
  float t = clamp(nu * 0.5 + 0.5, 0.0, 1.0);
  float f = clamp((float(k) - 1.0) / max(1.0, float(u_stages) - 3.0), 0.0, 1.0);
  vec3 ka = mix(texture(u_kuwA, a).rgb, texture(u_kuwB, a).rgb, f);
  vec3 kb = mix(texture(u_kuwA, b).rgb, texture(u_kuwB, b).rgb, f);
  vec3 grad = mix(ka, kb, t);
  float fl = u_flat * (1.0 - 0.8 * float(k) / max(1.0, float(u_stages - 2)));
  vec3 col = mix(grad, flatC, k == 0 ? max(fl, 0.75) : fl);
  raw = col;
  float l = lum(col);
  if (k == 0) {
    // etap 1 „płaskie średnie”: walory ściśnięte do średniej obrazu, przygaszony kolor —
    // jednolite masy bez światłocienia (jak tonowany podkład)
    float g = lum(textureLod(u_painted, vec2(0.5), 9.0).rgb);
    float l2 = mix(l, g, 0.45) * 1.1 + 0.015;
    col = mix(vec3(l), col, 0.7) * (l2 / max(l, 1e-3));
  } else {
    // etap 2 „światłocień”: duże walory z mocnym kontrastem wokół lokalnej średniej (+nasycenie);
    // dalsze etapy łagodniej
    float m = lum(textureLod(u_painted, suv, 5.0).rgb);
    float s = k == 1 ? 1.6 : 1.15;
    vec3 sat = mix(vec3(l), col, k == 1 ? 1.15 : 1.0);
    col = max(sat + (m + (l - m) * s - l), 0.0);
  }
  // podmalówka trzyma światła: ostre jasne punkty dopiero w detalu
  float lf = lum(flatC);
  float hold = 0.7 * (1.0 - 0.6 * float(k) / max(1.0, float(u_stages - 2)));
  col *= mix(1.0, min(1.0, (lf * 1.35 + 0.04) / max(lum(col), 1e-4)), hold);
  return col;
}

// Kolor etapu detalu: ostrzy się w czasie lokalnym (mip 1.2 → 0); światła przytrzymane, potem rosną
// od rdzenia (jasne pierwsze) — lokalnie, po detalu regionu.
vec3 detailColor(vec2 uv, float p, float st, float W) {
  float q = clamp((p - st) / W, 0.0, 1.0);
  vec3 dc = textureLod(u_painted, uv, 1.2 * (1.0 - q)).rgb;
  float la = textureLod(u_field, uv, 1.0).a;
  float tl = st + W * 0.5 * u_detailLag + (1.0 - la) * 0.2 * W;
  float rel = smoothstep(0.0, 1.0, (p - tl) / (0.25 * W));
  float m = lum(textureLod(u_painted, uv, 4.0).rgb);
  vec3 held = dc * min(1.0, (m * 1.2 + 0.05) / max(lum(dc), 1e-4));
  return mix(held, dc, max(rel, 1.0 - la * 1.5));
}

// Ewaluacja warstwy k w pikselu: zwraca krycie (AA, narastające) i kolor (out col).
float layerEval(int k, vec2 px, vec2 uv, float p, float Tuv, out vec3 col) {
  bool detail = k == u_stages - 1;
  float c = layerCell(k);
  float W = stageDur(k);
  float dur = W * 0.3;
  float fk0 = float(k) / max(1.0, float(u_stages - 1));
  // kształt: etap 1 zaokrąglone, organiczne plamy (elipsa), detal — płaskie prostokątne pociągnięcia
  float pv = mix(2.6, 5.0, fk0), pu = mix(3.0, 6.0, fk0);
  float elong = u_elong * mix(0.65, 1.15, float(k) / max(1.0, float(u_stages - 1)));
  vec2 base = floor(px / c);
  // zasięg najdłuższego możliwego pociągnięcia tej warstwy → tani odrzut kandydatów (bez fetchy/atan)
  float hlMax = min(c * elong * 0.625, 2.0 * c), hwMax = c * 0.5 * mix(1.45, 1.2, fk0);
  float reach2 = hlMax * hlMax + hwMax * hwMax + 4.0;
  float fk = clamp((float(k) - 1.0) / max(1.0, float(u_stages) - 3.0), 0.0, 1.0);
  vec3 kPix = vec3(0.0);
  if (k >= 1 && !detail) kPix = mix(texture(u_kuwA, uv).rgb, texture(u_kuwB, uv).rgb, fk);
  // detal już domknięty laserunkiem → krycie 1 bez pętli pociągnięć (wynik identyczny: max(·, 1) = 1)
  float stD = stageStart(Tuv, k);
  float glaze = smoothstep(stD + 0.6 * W, stD + W, p);
  if (detail && glaze >= 1.0) { col = detailColor(uv, p, stD, W); return 1.0; }
  float tau = mix(0.35, 0.15, fk);
  float bestT = -1.0, bestCov = 0.0, trans = 1.0;
  vec2 wSite = vec2(0.0), wAx = vec2(1.0, 0.0);
  float wHl = 1.0, wNu = 0.0, wNv = 0.0, wId = 0.0;
  float nearD = 1e9, nearT = 1e9, nearHl = 1.0, nearNu = 0.0; vec2 nearSite = vec2(0.0), nearAx = vec2(1.0, 0.0);
  // Fala 2 (bezstratnie): tylko komórki, których pole miejsc (cid + [0.05, 0.95])·c leży w zasięgu (+0.5 px
  // zapasu na zaokrąglenia) — pominięte i tak odpadłyby na teście dot(d,d) > reach2; kolejność pozostałych ta sama.
  float R = sqrt(reach2) + 0.5;
  ivec2 lo = clamp(ivec2(ceil((px - R) / c - 0.95) - base), ivec2(-2), ivec2(2));
  ivec2 hi = clamp(ivec2(floor((px + R) / c - 0.05) - base), ivec2(-2), ivec2(2));
  for (int j = lo.y; j <= hi.y; j++) {
    float gy = max(max((base.y + float(j) + 0.05) * c - px.y, px.y - (base.y + float(j) + 0.95) * c) - 0.5, 0.0);
    for (int i = lo.x; i <= hi.x; i++) {
      vec2 cid = base + vec2(float(i), float(j));
      float gx = max(max((cid.x + 0.05) * c - px.x, px.x - (cid.x + 0.95) * c) - 0.5, 0.0);
      if (gx * gx + gy * gy > reach2) continue;
      ivec2 tc = clamp(ivec2(cid) + TAB_MARGIN, ivec2(0), ivec2(u_cols[k] - 1, u_rows[k] - 1));
      tc.y += u_rowOff[k];
      vec4 A = texelFetch(u_tabA, tc, 0);
      vec2 site = (cid + 0.05 + 0.9 * A.rg) * c;
      vec2 d = px - site;
      if (dot(d, d) > reach2) continue;
      vec4 B = texelFetch(u_tabB, tc, 0);
      vec2 suv = site / u_res;
      // start pociągnięcia = lokalny start etapu w miejscu pociągnięcia + seria w klastrze
      float t0 = stageStart(A.a, k) + W * B.a * 0.65;
      // detal nie używa kandydatów domknięcia dziur (near*) → nierozpoczęte odpadają przed kształtem (bezstratnie)
      if (detail && t0 > p) continue;
      float ang = A.b * PI;
      vec2 ax = vec2(cos(ang), sin(ang));
      float u = dot(d, ax), v = dot(d, vec2(-ax.y, ax.x));
      float hl = B.r * 2.0 * c, hw = B.g * c;
      float nu = u / hl, nv = v / hw;
      float id = B.b * 100.0;
      float endL = 1.0 - 0.12 * vnoise1(nv * 4.0 + id, id);
      float dist = pow(abs(nv), pv) + pow(abs(nu) / endL, pu);
      // domknięcie dziur: NAJBLIŻSZE pociągnięcie spośród wszystkich (także nierozpoczętych) —
      // inaczej granica wypełnienia szła po krawędziach okna 5×5 komórek (proste cięcia)
      if (dist < nearD) { nearD = dist; nearT = t0 + dur; nearSite = site; nearAx = ax; nearHl = hl; nearNu = clamp(nu, -1.0, 1.0); }
      if (t0 > p) continue;   // nierozpoczęte: tylko kandydat do domknięcia dziur
      float e = 1.2 * pv / hw;
      float covS = 1.0 - smoothstep(1.0 - e, 1.0 + e, dist);
      if (covS <= 0.0) continue;   // nie pokrywa piksela → bez kosztu głowicy i koloru
      // płaskie czoło głowicy (prostopadłe do osi) z lekką falą włosia
      float sgn = fract(B.b * 7.31) < 0.5 ? -1.0 : 1.0;
      float s = (nu * sgn + 1.0) * 0.5 + 0.02 * (vnoise1(nv * 6.0, id + 3.0) - 0.5) + 0.25 * (1.0 - fk0) * nv * nv;
      float covH = clamp((p - t0 - dur * clamp(s, 0.0, 1.0)) / (dur * 1.5 / (2.0 * hl)) + 0.5, 0.0, 1.0);
      float cov = covS * covH;
      if (cov <= 0.0) continue;
      if (detail) {
        trans *= 1.0 - 0.55 * cov;   // krycie narastające 1 − 0.45^n
        continue;
      }
      // Hertzmann: pociągnięcie nie przechodzi przez krawędź koloru (etapy 2+); tani test 1 fetchem,
      // pełny kolor liczony raz, po pętli, tylko dla zwycięzcy (swiftshader wykonuje gałęzie maskami)
      if (k >= 1) {
        vec3 ks = mix(textureLod(u_kuwA, suv, 0.0).rgb, textureLod(u_kuwB, suv, 0.0).rgb, fk);
        cov *= 1.0 - smoothstep(tau, tau * 1.4, length(kPix - ks));
      }
      if (cov > 0.02) {
        if ((t0 > bestT && cov > 0.5) || (bestT < 0.0 && cov > bestCov)) {
          if (cov > 0.5) bestT = t0;
          wSite = site; wAx = ax; wHl = hl; wNu = clamp(nu, -1.0, 1.0); wNv = nv; wId = id;
        }
        bestCov = max(bestCov, cov);
      }
    }
  }
  if (detail) {
    col = detailColor(uv, p, stD, W);
    return max(1.0 - trans, glaze);
  }
  if (bestCov <= 0.02 && nearT > p) { col = vec3(0.0); return 0.0; }
  if (bestCov < 0.5 && nearT <= p) {   // domknięcie dziur
    vec3 raw;
    col = strokeColor(k, nearSite, nearAx, nearHl, nearNu, raw);
    return 1.0;
  }
  vec3 raw;
  col = strokeColor(k, wSite, wAx, wHl, wNu, raw);
  // faktura włosia ∝ (1 − płaskość), drobniejsza z etapem
  float bristle = vnoise1(wNv * 16.0, wId) * 0.6 + vnoise1(wNv * 5.0, wId + 7.0) * 0.4;
  float edge = smoothstep(0.55, 1.0, abs(wNv));
  float amp = u_texture * (1.0 - 0.6 * u_flat) * (k <= 1 ? 1.0 : 0.5);
  col *= 1.0 + amp * ((bristle - 0.5) * 0.16 - 0.05 * edge) + 0.04 * u_texture * (hash12(vec2(wId, 2.0)) - 0.5);
  return bestCov;
}
`;

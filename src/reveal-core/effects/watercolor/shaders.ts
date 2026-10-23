/**
 * Główny fragment shader efektu `watercolor` (akwarela: plamy, laserunki walorowe, detal).
 *
 * Czas LOKALNY (bez „fali za falą”): start_k(uv) = HOLD + Tb(uv)·SP_k + k·D + j_k(uv), gdzie Tb =
 * wyrównana histogramem kolejność z CPU (u_field.r), j_k = niezależny szum opóźnienia per laserunek,
 * SP ≥ 3D → w środku animacji 3–4 etapy naraz w różnych miejscach. Stos monotoniczny:
 * cov_k ≤ covRaw_{k−1}. Gdzie warstwa wpada na mokrą poprzednią — wet-on-wet: miękki brzeg, bez rantu.
 * Plamy: w komórce S_k jeden zalążek, start t0 = start_k(zalążek), promień R·s^0.65.
 * Kolor w log-transmitancji: acc += cov·(G_k − acc); jasność ×f_k, chroma zachowana; ostatnia
 * warstwa = L(lod 2→0 lokalnie) → przy p→1 dokładnie painted. Bezstanowo → skrubowalne.
 * Papier: wspólny sterownik reveal-core/paper.ts — biel transmitancji PAPER = tint·M per piksel (papier prześwieca
 * przez laserunki), goły papier = szkic·tint·M od p=0 (bez rampy), relief granulacji tylko pod farbą.
 */
import { PAPER_TEX_GLSL } from "../../paper";
import { WC_NOISE } from "./glslCommon";
import { WC_SEED_COMMON, WC_SEED_FETCH } from "./seeds";

export const WC_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_sketch;
uniform sampler2D u_painted;   // z mipmapami
uniform sampler2D u_paper;     // r = wysokość, gb = gradient, a = szum strzępienia
uniform sampler2D u_field;     // r = Tb, gb = warp
uniform vec2 u_view;
uniform vec2 u_res;
uniform float u_p;
uniform int u_layers;
uniform float u_wet, u_bleed, u_edge, u_gran, u_blooms, u_drying, u_blob, u_lines, u_seed;
uniform float u_hold, u_SP0, u_SP, u_D, u_J, u_Wloc;
uniform float u_thr[4];        // progi V laserunków środkowych (kwantyle)
uniform vec2 u_origin;
uniform int u_debug;           // 1 = mapa etapów (pomiary), 2 = licznik warstw (R = liczone, G = bez skrótów fali 2) / 8
uniform sampler2D u_minTb;     // dolne ograniczenie Tb w zasięgu zalążków warstw 1..4 (RGBA) — wczesny odrzut
uniform int u_prune;           // 1 = przycinanie pierścienia zalążków (późna faza; wybór nie zmienia wyniku)
uniform int u_quality;         // 0 high (referencja), 1 medium
uniform sampler2D u_maxA;      // fala 2: max Tb w zasięgu zalążków warstw 0..3 (fields.ts boundFields)
uniform sampler2D u_maxB;      // r,g = max Tb warstw 4,5
uniform highp usampler2D u_seeds;  // zalążki per komórka (seeds.ts), bitowo
uniform ivec4 u_seedGrid[6];
out vec4 o;

${PAPER_TEX_GLSL}
vec3 PAPER = vec3(1.0);   // biel transmitancji = papier pod szkicem (paperUnder(M)), ustawiana na starcie main()
${WC_NOISE}

vec3 logT(vec2 uv, float lod) {
  vec3 c = textureLod(u_painted, uv, lod).rgb;
  return log(clamp(c / PAPER, vec3(0.012), vec3(1.25)));
}
float mean3(vec3 v) { return (v.r + v.g + v.b) / 3.0; }

${WC_SEED_COMMON}
${WC_SEED_FETCH}
int nSeeds = 0;   // licznik (u_debug = 2)
// m zalążka komórki c warstwy k (jedno miejsce w kodzie → ta sama arytmetyka w obu przebiegach layer()).
float seedM(int k, vec2 c, vec2 q, float R, float dur, float t, out vec2 sp, out float t0, out float T) {
  vec2 a2, a3;
  nSeeds++;
  fetchSeed(k, c, sp, t0, a2, a3);              // = computeSeed(k, c, …), policzone raz (seeds.ts)
  vec2 dv = q - sp;
  float len = length(dv) + 1e-4;
  vec2 n = dv / len;
  // Nieregularny kształt bez trygonometrii: harmoniczne 2 i 3 kąta z losową fazą.
  float c2 = n.x * n.x - n.y * n.y, s2 = 2.0 * n.x * n.y;
  float c3 = n.x * (4.0 * n.x * n.x - 3.0), s3 = n.y * (3.0 - 4.0 * n.y * n.y);
  float shape = 1.0 + 0.26 * dot(vec2(c2, s2), a2) + 0.16 * dot(vec2(c3, s3), a3);
  float d = len / shape;
  float s = clamp((t - t0) / dur, 0.0, 1.0);
  T = t0 + dur * pow(min(d / R, 2.0), 1.5385);
  return s > 0.0 ? R * pow(s, 0.65) - d : -1e4 - d;   // ~dyfuzja: szybko, potem wolniej
}
// Top-2 wg (m malejąco, indeks w skanie 5×5 rosnąco) = wynik oryginalnego skanu ze ścisłym „>” (remisy: wcześniejszy).
void topTwo(float m, int idx, float t0, float T, vec2 c, vec2 sp,
            inout float m1, inout int i1, inout float T1, inout float t01, inout vec2 c1, inout vec2 s1,
            inout float m2, inout int i2, inout float T2) {
  if (m > m1 || (m == m1 && idx < i1)) {
    m2 = m1; T2 = T1; i2 = i1;
    m1 = m; i1 = idx; T1 = T; t01 = t0; c1 = c; s1 = sp;
  } else if (m > m2 || (m == m2 && idx < i2)) {
    m2 = m; i2 = idx; T2 = T;
  }
}
struct Lay { float cov; float wet; float ring; float overlap; float bloomIn; float bloomEdge; float T1; };

Lay layer(int k, vec2 px, vec2 uv, float t, float hgt, vec2 warp, float feather, float wetPrev) {
  Lay r = Lay(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  bool detail = k == u_layers - 1;
  float S = cellSize(k);
  float R = S * 1.7;
  float Wk = winK(k);
  float dur = Wk * mix(0.35, 0.6, u_wet);
  vec2 lw = vec2(vnoise(px / (0.45 * S) + float(k) * 13.1), vnoise(px / (0.45 * S) + float(k) * 13.1 + 41.0)) - 0.5;
  vec2 q = px + warp * S * 0.8 + lw * S * 0.3;
  vec2 cell = floor(q / S);
  float m1 = -1e9, m2 = -1e9, T1 = 0.0, T2 = 0.0, t01 = 0.0;
  vec2 c1 = vec2(0.0), s1 = vec2(0.0);
  int i1 = 99, i2 = 99;
  float sk = startK(k, uv);
  if (u_prune == 0 || t < sk) {
    // Przed lokalnym startem warstwy pierścienia i tak zwykle nie da się pominąć (zalążki nie ruszyły, m ≈ −1e4) →
    // oryginalny skan 5×5 (bez narzutu topTwo). Obie gałęzie dają ten sam top-2 → wybór gałęzi nie zmienia wyniku.
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        vec2 c = cell + vec2(i, j), sp;
        float t0, T;
        float m = seedM(k, c, q, R, dur, t, sp, t0, T);
        if (m > m1) { m2 = m1; T2 = T1; m1 = m; T1 = T; t01 = t0; c1 = c; s1 = sp; }
        else if (m > m2) { m2 = m; T2 = T; }
      }
    }
  } else {
  // Fala 2 (BEZSTRATNIE). Oryginał: skan 5×5 wierszami ze ścisłym „>” = top-2 wg klucza (m malejąco, indeks rosnąco).
  // Ten sam top-2 przy dowolnej kolejności → najpierw środek 3×3, potem pierścień zewnętrzny, który pomijamy w całości
  // (break pętli — SwiftShader/GPU naprawdę wtedy nie liczą), gdy żaden jego zalążek nie może wejść do top-2:
  // m ≤ R − |q − sp|/shape, shape ≤ 1 + 0.42·√0.5 = 1.29698 < 1.2975, a pole zalążka pierścienia (0.1..0.9 komórki ±2)
  // leży ≥ minGap od q. Gdy R − minGap/1.2975 + 0.01 < m2 (po środku) — pierścień nic nie zmienia.
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(i, j), sp;
      float t0, T;
      float m = seedM(k, c, q, R, dur, t, sp, t0, T);
      topTwo(m, (j + 2) * 5 + i + 2, t0, T, c, sp, m1, i1, T1, t01, c1, s1, m2, i2, T2);
    }
  }
  vec2 fq = q / S - cell;
  float minGap = min(min(fq.x + 1.1, 2.1 - fq.x), min(fq.y + 1.1, 2.1 - fq.y)) * S;
  for (int once = 0; once < 1; once++) {
    if (R - minGap / 1.2975 + 0.01 < m2) break;
    for (int n = 0; n < 16; n++) {            // pierścień: wiersze j = ±2 (10), potem kolumny i = ±2, j = −1..1 (6)
      int i = n < 10 ? n % 5 - 2 : (n < 13 ? -2 : 2);
      int j = n < 5 ? -2 : (n < 10 ? 2 : (n < 13 ? n - 11 : n - 14));
      vec2 c = cell + vec2(i, j), sp;
      float t0, T;
      float m = seedM(k, c, q, R, dur, t, sp, t0, T);
      topTwo(m, (j + 2) * 5 + i + 2, t0, T, c, sp, m1, i1, T1, t01, c1, s1, m2, i2, T2);
    }
  }
  }
  float dryT = dur * mix(0.5, 1.6, u_wet);
  float age = t - T1;
  r.T1 = T1;
  r.wet = step(0.0, age) * (1.0 - smoothstep(0.0, dryT, age));
  float edgePx = u_res.y * 0.0045;
  float bl = u_bleed * (1.0 + wetPrev);
  m1 += (hgt - 0.5) * edgePx * 2.0 + (feather - 0.5) * r.wet * bl * S * 0.16;
  float soft = mix(0.8, 0.9 + u_res.y * 0.028 * u_bleed, r.wet * r.wet) * mix(1.0, 2.5, wetPrev);
  if (detail) soft = max(soft, S * 0.12);
  r.cov = smoothstep(-soft, soft * 0.25, m1);
  // Kieszenie dopełniane LOKALNIE (od startu warstwy w tym pikselu), nie globalnym zdarzeniem.
  r.cov = max(r.cov, smoothstep(sk + Wk - 0.03, sk + Wk, t));
  float ew = edgePx * mix(1.0, 2.2, u_wet);
  float settle = 0.35 + 0.65 * (1.0 - r.wet);
  float noEdge = (1.0 - wetPrev) * (detail ? 0.3 : 1.0);
  r.ring = exp(-max(m1, 0.0) / ew) * settle * r.cov * noEdge;
  float hard = smoothstep(0.25, 0.9, abs(T1 - T2) / dryT);
  float cov2 = smoothstep(-0.8, 0.2, m2);
  r.overlap = cov2 * hard * noEdge;
  r.ring = max(r.ring, exp(-max(m2, 0.0) / ew) * cov2 * hard * settle * noEdge);
  // Kwiat (backrun) — głównie w washu i dużych laserunkach: kropla w półsuchej plamie.
  float bp = u_blooms * (k <= 1 ? 0.5 : 0.15);
  if (!detail && h12(c1 + float(k) * 3.1 + 11.0) < bp) {
    vec2 bc = s1 + (h22(c1 + 27.0) * 2.0 - 1.0) * R * 0.25;
    float tb = t01 + dur * 0.5 + dryT * 0.3;
    float sb = clamp((t - tb) / (dur * 0.8), 0.0, 1.0);
    float rb = R * mix(0.18, 0.35, h12(c1 + 5.0)) * sqrt(sb);
    float db = distance(q, bc) * (0.8 + 0.5 * ridged(q / (S * 0.07) + float(k)));
    float mb = rb - db;
    float bin = smoothstep(-1.5, 1.5, mb) * step(0.0001, sb);
    r.bloomIn = bin * r.cov;
    r.bloomEdge = exp(-max(mb, 0.0) / (ew * 2.5)) * bin * r.cov;
  }
  return r;
}

float capK(int k) { return 0.965 - winK(u_layers - 1) - float(u_layers - 1 - k) * 0.02; }
// Fala 2: górna granica t, od której warstwa k jest w tym pikselu na pewno sucha (wet = 0 dokładnie): T1 ≤ t0max +
// dur·2^1.5385 (2.9048 < 2.91), t0 ≤ startK(maxTb) + 0.25·(Wk − dur), wet = 0 gdy t − T1 ≥ dryT. Zapas 1e-4 ≫ ulp.
float dryAt(int k, float maxTb) {
  float Wk = winK(k);
  float dur = Wk * mix(0.35, 0.6, u_wet);
  float t0 = min(capK(k), u_hold + maxTb * (k == 0 ? u_SP0 : u_SP) + float(k) * u_D + u_J * (k == 0 ? 0.5 : 1.0));
  return t0 + 0.25 * (Wk - dur) + 2.91 * dur + dur * mix(0.5, 1.6, u_wet) + 1e-4;
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_view.x, 1.0 - gl_FragCoord.y / u_view.y);
  vec2 px = uv * u_res;
  float p = clamp(u_p, 0.0, 1.0);
  float t = mix(p, p * p * (3.0 - 2.0 * p), 0.1);
  float ppM = paperMod(px);
  PAPER = paperUnder(ppM);
  // p=0: szkic na wspólnym papierze + dither — bez liczenia warstw (to samo, co goły papier przy t>0).
  if (t <= 0.0 && u_debug == 0) {
    o = vec4(clamp(paperOver(texture(u_sketch, uv).rgb * PAPER, ppM) + (h12(px + 0.37) - 0.5) / 255.0, 0.0, 1.0), 1.0);
    return;
  }
  vec4 pap = texture(u_paper, uv);
  float hgt = pap.r, feather = pap.a;
  vec2 warp = texture(u_field, uv).gb;
  vec3 L0 = logT(uv, 0.0);
  // Rezerwa czystego pigmentu (neon, latarnia): wysokie S·V — malowane od razu czysto, nie z błota.
  vec3 c2 = textureLod(u_painted, uv, 2.0).rgb;
  float mx = max(c2.r, max(c2.g, c2.b));
  float nm = smoothstep(0.2, 0.38, (mx - min(c2.r, min(c2.g, c2.b))) * step(0.001, mx));
  // Walory: krawędź kształtu z lod 3.2, bramka z lod 4.6 (bez drobnych kleksów). Pochodne poza pętlą.
  float V = -mean3(logT(uv, 3.2)) + (feather - 0.5) * 0.22 + (hgt - 0.5) * 0.05;
  float Vg = -mean3(logT(uv, 4.6)) + (feather - 0.5) * 0.11;
  float Vw = max(fwidth(V), 1e-4);
  float Tdone = startK(u_layers - 1, uv) + winK(u_layers - 1);
  // Jakość medium (stratnie, PSNR ≥ 60 dB): po lokalnym końcu piksel = painted (high liczy to samo z błędem zaokrągleń).
  if (u_quality > 0 && u_debug == 0 && t >= Tdone + 0.03) { o = vec4(paperOver(textureLod(u_painted, uv, 0.0).rgb, ppM), 1.0); return; }
  ivec2 mtSize = textureSize(u_minTb, 0);
  ivec2 mtc = min(ivec2(uv * vec2(mtSize)), mtSize - 1);
  vec4 minTb = texelFetch(u_minTb, mtc, 0);
  float sLine = startK(min(1, u_layers - 1), uv);
  // Fala 2, skrót BEZSTRATNY „po końcu”: gdy po Tdone+0.03 (endFade = fin = 0) każda warstwa ma kieszeń domkniętą
  // (cov = 1) i jest na pewno sucha (wet = 0), wynik nie zależy od pętli 5×5 zalążków: z Lay idą tylko cov i wet
  // (ring/overlap/kwiaty → ext·endFade = 0, T1 → lod detalu ·fin = 0). Reszta arytmetyki bez zmian → bajt w bajt.
  bool dry = false;
  if (u_debug != 1 && t >= Tdone + 0.03 + 1e-4) {
    vec4 maxA = texelFetch(u_maxA, mtc, 0), maxB = texelFetch(u_maxB, mtc, 0);
    dry = true;
    for (int k = 0; k < 6; k++) {
      if (k >= u_layers) break;
      if (t < dryAt(k, k < 4 ? maxA[k] : maxB[k - 4]) || t < startK(k, uv) + winK(k) + 1e-4) { dry = false; break; }
    }
  }
  int nEval = 0, nOld = 0;

  vec3 acc = vec3(0.0), ext = vec3(0.0);
  float covAny = 0.0, wetAny = 0.0, covLast = 0.0, covPrev = 1.0, wetPrev = 0.0;
  int stage = 0, wet2 = 0;
  for (int k = 0; k < 6; k++) {
    if (k >= u_layers) break;
    // Wczesne odrzuty BEZSTRATNE: gdy warstwa pod spodem ma pokrycie 0, stos daje covRaw = 0 tej i każdej
    // następnej (acc, ext, covAny… bez zmian) → break. Gdy t < dolnej granicy startu wszystkich zalążków
    // w zasięgu (i kieszeni), pokrycie warstwy wynosi dokładnie 0 → to samo.
    if (covPrev <= 0.0) break;
    if (k >= 1 && k <= 4) {
      float cap = 0.965 - winK(u_layers - 1) - float(u_layers - 1 - k) * 0.02;
      float lb = clamp(u_hold + minTb[k - 1] * u_SP + float(k) * u_D - u_J, 0.0, cap);
      if (t < lb - 1e-4) break;
    }
    bool detail = k == u_layers - 1;
    float kf = float(k) / max(float(u_layers) - 1.0, 1.0);
    nOld++;
    Lay ly = Lay(1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    if (!dry) { ly = layer(k, px, uv, t, hgt, warp, feather, wetPrev); nEval++; }
    float covRaw = min(ly.cov, covPrev);          // stos: nie przed warstwą pod spodem
    float wetK = ly.wet * step(0.02, covRaw);
    if (covRaw > 0.5) stage++;
    if (wetK > 0.05 && wetPrev > 0.05) wet2 = 1;
    float S = cellSize(k);
    // Detal: lokalne wyostrzanie lod 2 → 0 po dotarciu (nie szablon ostrego obrazu w dziurach).
    float fin = detail ? 1.0 - smoothstep(Tdone - 0.03, Tdone + 0.03, t) : 1.0;
    float lod = detail ? 2.0 * (1.0 - smoothstep(ly.T1, ly.T1 + 0.5 * winK(k), t)) : 5.2 * pow(1.0 - kf, 1.2);
    lod += (ly.wet + wetPrev) * u_bleed * (detail ? 0.5 : 1.0);
    lod = mix(lod, min(lod, 1.0), nm) * fin;
    vec2 flow = warp * ly.wet * u_bleed * S * 0.3 / u_res * fin;
    vec3 raw = logT(uv + flow, lod);
    float m = mean3(raw);
    float f = 1.0, cb = 1.0;
    if (k == 0) {
      f = mix(0.85, 0.55, smoothstep(u_thr[0] - 0.5, u_thr[0], -m));   // światła = sam wash
      cb = 1.15;
    } else if (!detail) {
      f = mix(0.82, 0.92, float(k - 1) / max(float(u_layers) - 3.0, 1.0));
      cb = 1.08;
    }
    f = mix(f, 1.0, nm);
    vec3 G = f * m + (raw - m) * cb;                  // jasność ×f, chroma zachowana (c^f odbarwia)
    if (!detail) G = min(G, vec3(0.0));
    float cov = covRaw, edgeV = 0.0;
    if (!detail && k > 0) {
      float thr = u_thr[k - 1];
      float dpx = (V - thr) / Vw;
      float inV = smoothstep(-0.7, 0.7, dpx) * smoothstep(thr - 0.12, thr - 0.03, Vg);
      edgeV = inV * exp(-max(dpx, 0.0) / (u_res.y * 0.004 * mix(1.0, 2.0, u_wet)));
      cov *= inV;
      edgeV *= covRaw * (0.35 + 0.65 * (1.0 - ly.wet)) * (1.0 - wetPrev);
    }
    vec3 before = acc;
    acc += cov * (G - acc);
    vec3 A = max(-G, 0.0);
    float pig = max(0.18, mean3(A)) * mix(1.0, 0.55, kf) + 0.6 * abs(mean3(G - before));
    vec3 tint = normalize(A + 0.05) * 1.732;
    // Granulują pigmenty o wyraźnej barwie (ultramaryna/sepia), nie światła i neony.
    float granW = (0.4 + 0.6 * smoothstep(0.08, 0.45, abs(A.r - A.b))) * (1.0 - nm) * smoothstep(0.1, 0.5, mean3(A));
    float e = 0.0;
    e -= u_edge * pig * (0.75 * ly.ring + 0.35 * ly.overlap + 1.6 * ly.bloomEdge + 0.7 * edgeV / max(cov, 0.05));
    e += u_edge * pig * 0.45 * ly.bloomIn;
    e -= u_gran * pig * 1.2 * granW * (0.5 - hgt) * (1.0 - 0.6 * kf) * (1.0 + 0.5 * ly.wet);
    e -= u_drying * 0.2 * ly.wet * pig;
    ext = ext * (1.0 - 0.7 * cov) + cov * e * mix(vec3(1.0), tint, 0.35);
    covAny = max(covAny, covRaw);
    wetAny = max(wetAny, ly.wet * cov);
    if (detail) covLast = covRaw;
    covPrev = covRaw;
    wetPrev = wetK;
  }
  if (u_debug == 1) { o = vec4(float(stage) / 8.0, float(wet2), 0.0, 1.0); return; }
  if (u_debug == 2) { o = vec4(float(nEval) / 8.0, float(nOld) / 8.0, float(nSeeds) / 255.0, 1.0); return; }
  float endFade = 1.0 - smoothstep(Tdone, Tdone + 0.03, t);
  vec3 total = acc + ext * endFade;
  // Bez przestrzału ciemności przy końcu: piksel z detalem nie ciemniejszy od celu o >~11%.
  total = max(total, L0 - 0.12 - 50.0 * (1.0 - smoothstep(0.5, 1.0, covLast)));
  vec3 col = PAPER * exp(total);
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = max(mix(vec3(lum), col, 1.0 + 0.35 * u_drying * wetAny), 0.0);
  vec2 g = (pap.gb - 0.5) / 4.0;
  float shade = 1.0 + u_gran * (0.5 * (-g.x - g.y) * 1.6 - 0.025 * (0.5 - hgt));
  col *= mix(1.0, shade, endFade * 0.6 * covAny);   // relief tylko pod farbą: goły papier = wspólne ziarno
  vec3 sk = texture(u_sketch, uv).rgb;
  float ink = smoothstep(0.08, 0.85, 1.0 - dot(sk, vec3(0.299, 0.587, 0.114)));
  float lineFade = 1.0 - smoothstep(sLine, Tdone, t);
  float lw = u_lines * lineFade * (1.0 - 0.45 * covLast);
  // goły papier: dokładnie szkic (multiply) jak przy p=0 — bez rampy; na farbie: tusz ×(1 − ink·lw)
  col *= mix(sk, 1.0 - ink * lw * vec3(0.94, 0.97, 1.0), covAny);
  col = paperOver(col, ppM);
  col += (h12(px + 0.37) - 0.5) / 255.0;            // dither przeciw bandingowi w ciemnym niebie
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

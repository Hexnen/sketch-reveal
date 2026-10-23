/**
 * GLSL ES 3.00 efektu „strokes”: instancjonowana wstęga pociągnięcia (Catmull-Rom po punktach z tekstury)
 * z proceduralnym pędzlem oraz kompozyt z LOKALNYMI etapami (pole kolejności T): papier+szkic, podkład
 * w szczelinach, linie szkicu (25–35% na farbie, gasną z warstwą L−2), glazura do ostrego obrazu.
 * Papier (kolor + ziarno) — wspólny sterownik reveal-core/paper.ts, od p=0 (bez rampy wejścia).
 */
import { PAPER_TEX_GLSL } from "../../paper";

const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/** Wierzchołki: 2·(SEGS+1) na instancję (TRIANGLE_STRIP), pozycja liczona z gl_VertexID. */
export const STROKE_SEGS = 24;

export const STROKE_VERT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 a_i0; // pointOffset, numPoints, radius, length
layout(location = 1) in vec4 a_i1; // rA, gA, bA, seed
layout(location = 2) in vec4 a_i2; // start, dur, texMix, lod
layout(location = 3) in vec3 a_i3; // rB, gB, bB
uniform highp sampler2D u_pts;     // RG32F, szerokość 4096
uniform vec2 u_work;               // rozmiar roboczy (px)
uniform float u_t;                 // bieżący czas (po warpie)
out vec2 v_sv;                     // s (px wzdłuż od startu), v (w promieniach, w poprzek)
flat out vec4 v_st;                // R, len, seed, Lv (widoczna długość)
flat out float v_grow;
flat out vec3 v_colA;
flat out vec3 v_colB;
flat out vec2 v_tex;               // texMix, lod
out vec2 v_uv;                     // uv obrazu (0,0 = lewy górny)

int g_off;
int g_n;
vec2 P(int i) {
  int idx = g_off + clamp(i, 0, g_n - 1);
  return texelFetch(u_pts, ivec2(idx % 4096, idx / 4096), 0).xy;
}

void main() {
  if (u_t <= a_i2.x) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // jeszcze nie ruszyło
  g_off = int(a_i0.x + 0.5);
  g_n = int(a_i0.y + 0.5);
  float R = a_i0.z;
  float len = a_i0.w;
  float x = clamp((u_t - a_i2.x) / max(a_i2.y, 1e-6), 0.0, 1.0);
  float grow = 1.0 - (1.0 - x) * (1.0 - x); // ease-out
  int seg = gl_VertexID / 2;
  float side = (gl_VertexID % 2 == 0) ? -1.0 : 1.0;
  float f = float(seg) / float(${STROKE_SEGS});
  // Pędzel od razu stawia płaski odcisk (≥ 0.8R), potem się wydłuża.
  float Lv = max(len * grow, min(len, 0.8 * R));
  float s = -R + f * (Lv + 2.0 * R);
  float sc = clamp(s, 0.0, Lv);
  vec2 pos;
  vec2 tan;
  if (g_n < 2 || len <= 1e-4) {
    pos = P(0);
    float a = a_i1.w * 6.2831853;
    tan = vec2(cos(a), sin(a));
  } else {
    float fi = sc / len * float(g_n - 1);
    int i0 = min(int(floor(fi)), g_n - 2);
    float t = fi - float(i0);
    vec2 p0 = P(i0 - 1), p1 = P(i0), p2 = P(i0 + 1), p3 = P(i0 + 2);
    if (i0 == 0) p0 = 2.0 * p1 - p2;
    if (i0 + 2 > g_n - 1) p3 = 2.0 * p2 - p1;
    float t2 = t * t, t3 = t2 * t;
    pos = 0.5 * ((2.0 * p1) + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
    tan = 0.5 * ((-p0 + p2) + 2.0 * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t + 3.0 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t2);
    float tl = length(tan);
    tan = tl > 1e-5 ? tan / tl : normalize(p2 - p1 + 1e-5);
  }
  pos += tan * (s - sc);
  vec2 nrm = vec2(-tan.y, tan.x);
  float margin = 1.2;
  vec2 world = pos + nrm * side * R * margin;
  gl_Position = vec4(world.x / u_work.x * 2.0 - 1.0, 1.0 - world.y / u_work.y * 2.0, 0.0, 1.0);
  v_sv = vec2(s, side * margin);
  v_st = vec4(R, len, a_i1.w, Lv);
  v_grow = grow;
  v_colA = a_i1.rgb;
  v_colB = a_i3;
  v_tex = a_i2.zw;
  v_uv = world / u_work;
}
`;

export const STROKE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_sv;
flat in vec4 v_st;
flat in float v_grow;
flat in vec3 v_colA;
flat in vec3 v_colB;
flat in vec2 v_tex;
in vec2 v_uv;
uniform sampler2D u_painted;
uniform float u_bristle;
uniform float u_pxScale; // px ekranu na px roboczy
out vec4 o;
${NOISE}
void main() {
  float R = v_st.x, len = v_st.y, seed = v_st.z * 97.0, Lv = v_st.w;
  float s = v_sv.x;
  float t = len > 1e-3 ? clamp(s / len, 0.0, 1.0) : 0.5;
  float bAmt = u_bristle * (1.0 - 0.7 * v_tex.x);
  // Nacisk: pełny na starcie, pędzel unosi się na końcu (zwężenie) + „oddychanie” szerokości.
  float wp = (1.0 - 0.35 * smoothstep(0.45, 1.0, t) * step(1e-3, len))
    * (1.0 + bAmt * 0.22 * (vnoise(vec2(s / R * 0.7, seed + 11.0)) - 0.5));
  float vn = v_sv.y / wp;
  float vc = clamp(vn, -1.0, 1.0) * 0.5 + 0.5;
  // Postrzępiony brzeg (szum wzdłuż pociągnięcia, inny po obu stronach).
  float en = vnoise(vec2(s / R * 1.6 + seed, sign(vn) * 7.0 + seed));
  float edge = 1.0 - 0.05 - bAmt * 0.2 * en;
  // Włoski kończą się na różnej długości: gładki szum po v + mały hash (bez schodków), ≤ 0.2R.
  float nb = clamp(R * 0.8, 5.0, 30.0);
  float bl = 0.8 * vnoise(vec2(vc * nb * 0.7, seed + 5.0)) + 0.2 * hash12(vec2(floor(vc * nb), seed));
  float sE = s + bAmt * R * 0.4 * (bl - 0.5) * (s < 0.0 ? 1.0 : -1.4);
  bool growing = v_grow < 1.0;
  float dx = sE < 0.0 ? sE / (R * 0.6) : (sE > Lv ? (sE - Lv) / (R * (growing ? 0.6 : 1.1)) : 0.0);
  vec2 q = abs(vec2(dx, vn));
  // Start i czoło rosnącego pociągnięcia: płaski pędzel (superelipsa); koniec: zaokrąglony.
  float d = (sE < 0.0 || growing) ? pow(pow(q.x, 3.0) + pow(q.y, 3.0), 1.0 / 3.0) : length(q);
  float aa = fwidth(d) * 0.75 + 1e-3;
  float shape = 1.0 - smoothstep(edge - aa, edge + aa, d);
  if (shape <= 0.003) discard;
  // Włosie: pasy w poprzek przesunięte szumem (nie siatką), każdy z własnym ładunkiem farby.
  float bv = vc * nb + 1.5 * vnoise(vec2(s / R * 0.3, seed + 9.0));
  float bh = vnoise(vec2(bv * 1.7, seed));
  float bn = vnoise(vec2(bv * 1.3, seed + 3.0));
  float streak = vnoise(vec2(bv * 1.1, s / R * 0.25 + seed * 1.7));
  // Suchy koniec: włoski kończą farbę w różnych miejscach; ziarno płótna tylko łagodnie.
  float tDry = 0.55 + 0.6 * bh;
  float grain = vnoise(gl_FragCoord.xy * 0.45 / u_pxScale + seed);
  float dry = smoothstep(tDry - 0.3, tDry + 0.1, t) * smoothstep(0.0, 0.05, len / R);
  float alpha = shape;
  alpha *= 1.0 - bAmt * 0.85 * dry * smoothstep(0.2, 0.85, grain + 0.3 * (1.0 - bh));
  alpha *= 1.0 - bAmt * 0.5 * smoothstep(0.5, 0.95, streak) * smoothstep(0.2, 0.7, t + 0.3 * abs(vn));
  alpha = clamp(alpha * 0.97, 0.0, 1.0);
  // Kolor per pociągnięcie: A → B wzdłuż osi. Detal (ostatnia warstwa): miękko z obrazu (LOD 1).
  vec3 base = mix(v_colA, v_colB, smoothstep(0.15, 0.85, t));
  if (v_tex.x > 0.0) base = mix(base, textureLod(u_painted, v_uv, v_tex.y).rgb, v_tex.x);
  vec3 col = base * (1.0 + bAmt * 0.16 * (bn - 0.5) + bAmt * 0.06 * (bh - 0.5));
  col *= 1.0 - bAmt * 0.07 * smoothstep(0.55, 1.0, d);
  col = clamp(col, 0.0, 1.0);
  o = vec4(col * alpha, alpha);
}
`;

export const FULL_VERT = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_sketch;
uniform sampler2D u_painted;
uniform sampler2D u_accum;
uniform sampler2D u_order;  // pole kolejności T (0..1)
uniform vec2 u_res;
uniform float u_tau;        // czas lokalnych etapów (przed warpem)
uniform float u_S;
uniform vec2 u_ground;      // [start, szerokość] względem S·T
uniform vec2 u_ink;
uniform vec2 u_fin;
uniform float u_done;       // 1 → czysty obraz (· ziarno przy „przedłuż na całość”)
out vec4 o;
${PAPER_TEX_GLSL}
float stage(vec2 se, float base) { return smoothstep(0.0, 1.0, (u_tau - base - se.x) / max(se.y, 1e-4)); }
void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_res.x, 1.0 - gl_FragCoord.y / u_res.y);
  vec3 painted = texture(u_painted, uv).rgb;
  if (u_done >= 1.0) {
    o = vec4(u_ppExt > 0.0 ? paperOver(painted, paperMod(uv * vec2(textureSize(u_painted, 0)))) : painted, 1.0);
    return;
  }
  vec3 sk = texture(u_sketch, uv).rgb;
  vec4 acc = texture(u_accum, gl_FragCoord.xy / u_res);
  float base = u_S * texture(u_order, uv).r;
  float ground = stage(u_ground, base);
  float inkGone = stage(u_ink, base);
  float fin = stage(u_fin, base);
  float M = paperMod(uv * vec2(textureSize(u_painted, 0)));
  float ink = 1.0 - dot(sk, vec3(0.299, 0.587, 0.114));
  float A = acc.a;
  vec3 paperPart = sk * paperUnder(M);
  // Linie szkicu na farbie: 30% (multiply) aż do lokalnej warstwy L−2.
  float inkOnPaint = 1.0 - ink * 0.3 * (1.0 - inkGone);
  vec3 groundPart = textureLod(u_painted, uv, 4.5).rgb * inkOnPaint;
  vec3 under = mix(paperPart, groundPart, ground);
  vec3 col = under * (1.0 - A) + acc.rgb * inkOnPaint;
  col = mix(col, painted, fin);
  o = vec4(paperOver(col, M), 1.0);
}
`;

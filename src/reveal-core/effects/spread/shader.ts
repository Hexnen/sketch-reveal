/**
 * GLSL ES 3.00 — efekt „spread”: bezstanowy, skrubowalny. Cała „historia” rozlewania siedzi w
 * teksturze czasu dotarcia u_time (CPU Dijkstra, patrz timeField.ts); tu tylko:
 *   wiek farby a = x − T(uv)  →  papier+szkic | płaska podmalówka (bloki) | detal (z opóźnieniem),
 * mokry brzeg + jasny meniskus na froncie, linie szkicu wymazywane lokalnie (cienkie pasmo).
 * Papier (kolor + ziarno) — wspólny sterownik reveal-core/paper.ts (PAPER_GLSL), od p=0 do zakrycia farbą.
 */
import { PAPER_TEX_GLSL } from "../../paper";

export const SPREAD_VERT = /* glsl */ `#version 300 es
out vec2 v_uv;
void main() {
  // Pełnoekranowy trójkąt bez buforów; uv (0,0) = lewy górny róg obrazu.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Czysty kolor — przy p>=1 efekt jest zdjęty (papier tylko przy „przedłuż na całość”: painted · M). */
export const BLIT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_painted;
${PAPER_TEX_GLSL}
void main() {
  vec3 c = texture(u_painted, v_uv).rgb;
  if (u_ppExt > 0.0) c = paperOver(c, paperMod(v_uv * vec2(textureSize(u_painted, 0))));
  outColor = vec4(c, 1.0);
}`;

export const SPREAD_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_sketch;
uniform sampler2D u_painted;   // z mipmapami (kolor bloków podmalówki)
uniform sampler2D u_time;      // R16F: znormalizowany czas dotarcia 0..1 (niska rozdzielczość)
uniform vec2  u_texRes;
uniform float u_x;             // postęp po easingu, przeskalowany do zakresu wieku
uniform float u_soft;
uniform float u_brush;
uniform float u_lag;
uniform float u_lineFade;
uniform float u_wet;
uniform float u_seed;
uniform float u_bleed;
uniform float u_barrier;
uniform float u_cellPx;        // rozmiar bloku podmalówki w px obrazu
uniform vec2  u_tail;          // ogon (tail.ts): x = Tk (od kiedy rozciągamy T), y = beta (0 = wyłączony)
${PAPER_TEX_GLSL}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 17.17)); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.9375;
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Środek komórki Voronoi (w px) najbliższej punktowi — nieregularne „bloki” podmalówki.
vec2 voronoiCenter(vec2 ppx, float cell, vec2 sd) {
  vec2 g = ppx / cell;
  vec2 gi = floor(g);
  float best = 1e9;
  vec2 bc = gi;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = gi + vec2(i, j);
    vec2 pt = c + hash2(c + sd);                 // pełny jitter = nieregularne bloki, nie plaster miodu
    float d = dot(pt - g, pt - g);
    if (d < best) { best = d; bc = pt; }
  }
  return bc * cell;
}

void main() {
  vec2 uv = v_uv;
  float aspect = u_texRes.x / u_texRes.y;
  vec2 q = vec2(uv.x * aspect, uv.y);
  vec2 sd = vec2(u_seed * 13.71, u_seed * 7.31);
  vec2 ppx = uv * u_texRes;
  float w = u_soft;

  vec3 sk = texture(u_sketch, uv).rgb;
  float skL = luma(sk);
  float ink = smoothstep(0.2, 0.75, 1.0 - skL);

  // Czas dotarcia w pikselu: pole z CPU + postrzępienie (bleed) + kreska sama opóźnia
  // (front staje NA linii, linia znika chwilę po zalaniu — cienkie pasmo nakładania).
  float rag = (fbm(q * u_brush * 6.0 + sd) - 0.5) * 0.8 + (vnoise(ppx / 3.0 + sd) - 0.5) * 0.4;
  float T0 = texture(u_time, uv).r;
  // Ogon: najpóźniejsze komórki (T > Tk) rozciągnięte rosnąco — front zwalnia i dolewa ostatnie dziury
  // płynnie aż do końca. Dla T <= Tk bez zmian (bit w bit), ciągłe z pochodną w Tk.
  if (T0 > u_tail.x) { float d = T0 - u_tail.x; T0 = u_tail.x + d * (1.0 + u_tail.y * d / max(1.0 - u_tail.x, 1e-3)); }
  float Tp = T0 + rag * u_bleed * w + ink * u_barrier * w * 0.6;
  float a = u_x - Tp;                                   // „wiek” farby (>0 = zalane)
  float r1 = smoothstep(0.0, w * 0.35, a);              // ostry, ale nie pikselowy brzeg

  // --- Papier + szkic --------------------------------------------------------------------
  float M = paperMod(ppx);
  vec3 sketchStage = sk * paperUnder(M);

  // --- Farba: płaskie bloki → detal --------------------------------------------------------
  float fresh = r1 * (1.0 - smoothstep(w * 0.3, w * 1.6, a));
  vec2 spill = (vec2(vnoise(q * 50.0 + sd), vnoise(q * 50.0 + sd + 9.0)) - 0.5) * 8.0 * u_bleed * fresh;
  vec2 cc = voronoiCenter(ppx + spill, u_cellPx, sd);
  vec3 under = textureLod(u_painted, cc / u_texRes, log2(u_cellPx) - 0.5).rgb;
  vec3 det = texture(u_painted, uv).rgb;
  float lagLocal = u_lag * (1.0 + 0.6 * (fbm(q * u_brush * 2.0 + sd * 2.0) - 0.5));
  float r2 = smoothstep(0.0, w * 0.6, a - lagLocal);
  vec3 paint = mix(under, det, r2);

  // Linie szkicu: zostają na świeżej farbie tylko w wąskim paśmie za frontem.
  float wl = w * (0.3 + 1.5 * u_lineFade);
  float lineAmt = 1.0 - smoothstep(0.0, wl, a);
  paint *= mix(1.0, skL, 0.85 * lineAmt);

  // Mokry brzeg: lekko ciemniejszy i nasycony pas, granulacja; jasny, nierówny meniskus na czubku.
  float pl = luma(paint);
  paint = mix(vec3(pl), paint, 1.0 + 0.45 * fresh * u_wet);
  paint *= 1.0 - 0.16 * fresh * u_wet;
  paint *= mix(1.0, M, 0.5 * fresh);              // świeża farba granuluje w ziarnie papieru
  float men = smoothstep(0.0, w * 0.06, a) * (1.0 - smoothstep(w * 0.06, w * 0.28, a));
  men *= 0.5 + vnoise(q * 90.0 + sd * 3.0);
  paint += vec3(1.0, 0.98, 0.94) * men * u_wet * 0.16;

  outColor = vec4(paperOver(mix(sketchStage, max(paint, 0.0), r1), M), 1.0);
}`;

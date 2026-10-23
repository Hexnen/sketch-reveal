/**
 * Wspólne fragmenty GLSL efektu `watercolor`: wierzchołki, blit, szum oraz przebieg wstępny papieru
 * (height-map + gradient + szum strzępienia liczone RAZ na obraz do tekstury — pod 4K splash).
 * Wysokość papieru = wspólny sterownik reveal-core/paper.ts (paperHeight) — granulacja osiada w dolinach
 * TEGO SAMEGO ziarna, które widać na gołym papierze we wszystkich efektach.
 */
import { PAPER_NOISE_GLSL, PAPER_TEX_GLSL } from "../../paper";

export const WC_VERT = /* glsl */ `#version 300 es
void main() {
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

export const WC_BLIT_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_painted;
uniform vec2 u_view;
${PAPER_TEX_GLSL}
out vec4 o;
void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_view.x, 1.0 - gl_FragCoord.y / u_view.y);
  vec3 c = texture(u_painted, uv).rgb;
  if (u_ppExt > 0.0) c = paperOver(c, paperMod(uv * vec2(textureSize(u_painted, 0)))); // „przedłuż na całość”
  o = vec4(c, 1.0);
}`;

/** Hash/szum zależne od u_seed (uniform musi być zadeklarowany przed wklejeniem). */
export const WC_NOISE = /* glsl */ `
float h12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + u_seed * 0.01731);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 h22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + u_seed * 0.01731);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), w.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), w.x), w.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.1; a *= 0.5; }
  return s / 0.9375;
}
float ridged(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * (1.0 - abs(2.0 * vnoise(p) - 1.0)); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.3; a *= 0.5; }
  return s / 0.875;
}
`;

/** Gradient papieru zapisany jako 0.5 + g·GRAD_SCALE (RGBA8). */
export const PAPER_GRAD_SCALE = 4.0;

/** Przebieg wstępny: r = wysokość papieru, g/b = gradient, a = szum strzępienia frontu. */
export const WC_PAPER_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_seed;
uniform float u_ppScale;
out vec4 o;
${WC_NOISE}
${PAPER_NOISE_GLSL}
// Papier akwarelowy (cold press): wspólna wysokość z paper.ts (u_ppScale = skala ziarna). Niżej = dolina.
float paperH(vec2 px) { return paperHeight(px); }
void main() {
  // Wiersz tekstury j ↔ v = j/h ↔ px.y obrazu (ta sama konwencja co uv·u_res w głównym shaderze).
  vec2 px = gl_FragCoord.xy;
  float h = paperH(px);
  float hx = paperH(px + vec2(1.0, 0.0)) - h;
  float hy = paperH(px + vec2(0.0, 1.0)) - h;
  float feather = fbm(px / (u_res.y * 0.012) + 5.0);
  o = vec4(clamp(h, 0.0, 1.0), clamp(0.5 + hx * ${PAPER_GRAD_SCALE.toFixed(1)}, 0.0, 1.0),
           clamp(0.5 + hy * ${PAPER_GRAD_SCALE.toFixed(1)}, 0.0, 1.0), feather);
}`;

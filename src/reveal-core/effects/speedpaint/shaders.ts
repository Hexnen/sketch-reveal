/**
 * GLSL ES 3.00 efektu `speedpaint` (film speed-paint: blokowanie → formy → detale).
 *
 * Model: N warstw „pociągnięć” (stages). Warstwa k = siatka komórek rozmiaru c_k (coarse→fine);
 * każda komórka ma jedno pociągnięcie — wydłużoną plamę zorientowaną wzdłuż formy (structure tensor
 * obrazu docelowego), o czasie startu t0 i przeciągnięciu (głowica pędzla idzie wzdłuż osi).
 * Malarski porządek bez stanu: w danym pikselu widoczne jest pociągnięcie, które zaczęło się NAJPÓŹNIEJ
 * spośród już namalowanych (później = na wierzchu). Wszystko zależy tylko od (uv, p) → skrubowalne,
 * zero migotania (szum zamrożony w UV/id komórki).
 */

import { PAPER_TEX_GLSL } from "../../paper";
import { SP_HEAD, SP_LAYER } from "./strokeGlsl";

export const SP_VERT = /* glsl */ `#version 300 es
void main() {
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Prezentacja tekstury na ekran: obraz (wiersz 0 = góra → u_flip=1) albo bufor FBO (u_flip=0).
 * u_ppMode (wspólny papier, reveal-core/paper.ts): 0 = bez, 1 = szkic na papierze (p=0), 2 = obraz
 * gotowy (p>=1: ziarno tylko przy „przedłuż na całość”). Tryby 1/2 tylko dla obrazów (u_flip=1).
 */
export const SP_BLIT_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_view;
uniform float u_flip;
uniform int u_ppMode;
${PAPER_TEX_GLSL}
out vec4 o;
void main() {
  vec2 f = gl_FragCoord.xy / u_view;
  vec2 uv = vec2(f.x, u_flip > 0.5 ? 1.0 - f.y : f.y);
  vec3 c = texture(u_src, uv).rgb;
  if (u_ppMode == 1 || (u_ppMode == 2 && u_ppExt > 0.0)) {
    float M = paperMod(uv * vec2(textureSize(u_src, 0)));
    if (u_ppMode == 1) c *= paperUnder(M);
    c = paperOver(c, M);
  }
  o = vec4(c, 1.0);
}`;


/**
 * Kompozycja front-to-back: od najwyższego etapu w dół; każda warstwa daje krycie (AA, narastające)
 * i kolor; reszta przepuszcza niższe etapy, na dnie szkic (papier + tusz). Linie szkicu leżą na
 * podmalówce jak warstwa „multiply”, słabnąc z etapem; detal (dokładny obraz) je zakrywa lokalnie.
 */
export const SP_FRAG = SP_HEAD + PAPER_TEX_GLSL + SP_LAYER + /* glsl */ `
void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_view.x, 1.0 - gl_FragCoord.y / u_view.y);
  vec2 px = uv * u_res;
  float p = warpTime(clamp(u_p, 0.0, 1.0));
  vec3 sk = texture(u_sketch, uv).rgb;
  vec4 ord = texture(u_order, uv);
  float ink = 1.0 - dot(sk, vec3(0.333));
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  vec4 lmin = texture(u_orderMin, uv);
  for (int k = u_stages - 1; k >= 0; k--) {
    // wczesny odrzut: żadne pociągnięcie etapu k nie mogło tu jeszcze dotrzeć (g = min T w zasięgu największej
    // warstwy; fala 2: dokładniejsze minimum per warstwa dla 4 górnych — max z dwóch zachowawczych granic)
    int r = u_stages - 1 - k;
    float tmin = r == 0 ? lmin.r : r == 1 ? lmin.g : r == 2 ? lmin.b : r == 3 ? lmin.a : 0.0;
    if (p < stageStart(max(ord.g, tmin), k)) continue;
    vec3 c;
    float a = layerEval(k, px, uv, p, ord.r, c);
    if (a <= 0.0) continue;
    if (k < u_stages - 1) {
      float w = clamp(u_lineErase * 1.2, 0.0, 0.7) * (1.0 - 0.6 * float(k) / max(1.0, float(u_stages - 1)));
      c *= 1.0 - ink * w;
    }
    acc += trans * a * c;
    trans *= 1.0 - a;
    if (trans < 0.004) break;
  }
  float M = paperMod(px);                   // wspólny papier pod szkicem (od p=0), reveal-core/paper.ts
  acc += trans * sk * paperUnder(M);
  o = vec4(paperOver(acc, M), 1.0);
}`;

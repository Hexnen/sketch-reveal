/** Fragment shader fazy szkicu (GLSL ES 3.00). Patrz render.ts. Papier: wspólny sterownik reveal-core/paper.ts. */
import { PAPER_GLSL } from "../paper";

export const MAX_PENS = 8;

export const FS = `#version 300 es
precision highp float;
uniform sampler2D uSketch;
uniform sampler2D uTarget;   // to, na czym kończymy (p=0 efektu koloru) — domyślnie = szkic
uniform highp sampler2D uField;
uniform vec2 uSize;
uniform vec2 uOut;
uniform vec2 uFieldSize;
uniform vec3 uPaper;         // średni kolor papieru celu (tam, gdzie szkic jest biały)
uniform int uHasTarget;      // 0 = bez klatki efektu: papier i szkic z PAPER_GLSL (te same formuły co efekty)
uniform float uImgScale;     // px obrazu / px tekstury szkicu (ziarno w px obrazu, jak w efektach)
${PAPER_GLSL}
uniform float uT;
uniform int uMode;
uniform float uFresh;
uniform float uSoft;
uniform vec4 uPens[${MAX_PENS}];
uniform vec4 uPenB[${MAX_PENS}];
uniform int uNP;
out vec4 o;
vec2 fieldAt(ivec2 i) { return texelFetch(uField, clamp(i, ivec2(0), ivec2(uFieldSize) - 1), 0).rg; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// ołówek z góry: stożek grafitu → drewno → lakier, oś „do ręki” (w prawo-dół), AA w px wyjścia
float pencil(vec2 v, float r, float aa, out float zone) {
  vec2 D = normalize(vec2(0.5, 0.86));
  float along = dot(v, D), across = abs(v.x * D.y - v.y * D.x);
  float hw = min(r * 0.25 + max(along, 0.0) * 0.36, r * 2.1);
  zone = along / r;
  return (1.0 - smoothstep(hw - aa, hw + aa, across))
       * smoothstep(-0.2 * r - aa, -0.2 * r + aa, along)
       * (1.0 - smoothstep(16.0 * r - aa, 16.0 * r + aa, along));
}

void main() {
  vec2 po = vec2(gl_FragCoord.x, uOut.y - gl_FragCoord.y);
  vec2 q = po * uSize / uOut;            // piksele szkicu (ciągłe)
  float kpx = uSize.x / uOut.x;
  vec3 s = texture(uSketch, q / uSize).rgb;
  vec3 g = texture(uTarget, q / uSize).rgb;
  float pM = paperMod(q * uImgScale);
  vec3 paper;
  if (uHasTarget == 1) {
    // papier celu: cel/szkic tam, gdzie szkic jasny (ziarno, ton papieru efektu); pod tuszem — średni papier × ziarno
    float ls = luma(s);
    paper = mix(uPaper * pM, clamp(g / max(s, vec3(0.05)), 0.0, 1.0), smoothstep(0.35, 0.6, ls));
  } else {
    // bez celu: dokładnie p=0 efektów (szkic · tint · M) — ten sam papier od pierwszej klatki fazy szkicu
    g = paperOver(s * paperUnder(pM), pM);
    paper = paperOver(paperUnder(pM), pM);
  }
  if (uMode == 2) { o = vec4(g, 1.0); return; }
  if (uMode == 0) { o = vec4(paper, 1.0); return; }

  vec2 fq = q * uFieldSize / uSize - 0.5;
  ivec2 i0 = ivec2(floor(fq));
  vec2 fr = fq - floor(fq);
  vec2 f = mix(mix(fieldAt(i0), fieldAt(i0 + ivec2(1, 0)), fr.x),
               mix(fieldAt(i0 + ivec2(0, 1)), fieldAt(i0 + ivec2(1, 1)), fr.x), fr.y);
  float age = uT - f.x;
  // KONTUR GŁADKI JAK W SDF: pokrycie per teksel (ciągłe po czasie) → gauss 4×4 (σ≈0,9 teksela) → próg 0,5
  // z AA = 1 px wyjścia (fwidth). Granica narysowane/nienarysowane jest gładką krzywą (bez schodków siatki
  // przy 1× i przy powiększeniu), a próg nie zostawia szarej mgły półpokrycia na styku z nienarysowanym.
  float ms = 0.0, wsum = 0.0;
  for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) {
    vec2 gg = fq - vec2(i0 + ivec2(i, j));
    vec2 fi = fieldAt(i0 + ivec2(i, j));
    float wgt = exp(-dot(gg, gg) * 0.78 / (0.6 + 0.4 * uSoft));
    ms += wgt * smoothstep(0.0, 1.0, (uT - fi.x) / max(fi.y * uSoft, 1e-5));
    wsum += wgt;
  }
  ms /= wsum;
  float aaM = max(fwidth(ms) * 0.75, 0.02);
  float m = smoothstep(0.5 - aaM, 0.5 + aaM, ms);
  vec3 c = mix(paper, g, m);
  if (uFresh > 0.0) {
    float fr2 = m * (1.0 - smoothstep(0.0, uFresh, age));
    c *= 1.0 - 0.2 * (1.0 - luma(g)) * fr2;
  }
  float aa = max(kpx, 0.3) * 0.8;
  for (int i = 0; i < ${MAX_PENS}; i++) {
    if (i >= uNP) break;
    vec4 P = uPens[i];
    float lift = uPenB[i].x, r = P.z, z;
    // cień: przesunięty tym bardziej, im wyżej ołówek nad papierem
    float sh = pencil(q - P.xy - vec2(0.55, 0.35) * r * (1.2 + 5.0 * lift), r * 1.15, aa + r * 0.5, z);
    c *= 1.0 - 0.16 * P.w * sh * (1.0 - 0.45 * lift);
    float body = pencil(q - P.xy, r, aa, z);
    vec3 col = z < 3.2 ? vec3(0.17, 0.17, 0.19) : z < 7.5 ? vec3(0.87, 0.74, 0.56) : vec3(0.93, 0.76, 0.24);
    col *= 0.85 + 0.15 * smoothstep(-1.0, 1.0, dot(normalize(vec2(-0.86, 0.5)), q - P.xy) / max(r, 1e-3));
    c = mix(c, col, P.w * body);
  }
  o = vec4(c, 1.0);
}`;

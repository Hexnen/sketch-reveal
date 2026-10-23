/**
 * Przebiegi przygotowawcze `speedpaint` (raz na setImages): pole orientacji/ważności oraz
 * podmalówki Kuwahara (płaskie plamy z twardymi krawędziami — nie rozmycie).
 */

/**
 * Pole pomocnicze (połowa rozdzielczości, potem mipmapy = wygładzanie za darmo):
 *  rg = wektor podwójnego kąta gradientu (cos2θ, sin2θ)·nasycenie → orientacja form,
 *  b  = energia krawędzi (gęstość detalu), a = „światło” (jasność ponad lokalne tło + nasycenie).
 */
export const SP_FIELD_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_painted;
uniform vec2 u_size;
out vec4 o;
float lum(vec2 uv, float lod) {
  return dot(textureLod(u_painted, uv, lod).rgb, vec3(0.299, 0.587, 0.114));
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec2 t = 1.0 / u_size;
  float l00 = lum(uv + t * vec2(-1, -1), 1.0), l10 = lum(uv + t * vec2(0, -1), 1.0), l20 = lum(uv + t * vec2(1, -1), 1.0);
  float l01 = lum(uv + t * vec2(-1, 0), 1.0), l21 = lum(uv + t * vec2(1, 0), 1.0);
  float l02 = lum(uv + t * vec2(-1, 1), 1.0), l12 = lum(uv + t * vec2(0, 1), 1.0), l22 = lum(uv + t * vec2(1, 1), 1.0);
  float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
  float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
  float m = gx * gx + gy * gy;
  vec2 dv = vec2(gx * gx - gy * gy, 2.0 * gx * gy) / max(m, 1e-6) * min(1.0, m * 40.0);
  float edge = clamp(sqrt(m) * 1.2 - 0.05, 0.0, 1.0);
  // „światło”: najjaśniejszy z 3×3 (cienki neon nie ginie w mipach) ponad tło + nasycona jasność
  float mxl = max(max(max(l00, l10), max(l20, l01)), max(max(l21, l02), max(l12, l22)));
  vec3 c = textureLod(u_painted, uv, 0.5).rgb;
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float sat = (mx - mn) / max(mx, 1e-4);
  float lift = mxl - lum(uv, 5.0);
  float light = smoothstep(0.35, 0.85, lift * 2.5 + sat * mx * 0.8);
  o = vec4(dv * 0.5 + 0.5, edge, light);
}`;

/**
 * Kuwahara (4 kwadranty) na zmniejszonej kopii obrazu: każdy piksel bierze średnią z najmniej
 * zróżnicowanego kwadratu → wnętrza regionów płaskie, krawędzie form ostre. To „średnie formy”.
 */
export const SP_KUWAHARA_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;   // rozmiar wyjścia
uniform float u_lod;   // poziom mip źródła odpowiadający rozdzielczości wyjścia
uniform int u_radius;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec2 t = 1.0 / u_size;
  vec3 m[4]; vec3 s2[4];
  for (int q = 0; q < 4; q++) { m[q] = vec3(0.0); s2[q] = vec3(0.0); }
  float n = float((u_radius + 1) * (u_radius + 1));
  for (int j = 0; j <= 8; j++) {
    if (j > u_radius) break;
    for (int i = 0; i <= 8; i++) {
      if (i > u_radius) break;
      vec3 a = textureLod(u_src, uv + vec2(-i, -j) * t, u_lod).rgb;
      vec3 b = textureLod(u_src, uv + vec2(i, -j) * t, u_lod).rgb;
      vec3 c = textureLod(u_src, uv + vec2(-i, j) * t, u_lod).rgb;
      vec3 d = textureLod(u_src, uv + vec2(i, j) * t, u_lod).rgb;
      m[0] += a; s2[0] += a * a; m[1] += b; s2[1] += b * b;
      m[2] += c; s2[2] += c * c; m[3] += d; s2[3] += d * d;
    }
  }
  // miękki wybór kwadratu (wagi ~ 1/wariancja², jak u Papariego) — bez blokowych artefaktów
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int q = 0; q < 4; q++) {
    vec3 mu = m[q] / n;
    vec3 v = abs(s2[q] / n - mu * mu);
    float sv = v.r + v.g + v.b;
    float w = 1.0 / (1e-5 + sv * sv * 1e4);
    acc += mu * w; wsum += w;
  }
  vec3 col = acc / wsum;
  o = vec4(col, 1.0);
}`;

/**
 * Zalążki plam per komórka, liczone RAZ (przy zmianie parametrów/pól) do tekstury RGBA32UI zamiast w każdym
 * pikselu × 25 sąsiadów × L warstw. Wartości (pozycja zalążka, start t0, fazy kształtu) są zapisane bitowo
 * (floatBitsToUint), więc główny shader dostaje DOKŁADNIE te same liczby, które liczyłby sam (te same funkcje
 * GLSL poniżej). Siatka warstwy k: komórki od −3 do ceil(res/S)+3 (zasięg q = px ± 0.55·S, sąsiedzi ±2).
 * Układ: 2 teksele na komórkę (A = sp.xy, t0, a2.x; B = a2.y, a3.xy, 0), warstwy jedna pod drugą.
 */
import { cellSizeCPU } from "./fields";
import { WC_NOISE } from "./glslCommon";

/** Wspólne funkcje (wymagają uniformów: u_field, u_res, u_layers, u_blob, u_wet, u_hold, u_SP0, u_SP, u_D, u_J, u_Wloc, u_origin). */
export const WC_SEED_COMMON = /* glsl */ `
// Okno lokalne etapu: detal krótszy (tylko dotarcie + wyostrzenie), więc reszta osi idzie na etapy.
float winK(int k) { return k == u_layers - 1 ? 0.6 * u_Wloc : u_Wloc; }

float startK(int k, vec2 uvS) {
  float Tb = textureLod(u_field, uvS, 0.0).r;
  float j = (vnoise(uvS * u_res / (0.3 * u_res.y) + float(k) * 19.3) - 0.5) * 2.0 * u_J;
  float s0 = u_hold + Tb * (k == 0 ? u_SP0 : u_SP) + float(k) * u_D + j * (k == 0 ? 0.5 : 1.0);
  // Jitter nie może przesunąć końca etapu za p≈0.93 (lokalne wygaszenie 0.03 musi zdążyć przed p = 1).
  return clamp(s0, 0.0, 0.965 - winK(u_layers - 1) - float(u_layers - 1 - k) * 0.02);
}

uniform float u_cellMin; // E6: dolna granica boku komórki (seedCellMin; 0 = bez zmian)
float cellSize(int k) {
  if (k == u_layers - 1) return max(u_cellMin, u_res.y * 0.05 * u_blob);              // detal: małe, miękkie komórki
  return max(u_cellMin, u_res.y * mix(0.24, 0.12, float(k) / max(float(u_layers) - 2.0, 1.0)) * u_blob);
}

// Zalążek komórki c warstwy k: pozycja (px), start t0, fazy harmonicznych kształtu.
void computeSeed(int k, vec2 c, out vec2 sp, out float t0, out vec2 a2, out vec2 a3) {
  float S = cellSize(k);
  float Wk = winK(k);
  float dur = Wk * mix(0.35, 0.6, u_wet);
  sp = (c + 0.1 + 0.8 * h22(c + float(k) * 71.3)) * S;
  t0 = startK(k, sp / u_res) + 0.25 * (Wk - dur) * h12(c + float(k) * 5.7 + 2.3);
  // Pierwsze krople przy origin od razu (brak martwego początku osi).
  if (k == 0) t0 = min(t0, u_hold + 0.15 * distance(sp / u_res.y, u_origin * vec2(u_res.x / u_res.y, 1.0)));
  a2 = h22(c + float(k) * 9.1 + 3.7) - 0.5;
  a3 = h22(c + float(k) * 4.3 + 8.9) - 0.5;
}
`;

const SEED_UNIFORMS = /* glsl */ `
uniform sampler2D u_field;
uniform vec2 u_res;
uniform int u_layers;
uniform float u_wet, u_blob, u_seed, u_hold, u_SP0, u_SP, u_D, u_J, u_Wloc;
uniform vec2 u_origin;
uniform ivec4 u_seedGrid[6];   // x0, y0 (indeks pierwszej komórki), wiersz startowy, szerokość (komórki)
uniform int u_seedRows[6];
`;

export const WC_SEED_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${SEED_UNIFORMS}
out uvec4 o;
${WC_NOISE}
${WC_SEED_COMMON}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int k = -1;
  for (int i = 0; i < 6; i++) {
    if (i < u_layers && f.y >= u_seedGrid[i].z && f.y < u_seedGrid[i].z + u_seedRows[i]) k = i;
  }
  if (k < 0 || f.x / 2 >= u_seedGrid[k].w) { o = uvec4(0u); return; }
  ivec4 g = u_seedGrid[k];
  vec2 c = vec2(float(f.x / 2 + g.x), float(f.y - g.z + g.y));
  vec2 sp, a2, a3;
  float t0;
  computeSeed(k, c, sp, t0, a2, a3);
  o = (f.x % 2 == 0) ? uvec4(floatBitsToUint(sp), floatBitsToUint(t0), floatBitsToUint(a2.x))
                     : uvec4(floatBitsToUint(a2.y), floatBitsToUint(a3), 0u);
}`;

/** Odczyt w głównym shaderze (wymaga u_seeds, u_seedGrid). */
export const WC_SEED_FETCH = /* glsl */ `
void fetchSeed(int k, vec2 c, out vec2 sp, out float t0, out vec2 a2, out vec2 a3) {
  ivec4 g = u_seedGrid[k];
  ivec2 tc = ivec2((int(c.x) - g.x) * 2, g.z + int(c.y) - g.y);
  uvec4 A = texelFetch(u_seeds, tc, 0);
  uvec4 B = texelFetch(u_seeds, tc + ivec2(1, 0), 0);
  sp = uintBitsToFloat(A.xy);
  t0 = uintBitsToFloat(A.z);
  a2 = vec2(uintBitsToFloat(A.w), uintBitsToFloat(B.x));
  a3 = uintBitsToFloat(B.yz);
}
`;

/** Układ siatek zalążków (musi odpowiadać cellSize() w GLSL; zapas ±1 komórki na różnice zaokrągleń). */
export function seedLayout(resW: number, resH: number, layers: number, blob: number) {
  const L = Math.round(Math.min(6, Math.max(2, layers)));
  const grid: number[] = [];
  const rows: number[] = [];
  let row = 0, maxW = 1;
  for (let k = 0; k < 6; k++) {
    if (k >= L) { grid.push(0, 0, row, 0); rows.push(0); continue; }
    const S = cellSizeCPU(k, L, resW, resH, blob);
    const w = Math.ceil(resW / S) + 8, h = Math.ceil(resH / S) + 8;
    grid.push(-4, -4, row, w);
    rows.push(h);
    row += h;
    maxW = Math.max(maxW, w);
  }
  return { grid: new Int32Array(grid), rows: new Int32Array(rows), texW: maxW * 2, texH: Math.max(1, row) };
}

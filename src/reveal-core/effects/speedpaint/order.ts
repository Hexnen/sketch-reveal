/**
 * Pole kolejności malowania T(uv) efektu `speedpaint` (v2, lokalne etapy).
 *
 * T_raw = 0.5·głębia + 0.3·fbm(≈0.3·H) + regionBias·hash(regionu Kuwahary), liczone w GPU na małej
 * teksturze (~160 px szer.), potem na CPU **wyrównane histogramem** (ranga / (n−1)) → każda wartość T
 * pokrywa tyle samo powierzchni, więc stała prędkość frontu = stałe tempo zmian (bez dzwonu i skoków).
 * Kanał G = min T w promieniu zasięgu pociągnięć (wczesny, zachowawczy odrzut warstw w shaderze).
 */
import { boxExtreme } from "../minFilter";
import { renderToTexture } from "./gl";

export const SP_ORDER_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_painted;
uniform sampler2D u_kuwA;
uniform vec2 u_size;
uniform vec2 u_origin;
uniform float u_aspect;
uniform float u_seed;
uniform float u_regionBias;
uniform float u_jitter;
out vec4 o;
float h12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + u_seed * 0.0137);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vn(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), f.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec2 q = uv * vec2(u_aspect, 1.0);
  // głębia: odległość od „tła” (origin) skorygowana proxy obrazu (daleko = jaśniej, mglisto, niebiesko)
  float dist = length((uv - u_origin) * vec2(u_aspect, 1.0)) / (0.8 * u_aspect);
  vec3 far = textureLod(u_painted, uv, 5.0).rgb;
  float l = dot(far, vec3(0.299, 0.587, 0.114));
  float haze = clamp(far.b - far.r, 0.0, 1.0);
  float depth = mix(dist, 1.0 - clamp((l + haze) * 1.5, 0.0, 1.0), 0.35);
  float n = 0.6 * vn(q / 0.3 + 3.1) + 0.4 * vn(q / 0.15 + 7.7);
  vec3 k = floor(texture(u_kuwA, uv).rgb * 4.0 + 0.5);
  float region = h12(k.xy * 7.1 + k.z * 13.3 + 0.5);
  // drobny jitter frontu (~0.05·H): w obrębie regionu starty rozciągnięte → brak skoku regionu
  float jit = 0.6 * vn(q / 0.05 + 11.0) + 0.4 * vn(q / 0.025 + 5.0);
  float raw = (0.5 * depth + 0.3 * n + u_regionBias * region + u_jitter * jit) / (0.8 + u_regionBias + u_jitter);
  raw = clamp(raw, 0.0, 0.9999);
  float hi = floor(raw * 255.0) / 255.0;
  o = vec4(hi, fract(raw * 255.0), 0.0, 1.0);   // 16 bit w R+G (ranga potrzebuje precyzji)
}`;

export interface OrderInputs {
  painted: WebGLTexture;
  kuwA: WebGLTexture;
  origin: [number, number];
  seed: number;
  regionBias: number;
  jitter: number;
  /** Zasięg pociągnięcia największej warstwy w px obrazu (promień minimum dla kanału G). */
  reachPx: number;
}

/** Wyrównanie histogramu + filtr minimum; zwraca RGBA8 (R = T, G = min T w promieniu). */
export function equalizeOrder(raw: Uint8Array, w: number, h: number, radius: number, ry = radius): Uint8Array {
  const n = w * h;
  // Ranga przez histogram klucza 16-bit (hi·255 + lo ∝ wartość) — O(n), bez komparatora i alokacji
  // tablicy liczb; remisy w kolejności indeksów = to samo co stabilny sort (wynik bajt w bajt).
  const KEYS = 255 * 255 + 256;
  const key = new Uint32Array(n);
  const count = new Uint32Array(KEYS + 1);
  for (let i = 0; i < n; i++) {
    key[i] = raw[i * 4] * 255 + raw[i * 4 + 1];
    count[key[i] + 1]++;
  }
  for (let k = 1; k <= KEYS; k++) count[k] += count[k - 1];
  const T = new Float32Array(n);
  const denom = Math.max(1, n - 1);
  for (let i = 0; i < n; i++) T[i] = count[key[i]]++ / denom;
  // separowalny filtr minimum (prostokąt (2r+1)×(2ry+1), zachowawczy względem koła) — kolejka monotoniczna O(n)
  // (E3: naiwnie O(n·r), sekundy na obrazach pionowych); wynik bajt w bajt (T ≤ 1, min = wybór wartości)
  const mn = boxExtreme(T, w, h, 1, 0, radius, ry, false);
  // lekkie wygładzenie T (3×3) — kontury bez schodków rastra
  const Ts = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          acc += T[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
        }
      }
      Ts[y * w + x] = acc / 9;
    }
  }
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.round(Ts[i] * 255);
    out[i * 4 + 1] = Math.floor(mn[i] * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Maks. wysokość siatki kolejności (8 × szerokość 256) — E6. */
const ORDER_MAX_H = 2048;

/** Kopia CPU wgranego pola (RGBA8, wiersz 0 = góra obrazu, R = T) — dla `coverage()` bez odczytu z GPU. */
export interface OrderCpu {
  data: Uint8Array;
  w: number;
  h: number;
}

/** Liczy T_raw na GPU, wyrównuje na CPU i wgrywa do `dst` (RGBA8, LINEAR); zwraca kopię CPU. */
export function buildOrder(
  gl: WebGL2RenderingContext,
  fbo: WebGLFramebuffer,
  vao: WebGLVertexArrayObject,
  prog: WebGLProgram,
  scratch: WebGLTexture,
  dst: WebGLTexture,
  imgW: number,
  imgH: number,
  inp: OrderInputs,
): OrderCpu {
  const ow = 256;
  // E6: siatka izotropowa do H/W = 8; wyżej wysokość przycięta (≤ MAX_TEXTURE_SIZE, pamięć CPU) — pole w uv,
  // promień pionowy liczony osobno. Poniżej progu bez zmian (bajt w bajt).
  const ohIso = Math.max(8, Math.round((ow * imgH) / imgW));
  const oh = Math.min(ohIso, ORDER_MAX_H, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
  renderToTexture(gl, fbo, vao, prog, scratch, ow, oh, (loc) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inp.painted);
    gl.uniform1i(loc("u_painted"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, inp.kuwA);
    gl.uniform1i(loc("u_kuwA"), 1);
    gl.uniform2f(loc("u_size"), ow, oh);
    gl.uniform2f(loc("u_origin"), inp.origin[0], inp.origin[1]);
    gl.uniform1f(loc("u_aspect"), imgW / imgH);
    gl.uniform1f(loc("u_seed"), inp.seed);
    gl.uniform1f(loc("u_regionBias"), inp.regionBias);
    gl.uniform1f(loc("u_jitter"), inp.jitter);
  });
  const raw = new Uint8Array(ow * oh * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scratch, 0);
  gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const radius = Math.ceil((inp.reachPx * ow) / imgW) + 2;
  const ry = oh === ohIso ? radius : Math.ceil((inp.reachPx * oh) / imgH) + 2;
  const eq = equalizeOrder(raw, ow, oh, radius, ry);
  gl.bindTexture(gl.TEXTURE_2D, dst);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ow, oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, eq);
  return { data: eq, w: ow, h: oh };
}

/**
 * Fala 2 (bezstratny wczesny odrzut per warstwa): min R pola T w otoczeniu zasięgu pociągnięć danej warstwy.
 * Kanał j = warstwa N−1−j (detal, N−2, N−3, N−4). Zachowawczo: promień w texelach = ceil(zasięg) + 3
 * (+1 bilinear T w miejscu pociągnięcia w tablicy, +1 próbka tej tekstury w pikselu, +1 zapas), wartość −1 LSB
 * (zaokrąglenia filtrowania i zapisu A.a do RGBA8). Gdy p < stageStart(min, k), żadne pociągnięcie warstwy k
 * w zasięgu piksela nie wystartowało (t0 ≥ stageStart(A.a, k)), a laserunek detalu = 0 (Tuv ≥ min) → warstwa
 * daje krycie 0 — pominięcie jej nie zmienia piksela. `reach[j]` w px obrazu (√(hlMax² + hwMax² + 4)).
 */
export function layerMinOrder(order: OrderCpu, imgW: number, imgH: number, reach: number[]): Uint8Array {
  const { data, w, h } = order;
  const n = w * h;
  const out = new Uint8Array(n * 4);
  for (let j = 0; j < 4; j++) {
    if (j >= reach.length) continue; // brak warstwy → 0 (nigdy nie odrzuca)
    const rx = Math.ceil((reach[j] * w) / imgW) + 3;
    const ry = Math.ceil((reach[j] * h) / imgH) + 3;
    const m = boxExtreme(data, w, h, 4, 0, rx, ry, false); // O(n) — E3 (wartości 0..255, wynik bajt w bajt)
    for (let i = 0; i < n; i++) out[i * 4 + j] = Math.max(0, m[i] - 1);
  }
  return out;
}

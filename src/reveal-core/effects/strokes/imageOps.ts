/**
 * Operacje obrazowe na CPU dla generatora pociągnięć: RNG, szum wartości, rozmycie pudełkowe.
 * Piramida i pole kierunków: pyramid.ts. Wszystko na Float32Array, deterministyczne (te same parametry → te same pociągnięcia).
 */
import type { RevealImageSource } from "../../types";

/** mulberry32 — szybki, deterministyczny RNG. */
export function rng(seed: number): () => number {
  let a = (Math.floor(seed * 9973) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Gładki szum wartości 0..1 (2 oktawy). */
export function valueNoise(x: number, y: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < 2; o++) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const s = seed * 31 + o * 7;
    const a = hash2(xi, yi, s);
    const b = hash2(xi + 1, yi, s);
    const c = hash2(xi, yi + 1, s);
    const d = hash2(xi + 1, yi + 1, s);
    sum += amp * (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy);
    norm += amp;
    amp *= 0.5;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 5.3;
  }
  return sum / norm;
}

export interface RGBImage {
  w: number;
  h: number;
  /** RGB przeplatane, 0..255. */
  rgb: Float32Array;
}

/** Wczytuje obraz w rozdzielczości roboczej (dłuższy bok ≤ maxSide). */
export function readImage(src: RevealImageSource, maxSide: number): RGBImage {
  const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * k));
  const h = Math.max(8, Math.round(sh * k));
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("strokes: brak kontekstu 2D");
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    rgb[j] = d[i];
    rgb[j + 1] = d[i + 1];
    rgb[j + 2] = d[i + 2];
  }
  return { w, h, rgb };
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Praca CPU krojona na porcje: generator oddaje sterowanie (`yield`) co wiersz/blok, a wynik zwraca na końcu.
 * `run` wykonuje go synchronicznie (te same operacje → te same bajty), `drive` asynchronicznie z oddawaniem
 * wątku (yieldIf decyduje, kiedy faktycznie oddać — budżet porcji w strokeGen.ts).
 */
export type Work<T> = Generator<void, T, void>;

export function run<T>(g: Work<T>): T {
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

export async function drive<T>(g: Work<T>, yieldIf: () => Promise<void>): Promise<T> {
  let r = g.next();
  while (!r.done) {
    await yieldIf();
    r = g.next();
  }
  return r.value;
}

/** Jedno przejście rozmycia pudełkowego (promień r) po `ch` kanałach, rozdzielne. */
function* boxPass(src: Float32Array, w: number, h: number, ch: number, r: number): Work<Float32Array> {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < ch; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[(row + Math.min(w - 1, Math.max(0, k))) * ch + c];
      for (let x = 0; x < w; x++) {
        tmp[(row + x) * ch + c] = acc * inv;
        const xa = Math.min(w - 1, x + r + 1);
        const xs = Math.max(0, x - r);
        acc += src[(row + xa) * ch + c] - src[(row + xs) * ch + c];
      }
    }
    if ((y & 7) === 7) yield;
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < ch; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * ch + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * ch + c] = acc * inv;
        const ya = Math.min(h - 1, y + r + 1);
        const ys = Math.max(0, y - r);
        acc += tmp[(ya * w + x) * ch + c] - tmp[(ys * w + x) * ch + c];
      }
    }
    if ((x & 7) === 7) yield;
  }
  return out;
}

/** Przybliżenie gaussa (3× pudełko) o odchyleniu ~sigma. */
export function* blurW(src: Float32Array, w: number, h: number, ch: number, sigma: number): Work<Float32Array> {
  if (sigma < 0.5) return src.slice();
  const r = Math.max(1, Math.round(sigma * 0.85));
  const a = yield* boxPass(src, w, h, ch, r);
  const b = yield* boxPass(a, w, h, ch, r);
  return yield* boxPass(b, w, h, ch, r);
}

export function blur(src: Float32Array, w: number, h: number, ch: number, sigma: number): Float32Array {
  return run(blurW(src, w, h, ch, sigma));
}

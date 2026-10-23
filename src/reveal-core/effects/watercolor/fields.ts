/**
 * Pola liczone na CPU raz na obraz/parametry (niezależne od p → skrubowalność bez zmian):
 * - Tb(uv) ∈ [0,1] — lokalna kolejność malowania: 0.55·odległość od origin + 0.30·fbm + 0.15·hash
 *   regionu koloru, rozmyte 3×3 i WYRÓWNANE HISTOGRAMEM (każda wartość = tyle samo powierzchni →
 *   stałe tempo, brak plateau),
 * - warp(uv) — niskoczęstotliwościowe pole odkształceń plam i przepływu mokrego pigmentu,
 * - progi laserunków = kwantyle mapy walorów V (ciemność celu), nie „średnia ± stała”.
 * Wynik: tekstura RGBA16F (Tb, warpX, warpY, 0) w siatce FIELD_W × (FIELD_W/aspect).
 */
import type { RevealImageSource } from "../../types";
import { boxExtreme } from "../minFilter";

export const FIELD_W = 128;
/** Biel papieru — ta sama co PAPER w shaderze. */
const PAPER = [0.955, 0.94, 0.9];

export interface ImageGrid {
  w: number;
  h: number;
  /** Średni kolor komórki (0..1), RGB po kolei. */
  rgb: Float32Array;
}

export interface Fields {
  w: number;
  h: number;
  data: Float32Array;
  /** Progi V dla laserunków środkowych (indeks = k−1). */
  thr: number[];
}

/** Zmniejsza obraz do siatki FIELD_W (najpierw ≤1024 px przez canvas, potem średnia blokowa). */
export function gridFromImage(img: RevealImageSource, iw: number, ih: number): ImageGrid {
  const mw = Math.min(iw, 1024);
  const mh = Math.max(1, Math.round((ih * mw) / iw));
  const cv = document.createElement("canvas");
  cv.width = mw;
  cv.height = mh;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("watercolor: brak 2D canvas");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, mw, mh);
  const src = ctx.getImageData(0, 0, mw, mh).data;
  const w = FIELD_W;
  // E6: wysokość siatki ≤ 8·FIELD_W (3×900 dawało 38 400 wierszy: tekstury ponad limit + CPU); pola w uv,
  // okna liczone osobno w poziomie i pionie (windowTb). Poniżej H/W = 8 bez zmian.
  const h = Math.min(8 * FIELD_W, Math.max(2, Math.round((FIELD_W * ih) / iw)));
  const rgb = new Float32Array(w * h * 3);
  const cnt = new Float32Array(w * h);
  for (let y = 0; y < mh; y++) {
    const gy = Math.min(h - 1, Math.floor((y * h) / mh));
    for (let x = 0; x < mw; x++) {
      const gx = Math.min(w - 1, Math.floor((x * w) / mw));
      const i = (y * mw + x) * 4;
      const g = gy * w + gx;
      rgb[g * 3] += src[i] / 255;
      rgb[g * 3 + 1] += src[i + 1] / 255;
      rgb[g * 3 + 2] += src[i + 2] / 255;
      cnt[g] += 1;
    }
  }
  for (let g = 0; g < w * h; g++) {
    const c = Math.max(1, cnt[g]);
    rgb[g * 3] /= c;
    rgb[g * 3 + 1] /= c;
    rgb[g * 3 + 2] /= c;
  }
  return { w, h, rgb };
}

function hash2(x: number, y: number, seed: number): number {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, seed: number): number {
  let s = 0, a = 0.5;
  for (let i = 0; i < 4; i++) {
    s += a * vnoise(x, y, seed + i * 17);
    const nx = 1.6 * x + 1.2 * y + 7.1;
    y = -1.2 * x + 1.6 * y + 7.1;
    x = nx;
    a *= 0.5;
  }
  return s / 0.9375;
}

function blur3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += src[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function quantile(sorted: Float32Array, q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/** Ciemność celu w log-transmitancji (jak −mean(logT) w shaderze). */
function darkness(r: number, g: number, b: number): number {
  const l = (c: number, p: number) => Math.log(Math.min(1.25, Math.max(0.012, c / p)));
  return -(l(r, PAPER[0]) + l(g, PAPER[1]) + l(b, PAPER[2])) / 3;
}

export function computeFields(grid: ImageGrid, originX: number, originY: number, seed: number, layers: number): Fields {
  const { w, h, rgb } = grid;
  const n = w * h;
  const aspect = w / h;
  const sd = Math.round(seed) * 7919 + 13;
  // Kolor „lod5” (≈ 32 px) do hasha regionów: dwa rozmycia 3×3.
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = rgb[i * 3 + c];
    return blur3(blur3(a, w, h), w, h);
  });
  const ox = originX * aspect, oy = originY;
  const dmax = Math.max(Math.hypot(ox, oy), Math.hypot(ox - aspect, oy), Math.hypot(ox, oy - 1), Math.hypot(ox - aspect, oy - 1));
  const raw = new Float32Array(n);
  const data = new Float32Array(n * 4);
  const V = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / h, v = (y + 0.5) / h; // jednostki wysokości obrazu
      const ord = Math.min(1, Math.hypot(u - ox, v - oy) / dmax);
      const fl = fbm(u / 0.3, v / 0.3, sd);
      const q = Math.floor(ch[0][i] * 4) + 4 * Math.floor(ch[1][i] * 4) + 16 * Math.floor(ch[2][i] * 4);
      raw[i] = 0.55 * ord + 0.3 * fl + 0.15 * hash2(q, 911, sd);
      data[i * 4 + 1] = fbm(u / 0.22, v / 0.22, sd + 101) - 0.5;
      data[i * 4 + 2] = fbm(u / 0.22 + 31.7, v / 0.22, sd + 202) - 0.5;
      V[i] = darkness(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    }
  }
  // Wyrównanie histogramem: Tb = ranga / (n−1).
  const tb = blur3(raw, w, h);
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => tb[a] - tb[b]);
  idx.forEach((i, r) => (data[i * 4] = r / Math.max(1, n - 1)));
  // Progi laserunków z kwantyli: 1. laserunek kryje ~55% najciemniejszych, ostatni ~25%.
  const vs = Float32Array.from(V).sort();
  const range = quantile(vs, 0.9) - quantile(vs, 0.1);
  const nMid = Math.max(0, Math.round(layers) - 2);
  const thr: number[] = [];
  for (let m = 0; m < Math.max(nMid, 1); m++) {
    const mf = nMid > 1 ? m / (nMid - 1) : 0;
    let c = 0.55 + (0.25 - 0.55) * mf;
    if (range < 0.3) c *= Math.max(0.2, range / 0.3);
    thr.push(quantile(vs, 1 - c));
  }
  while (thr.length < 4) thr.push(thr[thr.length - 1] ?? 1);
  return { w, h, data, thr };
}

/**
 * Dolne ograniczenie Tb w zasięgu zalążków warstwy k (k = 1..4 → kanały RGBA): minimum Tb w kwadracie
 * ±(3.45·S_k + 2 komórki siatki). Zalążki warstwy leżą w ±3.45·S od piksela (komórki ±2, warp ≤ 0.55·S,
 * jitter 0.1–0.9), +1 komórka na interpolację próbki Tb i +1 na texelFetch piksela. Shader pomija warstwę
 * (i wszystkie następne — stos), gdy t < start_k(minTb) — wtedy jej pokrycie i tak wynosi dokładnie 0.
 * Zapas −0.002 pokrywa zaokrąglenie do fp16.
 */
export function minStartField(f: { w: number; h: number; data: Float32Array }, resW: number, resH: number, layers: number, blob: number): Float32Array {
  const { w, h } = f;
  const L = Math.round(Math.min(6, Math.max(2, layers)));
  const out = new Float32Array(w * h * 4);
  for (let ch = 0; ch < 4; ch++) {
    const k = ch + 1;
    if (k > L - 1) continue;
    const m = windowTb(f, resW, resH, cellSizeCPU(k, L, resW, resH, blob), Math.min);
    for (let i = 0; i < w * h; i++) out[i * 4 + ch] = m[i] - 0.002;
  }
  return out;
}

/** Maks. liczba komórek zalążków w wierszu (E6: tekstura zalążków ≤ 2·(2048+8) ≤ MAX_TEXTURE_SIZE). */
const SEED_MAX_CELLS = 2048;

/**
 * Dolna granica boku komórki (= u_cellMin w GLSL). 0 dla zwykłych proporcji (detal S = 0,05·resH·blob daje
 * ≤ 2048 komórek w wierszu aż do W/H ≈ 100·blob) → cellSize bez zmian (max(0, S) = S, bajt w bajt). Skrajnie
 * szerokie obrazy (np. 1024×2): komórki większe, zamiast tekstury ponad limit i złej klatki.
 */
export function seedCellMin(resW: number, resH: number, blob: number): number {
  return resW / (resH * 0.05 * blob) > SEED_MAX_CELLS ? resW / SEED_MAX_CELLS : 0;
}

/** Bok komórki zalążków warstwy k (= cellSize() w GLSL). */
export function cellSizeCPU(k: number, L: number, resW: number, resH: number, blob: number): number {
  const S = k === L - 1 ? resH * 0.05 * blob : resH * (0.24 + (0.12 - 0.24) * (k / Math.max(L - 2, 1))) * blob;
  return Math.max(seedCellMin(resW, resH, blob), S);
}

/** Min/max Tb w kwadracie ±(3.45·S + 2 komórki) wokół każdej komórki siatki (rozdzielnie: wiersze, potem kolumny). */
function windowTb(f: { w: number; h: number; data: Float32Array }, resW: number, resH: number, S: number, op: (a: number, b: number) => number): Float32Array {
  const { w, h, data } = f;
  const rx = Math.ceil((3.45 * S) / (resW / w)) + 2;
  const ry = Math.ceil((3.45 * S) / (resH / h)) + 2;
  // kolejka monotoniczna O(n) zamiast O(n·r) (E3/E6) — min/max to wybór wartości, wynik bajt w bajt
  return boxExtreme(data, w, h, 4, 0, rx, ry, op === Math.max);
}

/**
 * Ograniczenia do bezstratnego skrótu „po końcu” w shaderze (fala 2, combined-perf.md), siatka jak minStartField:
 * `maxA` (RGBA = k 0..3), `maxB.rg` (k 4..5) = GÓRNE ograniczenie Tb w zasięgu zalążków warstwy k (+0.002 na fp16)
 * → górna granica T1 (czasu dotarcia zwycięskiego zalążka) → „warstwa na pewno sucha” (wet = 0 dokładnie).
 */
export function boundFields(f: { w: number; h: number; data: Float32Array }, resW: number, resH: number, layers: number, blob: number) {
  const { w, h } = f;
  const L = Math.round(Math.min(6, Math.max(2, layers)));
  const maxA = new Float32Array(w * h * 4);
  const maxB = new Float32Array(w * h * 4);
  for (let k = 0; k < Math.min(L, 6); k++) {
    const m = windowTb(f, resW, resH, cellSizeCPU(k, L, resW, resH, blob), Math.max);
    const [arr, ch] = k < 4 ? [maxA, k] : [maxB, k - 4];
    for (let i = 0; i < w * h; i++) arr[i * 4 + ch] = m[i] + 0.002;
  }
  return { maxA, maxB };
}

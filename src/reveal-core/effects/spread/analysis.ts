/**
 * Analiza obrazów dla pola czasu spread (linie szkicu, krawędzie i „ważność” obrazu) na siatce ~256 px.
 * Wynik zależy tylko od pary obrazów — liczony raz (cache w prep.ts), porcjami: `analyzeSteps` to generator,
 * który oddaje sterowanie co kilka wierszy (fala 2: przygotowanie w tle ≤ 8 ms). Wynik bit w bit jak dawniej.
 */
export interface ImageAnalysis {
  gw: number;
  gh: number;
  /** Ciemność linii szkicu (max-pool w komórce), 0..1. */
  ink: Float32Array;
  /** Siła krawędzi obrazu docelowego (Sobel), 0..1. */
  edge: Float32Array;
  /** „Ważność” — jasność ponad średnią + nasycenie, 0..1 (do zalążków w światłach). */
  imp: Float32Array;
}

const GRID_TARGET = 256;   // szerokość siatki (dłuższy bok) — 1/4 dla obrazu 1024 px
const INK_SUPERSAMPLE = 4; // linie analizujemy w 4× gęstszej siatce i max-poolujemy

function sourceSize(src: TexImageSource): { width: number; height: number } {
  if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement) {
    return { width: src.naturalWidth, height: src.naturalHeight };
  }
  if (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) {
    return { width: src.videoWidth, height: src.videoHeight };
  }
  if (typeof VideoFrame !== "undefined" && src instanceof VideoFrame) {
    return { width: src.displayWidth, height: src.displayHeight };
  }
  const s = src as { width: number; height: number };
  return { width: s.width, height: s.height };
}

function rasterize(src: TexImageSource, w: number, h: number): Uint8ClampedArray {
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("reveal: brak kontekstu 2D do analizy obrazów");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** k-ty najmniejszy element (quickselect, Hoare) — ta sama wartość co `sort()[k]`, O(n) zamiast O(n log n). */
export function selectKth(a: Float32Array, k: number): number {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/** Analiza porcjami: `yield` między krokami (rasteryzacja = jeden niepodzielny krok). Zwraca wynik. */
export function* analyzeSteps(sketch: TexImageSource, painted: TexImageSource): Generator<void, ImageAnalysis, void> {
  const size = sourceSize(painted);
  const scale = GRID_TARGET / Math.max(size.width, size.height);
  const gw = Math.max(8, Math.round(size.width * scale));
  const gh = Math.max(8, Math.round(size.height * scale));
  const n = gw * gh;

  // Linie: gęstsza siatka → max-pool, żeby cienka kreska nie rozmyła się do szarości.
  const S = INK_SUPERSAMPLE;
  const sk = rasterize(sketch, gw * S, gh * S);
  yield;
  const ink = new Float32Array(n);
  for (let y = 0; y < gh * S; y++) {
    for (let x = 0; x < gw * S; x++) {
      const i = (y * gw * S + x) * 4;
      const l = (0.299 * sk[i] + 0.587 * sk[i + 1] + 0.114 * sk[i + 2]) / 255;
      const v = smooth(0.2, 0.75, 1 - l);
      const c = ((y / S) | 0) * gw + ((x / S) | 0);
      if (v > ink[c]) ink[c] = v;
    }
    if ((y & 63) === 63) yield;
  }

  const pa = rasterize(painted, gw, gh);
  yield;
  const lum = new Float32Array(n);
  const sat = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const r = pa[i * 4] / 255, g = pa[i * 4 + 1] / 255, b = pa[i * 4 + 2] / 255;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
    mean += lum[i];
  }
  mean /= n;

  const edge = new Float32Array(n);
  const imp = new Float32Array(n);
  const at = (x: number, y: number) => lum[Math.min(gh - 1, Math.max(0, y)) * gw + Math.min(gw - 1, Math.max(0, x))];
  let emax = 1e-6;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const i = y * gw + x;
      edge[i] = Math.hypot(gx, gy);
      if (edge[i] > emax) emax = edge[i];
      imp[i] = Math.min(1, Math.max(0, (lum[i] - mean) * 2.5 + sat[i] * 0.9));
    }
  }
  yield;
  // Normalizacja krawędzi do ~95. percentyla (pojedyncze ostre piksele nie spłaszczają reszty).
  // Quickselect zamiast pełnego sortu — ta sama wartość (k-ty element), bit w bit.
  const p95 = Math.max(1e-6, selectKth(Float32Array.from(edge), Math.floor(n * 0.95)) || emax);
  for (let i = 0; i < n; i++) edge[i] = Math.min(1, edge[i] / p95);
  return { gw, gh, ink, edge, imp };
}

/** Synchronicznie (testy/narzędzia). */
export function analyzeImages(sketch: TexImageSource, painted: TexImageSource): ImageAnalysis {
  const g = analyzeSteps(sketch, painted);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

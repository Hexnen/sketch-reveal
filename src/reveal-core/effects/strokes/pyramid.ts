/**
 * Piramida Gaussa (raz na obraz) i pole kierunków z obrazu (nie z seeda):
 * - tensor Di Zenzo (suma tensorów kanałów RGB — krawędzie barwne, np. neon/kałuże, też się liczą),
 * - siła normalizowana LOKALNIE (ślad / średni ślad w oknie), więc ciemne strefy mają własne krawędzie,
 * - wygładzanie kierunków ważone siłą (jak edge tangent flow) — kierunek z mocnych krawędzi rozlewa się
 *   na płaskie obszary zamiast dosypywania szumu.
 * Każda warstwa pociągnięć pracuje na poziomie piramidy o skali ~R/2 (warstwa 0 na 1/64 pikseli).
 */
import { blurW, run, type RGBImage, type Work } from "./imageOps";

export interface Level {
  w: number;
  h: number;
  /** RGB przeplatane, 0..255. */
  rgb: Float32Array;
  /** Rozmiar piksela poziomu w px roboczych (2^ℓ). */
  scale: number;
}

/** Zmniejszenie 2× filtrem binomialnym [1 3 3 1]/8 (ch kanałów). */
export function* downsampleW(src: Float32Array, w: number, h: number, ch: number): Work<{ w: number; h: number; data: Float32Array }> {
  const w2 = Math.max(1, Math.ceil(w / 2));
  const h2 = Math.max(1, Math.ceil(h / 2));
  const K = [1, 3, 3, 1];
  const tmp = new Float32Array(w2 * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w2; x++) {
      for (let c = 0; c < ch; c++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) {
          const sx = Math.min(w - 1, Math.max(0, 2 * x - 1 + k));
          acc += K[k] * src[(y * w + sx) * ch + c];
        }
        tmp[(y * w2 + x) * ch + c] = acc / 8;
      }
    }
    if ((y & 7) === 7) yield;
  }
  const out = new Float32Array(w2 * h2 * ch);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      for (let c = 0; c < ch; c++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) {
          const sy = Math.min(h - 1, Math.max(0, 2 * y - 1 + k));
          acc += K[k] * tmp[(sy * w2 + x) * ch + c];
        }
        out[(y * w2 + x) * ch + c] = acc / 8;
      }
    }
    if ((y & 7) === 7) yield;
  }
  return { w: w2, h: h2, data: out };
}

export function downsample(src: Float32Array, w: number, h: number, ch: number): { w: number; h: number; data: Float32Array } {
  return run(downsampleW(src, w, h, ch));
}

export function buildPyramid(img: RGBImage, levels: number): Level[] {
  return run(buildPyramidW(img, levels));
}

export function* buildPyramidW(img: RGBImage, levels: number): Work<Level[]> {
  const out: Level[] = [{ w: img.w, h: img.h, rgb: img.rgb, scale: 1 }];
  for (let l = 1; l < levels; l++) {
    const prev = out[l - 1];
    if (prev.w <= 8 || prev.h <= 8) break;
    const d = yield* downsampleW(prev.rgb, prev.w, prev.h, 3);
    out.push({ w: d.w, h: d.h, rgb: d.data, scale: prev.scale * 2 });
  }
  return out;
}

/** Lokalne odchylenie standardowe koloru (pierwiastek sumy wariancji kanałów) w oknie ~r. */
export function localStd(rgb: Float32Array, w: number, h: number, r: number): Float32Array {
  return run(localStdW(rgb, w, h, r));
}

export function* localStdW(rgb: Float32Array, w: number, h: number, r: number): Work<Float32Array> {
  const sq = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) sq[i] = rgb[i] * rgb[i];
  yield;
  const m = yield* blurW(rgb, w, h, 3, r);
  const m2 = yield* blurW(sq, w, h, 3, r);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let v = 0;
    for (let c = 0; c < 3; c++) v += Math.max(0, m2[i * 3 + c] - m[i * 3 + c] * m[i * 3 + c]);
    out[i] = Math.sqrt(v);
  }
  return out;
}

/**
 * Pole kierunków wzdłuż formy: [cos2θ, sin2θ, pewność 0..1] na piksel poziomu.
 * sigma — skala całkowania tensora; normR — okno lokalnej normalizacji siły; flowR — rozlewanie kierunków.
 */
export function orientationRGB(rgb: Float32Array, w: number, h: number, sigma: number, normR: number, flowR: number): Float32Array {
  return run(orientationRGBW(rgb, w, h, sigma, normR, flowR));
}

export function* orientationRGBW(rgb: Float32Array, w: number, h: number, sigma: number, normR: number, flowR: number): Work<Float32Array> {
  const J = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1) * w;
    const y1 = y * w;
    const y2 = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x2 = Math.min(w - 1, x + 1);
      let a = 0;
      let b = 0;
      let c = 0;
      const i00 = (y0 + x0) * 3, i01 = (y0 + x) * 3, i02 = (y0 + x2) * 3;
      const i10 = (y1 + x0) * 3, i12 = (y1 + x2) * 3;
      const i20 = (y2 + x0) * 3, i21 = (y2 + x) * 3, i22 = (y2 + x2) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const gx = rgb[i02 + ch] + 2 * rgb[i12 + ch] + rgb[i22 + ch] - rgb[i00 + ch] - 2 * rgb[i10 + ch] - rgb[i20 + ch];
        const gy = rgb[i20 + ch] + 2 * rgb[i21 + ch] + rgb[i22 + ch] - rgb[i00 + ch] - 2 * rgb[i01 + ch] - rgb[i02 + ch];
        a += gx * gx;
        b += gx * gy;
        c += gy * gy;
      }
      const i = (y1 + x) * 3;
      J[i] = a;
      J[i + 1] = b;
      J[i + 2] = c;
    }
    if ((y & 7) === 7) yield;
  }
  const S = yield* blurW(J, w, h, 3, sigma);
  const tr = new Float32Array(w * h);
  let gMean = 0;
  for (let i = 0; i < w * h; i++) {
    tr[i] = S[i * 3] + S[i * 3 + 2];
    gMean += tr[i];
  }
  gMean = gMean / (w * h) + 1e-6;
  yield;
  const trLocal = yield* blurW(tr, w, h, 1, normR);
  // Wektor kierunku (podwójny kąt) ważony spójnością × lokalnie znormalizowaną siłą.
  const V = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const a = S[i * 3];
    const b = S[i * 3 + 1];
    const c = S[i * 3 + 2];
    const diff = Math.sqrt((a - c) * (a - c) + 4 * b * b);
    const coh = tr[i] > 1e-6 ? diff / tr[i] : 0;
    const strength = Math.min(1, tr[i] / (1.2 * trLocal[i] + 0.03 * gMean));
    const wgt = coh * strength;
    const ox = diff > 1e-6 ? -(a - c) / diff : 0;
    const oy = diff > 1e-6 ? -(2 * b) / diff : 0;
    V[i * 3] = ox * wgt;
    V[i * 3 + 1] = oy * wgt;
    V[i * 3 + 2] = wgt;
    if ((i & 16383) === 16383) yield;
  }
  // Rozlewanie: dwa przejścia ważonego rozmycia z renormalizacją kierunku (ETF-podobne).
  let F: Float32Array = V;
  for (let it = 0; it < 2; it++) {
    const B = yield* blurW(F, w, h, 3, flowR);
    for (let i = 0; i < w * h; i++) {
      const vx = B[i * 3];
      const vy = B[i * 3 + 1];
      const n = Math.hypot(vx, vy);
      const keep = V[i * 3 + 2]; // silne krawędzie trzymają własny kierunek
      const nx = n > 1e-6 ? vx / n : 0;
      const ny = n > 1e-6 ? vy / n : 0;
      const conf = Math.min(1, n * 2.2);
      B[i * 3] = (V[i * 3] + nx * conf * (1 - keep));
      B[i * 3 + 1] = (V[i * 3 + 1] + ny * conf * (1 - keep));
      B[i * 3 + 2] = Math.max(keep, conf);
      if ((i & 16383) === 16383) yield;
    }
    F = B;
  }
  const out = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const vx = F[i * 3];
    const vy = F[i * 3 + 1];
    const n = Math.hypot(vx, vy);
    out[i * 3] = n > 1e-6 ? vx / n : 1;
    out[i * 3 + 1] = n > 1e-6 ? vy / n : 0;
    out[i * 3 + 2] = n > 1e-6 ? Math.min(1, F[i * 3 + 2]) : 0;
  }
  return out;
}

/**
 * Mapa pokrycia `watercolor` przez SYMULACJĘ KOLORU na CPU (fala 2c; dawna heurystyka czasu — coverage.ts).
 * Dla każdego piksela obrazu roboczego (obraz zmniejszony, ~128–256 px) liczymy ścieżkę koloru c(p) jak shader, ale
 * uśrednioną po pikselu roboczym i bez składników o zerowej średniej (ziarno/relief papieru, granulacja, dither) oraz
 * bez kwiatów (backruns). Te same zalążki (seeds.ts → computeSeed w float32), warp i szum lw, harmonogram, top-2 plam,
 * mokrość, ranty, nakładki, ciemny brzeg walorów, laserunki w log-transmitancji, detal lod 2 → 0, ograniczenie
 * przestrzału, tusz i goły papier = szkic. Ścieżka piksela: coverageSimPath.ts.
 *
 * Piksel gotowy od kroku p po OSTATNIM kroku, w którym kolor wychodzi poza tolerancję bramki glow względem obrazu
 * („ostatnia istotna zmiana”; monotoniczne z konstrukcji), najpóźniej przy lokalnym końcu Tdone + 0,03 (shader daje
 * wtedy dokładnie obraz). Komórka = kwantyl `quantile` gotowości jej pikseli (jak atrapa bramki w wave2-gate.cjs).
 * Czyste i deterministyczne. Kalibracja: tools/coverage-eval.cjs, watercolor.md („Fala 2c”).
 */
import { makeH12, vnoise } from "./coverage";
import { cellSizeCPU, seedCellMin } from "./fields";
import { schedule } from "./params";
import { pixelReady, type PixelCtx, type SimLayer } from "./coverageSimPath";

/** Obraz roboczy (rgb 0..1, wiersze od góry). `ink` = średni tusz szkicu w pikselu (z większej rozdzielczości). */
export interface SimImages { w: number; h: number; painted: Float32Array; sketch: Float32Array; ink?: Float32Array }

export interface SimInput {
  fields: { w: number; h: number; data: Float32Array; thr: ArrayLike<number> };
  /** u_res shadera = rozmiar tekstury obrazu (px). */
  resW: number;
  resH: number;
  layers: number;
  independence: number;
  seed: number;
  originX: number;
  originY: number;
  blobSize: number;
  wetness: number;
  bleed: number;
  edgeDark: number;
  drying: number;
  lines: number;
  img: SimImages;
  /** Biel transmitancji (papier pod szkicem); domyślnie #fdfdfd. */
  paper?: [number, number, number];
  /** Szerokość płótna (px wyjścia). fwidth(V) w shaderze liczy się w px płótna, więc pas ciemnego brzegu walorów
   * (u_res.y·0,004 „px”) jest na zmniejszonym płótnie szerszy w px obrazu. Domyślnie = resW. */
  viewW?: number;
}

export interface SimOpts {
  /** Tolerancja modelu na kanał (0..255). Bramka glow ma 28; model dostaje 22 — zapas na składniki pominięte w
   * symulacji (kalibracja w watercolor.md, „Fala 2c”). */
  tol?: number;
  /** Udział pikseli komórki, który musi być gotowy (atrapa bramki: 0,9). */
  quantile?: number;
  /** Liczba kroków p (0..1) ścieżki koloru. */
  steps?: number;
  /** Przesunięcie gotowości (p) — kalibracja. */
  bias?: number;
  /** Diagnostyka: piksele do śledzenia → (i, krok, [r, g, b, liczba warstw covRaw > 0,5]). */
  traceSet?: Set<number>;
  trace?: (i: number, s: number, v: number[]) => void;
}

export const SIM_TOL = 22;
export const SIM_QUANTILE = 0.9;
export const SIM_STEPS = 50;
export const SIM_BIAS = 0;
/** Liczba poziomów lod (tekstury) liczonych na piksel; wyższe = ostatni. */
const NLOD = 8;

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const F32 = Math.fround;

/** h22 z glslCommon.ts w float32 (w float64 hash daje INNE zalążki niż GPU). */
function makeH22(seed: number) {
  const fr = (x: number) => F32(x - Math.floor(x));
  const so = F32(F32(seed) * F32(0.01731));
  return (x: number, y: number): [number, number] => {
    x = F32(x); y = F32(y);
    let a = fr(F32(F32(x * F32(0.1031)) + so)), b = fr(F32(F32(y * F32(0.103)) + so)), c = fr(F32(F32(x * F32(0.0973)) + so));
    const d = F32(F32(F32(a * F32(b + 33.33)) + F32(b * F32(c + 33.33))) + F32(c * F32(a + 33.33)));
    a = F32(a + d); b = F32(b + d); c = F32(c + d);
    return [fr(F32(F32(a + b) * c)), fr(F32(F32(a + c) * b))];
  };
}

/** Piramida (box 2×2) obrazu roboczego; próbka trójliniowa w lod względem rozdzielczości roboczej. */
function pyramid(rgb: Float32Array, w: number, h: number) {
  const lv: { w: number; h: number; d: Float32Array }[] = [{ w, h, d: rgb }];
  while (lv.length < 12) {
    const p = lv[lv.length - 1];
    if (p.w <= 1 && p.h <= 1) break;
    const nw = Math.max(1, p.w >> 1), nh = Math.max(1, p.h >> 1), d = new Float32Array(nw * nh * 3);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const x0 = Math.min(p.w - 1, 2 * x), x1 = Math.min(p.w - 1, 2 * x + 1), y0 = Math.min(p.h - 1, 2 * y), y1 = Math.min(p.h - 1, 2 * y + 1);
      for (let c = 0; c < 3; c++) {
        d[(y * nw + x) * 3 + c] = 0.25 * (p.d[(y0 * p.w + x0) * 3 + c] + p.d[(y0 * p.w + x1) * 3 + c] + p.d[(y1 * p.w + x0) * 3 + c] + p.d[(y1 * p.w + x1) * 3 + c]);
      }
    }
    lv.push({ w: nw, h: nh, d });
  }
  const bil = (l: number, u: number, v: number, out: Float64Array, o: number, wgt: number) => {
    const L = lv[l];
    const x = Math.min(L.w - 1, Math.max(0, u * L.w - 0.5)), y = Math.min(L.h - 1, Math.max(0, v * L.h - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(L.w - 1, x0 + 1), y1 = Math.min(L.h - 1, y0 + 1);
    const ax = x - x0, ay = y - y0, d = L.d;
    for (let c = 0; c < 3; c++) {
      const v0 = d[(y0 * L.w + x0) * 3 + c] * (1 - ax) + d[(y0 * L.w + x1) * 3 + c] * ax;
      const v1 = d[(y1 * L.w + x0) * 3 + c] * (1 - ax) + d[(y1 * L.w + x1) * 3 + c] * ax;
      out[o + c] += wgt * (v0 * (1 - ay) + v1 * ay);
    }
  };
  /** Dodaje do out[o..o+2] próbkę w lod (roboczym). */
  return (lod: number, u: number, v: number, out: Float64Array, o: number) => {
    out[o] = out[o + 1] = out[o + 2] = 0;
    const l = Math.min(lv.length - 1, Math.max(0, lod));
    const l0 = Math.floor(l), f = l - l0;
    bil(l0, u, v, out, o, f > 0 && l0 + 1 < lv.length ? 1 - f : 1);
    if (f > 0 && l0 + 1 < lv.length) bil(l0 + 1, u, v, out, o, f);
  };
}

/** Czas p gotowości każdego piksela obrazu roboczego (synchronicznie — narzędzia/testy). */
export function simReadyTimes(inp: SimInput, o: SimOpts = {}): Float32Array {
  const g = simReadyTimesW(inp, o);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/** Jak simReadyTimes, krojone: yield po każdym wierszu obrazu roboczego (~256 pikseli, ≈ 3–10 ms) — do liczenia w
 * porcjach w wątku głównym (jak strokes: drive + yielder) albo w workerze. */
export function* simReadyTimesW(inp: SimInput, o: SimOpts = {}): Generator<void, Float32Array, void> {
  const { img, fields: F, resW, resH } = inp;
  const { w, h } = img;
  const sc = schedule(inp.layers, inp.independence);
  const L = sc.L;
  const seed = inp.seed % 1000;
  const h12 = makeH12(seed), h22 = makeH22(seed);
  // vnoise woła h12 tylko w węzłach całkowitych → pamięć podręczna węzłów (ta sama wartość, bez liczenia hasha)
  const lat = new Map<number, number>();
  const h12n = (x: number, y: number) => {
    const key = (x + 32768) * 65536 + (y + 32768);
    let v = lat.get(key);
    if (v === undefined) { v = h12(x, y); lat.set(key, v); }
    return v;
  };
  const blob = Math.max(0.2, inp.blobSize);
  const wet = Math.min(1, Math.max(0, inp.wetness));
  const PAPER = inp.paper ?? [0xfd / 255, 0xfd / 255, 0xfd / 255];
  const winK = (k: number) => (k === L - 1 ? 0.6 * sc.Wloc : sc.Wloc);
  const capK = (k: number) => 0.965 - winK(L - 1) - (L - 1 - k) * 0.02;
  const field = (ch: number, u: number, v: number) => {
    const x = Math.min(F.w - 1, Math.max(0, u * F.w - 0.5)), y = Math.min(F.h - 1, Math.max(0, v * F.h - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(F.w - 1, x0 + 1), y1 = Math.min(F.h - 1, y0 + 1);
    const ax = x - x0, ay = y - y0, g = (xx: number, yy: number) => F.data[(yy * F.w + xx) * 4 + ch];
    return (g(x0, y0) * (1 - ax) + g(x1, y0) * ax) * (1 - ay) + (g(x0, y1) * (1 - ax) + g(x1, y1) * ax) * ay;
  };
  const jScale = 1 / (0.3 * resH);
  const startK = (k: number, u: number, v: number) => {
    const j = (vnoise(h12n, u * resW * jScale + k * 19.3, v * resH * jScale + k * 19.3) - 0.5) * 2 * sc.J;
    const s0 = sc.HOLD + field(0, u, v) * (k === 0 ? sc.SP0 : sc.SP) + k * sc.D + j * (k === 0 ? 0.5 : 1);
    return Math.min(capK(k), Math.max(0, s0));
  };
  // Zalążki warstw w gęstych siatkach (komórki −4 … ceil(res/S)+4, jak seedLayout): sp, t0, a2, a3 (computeSeed).
  const cellMin = seedCellMin(resW, resH, blob);
  const aspect = resW / resH;
  const lays: SimLayer[] = [];
  const grids: { x0: number; y0: number; gw: number; gh: number; d: Float64Array }[] = [];
  for (let k = 0; k < L; k++) {
    const S = Math.max(cellMin, cellSizeCPU(k, L, resW, resH, blob));
    const Wk = winK(k), dur = Wk * (0.35 + 0.25 * wet);
    lays.push({ S, R: 1.7 * S, Wk, dur, dryT: dur * (0.5 + 1.1 * wet), detail: k === L - 1, kf: k / Math.max(L - 1, 1) });
    const gx0 = -5, gy0 = -5, gw = Math.ceil(resW / S) + 11, gh = Math.ceil(resH / S) + 11;
    const d = new Float64Array(gw * gh * 7);
    const off = (m: number) => F32(F32(k) * F32(m)); // float(k)·m jak w GLSL (float32)
    for (let cy = gy0; cy < gy0 + gh; cy++) for (let cx = gx0; cx < gx0 + gw; cx++) {
      const b = ((cy - gy0) * gw + (cx - gx0)) * 7;
      const [hx, hy] = h22(F32(cx + off(71.3)), F32(cy + off(71.3)));
      const spx = (cx + 0.1 + 0.8 * hx) * S, spy = (cy + 0.1 + 0.8 * hy) * S;
      const e = h12(F32(F32(cx + off(5.7)) + F32(2.3)), F32(F32(cy + off(5.7)) + F32(2.3)));
      let t0 = startK(k, spx / resW, spy / resH) + 0.25 * (Wk - dur) * e;
      if (k === 0) t0 = Math.min(t0, sc.HOLD + 0.15 * Math.hypot(spx / resH - inp.originX * aspect, spy / resH - inp.originY));
      const a2 = h22(F32(F32(cx + off(9.1)) + F32(3.7)), F32(F32(cy + off(9.1)) + F32(3.7)));
      const a3 = h22(F32(F32(cx + off(4.3)) + F32(8.9)), F32(F32(cy + off(4.3)) + F32(8.9)));
      d[b] = spx; d[b + 1] = spy; d[b + 2] = t0; d[b + 3] = a2[0] - 0.5; d[b + 4] = a2[1] - 0.5; d[b + 5] = a3[0] - 0.5; d[b + 6] = a3[1] - 0.5;
    }
    grids.push({ x0: gx0, y0: gy0, gw, gh, d });
  }

  const lodOff = Math.log2(Math.max(resW / w, resH / h));
  const pyr = pyramid(img.painted, w, h);
  const pxPerWork = Math.max(resW / w, resH / h);
  /** px płótna na piksel roboczy. */
  const pcPerWork = Math.max(1, (inp.viewW ?? resW) / w);
  const ctx: PixelCtx = {
    L, lays, sc, tol: (o.tol ?? SIM_TOL) / 255, steps: Math.max(4, Math.round(o.steps ?? SIM_STEPS)), P: pxPerWork,
    wet, bleed: inp.bleed, edge: inp.edgeDark, drying: inp.drying, lines: inp.lines, resH, PAPER, thr: inp.fields.thr,
    // per piksel (wypełniane niżej)
    lin: new Float64Array(NLOD * 3), NLOD, sk0: new Float64Array(L), nC: new Int32Array(L), cT0: new Float64Array(L * 25),
    cD: new Float64Array(L * 25), cT: new Float64Array(L * 25), inV: new Float64Array(L), edgeVs: new Float64Array(L), ref: [0, 0, 0], sk: [0, 0, 0], ink: 0,
    trace: null,
  };
  // V (lod 3,2) w całej siatce roboczej — gradient do szerokości rampy walorów.
  const tmp = new Float64Array(3);
  const meanLog = (o3: Float64Array) => {
    let s = 0;
    for (let c = 0; c < 3; c++) s += Math.log(Math.min(1.25, Math.max(0.012, o3[c] / PAPER[c])));
    return s / 3;
  };
  const Vmap = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { pyr(3.2 - lodOff, (x + 0.5) / w, (y + 0.5) / h, tmp, 0); Vmap[y * w + x] = -meanLog(tmp); }

  const out = new Float32Array(w * h);
  const bias = o.bias ?? SIM_BIAS;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x === 0 && y > 0) yield;
    const i = y * w + x, u = (x + 0.5) / w, v = (y + 0.5) / h, px = u * resW, py = v * resH;
    for (let c = 0; c < 3; c++) { ctx.ref[c] = img.painted[i * 3 + c]; ctx.sk[c] = img.sketch[i * 3 + c]; }
    const sk = ctx.sk;
    ctx.ink = img.ink ? img.ink[i] : ss(0.08, 0.85, 1 - (0.299 * sk[0] + 0.587 * sk[1] + 0.114 * sk[2]));
    for (let l = 0; l < NLOD; l++) pyr(l - lodOff, u, v, ctx.lin, l * 3);
    // walory: V (lod 3,2), Vg (lod 4,6), szerokość rampy z gradientu V
    pyr(4.6 - lodOff, u, v, tmp, 0);
    const Vg = -meanLog(tmp), V = Vmap[i];
    const gx = (Vmap[y * w + Math.min(w - 1, x + 1)] - Vmap[y * w + Math.max(0, x - 1)]) * 0.5;
    const gy = (Vmap[Math.min(h - 1, y + 1) * w + x] - Vmap[Math.max(0, y - 1) * w + x]) * 0.5;
    const Vw = Math.max(1e-4, Math.hypot(gx, gy) / pcPerWork); // na px płótna (jak fwidth)
    const fx = field(1, u, v), fy = field(2, u, v);
    for (let k = 0; k < L; k++) {
      const ly = lays[k], S = ly.S, R = ly.R;
      ctx.sk0[k] = startK(k, u, v);
      // kandydaci (zalążki 5×5 wokół q, w zasięgu R + 1 px) — reszta nie wpływa na cov/ring/nakładkę
      const lwx = vnoise(h12n, px / (0.45 * S) + k * 13.1, py / (0.45 * S) + k * 13.1) - 0.5;
      const lwy = vnoise(h12n, px / (0.45 * S) + k * 13.1 + 41, py / (0.45 * S) + k * 13.1 + 41) - 0.5;
      const qx = px + fx * S * 0.8 + lwx * S * 0.3, qy = py + fy * S * 0.8 + lwy * S * 0.3;
      const cx = Math.floor(qx / S), cy = Math.floor(qy / S), g = grids[k];
      let n = 0;
      const reach2 = ((R + 1 + 0.5 * pxPerWork) * 1.2975) ** 2;
      for (let j = -2; j <= 2; j++) for (let ii = -2; ii <= 2; ii++) {
        const b = ((cy + j - g.y0) * g.gw + (cx + ii - g.x0)) * 7, s = g.d;
        const dx = qx - s[b], dy = qy - s[b + 1], l2 = dx * dx + dy * dy;
        if (l2 > reach2) continue; // d = len/shape ≥ len/1,2975
        const len = Math.sqrt(l2) + 1e-4;
        const nx = dx / len, ny = dy / len;
        const shape = 1 + 0.26 * ((nx * nx - ny * ny) * s[b + 3] + 2 * nx * ny * s[b + 4]) + 0.16 * (nx * (4 * nx * nx - 3) * s[b + 5] + ny * (3 - 4 * ny * ny) * s[b + 6]);
        const d = len / shape;
        if (d > R + 1 + 0.5 * pxPerWork) continue;
        ctx.cT0[k * 25 + n] = s[b + 2]; ctx.cD[k * 25 + n] = d;
        ctx.cT[k * 25 + n] = s[b + 2] + ly.dur * Math.pow(Math.min(d / R, 2), 1.5385); n++;
      }
      ctx.nC[k] = n;
      // bramka walorowa laserunków środkowych i ciemny brzeg (uśrednione po pikselu roboczym)
      ctx.inV[k] = 1; ctx.edgeVs[k] = 0;
      if (!ly.detail && k > 0) {
        const t = ctx.thr[k - 1], dpx = (V - t) / Vw, Pw = pcPerWork;
        ctx.inV[k] = ss(-0.7 - 0.5 * Pw, 0.7 + 0.5 * Pw, dpx) * ss(t - 0.12, t - 0.03, Vg);
        const ewV = resH * 0.004 * (1 + wet), a = Math.max(0, dpx - Pw / 2), bb = Math.max(0, dpx + Pw / 2);
        ctx.edgeVs[k] = ss(t - 0.12, t - 0.03, Vg) * (ewV * (Math.exp(-a / ewV) - Math.exp(-bb / ewV))) / Pw;
      }
    }
    ctx.trace = o.traceSet?.has(i) && o.trace ? (s: number, vals: number[]) => o.trace!(i, s, vals) : null;
    out[i] = Math.min(1, Math.max(0, pixelReady(ctx) + bias));
  }
  return out;
}

/** Siatka gw×gh: kwantyl q czasów gotowości pikseli komórki (jak atrapa bramki). */
export function aggregateReady(t: Float32Array, w: number, h: number, gw: number, gh: number, q = SIM_QUANTILE): Float32Array {
  const out = new Float32Array(gw * gh);
  const v: number[] = [];
  for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
    v.length = 0;
    const y0 = Math.floor((cy * h) / gh), y1 = Math.max(y0 + 1, Math.ceil(((cy + 1) * h) / gh));
    const x0 = Math.floor((cx * w) / gw), x1 = Math.max(x0 + 1, Math.ceil(((cx + 1) * w) / gw));
    for (let y = y0; y < Math.min(h, y1); y++) for (let x = x0; x < Math.min(w, x1); x++) v.push(t[y * w + x]);
    v.sort((a, b) => a - b);
    out[cy * gw + cx] = v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 1;
  }
  return out;
}

export function coverageSimGrid(inp: SimInput, gw: number, gh: number, o: SimOpts = {}): Float32Array {
  return aggregateReady(simReadyTimes(inp, o), inp.img.w, inp.img.h, Math.round(gw), Math.round(gh), o.quantile ?? SIM_QUANTILE);
}

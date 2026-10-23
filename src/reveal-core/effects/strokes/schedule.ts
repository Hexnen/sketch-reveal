/**
 * Harmonogram LOKALNY (warstwy przenikają się przestrzennie, nie „fala za falą”):
 *   start_i = S·T(x) + k·D + W_k·u_i,   T = wyrównane (ranga) pole kolejności (głębia + fbm + regiony
 *   podmalówki), S ≥ 2D → w środku animacji 3+ warstwy naraz w różnych miejscach.
 * Przyczynowość: mapa końców E (¼ rozdzielczości) — pociągnięcie warstwy k zaczyna się dopiero po końcu
 * grubszych pod nim (+gap), więc detal nie ląduje pod podmalówką.
 * Warp osi: t' = 0.3·τ + 0.7·CDF_powierzchni(τ) — stałe tempo malowania (bez zalewu i martwego końca).
 * Lista sortowana po końcu (prefiks = ukończone) → akumulacja i checkpointy jak wcześniej.
 * Kompozyt liczy lokalne etapy (podkład, gaśnięcie linii, glazura) w czasie τ = warp⁻¹(t).
 */
import { blurW, rng, run, valueNoise, type Work } from "./imageOps";
import type { StrokesParams } from "./params";
import { INST_STRIDE, type StrokeSet } from "./strokeGen";

export interface Schedule {
  /** Dane instancji posortowane po końcu (start/dur już w czasie t' po warpie). */
  inst: Float32Array;
  starts: Float32Array;
  ends: Float32Array;
  maxDur: number;
  /** Pole kolejności T (gw×gh, 0..1) do kompozytu. */
  T: Float32Array;
  gw: number;
  gh: number;
  /** Stałe kompozytu (τ): S i etapy [start, szerokość] względem S·T. */
  S: number;
  ground: [number, number];
  ink: [number, number];
  fin: [number, number];
  /** Tablica warpu τ → t' (WARP_N+1 węzłów). */
  warp: Float32Array;
  /** Pociągnięcia przesunięte przez przyczynowość (diagnostyka). */
  shifted: number;
}

const WARP_N = 1024;

/**
 * Permutacja indeksów posortowana po `ends` rosnąco, remisy po indeksie — ta sama co
 * `idx.sort((i, j) => ends[i] - ends[j] || i - j)`, ale stabilnym sortowaniem pozycyjnym po bitach float32
 * (dla liczb ≥ 0 porządek bitów = porządek wartości): O(n) zamiast O(n log n) z komparatorem.
 */
function sortByEnd(ends: Float32Array): Uint32Array | number[] {
  const n = ends.length;
  for (let i = 0; i < n; i++) {
    if (!(ends[i] > 0)) return Array.from({ length: n }, (_, k) => k).sort((a, b) => ends[a] - ends[b] || a - b);
  }
  const bits = new Uint32Array(ends.buffer, ends.byteOffset, n);
  let src = new Uint32Array(n);
  let dst = new Uint32Array(n);
  for (let i = 0; i < n; i++) src[i] = i;
  for (let shift = 0; shift < 32; shift += 16) {
    const cnt = new Uint32Array(65537);
    for (let i = 0; i < n; i++) cnt[((bits[i] >>> shift) & 0xffff) + 1]++;
    for (let k = 0; k < 65536; k++) cnt[k + 1] += cnt[k];
    for (let i = 0; i < n; i++) {
      const v = src[i];
      dst[cnt[(bits[v] >>> shift) & 0xffff]++] = v;
    }
    [src, dst] = [dst, src];
  }
  return src;
}

function rankEqualize(a: Float32Array): Float32Array {
  const idx = Array.from(a.keys()).sort((i, j) => a[i] - a[j]);
  const out = new Float32Array(a.length);
  const n = Math.max(1, a.length - 1);
  idx.forEach((i, r) => { out[i] = r / n; });
  return out;
}

function* orderField(set: StrokeSet, p: StrokesParams, hz: Float32Array): Work<Float32Array> {
  const { gw, gh, region } = set.order;
  const raw = new Float32Array(gw * gh);
  const wd = Math.min(1, Math.max(0, p.orderDepth));
  const ox = p.originX * gw;
  const oy = p.originY * gh;
  const dMax = Math.hypot(Math.max(ox, gw - ox), Math.max(oy, gh - oy)) || 1;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const dist = Math.hypot(x + 0.5 - ox, y + 0.5 - oy) / dMax;
      const depth = 0.5 * dist + 0.5 * (1 - hz[i]); // daleko (zamglone) → wcześniej
      const fbm = valueNoise(x / (0.3 * gh), y / (0.3 * gh), p.seed + 41);
      raw[i] = wd * depth + (1 - wd) * (0.6 * fbm + 0.4 * region[i]);
    }
    if ((y & 7) === 7) yield;
  }
  const b = yield* blurW(raw, gw, gh, 1, 0.04 * gh);
  yield;
  return rankEqualize(b);
}

function sampleGrid(T: Float32Array, gw: number, gh: number, u: number, v: number): number {
  const x = Math.min(gw - 1.001, Math.max(0, u * gw - 0.5));
  const y = Math.min(gh - 1.001, Math.max(0, v * gh - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = T[y0 * gw + x0];
  const b = T[y0 * gw + x0 + 1];
  const c = T[(y0 + 1) * gw + x0];
  const d = T[(y0 + 1) * gw + x0 + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function buildSchedule(set: StrokeSet, p: StrokesParams): Schedule {
  return run(buildScheduleW(set, p));
}

/** Jak buildSchedule, krojone na porcje (renderer: `drive` przy zmianie harmonogramu — bez zadań > 50 ms). */
export function* buildScheduleW(set: StrokeSet, p: StrokesParams): Work<Schedule> {
  const L = set.layerRadius.length;
  const { gw, gh } = set.order;
  const hzEq = rankEqualize(set.order.haze);
  yield;
  const T = yield* orderField(set, p, hzEq);
  const F = p.finish;
  const S = p.spread;
  const rMax = set.layerRadius[0] || 1;
  const durOf = (k: number) => 0.01 + 0.05 * (set.layerRadius[k] / rMax);
  const durLast = durOf(L - 1);
  const o = p.layerOverlap;
  const avail = Math.max(0.05, 1 - S - F - durLast);
  const D = L > 1 ? avail / (L - 1 + 1.4 * o) : 0;
  const Wk = (k: number) => (L === 1 ? avail : (k === L - 1 ? 1.4 : 1) * o * D);
  const tEnd = 1 - 0.5 * F;

  const raw = set.inst;
  const n = set.count;
  const starts = new Float32Array(n);
  const ends = new Float32Array(n);
  const rand = rng(p.seed + 2);
  // Mapa końców grubszych warstw (¼ rozdzielczości roboczej).
  const ew = Math.max(1, Math.ceil(set.w / 4));
  const eh = Math.max(1, Math.ceil(set.h / 4));
  const E = new Float32Array(ew * eh);
  const gap = 0.004;
  let shifted = 0;
  const pt = (i: number, j: number) => {
    const off = raw[i * INST_STRIDE];
    const np = raw[i * INST_STRIDE + 1];
    const q = (off + Math.min(np - 1, j)) * 2;
    return [set.points[q], set.points[q + 1]];
  };
  for (let k = 0; k < L; k++) {
    const a = set.layerStart[k];
    const b = set.layerStart[k + 1];
    const dur = durOf(k);
    for (let i = a; i < b; i++) {
      const np = raw[i * INST_STRIDE + 1];
      const [mx, my] = pt(i, Math.floor(np / 2));
      let st = S * sampleGrid(T, gw, gh, mx / set.w, my / set.h) + k * D + Wk(k) * rand();
      if (k > 0) {
        let m = 0;
        for (let s = 0; s < 5; s++) {
          const [x, y] = pt(i, Math.round(((np - 1) * s) / 4));
          const ex = Math.min(ew - 1, Math.max(0, Math.floor(x / 4)));
          const ey = Math.min(eh - 1, Math.max(0, Math.floor(y / 4)));
          m = Math.max(m, E[ey * ew + ex]);
        }
        if (m + gap > st) { st = m + gap; shifted++; }
      }
      st = Math.min(st, tEnd - dur);
      starts[i] = st;
      ends[i] = st + dur;
      if ((i & 1023) === 1023) yield;
    }
    if (k === L - 1) break;
    // Stempel końców tej warstwy (kapsuła ~R wokół punktów).
    for (let i = a; i < b; i++) {
      const np = raw[i * INST_STRIDE + 1];
      const r = Math.max(1, Math.round(raw[i * INST_STRIDE + 2] / 4));
      for (let j = 0; j < np; j++) {
        const [x, y] = pt(i, j);
        const cx = Math.floor(x / 4);
        const cy = Math.floor(y / 4);
        for (let yy = Math.max(0, cy - r); yy <= Math.min(eh - 1, cy + r); yy++) {
          for (let xx = Math.max(0, cx - r); xx <= Math.min(ew - 1, cx + r); xx++) {
            if ((xx - cx) ** 2 + (yy - cy) ** 2 > r * r) continue;
            const e = yy * ew + xx;
            if (ends[i] > E[e]) E[e] = ends[i];
          }
        }
      }
      if ((i & 511) === 511) yield;
    }
  }

  // Warp osi po skumulowanej ZMIANIE WIDOCZNEJ (po końcach): powierzchnia × kontrast. Podmalówka kładzie
  // ciemną farbę na białym papierze (duża zmiana), dalsze warstwy poprawiają o ~próg; plus glazura regionów.
  const hist = new Float64Array(WARP_N + 1);
  let tot = 0;
  for (let i = 0; i < n; i++) {
    const o = i * INST_STRIDE;
    const R = raw[o + 2];
    let wgt = R * (2 * R + raw[o + 3]);
    if (set.layer[i] === 0) {
      const dc = Math.hypot(0.96 - raw[o + 4], 0.955 - raw[o + 5], 0.93 - raw[o + 6]) * 255;
      wgt *= Math.max(1, dc / 25);
    }
    hist[Math.min(WARP_N, Math.max(0, Math.round(ends[i] * WARP_N)))] += wgt;
    tot += wgt;
    if ((i & 8191) === 8191) yield;
  }
  const fin0 = (L - 1) * D + Wk(L - 1) + durLast;
  const gWeight = (0.06 * tot) / (gw * gh);
  const fBins = Math.max(1, Math.round(F * WARP_N));
  for (let i = 0; i < gw * gh; i++) {
    const b0 = Math.round((S * T[i] + fin0) * WARP_N);
    for (let b = 0; b < fBins; b++) hist[Math.min(WARP_N, Math.max(0, b0 + b))] += gWeight / fBins;
  }
  tot += 0.06 * tot;
  const warp = new Float32Array(WARP_N + 1);
  let acc = 0;
  for (let j = 0; j <= WARP_N; j++) {
    acc += hist[j];
    warp[j] = 0.3 * (j / WARP_N) + 0.7 * (tot > 0 ? acc / tot : j / WARP_N);
  }
  warp[0] = 0;
  const fw = (t: number) => {
    const x = Math.min(1, Math.max(0, t)) * WARP_N;
    const j = Math.min(WARP_N - 1, Math.floor(x));
    return warp[j] + (warp[j + 1] - warp[j]) * (x - j);
  };

  // Sort po końcu (stabilnie) + permutacja wierszy instancji.
  const idx = sortByEnd(ends);
  yield;
  const inst = new Float32Array(n * INST_STRIDE);
  const sS = new Float32Array(n);
  const sE = new Float32Array(n);
  let maxDur = 0;
  for (let r = 0; r < n; r++) {
    const i = idx[r];
    inst.set(raw.subarray(i * INST_STRIDE, (i + 1) * INST_STRIDE), r * INST_STRIDE);
    sS[r] = fw(starts[i]);
    sE[r] = Math.max(sS[r] + 1e-6, fw(ends[i]));
    inst[r * INST_STRIDE + 8] = sS[r];
    inst[r * INST_STRIDE + 9] = sE[r] - sS[r];
    maxDur = Math.max(maxDur, sE[r] - sS[r]);
    if ((r & 4095) === 4095) yield;
  }
  // fw monotoniczna, ale float — wymuś niemalejące końce dla upperBound.
  for (let r = 1; r < n; r++) if (sE[r] < sE[r - 1]) sE[r] = sE[r - 1];

  const kInk = Math.max(0, L - 2);
  return {
    inst, starts: sS, ends: sE, maxDur, T, gw, gh, S, warp, shifted,
    ground: L > 1 ? [D, Wk(1)] : [0.7 * Wk(0), 0.3 * Wk(0)],
    ink: [kInk * D, Wk(kInk)],
    fin: [fin0, F],
  };
}

/** τ = warp⁻¹(t) (wyszukiwanie binarne w tablicy). */
export function unwarp(warp: Float32Array, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0;
  let hi = warp.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (warp[mid] <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - warp[lo]) / Math.max(1e-9, warp[hi] - warp[lo]);
  return (lo + f) / (warp.length - 1);
}

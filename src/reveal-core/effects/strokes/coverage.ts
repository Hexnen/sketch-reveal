/**
 * Siatka pokrycia efektu „strokes” liczona na CPU (kontrakt `EffectInstance.coverage`, combined-perf.md P3/K1):
 * dla każdej komórki w×h najmniejsze p, przy którym ≥ COV_FRAC jej próbek jest już „pomalowane” w mierze bramki
 * glow (kolor klatki w tolerancji od obrazu). Bez GL — tylko lista pociągnięć + harmonogram:
 *  - pociągnięcia (posortowane po końcu, czyli w kolejności wejścia do akumulacji): stempel kapsuły promienia R
 *    na siatce próbek (¼ rozdzielczości roboczej); próbka bierze kolor wierzchniego pociągnięcia (A: pierwsza połowa
 *    śladu, B: druga, detal: 25% koloru + 75% obrazu jak w shaderze) i staje się pokryta przy pierwszym końcu,
 *    po którym ten kolor leży w tolerancji od obrazu (akumulacja warstw coarse→fine);
 *  - glazura (kompozyt): fin = smoothstep((τ − S·T − fin0)/F) dociąga kolor do obrazu → próbka pokryta, gdy
 *    fin ≥ GLAZE_FIN, w czasie osi p = warp(τ).
 * Próbka = min(obie drogi); komórka = kwantyl COV_FRAC czasów jej próbek. Kalibracja i zgodność z klatkami:
 * docs/reveal-effects/strokes.md („Fala 2”), narzędzie tools/strokes-wave2.cjs coverage.
 */
import { simSampleTimesW } from "./coverageSim";
import { run, type RGBImage, type Work } from "./imageOps";
import type { Schedule } from "./schedule";
import { INST_STRIDE, type StrokeSet } from "./strokeGen";

/**
 * Tolerancja koloru próbki (0..255, maks. kanał) względem średniego koloru pociągnięcia. Bramka glow ma 28 na
 * pikselach; tu porównujemy kolor ŚREDNI pociągnięcia (bez włosia), więc kalibracja dała więcej (strokes.md).
 */
const COLOR_TOL = 40;
/** Tolerancja przyciemnienia liniami szkicu (0,3·ink·kolor) przed lokalnym etapem „ink”. */
const INK_TOL = 10;
/** Udział pomalowanych próbek komórki, od którego komórka jest pokryta (bramka glow: 0,9 → pełna). */
const COV_FRAC = 0.9;
/** Poziom glazury, przy którym resztkowa różnica (1 − fin)·Δ mieści się w tolerancji. */
const GLAZE_FIN = 0.75;
/** true = próbka pokryta od ostatniego wejścia w zgodność (nie od pierwszego). */
const STABLE = true;
/** Krok siatki próbek w px roboczych (jak mapa końców w schedule.ts). */
const SUB = 4;

export interface CoverageOptions {
  tol?: number; frac?: number; glazeFin?: number; inkTol?: number; stable?: boolean;
  /** true = dawny model progowy (fala 2) zamiast symulacji koloru coverageSim.ts (fala 2c) — porównania. */
  legacy?: boolean;
}

/** Wejście poza listą: szkic w rozdzielczości roboczej i kolor papieru pod nim (0..1) — klatka p=0. */
export interface CoverageBase { sketch?: RGBImage | null; tint?: [number, number, number] }

export interface SampleTimes { t: Float32Array; sw: number; sh: number }

/** Odwrotność smoothstep na [0,1] (x, dla którego 3x² − 2x³ = y). */
function invSmooth(y: number): number {
  const v = Math.min(1, Math.max(0, y));
  return 0.5 - Math.sin(Math.asin(1 - 2 * v) / 3);
}

/** t' = warp(τ) — interpolacja liniowa tablicy (jak `fw` w buildSchedule). */
function warpFwd(warp: Float32Array, tau: number): number {
  const N = warp.length - 1;
  const x = Math.min(1, Math.max(0, tau)) * N;
  const j = Math.min(N - 1, Math.floor(x));
  return warp[j] + (warp[j + 1] - warp[j]) * (x - j);
}

/** Próbka pola T jak tekstura LINEAR + CLAMP_TO_EDGE (uv 0..1). */
function sampleT(T: Float32Array, gw: number, gh: number, u: number, v: number): number {
  const x = Math.min(gw - 1, Math.max(0, u * gw - 0.5));
  const y = Math.min(gh - 1, Math.max(0, v * gh - 0.5));
  const x0 = Math.min(gw - 1, Math.floor(x));
  const y0 = Math.min(gh - 1, Math.floor(y));
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = T[y0 * gw + x0] + (T[y0 * gw + x1] - T[y0 * gw + x0]) * fx;
  const b = T[y1 * gw + x0] + (T[y1 * gw + x1] - T[y1 * gw + x0]) * fx;
  return a + (b - a) * fy;
}

/** Obraz na siatce próbek (średnia bloku SUB×SUB w rozdzielczości roboczej). */
function* blockMean(img: RGBImage, sw: number, sh: number): Work<Float32Array> {
  const N = sw * sh;
  const ref = new Float32Array(N * 3);
  const cnt = new Float32Array(N);
  for (let y = 0; y < img.h; y++) {
    const row = Math.min(sh - 1, Math.floor(y / SUB)) * sw;
    for (let x = 0; x < img.w; x++) {
      const s = row + Math.min(sw - 1, Math.floor(x / SUB));
      const i = (y * img.w + x) * 3;
      ref[s * 3] += img.rgb[i];
      ref[s * 3 + 1] += img.rgb[i + 1];
      ref[s * 3 + 2] += img.rgb[i + 2];
      cnt[s]++;
    }
    if ((y & 15) === 15) yield;
  }
  for (let s = 0; s < N; s++) {
    const k = 1 / (cnt[s] || 1);
    ref[s * 3] *= k; ref[s * 3 + 1] *= k; ref[s * 3 + 2] *= k;
  }
  return ref;
}

/** Czas pokrycia każdej próbki (sw×sh, ¼ rozdzielczości roboczej). Czyste, deterministyczne. */
export function sampleTimes(set: StrokeSet, sched: Schedule, work: RGBImage, base: CoverageBase = {}, o: CoverageOptions = {}): SampleTimes {
  return run(sampleTimesW(set, sched, work, base, o));
}

/** Jak sampleTimes, krojone na porcje (renderer liczy to asynchronicznie przy pierwszym coverage()). */
export function* sampleTimesW(set: StrokeSet, sched: Schedule, work: RGBImage, base: CoverageBase = {}, o: CoverageOptions = {}): Work<SampleTimes> {
  // Fala 2c: symulacja koloru (akumulacja z alfą włosia, wzrost pociągnięć, kompozyt) — strokes.md „Fala 2c”.
  if (!o.legacy) return yield* simSampleTimesW(set, sched, work, base, o.tol !== undefined ? { tol: o.tol } : {});
  const tol = o.tol ?? COLOR_TOL;
  const sw = Math.max(1, Math.ceil(set.w / SUB));
  const sh = Math.max(1, Math.ceil(set.h / SUB));
  const N = sw * sh;
  const ref = yield* blockMean(work, sw, sh);

  const t = new Float32Array(N).fill(Infinity);
  const stable = o.stable ?? STABLE;
  // Klatka p=0 (szkic na papierze) już zgodna z obrazem (jasne, płaskie miejsca) → pokryte od 0.
  const zero = new Uint8Array(N);
  const sk = base.sketch && base.sketch.w === work.w && base.sketch.h === work.h ? yield* blockMean(base.sketch, sw, sh) : null;
  if (sk) {
    const tint = base.tint ?? [1, 1, 1];
    for (let s = 0; s < N; s++) {
      let ok = true;
      for (let c = 0; c < 3 && ok; c++) if (Math.abs(sk[s * 3 + c] * tint[c] - ref[s * 3 + c]) > tol) ok = false;
      if (ok) zero[s] = 1;
    }
  }
  const inst = sched.inst;
  const pts = set.points;
  const n = set.count;
  for (let r = 0; r < n; r++) {
    const b = r * INST_STRIDE;
    const off = inst[b];
    const np = inst[b + 1];
    const R = inst[b + 2];
    const end = sched.ends[r];
    const texMix = inst[b + 10];
    const rr = Math.max(0.5, R / SUB);
    const half = Math.max(1, Math.ceil(np / 2));
    for (let j = 0; j < np; j++) {
      const q = (off + j) * 2;
      const cx = pts[q] / SUB;
      const cy = pts[q + 1] / SUB;
      const cb = j < half ? 4 : 12; // kolor A (pierwsza połowa) / B (druga)
      const x0 = Math.max(0, Math.floor(cx - rr));
      const x1 = Math.min(sw - 1, Math.floor(cx + rr));
      const y0 = Math.max(0, Math.floor(cy - rr));
      const y1 = Math.min(sh - 1, Math.floor(cy + rr));
      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - cy;
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx;
          if (dx * dx + dy * dy > rr * rr) continue;
          const s = y * sw + x;
          if (!stable && t[s] !== Infinity) continue;
          let ok = true;
          for (let c = 0; c < 3 && ok; c++) {
            const rc = ref[s * 3 + c];
            const col = Math.min(255, inst[b + cb + c] * 255) * (1 - texMix) + rc * texMix;
            if (Math.abs(col - rc) > tol) ok = false;
          }
          // stable: czas OSTATNIEGO wejścia w zgodność (wierzchnie pociągnięcie może ją znów zepsuć)
          if (ok) { if (t[s] === Infinity) t[s] = end; } else if (stable) t[s] = Infinity;
        }
      }
    }
    if ((r & 255) === 255) yield;
  }

  // Linie szkicu na farbie (kompozyt: kolor × (1 − 0,3·ink·(1 − inkGone))) gasną dopiero z lokalnym etapem
  // „ink” → pociągnięcie zgodne kolorem liczy się od τ, przy którym przyciemnienie mieści się w tolerancji.
  // Glazura: τ, przy którym fin ≥ GLAZE_FIN, → p = warp(τ).
  const gf = o.glazeFin ?? GLAZE_FIN; // > 1 = bez glazury (diagnostyka)
  const sFin = gf > 1 ? 2 : invSmooth(gf);
  const [fin0, F] = sched.fin;
  const [ink0, inkW] = sched.ink;
  const inkTol = o.inkTol ?? INK_TOL;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const s = y * sw + x;
      const u = ((x + 0.5) * SUB) / set.w;
      const v = ((y + 0.5) * SUB) / set.h;
      const b0 = sched.S * sampleT(sched.T, sched.gw, sched.gh, u, v);
      const tau = b0 + fin0 + F * sFin;
      const tg = sFin > 1 ? Infinity : tau >= 1 ? 1 : warpFwd(sched.warp, tau);
      if (sk && t[s] < Infinity && inkTol >= 0) {
        const ink = 1 - (0.299 * sk[s * 3] + 0.587 * sk[s * 3 + 1] + 0.114 * sk[s * 3 + 2]) / 255;
        const mx = Math.max(ref[s * 3], ref[s * 3 + 1], ref[s * 3 + 2]);
        const need = 0.3 * ink * mx; // przyciemnienie przy inkGone = 0
        if (need > inkTol) {
          const ti = b0 + ink0 + inkW * invSmooth(1 - inkTol / need);
          const tp = ti >= 1 ? 1 : warpFwd(sched.warp, ti);
          if (tp > t[s]) t[s] = tp;
        }
      }
      if (tg < t[s]) t[s] = tg;
      if (zero[s]) t[s] = 0;
      if (t[s] > 1) t[s] = 1; // p ≥ 1 = czysty obraz
    }
    if ((y & 15) === 15) yield;
  }
  return { t, sw, sh };
}

/** Siatka w×h (wiersze od góry) z czasów próbek: kwantyl `frac` czasów próbek komórki. Tanie (bez listy). */
export function aggregateCoverage(st: SampleTimes, w: number, h: number, o: CoverageOptions = {}): Float32Array {
  const gw = Math.max(1, Math.round(w));
  const gh = Math.max(1, Math.round(h));
  const { t, sw, sh } = st;
  const frac = o.frac ?? COV_FRAC;
  const buckets: number[][] = Array.from({ length: gw * gh }, () => []);
  for (let y = 0; y < sh; y++) {
    const cy = Math.min(gh - 1, Math.floor(((y + 0.5) * gh) / sh));
    for (let x = 0; x < sw; x++) {
      const cx = Math.min(gw - 1, Math.floor(((x + 0.5) * gw) / sw));
      buckets[cy * gw + cx].push(t[y * sw + x]);
    }
  }
  const out = new Float32Array(gw * gh);
  for (let c = 0; c < gw * gh; c++) {
    const b = buckets[c];
    if (!b.length) {
      // komórka mniejsza niż próbka: najbliższa próbka
      const x = Math.min(sw - 1, Math.floor((((c % gw) + 0.5) * sw) / gw));
      const y = Math.min(sh - 1, Math.floor(((Math.floor(c / gw) + 0.5) * sh) / gh));
      out[c] = t[y * sw + x];
      continue;
    }
    b.sort((p, q) => p - q);
    out[c] = b[Math.min(b.length - 1, Math.max(0, Math.ceil(frac * b.length) - 1))];
  }
  return out;
}

/** Całość synchronicznie (narzędzia/testy). */
export function computeCoverage(set: StrokeSet, sched: Schedule, work: RGBImage, w: number, h: number, base: CoverageBase = {}, o: CoverageOptions = {}): Float32Array {
  return aggregateCoverage(sampleTimes(set, sched, work, base, o), w, h, o);
}

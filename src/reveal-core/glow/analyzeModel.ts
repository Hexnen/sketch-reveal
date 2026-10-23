/**
 * Detektor adaptacyjny — mały, jawny model (krok 4): pewność „emiter” (regresja logistyczna na cechach bloba)
 * i rodzaj (wielomianowa regresja logistyczna). Wagi w detectorWeights.ts — kalibrowane narzędziem
 * docs/samples/sketch-reveal/tools/glow-calibrate.py na glow-truth.json (dowód uogólnienia: leave-one-scene-out).
 */
import { FEATURE_COUNT } from "./analyzeTree";

/** Nazwy cech w kolejności wektora `Node.f` (analyzeTree.ts). */
export const FEATURES = [
  "logArea", "elong", "fill", "round", "p95", "zE", "cNear", "cFar", "halo1", "halo2", "ctx", "c90", "temp", "tint",
  "coher", "clip", "white", "tex", "edge", "y", "stab", "rep", "exposure", "exCFar", "exLogArea", "zY", "wNear", "wFar", "relEV", "dom", "treeC",
] as const;

/** Rodzaje modelu (kolejność wyjścia softmax). Mapowanie na rodzaje renderera: analyzeFixtures.ts. */
export const MODEL_KINDS = ["neon", "okno", "latarnia", "tarcza", "ekran", "led", "świetlik"] as const;
export const MK_NEON = 0, MK_WINDOW = 1, MK_LAMP = 2, MK_DISC = 3, MK_SCREEN = 4, MK_LED = 5, MK_SKY = 6;

/** Drzewo regresyjne (gradient boosting): węzeł i → cecha f[i] (−1 = liść), próg t[i], dzieci l[i]/r[i], wartość v[i]. */
export interface GbTree { f: number[]; t: number[]; l: number[]; r: number[]; v: number[] }

export interface DetectorWeights {
  /** Pewność: albo regresja logistyczna (wagi w przestrzeni SUROWYCH cech, standaryzacja wliczona), albo — gdy jest
   *  `trees` — mały gradient boosting (logit = base + lr · Σ drzew; płytkie drzewa na surowych cechach). */
  emit: { w: number[]; b: number; trees?: GbTree[]; base?: number; lr?: number };
  /** Rodzaj: wielomianowa regresja logistyczna (W, b) albo — gdy jest `trees` — gradient boosting
   *  (trees[k] = drzewa klasy k; logit_k = base[k] + lr · Σ). */
  kind: { W: number[][]; b: number[]; trees?: GbTree[][]; base?: number[]; lr?: number };
  /** Próg „emiter” (oprawa), próg dołączenia słabego członka, preferencja większego bloba w drzewie. */
  theta: number; thetaJoin: number; delta: number;
  /** Klasteryzacja opraw: odstęp ≤ gamma × promień równoważny większego bloba (LED: gammaLed). */
  gamma: number; gammaLed: number;
  meta: Record<string, unknown>;
}

const sigm = (x: number) => 1 / (1 + Math.exp(-x));

function gbSum(T: GbTree[], f: Float32Array): number {
  let s = 0;
  for (const t of T) {
    let i = 0;
    while (t.f[i] >= 0) i = f[t.f[i]] <= t.t[i] ? t.l[i] : t.r[i];
    s += t.v[i];
  }
  return s;
}

export function emitLogit(f: Float32Array, W: DetectorWeights): number {
  if (W.emit.trees) return (W.emit.base ?? 0) + (W.emit.lr ?? 1) * gbSum(W.emit.trees, f);
  let s = W.emit.b;
  for (let i = 0; i < FEATURE_COUNT; i++) s += W.emit.w[i] * f[i];
  return s;
}
export const emitProb = (f: Float32Array, W: DetectorWeights) => sigm(emitLogit(f, W));

export function kindProbs(f: Float32Array, W: DetectorWeights): Float32Array {
  const K = W.kind.b.length, out = new Float32Array(K);
  let mx = -Infinity;
  for (let k = 0; k < K; k++) {
    let s: number;
    if (W.kind.trees) s = (W.kind.base?.[k] ?? 0) + (W.kind.lr ?? 1) * gbSum(W.kind.trees[k], f);
    else {
      s = W.kind.b[k];
      const w = W.kind.W[k];
      for (let i = 0; i < FEATURE_COUNT; i++) s += w[i] * f[i];
    }
    out[k] = s; if (s > mx) mx = s;
  }
  let z = 0;
  for (let k = 0; k < K; k++) { out[k] = Math.exp(out[k] - mx); z += out[k]; }
  for (let k = 0; k < K; k++) out[k] /= z;
  return out;
}

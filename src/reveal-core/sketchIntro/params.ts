/** Parametry fazy „rysowanie szkicu” (osobne od parametrów efektów koloru). */
import { mergePaper, PAPER_DEFAULTS, type PaperParams } from "../paper";
import type { ParamSpec } from "../types";

export type SketchOrder = "big" | "lr" | "random";

/**
 * Papier (PaperParams: paper, paperColor, paperTexture, paperScale, paperExtend) — wspólny sterownik
 * reveal-core/paper.ts. Używany, gdy nakładka NIE ma klatki p=0 efektu (setTarget(null)); z celem papier
 * pochodzi z niej. Spięcie: te same wartości co w efekcie; w trybie overlap (szkic = nakładka multiply) paper:false.
 */
export interface SketchIntroParams extends PaperParams {
  /** Pióro (czubek ołówka) widoczne na końcu rysowanej kreski. */
  pen: boolean;
  /** Świeży grafit: kreska tuż po narysowaniu jest ciemniejsza i „schnie” do koloru szkicu. */
  fresh: boolean;
  /** Ile kresek powstaje naraz (liczba „rąk”). */
  parallel: number;
  /** Nierówność rytmu i prędkości (0 = maszynowo równo, 1 = bardzo nierówno). */
  irregularity: number;
  /** Kolejność: duże formy → detale, lewo → prawo, losowo (ręka zawsze lokalna). */
  order: SketchOrder;
  /** Miękkość czoła kreski i granicy narysowane/nienarysowane (mnożnik; 1 = jak dotąd, 2 = bardzo miękko). */
  softness: number;
  seed: number;
  /** Długość fazy w sekundach (ustawia UI z suwaka czasu) — kreski z piórem trwają realne ≥ ~5 klatek. */
  seconds: number;
}

export const SKETCH_INTRO_DEFAULTS: SketchIntroParams = {
  pen: false,
  fresh: true,
  parallel: 2,
  irregularity: 0.5,
  order: "big",
  softness: 1.6,
  seed: 7,
  seconds: 10,
  ...PAPER_DEFAULTS,
};

export const SKETCH_INTRO_PARAM_SPECS: ParamSpec[] = [
  { key: "parallel", label: "Ręce z piórem", min: 1, max: 4, step: 1, hint: "Ile widocznych rąk z ołówkiem; szybkie detale i kreskowanie w tle dobierane są automatycznie, by zmieścić się w czasie" },
  { key: "irregularity", label: "Nierówność", min: 0, max: 1, step: 0.05, hint: "Rozrzut tempa, pauzy, zmienna prędkość pociągnięć" },
  { key: "softness", label: "Miękkość krawędzi", min: 0.5, max: 2, step: 0.1, hint: "Jak łagodnie kreska „wsiąka” za czubkiem i jak rozmyta jest granica narysowane/nienarysowane" },
  { key: "seed", label: "Ziarno", min: 0, max: 999, step: 1 },
];

export const SKETCH_INTRO_ORDERS: { value: SketchOrder; label: string }[] = [
  { value: "big", label: "duże → małe" },
  { value: "lr", label: "lewo → prawo" },
  { value: "random", label: "losowo" },
];

export function mergeParams(base: SketchIntroParams, p: Partial<SketchIntroParams>): SketchIntroParams {
  const out = { ...base, ...mergePaper(base, p) };
  if (typeof p.pen === "boolean") out.pen = p.pen;
  if (typeof p.fresh === "boolean") out.fresh = p.fresh;
  if (typeof p.parallel === "number" && isFinite(p.parallel)) out.parallel = Math.max(1, Math.min(4, Math.round(p.parallel)));
  if (typeof p.irregularity === "number" && isFinite(p.irregularity)) out.irregularity = Math.max(0, Math.min(1, p.irregularity));
  if (p.order === "big" || p.order === "lr" || p.order === "random") out.order = p.order;
  if (typeof p.softness === "number" && isFinite(p.softness)) out.softness = Math.max(0.5, Math.min(2, p.softness));
  if (typeof p.seed === "number" && isFinite(p.seed)) out.seed = Math.round(p.seed);
  if (typeof p.seconds === "number" && isFinite(p.seconds)) out.seconds = Math.max(0.3, Math.min(120, p.seconds));
  return out;
}

/** Deterministyczny PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kooperacyjne oddawanie wątku: `await slice()` w pętlach — przerywa co ~10 ms. */
export function makeSlicer(budgetMs = 10) {
  let t0 = performance.now();
  return async (): Promise<void> => {
    if (performance.now() - t0 < budgetMs) return;
    await new Promise<void>((r) => setTimeout(r, 0));
    t0 = performance.now();
  };
}

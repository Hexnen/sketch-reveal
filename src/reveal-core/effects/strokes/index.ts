import { PAPER_DEFAULTS } from "../../paper";
import type { RevealEffect } from "../../types";
import { guardEffect } from "../guard";
import { DEFAULT_STROKES, STROKES_PARAM_SPECS } from "./params";
import { createStrokesRenderer, type StrokesOptions } from "./renderer";

export type { StrokesOptions } from "./renderer";

/**
 * „Pociągnięcia”: prawdziwe pociągnięcia pędzla (Hertzmann coarse→fine). Lista pociągnięć liczona
 * na CPU przy setImages (asynchronicznie), rysowana instancjami z proceduralnym pędzlem do bufora
 * akumulacji. Skrubowalny (cofanie z checkpointów).
 */
export const effect: RevealEffect = {
  id: "strokes",
  label: "Pociągnięcia pędzla",
  defaultParams: { ...DEFAULT_STROKES, ...PAPER_DEFAULTS }, // papier: wspólny sterownik reveal-core/paper.ts
  paramSpecs: STROKES_PARAM_SPECS,
  scrubbable: true,
  // opcjonalny 2. argument (preserveDrawingBuffer) — zgodny z kontraktem create(canvas)
  // guardEffect: zwolnienie kontekstu po dispose + odtworzenie po utracie kontekstu (E1/E2, effects/guard.ts)
  create: (canvas: HTMLCanvasElement, opts?: StrokesOptions) => guardEffect(canvas, (c) => createStrokesRenderer(c, opts)),
};

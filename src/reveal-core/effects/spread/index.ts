import { PAPER_DEFAULTS } from "../../paper";
import type { RevealEffect } from "../../types";
import { guardEffect } from "../guard";
import { DEFAULT_SPREAD, SPREAD_PARAM_SPECS } from "./params";
import { createSpreadRenderer, type SpreadOptions } from "./renderer";

export type { SpreadOptions } from "./renderer";

/** „Rozlewanie”: farba rozlewa się od zalążków, linie szkicu ją hamują (czas dotarcia T). */
export const effect: RevealEffect = {
  id: "spread",
  label: "Rozlewanie farby",
  // papier (kolor/faktura/przedłuż) — wspólny sterownik reveal-core/paper.ts; UI: PaperControls w panelu
  defaultParams: { ...DEFAULT_SPREAD, ...PAPER_DEFAULTS },
  paramSpecs: SPREAD_PARAM_SPECS,
  choiceSpecs: [{ key: "seedMode", label: "Zalążki", options: ["scatter", "origin"] }],
  scrubbable: true,
  // opcjonalny 2. argument (preserveDrawingBuffer) — zgodny z kontraktem create(canvas)
  // guardEffect: zwolnienie kontekstu po dispose + odtworzenie po utracie kontekstu (E1/E2, effects/guard.ts)
  create: (canvas: HTMLCanvasElement, opts?: SpreadOptions) => guardEffect(canvas, (c) => createSpreadRenderer(c, opts)),
};

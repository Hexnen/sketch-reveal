/**
 * Efekt `speedpaint` — wygląda jak film speed-paint (time-lapse malowania cyfrowego):
 * szkic → duże płaskie plamy (blokowanie) → światłocień → detale i światła, lokalnie (obszarami),
 * jako widoczne, kierunkowe pociągnięcia (orientacja z structure tensor obrazu docelowego).
 * Czysty WebGL2, bezstanowy: wszystko liczone z (uv, p) → skrubowalny w obie strony.
 * Opis, pomiary i pułapki: docs/reveal-effects/speedpaint.md
 */
import { PAPER_DEFAULTS } from "../../paper";
import type { RevealEffect } from "../../types";
import { guardEffect } from "../guard";
import { createSpeedpaint, type SpeedpaintOptions } from "./instance";
import { PARAM_SPECS, SPEEDPAINT_DEFAULTS } from "./params";

export { SPEEDPAINT_DEFAULTS } from "./params";
export type { SpeedpaintInstance, SpeedpaintOptions } from "./instance";

export const effect: RevealEffect = {
  id: "speedpaint",
  label: "Speed-paint (plamy → formy → detal)",
  defaultParams: { ...SPEEDPAINT_DEFAULTS, ...PAPER_DEFAULTS }, // papier: wspólny sterownik reveal-core/paper.ts
  paramSpecs: PARAM_SPECS,
  scrubbable: true,
  // opcjonalny 2. argument (preserveDrawingBuffer, maxTextureSide) — zgodny z kontraktem create(canvas)
  // guardEffect: zwolnienie kontekstu po dispose + odtworzenie po utracie kontekstu (E1/E2, effects/guard.ts)
  create: (canvas: HTMLCanvasElement, opts?: SpeedpaintOptions) => guardEffect(canvas, (c) => createSpeedpaint(c, opts)),
};

export default effect;

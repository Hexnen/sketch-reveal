// Wejście bundla: tylko to, czego potrzebuje moduł Foundry (bez glow/analiz AI).
export { EFFECTS, getEffect } from "./reveal-core/effects";
export { createSketchIntro, SKETCH_INTRO_DEFAULTS, SKETCH_INTRO_ORDERS, SKETCH_INTRO_PARAM_SPECS } from "./reveal-core/sketchIntro";
export { PAPER_DEFAULTS, PAPER_COLORS, PAPER_PARAM_SPECS } from "./reveal-core/paper";
// Rozbłysk (glow): pseudo-HDR świateł po kolorze + żywe światło — używa scripts/fx/glow.mjs
export {
  createGlow, GLOW_DEFAULTS, GLOW_DETECT_DEFAULTS, GLOW_DETECT_SPECS, GLOW_DETECT_TOGGLES, GLOW_PARAM_SPECS, GLOW_QUALITIES,
} from "./reveal-core/glow";
export { GLOW_DETECTORS, GLOW_DETECTOR_HINT } from "./reveal-core/glow/analyzeOpts";
export { applyHints, sanitizeHints, LIGHT_HINT_KINDS } from "./reveal-core/glow";

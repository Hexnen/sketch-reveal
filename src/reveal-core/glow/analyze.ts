/**
 * Analiza świateł — DYSPOZYTOR (`opts.detector`, glow.md „Wybór detektora”): „legacy” (DOMYŚLNY) = klasyczny,
 * ręcznie strojony detektor (analyzeLegacy.ts); „adaptive” = detektor adaptacyjny opisany niżej (eksperymentalny).
 *
 * DETEKTOR ADAPTACYJNY (2026-10-22): raz na obraz, na pomniejszonej kopii (≤ 768 px), kawałkami ≤ 8 ms (bez blokowania UI).
 *
 * 1. Płaszczyzny i samokalibracja sceny (analyzePlanes.ts): ekspozycja (ciągła), rozkład mapy emisji
 *    (mediana/MAD), faktura (mediana |∇V|).
 * 2. Drzewo komponentów mapy emisji na poziomach `med + z·MAD` (analyzeTree.ts) — wielo-skalowe bloby.
 * 3. Cechy bloba: kształt, kontrast w 4 skalach, profil poświaty, kontekst, barwa, przepalenie, tekstura,
 *    położenie, powtarzalność, ekspozycja (analyzeTree.ts).
 * 4. Model (analyzeModel.ts + detectorWeights.ts): pewność „emiter” i rodzaj — regresja logistyczna
 *    skalibrowana na glow-truth.json, uogólnienie sprawdzone leave-one-scene-out (glow.md, „Detektor adaptacyjny”).
 * 5. Wybór skali w drzewie i bezpieczniki powierzchni (analyzeSelect.ts).
 * 6. Oprawy (klasteryzacja zależna od skali), odbicia, oświetlone, tekstura (analyzeFixtures.ts).
 */
import type { RevealImageSource } from "../types";
import { makeSlicer } from "./params";
import { buildPlanes } from "./analyzePlanes";
import { buildTree } from "./analyzeTree";
import { scoreNodes, selectNodes } from "./analyzeSelect";
import { buildFixtures } from "./analyzeFixtures";
import { detectLegacyLights } from "./analyzeLegacy";
import { resolveDetect, type GlowDetectOptions } from "./analyzeOpts";
import type { DetectorWeights } from "./analyzeModel";
import { DETECTOR_WEIGHTS } from "./detectorWeights";
import type { GlowAnalysis } from "./analyzeTypes";

export { KIND_LAMP, KIND_LED, KIND_LIT, KIND_NAMES, KIND_NEON, KIND_SCREEN, KIND_SKY, KIND_WINDOW } from "./analyzeTypes";
export type { Comp, Fixture, GlowAnalysis, GlowDebugComp } from "./analyzeTypes";
export { GLOW_DETECT_DEFAULTS, GLOW_DETECTORS, detectKey, resolveDetect, type GlowDetectOptions, type GlowDetector, type SceneKey } from "./analyzeOpts";

const MAX_ANALYSIS_SIDE = 768;

/** Opcje dla harnessu/kalibracji (nie dla UI, tylko detektor adaptacyjny): inne wagi (leave-one-scene-out), zrzut drzewa. */
export interface AnalyzeExtra { weights?: DetectorWeights; dump?: boolean }

export async function analyzeLights(src: RevealImageSource, w: number, h: number, opts: Partial<GlowDetectOptions> = {},
  extra: AnalyzeExtra = {}): Promise<GlowAnalysis> {
  const t0 = performance.now();
  const sc = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(w, h));
  const aw = Math.max(1, Math.round(w * sc)), ah = Math.max(1, Math.round(h * sc));
  const c = document.createElement("canvas");
  c.width = aw; c.height = ah;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("Brak kontekstu 2D");
  g.drawImage(src, 0, 0, aw, ah);
  return detectLights(g.getImageData(0, 0, aw, ah).data, aw, ah, opts, extra, t0);
}

/** Rdzeń bez DOM: piksele RGBA w rozdzielczości analizy → analiza (wybranym detektorem). */
export async function detectLights(px: Uint8ClampedArray, aw: number, ah: number, opts: Partial<GlowDetectOptions> = {},
  extra: AnalyzeExtra = {}, t0 = performance.now()): Promise<GlowAnalysis> {
  const o = resolveDetect(opts);
  if (o.detector === "legacy") return detectLegacyLights(px, aw, ah, o, t0);
  const W = extra.weights ?? DETECTOR_WEIGHTS;
  const slice = makeSlicer(8);
  const { P, st } = await buildPlanes(px, aw, ah, slice);
  const tree = await buildTree(P, st, slice);
  scoreNodes(tree, W, o);
  await slice();
  const sel = selectNodes(tree, W, o, aw * ah);
  const scene = { meanY: st.meanY, brightShare: st.brightShare, day: st.day, exposure: st.exposure };
  const an = await buildFixtures(sel, tree, P, W, o, scene, t0, slice);
  if (extra.dump) an.dump = { nodes: tree.nodes, labs: tree.labs, thr: tree.thr };
  return an;
}

/** Typy i stałe wyniku detekcji świateł (re-eksportowane z analyze.ts). */
import type { SceneKey } from "./analyzeOpts";

export const KIND_NEON = 0, KIND_WINDOW = 1, KIND_LAMP = 2, KIND_LIT = 3;
/** Wnętrza (2026-10-22): ekran/panel świecący (duża jasna powierzchnia z treścią), lampka LED (mały nasycony punkt),
 *  świetlik/okno dzienne (neutralne, chłodne, delikatny bloom). Emitery jak 0–2 (LIT = 3 zostaje „oświetlonym”). */
export const KIND_SCREEN = 4, KIND_LED = 5, KIND_SKY = 6;
export const KIND_NAMES = ["neon", "okno", "latarnia", "oświetlone", "ekran", "led", "świetlik"];

export interface Comp {
  fixture: number;
  conf: number;
  /** Środek „rdzenia” (piksele V ≥ 0,97, albo bbox) w uv, promień w uv (względem wysokości). */
  cx: number; cy: number; r: number;
  /** Barwa liniowa rdzenia (znormalizowana do max = 1). */
  color: [number, number, number];
  bright: number;
  area: number;
  /** Indeks surowego komponentu (wewnętrzny). */
  raw: number;
}

export interface Fixture {
  kind: number;
  members: number[];
  conf: number;
  bright: number;
  cx: number; cy: number; r: number;
  color: [number, number, number];
  /** Dla „oświetlonych”: oprawa-emiter, za którą idą (-1 = brak). */
  parent: number;
  /** Mnożnik siły dla oświetlonych (0..1). */
  gain: number;
  /** Tarcza (słońce/księżyc): rodzaj = KIND_WINDOW (łagodne narastanie, bez stuknięć), rozpoznana osobno. */
  disc?: boolean;
  /** Ekran: obrys panelu w uv [x0, y0, x1, y1] (przemiatanie zapłonu, odbicie pod ekranem). */
  box?: [number, number, number, number];
  /** Pochodzenie: „auto” = detektor adaptacyjny, „hint” = warstwa semantyczna (hints.ts). Brak = „auto”. */
  source?: "auto" | "hint";
}

export interface GlowDebugComp {
  x: number; y: number; area: number; p95: number; c90: number; hue: number; sat: number; fall: number; conf: number;
  coreSat: number; note: string;
}

export interface GlowAnalysis {
  aw: number; ah: number;
  /** RGBA8: R = id komponentu (1..254, 0 = brak), G = lokalna średnia luminancji ×255. */
  tex: Uint8Array;
  /** comps[0] = pusty (id 0). */
  comps: Comp[];
  fixtures: Fixture[];
  ms: number;
  /** Diagnostyka: cechy największych i najpewniejszych komponentów (harness/raport). */
  debug: GlowDebugComp[];
  /** Klucz sceny (jasność całego kadru → „dzień” wyłącza detekcję poza małymi rdzeniami i tarczami). */
  scene?: SceneKey;
  /** Tylko z `analyzeLights(..., { dump: true })` (kalibracja/harness): drzewo komponentów z cechami. */
  dump?: { nodes: unknown[]; labs: Int32Array[]; thr: number[] };
}

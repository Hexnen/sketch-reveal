/**
 * Parametry efektu „strokes” (pociągnięcia pędzla, Hertzmann coarse→fine, lokalny postęp warstw).
 * Rozmiary pędzla w px przy dłuższym boku obrazu = 1024 (skalowane z rozdzielczością).
 */
import type { EffectParams, ParamSpec } from "../../types";

export interface StrokesParams {
  duration: number;
  /** Promień największego pędzla (warstwa 1 — podmalówka). */
  brushSizeMax: number;
  /** Promień najmniejszego pędzla (ostatnia warstwa — detal). */
  brushSizeMin: number;
  /** Liczba warstw (pędzli) między max a min, geometrycznie. */
  layers: number;
  /** Maks. długość pociągnięcia w promieniach pędzla (podmalówka ≤ 5.5). */
  strokeLength: number;
  /** 0 = proste pociągnięcia, 1 = w pełni idą za formą (filtr kierunku Hertzmanna). */
  curvature: number;
  /** Rozrzut szerokości/jasności pociągnięć. */
  jitter: number;
  /** Siła tekstury włosia (smugi, suchy koniec, postrzępiony brzeg). */
  bristle: number;
  /** Ile poprawek kładą drobne warstwy (niżej = większy próg błędu, mniej pociągnięć). */
  coverage: number;
  /** Ziarno losowości. */
  seed: number;
  /** Lokalny czas glazury (dojście do ostrego obrazu) w regionie, jednostki osi. */
  finish: number;
  /** S: rozciągnięcie kolejności regionów na osi (≥ 2× odstęp warstw → warstwy się przenikają). */
  spread: number;
  /** W/D: jak długo trwa lokalna seria warstwy względem odstępu między warstwami. */
  layerOverlap: number;
  /** Waga głębi (od punktu startu i „zamglenia”) w kolejności vs szum i regiony podmalówki. */
  orderDepth: number;
  /** Punkt, od którego zaczyna się malowanie (klik w obraz). */
  originX: number;
  originY: number;
}

export const DEFAULT_STROKES: StrokesParams = {
  duration: 9,
  brushSizeMax: 36,
  brushSizeMin: 2.5,
  layers: 5,
  strokeLength: 9,
  curvature: 0.55,
  jitter: 0.35,
  bristle: 0.6,
  coverage: 0.6,
  seed: 11,
  finish: 0.08,
  spread: 0.45,
  layerOverlap: 1.1,
  orderDepth: 0.5,
  originX: 0.5,
  originY: 0.4,
};

/** Klucze, których zmiana wymaga przeliczenia listy pociągnięć (CPU, ~1 s). */
export const GEN_KEYS = [
  "brushSizeMax", "brushSizeMin", "layers", "strokeLength", "curvature", "jitter", "coverage", "seed",
] as const satisfies readonly (keyof StrokesParams)[];

/** Klucze harmonogramu (bez generowania: czasy + sort + upload, kilkadziesiąt ms). */
export const SCHEDULE_KEYS = [
  "finish", "spread", "layerOverlap", "orderDepth", "originX", "originY",
] as const satisfies readonly (keyof StrokesParams)[];

export const STROKES_PARAM_SPECS: ParamSpec[] = [
  { key: "duration", label: "Czas (s)", min: 2, max: 30, step: 0.5 },
  { key: "brushSizeMax", label: "Pędzel max (px)", min: 8, max: 96, step: 1, hint: "promień pędzla podmalówki (przy 1024 px)" },
  { key: "brushSizeMin", label: "Pędzel min (px)", min: 1, max: 12, step: 0.5, hint: "promień pędzla detalu (przy 1024 px)" },
  { key: "layers", label: "Warstwy", min: 1, max: 8, step: 1, hint: "liczba pędzli od dużego do małego" },
  { key: "strokeLength", label: "Długość pociągnięć", min: 1, max: 24, step: 1, hint: "maks. długość w promieniach pędzla" },
  { key: "curvature", label: "Krzywizna", min: 0, max: 1, step: 0.05, hint: "0 proste, 1 idą za formą" },
  { key: "jitter", label: "Rozrzut", min: 0, max: 1, step: 0.05, hint: "rozrzut szerokości i jasności" },
  { key: "bristle", label: "Włosie", min: 0, max: 1, step: 0.05, hint: "smugi, suchy koniec, postrzępiony brzeg" },
  { key: "coverage", label: "Pokrycie detalu", min: 0, max: 1, step: 0.05, hint: "więcej = drobne warstwy poprawiają więcej miejsc" },
  { key: "spread", label: "Rozłożenie regionów", min: 0.25, max: 0.7, step: 0.01, hint: "większe = regiony startują bardziej po kolei, warstwy bardziej się przenikają" },
  { key: "layerOverlap", label: "Nakładanie warstw", min: 0.5, max: 2, step: 0.05, hint: "długość lokalnej serii warstwy / odstęp warstw" },
  { key: "orderDepth", label: "Kolejność: głębia", min: 0, max: 1, step: 0.05, hint: "1 = od punktu startu i tła ku pierwszemu planowi; 0 = plamy podmalówki" },
  { key: "originX", label: "Start X", min: 0, max: 1, step: 0.01 },
  { key: "originY", label: "Start Y", min: 0, max: 1, step: 0.01 },
  { key: "seed", label: "Ziarno", min: 0, max: 99, step: 1 },
  { key: "finish", label: "Glazura (lokalnie)", min: 0.02, max: 0.3, step: 0.01, hint: "czas dojścia regionu do ostrego obrazu" },
];

export function mergeStrokes(base: StrokesParams, p: Partial<EffectParams>): StrokesParams {
  const out = { ...base };
  for (const k of Object.keys(DEFAULT_STROKES) as (keyof StrokesParams)[]) {
    const v = p[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  out.layers = Math.max(1, Math.min(8, Math.round(out.layers)));
  out.brushSizeMin = Math.max(0.75, Math.min(out.brushSizeMin, out.brushSizeMax));
  out.spread = Math.max(0, Math.min(0.8, out.spread));
  out.layerOverlap = Math.max(0.2, Math.min(3, out.layerOverlap));
  out.finish = Math.max(0.01, Math.min(0.4, out.finish));
  return out;
}

export function genKey(p: StrokesParams): string {
  return GEN_KEYS.map((k) => p[k]).join("|");
}

export function scheduleKey(p: StrokesParams): string {
  return SCHEDULE_KEYS.map((k) => p[k]).join("|");
}

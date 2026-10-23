/**
 * Progi KLASYCZNEGO detektora świateł (analyzeLegacy*.ts, `detector: "legacy"` — domyślny).
 * Snapshot ręcznie strojonych progów sprzed detektora adaptacyjnego (2026-10-22). Nie są wystawione w UI ani w
 * GlowDetectOptions (suwaki czułości/limity/rygor neonu/przełączniki rodzajów są wspólne dla obu detektorów):
 * stałe tutaj, więc klucz cache analizy (detectKey) pozostaje pełny.
 * Powierzchnie są UŁAMKAMI KADRU (niezależne od rozdzielczości analizy).
 */
import { smoothstep as ss } from "./params";
import type { GlowDetectOptions, SceneKey } from "./analyzeOpts";

export interface LegacyThresholds {
  /** Próg maski bazowej (wynik światła minus 0,7 × lokalna średnia). */
  t0: number;
  /** Komponent szerszy niż tyle szerokości kadru → redukcja do rdzenia V ≥ `coreV`. */
  maxCompBBox: number;
  coreV: number;
  /** Neon: p90 chromy i p95 jasności rdzenia, spadek poświaty. */
  neonC90: [number, number];
  neonP95: [number, number];
  neonFall: [number, number];
  /** Okno/latarnia (ciepłe 15–75°): chroma i spadek. */
  warmC90: [number, number];
  warmFall: [number, number];
  /** Klucz sceny: średnia luminancja i udział pikseli Y > 0,6, przy których scena jest „dzienna”. */
  dayMeanY: [number, number];
  dayBrightShare: [number, number];
  /** Tarcza (słońce/księżyc): min. promień (ułamek przekątnej), maks. powierzchnia (kadru), okrągłość. */
  discMinR: number;
  discMaxFrac: number;
  discRound: number;
  /** „Szyld”: mała (≤ signMaxFrac kadru), słabsza litera obok pewnego neonu (≤ signGap przekątnej). */
  signMaxFrac: number;
  signGap: number;
}

export type LegacyDetectOptions = GlowDetectOptions & LegacyThresholds;

export const LEGACY_THRESHOLDS: LegacyThresholds = {
  t0: 0.36,
  maxCompBBox: 0.25,
  coreV: 0.95,
  neonC90: [0.36, 0.5],
  neonP95: [0.85, 0.95],
  neonFall: [1.1, 1.35],
  warmC90: [0.28, 0.5],
  warmFall: [1.1, 1.5],
  dayMeanY: [0.3, 0.45],
  dayBrightShare: [0.15, 0.35],
  discMinR: 0.015,
  discMaxFrac: 0.03,
  discRound: 0.72,
  signMaxFrac: 0.0006,
  signGap: 0.06,
};

/** Progi faktycznie użyte przez detekcję: rygor neonu przeliczony na progi neonu (czułość działa w scoreRaw). */
export function legacyEffective(base: GlowDetectOptions): LegacyDetectOptions {
  const o: LegacyDetectOptions = { ...base, ...LEGACY_THRESHOLDS };
  const nd = (o.neonStrict - 0.5) * 2;
  const sh = (r: [number, number], d: number, max = 9): [number, number] => [Math.min(max, r[0] + d), Math.min(max, r[1] + d)];
  return {
    ...o,
    neonC90: sh(o.neonC90, 0.08 * nd),
    neonP95: sh(o.neonP95, 0.03 * nd, 0.99),
    neonFall: sh(o.neonFall, 0.12 * nd),
  };
}

/** Klucz sceny: 0 = noc (pełna detekcja) … 1 = dzień (tylko małe rdzenie V ≥ 0,97 z wyraźnym spadkiem + tarcze). */
export function legacySceneKey(Y: Float32Array, o: LegacyDetectOptions): SceneKey {
  let s = 0, b = 0;
  for (let i = 0; i < Y.length; i++) { s += Y[i]; if (Y[i] > 0.6) b++; }
  const meanY = s / Y.length, brightShare = b / Y.length;
  const day = Math.max(ss(o.dayMeanY[0], o.dayMeanY[1], meanY), ss(o.dayBrightShare[0], o.dayBrightShare[1], brightShare));
  return { meanY, brightShare, day };
}

/** Skóra: barwa 340–35°, średnie nasycenie (najbardziej nasyconej ćwiartki), brak przepalonego rdzenia o wysokiej
 *  chromie. Malowane neony czerwone/różowe mają nasycenie > 0,7 albo barwę 280–335°. */
export const skinLike = (hue: number, sat: number) => (hue >= 340 || hue <= 35) && sat >= 0.15 && sat <= 0.66;
/** Wyjątek od skóry: jasny (p95 ≥ 0,93), nasycony (c90 ≥ 0,4) rdzeń z namalowanym spadkiem poświaty (≥ 1,28). */
export const glowingCore = (p95: number, c90: number, fall: number) => p95 >= 0.93 && c90 >= 0.4 && fall >= 1.28;

export { ss };

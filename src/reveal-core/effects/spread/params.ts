/**
 * Parametry efektu „spread” (farba rozlewa się od zalążków, hamowana liniami szkicu).
 * Płaskie wartości (kontrakt `EffectParams`): origin → originX/originY, ręczne zalążki → string.
 */
import type { EffectParams, ParamSpec } from "../../types";

export type SeedMode = "origin" | "scatter";

export interface SpreadParams {
  /** Czas odtwarzania (s) — konwencja UI: klucz `duration`. */
  duration: number;
  /** Główny zalążek w UV (0,0 = lewy górny róg). */
  originX: number;
  originY: number;
  /** Szerokość frontu (ułamek znormalizowanego czasu dotarcia). */
  softness: number;
  /** Skala szumu w koszcie przejścia i postrzępienia brzegu (większa = drobniej). */
  brushScale: number;
  /** Opóźnienie detalu względem płaskiej podmalówki (ułamek czasu). */
  underpaintLag: number;
  /** Szerokość pasma, w którym linie szkicu zostają na farbie za frontem (0..1). */
  lineFade: number;
  /** Mokry brzeg: ciemniejszy/nasycony pas + jasny meniskus (0..1). */
  wetEdge: number;
  /** Ziarno szumu i losowych zalążków. */
  seed: number;
  /** Udział dodatkowych zalążków stawianych w światłach (tryb scatter), 0..1. */
  lightsFirst: number;
  /** Jak mocno linie szkicu (i krawędzie obrazu) hamują farbę (0..1). */
  lineBarrier: number;
  /** Liczba dodatkowych zalążków (tryb scatter). */
  seedCount: number;
  /** "origin" = tylko origin + ręczne; "scatter" = + seedCount losowych/w światłach. */
  seedMode: SeedMode;
  /** Postrzępienie brzegu i przelewanie koloru przez front (0..1). */
  bleed: number;
  /** Ręczne zalążki (klik GM) jako "x,y;x,y" w UV. */
  seedPoints: string;
}

export const DEFAULT_SPREAD: SpreadParams = {
  duration: 6,
  originX: 0.5,
  originY: 0.55,
  softness: 0.08,
  brushScale: 5,
  underpaintLag: 0.12,
  lineFade: 0.3,
  wetEdge: 0.6,
  seed: 7,
  lightsFirst: 0.3,
  lineBarrier: 0.6,
  seedCount: 4,
  seedMode: "scatter",
  bleed: 0.5,
  seedPoints: "",
};

export const SPREAD_PARAM_SPECS: ParamSpec[] = [
  { key: "duration", label: "Czas (s)", min: 1, max: 15, step: 0.5 },
  { key: "softness", label: "Szerokość frontu", min: 0.02, max: 0.3, step: 0.01 },
  { key: "lineBarrier", label: "Bariera linii", min: 0, max: 1, step: 0.05, hint: "Jak mocno linie szkicu zatrzymują farbę" },
  { key: "bleed", label: "Przelewanie", min: 0, max: 1, step: 0.05, hint: "Postrzępienie brzegu i przelewanie koloru" },
  { key: "underpaintLag", label: "Opóźnienie detalu", min: 0, max: 0.4, step: 0.01 },
  { key: "lineFade", label: "Pasmo linii za frontem", min: 0, max: 1, step: 0.05 },
  { key: "wetEdge", label: "Mokry brzeg", min: 0, max: 1, step: 0.05 },
  { key: "brushScale", label: "Skala szumu", min: 1, max: 12, step: 0.25 },
  { key: "seedCount", label: "Dodatkowe zalążki", min: 0, max: 16, step: 1 },
  { key: "lightsFirst", label: "Zalążki w światłach", min: 0, max: 1, step: 0.05 },
  { key: "seed", label: "Ziarno", min: 0, max: 99, step: 1 },
  { key: "originX", label: "Start X", min: 0, max: 1, step: 0.01 },
  { key: "originY", label: "Start Y", min: 0, max: 1, step: 0.01 },
];

/** Parametry, od których zależy pole czasu T(uv) — ich zmiana = przeliczenie na CPU. */
export const TIME_FIELD_KEYS: (keyof SpreadParams)[] = [
  "originX", "originY", "seed", "lightsFirst", "lineBarrier", "seedCount", "seedMode", "brushScale", "seedPoints",
];

/** Bezpieczne scalenie płaskiego patcha (nieznane klucze i złe typy są ignorowane). */
export function mergeSpread(base: SpreadParams, patch: Partial<EffectParams>): SpreadParams {
  const out: SpreadParams = { ...base };
  const rec = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base) || v === undefined) continue;
    if (typeof v !== typeof (base as unknown as Record<string, unknown>)[k]) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue; // E7: NaN/±Infinity ignorowane
    rec[k] = v;
  }
  if (out.seedMode !== "origin" && out.seedMode !== "scatter") out.seedMode = base.seedMode;
  return out;
}

export function parseSeedPoints(s: string): { x: number; y: number }[] {
  return s.split(";").map((t) => t.split(",").map(Number)).filter((a) => a.length === 2 && a.every(Number.isFinite))
    .map(([x, y]) => ({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }));
}

/** Postęp czasowy t (0..1) → postęp efektu: łagodny ease-in-out (0→0, 1→1, monotoniczny). */
export function easeProgress(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 0.5 * x + 0.5 * (0.5 - 0.5 * Math.cos(Math.PI * x));
}

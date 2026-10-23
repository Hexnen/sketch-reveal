/** Parametry fazy „rozbłysk” (pseudo-HDR: światła na gotowym obrazie zapalają się i świecą). */
import type { ParamSpec } from "../types";
import type { GlowDetectOptions } from "./analyzeOpts";

export type GlowQuality = "low" | "med" | "high";

export interface GlowParams {
  /** Siła świecenia (rdzeń HDR + bloom). */
  intensity: number;
  /** Zasięg bloomu (0 = ciasna poświata, 1 = szeroka mgła). */
  radius: number;
  /** Próg „jasne = światło” (miękki, na mierze jasność+nasycenie względem lokalnego tła). */
  threshold: number;
  /** Szerokość kolana progu. */
  knee: number;
  /** Ile nasycenie podbija wynik światła (neony są nasycone, ale niezbyt jasne w luminancji). */
  saturationBias: number;
  /** Rozrzut zapłonu źródeł (0 = wszystkie naraz, 1 = po kolei przez całą fazę). */
  stagger: number;
  /** Migotanie neonów (0 = gładkie narastanie, 1 = kilka stuknięć jaśniej/ciemniej). */
  flicker: number;
  /** Ocieplenie barwy ciepłych źródeł (okna, latarnie). */
  warmth: number;
  /** Szerokie, miękkie halo latarni (0 = brak). */
  haloLamp: number;
  /** Anamorficzne poziome smugi (0 = wyłączone). */
  streaks: number;
  /** Głębia cieni / lokalny kontrast (wrażenie HDR; tylko przyciemnia, nigdy nie rozjaśnia). */
  contrast: number;
  /** Długość fazy w sekundach (czas trwania stuknięć neonów jest w sekundach, nie w ułamku osi). */
  duration: number;
  seed: number;
  quality: GlowQuality;
  /** „Żywe światło”: po zapłonie subtelna, ciągła modulacja źródeł (render(p, idle) przy p ≥ 1). */
  life: boolean;
  /** Siła ożywienia (0..2; 1 = kilka % jasności). */
  lifeAmount: number;
  /** Opcjonalne progi wykrywania świateł (suwaki czułości). Zmiana → ponowna analiza (z opóźnieniem, keszowana per
   *  obraz + klucz progów). Brak/puste = domyślne (GLOW_DETECT_DEFAULTS). */
  detect?: Partial<GlowDetectOptions>;
}

export const GLOW_DEFAULTS: GlowParams = {
  intensity: 1,
  radius: 0.5,
  threshold: 0.44,
  knee: 0.1,
  saturationBias: 0.35,
  stagger: 0.8,
  flicker: 0.7,
  warmth: 0.25,
  haloLamp: 0.6,
  streaks: 0,
  contrast: 0.4,
  duration: 4,
  seed: 11,
  quality: "high",
  life: true,
  lifeAmount: 1,
};

export const GLOW_PARAM_SPECS: ParamSpec[] = [
  { key: "intensity", label: "Siła świecenia", min: 0, max: 2.5, step: 0.05, hint: "Jasność rdzeni świateł (HDR) i poświaty" },
  { key: "radius", label: "Zasięg poświaty", min: 0, max: 1, step: 0.05, hint: "0 = ciasna poświata przy źródle, 1 = szeroka mgła" },
  { key: "threshold", label: "Próg świateł", min: 0.36, max: 0.8, step: 0.01, hint: "Wyżej = świecą tylko najjaśniejsze rdzenie" },
  { key: "knee", label: "Miękkość progu", min: 0.02, max: 0.25, step: 0.01, hint: "Szerokość przejścia światło/nie-światło" },
  { key: "saturationBias", label: "Waga nasycenia", min: 0, max: 1, step: 0.05, hint: "Ile nasycenie (neony) liczy się jak jasność" },
  { key: "stagger", label: "Rozrzut zapłonu", min: 0, max: 1, step: 0.05, hint: "0 = wszystkie światła naraz, 1 = po kolei przez całą fazę" },
  { key: "flicker", label: "Migotanie neonów", min: 0, max: 1, step: 0.05, hint: "Stuknięcia jaśniej/ciemniej zanim neon się ustabilizuje" },
  { key: "warmth", label: "Ciepło", min: 0, max: 1, step: 0.05, hint: "Ocieplenie poświaty okien i latarni" },
  { key: "haloLamp", label: "Halo latarni", min: 0, max: 1.5, step: 0.05, hint: "Szeroka, miękka aureola wokół latarni" },
  { key: "streaks", label: "Smugi anamorficzne", min: 0, max: 1, step: 0.05, hint: "Poziome smugi ze świateł (0 = wyłączone)" },
  { key: "contrast", label: "Głębia cieni", min: 0, max: 1, step: 0.05, hint: "Lokalny kontrast cieni dla wrażenia HDR (tylko przyciemnia)" },
  { key: "duration", label: "Czas fazy [s]", min: 1, max: 12, step: 0.5, hint: "Długość rozbłysku; stuknięcia neonów trwają realne ułamki sekundy" },
  { key: "seed", label: "Ziarno", min: 0, max: 999, step: 1 },
  { key: "lifeAmount", label: "Siła ożywienia", min: 0, max: 2, step: 0.05, hint: "Amplituda „życia” świateł po zapłonie (szum neonów, oddech latarni, falowanie okien)" },
];

export const GLOW_QUALITIES: { value: GlowQuality; label: string }[] = [
  { value: "high", label: "wysoka (pełny wygląd)" },
  { value: "med", label: "średnia" },
  { value: "low", label: "niska" },
];

const NUM_KEYS = GLOW_PARAM_SPECS.map((s) => s.key) as (keyof GlowParams)[];

export function mergeGlowParams(base: GlowParams, p: Partial<GlowParams>): GlowParams {
  const out = { ...base } as Record<string, unknown>;
  for (const s of GLOW_PARAM_SPECS) {
    const v = (p as Record<string, unknown>)[s.key];
    if (typeof v === "number" && isFinite(v)) out[s.key] = Math.max(s.min, Math.min(s.max, v));
  }
  if (p.quality === "low" || p.quality === "med" || p.quality === "high") out.quality = p.quality;
  if (typeof p.life === "boolean") out.life = p.life;
  if ("detect" in p) out.detect = p.detect && typeof p.detect === "object" ? { ...p.detect } : undefined;
  out.seed = Math.round(out.seed as number);
  return out as unknown as GlowParams;
}

/** Klucz zmian parametrów (render tylko przy zmianie). */
export function paramsKey(p: GlowParams): string {
  return NUM_KEYS.map((k) => p[k]).join(",") + "," + p.quality + "," + (p.life ? 1 : 0);
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

/** Kooperacyjne oddawanie wątku: `await slice()` w pętlach — przerywa co ~budgetMs. */
export function makeSlicer(budgetMs = 8) {
  let t0 = performance.now();
  return async (): Promise<void> => {
    if (performance.now() - t0 < budgetMs) return;
    await new Promise<void>((r) => setTimeout(r, 0));
    t0 = performance.now();
  };
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

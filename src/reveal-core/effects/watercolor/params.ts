/** Parametry efektu „watercolor”, opisy suwaków, jakość i harmonogram czasu lokalnego. */
import type { EffectParams, ParamSpec, RevealImageSource } from "../../types";

export const WATERCOLOR_DEFAULTS = {
  duration: 8,
  layers: 4,
  wetness: 0.6,
  bleed: 0.6,
  edgeDark: 0.7,
  granulation: 0.6,
  blooms: 0.5,
  drying: 0.6,
  blobSize: 1,
  lines: 0.5,
  independence: 0.5,
  originX: 0.5,
  originY: 0.35,
  seed: 7,
} satisfies EffectParams;

export type WcParams = typeof WATERCOLOR_DEFAULTS;

export const PARAM_SPECS: ParamSpec[] = [
  { key: "duration", label: "Czas (s)", min: 2, max: 20, step: 0.5 },
  { key: "layers", label: "Laserunki", min: 2, max: 6, step: 1, hint: "Liczba warstw: jasny wash → ciemniejsze → detal (ostatnia = obraz)" },
  { key: "wetness", label: "Wilgotność", min: 0, max: 1, step: 0.05, hint: "Jak długo plamy są mokre: wolniejsze schnięcie, miękkie fronty, szersze pierścienie" },
  { key: "bleed", label: "Rozlewanie", min: 0, max: 1, step: 0.05, hint: "Strzępienie mokrego frontu i przepływ pigmentu na mokro (wet-on-wet)" },
  { key: "edgeDark", label: "Ciemne brzegi", min: 0, max: 1.5, step: 0.05, hint: "Pigment zbiera się przy brzegu wyschniętej plamy i na nakładkach" },
  { key: "granulation", label: "Granulacja", min: 0, max: 1.5, step: 0.05, hint: "Pigment osiada w dolinach papieru (ziarno = wspólny papier: skala/faktura w sekcji Papier)" },
  { key: "blooms", label: "Kwiaty (backruns)", min: 0, max: 1, step: 0.05, hint: "Krople wody w półsuchej plamie — jaśniejsze wnętrze, kalafiorowy brzeg" },
  { key: "drying", label: "Schnięcie", min: 0, max: 1, step: 0.05, hint: "Mokra farba ciemniejsza i nasycona; schnąc jaśnieje i traci saturację" },
  { key: "blobSize", label: "Rozmiar plam", min: 0.5, max: 2, step: 0.05 },
  { key: "lines", label: "Tusz pod farbą", min: 0, max: 1, step: 0.05, hint: "Widoczność linii szkicu na farbie (wygasają łagodnie do końca)" },
  { key: "independence", label: "Niezależność etapów", min: 0, max: 1, step: 0.05, hint: "0 = etapy blisko siebie w kolejności; 1 = laserunki mocno rozjechane w przestrzeni, więcej wet-on-wet" },
  { key: "originX", label: "Początek — X", min: 0, max: 1, step: 0.01, hint: "Skąd zaczynają się plamy" },
  { key: "originY", label: "Początek — Y", min: 0, max: 1, step: 0.01 },
  { key: "seed", label: "Ziarno", min: 0, max: 999, step: 1 },
];

/**
 * Jakość: high = wygląd referencyjny (bajt w bajt); medium = stratne przyspieszenia z PSNR ≥ 60 dB (koniec lokalny →
 * painted, tekstury ≤ rozmiar wyjścia). „low” (½ rozdzielczości) odrzucone: 28 dB < kryterium 40 dB (watercolor.md).
 */
export const QUALITIES = ["high", "medium"] as const;
export type Quality = (typeof QUALITIES)[number];

export function imageSize(img: RevealImageSource): { w: number; h: number } {
  if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) {
    return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  }
  return { w: img.width, h: img.height };
}

export function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * Harmonogram lokalny: start_k = HOLD + Tb·SP_k + k·D + j_k (przycięte). HOLD + SP + (L−1)·D + Wdetal(0.6·Wloc) ≈ 0.965,
 * więc ostatni piksel kończy (z lokalnym wygaszeniem 0.03) przed p = 1. SP ≥ 3D dla każdego L.
 */
export function schedule(layers: number, independence: number) {
  const L = Math.round(clamp(layers, 2, 6));
  const ind = clamp(independence, 0, 1);
  const HOLD = 0.005, Wloc = 0.13;
  const D = (0.3 / (L - 1)) * (1.2 - 0.4 * ind);
  const J = 0.14 * ind;
  // J nie wchodzi do budżetu: shader przycina start_k, więc jitter nie wypycha końca poza 0.93.
  const SP = 0.965 - HOLD - (L - 1) * D - 0.6 * Wloc - 0.25 * J;
  return { L, HOLD, Wloc, D, J, SP, SP0: SP };
}


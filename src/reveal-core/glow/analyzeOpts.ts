/**
 * Opcje wykrywania świateł (suwaki „Wykrywanie świateł”) dla `analyzeLights`.
 *
 * Dwa detektory (`detector`, glow.md „Wybór detektora”): „legacy” (domyślny) — klasyczne, ręcznie strojone progi
 * (stałe w analyzeLegacyOpts.ts, poza tym obiektem); „adaptive” — model skalibrowany na glow-truth.json
 * (detectorWeights.ts). Tu są tylko KONTROLE UŻYTKOWNIKA wspólne dla obu:
 *  - `sensitivity` mnoży pewność (conf · s^1,5),
 *  - `neonStrict` rygor neonu (klasyczny: przesuwa progi neonu; adaptacyjny: logit blobów „neon” ±2),
 *  - `maxCompFrac` / `maxEmitFrac` / `maxLitFrac` — bezpieczniki powierzchni (ułamki kadru),
 *  - przełączniki rodzajów.
 * Klucze dawnych progów (t0, coreV, neonC90…) w zapisanych ustawieniach są ignorowane (resolveDetect pomija nieznane).
 */
import type { ParamSpec } from "../types";
import { smoothstep as ss } from "./params";

/** Detektor świateł: „legacy” = klasyczny, ręcznie strojony (analyzeLegacy*.ts, DOMYŚLNY — mniej fałszywych świateł);
 *  „adaptive” = adaptacyjny, model uczony na glow-truth.json (eksperymentalny). Patrz glow.md „Wybór detektora”. */
export type GlowDetector = "legacy" | "adaptive";
export const GLOW_DETECTORS: readonly { value: GlowDetector; label: string }[] = [
  { value: "legacy", label: "klasyczny (strojony)" },
  { value: "adaptive", label: "adaptacyjny (eksperymentalny)" },
];
export const GLOW_DETECTOR_HINT = "Klasyczny: ręcznie strojone progi — na naszych 7 scenach trafia 92% źródeł przy 3 fałszywych oprawach. "
  + "Adaptacyjny: model uczony na oznaczonych scenach — lepszy tylko na mieście nocą; na nowych scenach 71% źródeł, "
  + "35 fałszywych opraw (światła w oczach i twarzach), rodzaj trafiony w połowie przypadków";

export interface GlowDetectOptions {
  /** Który detektor (domyślnie „legacy”). Suwaki i przełączniki niżej działają dla obu. */
  detector: GlowDetector;
  /** Bezpiecznik: pojedynczy blob większy niż tyle kadru nie zostaje emiterem (wybierane są jego mniejsze części
   *  z drzewa komponentów — rdzenie, litery, kawałki treści ekranu). */
  maxCompFrac: number;
  /** Łączna powierzchnia emiterów (bez LED) ≤ tyle kadru — nadmiar odcinany od najmniej pewnych. */
  maxEmitFrac: number;
  /** Łączna powierzchnia „oświetlonych” ≤ tyle kadru; pojedyncza łata ≤ `maxCompFrac`. */
  maxLitFrac: number;
  /** Suwak „Czułość” (0,5–2; 1 = domyślne): mnożnik pewności (^1,5) — > 1 więcej (słabszych) źródeł. */
  sensitivity: number;
  /** Suwak „Rygor neonu” (0–1; 0,5 = domyślne): przesuwa logit pewności blobów rodzaju neon o (0,5 − x)·4. */
  neonStrict: number;
  /** Przełączniki rodzajów: tarcze słońca/księżyca, ekrany/panele, lampki LED, świetliki/okna dzienne. */
  discs: boolean;
  screens: boolean;
  leds: boolean;
  skylights: boolean;
}

export const GLOW_DETECT_DEFAULTS: GlowDetectOptions = {
  detector: "legacy",
  maxCompFrac: 0.015,
  maxEmitFrac: 0.04,
  maxLitFrac: 0.06,
  sensitivity: 1,
  neonStrict: 0.5,
  discs: true,
  screens: true,
  leds: true,
  skylights: true,
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Pełne opcje z częściowych (suwaki): wartości liczbowe przycięte do bezpiecznych zakresów, nieznane klucze pominięte. */
export function resolveDetect(p: Partial<GlowDetectOptions> = {}): GlowDetectOptions {
  const o = { ...GLOW_DETECT_DEFAULTS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    const d = (GLOW_DETECT_DEFAULTS as unknown as Record<string, unknown>)[k];
    if (d === undefined || v === undefined) continue;
    if (typeof d === "number" && typeof v === "number" && isFinite(v)) o[k] = v;
    else if (typeof d === "boolean" && typeof v === "boolean") o[k] = v;
    else if (k === "detector" && GLOW_DETECTORS.some((x) => x.value === v)) o[k] = v;
  }
  const r = o as unknown as GlowDetectOptions;
  r.sensitivity = clamp(r.sensitivity, 0.5, 2);
  r.neonStrict = clamp(r.neonStrict, 0, 1);
  r.maxCompFrac = clamp(r.maxCompFrac, 0.002, 0.1);
  r.maxEmitFrac = clamp(r.maxEmitFrac, 0.005, 0.25);
  r.maxLitFrac = clamp(r.maxLitFrac, 0, 0.25);
  return r;
}

/** Klucz cache analizy: tylko pola różne od domyślnych (domyślne → ""), kolejność stała. */
export function detectKey(p: Partial<GlowDetectOptions> = {}): string {
  const o = resolveDetect(p) as unknown as Record<string, unknown>, d = GLOW_DETECT_DEFAULTS as unknown as Record<string, unknown>;
  return Object.keys(d).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(d[k])).map((k) => `${k}=${JSON.stringify(o[k])}`).join(";");
}

/** Diagnostyka sceny (zgodność z dawnym typem): ekspozycja jest ciągła, `day` tylko do wyświetlania. */
export interface SceneKey {
  meanY: number;
  brightShare: number;
  /** 0..1 z ekspozycji (diagnostyka — detektor nie używa progu dzień/noc). */
  day: number;
  /** Ekspozycja sceny w EV względem szarości 0,18 (średnia geometryczna luminancji). */
  exposure?: number;
}

export { ss };

/** Suwaki wykrywania (GlowSection). `scale` = mnożnik wyświetlania (ułamek kadru → %). */
export const GLOW_DETECT_SPECS: (ParamSpec & { scale?: number; unit?: string })[] = [
  { key: "sensitivity", label: "Czułość", min: 0.5, max: 2, step: 0.05, hint: "Ogólna czułość wykrywania: wyżej = więcej (słabszych) źródeł, niżej = tylko pewne" },
  { key: "maxCompFrac", label: "Limit źródła", min: 0.002, max: 0.1, step: 0.001, scale: 100, unit: "% kadru",
    hint: "Największe pojedyncze źródło; większe plamy są redukowane do mniejszych części (rdzenie, litery) albo odrzucane" },
  { key: "maxEmitFrac", label: "Limit łączny", min: 0.005, max: 0.25, step: 0.005, scale: 100, unit: "% kadru",
    hint: "Łączna powierzchnia wszystkich źródeł; nadmiar odpada od najmniej pewnych" },
  { key: "neonStrict", label: "Rygor neonu", min: 0, max: 1, step: 0.05, hint: "Wyżej = mniej neonów: neon musi mieć jaśniejszy, bardziej nasycony rdzeń i wyraźną poświatę" },
];
export const GLOW_DETECT_TOGGLES: { key: "discs" | "screens" | "leds" | "skylights"; label: string; hint: string }[] = [
  { key: "discs", label: "Tarcze słońca/księżyca", hint: "Okrągłe, jasne tarcze na niebie świecą" },
  { key: "screens", label: "Ekrany", hint: "Duże świecące panele z treścią: włączanie ekranu, poświata, odbicie na podłodze" },
  { key: "leds", label: "Lampki LED", hint: "Małe nasycone punkty (szafy, pulpity): kaskada zapłonu, część mruga" },
  { key: "skylights", label: "Świetliki", hint: "Jasne, neutralne okna dzienne/świetliki we wnętrzu: delikatna poświata" },
];

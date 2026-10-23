/**
 * Kontrakt `LightHint` (podpowiedzi źródeł światła z modelu wizyjnego) + sanityzacja wejścia.
 *
 * Plik BEZ importów i bez DOM — używa go też backend (`src/lib/roleplay/revealLights.ts`), więc musi się
 * kompilować pod `types: ["node"]`. Łączenie z analizą lokalną: `hints.ts` (`applyHints`).
 * Opis warstwy: docs/reveal-effects/glow-ai.md.
 */

export const LIGHT_HINT_KINDS = [
  "neon", "window", "lamp", "sun", "moon", "screen", "led", "skylight", "hologram", "candle", "fire", "other",
] as const;
export type LightHintKind = (typeof LIGHT_HINT_KINDS)[number];

/** Jedno źródło światła widziane przez model. Współrzędne w uv obrazu (0..1, lewy górny róg = 0,0). */
export interface LightHint {
  kind: LightHintKind;
  /** Środek źródła (uv). */
  x: number; y: number;
  /** Promień (uv względem WYSOKOŚCI obrazu — jak `Fixture.r`). */
  r: number;
  /** Barwa emitowana, sRGB 0..1. */
  color: [number, number, number];
  /** Jak mocno świeci (0..1). */
  intensity: number;
  /** Skłonność do migotania (neon, płomień) 0..1 — opcjonalne. */
  flicker?: number;
  /** Pewność modelu 0..1. */
  confidence: number;
  /** Krótka etykieta („szyld BAR”, „latarnia uliczna”). */
  label?: string;
}

export const MAX_HINTS = 48;
const MIN_CONFIDENCE = 0.05;
const R_MIN = 0.003, R_MAX = 0.5, R_DEFAULT = 0.03;

/** Synonimy, które modele lubią zwracać zamiast słownika. */
const SYNONYMS: Record<string, LightHintKind> = {
  sign: "neon", "neon sign": "neon", signage: "neon", "street lamp": "lamp", streetlamp: "lamp", streetlight: "lamp",
  "street light": "lamp", lantern: "lamp", bulb: "lamp", "light bulb": "lamp", chandelier: "lamp", "wall lamp": "lamp",
  sconce: "lamp", torch: "fire", flame: "fire", campfire: "fire", fireplace: "fire", bonfire: "fire", monitor: "screen",
  tv: "screen", television: "screen", display: "screen", billboard: "screen", phone: "screen", indicator: "led",
  "status light": "led", skylights: "skylight", "ceiling window": "skylight", holo: "hologram", windows: "window",
};

const DEFAULT_COLOR: Record<LightHintKind, [number, number, number]> = {
  neon: [1, 0.3, 0.7], window: [1, 0.8, 0.5], lamp: [1, 0.75, 0.4], sun: [1, 0.95, 0.8], moon: [0.85, 0.9, 1],
  screen: [0.6, 0.8, 1], led: [0.3, 1, 0.5], skylight: [0.85, 0.92, 1], hologram: [0.4, 0.9, 1], candle: [1, 0.7, 0.35],
  fire: [1, 0.55, 0.2], other: [1, 0.9, 0.7],
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export function normalizeHintKind(v: unknown): LightHintKind | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/[_-]+/g, " ");
  if ((LIGHT_HINT_KINDS as readonly string[]).includes(s)) return s as LightHintKind;
  if (SYNONYMS[s]) return SYNONYMS[s];
  const word = s.split(/\s+/).reverse().find((w) => (LIGHT_HINT_KINDS as readonly string[]).includes(w) || SYNONYMS[w]);
  return word ? ((LIGHT_HINT_KINDS as readonly string[]).includes(word) ? (word as LightHintKind) : SYNONYMS[word]) : null;
}

function parseColor(v: unknown): [number, number, number] | null {
  if (typeof v === "string") {
    const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  if (!Array.isArray(v) || v.length < 3) return null;
  const c = v.slice(0, 3).map(num);
  if (c.some((x) => x === null || x < 0)) return null;
  const k = (c as number[]).some((x) => x > 1) ? 255 : 1; // 0..255 → 0..1
  return (c as number[]).map((x) => clamp01(x / k)) as [number, number, number];
}

export interface SanitizeOptions {
  /** Szerokość/wysokość obrazu — potrzebne, gdy model zwrócił `box` (promień liczony względem wysokości). */
  aspect?: number;
  max?: number;
}

/**
 * Wejście: tablica albo `{ lights: [...] }` (dowolny klucz z tablicą). Element: pola LightHint, albo zamiast x/y/r
 * `box: [ymin, xmin, ymax, xmax]` w skali 0..1000 (format „groundingu” Gemini/Qwen). Śmieci (brak położenia, NaN,
 * nieznany rodzaj, pewność < 0,05) są odrzucane; zakresy przycinane; duplikaty (ten sam rodzaj, środek w promieniu)
 * scalane; wynik posortowany malejąco po pewności i ucięty do `max` (domyślnie 48).
 */
export function sanitizeHints(raw: unknown, opts: SanitizeOptions = {}): LightHint[] {
  const aspect = opts.aspect && Number.isFinite(opts.aspect) && opts.aspect > 0 ? opts.aspect : 1;
  let arr: unknown = raw;
  if (arr && typeof arr === "object" && !Array.isArray(arr)) arr = Object.values(arr as object).find(Array.isArray);
  if (!Array.isArray(arr)) return [];
  const out: LightHint[] = [];
  for (const it of arr.slice(0, 400)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const kind = normalizeHintKind(o.kind ?? o.type);
    if (!kind) continue;
    let x = num(o.x), y = num(o.y), r = num(o.r ?? o.radius);
    const box = Array.isArray(o.box) ? o.box.map(num) : Array.isArray(o.box_2d) ? (o.box_2d as unknown[]).map(num) : null;
    if ((x === null || y === null) && box && box.length === 4 && box.every((b) => b !== null)) {
      const [y0, x0, y1, x1] = (box as number[]).map((b) => clamp01(b / 1000));
      if (y1 <= y0 || x1 <= x0) continue;
      x = (x0 + x1) / 2; y = (y0 + y1) / 2;
      r = Math.max((x1 - x0) * aspect, y1 - y0) / 2;
    }
    if (x === null || y === null || x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) continue;
    const confidence = clamp01(num(o.confidence) ?? 0.5);
    if (confidence < MIN_CONFIDENCE) continue;
    const h: LightHint = {
      kind, x: clamp01(x), y: clamp01(y),
      r: Math.min(R_MAX, Math.max(R_MIN, r ?? R_DEFAULT)),
      color: parseColor(o.color) ?? DEFAULT_COLOR[kind],
      intensity: clamp01(num(o.intensity) ?? 0.7),
      confidence,
    };
    const fl = num(o.flicker);
    if (fl !== null) h.flicker = clamp01(fl);
    if (typeof o.label === "string") {
      const label = o.label.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60);
      if (label) h.label = label;
    }
    out.push(h);
  }
  out.sort((a, b) => b.confidence - a.confidence);
  const kept: LightHint[] = [];
  for (const h of out) {
    const dup = kept.some((k) => k.kind === h.kind && Math.hypot((k.x - h.x) * aspect, k.y - h.y) < Math.min(k.r, h.r));
    if (!dup) kept.push(h);
    if (kept.length >= (opts.max ?? MAX_HINTS)) break;
  }
  return kept;
}

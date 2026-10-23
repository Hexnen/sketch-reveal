/**
 * „Życie po zapłonie”: subtelna, ciągła modulacja poziomu źródeł w stanie końcowym (p ≥ 1).
 * Czysta funkcja czasu idle u (sekundy od końca zapłonu) i ziarna — bez stanu, skrubowalna.
 *  - obwiednia smoothstep(0, RAMP_S, u): przy u = 0 mnożnik = 1 dokładnie (zero skoku, zero pochodnej),
 *  - neon: mikroszum transformatora (kilka %) + rzadki krótki „przygasający” trzask (oprawa albo jedna litera),
 *  - latarnia (sodowa): powolne oddychanie + minimalne drżenie,
 *  - okno: ledwie zauważalne falowanie; część okien (z ziarna) to „płomień” — nieregularnie, nieco szybciej,
 *  - oświetlone/odbicia: liczone przez wołającego jako poziom rodzica w chwili u − LIT_DELAY_S.
 * Poziom źródła ~1 ± 5–10 % · amount (0..2) — w pikselach to ~1–4 % jasności (światło jest DODAWANE do obrazu);
 * trzask sięga głębiej (22–45 %), ale trwa 50–150 ms i zdarza się rzadko (~co 17 s na oprawę).
 */
import { KIND_LAMP, KIND_LED, KIND_NEON, KIND_SCREEN, KIND_SKY } from "./analyze";

export const RAMP_S = 1.5;
/** Opóźnienie odbić i plam światła względem źródła [s]. */
export const LIT_DELAY_S = 0.12;
const CRACKLE_SLOT_S = 7;

/** Hash całkowity (a, b) → [0, 1). */
function hash(a: number, b: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Gładki szum wartości (C1) w [-1, 1]. */
function vnoise(x: number, s: number): number {
  const i = Math.floor(x), f = x - i;
  const a = hash(s, i), b = hash(s, i + 1);
  const t = f * f * f * (f * (f * 6 - 15) + 10);
  return (a + (b - a) * t) * 2 - 1;
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Ziarno oprawy (stałe dla seed + indeksu). */
export function lifeSeed(seed: number, fi: number): number {
  return (Math.imul(seed | 0, 7919) + Math.imul(fi, 104729) + 77) | 0;
}

/** Trzask neonu w chwili u: głębokość przygaśnięcia 0..~0,45 dla członka mi (0 poza trzaskiem). */
function crackle(u: number, s: number, mi: number, nMembers: number): number {
  const phase = hash(s, 901) * CRACKLE_SLOT_S;
  const x = u + phase, k = Math.floor(x / CRACKLE_SLOT_S);
  if (hash(s, 1000 + k) > 0.4) return 0; // ~co 17 s na oprawę
  const who = hash(s, 2000 + k);
  if (nMembers > 1 && who >= 0.5 && mi !== Math.floor(((who - 0.5) / 0.5) * nMembers)) return 0;
  const t0 = k * CRACKLE_SLOT_S + 1 + hash(s, 3000 + k) * (CRACKLE_SLOT_S - 2);
  const dur = 0.05 + 0.1 * hash(s, 4000 + k);
  const depth = 0.22 + 0.23 * hash(s, 5000 + k);
  const e = Math.min(0.018, dur / 3);
  const bump = (a: number, w: number) => sstep(a, a + e, x) * (1 - sstep(a + w - e, a + w, x));
  let d = depth * bump(t0, dur);
  if (hash(s, 6000 + k) < 0.45) d = Math.max(d, 0.6 * depth * bump(t0 + dur + 0.07, dur * 0.6)); // podwójne stuknięcie
  return d;
}

/**
 * Mnożnik poziomu członka `mi` oprawy rodzaju `kind` w chwili idle `u` (≤ 0 → dokładnie 1).
 * `amount` 0..2 skaluje amplitudę (0 → dokładnie 1). `big` 0..1 (udział kadru oprawy) wycisza trzaski neonu.
 */
export function lifeLevel(kind: number, u: number, s: number, mi: number, nMembers: number, amount: number, big = 0): number {
  if (!(u > 0) || !(amount > 0)) return 1;
  const env = sstep(0, RAMP_S, u) * amount;
  let n: number;
  if (kind === KIND_NEON) {
    // wspólny transformator oprawy + drobna różnica liter
    n = 0.03 * vnoise(u * 11, s + 1) + 0.02 * vnoise(u * 23, s + 2) + 0.025 * vnoise(u * 0.7, s + 3)
      + 0.01 * vnoise(u * 17, s + 11 + mi * 131);
    // duże oprawy (big → 1) bez trzasków: przygaśnięcie dużej powierzchni to błysk całego kadru (B3)
    const c = big >= 1 ? 0 : crackle(u, s, mi, nMembers) * (1 - big);
    return Math.max(0.05, (1 + env * n) * (1 - Math.min(0.9, c * env)));
  }
  if (kind === KIND_LAMP) {
    const per = 4 + 3 * hash(s, 7);
    n = 0.07 * Math.sin((u / per + hash(s, 8)) * Math.PI * 2) + 0.025 * vnoise(u * 0.4, s + 4) + 0.015 * vnoise(u * 9, s + 5);
    return 1 + env * n;
  }
  if (kind === KIND_SCREEN) {
    // ekran: drobne „odświeżanie” całego panelu + wolna zmiana treści per kawałek
    n = 0.02 * vnoise(u * 6, s + 21) + 0.015 * vnoise(u * 0.4, s + 22) + 0.012 * vnoise(u * 0.9, s + 23 + mi * 131);
    return 1 + env * n;
  }
  if (kind === KIND_LED) {
    // ~30% lampek (z ziarna i indeksu) to diody statusu: miękkie mruganie 0,5–1,7 Hz; reszta stała (1% szumu)
    const ls = s + 41 + mi * 977;
    if (hash(ls, 1) < 0.3) {
      const hz = 0.5 + 1.2 * hash(ls, 2), ph = (u * hz + hash(ls, 3)) % 1;
      const off = sstep(0.45, 0.5, ph) * (1 - sstep(0.95, 1, ph));
      return Math.max(0.1, 1 - Math.min(0.85, 0.7 * off * env));
    }
    return 1 + env * 0.01 * vnoise(u * 3, ls);
  }
  if (kind === KIND_SKY) {
    // świetlik: bardzo wolne przesuwanie chmur
    n = 0.03 * vnoise(u * 0.15, s + 31) + 0.01 * vnoise(u * 0.6, s + 32);
    return 1 + env * n;
  }
  // okno / świeca
  if (hash(s, 9) < 0.35) {
    n = 0.06 * vnoise(u * 2.2, s + 6) + 0.03 * vnoise(u * 5.3, s + 7) + 0.015 * vnoise(u * 11, s + 8);
  } else {
    n = 0.05 * vnoise(u * 0.35, s + 6) + 0.02 * vnoise(u * 1.3, s + 7);
  }
  return 1 + env * n;
}

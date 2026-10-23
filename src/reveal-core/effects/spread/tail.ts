/**
 * Ogon efektu „spread” (2026-10-22): mapowanie postępu → zakres wieku `x`, z rozciągnięciem końcówki.
 *
 * Bez ogona: x(p) = x0 + ease(p)·(x1 − x0). Najpóźniejsze komórki pola T (zakątki, kieszenie za liniami)
 * mają małe |∇T| (CDF-wyrównanie zbija je w wąski pas pod 1), więc front przebiega je ~3× szybciej niż
 * środek obrazu, a farba kończy się ok. p 0.75 — dalej tylko wyostrzanie detalu.
 *
 * Z ogonem: od p = TAIL_P0 komórki z T > Tk dostają T' = Tk + d·(1 + β·d/(1 − Tk)) (d = T − Tk; nachylenie
 * 1 → 1+2β, czyli front płynnie zwalnia), a x(p) dostaje dodatek Δ·u² (u = (p − p0)/(1 − p0), Δ = T'max − 1),
 * więc x1 rośnie dokładnie o tyle, ile rozciągnięto T. Tk jest wybrane tak, że przy p ≤ p0 żadna komórka
 * z T > Tk nie jest jeszcze ruszona → klatki p ≤ p0 są bit w bit takie same jak bez ogona.
 */
import { easeProgress } from "./params";

/** Od tego postępu zaczyna się ogon (klatki wcześniej bez zmian). */
export const TAIL_P0 = 0.65;
/** Siła rozciągnięcia końcówki: nachylenie T' na samym końcu = 1 + 2β. */
export const TAIL_BETA = 4;

export interface TailMap {
  /** Zakres wieku dla danego postępu czasowego p (0..1). */
  x(p: number): number;
  /** Uniform `u_tail` = (Tk, β). */
  tk: number;
  beta: number;
}

/**
 * @param x0,x1  dotychczasowy zakres wieku (renderer.ts), dla pola T w [0,1]
 * @param lead   największe możliwe wyprzedzenie frontu względem T (postrzępienie: 0.6·w·bleed)
 */
export function makeTail(x0: number, x1: number, lead: number): TailMap {
  const base = (p: number) => x0 + easeProgress(p) * (x1 - x0);
  const xk = base(TAIL_P0);
  const tk = xk + lead + 1e-3; // przy p ≤ p0 komórki z T > tk mają wiek a < 0 (papier, nietknięte)
  if (tk >= 0.995) return { x: base, tk: 2, beta: 0 }; // ogromne bleed/softness — nie ma czego rozciągać
  const delta = (1 - tk) * TAIL_BETA; // T'max − 1 (T max = 1)
  return {
    tk,
    beta: TAIL_BETA,
    x(p: number) {
      const b = base(p);
      if (p <= TAIL_P0) return b;
      const u = Math.min(1, (p - TAIL_P0) / (1 - TAIL_P0));
      return b + delta * u * u;
    },
  };
}

/** Zakres wieku i ogon dla parametrów (te same wyrażenia co dawniej w renderer.ts — bit w bit). */
export function spreadTail(params: { softness: number; underpaintLag: number; lineFade: number; bleed: number; lineBarrier: number }): TailMap & { lead: number } {
  const w = params.softness;
  const lag = params.underpaintLag;
  const wl = w * (0.3 + 1.5 * params.lineFade);
  // Zakres wieku: p=0 → nic (z zapasem na postrzępienie), p→1 → wszystko łącznie z detalem i liniami.
  const x0 = -0.6 * w * params.bleed - 0.01;
  const x1 = 1 + 0.6 * w * params.bleed + 0.6 * w * params.lineBarrier
    + Math.max(1.3 * lag + 0.6 * w, wl, 1.6 * w) + 0.01;
  const lead = 0.6 * w * params.bleed;
  return { ...makeTail(x0, x1, lead), lead };
}

/** Rozciągnięcie późnych komórek pola T (jak `u_tail` w shaderze). */
export function stretchT(t: number, tk: number, beta: number): number {
  if (t <= tk) return t;
  const d = t - tk;
  return tk + d * (1 + (beta * d) / Math.max(1 - tk, 1e-3));
}

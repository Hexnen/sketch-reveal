/**
 * Analityczna mapa pokrycia `speedpaint` (kontrakt `EffectInstance.coverage`, combined-perf.md P3 wariant B):
 * dla każdej komórki siatki — najmniejszy postęp UŻYTKOWNIKA p, przy którym komórka jest już (prawie) w kolorze
 * końcowym. Czysto z danych CPU efektu, bez GL i bez odczytu płótna:
 *
 *   pole kolejności T (order.ts, po wyrównaniu histogramem; kopia CPU wgranej tekstury)
 *   → start lokalny etapu detalu  st = T·spread_{N−1} + (N−1)·delay   (strokeGlsl.ts: stageStart, u_hold = 0)
 *   → czas domknięcia             t  = st + α·W,  W = 1.4·dur  (laserunek ≥ ~0.9 przy α≈0.9; skalibrowane α = 0.8;
 *                                                               światła trzymane do st + (0.5·detailLag + ~0.32)·W)
 *   → odwrócenie deformacji czasu (warpTime, rytm) i kalibracji tempa (pace.ts: userToInternal)  → p użytkownika.
 *
 * Komórka = kwantyl `quantile` (domyślnie 0.75) czasów próbek pola w komórce. Stałe skalibrowane na klatkach
 * (≥ 90% pikseli komórki ≤ 6 LSB od obrazu końcowego): średni |Δp| 0.050 / 0.050, r 0.91 / 0.94 (para 1 / 2).
 * Wartości ≤ 1 (p = 1 to zawsze czysty obraz). Szczegóły: speedpaint.md, sekcja „v5 — fala 2”.
 */
import { timing } from "./draw";
import type { OrderCpu } from "./order";
import { userToInternal, warpTime } from "./pace";
import type { SpParams } from "./params";

export interface CoverageTune {
  /** Ułamek lokalnego czasu detalu W, po którym piksel uznajemy za gotowy (dolna granica; światła mogą wydłużyć). */
  alpha?: number;
  /** Kwantyl czasów próbek w komórce (0.9 = 90% komórki gotowe). */
  quantile?: number;
  /**
   * Etap, którego domknięcie liczymy (domyślnie N−1 = detal = kolor końcowy). Niższy etap = „pokryte jakąkolwiek
   * farbą” (np. 0 = blokowanie); wtedy W = dur, spread_k = spread·(0.55 + 0.45·k/(N−1)), bez wydłużenia świateł.
   */
  stage?: number;
}

export const COVERAGE_ALPHA = 0.8;
export const COVERAGE_QUANTILE = 0.75;
const STEPS = 2048;

/** F(p_user) = warpTime(userToInternal(p_user)) na STEPS+1 punktach (niemalejąca). */
function timeTable(P: SpParams, paceC: Float32Array | null): Float64Array {
  const F = new Float64Array(STEPS + 1);
  let prev = -Infinity;
  for (let i = 0; i <= STEPS; i++) {
    const pInt = userToInternal(i / STEPS, P.hold, P.evenPace, P.evenPace > 0 ? paceC : null);
    const v = warpTime(Math.min(1, Math.max(0, pInt)), P.rhythm, P.seed);
    prev = Math.max(prev, v); // zabezpieczenie monotoniczności (rhythm spoza zakresu suwaka)
    F[i] = prev;
  }
  return F;
}

/** Najmniejsze p_user z F(p) ≥ t (interpolacja liniowa); t ponad koniec → 1. */
function invert(F: Float64Array, t: number): number {
  if (t <= F[0]) return 0;
  if (t > F[STEPS]) return 1;
  let lo = 0;
  let hi = STEPS;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (F[mid] >= t) hi = mid;
    else lo = mid;
  }
  const span = F[hi] - F[lo];
  const f = span > 1e-12 ? (t - F[lo]) / span : 1;
  return Math.min(1, (lo + f) / STEPS);
}

/**
 * Siatka w×h (wiersz 0 = góra), wartość = p użytkownika pokrycia komórki. `order` = kopia CPU pola T,
 * `n` = liczba etapów, `paceC` = krzywa kalibracji tempa (null przy evenPace 0).
 */
export function coverageGrid(
  order: OrderCpu, P: SpParams, n: number, paceC: Float32Array | null, w: number, h: number, tune: CoverageTune = {},
): Float32Array {
  const gw = Math.max(1, Math.floor(w));
  const gh = Math.max(1, Math.floor(h));
  const tm = timing(P, n);
  const k = Math.min(n - 1, Math.max(0, Math.round(tune.stage ?? n - 1)));
  const detail = k === n - 1;
  const W = detail ? tm.dur * 1.4 : tm.dur;
  const spreadK = tm.spread * (0.55 + 0.45 * (k / Math.max(1, n - 1)));
  const a0 = tune.alpha ?? COVERAGE_ALPHA;
  const alpha = detail ? Math.max(a0, 0.5 * P.detailLag + 0.32) : a0;
  const q = Math.min(1, Math.max(0, tune.quantile ?? COVERAGE_QUANTILE));
  const base = k * tm.delay + alpha * W;
  const F = timeTable(P, paceC);
  // próbki pola T w komórkach (środek texela → komórka); 256 binów T na komórkę = kwantyl bez sortowania
  const { data, w: ow, h: oh } = order;
  const hist = new Uint32Array(gw * gh * 256);
  const cnt = new Uint32Array(gw * gh);
  for (let y = 0; y < oh; y++) {
    const cy = Math.min(gh - 1, Math.floor(((y + 0.5) / oh) * gh));
    for (let x = 0; x < ow; x++) {
      const ci = cy * gw + Math.min(gw - 1, Math.floor(((x + 0.5) / ow) * gw));
      hist[ci * 256 + data[(y * ow + x) * 4]]++;
      cnt[ci]++;
    }
  }
  const out = new Float32Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      const ci = cy * gw + cx;
      let T: number;
      if (cnt[ci] === 0) {
        // siatka gęstsza niż pole: najbliższy texel środka komórki
        const ox = Math.min(ow - 1, Math.floor(((cx + 0.5) / gw) * ow));
        const oy = Math.min(oh - 1, Math.floor(((cy + 0.5) / gh) * oh));
        T = data[(oy * ow + ox) * 4] / 255;
      } else {
        const need = Math.max(1, Math.ceil(q * cnt[ci]));
        let acc = 0;
        let b = 0;
        for (; b < 255; b++) {
          acc += hist[ci * 256 + b];
          if (acc >= need) break;
        }
        T = b / 255;
      }
      out[ci] = invert(F, T * spreadK + base);
    }
  }
  return out;
}

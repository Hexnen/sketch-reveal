/**
 * Pióra rąk WIDOCZNYCH (najwyżej `parallel`, domyślnie 2): ołówek prowadzi kreskę, a między kreskami
 * tej samej ręki PRZELATUJE nad papierem (łuk uniesienia, easing) — bez teleportów. Ręce „przepustowości”
 * (szybkie detale/kreskowanie w tle) piór nie mają.
 * Format: 8 floatów na pióro — [x, y, r, alfa, uniesienie, 0, 0, 0] w pikselach SZKICU.
 */
import { profileF, type Schedule } from "./schedule";
import type { Path } from "./trace";

export const PEN_STRIDE = 8;

function pointAt(P: Path, s: number): [number, number] {
  let lo = 0, hi = P.cum.length - 1;
  if (hi <= 0) return [P.xs[0], P.ys[0]];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P.cum[mid] < s) lo = mid; else hi = mid; }
  const seg = P.cum[hi] - P.cum[lo], f = seg > 0 ? Math.max(0, Math.min(1, (s - P.cum[lo]) / seg)) : 0;
  return [P.xs[lo] + (P.xs[hi] - P.xs[lo]) * f, P.ys[lo] + (P.ys[hi] - P.ys[lo]) * f];
}

const startPt = (P: Path, rev: number) => pointAt(P, rev ? P.L : 0);
const endPt = (P: Path, rev: number) => pointAt(P, rev ? 0 : P.L);
const ease = (u: number) => u * u * (3 - 2 * u);

/** k = piksele szkicu na piksel analizy, r = promień czubka (px szkicu). Zwraca liczbę piór. */
export function collectPens(paths: Path[], S: Schedule, t: number, k: number, r: number, out: Float32Array, max: number): number {
  let n = 0;
  const put = (x: number, y: number, a: number, lift: number) => {
    if (n >= max || a <= 0.001) return;
    const o = n * PEN_STRIDE;
    out[o] = (x + 0.5) * k; out[o + 1] = (y + 0.5) * k; out[o + 2] = r; out[o + 3] = Math.min(1, a); out[o + 4] = lift;
    out[o + 5] = 0; out[o + 6] = 0; out[o + 7] = 0;
    n++;
  };
  for (const list of S.visible) {
    if (!list.length) continue;
    // ostatnia kreska tej ręki, która już się zaczęła
    let lo = -1, hi = list.length;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S.start[list[mid]] <= t) lo = mid; else hi = mid; }
    if (lo < 0) {
      const i0 = list[0], lead = 0.035, dt = S.start[i0] - t;
      if (dt < lead) { const [x, y] = startPt(paths[i0], S.rev[i0]); put(x, y, 1 - dt / lead, dt / lead); }
      continue;
    }
    const i = list[lo], P = paths[i], s0 = S.start[i], d = S.dur[i];
    if (t <= s0 + d) {
      const u = profileF(S.prof[i], (t - s0) / d);
      const [x, y] = pointAt(P, (S.rev[i] ? 1 - u : u) * P.L);
      put(x, y, 1, 0);
      continue;
    }
    const [ax, ay] = endPt(P, S.rev[i]);
    if (lo + 1 < list.length) {
      const j = list[lo + 1], gap = Math.max(1e-6, S.start[j] - (s0 + d));
      const u = ease(Math.min(1, (t - s0 - d) / gap));
      const [bx, by] = startPt(paths[j], S.rev[j]);
      put(ax + (bx - ax) * u, ay + (by - ay) * u, 1, Math.sin(Math.PI * u) * Math.min(1, Math.hypot(bx - ax, by - ay) / 40));
    } else {
      const u = (t - s0 - d) / 0.04; // ręka skończyła — ołówek odjeżdża i znika
      put(ax, ay, 1 - u, u);
    }
  }
  return n;
}

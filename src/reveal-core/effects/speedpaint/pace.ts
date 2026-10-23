/**
 * Równe tempo `speedpaint`: mapowanie postępu użytkownika → czas wewnętrzny efektu tak, by zmiana
 * obrazu rozkładała się równomiernie na całej osi (bez plateau na końcu i bez „wszystko w 10%”).
 *
 * Kalibracja (raz na obraz + parametry): efekt renderowany w M+1 punktach czasu wewnętrznego na małym
 * buforze (~128 px), z klatek liczona „ilość zmiany” na krok = 0.3·średnia |Δ| do poprzedniej klatki
 * (wszystko, co widać) + 0.7·przyrost udziału pikseli już finalnych (domykanie detalu) + mała podłoga.
 * Oś użytkownika [hold, END_USER] → czas wewnętrzny [0, 1]; ostatnie 3% to już gotowy obraz.
 * Skumulowana, znormalizowana krzywa C(τ) jest odwracana: p_user → τ = C⁻¹(p). Deterministyczne
 * (te same piksele → ta sama tablica), więc skrubowanie zostaje bajt w bajt.
 */

export const PACE_STEPS = 40;
export const END_USER = 0.97;

/** frames[i] = RGBA8 klatki dla τ = i/M (i = 0..M). Zwraca C (Float32Array długości M+1, C[0]=0, C[M]=1). */
export function paceCurve(frames: Uint8Array[]): Float32Array {
  const M = frames.length - 1;
  const last = frames[M];
  const n = last.length / 4;
  const chg = new Float64Array(M + 1);
  const fin = new Float64Array(M + 1);
  for (let i = 0; i <= M; i++) {
    const f = frames[i];
    let finals = 0;
    let diff = 0;
    const prev = i > 0 ? frames[i - 1] : null;
    for (let j = 0; j < n; j++) {
      const o = j * 4;
      const dr = Math.abs(f[o] - last[o]), dg = Math.abs(f[o + 1] - last[o + 1]), db = Math.abs(f[o + 2] - last[o + 2]);
      if (dr <= 1 && dg <= 1 && db <= 1) finals++;
      if (prev) diff += Math.abs(f[o] - prev[o]) + Math.abs(f[o + 1] - prev[o + 1]) + Math.abs(f[o + 2] - prev[o + 2]);
    }
    fin[i] = finals / n;
    chg[i] = diff / (n * 3 * 255);
  }
  let sa = 0;
  let sb = 0;
  for (let i = 1; i <= M; i++) {
    sa += chg[i];
    sb += Math.max(0, fin[i] - fin[i - 1]);
  }
  const C = new Float32Array(M + 1);
  let acc = 0;
  for (let i = 1; i <= M; i++) {
    const a = sa > 0 ? chg[i] / sa : 1 / M;
    const b = sb > 0 ? Math.max(0, fin[i] - fin[i - 1]) / sb : 1 / M;
    acc += 0.3 * a + 0.7 * b + 0.1 / M;
    C[i] = acc;
  }
  for (let i = 1; i <= M; i++) C[i] /= acc;
  C[M] = 1;
  return C;
}

/** τ = C⁻¹(q) (liniowa interpolacja); q ∈ [0,1]. */
export function invertPace(C: Float32Array, q: number): number {
  const M = C.length - 1;
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  let lo = 0;
  let hi = M;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (C[mid] <= q) lo = mid;
    else hi = mid;
  }
  const span = C[hi] - C[lo];
  const t = span > 1e-9 ? (q - C[lo]) / span : 0;
  return (lo + t) / M;
}

/**
 * Postęp użytkownika → czas wewnętrzny. `hold` = ile osi stoi sam szkic; `even` ∈ [0,1] miesza
 * mapowanie liniowe z równym tempem.
 */
export function userToInternal(p: number, hold: number, even: number, C: Float32Array | null): number {
  if (p <= hold) return 0;
  const q = Math.min(1, (p - hold) / Math.max(1e-6, END_USER - hold));
  if (!C || even <= 0) return q;
  return q + (invertPace(C, q) - q) * Math.min(1, even);
}

/** Ta sama deformacja czasu co `warpTime` w strokeGlsl.ts (monotoniczna dla rhythm ≤ 1.25). */
export function warpTime(p: number, rhythm: number, seed: number): number {
  const r = 0.8 * rhythm;
  const s = seed * 0.371;
  const ph = (s - Math.floor(s)) * 6.2831;
  const f = 7;
  return p + (r * (Math.sin(2 * Math.PI * f * p + ph) - Math.sin(ph))) / (2 * Math.PI * f);
}

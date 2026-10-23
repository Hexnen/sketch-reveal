/**
 * Ścieżka koloru jednego piksela roboczego dla coverageSim.ts — pętla warstw jak `main()`/`layer()` w shaders.ts,
 * uśredniona po pikselu roboczym (P px obrazu): rampy pokrycia poszerzone o P/2, ranty (exp od brzegu) całkowane po
 * pikselu. Pominięte (zerowa średnia albo rzadkie): ziarno/relief papieru, granulacja, kwiaty, przepływ mokrego
 * pigmentu (flow), dither. Wynik: p gotowości piksela (ostatni krok poza tolerancją + 1, ≤ lokalny koniec).
 */
import { tToP } from "./coverage";

export interface SimLayer { S: number; R: number; Wk: number; dur: number; dryT: number; detail: boolean; kf: number }

export interface PixelCtx {
  L: number;
  lays: SimLayer[];
  sc: { HOLD: number; SP: number; D: number; J: number; Wloc: number };
  tol: number;
  steps: number;
  /** px obrazu na piksel roboczy. */
  P: number;
  wet: number;
  bleed: number;
  edge: number;
  drying: number;
  lines: number;
  resH: number;
  PAPER: [number, number, number];
  thr: ArrayLike<number>;
  /** Obraz liniowo (rgb) na lod 0..NLOD−1 (lod tekstury). */
  lin: Float64Array;
  NLOD: number;
  sk0: Float64Array;
  nC: Int32Array;
  cT0: Float64Array;
  cD: Float64Array;
  /** Czas dotarcia plamy kandydata: t0 + dur·(d/R)^1,5385. */
  cT: Float64Array;
  inV: Float64Array;
  edgeVs: Float64Array;
  ref: number[];
  sk: number[];
  ink: number;
  trace: ((s: number, v: number[]) => void) | null;
}

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const IC = [0.94, 0.97, 1];

/** Średnia exp(−max(x, 0)/ew) po x ∈ [m − P/2, m + P/2]. */
function boxExp(m: number, P: number, ew: number): number {
  const lo = m - P / 2, hi = m + P / 2;
  if (lo > 12 * ew) return 0;
  const neg = Math.min(P, Math.max(0, -lo));
  const a = Math.max(0, lo), b = Math.max(0, hi);
  return (neg + ew * (Math.exp(-a / ew) - Math.exp(-b / ew))) / P;
}

export function pixelReady(c: PixelCtx): number {
  const { L, lays, P, wet, bleed, edge, drying, PAPER, lin, NLOD, ref, sk, ink } = c;
  const winLast = lays[L - 1].Wk;
  const Tdone = c.sk0[L - 1] + winLast;
  const sLine = c.sk0[Math.min(1, L - 1)];
  const edgePx = c.resH * 0.0045;
  const softWet = 0.9 + c.resH * 0.028 * bleed;
  const L0 = [0, 0, 0], raw = [0, 0, 0], G = [0, 0, 0], acc = [0, 0, 0], ext = [0, 0, 0], before = [0, 0, 0], col = [0, 0, 0];
  // log-transmitancja na całkowitych lod; między nimi interpolacja w logu (GPU: liniowo, potem log — różnica pomijalna)
  const lg = new Float64Array(NLOD * 3);
  for (let q = 0; q < NLOD * 3; q++) lg[q] = Math.log(Math.min(1.25, Math.max(0.012, lin[q] / PAPER[q % 3])));
  const logAt = (lod: number, out: number[]) => {
    const l = Math.min(NLOD - 1, Math.max(0, lod)), l0 = Math.min(NLOD - 2, Math.floor(l)), f = l - l0;
    for (let ch = 0; ch < 3; ch++) out[ch] = lg[l0 * 3 + ch] * (1 - f) + lg[(l0 + 1) * 3 + ch] * f;
  };
  logAt(0, L0);
  // rezerwa czystego pigmentu (lod 2)
  const c2 = [lin[6], lin[7], lin[8]], mx = Math.max(c2[0], c2[1], c2[2]);
  const nm = ss(0.2, 0.38, (mx - Math.min(c2[0], c2[1], c2[2])) * (mx > 0.001 ? 1 : 0));
  const tEnd = Tdone + 0.03;
  // okno aktywności plam warstwy [min t0, max t0 + dur) i top-2 przed/po nim (ta sama kolejność co pełny skan)
  const win = new Float64Array(L * 4), top = new Float64Array(L * 8);
  for (let k = 0; k < L; k++) {
    let lo = Infinity, hi = -Infinity;
    for (let n = k * 25, ne = n + c.nC[k]; n < ne; n++) { lo = Math.min(lo, c.cT0[n]); hi = Math.max(hi, c.cT0[n] + lays[k].dur); }
    win[k * 4] = lo; win[k * 4 + 1] = hi;
    for (let q = 0; q < 2; q++) {
      let m1 = -1e9, m2 = -1e9, T1 = 0, T2 = 0;
      for (let n = k * 25, ne = n + c.nC[k]; n < ne; n++) {
        const m = q === 0 ? -1e4 - c.cD[n] : lays[k].R - c.cD[n];
        if (m > m1) { m2 = m1; T2 = T1; m1 = m; T1 = c.cT[n]; } else if (m > m2) { m2 = m; T2 = c.cT[n]; }
      }
      top.set([m1, T1, m2, T2], k * 8 + q * 4);
    }
  }
  let lastBad = 0;
  const lodK = lays.map((ly) => 5.2 * Math.pow(1 - ly.kf, 1.2));
  const steps = c.steps;
  // Kroki są niezależne (shader bezstanowy) → bez śledzenia skanujemy WSTECZ od lokalnego końca i kończymy na pierwszym
  // złym kroku (= ostatnim złym w czasie). Ze śledzeniem — wszystkie kroki do przodu.
  const fwd = !!c.trace;
  let sEnd = steps;
  while (sEnd > 0 && !fwd) { const p = sEnd / steps; if (0.9 * p + 0.1 * p * p * (3 - 2 * p) < tEnd) break; sEnd--; }
  for (let it = 1; it <= (fwd ? steps : sEnd); it++) {
    const s = fwd ? it : sEnd + 1 - it;
    const p = s / steps, t = 0.9 * p + 0.1 * p * p * (3 - 2 * p);
    acc[0] = acc[1] = acc[2] = 0; ext[0] = ext[1] = ext[2] = 0;
    let covPrev = 1, wetPrev = 0, covAny = 0, wetAny = 0, covLast = 0, stage = 0;
    for (let k = 0; k < L; k++) {
      if (covPrev <= 0) break;
      const ly = lays[k], { R, dur, dryT, Wk, detail, kf } = ly;
      // top-2 plam (m malejąco)
      let m1 = -1e9, m2 = -1e9, T1 = 0, T2 = 0;
      const tb = k * 4;
      if (t < win[tb] || t >= win[tb + 1]) {
        // przed startem wszystkich plam / po pełnym wzroście: top-2 stały (policzony raz)
        const q = t < win[tb] ? 0 : 1;
        m1 = top[k * 8 + q * 4]; T1 = top[k * 8 + q * 4 + 1]; m2 = top[k * 8 + q * 4 + 2]; T2 = top[k * 8 + q * 4 + 3];
      } else {
        for (let n = k * 25, ne = n + c.nC[k]; n < ne; n++) {
          const t0 = c.cT0[n], d = c.cD[n];
          const sv = (t - t0) / dur;
          const m = sv <= 0 ? -1e4 - d : sv >= 1 ? R - d : R * Math.exp(0.65 * Math.log(sv)) - d;
          if (m > m1) { m2 = m1; T2 = T1; m1 = m; T1 = c.cT[n]; } else if (m > m2) { m2 = m; T2 = c.cT[n]; }
        }
      }
      const age = t - T1;
      const wetL = age >= 0 ? 1 - ss(0, dryT, age) : 0;
      let soft = (0.8 + (softWet - 0.8) * wetL * wetL) * (1 + 1.5 * wetPrev);
      if (detail) soft = Math.max(soft, ly.S * 0.12);
      let cov = ss(-soft - P / 2, soft * 0.25 + P / 2, m1);
      const sk = c.sk0[k];
      cov = Math.max(cov, ss(sk + Wk - 0.03, sk + Wk, t));
      const ew = edgePx * (1 + 1.2 * wet);
      const settle = 0.35 + 0.65 * (1 - wetL);
      const noEdge = (1 - wetPrev) * (detail ? 0.3 : 1);
      let ring = cov > 0 && noEdge > 0 ? boxExp(m1, P, ew) * settle * cov * noEdge : 0;
      const hard = ss(0.25, 0.9, Math.abs(T1 - T2) / dryT);
      const cov2 = ss(-0.8 - P / 2, 0.2 + P / 2, m2);
      const overlap = cov2 * hard * noEdge;
      if (cov2 * hard * noEdge > 0) ring = Math.max(ring, boxExp(m2, P, ew) * cov2 * hard * settle * noEdge);

      const covRaw = Math.min(cov, covPrev);
      const wetK = covRaw >= 0.02 ? wetL : 0;
      if (covRaw > 0.5) stage++;
      const fin = detail ? 1 - ss(Tdone - 0.03, Tdone + 0.03, t) : 1;
      let lod = detail ? 2 * (1 - ss(T1, T1 + 0.5 * Wk, t)) : lodK[k];
      lod += (wetL + wetPrev) * bleed * (detail ? 0.5 : 1);
      lod = (lod + (Math.min(lod, 1) - lod) * nm) * fin;
      logAt(lod, raw);
      const m = (raw[0] + raw[1] + raw[2]) / 3;
      let f = 1, cb = 1;
      if (k === 0) { f = 0.85 + (0.55 - 0.85) * ss(c.thr[0] - 0.5, c.thr[0], -m); cb = 1.15; }
      else if (!detail) { f = 0.82 + 0.1 * ((k - 1) / Math.max(L - 3, 1)); cb = 1.08; }
      f = f + (1 - f) * nm;
      for (let ch = 0; ch < 3; ch++) { G[ch] = f * m + (raw[ch] - m) * cb; if (!detail) G[ch] = Math.min(G[ch], 0); }
      let covE = covRaw, edgeV = 0;
      if (!detail && k > 0) {
        edgeV = c.edgeVs[k] * covRaw * (0.35 + 0.65 * (1 - wetL)) * (1 - wetPrev);
        covE *= c.inV[k];
      }
      let A0 = 0, A1 = 0, A2 = 0, dmean = 0;
      for (let ch = 0; ch < 3; ch++) { before[ch] = acc[ch]; acc[ch] += covE * (G[ch] - acc[ch]); dmean += (G[ch] - before[ch]) / 3; }
      A0 = Math.max(-G[0], 0); A1 = Math.max(-G[1], 0); A2 = Math.max(-G[2], 0);
      const pig = Math.max(0.18, (A0 + A1 + A2) / 3) * (1 - 0.45 * kf) + 0.6 * Math.abs(dmean);
      let e = -edge * pig * (0.75 * ring + 0.35 * overlap + 0.7 * edgeV / Math.max(covE, 0.05));
      e -= drying * 0.2 * wetL * pig;
      const kA = (0.35 * 1.732) / (Math.sqrt((A0 + 0.05) ** 2 + (A1 + 0.05) ** 2 + (A2 + 0.05) ** 2) || 1), ce = covE * e;
      ext[0] = ext[0] * (1 - 0.7 * covE) + ce * (0.65 + kA * (A0 + 0.05));
      ext[1] = ext[1] * (1 - 0.7 * covE) + ce * (0.65 + kA * (A1 + 0.05));
      ext[2] = ext[2] * (1 - 0.7 * covE) + ce * (0.65 + kA * (A2 + 0.05));
      covAny = Math.max(covAny, covRaw);
      wetAny = Math.max(wetAny, wetL * covE);
      if (detail) covLast = covRaw;
      covPrev = covRaw;
      wetPrev = wetK;
    }
    const endFade = 1 - ss(Tdone, Tdone + 0.03, t);
    const lim = 0.12 + 50 * (1 - ss(0.5, 1, covLast));
    for (let ch = 0; ch < 3; ch++) col[ch] = PAPER[ch] * Math.exp(Math.max(acc[ch] + ext[ch] * endFade, L0[ch] - lim));
    const lum = 0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2], sat = 1 + 0.35 * drying * wetAny;
    const lw = c.lines * (1 - ss(sLine, Tdone, t)) * (1 - 0.45 * covLast);
    let bad = false;
    for (let ch = 0; ch < 3; ch++) {
      const v = Math.max(lum + (col[ch] - lum) * sat, 0) * (sk[ch] + (1 - ink * lw * IC[ch] - sk[ch]) * covAny);
      col[ch] = v;
      if (Math.abs(v - ref[ch]) > c.tol) bad = true;
    }
    if (c.trace) c.trace(s, [col[0], col[1], col[2], stage]);
    if (bad && t < tEnd) { if (s > lastBad) lastBad = s; if (!fwd) break; }
  }
  return Math.min(lastBad < steps ? (lastBad + 1) / steps : 1, tToP(tEnd));
}

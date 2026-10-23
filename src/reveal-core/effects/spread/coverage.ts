/**
 * Mapa pokrycia farbą z CPU (kontrakt `EffectInstance.coverage`, fala 2) — bez odczytu płótna.
 *
 * Shader (shader.ts): a = x(p) − Tp, Tp = T'(uv) + rag·bleed·w + ink·bariera·w·0.6, gdzie T' = rozciągnięte
 * ogonem pole czasu. Kolor obrazu stoi w pikselu, gdy r1 = smoothstep(0, 0.35w, a) i
 * r2 = smoothstep(0, 0.6w, a − lagLocal) są ≥ PRÓG; obie rosną z a, więc warunek to a ≥ aNeed:
 *   aNeed = max(S⁻¹(PRÓG)·0.35w, lag + S⁻¹(PRÓG)·0.6w)    (S = smoothstep na [0,1]).
 * Szum o skali pikseli uśredniamy: rag ma średnią 0, lagLocal → lag (fbm ≈ 0.5). Linie szkicu: `ink`
 * z analizy (max-pool w komórce siatki T). Komórka wyjścia = kwantyl KWANTYL czasów pod-próbek
 * (dwuliniowo z siatki T, jak LINEAR w teksturze), czyli „≥ 90% komórki pokryte”. Na końcu odwracamy
 * x(p) (easing + ogon, monotoniczne) bisekcją: najmniejsze p z x(p) ≥ Tp + aNeed. Nie da się przed końcem → 2.
 */
import type { ImageAnalysis } from "./analysis";
import type { SpreadParams } from "./params";
import { spreadTail, stretchT } from "./tail";

/** Próg r1/r2 i kwantyl pokrycia komórki. */
export const COVER_LEVEL = 0.9;
const QUANTILE = 0.9;
/** Wartość dla komórek, które pokrywa dopiero blit końcowy (p ≥ 1). */
const NEVER = 2;

/** Odwrotność smoothstep(0,1,·): t z 3t² − 2t³ = y (bisekcja). */
function smoothInv(y: number): number {
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) {
    const t = 0.5 * (lo + hi);
    if (t * t * (3 - 2 * t) < y) lo = t; else hi = t;
  }
  return 0.5 * (lo + hi);
}

export function spreadCoverage(T: Float32Array, an: ImageAnalysis, params: SpreadParams, w: number, h: number): Float32Array {
  const W = Math.max(1, Math.floor(w)), H = Math.max(1, Math.floor(h));
  const { gw, gh, ink } = an;
  const soft = params.softness;
  const s = smoothInv(COVER_LEVEL);
  const aNeed = Math.max(s * 0.35 * soft, params.underpaintLag + s * 0.6 * soft);
  const tail = spreadTail(params);
  const inkK = params.lineBarrier * soft * 0.6;

  // Pod-próbki: co najmniej 4×4 na komórkę wyjścia i nie rzadziej niż siatka T.
  const sx = Math.max(4, Math.ceil(gw / W)), sy = Math.max(4, Math.ceil(gh / H));
  const vals = new Float32Array(sx * sy);
  const q = Math.min(vals.length - 1, Math.floor(QUANTILE * vals.length));
  const at = (x: number, y: number) => T[y * gw + x];
  const xNeed = new Float32Array(W * H);
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      let k = 0;
      for (let j = 0; j < sy; j++) {
        // uv środka pod-próbki → współrzędne tekseli (środek teksela = i + 0.5), CLAMP_TO_EDGE
        const fy = Math.min(gh - 1, Math.max(0, ((cy + (j + 0.5) / sy) / H) * gh - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
        for (let i = 0; i < sx; i++) {
          const fx = Math.min(gw - 1, Math.max(0, ((cx + (i + 0.5) / sx) / W) * gw - 0.5));
          const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
          const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
          const bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
          // jak shader: T dwuliniowo → ogon → + opóźnienie linii (ink najbliższej komórki) + wymagany wiek
          const t = stretchT(top + (bot - top) * ty, tail.tk, tail.beta);
          vals[k++] = t + ink[Math.round(fy) * gw + Math.round(fx)] * inkK + aNeed;
        }
      }
      vals.sort();
      xNeed[cy * W + cx] = vals[q];
    }
  }

  // Odwrócenie x(p): tablica x na siatce p + bisekcja w przedziale.
  const N = 512;
  const xs = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) xs[i] = tail.x(i / N);
  const out = new Float32Array(W * H);
  for (let c = 0; c < out.length; c++) {
    const X = xNeed[c];
    if (X > xs[N]) { out[c] = NEVER; continue; }
    if (X <= xs[0]) { out[c] = 0; continue; }
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] >= X) hi = m; else lo = m; }
    let a = lo / N, b = hi / N;
    for (let k = 0; k < 20; k++) { const m = 0.5 * (a + b); if (tail.x(m) >= X) b = m; else a = m; }
    out[c] = b;
  }
  return out;
}

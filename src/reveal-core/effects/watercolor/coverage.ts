/**
 * Mapa pokrycia efektu `watercolor` BEZ GPU (kontrakt `EffectInstance.coverage`, combined-perf.md P3 wariant B):
 * dla każdej komórki siatki w×h najmniejsze p, przy którym piksele komórki są (prawie) w pełni pokryte kolorem —
 * liczone z tych samych danych CPU co shader (pole Tb, harmonogram `schedule()`, jitter startu per laserunek).
 *
 * Model: piksel jest „gotowy” (≈ painted w tolerancji bramki glow), gdy wszystkie warstwy domknęły kieszeń
 * (t ≥ max_k start_k + W_k; dla detalu to lokalne Tdone) plus `bias` (dopasowany do klatek: tools/wc-coverage-test.cjs).
 * Komórka = kwantyl `quantile` (domyślnie 0.9 = 90% pikseli) z próbek sub×sub. Czas t → p przez odwrotność
 * easingu shadera t = mix(p, smoothstep(p), 0.1). Funkcja czysta; wynik deterministyczny (hash jak GLSL, fround).
 */
import { schedule } from "./params";

export interface CoverageInput {
  fields: { w: number; h: number; data: Float32Array };
  resW: number;
  resH: number;
  layers: number;
  independence: number;
  seed: number;
}

export interface CoverageOpts {
  /** Przesunięcie czasu gotowości (t) względem domknięcia kieszeni wszystkich warstw. */
  bias?: number;
  /** Udział pikseli komórki, który musi być gotowy. */
  quantile?: number;
  /** Próbek na bok komórki. */
  sub?: number;
  /** close = domknięcie kieszeni wszystkich warstw (max_k start_k + W_k); detail = sam start detalu (start_{L−1}). */
  mode?: "close" | "detail";
}

/** Kompromis z przeglądu (watercolor.md, „Fala 2”): zgodność z klatkami poniżej celu — patrz tam. */
export const COVERAGE_BIAS = -0.12;
export const COVERAGE_QUANTILE = 0.9;
export const COVERAGE_MODE: "close" | "detail" = "close";

const f32 = Math.fround;
const fract = (x: number) => f32(x - Math.floor(x));

/** h12 z glslCommon.ts (WC_NOISE) w float32. */
export function makeH12(seed: number) {
  const so = f32(f32(seed) * f32(0.01731));
  return (x: number, y: number) => {
    let a = fract(f32(f32(x * f32(0.1031)) + so));
    let b = fract(f32(f32(y * f32(0.1031)) + so));
    let c = fract(f32(f32(x * f32(0.1031)) + so));
    const d = f32(f32(f32(a * f32(b + 33.33)) + f32(b * f32(c + 33.33))) + f32(c * f32(a + 33.33)));
    a = f32(a + d); b = f32(b + d); c = f32(c + d);
    return fract(f32(f32(a + b) * c));
  };
}

export function vnoise(h12: (x: number, y: number) => number, x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const wx = fx * fx * (3 - 2 * fx), wy = fy * fy * (3 - 2 * fy);
  const a = h12(ix, iy), b = h12(ix + 1, iy), c = h12(ix, iy + 1), d = h12(ix + 1, iy + 1);
  const top = a + (b - a) * wx, bot = c + (d - c) * wx;
  return top + (bot - top) * wy;
}

/** Tb z pola (kanał r) próbkowane jak textureLod(LINEAR, CLAMP_TO_EDGE). */
export function sampleTb(f: CoverageInput["fields"], u: number, v: number): number {
  const x = Math.min(f.w - 1, Math.max(0, u * f.w - 0.5)), y = Math.min(f.h - 1, Math.max(0, v * f.h - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(f.w - 1, x0 + 1), y1 = Math.min(f.h - 1, y0 + 1);
  const ax = x - x0, ay = y - y0;
  const g = (xx: number, yy: number) => f.data[(yy * f.w + xx) * 4];
  return (g(x0, y0) * (1 - ax) + g(x1, y0) * ax) * (1 - ay) + (g(x0, y1) * (1 - ax) + g(x1, y1) * ax) * ay;
}

/** Odwrotność easingu shadera: t(p) = 0.9·p + 0.1·p²(3 − 2p) (monotoniczny). */
export function tToP(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1 + (t - 1);
  let p = t;
  for (let i = 0; i < 6; i++) {
    const tp = 0.9 * p + 0.1 * p * p * (3 - 2 * p);
    p -= (tp - t) / (0.9 + 0.6 * p * (1 - p));
    p = Math.min(1, Math.max(0, p));
  }
  return p;
}

/** Siatka w×h (wiersze od góry) p gotowości komórek. */
export function coverageGrid(inp: CoverageInput, w: number, h: number, opts: CoverageOpts = {}): Float32Array {
  const bias = opts.bias ?? COVERAGE_BIAS;
  const q = opts.quantile ?? COVERAGE_QUANTILE;
  const sub = Math.max(1, Math.round(opts.sub ?? 3));
  const mode = opts.mode ?? COVERAGE_MODE;
  const sc = schedule(inp.layers, inp.independence);
  const L = sc.L;
  const h12 = makeH12(inp.seed % 1000);
  const winK = (k: number) => (k === L - 1 ? 0.6 * sc.Wloc : sc.Wloc);
  const scale = 1 / (0.3 * inp.resH);
  const out = new Float32Array(w * h);
  const vals = new Float64Array(sub * sub);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      let n = 0;
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const u = (cx + (sx + 0.5) / sub) / w, v = (cy + (sy + 0.5) / sub) / h;
          const Tb = sampleTb(inp.fields, u, v);
          const nx = u * inp.resW * scale, ny = v * inp.resH * scale;
          let tEnd = 0;
          for (let k = 0; k < L; k++) {
            const j = (vnoise(h12, nx + k * 19.3, ny + k * 19.3) - 0.5) * 2 * sc.J;
            const s0 = sc.HOLD + Tb * (k === 0 ? sc.SP0 : sc.SP) + k * sc.D + j * (k === 0 ? 0.5 : 1);
            const cap = 0.965 - winK(L - 1) - (L - 1 - k) * 0.02;
            const st = Math.min(cap, Math.max(0, s0));
            if (mode === "close") tEnd = Math.max(tEnd, st + winK(k));
            else if (k === L - 1) tEnd = st;
          }
          vals[n++] = tEnd + bias;
        }
      }
      const s = vals.slice(0, n).sort();
      out[cy * w + cx] = tToP(s[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]);
    }
  }
  return out;
}

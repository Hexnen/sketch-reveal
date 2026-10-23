/**
 * Czasy pokrycia próbek efektu „strokes” przez SYMULACJĘ KOLORU na CPU (fala 2c; dawny model progowy — coverage.ts).
 * Siatka próbek = ¼ rozdzielczości roboczej (jak coverage.ts). Na osi p (= t′, kroki 0..steps):
 *  - akumulacja pociągnięć ukończonych do p (lista po końcu = kolejność wejścia do akumulatora), premultiplied „over”
 *    jak blend shadera: kolor A → B wzdłuż osi (smoothstep 0,15–0,85), detal = 75% obrazu (lod 1), przyciemnienie
 *    brzegu włosiem, alfa = 0,97 · ŚREDNIE dziury suchego końca i smug (włosie uśrednione po próbce, bez szumu),
 *    zwężenie końca (wp) w promieniu stempla;
 *  - kompozyt jak COMPOSITE_FRAG w τ = warp⁻¹(p): papier·szkic / podkład (obraz lod 4,5) w szczelinach, linie szkicu
 *    30% do etapu „ink”, glazura `fin` do obrazu; ziarno papieru pominięte (średnia zero).
 * Próbka gotowa od kroku po OSTATNIM kroku z kolorem poza tolerancją (monotoniczne). Kalibracja: strokes.md („Fala 2c”),
 * tools/coverage-eval.cjs. Pociągnięcia rosnące w danym p pominięte (wchodzą do akumulacji przy końcu).
 */
import type { RGBImage, Work } from "./imageOps";
import { unwarp, type Schedule } from "./schedule";
import { INST_STRIDE, type StrokeSet } from "./strokeGen";

export interface SimBase {
  sketch?: RGBImage | null;
  tint?: [number, number, number];
  /** Parametr „Włosie” (domyślnie 0,6 = DEFAULT_STROKES). */
  bristle?: number;
  /** Bok tekstury obrazu (px) — lod 4,5 podkładu liczony względem niej; domyślnie szerokość roboczego. */
  texW?: number;
}

export interface SimOpts {
  /** Tolerancja modelu na kanał (0..255); bramka glow ma 28 na pikselach. */
  tol?: number;
  /** Liczba kroków osi p. */
  steps?: number;
  /** Mnożnik dziur włosia (alfa) — kalibracja. */
  holes?: number;
  /** false = pociągnięcie wchodzi dopiero przy końcu (bez wzrostu) — diagnostyka. */
  reach?: boolean;
}

export const SIM_TOL = 24;
export const SIM_STEPS = 100;
const SUB = 4;

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Średnia po bh ∈ (0,1) z smoothstep(tDry − 0,3, tDry + 0,1, t), tDry = 0,55 + 0,6·bh (suchy koniec włosia). */
function dryMean(t: number): number {
  let s = 0;
  for (let i = 0; i < 8; i++) { const td = 0.55 + 0.6 * ((i + 0.5) / 8); s += ss(td - 0.3, td + 0.1, t); }
  return s / 8;
}

function blockMean(img: RGBImage, sw: number, sh: number): Float32Array {
  const ref = new Float32Array(sw * sh * 3), cnt = new Float32Array(sw * sh);
  for (let y = 0; y < img.h; y++) {
    const row = Math.min(sh - 1, Math.floor(y / SUB)) * sw;
    for (let x = 0; x < img.w; x++) {
      const s = row + Math.min(sw - 1, Math.floor(x / SUB)), i = (y * img.w + x) * 3;
      ref[s * 3] += img.rgb[i]; ref[s * 3 + 1] += img.rgb[i + 1]; ref[s * 3 + 2] += img.rgb[i + 2]; cnt[s]++;
    }
  }
  for (let s = 0; s < sw * sh; s++) { const k = 1 / (cnt[s] || 1); ref[s * 3] *= k; ref[s * 3 + 1] *= k; ref[s * 3 + 2] *= k; }
  return ref;
}

/** Rozmycie pudełkowe (3 przebiegi ≈ gauss) promieniem r próbek, kanały RGB. */
function boxBlur3(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 0.5) return src.slice();
  const R = Math.max(1, Math.round(r));
  let a = src.slice(), b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    for (const horiz of [true, false]) {
      const n = horiz ? w : h, m = horiz ? h : w;
      for (let j = 0; j < m; j++) for (let c = 0; c < 3; c++) {
        let acc = 0;
        const at = (i: number) => { const q = Math.min(n - 1, Math.max(0, i)); return a[((horiz ? j * w + q : q * w + j) * 3) + c]; };
        for (let i = -R; i <= R; i++) acc += at(i);
        for (let i = 0; i < n; i++) {
          b[((horiz ? j * w + i : i * w + j) * 3) + c] = acc / (2 * R + 1);
          acc += at(i + R + 1) - at(i - R);
        }
      }
      [a, b] = [b, a];
    }
  }
  return a;
}

function sampleT(T: Float32Array, gw: number, gh: number, u: number, v: number): number {
  const x = Math.min(gw - 1, Math.max(0, u * gw - 0.5)), y = Math.min(gh - 1, Math.max(0, v * gh - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = T[y0 * gw + x0] + (T[y0 * gw + x1] - T[y0 * gw + x0]) * fx;
  const b = T[y1 * gw + x0] + (T[y1 * gw + x1] - T[y1 * gw + x0]) * fx;
  return a + (b - a) * fy;
}

/** Czasy (p) pokrycia próbek sw×sh; porcje do `drive` (yield co pociągnięcia / wiersze). */
export function* simSampleTimesW(set: StrokeSet, sched: Schedule, work: RGBImage, base: SimBase = {}, o: SimOpts = {}): Work<{ t: Float32Array; sw: number; sh: number }> {
  const tol = o.tol ?? SIM_TOL, steps = Math.max(8, Math.round(o.steps ?? SIM_STEPS)), holes = o.holes ?? 1;
  const bristle = base.bristle ?? 0.6;
  const sw = Math.max(1, Math.ceil(set.w / SUB)), sh = Math.max(1, Math.ceil(set.h / SUB)), N = sw * sh;
  const ref = blockMean(work, sw, sh);
  yield;
  const tint = base.tint ?? [1, 1, 1];
  const skOk = base.sketch && base.sketch.w === work.w && base.sketch.h === work.h;
  const sk = skOk ? blockMean(base.sketch!, sw, sh) : null;
  // podkład: obraz na lod 4,5 tekstury → promień w próbkach
  const texW = base.texW ?? work.w;
  const ground = boxBlur3(ref, sw, sh, (Math.pow(2, 4.5) * (work.w / texW)) / SUB / 2.2);
  yield;
  const b0 = new Float32Array(N), ink = new Float32Array(N), paper = new Float32Array(N * 3);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const s = y * sw + x;
    b0[s] = sched.S * sampleT(sched.T, sched.gw, sched.gh, ((x + 0.5) * SUB) / set.w, ((y + 0.5) * SUB) / set.h);
    for (let c = 0; c < 3; c++) paper[s * 3 + c] = (sk ? sk[s * 3 + c] : 255) * tint[c];
    ink[s] = sk ? 1 - (0.299 * sk[s * 3] + 0.587 * sk[s * 3 + 1] + 0.114 * sk[s * 3 + 2]) / 255 : 0;
  }
  const acc = new Float32Array(N * 4); // premultiplied rgb (0..255) + a
  const mark = new Int32Array(N).fill(-1);
  const last = new Int32Array(N).fill(-1);
  const inst = sched.inst, pts = set.points, n = set.count;
  const [g0, gW] = sched.ground, [i0, iW] = sched.ink, [f0, fW] = sched.fin;
  // Pociągnięcia rosną: punkt j (łuk ≈ tj·len) jest na płótnie od chwili, gdy widoczna długość Lv (≥ 0,8R od razu, potem
  // len·grow, grow = 1 − (1 − x)²) plus czoło 0,6R go mija. Stemple w kolejności listy (po końcu), punkty od dotarcia.
  const done = new Int32Array(n); // ile punktów pociągnięcia już w akumulatorze
  const maxDur = sched.maxDur;
  let rFull = 0;
  const reachOf = (r: number, j: number, np: number, R: number, len: number) => {
    if (o.reach === false) return sched.ends[r];
    const sj = (np > 1 ? j / (np - 1) : 0.5) * len;
    if (sj <= Math.min(len, 0.8 * R) + 0.6 * R) return sched.starts[r];
    const g = Math.min(1, Math.max(0, (sj - 0.6 * R) / Math.max(len, 1e-6)));
    const dur = Math.max(sched.ends[r] - sched.starts[r], 0);
    return sched.starts[r] + dur * (1 - Math.sqrt(1 - g));
  };
  for (let st = 0; st <= steps; st++) {
    const p = st / steps;
    if (p >= 1) break; // p ≥ 1 = czysty obraz
    // akumulacja: pociągnięcia z końcem ≤ p + maxDur mogą już rosnąć
    while (rFull < n && done[rFull] >= inst[rFull * INST_STRIDE + 1]) rFull++;
    for (let r = rFull; r < n && sched.ends[r] <= p + maxDur + 1e-6; r++) {
      if (sched.starts[r] > p) continue;
      const b = r * INST_STRIDE, off = inst[b], np = inst[b + 1], R = inst[b + 2], len = inst[b + 3], texMix = inst[b + 10];
      if (done[r] >= np) continue;
      const bAmt = bristle * (1 - 0.7 * texMix);
      const hasLen = len > 1e-3;
      for (let j = done[r]; j < np; j++) {
        if (reachOf(r, j, np, R, len) > p) break;
        done[r] = j + 1;
        const tj = np > 1 ? j / (np - 1) : 0.5;
        const wp = 1 - 0.35 * ss(0.45, 1, tj) * (hasLen ? 1 : 0);
        const rr = Math.max(0.5, (R * wp * (0.95 - 0.1 * bAmt)) / SUB);
        const cx = pts[(off + j) * 2] / SUB, cy = pts[(off + j) * 2 + 1] / SUB;
        const mix = ss(0.15, 0.85, tj);
        const dryF = dryMean(tj) * ss(0, 0.05, len / R);
        let alpha = 0.97 * (1 - holes * bAmt * 0.85 * dryF * 0.7) * (1 - holes * bAmt * 0.5 * 0.25 * ss(0.2, 0.7, tj));
        alpha = Math.min(1, Math.max(0, alpha));
        const xa = Math.max(0, Math.floor(cx - rr)), xb = Math.min(sw - 1, Math.floor(cx + rr));
        const ya = Math.max(0, Math.floor(cy - rr)), yb = Math.min(sh - 1, Math.floor(cy + rr));
        for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d2 = dx * dx + dy * dy;
          if (d2 > rr * rr) continue;
          const s = y * sw + x;
          if (mark[s] === r) continue; // jeden stempel na pociągnięcie
          mark[s] = r;
          const dark = 1 - bAmt * 0.07 * ss(0.55, 1, Math.sqrt(d2) / rr);
          const q = s * 4;
          for (let c = 0; c < 3; c++) {
            let col = (inst[b + 4 + c] * (1 - mix) + inst[b + 12 + c] * mix) * 255;
            if (texMix > 0) col = col * (1 - texMix) + ref[s * 3 + c] * texMix;
            col = Math.min(255, col * dark);
            acc[q + c] = col * alpha + acc[q + c] * (1 - alpha);
          }
          acc[q + 3] = alpha + acc[q + 3] * (1 - alpha);
        }
      }
      if ((r & 255) === 255) yield;
    }
    // kompozyt w τ i porównanie z obrazem
    const tau = unwarp(sched.warp, p);
    for (let s = 0; s < N; s++) {
      const bb = b0[s];
      const gr = ss(0, 1, (tau - bb - g0) / Math.max(gW, 1e-4));
      const inkGone = ss(0, 1, (tau - bb - i0) / Math.max(iW, 1e-4));
      const fin = ss(0, 1, (tau - bb - f0) / Math.max(fW, 1e-4));
      const inkOn = 1 - ink[s] * 0.3 * (1 - inkGone);
      const A = acc[s * 4 + 3];
      let bad = false;
      for (let c = 0; c < 3 && !bad; c++) {
        const under = paper[s * 3 + c] * (1 - gr) + ground[s * 3 + c] * inkOn * gr;
        let col = under * (1 - A) + acc[s * 4 + c] * inkOn;
        col += (ref[s * 3 + c] - col) * fin;
        if (Math.abs(col - ref[s * 3 + c]) > tol) bad = true;
      }
      if (bad) last[s] = st;
    }
    if ((st & 7) === 7) yield;
  }
  const t = new Float32Array(N);
  for (let s = 0; s < N; s++) t[s] = last[s] < 0 ? 0 : Math.min(1, (last[s] + 1) / steps);
  return { t, sw, sh };
}

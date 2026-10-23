/**
 * Generator pociągnięć (Hertzmann 1998, „Painterly Rendering with Curved Brush Strokes of Multiple Sizes”).
 * Warstwy od dużego pędzla do małego; każda pracuje na poziomie piramidy o skali ~R/2. Siatka co R,
 * pociągnięcie startuje tam, gdzie płótno (symulowane na CPU) najbardziej odbiega od odniesienia;
 * kierunek z pola kierunków obrazu (pyramid.ts), kolor uśredniony po śladzie (A: pierwsza połowa,
 * B: druga), koniec gdy płótno jest już bliższe odniesieniu albo kolor pod pędzlem odbiegnie o więcej
 * niż tolerancja WZGLĘDNA do lokalnego kontrastu. Ostatnia warstwa tylko na krawędziach/teksturze.
 * Asynchronicznie w porcjach ≤ ~8 ms (generatory `Work` z imageOps.ts/pyramid.ts oddają wątek co wiersz/blok,
 * raster płótna CPU wymuszany co 64 pociągnięcia) — bez zadań > 50 ms przy 1024. Harmonogram: schedule.ts.
 */
import { blur, blurW, drive, hash2, makeCanvas, rng, valueNoise, type RGBImage, type Work } from "./imageOps";
import type { StrokesParams } from "./params";
import { buildPyramidW, localStd, localStdW, orientationRGBW, type Level } from "./pyramid";

/**
 * Floaty na instancję: [pointOffset, numPoints, radius, length] [rA, gA, bA, seed]
 * [start, dur, texMix, lod] [rB, gB, bB]. start/dur wypełnia schedule.ts.
 */
export const INST_STRIDE = 15;

export interface StrokeSet {
  w: number;
  h: number;
  count: number;
  /** Punkty (x, y) w px roboczych. */
  points: Float32Array;
  /** Dane instancji w kolejności generowania (warstwami). */
  inst: Float32Array;
  layer: Uint8Array;
  layerStart: number[];
  layerRadius: number[];
  /** Siatki do pola kolejności (gw×gh): region = hash id pociągnięcia warstwy 0, haze = „dalekość”. */
  order: { gw: number; gh: number; region: Float32Array; haze: Float32Array };
  /** Diagnostyka: czasy etapów generowania (ms). */
  profile?: string[];
}

export interface CancelToken { cancelled: boolean }

const MAX_STROKES = 200_000;
/** Budżet porcji pracy w wątku głównym (ms) — po nim oddajemy wątek (MessageChannel). */
const SLICE_MS = 8;

function yieldTask(): Promise<void> {
  if (typeof MessageChannel !== "undefined") {
    return new Promise((res) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); res(); };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((res) => setTimeout(res, 0));
}

export function makeYielder(token: CancelToken) {
  let last = performance.now();
  return async (force = false) => {
    if (token.cancelled) throw new Error("cancelled");
    const now = performance.now();
    if (force || now - last > SLICE_MS) {
      await yieldTask();
      last = performance.now();
      if (token.cancelled) throw new Error("cancelled");
    }
  };
}

interface RawStroke { pts: number[]; r: number; cA: number[]; cB: number[]; seed: number; layer: number }

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Płótno CPU uśrednione do poziomu ℓ (bloki 2^ℓ×2^ℓ, jedno przejście): rgb + alfa (0..255). */
function* canvasLevel(data: Uint8ClampedArray, w: number, h: number, lw: number, lh: number, sc: number): Work<Float32Array> {
  const out = new Float32Array(lw * lh * 4);
  const cnt = new Float32Array(lw * lh);
  for (let y = 0; y < h; y++) {
    const ly = Math.min(lh - 1, Math.floor(y / sc)) * lw;
    for (let x = 0; x < w; x++) {
      const o = (ly + Math.min(lw - 1, Math.floor(x / sc))) * 4;
      const i = (y * w + x) * 4;
      out[o] += data[i];
      out[o + 1] += data[i + 1];
      out[o + 2] += data[i + 2];
      out[o + 3] += data[i + 3];
      cnt[o >> 2]++;
    }
    if ((y & 15) === 15) yield;
  }
  for (let k = 0; k < lw * lh; k++) {
    const n = cnt[k] || 1;
    for (let q = 0; q < 4; q++) out[k * 4 + q] /= n;
  }
  return out;
}

export async function generateStrokes(img: RGBImage, p: StrokesParams, token: CancelToken): Promise<StrokeSet> {
  const { w, h } = img;
  const yieldIf = makeYielder(token);
  const tick = () => yieldIf();
  const rand = rng(p.seed + 1);
  const scale = Math.max(w, h) / 1024;
  const L = p.layers;
  const radii: number[] = [];
  for (let i = 0; i < L; i++) {
    const t = L === 1 ? 0 : i / (L - 1);
    radii.push(Math.max(0.75, scale * p.brushSizeMax * Math.pow(p.brushSizeMin / p.brushSizeMax, t)));
  }
  const tg = performance.now();
  const pyr = await drive(buildPyramidW(img, 7), tick);
  await yieldIf(true);
  const prof: string[] = [`pyr+big ${Math.round(performance.now() - tg)}`];
  // Fallback kierunku dla płaskich miejsc: tensor z bardzo dużej skali (σ ≈ 0.08·max(W,H)).
  const big = pyr[Math.min(4, pyr.length - 1)];
  const bigO = await drive(orientationRGBW(big.rgb, big.w, big.h, (0.08 * Math.max(w, h)) / big.scale, 1e3, 2), tick);

  const cv = makeCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("strokes: brak kontekstu 2D");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let canvasData: Uint8ClampedArray | null = null;

  const threshold = 40 - 34 * Math.min(1, Math.max(0, p.coverage));
  const all: RawStroke[] = [];
  const layerStart: number[] = [];

  for (let li = 0; li < L; li++) {
    const R = radii[li];
    const lt = L === 1 ? 0 : li / (L - 1);
    const isLast = li === L - 1 && L > 1;
    const lvIdx = Math.max(0, Math.min(pyr.length - 1, Math.floor(Math.log2(Math.max(1, R / 1.25)))));
    const lv: Level = pyr[lvIdx];
    const sc = lv.scale;
    const lw = lv.w;
    const lh = lv.h;
    await yieldIf(true);
    let tp = performance.now();
    const extra = 0.5 * R / sc - 0.7;
    const ref = extra > 0.4 ? await drive(blurW(lv.rgb, lw, lh, 3, extra), tick) : lv.rgb;
    const orient = await drive(orientationRGBW(ref, lw, lh, Math.max(1, (0.8 * R) / sc), Math.max(2, (8 * R) / sc), Math.max(1, R / sc)), tick);
    const sd = await drive(localStdW(ref, lw, lh, Math.max(1, (2 * R) / sc)), tick);
    const mean = pyr[Math.min(pyr.length - 1, lvIdx + 2)];
    await yieldIf(true);

    // Błąd płótna względem odniesienia na poziomie ℓ.
    const err = new Float32Array(lw * lh);
    const cl = canvasData ? await drive(canvasLevel(canvasData, w, h, lw, lh, sc), tick) : null;
    for (let i = 0; i < lw * lh; i++) {
      if (!cl || cl[i * 4 + 3] < 200) { err[i] = 1e4; continue; }
      const dr = ref[i * 3] - cl[i * 4];
      const dg = ref[i * 3 + 1] - cl[i * 4 + 1];
      const db = ref[i * 3 + 2] - cl[i * 4 + 2];
      err[i] = Math.sqrt(dr * dr + dg * dg + db * db);
      if ((i & 32767) === 32767) await yieldIf();
    }
    await yieldIf(true);

    const at = (x: number, y: number) =>
      Math.min(lh - 1, Math.max(0, Math.floor(y / sc))) * lw + Math.min(lw - 1, Math.max(0, Math.floor(x / sc)));
    const step = Math.max(1, R);
    const ox = rand() * step;
    const oy = rand() * step;
    const spacing = Math.max(0.6, R * 0.6);
    const maxLen = li === 0 && L > 1 ? Math.min(p.strokeLength, 5.5) : p.strokeLength;
    const maxSteps = Math.max(1, Math.round(maxLen / 0.6));
    const minSteps = Math.max(1, Math.round(maxSteps / 3));
    const fc = Math.min(1, Math.max(0, p.curvature));
    const layerStrokes: RawStroke[] = [];
    prof.push(`L${li} analiza ${Math.round(performance.now() - tp)}`); tp = performance.now();

    const trace = (sx: number, sy: number): RawStroke => {
      const k0 = at(sx, sy);
      const c = [ref[k0 * 3], ref[k0 * 3 + 1], ref[k0 * 3 + 2]];
      const tol = Math.min(90, Math.max(16, 2.2 * sd[k0] + 10)) * (1 + 0.2 * (1 - lt));
      const pts = [sx, sy];
      const samples = [k0];
      let x = sx;
      let y = sy;
      let pdx = 0;
      let pdy = 0;
      for (let i = 1; i <= maxSteps; i++) {
        const k = at(x, y);
        const dr = ref[k * 3] - c[0];
        const dg = ref[k * 3 + 1] - c[1];
        const db = ref[k * 3 + 2] - c[2];
        const dStroke = Math.sqrt(dr * dr + dg * dg + db * db);
        if (i > minSteps && (err[k] < dStroke || dStroke > tol)) break;
        const c1 = orient[k * 3 + 2];
        const kb = Math.min(big.h - 1, Math.max(0, Math.floor(y / big.scale))) * big.w + Math.min(big.w - 1, Math.max(0, Math.floor(x / big.scale)));
        const c2 = bigO[kb * 3 + 2];
        // Fallback: poziom ±15° (podłoże, niebo); szum tylko jako wahanie, nie źródło kierunku.
        const phi = (valueNoise(x / (90 * scale), y / (90 * scale), p.seed + 3) - 0.5) * 0.52;
        const wh = (1 - c1) * (1 - c2) * 0.6;
        const vx = orient[k * 3] * c1 + bigO[kb * 3] * c2 * (1 - c1) + Math.cos(2 * phi) * wh;
        const vy = orient[k * 3 + 1] * c1 + bigO[kb * 3 + 1] * c2 * (1 - c1) + Math.sin(2 * phi) * wh;
        const th = 0.5 * Math.atan2(vy, vx);
        let dx = Math.cos(th);
        let dy = Math.sin(th);
        if (i === 1) {
          if (rand() < 0.5) { dx = -dx; dy = -dy; }
        } else {
          if (dx * pdx + dy * pdy < 0) { dx = -dx; dy = -dy; }
          dx = fc * dx + (1 - fc) * pdx;
          dy = fc * dy + (1 - fc) * pdy;
          const n = Math.hypot(dx, dy) || 1;
          dx /= n;
          dy /= n;
        }
        const nx = x + dx * spacing;
        const ny = y + dy * spacing;
        if (nx < -R || ny < -R || nx > w + R || ny > h + R) break;
        x = nx;
        y = ny;
        pdx = dx;
        pdy = dy;
        pts.push(x, y);
        samples.push(at(x, y));
      }
      // Kolor = średnia odniesienia po śladzie (A: pierwsza połowa, B: druga).
      const half = Math.max(1, Math.ceil(samples.length / 2));
      const avg = (from: number, to: number) => {
        const o = [0, 0, 0];
        for (let s = from; s < to; s++) for (let q = 0; q < 3; q++) o[q] += ref[samples[s] * 3 + q];
        const n = Math.max(1, to - from);
        return o.map((v) => v / n);
      };
      let cA = avg(0, half);
      let cB = samples.length > 1 ? avg(samples.length - half, samples.length) : cA.slice();
      // Podmalówka (2 najgrubsze warstwy): uogólnienie ku średniej regionu, światła trzymane w tonie
      // otoczenia (+25%), lekkie rozjaśnienie nocnej sceny i kontrast ×1.15.
      if (li <= 1 && L > 2) {
        const km = Math.min(mean.h - 1, Math.floor(sy / mean.scale)) * mean.w + Math.min(mean.w - 1, Math.floor(sx / mean.scale));
        const m = [mean.rgb[km * 3], mean.rgb[km * 3 + 1], mean.rgb[km * 3 + 2]];
        const lm = lum(m[0], m[1], m[2]);
        const tone = (col: number[]) => {
          let o = col.map((v, q) => m[q] + (v - m[q]) * 1.15);
          o = o.map((v, q) => v * 0.8 + m[q] * 0.2);
          const l = lum(o[0], o[1], o[2]);
          const cap = Math.max(lm * 1.25, 110);
          if (l > cap) o = o.map((v) => (v * cap) / l);
          const lift = li === 0 ? 1.13 : 1.06;
          return o.map((v) => Math.min(255, v * lift + 4));
        };
        cA = tone(cA);
        cB = tone(cB);
      }
      const vj = 1 + (rand() - 0.5) * 0.08 * p.jitter;
      return {
        pts,
        r: R * (1 + (rand() - 0.5) * 0.35 * p.jitter),
        cA: cA.map((v) => v * vj),
        cB: cB.map((v) => v * vj),
        seed: rand(),
        layer: li,
      };
    };

    const stepL = step / sc;
    for (let gy = -oy / sc; gy < lh; gy += stepL) {
      for (let gx = -ox / sc; gx < lw; gx += stepL) {
        const x0 = Math.max(0, Math.floor(gx));
        const y0 = Math.max(0, Math.floor(gy));
        const x1 = Math.min(lw, Math.max(x0 + 1, Math.floor(gx + stepL)));
        const y1 = Math.min(lh, Math.max(y0 + 1, Math.floor(gy + stepL)));
        if (x1 <= x0 || y1 <= y0) continue;
        let sum = 0;
        let best = -1;
        let bi = -1;
        let sdMax = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const e = err[y * lw + x];
            sum += e;
            if (e > best) { best = e; bi = y * lw + x; }
            if (sd[y * lw + x] > sdMax) sdMax = sd[y * lw + x];
          }
        }
        if (sum / ((x1 - x0) * (y1 - y0)) <= threshold) continue;
        if (isLast && sdMax < 14) continue; // detal tylko na krawędziach/teksturze
        if (all.length + layerStrokes.length >= MAX_STROKES) continue;
        const jx = (rand() - 0.5) * sc;
        const jy = (rand() - 0.5) * sc;
        layerStrokes.push(trace(((bi % lw) + 0.5) * sc + jx, (Math.floor(bi / lw) + 0.5) * sc + jy));
      }
      await yieldIf();
    }

    layerStart.push(all.length);
    prof.push(`L${li} trace ${Math.round(performance.now() - tp)}`); tp = performance.now();
    if (isLast || li === L - 1) {
      for (const st of layerStrokes) all.push(st);
      break;
    }
    // Nanieś warstwę na płótno CPU (średni kolor śladu).
    for (let s = 0; s < layerStrokes.length; s++) {
      const st = layerStrokes[s];
      const c = st.cA.map((v, q) => ((v + st.cB[q]) / 2) | 0);
      ctx.strokeStyle = ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.lineWidth = st.r * 2;
      ctx.beginPath();
      ctx.moveTo(st.pts[0], st.pts[1]);
      if (st.pts.length <= 2) ctx.lineTo(st.pts[0] + 0.01, st.pts[1]);
      for (let j = 2; j < st.pts.length; j += 2) ctx.lineTo(st.pts[j], st.pts[j + 1]);
      ctx.stroke();
      all.push(st);
      // Wymuś raster dotychczasowych pociągnięć (odczyt 1 px), żeby końcowy getImageData nie rasteryzował
      // całej warstwy w jednym zadaniu. Kolejność operacji ta sama → te same piksele.
      if ((s & 63) === 63) { ctx.getImageData(0, 0, 1, 1); await yieldIf(); }
    }
    canvasData = ctx.getImageData(0, 0, w, h).data;
    prof.push(`L${li} raster ${Math.round(performance.now() - tp)}`);
  }
  layerStart.push(all.length);
  await yieldIf();
  const order = buildOrderGrids(all, layerStart, pyr, w, h);
  await yieldIf();
  const set = await drive(pack(all, layerStart, radii, w, h, order), tick);
  set.profile = prof;
  return set;
}

/** Siatki kolejności: region = hash id pociągnięcia warstwy 0 pod pikselem, haze = jasno + mało kontrastu = daleko. */
function buildOrderGrids(all: RawStroke[], layerStart: number[], pyr: Level[], w: number, h: number) {
  const gw = Math.max(8, Math.round((128 * w) / Math.max(w, h)));
  const gh = Math.max(8, Math.round((128 * h) / Math.max(w, h)));
  const k = gw / w;
  const cv = makeCanvas(gw, gh);
  const ctx = cv.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = layerStart[0]; i < layerStart[1]; i++) {
    const st = all[i];
    const id = i + 1;
    ctx.strokeStyle = `rgb(${id & 255},${(id >> 8) & 255},${(id >> 16) & 255})`;
    ctx.lineWidth = st.r * 2 * k;
    ctx.beginPath();
    ctx.moveTo(st.pts[0] * k, st.pts[1] * k);
    if (st.pts.length <= 2) ctx.lineTo(st.pts[0] * k + 0.01, st.pts[1] * k);
    for (let j = 2; j < st.pts.length; j += 2) ctx.lineTo(st.pts[j] * k, st.pts[j + 1] * k);
    ctx.stroke();
  }
  const d = ctx.getImageData(0, 0, gw, gh).data;
  const region = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) region[i] = d[i * 4 + 3] > 0 ? hash2(d[i * 4], d[i * 4 + 1] * 256 + d[i * 4 + 2], 17) : 0.5;
  const lv = pyr.reduce((a, b) => (Math.abs(b.w - gw) < Math.abs(a.w - gw) ? b : a));
  const sd = localStd(lv.rgb, lv.w, lv.h, 3);
  const L = new Float32Array(lv.w * lv.h);
  for (let i = 0; i < lv.w * lv.h; i++) L[i] = lum(lv.rgb[i * 3], lv.rgb[i * 3 + 1], lv.rgb[i * 3 + 2]);
  const Lb = blur(L, lv.w, lv.h, 1, 4);
  const norm = (a: Float32Array) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return (v: number) => (v - lo) / Math.max(1e-6, hi - lo);
  };
  const nl = norm(Lb);
  const ns = norm(sd);
  const haze = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = Math.min(lv.h - 1, Math.floor((y * lv.h) / gh)) * lv.w + Math.min(lv.w - 1, Math.floor((x * lv.w) / gw));
      haze[y * gw + x] = 0.5 * nl(Lb[i]) + 0.5 * (1 - ns(sd[i]));
    }
  }
  return { gw, gh, region, haze };
}

function* pack(all: RawStroke[], layerStart: number[], radii: number[], w: number, h: number, order: StrokeSet["order"]): Work<StrokeSet> {
  let nPts = 0;
  for (const s of all) nPts += s.pts.length / 2;
  const points = new Float32Array(nPts * 2);
  const inst = new Float32Array(all.length * INST_STRIDE);
  const layer = new Uint8Array(all.length);
  const L = radii.length;
  let off = 0;
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    points.set(s.pts, off * 2);
    const n = s.pts.length / 2;
    let len = 0;
    for (let j = 2; j < s.pts.length; j += 2) len += Math.hypot(s.pts[j] - s.pts[j - 2], s.pts[j + 1] - s.pts[j - 1]);
    const o = i * INST_STRIDE;
    const last = s.layer === L - 1 && L > 1;
    inst.set([off, n, s.r, len, s.cA[0] / 255, s.cA[1] / 255, s.cA[2] / 255, s.seed, 0, 0,
      last ? 0.75 : 0, last ? 1 : 0, s.cB[0] / 255, s.cB[1] / 255, s.cB[2] / 255], o);
    layer[i] = s.layer;
    off += n;
    if ((i & 2047) === 2047) yield;
  }
  return { w, h, count: all.length, points, inst, layer, layerStart, layerRadius: radii, order };
}

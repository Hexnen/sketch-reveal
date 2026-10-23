/**
 * Pole czasu dotarcia farby T(uv) — liczone RAZ na CPU (Dijkstra na siatce ~256 px szer.),
 * potem shader jest bezstanowy i skrubowalny: reveal(uv) = f(postęp − T(uv)).
 *
 * Koszt przejścia komórki = 1 + bariera·(linie szkicu + krawędzie obrazu) + niski szum, więc
 * farba rozlewa się od zalążków, zatrzymuje na liniach, wypełnia region i dopiero potem je przelewa.
 */
import type { ImageAnalysis } from "./analysis";
import { repairIslands } from "./islands";
import { parseSeedPoints, type SpreadParams } from "./params";

// --- Szum i RNG (deterministyczne od ziarna) ---------------------------------------------------
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x: number, y: number, s: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, s: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

// --- Kopiec binarny (min) po czasie — tablice typowane, te same porównania co dawny kopiec na number[] ----
// (przesiewanie „dziurą” zamiast zamian: identyczna kolejność zdejmowania, także przy remisach).
class MinHeap {
  private idx = new Int32Array(4096);
  private key = new Float64Array(4096);
  size = 0;
  /** Klucz ostatnio zdjętego elementu (float64, jak dawniej `[i, t]`). */
  topKey = 0;
  push(i: number, k: number) {
    if (this.size === this.idx.length) {
      const ni = new Int32Array(this.size * 2); ni.set(this.idx); this.idx = ni;
      const nk = new Float64Array(this.size * 2); nk.set(this.key); this.key = nk;
    }
    const I = this.idx, K = this.key;
    let c = this.size++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (K[p] <= k) break;
      I[c] = I[p]; K[c] = K[p]; c = p;
    }
    I[c] = i; K[c] = k;
  }
  pop(): number {
    const I = this.idx, K = this.key;
    const top = I[0];
    this.topKey = K[0];
    const n = --this.size;
    if (n > 0) {
      const li = I[n], lk = K[n];
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = -1, mk = lk;
        if (l < n && K[l] < mk) { m = l; mk = K[l]; }
        if (r < n && K[r] < mk) { m = r; mk = K[r]; }
        if (m < 0) break;
        I[c] = I[m]; K[c] = K[m]; c = m;
      }
      I[c] = li; K[c] = lk;
    }
    return top;
  }
}

export interface SeedPoint { x: number; y: number; delay: number }

/** Zalążki: origin + kliknięte (delay 0) + w trybie scatter `seedCount` losowych/w światłach. */
export function pickSeeds(a: ImageAnalysis, p: SpreadParams): SeedPoint[] {
  const seeds: SeedPoint[] = [{ x: p.originX, y: p.originY, delay: 0 }];
  for (const s of parseSeedPoints(p.seedPoints)) seeds.push({ x: s.x, y: s.y, delay: 0 });
  if (p.seedMode !== "scatter") return seeds;
  const rng = mulberry32(p.seed * 9973 + 17);
  const minDist = 0.12;
  const far = (x: number, y: number) => seeds.every((s) => Math.hypot(s.x - x, (s.y - y) * (a.gh / a.gw)) > minDist);
  for (let k = 0; k < Math.round(p.seedCount); k++) {
    const lights = rng() < p.lightsFirst;
    let best: { x: number; y: number; score: number } | null = null;
    for (let t = 0; t < (lights ? 300 : 40); t++) {
      const x = rng(), y = rng();
      if (!far(x, y)) continue;
      const score = lights ? a.imp[Math.min(a.gh - 1, (y * a.gh) | 0) * a.gw + Math.min(a.gw - 1, (x * a.gw) | 0)] : rng();
      if (!best || score > best.score) best = { x, y, score };
    }
    if (!best) continue;
    // Opóźnienie startu w ułamkach „średnicy” siatki — origin zawsze prowadzi.
    const delay = (lights ? 0.05 + 0.25 * rng() : 0.15 + 0.45 * rng()) * Math.max(a.gw, a.gh);
    seeds.push({ x: best.x, y: best.y, delay });
  }
  return seeds;
}

/** Kroki pomiędzy oddaniem sterowania w generatorach (zdjęcia z kopca / wiersze siatki). */
const POPS_PER_YIELD = 2048;
const ROWS_PER_YIELD = 24;

/** Dijkstra (8-sąsiedztwo) → znormalizowane T w [0,1] (pół liniowo, pół wyrównanie histogramu). Porcjami. */
export function* timeFieldSteps(a: ImageAnalysis, p: SpreadParams): Generator<void, Float32Array, void> {
  const { gw, gh } = a;
  const n = gw * gh;
  const cost = new Float32Array(n);
  const aspect = gw / gh;
  const B = p.lineBarrier;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const u = (x / gw) * aspect * p.brushScale, v = (y / gh) * p.brushScale;
      const nz = 0.65 * vnoise(u, v, p.seed) + 0.35 * vnoise(u * 2.3, v * 2.3, p.seed + 1);
      // Kreska 1–2 komórki ≈ 12–24 „kroków” objazdu: front staje, ale małe kieszenie (szyby,
      // cegły) nie zostają długo białymi dziurami.
      cost[i] = 1 + B * (12 * a.ink[i] + 4 * a.edge[i]) + 0.9 * nz;
    }
  }
  yield;
  // UWAGA: Float32 celowo (zgodność wyglądu) — zaokrąglenie zostawia „martwe” komórki i wyspy T=∞,
  // naprawiane potem przez repairIslands (islands.ts). Nie zmieniaj na Float64 bez decyzji o wyglądzie.
  const T = new Float32Array(n).fill(Infinity);
  const heap = new MinHeap();
  for (const s of pickSeeds(a, p)) {
    const i = Math.min(gh - 1, Math.max(0, Math.round(s.y * (gh - 1)))) * gw + Math.min(gw - 1, Math.max(0, Math.round(s.x * (gw - 1))));
    if (s.delay < T[i]) { T[i] = s.delay; heap.push(i, s.delay); }
  }
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
  let pops = 0;
  while (heap.size) {
    const i = heap.pop();
    const t = heap.topKey;
    if ((++pops & (POPS_PER_YIELD - 1)) === 0) yield;
    if (t > T[i]) continue;
    const x = i % gw, y = (i / gw) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx;
      const nt = t + 0.5 * (cost[i] + cost[j]) * DL[d];
      if (nt < T[j]) { T[j] = nt; heap.push(j, nt); }
    }
  }
  yield;
  // Wyspy nieosiągalne przez „martwe” komórki (patrz islands.ts) — dolewane od brzegu, reszta bez zmian.
  const R = repairIslands(T, cost, gw, gh);
  const island = R ? Uint8Array.from(T, (v) => (v === Infinity ? 1 : 0)) : null;
  let tmax = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(T[i]) && T[i] > tmax) tmax = T[i];
  tmax = Math.max(tmax, 1e-6);
  const BINS = 1024;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < n; i++) {
    T[i] = Number.isFinite(T[i]) ? T[i] / tmax : 1;
    hist[Math.min(BINS - 1, (T[i] * BINS) | 0)]++;
  }
  const cdf = new Float32Array(BINS);
  let acc = 0;
  for (let b = 0; b < BINS; b++) { cdf[b] = (acc + hist[b] / 2) / n; acc += hist[b]; }
  // Pół na pół: liniowe T zachowuje „stanie na linii”, CDF wyrównuje tempo (pole ~liniowo w czasie).
  for (let i = 0; i < n; i++) T[i] = 0.5 * T[i] + 0.5 * cdf[Math.min(BINS - 1, (T[i] * BINS) | 0)];
  yield;
  const out = new Float32Array(T);
  yield* fillPockets(T, gw, gh, 0.03, null, out);
  if (!R || !island) return out;
  // Wyspy: ta sama normalizacja (histogram jak dotąd — wyspy liczone jako 1 — żeby reszta pola została
  // bit w bit). Czas za tmax (wyspa za najpóźniejszym brzegiem) ściskamy w (½·r+½) ≤ 1: późno, ale płynnie.
  const N2 = new Float32Array(T);
  for (let i = 0; i < n; i++) {
    if (!island[i]) continue;
    const r = R[i] / tmax;
    N2[i] = r <= 1 ? 0.5 * r + 0.5 * cdf[Math.min(BINS - 1, (r * BINS) | 0)] : Math.min(1, 0.5 + 0.5 * r);
  }
  yield* fillPockets(N2, gw, gh, 0.03, island, out);
  return out;
}

/** Synchronicznie (testy/narzędzia). */
export function computeTimeField(a: ImageAnalysis, p: SpreadParams): Float32Array {
  const g = timeFieldSteps(a, p);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

/**
 * Domykanie kieszeni: komórka nie może być „spóźniona” bardziej niż `slack` względem mediany
 * sąsiedztwa 5×5. Małe zamknięte obszary (szyby, cegły) dostają farbę zaraz po otoczeniu,
 * a długie linie dalej trzymają front (po drugiej stronie linii mediana też jest późna).
 * `only`: przelicz tylko wskazane komórki; wynik wpisywany do `out` (reszta `out` bez zmian).
 * Okno w stałym Float32Array(25) + sortowanie przez wstawianie (bez alokacji per komórka) — ta sama mediana.
 */
function* fillPockets(
  T: Float32Array, gw: number, gh: number, slack: number, only: Uint8Array | null, out: Float32Array,
): Generator<void, void, void> {
  const win = new Float32Array(25);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (only && !only[y * gw + x]) continue;
      let k = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const row = Math.min(gh - 1, Math.max(0, y + dy)) * gw;
        for (let dx = -2; dx <= 2; dx++) {
          const v = T[row + Math.min(gw - 1, Math.max(0, x + dx))];
          let j = k++;
          while (j > 0 && win[j - 1] > v) { win[j] = win[j - 1]; j--; }
          win[j] = v;
        }
      }
      const med = win[12];
      const i = y * gw + x;
      out[i] = T[i] > med + slack ? med + slack : T[i];
    }
    if (y % ROWS_PER_YIELD === ROWS_PER_YIELD - 1) yield;
  }
}

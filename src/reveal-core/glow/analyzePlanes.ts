/**
 * Detektor adaptacyjny — płaszczyzny obrazu i samokalibracja sceny (krok 1).
 *
 * Wszystko, co dalej jest „progiem”, wynika z tych statystyk, a nie ze stałych pod konkretny obraz:
 *  - ekspozycja sceny: klucz = średnia geometryczna luminancji (Reinhard), `exposure` = log2(klucz / 0,18) —
 *    ciągła wartość (EV względem szarości średniej), nie przełącznik dzień/noc;
 *  - mapa emisji E = ½Y + ½V + 0,35·sat·V − 0,7·(lokalna średnia Y w skali ~4% przekątnej) i jej rozkład
 *    (mediana, MAD) — poziomy drzewa komponentów to `med + z·MAD` (analyzeTree.ts), więc obraz z bogatą fakturą
 *    sam podnosi próg, a ciemna scena z drobnymi światłami go obniża;
 *  - to samo dla luminancji Y: sygnał drzewa Z = max(zE, zY) — emisja lokalna (lampa na ciemnej ścianie) albo
 *    jasność odstająca od całej sceny (słońce na jasnym niebie, gdzie lokalny kontrast jest mały);
 *  - szum/faktura: mediana |∇V| (krawędź „treści” liczy się względem niej).
 * Współczynniki E (½, ½, 0,35, 0,7) to definicja sygnału, nie decyzja — decyzje podejmuje skalibrowany model.
 */
export interface Planes {
  V: Float32Array; C: Float32Array; Y: Float32Array; E: Float32Array; G: Float32Array;
  /** Sygnał drzewa: max(z-score emisji, z-score luminancji) — wartości odstające od rozkładu SAMEJ sceny. */
  Z: Float32Array;
  /** Lokalna średnia luminancji (G tekstury dla shadera). */
  M: Float32Array;
  px: Uint8ClampedArray; aw: number; ah: number;
  /** Obraz całkowy V (Float64, (aw+1)×(ah+1)) — pierścienie wokół blobów w O(1). */
  IV: Float64Array;
}

export interface SceneStats {
  /** Średnia geometryczna Y i ekspozycja w EV względem 0,18 (ciągła). */
  key: number; exposure: number;
  meanY: number; brightShare: number;
  /** Diagnostyka (zgodność z dawnym `SceneKey.day`): ciągłe 0..1 z ekspozycji, NIE używane do decyzji. */
  day: number;
  /** Rozkład mapy emisji i luminancji: mediana i MAD (×1,4826). */
  eMed: number; eMad: number; yMed: number; yMad: number;
  /** Percentyle Y (p50, p99) i V (p999) całego kadru. */
  y50: number; y99: number; v999: number;
  /** Mediana |∇V| (faktura/szum obrazu). */
  gMed: number;
}

/** Rozmycie pudełkowe (separowalne, sumy bieżące), w miejscu. */
export function boxBlur(a: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    let acc = 0; const o = y * w;
    for (let x = -r; x <= r; x++) acc += a[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[x] = acc / (2 * r + 1);
      acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
    }
    a.set(tmp.subarray(0, w), o);
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += a[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      tmp[y] = acc / (2 * r + 1);
      acc += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
    }
    for (let y = 0; y < h; y++) a[y * w + x] = tmp[y];
  }
}

/** Kwantyl z histogramu 1024 koszyków na [lo, hi]. */
function histQ(a: Float32Array, lo: number, hi: number, qs: number[]): number[] {
  const B = 1024, h = new Uint32Array(B), s = (B - 1) / (hi - lo);
  for (let i = 0; i < a.length; i++) h[Math.max(0, Math.min(B - 1, ((a[i] - lo) * s) | 0))]++;
  return qs.map((q) => {
    let acc = 0; const t = q * a.length;
    for (let i = 0; i < B; i++) { acc += h[i]; if (acc >= t) return lo + (i + 0.5) / s; }
    return hi;
  });
}

export async function buildPlanes(px: Uint8ClampedArray, aw: number, ah: number, slice: () => Promise<void>): Promise<{ P: Planes; st: SceneStats }> {
  const N = aw * ah, diag = Math.hypot(aw, ah);
  const V = new Float32Array(N), C = new Float32Array(N), Y = new Float32Array(N), E = new Float32Array(N), M = new Float32Array(N), G = new Float32Array(N);
  let logSum = 0, ySum = 0, bright = 0;
  for (let i = 0; i < N; i++) {
    const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    V[i] = mx; C[i] = mx - mn; Y[i] = y; M[i] = y;
    E[i] = 0.5 * y + 0.5 * mx + 0.35 * (mx > 0 ? (mx - mn) / mx : 0) * mx;
    logSum += Math.log(y + 0.01); ySum += y; if (y > 0.6) bright++;
  }
  await slice();
  const R = Math.max(2, Math.round(0.039 * diag)) >> 1;
  boxBlur(M, aw, ah, R); await slice();
  boxBlur(M, aw, ah, R); await slice();
  for (let i = 0; i < N; i++) E[i] -= 0.7 * M[i];
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
    const i = y * aw + x;
    G[i] = (x < aw - 1 ? Math.abs(V[i + 1] - V[i]) : 0) + (y < ah - 1 ? Math.abs(V[i + aw] - V[i]) : 0);
  }
  const W1 = aw + 1, IV = new Float64Array(W1 * (ah + 1));
  for (let y = 0; y < ah; y++) {
    let row = 0;
    for (let x = 0; x < aw; x++) { row += V[y * aw + x]; IV[(y + 1) * W1 + x + 1] = IV[y * W1 + x + 1] + row; }
  }
  await slice();
  const [eMed] = histQ(E, -1, 2, [0.5]);
  const dev = new Float32Array(N);
  for (let i = 0; i < N; i++) dev[i] = Math.abs(E[i] - eMed);
  const [mad] = histQ(dev, 0, 2, [0.5]);
  const [y50, y99] = histQ(Y, 0, 1, [0.5, 0.99]);
  for (let i = 0; i < N; i++) dev[i] = Math.abs(Y[i] - y50);
  const [ymad] = histQ(dev, 0, 1, [0.5]);
  const eMad = Math.max(0.02, mad * 1.4826), yMad = Math.max(0.02, ymad * 1.4826);
  const Z = new Float32Array(N);
  for (let i = 0; i < N; i++) Z[i] = Math.max((E[i] - eMed) / eMad, (Y[i] - y50) / yMad);
  const [v999] = histQ(V, 0, 1, [0.999]);
  const [gMed] = histQ(G, 0, 2, [0.5]);
  const key = Math.exp(logSum / N) - 0.01, exposure = Math.log2(Math.max(1e-3, key) / 0.18);
  const st: SceneStats = {
    key, exposure, meanY: ySum / N, brightShare: bright / N, day: Math.max(0, Math.min(1, (exposure + 0.5) / 2)),
    eMed, eMad, yMed: y50, yMad, y50, y99, v999, gMed: Math.max(0.004, gMed),
  };
  return { P: { V, C, Y, E, G, Z, M, px, aw, ah, IV }, st };
}

/** Suma V w prostokącie [x0, x1) × [y0, y1) (przycięte do kadru) i liczba pikseli. */
export function rectV(P: Planes, x0: number, y0: number, x1: number, y1: number): [number, number] {
  const { aw, ah, IV } = P, W1 = aw + 1;
  x0 = Math.max(0, Math.min(aw, x0)); x1 = Math.max(0, Math.min(aw, x1)); y0 = Math.max(0, Math.min(ah, y0)); y1 = Math.max(0, Math.min(ah, y1));
  if (x1 <= x0 || y1 <= y0) return [0, 0];
  return [IV[y1 * W1 + x1] - IV[y0 * W1 + x1] - IV[y1 * W1 + x0] + IV[y0 * W1 + x0], (x1 - x0) * (y1 - y0)];
}

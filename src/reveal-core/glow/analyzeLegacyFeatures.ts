/**
 * Komponenty spójne i ich cechy (detekcja świateł). Etykietowanie po KLASACH (1 = zwykła maska, 2 = tarcza):
 * sąsiednie piksele różnych klas nie łączą się, więc słońce nie zlewa się z niebem.
 */
export interface LegacyRaw {
  cls: number;
  area: number; x0: number; y0: number; x1: number; y1: number;
  hv: Uint32Array; hc: Uint32Array; // histogramy V i chromy (32 koszyki)
  r1: number; n1: number; r2: number; n2: number;
  coreX: number; coreY: number; coreN: number; /** piksele „białego żaru” (V ≥ 0,97, sat < 0,3) */ coreSat: number;
  cr: number; cg: number; cb: number; cn: number; // barwa ćwiartki najbardziej nasyconej (sRGB)
  sx: number; sy: number; sY: number; rmax: number; // środek ciężkości, suma Y, maks. odległość od środka
  p95: number; c90: number; hue: number; sat: number; conf: number; warm: boolean; maxV: number; fall: number;
  /** Odrzucony (za duży rdzeń, limit łączny) — nie jest ani emiterem, ani „oświetlonym”. */
  drop: boolean;
  /** Rdzeń wycięty z za dużego komponentu: indeks komponentu-rodzica z przebiegu 1 (-1 = nie). */
  parent: number;
  /** Rodzic (dla rdzenia) wygląda jak skóra — rdzeń nie dostaje wyjątku „świecący rdzeń” (jasna dłoń na obrusie). */
  pskin: boolean;
  /** Małe białe światło nocą (przepalony, achromatyczny rdzeń z poświatą): okno/żarówka, nigdy neon ani latarnia. */
  white: boolean;
  /** Lampka LED (mały, nasycony punkt na ciemnym tle) / świetlik (achromatyczna, zwarta, jasna plama) — analyzeKinds.ts. */
  led: boolean;
  sky: boolean;
  /** Diagnostyka: dlaczego odrzucony / jak sklasyfikowany. */
  note: string;
}

export interface LegacyPlanes { V: Float32Array; C: Float32Array; Y: Float32Array; px: Uint8ClampedArray; aw: number; ah: number }

export function legacyHueOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-5) return 0;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
export const legacyHueDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
export const legacyIsWarm = (h: number) => h >= 15 && h <= 75;

export const legacyPct = (h: Uint32Array, n: number, q: number) => {
  let acc = 0;
  for (let i = 0; i < h.length; i++) { acc += h[i]; if (acc >= q * n) return (i + 0.5) / h.length; }
  return 1;
};

/** Rozmycie pudełkowe (separowalne, sumy bieżące), w miejscu. */
export function legacyBoxBlur(a: Float32Array, w: number, h: number, r: number) {
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

const newRaw = (cls: number, aw: number, ah: number): LegacyRaw => ({
  cls, area: 0, x0: aw, y0: ah, x1: 0, y1: 0, hv: new Uint32Array(32), hc: new Uint32Array(32), r1: 0, n1: 0, r2: 0, n2: 0,
  coreX: 0, coreY: 0, coreN: 0, coreSat: 0, cr: 0, cg: 0, cb: 0, cn: 0, sx: 0, sy: 0, sY: 0, rmax: 0,
  p95: 0, c90: 0, hue: 0, sat: 0, conf: 0, warm: false, maxV: 0, fall: 0, drop: false, parent: -1, pskin: false, white: false, led: false, sky: false, note: "",
});

/** Etykietowanie (8-sąsiedztwo, tylko w obrębie tej samej klasy) + cechy. `k` = skala progów (przekątna / ref). */
export async function labelAndMeasureLegacy(cls: Uint8Array, P: LegacyPlanes, k: number, slice: () => Promise<void>) {
  const { V, C, Y, px, aw, ah } = P;
  const N = aw * ah;
  const lab = new Int32Array(N);
  const raws: LegacyRaw[] = [];
  const stack = new Int32Array(N);
  for (let i0 = 0; i0 < N; i0++) {
    const c0 = cls[i0];
    if (!c0 || lab[i0]) continue;
    const id = raws.length + 1;
    const rw = newRaw(c0, aw, ah);
    raws.push(rw);
    let sp = 0; stack[sp++] = i0; lab[i0] = id;
    while (sp) {
      const i = stack[--sp], x = i % aw, y = (i / aw) | 0;
      rw.area++; rw.sx += x; rw.sy += y; rw.sY += Y[i];
      if (x < rw.x0) rw.x0 = x; if (x > rw.x1) rw.x1 = x; if (y < rw.y0) rw.y0 = y; if (y > rw.y1) rw.y1 = y;
      rw.hv[Math.min(31, (V[i] * 32) | 0)]++; rw.hc[Math.min(31, (C[i] * 32) | 0)]++;
      if (V[i] > rw.maxV) rw.maxV = V[i];
      if (V[i] >= 0.97) { rw.coreX += x; rw.coreY += y; rw.coreN++; if (C[i] < 0.3 * V[i]) rw.coreSat++; }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= ah) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= aw) continue;
          const j = yy * aw + xx;
          if (cls[j] === c0 && !lab[j]) { lab[j] = id; stack[sp++] = j; }
        }
      }
    }
    if ((raws.length & 63) === 0) await slice();
  }
  for (const rw of raws) { rw.p95 = legacyPct(rw.hv, rw.area, 0.95); rw.c90 = legacyPct(rw.hc, rw.area, 0.9); }

  // spadek poświaty: średnia V tła (bez maski) blisko (box r≈5) vs daleko (pierścień box 14–26) — obrazy całkowe
  const W1 = aw + 1, Iv = new Float64Array(W1 * (ah + 1)), In = new Float64Array(W1 * (ah + 1));
  for (let y = 0; y < ah; y++) {
    let rv = 0, rn = 0;
    for (let x = 0; x < aw; x++) {
      const i = y * aw + x, f = cls[i] ? 0 : 1;
      rv += V[i] * f; rn += f;
      Iv[(y + 1) * W1 + x + 1] = Iv[y * W1 + x + 1] + rv; In[(y + 1) * W1 + x + 1] = In[y * W1 + x + 1] + rn;
    }
  }
  await slice();
  const box = (I: Float64Array, x: number, y: number, r: number) => {
    const x0 = Math.max(0, x - r), x1 = Math.min(aw, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(ah, y + r + 1);
    return I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
  };
  const rA = Math.max(2, Math.round(5 * k)), rB = Math.round(14 * k), rC = Math.round(26 * k);
  const c75 = raws.map((rw) => legacyPct(rw.hc, rw.area, 0.75) - 1 / 64);
  for (let i = 0; i < N; i++) {
    const id = lab[i]; if (!id) continue;
    const x = i % aw, y = (i / aw) | 0, rw = raws[id - 1];
    const nA = box(In, x, y, rA), nB = box(In, x, y, rB), nC = box(In, x, y, rC);
    if (nA > 0) { rw.r1 += box(Iv, x, y, rA) / nA; rw.n1++; }
    if (nC - nB > 0) { rw.r2 += (box(Iv, x, y, rC) - box(Iv, x, y, rB)) / (nC - nB); rw.n2++; }
    // barwa najbardziej nasyconej ćwiartki
    if (C[i] >= c75[id - 1]) { rw.cr += px[i * 4]; rw.cg += px[i * 4 + 1]; rw.cb += px[i * 4 + 2]; rw.cn++; }
    // okrągłość: maks. odległość od środka ciężkości
    const d = Math.hypot(x - rw.sx / rw.area, y - rw.sy / rw.area);
    if (d > rw.rmax) rw.rmax = d;
  }
  await slice();
  for (const rw of raws) {
    rw.hue = rw.cn ? legacyHueOf(rw.cr, rw.cg, rw.cb) : 0;
    const mx = Math.max(rw.cr, rw.cg, rw.cb);
    rw.sat = mx > 0 ? (mx - Math.min(rw.cr, rw.cg, rw.cb)) / mx : 0;
    rw.warm = legacyIsWarm(rw.hue);
    const r1 = rw.n1 ? rw.r1 / rw.n1 : 0, r2 = rw.n2 ? rw.r2 / rw.n2 : r1;
    rw.fall = r1 / Math.max(r2, 0.03);
  }
  return { lab, raws };
}

/** Okrągłość: powierzchnia / koło o promieniu rmax (koło ≈ 0,85–1, kłąb chmur / prostokąt okna ≈ 0,5–0,65). */
export const legacyRoundness = (r: LegacyRaw) => r.area / (Math.PI * Math.max(1, r.rmax + 0.5) ** 2);

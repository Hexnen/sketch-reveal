/**
 * Pole czasu T(x,y): kiedy piksel tuszu staje się widoczny.
 * 1) WŁASNOŚĆ: każdy piksel tuszu należy do najbliższej osi (BFS od szkieletów, raz na analizę) i dziedziczy
 *    czas jej punktu: T = Tp(s) + opóźnienie·odległość od osi (euklidesowa, nie w krokach BFS) — brzegi kreski
 *    mają czas gładki i spójny z osią, bez „frędzli” z pikseli przyłączonych po jednym.
 * 2) RDZEŃ: kreska kładzie też tusz cudzych pikseli, ale tylko w swoim rdzeniu (≤ 0,9·półgrubości) — na
 *    skrzyżowaniu linia jest ciągła, a przecinające ją kreskowanie nie wystaje „grzebieniem” ząbków.
 * 3) PLAMY: tusz dalej niż półgrubość+1,5 px od osi jest zamalowywany zygzakiem (fillSweep), nie blokiem.
 * 4) Tony/szum bez połączenia: czas najbliższej kreski + krótkie opóźnienie.
 * Render jest bezstanowy: kolor = mix(papier, cel, pokrycie(t − T, soft)).
 */
import { END, profileInv, type Schedule } from "./schedule";
import type { Path } from "./trace";

export interface FieldDeps { END: number; profileInv: typeof profileInv }

/**
 * Fabryka bez odwołań na zewnątrz (zależności tylko z parametru) — źródło serializowane do Workera
 * (Blob URL, worker.ts) i wołane na wątku głównym (fallback). Nie odwołuj się tu do importów modułu.
 */
export function fieldModule(d: FieldDeps) {
  const { END, profileInv } = d;
  const OFF8 = (w: number) => [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1];

  interface Owners { path: Int32Array; j: Int32Array }
  const ownersCache = new WeakMap<Path[], Owners>();

  /** Właściciel piksela tuszu: najbliższy (BFS) piksel szkieletu — ścieżka i indeks punktu. Dłuższe ścieżki mają pierwszeństwo. */
  function owners(paths: Path[], ink: Uint8Array, inkLo: number, w: number, h: number): Owners {
    const hit = ownersCache.get(paths);
    if (hit) return hit;
    const n = w * h, path = new Int32Array(n).fill(-1), jj = new Int32Array(n), q = new Int32Array(n);
    let qt = 0;
    const ord = paths.map((_, i) => i).sort((a, b) => paths[b].L - paths[a].L);
    for (const k of ord) {
      const P = paths[k];
      for (let j = 0; j < P.pix.length; j++) {
        const i = P.pix[j];
        if (path[i] >= 0) continue;
        path[i] = k; jj[i] = Math.round(j * (P.xs.length - 1) / Math.max(1, P.pix.length - 1)); q[qt++] = i;
      }
    }
    const off = OFF8(w);
    for (let qh = 0; qh < qt; qh++) {
      const i = q[qh], x = i % w;
      for (let k = 0; k < 8; k++) {
        const r = i + off[k];
        if (r < 0 || r >= n || path[r] >= 0 || ink[r] <= inkLo) continue;
        const rx = r % w;
        if (rx - x > 1 || x - rx > 1) continue;
        path[r] = path[i]; jj[r] = jj[i]; q[qt++] = r;
      }
    }
    const o = { path, j: jj };
    ownersCache.set(paths, o);
    return o;
  }

  /** Pole (T, soft) przeplecione — gotowe do tekstury RG32F. Synchroniczne (~kilkadziesiąt ms dla 0,6 Mpx). */
  function computeField(paths: Path[], ink: Uint8Array, inkLo: number, w: number, h: number, S: Schedule): Float32Array {
    const n = w * h, f = new Float32Array(n * 2);
    const T = new Float32Array(n).fill(Infinity), soft = new Float32Array(n), depth = new Uint8Array(n);
    const TMAX = END + 0.03;
    const O = owners(paths, ink, inkLo, w, h);
    const pxT = new Float32Array(paths.length), sfK = new Float32Array(paths.length);
    const tp = (k: number, j: number) => {
      const P = paths[k], u = S.rev[k] ? 1 - P.cum[j] / P.L : P.cum[j] / P.L;
      return S.start[k] + S.dur[k] * profileInv(S.prof[k], u);
    };
    paths.forEach((P, k) => {
      pxT[k] = S.dur[k] / Math.max(1, P.L);
      sfK[k] = Math.min(0.03, Math.max(1e-4, pxT[k] * 3.5)); // miękkie czoło ~3,5 px łuku
    });
    // 1) własność: czas punktu osi + opóźnienie wg odległości euklidesowej
    for (let i = 0; i < n; i++) {
      const k = O.path[i];
      if (k < 0) continue;
      const P = paths[k], j = O.j[i];
      const d = Math.hypot((i % w) - P.xs[j], ((i / w) | 0) - P.ys[j]);
      T[i] = tp(k, j) + pxT[k] * 1.3 * d; soft[i] = sfK[k];
      if (d > P.hw[j] + 1.5 && d >= 2.5) depth[i] = 3; // plama → sweep
    }
    // 2) rdzeń kreski kładzie tusz także na cudzych pikselach (ciągłość na skrzyżowaniach)
    for (let k = 0; k < paths.length; k++) {
      const P = paths[k], lag = pxT[k] * 1.3;
      for (let j = 0; j < P.xs.length; j++) {
        const r = P.hw[j] * 0.9 + 0.35, x0 = P.xs[j], y0 = P.ys[j], Tp = tp(k, j), r2 = r * r;
        const xa = Math.max(0, Math.floor(x0 - r)), xb = Math.min(w - 1, Math.ceil(x0 + r));
        const ya = Math.max(0, Math.floor(y0 - r)), yb = Math.min(h - 1, Math.ceil(y0 + r));
        for (let y = ya; y <= yb; y++) {
          const dy2 = (y - y0) * (y - y0);
          for (let x = xa, i = y * w + xa; x <= xb; x++, i++) {
            if (ink[i] <= inkLo || Tp >= T[i]) continue;
            const d2 = (x - x0) * (x - x0) + dy2;
            if (d2 > r2) continue;
            const t = Tp + lag * Math.sqrt(d2);
            if (t < T[i]) { T[i] = t; soft[i] = sfK[k]; depth[i] = 0; }
          }
        }
      }
    }
    fillSweep(T, soft, depth, w, h, TMAX);
    // 3) tony i drobny szum bez połączenia: czas sąsiedztwa (BFS przez papier), potem lekkie opóźnienie
    const q = new Int32Array(n), off = OFF8(w);
    let qt = 0;
    const isTone = new Uint8Array(n), st = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (T[i] < Infinity) q[qt++] = i;
      else if (ink[i] >= 2) isTone[i] = 1;
    }
    for (let qh = 0; qh < qt; qh++) {
      const i = q[qh], x = i % w;
      for (let k = 0; k < 8; k++) {
        const r = i + off[k];
        if (r < 0 || r >= n || T[r] < Infinity) continue;
        const rx = r % w;
        if (rx - x > 1 || x - rx > 1) continue;
        T[r] = T[i]; soft[r] = soft[i]; st[r] = Math.min(255, st[i] + 1); q[qt++] = r;
      }
    }
    for (let i = 0; i < n; i++) {
      let t = T[i], s = soft[i];
      if (t === Infinity) { t = 0.5; s = 0.03; }
      // jasny AA tuż przy kresce (≤ 2 px) idzie RAZEM z nią (bez szarej obwódki doklejanej później);
      // dalekie tony/szum — chwilę po najbliższej kresce
      if (isTone[i] && st[i] > 2) { t += 0.025; s = 0.025; }
      s = Math.min(s, 0.03);
      f[i * 2] = Math.min(t, TMAX - s);
      f[i * 2 + 1] = s;
    }
    return f;
  }

  /**
   * Plamy (tusz dalej niż 2 px od osi kresek): zamalowywanie zygzakiem w poprzek plamy pod 45° — rzędy co 3 px,
   * kierunek naprzemienny, start = najwcześniejszy czas dotarcia do plamy, czas ∝ powierzchni.
   * Zastępuje „dopełnianie blokiem” z BFS.
   */
  function fillSweep(T: Float32Array, soft: Float32Array, depth: Uint8Array, w: number, h: number, TMAX: number) {
    const n = w * h, seen = new Uint8Array(n), comp: number[] = [];
    const off = OFF8(w);
    for (let s0 = 0; s0 < n; s0++) {
      if (depth[s0] < 3 || seen[s0]) continue;
      comp.length = 0; comp.push(s0); seen[s0] = 1;
      for (let c = 0; c < comp.length; c++) {
        const i = comp[c], x = i % w;
        for (let k = 0; k < 8; k++) {
          const r = i + off[k];
          if (r < 0 || r >= n || seen[r] || depth[r] < 3) continue;
          const rx = r % w;
          if (rx - x > 1 || x - rx > 1) continue;
          seen[r] = 1; comp.push(r);
        }
      }
      if (comp.length < 6) continue;
      let t0 = Infinity, vmin = Infinity, vmax = -Infinity, umin = Infinity, umax = -Infinity;
      for (const i of comp) {
        const x = i % w, y = (i / w) | 0, u = x + y, v = x - y;
        t0 = Math.min(t0, T[i]); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); umin = Math.min(umin, u); umax = Math.max(umax, u);
      }
      const rows = Math.max(1, Math.ceil((vmax - vmin + 1) / 4)); // rząd = 4 jednostki v ≈ 2,8 px
      const dur = Math.min(0.08, 0.004 + comp.length / 40000);
      const sf = Math.max(1e-3, (dur / rows) * 0.6), du = Math.max(1, umax - umin);
      for (const i of comp) {
        const x = i % w, y = (i / w) | 0, row = Math.min(rows - 1, Math.floor((x - y - vmin) / 4));
        let a = (x + y - umin) / du;
        if (row & 1) a = 1 - a;
        T[i] = Math.min(TMAX - sf, t0 + 0.01 + (dur * (row + a)) / rows);
        soft[i] = sf;
      }
    }
  }
  return { computeField };
}

export const { computeField } = fieldModule({ END, profileInv });

/** Części harmonogramu: profile prędkości kreski, wykrywanie serii kreskowania, siatka najbliższych zadań. */
import type { Path } from "./trace";

// ── profile prędkości: f(τ) = (1−a)·τ + a·minjerk(τ^g); LUT odwrotności (s/L → τ) ──
export interface Job { paths: number[]; tier: number; ax: number; ay: number; bx: number; by: number; hatch: boolean }
/**
 * Fabryka bez odwołań na zewnątrz (zależności tylko z parametru) — źródło serializowane do Workera
 * (Blob URL, worker.ts) i wołane na wątku głównym (fallback). Nie odwołuj się tu do importów modułu.
 */
export function partsModule() {
  const A_LEVELS = 8;
  const G = [0.72, 1, 1.38], LUT = 256;
  const mj = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);
  function profileF(prof: number, t: number): number {
    const a = Math.floor(prof / 3) / (A_LEVELS - 1), g = G[prof % 3];
    return (1 - a) * t + a * mj(Math.pow(t, g));
  }
  const PROFILE_INV: Float32Array[] = Array.from({ length: A_LEVELS * 3 }, (_, prof) => {
    const inv = new Float32Array(LUT + 1);
    for (let j = 0; j <= LUT; j++) {
      const u = j / LUT;
      let lo = 0, hi = 1;
      for (let it = 0; it < 24; it++) { const mid = (lo + hi) / 2; if (profileF(prof, mid) < u) lo = mid; else hi = mid; }
      inv[j] = (lo + hi) / 2;
    }
    return inv;
  });
  function profileInv(prof: number, u: number): number {
    const inv = PROFILE_INV[prof], x = Math.max(0, Math.min(1, u)) * LUT, i = Math.min(LUT - 1, x | 0), f = x - i;
    return inv[i] + (inv[i + 1] - inv[i]) * f;
  }


  /** Grupy kreskowania: krótkie, proste, równoległe kreski leżące obok siebie (union-find na siatce). */
  function hatchGroups(paths: Path[], diag: number): { g: number[]; structure: boolean }[] {
    const R = Math.max(8, diag * 0.018), maxL = diag * 0.07;
    const n = paths.length, par = new Int32Array(n).map((_, i) => i);
    const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const ux = new Float32Array(n), uy = new Float32Array(n), cx = new Float32Array(n), cy = new Float32Array(n);
    const cand = new Uint8Array(n), grid = new Map<number, number[]>();
    paths.forEach((p, i) => {
      const m = p.xs.length - 1, dx = p.xs[m] - p.xs[0], dy = p.ys[m] - p.ys[0], d = Math.hypot(dx, dy);
      cx[i] = (p.xs[0] + p.xs[m]) / 2; cy[i] = (p.ys[0] + p.ys[m]) / 2;
      if (p.L > maxL || d < 0.86 * p.L || d < 3) return;
      cand[i] = 1; ux[i] = dx / d; uy[i] = dy / d;
      const key = Math.floor(cx[i] / R) * 65536 + Math.floor(cy[i] / R);
      const cell = grid.get(key); if (cell) cell.push(i); else grid.set(key, [i]);
    });
    for (let i = 0; i < n; i++) {
      if (!cand[i]) continue;
      const gx = Math.floor(cx[i] / R), gy = Math.floor(cy[i] / R);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        for (const j of grid.get((gx + ox) * 65536 + gy + oy) ?? []) {
          if (j <= i) continue;
          if (Math.abs(ux[i] * uy[j] - uy[i] * ux[j]) > 0.3) continue;
          const ddx = cx[j] - cx[i], ddy = cy[j] - cy[i];
          const along = Math.abs(ddx * ux[i] + ddy * uy[i]), perp = Math.abs(ddx * uy[i] - ddy * ux[i]);
          if (perp > R || perp < 0.8 || along > 0.45 * (paths[i].L + paths[j].L) / 2 + 2) continue;
          par[find(i)] = find(j);
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) if (cand[i]) { const r = find(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); }
    const out: { g: number[]; structure: boolean }[] = [];
    for (const g of groups.values()) {
      if (g.length < 3) continue;
      const r = g[0], nx = -uy[r], ny = ux[r];
      const proj = (i: number) => cx[i] * nx + cy[i] * ny;
      g.sort((a, b) => proj(a) - proj(b));
      // balustrada/szczeble/schody: rzadkie (odstęp > 4× grubość) albo nierówne długości → struktura (forma),
      // nie cieniowanie — artysta rysuje ją zaraz po bryle, nie na końcu
      const Ls = g.map((i) => paths[i].L).sort((x, y) => x - y), Lmed = Ls[Ls.length >> 1];
      const thick = 2 * g.reduce((sum, i) => sum + paths[i].meanHw, 0) / g.length;
      const spacing = (proj(g[g.length - 1]) - proj(g[0])) / (g.length - 1);
      out.push({ g, structure: spacing > 4 * thick + 2 || Ls[Ls.length - 1] > 2 * Lmed });
    }
    return out;
  }

  /** Siatka końców zadań per warstwa — wyszukiwanie najbliższego pierścieniami (zamiast O(n²)). */
  class JobGrid {
    private cells: number[][][];
    private cs: number;
    private gw: number;
    private gh: number;
    lastDist = 0;
    constructor(private jobs: Job[], w: number, h: number, diag: number, maxTier: number) {
      this.cs = Math.max(8, diag / 28);
      this.gw = Math.ceil(w / this.cs) + 1; this.gh = Math.ceil(h / this.cs) + 1;
      this.cells = Array.from({ length: maxTier + 1 }, () => Array.from({ length: this.gw * this.gh }, () => []));
      jobs.forEach((J, j) => {
        const g = this.cells[J.tier];
        g[this.key(J.ax, J.ay)].push(j);
        const kb = this.key(J.bx, J.by);
        if (kb !== this.key(J.ax, J.ay)) g[kb].push(j);
      });
    }
    private key(x: number, y: number) {
      const cx = Math.max(0, Math.min(this.gw - 1, Math.floor(x / this.cs)));
      const cy = Math.max(0, Math.min(this.gh - 1, Math.floor(y / this.cs)));
      return cy * this.gw + cx;
    }
    nearest(tier: number, px: number, py: number, limit: number, alive: Uint8Array, blocked?: (j: number) => boolean): number {
      const g = this.cells[tier], cs = this.cs;
      const cx = Math.floor(px / cs), cy = Math.floor(py / cs);
      let best = -1, bd = limit;
      const maxR = Math.max(this.gw, this.gh) + 1;
      for (let r = 0; r <= maxR; r++) {
        if ((r - 1) * cs > bd) break;
        for (let y = cy - r; y <= cy + r; y++) {
          if (y < 0 || y >= this.gh) continue;
          const edge = y === cy - r || y === cy + r;
          for (let x = cx - r; x <= cx + r; x += edge ? 1 : 2 * r || 1) {
            if (x < 0 || x >= this.gw) continue;
            const cell = g[y * this.gw + x];
            for (let q = cell.length - 1; q >= 0; q--) {
              const j = cell[q];
              if (!alive[j]) { cell[q] = cell[cell.length - 1]; cell.pop(); continue; }
              if (blocked?.(j)) continue;
              const J = this.jobs[j];
              const d = Math.min(Math.hypot(J.ax - px, J.ay - py), Math.hypot(J.bx - px, J.by - py));
              if (d < bd) { bd = d; best = j; }
            }
          }
        }
      }
      this.lastDist = bd;
      return best;
    }
  }
  return { A_LEVELS, profileF, PROFILE_INV, profileInv, hatchGroups, JobGrid };
}

export const { A_LEVELS, profileF, PROFILE_INV, profileInv, hatchGroups, JobGrid } = partsModule();

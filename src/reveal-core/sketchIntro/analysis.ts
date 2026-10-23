/**
 * Wektoryzacja szkicu na typed arrays (bez DOM): tusz → próg Otsu → transformata odległości → szkielet →
 * ścieżki (+ jasna warstwa kreskowania) → gęstość tuszu wzdłuż ścieżek. Fabryka bez odwołań na zewnątrz —
 * serializowana do Workera (worker.ts); na wątku głównym ta sama funkcja (fallback, flush, harness).
 */
import type { skeletonModule } from "./skeleton";
import type { Path, traceModule } from "./trace";

type Slice = () => Promise<void>;

export function analysisModule(sk: ReturnType<typeof skeletonModule>, tr: ReturnType<typeof traceModule>) {
  const { otsuThreshold, distanceTransform, zhangSuen } = sk;
  const { tracePaths } = tr;

  /** Udział tuszu w oknie (2r+1)² (obraz całkowy). */
  function boxDensity(mask: Uint8Array, w: number, h: number, r: number): Float32Array {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += mask[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
        out[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }

  async function analyzeInk(ink: Uint8Array, aw: number, ah: number, slice: Slice): Promise<Path[]> {
    await slice();
    const thr = otsuThreshold(ink);
    const mask = new Uint8Array(aw * ah);
    for (let i = 0; i < mask.length; i++) mask[i] = ink[i] > thr ? 1 : 0;
    const dt = await distanceTransform(mask, aw, ah, slice);
    const dens = boxDensity(mask, aw, ah, 4);
    // druga, jasna warstwa: delikatne kreskowanie/szkic konstrukcyjny poniżej progu Otsu — też jako kreski
    // (bez tego jasny tusz byłby „zamalowywany” plamami, a granica cięłaby kreski w poprzek)
    const light = new Uint8Array(aw * ah);
    for (let y = 1; y < ah - 1; y++) for (let x = 1; x < aw - 1; x++) {
      const i = y * aw + x;
      if (ink[i] <= 45 || mask[i] || mask[i - 1] || mask[i + 1] || mask[i - aw] || mask[i + aw]) continue;
      light[i] = 1;
    }
    const dtL = await distanceTransform(light, aw, ah, slice);
    await zhangSuen(mask, aw, ah, slice);
    const paths = await tracePaths(mask, dt, aw, ah, slice);
    await zhangSuen(light, aw, ah, slice);
    for (const P of await tracePaths(light, dtL, aw, ah, slice)) { if (P.L >= 3) { P.micro = P.L < 6; paths.push(P); } }
    // gęstość tuszu wzdłuż ścieżek: kręgosłupy plam kreskowania ≠ linie konstrukcyjne
    for (const P of paths) {
      let sum = 0, dense = 0;
      for (let j = 0; j < P.pix.length; j++) { const v = dens[P.pix[j]]; sum += v; if (v > 0.35) dense++; }
      P.dens = sum / P.pix.length; P.denseFrac = dense / P.pix.length;
    }
    return paths;
  }

  return { analyzeInk };
}

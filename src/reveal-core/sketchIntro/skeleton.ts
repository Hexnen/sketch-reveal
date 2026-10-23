/**
 * Rastrowa część wektoryzacji line-artu: tusz → próg (Otsu) → transformata odległości →
 * szkieletyzacja Zhang–Suen → usunięcie „schodków” (szkielet 1 px, 8-spójny).
 * Wszystko na typed arrays, pętle przerywane `slice()` (bez blokowania UI).
 */

type Slice = () => Promise<void>;

/**
 * Fabryka bez odwołań na zewnątrz (zależności tylko z parametru) — źródło serializowane do Workera
 * (Blob URL, worker.ts) i wołane na wątku głównym (fallback). Nie odwołuj się tu do importów modułu.
 */
export function skeletonModule() {
  /** Luminancja → tusz (0 = papier, 255 = czerń). */
  function inkFromRgba(rgba: Uint8ClampedArray, n: number): Uint8Array {
    const ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      ink[i] = 255 - Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);
    }
    return ink;
  }

  /** Próg Otsu liczony tylko na pikselach „niepapierowych”, przycięty do rozsądnego zakresu. */
  function otsuThreshold(ink: Uint8Array): number {
    const hist = new Float64Array(256);
    let total = 0;
    for (let i = 0; i < ink.length; i++) if (ink[i] > 12) { hist[ink[i]]++; total++; }
    if (total < 16) return 110;
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = 0, thr = 110;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = v; }
    }
    return Math.max(70, Math.min(150, thr));
  }

  /** Transformata odległości (chamfer 3-4) do najbliższego piksela tła; wynik w px (półgrubość linii). */
  async function distanceTransform(mask: Uint8Array, w: number, h: number, slice: Slice): Promise<Float32Array> {
    const BIG = 1 << 20;
    const d = new Int32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? BIG : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!d[i]) continue;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 3); else v = Math.min(v, 3);
        if (y > 0) {
          v = Math.min(v, d[i - w] + 3);
          if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
          if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
        } else v = Math.min(v, 3);
        d[i] = v;
      }
      if ((y & 31) === 0) await slice();
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!d[i]) continue;
        let v = d[i];
        if (x < w - 1) v = Math.min(v, d[i + 1] + 3); else v = Math.min(v, 3);
        if (y < h - 1) {
          v = Math.min(v, d[i + w] + 3);
          if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
          if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
        } else v = Math.min(v, 3);
        d[i] = v;
      }
      if ((y & 31) === 0) await slice();
    }
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i] / 3;
    return out;
  }

  /** Szkieletyzacja Zhang–Suen na liście kandydatów (koszt ∝ liczbie pikseli tuszu, nie obrazu). */
  async function zhangSuen(m: Uint8Array, w: number, h: number, slice: Slice): Promise<void> {
    for (let x = 0; x < w; x++) { m[x] = 0; m[(h - 1) * w + x] = 0; }
    for (let y = 0; y < h; y++) { m[y * w] = 0; m[y * w + w - 1] = 0; }
    let list: number[] = [];
    for (let i = 0; i < m.length; i++) if (m[i]) list.push(i);
    const del: number[] = [];
    for (let iter = 0; iter < 200; iter++) {
      let changed = false;
      for (let sub = 0; sub < 2; sub++) {
        del.length = 0;
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (!m[i]) continue;
          const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1];
          const p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) +
            (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
          if (a !== 1) continue;
          if (sub === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
        for (let k = 0; k < del.length; k++) m[del[k]] = 0;
        if (del.length) changed = true;
        await slice();
      }
      if (!changed) break;
      list = list.filter((i) => m[i]);
    }
    // „schodki”: piksel narożny między dwoma sąsiadami 4-spójnymi jest zbędny (8-spójność zostaje)
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      if (!m[i]) continue;
      const n = m[i - w], e = m[i + 1], s = m[i + w], wv = m[i - 1];
      const ne = m[i - w + 1], se = m[i + w + 1], sw = m[i + w - 1], nw = m[i - w - 1];
      if ((n && e && !s && !wv && !sw && !ne) || (e && s && !n && !wv && !nw && !se) ||
          (s && wv && !n && !e && !ne && !sw) || (wv && n && !s && !e && !se && !nw)) m[i] = 0;
    }
  }
  return { inkFromRgba, otsuThreshold, distanceTransform, zhangSuen };
}

export const { inkFromRgba, otsuThreshold, distanceTransform, zhangSuen } = skeletonModule();

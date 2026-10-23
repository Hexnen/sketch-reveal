/**
 * Mapa najbliższego komponentu (K6, tania klatka życia w jakości med/low): dla każdego piksela siatki analizy id
 * komponentu (R tekstury analizy), którego piksel jest najbliżej (BFS wielu źródeł, metryka 8-sąsiedztwa).
 * Poświata/halo piksela idą wtedy za poziomem „swojego” źródła. Liczona raz na analizę (keszowana).
 */
import type { GlowAnalysis } from "./analyze";

const memo = new WeakMap<GlowAnalysis, Uint8Array>();

export function nearestCompMap(an: GlowAnalysis): Uint8Array {
  const hit = memo.get(an);
  if (hit) return hit;
  const { aw, ah, tex } = an, n = aw * ah;
  const out = new Uint8Array(n), q = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) { const id = tex[i * 4]; if (id) { out[i] = id; q[tail++] = i; } }
  while (head < tail) {
    const i = q[head++], x = i % aw, y = (i / aw) | 0, id = out[i];
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= ah) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= aw) continue;
        const j = yy * aw + xx;
        if (!out[j]) { out[j] = id; q[tail++] = j; }
      }
    }
  }
  memo.set(an, out);
  return out;
}

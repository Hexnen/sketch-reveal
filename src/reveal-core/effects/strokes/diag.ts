/** Diagnostyka efektu „strokes” (ST6: alokuje duże tablice — tylko narzędzia, nie produkcja). */
import type { Schedule } from "./schedule";
import { INST_STRIDE, type StrokeSet } from "./strokeGen";

/** Czasy (po warpie), warstwy i pozycje w kolejności listy. */
export function timelineOf(set: StrokeSet, sched: Schedule) {
  const n = set.count;
  const layer = new Uint8Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const ang = new Float32Array(n); // kąt osi start→koniec od poziomu, 0..90°
  // Warstwa po promieniu (lista posortowana — mapujemy przez R najbliższe warstwie).
  for (let r = 0; r < n; r++) {
    const o = r * INST_STRIDE;
    const off = sched.inst[o];
    const np = sched.inst[o + 1];
    const q = (off + Math.floor(np / 2)) * 2;
    x[r] = set.points[q] / set.w;
    y[r] = set.points[q + 1] / set.h;
    const qa = off * 2;
    const qb = (off + np - 1) * 2;
    ang[r] = (Math.atan2(Math.abs(set.points[qb + 1] - set.points[qa + 1]), Math.abs(set.points[qb] - set.points[qa])) * 180) / Math.PI;
    const lod = sched.inst[o + 11];
    const R = sched.inst[o + 2];
    let best = 0;
    for (let k = 1; k < set.layerRadius.length; k++) {
      if (Math.abs(Math.log(set.layerRadius[k] / R)) < Math.abs(Math.log(set.layerRadius[best] / R))) best = k;
    }
    layer[r] = lod > 0 ? set.layerRadius.length - 1 : best;
  }
  return { starts: sched.starts, ends: sched.ends, layer, x, y, ang };
}

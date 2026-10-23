/**
 * Rodzaje źródeł we wnętrzach (2026-10-22, „Wnętrza i ekrany”): lampki LED, świetliki/okna dzienne, ekrany.
 *  - LED: mały (≤ 0,008% kadru), nasycony, jasny punkt na ciemnym tle (obwódka bez maski ciemniejsza o ≥ 0,3 V);
 *    w grupie (≥ 2 inne w 5% przekątnej — szafa serwerowa, pulpit) albo bardzo wyraźny. Etap „surowy” (po pewności).
 *  - Świetlik: achromatyczna (c90 < 0,3), przepalona, zwarta plama w górnych 60% kadru, wyraźnie jaśniejsza od
 *    obwódki, z namalowaną poświatą. Etap „surowy”.
 *  - Ekran: oprawa neonowa (nie ciepła) ≥ 0,2% kadru, której obrys jest w większości jasny (treść ekranu), wyraźnie
 *    jaśniejsza od otoczenia i barwna. Etap oprawy: dzielona na panele (duże komponenty = osobne ekrany), wchłania
 *    słabsze kawałki tej samej barwy w obrysie (ciemniejsze fragmenty treści).
 * Wszystko tylko nocą/we wnętrzu (scene.day < 0,5) — w dzień nie dodaje źródeł.
 */
import { legacyHueDiff, legacyHueOf, type LegacyPlanes, type LegacyRaw } from "./analyzeLegacyFeatures";
import { ss, type LegacyDetectOptions } from "./analyzeLegacyOpts";
import type { SceneKey } from "./analyzeOpts";
import { KIND_NEON, KIND_SCREEN, type Comp, type Fixture } from "./analyzeTypes";

const LED_MAX = 0.00008, LED_WARM_MAX = 0.00003, LED_CAP = 64;
const SKY_MIN = 0.0008;
const SCREEN_MIN = 0.0025, PANEL_SEED = 0.0012, SCREEN_TX = 0.1, SCREEN_SAT = 0.5;

/** Średnia V, Y i barwa (sRGB) pikseli bez maski w pierścieniu wokół obrysu (bbox ± pad). */
function rim(rw: LegacyRaw, P: LegacyPlanes, lab: Int32Array, pad: number): { v: number; y: number; hue: number; sat: number; lit: number } {
  const { V, Y, px, aw, ah } = P;
  let sv = 0, sy = 0, n = 0, cr = 0, cg = 0, cb = 0, lit = 0;
  const x0 = Math.max(0, rw.x0 - pad), x1 = Math.min(aw - 1, rw.x1 + pad), y0 = Math.max(0, rw.y0 - pad), y1 = Math.min(ah - 1, rw.y1 + pad);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (x >= rw.x0 && x <= rw.x1 && y >= rw.y0 && y <= rw.y1) continue;
    const i = y * aw + x; if (lab[i]) continue;
    sv += V[i]; sy += Y[i]; n++; if (V[i] > 0.5) lit++; cr += px[i * 4]; cg += px[i * 4 + 1]; cb += px[i * 4 + 2];
  }
  const mx = Math.max(cr, cg, cb);
  return n ? { v: sv / n, y: sy / n, hue: legacyHueOf(cr, cg, cb), sat: mx > 0 ? 1 - Math.min(cr, cg, cb) / mx : 0, lit: lit / n } : { v: 1, y: 1, hue: 0, sat: 0, lit: 1 };
}

const ctr = (r: LegacyRaw) => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];

/** LED i świetliki wśród komponentów, które nie są pewnymi emiterami (conf < 0,15). */
export function markLegacyInterior(raws: LegacyRaw[], lab: Int32Array, P: LegacyPlanes, k: number, diagA: number, scene: SceneKey, o: LegacyDetectOptions) {
  if (scene.day >= 0.5) return;
  const N = P.aw * P.ah, night = 1 - ss(0.25, 0.5, scene.day);
  const free = (r: LegacyRaw) => r.cls === 1 && !r.drop && r.conf < 0.15 && !r.pskin;
  const bigNeon = raws.filter((r) => r.cls === 1 && !r.drop && !r.warm && r.conf >= 0.5 && r.area > 0.002 * N);
  const inBig = (r: LegacyRaw) => { const [x, y] = ctr(r), m = 0.02 * diagA; return bigNeon.some((a) => x >= a.x0 - m && x <= a.x1 + m && y >= a.y0 - m && y <= a.y1 + m); };
  if (o.leds) {
    // iskry/drobinki przy pewnym, dużym neonie (VS) to część jego efektu, nie lampki
    const nearNeon = (r: LegacyRaw) => bigNeon.some((a) => Math.hypot(Math.max(0, Math.max(a.x0, r.x0) - Math.min(a.x1, r.x1)), Math.max(0, Math.max(a.y0, r.y0) - Math.min(a.y1, r.y1))) <= 0.06 * diagA);
    const cand: { r: LegacyRaw; s: number; c: number }[] = [];
    for (const r of raws) {
      if (!free(r) || r.area < 2 || r.area > LED_MAX * N || r.maxV < 0.6 || r.sat < 0.1) continue;
      if (r.warm && (r.sat < 0.75 || r.area > LED_WARM_MAX * N)) continue; // świeca/okno ≠ LED
      const rm = rim(r, P, lab, 2), c = r.maxV - rm.v;
      // ciemna obudowa (V ≤ 0,3) i wyraźny punkt; skóra/różowe kropki tylko na bardzo ciemnym tle
      // …w CAŁOŚCI ciemnej obudowie (≤ 20% jasnych pikseli obwódki: nie brzeg jasnej płaszczyzny) i zwarty (nie kreska)
      const bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1;
      if (rm.v > 0.3 || c < 0.4 || rm.lit > 0.2 || (r.area >= 4 && (bw > 2.5 * bh || bh > 2.5 * bw))) continue;
      // blada dioda (sat 0,1–0,4): tylko w bardzo ciemnej obudowie (V ≤ 0,2, zero jasnych pikseli) i bardzo wyraźna;
      // barwy obwódki nie porównujemy — namalowana poświata diody barwi ją na kolor diody
      if (r.sat < 0.4 && (rm.v > 0.2 || rm.lit > 0 || c < 0.5)) continue;
      if ((r.hue >= 330 || r.hue <= 35) && r.sat < 0.75 && rm.v > 0.2) continue;
      if (nearNeon(r)) continue;
      cand.push({ r, s: ss(0.4, 0.6, c) * ss(0.1, 0.4, r.sat), c });
    }
    const R = 0.05 * diagA;
    const ok = cand.filter((a) => {
      const [ax, ay] = ctr(a.r);
      const near = cand.filter((b) => b !== a && Math.hypot(ctr(b.r)[0] - ax, ctr(b.r)[1] - ay) <= R).length;
      return near >= 2 || (a.s >= 0.9 && a.c >= 0.5 && a.r.sat >= 0.7);
    }).sort((a, b) => b.s - a.s).slice(0, LED_CAP);
    for (const a of ok) {
      const c = Math.min(0.49, 0.5 * (0.6 + 0.4 * a.s)) * night;
      if (c < 0.15) continue;
      a.r.conf = c; a.r.led = true; a.r.note = "led";
    }
  }
  if (o.skylights) {
    for (const r of raws) {
      if (!free(r) || r.led || r.c90 >= 0.3 || r.p95 < 0.95 || r.coreSat < 0.2 * r.area) continue;
      if (r.area < SKY_MIN * N || r.area > o.maxCompFrac * N || ctr(r)[1] > 0.6 * P.ah) continue;
      if (inBig(r)) continue; // biała treść ekranu (wideo) to nie świetlik
      const bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1;
      if (r.area / (bw * bh) < 0.35) continue;
      const rm = rim(r, P, lab, Math.max(3, Math.round(4 * k))), c = r.sY / r.area - rm.y;
      const sc = 0.45 * ss(1.1, 1.3, r.fall) * ss(0.3, 0.45, c) * night;
      if (sc >= 0.15 && sc > r.conf) { r.conf = sc; r.sky = true; r.white = false; r.warm = false; r.note = "świetlik"; }
    }
  }
}

/** Cechy obrysu oprawy: udział jasnych pikseli (V ≥ 0,35) w bbox, średnie V w bbox i w obwódce. */
function boxStats(P: LegacyPlanes, x0: number, y0: number, x1: number, y1: number) {
  const { V, aw, ah } = P;
  let n = 0, br = 0, sv = 0, rv = 0, rn = 0, tx = 0;
  const pad = Math.max(3, Math.round(0.15 * Math.min(x1 - x0, y1 - y0)));
  for (let y = Math.max(0, y0 - pad); y <= Math.min(ah - 1, y1 + pad); y++)
    for (let x = Math.max(0, x0 - pad); x <= Math.min(aw - 1, x1 + pad); x++) {
      const v = V[y * aw + x];
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        n++; sv += v; if (v >= 0.35) br++;
        if (x < x1 && y < y1) tx += Math.abs(V[y * aw + x + 1] - v) + Math.abs(V[(y + 1) * aw + x] - v);
      } else { rv += v; rn++; }
    }
  // tx = treść: średni gradient V w obrysie (mapa/wykresy ekranu ≫ jednolita tafla szyldu)
  return { bright: n ? br / n : 0, inV: n ? sv / n : 0, rimV: rn ? rv / rn : 0, tx: n ? tx / n : 0 };
}

const satOf = (c: number[]) => { const m = Math.max(...c); return m > 0 ? 1 - Math.min(...c) / m : 0; };

/**
 * Ekrany: oprawy neonowe spełniające warunki ekranu → rodzaj KIND_SCREEN, podział na panele, wchłonięcie słabszych
 * kawałków treści. `mkComp(raw, fixture, conf)` tworzy komponent (id tekstury). Zwraca indeksy wchłoniętych surowych.
 */
export function classifyLegacyScreens(fixtures: Fixture[], comps: Comp[], raws: LegacyRaw[], P: LegacyPlanes, diagA: number, scene: SceneKey,
  o: LegacyDetectOptions, eff: number[], mkComp: (i: number, fx: number, conf: number) => number) {
  if (!o.screens || scene.day >= 0.5) return;
  const { aw, ah } = P, N = aw * ah;
  const bbox = (ms: number[]) => {
    let x0 = aw, y0 = ah, x1 = 0, y1 = 0, a = 0;
    for (const ci of ms) { const r = raws[comps[ci].raw]; x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); a += r.area; }
    return { x0, y0, x1, y1, a };
  };
  const nFix = fixtures.length;
  for (let fi = 0; fi < nFix; fi++) {
    const f = fixtures[fi];
    if (f.kind !== KIND_NEON || f.disc || f.members.some((ci) => raws[comps[ci].raw].led || raws[comps[ci].raw].sky)) continue;
    const b = bbox(f.members);
    if (b.a < SCREEN_MIN * N || satOf(f.color) < SCREEN_SAT) continue;
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    if (bw / bh > 6 || bh / bw > 4) continue;
    const st = boxStats(P, b.x0, b.y0, b.x1, b.y1);
    if (st.bright < 0.5 || st.inV - st.rimV < 0.12 || st.tx < SCREEN_TX) continue;
    // wchłoń słabsze kawałki tej samej barwy w obrysie (ciemniejsza treść ekranu — także cały ekran, którego żaden
    // kawałek nie był pewny), zanim oprawa zostanie podzielona na panele
    const mx = 0.02 * diagA, fh = legacyHueOf(f.color[0], f.color[1], f.color[2]);
    for (let i = 0; i < raws.length; i++) {
      const r = raws[i];
      if (r.cls !== 1 || r.drop || eff[i] >= 0.15 || r.warm || r.led || r.sky || r.p95 < 0.8 || r.c90 < 0.25 || legacyHueDiff(r.hue, fh) > 30) continue;
      const [cx, cy] = ctr(r);
      if (cx < b.x0 - mx || cx > b.x1 + mx || cy < b.y0 - mx || cy > b.y1 + mx || comps.length >= 200) continue;
      eff[i] = Math.max(0.15, 0.6 * f.conf); r.note = "ekran";
      f.members.push(mkComp(i, fi, eff[i]));
    }
    // panele: duże komponenty to osobne ekrany; reszta członków do najbliższego panelu
    const seeds = f.members.filter((ci) => comps[ci].area >= PANEL_SEED * N);
    if (!seeds.length) seeds.push(f.members.reduce((a, c) => (comps[c].area > comps[a].area ? c : a)));
    const groups = new Map<number, number[]>(seeds.map((sd) => [sd, [sd]]));
    const gapOf = (a: LegacyRaw, c: LegacyRaw) => Math.hypot(Math.max(0, Math.max(a.x0, c.x0) - Math.min(a.x1, c.x1)), Math.max(0, Math.max(a.y0, c.y0) - Math.min(a.y1, c.y1)));
    for (const ci of f.members) {
      if (groups.has(ci)) continue;
      let best = seeds[0], bd = Infinity;
      for (const sd of seeds) { const d = gapOf(raws[comps[ci].raw], raws[comps[sd].raw]); if (d < bd) { bd = d; best = sd; } }
      groups.get(best)!.push(ci);
    }
    let first = true;
    for (const ms of groups.values()) {
      const tgt = first ? fi : fixtures.length;
      if (!first) fixtures.push({ ...f, members: [], parent: -1, gain: 1 });
      first = false;
      const F = fixtures[tgt];
      F.kind = KIND_SCREEN; F.members = ms;
      for (const ci of ms) comps[ci].fixture = tgt;
      const q = bbox(ms);
      F.box = [q.x0 / aw, q.y0 / ah, (q.x1 + 1) / aw, (q.y1 + 1) / ah];
      F.cx = (F.box[0] + F.box[2]) / 2; F.cy = (F.box[1] + F.box[3]) / 2; F.r = 0.5 * Math.max((F.box[2] - F.box[0]) * aw / ah, F.box[3] - F.box[1]);
      F.conf = Math.max(...ms.map((ci) => comps[ci].conf)); F.bright = Math.max(...ms.map((ci) => comps[ci].bright));
    }
  }
}

/**
 * Oprawy z komponentów (detekcja świateł, krok 2): grupowanie liter neonu, rodzaj (neon / okno / latarnia /
 * tarcza), odbicia, „oświetlone” łaty, tekstura id dla shadera.
 */
import type { Comp, Fixture, GlowAnalysis } from "./analyzeTypes";
import { KIND_LAMP, KIND_LED, KIND_LIT, KIND_NEON, KIND_SKY, KIND_WINDOW } from "./analyzeTypes";
import { legacyHueDiff, legacyHueOf, type LegacyPlanes, type LegacyRaw } from "./analyzeLegacyFeatures";
import { classifyLegacyScreens } from "./analyzeLegacyKinds";
import { ss, type LegacyDetectOptions } from "./analyzeLegacyOpts";
import type { SceneKey } from "./analyzeOpts";

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export async function buildLegacyFixtures(raws: LegacyRaw[], lab: Int32Array, M: Float32Array, P: LegacyPlanes, diagA: number, k: number,
  t0: number, slice: () => Promise<void>, o: LegacyDetectOptions, scene: SceneKey): Promise<GlowAnalysis> {
  const { aw, ah } = P, N = aw * ah;
  const isDisc = (r: LegacyRaw) => r.cls === 2;
  // kandydaci do opraw: ciepłe od 0,1 (żeby oświetlone łaty przy latarni nie stawały się emiterami), neonowe od 0,02
  // (niebieska rama neonu jest ciemniejsza niż litery — dołącza do oprawy, gdy leży tuż przy niej). Tarcze osobno.
  const minC = (r: LegacyRaw) => (r.warm ? 0.1 : 0.02);
  const cand = raws.map((_, i) => i).filter((i) => !isDisc(raws[i]) && !raws[i].drop && raws[i].conf >= minC(raws[i]));
  const par = raws.map((_, i) => i);
  const find = (i: number): number => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
  const gap = 0.022 * diagA;
  const gapOf = (A: LegacyRaw, B: LegacyRaw) => Math.hypot(Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1)), Math.max(0, Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1)));
  // 1) silne komponenty: blisko i zgodna barwa → jedna oprawa (litery neonu)
  const strong = cand.filter((i) => raws[i].conf >= 0.15), weak = cand.filter((i) => raws[i].conf < 0.15);
  for (let a = 0; a < strong.length; a++) for (let b = a + 1; b < strong.length; b++) {
    const A = raws[strong[a]], B = raws[strong[b]];
    // LED: lampki jednej szafy/pulpitu razem bez warunku barwy; świetliki i LED nie łączą się z innymi rodzajami
    if (A.led !== B.led || A.sky !== B.sky) continue;
    if (A.led ? gapOf(A, B) > 0.035 * diagA : A.sky ? gapOf(A, B) > gap : gapOf(A, B) > gap || A.warm !== B.warm || legacyHueDiff(A.hue, B.hue) > 40) continue;
    par[find(strong[a])] = find(strong[b]);
  }
  // 2) słabe dołączają do NAJBLIŻSZEGO silnego (neon: bez warunku barwy — rama innego koloru niż litery), nie scalając opraw
  for (const i of weak) {
    const A = raws[i]; let best = -1, bd = gap;
    for (const j of strong) {
      const B = raws[j];
      if (B.led || B.sky || A.warm !== B.warm || (A.warm && legacyHueDiff(A.hue, B.hue) > 40)) continue;
      const d = gapOf(A, B); if (d <= bd) { bd = d; best = j; }
    }
    if (best >= 0) par[i] = find(best);
  }
  const fixMax = new Map<number, number>();
  for (const i of cand) fixMax.set(find(i), Math.max(fixMax.get(find(i)) ?? 0, raws[i].conf));
  const eff: number[] = raws.map((rw, i) => (isDisc(rw) ? rw.conf : !rw.drop && rw.conf >= minC(rw) ? Math.max(rw.conf, 0.85 * (fixMax.get(find(i)) ?? 0)) : rw.conf));

  const comps: Comp[] = [{ fixture: -1, conf: 0, cx: 0, cy: 0, r: 0, color: [0, 0, 0], bright: 0, area: 0, raw: -1 }];
  const fixtures: Fixture[] = [];
  const idOf = new Int32Array(raws.length + 1);
  const fixOfRoot = new Map<number, number>();
  const mkComp = (i: number, fx: number, conf: number): number => {
    const rw = raws[i];
    const cx = rw.coreN ? rw.coreX / rw.coreN : (rw.x0 + rw.x1) / 2, cy = rw.coreN ? rw.coreY / rw.coreN : (rw.y0 + rw.y1) / 2;
    const cl: [number, number, number] = rw.cn ? [lin(rw.cr / rw.cn / 255), lin(rw.cg / rw.cn / 255), lin(rw.cb / rw.cn / 255)] : [1, 1, 1];
    const m = Math.max(1e-4, ...cl);
    comps.push({ fixture: fx, conf, cx: (cx + 0.5) / aw, cy: (cy + 0.5) / ah, r: (0.5 * Math.max(rw.x1 - rw.x0, rw.y1 - rw.y0) + 1) / ah,
      color: [cl[0] / m, cl[1] / m, cl[2] / m], bright: rw.p95, area: rw.area, raw: i });
    idOf[i + 1] = comps.length - 1;
    return comps.length - 1;
  };
  // emitery (od najważniejszych), max 254 komponentów razem z oświetlonymi
  const emit = raws.map((_, i) => i).filter((i) => !raws[i].drop && eff[i] >= 0.15).sort((a, b) => eff[b] * raws[b].area - eff[a] * raws[a].area);
  for (const i of emit) {
    if (comps.length >= 200) break;
    const root = isDisc(raws[i]) ? -1 - i : find(i);
    let fx = fixOfRoot.get(root);
    if (fx === undefined) {
      fx = fixtures.length; fixOfRoot.set(root, fx);
      fixtures.push({ kind: KIND_NEON, members: [], conf: 0, bright: 0, cx: 0, cy: 0, r: 0, color: [1, 1, 1], parent: -1, gain: 1 });
    }
    fixtures[fx].members.push(mkComp(i, fx, eff[i]));
  }
  // latarnia bez białego żaru (jednolicie przepalona, ciepła) tylko gdy takich kandydatów jest mało — fasada z wieloma
  // zapalonymi oknami to okna, nie latarnie
  const plainHot = fixtures.filter((f) => !raws[comps[f.members[0]].raw].led && !raws[comps[f.members[0]].raw].sky && f.members.every((ci) => raws[comps[ci].raw].coreSat < 2 * k * k) && f.members.some((ci) => comps[ci].bright >= 0.96)).length;
  for (const f of fixtures) {
    let wsum = 0, cx = 0, cy = 0, x0 = 1, x1 = 0, y0 = 1, y1 = 0; const col = [0, 0, 0];
    let big = comps[f.members[0]];
    for (const ci of f.members) {
      const cp = comps[ci], wt = cp.area * cp.conf;
      wsum += wt; cx += cp.cx * wt; cy += cp.cy * wt;
      for (let q = 0; q < 3; q++) col[q] += cp.color[q] * wt;
      f.conf = Math.max(f.conf, cp.conf); f.bright = Math.max(f.bright, cp.bright);
      x0 = Math.min(x0, cp.cx - cp.r * ah / aw); x1 = Math.max(x1, cp.cx + cp.r * ah / aw);
      y0 = Math.min(y0, cp.cy - cp.r); y1 = Math.max(y1, cp.cy + cp.r);
      if (cp.area > big.area) big = cp;
    }
    const m = Math.max(1e-4, ...col);
    f.color = [col[0] / m, col[1] / m, col[2] / m];
    f.cx = cx / wsum; f.cy = cy / wsum; f.r = 0.5 * Math.max((x1 - x0) * aw / ah, y1 - y0);
    const rw = raws[big.raw];
    // tarcza (słońce/księżyc): łagodne narastanie jak okno, bez stuknięć i bez halo latarni
    if (isDisc(rw)) { f.kind = KIND_WINDOW; f.disc = true; continue; }
    if (rw.led) { f.kind = KIND_LED; continue; }
    if (rw.sky) { f.kind = KIND_SKY; continue; }
    const warm = rw ? rw.warm : true;
    // latarnia: ciepła/biała oprawa z „białym żarem” (V ≥ 0,97 i mało nasycony) w którymkolwiek członku
    let hot = -1;
    for (const ci of f.members) { const r = raws[comps[ci].raw]; if (r.maxV >= 0.97 && r.coreSat >= 2 * k * k && (hot < 0 || r.coreSat > raws[comps[hot].raw].coreSat)) hot = ci; }
    const fArea = f.members.reduce((s, ci) => s + comps[ci].area, 0);
    if (hot < 0 && f.bright >= 0.96 && plainHot <= 4) hot = big.raw >= 0 ? comps.indexOf(big) : -1;
    const lamp = warm && !rw.white && hot >= 0 && fArea >= 150 * k * k && f.conf >= 0.5;
    f.kind = !warm ? KIND_NEON : lamp ? KIND_LAMP : KIND_WINDOW;
    if (lamp) { const H = comps[hot], r = raws[H.raw]; f.cx = H.cx; f.cy = H.cy; f.color = H.color; f.r = Math.max(Math.sqrt(r.coreSat / Math.PI), 2) / ah; }
  }
  // ekrany: oprawy neonowe o jasnym obrysie z treścią → panele (analyzeKinds.ts)
  classifyLegacyScreens(fixtures, comps, raws, P, diagA, scene, o, eff, mkComp);
  // odbicia: słaba „oprawa” pod silną o zgodnej barwie (kałuża pod neonem/latarnią) → oświetlona, zapala się z nią
  for (let a = 0; a < fixtures.length; a++) {
    const f = fixtures[a]; if (f.conf >= 0.35 || f.disc || f.kind > KIND_LIT) continue;
    let best = -1, bd = 1e9;
    for (let b = 0; b < fixtures.length; b++) {
      const g = fixtures[b]; if (b === a || g.disc || g.conf < 0.5 || g.kind >= KIND_LIT || g.cy >= f.cy) continue;
      if ((g.kind === KIND_NEON) !== (f.kind === KIND_NEON)) continue;
      const dx = Math.abs(f.cx - g.cx) * aw / diagA, dy = (f.cy - g.cy) * ah / diagA;
      if (dx > 0.08 || dy > 0.3) continue;
      if (dx + 0.3 * dy < bd) { bd = dx + 0.3 * dy; best = b; }
    }
    if (best >= 0) { f.kind = KIND_LIT; f.parent = best; f.gain = 0.6; }
  }
  await slice();
  // oświetlone: nie-emitery przy zgodnym barwowo źródle; każda łata ≤ maxCompFrac, razem ≤ maxLitFrac kadru
  const nEmit = fixtures.length;
  const lit = raws.map((_, i) => i).filter((i) => !raws[i].drop && !isDisc(raws[i]) && eff[i] < 0.15 && raws[i].area >= 10 * k * k && raws[i].area <= o.maxCompFrac * N)
    .sort((a, b) => raws[b].area - raws[a].area);
  const dmax = 0.2;
  let litArea = 0;
  for (const i of lit) {
    if (comps.length >= 255) break;
    const rw = raws[i];
    if (litArea + rw.area > o.maxLitFrac * N) continue;
    const cx = (rw.x0 + rw.x1 + 1) / 2 / aw, cy = (rw.y0 + rw.y1 + 1) / 2 / ah;
    let best = -1, bd = 1e9;
    for (let f = 0; f < nEmit; f++) {
      const F = fixtures[f];
      if (F.kind === KIND_LIT || F.kind === KIND_LED || F.disc) continue;
      const d = Math.max(0, Math.hypot((cx - F.cx) * aw / diagA, (cy - F.cy) * ah / diagA) - F.r * ah / diagA);
      const fh = legacyHueOf(F.color[0], F.color[1], F.color[2]);
      const compat = rw.c90 < 0.12 ? F.kind !== KIND_NEON : legacyHueDiff(rw.hue, fh) <= 40 || (rw.warm && F.kind !== KIND_NEON);
      if (compat && d < bd) { bd = d; best = f; }
    }
    if (best < 0 || bd > dmax) continue;
    litArea += rw.area;
    const fx = fixtures.length;
    fixtures.push({ kind: KIND_LIT, members: [], conf: 0, bright: rw.p95, cx, cy, r: 0, color: [1, 1, 1], parent: best,
      gain: 0.55 * (1 - bd / dmax) * ss(0.45, 0.85, rw.p95) });
    fixtures[fx].members.push(mkComp(i, fx, 0));
  }
  // tekstura: R = id (poszerzone o 2 px), G = lokalna średnia
  let ids = new Uint8Array(N);
  for (let i = 0; i < N; i++) ids[i] = lab[i] ? idOf[lab[i]] : 0;
  for (let it = 0; it < 2; it++) {
    const nx = ids.slice();
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      const i = y * aw + x; if (ids[i]) continue;
      const v = (x > 0 && ids[i - 1]) || (x < aw - 1 && ids[i + 1]) || (y > 0 && ids[i - aw]) || (y < ah - 1 && ids[i + aw]) || 0;
      if (v) nx[i] = v;
    }
    ids = nx;
  }
  const tex = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    tex[i * 4] = ids[i]; tex[i * 4 + 1] = Math.round(Math.min(1, M[i]) * 255); tex[i * 4 + 3] = 255;
  }
  const dbg = (r: LegacyRaw) => ({
    x: Math.round((r.x0 + r.x1) / 2 / aw * 1000) / 1000, y: Math.round((r.y0 + r.y1) / 2 / ah * 1000) / 1000, area: r.area,
    p95: +r.p95.toFixed(2), c90: +r.c90.toFixed(2), hue: Math.round(r.hue), sat: +r.sat.toFixed(2), fall: +r.fall.toFixed(2),
    conf: +r.conf.toFixed(2), coreSat: r.coreSat, note: r.note });
  const byArea = [...raws].sort((a, b) => b.area - a.area).slice(0, 40);
  const byConf = raws.filter((r) => r.conf >= 0.1 && !byArea.includes(r)).sort((a, b) => b.conf - a.conf).slice(0, 30);
  const debug = [...byArea, ...byConf].map(dbg);
  return { aw, ah, tex, comps, fixtures, ms: performance.now() - t0, debug, scene };
}

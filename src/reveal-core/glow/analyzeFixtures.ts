/**
 * Detektor adaptacyjny — oprawy (krok 6): klasteryzacja wybranych blobów zależna od ich skali, rodzaj oprawy
 * z głosowania modelu, odbicia, „oświetlone” łaty i tekstura id dla shadera.
 *
 *  - Łączenie: dwa pewne bloby (p ≥ θ) tego samego rodzaju łączą się, gdy odstęp ich obrysów ≤ γ × promień
 *    równoważny większego (LED: γ_LED — diody szafy leżą w odstępach wielu własnych średnic) i — dla neonów,
 *    okien, latarń — mają zgodną chromatyczność (temperatura/odcień ±0,25). Tarcze nigdy się nie łączą.
 *    Słabe bloby (θ_join ≤ p < θ) dołączają do najbliższej zgodnej oprawy, nie tworzą własnych.
 *  - Rodzaj oprawy = argmax Σ (powierzchnia · p · rozkład rodzajów członków).
 *  - Oświetlone: węzły drzewa bez wybranego emitera (albo z resztą pikseli wokół niego), mieszczące się w limicie
 *    łaty — od korzeni w dół; przy zgodnym barwowo emiterze (≤ 20% przekątnej) rozjaśniają się razem z nim.
 */
import type { Comp, Fixture, GlowAnalysis } from "./analyzeTypes";
import { KIND_LAMP, KIND_LED, KIND_LIT, KIND_NEON, KIND_SCREEN, KIND_SKY, KIND_WINDOW } from "./analyzeTypes";
import { MK_DISC, MK_LAMP, MK_LED, MK_NEON, MK_SCREEN, MK_WINDOW, type DetectorWeights } from "./analyzeModel";
import { ss, type GlowDetectOptions, type SceneKey } from "./analyzeOpts";
import type { Planes } from "./analyzePlanes";
import { hueDiff, hueOf, type Node, type Tree } from "./analyzeTree";

const RENDER_KIND = [KIND_NEON, KIND_WINDOW, KIND_LAMP, KIND_WINDOW, KIND_SCREEN, KIND_LED, KIND_SKY];
const family = (k: number) => (k === MK_WINDOW || k === MK_LAMP ? 1 : k === MK_NEON || k === MK_SCREEN ? 2 : 10 + k);

const gapOf = (A: Node, B: Node) => Math.hypot(Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1)), Math.max(0, Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1)));
const chromaOk = (A: Node, B: Node) => Math.abs(A.temp - B.temp) <= 0.25 && Math.abs(A.tint - B.tint) <= 0.25;

export async function buildFixtures(sel: Node[], tree: Tree, P: Planes, W: DetectorWeights, o: GlowDetectOptions,
  scene: SceneKey, t0: number, slice: () => Promise<void>): Promise<GlowAnalysis> {
  const { aw, ah, M } = P, N = aw * ah, diagA = Math.hypot(aw, ah), k = diagA / 1173;
  const strong = sel.filter((n) => n.prob >= W.theta).sort((a, b) => b.prob * b.area - a.prob * a.area).slice(0, 200);
  const weak = sel.filter((n) => n.prob < W.theta);
  const par = strong.map((_, i) => i);
  const find = (i: number): number => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
  for (let a = 0; a < strong.length; a++) for (let b = a + 1; b < strong.length; b++) {
    const A = strong[a], B = strong[b];
    if (A.kind !== B.kind || A.kind === MK_DISC) continue;
    const g = A.kind === MK_LED ? W.gammaLed : W.gamma;
    if (gapOf(A, B) > g * Math.max(A.req, B.req) + 1) continue;
    if (A.kind !== MK_LED && A.kind !== MK_SCREEN && !chromaOk(A, B)) continue;
    par[find(a)] = find(b);
  }
  const groups = new Map<number, Node[]>();
  strong.forEach((n, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(n); else groups.set(r, [n]); });
  const fixNodes = [...groups.values()];
  let nMem = strong.length;
  for (const n of weak) {
    if (nMem >= 200) break;
    let best = -1, bd = Infinity;
    for (let f = 0; f < fixNodes.length; f++) for (const m of fixNodes[f]) {
      if (family(m.kind) !== family(n.kind) || m.kind === MK_DISC || m.kind === MK_LED) continue;
      const d = gapOf(n, m);
      if (d <= W.gamma * Math.max(n.req, m.req) + 1 && d < bd) { bd = d; best = f; }
    }
    if (best >= 0 && fixNodes[best].length < 40) { fixNodes[best].push(n); nMem++; }
  }

  const comps: Comp[] = [{ fixture: -1, conf: 0, cx: 0, cy: 0, r: 0, color: [0, 0, 0], bright: 0, area: 0, raw: -1 }];
  const fixtures: Fixture[] = [];
  const compOf = new Int32Array(tree.nodes.length).fill(-1), litOf = new Int32Array(tree.nodes.length).fill(-1);
  const mkComp = (n: Node, fx: number, conf: number) => {
    comps.push({ fixture: fx, conf, cx: (n.cx + 0.5) / aw, cy: (n.cy + 0.5) / ah, r: (0.5 * Math.max(n.x1 - n.x0, n.y1 - n.y0) + 1) / ah,
      color: n.color, bright: n.p95, area: n.area, raw: n.id });
    compOf[n.id] = comps.length - 1;
    return comps.length - 1;
  };
  for (const ms of fixNodes) {
    const fx = fixtures.length;
    const vote = new Float32Array(7);
    for (const n of ms) for (let q = 0; q < 7; q++) vote[q] += n.area * n.prob * n.kindP[q];
    let mk = 0;
    for (let q = 1; q < 7; q++) if (vote[q] > vote[mk]) mk = q;
    const f: Fixture = { kind: RENDER_KIND[mk], members: [], conf: 0, bright: 0, cx: 0, cy: 0, r: 0, color: [1, 1, 1], parent: -1, gain: 1, source: "auto" };
    if (mk === MK_DISC) f.disc = true;
    fixtures.push(f);
    let wsum = 0, cx = 0, cy = 0, x0 = aw, x1 = 0, y0 = ah, y1 = 0; const col = [0, 0, 0];
    let hot: Node | null = null;
    for (const n of ms) {
      const ci = mkComp(n, fx, n.prob), wt = n.area * n.prob;
      f.members.push(ci);
      wsum += wt; cx += comps[ci].cx * wt; cy += comps[ci].cy * wt;
      for (let q = 0; q < 3; q++) col[q] += n.color[q] * wt;
      f.conf = Math.max(f.conf, n.prob); f.bright = Math.max(f.bright, n.p95);
      x0 = Math.min(x0, n.x0); x1 = Math.max(x1, n.x1); y0 = Math.min(y0, n.y0); y1 = Math.max(y1, n.y1);
      if (n.white > 0 && (!hot || n.white > hot.white)) hot = n;
    }
    const m = Math.max(1e-4, ...col);
    f.color = [col[0] / m, col[1] / m, col[2] / m];
    f.cx = cx / wsum; f.cy = cy / wsum; f.r = 0.5 * Math.max((x1 - x0 + 1) / ah, (y1 - y0 + 1) / ah);
    if (mk === MK_SCREEN) f.box = [x0 / aw, y0 / ah, (x1 + 1) / aw, (y1 + 1) / ah];
    // latarnia: środek i promień halo w najbielszym rdzeniu (żarnik)
    if (mk === MK_LAMP && hot) { f.cx = (hot.cx + 0.5) / aw; f.cy = (hot.cy + 0.5) / ah; f.color = hot.color; f.r = Math.max(Math.sqrt(hot.white / Math.PI), 2) / ah; }
  }
  // odbicia: słaba oprawa pod silną tej samej rodziny (kałuża pod neonem/latarnią) → oświetlona, zapala się z nią
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
  // oświetlone: od korzeni w dół — pierwszy węzeł bez wybranego emitera, mieszczący się w limicie łaty
  const nEmit = fixtures.length;
  const selSet = new Set(sel.map((n) => n.id));
  const litCand: Node[] = [];
  const visit = (n: Node) => {
    if (selSet.has(n.id)) return;
    if (n.area <= o.maxCompFrac * N) { if (n.area >= 10 * k * k) litCand.push(n); return; }
    for (const c of n.children) visit(tree.nodes[c]);
  };
  for (const n of tree.nodes) if (n.level === 0) visit(n);
  litCand.sort((a, b) => b.area - a.area);
  let litArea = 0;
  const dmax = 0.2;
  for (const n of litCand) {
    if (comps.length >= 255) break;
    if (litArea + n.area > o.maxLitFrac * N) continue;
    const cx = (n.cx + 0.5) / aw, cy = (n.cy + 0.5) / ah;
    let best = -1, bd = 1e9;
    for (let f = 0; f < nEmit; f++) {
      const F = fixtures[f];
      if (F.kind === KIND_LIT || F.kind === KIND_LED || F.disc) continue;
      const d = Math.max(0, Math.hypot((cx - F.cx) * aw / diagA, (cy - F.cy) * ah / diagA) - F.r * ah / diagA);
      const fh = hueOf(F.color[0], F.color[1], F.color[2]);
      const warmF = F.kind === KIND_WINDOW || F.kind === KIND_LAMP;
      const compat = n.c90 < 0.12 ? F.kind !== KIND_NEON : hueDiff(n.hue, fh) <= 40 || (n.temp > 0.1 && warmF);
      if (compat && d < bd) { bd = d; best = f; }
    }
    if (best < 0 || bd > dmax) continue;
    litArea += n.area;
    const fx = fixtures.length;
    fixtures.push({ kind: KIND_LIT, members: [], conf: 0, bright: n.p95, cx, cy, r: 0, color: [1, 1, 1], parent: best,
      gain: 0.55 * (1 - bd / dmax) * ss(0.45, 0.85, n.p95), source: "auto" });
    const ci = mkComp(n, fx, 0);
    fixtures[fx].members.push(ci);
    litOf[n.id] = ci;
  }
  // tekstura: R = id (emiter ma pierwszeństwo przed łatą, która go zawiera; poszerzone o 2 px), G = lokalna średnia
  let ids = new Uint8Array(N);
  const L = tree.labs.length;
  for (let i = 0; i < N; i++) {
    let lit = 0;
    for (let l = 0; l < L; l++) {
      const id = tree.labs[l][i]; if (!id) break;
      const e = compOf[id - 1];
      if (e >= 0 && comps[e].fixture < nEmit) { ids[i] = e; lit = -1; break; }
      const t = litOf[id - 1]; if (t >= 0) lit = t;
    }
    if (lit > 0) ids[i] = lit;
  }
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
  for (let i = 0; i < N; i++) { tex[i * 4] = ids[i]; tex[i * 4 + 1] = Math.round(Math.min(1, M[i]) * 255); tex[i * 4 + 3] = 255; }
  const debug = [...tree.nodes].filter((n) => n.prob >= 0.05).sort((a, b) => b.prob - a.prob).slice(0, 60).map((n) => ({
    x: +((n.cx + 0.5) / aw).toFixed(3), y: +((n.cy + 0.5) / ah).toFixed(3), area: n.area, p95: +n.p95.toFixed(2), c90: +n.c90.toFixed(2),
    hue: Math.round(n.hue), sat: +n.f[11].toFixed(2), fall: +n.f[8].toFixed(2), conf: +n.prob.toFixed(2), coreSat: n.white,
    note: `L${n.level} ${["neon", "okno", "latarnia", "tarcza", "ekran", "led", "świetlik"][n.kind]}${selSet.has(n.id) ? " ✓" : ""}`,
  }));
  return { aw, ah, tex, comps, fixtures, ms: performance.now() - t0, debug, scene };
}

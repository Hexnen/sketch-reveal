/**
 * Kolejność i czas rysowania kresek — „jak artysta”. Czas liczony w SEKUNDACH (rdzeń zna długość fazy),
 * dopiero na końcu mapowany na oś 0..END:
 *  - warstwy: konstrukcja (długie, proste, poza strefami gęstymi) → formy/struktury (balustrady, szczeble)
 *    → detal i mikrokreski → kreskowanie/wypełnienia; hierarchia LOKALNA: w regionie (siatka 3×3) detal
 *    rusza dopiero po ≥80% długości form tego regionu (bramka), więc nie zlewa się po 6% osi;
 *  - ręce: pierwsze `parallel` to ręce widoczne (z piórem, przelot między kreskami), reszta to
 *    „przepustowość” dobierana automatycznie tak, by gęsty rysunek zmieścił się w czasie;
 *    każda ręka bierze zadanie najbliższe końca poprzedniej kreski (bez skakania po ekranie);
 *  - kreska „pokazowa” trwa ≥ ~5 klatek; profil min-jerk (rozpęd/hamowanie), nierówne pauzy;
 *  - przemapowanie czasu wg skumulowanego tuszu: równe tempo przybywania tuszu (bez zrywu → pełzania →
 *    fali kreskowania), nachylenie przycięte, żeby nie zabić rytmu ręki.
 */
import type { SketchIntroParams } from "./params";
import { rng } from "./params";
import { A_LEVELS, hatchGroups, JobGrid, type Job } from "./scheduleParts";

export interface ScheduleDeps {
  rng: typeof rng; A_LEVELS: typeof A_LEVELS; hatchGroups: typeof hatchGroups; JobGrid: typeof JobGrid;
}
import type { Path } from "./trace";

export { profileF, profileInv } from "./scheduleParts";

export interface Schedule {
  start: Float32Array;
  dur: Float32Array;
  rev: Uint8Array;
  prof: Uint8Array;
  lane: Int16Array;
  /** Ścieżki rąk widocznych (z piórem) w kolejności czasu. */
  visible: Int32Array[];
}
/**
 * Fabryka bez odwołań na zewnątrz (zależności tylko z parametru) — źródło serializowane do Workera
 * (Blob URL, worker.ts) i wołane na wątku głównym (fallback). Nie odwołuj się tu do importów modułu.
 */
export function scheduleModule(d: ScheduleDeps) {
  const { rng, A_LEVELS, hatchGroups, JobGrid } = d;
  /** Kreski kończą się przed END — reszta osi to krótkie „schnięcie” świeżego grafitu. */
  const END = 0.97;


  const MIN_SHOW = 0.11; // s — kreska z piórem ≥ ~5 klatek przy 60 fps (z zapasem na przemapowanie czasu)

  function buildSchedule(paths: Path[], w: number, h: number, prm: SketchIntroParams, seconds: number): Schedule {
    const n = paths.length, diag = Math.hypot(w, h), irr = prm.irregularity;
    const rnd = rng(prm.seed * 7919 + 13);
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.15;
    const S: Schedule = { start: new Float32Array(n), dur: new Float32Array(n), rev: new Uint8Array(n),
      prof: new Uint8Array(n), lane: new Int16Array(n).fill(-1), visible: [] };
    if (!n) return S;
    const end = (i: number, e: 0 | 1) => { const p = paths[i], m = p.xs.length - 1; return e ? [p.xs[m], p.ys[m]] : [p.xs[0], p.ys[0]]; };

    // ── zadania ──
    const inGroup = new Uint8Array(n);
    const jobs: Job[] = [];
    for (const { g, structure } of hatchGroups(paths, diag)) {
      for (const i of g) {
        inGroup[i] = 1;
        const [x0, y0] = end(i, 0), [x1, y1] = end(i, 1);
        S.rev[i] = (x1 - x0) + 1.6 * (y1 - y0) < 0 ? 1 : 0;
      }
      const [ax, ay] = end(g[0], S.rev[g[0]] as 0 | 1), [bx, by] = end(g[g.length - 1], S.rev[g[g.length - 1]] ? 0 : 1);
      jobs.push({ paths: g, tier: structure ? 1 : 3, ax, ay, bx, by, hatch: !structure });
    }
    const bigL = diag * 0.11, midL = diag * 0.035;
    // mikrokreski (cegły, szczeble, ostrogi) — serie w komórkach ~2,5% przekątnej: jedna ręka stawia je po kolei
    const cell = Math.max(16, diag * 0.05), micro = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (inGroup[i] || !paths[i].micro) continue;
      const P = paths[i], m = P.xs.length - 1;
      const key = (Math.floor((P.xs[0] + P.xs[m]) / 2 / cell) * 4096 + Math.floor((P.ys[0] + P.ys[m]) / 2 / cell)) * 2 + (P.denseFrac >= 0.4 ? 1 : 0);
      const c = micro.get(key); if (c) c.push(i); else micro.set(key, [i]);
      inGroup[i] = 1;
    }
    for (const [key, g] of micro) {
      g.sort((a, b) => (paths[a].xs[0] + paths[a].ys[0]) - (paths[b].xs[0] + paths[b].ys[0]));
      const [ax, ay] = end(g[0], 0), [bx, by] = end(g[g.length - 1], 1);
      jobs.push({ paths: g, tier: key & 1 ? 3 : 2, ax, ay, bx, by, hatch: false });
    }
    for (let i = 0; i < n; i++) {
      if (inGroup[i]) continue;
      const P = paths[i], [ax, ay] = end(i, 0), [bx, by] = end(i, 1);
      const straight = Math.hypot(bx - ax, by - ay) / Math.max(1, P.L);
      let tier: number;
      if (P.denseFrac >= 0.4 || P.L < 4 * P.meanHw) tier = 3; // kropki/plamki też; kręgosłup plamy kreskowania — to nie kreska konstrukcyjna
      else if (P.L > bigL && straight >= 0.9 && P.dens < 0.35) tier = 0;
      else tier = P.L > midL ? 1 : 2;
      jobs.push({ paths: [i], tier, ax, ay, bx, by, hatch: false });
    }
    const local = prm.order === "big";
    for (const j of jobs) {
      if (prm.order === "lr") j.tier = Math.min(5, Math.floor(((j.ax + j.bx) / 2 / w) * 6));
      else if (prm.order === "random") j.tier = Math.floor(rnd() * 3);
    }
    const maxTier = jobs.reduce((m, j) => Math.max(m, j.tier), 0);
    const left = new Int32Array(maxTier + 1);
    for (const j of jobs) left[j.tier]++;
    const tierPenalty = prm.order === "random" ? diag * 0.15 : local ? diag * 0.6 : diag * 0.45;

    // ── regiony 3×3: bramka „detal po formach” ──
    const region = jobs.map((J) => Math.min(2, Math.floor(((J.ax + J.bx) / 2 / w) * 3)) + 3 * Math.min(2, Math.floor(((J.ay + J.by) / 2 / h) * 3)));
    const jobLen = jobs.map((J) => J.paths.reduce((s, i) => s + paths[i].L, 0));
    const formTot = new Float64Array(9), formLeft = new Float64Array(9);
    jobs.forEach((J, j) => { if (J.tier <= 1) { formTot[region[j]] += jobLen[j]; formLeft[region[j]] += jobLen[j]; } });
    const blocked = local ? (j: number) => jobs[j].tier >= 2 && formLeft[region[j]] > 0.1 * formTot[region[j]] : undefined;

    // ── czasy w sekundach ──
    const jit = () => Math.exp(irr * 0.4 * gauss());
    const strokeDur = (P: Path, tier: number, hatch: boolean) => {
      if (hatch) return (0.025 + P.L / 1800) * jit();
      if (P.micro) return (0.012 + P.L / 2200) * jit();
      if (tier <= 1) return Math.max(MIN_SHOW, (0.07 + P.L / 700) * (tier === 0 ? 1.25 : 1) * jit());
      return (0.035 + P.L / 1100) * jit();
    };
    const pickProf = () => {
      const a = irr > 0 ? Math.min(A_LEVELS - 1, Math.floor((0.35 + 0.65 * rnd()) * A_LEVELS)) : 5;
      return a * 3 + (irr > 0 ? Math.floor(rnd() * 3) : 1);
    };
    const durs = new Float32Array(n);
    let work = 0;
    jobs.forEach((J) => {
      work += 0.06;
      J.paths.forEach((i, idx) => { durs[i] = strokeDur(paths[i], J.tier, J.hatch); work += durs[i] + (idx ? 0.012 : 0); });
    });
    // przepustowość: tyle rąk, ile trzeba, by zmieścić się w ~90% czasu fazy (min. = ręce widoczne)
    const budget = Math.max(0.5, seconds) * END;
    const V = Math.max(1, Math.min(prm.parallel, jobs.length));
    const N = Math.max(V, Math.min(32, Math.ceil(work / (budget * 0.76)))); // limit miejsc zapalających się naraz

    const laneT = new Float64Array(N), laneX = new Float64Array(N), laneY = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      // widoczne ręce zaczynają pierwsze (konstrukcja), ręce w tle dołączają stopniowo przez ~1/3 fazy
      laneT[k] = k < V ? k * 0.25 : budget * (0.03 + 0.3 * Math.pow((k - V + 1) / (N - V + 1), 1.3)) * (0.85 + 0.3 * rnd());
      laneX[k] = w * (0.15 + 0.7 * rnd()); laneY[k] = h * (0.15 + 0.7 * rnd());
    }
    const visible: number[][] = Array.from({ length: V }, () => []);
    const alive = new Uint8Array(jobs.length).fill(1);
    const grid = new JobGrid(jobs, w, h, diag, maxTier);
    for (let done = 0; done < jobs.length; done++) {
      let k = 0;
      for (let q = 1; q < N; q++) if (laneT[q] < laneT[k]) k = q;
      let minTier = 0;
      while (minTier < maxTier && !left[minTier]) minTier++;
      const px = laneX[k], py = laneY[k];
      let best = -1, bestC = Infinity;
      for (let pass = 0; pass < 2 && best < 0; pass++) {
        for (let t = minTier; t <= maxTier && (t - minTier) * tierPenalty < bestC; t++) {
          if (!left[t]) continue;
          const pen = (t - minTier) * tierPenalty;
          const j = grid.nearest(t, px, py, bestC - pen, alive, pass === 0 ? blocked : undefined);
          if (j >= 0 && grid.lastDist + pen < bestC) { bestC = grid.lastDist + pen; best = j; }
        }
      }
      const J = jobs[best];
      alive[best] = 0; left[J.tier]--;
      if (J.tier <= 1) formLeft[region[best]] -= jobLen[best];
      const flip = Math.hypot(J.bx - px, J.by - py) < Math.hypot(J.ax - px, J.ay - py);
      const list = flip ? J.paths.slice().reverse() : J.paths;
      const [sx, sy] = flip ? [J.bx, J.by] : [J.ax, J.ay];
      let t = laneT[k] + 0.03 + Math.hypot(sx - px, sy - py) / 2500 + irr * Math.pow(rnd(), 3) * 0.12;
      if (rnd() < irr * 0.03) t += 0.15 + rnd() * 0.25;
      let ex = sx, ey = sy;
      list.forEach((i, idx) => {
        if (J.paths.length === 1) S.rev[i] = flip ? 1 : 0; // serie mają kierunek ustalony wcześniej
        if (idx) t += 0.008 + 0.012 * irr * rnd();
        S.start[i] = t; S.dur[i] = durs[i]; S.prof[i] = pickProf(); S.lane[i] = k;
        if (k < V) visible[k].push(i);
        t += durs[i];
        [ex, ey] = end(i, S.rev[i] ? 0 : 1);
      });
      laneT[k] = t; laneX[k] = ex; laneY[k] = ey;
    }
    remapByInk(paths, S, END);
    S.visible = visible.map((v) => Int32Array.from(v));
    return S;
  }

  /**
   * Przemapowanie czasu: tusz przybywa w równym tempie. Gęstość tuszu w 240 przedziałach → nowe szerokości
   * przedziałów ∝ gęstość (przycięte do 0,35–3× średniej, by nie zabić rytmu), odwzorowanie odcinkowo liniowe
   * [0, M] → [0, END] stosowane do początku i końca każdej kreski.
   */
  function remapByInk(paths: Path[], S: Schedule, endAt: number) {
    const n = paths.length, B = 240;
    let M = 0;
    for (let i = 0; i < n; i++) M = Math.max(M, S.start[i] + S.dur[i]);
    if (!(M > 0)) return;
    const bins = new Float64Array(B);
    for (let i = 0; i < n; i++) {
      const a = (S.start[i] / M) * B, b = ((S.start[i] + S.dur[i]) / M) * B;
      const ink = paths[i].L * (1 + paths[i].meanHw), span = Math.max(1e-6, b - a);
      for (let q = Math.floor(a); q < Math.min(B, Math.ceil(b)); q++) {
        bins[q] += (ink * (Math.min(b, q + 1) - Math.max(a, q))) / span;
      }
    }
    let mean = 0;
    for (let q = 0; q < B; q++) mean += bins[q] / B;
    const edge = new Float64Array(B + 1);
    // lekki ease-in: na starcie tusz przybywa wolniej (kilka rąk kreśli konstrukcję), potem równo
    const rate = (x: number) => 0.75 + 0.25 * Math.min(1, x / 0.3) * Math.min(1, x / 0.3) * (3 - 2 * Math.min(1, x / 0.3));
    for (let q = 0; q < B; q++) edge[q + 1] = edge[q] + Math.max(0.2, Math.min(3, bins[q] / Math.max(1e-9, mean) / rate(q / B)));
    const k = endAt / edge[B];
    const map = (t: number) => {
      const x = Math.max(0, Math.min(B, (t / M) * B)), q = Math.min(B - 1, Math.floor(x));
      return (edge[q] + (edge[q + 1] - edge[q]) * (x - q)) * k;
    };
    for (let i = 0; i < n; i++) {
      const s = map(S.start[i]), e = map(S.start[i] + S.dur[i]);
      S.start[i] = s; S.dur[i] = Math.max(1e-5, e - s);
    }
  }
  return { END, buildSchedule };
}

export const { END, buildSchedule } = scheduleModule({ rng, A_LEVELS, hatchGroups, JobGrid });

/**
 * Faza 0 przejścia: RYSOWANIE szkicu na białym arkuszu, zanim wejdzie kolor.
 *
 * setSketch → (asynchronicznie, kawałkami) wektoryzacja line-artu: próg tuszu → transformata
 * odległości (grubość) → szkielet Zhang–Suen → graf → ścieżki sklejone przez skrzyżowania →
 * etykiety pikseli (BFS). Potem harmonogram „jak artysta” (schedule.ts) i pole czasu T (field.ts).
 * render(p) jest bezstanowy i skrubowalny: p=0 czysty papier, p=1 piksel w piksel szkic
 * (to, co efekty koloru pokazują w swoim p=0 — przekazanie bez skoku).
 */
import type { ParamSpec, RevealImageSource } from "../types";
import { acquireAnalysis, getAnalysis, type Analysis } from "./analysisCache";
import { computeField } from "./field";
import { claimGlCanvas, releaseGlCanvas } from "./glContext";
import {
  mergeParams, SKETCH_INTRO_DEFAULTS, SKETCH_INTRO_ORDERS, SKETCH_INTRO_PARAM_SPECS,
  type SketchIntroParams,
} from "./params";
import { collectPens, PEN_STRIDE } from "./pens";
import { createIntroRenderer, MAX_PENS, type IntroRenderer } from "./render";
import { buildSchedule, type Schedule } from "./schedule";
import { workerField, workerStats } from "./worker";

export { SKETCH_INTRO_DEFAULTS, SKETCH_INTRO_ORDERS, SKETCH_INTRO_PARAM_SPECS };
export type { SketchIntroParams, SketchOrder } from "./params";
export { workerStats } from "./worker";

export interface SketchIntro {
  setSketch(sketch: RevealImageSource, width: number, height: number): void;
  /** 0..1 — ile szkicu już narysowano. */
  render(p: number): void;
  dispose(): void;
  /** Opcjonalne: parametry rysowania (częściowa aktualizacja). */
  setParams?(p: Partial<SketchIntroParams>): void;
  paramSpecs?: ParamSpec[];
  /** Opcjonalne: rozwiązuje się, gdy wektoryzacja ostatniego setSketch jest gotowa. */
  whenReady?(): Promise<void>;
  /** Opcjonalne: czy wektoryzacja gotowa (przed gotowością render pokazuje czysty papier). */
  isReady?(): boolean;
  /** Opcjonalne: wymusza przeliczenie odroczonej zmiany parametrów (np. przed zrzutem klatek). */
  flush?(): void;
  /**
   * Opcjonalne: klatka p=0 efektu koloru (RGBA w rozmiarze szkicu). Nakładka kończy wtedy DOKŁADNIE na niej
   * (papier/ziarno efektu, np. kremowy papier `spread`), a zaczyna na papierze efektu — bez szwu. null = szkic.
   */
  setTarget?(rgba: Uint8ClampedArray | null, width: number, height: number): void;
  /**
   * Opcjonalne: zwolnij zasoby GPU (tekstury, backbuffer) — nakładka niewidoczna. Analiza i pole T zostają w
   * pamięci; następny `render(p)` odtwarza renderer leniwie (ten sam obraz, bez ponownej wektoryzacji).
   */
  release?(): void;
}

/** Największy bok tekstury szkicu i płótna (mapy Foundry 6–10k px): powyżej — pomniejszona kopia. */
const MAX_SIDE = 4096;

const INK_LO = 45; // poniżej: ton/tło kreskowania — dziedziczy czas sąsiedniej kreski, nie „zalewa” plamą
const FRESH = 0.04;

export function createSketchIntro(canvas: HTMLCanvasElement): SketchIntro {
  /** disposed = po dispose() nic już nie rysuje ani nie tworzy renderera (spóźnione obietnice, timery — bughunt #1). */
  let disposed = false;
  /** lost = kontekst WebGL utracony (GPU albo nasze odroczone zwolnienie) — renderer odtwarzany po `restored`. */
  let lost = claimGlCanvas(canvas);
  let glCtx: WebGL2RenderingContext | null = null;
  const newRd = (): IntroRenderer => { const r = createIntroRenderer(canvas); if (r.gl) glCtx = r.gl; return r; };
  let rd: IntroRenderer | null = lost ? null : newRd();
  let suspended = false;
  let src: RevealImageSource | null = null, tgt: Uint8ClampedArray | null = null, fieldData: Float32Array | null = null;
  let srcPx: Uint8ClampedArray | null = null;
  let tw = 0, th = 0; // rozmiar tekstury szkicu (= w×h, chyba że > MAX_SIDE)
  let params: SketchIntroParams = { ...SKETCH_INTRO_DEFAULTS };
  let an: Analysis | null = null;
  let sched: Schedule | null = null;
  let fieldDirty = true;
  let w = 0, h = 0, gen = 0, lastP = 0;
  let ready: Promise<void> = Promise.resolve();
  const pens = new Float32Array(MAX_PENS * PEN_STRIDE);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let held: { release(): void } | null = null; // analiza w użyciu (anulowana przy zmianie obrazu)
  let fieldSeq = 0, inflight = false;
  const applyField = (a: Analysis, S: Schedule, f: Float32Array) => {
    sched = S; fieldData = f;
    rd?.setField(f, a.aw, a.ah);
  };
  /** Synchronicznie na wątku głównym (flush/harness, fallback). */
  const rebuild = () => {
    if (!an) return;
    fieldSeq++; inflight = false; fieldDirty = false;
    const S = buildSchedule(an.paths, an.aw, an.ah, params, params.seconds);
    applyField(an, S, computeField(an.paths, an.ink, INK_LO, an.aw, an.ah, S));
  };
  /** Harmonogram + pole T w workerze (wątek główny wolny); nieaktualne wyniki odrzucane. */
  const rebuildAsync = async () => {
    const a = an;
    if (!a) return;
    const my = ++fieldSeq;
    inflight = true; fieldDirty = false;
    try {
      const r = await workerField(a, params, INK_LO);
      if (my !== fieldSeq || a !== an) return;
      inflight = false;
      applyField(a, r.sched, r.field);
    } catch {
      if (my !== fieldSeq || a !== an) return;
      workerStats.fallbacks++;
      rebuild();
    }
  };
  /** Pierwsze pole liczone przed gotowością; zmiany parametrów — odroczone i zbijane (suwak nie zacina UI). */
  const ensureField = () => {
    if (!an || !fieldDirty) return;
    if (!sched) { rebuild(); return; }
    if (timer) return;
    timer = setTimeout(() => { timer = null; if (fieldDirty && !disposed) void rebuildAsync().then(() => { if (!disposed) redraw(); }); }, 40);
  };

  /** Rozmiar płótna = rozmiar wyświetlania × DPR (bez rozciągania CSS-em); poza DOM — rozmiar szkicu. */
  const fitCanvas = () => {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    let ow = tw, oh = th;
    if (cw > 0 && ch > 0 && rd?.kind === "gl") {
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      // nigdy poniżej rozmiaru szkicu: przy pomniejszeniu skaluje kompozytor — tak jak u efektów (bez skoku ostrości)
      const k = Math.min(Math.max(1, Math.min((cw * dpr) / tw, (ch * dpr) / th)), Math.max(1, MAX_SIDE / Math.max(tw, th)));
      ow = Math.max(1, Math.round(tw * k)); oh = Math.max(1, Math.round(th * k));
    }
    if (canvas.width !== ow || canvas.height !== oh) { canvas.width = ow; canvas.height = oh; }
  };
  // resize: przerysowanie dopiero po ustaniu zmian (realokacja backbuffera co krok przeciągania okna = zacięcia)
  let roTimer: ReturnType<typeof setTimeout> | null = null;
  const ro = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => { if (roTimer) clearTimeout(roTimer); roTimer = setTimeout(() => { roTimer = null; redraw(); }, 120); })
    : null;
  ro?.observe(canvas);

  /** Szkic na białym tle w rozmiarze tekstury (płótno 2D: upload GPU→GPU; piksele tylko na żądanie). */
  const uploadSketch = () => {
    if (!rd || !src) return;
    const s = src;
    const make = () => {
      const off = document.createElement("canvas");
      off.width = tw; off.height = th;
      const g = off.getContext("2d", { willReadFrequently: false });
      if (!g) throw new Error("Brak kontekstu 2D");
      g.fillStyle = "#fff"; g.fillRect(0, 0, tw, th);
      g.drawImage(s, 0, 0, tw, th);
      return { off, g };
    };
    // płótno uploadu nie jest trzymane; piksele (szew/fallback 2D) — z nowej kopii, raz na setSketch
    rd.setSketch(make().off, tw, th, () => (srcPx ??= make().g.getImageData(0, 0, tw, th).data));
  };
  /** Leniwe odtworzenie renderera po release(): te same dane (szkic, pole, cel) → te same bajty. */
  const pushPaper = () => rd?.setPaper(params, tw > 0 ? w / tw : 1);
  /** Rozmiar tekstury szkicu (≤ MAX_SIDE i MAX_TEXTURE_SIZE renderera). */
  const sizeTex = (maxSide: number) => {
    const ts = Math.min(1, Math.min(MAX_SIDE, maxSide) / Math.max(w, h));
    tw = Math.max(1, Math.round(w * ts)); th = Math.max(1, Math.round(h * ts));
  };
  const ensureRd = (): IntroRenderer | null => {
    if (rd) return rd;
    if (disposed || lost) return null;
    rd = newRd();
    if (w) sizeTex(rd.maxSide); // ten sam renderer → te same tw×th; po odtworzeniu kontekstu — limit nowego
    pushPaper();
    uploadSketch();
    if (fieldData && an) rd.setField(fieldData, an.aw, an.ah);
    rd.setTarget(tgt);
    return rd;
  };
  /** Wewnętrzne przerysowania (pole, parametry, cel, resize) — nie budzą zwolnionej nakładki. */
  const redraw = () => { if (!suspended) draw(lastP); };

  const draw = (p: number) => {
    if (disposed) return;
    lastP = p;
    suspended = false;
    if (!w) return;
    const R = ensureRd();
    if (!R) return; // kontekst utracony — narysuje `webglcontextrestored`
    fitCanvas();
    if (p >= 1) { R.draw(2, 1, pens, 0, 0); return; }
    if (p <= 0 || !an) { R.draw(0, 0, pens, 0, 0); return; }
    ensureField();
    const n = an && sched && params.pen
      ? collectPens(an.paths, sched, p, tw / an.aw, Math.max(1.6, Math.hypot(tw, th) / 650), pens, MAX_PENS) : 0;
    R.draw(1, p, pens, n, params.fresh ? FRESH : 0, params.softness);
  };

  // utrata kontekstu (GPU, nasze zwolnienie): renderer porzucony; po odtworzeniu — nowy z zachowanych danych
  const onLost = (e: Event) => { e.preventDefault(); lost = true; rd = null; };
  const onRestored = () => { if (disposed) return; lost = false; rd = null; redraw(); };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    paramSpecs: SKETCH_INTRO_PARAM_SPECS,
    setSketch(sketch, width, height) {
      const my = ++gen;
      if (disposed) return;
      w = width; h = height; src = sketch; tgt = null; srcPx = null;
      const R = ensureRd();
      sizeTex(R?.maxSide ?? MAX_SIDE);
      pushPaper();
      uploadSketch();
      an = null; sched = null; fieldDirty = true; fieldData = null;
      R?.setField(null, 1, 1);
      redraw();
      held?.release();
      const job = acquireAnalysis(sketch, w, h);
      held = job;
      ready = job.pr.then(async (a) => {
        if (my !== gen) return;
        an = a; fieldDirty = true;
        await rebuildAsync(); // pole liczone PRZED zgłoszeniem gotowości — pierwsza klatka odtwarzania bez zacięcia
        if (my !== gen) return;
        if (!sched) rebuild();
        redraw();
      }, (e: Error) => { if (my === gen) throw e; });
    },
    setParams(p) {
      if (disposed) return;
      const next = mergeParams(params, p);
      const sameSched = next.parallel === params.parallel && next.irregularity === params.irregularity &&
        next.order === params.order && next.seed === params.seed && next.seconds === params.seconds;
      params = next;
      pushPaper();
      if (!sameSched) fieldDirty = true;
      redraw();
    },
    /** Natychmiastowe przeliczenie odroczonych zmian (harness/testy). */
    flush() {
      if (disposed) return;
      if (timer) { clearTimeout(timer); timer = null; }
      if (fieldDirty || inflight) rebuild();
      redraw();
    },
    setTarget(rgba, gw, gh) {
      if (disposed) return;
      // cel tylko w rozmiarze tekstury (szkic > MAX_SIDE → bez szwu z efektem, kończy na szkicu)
      tgt = rgba && gw === w && gh === h && tw === w && th === h ? rgba : null;
      rd?.setTarget(tgt);
      redraw();
    },
    release() {
      if (suspended || !rd) return;
      suspended = true;
      rd.dispose(); rd = null;
      canvas.width = 1; canvas.height = 1; // backbuffer → 1 px
    },
    whenReady: () => ready,
    isReady: () => !!an,
    render: draw,
    dispose() {
      if (disposed) return;
      disposed = true; suspended = true; w = 0;
      gen++; an = null; sched = null; src = null; tgt = null; fieldData = null; srcPx = null; fieldSeq++;
      held?.release(); held = null;
      if (timer) { clearTimeout(timer); timer = null; }
      if (roTimer) { clearTimeout(roTimer); roTimer = null; }
      ro?.disconnect(); rd?.dispose(); rd = null;
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      releaseGlCanvas(canvas, glCtx); // odroczony loseContext (anulowany, gdy płótno zaraz weźmie nowa instancja)
    },
  };
}

/** Diagnostyka (harness/raport): statystyki wektoryzacji dla obrazu. */
export async function analyzeSketchStats(src: RevealImageSource, w: number, h: number) {
  const a = await getAnalysis(src, w, h);
  let px = 0, L = 0;
  for (const p of a.paths) { px += p.pix.length; L += p.L; }
  return { paths: a.paths.length, skeletonPx: px, totalLength: Math.round(L), ms: Math.round(a.ms), aw: a.aw, ah: a.ah };
}

/** Diagnostyka (harness): harmonogram dla parametrów — czasy kresek, warstwy, ręce, pióra w chwilach `ts`. */
export async function debugSchedule(src: RevealImageSource, w: number, h: number, p: Partial<SketchIntroParams>, ts: number[]) {
  const a = await getAnalysis(src, w, h);
  const prm = mergeParams(SKETCH_INTRO_DEFAULTS, p);
  const S = buildSchedule(a.paths, a.aw, a.ah, prm, prm.seconds);
  const buf = new Float32Array(MAX_PENS * PEN_STRIDE);
  const pens = ts.map((t) => {
    const n = collectPens(a.paths, S, t, w / a.aw, 2, buf, MAX_PENS);
    return Array.from({ length: n }, (_, i) => [buf[i * PEN_STRIDE], buf[i * PEN_STRIDE + 1], buf[i * PEN_STRIDE + 4]]);
  });
  return {
    start: Array.from(S.start), dur: Array.from(S.dur), lane: Array.from(S.lane),
    L: a.paths.map((q) => q.L), micro: a.paths.map((q) => q.micro), denseFrac: a.paths.map((q) => q.denseFrac),
    lanes: Math.max(...Array.from(S.lane)) + 1, visible: S.visible.map((v) => v.length), pens,
  };
}

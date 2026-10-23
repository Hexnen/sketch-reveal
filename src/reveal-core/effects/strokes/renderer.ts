/**
 * Renderer WebGL2 efektu „strokes”.
 * - setImages: upload tekstur + asynchroniczne generowanie listy pociągnięć (CPU, w kawałkach).
 * - Harmonogram lokalny (schedule.ts): lista posortowana po końcu → prefiks = ukończone.
 * - Bufor akumulacji (FBO RGBA8, premultiplied): ukończone pociągnięcia, dorysowywane przyrostowo;
 *   przy cofnięciu odtwarzane z najbliższego checkpointu (kopie FBO co N pociągnięć).
 * - Klatka: kompozyt z lokalnymi etapami (pole T) + pociągnięcia „w ruchu” rysowane wprost na ekran.
 * - p = 0 → dokładnie szkic; p ≥ 1 → dokładnie obraz kolorowy.
 * - Fala 2 (bezstratnie): dirty-check w render(), harmonogram krojony asynchronicznie, pamięć list/harmonogramów
 *   (cache.ts), tekstury obrazu ≤ MAX_TEXTURE_SIZE, coverage() z danych CPU (coverage.ts). Opcja jakości
 *   `accumMaxSide` (stratna, domyślnie wył.).
 */
import { createPaperTexture, mergePaper, PAPER_DEFAULTS, paperUniforms, paperUniformValues, type PaperParams } from "../../paper";
import type { EffectInstance, EffectParams, RevealImageSource } from "../../types";
import { getSchedule, getSet, imageFingerprint, putSchedule, putSet } from "./cache";
import { aggregateCoverage, sampleTimesW, type SampleTimes } from "./coverage";
import { timelineOf } from "./diag";
import { drive, readImage, type RGBImage } from "./imageOps";
import { DEFAULT_STROKES, genKey, mergeStrokes, scheduleKey, type StrokesParams } from "./params";
import { buildScheduleW, unwarp, type Schedule } from "./schedule";
import { COMPOSITE_FRAG, FULL_VERT, STROKE_FRAG, STROKE_SEGS, STROKE_VERT } from "./shaders";
import { INST_STRIDE, generateStrokes, makeYielder, type CancelToken, type StrokeSet } from "./strokeGen";
import { createAccum, limitImage, link, uploadImage, type Accum } from "./glUtil";

const WORK_SIDE = 1024;
const CHECKPOINT_BYTES = 96 * 1024 * 1024;
const MAX_CHECKPOINTS = 12;
/** Po tylu ms stania na p ≥ 1 zwalniamy akumulację i checkpointy (kompozyt p ≥ 1 ich nie czyta; powrót = odtworzenie). */
const RELEASE_AFTER_DONE_MS = 1500;

export interface StrokesOptions {
  /** Domyślnie false (bez kopii bufora przy prezentacji). Zrzuty robić w tym samym zadaniu co render(). */
  preserveDrawingBuffer?: boolean;
  /**
   * Jakość (STRATNE, domyślnie brak limitu = „high”, bajt w bajt): dłuższy bok bufora akumulacji i checkpointów
   * (np. 2048). Kompozyt skaluje akumulację liniowo. Pomiar PSNR: strokes.md „Fala 2”.
   */
  accumMaxSide?: number;
  /** Limit boku tekstur obrazu (domyślnie MAX_TEXTURE_SIZE); poniżej limitu bez zmian. */
  maxTextureSide?: number;
}

export type StrokesInstance = EffectInstance & {
  /** Rozwiązuje się, gdy lista pociągnięć jest gotowa. Zegar odtwarzacza powinien na to czekać. */
  whenReady(): Promise<void>;
  /** true = lista pociągnięć gotowa (przed tym render pokazuje sam szkic). */
  isReady(): boolean;
  /** Liczba pociągnięć (0 przed wygenerowaniem). */
  strokeCount(): number;
  /** Diagnostyka: liczba pociągnięć i promień (px robocze) na warstwę + przesunięte przyczynowością. */
  stats(): { count: number; radius: number; genMs: number; shifted: number }[];
  /** Diagnostyka: czasy (po warpie) i warstwy w kolejności listy. */
  timeline(): { starts: Float32Array; ends: Float32Array; layer: Uint8Array; x: Float32Array; y: Float32Array; ang: Float32Array } | null;
};

/** Pierwszy indeks i, dla którego arr[i] > t (arr niemalejąca). */
function upperBound(arr: Float32Array, t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function createStrokesRenderer(canvas: HTMLCanvasElement, opts: StrokesOptions = {}): StrokesInstance {
  // Kompozyt pisze alfa = 1, a pociągnięcia (ONE, ONE_MINUS_SRC_ALPHA) ją zachowują → alpha:false bez zmiany pikseli.
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    depth: false, stencil: false, alpha: false, powerPreference: "high-performance",
  });
  if (!gl) throw new Error("strokes: WebGL2 niedostępny");

  const strokeProg = link(gl, STROKE_VERT, STROKE_FRAG);
  const compProg = link(gl, FULL_VERT, COMPOSITE_FRAG);
  const uS = (n: string) => gl.getUniformLocation(strokeProg, n);
  const uC = (n: string) => gl.getUniformLocation(compProg, n);
  const sl = { painted: uS("u_painted"), pts: uS("u_pts"), work: uS("u_work"), t: uS("u_t"), bristle: uS("u_bristle"), pxScale: uS("u_pxScale") };
  const cl = Object.fromEntries(
    ["u_sketch", "u_painted", "u_accum", "u_order", "u_res", "u_tau", "u_S", "u_ground", "u_ink", "u_fin",
      "u_done"].map((n) => [n, uC(n)]),
  ) as Record<string, WebGLUniformLocation | null>;
  // jednostki samplerów są stałe — ustawiane raz, nie co klatkę
  gl.useProgram(compProg);
  ["u_sketch", "u_painted", "u_accum", "u_order"].forEach((n, i) => gl.uniform1i(cl[n], i));
  gl.useProgram(strokeProg);
  gl.uniform1i(sl.painted, 1);
  gl.uniform1i(sl.pts, 3);
  const setPaper = paperUniforms(gl, compProg);
  const paperTex = createPaperTexture(gl);
  let imgW = 0, imgH = 0; // rozmiar obrazu (ziarno papieru w px obrazu)
  const emptyVao = gl.createVertexArray();
  const strokeVao = gl.createVertexArray();
  const instBuf = gl.createBuffer();
  const texSketch = gl.createTexture();
  const texPainted = gl.createTexture();
  const texPts = gl.createTexture();
  const texOrder = gl.createTexture();
  const maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, opts.maxTextureSide ?? Infinity);

  let params: StrokesParams = { ...DEFAULT_STROKES };
  let paper: PaperParams = { ...PAPER_DEFAULTS };
  let progress = 0;
  let disposed = false;
  let hasImages = false;
  let work: RGBImage | null = null;
  let set: StrokeSet | null = null;
  let sched: Schedule | null = null;
  let genMs = 0;
  let curGenKey = "";
  let curSchedKey = "";
  let curBristle = -1;
  let token: CancelToken = { cancelled: true };
  let ready: Promise<void> = Promise.resolve();
  let genSeq = 0; // E5: licznik startGeneration + obietnica ostatniego generowania (nigdy nie zależy od `ready`)
  let genReady: Promise<void> = Promise.resolve();
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let workKey = "";
  /** Harmonogram w trakcie liczenia (krojony) — do jego końca render pokazuje poprzedni. */
  let schedToken: CancelToken = { cancelled: true };
  let schedPending = false;
  /** Dirty-check: wersja stanu wpływającego na klatkę (obrazy, parametry, lista, harmonogram). */
  let ver = 0;
  let lastKey = "";
  /** coverage(): próbki liczone asynchronicznie (porcje ≤ 8 ms) przy pierwszym wywołaniu, potem siatki z pamięci. */
  let sketchSrc: RevealImageSource | null = null;
  let sketchWork: RGBImage | null = null;
  let cov: { sched: Schedule; key: string; st: SampleTimes | null; tk: CancelToken; grids: Map<string, Float32Array> } | null = null;

  let accum: Accum | null = null;
  let accumCount = 0;
  /** acc = null → tekstura jeszcze nieprzydzielona (leniwie, przy pierwszym zapisie checkpointu). */
  let checkpoints: { at: number; acc: Accum | null; valid: boolean }[] = [];
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Checkpointy służą tylko cofaniu: do pierwszego cofnięcia (studio, suwak) nie są przydzielane. Odtwarzanie
   * wyłącznie do przodu (splash/Foundry) nie trzyma ich wcale; pierwsze cofnięcie = jednorazowe odtworzenie od 0. */
  let rewound = false;

  function freeAccum() {
    if (accum) accum.free();
    for (const c of checkpoints) c.acc?.free();
    accum = null;
    checkpoints = [];
    accumCount = 0;
  }

  function ensureAccum() {
    const DW = gl!.drawingBufferWidth;
    const DH = gl!.drawingBufferHeight;
    const k = Math.min(1, (opts.accumMaxSide ?? Infinity) / Math.max(DW, DH));
    const W = k < 1 ? Math.max(1, Math.round(DW * k)) : DW;
    const H = k < 1 ? Math.max(1, Math.round(DH * k)) : DH;
    if (accum && accum.w === W && accum.h === H) return;
    freeAccum();
    accum = createAccum(gl!, W, H);
    resetAccum();
  }

  /**
   * Czyści akumulację i unieważnia checkpointy (nowa lista / kolejność / wygląd pędzla). Istniejące tekstury
   * checkpointów idą do ponownego użycia (copyTo nadpisuje całość), nowe przydziela dopiero advanceTo.
   */
  function resetAccum() {
    if (!accum) return;
    accum.clear();
    accumCount = 0;
    const pool = checkpoints.flatMap((c) => (c.acc ? [c.acc] : []));
    checkpoints = [];
    if (set && set.count > 0) {
      const K = Math.min(MAX_CHECKPOINTS, Math.floor(CHECKPOINT_BYTES / (accum.w * accum.h * 4)));
      for (let k = 1; k <= K; k++) {
        checkpoints.push({ at: Math.round((k * set.count) / (K + 1)), acc: pool.pop() ?? null, valid: false });
      }
    }
    for (const a of pool) a.free();
  }

  /** pxScale = px celu (ekran / akumulacja) na px roboczy — ziarno pędzla w px obrazu. */
  function drawStrokes(a: number, b: number, t: number, pxScale: number) {
    if (b <= a || !set) return;
    gl!.useProgram(strokeProg);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, texPainted);
    gl!.uniform2f(sl.work, set.w, set.h);
    gl!.uniform1f(sl.t, t);
    gl!.uniform1f(sl.bristle, params.bristle);
    gl!.uniform1f(sl.pxScale, pxScale);
    gl!.activeTexture(gl!.TEXTURE3);
    gl!.bindTexture(gl!.TEXTURE_2D, texPts);
    gl!.bindVertexArray(strokeVao);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, instBuf);
    const stride = INST_STRIDE * 4;
    const base = a * stride; // WebGL2 nie ma baseInstance → offset atrybutów
    gl!.vertexAttribPointer(0, 4, gl!.FLOAT, false, stride, base);
    gl!.vertexAttribPointer(1, 4, gl!.FLOAT, false, stride, base + 16);
    gl!.vertexAttribPointer(2, 4, gl!.FLOAT, false, stride, base + 32);
    gl!.vertexAttribPointer(3, 3, gl!.FLOAT, false, stride, base + 48);
    gl!.enable(gl!.BLEND);
    gl!.blendFunc(gl!.ONE, gl!.ONE_MINUS_SRC_ALPHA);
    gl!.drawArraysInstanced(gl!.TRIANGLE_STRIP, 0, 2 * (STROKE_SEGS + 1), b - a);
    gl!.disable(gl!.BLEND);
    gl!.bindVertexArray(null);
  }

  function drawToAccum(a: number, b: number) {
    if (b <= a || !accum) return;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, accum.fbo);
    gl!.viewport(0, 0, accum.w, accum.h);
    drawStrokes(a, b, 1e9, accum.w / set!.w);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
  }

  /** Doprowadza akumulację do dokładnie n ukończonych pociągnięć (przód: dorysuj; tył: checkpoint). */
  function advanceTo(n: number) {
    if (!accum) return;
    if (n < accumCount) {
      rewound = true;
      let best: (typeof checkpoints)[number] | null = null;
      for (const c of checkpoints) if (c.valid && c.at <= n && (!best || c.at > best.at)) best = c;
      if (best?.acc) {
        best.acc.copyTo(accum);
        accumCount = best.at;
      } else {
        accum.clear();
        accumCount = 0;
      }
    }
    for (const c of checkpoints) {
      if (!rewound || c.valid || c.at <= accumCount || c.at > n) continue;
      drawToAccum(accumCount, c.at);
      accumCount = c.at;
      c.acc ??= createAccum(gl!, accum.w, accum.h);
      accum.copyTo(c.acc);
      c.valid = true;
    }
    drawToAccum(accumCount, n);
    accumCount = n;
  }

  function uploadPoints(s: StrokeSet) {
    const rows = Math.max(1, Math.ceil(s.points.length / 2 / 4096));
    const padded = new Float32Array(4096 * rows * 2);
    padded.set(s.points);
    gl!.bindTexture(gl!.TEXTURE_2D, texPts);
    gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 4);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RG32F, 4096, rows, 0, gl!.RG, gl!.FLOAT, padded);
    for (const p of [gl!.TEXTURE_MIN_FILTER, gl!.TEXTURE_MAG_FILTER]) gl!.texParameteri(gl!.TEXTURE_2D, p, gl!.NEAREST);
    gl!.bindVertexArray(strokeVao);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, instBuf);
    for (let i = 0; i < 4; i++) {
      gl!.enableVertexAttribArray(i);
      gl!.vertexAttribDivisor(i, 1);
    }
    gl!.bindVertexArray(null);
  }

  /**
   * Harmonogram (krojony na porcje ≤ 8 ms albo z pamięci) → applySchedule. Do końca liczenia render pokazuje
   * poprzedni harmonogram (jak przy zmianie listy w debounce); isReady() = false.
   */
  async function reschedule(): Promise<void> {
    if (!set) return;
    const s = set;
    const key = scheduleKey(params);
    schedToken.cancelled = true;
    const tk: CancelToken = { cancelled: false };
    schedToken = tk;
    curSchedKey = key;
    let sc = getSchedule(s, key);
    if (!sc) {
      schedPending = true;
      try {
        sc = await drive(buildScheduleW(s, { ...params }), makeYielder(tk));
      } catch (e) {
        if (e instanceof Error && e.message === "cancelled") return;
        throw e;
      } finally {
        if (schedToken === tk) schedPending = false;
      }
      putSchedule(s, key, sc);
    } else {
      schedPending = false; // E4: z pamięci — anulowany poprzednik (finally z innym tokenem) flagi już nie zdejmie
    }
    if (tk.cancelled || disposed || set !== s) return;
    applySchedule(sc);
  }

  /** Upload instancji i pola T; kolejność listy się zmienia → akumulacja od nowa. */
  function applySchedule(sc: Schedule) {
    sched = sc;
    ver++;
    gl!.bindBuffer(gl!.ARRAY_BUFFER, instBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, sched.inst, gl!.STATIC_DRAW);
    gl!.bindTexture(gl!.TEXTURE_2D, texOrder);
    gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R16F, sched.gw, sched.gh, 0, gl!.RED, gl!.FLOAT, sched.T);
    for (const f of [gl!.TEXTURE_MIN_FILTER, gl!.TEXTURE_MAG_FILTER]) gl!.texParameteri(gl!.TEXTURE_2D, f, gl!.LINEAR);
    for (const w of [gl!.TEXTURE_WRAP_S, gl!.TEXTURE_WRAP_T]) gl!.texParameteri(gl!.TEXTURE_2D, w, gl!.CLAMP_TO_EDGE);
    resetAccum();
  }

  function startGeneration() {
    if (!work) return;
    token.cancelled = true;
    const myToken: CancelToken = { cancelled: false };
    token = myToken;
    curGenKey = genKey(params);
    const img = work;
    const t0 = performance.now();
    const cacheKey = `${workKey}|${curGenKey}`;
    const cached = getSet(cacheKey);
    const gen = cached ? Promise.resolve(cached) : generateStrokes(img, { ...params }, myToken);
    ready = gen.then(
      async (s) => {
        if (myToken.cancelled || disposed) return;
        if (!cached) putSet(cacheKey, s);
        genMs = Math.round(performance.now() - t0);
        set = s;
        ver++;
        uploadPoints(s);
        ensureAccum();
        await reschedule();
        if (myToken.cancelled || disposed || set !== s) return;
        render();
      },
      (e: unknown) => {
        if (e instanceof Error && e.message === "cancelled") return;
        console.error("strokes: generowanie nie powiodło się", e);
      },
    );
    genSeq++;
    genReady = ready;
  }

  function render() {
    if (disposed || !hasImages) return;
    // Dirty-check (W2/ST5): bez zmian (p, stan, rozmiar) płótno trzyma klatkę. Tanie klatki (p=0, p≥1) rysujemy
    // zawsze — zrzut w tym samym zadaniu co render() (useSeamTarget) działa też bez preserveDrawingBuffer.
    const key = `${progress}|${ver}|${gl!.drawingBufferWidth}x${gl!.drawingBufferHeight}`;
    if (progress > 0 && progress < 1 && key === lastKey) return;
    lastKey = key;
    // wysokość papieru (raz na rozmiar/skalę) — przed wiązaniem tekstur, bo zmienia stan GL (FBO, program, viewport)
    const pt: [WebGLTexture, number] | null = paperTex.ensure(imgW, imgH, paper) ? [paperTex.tex, 4] : null;
    // p ≥ 1: kompozyt nie czyta akumulacji (u_done) → nie przydzielaj jej; po chwili stania zwolnij (K10)
    if (progress < 1) {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
      ensureAccum();
    } else if (accum && !releaseTimer) {
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (!disposed && progress >= 1) freeAccum();
      }, RELEASE_AFTER_DONE_MS);
    }
    const W = gl!.drawingBufferWidth;
    const H = gl!.drawingBufferHeight;
    const t = progress;
    const live = !!(set && sched) && progress < 1;
    let completed = 0;
    let windowEnd = 0;
    if (live && sched) {
      if (curBristle !== params.bristle) {
        curBristle = params.bristle;
        resetAccum();
      }
      completed = upperBound(sched.ends, t);
      windowEnd = upperBound(sched.ends, t + sched.maxDur + 1e-6);
      advanceTo(completed);
    }
    const tau = sched ? unwarp(sched.warp, t) : 0;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, W, H);
    gl!.useProgram(compProg);
    [texSketch, texPainted, accum?.tex ?? null, texOrder].forEach((tex, i) => {
      gl!.activeTexture(gl!.TEXTURE0 + i);
      gl!.bindTexture(gl!.TEXTURE_2D, tex);
    });
    gl!.uniform2f(cl.u_res, W, H);
    // Bez listy pociągnięć: sam szkic (p<1) albo czysty obraz (p≥1). τ < 0 wyłącza lokalne etapy.
    gl!.uniform1f(cl.u_tau, live ? tau : -10);
    gl!.uniform1f(cl.u_S, sched?.S ?? 0);
    gl!.uniform2f(cl.u_ground, ...(sched?.ground ?? [1, 1]));
    gl!.uniform2f(cl.u_ink, ...(sched?.ink ?? [1, 1]));
    gl!.uniform2f(cl.u_fin, ...(sched?.fin ?? [1, 1]));
    setPaper(paper, false, pt); // wspólny papier od p=0 (dawniej rampa u_paperIn 0→1 w p∈[0, 0.03])
    gl!.uniform1f(cl.u_done, progress >= 1 ? 1 : 0);
    gl!.bindVertexArray(emptyVao);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    gl!.bindVertexArray(null);
    if (live && windowEnd > completed && set) drawStrokes(completed, windowEnd, t, W / set.w);
  }

  const inst: StrokesInstance = {
    setImages(sketch: RevealImageSource, painted: RevealImageSource) {
      if (disposed) return;
      // W5: ≤ MAX_TEXTURE_SIZE (poniżej limitu ten sam obiekt → bez zmian bajtów)
      const sk = limitImage(sketch, maxTex) as RevealImageSource;
      const pa = limitImage(painted, maxTex) as RevealImageSource;
      uploadImage(gl, texSketch!, sk);
      uploadImage(gl, texPainted!, pa, true);
      imgW = pa instanceof HTMLImageElement ? pa.naturalWidth : pa.width;
      imgH = pa instanceof HTMLImageElement ? pa.naturalHeight : pa.height;
      hasImages = true;
      work = readImage(painted, WORK_SIDE);
      workKey = imageFingerprint(work);
      sketchSrc = sketch;
      sketchWork = null;
      set = null;
      sched = null;
      if (cov) cov.tk.cancelled = true;
      cov = null;
      schedToken.cancelled = true;
      schedPending = false;
      ver++;
      startGeneration();
    },
    setParams(p: Partial<EffectParams>) {
      params = mergeStrokes(params, p);
      paper = mergePaper(paper, p);
      ver++;
      if (work && genKey(params) !== curGenKey) {
        if (debounce) clearTimeout(debounce);
        token.cancelled = true;
        debounce = setTimeout(() => { debounce = null; startGeneration(); }, 120);
        // E5: po 130 ms podepnij obietnicę NOWEGO generowania; gdy go nie było (dispose w debounce, brak obrazu)
        // — rozwiąż się (wcześniej `.then(() => ready)` zwracało samą siebie → „Chaining cycle detected”)
        const seq = genSeq;
        ready = new Promise((res) => setTimeout(res, 130)).then(() => (genSeq !== seq ? genReady : undefined));
      } else if (set && scheduleKey(params) !== curSchedKey) {
        const done = reschedule();
        const prev = ready;
        ready = done.then(() => prev).catch(() => undefined);
      }
    },
    setProgress(p: number) {
      if (Number.isNaN(p)) return; // E7: NaN ignorowany (±Infinity → 0/1)
      progress = Math.min(1, Math.max(0, p));
    },
    render,
    dispose() {
      if (disposed) return;
      disposed = true;
      token.cancelled = true;
      if (debounce) clearTimeout(debounce);
      if (releaseTimer) clearTimeout(releaseTimer);
      schedToken.cancelled = true;
      freeAccum();
      if (cov) cov.tk.cancelled = true;
      cov = null;
      sketchSrc = sketchWork = null;
      work = null;
      set = null;
      sched = null;
      gl.deleteProgram(strokeProg);
      gl.deleteProgram(compProg);
      paperTex.dispose();
      for (const t of [texSketch, texPainted, texPts, texOrder]) gl.deleteTexture(t);
      gl.deleteBuffer(instBuf);
      gl.deleteVertexArray(emptyVao);
      gl.deleteVertexArray(strokeVao);
    },
    whenReady: () => ready,
    isReady: () => !!sched && !debounce && !schedPending,
    coverage(w: number, h: number) {
      // Lista/harmonogram jeszcze liczone → null (rdzeń wraca do odczytu płótna). Wynik w pamięci per (harmonogram, w×h).
      if (disposed || !set || !sched || !work || debounce || schedPending) return null;
      const tint = paperUniformValues(paper).tint;
      const key = tint.join(",");
      if (cov && cov.sched === sched && cov.key === key) {
        if (!cov.st) return null; // w trakcie
        const gk = `${w}x${h}`;
        let g = cov.grids.get(gk);
        if (!g) cov.grids.set(gk, (g = aggregateCoverage(cov.st, w, h)));
        return g;
      }
      if (cov) cov.tk.cancelled = true;
      const tk: CancelToken = { cancelled: false };
      const job: NonNullable<typeof cov> = { sched, key, st: null, tk, grids: new Map() };
      cov = job;
      if (!sketchWork && sketchSrc) sketchWork = readImage(sketchSrc, WORK_SIDE);
      drive(sampleTimesW(set, sched, work, { sketch: sketchWork, tint }), makeYielder(tk)).then(
        (st) => { if (!tk.cancelled && cov === job) job.st = st; },
        () => { if (cov === job) cov = null; },
      );
      return null;
    },
    strokeCount: () => set?.count ?? 0,
    stats: () => (set ? set.layerRadius.map((radius, i) => ({
      count: set!.layerStart[i + 1] - set!.layerStart[i], radius: Math.round(radius * 10) / 10,
      genMs, shifted: sched?.shifted ?? 0,
    })) : []),
    timeline: () => (set && sched ? timelineOf(set, sched) : null),
  };
  return inst;
}

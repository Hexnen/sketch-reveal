/**
 * Instancja efektu `speedpaint` (czysty WebGL2). Wydajność (performance-audit.md, paczka E2):
 *  - render() rysuje tylko przy zmianie p / parametrów / obrazu / rozmiaru (dirty-check),
 *  - przygotowanie (pole, Kuwahara, kolejność T, tablica pociągnięć, kalibracja tempa) liczone RAZ, w tle
 *    kawałkami ≤ 8 ms (setTimeout), a render() przed gotowością dokańcza je synchronicznie (determinizm),
 *  - kontekst bez depth/stencil/alpha i bez preserveDrawingBuffer (flaga w opcjach dla zrzutów),
 *  - limit boku tekstur obrazu (MAX_TEXTURE_SIZE / opcja maxTextureSide; poniżej limitu bez zmian).
 *  Tryb jakości low/med (renderScale 0.75/0.5) zmierzony i ODRZUCONY: PSNR 17–34 dB < 40 dB (speedpaint.md).
 */
import { createPaperTexture, mergePaper, PAPER_DEFAULTS, paperKey, paperUniforms, type PaperParams } from "../../paper";
import type { EffectInstance, RevealImageSource } from "../../types";
import { linkProgram, makeTexture, renderToTexture } from "./gl";
import { buildOrder, layerMinOrder, SP_ORDER_FRAG, type OrderCpu } from "./order";
import { coverageGrid, type CoverageTune } from "./coverage";
import { PACE_STEPS, paceCurve, userToInternal } from "./pace";
import { num, SPEEDPAINT_DEFAULTS, type SpParams } from "./params";
import { SP_FIELD_FRAG, SP_KUWAHARA_FRAG } from "./preShaders";
import { SP_BLIT_FRAG, SP_FRAG } from "./shaders";
import { createStrokeTable } from "./strokeTable";
import { createMainDraw } from "./draw";

export interface SpeedpaintOptions {
  /** true tylko dla zrzutów odczytywanych później niż w zadaniu render() (harness/testy). */
  preserveDrawingBuffer?: boolean;
  /** Twardy limit dłuższego boku tekstur obrazu (px), np. rozmiar wyjścia. */
  maxTextureSide?: number;
}

export interface SpeedpaintInstance extends EffectInstance {
  /** Rozwiązuje się, gdy przygotowanie (liczone w tle) jest gotowe. */
  whenReady(): Promise<void>;
  /** true, gdy przygotowanie (pole, kolejność, tablica, kalibracja tempa) jest gotowe. */
  isReady(): boolean;
  /** Analityczna mapa pokrycia (coverage.ts); null przed gotowością. `tune` tylko dla narzędzi kalibracji. */
  coverage(w: number, h: number, tune?: CoverageTune): Float32Array | null;
}

const PACE_CHUNK = 8;

function sizeOf(img: TexImageSource): { w: number; h: number } {
  if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) {
    return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  }
  const s = img as { width: number; height: number };
  return { w: s.width, h: s.height };
}

/** Zmniejsza obraz, gdy dłuższy bok > maxSide (2D canvas, jakość „high”); inaczej zwraca oryginał. */
function limitImage(img: RevealImageSource, maxSide: number): TexImageSource {
  const { w, h } = sizeOf(img);
  if (Math.max(w, h) <= maxSide) return img;
  const s = maxSide / Math.max(w, h);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const x = c.getContext("2d");
  if (!x) return img;
  x.imageSmoothingQuality = "high";
  x.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export function createSpeedpaint(canvas: HTMLCanvasElement, opts: SpeedpaintOptions = {}): SpeedpaintInstance {
  const ctx = canvas.getContext("webgl2", {
    premultipliedAlpha: false, preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false, antialias: false,
    depth: false, stencil: false, alpha: false, powerPreference: "high-performance",
  });
  if (!ctx) throw new Error("speedpaint: WebGL2 niedostępny");
  const gl: WebGL2RenderingContext = ctx;
  const vao = gl.createVertexArray();
  const fbo = gl.createFramebuffer();
  if (!vao || !fbo) throw new Error("speedpaint: brak VAO/FBO");
  const fieldProg = linkProgram(gl, SP_FIELD_FRAG);
  const kuwProg = linkProgram(gl, SP_KUWAHARA_FRAG);
  const orderProg = linkProgram(gl, SP_ORDER_FRAG);
  const blit = linkProgram(gl, SP_BLIT_FRAG);
  const blitU = {
    src: gl.getUniformLocation(blit, "u_src"), view: gl.getUniformLocation(blit, "u_view"),
    flip: gl.getUniformLocation(blit, "u_flip"), ppMode: gl.getUniformLocation(blit, "u_ppMode"),
  };
  const setBlitPaper = paperUniforms(gl, blit);
  const paperTex = createPaperTexture(gl);
  let pt: [WebGLTexture, number] | null = null; // wysokość papieru (jednostka 8), ustawiana na starcie render()
  const tex = {
    sketch: makeTexture(gl, false), painted: makeTexture(gl, true), field: makeTexture(gl, true),
    kuwA: makeTexture(gl, false), kuwB: makeTexture(gl, false), order: makeTexture(gl, false),
    orderScratch: makeTexture(gl, false), pace: makeTexture(gl, false), orderMin: makeTexture(gl, false),
  };
  gl.bindTexture(gl.TEXTURE_2D, tex.orderMin); // odczyt dokładnie jednego texela (NEAREST) — patrz layerMinOrder
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const table = createStrokeTable(gl);
  const drawMain = createMainDraw(gl, linkProgram(gl, SP_FRAG), vao, tex, table);

  let src: { sketch: RevealImageSource; painted: RevealImageSource } | null = null;
  let res: { w: number; h: number } | null = null;
  let params: SpParams = { ...SPEEDPAINT_DEFAULTS };
  let paper: PaperParams = { ...PAPER_DEFAULTS };
  let progress = 0;
  let ver = 0;
  let lastKey = "";
  let precomputed = 0; // 0..3: pole, Kuwahara ¼, Kuwahara ½ (osobne kawałki tła)
  let orderCpu: OrderCpu | null = null;
  let cov: { key: string; grid: Float32Array } | null = null;
  let orderKey = "";
  let tableKey = "";
  let paceDoneKey = "";
  let paceC: Float32Array | null = null;
  let paceWork: { key: string; frames: Uint8Array[] } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Fala 2: przygotowanie w tle bez blokowania wątku — odczyty (kolejność T, klatki kalibracji) dopiero po
  // fence'ie poprzednich przebiegów GPU; klatki kalibracji przez PIXEL_PACK_BUFFER (te same bajty co readPixels).
  let fence: WebGLSync | null = null;
  let paceFlight: { key: string; n: number; size: number } | null = null;
  const pbo = gl.createBuffer();
  let waiters: (() => void)[] = [];

  const nStages = () => Math.round(Math.min(6, Math.max(2, params.stages)));
  const brushPx = () => Math.max(4, params.brushSize * (res ? res.h : 1));
  const maxSide = () => Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, opts.maxTextureSide ?? Infinity);

  function upload(t: WebGLTexture, img: TexImageSource, mip: boolean) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
  }

  function uploadImages() {
    if (!src) return;
    const m = maxSide();
    const painted = limitImage(src.painted, m);
    upload(tex.sketch, limitImage(src.sketch, m), false);
    upload(tex.painted, painted, true);
    res = sizeOf(painted);
    precomputed = 0;
    orderCpu = null;
    orderKey = tableKey = paceDoneKey = "";
    paceWork = null;
    paceFlight = null; // klatki w locie są z poprzedniego obrazu (klucz tempa nie zawiera pikseli)
    paceC = null;
  }

  /** Pole orientacji/ważności (½, z mipami) + 2× Kuwahara (¼ i ½) — zależą tylko od obrazu. Krok `step` 0..2. */
  function precompute(w: number, h: number, step: number) {
    const bindSrc = (loc: (n: string) => WebGLUniformLocation | null) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex.painted);
      gl.uniform1i(loc("u_painted"), 0);
      gl.uniform1i(loc("u_src"), 0);
    };
    const half = { w: Math.max(1, Math.round(w / 2)), h: Math.max(1, Math.round(h / 2)) };
    const quarter = { w: Math.max(1, Math.round(w / 4)), h: Math.max(1, Math.round(h / 4)) };
    if (step === 0) {
      renderToTexture(gl, fbo, vao, fieldProg, tex.field, half.w, half.h, (loc) => {
        bindSrc(loc);
        gl.uniform2f(loc("u_size"), half.w, half.h);
      }, true);
      return;
    }
    const kuw = (dst: WebGLTexture, s: { w: number; h: number }, lod: number, radius: number) =>
      renderToTexture(gl, fbo, vao, kuwProg, dst, s.w, s.h, (loc) => {
        bindSrc(loc);
        gl.uniform2f(loc("u_size"), s.w, s.h);
        gl.uniform1f(loc("u_lod"), lod);
        gl.uniform1i(loc("u_radius"), radius);
      });
    if (step === 1) kuw(tex.kuwA, quarter, 2, 3);
    else kuw(tex.kuwB, half, 1, 3);
  }

  const orderKeyFor = () => {
    const P = params;
    return [res?.w, res?.h, P.originX, P.originY, P.seed, P.regionBias, P.frontJitter, Math.round(2.1 * brushPx())].join("|");
  };
  const tableKeyFor = () => [orderKeyFor(), nStages(), brushPx(), params.strokeLength, params.strokeDirection, params.seed].join("|");
  const paceKeyFor = () => {
    const { hold: _h, evenPace: _e, ...look } = params;
    return JSON.stringify([res?.w, res?.h, look]);
  };
  const paceNeeded = () => params.evenPace > 0 && paceKeyFor() !== paceDoneKey;

  function pending(): boolean {
    return !!res && (precomputed < 3 || orderKeyFor() !== orderKey || tableKeyFor() !== tableKey || paceNeeded());
  }

  /** true = GPU jeszcze liczy wcześniej zlecone przebiegi (sprawdzenie bez blokowania). */
  function gpuBusy(): boolean {
    if (!fence) return false;
    if (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) return true;
    gl.deleteSync(fence);
    fence = null;
    return false;
  }
  function fenceNow() {
    if (fence) gl.deleteSync(fence);
    fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /**
   * Jeden kawałek przygotowania: 0 = nic do zrobienia, 1 = zrobiony, 2 = czeka na GPU (tylko `bg`: w tle;
   * synchronicznie odczyt po prostu czeka — ten sam wynik).
   */
  function prepStep(bg: boolean): 0 | 1 | 2 {
    if (!res) return 0;
    if (precomputed < 3) {
      precompute(res.w, res.h, precomputed++);
      if (precomputed === 3) fenceNow();
      return 1;
    }
    if (orderKeyFor() !== orderKey) {
      if (bg && gpuBusy()) return 2;
      orderKey = orderKeyFor();
      orderCpu = buildOrder(gl, fbo, vao, orderProg, tex.orderScratch, tex.order, res.w, res.h, {
        painted: tex.painted, kuwA: tex.kuwA, origin: [params.originX, params.originY], seed: params.seed,
        regionBias: params.regionBias, jitter: params.frontJitter, reachPx: 2.1 * brushPx(),
      });
      return 1;
    }
    if (tableKeyFor() !== tableKey) {
      tableKey = tableKeyFor();
      const n = nStages();
      table.build(vao, tex.field, tex.order, res.w, res.h, {
        stages: n, cells: Array.from({ length: n }, (_, k) => Math.max(brushPx() * Math.pow(0.5, k), 5)),
        elong: Math.max(1, params.strokeLength), dir: params.strokeDirection, seed: params.seed,
      });
      uploadLayerMins(n);
      return 1;
    }
    if (paceFlight) {
      if (bg && gpuBusy()) return 2;
      paceCollect();
      return 1;
    }
    if (paceNeeded()) {
      paceIssue();
      if (!bg) paceCollect();
      return 1;
    }
    return 0;
  }

  /** Minima T per warstwa (od detalu w dół) dla wczesnego odrzutu — te same wzory zasięgu co layerEval w GLSL. */
  function uploadLayerMins(n: number) {
    if (!res || !orderCpu) return;
    const elong = Math.max(1, params.strokeLength);
    const reach: number[] = [];
    for (let k = n - 1; k >= Math.max(0, n - 4); k--) {
      const c = Math.max(brushPx() * Math.pow(0.5, k), 5);
      const fk0 = k / Math.max(1, n - 1);
      const el = elong * (0.65 + 0.5 * fk0);
      const hl = Math.min(c * el * 0.625, 2 * c), hw = c * 0.5 * (1.45 - 0.25 * fk0);
      reach.push(Math.sqrt(hl * hl + hw * hw + 4) + 1);
    }
    const m = layerMinOrder(orderCpu, res.w, res.h, reach);
    gl.bindTexture(gl.TEXTURE_2D, tex.orderMin);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, orderCpu.w, orderCpu.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, m);
  }

  /** Kalibracja tempa: PACE_CHUNK klatek 128 px na wywołanie (wznawialna, kluczowana parametrami) → PBO + fence. */
  function paceIssue() {
    if (!res) return;
    const key = paceKeyFor();
    if (!paceWork || paceWork.key !== key) paceWork = { key, frames: [] };
    const cw = 128;
    const ch = Math.min(4 * cw, Math.max(8, Math.round((cw * res.h) / res.w))); // E6: H/W > 4 → przycięte (≤ 512)
    gl.bindTexture(gl.TEXTURE_2D, tex.pace);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.pace, 0);
    gl.viewport(0, 0, cw, ch);
    const size = cw * ch * 4;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size * PACE_CHUNK, gl.STREAM_READ);
    let n = 0;
    for (; n < PACE_CHUNK && paceWork.frames.length + n <= PACE_STEPS; n++) {
      drawMain((paceWork.frames.length + n) / PACE_STEPS, cw, ch, res, params, nStages(), paper, true);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, n * size);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    paceFlight = { key, n, size };
    fenceNow();
  }

  function paceCollect() {
    const f = paceFlight;
    paceFlight = null;
    if (!f || !paceWork || paceWork.key !== f.key) return; // parametry zmieniły się w locie → kawałek od nowa
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    for (let i = 0; i < f.n; i++) {
      const px = new Uint8Array(f.size);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, i * f.size, px);
      paceWork.frames.push(px);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (paceWork.frames.length > PACE_STEPS) {
      const key = f.key;
      paceC = paceCurve(paceWork.frames);
      paceDoneKey = key;
      paceWork = null;
    }
  }

  function settle() {
    if (pending()) return;
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  }

  function tick() {
    timer = null;
    const t0 = performance.now();
    let r: 0 | 1 | 2 = 1;
    while (performance.now() - t0 < 8 && (r = prepStep(true)) === 1) { /* kolejne kawałki w budżecie */ }
    if (pending()) schedule(r === 2 ? 4 : 0);
    else settle();
  }

  function schedule(ms = 0) {
    if (timer === null && pending()) timer = setTimeout(tick, ms);
  }

  /** ppMode: 0 bez papieru, 1 szkic na papierze (p=0), 2 obraz gotowy (ziarno przy „przedłuż na całość”). */
  function present(t: WebGLTexture, flip: boolean, vw: number, vh: number, ppMode = 0) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, vw, vh);
    gl.bindVertexArray(vao);
    gl.useProgram(blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(blitU.src, 0);
    gl.uniform2f(blitU.view, vw, vh);
    gl.uniform1f(blitU.flip, flip ? 1 : 0);
    gl.uniform1i(blitU.ppMode, ppMode);
    setBlitPaper(paper, false, pt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    setImages(sketch, painted) {
      src = { sketch, painted };
      uploadImages();
      ver++;
      schedule();
    },
    setParams(p) {
      let changed = false;
      const next = { ...params };
      for (const key of Object.keys(SPEEDPAINT_DEFAULTS) as (keyof SpParams)[]) {
        if (p[key] === undefined) continue;
        const v = num(p[key], SPEEDPAINT_DEFAULTS[key]);
        if (v !== next[key]) { next[key] = v; changed = true; }
      }
      params = next;
      const np = mergePaper(paper, p);
      if (paperKey(np) !== paperKey(paper)) { paper = np; ver++; } // papier: tylko przerysowanie (bez przeliczeń)
      if (changed) {
        ver++;
        schedule();
      }
    },
    setProgress(p) {
      if (Number.isNaN(p)) return; // E7: NaN ignorowany (±Infinity → 0/1)
      progress = Math.min(1, Math.max(0, p));
    },
    render() {
      const vw = canvas.width;
      const vh = canvas.height;
      const key = `${progress}|${ver}|${vw}x${vh}`;
      if (key === lastKey) return;
      lastKey = key;
      if (!res) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      pt = paperTex.ensure(res.w, res.h, paper) ? [paperTex.tex, 8] : null; // przed wiązaniem tekstur (stan GL)
      if (progress >= 1) return present(tex.painted, true, vw, vh, 2);
      while (prepStep(false) === 1) { /* dokończ przygotowanie synchronicznie — wynik nie zależy od czasu */ }
      settle();
      const pInt = userToInternal(progress, params.hold, params.evenPace, params.evenPace > 0 ? paceC : null);
      if (pInt <= 0) return present(tex.sketch, true, vw, vh, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, vw, vh);
      drawMain(pInt, vw, vh, res, params, nStages(), paper, false, pt);
    },
    isReady() {
      return !!res && !pending();
    },
    coverage(w, h, tune) {
      if (!res || !orderCpu || pending()) return null;
      const n = nStages();
      const key = `${w}x${h}|${orderKey}|${n}|${paceDoneKey}|${JSON.stringify(params)}`;
      if (!tune && cov && cov.key === key) return cov.grid;
      const grid = coverageGrid(orderCpu, params, n, params.evenPace > 0 ? paceC : null, w, h, tune);
      if (!tune) cov = { key, grid };
      return grid;
    },
    whenReady() {
      if (!pending()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        schedule();
      });
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const t of Object.values(tex)) gl.deleteTexture(t);
      table.dispose();
      if (fence) gl.deleteSync(fence);
      fence = null;
      paceFlight = null;
      gl.deleteBuffer(pbo);
      drawMain.dispose();
      paperTex.dispose();
      for (const p of [fieldProg, kuwProg, orderProg, blit]) gl.deleteProgram(p);
      gl.deleteFramebuffer(fbo);
      gl.deleteVertexArray(vao);
      res = null;
      src = null;
      orderCpu = null;
      cov = null;
      paceWork = null;
      const w = waiters;
      waiters = [];
      for (const f of w) f();
    },
  };
}

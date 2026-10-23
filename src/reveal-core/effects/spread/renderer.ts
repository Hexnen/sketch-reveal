/**
 * Renderer WebGL2 efektu „spread”. Czysty WebGL2, bez zależności.
 * Przygotowanie (prep.ts): upload obrazów, analiza (CPU) i pole czasu T (Dijkstra) — w tle porcjami ≤ 8 ms,
 * cache między instancjami; isReady/whenReady. Każda klatka: jeden pass shadera (bezstanowy, skrubowalny),
 * p >= 1 → blit czystego koloru. Fala 2 (bezstratnie, klatki bajt w bajt): dirty-check w render(), uniformy
 * zależne od parametrów ustawiane tylko przy zmianie, limit boku tekstur (MAX_TEXTURE_SIZE), pełne zwalnianie
 * w dispose, `coverage(w,h)` z pola T (coverage.ts). render() przed gotowością dokańcza przygotowanie
 * synchronicznie — wynik nie zależy od czasu; przy p, w którym farba nie dotyka żadnego piksela (p=0), nie czeka.
 */
import type { EffectInstance, EffectParams, RevealImageSource } from "../../types";
import { createPaperTexture, mergePaper, PAPER_DEFAULTS, paperKey, paperUniforms, type PaperParams } from "../../paper";
import { spreadCoverage } from "./coverage";
import { DEFAULT_SPREAD, mergeSpread, type SpreadParams } from "./params";
import { createPrepJob, fieldKeyOf, type PrepJob } from "./prep";
import { BLIT_FRAG, SPREAD_FRAG, SPREAD_VERT } from "./shader";
import { spreadTail } from "./tail";

const UNIFORMS = [
  "u_sketch", "u_painted", "u_time", "u_texRes", "u_x", "u_soft", "u_brush", "u_lag", "u_lineFade",
  "u_wet", "u_seed", "u_bleed", "u_barrier", "u_cellPx", "u_tail",
] as const;
type UniformName = (typeof UNIFORMS)[number];

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("spread: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`spread: shader compile error\n${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error("spread: createProgram failed");
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`spread: link error\n${gl.getProgramInfoLog(prog)}`);
  return prog;
}


function sizeOf(src: TexImageSource) {
  return typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement
    ? { width: src.naturalWidth, height: src.naturalHeight }
    : { width: (src as { width: number }).width, height: (src as { height: number }).height };
}

/** Zmniejsza obraz, gdy dłuższy bok > maxSide (jak speedpaint); poniżej limitu zwraca oryginał (bajt w bajt). */
function limitImage(img: RevealImageSource, maxSide: number): TexImageSource {
  const { width: w, height: h } = sizeOf(img);
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

function uploadImage(gl: WebGL2RenderingContext, tex: WebGLTexture, src: TexImageSource, mips: boolean) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // uv (0,0) = lewy górny róg
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
}

export interface SpreadOptions {
  /** Domyślnie false (bez kopii bufora przy prezentacji). Zrzuty robić w tym samym zadaniu co render(). */
  preserveDrawingBuffer?: boolean;
  /** Twardy limit dłuższego boku tekstur obrazu (px); zawsze też ≤ MAX_TEXTURE_SIZE. */
  maxTextureSide?: number;
}

export interface SpreadInstance extends EffectInstance {
  isReady(): boolean;
  whenReady(): Promise<void>;
  coverage(w: number, h: number): Float32Array | null;
}

/** Budżet jednej porcji przygotowania w tle (ms). Pojedyncze kroki niepodzielne (rasteryzacja) mogą trwać dłużej. */
const PREP_BUDGET_MS = 8;

export function createSpreadRenderer(canvas: HTMLCanvasElement, opts: SpreadOptions = {}): SpreadInstance {
  // Shadery zawsze piszą alfa = 1, więc alpha:false nie zmienia pikseli (combined-perf.md K8/P5).
  const ctx = canvas.getContext("webgl2", {
    premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    depth: false, stencil: false, alpha: false, powerPreference: "high-performance",
  });
  if (!ctx) throw new Error("spread: WebGL2 niedostępny");
  const gl: WebGL2RenderingContext = ctx;

  const prog = link(gl, SPREAD_VERT, SPREAD_FRAG);
  const blit = link(gl, SPREAD_VERT, BLIT_FRAG);
  const vao = gl.createVertexArray();
  const loc = {} as Record<UniformName, WebGLUniformLocation | null>;
  for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(prog, name);
  // jednostki samplerów są stałe — ustawiane raz przy tworzeniu, nie co klatkę
  gl.useProgram(prog);
  gl.uniform1i(loc.u_sketch, 0);
  gl.uniform1i(loc.u_painted, 1);
  gl.uniform1i(loc.u_time, 2);
  gl.useProgram(blit);
  gl.uniform1i(gl.getUniformLocation(blit, "u_painted"), 1);
  const setPaper = paperUniforms(gl, prog);
  const setPaperBlit = paperUniforms(gl, blit);
  const paperTex = createPaperTexture(gl);
  const texSketch = gl.createTexture()!;
  const texPainted = gl.createTexture()!;
  const texTime = gl.createTexture()!;
  // Pole T przed pierwszym policzeniem: 1×1 zero (kompletna tekstura). Klatki, w których farba nie dotyka
  // żadnego piksela (p=0), nie zależą od T — mogą się rysować, zanim pole jest gotowe (patrz render()).
  gl.bindTexture(gl.TEXTURE_2D, texTime);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array(1));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const maxSide = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, opts.maxTextureSide ?? Infinity);

  let size: { width: number; height: number } | null = null;
  let job: PrepJob | null = null;
  let params: SpreadParams = { ...DEFAULT_SPREAD };
  let paper: PaperParams = { ...PAPER_DEFAULTS };
  let progress = 0;
  /** Wersja stanu (obrazy, parametry, papier) — dirty-check render() i uniformy zależne od parametrów. */
  let ver = 0;
  let lastKey = "";
  let uniVer = -1;
  let tail: { ver: number; t: ReturnType<typeof spreadTail> } | null = null;
  /** Klucz pola wgranego do texTime ("" = nic aktualnego). */
  let timeKey = "";
  let cov: { key: string; job: PrepJob; grid: Float32Array } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiters: (() => void)[] = [];
  let disposed = false;

  const pending = () => !!job && (job.pending(fieldKeyOf(params)) || timeKey !== fieldKeyOf(params));

  function uploadField() {
    const k = fieldKeyOf(params);
    const T = job?.field(k);
    const an = job?.analysis;
    if (!T || !an || timeKey === k) return;
    timeKey = k;
    gl.bindTexture(gl.TEXTURE_2D, texTime);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, an.gw, an.gh, 0, gl.RED, gl.FLOAT, T);
  }

  /** Posuwa przygotowanie do terminu; true = zostało coś do zrobienia. */
  function prepStep(deadline: number): boolean {
    if (!job) return false;
    const more = job.step(params, deadline);
    if (!more) uploadField();
    return more;
  }

  function settle() {
    if (pending()) return;
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  }

  function tick() {
    timer = null;
    if (disposed) return;
    prepStep(performance.now() + PREP_BUDGET_MS);
    if (pending()) schedule();
    else settle();
  }

  function schedule() {
    if (timer === null && !disposed && pending()) timer = setTimeout(tick, 0);
  }

  /** Dokończ przygotowanie synchronicznie (render przy p > 0 przed gotowością, coverage) — wynik ten sam. */
  function finishSync() {
    prepStep(Infinity);
    settle();
  }

  function tailNow() {
    if (!tail || tail.ver !== ver) tail = { ver, t: spreadTail(params) };
    return tail.t;
  }

  function draw() {
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texSketch);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texPainted);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texTime);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Uniformy zależne tylko od parametrów i rozmiaru — raz na wersję stanu (program trzyma wartości). */
  function staticUniforms(t: ReturnType<typeof spreadTail>) {
    if (uniVer === ver || !size) return;
    uniVer = ver;
    gl.uniform2f(loc.u_texRes, size.width, size.height);
    gl.uniform2f(loc.u_tail, t.tk, t.beta);
    gl.uniform1f(loc.u_soft, params.softness);
    gl.uniform1f(loc.u_brush, params.brushScale);
    gl.uniform1f(loc.u_lag, params.underpaintLag);
    gl.uniform1f(loc.u_lineFade, params.lineFade);
    gl.uniform1f(loc.u_wet, params.wetEdge);
    gl.uniform1f(loc.u_seed, params.seed);
    gl.uniform1f(loc.u_bleed, params.bleed);
    gl.uniform1f(loc.u_barrier, params.lineBarrier);
    gl.uniform1f(loc.u_cellPx, Math.max(8, size.height / 26));
  }

  return {
    setImages(sketch, painted) {
      if (disposed) return;
      gl.activeTexture(gl.TEXTURE0);
      const pa = limitImage(painted, maxSide);
      uploadImage(gl, texSketch, limitImage(sketch, maxSide), false);
      uploadImage(gl, texPainted, pa, true);
      size = sizeOf(pa);
      // analiza i pole T: z ORYGINAŁÓW (siatka ~256 px), w tle porcjami; cache po parze obrazów (prep.ts)
      job?.dispose();
      job = createPrepJob(sketch, painted);
      timeKey = "";
      cov = null;
      ver++;
      schedule();
    },
    setParams(p: Partial<EffectParams>) {
      const np = mergeSpread(params, p);
      const pp = mergePaper(paper, p);
      if (paperKey(pp) !== paperKey(paper)) ver++; // papier: tylko przerysowanie
      paper = pp;
      if (JSON.stringify(np) === JSON.stringify(params)) return;
      params = np;
      ver++;
      schedule(); // nowe pole T (jeśli zmieniły się jego klucze) liczy się w tle
    },
    setProgress(p) {
      if (Number.isNaN(p)) return; // E7: NaN ignorowany (±Infinity → 0/1)
      progress = Math.min(1, Math.max(0, p));
    },
    render() {
      if (disposed || !size) return;
      // dirty-check: ten sam stan i rozmiar bufora → płótno już pokazuje tę klatkę
      const key = `${progress}|${ver}|${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`;
      if (key === lastKey) return;
      lastKey = key;
      // wysokość papieru: tekstura liczona raz na (rozmiar, skala) — przed wiązaniem tekstur efektu (zmienia stan GL)
      const pt: [WebGLTexture, number] | null = paperTex.ensure(size.width, size.height, paper) ? [paperTex.tex, 3] : null;
      if (progress >= 1) {
        gl.useProgram(blit);
        setPaperBlit(paper, false, pt);
        draw();
        return;
      }
      // Ogon (tail.ts): p ≤ 0.65 bez zmian; potem najpóźniejsze komórki dolewają się wolniej aż do końca.
      const t = tailNow();
      const x = t.x(progress);
      // Wiek a = x − Tp ≤ x + lead (T ≥ 0, rag ≥ −0.6) — gdy < 0, żaden piksel nie jest tknięty farbą
      // (r1 = 0 → mix(...) = szkic na papierze), więc pole T nie wpływa na bajty: nie czekamy na nie.
      if (!(x + t.lead < -1e-3)) finishSync();
      else if (job && timeKey === "" && !job.pending(fieldKeyOf(params))) uploadField();
      gl.useProgram(prog);
      staticUniforms(t);
      gl.uniform1f(loc.u_x, x);
      setPaper(paper, false, pt);
      draw();
    },
    isReady: () => !pending(),
    whenReady() {
      if (!pending()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        schedule();
      });
    },
    coverage(w: number, h: number) {
      if (disposed || !job) return null;
      finishSync();
      const T = job.field(fieldKeyOf(params));
      const an = job.analysis;
      if (!T || !an) return null;
      const key = `${JSON.stringify(params)}|${w}x${h}`;
      if (cov && cov.key === key && cov.job === job) return cov.grid;
      const grid = spreadCoverage(T, an, params, w, h);
      cov = { key, job, grid };
      return grid;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      gl.deleteProgram(prog);
      gl.deleteProgram(blit);
      paperTex.dispose();
      for (const tx of [texSketch, texPainted, texTime]) gl.deleteTexture(tx);
      gl.deleteVertexArray(vao);
      job?.dispose();
      job = null;
      size = null;
      cov = null;
      tail = null;
      const w = waiters;
      waiters = [];
      for (const f of w) f(); // nikt nie czeka w nieskończoność na zwolnioną instancję
    },
  };
}

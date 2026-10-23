/**
 * Efekt `watercolor` — akwarela: mokre plamy wsiąkają i rosną z zalążków, pigment rozlewa się i
 * osiada, brzegi wyschniętych plam ciemnieją, papier granuluje, kolejne laserunki (jasny wash →
 * ciemniejsze warstwy → detal), kwiaty (backruns). Szkic = rysunek tuszem pod akwarelą.
 * Czas etapów LOKALNY (pole kolejności Tb z CPU + niezależny jitter per laserunek) → kilka etapów
 * naraz w różnych miejscach, miękkie przenikanie (wet-on-wet), nie „fala za falą”.
 * Czysty WebGL2, jeden pass na klatkę, bezstanowy (wszystko z (uv, p)) → skrubowalny w obie strony.
 * Wydajność: render pomijany bez zmian, przygotowanie w krokach (whenReady), wczesne odrzuty warstw,
 * tryb jakości (high = referencja bajt w bajt). Opis i pułapki: docs/reveal-effects/watercolor.md
 */
import { createPaperTexture, mergePaper, PAPER_DEFAULTS, paperKey, paperUniforms, type PaperParams } from "../../paper";
import type { EffectInstance, RevealEffect, RevealImageSource } from "../../types";
import { guardEffect } from "../guard";
import { coverageGrid } from "./coverage";
import { seedCellMin } from "./fields";
import { linkProgram, makeTexture } from "./gl";
import { WC_BLIT_FRAG, WC_PAPER_FRAG } from "./glslCommon";
import { PARAM_SPECS, QUALITIES, WATERCOLOR_DEFAULTS, clamp, imageSize, num, schedule, type Quality, type WcParams } from "./params";
import { createPrep } from "./prep";
import { WC_SEED_FRAG, seedLayout } from "./seeds";
import { WC_FRAG } from "./shaders";

export { WATERCOLOR_DEFAULTS, schedule } from "./params";

/**
 * Od tego p włączone przycinanie pierścienia zalążków (fala 2): wcześniej zalążki rzadko są już wyrośnięte, więc
 * przycinanie nic nie pomija, a jego księgowość kosztuje (zmierzone, watercolor.md „Fala 2”). Bezstratne w obu trybach.
 */
const PRUNE_FROM = 0.4;

const UNIFORMS = [
  "u_sketch", "u_painted", "u_paper", "u_field", "u_minTb", "u_view", "u_res", "u_p", "u_layers", "u_wet", "u_bleed",
  "u_edge", "u_gran", "u_blooms", "u_drying", "u_blob", "u_lines", "u_seed", "u_hold", "u_SP0", "u_SP", "u_D", "u_J",
  "u_Wloc", "u_thr", "u_origin", "u_debug", "u_quality", "u_seeds", "u_seedGrid", "u_maxA", "u_maxB", "u_prune", "u_cellMin",
] as const;

export interface WatercolorOptions {
  /** Domyślnie false (oszczędza kopię bufora). Zrzuty robić w tym samym zadaniu co render(). */
  preserveDrawingBuffer?: boolean;
  quality?: Quality;
}

/** Źródło przeskalowane do maxW×maxH (proporcje zachowane), gdy jest większe; inaczej oryginał. */
function fitImage(img: RevealImageSource, maxW: number, maxH: number): RevealImageSource | HTMLCanvasElement {
  const { w, h } = imageSize(img);
  const s = Math.min(1, maxW / w, maxH / h);
  if (s >= 1) return img;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const x = c.getContext("2d");
  if (!x) return img;
  x.imageSmoothingQuality = "high";
  x.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function createWatercolor(canvas: HTMLCanvasElement, opts: WatercolorOptions = {}): EffectInstance {
  const ctx = canvas.getContext("webgl2", {
    premultipliedAlpha: false, preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false, antialias: false,
    depth: false, stencil: false, alpha: false, powerPreference: "high-performance",
  });
  if (!ctx) throw new Error("watercolor: WebGL2 niedostępny");
  const gl: WebGL2RenderingContext = ctx;
  const main = linkProgram(gl, WC_FRAG);
  const blit = linkProgram(gl, WC_BLIT_FRAG);
  const paperProg = linkProgram(gl, WC_PAPER_FRAG);
  const seedProg = linkProgram(gl, WC_SEED_FRAG);
  const vao = gl.createVertexArray();
  const fbo = gl.createFramebuffer();
  if (!vao || !fbo) throw new Error("watercolor: brak VAO/FBO");
  const u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(main, n)])) as Record<
    (typeof UNIFORMS)[number],
    WebGLUniformLocation | null
  >;
  const sketchTex = makeTexture(gl, false);
  const paintedTex = makeTexture(gl, true);
  const paperTex = makeTexture(gl, false);
  const fieldTex = makeTexture(gl, false);
  const minTex = makeTexture(gl, false);
  const maxATex = makeTexture(gl, false);
  const maxBTex = makeTexture(gl, false);
  const seedTex = gl.createTexture();
  if (!seedTex) throw new Error("watercolor: createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, seedTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  let seedKey = "";
  let seedGrid = new Int32Array(24);
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  let src: { sketch: RevealImageSource; painted: RevealImageSource } | null = null;
  let res: { w: number; h: number } | null = null;
  let params: WcParams = { ...WATERCOLOR_DEFAULTS };
  let paper: PaperParams = { ...PAPER_DEFAULTS };
  const setPaperMain = paperUniforms(gl, main);
  const setPaperBlit = paperUniforms(gl, blit);
  const ppTex = createPaperTexture(gl);
  let pt: [WebGLTexture, number] | null = null; // wysokość wspólnego papieru (jednostka 6), na starcie render()
  /** Skala ziarna reliefu (granulacja) = skala wspólnego papieru. */
  const prepParams = () => ({ ...params, paperScale: paper.paperScale });
  let quality: Quality = opts.quality ?? "high";
  let sc = schedule(params.layers, params.independence);
  let progress = 0;
  let debug = 0;
  /** __prune: −1 auto (od PRUNE_FROM), 0 wył., 1 wł. — tylko pomiary; wynik bajt w bajt ten sam. */
  let prune = -1;
  let coverageOn = false;
  let version = 0;
  let lastKey = "";
  /** coverage(): cache po (siatka, rozdzielczość, parametry harmonogramu) + tożsamość pól z przygotowania. */
  let covCache: { key: string; f: object; grid: Float32Array } | null = null;

  const prep = createPrep({
    gl, fieldTex, minTex, maxATex, maxBTex, paperTex,
    allocPaper(w, h) {
      gl.bindTexture(gl.TEXTURE_2D, paperTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    },
    drawPaperStrip(w, h, y0, rows, P) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, paperTex, 0);
      gl.viewport(0, 0, w, h);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, y0, w, rows);
      gl.useProgram(paperProg);
      gl.uniform2f(gl.getUniformLocation(paperProg, "u_res"), w, h);
      gl.uniform1f(gl.getUniformLocation(paperProg, "u_ppScale"), Math.max(0.5, P.paperScale));
      gl.uniform1f(gl.getUniformLocation(paperProg, "u_seed"), P.seed % 1000);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
  });
  prep.onChange(() => { version++; });

  function upload(tex: WebGLTexture, img: RevealImageSource | HTMLCanvasElement, mip: boolean) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Upload obrazów: zawsze ≤ MAX_TEXTURE_SIZE; poza „high” także ≤ rozmiar wyjścia (canvas). */
  function uploadImages() {
    if (!src) return;
    let mw = maxTex, mh = maxTex;
    if (quality !== "high" && canvas.width > 0 && canvas.height > 0) {
      mw = Math.min(mw, canvas.width);
      mh = Math.min(mh, canvas.height);
    }
    const pa = fitImage(src.painted, mw, mh);
    const sz = imageSize(pa as RevealImageSource);
    upload(sketchTex, fitImage(src.sketch, sz.w, sz.h), false);
    upload(paintedTex, pa, true);
    res = sz;
    prep.setImage(pa as RevealImageSource, sz.w, sz.h);
    prep.setParams(prepParams());
    version++;
  }

  function bindTex(unit: number, tex: WebGLTexture) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /** Zalążki per komórka (RGBA32UI, bitowo) — przeliczane tylko przy zmianie parametrów/pól/obrazu. */
  function updateSeeds() {
    const P = params;
    const r = res as { w: number; h: number };
    const key = `${version}|${r.w}x${r.h}`;
    if (key === seedKey) return;
    seedKey = key;
    const lay = seedLayout(r.w, r.h, sc.L, Math.max(0.2, P.blobSize));
    seedGrid = lay.grid;
    gl.bindTexture(gl.TEXTURE_2D, seedTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, lay.texW, lay.texH, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, seedTex, 0);
    gl.viewport(0, 0, lay.texW, lay.texH);
    gl.useProgram(seedProg);
    const L = (n: string) => gl.getUniformLocation(seedProg, n);
    bindTex(3, fieldTex);
    gl.uniform1i(L("u_field"), 3);
    gl.uniform2f(L("u_res"), r.w, r.h);
    gl.uniform1i(L("u_layers"), sc.L);
    gl.uniform1f(L("u_wet"), clamp(P.wetness, 0, 1));
    gl.uniform1f(L("u_blob"), Math.max(0.2, P.blobSize));
    gl.uniform1f(L("u_seed"), P.seed % 1000);
    gl.uniform1f(L("u_hold"), sc.HOLD);
    gl.uniform1f(L("u_SP0"), sc.SP0);
    gl.uniform1f(L("u_SP"), sc.SP);
    gl.uniform1f(L("u_D"), sc.D);
    gl.uniform1f(L("u_J"), sc.J);
    gl.uniform1f(L("u_Wloc"), sc.Wloc);
    gl.uniform2f(L("u_origin"), P.originX, P.originY);
    gl.uniform1f(L("u_cellMin"), seedCellMin(r.w, r.h, Math.max(0.2, P.blobSize)));
    gl.uniform4iv(L("u_seedGrid"), lay.grid);
    gl.uniform1iv(L("u_seedRows"), lay.rows);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function drawMain(vw: number, vh: number) {
    const P = params;
    const r = res as { w: number; h: number };
    gl.useProgram(main);
    bindTex(0, sketchTex);
    bindTex(1, paintedTex);
    bindTex(2, paperTex);
    bindTex(3, fieldTex);
    bindTex(4, minTex);
    gl.uniform1i(u.u_sketch, 0);
    gl.uniform1i(u.u_painted, 1);
    gl.uniform1i(u.u_paper, 2);
    gl.uniform1i(u.u_field, 3);
    gl.uniform1i(u.u_minTb, 4);
    bindTex(5, seedTex);
    gl.uniform1i(u.u_seeds, 5);
    bindTex(7, maxATex);
    bindTex(8, maxBTex);
    gl.uniform1i(u.u_maxA, 7);
    gl.uniform1i(u.u_maxB, 8);
    gl.uniform4iv(u.u_seedGrid, seedGrid);
    gl.uniform2f(u.u_view, vw, vh);
    gl.uniform2f(u.u_res, r.w, r.h);
    gl.uniform1f(u.u_p, progress);
    gl.uniform1i(u.u_layers, sc.L);
    gl.uniform1f(u.u_wet, clamp(P.wetness, 0, 1));
    gl.uniform1f(u.u_bleed, Math.max(0, P.bleed));
    gl.uniform1f(u.u_edge, Math.max(0, P.edgeDark));
    gl.uniform1f(u.u_gran, Math.max(0, P.granulation));
    gl.uniform1f(u.u_blooms, clamp(P.blooms, 0, 1));
    gl.uniform1f(u.u_drying, Math.max(0, P.drying));
    gl.uniform1f(u.u_blob, Math.max(0.2, P.blobSize));
    gl.uniform1f(u.u_cellMin, seedCellMin(r.w, r.h, Math.max(0.2, P.blobSize)));
    gl.uniform1f(u.u_lines, clamp(P.lines, 0, 1));
    gl.uniform1f(u.u_seed, P.seed % 1000);
    gl.uniform1f(u.u_hold, sc.HOLD);
    gl.uniform1f(u.u_SP0, sc.SP0);
    gl.uniform1f(u.u_SP, sc.SP);
    gl.uniform1f(u.u_D, sc.D);
    gl.uniform1f(u.u_J, sc.J);
    gl.uniform1f(u.u_Wloc, sc.Wloc);
    gl.uniform1fv(u.u_thr, prep.thresholds());
    gl.uniform2f(u.u_origin, P.originX, P.originY);
    gl.uniform1i(u.u_debug, Math.round(debug)); // 1 = mapa etapów, 2 = licznik warstw (pomiary fali 2)
    gl.uniform1i(u.u_quality, QUALITIES.indexOf(quality));
    gl.uniform1i(u.u_prune, prune >= 0 ? prune : progress >= PRUNE_FROM ? 1 : 0);
    setPaperMain(paper, false, pt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    setImages(sketch, painted) {
      src = { sketch, painted };
      uploadImages();
    },
    setParams(p) {
      const next = { ...params };
      let changed = false;
      for (const key of Object.keys(WATERCOLOR_DEFAULTS) as (keyof WcParams)[]) {
        if (p[key] === undefined) continue;
        const v = num(p[key], WATERCOLOR_DEFAULTS[key]);
        if (v !== next[key]) { next[key] = v; changed = true; }
      }
      if (p.__coverage !== undefined) coverageOn = num(p.__coverage, 0) > 0;
      if (p.__prune !== undefined && num(p.__prune, -1) !== prune) { prune = num(p.__prune, -1); changed = true; }
      if (p.__debug !== undefined && num(p.__debug, 0) !== debug) { debug = num(p.__debug, 0); changed = true; }
      if (typeof p.quality === "string" && (QUALITIES as readonly string[]).includes(p.quality) && p.quality !== quality) {
        quality = p.quality as Quality;
        changed = true;
        if (src) uploadImages();
      }
      const np = mergePaper(paper, p);
      if (paperKey(np) !== paperKey(paper)) { paper = np; changed = true; }
      if (!changed) return;
      params = next;
      sc = schedule(params.layers, params.independence);
      prep.setParams(prepParams());
      version++;
    },
    setProgress(p) {
      if (!Number.isNaN(p)) progress = clamp(p, 0, 1); // E7: NaN ignorowany
    },
    isReady: () => prep.isReady(),
    coverage(w, h) {
      // Wyłączone (null → rdzeń glow czyta płótno): model CPU nie trzyma celu zgodności z klatkami (watercolor.md,
      // „Fala 2”). `__coverage: 1` włącza do pomiarów (tools/wc-coverage-test.cjs).
      if (!coverageOn) return null;
      const f = prep.fields();
      if (!res || !f || !prep.isReady() || w < 1 || h < 1) return null;
      const key = `${w}x${h}|${res.w}x${res.h}|${params.layers}|${params.independence}|${params.seed}`;
      if (!covCache || covCache.key !== key || covCache.f !== f) {
        covCache = { key, f, grid: coverageGrid({ fields: f, resW: res.w, resH: res.h, layers: params.layers, independence: params.independence, seed: params.seed }, Math.round(w), Math.round(h)) };
      }
      return covCache.grid;
    },
    whenReady: () => prep.whenReady(),
    render() {
      const vw = canvas.width;
      const vh = canvas.height;
      if (progress > 0 && progress < 1 && res && !prep.isReady()) prep.flush();
      // Brak zmian (p, parametry, obrazy, rozmiar) → canvas trzyma klatkę. Tanie klatki (p=0 szkic, p≥1 blit)
      // rysujemy zawsze — zrzut p=0 w tym samym zadaniu (useSeamTarget) działa też bez preserveDrawingBuffer.
      const key = `${progress}|${version}|${vw}x${vh}`;
      const cheap = progress <= 0 || progress >= 1;
      if (!cheap && !debug && key === lastKey) return;
      if (res) pt = ppTex.ensure(res.w, res.h, paper) ? [ppTex.tex, 6] : null; // przed stanem GL klatki
      gl.viewport(0, 0, vw, vh);
      gl.bindVertexArray(vao);
      if (!res) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      if (progress >= 1 && !debug) {
        gl.useProgram(blit);
        bindTex(0, paintedTex);
        gl.uniform1i(gl.getUniformLocation(blit, "u_painted"), 0);
        gl.uniform2f(gl.getUniformLocation(blit, "u_view"), vw, vh);
        setPaperBlit(paper, false, pt);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        lastKey = key;
        return;
      }
      updateSeeds();
      gl.viewport(0, 0, vw, vh);
      drawMain(vw, vh);
      lastKey = key;
    },
    dispose() {
      prep.dispose();
      ppTex.dispose();
      for (const t of [sketchTex, paintedTex, paperTex, fieldTex, minTex, maxATex, maxBTex, seedTex]) gl.deleteTexture(t);
      gl.deleteFramebuffer(fbo);
      gl.deleteVertexArray(vao);
      for (const p of [main, blit, paperProg, seedProg]) gl.deleteProgram(p);
      res = null;
      src = null;
      covCache = null;
    },
  };
}

export const effect: RevealEffect = {
  id: "watercolor",
  label: "Akwarela (plamy, laserunki, brzegi)",
  defaultParams: { ...WATERCOLOR_DEFAULTS, ...PAPER_DEFAULTS, quality: "high" }, // papier: reveal-core/paper.ts
  paramSpecs: PARAM_SPECS,
  choiceSpecs: [{ key: "quality", label: "Jakość", options: [...QUALITIES] }],
  scrubbable: true,
  // guardEffect: zwolnienie kontekstu po dispose + odtworzenie po utracie kontekstu (E1/E2, effects/guard.ts)
  create: (canvas: HTMLCanvasElement, opts?: WatercolorOptions) => guardEffect(canvas, (c) => createWatercolor(c, opts)),
};

export default effect;

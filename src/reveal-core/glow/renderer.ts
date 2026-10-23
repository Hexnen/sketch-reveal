/**
 * WebGL2 fazy „rozbłysk”: jeden kontekst, jedna pętla przebiegów w ½ (low: ¼) rozdzielczości dla bloomu:
 * jasny (emisja + prefiltr) → łańcuch dual-Kawase w dół (4–6 skal) → w górę z wagami skal → [smugi] →
 * kompozycja w pełnej rozdzielczości. Bufory: RGBA16F, gdy jest EXT_color_buffer_float, inaczej RGBA8 z kodowaniem.
 */
import type { GlowAnalysis } from "./analyze";
import type { Ignition } from "./ignite";
import { MAX_LAMPS, TABLE_SIZE } from "./ignite";
import type { GlowParams } from "./params";
import { FS_BLIT, FS_BRIGHT, FS_COMPOSITE, FS_DOWN, FS_IDLE, FS_SRCMAP, FS_STREAK, FS_UP, VS } from "./shaders";
import { nearestCompMap } from "./nearest";

/** Najwyższe podniesienie Y ciemnego piksela szarym światłem (sRGB 0..1; barwne światło ma do 4× więcej). */
const DARK_CAP = 22 / 255;
/** Ogon poświaty poniżej tej luminancji liniowej jest odcinany (skończony zasięg bloomu dużych źródeł). */
const BLOOM_FLOOR = 0.008;

interface Prog { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }
interface RT { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }

export interface GlowRenderer {
  /** Kontekst (odroczone zwolnienie po dispose — sketchIntro/glContext.ts). */
  gl: WebGL2RenderingContext;
  maxSide: number;
  floatRT: boolean;
  setImage(src: TexImageSource, w: number, h: number): void;
  setAnalysis(an: GlowAnalysis | null): void;
  /**
   * p ≤ 0 lub brak analizy → kopia obrazu 1:1 (w trybie przyrostu: czerń). `bloomCap` (K7, tylko jakość med/low) =
   * największy bok bazy łańcucha bloomu [px]; 0/brak = bez limitu (high: baza = ½ wyjścia, piksele bez zmian).
   */
  draw(ig: Ignition | null, prm: GlowParams, outW: number, outH: number, bloomCap?: number): void;
  /**
   * Tania klatka życia (K6, jakość med/low): `ig0` = stan końcowy (idle 0) pod kluczem `key` — liczony pełnym
   * łańcuchem do pamięci podręcznej tylko przy zmianie klucza; potem jedna kompozycja: zapamiętany × stosunek
   * poziomu najbliższego źródła (ig vs ig0). false = niedostępne (wołający rysuje pełną drogą).
   */
  drawIdle(ig: Ignition, ig0: () => Ignition, key: string, prm: GlowParams, outW: number, outH: number, bloomCap?: number): boolean;

  /** 0 = pełny obraz + światło, 1 = sam przyrost (CSS plus-lighter), 2 = przyrost kodowany pod CSS screen. */
  setMode(mode: 0 | 1 | 2): void;
  /** Zwolnienie łańcucha FBO i mapy źródeł (stan końcowy narysowany); następny draw odtworzy je leniwie. */
  release(): void;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

export function createGlowRenderer(canvas: HTMLCanvasElement, preserveDrawingBuffer = false, forceLdr = false): GlowRenderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer, depth: false, stencil: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;
  const floatRT = !forceLdr && !!gl.getExtension("EXT_color_buffer_float");
  const shaders: WebGLShader[] = [];
  const vs = compile(gl, gl.VERTEX_SHADER, VS); shaders.push(vs);
  const progs: Prog[] = [];
  const mk = (fs: string): Prog => {
    const p = gl.createProgram()!;
    const f = compile(gl, gl.FRAGMENT_SHADER, fs); shaders.push(f);
    gl.attachShader(p, vs); gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    const pr = { p, u: new Map<string, WebGLUniformLocation | null>() };
    progs.push(pr);
    return pr;
  };
  const P = { bright: mk(FS_BRIGHT), down: mk(FS_DOWN), up: mk(FS_UP), streak: mk(FS_STREAK), blit: mk(FS_BLIT), comp: mk(FS_COMPOSITE), srcmap: mk(FS_SRCMAP), idle: mk(FS_IDLE) };
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const maxSide = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

  const U = (pr: Prog, n: string) => {
    if (!pr.u.has(n)) pr.u.set(n, gl.getUniformLocation(pr.p, n));
    return pr.u.get(n)!;
  };
  const newTex = (filter: number) => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const img = newTex(gl.LINEAR), ana = newTex(gl.LINEAR), tab = newTex(gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, tab);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TABLE_SIZE, 1, 0, gl.RGBA, gl.FLOAT, null);
  /** K6: stan końcowy (RGBA8, rozmiar wyjścia) + tabela poziomów idle 0 + mapa najbliższego komponentu (R8, analiza). */
  let idleRT: RT | null = null, idleKey = "", idleT0: Float32Array | null = null;
  let near: WebGLTexture | null = null, ratio: WebGLTexture | null = null, curAn: GlowAnalysis | null = null;
  const ratioBuf = new Float32Array(TABLE_SIZE * 4);
  const freeIdle = () => { if (idleRT) { gl.deleteTexture(idleRT.tex); gl.deleteFramebuffer(idleRT.fb); idleRT = null; } idleKey = ""; idleT0 = null; };
  let iw = 1, ih = 1, aw = 1, ah = 1, hasAna = false, mode: 0 | 1 | 2 = 0;
  /** Mapa źródeł (RGBA16F, rozdzielczość analizy) — tylko z float RT; bez nich shader liczy srcAt ręcznie. */
  let srcMap: RT | null = null;

  let rts: { down: RT[]; up: RT[]; streak: RT[]; key: string } = { down: [], up: [], streak: [], key: "" };
  const newRT = (w: number, h: number, ldr = false): RT => {
    const tex = newTex(gl.LINEAR);
    if (floatRT && !ldr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  };
  const freeRTs = () => {
    for (const r of [...rts.down, ...rts.up, ...rts.streak]) { gl.deleteTexture(r.tex); gl.deleteFramebuffer(r.fb); }
    rts = { down: [], up: [], streak: [], key: "" };
  };
  /** Łańcuch skal: baza = ½ (low: ¼) rozmiaru wyjścia, ograniczona do obrazu i (med/low) do `cap` (dłuższy bok). */
  const ensureRTs = (ow: number, oh: number, q: GlowParams["quality"], cap = 0) => {
    const div = q === "low" ? 4 : 2, levels = q === "high" ? 6 : q === "med" ? 5 : 4;
    let bw = Math.max(1, Math.ceil(ow / div)), bh = Math.max(1, Math.ceil(oh / div));
    if (cap > 0 && Math.max(bw, bh) > cap) { const k = cap / Math.max(bw, bh); bw = Math.max(1, Math.round(bw * k)); bh = Math.max(1, Math.round(bh * k)); }
    const key = `${bw}x${bh}x${levels}`;
    if (rts.key === key) return;
    freeRTs();
    let w = bw, h = bh;
    for (let i = 0; i < levels; i++) {
      rts.down.push(newRT(w, h)); rts.up.push(newRT(w, h));
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
    }
    // smugi: poziomo ¼ bazy (szeroki ogon tanio), pionowo pełna baza (cienkie linie)
    const s0 = rts.down[0];
    rts.streak.push(newRT(Math.max(1, Math.ceil(s0.w / 4)), s0.h), newRT(Math.max(1, Math.ceil(s0.w / 4)), s0.h));
    rts.key = key;
  };

  const freeSrcMap = () => { if (srcMap) { gl.deleteTexture(srcMap.tex); gl.deleteFramebuffer(srcMap.fb); srcMap = null; } };
  const bindTex = (unit: number, t: WebGLTexture) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); };
  const pass = (pr: Prog, target: RT | null, w: number, h: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(pr.p);
    gl.uniform2f(U(pr, "uOut"), w, h);
    gl.uniform1i(U(pr, "uEnc"), floatRT ? 0 : 1);
  };
  const lightUniforms = (pr: Prog, prm: GlowParams) => {
    bindTex(0, img); bindTex(1, ana); bindTex(2, tab);
    gl.uniform1i(U(pr, "uImg"), 0); gl.uniform1i(U(pr, "uAna"), 1); gl.uniform1i(U(pr, "uTab"), 2);
    if (srcMap) bindTex(5, srcMap.tex);
    gl.uniform1i(U(pr, "uSrcMap"), 5); gl.uniform1i(U(pr, "uUseMap"), srcMap ? 1 : 0);
    gl.uniform2f(U(pr, "uAnaSize"), aw, ah);
    gl.uniform1f(U(pr, "uThr"), prm.threshold); gl.uniform1f(U(pr, "uKnee"), prm.knee); gl.uniform1f(U(pr, "uSatB"), prm.saturationBias);
  };
  const draw3 = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  return {
    gl, maxSide, floatRT,
    setImage(src, w, h) {
      iw = w; ih = h; freeIdle();
      gl.bindTexture(gl.TEXTURE_2D, img);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    },
    setAnalysis(an) {
      hasAna = !!an;
      if (an !== curAn) { freeIdle(); if (near) { gl.deleteTexture(near); near = null; } }
      curAn = an;
      if (!an) return;
      aw = an.aw; ah = an.ah;
      freeSrcMap();
      gl.bindTexture(gl.TEXTURE_2D, ana);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, aw, ah, 0, gl.RGBA, gl.UNSIGNED_BYTE, an.tex);
    },
    draw(ig, prm, ow, oh, cap = 0) {
      if (!ig || !hasAna) {
        pass(P.blit, null, ow, oh); bindTex(0, img); gl.uniform1i(U(P.blit, "uImg"), 0); gl.uniform1i(U(P.blit, "uMode"), mode); draw3();
        return;
      }
      full(ig, prm, ow, oh, cap, null);
    },
    drawIdle(ig, ig0, key, prm, ow, oh, cap = 0) {
      if (!hasAna || !curAn) return false;
      if (!near) {
        near = newTex(gl.NEAREST);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, aw, ah, 0, gl.RED, gl.UNSIGNED_BYTE, nearestCompMap(curAn));
      }
      if (!ratio) { ratio = newTex(gl.NEAREST); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TABLE_SIZE, 1, 0, gl.RGBA, gl.FLOAT, null); }
      if (!idleRT || idleRT.w !== ow || idleRT.h !== oh || idleKey !== key) {
        if (!idleRT || idleRT.w !== ow || idleRT.h !== oh) { freeIdle(); idleRT = newRT(ow, oh, true); }
        const g0 = ig0();
        full(g0, prm, ow, oh, cap, idleRT);
        idleKey = key; idleT0 = g0.table.slice();
      }
      const t0 = idleT0!, t = ig.table;
      for (let i = 0; i < TABLE_SIZE; i++) { const a = t0[i * 4]; ratioBuf[i * 4] = a > 0 ? t[i * 4] / a : 1; }
      gl.bindTexture(gl.TEXTURE_2D, ratio);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TABLE_SIZE, 1, gl.RGBA, gl.FLOAT, ratioBuf);
      const I = P.idle;
      pass(I, null, ow, oh);
      bindTex(0, idleRT!.tex); bindTex(1, near); bindTex(2, ratio); bindTex(3, img);
      gl.uniform1i(U(I, "uCache"), 0); gl.uniform1i(U(I, "uNear"), 1); gl.uniform1i(U(I, "uRatio"), 2); gl.uniform1i(U(I, "uImg"), 3);
      gl.uniform2f(U(I, "uAnaSize"), aw, ah); gl.uniform1i(U(I, "uMode"), mode);
      draw3();
      return true;
    },
    setMode(m) { mode = m; freeIdle(); },
    release() { freeRTs(); freeSrcMap(); freeIdle(); },
    dispose() {
      freeRTs();
      freeSrcMap();
      freeIdle();
      for (const t of [img, ana, tab, near, ratio]) if (t) gl.deleteTexture(t);
      for (const p of progs) gl.deleteProgram(p.p);
      for (const s of shaders) gl.deleteShader(s);
      gl.deleteBuffer(buf); gl.deleteVertexArray(vao);
    },
  };

  /** Pełna droga: mapa źródeł → jasny → łańcuch → [smugi] → kompozycja do `target` (null = ekran). */
  function full(ig: Ignition, prm: GlowParams, ow: number, oh: number, cap: number, target: RT | null) {
      if (!gl) return; // (zawężenie typu w deklaracji funkcji)
      ensureRTs(ow, oh, prm.quality, cap);
      if (floatRT && !srcMap) srcMap = newRT(aw, ah);
      gl.bindTexture(gl.TEXTURE_2D, tab);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TABLE_SIZE, 1, gl.RGBA, gl.FLOAT, ig.table);
      const D = rts.down, Up = rts.up, n = D.length;
      if (srcMap) {
        pass(P.srcmap, srcMap, aw, ah);
        bindTex(1, ana); bindTex(2, tab);
        gl.uniform1i(U(P.srcmap, "uAna"), 1); gl.uniform1i(U(P.srcmap, "uTab"), 2);
        draw3();
      }
      // jasny
      pass(P.bright, D[0], D[0].w, D[0].h);
      lightUniforms(P.bright, prm);
      gl.uniform2f(U(P.bright, "uImgTexel"), 1 / iw, 1 / ih);
      gl.uniform1f(U(P.bright, "uGain"), 1);
      gl.uniform1i(U(P.bright, "uPre"), prm.quality === "low" ? 0 : 1);
      draw3();
      // w dół
      for (let i = 1; i < n; i++) {
        pass(P.down, D[i], D[i].w, D[i].h);
        bindTex(0, D[i - 1].tex); gl.uniform1i(U(P.down, "uSrc"), 0);
        gl.uniform2f(U(P.down, "uTexel"), 1 / D[i - 1].w, 1 / D[i - 1].h);
        draw3();
      }
      // wagi skal: radius przesuwa energię ku szerokim skalom
      const rk = 0.55 + prm.radius * 0.95;
      const w: number[] = []; let ws = 0;
      for (let i = 0; i < n; i++) { w.push(Math.pow(rk, i)); ws += w[i]; }
      // w górę: U[n-1] = D[n-1]·w, U[i] = up(U[i+1]) + D[i]·w
      pass(P.up, Up[n - 1], Up[n - 1].w, Up[n - 1].h);
      bindTex(0, D[n - 1].tex); bindTex(1, D[n - 1].tex);
      gl.uniform1i(U(P.up, "uSrc"), 0); gl.uniform1i(U(P.up, "uSelf"), 1);
      gl.uniform2f(U(P.up, "uTexel"), 1 / D[n - 1].w, 1 / D[n - 1].h);
      gl.uniform1f(U(P.up, "uW"), w[n - 1] / ws); gl.uniform1f(U(P.up, "uWsrc"), 0);
      draw3();
      for (let i = n - 2; i >= 0; i--) {
        pass(P.up, Up[i], Up[i].w, Up[i].h);
        bindTex(0, Up[i + 1].tex); bindTex(1, D[i].tex);
        gl.uniform1i(U(P.up, "uSrc"), 0); gl.uniform1i(U(P.up, "uSelf"), 1);
        gl.uniform2f(U(P.up, "uTexel"), 1 / Up[i + 1].w, 1 / Up[i + 1].h);
        gl.uniform1f(U(P.up, "uW"), w[i] / ws); gl.uniform1f(U(P.up, "uWsrc"), 1);
        draw3();
      }
      // smugi (opcjonalne, nie w low)
      const streak = prm.streaks > 0 && prm.quality !== "low";
      if (streak) {
        const S = rts.streak;
        let src = D[0].tex;
        [1, 4, 16].forEach((step, k) => {
          const dst = S[k & 1];
          pass(P.streak, dst, dst.w, dst.h);
          bindTex(0, src); gl.uniform1i(U(P.streak, "uSrc"), 0);
          gl.uniform2f(U(P.streak, "uTexel"), 1 / dst.w, 1 / dst.h);
          gl.uniform1f(U(P.streak, "uStep"), step);
          gl.uniform1f(U(P.streak, "uCut"), k === 0 ? 0.25 : 0); // tylko gorące rdzenie dają smugę
          draw3();
          src = dst.tex;
        });
      }
      // kompozycja
      const C = P.comp;
      pass(C, target, ow, oh);
      lightUniforms(C, prm);
      bindTex(3, Up[0].tex); gl.uniform1i(U(C, "uBloom"), 3);
      bindTex(4, streak ? rts.streak[0].tex : Up[0].tex); gl.uniform1i(U(C, "uStreak"), 4);
      gl.uniform1f(U(C, "uCore"), 2.2 * prm.intensity);
      gl.uniform1f(U(C, "uBloomAmt"), 4.5 * prm.intensity);
      gl.uniform1f(U(C, "uWrap"), 0.3);
      gl.uniform1f(U(C, "uStreakAmt"), streak ? prm.streaks * 3 * prm.intensity : 0);
      gl.uniform1f(U(C, "uHalo"), prm.haloLamp);
      gl.uniform1f(U(C, "uRadius"), prm.radius);
      gl.uniform1f(U(C, "uContrast"), prm.contrast);
      gl.uniform1f(U(C, "uGlobal"), ig.global);
      gl.uniform1f(U(C, "uAspect"), iw / ih);
      gl.uniform4fv(U(C, "uLamp"), ig.lamps.subarray(0, MAX_LAMPS * 4));
      gl.uniform4fv(U(C, "uLampCol"), ig.lampColors.subarray(0, MAX_LAMPS * 4));
      gl.uniform1i(U(C, "uNL"), ig.nLamps);
      gl.uniform4fv(U(C, "uRefl"), ig.refl.subarray(0, MAX_LAMPS * 4));
      gl.uniform4fv(U(C, "uReflCol"), ig.reflColors.subarray(0, MAX_LAMPS * 4));
      gl.uniform1i(U(C, "uNR"), ig.nRefl);
      gl.uniform1f(U(C, "uReflAmt"), 1.6 * prm.intensity);
      gl.uniform1f(U(C, "uDarkCap"), DARK_CAP);
      gl.uniform1f(U(C, "uBloomFloor"), BLOOM_FLOOR);
      gl.uniform1i(U(C, "uMode"), mode);
      draw3();
  }
}

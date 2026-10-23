/**
 * Render fazy szkicu. Domyślnie WebGL2 (fragment shader czyta pole T z tekstury RG32F i szkic z RGBA8):
 * koszt klatki ~stały niezależnie od rozdzielczości — 4K płynnie, a pole T może mieć niższą
 * rozdzielczość niż obraz (analiza na pomniejszonej kopii). Fallback 2D (typed arrays) dla braku WebGL2.
 * Płótno ma rozmiar wyświetlania × devicePixelRatio (index.ts), szkic próbkowany liniowo z mipmapami,
 * pole T interpolowane dwuliniowo — brak pikselozy przy skalowaniu. Przy płótnie = rozmiar szkicu
 * próbki trafiają w środki tekseli → p=1 piksel w piksel.
 * Tryby: 0 = czysty papier, 1 = rysowanie, 2 = szkic (p ≥ 1).
 */

import { paperUniforms, PAPER_DEFAULTS, type PaperParams } from "../paper";
import { FS, MAX_PENS } from "./shader";

export { MAX_PENS };

export interface IntroRenderer {
  /** "gl" renderuje w dowolnym rozmiarze płótna; "2d" tylko w rozmiarze szkicu (CSS skaluje). */
  kind: "gl" | "2d";
  /** Kontekst WebGL2 (tylko "gl") — dla odroczonego zwolnienia po dispose (glContext.ts). */
  gl?: WebGL2RenderingContext;
  /**
   * Szkic jako źródło tekstury (płótno 2D w rozmiarze w×h, już na białym tle) — upload GPU→GPU bez getImageData
   * w pełnej rozdzielczości. `pixels()` daje RGBA na żądanie (leniwie: tylko szew z celem i fallback 2D).
   */
  setSketch(src: TexImageSource, w: number, h: number, pixels: () => Uint8ClampedArray): void;
  /** Największy bok tekstury, jaki przyjmie renderer. */
  maxSide: number;
  /**
   * Wspólny papier (reveal-core/paper.ts) dla trybu bez celu; imgScale = px obrazu / px tekstury.
   * Z celem papier pochodzi z klatki p=0 efektu (bajt w bajt). Fallback 2D: bez papieru (biel).
   */
  setPaper(p: PaperParams, imgScale: number): void;
  /** Klatka p=0 efektu (ten sam rozmiar co szkic) albo null = kończ na szkicu na wspólnym papierze. */
  setTarget(rgba: Uint8ClampedArray | null): void;
  setField(field: Float32Array | null, aw: number, ah: number): void;
  /** mode 0/1/2, t = czas znormalizowany, pens = 8 floatów/pióro (pens.ts), fresh = okno świeżego grafitu. */
  draw(mode: 0 | 1 | 2, t: number, pens: Float32Array, nPens: number, fresh: number, soft?: number): void;
  dispose(): void;
}

const VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** Średni kolor „papieru” celu: piksele, gdzie szkic jest prawie biały. */
function paperOf(target: Uint8ClampedArray, sketch: Uint8ClampedArray): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let o = 0; o < sketch.length; o += 4 * 7) {
    if (sketch[o] + sketch[o + 1] + sketch[o + 2] < 735) continue;
    r += target[o]; g += target[o + 1]; b += target[o + 2]; n++;
  }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : [1, 1, 1];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

function createGl(canvas: HTMLCanvasElement): IntroRenderer | null {
  // bez preserveDrawingBuffer/depth/stencil: mniej pamięci i brak kopii przy prezentacji (klatki czytane tylko
  // w tym samym zadaniu co render — harness/zrzuty)
  const gl = canvas.getContext("webgl2", {
    alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false, depth: false, stencil: false,
  });
  if (!gl) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(prog, n);
  const u = { sketch: U("uSketch"), target: U("uTarget"), field: U("uField"), size: U("uSize"), out: U("uOut"),
    fsize: U("uFieldSize"), paper: U("uPaper"), t: U("uT"), mode: U("uMode"), fresh: U("uFresh"), soft: U("uSoft"),
    pens: U("uPens"), penB: U("uPenB"), np: U("uNP"), hasTarget: U("uHasTarget"), imgScale: U("uImgScale") };
  const setPaperU = paperUniforms(gl, prog);
  let paperP: PaperParams = { ...PAPER_DEFAULTS }, imgScale = 1;
  const tex = () => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const tSketch = tex(), tField = tex(), tTarget = tex();
  let w = 1, h = 1, aw = 1, ah = 1, hasField = false, hasTarget = false;
  let sketchPx: (() => Uint8ClampedArray) | null = null;
  let paper: [number, number, number] = [1, 1, 1];
  const upload = (t: WebGLTexture, rgba: Uint8ClampedArray | TexImageSource) => {
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (ArrayBuffer.isView(rgba)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  };
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const penA = new Float32Array(MAX_PENS * 4), penB = new Float32Array(MAX_PENS * 4);
  return {
    kind: "gl", gl,
    maxSide: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    setSketch(src, W, H, pixels) {
      w = W; h = H; sketchPx = pixels; hasTarget = false; paper = [1, 1, 1];
      upload(tSketch, src);
    },
    setPaper(p, k) { paperP = p; imgScale = k; },
    setTarget(rgba) {
      hasTarget = !!rgba && !!sketchPx && rgba.length === w * h * 4;
      if (!hasTarget) { paper = [1, 1, 1]; return; }
      upload(tTarget, rgba!);
      paper = paperOf(rgba!, sketchPx!());
    },
    setField(field, AW, AH) {
      hasField = !!field;
      if (!field) return;
      aw = AW; ah = AH;
      gl.bindTexture(gl.TEXTURE_2D, tField);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, aw, ah, 0, gl.RG, gl.FLOAT, field);
    },
    draw(mode, t, pens, nPens, fresh, soft = 1) {
      if (mode === 1 && !hasField) mode = 0;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tSketch);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tField);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, hasTarget ? tTarget : tSketch);
      gl.uniform1i(u.sketch, 0); gl.uniform1i(u.field, 1); gl.uniform1i(u.target, 2);
      gl.uniform3f(u.paper, paper[0], paper[1], paper[2]);
      gl.uniform1i(u.hasTarget, hasTarget ? 1 : 0); gl.uniform1f(u.imgScale, imgScale);
      setPaperU(paperP);
      gl.uniform2f(u.size, w, h); gl.uniform2f(u.out, canvas.width, canvas.height); gl.uniform2f(u.fsize, aw, ah);
      gl.uniform1f(u.t, t); gl.uniform1i(u.mode, mode); gl.uniform1f(u.fresh, fresh); gl.uniform1f(u.soft, soft);
      const np = Math.min(MAX_PENS, nPens);
      penA.fill(0); penB.fill(0);
      for (let i = 0; i < np; i++) for (let c = 0; c < 4; c++) { penA[i * 4 + c] = pens[i * 8 + c]; penB[i * 4 + c] = pens[i * 8 + 4 + c]; }
      gl.uniform4fv(u.pens, penA); gl.uniform4fv(u.penB, penB); gl.uniform1i(u.np, np);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      // bez loseContext(): ten sam <canvas> może dostać nową instancję (StrictMode/remount) — utracony kontekst
      // zostałby zwrócony ponownie przez getContext i nakładka zostałaby biała na zawsze
      gl.deleteTexture(tSketch); gl.deleteTexture(tField); gl.deleteTexture(tTarget); gl.deleteBuffer(buf); gl.deleteProgram(prog);
    },
  };
}

const CROSSFADE_PX = 1_000_000;

/** Fallback 2D: ta sama formuła na CPU; powyżej ~1 Mpx — tanie przenikanie (bez WebGL2 animacja per piksel to sekundy). */
function create2d(canvas: HTMLCanvasElement): IntroRenderer {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Brak kontekstu 2D");
  let sk: Uint8ClampedArray | null = null, field: Float32Array | null = null;
  let w = 0, h = 0, aw = 0, ah = 0, frame: ImageData | null = null, img: TexImageSource | null = null;
  return {
    kind: "2d",
    maxSide: 16384,
    setSketch(src, W, H, pixels) {
      w = W; h = H; img = src;
      // duży szkic bez WebGL2: formuła per piksel na CPU to sekundy na klatkę → przenikanie papier→szkic
      if (w * h > CROSSFADE_PX) { sk = null; frame = null; return; }
      sk = pixels(); frame = ctx.createImageData(w, h);
    },
    setPaper() { /* fallback 2D: papier pominięty (czysta biel) */ },
    setTarget(rgba) { if (rgba && sk && rgba.length === sk.length) sk = rgba; },
    setField(f, AW, AH) { field = f; aw = AW; ah = AH; },
    draw(mode, t, pens, nPens, fresh) {
      if (!sk && img) {
        ctx.globalAlpha = 1; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        const a = mode === 2 ? 1 : mode === 0 ? 0 : Math.min(1, t / 0.97);
        ctx.globalAlpha = a * a * (3 - 2 * a); ctx.drawImage(img as CanvasImageSource, 0, 0, w, h); ctx.globalAlpha = 1;
        return;
      }
      if (!sk || !frame) return;
      if (mode === 1 && !field) mode = 0;
      const d = frame.data;
      if (mode === 2) d.set(sk);
      else if (mode === 0) d.fill(255);
      else {
        const sx = aw / w, sy = ah / h;
        for (let y = 0; y < h; y++) {
          const fy = Math.min(ah - 1, (y * sy) | 0) * aw;
          for (let x = 0; x < w; x++) {
            const i = y * w + x, o = i * 4, fi = (fy + Math.min(aw - 1, (x * sx) | 0)) * 2;
            const age = t - field![fi];
            const m = Math.max(0, Math.min(1, age / Math.max(field![fi + 1], 1e-5)));
            let k = 1;
            if (fresh > 0 && m > 0 && age < fresh) {
              const z = age / fresh, inkv = 1 - (0.299 * sk[o] + 0.587 * sk[o + 1] + 0.114 * sk[o + 2]) / 255;
              k = 1 - 0.35 * inkv * m * (1 - z * z * (3 - 2 * z));
            }
            for (let c = 0; c < 3; c++) d[o + c] = (255 + (sk[o + c] - 255) * m) * k;
            d[o + 3] = 255;
          }
        }
      }
      ctx.putImageData(frame, 0, 0);
      ctx.fillStyle = "rgba(26,26,30,0.9)";
      for (let i = 0; i < Math.min(nPens, MAX_PENS); i++) {
        ctx.globalAlpha = pens[i * 8 + 3];
        ctx.beginPath(); ctx.arc(pens[i * 8], pens[i * 8 + 1], pens[i * 8 + 2], 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
    dispose() { sk = null; field = null; frame = null; img = null; },
  };
}

export function createIntroRenderer(canvas: HTMLCanvasElement): IntroRenderer {
  try {
    const r = createGl(canvas);
    if (r) return r;
  } catch { /* brak/odrzucony WebGL2 → 2D */ }
  return create2d(canvas);
}

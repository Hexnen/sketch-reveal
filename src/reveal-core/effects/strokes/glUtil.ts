/** Drobne pomocniki WebGL2 efektu „strokes”: programy, tekstury obrazów, bufory akumulacji. */
import type { RevealImageSource } from "../../types";

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("strokes: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`strokes: shader compile error\n${log}`);
  }
  return sh;
}

export function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error("strokes: createProgram failed");
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`strokes: link error\n${gl.getProgramInfoLog(prog)}`);
  return prog;
}

export function uploadImage(gl: WebGL2RenderingContext, tex: WebGLTexture, src: RevealImageSource, mips = false) {
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

/** Tekstura RGBA8 + FBO (premultiplied, start = przezroczysta). */
export interface Accum {
  w: number;
  h: number;
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  clear(): void;
  /** Kopiuje zawartość do `dst` (ten sam rozmiar) przez blitFramebuffer. */
  copyTo(dst: Accum): void;
  free(): void;
}

export function createAccum(gl: WebGL2RenderingContext, w: number, h: number): Accum {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) throw new Error("strokes: brak tekstury/FBO");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const acc: Accum = {
    w,
    h,
    tex,
    fbo,
    clear() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    copyTo(dst) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, dst.w, dst.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    },
    free() {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
    },
  };
  acc.clear();
  return acc;
}

/** Obraz zmniejszony do boku ≤ max (canvas 2D); gdy już mieści się — ten sam obiekt (bez zmian bajtów). */
export function limitImage(src: RevealImageSource, max: number): RevealImageSource | HTMLCanvasElement {
  const w = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const h = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  if (Math.max(w, h) <= max) return src;
  const k = max / Math.max(w, h);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext("2d")?.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

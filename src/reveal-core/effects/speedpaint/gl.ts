/** Drobne pomocniki WebGL2 efektu `speedpaint` (bez zależności). */
import { SP_VERT } from "./shaders";

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("speedpaint: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`speedpaint: shader compile error\n${log}`);
  }
  return sh;
}

/** Program = pełnoekranowy trójkąt (SP_VERT) + podany fragment shader. */
export function linkProgram(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error("speedpaint: createProgram failed");
  const v = compile(gl, gl.VERTEX_SHADER, SP_VERT);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`speedpaint: link error\n${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

export function makeTexture(gl: WebGL2RenderingContext, mip: boolean): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error("speedpaint: createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/**
 * Renderuje `prog` do tekstury `dst` (RGBA8, w×h). `setup` ustawia uniformy/tekstury wejściowe.
 * Opcjonalnie generuje mipmapy wyniku (wygładzanie pola).
 */
export function renderToTexture(
  gl: WebGL2RenderingContext,
  fbo: WebGLFramebuffer,
  vao: WebGLVertexArrayObject,
  prog: WebGLProgram,
  dst: WebGLTexture,
  w: number,
  h: number,
  setup: (loc: (name: string) => WebGLUniformLocation | null) => void,
  mip = false,
): void {
  gl.bindTexture(gl.TEXTURE_2D, dst);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
  gl.viewport(0, 0, w, h);
  gl.useProgram(prog);
  setup((name) => gl.getUniformLocation(prog, name));
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (mip) {
    gl.bindTexture(gl.TEXTURE_2D, dst);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
}

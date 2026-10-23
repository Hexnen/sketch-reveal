/** Drobne pomocniki WebGL2 efektu `watercolor` (bez zależności). */
import { WC_VERT } from "./glslCommon";

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("watercolor: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`watercolor: shader compile error\n${log}`);
  }
  return sh;
}

/** Program = pełnoekranowy trójkąt + podany fragment shader. */
export function linkProgram(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error("watercolor: createProgram failed");
  const v = compile(gl, gl.VERTEX_SHADER, WC_VERT);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`watercolor: link error\n${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

export function makeTexture(gl: WebGL2RenderingContext, mip: boolean): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error("watercolor: createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

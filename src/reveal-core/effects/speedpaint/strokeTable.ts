/**
 * Tablica pociągnięć `speedpaint`: wszystko, co zależy tylko od komórki siatki (pozycja, kąt z tensora,
 * długość/szerokość, T w punkcie, seria, id) liczone RAZ (przy zmianie obrazu/parametrów) do dwóch
 * atlasów RGBA8 — warstwy ułożone pionowo, z marginesem MARGIN komórek wokół obrazu. Pętla 5×5 w
 * shaderze klatki robi wtedy 2× texelFetch zamiast hashy, 2 fetchy pola/T, atan i sin/cos.
 *
 *  A = (jitter.x, jitter.y, kąt/π (mod 1), T)      B = (hl/(2c), hw/c, id, seria/0.65)
 */
import { linkProgram } from "./gl";

export const TABLE_MARGIN = 3;

const TABLE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_field;
uniform sampler2D u_order;
uniform vec2 u_res;
uniform float u_c;        // komórka warstwy (px)
uniform int u_k;
uniform int u_stages;
uniform int u_rowOff;
uniform float u_margin;
uniform float u_elong;
uniform float u_dir;
uniform float u_seed;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + u_seed * 0.0137);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + u_seed * 0.0219);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
void main() {
  vec2 cell = floor(gl_FragCoord.xy) - vec2(0.0, float(u_rowOff));
  vec2 cid = cell - u_margin;
  float c = u_c;
  float k = float(u_k);
  float fk0 = k / max(1.0, float(u_stages - 1));
  vec2 key = cid + k * vec2(17.1, 5.3);
  vec2 h = hash22(key);
  vec2 site = (cid + 0.5 + (h - 0.5) * 0.9) * c;
  vec2 suv = clamp(site / u_res, 0.0, 1.0);
  float T = textureLod(u_order, suv, 0.0).r;
  vec2 cl = floor((cid + 0.5) / 3.0);
  float burst = 0.5 * hash12(cl * 7.13 + k * 31.7) + 0.15 * hash12(key + 2.2);
  float lodF = clamp(log2(c) - 1.0, 0.0, 8.0);
  vec2 dv = textureLod(u_field, suv, lodF).rg * 2.0 - 1.0;
  float coh = length(dv);
  float wForm = (1.0 - u_dir) * smoothstep(0.03, 0.3, coh);
  vec2 tanD = coh > 1e-4 ? -dv / coh : vec2(1.0, 0.0);
  float fixedAng = 0.62 + (fract(u_seed * 0.113) - 0.5) * 0.6;
  float fa = fixedAng + (1.0 - u_dir) * (hash12(cl + 41.0) - 0.5) * 1.4;
  vec2 m2 = wForm * tanD + (1.0 - wForm) * vec2(cos(2.0 * fa), sin(2.0 * fa));
  float ang = 0.5 * atan(m2.y, m2.x) + (hash12(key + 9.1) - 0.5) * 0.45;
  float elong = u_elong * mix(0.65, 1.15, fk0);
  // zasięg ≤ 2c → siatka 5×5 nigdy nie ucina pociągnięcia
  float hl = min(c * elong * 0.5 * (0.75 + 0.5 * hash12(key + 3.7)), 2.0 * c);
  float hw = c * 0.5 * mix(0.55 + 0.9 * hash12(key + 5.9), 0.8 + 0.4 * hash12(key + 5.9), fk0);
  oA = vec4(h, fract(ang / 3.14159265), T);
  oB = vec4(hl / (2.0 * c), hw / c, hash12(key + 11.3), burst / 0.65);
}`;

export interface TableLayout {
  cols: number[];
  rows: number[];
  rowOff: number[];
  width: number;
  height: number;
}

export interface TableParams {
  stages: number;
  cells: number[];
  elong: number;
  dir: number;
  seed: number;
}

export function createStrokeTable(gl: WebGL2RenderingContext) {
  const prog = linkProgram(gl, TABLE_FRAG);
  const mk = () => {
    const t = gl.createTexture();
    if (!t) throw new Error("speedpaint: createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [p, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    return t;
  };
  const texA = mk();
  const texB = mk();
  const fbo = gl.createFramebuffer();
  let layout: TableLayout | null = null;

  function build(
    vao: WebGLVertexArrayObject, field: WebGLTexture, order: WebGLTexture, imgW: number, imgH: number, P: TableParams,
  ): TableLayout {
    const cols: number[] = [];
    const rows: number[] = [];
    const rowOff: number[] = [];
    let height = 0;
    for (let k = 0; k < P.stages; k++) {
      const c = P.cells[k];
      cols.push(Math.ceil(imgW / c) + 2 * TABLE_MARGIN);
      rows.push(Math.ceil(imgH / c) + 2 * TABLE_MARGIN);
      rowOff.push(height);
      height += rows[k];
    }
    const width = Math.max(...cols);
    for (const t of [texA, texB]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texB, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, field);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, order);
    const L = (n: string) => gl.getUniformLocation(prog, n);
    gl.uniform1i(L("u_field"), 0);
    gl.uniform1i(L("u_order"), 1);
    gl.uniform2f(L("u_res"), imgW, imgH);
    gl.uniform1i(L("u_stages"), P.stages);
    gl.uniform1f(L("u_margin"), TABLE_MARGIN);
    gl.uniform1f(L("u_elong"), P.elong);
    gl.uniform1f(L("u_dir"), P.dir);
    gl.uniform1f(L("u_seed"), P.seed);
    gl.bindVertexArray(vao);
    for (let k = 0; k < P.stages; k++) {
      gl.viewport(0, rowOff[k], cols[k], rows[k]);
      gl.uniform1f(L("u_c"), P.cells[k]);
      gl.uniform1i(L("u_k"), k);
      gl.uniform1i(L("u_rowOff"), rowOff[k]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    layout = { cols, rows, rowOff, width, height };
    return layout;
  }

  return {
    texA,
    texB,
    build,
    get layout() {
      return layout;
    },
    dispose() {
      gl.deleteTexture(texA);
      gl.deleteTexture(texB);
      gl.deleteFramebuffer(fbo);
      gl.deleteProgram(prog);
    },
  };
}

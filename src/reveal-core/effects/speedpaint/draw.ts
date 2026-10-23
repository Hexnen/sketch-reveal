/**
 * Pass klatki `speedpaint`: ustawia uniformy/tekstury głównego programu i rysuje do związanego bufora.
 * Fala 2 (bezstratnie): stan programu trwa między klatkami — jednostki samplerów raz, tablice układu przy
 * przebudowie tablicy pociągnięć, uniformy parametrów przy zmianie (params/etapy/obraz); co klatkę tylko p,
 * widok i papier (55 → 31 wywołań GL na klatkę, uniformy 33 → 7).
 */
import { paperUniforms, type PaperParams } from "../../paper";
import type { SpParams } from "./params";
import type { createStrokeTable } from "./strokeTable";

const UNIFORMS = [
  "u_view", "u_res", "u_p", "u_stages", "u_brush", "u_elong", "u_dir", "u_flat", "u_detailLag", "u_lineErase",
  "u_rhythm", "u_seed", "u_texture", "u_hold", "u_spread", "u_delay", "u_dur", "u_rowOff", "u_cols", "u_rows",
] as const;
/** Sampler → jednostka (8 = wysokość papieru, 15 = atrapa papieru — paper.ts). */
const UNITS = { u_sketch: 0, u_painted: 1, u_field: 2, u_kuwA: 3, u_kuwB: 4, u_order: 5, u_tabA: 6, u_tabB: 7, u_orderMin: 9 } as const;

interface Textures {
  sketch: WebGLTexture;
  painted: WebGLTexture;
  field: WebGLTexture;
  kuwA: WebGLTexture;
  kuwB: WebGLTexture;
  order: WebGLTexture;
  orderMin: WebGLTexture;
}

/** Czas lokalny (wewnętrzny, bez hold): spread + (N−1)·delay + 1.4·dur ≤ 0.97 (skalowanie). */
export function timing(P: SpParams, n: number) {
  const avail = 0.97;
  const total = P.spread + (n - 1) * P.stageDelay + 1.4 * P.stageDur;
  const f = total > avail ? avail / total : 1;
  return { spread: P.spread * f, delay: P.stageDelay * f, dur: P.stageDur * f };
}

export function createMainDraw(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  vao: WebGLVertexArrayObject,
  tex: Textures,
  table: ReturnType<typeof createStrokeTable>,
) {
  const u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as Record<
    (typeof UNIFORMS)[number],
    WebGLUniformLocation | null
  >;
  const setPaper = paperUniforms(gl, prog);
  const pad = (a: number[]) => Int32Array.from({ length: 6 }, (_, i) => a[i] ?? 0);
  const bind = (unit: number, t: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
  };
  gl.useProgram(prog);
  for (const [n, unit] of Object.entries(UNITS)) gl.uniform1i(gl.getUniformLocation(prog, n), unit);
  let lastLay: unknown = null;
  let lastStatic: { P: SpParams; n: number; w: number; h: number } | null = null;

  /** paperOff: przebiegi pomiarowe (kalibracja tempa) bez papieru — tempo nie zależy od ustawień papieru. */
  function draw(pInt: number, vw: number, vh: number, im: { w: number; h: number }, P: SpParams, n: number, paper: PaperParams, paperOff = false, paperTex: [WebGLTexture, number] | null = null) {
    gl.bindVertexArray(vao);
    gl.useProgram(prog);
    bind(0, tex.sketch);
    bind(1, tex.painted);
    bind(2, tex.field);
    bind(3, tex.kuwA);
    bind(4, tex.kuwB);
    bind(5, tex.order);
    bind(6, table.texA);
    bind(7, table.texB);
    bind(9, tex.orderMin);
    const lay = table.layout;
    if (lay && lay !== lastLay) {
      lastLay = lay;
      gl.uniform1iv(u.u_rowOff, pad(lay.rowOff));
      gl.uniform1iv(u.u_cols, pad(lay.cols));
      gl.uniform1iv(u.u_rows, pad(lay.rows));
    }
    const st = lastStatic;
    if (!st || st.P !== P || st.n !== n || st.w !== im.w || st.h !== im.h) {
      lastStatic = { P, n, w: im.w, h: im.h };
      const tm = timing(P, n);
      gl.uniform1f(u.u_hold, 0);
      gl.uniform1f(u.u_spread, tm.spread);
      gl.uniform1f(u.u_delay, tm.delay);
      gl.uniform1f(u.u_dur, tm.dur);
      gl.uniform2f(u.u_res, im.w, im.h);
      gl.uniform1i(u.u_stages, n);
      gl.uniform1f(u.u_brush, Math.max(4, P.brushSize * im.h));
      gl.uniform1f(u.u_elong, Math.max(1, P.strokeLength));
      gl.uniform1f(u.u_dir, P.strokeDirection);
      gl.uniform1f(u.u_flat, P.flatness);
      gl.uniform1f(u.u_detailLag, P.detailLag);
      gl.uniform1f(u.u_lineErase, P.lineErase);
      gl.uniform1f(u.u_rhythm, P.rhythm);
      gl.uniform1f(u.u_seed, P.seed);
      gl.uniform1f(u.u_texture, P.bristle);
    }
    gl.uniform2f(u.u_view, vw, vh);
    gl.uniform1f(u.u_p, pInt);
    setPaper(paper, paperOff, paperTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  draw.dispose = () => gl.deleteProgram(prog);
  return draw;
}

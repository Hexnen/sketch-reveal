/**
 * Bramka pokrycia bez synchronicznego odczytu (K1, combined-perf.md). Domyślnie robi to WORKER
 * (backdropWorker.ts: migawka `createImageBitmap(płótno)` = kopia GPU bez czekania, odczyt w wątku workera —
 * wątek główny nigdy nie czeka na GPU). Ten plik to droga zapasowa (brak Worker/OffscreenCanvas, CSP bez blob:)
 * i wspólny shader pomniejszenia. Droga zapasowa: klatka efektu koloru jest kopiowana do
 * tekstury MAŁEGO, OSOBNEGO kontekstu WebGL2 (texImage2D z płótna WebGL = kopia GPU→GPU, bez odczytu na CPU),
 * pomniejszana shaderem do siatki ≤ 256 (średnia 6×6 próbek dwuliniowych na komórkę ≈ średnia obszaru), czytana
 * do PIXEL_PACK_BUFFER (`readPixels` z buforem nie czeka) i odbierana dopiero po sygnale `fenceSync` przez
 * `getBufferSubData` (z kopii-cienia Chromium — bez czekania). Ta sama droga liczy referencję (obraz), więc obie
 * siatki mają ten sam filtr.
 *
 * Dlaczego osobny kontekst (zmierzone, swiftshader): `getBufferSubData` jest natychmiastowe tylko wtedy, gdy po
 * płocie kontekst nie dostał nowych komend; w kontekście glow kolejna klatka rysuje zaraz po próbce, więc odczyt
 * czekał na cały jej render (0,5–2 s). Ten kontekst nie robi nic poza próbkami. Żyje tylko, gdy bramka jest
 * aktywna (rozbłysk w trakcie koloru) — `dispose()` zwalnia go od razu (loseContext).
 * Bufor PBO jest świeży na każdy odczyt: ponowny zapis do bufora READ kasuje kopię-cień (ostrzeżenie Chromium).
 * Dwa sloty: nowa próbka zawsze wychodzi (skrub w pauzie nie gubi ostatniej klatki); przy obu zajętych najstarsza
 * jest porzucana. Kontekst efektu nie jest dotykany.
 */
import { VS } from "./shaders";
import { createWorkerSampler } from "./backdropWorker";

export const FS_COVER = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uSrc; uniform vec2 uGrid; uniform float uY0;
void main(){
  vec2 p = floor(vec2(gl_FragCoord.x, gl_FragCoord.y - uY0));
  vec3 s = vec3(0.0);
  for (int j = 0; j < 6; j++) for (int i = 0; i < 6; i++)
    s += texture(uSrc, (p + (vec2(float(i), float(j)) + 0.5) / 6.0) / uGrid).rgb;
  o = vec4(s / 36.0, 1.0);
}`;

export interface CoverageResult { ref: Uint8Array; cur: Uint8Array; cw: number; ch: number; tag: number }

export interface CoverageSampler {
  /**
   * Zleca odczyt siatki cw×ch klatki `frame` i obrazu `ref` (wysyłany raz na obiekt). Wołać w tym samym zadaniu,
   * w którym warstwa narysowała klatkę (backbuffer bez preserveDrawingBuffer). false = nie da się (np. tainted).
   */
  request(frame: TexImageSource, ref: TexImageSource, cw: number, ch: number, tag: number): boolean;
  /** Najnowszy gotowy wynik (bez blokowania; starsze w toku są porzucane); wiersz 0 = góra. */
  poll(): CoverageResult | null;
  busy(): boolean;
  /** Porzuca odczyty w toku. */
  cancel(): void;
  dispose(): void;
}

/** Worker, a bez niego osobny kontekst w wątku głównym; null = brak WebGL2 (wołający: odczyt synchroniczny 2D). */
export function createCoverageSampler(): CoverageSampler | null {
  return createWorkerSampler(VS, FS_COVER) ?? createThreadSampler();
}

/** Zapas w wątku głównym (PBO + fence w osobnym kontekście). Na GPU bez czekania; na swiftshaderze odczyt i tak
 *  czeka, aż wątek GPU skończy bieżącą komendę innego kontekstu (zmierzone ~0,5–1,5 s) — stąd domyślnie worker. */
function createThreadSampler(): CoverageSampler | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1; canvas.height = 1;
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "cover");
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FS_COVER));
  gl.bindAttribLocation(prog, 0, "aPos"); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "cover link");
  gl.useProgram(prog);
  gl.uniform1i(gl.getUniformLocation(prog, "uSrc"), 0);
  const uGrid = gl.getUniformLocation(prog, "uGrid"), uY0 = gl.getUniformLocation(prog, "uY0");
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const tex = () => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const frameTex = tex(), refTex = tex();
  let refOf: TexImageSource | null = null;
  let rt: { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number } | null = null;
  interface Slot { pbo: WebGLBuffer | null; sync: WebGLSync | null; cw: number; ch: number; tag: number }
  const slots: Slot[] = [0, 1].map(() => ({ pbo: null, sync: null, cw: 0, ch: 0, tag: -1 }));
  const drop = (s: Slot) => {
    if (s.sync) { gl.deleteSync(s.sync); s.sync = null; }
    if (s.pbo) { gl.deleteBuffer(s.pbo); s.pbo = null; }
  };
  const cancel = () => slots.forEach(drop);
  let dead = false;
  return {
    busy: () => slots.some((s) => !!s.sync),
    cancel,
    request(frame, ref, cw, ch, tag) {
      if (dead || gl.isContextLost()) return false;
      try {
        if (refOf !== ref) { gl.bindTexture(gl.TEXTURE_2D, refTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, ref); refOf = ref; }
        gl.bindTexture(gl.TEXTURE_2D, frameTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      } catch { return false; } // np. płótno „tainted” → droga zapasowa
      const slot = slots.find((s) => !s.sync) ?? slots.reduce((a, b) => (a.tag <= b.tag ? a : b));
      drop(slot);
      const H = ch * 2;
      if (!rt || rt.w !== cw || rt.h !== H) {
        if (rt) { gl.deleteTexture(rt.tex); gl.deleteFramebuffer(rt.fb); }
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fb = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        rt = { tex: t, fb, w: cw, h: H };
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fb);
      gl.uniform2f(uGrid, cw, ch);
      // dolna połowa celu = obraz (referencja), górna = klatka
      gl.viewport(0, 0, cw, ch); gl.uniform1f(uY0, 0);
      gl.bindTexture(gl.TEXTURE_2D, refTex); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.viewport(0, ch, cw, ch); gl.uniform1f(uY0, ch);
      gl.bindTexture(gl.TEXTURE_2D, frameTex); gl.drawArrays(gl.TRIANGLES, 0, 3);
      slot.pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, cw * H * 4, gl.STREAM_READ);
      gl.readPixels(0, 0, cw, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) { drop(slot); return false; }
      gl.flush();
      Object.assign(slot, { sync, cw, ch, tag });
      return true;
    },
    poll() {
      if (dead) return null;
      // stan płotu aktualizuje się dopiero po powrocie do pętli zdarzeń — zapytanie nie czeka na GPU
      let best: Slot | null = null;
      for (const s of slots) if (s.sync && (!best || s.tag > best.tag) && gl.getSyncParameter(s.sync, gl.SYNC_STATUS) === gl.SIGNALED) best = s;
      if (!best) return null;
      for (const s of slots) if (s !== best && s.sync && s.tag < best.tag) drop(s); // starsze są już nieaktualne
      const { cw, ch, tag } = best;
      const all = new Uint8Array(cw * ch * 8);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, best.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, all);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      drop(best);
      const half = cw * ch * 4;
      return { ref: all.subarray(0, half), cur: all.subarray(half), cw, ch, tag };
    },
    dispose() {
      if (dead) return;
      dead = true;
      cancel();
      gl.getExtension("WEBGL_lose_context")?.loseContext(); // zwalnia kontekst od razu (limit kontekstów strony)
    },
  };
}

/**
 * Mapa pokrycia z efektu (`EffectInstance.coverage(w, h)`, fala 2): komórka = postęp efektu, przy którym jest już
 * pomalowana. Zastępuje odczyt klatki: bramka liczona na CPU z samego `effectP` (bez GPU, bez workera).
 */
export interface CoverageMap { grid: Float32Array; w: number; h: number }

/**
 * Tabele bramki per komponent: te same próbki co odczyt klatki (siatka cw×ch ≤ 256, obrys `r·1,1` + pół komórki),
 * w każdej próbce czas pokrycia z mapy (dwuliniowo), posortowany. Udział pomalowanych przy p = liczba czasów ≤ p / n
 * (wyszukiwanie binarne) — ta sama krzywa 0,5→0,9 co w bramce odczytu. Liczone raz na (analizę, mapę).
 */
export function coverageTables(
  comps: readonly { cx: number; cy: number; r: number }[], asp: number, map: CoverageMap, cw: number, ch: number,
): (Float32Array | null)[] {
  const { grid, w: mw, h: mh } = map;
  const T = (u: number, v: number) => { // dwuliniowo, środki komórek mapy w (i+0,5)/mw
    const x = Math.max(0, Math.min(mw - 1, u * mw - 0.5)), y = Math.max(0, Math.min(mh - 1, v * mh - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(mw - 1, x0 + 1), y1 = Math.min(mh - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = grid[y0 * mw + x0] * (1 - fx) + grid[y0 * mw + x1] * fx;
    const b = grid[y1 * mw + x0] * (1 - fx) + grid[y1 * mw + x1] * fx;
    return a * (1 - fy) + b * fy;
  };
  const out: (Float32Array | null)[] = [null];
  for (let ci = 1; ci < comps.length; ci++) {
    const cp = comps[ci], rx = cp.r * asp * 1.1 + 0.5 / cw, ry = cp.r * 1.1 + 0.5 / ch;
    let x0 = Math.floor((cp.cx - rx) * cw), x1 = Math.ceil((cp.cx + rx) * cw), y0 = Math.floor((cp.cy - ry) * ch), y1 = Math.ceil((cp.cy + ry) * ch);
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(cw - 1, Math.max(x0, x1)); y1 = Math.min(ch - 1, Math.max(y0, y1));
    const t = new Float32Array((x1 - x0 + 1) * (y1 - y0 + 1));
    let k = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) t[k++] = T((x + 0.5) / cw, (y + 0.5) / ch);
    out.push(t.sort());
  }
  return out;
}

/** Bramka 0..1 per komponent przy postępie efektu `p` (smoothstep udziału pomalowanych lo→hi, jak odczyt). */
export function gateFromTables(tables: readonly (Float32Array | null)[], p: number, lo: number, hi: number): Float32Array {
  const out = new Float32Array(tables.length).fill(1);
  for (let ci = 1; ci < tables.length; ci++) {
    const t = tables[ci];
    if (!t || !t.length) continue;
    let a = 0, b = t.length; // liczba wartości ≤ p
    while (a < b) { const m = (a + b) >> 1; if (t[m] <= p) a = m + 1; else b = m; }
    const s = Math.max(0, Math.min(1, (a / t.length - lo) / (hi - lo)));
    out[ci] = s * s * (3 - 2 * s);
  }
  return out;
}

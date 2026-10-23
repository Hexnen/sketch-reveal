/**
 * Bramka pokrycia w WORKERZE (K1): wątek główny robi tylko migawkę `createImageBitmap(płótnoEfektu)` (w tym samym
 * zadaniu co render efektu; Chromium kopiuje bufor na GPU, bez odczytu na CPU) i przekazuje ją workerowi
 * (transfer). Worker: OffscreenCanvas + WebGL2 → pomniejszenie shaderem (ten sam FS_COVER co droga zapasowa) →
 * `readPixels` siatki cw×2ch (blokuje tylko worker) → wynik (transfer) do wątku głównego. Klatki, które przyszły,
 * gdy worker był zajęty, są zastępowane najnowszą (odpowiedź `skip`). Referencja (obraz) wysyłana raz na obiekt.
 * Kod workera jest ciągiem (Blob URL) — bez zależności od bundlera (Vite / Foundry).
 */
import type { CoverageResult, CoverageSampler } from "./backdrop";

const WORKER = (vs: string, fs: string) => `
let gl = null, uGrid, uY0, frameTex, refTex, rt = null, next = null, sched = false;
const VS = ${JSON.stringify(vs)}, FS = ${JSON.stringify(fs)};
function init() {
  gl = new OffscreenCanvas(1, 1).getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) throw new Error('webgl2');
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p); gl.useProgram(p);
  gl.uniform1i(gl.getUniformLocation(p, 'uSrc'), 0);
  uGrid = gl.getUniformLocation(p, 'uGrid'); uY0 = gl.getUniformLocation(p, 'uY0');
  gl.bindVertexArray(gl.createVertexArray()); gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
  frameTex = tex(); refTex = tex();
}
function run() {
  sched = false; const d = next; next = null; if (!d) return;
  try {
    gl.bindTexture(gl.TEXTURE_2D, frameTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, d.bmp); d.bmp.close();
    const cw = d.cw, ch = d.ch, H = ch * 2;
    if (!rt || rt.w !== cw || rt.h !== H) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); rt = { w: cw, h: H };
    }
    gl.uniform2f(uGrid, cw, ch);
    gl.viewport(0, 0, cw, ch); gl.uniform1f(uY0, 0); gl.bindTexture(gl.TEXTURE_2D, refTex); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.viewport(0, ch, cw, ch); gl.uniform1f(uY0, ch); gl.bindTexture(gl.TEXTURE_2D, frameTex); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(cw * H * 4); gl.readPixels(0, 0, cw, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    postMessage({ tag: d.tag, cw, ch, px }, [px.buffer]);
  } catch (e) { postMessage({ tag: d.tag, err: String(e) }); }
}
onmessage = (e) => {
  const d = e.data;
  try {
    if (!gl) init();
    if (d.t === 'ref') { gl.bindTexture(gl.TEXTURE_2D, refTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, d.bmp); d.bmp.close(); return; }
    if (next) { next.bmp.close(); postMessage({ tag: next.tag, skip: true }); }
    next = d; if (!sched) { sched = true; setTimeout(run, 0); }
  } catch (err) { if (d.bmp) d.bmp.close(); postMessage({ tag: d.tag, err: String(err) }); }
};`;

export function createWorkerSampler(vs: string, fs: string): CoverageSampler | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function"
    || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return null;
  let url = "", wk: Worker;
  try {
    url = URL.createObjectURL(new Blob([WORKER(vs, fs)], { type: "text/javascript" }));
    wk = new Worker(url);
  } catch { if (url) URL.revokeObjectURL(url); return null; }
  let pending = 0, latest: CoverageResult | null = null, dead = false, failed = false;
  let refOf: TexImageSource | null = null, chain: Promise<unknown> = Promise.resolve();
  wk.onmessage = (e: MessageEvent) => {
    const d = e.data as { tag: number; cw?: number; ch?: number; px?: Uint8Array; skip?: boolean; err?: string };
    pending = Math.max(0, pending - 1);
    if (d.err) { failed = true; console.warn("glow: bramka (worker)", d.err); return; }
    if (d.skip || !d.px || dead) return;
    const half = d.cw! * d.ch! * 4;
    if (!latest || d.tag > latest.tag) latest = { ref: d.px.subarray(0, half), cur: d.px.subarray(half), cw: d.cw!, ch: d.ch!, tag: d.tag };
  };
  wk.onerror = () => { failed = true; pending = 0; };
  return {
    busy: () => pending > 0 || !!latest,
    cancel: () => { latest = null; },
    request(frame, ref, cw, ch, tag) {
      if (dead || failed) return false;
      let fp: Promise<ImageBitmap>;
      // migawka TERAZ (to samo zadanie co render efektu); dalsza droga jest asynchroniczna
      try { fp = createImageBitmap(frame as ImageBitmapSource); } catch { return false; }
      if (refOf !== ref) {
        refOf = ref;
        let rp: Promise<ImageBitmap> | null = null;
        try { rp = createImageBitmap(ref as ImageBitmapSource); } catch { /* bez referencji wynik byłby błędny */ return false; }
        chain = chain.then(() => rp!).then((b) => { if (dead) b.close(); else wk.postMessage({ t: "ref", bmp: b }, [b]); });
      }
      pending++;
      chain = chain.then(() => fp).then(
        (b) => { if (dead) { b.close(); return; } wk.postMessage({ t: "frame", bmp: b, cw, ch, tag }, [b]); },
        () => { pending = Math.max(0, pending - 1); },
      );
      return true;
    },
    poll() { const r = latest; latest = null; return r; },
    dispose() {
      if (dead) return;
      dead = true; latest = null;
      wk.terminate(); URL.revokeObjectURL(url);
    },
  };
}

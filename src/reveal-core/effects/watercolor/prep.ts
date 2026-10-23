/**
 * Przygotowanie efektu `watercolor` (zależne od obrazu i parametrów, NIE od p) — w krokach, bez blokowania wątku:
 * siatka obrazu (CPU) → pola Tb/warp + progi (CPU) → dolne ograniczenia startu warstw (CPU) → papier (GPU, pasami).
 * Kroki idą w osobnych zadaniach (setTimeout 0); `flush()` dokańcza synchronicznie (np. gdy render przychodzi
 * przed gotowością). Wynik jest identyczny niezależnie od podziału na kroki.
 */
import type { RevealImageSource } from "../../types";
import { boundFields, computeFields, gridFromImage, minStartField, type ImageGrid } from "./fields";

/** Parametry, od których zależy przygotowanie. */
export interface PrepParams {
  originX: number;
  originY: number;
  seed: number;
  layers: number;
  blobSize: number;
  paperScale: number;
}

export interface PrepTargets {
  gl: WebGL2RenderingContext;
  fieldTex: WebGLTexture;
  minTex: WebGLTexture;
  /** Ograniczenia skrótów bezstratnych (fields.ts boundFields): maxA = max Tb k0..3, maxB.rg = max Tb k4, k5. */
  maxATex: WebGLTexture;
  maxBTex: WebGLTexture;
  paperTex: WebGLTexture;
  /** Rysuje pas papieru [y0, y0+rows) do już zaalokowanej tekstury (FBO + scissor). */
  drawPaperStrip(w: number, h: number, y0: number, rows: number, p: PrepParams): void;
  allocPaper(w: number, h: number): void;
}

/** ~512k pikseli papieru na krok. */
const PAPER_STEP_PX = 1 << 19;

export function createPrep(t: PrepTargets) {
  const { gl } = t;
  let img: RevealImageSource | null = null;
  let res = { w: 0, h: 0 };
  let grid: ImageGrid | null = null;
  let fieldKey = "", minKey = "", paperKey = "";
  let paperRow = 0;
  let paperWorking = "";
  let thr = new Float32Array([1, 1, 1, 1]);
  let fieldsData: { w: number; h: number; data: Float32Array } | null = null;
  let params: PrepParams | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiters: (() => void)[] = [];
  let onDone: () => void = () => {};

  const upload16F = (tex: WebGLTexture, w: number, h: number, data: Float32Array) => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  };

  /** Jeden krok pracy; false = nic nie zostało. */
  function step(): boolean {
    if (!img || !params) return false;
    const P = params;
    if (!grid) {
      grid = gridFromImage(img, res.w, res.h);
      return true;
    }
    const fk = `${P.originX}|${P.originY}|${P.seed}|${Math.round(P.layers)}`;
    if (fk !== fieldKey) {
      const f = computeFields(grid, P.originX, P.originY, P.seed, P.layers);
      thr = Float32Array.from(f.thr.slice(0, 4));
      fieldsData = f;
      upload16F(t.fieldTex, f.w, f.h, f.data);
      fieldKey = fk;
      minKey = "";
      return true;
    }
    const mk = `${fk}|${P.blobSize}|${res.w}x${res.h}`;
    if (mk !== minKey && fieldsData) {
      const m = minStartField(fieldsData, res.w, res.h, P.layers, P.blobSize);
      upload16F(t.minTex, fieldsData.w, fieldsData.h, m);
      const b = boundFields(fieldsData, res.w, res.h, P.layers, P.blobSize);
      upload16F(t.maxATex, fieldsData.w, fieldsData.h, b.maxA);
      upload16F(t.maxBTex, fieldsData.w, fieldsData.h, b.maxB);
      minKey = mk;
      return true;
    }
    const pk = `${res.w}x${res.h}|${P.paperScale}|${P.seed}`;
    if (pk !== paperKey) {
      if (pk !== paperWorking) { paperWorking = pk; paperRow = 0; }
      if (paperRow === 0) t.allocPaper(res.w, res.h);
      const rows = Math.max(1, Math.floor(PAPER_STEP_PX / Math.max(1, res.w)));
      const n = Math.min(rows, res.h - paperRow);
      t.drawPaperStrip(res.w, res.h, paperRow, n, P);
      paperRow += n;
      if (paperRow >= res.h) {
        paperKey = pk;
        paperRow = 0;
      }
      return true;
    }
    return false;
  }

  function pending(): boolean {
    if (!img || !params) return false;
    const P = params;
    const fk = `${P.originX}|${P.originY}|${P.seed}|${Math.round(P.layers)}`;
    return !grid || fk !== fieldKey || `${fk}|${P.blobSize}|${res.w}x${res.h}` !== minKey ||
      `${res.w}x${res.h}|${P.paperScale}|${P.seed}` !== paperKey;
  }

  function finish() {
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
    onDone();
  }

  function tick() {
    timer = null;
    const t0 = performance.now();
    while (performance.now() - t0 < 8 && step()) { /* krok po kroku, ≤ ~8 ms na zadanie */ }
    if (pending()) timer = setTimeout(tick, 0);
    else finish();
  }

  function kick() {
    if (timer === null && pending()) timer = setTimeout(tick, 0);
    else if (!pending()) finish();
  }

  return {
    setImage(painted: RevealImageSource, w: number, h: number) {
      img = painted;
      res = { w, h };
      grid = null;
      fieldKey = minKey = paperKey = paperWorking = "";
      paperRow = 0;
      kick();
    },
    setParams(p: PrepParams) {
      params = p;
      kick();
    },
    /** Dokończ synchronicznie (render w trakcie przygotowania). */
    flush() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      let any = false;
      while (step()) any = true;
      if (any || waiters.length) finish();
    },
    isReady: () => !pending(),
    whenReady: () => (pending() ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
    thresholds: () => thr,
    /** Pola Tb/warp z CPU (do coverage) — null przed policzeniem. */
    fields: () => fieldsData,
    onChange(f: () => void) { onDone = f; },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      img = null;
      grid = null;
      fieldsData = null;
      finish();
    },
  };
}

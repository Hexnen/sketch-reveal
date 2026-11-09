/* Wątek roboczy odbitek sesji fotografa (gazeta klasyczna): raster druku liczony poza wątkiem głównym, żeby sesja (kamera,
   flesz, loty odbitek) nie gubiła klatek na słabszym sprzęcie. Wejście: {id, bitmap, w, h, cell, ink, paper};
   wyjście: {id, bitmap} (ImageBitmap w×h) albo {id, error}. */
import { halftoneGrid, halftoneRaster, halftoneTone } from "./halftone.mjs";

self.onmessage = (e) => {
  const { id, bitmap, w, h, cell, ink, paper } = e.data ?? {};
  try {
    const { sw, sh } = halftoneGrid(w, h, cell);
    const sc = new OffscreenCanvas(sw, sh), sg = sc.getContext("2d", { willReadFrequently: true });
    sg.imageSmoothingQuality = "high";
    sg.drawImage(bitmap, 0, 0, sw, sh);
    bitmap.close?.();
    const L = halftoneTone(sg.getImageData(0, 0, sw, sh).data, sw, sh);
    const r = halftoneRaster(L, sw, sh, { x: 0, y: 0, w, h }, cell, ink, paper);
    const out = new OffscreenCanvas(w, h);
    out.getContext("2d").putImageData(new ImageData(r.data, r.bw, r.bh), r.X0, r.Y0);
    const result = out.transferToImageBitmap();
    self.postMessage({ id, bitmap: result }, [result]);
  } catch (err) {
    try { bitmap?.close?.(); } catch { /* */ }
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

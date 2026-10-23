/**
 * Skąd bierze się analiza szkicu: pamięć (WeakMap per obraz) → IndexedDB (hash zawartości) → Worker (Blob URL)
 * → wątek główny w kawałkach 10 ms (fallback: CSP/brak Workera/błąd). Wynik identyczny każdą drogą.
 * Anulowanie: licznik użytkowników wpisu; gdy spadnie do 0 przed końcem (zmiana obrazu) — przerwij pracę.
 */
import type { RevealImageSource } from "../types";
import { analysisModule } from "./analysis";
import { fnv, idbGet, idbPut } from "./idb";
import { makeSlicer } from "./params";
import { distanceTransform, inkFromRgba, otsuThreshold, skeletonModule, zhangSuen } from "./skeleton";
import { tracePaths, type Path, type traceModule } from "./trace";
import { ANALYSIS_VERSION, workerAnalyze, workerStats } from "./worker";

/** Analiza robiona na kopii o najwyżej tylu pikselach (4K → ~1.4 Mpx); pole T skalowane w shaderze. */
const MAX_ANALYSIS_PX = 1_400_000;

export interface Analysis {
  aw: number; ah: number; paths: Path[]; ink: Uint8Array; ms: number;
  /** Klucz zawartości (wersja algorytmu + rozmiar + hash tuszu) — IndexedDB i magazyn workera. */
  key: string;
  via: "idb" | "worker" | "main";
}

const sk = { inkFromRgba, otsuThreshold, distanceTransform, zhangSuen } as ReturnType<typeof skeletonModule>;
const local = analysisModule(sk, { tracePaths } as ReturnType<typeof traceModule>);

class Cancelled extends Error { constructor() { super("cancelled"); } }

async function analyze(src: RevealImageSource, w: number, h: number, isCancelled: () => boolean, onJob: (c: () => void) => void): Promise<Analysis> {
  const t0 = performance.now();
  const sc = Math.min(1, Math.sqrt(MAX_ANALYSIS_PX / (w * h)));
  const aw = Math.max(1, Math.round(w * sc)), ah = Math.max(1, Math.round(h * sc));
  const c = document.createElement("canvas");
  c.width = aw; c.height = ah;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("Brak kontekstu 2D");
  g.fillStyle = "#fff"; g.fillRect(0, 0, aw, ah);
  g.drawImage(src, 0, 0, aw, ah);
  const ink = inkFromRgba(g.getImageData(0, 0, aw, ah).data, aw * ah);
  const key = `${ANALYSIS_VERSION}:${aw}x${ah}:${fnv(ink)}:${fnv(ink, 0x9747b28c)}`;
  const hit = await idbGet<{ paths: Path[] }>(key);
  if (isCancelled()) throw new Cancelled();
  if (hit?.paths) return { aw, ah, ink, key, paths: hit.paths, ms: performance.now() - t0, via: "idb" };
  let paths: Path[], via: Analysis["via"] = "worker";
  try {
    const job = workerAnalyze(key, ink.slice(), aw, ah);
    onJob(job.cancel);
    paths = await job.promise;
  } catch (e) {
    if (isCancelled() || (e as Error).message === "cancelled") throw new Cancelled();
    via = "main"; workerStats.fallbacks++;
    const base = makeSlicer(10);
    paths = await local.analyzeInk(ink, aw, ah, async () => { if (isCancelled()) throw new Cancelled(); await base(); });
  }
  void idbPut(key, { paths });
  return { aw, ah, ink, key, paths, ms: performance.now() - t0, via };
}

interface Entry { pr: Promise<Analysis>; refs: number; done: boolean; cancelled: boolean; cancel: (() => void) | null }
const cache = new WeakMap<object, Map<string, Entry>>();

/** Wspólna analiza obrazu; `release()` gdy już niepotrzebna (ostatni użytkownik anuluje pracę w toku). */
export function acquireAnalysis(src: RevealImageSource, w: number, h: number): { pr: Promise<Analysis>; release(): void } {
  let m = cache.get(src);
  if (!m) { m = new Map(); cache.set(src, m); }
  const k = `${w}x${h}`;
  let e = m.get(k);
  if (!e) {
    const ent: Entry = { pr: null!, refs: 0, done: false, cancelled: false, cancel: null };
    ent.pr = analyze(src, w, h, () => ent.cancelled, (c) => { ent.cancel = c; });
    ent.pr.then(() => { ent.done = true; }, () => { if (m!.get(k) === ent) m!.delete(k); });
    m.set(k, ent);
    e = ent;
  }
  const ent = e;
  ent.refs++;
  let released = false;
  return {
    pr: ent.pr,
    release() {
      if (released) return;
      released = true;
      if (--ent.refs > 0 || ent.done) return;
      ent.cancelled = true;
      ent.cancel?.();
      if (m!.get(k) === ent) m!.delete(k);
    },
  };
}

/** Bez anulowania (harness/diagnostyka). */
export const getAnalysis = (src: RevealImageSource, w: number, h: number) => acquireAnalysis(src, w, h).pr;

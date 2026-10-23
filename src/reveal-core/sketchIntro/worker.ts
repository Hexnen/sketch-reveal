/**
 * Wektoryzacja i pole T w Workerze z Blob URL — bez osobnego pliku i bez bundlera (działa w Vite i w Foundry).
 * Źródło workera składane z TYCH SAMYCH fabryk co wątek główny (`*Module.toString()`): jeden kod algorytmów,
 * wyniki bajt w bajt. CSP bez `blob:` / brak Workera / błąd w workerze → `null`/odrzucenie, a wywołujący
 * liczy na wątku głównym (obecne chunkowanie). Analiza anulowalna (zmiana obrazu), pole T — tylko najnowsze.
 */
import { analysisModule } from "./analysis";
import { fieldModule } from "./field";
import { fnv } from "./idb";
import { rng, type SketchIntroParams } from "./params";
import { scheduleModule, type Schedule } from "./schedule";
import { partsModule } from "./scheduleParts";
import { skeletonModule } from "./skeleton";
import { traceModule, type Path } from "./trace";

/** Wersja algorytmu analizy: zmiana kodu wektoryzacji → nowe klucze cache (IndexedDB). */
export const ANALYSIS_VERSION = fnv(skeletonModule.toString() + traceModule.toString() + analysisModule.toString());

const BOOT = `
const store = new Map(), cancelled = new Set();
const slicer = (id) => { let t0 = performance.now(); return async () => {
  if (cancelled.has(id)) throw new Error("cancelled");
  if (performance.now() - t0 < 40) return;
  await new Promise((r) => setTimeout(r, 0)); t0 = performance.now();
  if (cancelled.has(id)) throw new Error("cancelled");
}; };
const keep = (key, v) => { store.delete(key); store.set(key, v); while (store.size > 3) store.delete(store.keys().next().value); };
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "cancel") { cancelled.add(m.id); return; }
  try {
    if (m.type === "analyze") {
      const paths = await an.analyzeInk(m.ink, m.aw, m.ah, slicer(m.id));
      keep(m.key, { paths, ink: m.ink, aw: m.aw, ah: m.ah });
      self.postMessage({ id: m.id, paths });
    } else if (m.type === "load") {
      keep(m.key, { paths: m.paths, ink: m.ink, aw: m.aw, ah: m.ah });
      self.postMessage({ id: m.id });
    } else if (m.type === "field") {
      const a = store.get(m.key);
      if (!a) { self.postMessage({ id: m.id, missing: true }); return; }
      const S = sc.buildSchedule(a.paths, a.aw, a.ah, m.params, m.params.seconds);
      const field = fi.computeField(a.paths, a.ink, m.inkLo, a.aw, a.ah, S);
      const bufs = new Set([field.buffer]);
      for (const v of Object.values(S)) if (ArrayBuffer.isView(v)) bufs.add(v.buffer);
      self.postMessage({ id: m.id, field, sched: S }, [...bufs]);
    }
  } catch (err) { self.postMessage({ id: m.id, error: String((err && err.message) || err) }); }
  finally { cancelled.delete(m.id); }
};
self.postMessage({ hello: true });
`;

function source(): string {
  return `"use strict";
const sk = (${skeletonModule.toString()})();
const tr = (${traceModule.toString()})();
const pa = (${partsModule.toString()})();
const rng = (${rng.toString()});
const sc = (${scheduleModule.toString()})({ rng, A_LEVELS: pa.A_LEVELS, hatchGroups: pa.hatchGroups, JobGrid: pa.JobGrid });
const fi = (${fieldModule.toString()})({ END: sc.END, profileInv: pa.profileInv });
const an = (${analysisModule.toString()})(sk, tr);
${BOOT}`;
}

/** Diagnostyka (harness/raport). */
export const workerStats = { available: null as boolean | null, analyses: 0, fields: 0, loads: 0, fallbacks: 0, error: "" };

interface Pending { resolve(v: any): void; reject(e: Error): void }
let W: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function fail(msg: string) {
  W?.terminate(); W = null;
  workerStats.available = false; workerStats.error = msg;
  for (const p of pending.values()) p.reject(new Error("worker-unavailable"));
  pending.clear();
}

function worker(): Worker | null {
  if (W !== undefined) return W;
  try {
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") throw new Error("no Worker");
    const url = URL.createObjectURL(new Blob([source()], { type: "text/javascript" }));
    const w = new Worker(url);
    W = w;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.hello) { workerStats.available = true; URL.revokeObjectURL(url); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
    };
    // CSP (np. Foundry bez `worker-src blob:`) potrafi odrzucić skrypt asynchronicznie — też tu trafia
    w.onerror = (e) => { e.preventDefault?.(); fail(e.message || "worker error"); };
  } catch (e) { W = null; workerStats.available = false; workerStats.error = String(e); }
  return W;
}

function call(msg: Record<string, unknown>, transfer: Transferable[] = []): { id: number; promise: Promise<any> } {
  const w = worker();
  const id = nextId++;
  if (!w) return { id, promise: Promise.reject(new Error("worker-unavailable")) };
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  // wyjątek synchroniczny (DataCloneError…): wpis zostaje w `pending`, więc `fail` odrzuci TAKŻE tę obietnicę
  // (wołający przechodzi na wątek główny) — bughunt #3
  try { w.postMessage({ ...msg, id }, transfer); } catch (e) { fail(String(e)); }
  return { id, promise };
}

/** Analiza w workerze. `ink` zostaje przekazany (transfer) — podaj kopię. */
export function workerAnalyze(key: string, ink: Uint8Array, aw: number, ah: number) {
  const { id, promise } = call({ type: "analyze", key, ink, aw, ah }, [ink.buffer]);
  return {
    promise: promise.then((m) => { workerStats.analyses++; return m.paths as Path[]; }),
    cancel() { if (W) W.postMessage({ type: "cancel", id }); },
  };
}

/** Harmonogram + pole T w workerze dla analizy `key` (gdy worker jej nie ma — dosyła ścieżki i tusz). */
export async function workerField(
  a: { key: string; paths: Path[]; ink: Uint8Array; aw: number; ah: number }, params: SketchIntroParams, inkLo: number,
): Promise<{ field: Float32Array; sched: Schedule }> {
  const ask = () => call({ type: "field", key: a.key, params: { ...params }, inkLo }).promise;
  let m = await ask();
  if (m.missing) {
    workerStats.loads++;
    await call({ type: "load", key: a.key, paths: a.paths, ink: a.ink, aw: a.aw, ah: a.ah }).promise;
    m = await ask();
    if (m.missing) throw new Error("worker-missing");
  }
  workerStats.fields++;
  return { field: m.field, sched: m.sched };
}

/**
 * Pamięć list pociągnięć i harmonogramów (ST4, bezstratne — te same dane wejściowe → ten sam wynik, bo generator
 * i harmonogram są deterministyczne):
 *  - lista pociągnięć: wspólna dla modułu (wszystkie instancje), klucz = odcisk obrazu roboczego + genKey.
 *    Nowa instancja na tym samym obrazie (studio ↔ splash, przełączenie efektu, powrót do parametrów) nie liczy
 *    listy od nowa (~1–5 s CPU). LRU z budżetem bajtów.
 *  - harmonogram: per lista (WeakMap), klucz = scheduleKey, ostatnie kilka (cofnięcie suwaka originX itp.).
 * IndexedDB świadomie pominięte: lista to 5–30 MB Float32, a koszt (de)serializacji + odcisk obrazu jest tego rzędu
 * co zysk dopiero przy 2. otwarciu strony — patrz strokes.md „Fala 2”.
 */
import type { RGBImage } from "./imageOps";
import type { Schedule } from "./schedule";
import type { StrokeSet } from "./strokeGen";

const SET_BUDGET_BYTES = 96 * 1024 * 1024;
const SCHED_PER_SET = 3;

/** Odcisk obrazu roboczego: FNV-1a po bitach całego RGB (Float32 z bajtów 0..255 → dokładny) + rozmiar. */
export function imageFingerprint(img: RGBImage): string {
  const u = new Uint32Array(img.rgb.buffer, img.rgb.byteOffset, img.rgb.length);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < u.length; i++) {
    h1 = Math.imul(h1 ^ u[i], 0x01000193);
    h2 = Math.imul(h2 ^ (u[i] >>> 7), 0x5bd1e995) ^ i;
  }
  return `${img.w}x${img.h}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

const setBytes = (s: StrokeSet) => s.points.byteLength + s.inst.byteLength + s.layer.byteLength
  + (s.order.region.byteLength + s.order.haze.byteLength);

const sets = new Map<string, StrokeSet>();

export function getSet(key: string): StrokeSet | undefined {
  const s = sets.get(key);
  if (s) { sets.delete(key); sets.set(key, s); } // LRU: odśwież
  return s;
}

export function putSet(key: string, s: StrokeSet) {
  sets.delete(key);
  sets.set(key, s);
  let total = 0;
  for (const v of sets.values()) total += setBytes(v);
  for (const [k, v] of sets) {
    if (total <= SET_BUDGET_BYTES || sets.size <= 1) break;
    total -= setBytes(v);
    sets.delete(k);
  }
}

const scheds = new WeakMap<StrokeSet, Map<string, Schedule>>();

export function getSchedule(set: StrokeSet, key: string): Schedule | undefined {
  return scheds.get(set)?.get(key);
}

export function putSchedule(set: StrokeSet, key: string, sc: Schedule) {
  let m = scheds.get(set);
  if (!m) scheds.set(set, (m = new Map()));
  m.delete(key);
  m.set(key, sc);
  while (m.size > SCHED_PER_SET) m.delete(m.keys().next().value as string);
}

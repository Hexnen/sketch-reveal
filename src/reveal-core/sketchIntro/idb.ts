/**
 * Trwały cache wyniku wektoryzacji (IndexedDB): powrót do tej samej sceny = 0 s analizy.
 * Klucz = wersja algorytmu (hash źródła funkcji analizy) + rozmiar + 2 hashe CAŁEGO obrazu tuszu (≤ 1.4 Mpx).
 * Wszystko w try/catch: prywatne okno, brak IndexedDB, quota → po prostu brak cache. Najwyżej MAX wpisów (LRU).
 */
const DB = "reveal-sketch-intro", STORE = "analysis", META = "meta", MAX = 8;

let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((res) => {
    try {
      if (typeof indexedDB === "undefined") { res(null); return; }
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE); r.result.createObjectStore(META); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T | null>((res) => { r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); });

export async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const d = await db();
    if (!d) return null;
    const tx = d.transaction([STORE, META], "readwrite");
    const v = await req<T>(tx.objectStore(STORE).get(key) as IDBRequest<T>);
    if (v) tx.objectStore(META).put(Date.now(), key);
    return v;
  } catch { return null; }
}

export async function idbPut(key: string, value: unknown): Promise<void> {
  try {
    const d = await db();
    if (!d) return;
    const tx = d.transaction([STORE, META], "readwrite");
    tx.objectStore(STORE).put(value, key);
    const meta = tx.objectStore(META);
    meta.put(Date.now(), key);
    const [keys, times] = await Promise.all([req(meta.getAllKeys()), req(meta.getAll())]);
    if (!keys || !times || keys.length <= MAX) return;
    const old = keys.map((k, i) => [k, times[i] as number] as const).sort((a, b) => a[1] - b[1]).slice(0, keys.length - MAX);
    for (const [k] of old) { tx.objectStore(STORE).delete(k); meta.delete(k); }
  } catch { /* quota / prywatne okno — bez cache */ }
}

/** FNV-1a 32 (tekst albo bajty); `seed` daje drugi, niezależny hash. */
export function fnv(data: string | Uint8Array, seed = 0x811c9dc5): string {
  let h = seed >>> 0;
  if (typeof data === "string") for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data.charCodeAt(i), 0x01000193);
  else for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
  return (h >>> 0).toString(36);
}

/* Integracja z modułem „Media Optimizer (Local)” (local-media-optimizer): opcjonalna — bez niego przycisk się nie pokazuje.
   Reveal skaluje obrazy u KAŻDEGO klienta przy starcie do limitu tekstur (≤ 4096 px), więc wielomegabajtowy PNG/10k px
   kosztuje transfer, dekodowanie i pamięć u wszystkich graczy. „Zoptymalizuj obrazy” robi to raz, po stronie GM-a, i zapisuje
   kopie jako WebP (oryginały zostają). Używa publicznego API optymalizatora: api.optimizeImage + upload z `optimized: true`
   (żeby optymalizator nie kodował pliku drugi raz — jego hook na FilePicker.upload respektuje tę flagę). */
import { MODULE_ID } from "./config.mjs";

const MAX_EDGE = 4096; // = górna granica boku tekstury w odtwarzaczu (revealMaxSide: min(4096, MAX_TEXTURE_SIZE))
const T = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));

/** API optymalizatora albo null (moduł nieobecny / nieaktywny — api powstaje dopiero w jego `init`). */
export function optimizerApi() {
  const api = game.modules.get("local-media-optimizer")?.api;
  return typeof api?.optimizeImage === "function" ? api : null;
}

const fmt = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Krótki, stabilny skrót ścieżki źródłowej — różne pliki o tej samej nazwie w różnych folderach nie nadpiszą się. */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function ensureDir(FP, dir) {
  let acc = "";
  for (const part of dir.split("/")) {
    acc = acc ? `${acc}/${part}` : part;
    try { await FP.createDirectory("data", acc, {}); } catch { /* katalog już istnieje */ }
  }
}

/**
 * Optymalizuje jeden obraz do WebP ≤ MAX_EDGE. Zwraca { path, changed, before, after } — path to NOWY plik (gdy changed)
 * albo oryginał. Oryginał nigdy nie jest ruszany.
 * @param {string} url  ścieżka źródłowa
 * @param {number} quality  0.1–1 (szkic: wyżej — cienkie linie są wejściem do wektoryzacji)
 */
async function optimizeOne(api, url, quality) {
  if (!url) return { path: url, changed: false, before: 0, after: 0 };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  const r = await api.optimizeImage(blob, { maxEdge: MAX_EDGE, quality, format: "webp", keepIfLarger: true, minGain: 0.1 });
  if (!r?.changed) return { path: url, changed: false, before: blob.size, after: blob.size };
  const stem = (decodeURIComponent(url.split("/").pop() ?? "image").replace(/\.[^.]+$/, "") || "image").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60);
  const FP = foundry.applications.apps.FilePicker.implementation;
  const dir = `worlds/${game.world.id}/${MODULE_ID}/images`;
  await ensureDir(FP, dir);
  const file = new File([r.blob], `${stem}-${hash(url)}.webp`, { type: "image/webp" });
  // optimized: true → optymalizator nie koduje drugi raz; ścieżkę bierzemy z odpowiedzi (rozszerzenie mogło się zmienić)
  const up = await FP.upload("data", dir, file, {}, { notify: false, optimized: true });
  if (!up?.path) throw new Error(`${url}: upload failed`);
  return { path: up.path, changed: true, before: blob.size, after: r.blob.size };
}

/**
 * Optymalizuje szkic i obraz malowany presetu. Zwraca { sketch, painted, report }, gdzie sketch/painted to nowe ścieżki
 * (albo dotychczasowe, gdy nic nie zyskano). Rzuca przy błędzie pobrania/uploadu — wołający pokazuje komunikat.
 */
export async function optimizeRevealImages({ sketch, painted }) {
  const api = optimizerApi();
  if (!api) throw new Error(T("Optimize.NoModule"));
  const s = await optimizeOne(api, sketch, 0.95);   // szkic: linie → wysoka jakość
  const p = await optimizeOne(api, painted, 0.88);
  const before = s.before + p.before, after = s.after + p.after;
  return { sketch: s.path, painted: p.path, changed: s.changed || p.changed, before, after,
    summary: T("Optimize.Done", { before: fmt(before), after: fmt(after), pct: before ? Math.round((1 - after / before) * 100) : 0 }) };
}

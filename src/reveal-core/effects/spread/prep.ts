/**
 * Przygotowanie CPU efektu spread (fala 2): analiza obrazów + pole czasu T, liczone porcjami (generatory z
 * analysis.ts/timeField.ts) i cache'owane między instancjami — przemontowanie efektu, powrót do poprzednich
 * parametrów albo ta sama para obrazów w innym widoku nie liczą Dijkstry od nowa. Wyniki deterministyczne,
 * więc cache nie zmienia ani bajtu klatek.
 */
import { analyzeSteps, type ImageAnalysis } from "./analysis";
import { TIME_FIELD_KEYS, type SpreadParams } from "./params";
import { timeFieldSteps } from "./timeField";

/** Klucz pola czasu (parametry, od których zależy T). */
export function fieldKeyOf(p: SpreadParams): string {
  return TIME_FIELD_KEYS.map((k) => String(p[k])).join("|");
}

interface PairEntry {
  sketch: object;
  sig: string;
  analysis: ImageAnalysis;
  /** LRU: ostatnio użyte na końcu. */
  fields: Map<string, Float32Array>;
}

const FIELDS_PER_PAIR = 6; // 6 × ~146 KB (siatka 256×143) na parę obrazów
/** Cache po obiekcie `painted` (WeakMap → znika razem z obrazem). Tylko źródła niezmienne (ImageBitmap,
 * HTMLImageElement z podpisem src+rozmiar) — płótna mogą zmienić treść pod tym samym obiektem. */
const pairs = new WeakMap<object, PairEntry>();

function signature(src: TexImageSource): string | null {
  if (typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap) return `bmp|${src.width}x${src.height}`;
  if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement) {
    return `img|${src.currentSrc || src.src}|${src.naturalWidth}x${src.naturalHeight}`;
  }
  return null;
}

function pairSig(sketch: TexImageSource, painted: TexImageSource): string | null {
  const a = signature(sketch), b = signature(painted);
  return a && b ? `${a}#${b}` : null;
}

function lookup(sketch: TexImageSource, painted: TexImageSource): PairEntry | null {
  const sig = pairSig(sketch, painted);
  if (!sig) return null;
  const e = pairs.get(painted as object);
  return e && e.sketch === sketch && e.sig === sig ? e : null;
}

export function cachedAnalysis(sketch: TexImageSource, painted: TexImageSource): ImageAnalysis | null {
  return lookup(sketch, painted)?.analysis ?? null;
}

export function storeAnalysis(sketch: TexImageSource, painted: TexImageSource, analysis: ImageAnalysis) {
  const sig = pairSig(sketch, painted);
  if (!sig) return;
  pairs.set(painted as object, { sketch: sketch as object, sig, analysis, fields: new Map() });
}

export function cachedField(sketch: TexImageSource, painted: TexImageSource, key: string): Float32Array | null {
  const e = lookup(sketch, painted);
  const f = e?.fields.get(key);
  if (!e || !f) return null;
  e.fields.delete(key); e.fields.set(key, f); // LRU
  return f;
}

export function storeField(sketch: TexImageSource, painted: TexImageSource, key: string, field: Float32Array) {
  const e = lookup(sketch, painted);
  if (!e) return;
  e.fields.set(key, field);
  while (e.fields.size > FIELDS_PER_PAIR) e.fields.delete(e.fields.keys().next().value as string);
}

/**
 * Zadanie przygotowania dla jednej pary obrazów: `step(deadline)` posuwa pracę do terminu (performance.now()),
 * `Infinity` = do końca (render() przed gotowością — determinizm). Zmiana parametrów pola przerywa bieżącego
 * Dijkstrę i zaczyna nowego (albo bierze gotowe pole z cache).
 */
export function createPrepJob(sketch: TexImageSource, painted: TexImageSource) {
  let analysis: ImageAnalysis | null = cachedAnalysis(sketch, painted);
  let aGen: Generator<void, ImageAnalysis, void> | null = null;
  let field: Float32Array | null = null;
  let fieldKey = "";
  let fGen: { key: string; gen: Generator<void, Float32Array, void> } | null = null;

  return {
    get analysis() { return analysis; },
    /** Gotowe pole dla `key` albo null. */
    field(key: string): Float32Array | null { return key === fieldKey ? field : null; },
    pending(key: string): boolean { return !analysis || fieldKey !== key; },
    /** Posuwa pracę; true = coś zostało do zrobienia przy tym kluczu (po powrocie). */
    step(params: SpreadParams, deadline: number): boolean {
      const key = fieldKeyOf(params);
      if (!analysis) {
        aGen ??= analyzeSteps(sketch, painted);
        for (;;) {
          const r = aGen.next();
          if (r.done) { analysis = r.value; aGen = null; storeAnalysis(sketch, painted, analysis); break; }
          if (performance.now() >= deadline) return true;
        }
      }
      if (fieldKey === key) return false;
      const hit = cachedField(sketch, painted, key);
      if (hit) { field = hit; fieldKey = key; fGen = null; return false; }
      if (!fGen || fGen.key !== key) fGen = { key, gen: timeFieldSteps(analysis, params) };
      for (;;) {
        const r = fGen.gen.next();
        if (r.done) {
          field = r.value; fieldKey = key; fGen = null;
          storeField(sketch, painted, key, field);
          return false;
        }
        if (performance.now() >= deadline) return true;
      }
    },
    dispose() { aGen = null; fGen = null; analysis = null; field = null; },
  };
}

export type PrepJob = ReturnType<typeof createPrepJob>;

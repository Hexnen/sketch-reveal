/**
 * Bliźniak do uploadu tekstur (dev/perf-audit.md F2): `<img>` zostaje źródłem dla wszystkich rysunków 2D (analizy, skalowanie
 * — rysunek z ImageBitmap przy dużym pomniejszeniu daje inne piksele niż z <img>), a `texImage2D` bierze zarejestrowany
 * ImageBitmap tego samego obrazu: upload 7–8× szybszy, bo Chromium konwertuje <img> przy KAŻDYM texImage2D. Wołający
 * rejestruje bliźniaka tylko wtedy, gdy tekstura jest bajt w bajt ta sama (nieprzezroczysty PNG bez profilu koloru,
 * ImageBitmap z premultiplyAlpha:"none" — jak UNPACK_PREMULTIPLY_ALPHA false). Zamknięty bliźniak (width 0) jest pomijany.
 */
const twins = new WeakMap<object, ImageBitmap>();

export function setUploadTwin(src: object, bmp: ImageBitmap | null): void {
  if (bmp) twins.set(src, bmp); else twins.delete(src);
}

/** Źródło dla texImage2D / createImageBitmap: bliźniak, gdy jest (i żyje), inaczej `src`. */
export function uploadSource<T>(src: T): T | ImageBitmap {
  const b = src && typeof src === "object" ? twins.get(src as unknown as object) : undefined;
  return b && b.width > 0 ? b : src;
}

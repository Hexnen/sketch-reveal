/**
 * Filtr minimum/maksimum w przesuwnym oknie (BUGHUNT-effects.md, E3) — kolejka monotoniczna, O(n) niezależnie
 * od promienia. Okno [i − r, i + r] przycięte do [0, len − 1] (= dotychczasowe „clamp do krawędzi”: powtórzone
 * wartości brzegowe nie zmieniają min/max). Wynik BAJT W BAJT jak pętla naiwna: min/max to dokładne wybranie
 * jednej z wartości wejścia (bez arytmetyki).
 */

/** Element wejścia: src[so + k·ss]; wyjście: dst[dOff + k·ds]. `dq` = bufor ≥ len (Int32Array, wielokrotnego użytku). */
export function slideExtreme(
  src: ArrayLike<number>, so: number, ss: number,
  dst: { [i: number]: number }, dOff: number, ds: number,
  len: number, r: number, max: boolean, dq: Int32Array,
): void {
  let head = 0, tail = 0, next = 0;
  for (let i = 0; i < len; i++) {
    const hi = Math.min(len - 1, i + r);
    for (; next <= hi; next++) {
      const v = src[so + next * ss];
      if (max) { while (tail > head && src[so + dq[tail - 1] * ss] <= v) tail--; }
      else { while (tail > head && src[so + dq[tail - 1] * ss] >= v) tail--; }
      dq[tail++] = next;
    }
    const lo = i - r;
    while (dq[head] < lo) head++;
    dst[dOff + i * ds] = src[so + dq[head] * ss];
  }
}

/**
 * Separowalny filtr min/max prostokątem (2rx+1)×(2ry+1) na kanale `ch` z `stride` kanałami (wejście `src`, w×h,
 * wiersz po wierszu) → Float32Array w×h (1 kanał). Najpierw wiersze, potem kolumny (jak dotychczasowe pętle).
 */
export function boxExtreme(
  src: ArrayLike<number>, w: number, h: number, stride: number, ch: number, rx: number, ry: number, max: boolean,
): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const dq = new Int32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) slideExtreme(src, y * w * stride + ch, stride, tmp, y * w, 1, w, rx, max, dq);
  for (let x = 0; x < w; x++) slideExtreme(tmp, x, w, out, x, w, h, ry, max, dq);
  return out;
}

/* Raster gazetowy (półton) — czyste obliczenia na pikselach, bez DOM: używane przez stronę (newspaper.mjs, wątek główny)
   i przez wątek roboczy odbitek (halftone-worker.mjs). Wynik jest identyczny w obu miejscach. */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Rozmiar siatki próbek jasności dla prostokąta `w`×`h` i skoku rastra `cell` (2 próbki na komórkę). */
export function halftoneGrid(w, h, cell) {
  const sw = Math.max(8, Math.round(w / (cell * 0.5)));
  return { sw, sh: Math.max(8, Math.round((sw * h) / w)) };
}

/**
 * Jasność 0…1 z pikseli RGBA (sw × sh) po „redakcji fotograficznej”: rozciągnięcie tonów (1.–99,5. percentyl),
 * średnia → ~0,52, łagodna krzywa S i wyostrzenie lokalnego kontrastu.
 */
export function halftoneTone(px, sw, sh) {
  const L = new Float32Array(sw * sh);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) L[i] = (0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]) / 255;
  // inaczej nocna scena wychodzi jako czarny prostokąt. Percentyle z histogramu (1024 przedziały, błąd < 0,001 — bez sortowania).
  const lo = quantile(L, 0.01), hi = Math.max(lo + 0.05, quantile(L, 0.995));
  let mean = 0;
  for (let i = 0; i < L.length; i++) { L[i] = clamp((L[i] - lo) / (hi - lo), 0, 1); mean += L[i]; }
  mean = clamp(mean / L.length, 0.02, 0.98);
  // średnia tonów → ~0,52 (nocna scena nie może wyjść czarnym prostokątem, jasna — wypraną; farba i tak „przyrasta”)
  const gam = clamp(Math.log(0.52) / Math.log(mean), 0.45, 1.6);
  // + łagodna krzywa S: po rozjaśnieniu cienie wracają do czerni, światła do papieru (bez „mgły” na ciemnych kadrach)
  for (let i = 0; i < L.length; i++) { const v = L[i] ** gam; L[i] = v + 0.45 * ((v < 0.5 ? 2 * v * v : 1 - 2 * (1 - v) ** 2) - v); }
  // retusz kliszy: wyostrzenie lokalnego kontrastu (maska nieostra), żeby małe zdjęcie nie zlewało się w plamy
  const bl = boxBlur(L, sw, sh, Math.max(2, Math.round(sw / 160))), amt = 0.9;
  for (let i = 0; i < L.length; i++) L[i] = clamp(L[i] + amt * (L[i] - bl[i]), 0, 1);
  return L;
}

/**
 * Kropki farby na siatce obróconej o 45°, pole kropki ∝ zaczernienie. `L` — jasność (sw × sh) dla prostokąta `rect`
 * (px płótna strony), `cell` — skok siatki. Zwraca piksele RGBA bufora {data, X0, Y0, bw, bh} pokrywającego `rect`
 * (całkowite px; brzegi przycina rysujący): papier (5 % szarszy, farba „przebija”) pod farbą.
 */
export function halftoneRaster(L, sw, sh, rect, cell, ink, paper) {
  const ca = Math.SQRT1_2, sa = Math.SQRT1_2;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, R = Math.hypot(rect.w, rect.h) / 2 + cell;
  // promień kropki z żądanego pokrycia c: do c = π/4 kropki się nie stykają (r = √(c/π)·cell), dalej szybki dojazd do
  // pełnego krycia (r → cell/√2, rogi komórki zalane). Pokrycie liniowe w tonie — półton to ~50 % farby, nie 90 %.
  const PI4 = Math.PI / 4;
  const radius = (cv) => (cv <= PI4 ? Math.sqrt(cv / Math.PI) : 0.5 + ((cv - PI4) / (1 - PI4)) * (Math.SQRT1_2 - 0.5)) * cell;
  // węzeł (i, j) leży w (uu, v) = (−R + i·cell, −R + j·cell); na płótnie x = cx + uu·cos − v·sin, y = cy + uu·sin + v·cos
  const N = Math.floor((2 * R) / cell + 1e-9) + 1;
  const rad = new Float32Array(N * N), kAA = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const v = -R + j * cell;
    for (let i = 0; i < N; i++) {
      const uu = -R + i * cell, x = cx + uu * ca - v * sa, y = cy + uu * sa + v * ca;
      if (x < rect.x - cell || x > rect.x + rect.w + cell || y < rect.y - cell || y > rect.y + rect.h + cell) continue;
      const fx = clamp(((x - rect.x) / rect.w) * sw, 0, sw - 1), fy = clamp(((y - rect.y) / rect.h) * sh, 0, sh - 1);
      const lx = fx | 0, ly = fy | 0, ax = fx - lx, ay = fy - ly, lx1 = Math.min(sw - 1, lx + 1), ly1 = Math.min(sh - 1, ly + 1);
      const l = (L[ly * sw + lx] * (1 - ax) + L[ly * sw + lx1] * ax) * (1 - ay) + (L[ly1 * sw + lx] * (1 - ax) + L[ly1 * sw + lx1] * ax) * ay;
      // krzywa gazetowa: najjaśniejsze światła zostają czystym papierem, najgłębsze cienie zalane do pełna
      const cv = clamp((1 - l - 0.05) / 0.88, 0, 1);
      if (cv <= 0) continue;
      const rr = radius(cv);
      if (rr < 0.28) continue;
      rad[j * N + i] = rr;
      // brzeg wygładzony liniowo na 1 px; skala tak, by ilość farby kropki = π·r² (małe kropki nie ciemnieją)
      kAA[j * N + i] = rr >= 0.5 ? (rr * rr) / (rr * rr + 1 / 12) : (3 * rr * rr) / (rr + 0.5) ** 3;
    }
  }
  // każda kropka stempluje swoje pokrycie w buforze — nakładające się kropki łączą się (maksimum), jak jedna ścieżka
  // wypełniona na płótnie
  const X0 = Math.floor(rect.x), Y0 = Math.floor(rect.y), bw = Math.max(1, Math.ceil(rect.x + rect.w) - X0), bh = Math.max(1, Math.ceil(rect.y + rect.h) - Y0);
  const cov = new Float32Array(bw * bh);
  for (let j = 0; j < N; j++) {
    const v = -R + j * cell;
    for (let i = 0; i < N; i++) {
      const rr = rad[j * N + i];
      if (rr === 0) continue;
      const uu = -R + i * cell, k = kAA[j * N + i], reach = rr + 0.5;
      // środek kropki w układzie bufora (środek piksela X = X + 0,5)
      const x = cx + uu * ca - v * sa - X0 - 0.5, y = cy + uu * sa + v * ca - Y0 - 0.5;
      const xa = Math.max(0, Math.ceil(x - reach)), xb = Math.min(bw - 1, Math.floor(x + reach));
      const ya = Math.max(0, Math.ceil(y - reach)), yb = Math.min(bh - 1, Math.floor(y + reach));
      for (let Y = ya; Y <= yb; Y++) {
        const dy = Y - y, dy2 = dy * dy, row = Y * bw;
        for (let X = xa; X <= xb; X++) {
          const dx = X - x, c = (reach - Math.sqrt(dx * dx + dy2)) * k;
          if (c > cov[row + X]) cov[row + X] = c;
        }
      }
    }
  }
  const data = new Uint8ClampedArray(bw * bh * 4);
  const pn = parseInt(paper.slice(1), 16), kn = parseInt(ink.slice(1), 16), dim = 1 - 13 / 255;
  const pr = ((pn >> 16) & 255) * dim, pg = ((pn >> 8) & 255) * dim, pb = (pn & 255) * dim;
  const ir = (kn >> 16) & 255, ig = (kn >> 8) & 255, ib = kn & 255;
  for (let q = 0, p = 0; q < cov.length; q++, p += 4) {
    const a = cov[q] > 1 ? 1 : cov[q], b = 1 - a;
    data[p] = pr * b + ir * a + 0.5; data[p + 1] = pg * b + ig * a + 0.5; data[p + 2] = pb * b + ib * a + 0.5; data[p + 3] = 255;
  }
  return { data, X0, Y0, bw, bh };
}

/** Kwantyl `q` wartości z [0, 1] z histogramu (1024 przedziały, interpolacja wewnątrz przedziału). */
function quantile(L, q) {
  const B = 1024, h = new Uint32Array(B);
  for (let i = 0; i < L.length; i++) h[Math.min(B - 1, (L[i] * B) | 0)]++;
  const target = Math.floor(L.length * q);
  let acc = 0;
  for (let b = 0; b < B; b++) {
    if (acc + h[b] > target) return (b + (target - acc + 0.5) / h[b]) / B;
    acc += h[b];
  }
  return 1;
}

/** Rozmycie pudełkowe (2 przebiegi ≈ gauss) siatki jasności `L` (sw × sh), promień `rad` próbek. */
function boxBlur(L, sw, sh, rad) {
  const a = Float32Array.from(L), b = new Float32Array(L.length), k = 1 / (2 * rad + 1);
  for (let p = 0; p < 2; p++) {
    // poziomo a → b (suma krocząca, brzegi powielone)
    for (let y = 0, o = 0; y < sh; y++, o += sw) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) s += a[o + (i < 0 ? 0 : i >= sw ? sw - 1 : i)];
      for (let x = 0; x < sw; x++) {
        b[o + x] = s * k;
        const add = x + rad + 1, sub = x - rad;
        s += a[o + (add >= sw ? sw - 1 : add)] - a[o + (sub < 0 ? 0 : sub)];
      }
    }
    // pionowo b → a
    for (let x = 0; x < sw; x++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) s += b[(i < 0 ? 0 : i >= sh ? sh - 1 : i) * sw + x];
      for (let y = 0; y < sh; y++) {
        a[y * sw + x] = s * k;
        const add = y + rad + 1, sub = y - rad;
        s += b[(add >= sh ? sh - 1 : add) * sw + x] - b[(sub < 0 ? 0 : sub) * sw + x];
      }
    }
  }
  return a;
}

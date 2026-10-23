/**
 * Naprawa „wysp” pola czasu (ogon efektu spread, 2026-10-22).
 *
 * Główny Dijkstra w timeField.ts trzyma czasy w Float32Array, a klucze kopca są float64. Gdy zapis do
 * Float32 zaokrągli czas W DÓŁ, przy zdjęciu z kopca `t > T[i]` → komórka nigdy nie jest rozwijana
 * („martwa”). Pierścień martwych komórek odcina obszar: zostaje T = ∞ → po normalizacji płaskie ≈1.
 * Na ekranie: białe dziury stoją bez ruchu od ~p 0.66 i znikają w 1–2 klatkach ok. p 0.75 (pop).
 * Zmierzone na parze testowej: 944 z 36 608 komórek (2,6%), do 161 komórek w jednej wyspie.
 *
 * Samego Dijkstry NIE poprawiamy: martwe komórki kształtują cały dotychczasowy (zaakceptowany) wygląd —
 * poprawny Dijkstra zmienia T średnio o 0,18 (połowa skali) i daje inny, „żyłkowany” front.
 * Zamiast tego: dolewamy wyspy od ich brzegu tym samym kosztem przejścia (jakby martwe komórki jednak
 * się rozwinęły), w float64. Komórki poza wyspami zostają bit w bit takie same.
 */

/** Wewnątrz wysp (T = ∞) liczy surowy czas dotarcia od brzegu wyspy; reszta tablicy bez zmian. */
export function repairIslands(raw: Float32Array, cost: Float32Array, gw: number, gh: number): Float64Array | null {
  const n = gw * gh;
  let any = false;
  for (let i = 0; i < n; i++) if (raw[i] === Infinity) { any = true; break; }
  if (!any) return null;
  const R = Float64Array.from(raw);
  // Prosta kolejka priorytetowa (kopiec binarny na tablicach typowanych); wysp jest mało.
  let hi = new Int32Array(1024), hk = new Float64Array(1024), hn = 0;
  const push = (i: number, k: number) => {
    if (hn === hi.length) {
      const ni = new Int32Array(hn * 2); ni.set(hi); hi = ni;
      const nk = new Float64Array(hn * 2); nk.set(hk); hk = nk;
    }
    let c = hn++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (hk[p] <= k) break;
      hi[c] = hi[p]; hk[c] = hk[p]; c = p;
    }
    hi[c] = i; hk[c] = k;
  };
  const pop = (): number => {
    const top = hi[0];
    const li = hi[--hn], lk = hk[hn];
    let c = 0;
    for (;;) {
      const l = 2 * c + 1, r = l + 1;
      let m = -1, mk = lk;
      if (l < hn && hk[l] < mk) { m = l; mk = hk[l]; }
      if (r < hn && hk[r] < mk) { m = r; mk = hk[r]; }
      if (m < 0) break;
      hi[c] = hi[m]; hk[c] = hk[m]; c = m;
    }
    hi[c] = li; hk[c] = lk;
    return top;
  };
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  // Źródła: skończone komórki stykające się z wyspą (martwy pierścień) — ze swoim czasem.
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (raw[i] === Infinity) continue;
      for (const [dx, dy] of D) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        if (raw[ny * gw + nx] === Infinity) { push(i, R[i]); break; }
      }
    }
  }
  while (hn) {
    const k0 = hk[0];
    const i = pop();
    if (k0 > R[i]) continue;
    const x = i % gw, y = (i / gw) | 0;
    for (const [dx, dy, len] of D) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx;
      if (raw[j] !== Infinity) continue; // poza wyspą nic nie ruszamy
      const nt = k0 + 0.5 * (cost[i] + cost[j]) * len;
      if (nt < R[j]) { R[j] = nt; push(j, nt); }
    }
  }
  return R;
}

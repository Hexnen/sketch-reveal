/**
 * Szkielet → graf → ścieżki (polilinie). Węzły = piksele o liczbie sąsiadów ≠ 2 (końce, skrzyżowania),
 * zgrupowane w klastry. Krawędzie = łańcuchy pikseli między węzłami. Potem: przycięcie ostróg
 * (artefakty szkieletyzacji), sklejenie krawędzi przechodzących prosto przez skrzyżowanie
 * (jedna długa kreska zamiast kawałków), wygładzenie, odrzucenie szumu.
 */

type Slice = () => Promise<void>;

export interface Path {
  /** Wygładzone współrzędne punktów (piksele szkieletu w kolejności rysowania). */
  xs: Float32Array;
  ys: Float32Array;
  /** Skumulowana długość łuku. */
  cum: Float32Array;
  /** Półgrubość linii w punkcie (z transformaty odległości). */
  hw: Float32Array;
  /** Indeksy pikseli szkieletu (do etykietowania). */
  pix: Int32Array;
  L: number;
  meanHw: number;
  /** Mikrokreska: przycięta ostroga lub bardzo krótki odcinek (cegła, szczebel) — własny czas, później. */
  micro: boolean;
  /** Średnia gęstość tuszu 9×9 wzdłuż ścieżki i udział długości w strefie gęstej (> 0,35) — liczone w index.ts. */
  dens: number;
  denseFrac: number;
}

interface Edge { pix: number[]; a: number; b: number; dead: boolean; spur?: boolean }

/**
 * Fabryka bez odwołań na zewnątrz (zależności tylko z parametru) — źródło serializowane do Workera
 * (Blob URL, worker.ts) i wołane na wątku głównym (fallback). Nie odwołuj się tu do importów modułu.
 */
export function traceModule() {
  async function tracePaths(skel: Uint8Array, dt: Float32Array, w: number, h: number, slice: Slice): Promise<Path[]> {
    const n = w * h;
    const off = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]; // N NE E SE S SW W NW
    const four = [true, false, true, false, true, false, true, false];
    const isNode = new Uint8Array(n);
    for (let i = w; i < n - w; i++) {
      if (!skel[i]) continue;
      let c = 0;
      for (let k = 0; k < 8; k++) c += skel[i + off[k]];
      if (c !== 2) isNode[i] = 1;
    }
    // klastry węzłów (8-spójne)
    const nodeId = new Int32Array(n).fill(-1);
    let nNodes = 0;
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!isNode[i] || nodeId[i] >= 0) continue;
      nodeId[i] = nNodes;
      stack.push(i);
      while (stack.length) {
        const q = stack.pop()!;
        for (let k = 0; k < 8; k++) {
          const r = q + off[k];
          if (isNode[r] && nodeId[r] < 0) { nodeId[r] = nNodes; stack.push(r); }
        }
      }
      nNodes++;
    }
    await slice();

    const visited = new Uint8Array(n);
    const edges: Edge[] = [];
    const walk = (start: number, first: number): Edge => {
      const pix = [start, first];
      visited[first] = 1;
      let prev = start, cur = first, end = -1;
      for (;;) {
        let next = -1;
        for (let pass = 0; pass < 2 && next < 0; pass++) {
          for (let k = 0; k < 8; k++) {
            if (four[k] !== (pass === 0)) continue;
            const r = cur + off[k];
            if (r === prev || !skel[r]) continue;
            if (isNode[r]) { if (nodeId[r] !== nodeId[start] || pix.length > 2) { next = r; break; } continue; }
            if (!visited[r]) { next = r; break; }
          }
        }
        if (next < 0) break;
        pix.push(next);
        if (isNode[next]) { end = nodeId[next]; break; }
        visited[next] = 1;
        prev = cur; cur = next;
      }
      return { pix, a: isNode[start] ? nodeId[start] : -1, b: end, dead: false };
    };
    for (let i = 0; i < n; i++) {
      if (!isNode[i]) continue;
      for (let k = 0; k < 8; k++) {
        const r = i + off[k];
        if (skel[r] && !isNode[r] && !visited[r]) edges.push(walk(i, r));
      }
      if ((i & 4095) === 0) await slice();
    }
    // pętle bez węzłów (np. zamknięte kontury)
    for (let i = 0; i < n; i++) {
      if (!skel[i] || isNode[i] || visited[i]) continue;
      visited[i] = 1;
      let r = -1;
      for (let k = 0; k < 8; k++) if (skel[i + off[k]] && !visited[i + off[k]]) { r = i + off[k]; break; }
      if (r < 0) continue;
      const e = walk(i, r);
      e.a = -1;
      edges.push(e);
    }
    await slice();

    const deg = new Int32Array(nNodes);
    const bump = (e: Edge, v: number) => { if (e.a >= 0) deg[e.a] += v; if (e.b >= 0) deg[e.b] += v; };
    for (const e of edges) {
      if (e.a >= 0 && e.a === e.b && e.pix.length < 6) e.dead = true; else bump(e, 1);
    }
    // ostrogi: krótkie odnogi kończące się „w powietrzu”, doczepione do skrzyżowania
    for (const e of edges) {
      if (e.dead) continue;
      const ends = [e.a, e.b];
      for (let s = 0; s < 2; s++) {
        const tip = ends[s], base = ends[1 - s];
        if (tip < 0 || base < 0 || deg[tip] !== 1 || deg[base] < 3) continue;
        const bp = e.pix[s === 0 ? e.pix.length - 1 : 0];
        if (e.pix.length < 3 + 2.2 * dt[bp]) { e.dead = true; e.spur = true; bump(e, -1); break; }
      }
    }
    const live = edges.filter((x) => !x.dead);
    const spurs = edges.filter((x) => x.spur);

    // sklejanie przez węzły: pary końców o kierunkach przeciwnych (kreska przechodzi prosto)
    const P = (i: number) => [i % w, (i / w) | 0];
    const ends: number[][] = Array.from({ length: nNodes }, () => []);
    const dir = new Float32Array(live.length * 4);
    live.forEach((e, ei) => {
      const m = e.pix.length, k = Math.min(m - 1, 7);
      const [x0, y0] = P(e.pix[0]), [xk, yk] = P(e.pix[k]);
      const [x1, y1] = P(e.pix[m - 1]), [xl, yl] = P(e.pix[m - 1 - k]);
      let dx = x0 - xk, dy = y0 - yk, d = Math.hypot(dx, dy) || 1;
      dir[ei * 4] = dx / d; dir[ei * 4 + 1] = dy / d;
      dx = x1 - xl; dy = y1 - yl; d = Math.hypot(dx, dy) || 1;
      dir[ei * 4 + 2] = dx / d; dir[ei * 4 + 3] = dy / d;
      if (e.a >= 0) ends[e.a].push(ei * 2);
      if (e.b >= 0) ends[e.b].push(ei * 2 + 1);
    });
    const partner = new Int32Array(live.length * 2).fill(-1);
    for (let v = 0; v < nNodes; v++) {
      const E = ends[v];
      if (E.length < 2) continue;
      const thr = E.length === 2 ? -0.45 : -0.78;
      const pairs: [number, number, number][] = [];
      for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
        const a = E[i], b = E[j];
        if (a >> 1 === b >> 1) continue;
        const dot = dir[a * 2] * dir[b * 2] + dir[a * 2 + 1] * dir[b * 2 + 1];
        if (dot < thr) pairs.push([dot, a, b]);
      }
      pairs.sort((p, q) => p[0] - q[0]);
      for (const [, a, b] of pairs) if (partner[a] < 0 && partner[b] < 0) { partner[a] = b; partner[b] = a; }
    }
    await slice();

    // łańcuchy krawędzi → ścieżki
    const used = new Uint8Array(live.length);
    const out: Path[] = [];
    const chain = (e0: number, side0: number) => {
      const pix: number[] = [];
      let e = e0, side = side0;
      for (;;) {
        used[e] = 1;
        const p = live[e].pix;
        const seq = side === 0 ? p : p.slice().reverse();
        for (const q of seq) if (pix[pix.length - 1] !== q) pix.push(q);
        const nx = partner[e * 2 + (1 - side)];
        if (nx < 0 || used[nx >> 1]) break;
        e = nx >> 1; side = nx & 1;
      }
      const path = buildPath(pix, dt, w);
      if (path) out.push(path);
    };
    for (let e = 0; e < live.length; e++) {
      if (used[e]) continue;
      if (partner[e * 2] < 0) chain(e, 0);
      else if (partner[e * 2 + 1] < 0) chain(e, 1);
    }
    for (let e = 0; e < live.length; e++) if (!used[e]) chain(e, 0);
    // ostrogi nie są sklejane z liniami, ale nie znikają: zostają mikrokreskami (ząbki cegieł, szczeble)
    for (const e of spurs) {
      const path = buildPath(e.pix, dt, w, true);
      if (path) out.push(path);
    }
    return out;
  }

  function buildPath(pix: number[], dt: Float32Array, w: number, spur = false): Path | null {
    const m = pix.length;
    if (m < 2) return null;
    let xs = new Float32Array(m), ys = new Float32Array(m);
    for (let i = 0; i < m; i++) { xs[i] = pix[i] % w; ys[i] = (pix[i] / w) | 0; }
    // wygładzenie [1 2 1] ×3 z zachowaniem końców (schodki szkieletu → płynna kreska)
    for (let it = 0; it < 3; it++) {
      const nx = xs.slice(), ny = ys.slice();
      for (let i = 1; i < m - 1; i++) {
        nx[i] = (xs[i - 1] + 2 * xs[i] + xs[i + 1]) / 4;
        ny[i] = (ys[i - 1] + 2 * ys[i] + ys[i + 1]) / 4;
      }
      xs = nx; ys = ny;
    }
    const cum = new Float32Array(m);
    const hw = new Float32Array(m);
    let hs = 0;
    for (let i = 0; i < m; i++) {
      if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
      hw[i] = dt[pix[i]];
      hs += hw[i];
    }
    const L = cum[m - 1], meanHw = hs / m;
    if (L < 1) return null;
    // krótsza niż ~2,5× swoja grubość = mikrokreska (osobny, późniejszy czas — nie „przyklejona” BFS-em do linii)
    const micro = spur || L < Math.max(4, 2.5 * meanHw);
    return { xs, ys, cum, hw, pix: Int32Array.from(pix), L, meanHw, micro, dens: 0, denseFrac: 0 };
  }
  return { tracePaths };
}

export const { tracePaths } = traceModule();

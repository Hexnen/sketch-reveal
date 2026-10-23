/**
 * Detektor adaptacyjny — drzewo komponentów (krok 2) i cechy blobów (krok 3).
 *
 * Wielo-skalowa detekcja blobów jako drzewo komponentów sygnału Z (z-score emisji/luminancji, analyzePlanes.ts,
 * jak MSER): poziomy Z ≥ z_l, 10 poziomów geometrycznie od z = 1,2 do 0,97·max Z sceny (geometrycznie: kolejne poziomy wycinają coraz jaśniejsze rdzenie). Komponent poziomu
 * l ma rodzica na poziomie l−1 (zawiera go), więc każda oprawa jest widziana w wielu skalach naraz: cały szyld z
 * poświatą → pojedyncze litery → rdzenie liter. Wybór skali robi model (analyzeSelect.ts), nie próg.
 *
 * Cechy bloba (wszystkie względne: do kadru, do sceny albo do samego bloba) — FEATURES w analyzeModel.ts:
 *  - kształt: log powierzchni (ułamek kadru), wydłużenie (momenty), wypełnienie bbox, okrągłość, stabilność
 *    w drzewie (log stosunku powierzchni rodzica do bloba — stabilny blob = wyraźna krawędź emitera);
 *  - jasność: p95 V, emisja i luminancja w jednostkach MAD sceny;
 *  - kontrast w wielu skalach: V wnętrza minus średnia V w pierścieniach 0,5/1/2/4 promienia równoważnego
 *    (obraz całkowy) i profil spadku poświaty (udział spadku w pierścieniach 1 i 2 — poświata namalowana wokół
 *    źródła vs ostra krawędź jasnej płaszczyzny), jasność dalekiego otoczenia (kontekst);
 *  - barwa: c90 chromy, temperatura (R−B)/(R+B) i odcień zielony–purpurowy barwy ważonej chromą, spójność barwy
 *    (|Σ wektorów chromatyczności| / Σ |…|);
 *  - przepalenie (V ≥ 0,97 — granica formatu 8-bit) i „biały żar” (przepalone i mało nasycone);
 *  - tekstura wnętrza: średni |∇V| względem jasności i gęstość krawędzi (> 4× mediana |∇V| sceny — ekran z treścią);
 *  - położenie (y), powtarzalność (ile podobnych blobów na tym samym poziomie — okna fasady, diody szafy);
 *  - ekspozycja sceny i jej iloczyny (model sam uczy się, że w jasnej scenie kontrast znaczy mniej).
 */
import { rectV, type Planes, type SceneStats } from "./analyzePlanes";

export const LEVELS = 10;
/** Najmniejszy blob-kandydat [px analizy]: 1–2 px to szum/faktura (cechy pierścieni są dla nich zdegenerowane);
 *  najmniejsza dioda LED po pomniejszeniu do 768 px ma ~3 px. */
export const MIN_AREA = 3;
const Z0 = 1.2, MAX_NODES_PER_LEVEL = 3000;

export interface Node {
  id: number; level: number; parent: number; children: number[];
  area: number; x0: number; y0: number; x1: number; y1: number;
  sx: number; sy: number; sxx: number; syy: number; sxy: number;
  sV: number; sE: number; sY: number; sG: number; mV: number; edge: number; clip: number; white: number;
  hv: Uint16Array; hc: Uint16Array;
  cr: number; cg: number; cb: number; cw: number; o1: number; o2: number; oa: number;
  /** wyliczone */
  cx: number; cy: number; req: number; p95: number; c90: number; temp: number; tint: number;
  /** barwa liniowa znormalizowana (max = 1) i odcień barwy ważonej chromą (diagnostyka/oświetlone) */
  color: [number, number, number]; hue: number;
  f: Float32Array;
  prob: number; kindP: Float32Array; kind: number;
}

export interface Tree { nodes: Node[]; labs: Int32Array[]; thr: number[] }

const H = 32;
const newNode = (id: number, level: number, parent: number, aw: number, ah: number): Node => ({
  id, level, parent, children: [], area: 0, x0: aw, y0: ah, x1: 0, y1: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0,
  sV: 0, sE: 0, sY: 0, sG: 0, mV: 0, edge: 0, clip: 0, white: 0, hv: new Uint16Array(H), hc: new Uint16Array(H),
  cr: 0, cg: 0, cb: 0, cw: 0, o1: 0, o2: 0, oa: 0, cx: 0, cy: 0, req: 0, p95: 0, c90: 0, temp: 0, tint: 0,
  color: [1, 1, 1], hue: 0, f: new Float32Array(0), prob: 0, kindP: new Float32Array(0), kind: 0,
});

const pctH = (h: Uint16Array, n: number, q: number) => {
  let acc = 0;
  for (let i = 0; i < H; i++) { acc += h[i]; if (acc >= q * n) return (i + 0.5) / H; }
  return 1;
};
export const hueOf = (r: number, g: number, b: number): number => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-6) return 0;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
};
export const hueDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export async function buildTree(P: Planes, st: SceneStats, slice: () => Promise<void>): Promise<Tree> {
  const { V, C, E, G, Z, Y, px, aw, ah } = P, N = aw * ah;
  const nodes: Node[] = [], labs: Int32Array[] = [], thr: number[] = [];
  const stack = new Int32Array(N);
  const gEdge = 4 * st.gMed;
  let prev: Int32Array | null = null, zMax = 0;
  for (let i = 0; i < N; i++) if (Z[i] > zMax) zMax = Z[i];
  // poziomy geometrycznie od Z0 do 0,97·max(Z) TEJ sceny: góra skali zawsze jest pocięta (płomień nad woskiem,
  // żarnik nad stożkiem), niezależnie od tego, czy max to z = 3 (dzień) czy 30 (ciemna scena z lampą)
  const zTop = Math.max(Z0 * 1.2, 0.97 * zMax);
  for (let l = 0; l < LEVELS; l++) {
    const T = Z0 * Math.pow(zTop / Z0, l / (LEVELS - 1));
    if (T >= zMax) break;
    const lab = new Int32Array(N);
    let made = 0;
    for (let i0 = 0; i0 < N; i0++) {
      if (Z[i0] < T || lab[i0] || (prev && !prev[i0])) continue;
      const parent = prev ? prev[i0] - 1 : -1;
      const nd = newNode(nodes.length, l, parent, aw, ah);
      const id = nodes.length + 1;
      let sp = 0; stack[sp++] = i0; lab[i0] = id;
      while (sp) {
        const i = stack[--sp], x = i % aw, y = (i / aw) | 0, v = V[i], c = C[i];
        nd.area++; nd.sx += x; nd.sy += y; nd.sxx += x * x; nd.syy += y * y; nd.sxy += x * y;
        if (x < nd.x0) nd.x0 = x; if (x > nd.x1) nd.x1 = x; if (y < nd.y0) nd.y0 = y; if (y > nd.y1) nd.y1 = y;
        if (v > nd.mV) nd.mV = v;
        nd.sV += v; nd.sE += E[i]; nd.sY += Y[i]; nd.sG += G[i]; if (G[i] > gEdge) nd.edge++;
        if (v >= 0.97) { nd.clip++; if (c < 0.3 * v) nd.white++; }
        nd.hv[Math.min(H - 1, (v * H) | 0)]++; nd.hc[Math.min(H - 1, (c * H) | 0)]++;
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
        nd.cr += c * r; nd.cg += c * g; nd.cb += c * b; nd.cw += c;
        const o1 = r - g, o2 = (r + g - 2 * b) * 0.577;
        nd.o1 += o1; nd.o2 += o2; nd.oa += Math.sqrt(o1 * o1 + o2 * o2);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= ah) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= aw) continue;
            const j = yy * aw + xx;
            if (!lab[j] && Z[j] >= T) { lab[j] = id; stack[sp++] = j; }
          }
        }
      }
      nodes.push(nd); made++;
      if (parent >= 0) nodes[parent].children.push(nd.id);
      if ((made & 63) === 0) await slice();
      if (made >= MAX_NODES_PER_LEVEL) break;
    }
    labs.push(lab); thr.push(T); prev = lab;
    await slice();
  }
  const mx = maxPyramid(V, aw, ah);
  for (const nd of nodes) measure(nd, P, st, nodes, mx);
  repetition(nodes);
  return { nodes, labs, thr };
}

/** Średnia V w pierścieniu między bbox+d0 a bbox+d1. */
function ring(P: Planes, nd: Node, d0: number, d1: number): number {
  const [s1, n1] = rectV(P, nd.x0 - d1, nd.y0 - d1, nd.x1 + 1 + d1, nd.y1 + 1 + d1);
  const [s0, n0] = rectV(P, nd.x0 - d0, nd.y0 - d0, nd.x1 + 1 + d0, nd.y1 + 1 + d0);
  return n1 - n0 > 0 ? (s1 - s0) / (n1 - n0) : s1 / Math.max(1, n1);
}

export const FEATURE_COUNT = 31;

/** Mapa maksimów V w komórkach 4×4 px (dominacja bloba w otoczeniu bez skanowania pełnej rozdzielczości). */
const CELL = 4;
function maxPyramid(V: Float32Array, aw: number, ah: number) {
  const cw = Math.ceil(aw / CELL), ch = Math.ceil(ah / CELL), m = new Float32Array(cw * ch);
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
    const j = ((y / CELL) | 0) * cw + ((x / CELL) | 0);
    if (V[y * aw + x] > m[j]) m[j] = V[y * aw + x];
  }
  return { m, cw, ch };
}

function measure(nd: Node, P: Planes, st: SceneStats, nodes: Node[], mx: { m: Float32Array; cw: number; ch: number }) {
  const { aw, ah } = P, N = aw * ah, a = nd.area;
  nd.cx = nd.sx / a; nd.cy = nd.sy / a; nd.req = Math.sqrt(a / Math.PI);
  nd.p95 = pctH(nd.hv, a, 0.95); nd.c90 = pctH(nd.hc, a, 0.9);
  const cw = Math.max(1e-6, nd.cw), r = nd.cr / cw, g = nd.cg / cw, b = nd.cb / cw;
  nd.temp = (r - b) / (r + b + 1); nd.tint = (2 * g - r - b) / (r + g + b + 1);
  nd.hue = hueOf(r, g, b);
  const cl = nd.cw > 0 ? [lin(r / 255), lin(g / 255), lin(b / 255)] : [1, 1, 1], m = Math.max(1e-4, ...cl);
  nd.color = [cl[0] / m, cl[1] / m, cl[2] / m];
  const bw = nd.x1 - nd.x0 + 1, bh = nd.y1 - nd.y0 + 1;
  const vx = nd.sxx / a - nd.cx * nd.cx + 1 / 12, vy = nd.syy / a - nd.cy * nd.cy + 1 / 12, cxy = nd.sxy / a - nd.cx * nd.cy;
  const tr = vx + vy, det = Math.sqrt(Math.max(0, (vx - vy) ** 2 + 4 * cxy * cxy));
  const l1 = (tr + det) / 2, l2 = Math.max(1e-3, (tr - det) / 2);
  // pierścienie 0,5/1/2/4 promienia, ale nie węższe niż 2/4/7/12 px analizy — poświata namalowana wokół małego
  // źródła (dioda, okno) ma kilka px; węższe pierścienie byłyby szumem
  const vin = nd.sV / a, d = [0.5, 1, 2, 4].map((k, j) => Math.max([2, 4, 7, 12][j], Math.ceil(k * nd.req) + 1));
  const m1 = ring(P, nd, 0, d[0]), m2 = ring(P, nd, d[0], d[1]), m3 = ring(P, nd, d[1], d[2]), m4 = ring(P, nd, d[2], d[3]);
  const drop = vin - m4 + 0.02;
  const par = nd.parent >= 0 ? nodes[nd.parent].area : a;
  const logA = Math.log(a / N), cFar = vin - m4;
  const f = new Float32Array(FEATURE_COUNT);
  f[0] = logA;
  f[1] = 0.5 * Math.log(l1 / l2);
  f[2] = a / (bw * bh);
  f[3] = Math.min(1, a / (Math.PI * (Math.max(bw, bh) / 2) ** 2));
  f[4] = nd.p95;
  f[5] = Math.log(1 + Math.max(0, (nd.sE / a - st.eMed) / st.eMad));
  f[6] = vin - m1;
  f[7] = cFar;
  f[8] = Math.max(-2, Math.min(2, (m1 - m4) / drop));
  f[9] = Math.max(-2, Math.min(2, (m2 - m4) / drop));
  f[10] = m4;
  f[11] = nd.c90;
  f[12] = nd.temp;
  f[13] = nd.tint;
  f[14] = nd.oa > 0 ? Math.hypot(nd.o1, nd.o2) / nd.oa : 0;
  f[15] = nd.clip / a;
  f[16] = nd.white / a;
  f[17] = nd.sG / a / (vin + 0.05);
  f[18] = nd.edge / a;
  f[19] = nd.cy / ah;
  f[20] = Math.log(par / a);
  // f[21] = powtarzalność (repetition)
  f[22] = st.exposure;
  f[23] = st.exposure * cFar;
  f[24] = st.exposure * logA;
  f[25] = Math.log(1 + Math.max(0, (nd.sY / a - st.yMed) / st.yMad));
  // kontrast Webera (względny do jasności otoczenia — ta sama wartość w ciemnej i jasnej scenie)
  f[26] = (vin - m1) / (m1 + 0.05);
  f[27] = cFar / (m4 + 0.05);
  // jasność ponad oświetlenie rozproszone sceny (EV ponad klucz): w jasnej scenie LDR nie ma „zapasu” nad kluczem,
  // więc biały dach w słońcu (≤ 1 EV) nie wygląda jak okno nocą (2,5+ EV)
  f[28] = Math.log2((nd.p95 + 0.01) / (st.key + 0.01));
  // dominacja: maks. V bloba minus maks. V w otoczeniu 2 promieni (komórki 4×4) — ≤ 0; < 0, gdy obok jest coś
  // jaśniejszego (wosk pod płomieniem, ściana przy lampie)
  const pad = Math.ceil(2 * nd.req) + 2;
  const cx0 = Math.max(0, ((nd.x0 - pad) / CELL) | 0), cx1 = Math.min(mx.cw - 1, ((nd.x1 + pad) / CELL) | 0);
  const cy0 = Math.max(0, ((nd.y0 - pad) / CELL) | 0), cy1 = Math.min(mx.ch - 1, ((nd.y1 + pad) / CELL) | 0);
  let around = 0;
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) if (mx.m[y * mx.cw + x] > around) around = mx.m[y * mx.cw + x];
  f[29] = Math.min(0, nd.mV - around);
  // kontrast w drzewie: V bloba wobec reszty rodzica (otoczenie „w tej samej skali” — odpowiednik DoG)
  if (nd.parent >= 0 && nodes[nd.parent].area > a) {
    const pr = nodes[nd.parent], rest = (pr.sV - nd.sV) / (pr.area - a);
    f[30] = (vin - rest) / (rest + 0.05);
  }
  void m3;
  nd.f = f;
}

/** Powtarzalność: ile blobów tego samego poziomu ma podobną skalę (±0,5 log), temperaturę (±0,2) i kontrast. */
function repetition(nodes: Node[]) {
  const byLevel = new Map<number, Node[]>();
  for (const n of nodes) { const l = byLevel.get(n.level); if (l) l.push(n); else byLevel.set(n.level, [n]); }
  for (const list of byLevel.values()) {
    const cand = list.filter((n) => n.area >= 3).sort((a, b) => a.f[0] - b.f[0]);
    let lo = 0;
    for (let i = 0; i < cand.length; i++) {
      const a = cand[i];
      while (cand[lo].f[0] < a.f[0] - 0.5) lo++;
      let c = 0;
      for (let j = lo; j < cand.length && cand[j].f[0] <= a.f[0] + 0.5; j++) {
        const b = cand[j];
        if (j !== i && Math.abs(a.temp - b.temp) < 0.2 && Math.abs(a.f[7] - b.f[7]) < 0.15) c++;
      }
      a.f[21] = Math.log(1 + c);
    }
  }
}

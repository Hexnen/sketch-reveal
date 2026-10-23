/**
 * Detektor adaptacyjny — ocena blobów modelem i wybór skali w drzewie (krok 5).
 *
 * Każdy węzeł drzewa dostaje ciągłą pewność p (model) i rozkład rodzajów. Wybór: od najwyższych poziomów w dół
 * węzeł zastępuje swoje dzieci, gdy jego p > max p dzieci + δ (rdzeń ma pierwszeństwo przed blobem z poświatą)
 * i nie przekracza limitu powierzchni źródła. Wynik to antyłańcuch drzewa (rozłączne
 * bloby). Suwaki: czułość mnoży p, rygor neonu przesuwa logit neonów, przełączniki wyłączają rodzaje.
 */
import { emitLogit, kindProbs, MK_DISC, MK_LED, MK_NEON, MK_SCREEN, MK_SKY, type DetectorWeights } from "./analyzeModel";
import type { GlowDetectOptions } from "./analyzeOpts";
import { MIN_AREA, type Node, type Tree } from "./analyzeTree";

export function scoreNodes(tree: Tree, W: DetectorWeights, o: GlowDetectOptions) {
  const off = new Set<number>();
  if (!o.discs) off.add(MK_DISC);
  if (!o.leds) off.add(MK_LED);
  if (!o.skylights) off.add(MK_SKY);
  for (const nd of tree.nodes) {
    nd.kind = MK_NEON; nd.prob = 0;
    if (nd.area < MIN_AREA) continue; // zbyt mały — nie może zostać wybrany (oszczędza ocenę modelu)
    let lg = emitLogit(nd.f, W);
    // rodzaj liczony tylko dla węzłów, które mogą przekroczyć próg dołączenia nawet po suwakach (czułość ≤ 2^1,5,
    // rygor neonu ≥ −2 logitu); reszta zostaje neonem z p ≈ 0 (bez wpływu na wynik)
    if (lg < -6) { nd.prob = 1 / (1 + Math.exp(-lg)); continue; }
    const kp = kindProbs(nd.f, W);
    if (!o.screens) kp[MK_SCREEN] = 0; // ekrany wyłączone → najbliższy inny rodzaj (dawniej: neon)
    let k = 0;
    for (let i = 1; i < kp.length; i++) if (kp[i] > kp[k]) k = i;
    nd.kindP = kp; nd.kind = k;
    if (k === MK_NEON) lg -= (o.neonStrict - 0.5) * 4;
    let p = 1 / (1 + Math.exp(-lg));
    if (off.has(k)) p = 0;
    nd.prob = o.sensitivity === 1 ? p : Math.min(1, p * Math.pow(o.sensitivity, 1.5));
  }
}

/** Wybór rozłącznych blobów (antyłańcuch drzewa) i bezpiecznik łącznej powierzchni. */
export function selectNodes(tree: Tree, W: DetectorWeights, o: GlowDetectOptions, N: number): Node[] {
  const { nodes } = tree;
  const best: Node[][] = new Array(nodes.length);
  const order = nodes.map((_, i) => i).sort((a, b) => nodes[b].level - nodes[a].level);
  for (const i of order) {
    const nd = nodes[i];
    const ch: Node[] = [];
    for (const c of nd.children) for (const x of best[c]) ch.push(x);
    let mx = 0;
    for (const x of ch) if (x.prob > mx) mx = x.prob;
    // tarcza i ekran to z definicji duże jednolite powierzchnie: 2× limit źródła
    const lim = nd.kind === MK_DISC || nd.kind === MK_SCREEN ? 2 : 1;
    const ok = nd.area <= lim * o.maxCompFrac * N && nd.area >= MIN_AREA;
    // rodzic zastępuje dzieci tylko, gdy jest WYRAŹNIE pewniejszy (o δ): maska emitera = rdzeń, poświatę dorysuje
    // renderer (większy blob z namalowaną poświatą zawyżałby maskę i zjadał limit łączny)
    best[i] = ok && (nd.prob > mx + W.delta || ch.length === 0) ? [nd] : ch;
  }
  const out: Node[] = [];
  for (const nd of nodes) if (nd.level === 0) for (const x of best[nd.id]) if (x.prob >= W.thetaJoin) out.push(x);
  // łączna powierzchnia emiterów (bez LED — z założenia drobne) ≤ maxEmitFrac: nadmiar od najmniej pewnych
  const em = out.filter((n) => n.kind !== MK_LED).sort((a, b) => b.prob - a.prob || a.area - b.area);
  let acc = 0;
  const drop = new Set<Node>();
  for (const n of em) { acc += n.area; if (acc > o.maxEmitFrac * N) drop.add(n); }
  return out.filter((n) => !drop.has(n));
}

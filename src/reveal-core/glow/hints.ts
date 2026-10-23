/**
 * Warstwa semantyczna rozbłysku: podpowiedzi modelu wizyjnego (`LightHint`) łączone z analizą lokalną.
 *
 * Zasada: model PODPOWIADA, obraz DECYDUJE. `applyHints` jest czystą funkcją (nie mutuje wejścia — analiza jest
 * keszowana w index.ts):
 *  - podpowiedź pokrywająca lokalną oprawę (w promieniu r, zgodna barwa) → potwierdzenie: wyższa pewność, rodzaj
 *    i migotanie z podpowiedzi (`hint` na oprawie, `source: "auto"`),
 *  - podpowiedź nad „oświetloną” łatą (KIND_LIT) z jasnym rdzeniem → awans łaty na emiter (`source: "hint"`),
 *  - podpowiedź bez lokalnej oprawy → nowe źródło TYLKO wtedy, gdy obraz ma tam jasną plamę (maksimum jasności
 *    w oknie r wyraźnie ponad pierścieniem tła); w ciemnym/płaskim miejscu podpowiedź jest odrzucana — model nie
 *    może „wymyślić” światła,
 *  - lokalna oprawa bez podpowiedzi → pewność × `unconfirmedFactor` (domyślnie 0,75); `strict` = mocniej, a słabe
 *    są tłumione (stają się nieświecącą łatą).
 * Bez podpowiedzi (null) index.ts w ogóle tego nie woła — offline/Foundry działa na samym detektorze lokalnym.
 */
import {
  KIND_LAMP, KIND_LED, KIND_LIT, KIND_NEON, KIND_SCREEN, KIND_SKY, KIND_WINDOW,
  type Comp, type Fixture, type GlowAnalysis,
} from "./analyzeTypes";
import type { LightHint, LightHintKind } from "./hintsSanitize";

export { LIGHT_HINT_KINDS, MAX_HINTS, normalizeHintKind, sanitizeHints } from "./hintsSanitize";
export type { LightHint, LightHintKind, SanitizeOptions } from "./hintsSanitize";

/**
 * Oprawa po scaleniu z podpowiedziami. UZGODNIENIE z detektorem lokalnym (analyzeTypes.ts): pola `source`/`hint`
 * nie istnieją w `Fixture` — dodane tu jako rozszerzenie (opcjonalne, ignorowane przez ignite/renderer). Gdy detektor
 * lokalny doda `source?: "auto" | "hint"` do `Fixture`, ten typ można zredukować do aliasu.
 * `flicker` (0..1) — migotanie per oprawa z podpowiedzi; ignite.ts na razie używa globalnego `params.flicker`.
 */
export interface HintedFixture extends Fixture {
  source?: "auto" | "hint";
  hint?: { kind: LightHintKind; label?: string; confidence: number };
  flicker?: number;
}

export interface HintReport {
  index: number;
  kind: LightHintKind;
  label?: string;
  status: "confirmed" | "promoted" | "added" | "rejected";
  /** confirmed/promoted/added: indeksy opraw; rejected: powód. */
  fixtures?: number[];
  reason?: "dark" | "flat" | "too-big" | "no-pixels" | "full" | "low-confidence" | "pattern" | "surface" | "large";
  /** Jasność szczytu i kontrast względem pierścienia (diagnostyka „czy obraz tam świeci”). */
  peak?: number; contrast?: number;
}

export interface HintedAnalysis extends GlowAnalysis {
  fixtures: HintedFixture[];
  hintReport: HintReport[];
}

/** Piksele obrazu RGBA (dowolny rozmiar — próbkowane w siatce analizy). Potrzebne do dodawania nowych źródeł. */
export interface HintPixels { data: Uint8ClampedArray | Uint8Array; w: number; h: number }

export interface ApplyHintsOptions {
  pixels?: HintPixels | null;
  /** Lokalne oprawy bez podpowiedzi: pewność × 0,35, a < 0,2 → tłumione. Domyślnie false (tylko × unconfirmedFactor). */
  strict?: boolean;
  unconfirmedFactor?: number;
  /** Podpowiedzi poniżej tej pewności są ignorowane. */
  minConfidence?: number;
  /** Ile potwierdzenie dokłada do pewności (× pewność podpowiedzi × brakująca część). */
  confirmBoost?: number;
  /** Minimalny szczyt „jasności światła” (½Y + ½V) i kontrast szczyt − pierścień dla nowego źródła. */
  addMinPeak?: number;
  addMinContrast?: number;
  /** Największa powierzchnia nowego źródła (udział kadru). */
  maxAddFrac?: number;
  /**
   * Bezpiecznik pętli powtórzeń modelu (tani model potrafi wypisać „siatkę” identycznych okien/LED-ów co 2% kadru):
   * grupa > patternMax podpowiedzi o tym samym rodzaju, promieniu i etykiecie może tylko POTWIERDZAĆ lokalne oprawy.
   */
  patternMax?: number;
  /** Mediana odstępu (uv wysokości) poniżej której grupa jest „siatką” (pętle modelu: co ~2% kadru). */
  patternStep?: number;
  /** Podpowiedź większa niż to (uv wysokości) może tylko potwierdzać — w dużym oknie „najjaśniejsze” to przypadek. */
  maxAddR?: number;
  /** Zapas dopasowania podpowiedź ↔ oprawa (uv wysokości): tani model myli położenie o 3–6% kadru. */
  matchSlack?: number;
}

const DEF: Required<Omit<ApplyHintsOptions, "pixels">> = {
  strict: false, unconfirmedFactor: 0.75, minConfidence: 0.3, confirmBoost: 0.6,
  addMinPeak: 0.6, addMinContrast: 0.22, maxAddFrac: 0.015, patternMax: 5, patternStep: 0.05, maxAddR: 0.15, matchSlack: 0.05,
};

/** Rodzaj podpowiedzi → rodzaj renderu (null = zostaw lokalny / „okno” dla nowych). */
export function hintKindToKind(k: LightHintKind): number | null {
  switch (k) {
    case "neon": case "hologram": return KIND_NEON;
    case "window": case "sun": case "moon": case "candle": case "fire": return KIND_WINDOW;
    case "lamp": return KIND_LAMP;
    case "screen": return KIND_SCREEN;
    case "led": return KIND_LED;
    case "skylight": return KIND_SKY;
    default: return null;
  }
}

const lin = (c: number) => Math.pow(c, 2.2);
function hueSat(c: readonly number[]): [number, number] {
  const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]), d = mx - mn;
  if (mx <= 0 || d <= 1e-6) return [0, 0];
  let h = mx === c[0] ? ((c[1] - c[2]) / d) % 6 : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, d / mx];
}
/** Zgodność barwy: obie prawie białe, jedna biała (przepalony rdzeń), albo odcień ±45°. */
function colorCompat(hintSrgb: readonly number[], fixLin: readonly number[]): boolean {
  const [h1, s1] = hueSat(hintSrgb.map(lin)), [h2, s2] = hueSat(fixLin);
  if (s1 < 0.2 || s2 < 0.2) return true;
  const d = Math.abs(h1 - h2) % 360;
  return Math.min(d, 360 - d) <= 45;
}

const ss = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function applyHints(an: GlowAnalysis, hints: readonly LightHint[], opts: ApplyHintsOptions = {}): HintedAnalysis {
  const o = { ...DEF, ...opts };
  const asp = an.aw / an.ah;
  const F: HintedFixture[] = an.fixtures.map((f) => ({ ...f, members: f.members.slice(), source: "auto" as const }));
  const C: Comp[] = an.comps.map((c) => ({ ...c }));
  let tex = an.tex;
  const report: HintReport[] = [];
  const gkey = (h: LightHint) => `${h.kind}|${h.r.toFixed(3)}|${h.label ?? ""}|${h.confidence}`;
  const groups = new Map<string, LightHint[]>();
  for (const h of hints) { const k = gkey(h); groups.set(k, [...(groups.get(k) ?? []), h]); }
  /** Siatka z pętli: > patternMax identycznych podpowiedzi o medianie odstępu do najbliższej < patternStep. */
  const pattern = new Set<string>();
  for (const [k, g] of groups) {
    if (g.length <= o.patternMax) continue;
    const nn = g.map((a) => Math.min(...g.filter((b) => b !== a).map((b) => Math.hypot((a.x - b.x) * asp, a.y - b.y)))).sort((a, b) => a - b);
    if (nn[nn.length >> 1] < o.patternStep) pattern.add(k);
  }
  // scena dzienna (klucz sceny detektora): nowe źródła tylko przy wyraźnie mocniejszym kontraście
  const day = an.scene?.day ?? 0;
  const addPeak = o.addMinPeak + 0.25 * day, addContrast = o.addMinContrast + 0.25 * day;
  const confirmed = new Set<number>();
  const best = new Map<number, number>(); // oprawa → pewność najlepszej podpowiedzi

  const dist = (x: number, y: number, cx: number, cy: number) => Math.hypot((cx - x) * asp, cy - y);
  const near = (h: LightHint, f: Fixture) => {
    let d = dist(h.x, h.y, f.cx, f.cy) - f.r;
    for (const ci of f.members) d = Math.min(d, dist(h.x, h.y, C[ci].cx, C[ci].cy) - C[ci].r);
    return d <= h.r + o.matchSlack;
  };
  const setConf = (fi: number, conf: number) => {
    const f = F[fi], k = f.conf > 1e-6 ? conf / f.conf : 0;
    for (const ci of f.members) C[ci].conf = Math.min(1, k ? C[ci].conf * k : conf);
    f.conf = conf;
  };

  hints.forEach((h, index) => {
    const base = { index, kind: h.kind, ...(h.label ? { label: h.label } : {}) };
    if (h.confidence < o.minConfidence) { report.push({ ...base, status: "rejected", reason: "low-confidence" }); return; }
    const mapped = hintKindToKind(h.kind);
    // 1) potwierdzenie lokalnych emiterów
    const hit: number[] = [];
    F.forEach((f, fi) => { if (f.kind !== KIND_LIT && fi < an.fixtures.length && near(h, f) && colorCompat(h.color, f.color)) hit.push(fi); });
    if (hit.length) {
      for (const fi of hit) {
        const f = F[fi];
        if ((best.get(fi) ?? -1) >= h.confidence) { confirmed.add(fi); continue; }
        best.set(fi, h.confidence); confirmed.add(fi);
        const orig = an.fixtures[fi].conf;
        setConf(fi, Math.min(1, Math.max(orig + o.confirmBoost * h.confidence * (1 - orig), 0.5 * h.confidence)));
        if (mapped !== null && h.confidence >= 0.5 && !f.disc) f.kind = mapped;
        if (h.flicker !== undefined) f.flicker = h.flicker;
        f.hint = { kind: h.kind, ...(h.label ? { label: h.label } : {}), confidence: h.confidence };
      }
      report.push({ ...base, status: "confirmed", fixtures: hit });
      return;
    }
    if (pattern.has(gkey(h))) { report.push({ ...base, status: "rejected", reason: "pattern" }); return; }
    // 2) awans „oświetlonej” łaty z jasnym rdzeniem (detektor uznał ją za odbicie/plamę)
    const lit: number[] = [];
    F.forEach((f, fi) => { if (f.kind === KIND_LIT && fi < an.fixtures.length && f.bright >= addPeak + 0.15 && near(h, f)) lit.push(fi); });
    if (lit.length && h.confidence >= 0.5) {
      for (const fi of lit) {
        const f = F[fi];
        f.kind = mapped ?? KIND_WINDOW; f.parent = -1; f.gain = 1; f.source = "hint";
        f.color = colorCompat(h.color, f.color) && f.color.some((c) => c < 0.999) ? f.color : (h.color.map(lin) as [number, number, number]);
        setConf(fi, 0.35 + 0.4 * h.confidence);
        for (const ci of f.members) C[ci].conf = f.conf;
        if (h.flicker !== undefined) f.flicker = h.flicker;
        f.hint = { kind: h.kind, ...(h.label ? { label: h.label } : {}), confidence: h.confidence };
        confirmed.add(fi);
      }
      report.push({ ...base, status: "promoted", fixtures: lit });
      return;
    }
    // 3) nowe źródło — tylko nad jasną plamą
    if (!o.pixels) { report.push({ ...base, status: "rejected", reason: "no-pixels" }); return; }
    if (h.r > o.maxAddR) { report.push({ ...base, status: "rejected", reason: "large" }); return; }
    if (C.length >= 255) { report.push({ ...base, status: "rejected", reason: "full" }); return; }
    if (tex === an.tex) tex = an.tex.slice();
    const disc = h.kind === "sun" || h.kind === "moon"; // tarcza na jasnym niebie: mały kontrast, ale prawie biała
    const r = addSource(an, tex, C, F, h, mapped, disc ? { ...o, addMinPeak: 0.9, addMinContrast: 0.08 } : { ...o, addMinPeak: addPeak, addMinContrast: addContrast });
    report.push({ ...base, ...r });
  });

  // lokalne emitery bez podpowiedzi
  F.forEach((f, fi) => {
    if (fi >= an.fixtures.length || f.kind === KIND_LIT || confirmed.has(fi)) return;
    if (!o.strict) { setConf(fi, f.conf * o.unconfirmedFactor); return; }
    const c = f.conf * 0.35;
    if (c < 0.2) { f.kind = KIND_LIT; f.parent = -1; f.gain = 0; setConf(fi, c); } else setConf(fi, c);
  });
  return { ...an, comps: C, fixtures: F, tex, hintReport: report };
}

/** Jasność „światła” piksela analizy (½Y + ½V) z obrazu dowolnego rozmiaru. */
function lightAt(px: HintPixels, an: GlowAnalysis, x: number, y: number): number {
  const sx = Math.min(px.w - 1, Math.floor((x + 0.5) * px.w / an.aw)), sy = Math.min(px.h - 1, Math.floor((y + 0.5) * px.h / an.ah));
  const i = (sy * px.w + sx) * 4, r = px.data[i] / 255, g = px.data[i + 1] / 255, b = px.data[i + 2] / 255;
  return 0.5 * (0.2126 * r + 0.7152 * g + 0.0722 * b) + 0.5 * Math.max(r, g, b);
}

function addSource(
  an: GlowAnalysis, tex: Uint8Array, C: Comp[], F: HintedFixture[], h: LightHint, mapped: number | null,
  o: typeof DEF & ApplyHintsOptions,
): Omit<HintReport, "index" | "kind" | "label"> {
  const px = o.pixels!, { aw, ah } = an;
  const cx = h.x * aw, cy = h.y * ah, R = Math.max(2, h.r * ah * 1.15), R2 = R * 2.2;
  const x0 = Math.max(0, Math.floor(cx - R2)), x1 = Math.min(aw - 1, Math.ceil(cx + R2));
  const y0 = Math.max(0, Math.floor(cy - R2)), y1 = Math.min(ah - 1, Math.ceil(cy + R2));
  let peak = 0, ring = 0, rn = 0;
  const inside: number[] = [], L: number[] = [], edge: boolean[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d > R2) continue;
    const l = lightAt(px, an, x, y);
    if (d <= R) { inside.push(y * aw + x); L.push(l); edge.push(d >= R - 1.5); if (l > peak) peak = l; }
    else if (d >= R * 1.4) { ring += l; rn++; }
  }
  ring = rn ? ring / rn : 0;
  const contrast = peak - ring;
  if (peak < o.addMinPeak) return { status: "rejected", reason: "dark", peak, contrast };
  if (contrast < o.addMinContrast) return { status: "rejected", reason: "flat", peak, contrast };
  const free = (i: number) => { const id = tex[i * 4], c = C[id]; return !id || (!!c && F[c.fixture]?.kind === KIND_LIT); };
  let pick: number[] = [];
  for (const q of [0.6, 0.8, 0.92]) {
    const thr = Math.max(o.addMinPeak * 0.9, ring + q * contrast);
    pick = inside.filter((i, k) => L[k] >= thr && free(i));
    if (pick.length <= o.maxAddFrac * aw * ah) break;
  }
  if (pick.length > o.maxAddFrac * aw * ah) return { status: "rejected", reason: "too-big", peak, contrast };
  // jasny obszar wychodzi poza okno podpowiedzi (obrus, ściana, niebo) → powierzchnia, nie zwarte źródło
  const pickSet = new Set(pick);
  let eN = 0, eHit = 0;
  inside.forEach((i, k) => { if (edge[k]) { eN++; if (pickSet.has(i)) eHit++; } });
  if (eN && eHit / eN > 0.2) return { status: "rejected", reason: "surface", peak, contrast };
  if (pick.length < 2) return { status: "rejected", reason: "no-pixels", peak, contrast };
  const id = C.length, fi = F.length;
  let sx = 0, sy = 0, cr = 0, cg = 0, cb = 0, bx0 = aw, by0 = ah, bx1 = 0, by1 = 0;
  for (const i of pick) {
    const x = i % aw, y = (i / aw) | 0;
    sx += x; sy += y; bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
    const s = Math.min(px.w - 1, Math.floor((x + 0.5) * px.w / aw)) + Math.min(px.h - 1, Math.floor((y + 0.5) * px.h / ah)) * px.w;
    cr += lin(px.data[s * 4] / 255); cg += lin(px.data[s * 4 + 1] / 255); cb += lin(px.data[s * 4 + 2] / 255);
    tex[i * 4] = id;
  }
  // poszerzenie o 1 px (jak detektor lokalny: maska poświaty), tylko w wolne piksele
  for (const i of pick) {
    const x = i % aw, y = (i / aw) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < aw - 1 ? i + 1 : -1, y > 0 ? i - aw : -1, y < ah - 1 ? i + aw : -1]) {
      if (j >= 0 && !tex[j * 4]) tex[j * 4] = id;
    }
  }
  const n = pick.length, mx = Math.max(cr, cg, cb, 1e-6);
  const color: [number, number, number] = [cr / mx, cg / mx, cb / mx];
  const conf = Math.min(0.6, 0.25 + 0.4 * h.confidence * ss(o.addMinContrast, o.addMinContrast + 0.3, contrast));
  const ccx = (sx / n + 0.5) / aw, ccy = (sy / n + 0.5) / ah, r = Math.max(1, Math.sqrt(n / Math.PI)) / ah;
  C.push({ fixture: fi, conf, cx: ccx, cy: ccy, r, color, bright: peak, area: n, raw: -1 });
  const kind = mapped ?? KIND_WINDOW;
  const f: HintedFixture = {
    kind, members: [id], conf, bright: peak, cx: ccx, cy: ccy, r, color, parent: -1, gain: 1, source: "hint",
    hint: { kind: h.kind, ...(h.label ? { label: h.label } : {}), confidence: h.confidence },
  };
  if (h.kind === "sun" || h.kind === "moon") f.disc = true;
  if (kind === KIND_SCREEN) f.box = [bx0 / aw, by0 / ah, (bx1 + 1) / aw, (by1 + 1) / ah];
  if (h.flicker !== undefined) f.flicker = h.flicker;
  F.push(f);
  return { status: "added", fixtures: [fi], peak, contrast };
}

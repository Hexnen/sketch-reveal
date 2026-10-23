/**
 * Faza „rozbłysk” (pseudo-HDR), po fazie koloru: na gotowym obrazie LDR światła zapalają się i świecą.
 *
 * setImage → (asynchronicznie, kawałkami) analiza świateł na pomniejszonej kopii: maska jasność+nasycenie
 * względem lokalnego tła, komponenty spójne, oprawy (litery neonu razem), rodzaj źródła (neon / okno /
 * latarnia / oświetlona powierzchnia) — analyze.ts. render(p) jest bezstanowy i skrubowalny:
 *  - p ≤ 0 → obraz bajt w bajt (kopia 1:1, płótno w rozmiarze obrazu) — brak szwu z fazą koloru,
 *  - 0 < p < 1 → każde źródło na własnej krzywej zapłonu (ignite.ts),
 *  - p ≥ 1 → stan końcowy (wszystkie źródła = 1 — zostaje po fazie); z `life` i idle > 0 źródła „żyją”
 *    (life.ts: subtelna modulacja, czysta funkcja idle — skrubowalna, idle = 0 → bajt w bajt stan końcowy).
 * Render tylko przy zmianie p/idle (gdy życie aktywne)/parametrów/rozmiaru.
 */
import type { ParamSpec, RevealImageSource } from "../types";
import { analyzeLights, detectKey, KIND_LAMP, KIND_LIT, KIND_NAMES, KIND_NEON, type GlowAnalysis, type GlowDetectOptions } from "./analyze";
import { GLOW_DETECT_DEFAULTS, GLOW_DETECT_SPECS, GLOW_DETECT_TOGGLES } from "./analyzeOpts";
import { buildPlan, computeIgnition, type Ignition, type Plan } from "./ignite";
import {
  GLOW_DEFAULTS, GLOW_PARAM_SPECS, GLOW_QUALITIES, mergeGlowParams, paramsKey, type GlowParams, type GlowQuality,
} from "./params";
import { createGlowRenderer, type GlowRenderer } from "./renderer";
import { coverageTables, createCoverageSampler, gateFromTables, type CoverageMap, type CoverageSampler } from "./backdrop";
import { applyHints, type ApplyHintsOptions, type HintedAnalysis, type LightHint } from "./hints";
import { claimGlCanvas, releaseGlCanvas } from "../sketchIntro/glContext";

export { GLOW_DEFAULTS, GLOW_DETECT_DEFAULTS, GLOW_DETECT_SPECS, GLOW_DETECT_TOGGLES, GLOW_PARAM_SPECS, GLOW_QUALITIES };
export type { CoverageMap, GlowDetectOptions, GlowParams, GlowQuality };
export { applyHints, hintKindToKind, sanitizeHints, LIGHT_HINT_KINDS } from "./hints";
export type { ApplyHintsOptions, HintedAnalysis, HintedFixture, HintReport, LightHint, LightHintKind } from "./hints";

export interface Glow {
  setImage(painted: RevealImageSource, width: number, height: number): void;
  setParams(p: Partial<GlowParams>): void;
  /** 0..1 — postęp rozbłysku; `idle` = sekundy po końcu zapłonu (życie świateł, tylko przy p ≥ 1 i `life`). */
  render(p: number, idle?: number): void;
  /** Czy render(1, idle) zmienia się z idle (życie włączone, analiza gotowa) — pętla ma tykać nakładkę. */
  isAlive(): boolean;
  /**
   * Bramka „najpierw kolor, potem światło” (rozbłysk startujący przed końcem efektu koloru): `frame` = bieżąca
   * klatka warstwy pod nakładką (płótno efektu — czytać w tym samym zadaniu co jego render). Źródło zapala się
   * dopiero, gdy jego miejsce jest pomalowane (klatka ≈ obraz w obrysie komponentu). null = bez bramki.
   * `progress` = postęp efektu: odczyt klatki jest pomijany, gdy nic by jeszcze nie świeciło albo gdy wszystkie
   * miejsca są już pomalowane, a postęp nie maleje (odczyt GPU kosztuje — tylko tyle, ile trzeba).
   * Odczyt jest ASYNCHRONICZNY (backdrop.ts: kopia GPU→GPU, PBO + fence, bez blokowania wątku); nowa bramka nie
   * rysuje od razu, tylko unieważnia klucz — rysuje najbliższy render() (w pauzie: jeden odroczony rysunek).
   * Zwraca false, gdy próbka nie została przyjęta (odczyt w toku) — wołający może spróbować w następnej klatce.
   */
  setBackdrop(frame: CanvasImageSource | null, progress?: number): boolean;
  /**
   * Fala 2: mapa pokrycia efektu (`EffectInstance.coverage`). Gdy ustawiona, `setBackdrop(_, progress)` liczy bramkę
   * z mapy przy `progress` (CPU, bez odczytu klatki; `frame` może być null), a odczyt płótna zostaje zapasem
   * (map = null). Ta sama tożsamość mapy = bez przeliczeń tabel.
   */
  setCoverage(map: CoverageMap | null): void;
  /** Diagnostyka (narzędzia): bieżąca bramka per komponent (kopia; null = bez bramki). */
  gateLevels(): Float32Array | null;
  /** Czy ostatni stan dodaje jakiekolwiek światło (false = nakładka niczego nie dodaje — można ją ukryć, K5). */
  hasLight(): boolean;
  /**
   * Podpowiedzi modelu wizyjnego (glow-ai.md): scalane z analizą lokalną przez `applyHints` (bez ponownej analizy).
   * null = sam detektor lokalny. Opcje bez `pixels` — rdzeń sam daje piksele obrazu (siatka analizy).
   */
  setHints(hints: readonly LightHint[] | null, opts?: Omit<ApplyHintsOptions, "pixels">): void;
  /** Raport scalenia ostatnich podpowiedzi (null = brak podpowiedzi albo analiza w toku). */
  hintReport(): HintedAnalysis["hintReport"] | null;
  dispose(): void;
  paramSpecs: ParamSpec[];
  isReady(): boolean;
  whenReady(): Promise<void>;
}

export interface GlowOptions {
  /** Tylko dla zrzutów w harnessie (domyślnie false — klatki czytać w tym samym zadaniu co render). */
  preserveDrawingBuffer?: boolean;
  /** Największy bok tekstury/płótna (domyślnie 4096; zawsze ≤ MAX_TEXTURE_SIZE). */
  maxSide?: number;
  /** Test fallbacku: bufory bloomu RGBA8 z kodowaniem nawet przy dostępnym EXT_color_buffer_float. */
  forceLdrTargets?: boolean;
  /**
   * "full" (domyślnie): płótno = obraz + światło (zakrywa warstwę pod spodem). "add": płótno = SAM przyrost
   * światła na czerni — do `mix-blend-mode: plus-lighter` (pod spodem efekt koloru, widoczny dalej). "screen":
   * przyrost kodowany Δ/(1−obraz) pod `mix-blend-mode: screen` (fallback; dokładny, gdy pod spodem jest obraz).
   */
  blend?: "full" | "add" | "screen";
  /**
   * K5: zmiana „czy nakładka cokolwiek dodaje” (wołane po narysowaniu). Gdy podane (tryb add/screen), rdzeń NIE
   * rysuje czarnego płótna bez światła — wołający ma wtedy ukryć płótno (display:none), bo jego treść jest nieaktualna.
   */
  onLight?: (lit: boolean) => void;
  /** Utrata / odtworzenie kontekstu WebGL (zmienia się `isAlive()`; po odtworzeniu nakładka jest przerysowana). */
  onContext?: (lost: boolean) => void;
}

/** Bok siatki próbkowania pokrycia (bramka setBackdrop). */
const COV_SIDE = 256;
/** Tolerancja „pomalowane” (maks. kanał, 0..255) i progi bramki (udział pomalowanych próbek w obrysie). */
const COV_TOL = 28, GATE_LO = 0.5, GATE_HI = 0.9;

/** Opóźnienie ponownej analizy po zmianie progów wykrywania (suwak) [ms]. */
const DETECT_DEBOUNCE_MS = 250;
/** Ile wariantów analizy (rozmiar × progi) trzymać na obraz — suwaki nie mogą puchnąć pamięci. */
const CACHE_PER_SRC = 6;

const cache = new WeakMap<object, Map<string, Promise<GlowAnalysis>>>();
function getAnalysis(src: RevealImageSource, w: number, h: number, detect?: Partial<GlowDetectOptions>): Promise<GlowAnalysis> {
  let m = cache.get(src);
  if (!m) { m = new Map(); cache.set(src, m); }
  const key = `${w}x${h}|${detectKey(detect)}`;
  let pr = m.get(key);
  if (pr) { m.delete(key); m.set(key, pr); return pr; } // LRU: odświeżona kolejność
  pr = analyzeLights(src, w, h, detect); m.set(key, pr); pr.catch(() => m!.delete(key));
  while (m.size > CACHE_PER_SRC) m.delete(m.keys().next().value as string);
  return pr;
}

export function createGlow(canvas: HTMLCanvasElement, opts: GlowOptions = {}): Glow {
  let rd: GlowRenderer | null = null;
  let lost = false, glCtx: WebGL2RenderingContext | null = null;
  const mode = opts.blend === "add" ? 1 : opts.blend === "screen" ? 2 : 0;
  const mkRd = () => {
    try { rd = createGlowRenderer(canvas, !!opts.preserveDrawingBuffer, !!opts.forceLdrTargets); rd?.setMode(mode); if (rd) glCtx = rd.gl; }
    catch (e) { console.warn("glow: WebGL2", e); rd = null; }
  };
  let src: RevealImageSource | null = null, upload: TexImageSource | null = null;
  let w = 0, h = 0, tw = 0, th = 0, gen = 0;
  let params: GlowParams = { ...GLOW_DEFAULTS };
  let an: GlowAnalysis | null = null, plan: Plan | null = null;
  let base: GlowAnalysis | null = null, hints: readonly LightHint[] | null = null, hintOpts: Omit<ApplyHintsOptions, "pixels"> = {};
  let hintPx: { src: RevealImageSource; aw: number; ah: number; data: Uint8ClampedArray } | null = null;
  /** Analiza lokalna + podpowiedzi (piksele obrazu w siatce analizy, keszowane per obraz). */
  const withHints = (a: GlowAnalysis): GlowAnalysis => {
    if (!hints || !src) return a;
    if (!hintPx || hintPx.src !== src || hintPx.aw !== a.aw || hintPx.ah !== a.ah) {
      const c = document.createElement("canvas"); c.width = a.aw; c.height = a.ah;
      const g = c.getContext("2d", { willReadFrequently: true });
      hintPx = null;
      if (g) { g.drawImage(src, 0, 0, a.aw, a.ah); hintPx = { src, aw: a.aw, ah: a.ah, data: g.getImageData(0, 0, a.aw, a.ah).data }; }
    }
    try {
      return applyHints(a, hints, { ...hintOpts, pixels: hintPx ? { data: hintPx.data, w: hintPx.aw, h: hintPx.ah } : null });
    } catch (e) { console.warn("glow: podpowiedzi", e); return a; }
  };
  let ig: Ignition | undefined;
  let lastKey = "", lastP = 0, lastIdle = 0;
  let ready: Promise<void> = Promise.resolve();
  let gate: Float32Array | null = null, gateVer = 0, covGen = 0, covP = 0, covFloor = 0;
  let sampler: CoverageSampler | null = null, samplerOk = true;
  let covMap: CoverageMap | null = null, covTab: { an: GlowAnalysis; map: CoverageMap; t: (Float32Array | null)[] } | null = null;
  /** Ostatnia próbka pokrycia (siatki obraz/klatka — niezależne od analizy): bramka dla nowej analizy bez odczytu. */
  let lastCov: { ref: ArrayLike<number>; cur: ArrayLike<number>; cw: number; ch: number } | null = null;
  /** Bramka wyłączona → osobny kontekst próbek zwolniony od razu. */
  const freeSampler = () => { sampler?.dispose(); sampler = null; };
  let pollTimer: ReturnType<typeof setTimeout> | null = null, drawQueued = false, litNow = false, dispSide = 0;
  let cov: { src: RevealImageSource; cw: number; ch: number; g: CanvasRenderingContext2D; ref: Uint8ClampedArray } | null = null;
  let relTimer: ReturnType<typeof setTimeout> | null = null;
  let detKey = "", detTimer: ReturnType<typeof setTimeout> | null = null, detDone: (() => void) | null = null;
  /** Analiza dla bieżącego obrazu i progów; `keep` = stara analiza świeci do czasu nowej (suwak, bez mrugnięcia). */
  const analyze = (keep: boolean): Promise<void> => {
    const my = ++gen, s0 = src;
    if (!s0) return Promise.resolve();
    if (!keep) { an = null; plan = null; }
    return getAnalysis(s0, w, h, params.detect).then((a) => {
      if (my !== gen) return;
      base = a; an = withHints(a); plan = null; ig = undefined;
      regate();
      rd?.setAnalysis(an);
      draw(lastP, true);
    });
  };
  /**
   * Nowa analiza / podpowiedzi przy AKTYWNEJ bramce (bughunt #2): bramka liczona od razu dla nowych komponentów —
   * z mapy efektu przy ostatnim postępie albo z ostatniej próbki klatki; bez danych = wszystko zamknięte (do próbki).
   * Wcześniej `gate = null` = „bez bramki” → światło nad niepomalowanym (w pauzie trwale).
   */
  const regate = () => {
    covTab = null;
    if (!gate || !an) return;
    let next: Float32Array | null = null;
    if (covMap) {
      const [cw, ch] = covGrid();
      covTab = { an, map: covMap, t: coverageTables(an.comps, an.ah / an.aw, covMap, cw, ch) };
      next = gateFromTables(covTab.t, covP, GATE_LO, GATE_HI);
    } else if (lastCov) next = coverageOf(lastCov.ref, lastCov.cur, lastCov.cw, lastCov.ch);
    if (!next) { next = new Float32Array(an.comps.length); next[0] = 1; }
    gate = next; gateVer++;
  };
  const settleDetect = () => { if (detTimer) { clearTimeout(detTimer); detTimer = null; } const d = detDone; detDone = null; d?.(); };

  /**
   * Płótno = tekstura = rozmiar obrazu (≤ maxSide i MAX_TEXTURE_SIZE) — tak samo jak płótno efektu, niezależnie od
   * rozmiaru wyświetlania i jakości (W1: bez szwu i bez przeładowań przy ukryciu/pokazaniu). Mapy > 4096 normalizuje
   * wołający (normalizeImages); tu tylko twardy limit.
   */
  const sizeTex = () => {
    const cap = Math.min(opts.maxSide ?? 4096, rd?.maxSide ?? 4096);
    const k = Math.min(1, cap / Math.max(w, h));
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
  };
  const uploadImage = () => {
    if (!src || !rd) return;
    [tw, th] = sizeTex();
    let s: TexImageSource = src;
    if (tw !== w || th !== h) {
      const c = document.createElement("canvas");
      c.width = tw; c.height = th;
      const g = c.getContext("2d");
      if (!g) return;
      g.imageSmoothingQuality = "high";
      g.drawImage(src, 0, 0, tw, th);
      s = c;
    }
    upload = s;
    rd.setImage(s, tw, th);
    rd.setAnalysis(an);
  };
  const fallback2d = () => { // brak WebGL2: sam obraz (bez świecenia)
    if (!src) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    canvas.getContext("2d")?.drawImage(src, 0, 0, w, h);
  };

  /** Życie tylko, gdy jest co ożywiać (K5: scena bez opraw nie tyka pętli rysunków). */
  const alive = () => !!rd && !lost && !!an && an.fixtures.length > 0 && params.life && params.lifeAmount > 0;
  const setLit = (v: boolean) => { if (v !== litNow) { litNow = v; opts.onLight?.(v); } };
  /** K7: bok bazy bloomu w med/low ≤ 0,75 (low 0,375) × wyświetlanie × DPR (= łańcuch jak dla płótna 1,5× ekranu). */
  const bloomCap = () => {
    if (params.quality === "high") return 0;
    const cw = canvas.clientWidth, chh = canvas.clientHeight;
    if (cw > 0 && chh > 0) dispSide = Math.max(cw, chh) * (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
    return dispSide > 0 ? Math.max(8, Math.round(dispSide * (params.quality === "low" ? 0.375 : 0.75))) : 0;
  };
  /** Czy cokolwiek świeci (inaczej wynik = sam obraz / czerń — tańszy blit, te same bajty). */
  const lit = (g: Ignition) => {
    for (let i = 0; i < g.table.length; i += 4) if (g.table[i] > 0) return true;
    return g.nLamps > 0 && g.lamps.some((v, i) => i % 4 === 3 && v > 0);
  };
  const draw = (p: number, force = false, idle = lastIdle) => {
    lastP = p; lastIdle = idle;
    pollCov(); // gotowa bramka (bez czekania) wchodzi już do tej klatki
    if (!src || !w || lost) return;
    if (!rd) { if (mode === 0) fallback2d(); return; }
    if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th; lastKey = ""; }
    const pc = Math.max(0, Math.min(1, p));
    const live = pc >= 1 && idle > 0 && alive() ? idle : 0;
    const cap = bloomCap();
    const key = `${pc}|${live}|${paramsKey(params)}|${tw}x${th}|${an ? 1 : 0}|${gate ? gateVer : 0}|${cap}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    if (relTimer) { clearTimeout(relTimer); relTimer = null; }
    // K5: bez światła w trybie przyrostu i z ukrywaniem po stronie wołającego — bez rysowania czarnego płótna
    const dark = () => { setLit(false); if (!(opts.onLight && mode !== 0)) rd!.draw(null, params, tw, th); };
    if (pc <= 0 || !an) { dark(); return; }
    if (!plan) plan = buildPlan(an, params);
    ig = computeIgnition(an, plan, params, pc, ig, live, gate);
    if (!lit(ig)) dark();
    else {
      // K6 (med/low): życie = stan końcowy z pamięci × stosunek poziomu najbliższego źródła (bez łańcucha bloomu)
      const a0 = an, p0 = plan, g0 = gate, ck = `${paramsKey(params)}|${tw}x${th}|${g0 ? gateVer : 0}|${cap}`;
      const cheap = live > 0 && params.quality !== "high"
        && rd.drawIdle(ig, () => computeIgnition(a0, p0, params, 1, undefined, 0, g0), ck, params, tw, th, cap);
      if (!cheap) rd.draw(ig, params, tw, th, cap);
      setLit(true);
    }
    // stan końcowy bez życia: obraz już się nie zmieni → zwolnij łańcuch FBO (W3; następny draw odtworzy leniwie)
    if (pc >= 1 && !live && !alive() && !gate) relTimer = setTimeout(() => { relTimer = null; rd?.release(); }, 400);
  };
  /** Pokrycie per komponent: udział próbek obrysu, w których klatka ≈ obraz → bramka 0..1. */
  const covGrid = () => {
    const k = Math.min(1, COV_SIDE / Math.max(w, h));
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
  };
  /** Pokrycie z gotowych siatek (ref = obraz, d = klatka; RGBA cw×ch, wiersz 0 = góra). */
  const coverageOf = (ref: ArrayLike<number>, d: ArrayLike<number>, cw: number, ch: number): Float32Array | null => {
    if (!an) return null;
    const C = an.comps, out = new Float32Array(C.length).fill(1), asp = an.ah / an.aw;
    for (let ci = 1; ci < C.length; ci++) {
      const cp = C[ci], rx = cp.r * asp * 1.1 + 0.5 / cw, ry = cp.r * 1.1 + 0.5 / ch;
      let x0 = Math.floor((cp.cx - rx) * cw), x1 = Math.ceil((cp.cx + rx) * cw), y0 = Math.floor((cp.cy - ry) * ch), y1 = Math.ceil((cp.cy + ry) * ch);
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(cw - 1, Math.max(x0, x1)); y1 = Math.min(ch - 1, Math.max(y0, y1));
      let n = 0, okN = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = (y * cw + x) * 4; n++;
        if (Math.abs(d[i] - ref[i]) <= COV_TOL && Math.abs(d[i + 1] - ref[i + 1]) <= COV_TOL && Math.abs(d[i + 2] - ref[i + 2]) <= COV_TOL) okN++;
      }
      const t = Math.max(0, Math.min(1, ((n ? okN / n : 1) - GATE_LO) / (GATE_HI - GATE_LO)));
      out[ci] = t * t * (3 - 2 * t);
    }
    return out;
  };
  /** Droga zapasowa (bez WebGL2 w rdzeniu / płótno nie do skopiowania): odczyt synchroniczny przez 2D. */
  const coverage = (frame: CanvasImageSource): Float32Array | null => {
    if (!an || !src) return null;
    if (!cov || cov.src !== src) {
      const [cw, ch] = covGrid();
      const c = document.createElement("canvas"); c.width = cw; c.height = ch;
      const g = c.getContext("2d", { willReadFrequently: true });
      if (!g) return null;
      g.drawImage(src, 0, 0, cw, ch);
      cov = { src, cw, ch, g, ref: g.getImageData(0, 0, cw, ch).data };
    }
    const { cw, ch, g, ref } = cov;
    g.clearRect(0, 0, cw, ch);
    g.drawImage(frame, 0, 0, cw, ch);
    const cur = g.getImageData(0, 0, cw, ch).data;
    lastCov = { ref, cur, cw, ch };
    return coverageOf(ref, cur, cw, ch);
  };
  /** K2: nowa bramka tylko unieważnia klucz; rysuje najbliższy render() z pętli. W pauzie (nikt nie woła render)
   *  jeden odroczony rysunek po klatkach rAF (setTimeout po rAF — jeśli pętla w tej klatce już narysowała, no-op). */
  const applyGate = (next: Float32Array | null) => {
    if (!next && !gate) return;
    if (next && gate && next.length === gate.length && next.every((v, i) => v === gate![i])) return;
    gate = next; gateVer++;
    if (drawQueued) return;
    drawQueued = true;
    const later = () => setTimeout(() => { if (drawQueued) { drawQueued = false; draw(lastP); } }, 0);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(later); else later();
  };
  /** Odbiór gotowego odczytu (bez blokowania). true = przyszedł wynik. */
  const pollCov = (): boolean => {
    if (!sampler?.busy()) return false;
    const r = sampler.poll();
    if (!r) return false;
    // tylko wyniki nowsze niż ostatnie zastosowane i od bieżącego obrazu/analizy (covFloor)
    if (r.tag > covFloor && an) { covFloor = r.tag; lastCov = r; applyGate(coverageOf(r.ref, r.cur, r.cw, r.ch)); }
    return true;
  };
  const armPoll = () => {
    if (pollTimer) return;
    const tick = () => { pollTimer = null; if (sampler?.busy() && !pollCov()) pollTimer = setTimeout(tick, 32); };
    pollTimer = setTimeout(tick, 32);
  };

  const onLost = (e: Event) => { e.preventDefault(); lost = true; rd = null; opts.onContext?.(true); };
  // odtworzenie: nowy renderer z zachowanych danych (obraz, analiza) — te same bajty co przed utratą
  const onRestored = () => {
    if (!lost) return;
    lost = false; mkRd(); uploadImage(); lastKey = "";
    draw(lastP, true);
    opts.onContext?.(false);
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  // kontekst zwolniony przez poprzednią instancję (odroczony loseContext) → czekamy na `restored`, potem renderer
  if (claimGlCanvas(canvas)) lost = true; else mkRd();

  return {
    paramSpecs: GLOW_PARAM_SPECS,
    setImage(painted, width, height) {
      settleDetect();
      src = painted; w = width; h = height; an = null; base = null; plan = null; lastKey = ""; gate = null; cov = null; lastCov = null; covFloor = ++covGen;
      detKey = detectKey(params.detect);
      uploadImage();
      draw(lastP, true);
      ready = analyze(false);
    },
    setParams(p) {
      const next = mergeGlowParams(params, p);
      if (next.seed !== params.seed || next.stagger !== params.stagger || next.flicker !== params.flicker || next.duration !== params.duration) plan = null;
      params = next;
      const dk = detectKey(next.detect);
      if (dk !== detKey) {
        detKey = dk;
        if (src) {
          // suwak wykrywania: ponowna analiza z opóźnieniem (seria zmian = jedna analiza); stara świeci do czasu nowej
          if (detTimer) clearTimeout(detTimer);
          if (!detDone) ready = new Promise<void>((res) => { detDone = res; });
          detTimer = setTimeout(() => {
            detTimer = null;
            const done = detDone; detDone = null;
            analyze(true).then(() => done?.(), () => done?.());
          }, DETECT_DEBOUNCE_MS);
        }
      }
      draw(lastP);
    },
    render: (p, idle = 0) => draw(p, false, idle),
    isAlive: alive,
    setBackdrop(frame, progress) {
      if (covMap && an && progress !== undefined) { // bramka z mapy efektu: bez odczytu klatki
        if (!covTab || covTab.an !== an || covTab.map !== covMap) {
          const [cw, ch] = covGrid();
          covTab = { an, map: covMap, t: coverageTables(an.comps, an.ah / an.aw, covMap, cw, ch) };
        }
        covP = progress; covFloor = ++covGen; freeSampler();
        applyGate(gateFromTables(covTab.t, progress, GATE_LO, GATE_HI));
        return true;
      }
      if (frame && an && progress !== undefined) {
        const open = !!gate && gate.every((v) => v >= 1) && progress >= covP;
        const dark = !!plan && !lit(computeIgnition(an, plan, params, Math.max(0, Math.min(1, lastP)), undefined, 0));
        if (open || dark) return true;
      }
      if (!frame || !an) { covFloor = ++covGen; freeSampler(); lastCov = null; applyGate(null); return true; }
      pollCov();
      if (progress !== undefined) covP = progress;
      const my = ++covGen;
      const [cw, ch] = covGrid();
      if (!sampler && samplerOk && typeof HTMLCanvasElement !== "undefined" && frame instanceof HTMLCanvasElement) {
        try { sampler = createCoverageSampler(); } catch (e) { console.warn("glow: bramka", e); }
        samplerOk = !!sampler;
      }
      const ref = upload ?? src;
      if (sampler && ref && frame instanceof HTMLCanvasElement && sampler.request(frame, ref as TexImageSource, cw, ch, my)) { armPoll(); return true; }
      covFloor = my; applyGate(coverage(frame)); // zapas: synchronicznie (bez WebGL2 albo płótno nie do skopiowania)
      return true;
    },
    gateLevels: () => (gate ? gate.slice() : null),
    setCoverage(map) { if (map !== covMap) { covMap = map; covTab = null; } },
    hasLight: () => litNow,
    setHints(next, o = {}) {
      hints = next ?? null; hintOpts = o;
      if (!base) return;
      an = withHints(base); plan = null; ig = undefined; lastKey = "";
      regate();
      rd?.setAnalysis(an);
      draw(lastP, true);
    },
    hintReport: () => (an && "hintReport" in an ? (an as HintedAnalysis).hintReport : null),
    isReady: () => !!an,
    whenReady: () => ready,
    dispose() {
      settleDetect();
      gen++; covFloor = ++covGen; src = null; upload = null; an = null; base = null; hintPx = null; plan = null; gate = null; cov = null; covMap = null; covTab = null; lastCov = null;
      if (relTimer) clearTimeout(relTimer);
      if (pollTimer) clearTimeout(pollTimer);
      drawQueued = false; freeSampler();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      rd?.dispose(); rd = null; lost = true;
      releaseGlCanvas(canvas, glCtx); // odroczony loseContext (anulowany, gdy płótno zaraz weźmie nowa instancja)
    },
  };
}

/** Diagnostyka (harness/raport): wykryte źródła. */
export async function analyzeGlowStats(src: RevealImageSource, w: number, h: number, detect?: Partial<GlowDetectOptions>) {
  const a = await getAnalysis(src, w, h, detect);
  const kinds = KIND_NAMES;
  return {
    debug: a.debug, ms: Math.round(a.ms), aw: a.aw, ah: a.ah, comps: a.comps.length - 1,
    fixtures: a.fixtures.map((f) => ({
      kind: kinds[f.kind], members: f.members.length, conf: +f.conf.toFixed(2), x: Math.round(f.cx * w), y: Math.round(f.cy * h),
      parent: f.parent, gain: +f.gain.toFixed(2),
    })),
    counts: { neon: a.fixtures.filter((f) => f.kind === KIND_NEON).length, lamp: a.fixtures.filter((f) => f.kind === KIND_LAMP).length,
      lit: a.fixtures.filter((f) => f.kind === KIND_LIT).length },
  };
}

/** Diagnostyka: maska świateł (id > 0) w rozdzielczości analizy — do pomiaru „wzrostu poza maską”. */
export async function glowMask(src: RevealImageSource, w: number, h: number, detect?: Partial<GlowDetectOptions>) {
  const a = await getAnalysis(src, w, h, detect);
  const m = new Uint8Array(a.aw * a.ah);
  for (let i = 0; i < m.length; i++) m[i] = a.tex[i * 4] ? 1 : 0;
  return { aw: a.aw, ah: a.ah, mask: m };
}

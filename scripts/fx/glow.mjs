/* Warstwa „rozbłysk” (glow): pseudo-HDR światła/ekrany/LED/świetliki po kolorze + żywe światło po końcu osi.
   Port useGlow.ts + GlowSection.tsx + settings (sanitize) + glowAt z harnessu (roleplay, feat/foundry-sketch-reveal)
   do czystego ES module — bez Reacta i bez globali Foundry. Rdzeń (createGlow itd.) pochodzi z vendor/reveal-core.js.

   Nakładka jest ADDYTYWNA: płótno trzyma sam przyrost światła na czerni, a CSS dodaje go do efektu pod spodem
   (mix-blend-mode: plus-lighter; starsze przeglądarki: screen). Host musi być grupą izolowaną (isolation:isolate —
   .sr-cam w player.mjs już jest), a płótno glow leży NAD płótnem efektu (i nad nakładką szkicu, jeśli ma świecić).

   Warstwa AI (zapytanie do backendu /api/roleplay/reveal-lights) NIE jest portowana — wymaga serwera i klucza.
   Zamiast tego: `hints` (zwalidowane LightHint[], np. z sanitizeHints) w createGlowLayer i `setHints(h, {strict})`. */
import * as Core from "../../vendor/reveal-core.js";

const {
  createGlow, GLOW_DEFAULTS, GLOW_DETECT_DEFAULTS, GLOW_DETECT_SPECS, GLOW_DETECT_TOGGLES, GLOW_PARAM_SPECS,
  GLOW_QUALITIES, GLOW_DETECTORS, GLOW_DETECTOR_HINT,
} = Core;

/* ---------------------------------------------------------------- stałe */
/** Odstęp próbek klatki efektu w odtwarzaniu [ms] (skok postępu ≥ 2% efektu — od razu) i najmniejsza zmiana postępu. */
const SAMPLE_MS = 300, SAMPLE_EPS = 1e-3;
/** Dłuższy bok mapy pokrycia z efektu (kontrakt rdzenia: komórki ≤ 64×64). */
const COVERAGE_SIDE = 64;

export const GLOW_BLEND =
  typeof CSS !== "undefined" && CSS.supports?.("mix-blend-mode", "plus-lighter") ? "plus-lighter" : "screen";

/** Które efekty mają ZWERYFIKOWANE `coverage()` (stan 2026-10-22: tylko spread). Inne → bramka czyta płótno przez worker. */
export const COVERAGE_TRUSTED = Object.freeze({ spread: true });

/* ---------------------------------------------------------------- ustawienia */
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => typeof v === "number" && Number.isFinite(v);
const qualityValues = GLOW_QUALITIES.map((q) => q.value);
const detectorValues = GLOW_DETECTORS.map((d) => d.value);

export const GLOW_DEFAULT_OPTS = Object.freeze({
  enabled: false, from: 100, params: Object.freeze({ ...GLOW_DEFAULTS }),
});

const clampSpecs = (o, specs) => {
  for (const s of specs) if (num(o[s.key])) o[s.key] = clamp(o[s.key], s.min, s.max);
  return o;
};

function detectOf(v) {
  if (!isObj(v)) return undefined;
  const out = {};
  for (const [k, d] of Object.entries(GLOW_DETECT_DEFAULTS)) {
    const x = v[k];
    if ((typeof d === "number" && num(x)) || (typeof d === "boolean" && typeof x === "boolean")
      || (k === "detector" && detectorValues.includes(x))) out[k] = x;
  }
  return Object.keys(out).length ? clampSpecs(out, GLOW_DETECT_SPECS) : undefined;
}

/** Dowolny obiekt → poprawne GlowParams (zakresy, quality enum, detect). Nigdy nie rzuca. */
export function sanitizeGlowParams(raw) {
  const out = { ...GLOW_DEFAULTS };
  try {
    if (isObj(raw)) {
      for (const k of Object.keys(GLOW_DEFAULTS)) {
        const d = GLOW_DEFAULTS[k], x = raw[k];
        if (typeof d === "number") { if (num(x)) out[k] = x; }
        else if (typeof d === "boolean") { if (typeof x === "boolean") out[k] = x; }
        else if (k === "quality") { if (qualityValues.includes(x)) out[k] = x; }
      }
      clampSpecs(out, GLOW_PARAM_SPECS);
      out.seed = Math.round(out.seed);
      const det = detectOf(raw.detect);
      if (det) out.detect = det;
    }
  } catch { /* zostają domyślne */ }
  return out;
}

/** Dowolny (np. wklejony / stary) obiekt → poprawne GlowSettings { enabled, from, params }. Nigdy nie rzuca. */
export function sanitizeGlow(raw) {
  try {
    if (!isObj(raw)) return { enabled: false, from: 100, params: { ...GLOW_DEFAULTS } };
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
      from: num(raw.from) ? clamp(raw.from, 0, 100) : 100,
      params: sanitizeGlowParams(raw.params),
    };
  } catch { return { enabled: false, from: 100, params: { ...GLOW_DEFAULTS } }; }
}

/* ---------------------------------------------------------------- spec formularza */
/** Najczęściej strojone; reszta (kolano progu, nasycenie, halo, smugi, kontrast, ziarno) jako „zaawansowane”. */
const MAIN = new Set(["intensity", "radius", "threshold", "stagger", "flicker", "warmth", "duration"]);
const cleanLabel = (s) => s.label.replace(/ \[s\]$/, "");
const specField = (s) => ({
  key: `params.${s.key}`, label: cleanLabel(s), type: "range", min: s.min, max: s.max, step: s.step,
  hint: s.hint, unit: s.key === "duration" ? " s" : "",
});

/**
 * Spec pól formularza. key = ścieżka względem GlowSettings (np. "params.intensity", "params.detect.sensitivity").
 * group: "glow" | "detect". advanced: ukryte pod „Więcej ustawień” / „Wykrywanie świateł”.
 * showIf: klucz boolean, od którego zależy widoczność. scale/unit (suwaki wykrywania): wyświetlaj value*scale + " " + unit.
 * Pola params.detect.* nie mają wartości w GLOW_DEFAULT_OPTS (brak = domyślna) — `detectDefault` podaje wartość domyślną.
 * „Wykrywanie: domyślne” = usuń params.detect.
 */
export const GLOW_FIELDS = [
  { key: "enabled", label: "Faza rozbłysku", type: "check", group: "glow", hint: "Faza świateł po kolorze (pseudo-HDR)" },
  { key: "from", label: "Rozbłysk od", type: "range", min: 0, max: 100, step: 5, unit: "% koloru", group: "glow",
    hint: "Kiedy zaczyna się rozbłysk, jako % fazy koloru. 100 = po efekcie; mniej = światła zapalają się już w trakcie kolorowania (każde dopiero, gdy jego miejsce jest pomalowane)" },
  { key: "params.quality", label: "Jakość", type: "select", group: "glow",
    options: GLOW_QUALITIES.map((q) => [q.value, q.label]) },
  ...GLOW_PARAM_SPECS.filter((s) => s.key !== "lifeAmount" && MAIN.has(s.key)).map((s) => ({ ...specField(s), group: "glow" })),
  { key: "params.life", label: "Żywe światło", type: "check", group: "glow",
    hint: "Po zapłonie światła subtelnie żyją: szum neonów, oddech latarni, falowanie okien" },
  ...GLOW_PARAM_SPECS.filter((s) => s.key === "lifeAmount").map((s) => ({ ...specField(s), group: "glow", showIf: "params.life" })),
  ...GLOW_PARAM_SPECS.filter((s) => s.key !== "lifeAmount" && !MAIN.has(s.key)).map((s) => ({ ...specField(s), group: "glow", advanced: true })),
  // Wykrywanie świateł (zmiana → ponowna analiza w rdzeniu, opóźniona o 250 ms, keszowana per obraz + progi)
  { key: "params.detect.detector", label: "Detektor", type: "select", group: "detect", advanced: true,
    hint: GLOW_DETECTOR_HINT, options: GLOW_DETECTORS.map((d) => [d.value, d.label]), detectDefault: GLOW_DETECT_DEFAULTS.detector },
  ...GLOW_DETECT_SPECS.map((s) => ({
    key: `params.detect.${s.key}`, label: s.label, type: "range", min: s.min, max: s.max, step: s.step, hint: s.hint,
    scale: s.scale, unit: s.unit, group: "detect", advanced: true, detectDefault: GLOW_DETECT_DEFAULTS[s.key],
  })),
  ...GLOW_DETECT_TOGGLES.map((t) => ({
    key: `params.detect.${t.key}`, label: t.label, type: "check", hint: t.hint, group: "detect", advanced: true,
    detectDefault: GLOW_DETECT_DEFAULTS[t.key],
  })),
];

/* ---------------------------------------------------------------- oś czasu */
/**
 * Postęp fazy rozbłysku na osi całości: [szkic][kolor][rozbłysk]. `glowStart` = sekunda startu rozbłysku
 * (cs + effectDur * from/100), `glowSec` = długość fazy. Nakładka widoczna od startu (p=0 to dokładnie obraz
 * kolorowy — brak szwu) i zostaje po fazie (p=1 = stan końcowy). `glowIdle` = sekundy po końcu fazy (żywe światło).
 */
export function glowAt(t, glowStart, glowSec) {
  const g = glowSec > 0 ? (t - glowStart) / glowSec : 0;
  return {
    glowProgress: Math.max(0, Math.min(1, g)),
    glowVisible: glowSec > 0 && t >= glowStart,
    glowIdle: glowSec > 0 ? Math.max(0, t - glowStart - glowSec) : 0,
  };
}

/* ---------------------------------------------------------------- pokrycie z efektu */
/**
 * Dostawca mapy pokrycia dla createGlowLayer({ coverage }): cache per (wersja, rozmiar); efekt spoza COVERAGE_TRUSTED
 * albo bez `coverage()` → null (bramka czyta płótno przez worker). `invalidate()` po zmianie obrazów/parametrów efektu.
 * @param {() => object|null} getEffect  bieżąca instancja efektu (EffectInstance)
 */
export function createCoverageProvider(getEffect, effectId, trusted = COVERAGE_TRUSTED) {
  let key = "", map = null, ver = 0;
  const fn = (w, h) => {
    const inst = getEffect();
    if (!trusted[effectId] || !inst?.coverage || inst.isReady?.() === false) return null;
    const k = `${ver}|${w}x${h}`;
    if (key === k) return map;
    let grid = null;
    try { grid = inst.coverage(w, h); } catch (e) { console.warn("sketch-reveal | coverage", e); }
    key = k; map = grid && grid.length >= w * h ? { grid, w, h } : null;
    return map;
  };
  fn.invalidate = () => { ver++; key = ""; map = null; };
  return fn;
}

/* ---------------------------------------------------------------- warstwa */
/**
 * @param {object} o
 * @param {HTMLElement} o.host   kontener (stacking context sceny; position != static) — płótno glow jest do niego dodawane
 * @param {{sketch?:any, painted:HTMLImageElement|HTMLCanvasElement|ImageBitmap}} o.images
 * @param {object} [o.params]   GlowParams (przechodzi przez sanitizeGlowParams)
 * @param {HTMLCanvasElement} [o.effectCanvas]  płótno efektu pod nakładką (bramka pokrycia, gdy glow startuje przed końcem koloru)
 * @param {(w:number,h:number)=>({grid:Float32Array,w:number,h:number}|null)} [o.coverage]
 * @param {readonly object[]|null} [o.hints]  zwalidowane LightHint[] (AI) — opcjonalnie; setHints() później
 * @param {boolean} [o.hintsStrict]
 * @param {(alive:boolean)=>void} [o.onAlive]  isAlive() po każdej zmianie (odtwarzacz tyka po końcu osi tylko gdy true)
 * @param {(ready:boolean)=>void} [o.onReady]
 */
export function createGlowLayer({ host, images, params, effectCanvas, coverage, hints = null, hintsStrict = false, onAlive, onReady }) {
  const canvas = document.createElement("canvas");
  canvas.className = "sr-canvas sr-glow";
  Object.assign(canvas.style, {
    position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "contain",
    pointerEvents: "none", display: "none", mixBlendMode: GLOW_BLEND,
  });
  host.appendChild(canvas);

  const painted = images?.painted;
  const st = { want: 0, drawn: NaN, idle: 0, drawnIdle: NaN, visible: false, effP: 1, sampledP: NaN, sampledAt: 0, lit: false, alive: false };
  let g = null, live = true, hintsStrictNow = !!hintsStrict, readyFlag = false, preTimer = 0;
  let covSize = [0, 0];
  const waiters = [];
  const settle = () => { readyFlag = true; for (const r of waiters.splice(0)) r(); };

  /** K5: nakładka bez światła = display:none (bez blitu i blendu kompozytora). */
  const applyDisplay = () => { canvas.style.display = st.visible && st.lit ? "" : "none"; };
  const checkAlive = () => {
    const a = live && !!g?.isAlive();
    if (a !== st.alive) { st.alive = a; try { onAlive?.(a); } catch (e) { console.warn(e); } }
  };
  const sync = (force = false) => {
    if (!g || !st.visible) return;
    const idle = st.want >= 1 ? st.idle : 0; // idle liczy się tylko przy p ≥ 1
    if (!force && st.want === st.drawn && idle === st.drawnIdle) return;
    st.drawn = st.want; st.drawnIdle = idle;
    g.render(st.want, idle);
  };
  const notifyReady = (v) => { try { onReady?.(v); } catch (e) { console.warn(e); } };

  const W = painted ? (painted.naturalWidth ?? painted.width) : 0, H = painted ? (painted.naturalHeight ?? painted.height) : 0;
  try {
    if (!painted || !W || !H) throw new Error("brak obrazu");
    const k = COVERAGE_SIDE / Math.max(1, W, H);
    covSize = [Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k))];
    // zawczasu (poza klatką): pierwsza mapa liczy się teraz, nie w pierwszej klatce bramki
    preTimer = setTimeout(() => { preTimer = 0; if (live) try { coverage?.(covSize[0], covSize[1]); } catch { /* */ } }, 0);
    g = createGlow(canvas, {
      blend: GLOW_BLEND === "plus-lighter" ? "add" : "screen",
      onLight: (lit) => { if (live) { st.lit = lit; applyDisplay(); } },
      onContext: () => { if (live) { st.drawn = NaN; checkAlive(); } },
    });
    g.setParams(sanitizeGlowParams(params));
    if (hints) g.setHints(hints, { strict: hintsStrictNow });
    g.setImage(painted, W, H);
    st.drawn = NaN;
    sync(true);
    notifyReady(g.isReady());
    g.whenReady().then(() => {
      if (!live) return;
      st.sampledP = NaN; sync(true); notifyReady(true); checkAlive(); settle();
    }).catch(() => { if (live) notifyReady(true); settle(); });
    checkAlive();
  } catch (e) {
    console.warn("sketch-reveal | rozbłysk niedostępny", e);
    try { g?.dispose(); } catch { /* */ }
    g = null; notifyReady(true); settle(); // bez nakładki zostaje obraz kolorowy
  }

  return {
    canvas,
    /** p = postęp 0..1; visible; idle = s po końcu fazy (żywe światło); effectP = postęp efektu koloru (bramka „najpierw kolor”). */
    update(p, visible, idle = 0, effectP = 1) {
      if (!live) return;
      if (visible && !st.visible) st.drawn = NaN; // po ukryciu backbuffer mógł zostać wyczyszczony
      st.want = p; st.visible = !!visible; st.idle = idle;
      if (g && visible) {
        const [mw, mh] = covSize;
        // mapa z efektu: bramka liczona z samego effectP — bez GPU
        let map = null;
        if (effectP < 1 && p > 0 && mw > 0) { try { map = coverage?.(mw, mh) ?? null; } catch { map = null; } }
        g.setCoverage(map);
        if (map) {
          if (effectP !== st.sampledP) { g.setBackdrop(null, effectP); st.sampledP = effectP; st.sampledAt = performance.now(); }
        } else if (effectP < 1 && p > 0 && effectCanvas) {
          // odczyt klatki efektu = synchronizacja z GPU: najwyżej co SAMPLE_MS, od razu przy skoku (scrub)
          const now = performance.now(), jump = !(Math.abs(effectP - st.sampledP) < 0.02);
          if (!(Math.abs(effectP - st.sampledP) < SAMPLE_EPS) && (now - st.sampledAt >= SAMPLE_MS || jump)) {
            if (g.setBackdrop(effectCanvas, effectP)) { st.sampledP = effectP; st.sampledAt = now; }
          }
        } else if (st.effP < 1 || !Number.isNaN(st.sampledP)) { st.sampledP = NaN; g.setBackdrop(null); st.drawn = NaN; }
      }
      st.effP = effectP;
      sync();
      applyDisplay();
      checkAlive();
    },
    isReady: () => (g ? g.isReady() : true),
    whenReady: () => (readyFlag || !g ? Promise.resolve() : new Promise((r) => waiters.push(r))),
    isAlive: () => st.alive,
    /** Zmiana parametrów (pełne GlowParams albo część); zmiana progów wykrywania = nowa analiza po debounce. */
    setParams(p) {
      if (!g || !live || !p) return;
      g.setParams(sanitizeGlowParams({ ...GLOW_DEFAULTS, ...p }));
      st.drawn = NaN; sync(); checkAlive();
      g.whenReady().then(() => { if (live) checkAlive(); }, () => {});
    },
    /** Podpowiedzi modelu wizyjnego (LightHint[] po sanitizeHints) albo null = sam detektor lokalny. */
    setHints(h, { strict } = {}) {
      if (typeof strict === "boolean") hintsStrictNow = strict;
      if (!g || !live) return;
      g.setHints(h ?? null, { strict: hintsStrictNow });
      st.drawn = NaN; sync(true); checkAlive();
    },
    /** Diagnostyka rdzenia (może być null). */
    core: () => g,
    dispose() {
      if (!live) return;
      live = false;
      if (preTimer) { clearTimeout(preTimer); preTimer = 0; }
      try { g?.dispose(); } catch (e) { console.warn(e); }
      g = null;
      if (st.alive) { st.alive = false; try { onAlive?.(false); } catch { /* */ } }
      canvas.width = 1; canvas.height = 1; canvas.style.display = "none";
      canvas.remove();
      settle();
    },
  };
}

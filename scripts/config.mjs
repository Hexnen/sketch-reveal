/* Schemat konfiguracji reveal (preset i nadpisania sceny), domyślne wartości, scalanie i sanityzacja.
   Wszystko serializowalne (JSON) — trafia do ustawienia świata i do flag sceny. */
import * as Core from "../vendor/reveal-core.js";
import { DEFAULT_SWAY, DEFAULT_ZOOM, sanitizeSway, sanitizeZoom } from "./fx/camera.mjs";
import { GLOW_DEFAULT_OPTS, sanitizeGlow } from "./fx/glow.mjs";
import { DEFAULT_RESIDUE, sanitizeResidue } from "./fx/residue.mjs";
import { DEFAULT_TITLE, sanitizeTitle } from "./fx/title.mjs";

export const MODULE_ID = "sketch-reveal";


export function defaultConfig() {
  const eff = Core.EFFECTS[0];
  return {
    effectId: eff.id,
    effectParams: {},            // tylko zmienione względem effect.defaultParams, per efekt
    intro: { enabled: false, seconds: 8, colorAt: 100, params: { ...Core.SKETCH_INTRO_DEFAULTS } },
    paper: { ...Core.PAPER_DEFAULTS },
    zoom: { ...DEFAULT_ZOOM },
    sway: { ...DEFAULT_SWAY },
    residue: DEFAULT_RESIDUE,
    title: { ...DEFAULT_TITLE },
    glow: sanitizeGlow(GLOW_DEFAULT_OPTS),
    holdSec: 2,                  // splash: ile s trzymać gotowy obraz zanim da się zamknąć samoczynnie (0 = do kliknięcia)
    playerSkip: false,           // czy gracze (nie-GM) mogą pominąć/zamknąć splash (klik, Esc); GM zawsze może
    fadeSec: 1.2,                // przejście: czas rozpłynięcia nakładki w żywą scenę
  };
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Głębokie scalenie (tylko zwykłe obiekty; tablice i prymitywy nadpisują). */
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

function like(def, v, enums = {}) {
  if (!isObj(v)) return { ...def };
  const out = { ...def };
  for (const k of Object.keys(def)) {
    const d = def[k], x = v[k];
    if (typeof d === "number") { if (typeof x === "number" && Number.isFinite(x)) out[k] = x; }
    else if (typeof d === "boolean") { if (typeof x === "boolean") out[k] = x; }
    else if (typeof d === "string") { if (typeof x === "string" && (!enums[k] || enums[k].includes(x))) out[k] = x; }
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Dowolny obiekt → poprawna konfiguracja (nigdy nie rzuca). */
export function sanitizeConfig(raw) {
  const def = defaultConfig();
  if (!isObj(raw)) return def;
  const c = { ...def };
  if (typeof raw.effectId === "string" && Core.EFFECTS.some((e) => e.id === raw.effectId)) c.effectId = raw.effectId;
  if (isObj(raw.effectParams)) {
    c.effectParams = {};
    for (const e of Core.EFFECTS) {
      if (!isObj(raw.effectParams[e.id])) continue;
      const enums = Object.fromEntries((e.choiceSpecs ?? []).map((s) => [s.key, s.options]));
      const p = like(e.defaultParams, raw.effectParams[e.id], enums);
      for (const s of e.paramSpecs) if (typeof p[s.key] === "number") p[s.key] = clamp(p[s.key], s.min, s.max);
      // rzadko: tylko wartości różne od domyślnych (diffy sceny i zapisane presety nie noszą pełnych bloków)
      const sparse = Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== e.defaultParams[k]));
      if (Object.keys(sparse).length) c.effectParams[e.id] = sparse;
    }
  }
  if (isObj(raw.intro)) {
    const i = like({ enabled: def.intro.enabled, seconds: def.intro.seconds, colorAt: def.intro.colorAt }, raw.intro);
    c.intro = {
      enabled: i.enabled, seconds: clamp(i.seconds, 0.5, 30), colorAt: clamp(i.colorAt, 0, 100),
      params: like(Core.SKETCH_INTRO_DEFAULTS, raw.intro.params, { order: Core.SKETCH_INTRO_ORDERS.map((o) => o.value) }),
    };
  }
  if (isObj(raw.paper)) {
    const p = like(Core.PAPER_DEFAULTS, raw.paper);
    p.paperColor = HEX.test(p.paperColor) ? p.paperColor : Core.PAPER_DEFAULTS.paperColor;
    p.paperTexture = clamp(p.paperTexture, 0, 1);
    p.paperScale = clamp(p.paperScale, 0.5, 20);
    c.paper = p;
  }
  if (isObj(raw.zoom)) c.zoom = sanitizeZoom(raw.zoom);
  if (isObj(raw.sway)) c.sway = sanitizeSway(raw.sway);
  if (typeof raw.residue === "number") c.residue = sanitizeResidue(raw.residue);
  if (isObj(raw.title)) c.title = sanitizeTitle(raw.title);
  if (isObj(raw.glow)) {
    c.glow = sanitizeGlow(raw.glow);
    // klucze wykrywania równe domyślnym nie są nadpisaniem (formularz zawsze wysyła wszystkie 9) — usuń je, a pusty blok całkiem;
    // bez tego zapis sceny/presetu zamrażał by wartości domyślne i tworzył „fantomowe” nadpisania
    const det = c.glow.params?.detect;
    if (det) {
      const kept = Object.fromEntries(Object.entries(det).filter(([k, v]) => v !== Core.GLOW_DETECT_DEFAULTS[k]));
      c.glow = { ...c.glow, params: { ...c.glow.params } };
      if (Object.keys(kept).length) c.glow.params.detect = kept; else delete c.glow.params.detect;
    }
  }
  if (typeof raw.holdSec === "number" && Number.isFinite(raw.holdSec)) c.holdSec = clamp(raw.holdSec, 0, 60);
  if (typeof raw.playerSkip === "boolean") c.playerSkip = raw.playerSkip;
  if (typeof raw.fadeSec === "number" && Number.isFinite(raw.fadeSec)) c.fadeSec = clamp(raw.fadeSec, 0, 10);
  return c;
}

/** Parametry efektu (defaultParams + zmiany + papier) — ten sam kształt co `effectParamsOf` + paperWiring w harnessie. */
export function effectParamsOf(cfg) {
  const eff = Core.getEffect(cfg.effectId);
  return { ...eff.defaultParams, ...(cfg.effectParams[eff.id] ?? {}), ...cfg.paper };
}

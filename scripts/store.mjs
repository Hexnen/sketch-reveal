/* Magazyn: presety (ustawienie świata + wbudowane przykłady) i konfiguracja per scena (flagi sceny). */
import { LIGHT_HINT_KINDS } from "../vendor/reveal-core.js";
import { MODULE_ID, defaultConfig, deepMerge, sanitizeConfig } from "./config.mjs";

const SAMPLES = `modules/${MODULE_ID}/samples`;

/** Wbudowane przykłady (para testowa z repo roleplay) — tylko do odczytu, można je zduplikować. */
export const BUILTIN_PRESETS = [
  { id: "builtin-ulica", name: "Ulica nocą (neony)", kind: "splash", builtin: true,
    sketch: `${SAMPLES}/ulica/sketch.png`, painted: `${SAMPLES}/ulica/painted.png`,
    config: { effectId: "spread", title: { enabled: true, text: "Neonowa ulica", place: "bottom" } } },
  { id: "builtin-miasto", name: "Miasto za dnia", kind: "transition", builtin: true,
    sketch: `${SAMPLES}/miasto/sketch.png`, painted: `${SAMPLES}/miasto/painted.png`,
    config: { effectId: "speedpaint" } },
  { id: "builtin-baza", name: "Podziemna baza (ekrany)", kind: "transition", builtin: true,
    sketch: `${SAMPLES}/baza/sketch.png`, painted: `${SAMPLES}/baza/painted.png`,
    config: { effectId: "watercolor", intro: { enabled: true, seconds: 6, colorAt: 80 } } },
];

export function registerStore() {
  game.settings.register(MODULE_ID, "presets", { scope: "world", config: false, type: Object, default: {} });
}

const userPresets = () => foundry.utils.deepClone(game.settings.get(MODULE_ID, "presets") ?? {});

/** Wszystkie presety: wbudowane + użytkownika (lista). */
export function listPresets() {
  return [...BUILTIN_PRESETS, ...Object.values(userPresets())];
}

export function getPreset(id) {
  if (typeof id !== "string") return null;
  const mine = userPresets();
  // hasOwn: id typu "constructor"/"__proto__" (np. z flagi obcej sceny) nie może zwrócić prototypu obiektu
  return BUILTIN_PRESETS.find((p) => p.id === id) ?? (Object.hasOwn(mine, id) ? mine[id] : null);
}

/** Ładunek dla odtwarzacza z presetu (obrazy + konfiguracja + podpowiedzi AI). */
export function presetPayload(preset, config = preset.config) {
  return { sketchUrl: preset.sketch, paintedUrl: preset.painted, config: sanitizeConfig(config), name: preset.name,
    hints: preset.hints?.length ? preset.hints : null, hintsStrict: !!preset.hintsStrict };
}

const str = (v, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const unit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Walidacja już znormalizowanych podpowiedzi świateł (LightHint[]): zły kształt/zakres odpada, najwyżej MAX_HINTS.
 * Import z pliku nie może wsadzić do presetu wpisów, które wywaliłyby fazę rozbłysku u wszystkich.
 */
export function validHints(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const h of arr) {
    if (!h || typeof h !== "object" || !LIGHT_HINT_KINDS.includes(h.kind)) continue;
    if (!unit(h.x) || !unit(h.y) || typeof h.r !== "number" || !(h.r >= 0.003 && h.r <= 0.5)) continue;
    if (!Array.isArray(h.color) || h.color.length !== 3 || !h.color.every(unit) || !unit(h.intensity) || !unit(h.confidence)) continue;
    const e = { kind: h.kind, x: h.x, y: h.y, r: h.r, color: [...h.color], intensity: h.intensity, confidence: h.confidence };
    if (unit(h.flicker)) e.flicker = h.flicker;
    if (typeof h.label === "string") e.label = h.label.slice(0, 60);
    out.push(e);
    if (out.length >= 48) break;
  }
  return out;
}

export async function savePreset(p) {
  if (!game.user.isGM) throw new Error("GM only");
  const all = userPresets();
  const id = typeof p.id === "string" && p.id && !p.id.startsWith("builtin-") && Object.hasOwn(all, p.id) ? p.id : foundry.utils.randomID();
  all[id] = { id, name: str(p.name, 120).trim() || "Reveal", kind: p.kind === "transition" ? "transition" : "splash",
    sketch: str(p.sketch), painted: str(p.painted), config: sanitizeConfig(p.config),
    // podpowiedzi świateł z AI (wykrywa GM w edytorze, gracze tylko je czytają)
    hints: validHints(p.hints), hintsStrict: !!p.hintsStrict };
  await game.settings.set(MODULE_ID, "presets", all);
  return all[id];
}

export async function deletePreset(id) {
  if (!game.user.isGM) return;
  const all = userPresets();
  delete all[id];
  await game.settings.set(MODULE_ID, "presets", all);
}

/* ---------------------------------------------------------------- scena */
export const sceneFlags = (scene) => scene?.flags?.[MODULE_ID] ?? {};

/** Obraz tła sceny (malowany) — v14: poziomy; stare dane: scene.background. */
export function sceneBackground(scene) {
  return scene?.firstLevel?.background?.src ?? scene?.background?.src ?? "";
}

/**
 * Rozstrzyga konfigurację sceny: preset + obrazy (flaga sceny nadpisuje preset; brak malunku → tło sceny)
 * + nadpisania konfiguracji. null = scena bez reveal.
 */
export function resolveScene(scene) {
  const f = sceneFlags(scene);
  if (!f.enabled || !f.presetId) return null;
  const preset = getPreset(f.presetId);
  if (!preset) return null;
  const sketchUrl = f.sketch || preset.sketch;
  const paintedUrl = f.painted || preset.painted || sceneBackground(scene);
  if (!sketchUrl || !paintedUrl) return null;
  const config = sanitizeConfig(deepMerge(sanitizeConfig(preset.config), f.override ?? {}));
  // podpowiedzi AI wykryto na obrazie presetu — przy innym obrazie malowanym (scena / tło) byłyby w złych miejscach
  const hintsFit = paintedUrl === preset.painted && preset.hints?.length;
  return { preset, hints: hintsFit ? preset.hints : null, hintsStrict: hintsFit ? !!preset.hintsStrict : false, sketchUrl, paintedUrl, config, trigger: f.trigger === "view" ? "view" : "activate", name: preset.name };
}

export { defaultConfig };

/* ---------------------------------------------------------------- wydajność (per klient) */
import { PREVIEW_RES, sanitizePerf } from "./fx/perf.mjs";

export function registerPerfSettings() {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, { scope: "client", config: true, ...data });
  const choices = (pairs) => Object.fromEntries(pairs.map(([v, l]) => [String(v), l]));
  reg("perfPreview", { name: "SKETCHREVEAL.Perf.Preview.Name", hint: "SKETCHREVEAL.Perf.Preview.Hint", type: String, default: "full", choices: choices(PREVIEW_RES) });
  reg("perfFpsLimit", { name: "SKETCHREVEAL.Perf.FpsLimit.Name", hint: "SKETCHREVEAL.Perf.FpsLimit.Hint", type: String, default: "0",
    choices: choices([[0, "—"], [60, "60"], [30, "30"], [24, "24"]]) });
  reg("perfLiteTitle", { name: "SKETCHREVEAL.Perf.LiteTitle.Name", hint: "SKETCHREVEAL.Perf.LiteTitle.Hint", type: Boolean, default: false });
  reg("perfFpsMeter", { name: "SKETCHREVEAL.Perf.FpsMeter.Name", hint: "SKETCHREVEAL.Perf.FpsMeter.Hint", type: Boolean, default: false });
  reg("perfAutoQuality", { name: "SKETCHREVEAL.Perf.AutoQuality.Name", hint: "SKETCHREVEAL.Perf.AutoQuality.Hint", type: Boolean, default: false });
}

/** Ustawienia wydajności tego klienta (domyślnie: pełna jakość, bez limitu). */
export function clientPerf() {
  const g = (k) => game.settings.get(MODULE_ID, k);
  return sanitizePerf({ preview: g("perfPreview"), fpsLimit: Number(g("perfFpsLimit")), liteTitle: g("perfLiteTitle"), fpsMeter: g("perfFpsMeter"), autoQuality: g("perfAutoQuality") });
}

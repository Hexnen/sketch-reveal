/* Magazyn: presety (ustawienie świata + wbudowane przykłady) i konfiguracja per scena (flagi sceny). */
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
  return BUILTIN_PRESETS.find((p) => p.id === id) ?? userPresets()[id] ?? null;
}

export async function savePreset(p) {
  if (!game.user.isGM) throw new Error("GM only");
  const all = userPresets();
  const id = p.id && !p.id.startsWith("builtin-") ? p.id : foundry.utils.randomID();
  all[id] = { id, name: p.name || "Reveal", kind: p.kind === "transition" ? "transition" : "splash",
    sketch: p.sketch || "", painted: p.painted || "", config: sanitizeConfig(p.config),
    // podpowiedzi świateł z AI (zwalidowane LightHint[]; wykrywa GM w edytorze, gracze tylko je czytają)
    hints: Array.isArray(p.hints) ? p.hints : [], hintsStrict: !!p.hintsStrict };
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
  return { preset, hints: preset.hints?.length ? preset.hints : null, hintsStrict: !!preset.hintsStrict, sketchUrl, paintedUrl, config, trigger: f.trigger === "view" ? "view" : "activate", name: preset.name };
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

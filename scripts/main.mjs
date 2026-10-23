import { MODULE_ID } from "./config.mjs";
import { RevealManager, createPresetMacro, showPresetToAll } from "./apps.mjs";
import { armTransition, cancelTransition, preloadImages, registerSocket, runTransition } from "./play.mjs";
import { onRenderSceneConfig } from "./scene-tab.mjs";
import { registerPerfSettings } from "./store.mjs";
import { registerStore, resolveScene } from "./store.mjs";

/** Które sceny mają przejście i kiedy: tylko gdy rozstrzygnięcie sceny jest ważne (preset, obrazy). */
function resolveFor(scene, trigger) {
  const r = resolveScene(scene);
  if (!r) return null;
  if (!game.settings.get(MODULE_ID, "transitions")) return null;
  if (r.trigger === "activate" && !scene.active) return null;
  return r;
}

let lastSceneId = null;

Hooks.once("init", () => {
  registerStore();
  game.settings.register(MODULE_ID, "transitions", {
    name: "SKETCHREVEAL.Settings.Transitions.Name", hint: "SKETCHREVEAL.Settings.Transitions.Hint",
    scope: "client", config: true, type: new foundry.data.fields.BooleanField({ initial: true }),
  });
  game.settings.register(MODULE_ID, "preload", {
    name: "SKETCHREVEAL.Settings.Preload.Name", hint: "SKETCHREVEAL.Settings.Preload.Hint",
    scope: "client", config: true, type: new foundry.data.fields.BooleanField({ initial: true }),
  });
  registerPerfSettings();
  game.settings.register(MODULE_ID, "openrouterKey", {
    name: "SKETCHREVEAL.Settings.Key.Name", hint: "SKETCHREVEAL.Settings.Key.Hint",
    scope: "client", config: true, restricted: true, type: String, default: "",
  });
  foundry.applications.handlebars.loadTemplates([`modules/${MODULE_ID}/templates/editor.hbs`, `modules/${MODULE_ID}/templates/manager.hbs`]);
});

Hooks.once("ready", () => {
  registerSocket();
  const mod = game.modules.get(MODULE_ID);
  mod.api = { openManager: () => RevealManager.open(), showToAll: (presetId) => showPresetToAll(presetId) };
  if (game.settings.get(MODULE_ID, "preload")) preloadScenes();
});

/** Rozgrzej cache obrazami scen z włączonym reveal (aktywna + przeglądana), żeby start był natychmiastowy. */
function preloadScenes() {
  const urls = [];
  for (const scene of game.scenes) {
    if (!scene.active && !scene.isView) continue;
    const r = resolveScene(scene);
    if (r) urls.push(r.sketchUrl, r.paintedUrl);
  }
  if (urls.length) preloadImages(urls);
}

/* ---- przejścia sceny: zasłona w canvasInit (przed pierwszą klatką), odtwarzanie w canvasReady */
Hooks.on("canvasInit", () => {
  const scene = canvas.scene;
  const sameScene = scene?.id === lastSceneId;
  lastSceneId = scene?.id ?? null;
  cancelTransition();
  if (!scene || sameScene) return; // przeładowanie tej samej sceny (np. zmiana ustawień) nie odpala przejścia
  const r = resolveFor(scene);
  if (r) armTransition(r);
});
Hooks.on("canvasReady", () => runTransition());
Hooks.on("canvasTearDown", () => cancelTransition());

/* ---- zmiana flag sceny / aktywacja: rozgrzej nowe obrazy */
Hooks.on("updateScene", (scene, changes) => {
  if (!game.settings.get(MODULE_ID, "preload")) return;
  if (!(MODULE_ID in (changes.flags ?? {})) && changes.active !== true) return;
  const r = resolveScene(scene);
  if (r && (scene.active || scene.isView)) preloadImages([r.sketchUrl, r.paintedUrl]);
});

/* ---- UI */
// Przycisk menedżera w lewym pasku narzędzi sceny, tuż pod „Journal Notes” (order notes = 8, nasz 8,5). Klik otwiera menedżer
// i wraca do poprzedniej warstwy (przycisk działa jak „akcja”, nie jak nowa warstwa).
let prevControl = null;
Hooks.on("activateSceneControls", (app) => { if (app.control?.name && app.control.name !== MODULE_ID) prevControl = app.control.name; });
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  controls[MODULE_ID] = {
    name: MODULE_ID, order: 8.5, title: "SKETCHREVEAL.Manager.Button", icon: "fa-solid fa-paintbrush", visible: true, activeTool: "manager",
    onChange: (event, active) => {
      if (!active) return;
      RevealManager.open();
      // wróć do poprzedniej warstwy (zapamiętanej, a gdy brak — pierwszej innej); odroczone, by nie wchodzić w trwającą aktywację
      const back = prevControl && ui.controls.controls[prevControl] ? prevControl : Object.keys(ui.controls.controls).find((k) => k !== MODULE_ID);
      if (back) setTimeout(() => ui.controls.activate({ control: back }), 0);
    },
    tools: { manager: { name: "manager", order: 1, title: "SKETCHREVEAL.Manager.Title", icon: "fa-solid fa-paintbrush", button: true, onChange: () => RevealManager.open() } },
  };
});
Hooks.on("renderSceneConfig", onRenderSceneConfig);


/* ---- przeciągnięcie obrazka presetu z menedżera na pasek makr → makro „pokaż wszystkim” */
Hooks.on("hotbarDrop", (bar, data, slot) => {
  if (data?.type !== "SketchRevealPreset") return;
  const T = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
  if (!game.user.isGM) { ui.notifications.warn(T("Macro.GMOnly")); return false; }
  // zablokowany pasek nie przyjmie przypisania — makro i tak powstaje (katalog makr), a GM dostaje jasny komunikat
  const locked = bar.locked;
  createPresetMacro(data.presetId, locked ? null : slot)
    .then((macro) => { if (macro && locked) ui.notifications.warn(T("Macro.BarLocked", { name: macro.name })); })
    .catch((e) => { console.error(`${MODULE_ID} | makro z presetu`, e); ui.notifications.error(T("Macro.Failed", { error: e?.message ?? e })); });
  return false; // własny typ — resztą (dokument) nie ma się zajmować pasek
});

import { MODULE_ID, sanitizeConfig } from "./config.mjs";
import {
  armTransition, cancelTransition, noteSceneActivation, preloadImages, registerSocket, registerSplashState, runTransition,
  runTransitionBarrier, syncIdForScene, transitionSyncId,
} from "./play.mjs";
import { onAirPresetId, onPresetsChanged, previewTicker, registerTickerState, restoreTicker, startTicker, stopTicker, tickerDebug, toggleTicker } from "./ticker-play.mjs";
import { attachNewspaper, cancelNewspaper, newspaperDebug, onTearDownNewspaper, previewNewspaper, resolveNewspaperFor, runNewspaper, warmNewspaperFont } from "./newspaper-play.mjs";
import { registerAiTypes } from "./ai-image.mjs";
import { registerPerfSettings } from "./store.mjs";
import { getPreset, listPresets, registerStore, resolveNewspaper, resolveScene } from "./store.mjs";
import { warmShaders } from "./fx/shader-warm.mjs";

/* Okna GM-a (menedżer, edytor, eksport, formularze, zakładka sceny) ładowane dopiero, gdy są potrzebne — gracze ich nigdy
   nie otwierają, więc nie pobierają ich przy każdym wejściu do świata (dev/perf-audit.md F8). GM dostaje je w tle po `ready`. */
const apps = () => import("./apps.mjs");
let sceneTab = null, sceneTabMod = null;
const loadSceneTab = () => (sceneTab ??= import("./scene-tab.mjs").then((m) => (sceneTabMod = m)));

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
  registerSplashState();
  registerTickerState();
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
  mod.api = {
    openManager: () => apps().then((m) => m.RevealManager.open()),
    // pasek wiadomości: „pokaż wszystkim” działa jak przełącznik (na antenie ↔ zdjęty)
    showToAll: (presetId) => (getPreset(presetId)?.kind === "ticker" ? toggleTicker(presetId) : apps().then((m) => m.showPresetToAll(presetId))),
    ticker: { start: startTicker, stop: stopTicker, toggle: toggleTicker, onAir: onAirPresetId, preview: previewTicker, debug: tickerDebug },
    // gazeta: podgląd na bieżącym widoku (preset id albo obiekt konfiguracji; bez argumentu — domyślna), diagnostyka
    newspaper: { preview: previewNewspaper, debug: newspaperDebug },
  };
  // rozgrzewka gazety (fonty + pierwsze malowanie strony) tylko tam, gdzie gazeta może zagrać: GM (podgląd, edytor) albo
  // świat ma scenę z gazetą; scena, która dostanie gazetę później, rozgrzewa ją w updateScene
  if (game.user.isGM || game.scenes.some((s) => resolveNewspaper(s))) warmNewspaperFont();
  if (game.user.isGM) {
    const later = () => { apps().catch(() => {}); loadSceneTab().catch(() => {}); };
    if (globalThis.requestIdleCallback) requestIdleCallback(later, { timeout: 5000 }); else setTimeout(later, 1000);
  }
  Hooks.on("sketchReveal.presets", onPresetsChanged);
  restoreTicker(); // pasek, który leci, widzą też klienci, którzy weszli później / przeładowali stronę
  // AI Image Gen (opcjonalnie): nasze typy obrazów trafiają do jego okna konfiguracji; kolejność startu modułów jest dowolna
  registerAiTypes();
  Hooks.on("aiImageGen.ready", (api) => { if (game.user.isGM) registerAiTypes(api); });
  if (game.settings.get(MODULE_ID, "preload")) preloadScenes();
  // F4: programy WebGL efektów używanych w presetach/scenach kompilowane w tle (pierwszy reveal bez ~1 s zamrożenia)
  setTimeout(() => {
    try {
      const cfgs = listPresets().filter((p) => p.config && p.kind !== "ticker" && p.kind !== "newspaper").map((p) => sanitizeConfig(p.config));
      for (const scene of game.scenes) { const r = resolveScene(scene); if (r) cfgs.push(r.config); }
      warmShaders(cfgs.map((c) => c.effectId), { glow: cfgs.some((c) => c.glow?.enabled) }).catch(() => {});
    } catch (e) { console.warn(`${MODULE_ID} | rozgrzewka shaderów`, e); }
  }, 3000);
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
  if (!scene || sameScene) { cancelNewspaper(); return; } // przeładowanie tej samej sceny (np. zmiana ustawień) nie odpala przejścia
  // gazeta: zasłona i zrzut już leżą od canvasTearDown — tu tylko id wspólnego startu
  if (resolveNewspaperFor(scene)) { attachNewspaper(scene, syncIdForScene(scene.id)); return; }
  cancelNewspaper();
  const r = resolveFor(scene);
  // aktywacja sceny widziana przez ten klient → przejście startuje wspólnie z innymi (syncId), inaczej od razu po przygotowaniu
  if (r) armTransition(r, syncIdForScene(scene.id));
});
Hooks.on("canvasReady", () => { runTransition(); runNewspaper(); });
// v14: canvasTearDown leci, zanim warstwy starej sceny zostaną zburzone, i zna następną scenę — moment na zrzut „gazety”
Hooks.on("canvasTearDown", (cv, options) => { cancelTransition(); onTearDownNewspaper(options); });

/* ---- zmiana flag sceny / aktywacja: rozgrzej nowe obrazy */
Hooks.on("updateScene", (scene, changes, options, userId) => {
  if (changes.active === true) {
    noteSceneActivation(scene.id); // każdy klient: ta scena właśnie została aktywowana
    // aktywujący GM jest inicjatorem wspólnego startu przejścia (czeka na gotowość klientów i wysyła czas startu)
    if (userId === game.user.id && game.user.isGM && game.settings.get(MODULE_ID, "transitions") && (resolveFor(scene) || resolveNewspaperFor(scene))) {
      runTransitionBarrier(scene.id, transitionSyncId(scene.id)).catch((e) => console.error(`${MODULE_ID} | wspólny start przejścia`, e));
    }
  }
  if ((MODULE_ID in (changes.flags ?? {}) || changes.active === true) && resolveNewspaper(scene)) warmNewspaperFont(); // jednorazowe
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
      apps().then((m) => m.RevealManager.open());
      // wróć do poprzedniej warstwy (zapamiętanej, a gdy brak — pierwszej innej); odroczone, by nie wchodzić w trwającą aktywację
      const back = prevControl && ui.controls.controls[prevControl] ? prevControl : Object.keys(ui.controls.controls).find((k) => k !== MODULE_ID);
      if (back) setTimeout(() => ui.controls.activate({ control: back }), 0);
    },
    tools: { manager: { name: "manager", order: 1, title: "SKETCHREVEAL.Manager.Title", icon: "fa-solid fa-paintbrush", button: true, onChange: () => apps().then((m) => m.RevealManager.open()) } },
  };
});
// zakładka sceny: moduł zwykle już załadowany w tle po `ready` (GM) — wtedy wstawienie jest synchroniczne jak dotąd
Hooks.on("renderSceneConfig", (...args) => {
  if (sceneTabMod) return sceneTabMod.onRenderSceneConfig(...args);
  loadSceneTab().then((m) => m.onRenderSceneConfig(...args)).catch((e) => console.error(`${MODULE_ID} | zakładka sceny`, e));
});


/* ---- przeciągnięcie obrazka presetu z menedżera na pasek makr → makro „pokaż wszystkim” */
Hooks.on("hotbarDrop", (bar, data, slot) => {
  if (data?.type !== "SketchRevealPreset") return;
  const T = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
  if (!game.user.isGM) return false; // gracze nie dostają powiadomień modułu
  // zablokowany pasek nie przyjmie przypisania — makro i tak powstaje (katalog makr), a GM dostaje jasny komunikat
  const locked = bar.locked;
  apps().then((m) => m.createPresetMacro(data.presetId, locked ? null : slot))
    .then((macro) => { if (macro && locked) ui.notifications.warn(T("Macro.BarLocked", { name: foundry.utils.escapeHTML(macro.name) })); })
    .catch((e) => { console.error(`${MODULE_ID} | makro z presetu`, e); ui.notifications.error(T("Macro.Failed", { error: foundry.utils.escapeHTML(String(e?.message ?? e)) })); });
  return false; // własny typ — resztą (dokument) nie ma się zajmować pasek
});

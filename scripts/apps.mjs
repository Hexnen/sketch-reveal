/* Aplikacje (ApplicationV2): menedżer presetów (splashe i przejścia) oraz edytor presetu / nadpisań sceny. */
import { MODULE_ID, defaultConfig, deepMerge, sanitizeConfig } from "./config.mjs";
import { exportRevealWebm } from "./export-ui.mjs";
import { optimizeRevealImages, optimizerApi } from "./optimize.mjs";
import { aiApi, aiBusy, aiGeneratePainted, aiGenerateSketch, aiGuard } from "./ai-image.mjs";
import { applyShowIf, configFormHtml, readForm } from "./form.mjs";
import { broadcastClose, playSplash, preloadForAll, showSplashToAll } from "./play.mjs";
import { detectLightHints } from "./fx/ai-hints.mjs";
import { openKeys } from "./keys-app.mjs";
import { BUILTIN_PRESETS, deletePreset, getPreset, isNewspaper, isTicker, listPresets, presetPayload, sceneBackground, sceneFlags, savePreset } from "./store.mjs";
import { DEFAULT_TICKER, inkOn, sanitizeTicker } from "./fx/ticker.mjs";
import { bindTickerItems, readTickerForm, tickerFormHtml } from "./ticker-form.mjs";
import { onAirPresetId, previewTicker, startTicker, stopTicker, toggleTicker } from "./ticker-play.mjs";
import { DEFAULT_NEWSPAPER, sanitizeNewspaper } from "./fx/newspaper.mjs";
import { bindNewspaperForm, newspaperFormHtml, previewNewspaper } from "./newspaper-play.mjs";
import { EFFECTS } from "../vendor/reveal-core.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const T = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
/** T dla powiadomień: powiadomienia Foundry wstawiają tekst jako HTML, więc wartości tekstowe (nazwy z importu, błędy) escapujemy. */
const TE = (k, d) => T(k, Object.fromEntries(Object.entries(d).map(([n, v]) => [n, typeof v === "string" ? foundry.utils.escapeHTML(v) : v])));

/** Ładunek dla odtwarzacza z presetu (obrazy + konfiguracja). */
export const payloadOf = presetPayload;

/** Pokaż preset wszystkim (używane przez makra z paska). Tylko GM; gracz nie dostaje żadnych powiadomień modułu. */
export function showPresetToAll(presetId) {
  if (!game.user.isGM) return console.warn(`${MODULE_ID} | tylko GM może pokazać splash wszystkim`);
  const p = getPreset(presetId);
  if (!p) return ui.notifications.warn(T("Macro.Missing"));
  if (isTicker(p)) return toggleTicker(presetId);
  if (isNewspaper(p)) return ui.notifications.warn(T("Newspaper.NotForAll")); // gazeta gra przy zmianie sceny, nie na żądanie
  return showSplashToAll(presetId);
}

/**
 * Kwadratowa ikona makra (kadrowanie „cover” ze środka obrazu): pasek makr ma kwadratowe sloty, a obraz 16:9 byłby w nich
 * ściśnięty. Zapis do worlds/<świat>/sketch-reveal/<preset>.webp; przy błędzie (brak uprawnień do plików) → null.
 */
async function makeSquareIcon(presetId, paintedUrl, size = 256) {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous"; img.src = paintedUrl;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const k = Math.max(size / img.naturalWidth, size / img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k;
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    const blob = await new Promise((res) => c.toBlob(res, "image/webp", 0.88));
    if (!blob) return null;
    const FP = foundry.applications.apps.FilePicker.implementation;
    const dir = `worlds/${game.world.id}/${MODULE_ID}`;
    try { await FP.createDirectory("data", dir, {}); } catch { /* katalog już istnieje */ }
    const name = `${presetId}.webp`;
    // optimized: true — to już zakodowany WebP; optymalizator mediów nie ma go kodować drugi raz
    const res = await FP.upload("data", dir, new File([blob], name, { type: "image/webp" }), {}, { notify: false, optimized: true });
    return res?.path ?? `${dir}/${name}`;
  } catch (e) { console.warn(`${MODULE_ID} | ikona makra`, e); return null; }
}

/** Ikona makra paska wiadomości: miniatura pakietu w danym wyglądzie (broadcast / wire / signal) na ciemnym tle. */
async function makeTickerIcon(presetId, accent, look = "broadcast", size = 256) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d"), u = size / 16;
    g.fillStyle = "#1d2027"; g.fillRect(0, 0, size, size);
    if (look === "wire") {
      // krzywo wklejona taśma, wycinek z tytułem, odcisk pieczątki
      g.save(); g.translate(size / 2, u * 10); g.rotate(-0.035);
      g.fillStyle = "#ebe6d9"; g.fillRect(-u * 7, -u * 1.3, u * 14, u * 2.6);
      g.strokeStyle = accent; g.lineWidth = u * 0.28; g.strokeRect(-u * 6.2, -u * 0.75, u * 2.8, u * 1.5);
      g.fillStyle = "#1e1c18"; g.fillRect(-u * 2.6, -u * 0.3, u * 8, u * 0.6);
      g.restore();
      g.save(); g.translate(u * 6.5, u * 7.2); g.rotate(-0.06);
      g.fillStyle = "#f3efe4"; g.fillRect(-u * 4, -u * 1.2, u * 8, u * 2.4);
      g.fillStyle = "#1e1c18"; g.fillRect(-u * 4, -u * 1.2, u * 8, u * 0.35); g.fillRect(-u * 3.3, -u * 0.2, u * 6, u * 0.75);
      g.restore();
    } else if (look === "signal") {
      const band = (x, y, w, h, cut, flip) => { g.beginPath(); g.moveTo(x, y); g.lineTo(x + w - (flip ? cut : 0), y); g.lineTo(x + w - (flip ? 0 : cut), y + h); g.lineTo(x, y + h); g.closePath(); g.fill(); };
      g.fillStyle = "#0b1017"; band(u * 1.5, u * 8.6, u * 13, u * 3, u * 1.2, false);   // pasmo
      band(u * 1.5, u * 6, u * 8, u * 2.4, u * 1, true);                                   // płytka tytułu
      g.fillStyle = accent; g.fillRect(u * 1.5, u * 8.45, u * 13, u * 0.3);                // szyna
      band(u * 1.5, u * 8.75, u * 3.8, u * 2.85, u * 0.9, false);                         // zakładka kanału
      g.fillStyle = "#e7eef4"; g.fillRect(u * 6.4, u * 9.9, u * 6, u * 0.55); g.fillRect(u * 2.3, u * 6.9, u * 5, u * 0.7);
    } else {
      g.fillStyle = "#0d1016"; g.fillRect(u * 1.5, u * 6.5, u * 4, u * 5);          // blok kanału
      g.fillStyle = accent; g.fillRect(u * 2.2, u * 8.9, u * 2.6, u * 0.9);          // znacznik „na żywo”
      g.fillRect(u * 5.5, u * 6.5, u * 9, u * 2.7);                                  // belka
      g.fillStyle = "#f1f2f4"; g.fillRect(u * 5.5, u * 9.2, u * 9, u * 2.3);         // pasek
      g.fillStyle = "#0d1016"; g.fillRect(u * 6.3, u * 10, u * 6, u * 0.7);          // „tekst” na pasku
      g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(u * 6.3, u * 7.4, u * 5.5, u * 0.9); // „tytuł” na belce
    }
    const blob = await new Promise((res) => c.toBlob(res, "image/webp", 0.92));
    if (!blob) return null;
    const FP = foundry.applications.apps.FilePicker.implementation;
    const dir = `worlds/${game.world.id}/${MODULE_ID}`;
    try { await FP.createDirectory("data", dir, {}); } catch { /* katalog już istnieje */ }
    const name = `${presetId}.webp`;
    const res = await FP.upload("data", dir, new File([blob], name, { type: "image/webp" }), {}, { notify: false, optimized: true });
    return res?.path ?? `${dir}/${name}`;
  } catch (e) { console.warn(`${MODULE_ID} | ikona makra paska`, e); return null; }
}

/** Makro „pokaż wszystkim” dla presetu (jedno na preset — istniejące jest używane ponownie); przypisuje je do slotu paska. */
export async function createPresetMacro(presetId, slot) {
  const p = getPreset(presetId);
  if (!p) return ui.notifications.warn(T("Macro.Missing"));
  if (isNewspaper(p)) return ui.notifications.warn(T("Newspaper.NotForAll"));
  let macro = game.macros.find((m) => m.getFlag(MODULE_ID, "presetId") === presetId);
  const icon = isTicker(p)
    ? (await makeTickerIcon(presetId, sanitizeTicker(p.ticker).accent, sanitizeTicker(p.ticker).look)) ?? "icons/svg/sound.svg"
    : (await makeSquareIcon(presetId, p.painted)) ?? (p.painted || "icons/svg/clapperboard.svg");
  if (macro && macro.img !== icon) await macro.update({ img: icon }); // stare makra z rozciągniętym obrazem dostają kwadratową ikonę
  if (!macro) {
    macro = await Macro.implementation.create({
      name: p.name, type: "script", img: icon,
      command: isTicker(p)
        ? `// Sketch Reveal: pasek wiadomości — nadaj wszystkim / zdejmij (przełącznik)
game.modules.get("${MODULE_ID}").api.ticker.toggle(${JSON.stringify(presetId)});`
        : `// Sketch Reveal: pokaż preset wszystkim (czeka, aż wszyscy będą gotowi)
game.modules.get("${MODULE_ID}").api.showToAll(${JSON.stringify(presetId)});`,
      flags: { [MODULE_ID]: { presetId } },
    });
  }
  if (slot !== undefined && slot !== null) await game.user.assignHotbarMacro(macro, slot);
  if (slot !== undefined && slot !== null) ui.notifications.info(TE("Macro.Created", { name: p.name }));
  return macro;
}

/* ================================================================ edytor */
export class RevealEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "sketch-reveal-editor-{id}",
    classes: ["sketch-reveal", "sr-editor"],
    tag: "form",
    window: { icon: "fa-solid fa-paintbrush", resizable: true },
    position: { width: 560, height: 720 },
    form: { handler: RevealEditor.#onSubmit, closeOnSubmit: true },
    actions: { preview: RevealEditor.#onPreview, applyLive: RevealEditor.#onApplyLive, exportWebm: RevealEditor.#onExportWebm, optimizeImages: RevealEditor.#onOptimize, aiPainted: RevealEditor.#onAiPainted, aiSketch: RevealEditor.#onAiSketch },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/editor.hbs`, scrollable: [".sr-editor-scroll"] } };

  /**
   * @param {object} o
   * @param {object} [o.preset]  edycja presetu (nowy = bez id)
   * @param {Scene}  [o.scene]   edycja nadpisań konfiguracji sceny
   */
  constructor({ preset, scene, ...options } = {}) {
    super(options);
    this.scene = scene ?? null;
    if (scene) {
      // bazą jest konfiguracja presetu NIEZALEŻNIE od „włączone”/obrazów (inaczej edycja wyłączonej sceny kasowałaby nadpisania)
      const f = sceneFlags(scene), preset = getPreset(f.presetId);
      this.base = preset ? sanitizeConfig(preset.config) : defaultConfig();
      this.cfg = sanitizeConfig(deepMerge(this.base, f.override ?? {}));
      this.meta = { name: scene.name, kind: "transition", sketch: f.sketch || preset?.sketch || "", painted: f.painted || preset?.painted || sceneBackground(scene) };
    } else {
      const p = preset ?? { name: "", kind: "splash", sketch: "", painted: "", config: defaultConfig() };
      this.presetId = p.id ?? null;
      this.ticker = sanitizeTicker(p.ticker ?? DEFAULT_TICKER);
      this.newspaper = sanitizeNewspaper(p.newspaper ?? DEFAULT_NEWSPAPER);
      this.hints = p.hints ?? []; this.hintsStrict = !!p.hintsStrict;
      this.cfg = sanitizeConfig(p.config);
      this.meta = { name: p.name, kind: p.kind, sketch: p.sketch, painted: p.painted };
    }
  }

  get title() {
    return this.scene ? T("Editor.SceneTitle", { scene: this.scene.name }) : this.presetId ? T("Editor.EditTitle") : T("Editor.NewTitle");
  }

  get isTicker() { return !this.scene && this.meta.kind === "ticker"; }
  get isNewspaper() { return !this.scene && this.meta.kind === "newspaper"; }

  async _prepareContext() {
    const ticker = this.isTicker, paper = this.isNewspaper;
    const noImages = ticker || paper;
    return {
      sceneMode: !!this.scene,
      isTicker: ticker,
      noImages,
      meta: this.meta,
      kinds: ["splash", "transition", "newspaper", "ticker"].map((value) => ({ value, label: T(`Kind.${value}`) })),
      // pasek wiadomości i gazeta nie mają obrazów ani efektu — własne formularze
      configHtml: ticker ? tickerFormHtml(this.ticker, { onAir: !!this.presetId && onAirPresetId() === this.presetId })
        : paper ? newspaperFormHtml(this.newspaper)
        : configFormHtml(this.cfg, this.scene ? "" : this._aiHtml()),
      saveLabel: T("Editor.Save"),
      canOptimize: !noImages && !this.scene && !!optimizerApi(), // przycisk tylko gdy działa moduł Media Optimizer (Local)
      canAi: !noImages && !this.scene && !!aiApi(), // generowanie obrazów tylko gdy działa moduł AI Image Gen (i jesteś GM-em)
      aiBusy: aiBusy(this._aiKey), // trwająca generacja przeżywa re-render edytora: oba przyciski zostają wyłączone
    };
  }

  /** Sekcja „AI” w rozbłysku (tylko edytor presetu): wykrywa GM kluczem OpenRouter, wynik zapisuje się w presecie. */
  _aiHtml() {
    const n = this.hints?.length ?? 0;
    return `<div class="form-group sr-ai"><label>${T("AI.Label")}</label>
      <div class="form-fields">
        <button type="button" data-sr="ai-detect"><i class="fa-solid fa-wand-magic-sparkles"></i> ${T("AI.Detect")}</button>
        <button type="button" data-sr="ai-clear"${n ? "" : " disabled"}><i class="fa-solid fa-eraser"></i> ${T("AI.Clear")}</button>
        <label class="checkbox"><input type="checkbox" name="hintsStrict"${this.hintsStrict ? " checked" : ""}> ${T("AI.Strict")}</label>
      </div>
      <p class="hint" data-sr="ai-status">${n ? T("AI.Status", { n }) : T("AI.None")} ${T("AI.Hint")}</p></div>`;
  }

  async _aiDetect() {
    this._collect(); // bieżący obraz malowany z pola formularza (nie ten sprzed zmiany)
    const key = game.settings.get(MODULE_ID, "openrouterKey");
    if (!key?.trim()) { ui.notifications.warn(T("AI.NoKey")); openKeys(); return; } // od razu okno klucza (tylko GM)
    if (!this.meta.painted) return ui.notifications.warn(T("AI.NeedPainted"));
    const status = this.element.querySelector('[data-sr="ai-status"]');
    const btn = this.element.querySelector('[data-sr="ai-detect"]');
    btn.disabled = true; status.textContent = T("AI.Working");
    try {
      const r = await detectLightHints(this.meta.painted, key);
      this.hints = r.hints;
      ui.notifications.info(T("AI.Done", { n: r.hints.length, cost: r.cost.toFixed(4) }));
    } catch (e) {
      ui.notifications.error(TE("AI.Failed", { error: String(e?.message ?? e) }));
    }
    this._collect(); this.render();
  }

  /** Zbierz bieżący stan formularza do this.cfg / this.meta. */
  _collect() {
    const form = this.element;
    if (!form) return;
    const data = readForm(form);
    // podpowiedzi AI dotyczą konkretnego obrazu malowanego — po jego zmianie są nieaktualne
    if (data.meta?.painted !== undefined && !this.scene && data.meta.painted !== this.meta.painted) this.hints = [];
    // sekcję paska czytamy wtedy, gdy JEST w DOM (rodzaj w polu mógł się właśnie zmienić)
    const tickerShown = !!form.querySelector('[data-sr="items"]');
    const paperShown = !!form.querySelector('[data-sr="newspaper"]');
    if (data.meta) this.meta = { ...this.meta, ...data.meta };
    const { meta, hintsStrict, ticker, newspaper, ...rest } = data;
    void meta;
    if (tickerShown) { this.ticker = readTickerForm(form, ticker); return; }
    if (paperShown) { this.newspaper = sanitizeNewspaper({ ...this.newspaper, ...(newspaper ?? {}), playerSkip: !!newspaper?.playerSkip }); return; }
    if (hintsStrict !== undefined) this.hintsStrict = !!hintsStrict;
    this.cfg = sanitizeConfig(deepMerge(this.cfg, rest));
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    // zmiana efektu przebudowuje pola parametrów (zachowując resztę formularza)
    this.element.querySelector('select[name="effectId"]')?.addEventListener("change", () => { this._collect(); this.render(); });
    // zmiana rodzaju (splash/przejście ↔ pasek wiadomości) przebudowuje formularz
    this.element.querySelector('select[name="meta.kind"]')?.addEventListener("change", () => { this._collect(); this.render(); });
    bindTickerItems(this.element);
    bindNewspaperForm(this.element);
    this.element.querySelector('[data-sr="ai-detect"]')?.addEventListener("click", () => this._aiDetect());
    this.element.querySelector('[data-sr="ai-clear"]')?.addEventListener("click", () => { this._collect(); this.hints = []; this.render(); });
    applyShowIf(this.element);
    this.element.onchange = () => applyShowIf(this.element); // pola warunkowe (showIf) wg bieżących wartości
  }

  // nasłuch okna (blur) i obserwator rozmiaru listy paska trzymałyby zamknięty edytor w pamięci do końca sesji
  _onClose(options) { super._onClose?.(options); this.element?._srItemsAbort?.abort(); }

  static async #onPreview() {
    this._collect();
    if (this.isTicker) return previewTicker(this.ticker);
    if (this.isNewspaper) return previewNewspaper(this.newspaper);
    if (!this.meta.sketch || !this.meta.painted) return ui.notifications.warn(T("Editor.NeedImages"));
    playSplash({ sketchUrl: this.meta.sketch, paintedUrl: this.meta.painted, config: this.cfg, hints: this.hints ?? null, hintsStrict: !!this.hintsStrict });
  }

  /** „Zoptymalizuj obrazy”: kopie WebP ≤ 4096 px przez Media Optimizer; preset dostaje nowe ścieżki, oryginały zostają. */
  static async #onOptimize(event, target) {
    this._collect();
    if (!this.meta.sketch || !this.meta.painted) return ui.notifications.warn(T("Editor.NeedImages"));
    target.disabled = true;
    try {
      const r = await optimizeRevealImages(this.meta);
      if (!r.changed) ui.notifications.info(T("Optimize.None"));
      else {
        this.meta.sketch = r.sketch; this.meta.painted = r.painted; // hinty AI są w uv, więc zostają ważne dla zmniejszonego obrazu
        ui.notifications.info(foundry.utils.escapeHTML(r.summary));
        this.render();
      }
    } catch (e) {
      console.error(`${MODULE_ID} | optymalizacja obrazów`, e);
      ui.notifications.error(TE("Optimize.Failed", { error: String(e?.message ?? e) }));
    } finally { target.disabled = false; }
  }

  get _aiKey() { return `editor:${this.id}`; }

  /**
   * „Wygeneruj malunek (AI)” / „Szkic z malunku (AI)”: wynik wpisuje się w preset dopiero po wyborze wersji.
   * Formularz zbieramy PO generacji (edycje z jej trwania nie giną), a gdy okno zdążyło się zamknąć, opłacony obraz trafia
   * wprost do zapisanego presetu (albo jest tylko zgłoszony powiadomieniem, gdy to był jeszcze niezapisany nowy preset).
   */
  async #aiRun(field, generate) {
    this._collect();
    return aiGuard(this._aiKey, async (controller, release) => {
      const path = await generate(controller);
      if (!path) return null;
      if (this.rendered) {
        this._collect();
        this.meta[field] = path;
        if (field === "painted") this.hints = []; // podpowiedzi świateł dotyczą konkretnego obrazu malowanego
        release(); // przed render(): nowy DOM ma mieć włączone przyciski
        this.render();
      } else await this.#applyClosed(field, path);
      return path;
    }, (on) => this.element?.querySelectorAll('[data-action="aiPainted"], [data-action="aiSketch"]').forEach((b) => { b.disabled = on; }));
  }

  async #applyClosed(field, path) {
    const saved = this.presetId ? getPreset(this.presetId) : null;
    if (saved && !saved.builtin) {
      try {
        await savePreset({ ...saved, [field]: path, ...(field === "painted" ? { hints: [] } : {}) });
        RevealManager.instance?.render();
        return ui.notifications.info(T("AIGen.AppliedPreset", { path: foundry.utils.escapeHTML(path) }));
      } catch (e) { console.warn(`${MODULE_ID} | zapis presetu po zamknięciu edytora`, e); }
    }
    ui.notifications.info(T("AIGen.EditorClosed", { path: foundry.utils.escapeHTML(path) }));
  }

  static async #onAiPainted() {
    return this.#aiRun("painted", (controller) => aiGeneratePainted({ name: this.meta.name || T("Editor.Unnamed"), current: this.meta.painted, controller }));
  }

  static async #onAiSketch() {
    return this.#aiRun("sketch", (controller) => aiGenerateSketch({ name: this.meta.name || T("Editor.Unnamed"), painted: this.meta.painted, controller }));
  }

  static async #onExportWebm() {
    this._collect();
    exportRevealWebm({ sketchUrl: this.meta.sketch, paintedUrl: this.meta.painted, config: this.cfg, hints: this.hints ?? null, hintsStrict: !!this.hintsStrict, name: this.meta.name });
  }

  static async #onSubmit(event, form, formData) {
    this._collect();
    if (this.scene) {
      // parametry efektu są w configu „rzadkie” (bez wartości domyślnych) — diff na rzadkich blokach nie umiałby cofnąć
      // parametru do domyślnej; porównujemy więc postać gęstą (defaultParams + zmiany)
      const dense = (c) => {
        const o = foundry.utils.deepClone(c);
        for (const id of new Set([...Object.keys(this.base.effectParams), ...Object.keys(this.cfg.effectParams), this.cfg.effectId, this.base.effectId])) {
          const eff = EFFECTS.find((e) => e.id === id);
          if (eff) o.effectParams[id] = { ...eff.defaultParams, ...(c.effectParams[id] ?? {}) };
        }
        return o;
      };
      const diff = foundry.utils.diffObject(dense(this.base), dense(this.cfg));
      const key = `flags.${MODULE_ID}`;
      await this.scene.update({ [`${key}.override`]: new foundry.data.operators.ForcedDeletion() }); // v14: „-=” jest przestarzałe
      if (!foundry.utils.isEmpty(diff)) await this.scene.update({ [`${key}.override`]: diff });
      this.scene.sheet?.render();
      return;
    }
    if (!this.meta.name?.trim()) this.meta.name = T("Editor.Unnamed");
    if (this.isTicker) { await this._saveTicker(); return; }
    if (this.isNewspaper) {
      const saved = await savePreset({ id: this.presetId, name: this.meta.name, kind: "newspaper", newspaper: this.newspaper });
      this.presetId = saved.id;
      RevealManager.instance?.render();
      return;
    }
    await savePreset({ id: this.presetId, ...this.meta, config: this.cfg, hints: this.hints, hintsStrict: this.hintsStrict });
    RevealManager.instance?.render();
  }

  /** Zapis paska; gdy jest na antenie, wszyscy widzą zmiany od następnej wiadomości (onChange ustawienia presetów). */
  async _saveTicker() {
    const saved = await savePreset({ id: this.presetId, name: this.meta.name, kind: "ticker", ticker: this.ticker });
    this.presetId = saved.id;
    RevealManager.instance?.render();
    return saved;
  }

  /** „Zastosuj”: zapis bez zamykania okna — do poprawiania listy, gdy pasek leci. */
  static async #onApplyLive() {
    this._collect();
    if (!this.meta.name?.trim()) this.meta.name = T("Editor.Unnamed");
    await this._saveTicker();
    ui.notifications.info(T(onAirPresetId() === this.presetId ? "Ticker.AppliedLive" : "Ticker.Applied"));
    this.render();
  }
}

/* ================================================================ menedżer */
export class RevealManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: "sketch-reveal-manager",
    classes: ["sketch-reveal", "sr-manager"],
    window: { icon: "fa-solid fa-paintbrush", title: "SKETCHREVEAL.Manager.Title", resizable: true },
    position: { width: 620, height: 560 },
    actions: {
      newPreset: RevealManager.#onNew,
      editPreset: RevealManager.#onEdit,
      duplicatePreset: RevealManager.#onDuplicate,
      deletePreset: RevealManager.#onDelete,
      playLocal: RevealManager.#onPlayLocal,
      playAll: RevealManager.#onPlayAll,
      preloadAll: RevealManager.#onPreload,
      closeAll: RevealManager.#onCloseAll,
      exportPreset: RevealManager.#onExport,
      exportWebm: RevealManager.#onExportWebm,
      importPreset: RevealManager.#onImport,
      tickerPreview: RevealManager.#onTickerPreview,
      tickerAir: RevealManager.#onTickerAir,
      tickerStop: RevealManager.#onTickerStop,
    },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/manager.hbs`, scrollable: [".sr-list"] } };

  static open() {
    this.instance ??= new RevealManager();
    return this.instance.render({ force: true });
  }

  async _prepareContext() {
    const onAir = onAirPresetId();
    const presets = listPresets().map((p) => {
      const o = { ...p, kindLabel: T(`Kind.${p.kind}`), effectLabel: p.config?.effectId ?? "", isGM: game.user.isGM };
      if (isNewspaper(p)) {
        const n = sanitizeNewspaper(p.newspaper);
        Object.assign(o, { isNewspaper: true, paper: n.paper, effectLabel: T("Newspaper.Meta", { kind: T("Kind.newspaper"), turns: n.turns, sec: n.spinSec }) });
      }
      return o;
    });
    const tickers = presets.filter((p) => isTicker(p)).map((p) => {
      const t = sanitizeTicker(p.ticker);
      return { ...p, accent: t.accent, onAccent: inkOn(t.accent), onAir: p.id === onAir, look: t.look,
        tickerMeta: [T(`LookShort.${t.look}`), T("Manager.TickerItems", { n: t.items.length }), T(`Mode.${t.mode}`), T(`StyleShort.${t.style}`)].join(" · ") };
    });
    return {
      isGM: game.user.isGM,
      presets,
      splashes: presets.filter((p) => p.kind === "splash"),
      transitions: presets.filter((p) => p.kind === "transition" || p.kind === "newspaper"),
      tickers,
      onAirName: tickers.find((p) => p.onAir)?.name ?? "",
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    // przeciągnięcie obrazka presetu na pasek makr tworzy makro „pokaż wszystkim”
    if (!game.user.isGM) return;
    // gazeta nie ma makra „pokaż wszystkim” (gra przy zmianie sceny) — jej miniatura nie jest przeciągalna
    for (const img of this.element.querySelectorAll(".sr-thumb:not(.sr-thumb-news)")) {
      img.draggable = true;
      img.addEventListener("dragstart", (ev) => {
        const id = img.closest("[data-preset]")?.dataset.preset;
        ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "SketchRevealPreset", presetId: id }));
        ev.dataTransfer.effectAllowed = "copy";
      });
    }
  }

  _onClose(options) { super._onClose?.(options); if (RevealManager.instance === this) RevealManager.instance = null; }

  static #preset(target) { return getPreset(target.closest("[data-preset]")?.dataset.preset); }

  static async #onNew() { new RevealEditor().render({ force: true }); }
  static async #onEdit(event, target) {
    const p = RevealManager.#preset(target);
    if (!p) return;
    if (p.builtin) return ui.notifications.info(T("Manager.BuiltinReadonly"));
    new RevealEditor({ preset: p }).render({ force: true });
  }
  static async #onDuplicate(event, target) {
    const p = RevealManager.#preset(target);
    if (!p) return;
    const copy = await savePreset({ ...p, id: null, name: `${p.name} ${T("Manager.CopySuffix")}`, builtin: false });
    this.render();
    new RevealEditor({ preset: copy }).render({ force: true });
  }
  static async #onDelete(event, target) {
    const p = RevealManager.#preset(target);
    if (!p || p.builtin) return;
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: T("Manager.Delete") }, content: `<p>${foundry.utils.escapeHTML(p.name)}</p>` });
    if (!ok) return;
    if (onAirPresetId() === p.id) await stopTicker(); // nie zostawiaj stanu „na antenie” po usuniętym presecie
    await deletePreset(p.id);
    this.render();
  }
  static async #onPlayLocal(event, target) {
    const p = RevealManager.#preset(target);
    if (p && isNewspaper(p)) return previewNewspaper(p.newspaper);
    if (p) playSplash(payloadOf(p));
  }
  static async #onPlayAll(event, target) {
    const p = RevealManager.#preset(target);
    if (p && isTicker(p)) return startTicker(p.id);
    if (p) showSplashToAll(p.id);
  }
  static async #onPreload(event, target) {
    const p = RevealManager.#preset(target);
    if (!p) return;
    await preloadForAll([p.sketch, p.painted]);
    ui.notifications.info(TE("Manager.Preloaded", { name: p.name }));
  }
  static async #onCloseAll() { broadcastClose(); }

  static async #onTickerPreview(event, target) {
    const p = RevealManager.#preset(target);
    if (p) previewTicker(p.ticker);
  }
  static async #onTickerAir(event, target) {
    const p = RevealManager.#preset(target);
    if (p) await toggleTicker(p.id);
  }
  static async #onTickerStop() { await stopTicker(); }

  static async #onExportWebm(event, target) {
    const p = RevealManager.#preset(target);
    if (p) exportRevealWebm({ ...payloadOf(p), name: p.name });
  }

  /** Eksport presetu do pliku JSON (ścieżki obrazów zostają — zadziałają po wgraniu obrazów w to samo miejsce). */
  static async #onExport(event, target) {
    const p = RevealManager.#preset(target);
    if (!p) return;
    const { id, builtin, ...data } = p;
    void id; void builtin;
    foundry.utils.saveDataToFile(JSON.stringify({ module: MODULE_ID, version: 1, ...data }, null, 2), "application/json", `${p.name}.${isTicker(p) ? "news" : "reveal"}.json`);
  }

  /** Import presetu z JSON (nigdy nie rzuca na zepsutym pliku — komunikat). */
  static async #onImport() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const raw = JSON.parse(await file.text());
        if (!raw || typeof raw !== "object" || raw.module !== MODULE_ID) throw new Error(T("Manager.ImportBad"));
        // ścieżki obrazów z obcego pliku: tylko względne (bez schematu i //) — inaczej każdy klient pobierałby cudzy URL (wyciek IP)
        // Parser URL traktuje „\” jak „/” i wycina tabulatory/nowe linie („\\host/x.png”, „/\host”, „/<TAB>/host”) — więc
        // ostatecznie decyduje rozwiązany adres: to samo źródło co Foundry
        const local = (u) => {
          const t = typeof u === "string" ? u.trim() : "";
          if (!t || /^([a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(t)) return "";
          try { return new URL(t, location.href).origin === location.origin ? t : ""; } catch { return ""; }
        };
        const sketch = local(raw.sketch), painted = local(raw.painted);
        const p = await savePreset({ name: raw.name, kind: raw.kind, sketch, painted, config: raw.config, hints: raw.hints, hintsStrict: raw.hintsStrict, ticker: raw.ticker, newspaper: raw.newspaper });
        ui.notifications.info(TE("Manager.Imported", { name: p.name }));
        if ((raw.sketch && !sketch) || (raw.painted && !painted)) ui.notifications.warn(T("Manager.ImportUrls"));
        this.render();
      } catch (e) { ui.notifications.error(TE("Manager.ImportFailed", { error: String(e?.message ?? e) })); }
    });
    input.click();
  }
}

// stan „na antenie” zmienił się (u każdego klienta) → odśwież menedżer (podświetlenie, przycisk nadawania)
Hooks.on("sketchReveal.tickerState", () => RevealManager.instance?.render());

export { BUILTIN_PRESETS };

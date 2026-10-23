/* Aplikacje (ApplicationV2): menedżer presetów (splashe i przejścia) oraz edytor presetu / nadpisań sceny. */
import { MODULE_ID, defaultConfig, deepMerge, sanitizeConfig } from "./config.mjs";
import { exportRevealWebm } from "./export-ui.mjs";
import { optimizeRevealImages, optimizerApi } from "./optimize.mjs";
import { applyShowIf, configFormHtml, readForm } from "./form.mjs";
import { broadcastClose, playSplash, preloadForAll, showSplashToAll } from "./play.mjs";
import { detectLightHints } from "./fx/ai-hints.mjs";
import { BUILTIN_PRESETS, deletePreset, getPreset, listPresets, presetPayload, sceneBackground, sceneFlags, savePreset } from "./store.mjs";
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
  if (!getPreset(presetId)) return ui.notifications.warn(T("Macro.Missing"));
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

/** Makro „pokaż wszystkim” dla presetu (jedno na preset — istniejące jest używane ponownie); przypisuje je do slotu paska. */
export async function createPresetMacro(presetId, slot) {
  const p = getPreset(presetId);
  if (!p) return ui.notifications.warn(T("Macro.Missing"));
  let macro = game.macros.find((m) => m.getFlag(MODULE_ID, "presetId") === presetId);
  const icon = (await makeSquareIcon(presetId, p.painted)) ?? p.painted ?? "icons/svg/clapperboard.svg";
  if (macro && macro.img !== icon) await macro.update({ img: icon }); // stare makra z rozciągniętym obrazem dostają kwadratową ikonę
  if (!macro) {
    macro = await Macro.implementation.create({
      name: p.name, type: "script", img: icon,
      command: `// Sketch Reveal: pokaż preset wszystkim (czeka, aż wszyscy będą gotowi)
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
    actions: { preview: RevealEditor.#onPreview, exportWebm: RevealEditor.#onExportWebm, optimizeImages: RevealEditor.#onOptimize },
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
      this.hints = p.hints ?? []; this.hintsStrict = !!p.hintsStrict;
      this.cfg = sanitizeConfig(p.config);
      this.meta = { name: p.name, kind: p.kind, sketch: p.sketch, painted: p.painted };
    }
  }

  get title() {
    return this.scene ? T("Editor.SceneTitle", { scene: this.scene.name }) : this.presetId ? T("Editor.EditTitle") : T("Editor.NewTitle");
  }

  async _prepareContext() {
    return {
      sceneMode: !!this.scene,
      meta: this.meta,
      kinds: [{ value: "splash", label: T("Kind.splash") }, { value: "transition", label: T("Kind.transition") }],
      configHtml: configFormHtml(this.cfg, this.scene ? "" : this._aiHtml()),
      saveLabel: T("Editor.Save"),
      canOptimize: !this.scene && !!optimizerApi(), // przycisk tylko gdy działa moduł Media Optimizer (Local)
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
    if (!key?.trim()) return ui.notifications.warn(T("AI.NoKey"));
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
    if (data.meta) this.meta = { ...this.meta, ...data.meta };
    const { meta, hintsStrict, ...rest } = data;
    void meta;
    if (hintsStrict !== undefined) this.hintsStrict = !!hintsStrict;
    this.cfg = sanitizeConfig(deepMerge(this.cfg, rest));
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    // zmiana efektu przebudowuje pola parametrów (zachowując resztę formularza)
    this.element.querySelector('select[name="effectId"]')?.addEventListener("change", () => { this._collect(); this.render(); });
    this.element.querySelector('[data-sr="ai-detect"]')?.addEventListener("click", () => this._aiDetect());
    this.element.querySelector('[data-sr="ai-clear"]')?.addEventListener("click", () => { this._collect(); this.hints = []; this.render(); });
    applyShowIf(this.element);
    this.element.onchange = () => applyShowIf(this.element); // pola warunkowe (showIf) wg bieżących wartości
  }

  static async #onPreview() {
    this._collect();
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
      await this.scene.update({ [`${key}.-=override`]: null });
      if (!foundry.utils.isEmpty(diff)) await this.scene.update({ [`${key}.override`]: diff });
      this.scene.sheet?.render();
      return;
    }
    if (!this.meta.name?.trim()) this.meta.name = T("Editor.Unnamed");
    await savePreset({ id: this.presetId, ...this.meta, config: this.cfg, hints: this.hints, hintsStrict: this.hintsStrict });
    RevealManager.instance?.render();
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
    },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/manager.hbs`, scrollable: [".sr-list"] } };

  static open() {
    this.instance ??= new RevealManager();
    return this.instance.render({ force: true });
  }

  async _prepareContext() {
    const presets = listPresets().map((p) => ({ ...p, kindLabel: T(`Kind.${p.kind}`), effectLabel: p.config?.effectId ?? "", isGM: game.user.isGM }));
    return {
      isGM: game.user.isGM,
      presets,
      splashes: presets.filter((p) => p.kind === "splash"),
      transitions: presets.filter((p) => p.kind === "transition"),
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    // przeciągnięcie obrazka presetu na pasek makr tworzy makro „pokaż wszystkim”
    if (!game.user.isGM) return;
    for (const img of this.element.querySelectorAll(".sr-thumb")) {
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
    await deletePreset(p.id);
    this.render();
  }
  static async #onPlayLocal(event, target) {
    const p = RevealManager.#preset(target);
    if (p) playSplash(payloadOf(p));
  }
  static async #onPlayAll(event, target) {
    const p = RevealManager.#preset(target);
    if (p) showSplashToAll(p.id);
  }
  static async #onPreload(event, target) {
    const p = RevealManager.#preset(target);
    if (!p) return;
    await preloadForAll([p.sketch, p.painted]);
    ui.notifications.info(TE("Manager.Preloaded", { name: p.name }));
  }
  static async #onCloseAll() { broadcastClose(); }

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
    foundry.utils.saveDataToFile(JSON.stringify({ module: MODULE_ID, version: 1, ...data }, null, 2), "application/json", `${p.name}.reveal.json`);
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
        const local = (u) => (typeof u === "string" && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(u.trim()) ? u.trim() : "");
        const sketch = local(raw.sketch), painted = local(raw.painted);
        const p = await savePreset({ name: raw.name, kind: raw.kind, sketch, painted, config: raw.config, hints: raw.hints, hintsStrict: raw.hintsStrict });
        ui.notifications.info(TE("Manager.Imported", { name: p.name }));
        if ((raw.sketch && !sketch) || (raw.painted && !painted)) ui.notifications.warn(T("Manager.ImportUrls"));
        this.render();
      } catch (e) { ui.notifications.error(TE("Manager.ImportFailed", { error: String(e?.message ?? e) })); }
    });
    input.click();
  }
}

export { BUILTIN_PRESETS };

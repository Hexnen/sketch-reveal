/* Zakładka „Reveal” w konfiguracji sceny (obok Miscellaneous): wybór presetu, wyzwalacz, własne obrazy i
   nadpisania konfiguracji presetu per scena. Pola `flags.sketch-reveal.*` zapisuje standardowy submit arkusza. */
import { MODULE_ID } from "./config.mjs";
import { RevealEditor } from "./apps.mjs";
import { exportRevealWebm } from "./export-ui.mjs";
import { playSplash } from "./play.mjs";
import { listPresets, resolveScene, sceneBackground, sceneFlags } from "./store.mjs";

const TAB = "sketchreveal";
const T = (k) => game.i18n.localize(`SKETCHREVEAL.${k}`);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

function tabHtml(scene, active) {
  const f = sceneFlags(scene);
  const F = `flags.${MODULE_ID}`;
  const presets = listPresets();
  const opts = [`<option value="">${esc(T("Scene.NoPreset"))}</option>`]
    .concat(presets.map((p) => `<option value="${esc(p.id)}"${p.id === f.presetId ? " selected" : ""}>${esc(p.name)} (${esc(T(`Kind.${p.kind}`))})</option>`)).join("");
  const overrideCount = Object.keys(foundry.utils.flattenObject(f.override ?? {})).length;
  const bg = sceneBackground(scene);
  return `<div class="tab scrollable sketch-reveal-tab${active ? " active" : ""}" data-group="sheet" data-tab="${TAB}">
    <fieldset>
      <legend>${esc(T("Scene.Legend"))}</legend>
      <div class="form-group">
        <label>${esc(T("Scene.Enabled"))}</label>
        <div class="form-fields"><input type="checkbox" name="${F}.enabled"${f.enabled ? " checked" : ""}></div>
        <p class="hint">${esc(T("Scene.EnabledHint"))}</p>
      </div>
      <div class="form-group">
        <label>${esc(T("Scene.Preset"))}</label>
        <div class="form-fields"><select name="${F}.presetId">${opts}</select></div>
      </div>
      <div class="form-group">
        <label>${esc(T("Scene.Trigger"))}</label>
        <div class="form-fields">
          <select name="${F}.trigger">
            <option value="activate"${f.trigger !== "view" ? " selected" : ""}>${esc(T("Trigger.activate"))}</option>
            <option value="view"${f.trigger === "view" ? " selected" : ""}>${esc(T("Trigger.view"))}</option>
          </select>
        </div>
        <p class="hint">${esc(T("Scene.TriggerHint"))}</p>
      </div>
    </fieldset>
    <fieldset>
      <legend>${esc(T("Scene.Images"))}</legend>
      <div class="form-group">
        <label>${esc(T("Field.Sketch"))}</label>
        <div class="form-fields"><file-picker name="${F}.sketch" type="image" value="${esc(f.sketch ?? "")}"></file-picker></div>
        <p class="hint">${esc(T("Scene.SketchHint"))}</p>
      </div>
      <div class="form-group">
        <label>${esc(T("Field.Painted"))}</label>
        <div class="form-fields"><file-picker name="${F}.painted" type="image" value="${esc(f.painted ?? "")}"></file-picker></div>
        <p class="hint">${esc(bg ? T("Scene.PaintedHint") : T("Scene.PaintedHintNoBg"))}</p>
      </div>
    </fieldset>
    <fieldset>
      <legend>${esc(T("Scene.Overrides"))}</legend>
      <p class="hint">${esc(T("Scene.OverridesHint"))} <strong>${overrideCount ? `(${overrideCount})` : ""}</strong></p>
      <div class="form-group">
        <div class="form-fields sr-scene-buttons">
          <button type="button" data-sr="edit"><i class="fa-solid fa-sliders"></i> ${esc(T("Scene.EditOverrides"))}</button>
          <button type="button" data-sr="reset"${overrideCount ? "" : " disabled"}><i class="fa-solid fa-rotate-left"></i> ${esc(T("Scene.ResetOverrides"))}</button>
          <button type="button" data-sr="preview"><i class="fa-solid fa-play"></i> ${esc(T("Scene.Preview"))}</button>
          <button type="button" data-sr="webm"><i class="fa-solid fa-film"></i> ${esc(T("Export.Button"))}</button>
        </div>
      </div>
    </fieldset>
  </div>`;
}

/** Hook `renderSceneConfig`: wstrzyknij zakładkę (idempotentnie — częściowe renderery nie dublują). */
export function onRenderSceneConfig(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || !game.user.isGM) return;
  const nav = root.querySelector("nav.sheet-tabs, nav.tabs");
  if (!nav || root.querySelector(`.tab[data-tab="${TAB}"]`)) return;
  const active = app.tabGroups?.sheet === TAB;

  const link = document.createElement("a");
  link.dataset.action = "tab"; link.dataset.group = "sheet"; link.dataset.tab = TAB;
  if (active) link.classList.add("active");
  link.innerHTML = `<i class="fa-solid fa-paintbrush" inert></i><span>${esc(T("Scene.Tab"))}</span>`;
  const misc = nav.querySelector('[data-tab="misc"]');
  if (misc) misc.after(link); else nav.append(link);

  const tmp = document.createElement("div");
  tmp.innerHTML = tabHtml(app.document, active);
  const tab = tmp.firstElementChild;
  const miscTab = root.querySelector('.tab[data-tab="misc"]');
  if (miscTab) miscTab.after(tab); else (root.querySelector("footer") ?? root).before(tab);

  tab.querySelector('[data-sr="edit"]').addEventListener("click", () => {
    if (!sceneFlags(app.document).presetId) return ui.notifications.warn(T("Scene.PickPreset"));
    new RevealEditor({ scene: app.document }).render({ force: true });
  });
  tab.querySelector('[data-sr="reset"]').addEventListener("click", async () => {
    await app.document.update({ [`flags.${MODULE_ID}.-=override`]: null });
    app.render();
  });
  tab.querySelector('[data-sr="webm"]').addEventListener("click", () => {
    const r = resolveScene(app.document);
    if (!r) return ui.notifications.warn(T("Scene.NothingToPreview"));
    exportRevealWebm({ sketchUrl: r.sketchUrl, paintedUrl: r.paintedUrl, config: r.config, hints: r.hints, hintsStrict: r.hintsStrict, name: app.document.name });
  });
  tab.querySelector('[data-sr="preview"]').addEventListener("click", () => {
    const r = resolveScene(app.document);
    if (!r) return ui.notifications.warn(T("Scene.NothingToPreview"));
    playSplash({ sketchUrl: r.sketchUrl, paintedUrl: r.paintedUrl, config: r.config, hints: r.hints, hintsStrict: r.hintsStrict });
  });
}

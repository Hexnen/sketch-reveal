/* Zakładka „Reveal” w konfiguracji sceny (obok Miscellaneous): wybór presetu, wyzwalacz, własne obrazy i
   nadpisania konfiguracji presetu per scena. Pola `flags.sketch-reveal.*` zapisuje standardowy submit arkusza. */
import { MODULE_ID } from "./config.mjs";
import { RevealEditor } from "./apps.mjs";
import { exportRevealWebm } from "./export-ui.mjs";
import { playSplash } from "./play.mjs";
import { aiApi, aiBusy, aiGeneratePainted, aiGenerateSketch, aiGuard } from "./ai-image.mjs";
import { getPreset, listPresets, resolveScene, sceneBackground, sceneFlags } from "./store.mjs";

const TAB = "sketchreveal";
const T = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const aiKey = (scene) => `scene:${scene.id}`;

function tabHtml(scene, active) {
  const f = sceneFlags(scene);
  const F = `flags.${MODULE_ID}`;
  const presets = listPresets();
  // preset usunięty/niedostępny: zaznacz osobną opcję, żeby zapis sceny nie wyczyścił po cichu powiązania
  const missing = f.presetId && !getPreset(f.presetId)
    ? [`<option value="${esc(f.presetId)}" selected>${esc(T("Scene.MissingPreset"))}: ${esc(f.presetId)}</option>`] : [];
  const opts = [`<option value="">${esc(T("Scene.NoPreset"))}</option>`, ...missing]
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
      ${aiApi() ? `<div class="form-group sr-ai-gen">
        <label>${esc(T("AIGen.Label"))}</label>
        <div class="form-fields sr-scene-buttons">
          <button type="button" data-sr="ai-painted"${aiBusy(aiKey(scene)) ? " disabled" : ""}><i class="fa-solid fa-wand-magic-sparkles"></i> ${esc(T("AIGen.Painted"))}</button>
          <button type="button" data-sr="ai-sketch"${aiBusy(aiKey(scene)) ? " disabled" : ""}><i class="fa-solid fa-pencil"></i> ${esc(T("AIGen.Sketch"))}</button>
        </div>
        <p class="hint">${esc(T("AIGen.Hint"))}</p>
      </div>` : ""}
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
  if (!nav) return;
  // pełny re-render podmienia nav (część `tabs`), a treść zakładki jest rodzeństwem części `misc` i przeżywa — zawsze
  // usuń starą wersję i wstrzyknij od nowa ze świeżych flag (inaczej znika link, a zostaje nieaktualna treść)
  root.querySelectorAll(`.sketch-reveal-tab, [data-tab="${TAB}"]`).forEach((el) => el.remove());
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

  // AI Image Gen (opcjonalnie): wynik wpisuje się w pola formularza sceny (zapisuje je zwykły „Zapisz” arkusza). Pola szukamy
  // w ŻYWYM arkuszu po zakończeniu generacji: przerysowanie sceny w trakcie podmienia zakładkę, a zamknięty arkusz dostaje flagę wprost.
  const liveTab = () => app.element?.querySelector(".sketch-reveal-tab");
  const liveField = (n) => liveTab()?.querySelector(`file-picker[name="flags.${MODULE_ID}.${n}"]`);
  const setAiButtons = (on) => app.element?.querySelectorAll('.sketch-reveal-tab [data-sr="ai-painted"], .sketch-reveal-tab [data-sr="ai-sketch"]').forEach((b) => { b.disabled = on; });
  const apply = async (n, path) => {
    const el = app.rendered ? liveField(n) : null;
    if (el) { el.value = path; el.dispatchEvent(new Event("change", { bubbles: true })); return; }
    await app.document.setFlag(MODULE_ID, n, path); // arkusz zamknięty w trakcie generacji: opłacony obraz nie ginie
    ui.notifications.info(T("AIGen.AppliedScene", { path: esc(path) }));
  };
  tab.querySelector('[data-sr="ai-painted"]')?.addEventListener("click", () => aiGuard(aiKey(app.document), async (controller) => {
    const path = await aiGeneratePainted({ name: app.document.name, background: sceneBackground(app.document), current: liveField("painted")?.value, controller });
    if (path) await apply("painted", path);
  }, setAiButtons));
  tab.querySelector('[data-sr="ai-sketch"]')?.addEventListener("click", () => aiGuard(aiKey(app.document), async (controller) => {
    // preset z formularza (niezapisana zmiana też się liczy), nie ten zapisany w scenie
    const presetId = liveTab()?.querySelector(`select[name="flags.${MODULE_ID}.presetId"]`)?.value ?? sceneFlags(app.document).presetId;
    const painted = liveField("painted")?.value || getPreset(presetId)?.painted || sceneBackground(app.document);
    const path = await aiGenerateSketch({ name: app.document.name, painted, controller });
    if (path) await apply("sketch", path);
  }, setAiButtons));

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

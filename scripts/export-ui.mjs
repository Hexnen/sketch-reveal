/* Interfejs eksportu WebM: okno opcji (rozdzielczość / klatkaż / jakość), nakładka z postępem i anulowaniem.
   Eksport jest OFFLINE (klatka po klatce) na osobnym, niewidocznym odtwarzaczu — nie zależy od szybkości komputera. */
import { MODULE_ID, sanitizeConfig } from "./config.mjs";
import * as X from "./fx/export.mjs";
import { RevealPlayer } from "./player.mjs";

const T = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const KEY = "export-options";

function loadOpts() {
  try { return { ...X.DEFAULT_EXPORT, ...JSON.parse(localStorage.getItem(`${MODULE_ID}.${KEY}`) || "{}") }; } catch { return { ...X.DEFAULT_EXPORT }; }
}
const saveOpts = (o) => { try { localStorage.setItem(`${MODULE_ID}.${KEY}`, JSON.stringify(o)); } catch { /* prywatne okno */ } };

const options = (list, cur) => list.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(cur) ? " selected" : ""}>${esc(o.label)}</option>`).join("");

/** Pyta o opcje; zwraca {res,fps,quality} albo null (anulowano). */
async function askOptions() {
  const o = loadOpts();
  const content = `<form class="sr-export-form standard-form">
    <div class="form-group"><label>${T("Export.Res")}</label><div class="form-fields"><select name="res">${options(X.EXPORT_RES, o.res)}</select></div></div>
    <div class="form-group"><label>${T("Export.Fps")}</label><div class="form-fields"><select name="fps">${options(X.EXPORT_FPS, o.fps)}</select></div></div>
    <div class="form-group"><label>${T("Export.Quality")}</label><div class="form-fields"><select name="quality">${options(X.EXPORT_QUALITY, o.quality)}</select></div></div>
    <p class="hint">${T("Export.Hint")}</p></form>`;
  const r = await foundry.applications.api.DialogV2.prompt({
    window: { title: T("Export.Title"), icon: "fa-solid fa-film" }, content, rejectClose: false,
    ok: { label: T("Export.Start"), icon: "fa-solid fa-download", callback: (ev, btn) => new foundry.applications.ux.FormDataExtended(btn.form).object },
  });
  if (!r) return null;
  const opts = { res: r.res, fps: Number(r.fps), quality: r.quality };
  saveOpts(opts);
  return opts;
}

/**
 * Eksportuje reveal do pliku WebM.
 * @param {{sketchUrl:string, paintedUrl:string, config:object, hints?:object[]|null, hintsStrict?:boolean, name?:string}} payload
 */
export async function exportRevealWebm(payload) {
  if (!X.supported()) return ui.notifications.error(T("Export.Unsupported"));
  if (!payload.sketchUrl || !payload.paintedUrl) return ui.notifications.warn(T("Editor.NeedImages"));
  const opts = await askOptions();
  if (!opts) return;

  // niewidoczny odtwarzacz o rozmiarze obrazu (układ ramki wymaga rozmiaru kontenera)
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;width:1920px;height:1080px;overflow:hidden;pointer-events:none;";
  document.body.append(host);
  const overlay = document.createElement("div");
  overlay.className = "sketch-reveal-overlay sr-export-progress";
  overlay.innerHTML = `<div class="sr-export-box"><h3>${esc(T("Export.Working"))}</h3><progress max="1" value="0"></progress><p class="sr-export-pct">0%</p>
    <button type="button"><i class="fa-solid fa-xmark"></i> ${esc(T("Export.Cancel"))}</button></div>`;
  document.body.append(overlay);
  const bar = overlay.querySelector("progress"), pct = overlay.querySelector(".sr-export-pct");
  const ac = new AbortController();
  overlay.querySelector("button").addEventListener("click", () => ac.abort());
  overlay.style.cursor = "default";

  const player = new RevealPlayer({
    container: host, sketchUrl: payload.sketchUrl, paintedUrl: payload.paintedUrl, config: sanitizeConfig(payload.config),
    fit: "contain", hints: payload.hints ?? null, hintsStrict: !!payload.hintsStrict,
  });
  try {
    pct.textContent = T("Export.Preparing");
    await player.prepare();
    const blob = await X.exportWebm({
      player, options: opts, signal: ac.signal,
      onProgress: (f) => { bar.value = f; pct.textContent = `${Math.round(f * 100)}%`; },
    });
    const base = (payload.name || "reveal").replace(/[^\p{L}\p{N}._-]+/gu, "_");
    X.downloadBlob(blob, `${base}.webm`);
    ui.notifications.info(T("Export.Done", { size: (blob.size / 1048576).toFixed(1) }));
  } catch (e) {
    if (e?.name === "AbortError") ui.notifications.info(T("Export.Cancelled"));
    else { console.error(`${MODULE_ID} | eksport`, e); ui.notifications.error(T("Export.Failed", { error: e?.message ?? e })); }
  } finally {
    player.dispose(); host.remove(); overlay.remove();
  }
}

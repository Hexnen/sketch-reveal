/* Integracja z modułem „AI Image Gen” (ai-image-gen): opcjonalna — bez niego przyciski się nie pokazują.
   Splash/przejście potrzebuje PARY obrazów o tym samym kadrze: malunku i szkicu. Moduł AI generuje malunek (z opisu,
   opcjonalnie z tłem sceny jako referencją) oraz szkic jako edycję malunku (malunek jest wtedy referencją, więc kompozycja
   i proporcje się zgadzają). Wywołania idą przez publiczne API ai-image-gen (limity budżetu, log, wybór wersji, klucze API
   i modele są tam), tu zostaje tylko dialog, rozmiary i wpisanie ścieżki w preset/scenę. Nic nie jest zapisywane bez wyboru. */
import { MODULE_ID } from "./config.mjs";

const AI_ID = "ai-image-gen";
export const TYPE_PAINTED = "sketch-reveal.painted";
export const TYPE_SKETCH = "sketch-reveal.sketch";
// Te same limity co „Zoptymalizuj obrazy” (optimize.mjs): tekstura w odtwarzaczu ma ≤ 4096 px; szkic: linie → wysoka jakość.
const MAX_EDGE = 4096;
const QUALITY = { painted: 0.88, sketch: 0.95 };
const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|bmp)(\?.*)?$/i;

const T = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** Surowe API ai-image-gen (moduł aktywny, GM, wersja API ≥ 1 i wszystkie funkcje, których używamy) albo null. */
function rawApi() {
  if (!game.user?.isGM) return null;
  const m = game.modules.get(AI_ID);
  const api = m?.active ? m.api : null;
  if (!api || !(Number(api.apiVersion) >= 1)) return null;
  return ["generateImage", "estimateGeneration", "registerImageType"].every((f) => typeof api[f] === "function") ? api : null;
}

let typesRegistered = false;

/** API ai-image-gen albo null (moduł nieobecny/nieaktywny/za stary, brak GM-a albo nasze typy nie zostały zarejestrowane). */
export function aiApi() {
  const api = rawApi();
  return api && typesRegistered ? api : null;
}

/** Zarejestruj nasze typy w ai-image-gen (okno konfiguracji pokaże grupę „Sketch Reveal”). Idempotentne. */
export function registerAiTypes(api = rawApi()) {
  typesRegistered = false;
  if (!api) return false;
  const group = "Sketch Reveal";
  try {
    api.registerImageType({
      key: TYPE_PAINTED, label: T("AIGen.TypePainted"), group, owner: MODULE_ID,
      defaults: { promptTemplate: "{description}", width: 1536, height: 1024, quality: "medium", output: { maxEdge: 0, format: "webp", quality: QUALITY.painted } }
    });
    api.registerImageType({
      key: TYPE_SKETCH, label: T("AIGen.TypeSketch"), group, owner: MODULE_ID, requiresRef: true,
      defaults: {
        promptTemplate: "Redraw the reference image as a clean pencil-and-ink line sketch on plain white paper. Keep exactly the same composition, framing, proportions and the position of every object. No color, no text, no border. {description}",
        width: 1536, height: 1024, quality: "high", output: { maxEdge: 0, format: "webp", quality: QUALITY.sketch }
      }
    });
    typesRegistered = true;
  } catch (e) {
    console.warn(`${MODULE_ID} | rejestracja typów w ${AI_ID} nie powiodła się`, e);
  }
  return typesRegistered;
}

/* Jedna generacja naraz na okno (klucz: scena albo edytor); stan przeżywa re-render, bo budują go z `aiBusy`. */
const busy = new Map(); // key -> AbortController
export const aiBusy = (key) => busy.has(key);

/**
 * Uruchom `fn(controller, release)` pod kluczem okna: druga generacja w tym samym oknie jest ignorowana (zwraca null),
 * a `onState(true/false)` pozwala wyłączyć/włączyć oba przyciski AI. `release()` zwalnia blokadę wcześniej (idempotentnie) —
 * potrzebne, gdy po generacji okno jest przerysowywane: kontekst renderu nie może jeszcze widzieć „zajęte”.
 */
export async function aiGuard(key, fn, onState) {
  if (busy.has(key)) return null;
  const controller = new AbortController();
  busy.set(key, controller);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    busy.delete(key);
    try { onState?.(false); } catch { /* okno mogło zniknąć */ }
  };
  try { onState?.(true); } catch { /* okno mogło zniknąć */ }
  try { return await fn(controller, release); }
  finally { release(); }
}

/** Naturalny rozmiar obrazu z adresu (null, gdy się nie da pobrać/zdekodować). */
async function imageSize(url) {
  try {
    const res = await fetch(foundry.utils.getRoute(url));
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const size = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return size.w > 0 && size.h > 0 ? size : null;
  } catch { return null; }
}

const isImage = (url) => !!url && IMAGE_EXT.test(String(url));
const dirImages = () => `worlds/${game.world.id}/${MODULE_ID}/images`;
export const stem = (s) => (String(s ?? "").replace(/ł/g, "l").replace(/Ł/g, "L").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "reveal");

/**
 * Dialog przed startem: opis, liczba wersji, (malunek) czy użyć tła sceny jako referencji, szacowany koszt.
 * @param {number|null} fixedRefs  stała liczba referencji w szacunku (szkic zawsze ma 1: malunek); null = zależnie od tła
 * @returns {Promise<{description:string, count:number, useBackground:boolean}|null>} null = anulowano
 */
async function ask({ api, typeKey, title, descLabel, descRequired, placeholder, background, aspect, fixedRefs = null }) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const estimate = (count, useBg) => api.estimateGeneration({ typeKey, count, refsCount: fixedRefs ?? (useBg ? 1 : 0), ...(aspect ? { aspectRatio: aspect } : {}) });
  const first = estimate(1, !!background);
  const uid = foundry.utils.randomID?.(6) ?? Math.random().toString(36).slice(2, 8);
  const content = `<div class="sr-ai-dialog">
    <div class="form-group stacked"><label for="sr-ai-desc-${uid}">${esc(descLabel)}</label>
      <textarea id="sr-ai-desc-${uid}" name="description" rows="3" placeholder="${esc(placeholder)}"></textarea></div>
    ${background ? `<div class="form-group"><label class="checkbox"><input type="checkbox" name="useBackground" checked> ${esc(T("AIGen.UseBackground"))}</label></div>` : ""}
    <div class="form-group"><label for="sr-ai-count-${uid}">${esc(T("AIGen.Versions"))}</label>
      <div class="form-fields"><input id="sr-ai-count-${uid}" type="number" name="count" value="1" min="1" max="8" step="1"></div></div>
    <p class="hint sr-ai-estimate" data-role="estimate" role="status" aria-live="polite"></p>
    <p class="notes warning sr-ai-warn" data-role="warn" role="status" aria-live="polite" hidden></p>
  </div>`;
  // DialogV2 is itself a <form>; a nested <form> would be dropped by the parser
  const formOf = (root) => (root.tagName === "FORM" ? root : root.querySelector("form"));
  const paint = (root) => {
    const f = formOf(root);
    const count = Math.min(8, Math.max(1, Math.floor(Number(f.elements.count.value)) || 1));
    const useBg = !!f.elements.useBackground?.checked;
    let est = first;
    try { est = estimate(count, useBg); } catch { /* zostaje pierwszy szacunek */ }
    root.querySelector('[data-role="estimate"]').textContent = T("AIGen.Estimate", { cost: Number(est.cost).toFixed(3), model: est.modelLabel, w: est.width, h: est.height });
    const warn = root.querySelector('[data-role="warn"]');
    warn.hidden = est.hasKey;
    warn.textContent = est.hasKey ? "" : T("AIGen.NoKey", { provider: est.providerLabel });
    const go = root.querySelector('button[data-action="go"]');
    if (go) go.disabled = !est.hasKey || (descRequired && !String(f.elements.description.value ?? "").trim());
  };
  return DialogV2.wait({
    window: { title, icon: "fa-solid fa-wand-magic-sparkles" },
    content,
    rejectClose: false,
    render: (event, dialog) => {
      const root = dialog.element;
      formOf(root).addEventListener("input", () => paint(root));
      paint(root);
    },
    buttons: [
      {
        action: "go", label: T("AIGen.Go"), icon: "fa-solid fa-wand-magic-sparkles", default: true,
        callback: (event, button) => {
          // „Generate” jest wyłączone przy pustym wymaganym opisie (więc to tylko zabezpieczenie): traktuj jak anulowanie
          const f = button.form.elements;
          const description = String(f.description.value ?? "").trim();
          if (descRequired && !description) return null;
          return { description, count: Math.min(8, Math.max(1, Math.floor(Number(f.count.value)) || 1)), useBackground: !!f.useBackground?.checked };
        }
      },
      { action: "cancel", label: T("AIGen.Cancel"), icon: "fa-solid fa-xmark" }
    ]
  }).then((r) => (r && typeof r === "object" ? r : null));
}

/** Jedno miejsce statusu: błąd generacji/estymacji (anulowanie jest ciche). */
function reportError(e) {
  if (e?.cancelled || e?.name === "AbortError") return;
  console.error(`${MODULE_ID} | generowanie AI`, e);
  ui.notifications.error(T("AIGen.Failed", { error: esc(e?.message ?? e) }), { console: false });
}

/**
 * Okienko „Generuję…” z przyciskiem Anuluj (jedyny wskaźnik postępu). Znika samo, gdy ai-image-gen otworzy okno wyboru wersji.
 * @returns {() => void} zamknięcie okienka
 */
function showProgress(title, controller) {
  let finished = false, dlg = null, hook = null;
  const stop = () => {
    finished = true;
    if (hook !== null) { Hooks.off("renderApplicationV2", hook); hook = null; }
    try { dlg?.close({ animate: false }); } catch { /* już zamknięte */ }
    dlg = null;
  };
  try {
    const DialogV2 = foundry.applications.api.DialogV2;
    dlg = new DialogV2({
      window: { title, icon: "fa-solid fa-wand-magic-sparkles" },
      content: `<p class="sr-ai-progress" role="status" aria-live="polite"><i class="fa-solid fa-spinner fa-spin-pulse"></i> ${esc(T("AIGen.Working"))}</p>`,
      buttons: [{ action: "cancel", label: T("AIGen.Cancel"), icon: "fa-solid fa-xmark", callback: () => { controller.abort(); } }],
      close: () => { if (!finished) controller.abort(); } // X w nagłówku = anuluj
    });
    dlg.render({ force: true });
    hook = Hooks.on("renderApplicationV2", (app) => { if (app?.options?.classes?.includes("aiimg-pick")) stop(); });
  } catch (e) { console.warn(`${MODULE_ID} | okienko postępu`, e); }
  return stop;
}

async function run(api, opts, controller = new AbortController()) {
  const stop = showProgress(T("AIGen.TitleWorking"), controller);
  try {
    const r = await api.generateImage({ ...opts, caller: MODULE_ID, pick: true, signal: controller.signal, saveTo: { dir: dirImages(), name: opts.saveName } });
    return r.path;
  } catch (e) {
    reportError(e);
    return null;
  } finally { stop(); }
}

/** Ostrzeż (raz), gdy proporcji obrazu nie da się odczytać, a miał być źródłem proporcji. */
function warnAspect(src, dims) {
  if (src && !dims) ui.notifications.warn(T("AIGen.AspectUnknown"));
}

/**
 * „Wygeneruj malunek (AI)”.
 * @param {object} o
 * @param {string} o.name         nazwa presetu/sceny (nazwa pliku, tytuł okna)
 * @param {string} [o.background] tło sceny (referencja, gdy to obraz)
 * @param {string} [o.current]    obecny malunek (proporcje, gdy brak tła)
 * @param {AbortController} [o.controller]  z aiGuard (anulowanie z okienka postępu)
 * @returns {Promise<string|null>} ścieżka zapisanego obrazu albo null (anulowano/błąd — błąd pokazany)
 */
export async function aiGeneratePainted({ name, background, current, controller } = {}) {
  const api = aiApi();
  if (!api) return null;
  const bg = isImage(background) ? background : null;
  const sizeSrc = bg || (isImage(current) ? current : null);
  const dims = sizeSrc ? await imageSize(sizeSrc) : null;
  warnAspect(sizeSrc, dims);
  const aspect = dims ? dims.w / dims.h : null;
  let answer;
  try {
    answer = await ask({
      api, typeKey: TYPE_PAINTED, title: T("AIGen.TitlePainted"), descLabel: T("AIGen.DescPainted"), descRequired: true,
      placeholder: T("AIGen.PlaceholderPainted"), background: bg, aspect
    });
  } catch (e) { reportError(e); return null; }
  if (!answer) return null;
  return run(api, {
    typeKey: TYPE_PAINTED, description: answer.description, name, saveName: `${stem(name)}-painted`,
    refs: answer.useBackground && bg ? [bg] : [], count: answer.count, ...(aspect ? { aspectRatio: aspect } : {}),
    output: { maxEdge: MAX_EDGE, quality: QUALITY.painted, format: "webp" }, title: T("AIGen.PickPainted", { name })
  }, controller);
}

/**
 * „Szkic z malunku (AI)”: szkic jako edycja malunku (ta sama kompozycja i proporcje).
 * @param {object} o
 * @param {string} o.name
 * @param {string} o.painted  malunek (preset / scena / tło)
 * @param {AbortController} [o.controller]
 */
export async function aiGenerateSketch({ name, painted, controller } = {}) {
  const api = aiApi();
  if (!api) return null;
  if (!isImage(painted)) { ui.notifications.warn(T("AIGen.NeedPainted")); return null; }
  const dims = await imageSize(painted);
  warnAspect(painted, dims);
  const aspect = dims ? dims.w / dims.h : null;
  let answer;
  try {
    answer = await ask({
      api, typeKey: TYPE_SKETCH, title: T("AIGen.TitleSketch"), descLabel: T("AIGen.DescSketch"), descRequired: false,
      placeholder: T("AIGen.PlaceholderSketch"), background: null, aspect, fixedRefs: 1
    });
  } catch (e) { reportError(e); return null; }
  if (!answer) return null;
  return run(api, {
    typeKey: TYPE_SKETCH, description: answer.description, name, saveName: `${stem(name)}-sketch`,
    refs: [painted], count: answer.count, ...(aspect ? { aspectRatio: aspect } : {}),
    output: { maxEdge: MAX_EDGE, quality: QUALITY.sketch, format: "webp" }, title: T("AIGen.PickSketch", { name })
  }, controller);
}

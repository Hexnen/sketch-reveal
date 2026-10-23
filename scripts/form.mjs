/* Generator formularza konfiguracji reveal (HTML) + parser formularza → rzadki obiekt konfiguracji.
   Używany przez edytor presetu i edytor nadpisań sceny. Nazwy pól = ścieżki w konfiguracji ("intro.params.order").
   Sekcje fx (napis, kamera, ślad szkicu, rozbłysk) są opisane własnymi *_FIELDS i renderowane generycznie. */
import * as Core from "../vendor/reveal-core.js";
import { SWAY_FIELDS, ZOOM_FIELDS } from "./fx/camera.mjs";
import { GLOW_FIELDS } from "./fx/glow.mjs";
import { RESIDUE_FIELD } from "./fx/residue.mjs";
import { TITLE_FIELDS } from "./fx/title.mjs";

const L = (k) => game.i18n.localize(`SKETCHREVEAL.${k}`);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);

function group(label, inner, hint = "", extra = "") {
  return `<div class="form-group"${extra}><label>${esc(label)}</label><div class="form-fields">${inner}</div>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</div>`;
}
const slider = (name, v, min, max, step) => `<range-picker name="${name}" value="${v}" min="${min}" max="${max}" step="${step}"></range-picker>`;
const check = (name, v) => `<input type="checkbox" name="${name}"${v ? " checked" : ""}>`;
const text = (name, v, ph = "") => `<input type="text" name="${name}" value="${esc(v)}" placeholder="${esc(ph)}">`;
const color = (name, v) => `<input type="color" name="${name}" value="${esc(v)}">`;
const select = (name, v, opts) =>
  `<select name="${name}">${opts.map(([val, lab]) => `<option value="${esc(val)}"${String(val) === String(v) ? " selected" : ""}>${esc(lab)}</option>`).join("")}</select>`;

const PAPER_KEYS = new Set(Object.keys(Core.PAPER_DEFAULTS));

/* ---------------------------------------------------------------- generyczny renderer pól fx */
function fieldInput(name, f, v) {
  switch (f.type) {
    case "range": return slider(name, v, f.min, f.max, f.step);
    case "select": return select(name, v, f.options);
    case "check": return check(name, v);
    case "color": return color(name, v);
    default: return text(name, v, f.placeholder);
  }
}

/** `showIf`: "klucz" (pole rodzeństwa prawdziwe) albo {key, is|not}. Atrybuty czyta applyShowIf(). */
function showAttrs(prefix, f) {
  if (!f.showIf) return "";
  const s = typeof f.showIf === "string" ? { key: f.showIf } : f.showIf;
  return ` data-showif="${esc(`${prefix}${s.key}`)}"${s.is !== undefined ? ` data-showif-is="${esc(s.is)}"` : ""}${s.not !== undefined ? ` data-showif-not="${esc(s.not)}"` : ""}`;
}

/** Pola `fields` obiektu `values` pod nazwami `${prefix}${key}`; pola `advanced` w zwijanym bloku. */
export function fieldsHtml(prefix, fields, values) {
  const row = (f) => {
    const name = `${prefix}${f.key}`;
    return group(f.label + (f.unit ? ` (${f.unit.trim()})` : ""), fieldInput(name, f, get(values, f.key) ?? f.detectDefault), f.hint, showAttrs(prefix, f));
  };
  const basic = fields.filter((f) => !f.advanced).map(row).join("");
  const adv = fields.filter((f) => f.advanced).map(row).join("");
  return basic + (adv ? `<details class="sr-adv"><summary>${esc(L("Section.Advanced"))}</summary>${adv}</details>` : "");
}

/** Pokaż/ukryj pola z `data-showif` wg bieżących wartości formularza (wołać po renderze i przy zmianie pól). */
export function applyShowIf(root) {
  for (const el of root.querySelectorAll("[data-showif]")) {
    const src = root.querySelector(`[name="${el.dataset.showif}"]`);
    if (!src) continue;
    const val = src.type === "checkbox" ? src.checked : src.value;
    let show = el.dataset.showifIs !== undefined ? String(val) === el.dataset.showifIs
      : el.dataset.showifNot !== undefined ? String(val) !== el.dataset.showifNot : !!val;
    el.hidden = !show;
  }
}

/* ---------------------------------------------------------------- efekt koloru */
function effectFields(cfg) {
  const eff = Core.getEffect(cfg.effectId);
  const cur = { ...eff.defaultParams, ...(cfg.effectParams[eff.id] ?? {}) };
  const base = `effectParams.${eff.id}`;
  const rows = eff.paramSpecs.filter((s) => !PAPER_KEYS.has(s.key)).map((s) => group(s.label, slider(`${base}.${s.key}`, cur[s.key], s.min, s.max, s.step), s.hint));
  for (const c of eff.choiceSpecs ?? []) rows.push(group(c.label, select(`${base}.${c.key}`, cur[c.key], c.options.map((o) => [o, o]))));
  return rows.join("");
}

/** HTML wszystkich sekcji konfiguracji. `extraSections` — dodatkowe fieldsety (np. rozbłysk) wstawiane przed „Zakończenie”. */
export function configFormHtml(cfg, extraSections = "") {
  const eff = select("effectId", cfg.effectId, Core.EFFECTS.map((e) => [e.id, e.label]));
  const i = cfg.intro, ip = i.params, p = cfg.paper;
  return `
  <fieldset><legend>${L("Section.Effect")}</legend>
    ${group(L("Field.Effect"), eff)}
    <div class="sr-effect-fields">${effectFields(cfg)}</div>
  </fieldset>
  <fieldset><legend>${L("Section.Intro")}</legend>
    ${group(L("Field.IntroEnabled"), check("intro.enabled", i.enabled), L("Hint.Intro"))}
    ${group(L("Field.IntroSeconds"), slider("intro.seconds", i.seconds, 0.5, 30, 0.5))}
    ${group(L("Field.IntroColorAt"), slider("intro.colorAt", i.colorAt, 0, 100, 5), L("Hint.ColorAt"))}
    ${group(L("Field.IntroOrder"), select("intro.params.order", ip.order, Core.SKETCH_INTRO_ORDERS.map((o) => [o.value, o.label])))}
    ${group(L("Field.IntroPen"), check("intro.params.pen", ip.pen))}
    ${Core.SKETCH_INTRO_PARAM_SPECS.map((s) => group(s.label, slider(`intro.params.${s.key}`, ip[s.key], s.min, s.max, s.step), s.hint)).join("")}
  </fieldset>
  <fieldset><legend>${L("Section.Paper")}</legend>
    ${group(L("Field.PaperOn"), check("paper.paper", p.paper))}
    ${group(L("Field.PaperColor"), color("paper.paperColor", p.paperColor))}
    ${Core.PAPER_PARAM_SPECS.map((s) => group(s.label, slider(`paper.${s.key}`, p[s.key], s.min, s.max, s.step), s.hint)).join("")}
    ${group(L("Field.PaperExtend"), check("paper.paperExtend", p.paperExtend))}
  </fieldset>
  <fieldset><legend>${L("Section.Camera")}</legend>
    ${fieldsHtml("zoom.", ZOOM_FIELDS, cfg.zoom)}
    <hr>
    ${fieldsHtml("sway.", SWAY_FIELDS, cfg.sway)}
  </fieldset>
  <fieldset><legend>${L("Section.Residue")}</legend>
    ${fieldsHtml("", [RESIDUE_FIELD], cfg)}
  </fieldset>
  <fieldset><legend>${L("Section.Title")}</legend>
    ${fieldsHtml("title.", TITLE_FIELDS, cfg.title)}
  </fieldset>
  <fieldset><legend>${L("Section.Glow")}</legend>
    ${fieldsHtml("glow.", GLOW_FIELDS.filter((x) => x.group !== "detect"), cfg.glow)}
    <details class="sr-adv"><summary>${esc(L("Section.Detect"))}</summary>
      ${fieldsHtml("glow.", GLOW_FIELDS.filter((x) => x.group === "detect").map((x) => ({ ...x, advanced: false })), cfg.glow)}
    </details>
    ${extraSections}
  </fieldset>
  <fieldset><legend>${L("Section.Ending")}</legend>
    ${group(L("Field.HoldSec"), slider("holdSec", cfg.holdSec, 0, 20, 0.5), L("Hint.Hold"))}
    ${group(L("Field.PlayerSkip"), check("playerSkip", cfg.playerSkip), L("Hint.PlayerSkip"))}
    ${group(L("Field.FadeSec"), slider("fadeSec", cfg.fadeSec, 0, 6, 0.1), L("Hint.Fade"))}
  </fieldset>`;
}

/** Formularz → rzadki obiekt (tylko pola obecne w formularzu), do deepMerge z bieżącą konfiguracją. */
export function readForm(form) {
  const data = new foundry.applications.ux.FormDataExtended(form).object;
  return foundry.utils.expandObject(data);
}

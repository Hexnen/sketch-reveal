/* Pasek wiadomości w Foundry: stan „na antenie” (ustawienie świata — zapis tylko GM, onChange u wszystkich klientów,
   także u spóźnionych po przeładowaniu), aktualizacje listy na żywo (zapis presetu → Hooks "sketchReveal.presets"),
   układ względem UI v14 (kolumna narzędzi z lewej, pasek boczny z prawej, pasek makr na dole). Silnik: fx/ticker.mjs. */
import { MODULE_ID } from "./config.mjs";
import { NewsBar, avoidBottomUi, bottomObstacles, estimatePassMs, prefersReducedMotion, sanitizeTicker } from "./fx/ticker.mjs";
import { getPreset, isTicker } from "./store.mjs";

const T = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
const STATE = "tickerState";
const LAYOUT_MS = 700;

let bar = null;          // bieżący pasek (na antenie albo podgląd)
let barKey = null;       // id stanu na antenie albo "preview"
let barPresetId = null;
let chain = Promise.resolve(); // zmiany stanu po kolei: stary pasek schodzi, zanim wejdzie nowy
let layoutTimer = 0, limitTimer = 0, dutyTimers = [];

/* ---------------------------------------------------------------- stan świata */
export function registerTickerState() {
  game.settings.register(MODULE_ID, STATE, { scope: "world", config: false, type: Object, default: {}, onChange: (v) => onState(v) });
}

const readState = () => { try { return game.settings.get(MODULE_ID, STATE) ?? {}; } catch { return {}; } };
/** Id presetu, który jest teraz na antenie (albo null). */
export function onAirPresetId() { const s = readState(); return s.phase === "on" && typeof s.presetId === "string" ? s.presetId : null; }
/** Jeden GM pilnuje limitów czasu i końca „jednego przebiegu” (żeby kilku GM-ów nie zapisywało stanu naraz). */
const isDutyGM = () => game.user.isGM && (game.users.activeGM?.id ?? game.user.id) === game.user.id;
const setState = (v) => game.settings.set(MODULE_ID, STATE, { id: foundry.utils.randomID(), at: Date.now(), ...v });

function onState(v) {
  Hooks.callAll("sketchReveal.tickerState", v);
  apply(v, false);
}

/** Po starcie klienta: pokaż pasek, który właśnie leci (pętla); „jeden przebieg” spóźnionym się nie wznawia. */
export function restoreTicker() { apply(readState(), true); }

function queue(fn) {
  chain = chain.then(fn).catch((e) => console.error(`${MODULE_ID} | pasek wiadomości`, e));
  return chain;
}

function apply(v, restoring) {
  return queue(async () => {
    clearDuty();
    const p = v?.phase === "on" ? getPreset(v.presetId) : null;
    if (!p || !isTicker(p)) { if (barKey !== "preview") await hide(); return; }
    const data = sanitizeTicker(p.ticker);
    const limitMs = data.mode === "loop" && data.limitMin > 0 ? data.limitMin * 60000 : 0;
    const left = limitMs ? v.at + limitMs - Date.now() : Infinity;
    armDuty(v, data, left);
    if (barKey === v.id && bar) return;
    await hide();
    if (restoring && data.mode === "once") return;
    if (left <= 0) return;
    show(data, { key: v.id, presetId: p.id, limitLeft: left });
  });
}

/* ---------------------------------------------------------------- GM: start / stop */
/** GM: pokaż pasek presetu wszystkim (zastępuje pasek, który już leci). */
export async function startTicker(presetId) {
  if (!game.user.isGM) return console.warn(`${MODULE_ID} | tylko GM może nadawać pasek wiadomości`);
  const p = getPreset(presetId);
  if (!p) return ui.notifications.warn(T("Macro.Missing"));
  if (!isTicker(p)) return ui.notifications.warn(T("Ticker.NotTicker"));
  if (!sanitizeTicker(p.ticker).items.length) return ui.notifications.warn(T("Ticker.NoItems"));
  return setState({ presetId: p.id, phase: "on" });
}

/** GM: zdejmij pasek u wszystkich (z animacją zejścia). */
export async function stopTicker() {
  if (!game.user.isGM) return;
  if (barKey !== "preview") queue(hide); // u siebie od razu, nie czekając na powrót ustawienia
  if (readState().phase !== "on") return;
  return setState({ phase: "off" });
}

/** GM: ten preset na antenie → zdejmij; inaczej → nadaj (makro z paska działa jak przełącznik). */
export function toggleTicker(presetId) {
  return onAirPresetId() === presetId ? stopTicker() : startTicker(presetId);
}

/** Lokalny podgląd (tylko ten klient, jeden przebieg, z przyciskiem „zakończ podgląd”). */
export function previewTicker(raw) {
  if (bar && barKey !== "preview") return ui.notifications.warn(T("Ticker.OnAirBusy"));
  const data = sanitizeTicker({ ...raw, mode: "once" });
  if (!data.items.length) return ui.notifications.warn(T("Ticker.NoItems"));
  return queue(async () => {
    await hide();
    show(data, { key: "preview", presetId: null, limitLeft: Infinity, preview: true });
  });
}

/* ---------------------------------------------------------------- pasek */
function show(data, { key, presetId, limitLeft, preview = false }) {
  const gm = game.user.isGM;
  let lite = false;
  try { lite = !!game.settings.get(MODULE_ID, "perfLiteTitle"); } catch { /* */ }
  const b = new NewsBar({
    data, reduced: prefersReducedMotion(), lite,
    strings: { live: T("Ticker.Live"), stop: T(preview ? "Ticker.StopPreview" : "Ticker.Stop"), region: T("Ticker.Region") },
    onStop: preview ? () => queue(hide) : gm ? () => stopTicker() : null,
    onFinish: () => { if (!preview && isDutyGM() && barKey === key) setTimeout(() => endPass(key), 1500); },
  });
  bar = b; barKey = key; barPresetId = presetId;
  b.setBounds(uiBounds());
  b.start();
  b.finished.then(() => { if (bar === b) { bar = null; barKey = null; barPresetId = null; stopLayout(); } });
  startLayout();
  clearTimeout(limitTimer);
  if (Number.isFinite(limitLeft)) limitTimer = setTimeout(() => { if (bar === b) queue(hide); }, limitLeft);
}

async function hide() {
  clearTimeout(limitTimer);
  const b = bar;
  bar = null; barKey = null; barPresetId = null;
  stopLayout();
  if (b) await b.exit();
}

/** Koniec „jednego przebiegu” — dyżurny GM czyści stan (spóźnieni po przeładowaniu nie zobaczą już paska). */
function endPass(key) {
  const s = readState();
  if (s.phase === "on" && s.id === key) setState({ phase: "off" }).catch(() => {});
}

function clearDuty() { for (const t of dutyTimers) clearTimeout(t); dutyTimers = []; }

/** Dyżurny GM: limit czasu pętli i zapas na koniec jednego przebiegu (gdy jego karta jest w tle i pasek nie zdąży zgłosić końca). */
function armDuty(v, data, limitLeft) {
  if (!isDutyGM()) return;
  if (Number.isFinite(limitLeft)) dutyTimers.push(setTimeout(() => endPass(v.id), Math.max(0, limitLeft)));
  if (data.mode === "once") {
    const est = estimatePassMs(data, Math.max(480, innerWidth * 0.6));
    dutyTimers.push(setTimeout(() => endPass(v.id), Math.max(0, v.at + est + 15000 - Date.now())));
  }
}

/* ---------------------------------------------------------------- aktualizacje na żywo */
/** Zapis presetów (u wszystkich): pasek na antenie bierze nową listę od następnej zmiany pozycji; usunięty preset → zejście. */
export function onPresetsChanged() {
  if (!bar || barKey === "preview" || !barPresetId) return;
  const p = getPreset(barPresetId);
  if (!p || !isTicker(p)) {
    queue(hide);
    if (isDutyGM()) endPass(readState().id);
    return;
  }
  bar.update(p.ticker);
  // zmieniony limit czasu / tryb: przelicz liczniki od chwili startu
  const v = readState();
  if (v.phase === "on" && v.id === barKey) {
    const data = sanitizeTicker(p.ticker);
    const limitMs = data.mode === "loop" && data.limitMin > 0 ? data.limitMin * 60000 : 0;
    const left = limitMs ? v.at + limitMs - Date.now() : Infinity;
    clearDuty(); armDuty(v, data, left);
    clearTimeout(limitTimer);
    const b = bar;
    if (Number.isFinite(left)) limitTimer = setTimeout(() => { if (bar === b) queue(hide); }, Math.max(0, left));
  }
}

/* ---------------------------------------------------------------- układ względem UI Foundry v14 */
/**
 * Odstępy paska: między kolumną narzędzi sceny a paskiem bocznym, tuż nad paskiem makr — i nad pływającymi dolnymi
 * paskami innych modułów (np. pasek reżysera moinen-maps, HUD drużyny), wykrywanymi ogólnie przy każdym przeliczeniu.
 */
export function uiBounds() {
  const W = innerWidth, H = innerHeight;
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? r : null; };
  const col = rect("#ui-left-column-1"), side = rect("#sidebar"), hot = rect("#hotbar");
  let left = col ? col.right + 12 : 16;
  let right = side && side.left > W * 0.4 ? W - side.left + 12 : 16;
  const bottom = hot && hot.top > H * 0.5 ? H - hot.top + 10 : 16;
  if (W - left - right < 480) { left = 8; right = 8; } // wąskie okno: cała szerokość
  // wysokość paska (z belką tytułu); przed pierwszym renderem — szacunek z jednostki skali (--srn-u ≈ 2,15vh)
  const barHeight = bar?.el?.isConnected ? bar.el.getBoundingClientRect().height : Math.min(32, Math.max(14, H * 0.0215)) * 4.6;
  return avoidBottomUi({ left, right, bottom }, { barHeight });
}

function relayout() { bar?.setBounds(uiBounds()); }
function startLayout() {
  if (layoutTimer) return;
  layoutTimer = setInterval(relayout, LAYOUT_MS); // pasek boczny zwija się/rozwija bez zdarzenia resize
  addEventListener("resize", relayout);
}
function stopLayout() {
  clearInterval(layoutTimer); layoutTimer = 0;
  removeEventListener("resize", relayout);
}

/** Do testów z konsoli. */
export const tickerDebug = () => ({ state: readState(), barKey, barPresetId, barState: bar?.state ?? null, bounds: uiBounds(),
  obstacles: bottomObstacles().map((o) => ({ el: o.el.id ? `#${o.el.id}` : o.el.className, top: Math.round(o.top), left: Math.round(o.left), right: Math.round(o.right) })) });

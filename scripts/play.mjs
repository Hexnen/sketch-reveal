/* Nakładki: splash (pełny ekran, modalny) i przejście sceny (nakładka nad płótnem, rozpływa się w żywą scenę).
   Synchronizacja graczy (gniazdo `module.sketch-reveal`): splash dla wszystkich działa w dwóch krokach —
   "prepare" (każdy klient ładuje obrazy i buduje efekt za zasłoną) → "ready" → GM czeka na wszystkich aktywnych
   (albo na limit czasu) → "go" (wszyscy startują razem). */
import { MODULE_ID, sanitizeConfig } from "./config.mjs";
import { RevealPlayer } from "./player.mjs";
import { clientPerf } from "./store.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOCKET = `module.${MODULE_ID}`;
const READY_TIMEOUT_MS = 90000; // zimna wektoryzacja szkicu (faza rysowania) potrafi trwać dziesiątki sekund; potem cache w IndexedDB
let current = null; // { overlay, player, close() }

function makeOverlay(cls) {
  const o = document.createElement("div");
  o.className = `sketch-reveal-overlay ${cls}`;
  document.body.append(o);
  return o;
}

export function closeCurrent() { current?.close(); }

/* ---------------------------------------------------------------- preload */
const warmed = new Set();
/** Rozgrzej cache przeglądarki (pobierz + zdekoduj) — ciche, bez nakładki. */
export async function preloadImages(urls) {
  await Promise.all(urls.filter((u) => u && !warmed.has(u)).map(async (u) => {
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = u;
      await img.decode();
      warmed.add(u);
    } catch (e) { console.warn(`${MODULE_ID} | preload nieudany`, u, e); }
  }));
}

/* ---------------------------------------------------------------- splash */
/**
 * Przygotuj splash za zasłoną (czarna nakładka ze wskaźnikiem ładowania). `start()` rusza odtwarzanie, gdy
 * przygotowanie skończone; `ready` → true/false (false = błąd, nakładka sama się zamyka).
 */
export function stageSplash({ sketchUrl, paintedUrl, config, hints = null, hintsStrict = false }, onPhase = null) {
  closeCurrent();
  const cfg = sanitizeConfig(config);
  const overlay = makeOverlay("sr-splash sr-loading");
  const stage = document.createElement("div");
  stage.className = "sr-stage";
  const hint = document.createElement("span");
  hint.className = "sr-hint";
  // gracze mogą pominąć/zamknąć splash tylko gdy preset na to pozwala (GM zawsze może)
  const canSkip = game.user.isGM || !!cfg.playerSkip;
  hint.textContent = game.i18n.localize("SKETCHREVEAL.Overlay.Hint");
  if (!canSkip) { hint.hidden = true; overlay.style.cursor = "default"; }
  const spin = document.createElement("span");
  spin.className = "sr-spinner";
  spin.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${game.i18n.localize("SKETCHREVEAL.Overlay.Loading")}`;
  overlay.append(stage, hint);
  if (game.user.isGM) overlay.append(spin); // znaczek „Przygotowywanie…” tylko dla GM (gracze bez żadnych wskaźników)
  const player = new RevealPlayer({ container: stage, sketchUrl, paintedUrl, config: cfg, fit: "contain", perf: clientPerf(), hints, hintsStrict, onPhase });
  let closed = false, started = false;
  const s = { overlay, player, close: null, start: null, ready: null };
  const close = async () => {
    if (closed) return; closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.classList.add("sr-leaving");
    await sleep(350);
    player.dispose(); overlay.remove();
    if (current === s) current = null;
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (canSkip) close(); } };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("click", () => { if (!canSkip) return; if (started && player.playing) player.skip(); else if (started) close(); });
  s.close = close;
  s.ready = player.prepare().then(() => !closed, (e) => {
    console.error(`${MODULE_ID} | przygotowanie splasha`, e);
    // gracze nie widzą żadnych powiadomień modułu — błąd tylko w konsoli (GM dostaje też powiadomienie)
    if (game.user.isGM) ui.notifications.error(game.i18n.format("SKETCHREVEAL.Error.Play", { error: e?.message ?? e }));
    close();
    return false;
  });
  s.start = async () => {
    if (started) return; started = true;
    if (!(await s.ready) || closed) return;
    overlay.classList.remove("sr-loading");
    overlay.classList.add("sr-ready");
    await player.play();
    if (closed) return;
    if (cfg.holdSec > 0) { await sleep(cfg.holdSec * 1000); if (!closed) await close(); }
  };
  current = s;
  return s;
}

/** Lokalnie, od razu (podgląd w edytorze, „Odtwórz u mnie”). */
export function playSplash(payload) { return stageSplash(payload).start(); }

/* ---------------------------------------------------------------- splash dla wszystkich (z barierą gotowości) */
const staged = new Map(); // id sesji → s (po stronie klienta)
const runs = new Map();   // id sesji → { ready:Set, failed:Set, wake() } (po stronie GM)

function clientPrepare(id, payload) {
  // fazy przygotowania lecą do GM (diagnostyka: na którym kroku klient stoi)
  const s = stageSplash(payload, (phase, ms) => {
    const msg = { action: "phase", id, userId: game.user.id, phase, ms, visible: document.visibilityState };
    if (runs.has(id)) Hooks.callAll("sketchReveal.phase", msg); else game.socket.emit(SOCKET, msg); // inicjator = ten, kto ma `run`
  });
  staged.set(id, s);
  s.ready.then((ok) => {
    const msg = { action: "ready", id, userId: game.user.id, ok };
    // inicjator (ma `run`) liczy siebie lokalnie; KAŻDY inny klient — także drugi GM — odpowiada przez gniazdo
    if (runs.has(id)) onReady(msg); else game.socket.emit(SOCKET, msg);
  });
}
function clientGo(id) {
  const s = staged.get(id);
  staged.delete(id);
  s?.start();
}
function onReady({ id, userId, ok }) {
  const r = runs.get(id);
  if (!r) return;
  (ok ? r.ready : r.failed).add(userId);
  r.wake();
}

/** Panel GM „na kogo czekamy”: lista klientów ze statusem (gotowy / aktualna faza / brak odpowiedzi) i czasem. */
export function createSyncHud(expected, run) {
  const L = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
  const el = document.createElement("div");
  el.className = "sr-sync-hud";
  document.body.append(el);
  const phases = new Map();
  const phaseLabel = (ph) => {
    const key = ph.startsWith("waiting") ? "waiting" : ph;
    const k = `SKETCHREVEAL.Phase.${key}`;
    return game.i18n.has(k) ? game.i18n.localize(k) : ph;
  };
  const t0 = performance.now();
  const render = () => {
    const ids = [...expected];
    const readyN = ids.filter((u) => run.ready.has(u)).length;
    const rows = ids.map((u) => {
      const name = foundry.utils.escapeHTML(game.users.get(u)?.name ?? u);
      let icon = "fa-hourglass-half", cls = "wait", text;
      if (run.ready.has(u)) { icon = "fa-circle-check"; cls = "ok"; text = L("Sync.ReadyStatus"); }
      else if (run.failed.has(u)) { icon = "fa-circle-xmark"; cls = "bad"; text = L("Sync.FailedStatus"); }
      else text = phases.has(u) ? phaseLabel(phases.get(u)) : L("Sync.NoReply");
      return `<li class="${cls}"><i class="fa-solid ${icon}"></i> <strong>${name}</strong> <span>${foundry.utils.escapeHTML(text)}</span></li>`;
    }).join("");
    el.innerHTML = `<h4>${L("Sync.Title")} <small>${readyN}/${ids.length} · ${Math.round((performance.now() - t0) / 1000)} s</small></h4><ul>${rows}</ul>`;
  };
  const hook = Hooks.on("sketchReveal.phase", (m) => { phases.set(m.userId, m.phase); render(); });
  const timer = setInterval(render, 500);
  render();
  return { update: render, dispose() { clearInterval(timer); Hooks.off("sketchReveal.phase", hook); el.remove(); } };
}

/**
 * GM: pokaż splash wszystkim aktywnym użytkownikom. Najpierw wszyscy przygotowują się za zasłoną; start dopiero,
 * gdy każdy zgłosi gotowość (albo po limicie czasu — wtedy ostrzeżenie, kogo zabrakło; spóźnieni startują, gdy skończą).
 */
export async function showSplashToAll(payload) {
  const id = foundry.utils.randomID();
  const expected = new Set(game.users.filter((u) => u.active).map((u) => u.id));
  const run = { ready: new Set(), failed: new Set(), wake: () => {} };
  runs.set(id, run);
  const waiting = () => [...expected].filter((u) => !run.ready.has(u) && !run.failed.has(u));
  const allDone = new Promise((res) => { run.wake = () => { if (!waiting().length) res(true); }; });
  game.socket.emit(SOCKET, { action: "prepare", id, payload });
  clientPrepare(id, payload);
  const hud = createSyncHud(expected, run);
  const done = await Promise.race([allDone, sleep(READY_TIMEOUT_MS).then(() => false)]);
  hud.dispose();
  runs.delete(id);
  if (!done) {
    const names = waiting().map((u) => game.users.get(u)?.name ?? u).join(", ");
    ui.notifications.warn(game.i18n.format("SKETCHREVEAL.Sync.Timeout", { names }));
  }
  const failed = [...run.failed].map((u) => game.users.get(u)?.name).filter(Boolean);
  if (failed.length) ui.notifications.warn(game.i18n.format("SKETCHREVEAL.Sync.Failed", { names: failed.join(", ") }));
  game.socket.emit(SOCKET, { action: "go", id });
  clientGo(id);
}

/** GM: poproś wszystkich klientów o wstępne załadowanie obrazów presetu (cache), bez pokazywania czegokolwiek. */
export function preloadForAll(urls) {
  game.socket.emit(SOCKET, { action: "preload", urls });
  return preloadImages(urls);
}

export function broadcastClose() { game.socket.emit(SOCKET, { action: "close" }); closeCurrent(); }

export function registerSocket() {
  game.socket.on(SOCKET, (msg) => {
    switch (msg?.action) {
      case "prepare": clientPrepare(msg.id, msg.payload); break;
      case "go": clientGo(msg.id); break;
      case "ready": if (runs.has(msg.id)) onReady(msg); break;
      case "preload": preloadImages(msg.urls ?? []); break;
      case "close": closeCurrent(); break;
      // diagnostyka: każdy klient z modułem odpowiada (GM widzi, kto odbiera gniazdo)
      case "ping": game.socket.emit(SOCKET, { action: "pong", userId: game.user.id, visible: document.visibilityState }); break;
      case "pong": Hooks.callAll("sketchReveal.pong", msg); break;
      case "phase": if (runs.has(msg.id)) Hooks.callAll("sketchReveal.phase", msg); break;
    }
  });
}

/* ---------------------------------------------------------------- przejście sceny */
// Przejście gra się u każdego klienta osobno (scena ładuje się u każdego we własnym tempie) — ale nakładka startuje
// dopiero po pełnym przygotowaniu, a zasłona wisi od canvasInit, więc nikt nie zobaczy "gołej" sceny ani nie dostanie
// efektu w połowie. Obrazy są rozgrzewane z góry (preloadImages przy ready i przy zmianie flag sceny).
let pending = null; // { overlay, player, ready, cfg, cancel() }

/** canvasInit: natychmiast zasłoń scenę (kolor papieru) i zacznij ładować — bez mignięcia żywej sceny. */
export function armTransition(resolved) {
  cancelTransition();
  const cfg = resolved.config;
  const overlay = makeOverlay("sr-transition");
  overlay.style.setProperty("--sr-cover", cfg.paper.paper ? cfg.paper.paperColor : "#ffffff");
  const stage = document.createElement("div");
  stage.className = "sr-stage";
  overlay.append(stage);
  const player = new RevealPlayer({ container: stage, sketchUrl: resolved.sketchUrl, paintedUrl: resolved.paintedUrl, config: cfg, fit: "cover", perf: clientPerf(), hints: resolved.hints, hintsStrict: resolved.hintsStrict });
  let cancelled = false;
  const ready = player.prepare().then(() => !cancelled, (e) => { console.error(`${MODULE_ID} | przygotowanie przejścia`, e); return false; });
  const t = { overlay, player, ready, cfg, cancel() { cancelled = true; clearTimeout(t.guard); player.dispose(); overlay.remove(); if (pending === t) pending = null; } };
  pending = t;
  // zabezpieczenie: nie zostawiaj zasłony na zawsze (np. scena nie dojechała do canvasReady)
  t.guard = setTimeout(() => { if (pending === t) t.cancel(); }, 45000);
}

export function cancelTransition() { pending?.cancel(); }

/** canvasReady: odtwórz przygotowane przejście i rozpłyń nakładkę w żywą scenę. */
export async function runTransition() {
  const t = pending;
  if (!t) return;
  clearTimeout(t.guard);
  const { overlay, player, cfg } = t;
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.classList.add("sr-fading");
    overlay.style.setProperty("--sr-fade", `${Math.max(0.05, cfg.fadeSec)}s`);
    player.setTitleExit(0);
    await sleep(Math.max(60, cfg.fadeSec * 1000));
    player.dispose(); overlay.remove();
    if (current?.overlay === overlay) current = null;
    if (pending === t) pending = null;
  };
  const canSkip = game.user.isGM || !!cfg.playerSkip;
  const onKey = (e) => { if (e.key === "Escape" && canSkip) close(); };
  document.addEventListener("keydown", onKey, true);
  if (canSkip) overlay.addEventListener("click", () => { if (player.playing) player.skip(); else close(); });
  current = { overlay, player, close };
  try {
    if (!(await t.ready)) { await close(); return; } // błąd przygotowania → bez efektu, scena żywa
    overlay.classList.add("sr-ready");
    await player.play();
    if (!closed) { if (cfg.holdSec > 0) await sleep(Math.min(cfg.holdSec, 1.5) * 1000); await close(); }
  } catch (e) {
    console.error(`${MODULE_ID} | transition`, e);
    close();
  }
}

/** GM: sprawdź, którzy klienci mają moduł i odbierają gniazdo. Zwraca [{userId, name, visible}] po `waitMs`. */
export function pingClients(waitMs = 3000) {
  const got = [];
  const id = Hooks.on("sketchReveal.pong", (m) => got.push({ userId: m.userId, name: game.users.get(m.userId)?.name, visible: m.visible }));
  game.socket.emit(SOCKET, { action: "ping" });
  return new Promise((res) => setTimeout(() => { Hooks.off("sketchReveal.pong", id); res(got); }, waitMs));
}

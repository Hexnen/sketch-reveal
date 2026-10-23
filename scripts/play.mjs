/* Nakładki: splash (pełny ekran, modalny) i przejście sceny (nakładka nad płótnem, rozpływa się w żywą scenę).
   Splash dla wszystkich: STAN idzie przez ustawienie świata `splashState` (zapis tylko GM — uwierzytelnione przez serwer),
   odpowiedzi klientów (ready/phase) i diagnostyka (ping/pong) przez gniazdo `module.sketch-reveal`.
   Dwa kroki: "prepare" (każdy klient ładuje obrazy i buduje efekt za zasłoną) → "ready" → GM czeka na wszystkich
   aktywnych (albo na limit czasu) → "go" (wszyscy startują razem). */
import { MODULE_ID, sanitizeConfig } from "./config.mjs";
import { RevealPlayer } from "./player.mjs";
import { clientPerf, getPreset, presetPayload } from "./store.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOCKET = `module.${MODULE_ID}`;
const READY_TIMEOUT_MS = 90000; // zimna wektoryzacja szkicu (faza rysowania) potrafi trwać dziesiątki sekund; potem cache w IndexedDB
const CLIENT_WAIT_MS = READY_TIMEOUT_MS + 20000; // klient czekający na „go” dłużej niż to zamyka splash sam (GM zniknął)
const START_LEAD_MS = 500; // „go” niesie czas startu = teraz + 500 ms (zegar GM-a) — tyle ma dojść do wszystkich klientów
/** Czas epokowy w ms z wysoką rozdzielczością (monotoniczny; różnice między klientami wyznacza syncClock). */
const epoch = () => performance.timeOrigin + performance.now();
let currentSplash = null;     // { overlay, player, close() }
let currentTransition = null; // { overlay, player, close() }

function makeOverlay(cls) {
  const o = document.createElement("div");
  o.className = `sketch-reveal-overlay ${cls}`;
  document.body.append(o);
  return o;
}

/** Zamyka bieżący splash (przejście sceny zostaje). */
function closeSplash() { currentSplash?.close(); }
/** Zamyka wszystko, co moduł pokazuje (splash i przejście) — „Zamknij u wszystkich”. */
export function closeCurrent() { currentSplash?.close(); currentTransition?.close(); cancelTransition(); }

/* ---------------------------------------------------------------- preload */
const warmed = new Set();
const sameOrigin = (u) => { try { return typeof u === "string" && new URL(u, location.href).origin === location.origin; } catch { return false; } };
/** Rozgrzej cache przeglądarki (pobierz + zdekoduj) — ciche, bez nakładki. */
export async function preloadImages(urls) {
  // wiadomość z gniazda nie jest uwierzytelniona: tylko tablica stringów, adresy z tego samego źródła, najwyżej 8
  if (!Array.isArray(urls)) return;
  await Promise.all(urls.slice(0, 8).filter((u) => sameOrigin(u) && !warmed.has(u)).map(async (u) => {
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
  closeSplash();
  const cfg = sanitizeConfig(config);
  const overlay = makeOverlay("sr-splash sr-loading");
  const stage = document.createElement("div");
  stage.className = "sr-stage";
  const hint = document.createElement("span");
  hint.className = "sr-hint";
  // gracze mogą pominąć/zamknąć splash tylko gdy preset na to pozwala (GM zawsze); gdy nie ma aktywnego GM-a
  // (zniknął w trakcie), nikt nie zamknie splasha za nich — wtedy mogą go zamknąć sami
  const canSkip = () => game.user.isGM || !!cfg.playerSkip || !game.users.activeGM;
  hint.textContent = game.i18n.localize("SKETCHREVEAL.Overlay.Hint");
  const syncSkip = () => { const ok = canSkip(); hint.hidden = !ok; overlay.style.cursor = ok ? "pointer" : "default"; };
  syncSkip();
  const skipTimer = setInterval(syncSkip, 1000);
  const spin = document.createElement("span");
  spin.className = "sr-spinner";
  spin.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${game.i18n.localize("SKETCHREVEAL.Overlay.Loading")}`;
  overlay.append(stage, hint);
  if (game.user.isGM) overlay.append(spin); // znaczek „Przygotowywanie…” tylko dla GM (gracze bez żadnych wskaźników)
  const player = new RevealPlayer({ container: stage, sketchUrl, paintedUrl, config: cfg, fit: "contain", perf: clientPerf(), hints, hintsStrict, onPhase });
  let closed = false, started = false;
  const s = { overlay, player, close: null, start: null, ready: null, isStarted: () => started };
  const close = async () => {
    if (closed) return; closed = true;
    document.removeEventListener("keydown", onKey, true);
    clearInterval(skipTimer);
    overlay.classList.add("sr-leaving");
    await sleep(350);
    player.dispose(); overlay.remove();
    if (currentSplash === s) currentSplash = null;
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (canSkip()) close(); } };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("click", () => { if (!canSkip()) return; if (started && player.playing) player.skip(); else if (started) close(); });
  s.close = close;
  s.ready = player.prepare().then(() => !closed, (e) => {
    // zamknięcie w trakcie przygotowania (Esc/„Zamknij u wszystkich”) powoduje odrzucenie — to nie błąd
    if (!closed) {
      console.error(`${MODULE_ID} | przygotowanie splasha`, e);
      // gracze nie widzą żadnych powiadomień modułu — błąd tylko w konsoli (GM dostaje też powiadomienie)
      if (game.user.isGM) ui.notifications.error(game.i18n.format("SKETCHREVEAL.Error.Play", { error: foundry.utils.escapeHTML(String(e?.message ?? e)) }));
    }
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
  currentSplash = s;
  return s;
}

/** Lokalnie, od razu (podgląd w edytorze, „Odtwórz u mnie”). */
export function playSplash(payload) { return stageSplash(payload).start(); }

/* ---------------------------------------------------------------- splash dla wszystkich (z barierą gotowości) */
// Klienci rozwiązują preset lokalnie po `presetId` (stan świata), więc gracz nie wymusi splasha z własnym obrazem ani nie
// zamknie cudzego. Podrobione „ready” z gniazda skraca najwyżej barierę GM-a (kosmetyka).
const staged = new Map(); // id sesji → s (po stronie klienta)
const runs = new Map();   // id sesji → { ready, failed, expected, wake() } (po stronie GM-inicjatora)

export function registerSplashState() {
  game.settings.register(MODULE_ID, "splashState", { scope: "world", config: false, type: Object, default: {}, onChange: (v) => onSplashState(v) });
}

function onSplashState(v) {
  if (!v || typeof v.id !== "string") return;
  if (v.phase === "prepare") {
    const preset = getPreset(v.presetId);
    if (preset) clientPrepare(v.id, presetPayload(preset));
  } else if (v.phase === "go") clientGo(v.id, v.startAt);
  else if (v.phase === "close") closeCurrent();
}

const clockOffset = new Map(); // id sesji → { offset: zegar GM minus mój [ms], rtt }
const tsyncPending = new Map(); // id sesji → próbki

/**
 * Różnica zegara względem inicjatora (GM): kilka rund ping–pong przez gniazdo, wybieramy próbkę o najmniejszym RTT
 * (offset = g + rtt/2 − c1). Inicjator ma offset 0. Bez odpowiedzi klient startuje od razu po „go” (bez wspólnego czasu).
 */
function syncClock(id) {
  if (runs.has(id)) { clockOffset.set(id, { offset: 0, rtt: 0 }); return; }
  tsyncPending.set(id, []);
  let n = 0;
  const send = () => {
    if (n++ >= 6 || !tsyncPending.has(id)) return;
    game.socket.emit(SOCKET, { action: "tsync", id, userId: game.user.id, c0: epoch() });
    setTimeout(send, 70);
  };
  send();
  setTimeout(() => tsyncPending.delete(id), CLIENT_WAIT_MS);
}
function onTsyncReply(msg) {
  const samples = tsyncPending.get(msg.id);
  if (!samples || msg.to !== game.user.id || typeof msg.c0 !== "number" || typeof msg.g !== "number") return;
  const c1 = epoch(), rtt = c1 - msg.c0;
  if (!(rtt >= 0 && rtt < 5000)) return;
  samples.push({ rtt, offset: msg.g + rtt / 2 - c1 });
  const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  clockOffset.set(msg.id, best);
}

function clientPrepare(id, payload) {
  syncClock(id);
  // fazy przygotowania lecą do GM (diagnostyka: na którym kroku klient stoi)
  const s = stageSplash(payload, (phase, ms) => {
    const msg = { action: "phase", id, userId: game.user.id, phase, ms, visible: document.visibilityState };
    if (runs.has(id)) Hooks.callAll("sketchReveal.phase", msg); else game.socket.emit(SOCKET, msg); // inicjator = ten, kto ma `run`
  });
  staged.set(id, s);
  // watchdog: GM zniknął w trakcie bariery → „go” nie przyjdzie; nie trzymaj gracza za zasłoną w nieskończoność
  setTimeout(() => { if (staged.get(id) === s) { staged.delete(id); if (!s.isStarted()) s.close(); } }, CLIENT_WAIT_MS);
  s.ready.then((ok) => {
    const msg = { action: "ready", id, userId: game.user.id, ok };
    // inicjator (ma `run`) liczy siebie lokalnie; KAŻDY inny klient — także drugi GM — odpowiada przez gniazdo
    if (runs.has(id)) onReady(msg); else game.socket.emit(SOCKET, msg);
  });
}
function clientGo(id, startAt) {
  const s = staged.get(id);
  staged.delete(id);
  if (!s) return;
  // wspólny start: czas GM-a przeliczony na mój zegar; bez wiarygodnej synchronizacji (brak odpowiedzi / duży RTT) — od razu
  const info = clockOffset.get(id);
  let delay = 0;
  if (typeof startAt === "number" && info && info.rtt < 1000) delay = Math.max(0, Math.min(5000, startAt - info.offset - epoch()));
  clockOffset.delete(id); tsyncPending.delete(id);
  const begin = () => {
    s.start();
    // diagnostyka: kiedy faktycznie wystartowałem, w zegarze GM-a (różnice między klientami = rozbieżność startu)
    const msg = { action: "phase", id, userId: game.user.id, phase: "started", gmAt: epoch() + (info?.offset ?? 0), delay: Math.round(delay), rtt: Math.round(info?.rtt ?? -1) };
    if (runs.has(id)) Hooks.callAll("sketchReveal.phase", msg); else game.socket.emit(SOCKET, msg);
  };
  if (delay > 0) setTimeout(begin, delay); else begin();
}
function onReady({ id, userId, ok }) {
  const r = runs.get(id);
  if (!r || typeof userId !== "string" || !r.expected.has(userId)) return;
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
      else if (!game.users.get(u)?.active) { icon = "fa-plug-circle-xmark"; cls = "bad"; text = L("Sync.Left"); }
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
 * GM: pokaż preset wszystkim aktywnym użytkownikom. Najpierw wszyscy przygotowują się za zasłoną; start dopiero,
 * gdy każdy aktywny klient zgłosi gotowość (klienci, którzy w międzyczasie wypadną, nie blokują; limit czasu →
 * ostrzeżenie, kogo zabrakło; spóźnieni startują, gdy skończą).
 */
export async function showSplashToAll(presetId) {
  if (!game.user.isGM) return;
  if (!getPreset(presetId)) return ui.notifications.warn(game.i18n.localize("SKETCHREVEAL.Macro.Missing"));
  const id = foundry.utils.randomID();
  const expected = new Set(game.users.filter((u) => u.active).map((u) => u.id));
  const run = { ready: new Set(), failed: new Set(), expected, wake: () => {} };
  runs.set(id, run);
  // klient, który wypadł (zamknął kartę) w trakcie, przestaje być oczekiwany
  const waiting = () => [...expected].filter((u) => game.users.get(u)?.active && !run.ready.has(u) && !run.failed.has(u));
  const allDone = new Promise((res) => { run.wake = () => { if (!waiting().length) res(true); }; });
  let hud, ticker;
  const state = (phase, extra = {}) => game.settings.set(MODULE_ID, "splashState", { id, presetId, phase, at: Date.now(), ...extra });
  try {
    await state("prepare");
    hud = createSyncHud(expected, run);
    ticker = setInterval(() => run.wake(), 500);
    const done = await Promise.race([allDone, sleep(READY_TIMEOUT_MS).then(() => false)]);
    if (!done) {
      const names = waiting().map((u) => foundry.utils.escapeHTML(game.users.get(u)?.name ?? u)).join(", ");
      ui.notifications.warn(game.i18n.format("SKETCHREVEAL.Sync.Timeout", { names }));
    }
    const failed = [...run.failed].map((u) => game.users.get(u)?.name).filter(Boolean).map(foundry.utils.escapeHTML);
    if (failed.length) ui.notifications.warn(game.i18n.format("SKETCHREVEAL.Sync.Failed", { names: failed.join(", ") }));
    await state("go", { startAt: epoch() + START_LEAD_MS });
  } catch (e) {
    console.error(`${MODULE_ID} | pokaż wszystkim`, e);
    try { await state("close"); } catch { /* */ } // nie zostawiaj klientów za zasłoną po wyjątku
    throw e;
  } finally {
    clearInterval(ticker); hud?.dispose();
    // wpis sesji żyje jeszcze przez okno startu: raporty „started”/tsync i własny start inicjatora go potrzebują
    setTimeout(() => runs.delete(id), START_LEAD_MS + 3000);
  }
}

/** GM: poproś wszystkich klientów o wstępne załadowanie obrazów (cache), bez pokazywania czegokolwiek. */
export function preloadForAll(urls) {
  game.socket.emit(SOCKET, { action: "preload", urls });
  return preloadImages(urls);
}

/** GM: zamknij splash (i przejście) u wszystkich — przez stan świata (tylko GM może zapisać). */
export function broadcastClose() {
  closeCurrent();
  return game.settings.set(MODULE_ID, "splashState", { id: foundry.utils.randomID(), phase: "close", at: Date.now() });
}

export function registerSocket() {
  game.socket.on(SOCKET, (msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.action) {
      case "ready": if (typeof msg.id === "string" && runs.has(msg.id)) onReady(msg); break;
      // synchronizacja zegara: inicjator odpowiada swoim czasem
      case "tsync": if (typeof msg.id === "string" && typeof msg.userId === "string" && runs.has(msg.id)) game.socket.emit(SOCKET, { action: "tsync-r", id: msg.id, to: msg.userId, c0: msg.c0, g: epoch() }); break;
      case "tsync-r": if (typeof msg.id === "string") onTsyncReply(msg); break;
      case "preload": preloadImages(msg.urls); break;
      // diagnostyka: każdy klient z modułem odpowiada (GM widzi, kto odbiera gniazdo)
      case "ping": game.socket.emit(SOCKET, { action: "pong", userId: game.user.id, visible: document.visibilityState }); break;
      case "pong": Hooks.callAll("sketchReveal.pong", msg); break;
      case "phase": if (typeof msg.id === "string" && runs.has(msg.id)) Hooks.callAll("sketchReveal.phase", msg); break;
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
  const ready = player.prepare().then(() => !cancelled, (e) => { if (!cancelled) console.error(`${MODULE_ID} | przygotowanie przejścia`, e); return false; });
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
    if (currentTransition?.overlay === overlay) currentTransition = null;
    if (pending === t) pending = null;
  };
  const canSkip = () => game.user.isGM || !!cfg.playerSkip || !game.users.activeGM;
  const onKey = (e) => { if (e.key === "Escape" && canSkip()) close(); };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("click", () => { if (!canSkip()) return; if (player.playing) player.skip(); else close(); });
  currentTransition = { overlay, player, close };
  try {
    // po canvasReady straż 45 s już nie działa — własny limit, żeby zawieszone przygotowanie nie zostawiło zasłony na zawsze
    if (!(await Promise.race([t.ready, sleep(READY_TIMEOUT_MS).then(() => false)]))) { await close(); return; } // błąd/limit → bez efektu, scena żywa
    if (closed) return;
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

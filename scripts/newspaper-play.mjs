/* „Wirująca gazeta” w Foundry: zrzut płótna tuż przed zburzeniem starej sceny, zasłona przez całe ładowanie nowej,
   wspólny start odlotu (ta sama bariera co przejścia reveal), podgląd bez zmiany sceny, formularz edytora.

   Kolejność w v14 (Canvas#draw): canvasTearDown(canvas, {nextScene}) — warstwy starej sceny jeszcze istnieją, root ukryty,
   ale renderowalny → TU robimy zrzut i od razu kładziemy zasłonę (pierwsza klatka = dokładnie to, co było na ekranie)
   → canvasInit (nowa scena, przypisujemy syncId) → canvasReady (nowa scena narysowana pod zasłoną) → po uformowaniu strony
   zgłaszamy gotowość, czekamy na „tgo” i odlatujemy. Każdy klient fotografuje SWÓJ widok (własna kamera, mgła, tokeny). */
import { MODULE_ID } from "./config.mjs";
import {
  DEFAULT_NEWSPAPER, HOLD_MS, NEWSPAPER_DEFAULT_TEXT, NEWSPAPER_LIMITS, NEWSPAPER_SLOTS, SHOT_CAP, cameraEase, clusterRects, coverView, createNewspaper,
  detailSpots, ensurePaperFont, newspaperText, photoCrop, prefersReducedMotion, REVEAL_ZOOM, revealCameraMs, sameRect, sanitizeNewspaper, shotFrame, usDate,
} from "./fx/newspaper.mjs";
import { awaitTransitionGo, prepareTransitionSync, transitionReadyOnly } from "./play.mjs";
import { clientPerf, getPreset, resolveNewspaper } from "./store.mjs";
import { uiBounds } from "./ticker-play.mjs";

const L = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const FONT = "Amiri"; // krój szeryfowy z rdzenia Foundry (/fonts/amiri, deklarowany w CSS rdzenia) — bez pobierania
const SANS = "Signika"; // bezszeryfowy krój rdzenia Foundry — tytuły współczesnej gazety (pełne polskie znaki)
const COND = "Modesto Condensed"; // wąski krój rdzenia Foundry (700 = grotesk nagłówków dziennika z lat 30.; bez polskich znaków)
const GUARD_MS = 45000;
const CAPTURE_MAX_W = 1920;
/** Zdjęcia grup (tryb multi): na stronie są małe, w sesji fotografa widać je chwilę na pełnym ekranie (pod ziarnem i błyskiem). */
const SHOT_MAX_W = 1280;

let cur = null;   // { np, overlay, sceneId, syncId, attached, preview, guard, closed, close() }
let last = {};    // diagnostyka ostatniego przebiegu

/** Ta scena gra „gazetę” (preset tego rodzaju, przejścia włączone, wyzwalacz spełniony). */
export function resolveNewspaperFor(scene) {
  const r = resolveNewspaper(scene);
  if (!r) return null;
  if (!game.settings.get(MODULE_ID, "transitions")) return null;
  if (r.trigger === "activate" && !scene.active) return null;
  return r;
}

/** Unieważnij bufory zależne od kamery (to samo, co robi Canvas#pan po zmianie widoku). */
function invalidateViewCaches() {
  try { canvas.hidden?.invalidateMasks?.(); } catch { /* */ }
  try { canvas.effects?.illumination?.invalidateDarknessLevelContainer?.(); } catch { /* */ }
}

/**
 * Zrzut samego płótna gry (bez HTML UI): render sceny do RenderTexture w rozdzielczości ≤ 1920 px szerokości i odczyt
 * do <canvas>. Działa także w canvasTearDown (root jest wtedy ukryty — na czas renderu włączamy go jak rdzeń v14).
 *
 * Zdjęcie do gazety pokazuje TYLKO mapę: kadr (photoCrop) o proporcjach ekranu leży w całości w obrazie sceny
 * (dimensions.sceneRect), możliwie blisko tego, co gracz widział. Gdy na ekranie było widać tło poza sceną, scena jest
 * renderowana drugi raz z kamerą ustawioną na ten kadr (pełna rozdzielczość, nie powiększony zrzut), a pierwszy zrzut
 * (`cover` — dokładnie to, co było na ekranie) służy do płynnego najazdu kamery. Kamera wraca do stanu sprzed zrzutu.
 *
 * `shots` = wygląd strony („classic” / „modern”) → tryb multi: dodatkowo zdjęcia grup tokenów widocznych dla TEGO
 * klienta (captureShots), w liczbie mieszczącej się na stronie. W trybie multi zdjęcie sceny i zdjęcia grup są renderowane
 * BEZ ukrytych tokenów (MG widzi je półprzezroczyste — na zdjęciach gazety nie ma ich nikt; `cover` = ekran jak był).
 * Zwraca { photo, cover|null, crop (px ekranu)|null, bg, shots|null }.
 */
export function captureView({ shots: shotStyle = null, safe = null } = {}) {
  const r = canvas?.app?.renderer;
  if (!r || !canvas.stage) throw new Error("no canvas");
  const { width, height } = r.screen;
  const res = Math.min(globalThis.devicePixelRatio || 1, CAPTURE_MAX_W / width);
  // kolor tła płótna (PIXI 7: background.color to liczba, backgroundColor — obiekt Color); zapas: kolor tła sceny
  let bg = null;
  try {
    const b = r.background;
    bg = b?.backgroundColor?.toHex?.() ?? (Number.isFinite(b?.color) ? `#${b.color.toString(16).padStart(6, "0")}` : null);
  } catch { /* */ }
  if (!/^#[0-9a-f]{6}$/i.test(bg ?? "")) bg = /^#[0-9a-f]{6}$/i.test(canvas.scene?.backgroundColor ?? "") ? canvas.scene.backgroundColor : "#000";
  const shot = (resolution = res) => {
    const rt = PIXI.RenderTexture.create({ width, height, resolution });
    const rootVisible = canvas.root?.visible;
    try {
      if (canvas.root) canvas.root.visible = true;
      r.render(canvas.stage, { renderTexture: rt, clear: true });
    } finally { if (canvas.root) canvas.root.visible = rootVisible; }
    const src = r.extract.canvas(rt);
    rt.destroy(true);
    // przezroczyste miejsca (poza sceną) mają kolor tła płótna, jak na ekranie
    const out = document.createElement("canvas");
    out.width = src.width; out.height = src.height;
    const g = out.getContext("2d");
    g.fillStyle = bg; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(src, 0, 0);
    return out;
  };
  const cover = shot();
  const st = canvas.stage, sr = canvas.dimensions?.sceneRect;
  const scale = st.scale.x;
  if (!sr || !(sr.width > 0) || !(sr.height > 0) || !(scale > 0)) return { photo: cover, cover: null, crop: null, bg, shots: null };
  // widok w jednostkach świata (pivot = punkt świata w miejscu stage.position)
  const view = { x: st.pivot.x - st.position.x / scale, y: st.pivot.y - st.position.y / scale, w: width / scale, h: height / scale };
  const scene = { x: sr.x, y: sr.y, w: sr.width, h: sr.height };
  const c = photoCrop(view, scene, width / height);
  const crop = { x: (c.x - view.x) * scale, y: (c.y - view.y) * scale, w: c.w * scale, h: c.h * scale };
  const needCrop = !sameRect(crop, { x: 0, y: 0, w: width, h: height }, 1);
  if (!needCrop && !shotStyle) return { photo: cover, cover: null, crop: null, bg, shots: null };
  // tryb multi: ukryte tokeny (u MG rysowane półprzezroczyste) znikają na czas renderów — kontener tokenu i jego siatka
  // w grupie primary; render jest synchroniczny, więc nic pomiędzy nie odświeży widoczności. Na końcu stan wraca.
  const veiled = [];
  if (shotStyle) for (const t of canvas.tokens?.placeables ?? []) {
    if (!t?.document?.hidden || t.destroyed) continue;
    veiled.push([t, t.visible, t.mesh, t.mesh?.visible]);
    t.visible = false;
    if (t.mesh) t.mesh.visible = false;
  }
  const multiPhoto = shotStyle && veiled.some(([, was, , meshWas]) => was || meshWas);
  // kolejne rendery: kamera na kadrze (bez Canvas#pan — żadnych hooków ani zapisu pozycji widoku sceny), na końcu powrót
  const saved = { px: st.pivot.x, py: st.pivot.y, sx: st.scale.x, sy: st.scale.y, x: st.position.x, y: st.position.y };
  const renderAt = (f, resolution) => {
    const k = width / f.w;
    st.pivot.set(f.x + f.w / 2, f.y + f.h / 2);
    st.scale.set(k, k);
    st.position.set(width / 2, height / 2);
    invalidateViewCaches();
    return shot(resolution);
  };
  let photo = null, shots = null;
  try {
    if (needCrop || multiPhoto) {
      try { photo = renderAt(c, res); } catch (e) { console.warn(`${MODULE_ID} | gazeta: kadr bez tła nieudany, zostaje zwykły zrzut`, e); }
    }
    if (shotStyle) {
      const outW = Math.min(SHOT_MAX_W, width * (globalThis.devicePixelRatio || 1));
      // wolna od UI część ekranu (0…1) — tam ląduje grupa na pełnoekranowym zdjęciu sesji
      const free = safe ? { x: safe.left / width, y: (safe.top ?? 0) / height, w: 1 - (safe.left + safe.right) / width, h: 1 - ((safe.top ?? 0) + safe.bottom) / height } : undefined;
      try { shots = captureShots(shotStyle, { est: c, scene, aspect: width / height, establishing: photo ?? cover, renderAt, outW, width, safe: free }); }
      catch (e) { console.warn(`${MODULE_ID} | gazeta: zdjęcia grup nieudane, zostaje jedno zdjęcie`, e); shots = null; }
    }
  } finally {
    st.pivot.set(saved.px, saved.py); st.scale.set(saved.sx, saved.sy); st.position.set(saved.x, saved.y);
    for (const [t, was, mesh, meshWas] of veiled) {
      if (!t.destroyed) t.visible = was;
      if (mesh && !mesh.destroyed) mesh.visible = meshWas;
    }
    invalidateViewCaches();
  }
  // bez potrzeby kadru zdjęcie multi to ten sam widok co ekran — najazdu nie ma (`crop` = cały ekran)
  if (photo && !needCrop) return { photo, cover: null, crop: null, bg, shots };
  return photo ? { photo, cover, crop, bg, shots } : { photo: cover, cover: null, crop: null, bg, shots };
}

/**
 * Token widoczny dla TEGO klienta w chwili zrzutu: `visible` liczy rdzeń v14 (Token#isVisible: ukryte tylko dla MG,
 * wizja tokenów, mgła, poziomy sceny), siatka (mesh) faktycznie rysowana. Ukrytych tokenów nie fotografujemy także
 * u MG (MG widzi je półprzezroczyste, ale to nie jest „zdarzenie” dla gazety). Podglądy przeciągania — nigdy.
 */
function seenToken(t) {
  if (!t || t.destroyed || t.isPreview || !t.visible || t.renderable === false) return false;
  if (t.document?.hidden) return false;
  if (t.mesh && (!t.mesh.visible || t.mesh.worldAlpha === 0)) return false;
  return (t.document?.alpha ?? 1) > 0.05;
}

/**
 * Tryb multi: fotograf. Tokeny widoczne dla tego klienta (seenToken) łączą się w grupy po bliskości (clusterRects: odstęp
 * ≤ 2,5 pola siatki = jedna grupa; najwyżej SHOT_CAP[wygląd] grup, od najliczniejszej). Każda grupa → kadr w proporcjach
 * ekranu z marginesem, w całości w obrazie sceny (shotFrame), render sceny z kamerą na tym kadrze. Grupa, której kadr to
 * praktycznie całe zdjęcie sceny, odpada (byłaby powtórzeniem). Bez grup — dwa miejsca z największą ilością szczegółów
 * na zdjęciu sceny (detailSpots), też jako osobne rendery (ostre, nie powiększony zrzut).
 * Zwraca [{image, focus, aspect, pos, rect, kind, count, ms}] od najważniejszego.
 */
function captureShots(style, { est, scene, aspect, establishing, renderAt, outW, width, safe }) {
  const cap = SHOT_CAP[style] ?? SHOT_CAP.classic;
  const grid = canvas.dimensions?.size || canvas.grid?.size || 100;
  const rects = [];
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!seenToken(t)) continue;
    const b = t.bounds;
    const x0 = Math.max(b.x, scene.x), y0 = Math.max(b.y, scene.y), x1 = Math.min(b.x + b.width, scene.x + scene.w), y1 = Math.min(b.y + b.height, scene.y + scene.h);
    if (x1 - x0 > 1 && y1 - y0 > 1) rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  // plan średni: szerokość kadru ≥ 4,5 pola i ≥ tyle, żeby mapa nie była powiększona ponad 2× (rozmyta tekstura)
  const minW = Math.max(4.5 * grid, outW / 2);
  // kadr praktycznie równy zdjęciu sceny (≥ 80 % szerokości) odpada — byłby powtórzeniem
  const framed = (gs) => gs.map((g) => ({ g, s: shotFrame(g.rect, scene, aspect, { pad: 0.6 * grid, minW, safe }) })).filter(({ s }) => s.frame.w < 0.8 * est.w);
  let picked = framed(clusterRects(rects, 2.5 * grid, cap));
  // dociąganie grup (gdy jest ich za dużo) dało za szeroki kadr → najliczniejsze grupy bez dociągania
  if (picked.length < cap) { const loose = framed(clusterRects(rects, 2.5 * grid, Infinity)).slice(0, cap); if (loose.length > picked.length) picked = loose; }
  const subjects = picked.map(({ g, s }) => ({ ...s, kind: "group", count: g.count, aspect: (s.focus.w * s.frame.w) / (s.focus.h * s.frame.h) }));
  if (!subjects.length) {
    for (const n of detailSpots(establishing, Math.min(cap, 2))) {
      const frame = { x: est.x + n.x * est.w, y: est.y + n.y * est.h, w: n.w * est.w, h: (n.w * est.w) / aspect };
      subjects.push({ frame, focus: { x: 0.15, y: 0.15, w: 0.7, h: 0.7 }, kind: "detail", count: 0, aspect });
    }
  }
  const resolution = Math.min(globalThis.devicePixelRatio || 1, outW / width);
  return subjects.map((s) => {
    const t0 = performance.now();
    const image = renderAt(s.frame, resolution);
    return { image, focus: s.focus, aspect: s.aspect, kind: s.kind, count: s.count, ms: Math.round(performance.now() - t0),
      pos: { x: (s.frame.x + s.frame.w / 2 - est.x) / est.w, y: (s.frame.y + s.frame.h / 2 - est.y) / est.h },
      // kadr w układzie zdjęcia sceny (0…1) — kamera sesji fotografa przerzuca się dokładnie na niego
      rect: { x: (s.frame.x - est.x) / est.w, y: (s.frame.y - est.y) / est.h, w: s.frame.w / est.w, h: s.frame.h / est.h } };
  });
}

/**
 * Kamera nowej sceny przy odsłonie: kadr bez tła poza sceną (coverView — przybliża tylko, gdy widok pokazywałby tło),
 * kamera startuje REVEAL_ZOOM bliżej i osiada na nim w czasie odlotu strony (wspólny start = ta sama chwila u wszystkich,
 * każdy klient liczy własny widok). Ograniczony ruch: od razu docelowy kadr, bez ruchu. Po przejściu kamera należy do gracza.
 * `animate` = false → tylko ustaw docelowy kadr (pominięcie przejścia).
 */
function frameRevealCamera({ animate = true, durationMs = 2000 } = {}) {
  try {
    if (!canvas?.ready || !canvas.stage || !canvas.dimensions?.sceneRect) return null;
    const sr = canvas.dimensions.sceneRect, st = canvas.stage, scr = canvas.app.renderer.screen;
    const rect = { x: sr.x, y: sr.y, w: sr.width, h: sr.height };
    const screen = { w: scr.width, h: scr.height };
    const max = canvas.dimensions.scale?.max ?? Infinity;
    const target = coverView({ x: st.pivot.x, y: st.pivot.y, scale: st.scale.x }, rect, screen, max);
    if (!animate) { canvas.pan(target); return null; }
    const startScale = Math.min(Math.max(max, target.scale), target.scale * REVEAL_ZOOM);
    canvas.pan(coverView({ x: target.x, y: target.y, scale: startScale }, rect, screen, max));
    return canvas.animatePan({ ...target, duration: durationMs, easing: cameraEase });
  } catch (e) {
    console.warn(`${MODULE_ID} | gazeta: kamera odsłony`, e);
    return null;
  }
}

function makeOverlay() {
  const o = document.createElement("div");
  // ta sama warstwa co przejście reveal: pod interfejsem Foundry, nad płótnem; tło przezroczyste (pod spodem żywa scena)
  o.className = "sketch-reveal-overlay sr-transition sr-newspaper";
  o.style.setProperty("--sr-cover", "transparent");
  o.style.cursor = "default";
  document.body.append(o);
  return o;
}

/** Uruchom gazetę na bieżącym widoku: zrzut + zasłona od razu, potem uformowanie strony. */
function stage(data, { sceneId = null, preview = false } = {}) {
  cancelNewspaper();
  const t0 = performance.now();
  let shot;
  const b = uiBounds();
  try { shot = captureView({ shots: data.shots === "multi" ? data.style : null, safe: { left: b.left, right: b.right, bottom: b.bottom, top: 16 } }); }
  catch (e) { console.warn(`${MODULE_ID} | gazeta: zrzut płótna nieudany`, e); return null; }
  const { photo, cover, crop, bg, shots } = shot;
  const captureMs = performance.now() - t0;
  const overlay = makeOverlay();
  const perf = clientPerf();
  const np = createNewspaper({
    host: overlay, photo, cover, crop, coverBg: bg, data, shots, family: FONT, sansFamily: SANS, condFamily: COND,
    reduced: prefersReducedMotion(),
    // lżejsza wersja (bez smug, mniejsza rozdzielczość strony) przy lekkich animacjach albo obniżonym podglądzie
    lite: perf.liteTitle || perf.preview !== "full",
    safe: { left: b.left, right: b.right, bottom: b.bottom, top: 16 },
  });
  const t = { np, overlay, sceneId, syncId: null, attached: preview, preview, closed: false, guard: 0, onKey: null, framed: false };
  t.close = (fast = true) => {
    if (t.closed) return;
    t.closed = true;
    clearTimeout(t.guard);
    if (t.onKey) document.removeEventListener("keydown", t.onKey, true);
    np.close(fast).finally(() => overlay.remove());
    if (cur === t) cur = null;
  };
  // zabezpieczenie: scena nie dojechała do canvasReady (błąd rysowania) — nie zostawiaj zasłony na zawsze
  t.guard = setTimeout(() => { if (cur === t && !t.running) t.close(false); }, GUARD_MS);
  last = { captureMs: Math.round(captureMs), photo: `${photo.width}×${photo.height}`, pushIn: np.stats.pushIn, crop: crop && { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w), h: Math.round(crop.h) }, sceneId, preview, reduced: np.stats.reduced, lite: np.stats.lite,
    // tryb multi: co sfotografowano (rodzaj, liczba tokenów, czas renderu, rozmiar) i ile trwa sesja
    shots: shots?.map((s) => ({ kind: s.kind, count: s.count, ms: s.ms, size: `${s.image.width}×${s.image.height}` })) ?? null, shootMs: np.stats.shootMs };
  np.ready.then((ok) => { last.buildMs = np.stats.buildMs; last.pageW = np.stats.pageW; if (!ok) t.close(true); });
  t.pressed = np.press().then(() => new Promise((r) => setTimeout(r, HOLD_MS)));
  cur = t;
  return t;
}

/** Hook canvasTearDown: stara scena jeszcze stoi — zrób zrzut i zasłoń, jeśli następna scena gra gazetę. */
export function onTearDownNewspaper(options) {
  const next = options?.nextScene;
  cancelNewspaper();
  if (!next || next.id === canvas.scene?.id) return; // przeładowanie tej samej sceny nie odpala przejścia
  const r = resolveNewspaperFor(next);
  if (!r) return;
  stage(r.newspaper, { sceneId: next.id });
}

/**
 * Hook canvasInit dla sceny z gazetą: dopnij id wspólnego startu. Gdy zrzutu nie ma (pierwsze wejście do świata, płótno
 * było puste), ten klient nic nie gra — ale zgłasza gotowość, żeby nie blokować innych w barierze.
 */
export function attachNewspaper(scene, syncId) {
  if (!cur || cur.preview || cur.sceneId !== scene.id) {
    if (!cur?.preview) cancelNewspaper();
    if (syncId) transitionReadyOnly(syncId);
    return false;
  }
  cur.syncId = syncId;
  cur.attached = true;
  if (syncId) prepareTransitionSync(syncId);
  return true;
}

/** Hook canvasReady: nowa scena narysowana pod zasłoną → po uformowaniu strony wspólny start odlotu. */
export async function runNewspaper() {
  const t = cur;
  if (!t || t.preview || !t.attached || t.running) return;
  t.running = true;
  clearTimeout(t.guard);
  const cfg = t.np.data;
  const canSkip = () => game.user.isGM || !!cfg.playerSkip || !game.users.activeGM;
  t.onKey = (e) => { if (e.key === "Escape" && canSkip() && !t.closed) { e.preventDefault(); e.stopPropagation(); t.close(true); } };
  document.addEventListener("keydown", t.onKey, true);
  if (canSkip()) { t.overlay.style.pointerEvents = "auto"; t.overlay.style.cursor = "pointer"; t.overlay.addEventListener("click", () => t.close(true)); }
  else t.overlay.style.pointerEvents = "none"; // gracz bez prawa pominięcia: kliki przechodzą do sceny pod spodem
  try {
    await t.pressed;
    if (t.closed) return;
    const w0 = performance.now();
    if (t.syncId) await awaitTransitionGo(t.syncId, () => t.closed); // zgłasza gotowość i czeka na wspólny czas startu
    last.waitMs = Math.round(performance.now() - w0);
    if (t.closed) return;
    const s0 = performance.now();
    revealCamera(t);
    await t.np.spin();
    last.spinMs = Math.round(performance.now() - s0);
  } catch (e) {
    console.error(`${MODULE_ID} | gazeta`, e);
  } finally {
    // pominięte przed odlotem: nowa scena i tak bez tła poza sceną (kadr od razu, bez ruchu)
    if (!t.framed && canvas?.ready && canvas.scene?.id === t.sceneId) { t.framed = true; frameRevealCamera({ animate: false }); }
    if (cur === t) { if (t.onKey) document.removeEventListener("keydown", t.onKey, true); t.overlay.remove(); cur = null; }
  }
}

/** Start odlotu = start kamery odsłony (pod tłem starej sceny, które gaśnie w trakcie odlotu). */
function revealCamera(t) {
  if (t.framed) return;
  t.framed = true;
  const reduced = t.np.stats.reduced;
  const p = frameRevealCamera({ animate: !reduced, durationMs: revealCameraMs(t.np.data.spinSec) });
  last.camera = canvas?.stage ? { reduced, scale: +canvas.stage.scale.x.toFixed(4) } : null;
  p?.then?.(() => { if (canvas?.stage) last.cameraEnd = { x: Math.round(canvas.stage.pivot.x), y: Math.round(canvas.stage.pivot.y), scale: +canvas.stage.scale.x.toFixed(4) }; });
}

export function cancelNewspaper() {
  const t = cur;
  if (!t) return;
  cur = null;
  t.closed = true;
  clearTimeout(t.guard);
  if (t.onKey) document.removeEventListener("keydown", t.onKey, true);
  t.np.dispose(); t.overlay.remove();
}

/**
 * Podgląd na bieżącym widoku bez zmiany sceny (menedżer, edytor, zakładka sceny, konsola): zrzut → strona → odlot,
 * pod spodem ta sama scena. `raw` — preset (id) albo obiekt konfiguracji gazety.
 */
export async function previewNewspaper(raw = DEFAULT_NEWSPAPER) {
  const data = typeof raw === "string" ? getPreset(raw)?.newspaper : raw;
  if (!data) return ui.notifications?.warn(L("Macro.Missing"));
  if (!canvas?.ready || !canvas.scene) return ui.notifications?.warn(L("Newspaper.NoCanvas"));
  const t = stage(sanitizeNewspaper(data), { preview: true });
  if (!t) return;
  t.running = true;
  clearTimeout(t.guard);
  t.onKey = (e) => { if (e.key === "Escape" && !t.closed) { e.preventDefault(); e.stopPropagation(); t.close(true); } };
  document.addEventListener("keydown", t.onKey, true);
  try {
    await t.pressed;
    if (t.closed) return;
    const s0 = performance.now();
    revealCamera(t);
    await t.np.spin();
    last.spinMs = Math.round(performance.now() - s0);
  } finally {
    if (cur === t) { document.removeEventListener("keydown", t.onKey, true); t.overlay.remove(); cur = null; }
  }
}

/** Krój strony: rozgrzej przy starcie, żeby pierwsza gazeta nie czekała na plik czcionki. */
export function warmNewspaperFont() { ensurePaperFont(FONT, 4000); ensurePaperFont(SANS, 4000); ensurePaperFont(COND, 4000); }

/** Do testów z konsoli: ostatni przebieg (czasy zrzutu, budowy, czekania, odlotu) i stan bieżący. */
export const newspaperDebug = () => ({ ...last, active: !!cur, sceneId: cur?.sceneId ?? null, syncId: cur?.syncId ?? null, preview: cur?.preview ?? null });

// „Zamknij u wszystkich” (play.mjs) zamyka też gazetę
Hooks.on("sketchReveal.closeAll", () => cur?.close(true));

/* ---------------------------------------------------------------- formularz edytora */
const group = (label, inner, hint = "", extra = "") =>
  `<div class="form-group"${extra}><label>${esc(label)}</label><div class="form-fields">${inner}</div>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</div>`;
const select = (name, v, opts) =>
  `<select name="${name}">${opts.map(([val, lab]) => `<option value="${esc(val)}"${String(val) === String(v) ? " selected" : ""}>${esc(lab)}</option>`).join("")}</select>`;

/**
 * Szkic pierwszej strony — pola pisze się jak tekst, nie jak formularz: winieta, linia z miejscem i datą, baner, nagłówek,
 * podtytuł, podpis zdjęcia i nagłówki pozostałych artykułów (rubryki z lewej mówią, gdzie trafi każdy wiersz).
 * `prefix` — prefiks nazw pól („newspaper” w edytorze, „flags.sketch-reveal.newspaper” w zakładce sceny), `values` — wpisany
 * tekst, `ph` — tekst, który wydrukuje się przy pustym polu (szary), `style` — wygląd (rubryki nagłówków listy).
 */
export function newspaperDraftHtml({ prefix, values = {}, ph, style = "classic", kickerPh = "", accent = DEFAULT_NEWSPAPER.accent, legend, hint = "", extra = "", shotsLabel = null }) {
  const Lm = NEWSPAPER_LIMITS;
  const uid = foundry.utils.randomID(6);
  let k = 0;
  const field = (name, value, placeholder, max, multi = false) => {
    const id = `sr-np-${uid}-${k++}`;
    const common = `id="${id}" class="sr-np-in" name="${prefix}.${name}" data-np="${name}" maxlength="${max}" placeholder="${esc(placeholder)}" spellcheck="true"`;
    return { id, html: multi ? `<textarea ${common} rows="1">${esc(value)}</textarea>` : `<input type="text" ${common} value="${esc(value)}">` };
  };
  const row = (cls, label, f) => `<div class="sr-np-row sr-np-${cls}"><label class="sr-np-slug" for="${f.id}">${esc(label)}</label>${f.html}</div>`;
  const slots = NEWSPAPER_SLOTS[style] ?? NEWSPAPER_SLOTS.classic;
  const stories = Array.from({ length: Lm.stories }, (_, i) =>
    row("story", L(`NewsSlot.${slots[i]}`), field(`stories.${i}`, values.stories?.[i] ?? "", ph.stories[i] ?? "", Lm.story))).join("");
  return `
  <fieldset class="sr-newspaper-form sr-np-draft" data-sr="newspaper-draft" data-style="${esc(style)}" style="--sr-accent: ${esc(accent)}"${extra}>
    <legend>${esc(legend)}</legend>
    ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}
    ${shotsLabel ? group(L("Field.Shots"), `<select name="${prefix}.shots" data-np="shots">${[["", shotsLabel], ["single", L("Shots.single")], ["multi", L("Shots.multi")]]
    .map(([v, lab]) => `<option value="${v}"${(values.shots ?? "") === v ? " selected" : ""}>${esc(lab)}</option>`).join("")}</select>`, L("Hint.SceneShots")) : ""}
    <div class="sr-np-sheet">
      ${row("masthead", L("NewsField.masthead"), field("masthead", values.masthead ?? "", ph.masthead, Lm.masthead))}
      ${row("place", L("NewsField.place"), field("place", values.place ?? "", ph.place, Lm.place))}
      ${row("date", L("NewsField.date"), field("date", values.date ?? "", ph.date, Lm.date))}
      ${row("kicker", L("NewsField.kicker"), field("kicker", values.kicker ?? "", kickerPh, Lm.kicker))}
      ${row("headline", L("NewsField.headline"), field("headline", values.headline ?? "", ph.headline, Lm.headline, true))}
      ${row("deck", L("NewsField.deck"), field("deck", values.deck ?? "", ph.deck, Lm.deck, true))}
      ${row("caption", L("NewsField.caption"), field("caption", values.caption ?? "", ph.caption, Lm.caption, true))}
      <p class="sr-np-divider">${esc(L("NewsDraft.Stories"))}</p>
      ${stories}
    </div>
  </fieldset>`;
}

/** Placeholdery szkicu w edytorze presetu: teksty domyślne wyglądu (to wydrukuje się przy pustym polu). */
const presetPh = (style) => ({ ...(NEWSPAPER_DEFAULT_TEXT[style] ?? NEWSPAPER_DEFAULT_TEXT.classic), date: usDate() });

/**
 * Ożyw szkic w `root`: pola wieloliniowe rosną z tekstem (Enter nie łamie — nagłówek to jeden akapit, wklejone podziały
 * wierszy → spacje). Zwraca refresh(): `resolve()` → {style, ph, kickerPh, accent} odświeża rubryki i szare podpowiedzi.
 */
export function bindNewspaperDraft(root, resolve = null) {
  const draft = root?.querySelector?.('[data-sr="newspaper-draft"]');
  if (!draft) return null;
  const grow = (t) => { t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; };
  for (const t of draft.querySelectorAll("textarea.sr-np-in")) {
    t.addEventListener("input", () => grow(t));
    t.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    t.addEventListener("paste", (e) => {
      const txt = e.clipboardData?.getData("text");
      if (!txt || !/[\r\n]/.test(txt)) return;
      e.preventDefault();
      t.setRangeText(txt.replace(/\s*[\r\n]+\s*/g, " "), t.selectionStart, t.selectionEnd, "end");
      t.dispatchEvent(new Event("input", { bubbles: true }));
    });
    requestAnimationFrame(() => grow(t));
  }
  const refresh = () => {
    const r = resolve?.();
    if (!r) return;
    draft.dataset.style = r.style;
    if (r.accent) draft.style.setProperty("--sr-accent", r.accent);
    const slots = NEWSPAPER_SLOTS[r.style] ?? NEWSPAPER_SLOTS.classic;
    for (const el of draft.querySelectorAll("[data-np]")) {
      const key = el.dataset.np, m = /^stories\.(\d+)$/.exec(key);
      if (el.tagName === "SELECT") { if (r.shotsLabel && el.options[0]) el.options[0].textContent = r.shotsLabel; continue; }
      if (m) {
        el.placeholder = r.ph.stories[+m[1]] ?? "";
        const lab = draft.querySelector(`label[for="${el.id}"]`);
        if (lab) lab.textContent = L(`NewsSlot.${slots[+m[1]]}`);
      } else el.placeholder = key === "kicker" ? r.kickerPh ?? "" : r.ph[key] ?? "";
    }
  };
  return refresh;
}

/** Edytor presetu: szkic pierwszej strony podąża za wyglądem (rubryki, teksty domyślne) i kolorem akcentu. */
export function bindNewspaperForm(root) {
  const val = (sel) => root.querySelector(sel)?.value;
  const style = () => val('select[name="newspaper.style"]') ?? "classic";
  const refresh = bindNewspaperDraft(root, () => ({ style: style(), ph: presetPh(style()), kickerPh: L("NewsDraft.NoKicker"), accent: val('input[name="newspaper.accent"]') }));
  if (!refresh) return;
  root.querySelector('select[name="newspaper.style"]')?.addEventListener("change", refresh);
  root.querySelector('input[name="newspaper.accent"]')?.addEventListener("input", refresh);
}

/** Placeholdery zakładki sceny: tekst, który wydrukuje preset (puste pole sceny = tekst presetu). */
export function sceneDraftPlaceholders(presetNewspaper) {
  const n = sanitizeNewspaper(presetNewspaper);
  const t = newspaperText(n);
  return { style: n.style, accent: n.accent, ph: { ...t, date: n.date || usDate() }, kickerPh: n.kicker || L("NewsDraft.NoKicker"),
    shotsLabel: L("Shots.AsPreset", { mode: L(`Shots.${n.shots}`) }) };
}

/** HTML sekcji gazety (pola pod prefiksem "newspaper."; marker data-sr="newspaper" mówi edytorowi, że sekcja jest w DOM). */
export function newspaperFormHtml(raw) {
  const n = sanitizeNewspaper(raw);
  const range = (k, min, max, step) => `<range-picker name="newspaper.${k}" value="${n[k]}" min="${min}" max="${max}" step="${step}"></range-picker>`;
  return `
  <fieldset class="sr-newspaper-form" data-sr="newspaper"><legend>${esc(L("Section.Newspaper"))}</legend>
    <p class="hint">${esc(L("Hint.Newspaper"))}</p>
    ${group(L("Field.PaperStyle"), select("newspaper.style", n.style, [["classic", L("PaperStyle.classic")], ["modern", L("PaperStyle.modern")]]), L("Hint.PaperStyle"))}
    ${group(L("Field.PaperColor"), `<input type="color" name="newspaper.paper" value="${esc(n.paper)}">`, "", ' data-showif="newspaper.style" data-showif-is="classic"')}
    ${group(L("Field.Accent"), `<input type="color" name="newspaper.accent" value="${esc(n.accent)}">`, L("Hint.PaperAccent"))}
    ${group(L("Field.Shots"), select("newspaper.shots", n.shots, [["single", L("Shots.single")], ["multi", L("Shots.multi")]]), L("Hint.Shots"))}
  </fieldset>
  ${newspaperDraftHtml({ prefix: "newspaper", values: n, ph: presetPh(n.style), style: n.style, kickerPh: L("NewsDraft.NoKicker"), accent: n.accent, legend: L("NewsDraft.Legend"), hint: L("NewsDraft.Hint") })}
  <fieldset class="sr-newspaper-form"><legend>${esc(L("Section.Spin"))}</legend>
    ${group(L("Field.SpinSec"), range("spinSec", 1, 5, 0.1), L("Hint.SpinSec"))}
    ${group(L("Field.Turns"), range("turns", 1, 6, 1))}
    ${group(L("Field.SpinDir"), select("newspaper.direction", n.direction, [["cw", L("Dir.cw")], ["ccw", L("Dir.ccw")]]))}
    ${group(L("Field.PlayerSkip"), `<input type="checkbox" name="newspaper.playerSkip"${n.playerSkip ? " checked" : ""}>`, L("Hint.NewsSkip"))}
  </fieldset>`;
}

/* „Wirująca gazeta” w Foundry: zrzut płótna tuż przed zburzeniem starej sceny, zasłona przez całe ładowanie nowej,
   wspólny start odlotu (ta sama bariera co przejścia reveal), podgląd bez zmiany sceny, formularz edytora.

   Kolejność w v14 (Canvas#draw): canvasTearDown(canvas, {nextScene}) — warstwy starej sceny jeszcze istnieją, root ukryty,
   ale renderowalny → TU robimy zrzut i od razu kładziemy zasłonę (pierwsza klatka = dokładnie to, co było na ekranie)
   → canvasInit (nowa scena, przypisujemy syncId) → canvasReady (nowa scena narysowana pod zasłoną) → po uformowaniu strony
   zgłaszamy gotowość, czekamy na „tgo” i odlatujemy. Każdy klient fotografuje SWÓJ widok (własna kamera, mgła, tokeny). */
import { MODULE_ID } from "./config.mjs";
import {
  DEFAULT_NEWSPAPER, HOLD_MS, NEWSPAPER_LIMITS, cameraEase, coverView, createNewspaper, ensurePaperFont, photoCrop, prefersReducedMotion,
  REVEAL_ZOOM, revealCameraMs, sameRect, sanitizeNewspaper,
} from "./fx/newspaper.mjs";
import { awaitTransitionGo, prepareTransitionSync, transitionReadyOnly } from "./play.mjs";
import { clientPerf, getPreset, resolveNewspaper } from "./store.mjs";
import { uiBounds } from "./ticker-play.mjs";

const L = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const FONT = "Amiri"; // krój szeryfowy z rdzenia Foundry (/fonts/amiri, deklarowany w CSS rdzenia) — bez pobierania
const SANS = "Signika"; // bezszeryfowy krój rdzenia Foundry — tytuły współczesnej gazety
const GUARD_MS = 45000;
const CAPTURE_MAX_W = 1920;

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
 * Zwraca { photo, cover|null, crop (px ekranu)|null, bg }.
 */
export function captureView() {
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
  const shot = () => {
    const rt = PIXI.RenderTexture.create({ width, height, resolution: res });
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
  if (!sr || !(sr.width > 0) || !(sr.height > 0) || !(scale > 0)) return { photo: cover, cover: null, crop: null, bg };
  // widok w jednostkach świata (pivot = punkt świata w miejscu stage.position)
  const view = { x: st.pivot.x - st.position.x / scale, y: st.pivot.y - st.position.y / scale, w: width / scale, h: height / scale };
  const c = photoCrop(view, { x: sr.x, y: sr.y, w: sr.width, h: sr.height }, width / height);
  const crop = { x: (c.x - view.x) * scale, y: (c.y - view.y) * scale, w: c.w * scale, h: c.h * scale };
  if (sameRect(crop, { x: 0, y: 0, w: width, h: height }, 1)) return { photo: cover, cover: null, crop: null, bg };
  // drugi render: kamera na kadrze (bez Canvas#pan — żadnych hooków ani zapisu pozycji widoku sceny)
  const saved = { px: st.pivot.x, py: st.pivot.y, sx: st.scale.x, sy: st.scale.y, x: st.position.x, y: st.position.y };
  let photo;
  try {
    const k = width / c.w;
    st.pivot.set(c.x + c.w / 2, c.y + c.h / 2);
    st.scale.set(k, k);
    st.position.set(width / 2, height / 2);
    invalidateViewCaches();
    photo = shot();
  } catch (e) {
    console.warn(`${MODULE_ID} | gazeta: kadr bez tła nieudany, zostaje zwykły zrzut`, e);
  } finally {
    st.pivot.set(saved.px, saved.py); st.scale.set(saved.sx, saved.sy); st.position.set(saved.x, saved.y);
    invalidateViewCaches();
  }
  return photo ? { photo, cover, crop, bg } : { photo: cover, cover: null, crop: null, bg };
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
  try { shot = captureView(); } catch (e) { console.warn(`${MODULE_ID} | gazeta: zrzut płótna nieudany`, e); return null; }
  const { photo, cover, crop, bg } = shot;
  const captureMs = performance.now() - t0;
  const overlay = makeOverlay();
  const perf = clientPerf();
  const b = uiBounds();
  const np = createNewspaper({
    host: overlay, photo, cover, crop, coverBg: bg, data, family: FONT, sansFamily: SANS,
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
  last = { captureMs: Math.round(captureMs), photo: `${photo.width}×${photo.height}`, pushIn: np.stats.pushIn, crop: crop && { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w), h: Math.round(crop.h) }, sceneId, preview, reduced: np.stats.reduced, lite: np.stats.lite };
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
export function warmNewspaperFont() { ensurePaperFont(FONT, 4000); ensurePaperFont(SANS, 4000); }

/** Do testów z konsoli: ostatni przebieg (czasy zrzutu, budowy, czekania, odlotu) i stan bieżący. */
export const newspaperDebug = () => ({ ...last, active: !!cur, sceneId: cur?.sceneId ?? null, syncId: cur?.syncId ?? null, preview: cur?.preview ?? null });

// „Zamknij u wszystkich” (play.mjs) zamyka też gazetę
Hooks.on("sketchReveal.closeAll", () => cur?.close(true));

/* ---------------------------------------------------------------- formularz edytora */
const group = (label, inner, hint = "", extra = "") =>
  `<div class="form-group"${extra}><label>${esc(label)}</label><div class="form-fields">${inner}</div>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</div>`;
const select = (name, v, opts) =>
  `<select name="${name}">${opts.map(([val, lab]) => `<option value="${esc(val)}"${String(val) === String(v) ? " selected" : ""}>${esc(lab)}</option>`).join("")}</select>`;

/** HTML sekcji gazety (pola pod prefiksem "newspaper."; marker data-sr="newspaper" mówi edytorowi, że sekcja jest w DOM). */
export function newspaperFormHtml(raw) {
  const n = sanitizeNewspaper(raw);
  const range = (k, min, max, step) => `<range-picker name="newspaper.${k}" value="${n[k]}" min="${min}" max="${max}" step="${step}"></range-picker>`;
  return `
  <fieldset class="sr-newspaper-form" data-sr="newspaper"><legend>${esc(L("Section.Newspaper"))}</legend>
    <p class="hint">${esc(L("Hint.Newspaper"))}</p>
    ${group(L("Field.PaperStyle"), select("newspaper.style", n.style, [["classic", L("PaperStyle.classic")], ["modern", L("PaperStyle.modern")]]), L("Hint.PaperStyle"))}
    ${group(L("Field.Masthead"), `<input type="text" name="newspaper.masthead" maxlength="${NEWSPAPER_LIMITS.masthead}" value="${esc(n.masthead)}" placeholder="${esc(L("Field.MastheadPh"))}">`, L("Hint.Masthead"))}
    ${group(L("Field.PaperHeadline"), `<input type="text" name="newspaper.headline" maxlength="${NEWSPAPER_LIMITS.headline}" value="${esc(n.headline)}" placeholder="${esc(L("Field.PaperHeadlinePh"))}">`, L("Hint.PaperHeadline"))}
    ${group(L("Field.PaperColor"), `<input type="color" name="newspaper.paper" value="${esc(n.paper)}">`, "", ' data-showif="newspaper.style" data-showif-is="classic"')}
    ${group(L("Field.Accent"), `<input type="color" name="newspaper.accent" value="${esc(n.accent)}">`, L("Hint.PaperAccent"), ' data-showif="newspaper.style" data-showif-is="modern"')}
  </fieldset>
  <fieldset class="sr-newspaper-form"><legend>${esc(L("Section.Spin"))}</legend>
    ${group(L("Field.SpinSec"), range("spinSec", 1, 5, 0.1), L("Hint.SpinSec"))}
    ${group(L("Field.Turns"), range("turns", 1, 6, 1))}
    ${group(L("Field.SpinDir"), select("newspaper.direction", n.direction, [["cw", L("Dir.cw")], ["ccw", L("Dir.ccw")]]))}
    ${group(L("Field.PlayerSkip"), `<input type="checkbox" name="newspaper.playerSkip"${n.playerSkip ? " checked" : ""}>`, L("Hint.NewsSkip"))}
  </fieldset>`;
}

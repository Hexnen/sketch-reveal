/* Odtwarzacz reveal w czystym DOM/WebGL (bez Reacta i Foundry): port useRevealTimeline + useEffectCanvas +
   useSketchIntro + useGlow + kamera/ślad szkicu/napis z harnessu (roleplay, gałąź feat/foundry-sketch-reveal).
   Oś czasu: [faza szkicu 0..sec] → kolor startuje w colorAt% szkicu i trwa `duration` efektu → rozbłysk od from% koloru.
   Warstwy w wrapperze kamery (stacking context): efekt, ślad szkicu, rozbłysk, nakładka szkicu; napis poza kamerą. */
import * as Core from "../vendor/reveal-core.js";
import { effectParamsOf } from "./config.mjs";
import { cameraActive, cameraMax, createCamera, oversampleStyle, swayActive } from "./fx/camera.mjs";
import { GLOW_DEFAULT_OPTS, createCoverageProvider, createGlowLayer, glowAt, sanitizeGlow } from "./fx/glow.mjs";
import {
  DEFAULT_PERF, createAutoQuality, createFpsBadge, createFpsMeter, createFrameGate, previewSide, sanitizePerf,
} from "./fx/perf.mjs";
import { createResidue, sceneIsolation } from "./fx/residue.mjs";
import { createTitle } from "./fx/title.mjs";

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/* ---------------------------------------------------------------- obrazy */
let maxSideCache = 0;
export function revealMaxSide() {
  if (maxSideCache) return maxSideCache;
  maxSideCache = 4096;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (gl) { maxSideCache = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE)); gl.getExtension("WEBGL_lose_context")?.loseContext(); }
  } catch { /* zostaje 4096 */ }
  return maxSideCache;
}

async function loadImage(src) {
  const img = new Image();
  img.decoding = "async";
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  return img;
}

const imgW = (s) => s.naturalWidth || s.width;
const imgH = (s) => s.naturalHeight || s.height;

/* Obrazy (dev/perf-audit.md F2/F3/F6). Źródłem dla wszystkich warstw zostaje <img> jak dawniej (rysunki 2D w analizach
   i skalowaniu dają z <img> inne piksele niż z ImageBitmap przy dużym pomniejszeniu), ale:
   - plik jest pobierany raz (fetch → Blob, pamięć niżej) i <img> dekoduje go z blob URL — bez drugiego żądania;
   - dla obrazów, których tekstura z ImageBitmap jest bajt w bajt ta sama (bitmapSafe), rdzeń dostaje bliźniaka do
     texImage2D (setUploadTwin): upload 7–8× szybszy, bo Chromium konwertuje <img> przy KAŻDYM texImage2D. */
const BMP_OPTS = { premultiplyAlpha: "none", colorSpaceConversion: "default", imageOrientation: "from-image" };

/* Pamięć pobranych plików (Blob, nie zdekodowane piksele): rozgrzewka (preloadImages) i powtórki tego samego obrazu nie
   pobierają go ponownie (Foundry wysyła `Cache-Control: no-store`, więc cache HTTP nie pomaga). Ten sam obiekt Blob =
   te same bajty, więc służy też za identyfikator zawartości (tusz szkicu liczony raz — F7). */
const BLOB_TTL_MS = 10 * 60_000, BLOB_MAX_BYTES = 160 * 1024 * 1024;
const blobCache = new Map(); // absolutny URL → { p: Promise<Blob>, at, size }
const absUrl = (u) => { try { return new URL(u, location.href).href; } catch { return String(u); } };
function pruneBlobs() {
  const now = performance.now();
  let total = 0;
  for (const [k, e] of [...blobCache].reverse()) { // od najnowszych
    if (now - e.at > BLOB_TTL_MS || (total += e.size) > BLOB_MAX_BYTES) blobCache.delete(k);
  }
}
/** Plik obrazu jako Blob (z pamięci, gdy świeży). Te same zasady co <img crossOrigin="anonymous">: CORS, ciasteczka tylko same-origin. */
export function fetchImageBlob(url) {
  const key = absUrl(url);
  const cacheable = /^https?:/i.test(key);
  if (cacheable) {
    pruneBlobs();
    const hit = blobCache.get(key);
    if (hit) { blobCache.delete(key); blobCache.set(key, hit); return hit.p; }
  }
  const e = { at: performance.now(), size: 0, p: null };
  e.p = fetch(key, { mode: "cors", credentials: "same-origin" })
    // arrayBuffer → Blob zamiast r.blob(): duże odpowiedzi (> ~10 MB) w r.blob() kończyły się „Failed to fetch” (Edge headless)
    .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return new Blob([await r.arrayBuffer()], { type: r.headers.get("content-type") || "" }); })
    .then((b) => { e.size = b.size; if (cacheable) pruneBlobs(); return b; }, (err) => { if (blobCache.get(key) === e) blobCache.delete(key); throw err; });
  if (cacheable) blobCache.set(key, e);
  return e.p;
}

/**
 * Czy tekstura z ImageBitmap tego pliku jest bajt w bajt ta sama co z <img>? Tylko nieprzezroczysty PNG bez zarządzania
 * kolorem (iCCP/cHRM/gAMA/cICP/tRNS) — zmierzone. JPEG (także bez EXIF i ICC), WebP, PNG z alfą lub profilem, AVIF, GIF,
 * SVG… — bez bliźniaka (tam ImageBitmap dawał inne piksele: dekoder, premultiplikacja, konwersja koloru).
 */
export async function bitmapSafe(blob) {
  try {
    const b = new Uint8Array(await blob.slice(0, Math.min(blob.size, 256 * 1024)).arrayBuffer());
    const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (!(b[0] === 0x89 && tag(1).startsWith("PNG")) || tag(12) !== "IHDR" || b[25] === 4 || b[25] === 6) return false; // PNG bez kanału alfa
    for (let o = 8; o + 8 <= b.length;) {
      const n = u32(o), t = tag(o + 4);
      if (t === "iCCP" || t === "cHRM" || t === "gAMA" || t === "cICP" || t === "tRNS") return false;
      if (t === "IDAT" || t === "IEND") return true;
      o += 12 + n;
    }
  } catch { /* */ }
  return false;
}

/** Obraz odtwarzacza: `src` (<img> dla warstw i śladu szkicu), `up` (bliźniak do uploadu albo null). */
function picOf(img, up) {
  if (up && (up.width !== img.naturalWidth || up.height !== img.naturalHeight)) up = null; // na wszelki wypadek
  if (up) Core.setUploadTwin(img, up);
  return { src: img, up };
}

async function loadPic(url, owned) {
  let blob = null;
  try { blob = await fetchImageBlob(url); } catch { /* np. CORS — dawna droga zgłosi ten sam błąd */ }
  if (!blob) return picOf(await loadImage(url), null);
  const u = owned.url(blob);
  const safe = await bitmapSafe(blob);
  const [img, up] = await Promise.all([
    loadImage(u),
    safe ? createImageBitmap(blob, BMP_OPTS).then((b) => owned.bmp(b), () => null) : null,
  ]);
  Core.setImageContentId(img, blob);
  return picOf(img, up);
}

/** Płótno → obraz odtwarzacza dawną drogą (PNG → <img>; źródło rysunków 2D bez zmian); bliźniak z płótna, gdy `twin` (nieprzezroczyste — zmierzone bajt w bajt). */
async function picFromCanvas(c, owned, twin) {
  const up = twin ? await createImageBitmap(c, { premultiplyAlpha: "none" }).then((b) => owned.bmp(b), () => null) : null;
  const img = await canvasToImage(c, owned);
  c.width = 0; c.height = 0;
  return picOf(img, up);
}

/** Obraz > `max` → kopia pomniejszona (wygładzanie „high” jak dawniej); inaczej ten sam obiekt. */
async function fitPic(pic, owned, max = revealMaxSide()) {
  const img = pic.src, W = img.naturalWidth, H = img.naturalHeight, k = max / Math.max(W, H);
  if (!(k < 1)) return pic;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, c.width, c.height);
  return picFromCanvas(c, owned, !!pic.up);
}

async function canvasToImage(c, owned) {
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const url = URL.createObjectURL(blob);
  owned.push(url);
  return loadImage(url);
}

/** Biały arkusz (tryb nakładania): ImageBitmap płótna zamiast PNG (F3) — jednolita biel jest ta sama w każdej drodze (zmierzone). */
async function blankImage(w, h, owned) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  try { const b = owned.bmp(await createImageBitmap(c, { premultiplyAlpha: "none" })); c.width = 0; c.height = 0; return b; } catch { /* */ }
  return canvasToImage(c, owned);
}

/** Zdekodowane piksele zwalniane zaraz po dispose (nie czekają na GC); z zapasem na odroczone zadania warstw. */
function closeLater(bitmaps) {
  if (bitmaps.length) setTimeout(() => { for (const b of bitmaps) try { b.close(); } catch { /* */ } }, 2000);
}

/** Ustąp wątkowi głównemu między krokami budowy warstw (F5): bez rAF — karta w tle nie może wstrzymać przygotowania. */
const yieldTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield()
  : new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); }));

/* ---------------------------------------------------------------- odtwarzacz */
export class RevealPlayer {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container  element sceny (position != static, ma rozmiar)
   * @param {string} o.sketchUrl
   * @param {string} o.paintedUrl
   * @param {object} o.config          zsanityzowana konfiguracja (config.mjs)
   * @param {"contain"|"cover"} [o.fit]
   * @param {object} [o.perf]          ustawienia wydajności klienta (fx/perf.mjs)
   * @param {object[]|null} [o.hints]  podpowiedzi świateł z AI (LightHint[])
   * @param {boolean} [o.hintsStrict]
   */
  constructor({ container, sketchUrl, paintedUrl, config, fit = "contain", perf, hints = null, hintsStrict = false, onPhase = null }) {
    this.onPhase = onPhase; this._ph0 = performance.now();
    this.container = container; this.sketchUrl = sketchUrl; this.paintedUrl = paintedUrl;
    this.cfg = config; this.fit = fit; this.hints = hints; this.hintsStrict = hintsStrict;
    this.perfBase = sanitizePerf(perf ?? DEFAULT_PERF);
    this.perf = this.perfBase;
    this.progress = 0; this.playing = false; this.disposed = false; this._raf = 0; this._over = 0;
    this._owned = {
      disposed: false, urls: [], bitmaps: [],
      push(u) { if (this.disposed) URL.revokeObjectURL(u); else this.urls.push(u); },
      url(blob) { const u = URL.createObjectURL(blob); this.push(u); return u; },
      bmp(b) { if (this.disposed) closeLater([b]); else this.bitmaps.push(b); return b; },
    };
    this._gen = 0; this._done = null; this._side = -1; this._lastM = null; this._liveLast = 0; this._loopOn = false;
    this.meter = createFpsMeter();
    this.finished = new Promise((res) => { this._done = res; });
    this._buildDom();
  }

  /* ---- DOM */
  _buildDom() {
    const mk = (cls) => { const e = document.createElement("div"); e.className = cls; return e; };
    this.frame = mk("sr-frame");          // ramka o proporcjach obrazu (contain/cover względem kontenera)
    this.cam = mk("sr-cam");              // wrapper kamery = stacking context sceny
    this.frame.append(this.cam);
    this.container.append(this.frame);
    this._ro = new ResizeObserver(() => this._layout());
    this._ro.observe(this.container);
  }

  _layout() {
    if (!this.W) return;
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    if (!cw || !ch) return;
    const k = (this.fit === "cover" ? Math.max : Math.min)(cw / this.W, ch / this.H);
    this.frame.style.width = `${this.W * k}px`;
    this.frame.style.height = `${this.H * k}px`;
  }

  /** Diagnostyka: raport fazy przygotowania (czas od startu) — np. przez gniazdo do GM. */
  _ph(name) { try { this.onPhase?.(name, Math.round(performance.now() - this._ph0)); } catch { /* */ } }

  /* ---- przygotowanie */
  async prepare() {
    const cfg = this.cfg;
    this._ph("start");
    const [s0, p0] = await Promise.all([loadPic(this.sketchUrl, this._owned), loadPic(this.paintedUrl, this._owned)]);
    this.uploadTwins = [!!s0.up, !!p0.up]; // diagnostyka: czy tekstury idą z ImageBitmap
    this._ph("images-loaded");
    if (this.disposed) return;
    const [sketch, painted] = await Promise.all([fitPic(s0, this._owned), fitPic(p0, this._owned)]);
    if (this.disposed) return;
    this.W = imgW(painted.src); this.H = imgH(painted.src);
    // szkic o innym rozmiarze niż malunek: rdzeń zakłada ten sam rozmiar → przeskaluj szkic na rozmiar malunku
    if (imgW(sketch.src) === this.W && imgH(sketch.src) === this.H) this.sketch = sketch;
    else {
      const c = document.createElement("canvas");
      c.width = this.W; c.height = this.H;
      c.getContext("2d").drawImage(sketch.src, 0, 0, this.W, this.H);
      this.sketch = await picFromCanvas(c, this._owned, !!sketch.up);
      if (this.disposed) return;
    }
    this.painted = painted;
    this._ph("images-fitted");
    this._layout();

    this.aspect = this.W / this.H;
    this.camera = { zoom: cfg.zoom, sway: cfg.sway };
    // napis w ramce obrazu (jak w oryginale): rozmiar liter liczony od szerokości obrazu, nie okna; eksport składa go tak samo
    this.title = createTitle({ host: this.frame, opts: cfg.title, lite: this.perf.liteTitle });
    this._timeline();
    this.cameraCtl = createCamera({ el: this.cam, camera: this.camera, total: this.total, aspect: this.aspect });

    this._ph("title-camera-ready");
    await this._buildLayers(await this._side_for(this.perf));
    this._ph("layers-ready");
    if (this.disposed) return;

    // znaczniki wydajności
    if (this.perfBase.fpsMeter) this.fpsBadge = createFpsBadge(this.container, this.meter, this.perfBase.fpsLimit);
    if (this.perfBase.autoQuality) {
      this.auto = createAutoQuality({ host: this.container, meter: this.meter, perf: this.perfBase, onChange: (p) => { this.setPerf(p).catch((e) => console.warn("sketch-reveal | setPerf", e)); } });
    }
    this._apply(0);
  }

  /**
   * Oś czasu: [faza szkicu][kolor][rozbłysk] + ogon napisu (animacje wejścia/zaniku napisu muszą się zmieścić na osi,
   * inaczej przy domyślnych ustawieniach zanik nigdy by się nie odegrał). Wołana też po awarii fazy szkicu.
   */
  _timeline() {
    const cfg = this.cfg, intro = cfg.intro, glow = this.glowOpts = sanitizeGlow(cfg.glow ?? GLOW_DEFAULT_OPTS);
    const useIntro = intro.enabled && !this._introFailed;
    this.sec = useIntro ? Math.max(0.2, intro.seconds) : 0;
    this.colorAt = Math.max(0, Math.min(100, intro.colorAt ?? 100)) / 100;
    this.overlap = this.sec > 0 && this.colorAt < 1;
    this.cs = this.sec * this.colorAt;
    const params = effectParamsOf(cfg);
    this.effectDur = typeof params.duration === "number" ? params.duration : 6;
    this.glowSec = glow.enabled ? Math.max(0.1, glow.params.duration) : 0;
    this.glowStart = this.cs + this.effectDur * Math.max(0, Math.min(100, glow.from ?? 100)) / 100;
    let total = this.glowSec > 0 ? Math.max(this.sec, this.cs + this.effectDur, this.glowStart + this.glowSec) : Math.max(this.sec, this.cs + this.effectDur);
    // napis pojawia się w chwili appearAt × oś bazowa (jak dotąd), a jego własny zegar trwa D s — oś dostaje ogon, żeby zanik
    // zdążył się odegrać (najwyżej +25 s). Opcje napisu dostają appearAt przeliczony na dłuższą oś, więc moment startu się nie zmienia.
    const base = total, D = cfg.title.enabled ? this.title?.duration?.() ?? 0 : 0;
    if (D > 0) total = Math.max(base, Math.min(cfg.title.appearAt * base + D, base + 25));
    this.total = total;
    if (this.title) this.title.setOpts({ ...cfg.title, appearAt: Math.min(0.95, (cfg.title.appearAt * base) / total) });
  }

  /* ---- rozdzielczość podglądu */
  async _side_for(perf) {
    const side = previewSide(perf.preview, this.container, cameraMax(this.camera, this.aspect));
    return side > 0 && Math.max(this.W, this.H) > side ? side : 0;
  }

  async _scaledImages(side) {
    if (!side) return { sketch: this.sketch, painted: this.painted, scale: 1 };
    this._scaleCache ??= new Map();
    if (!this._scaleCache.has(side)) {
      const [sketch, painted] = await Promise.all([fitPic(this.sketch, this._owned, side), fitPic(this.painted, this._owned, side)]);
      this._scaleCache.set(side, { sketch, painted, scale: imgW(painted.src) / imgW(this.painted.src) });
    }
    return this._scaleCache.get(side);
  }

  /* ---- warstwy */
  _teardownLayers() {
    // najpierw odpiąć płótna od DOM (F1): rozbłysk i nakładka szkicu zwalniają kontekst WebGL po 1 s, gdy płótno jest
    // odłączone w chwili dispose(), a po 10 s, gdy wisi w DOM — kilka szybkich powtórek dobijało do limitu 16 kontekstów
    this.cam.replaceChildren();
    for (const k of ["effect", "intro", "glow", "residue"]) {
      try { this[k]?.dispose?.(); } catch { /* */ }
      this[k] = null;
    }
    this.effectCanvas = this.introCanvas = null;
  }

  /** (Re)buduje efekt, ślad szkicu, rozbłysk i nakładkę szkicu na kopii obrazów o boku `side` (0 = pełne). */
  async _buildLayers(side) {
    const gen = ++this._gen; // nowsza przebudowa (auto-jakość) unieważnia starszą: po każdym await `stale()` → wyjście
    const stale = () => this.disposed || gen !== this._gen;
    // F5: pierwsza budowa (za zasłoną, nic jeszcze nie gra) ustępuje wątkowi między krokami — bez jednego długiego zadania.
    // Przebudowa w trakcie odtwarzania (auto-jakość) zostaje jednym zadaniem jak dotąd (żadna klatka bez części warstw).
    const step = this._built ? async () => {} : yieldTask;
    const cfg = this.cfg, pics = await this._scaledImages(side), scale = pics.scale;
    if (stale()) return;
    const sketch = pics.sketch.src, painted = pics.painted.src, pw = imgW(painted), ph = imgH(painted);
    this._teardownLayers();
    this._side = side;
    const sw = (p) => (typeof p.paperScale === "number" ? { ...p, paperScale: p.paperScale * scale } : p); // ziarno papieru w uv jak w oryginale
    const params = effectParamsOf(cfg);
    const mkCanvas = (cls) => { const c = document.createElement("canvas"); c.className = `sr-canvas ${cls}`; return c; };

    // efekt koloru (w trybie nakładania dostaje biały arkusz zamiast szkicu — szkic rysuje nakładka)
    this.effectCanvas = mkCanvas("sr-effect");
    this.cam.append(this.effectCanvas);
    this.effectCanvas.width = pw; this.effectCanvas.height = ph;
    this.effect = Core.getEffect(cfg.effectId).create(this.effectCanvas);
    const effSketch = this.overlap ? await blankImage(pw, ph, this._owned) : sketch;
    if (stale()) return; // warstwy tej przebudowy sprzątnie nowsza (albo dispose)
    this.effect.setImages(effSketch, painted);
    this.effect.setParams(sw(params));
    this._ph("effect-created");
    // szew nakładki z klatką p=0 efektu: odczyt w tym samym zadaniu co setImages (jak dawniej) — późniejsze przerwy (F5)
    // nie mogą zmienić klatki, którą czyta (asynchroniczny preprocessing efektu biegnie dalej między zadaniami)
    const seam = cfg.intro.enabled && this.sec > 0 && !this.overlap ? this._seamPixels(pw, ph) : null;
    this.coverage = createCoverageProvider(() => this.effect, cfg.effectId);
    await step();
    if (stale()) return;

    // ślad szkicu pod malunkiem
    if (cfg.residue > 0) {
      this.residue = createResidue({ host: this.cam, sketchImage: sketch, percent: cfg.residue, onBlendChange: () => this._isolate() });
    }
    // rozbłysk
    if (this.glowSec > 0) {
      this.glow = createGlowLayer({
        host: this.cam, images: { sketch, painted }, params: this.glowOpts.params, effectCanvas: this.effectCanvas,
        coverage: this.coverage, hints: this.hints, hintsStrict: this.hintsStrict,
      });
      await step();
      if (stale()) return;
    }
    // nakładka rysowania szkicu
    if (cfg.intro.enabled && this.sec > 0) {
      this.introCanvas = mkCanvas("sr-intro");
      this.cam.append(this.introCanvas);
      Object.assign(this.introCanvas.style, oversampleStyle(this.camera, this.aspect) ?? {});
      let it = null;
      try {
        it = Core.createSketchIntro(this.introCanvas);
        const ip = sw({ ...cfg.intro.params, ...cfg.paper, seconds: cfg.intro.seconds });
        if (this.overlap) { ip.paper = false; this.introCanvas.style.mixBlendMode = "multiply"; }
        it.setParams?.(ip);
        it.setSketch(sketch, pw, ph);
        this.intro = it;
      } catch (e) {
        try { it?.dispose?.(); } catch { /* */ }
        this._introFailedWith(e, sketch, painted);
      }
      if (this.intro && seam) { try { this.intro.setTarget?.(seam, pw, ph); } catch { /* bez szwu nakładka kończy na szkicu */ } }
    }
    this._isolate();
    // gotowość asynchronicznych warstw (efekty z preprocessingiem, wektoryzacja szkicu, analiza świateł)
    const waits = [];
    this._ph(`waiting effect=${this.effect.isReady?.()} intro=${this.intro?.isReady?.()} glow=${!!this.glow}`);
    if (this.effect.isReady?.() === false) waits.push(this.effect.whenReady?.().then(() => this._ph("effect-ready")).catch(() => {}));
    if (this.intro?.isReady?.() === false) waits.push(this.intro.whenReady?.().catch(() => {}));
    if (this.glow) waits.push(this.glow.whenReady());
    await Promise.all(waits);
    if (!stale()) this._built = true;
  }

  /** Faza szkicu niedostępna: bez niej przelicz CAŁĄ oś (total, glowStart, kamera); w trybie nakładania efekt dostał biały arkusz — wróć do prawdziwego szkicu. */
  _introFailedWith(e, sketch, painted) {
    console.warn("sketch-reveal | faza szkicu niedostępna, pomijam", e);
    this.intro = null; this.introCanvas?.remove(); this.introCanvas = null;
    const wasOverlap = this.overlap;
    this._introFailed = true;
    this._timeline();
    this.cameraCtl?.set?.({ total: this.total });
    if (wasOverlap) this.effect.setImages(sketch, painted);
  }

  _isolate() {
    const blend = !!this.residue?.blendMode;
    this.cam.style.isolation = sceneIsolation(this.glowSec > 0, blend, this.overlap);
  }

  /** Klatka p=0 efektu (RGBA) do szwu z nakładką szkicu; null = pusta/błąd (wtedy nakładka kończy na szkicu). */
  _seamPixels(w, h) {
    try {
      this.effect.setProgress(0); this.effect.render();
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(this.effectCanvas, 0, 0);
      const d = g.getImageData(0, 0, w, h).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) return d;
    } catch { /* */ }
    return null;
  }

  /* ---- ustawienia wydajności w trakcie (auto-jakość) */
  async setPerf(perf) {
    if (this.disposed) return;
    this.perf = perf;
    this.title?.setLite(perf.liteTitle);
    if (perf.fpsLimit !== this._gateLimit) { this._gateLimit = perf.fpsLimit; this._gate = createFrameGate(perf.fpsLimit); }
    const side = await this._side_for(perf);
    if (side !== this._side && !this.disposed) {
      try { await this._buildLayers(side); this._lastP = NaN; this._apply(this.progress); } catch (e) { console.warn("sketch-reveal | przebudowa warstw", e); }
    }
  }

  /* ---- oś czasu */
  _at(p) {
    const { sec, cs, effectDur, total, overlap, glowSec, glowStart } = this;
    const t = p * total;
    const effectProgress = Math.max(0, Math.min(1, (t - cs) / effectDur)); // cs = 0 bez fazy szkicu
    const introProgress = sec > 0 ? Math.min(1, t / sec) : 1;
    const introOpacity = overlap ? 1 - smooth(0.55, 0.95, effectProgress) : 1;
    const introVisible = sec > 0 && (overlap ? introOpacity > 0.001 : t < sec);
    return { effectProgress, introProgress, introOpacity, introVisible, ...glowAt(t, glowStart, glowSec) };
  }

  /** `over` = sekundy po końcu osi (żywe światło, kołysanie live) — wtedy odświeżamy tylko warstwy, które żyją. */
  _apply(p, over = 0) {
    if (this.disposed) return;
    this.progress = p;
    if (p === this._lastP && this._lastM && over > 0) {
      const m = this._lastM;
      try {
        this.glow?.update(m.glowProgress, m.glowVisible, m.glowIdle + over, m.effectProgress);
        this.cameraCtl.update(p, over);
      } catch (e) { console.warn("sketch-reveal | live", e); }
      return;
    }
    const m = this._at(p);
    this._lastP = p; this._lastM = m;
    try {
      this.effect.setProgress(m.effectProgress);
      this.effect.render();
      if (this.intro) {
        this.introCanvas.style.opacity = String(m.introOpacity);
        this.introCanvas.style.display = m.introVisible ? "" : "none";
        if (m.introVisible) this.intro.render(m.introProgress); else this.intro.release?.();
      }
      this.residue?.update(m.effectProgress);
      if (this.glow) {
        this.glow.canvas.style.display = m.glowVisible ? "" : "none";
        this.glow.update(m.glowProgress, m.glowVisible, m.glowIdle + over, m.effectProgress);
      }
    } catch (e) { console.warn("sketch-reveal | render", e); }
    this.cameraCtl.update(p, over);
    this.title.update(p, this.total);
    this.onProgress?.(p);
  }

  /* ---- sterowanie */
  _liveWanted() { return !!this.glow?.isAlive() || (this.cfg.sway?.live && swayActive(this.cfg.sway) && cameraActive(this.camera)); }

  _ensureLoop() {
    if (this._loopOn || this.disposed) return;
    this._loopOn = true;
    const tick = (now) => {
      if (this.disposed) return;
      if (!this.playing && !(this.progress >= 1 && this._liveWanted())) { this._loopOn = false; return; }
      this._raf = requestAnimationFrame(tick);
      if (this._gate && !this._gate(now)) return; // limit klatek: ten tyk bez pracy
      const t0w = performance.now();
      if (this.playing) {
        // zegar ścienny (nie sumowanie dt): wolny klient gubi klatki, ale nie rozjeżdża się z innymi
        const p = Math.min(1, this._startP + Math.max(0, t0w - this._t0) / 1000 / Math.max(0.1, this.total));
        this._apply(p);
        if (p >= 1) { this.playing = false; this._endAt = t0w; this._done(); }
      } else if (t0w - this._liveLast >= (this.glowOpts.params.quality === "low" ? 50 : 33)) {
        this._liveLast = t0w;
        this._apply(1, (t0w - this._endAt) / 1000);
      } else return;
      this.meter.tick(now, performance.now() - t0w);
    };
    this._raf = requestAnimationFrame(tick);
  }

  setProgress(p) {
    this.playing = false; this._over = 0;
    this._lastP = NaN;
    this._apply(Math.max(0, Math.min(1, p)));
  }

  play() {
    if (this.disposed) return this.finished;
    if (this.playing) return this.finished;
    if (this.progress >= 1) { this._lastP = NaN; this._apply(0); }
    this.playing = true;
    this._startP = this.progress; this._t0 = performance.now();
    this._gateLimit = this.perf.fpsLimit; this._gate = createFrameGate(this.perf.fpsLimit);
    this._ensureLoop();
    return this.finished;
  }

  /** Przeskocz do końca (czysty obraz; żywe światło/kołysanie dalej tykają). */
  skip() {
    if (this.progress >= 1 && !this.playing) return;
    this.playing = false; this._lastP = NaN;
    this._apply(1);
    this._endAt = performance.now();
    this._done();
    this._ensureLoop();
  }

  /** Zanik napisu przy zamykaniu nakładki — napis jest w kontenerze, który i tak się rozpływa; zostawione dla zgodności. */
  setTitleExit() {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.playing = false;
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    try { this.auto?.dispose(); this.fpsBadge?.dispose(); } catch { /* */ }
    try { this.title?.dispose(); this.cameraCtl?.dispose(); } catch { /* */ }
    this.frame.remove(); // F1: płótna poza DOM przed dispose() warstw → krótkie zwolnienie kontekstów WebGL
    this._teardownLayers();
    this._owned.disposed = true;
    for (const u of this._owned.urls) URL.revokeObjectURL(u);
    closeLater(this._owned.bitmaps.splice(0));
    this._scaleCache?.clear();
    this._done?.();
  }
}

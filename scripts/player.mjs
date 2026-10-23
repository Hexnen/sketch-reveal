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

/** Obraz > `max` → kopia pomniejszona (blob URL — zwalnia właściciel w `owned`); inaczej ten sam obiekt. */
async function fitImage(img, owned, max = revealMaxSide()) {
  const W = img.naturalWidth, H = img.naturalHeight, k = max / Math.max(W, H);
  if (!(k < 1)) return img;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  if (!blob) return img;
  const url = URL.createObjectURL(blob);
  owned.push(url);
  return loadImage(url);
}

async function canvasToImage(c, owned) {
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const url = URL.createObjectURL(blob);
  owned.push(url);
  return loadImage(url);
}

async function blankImage(w, h, owned) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  return canvasToImage(c, owned);
}

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
    this._owned = { disposed: false, urls: [], push(u) { if (this.disposed) URL.revokeObjectURL(u); else this.urls.push(u); } };
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
    const [s0, p0] = await Promise.all([loadImage(this.sketchUrl), loadImage(this.paintedUrl)]);
    this._ph("images-loaded");
    if (this.disposed) return;
    const [sketch, painted] = await Promise.all([fitImage(s0, this._owned), fitImage(p0, this._owned)]);
    if (this.disposed) return;
    this.W = painted.naturalWidth; this.H = painted.naturalHeight;
    // szkic o innym rozmiarze niż malunek: rdzeń zakłada ten sam rozmiar → przeskaluj szkic na rozmiar malunku
    if (sketch.naturalWidth === this.W && sketch.naturalHeight === this.H) this.sketch = sketch;
    else {
      const c = document.createElement("canvas");
      c.width = this.W; c.height = this.H;
      c.getContext("2d").drawImage(sketch, 0, 0, this.W, this.H);
      this.sketch = await canvasToImage(c, this._owned);
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
      const [sketch, painted] = await Promise.all([fitImage(this.sketch, this._owned, side), fitImage(this.painted, this._owned, side)]);
      this._scaleCache.set(side, { sketch, painted, scale: painted.naturalWidth / this.painted.naturalWidth });
    }
    return this._scaleCache.get(side);
  }

  /* ---- warstwy */
  _teardownLayers() {
    for (const k of ["effect", "intro", "glow", "residue"]) {
      try { this[k]?.dispose?.(); } catch { /* */ }
      this[k] = null;
    }
    this.cam.replaceChildren();
    this.effectCanvas = this.introCanvas = null;
  }

  /** (Re)buduje efekt, ślad szkicu, rozbłysk i nakładkę szkicu na kopii obrazów o boku `side` (0 = pełne). */
  async _buildLayers(side) {
    const gen = ++this._gen; // nowsza przebudowa (auto-jakość) unieważnia starszą: po każdym await `stale()` → wyjście
    const stale = () => this.disposed || gen !== this._gen;
    const cfg = this.cfg, { sketch, painted, scale } = await this._scaledImages(side);
    if (stale()) return;
    this._teardownLayers();
    this._side = side;
    const sw = (p) => (typeof p.paperScale === "number" ? { ...p, paperScale: p.paperScale * scale } : p); // ziarno papieru w uv jak w oryginale
    const params = effectParamsOf(cfg);
    const mkCanvas = (cls) => { const c = document.createElement("canvas"); c.className = `sr-canvas ${cls}`; return c; };

    // efekt koloru (w trybie nakładania dostaje biały arkusz zamiast szkicu — szkic rysuje nakładka)
    this.effectCanvas = mkCanvas("sr-effect");
    this.cam.append(this.effectCanvas);
    this.effectCanvas.width = painted.naturalWidth; this.effectCanvas.height = painted.naturalHeight;
    this.effect = Core.getEffect(cfg.effectId).create(this.effectCanvas);
    const effSketch = this.overlap ? await blankImage(painted.naturalWidth, painted.naturalHeight, this._owned) : sketch;
    if (stale()) return; // warstwy tej przebudowy sprzątnie nowsza (albo dispose)
    this.effect.setImages(effSketch, painted);
    this.effect.setParams(sw(params));
    this._ph("effect-created");
    this.coverage = createCoverageProvider(() => this.effect, cfg.effectId);

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
    }
    // nakładka rysowania szkicu
    if (cfg.intro.enabled && this.sec > 0) {
      this.introCanvas = mkCanvas("sr-intro");
      this.cam.append(this.introCanvas);
      Object.assign(this.introCanvas.style, oversampleStyle(this.camera, this.aspect) ?? {});
      try {
        const it = Core.createSketchIntro(this.introCanvas);
        const ip = sw({ ...cfg.intro.params, ...cfg.paper, seconds: cfg.intro.seconds });
        if (this.overlap) { ip.paper = false; this.introCanvas.style.mixBlendMode = "multiply"; }
        it.setParams?.(ip);
        it.setSketch(sketch, painted.naturalWidth, painted.naturalHeight);
        this.intro = it;
        if (!this.overlap) this._seam(painted.naturalWidth, painted.naturalHeight); // szew z klatką p=0 efektu
      } catch (e) {
        console.warn("sketch-reveal | faza szkicu niedostępna, pomijam", e);
        this.intro = null; this.introCanvas.remove(); this.introCanvas = null;
        // bez fazy szkicu przelicz CAŁĄ oś (total, glowStart, kamera); w trybie nakładania efekt dostał biały arkusz — wróć do prawdziwego szkicu
        const wasOverlap = this.overlap;
        this._introFailed = true;
        this._timeline();
        this.cameraCtl?.set?.({ total: this.total });
        if (wasOverlap) this.effect.setImages(sketch, painted);
      }
    }
    this._isolate();
    // gotowość asynchronicznych warstw (efekty z preprocessingiem, wektoryzacja szkicu, analiza świateł)
    const waits = [];
    this._ph(`waiting effect=${this.effect.isReady?.()} intro=${this.intro?.isReady?.()} glow=${!!this.glow}`);
    if (this.effect.isReady?.() === false) waits.push(this.effect.whenReady?.().then(() => this._ph("effect-ready")).catch(() => {}));
    if (this.intro?.isReady?.() === false) waits.push(this.intro.whenReady?.().catch(() => {}));
    if (this.glow) waits.push(this.glow.whenReady());
    await Promise.all(waits);
  }

  _isolate() {
    const blend = !!this.residue?.blendMode;
    this.cam.style.isolation = sceneIsolation(this.glowSec > 0, blend, this.overlap);
  }

  _seam(w, h) {
    try {
      this.effect.setProgress(0); this.effect.render();
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(this.effectCanvas, 0, 0);
      const d = g.getImageData(0, 0, w, h).data;
      let blank = true;
      for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) { blank = false; break; }
      if (!blank) this.intro.setTarget?.(d, w, h);
    } catch { /* bez szwu nakładka kończy na szkicu */ }
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
    this._teardownLayers();
    this._owned.disposed = true;
    for (const u of this._owned.urls) URL.revokeObjectURL(u);
    this.frame.remove();
    this._done?.();
  }
}

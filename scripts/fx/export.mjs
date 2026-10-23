/* Eksport osi reveal do WebM — czysty ES module (port 1:1 z roleplay/.../reveal/export/{exportWebm,layerCapture,
   titleSnapshot,webmMuxer}.ts na RevealPlayer, bez Reacta).
   OFFLINE, klatka po klatce: oś ustawiana na t = i/fps (`player.setProgress`, jak scrub), warstwy sceny (`player.cam`)
   składane na jedno płótno, napis (DOM w `player.container`) → obraz SVG foreignObject, WebCodecs VideoEncoder (VP9 → VP8)
   i własny muxer WebM (stały klatkaż, Duration, Cues, klaster na klatkę kluczową). Wynik nie zależy od szybkości maszyny.
   Oś 0 … total: bez „żywego światła”/kołysania po końcu osi (over = 0) i bez pętli.

   Użycie:
     const blob = await exportWebm({ player, options: { res: "1280", fps: 30, quality: "medium" }, onProgress: (f) => …, signal });
     downloadBlob(blob, "reveal.webm");
   Różnice względem oryginału: patrz raport / komentarze „RÓŻNICA”. */

/* ---------------------------------------------------------------- opcje */

export const EXPORT_RES = [
  { value: "720", label: "720 px" }, { value: "1280", label: "1280 px" }, { value: "1920", label: "1920 px (Full HD)" },
  { value: "2560", label: "2K (2560 px)" }, { value: "3840", label: "4K (3840 px)" }, { value: "orig", label: "oryginał (rozmiar obrazu)" },
];
export const EXPORT_FPS = [
  { value: "24", label: "24 kl./s" }, { value: "30", label: "30 kl./s" }, { value: "60", label: "60 kl./s" },
];
export const EXPORT_QUALITY = [
  { value: "low", label: "niska (mały plik)" }, { value: "medium", label: "średnia" }, { value: "high", label: "wysoka" },
];
export const DEFAULT_EXPORT = { res: "orig", fps: 30, quality: "medium" };

/** Bity na piksel na klatkę → bitrate = bpp·W·H·fps (VP9; VP8 ×1,5). */
const BPP = { low: 0.04, medium: 0.08, high: 0.16 };
/** Górna granica bitrate. */
const MAX_BITRATE = 100e6;
/** Klatka kluczowa co tyle sekund (przewijanie; nowy klaster WebM przy każdej). */
const KEY_EVERY_S = 2;

/** Rozmiar eksportu: szerokość wg opcji („oryginał” = szerokość obrazu), proporcje obrazu, oba boki parzyste (4:2:0). */
export function exportSize(natW, natH, res) {
  const w = res === "orig" ? natW : Number(res);
  const even = (v) => Math.max(2, 2 * Math.round(v / 2));
  return { W: even(w), H: even((w * natH) / Math.max(1, natW)) };
}

/** Poziom VP9 (profil 0) z rozmiaru i tempa próbek (tabela poziomów VP9: maks. piksele obrazu / próbki na s). */
export function vp9Level(W, H, fps) {
  const px = W * H, rate = px * fps;
  const L = [["10", 36864, 829440], ["20", 122880, 4608000], ["21", 245760, 9216000],
    ["30", 552960, 20736000], ["31", 983040, 36864000], ["40", 2228224, 83558400], ["41", 2228224, 160432128],
    ["50", 8912896, 311951360], ["51", 8912896, 588251136], ["52", 8912896, 1176502272], ["60", 35651584, 1176502272],
    ["61", 35651584, 2353004544], ["62", 35651584, 4706009088]];
  return (L.find(([, p, r]) => px <= p && rate <= r) ?? L[L.length - 1])[0];
}

/** Czy przeglądarka ma WebCodecs (VideoEncoder + VideoFrame). Samo VP8/VP9 sprawdza `pickCodec`. */
export function supported() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/** Pierwszy obsługiwany kodek (VideoEncoder.isConfigSupported); null = brak WebCodecs/VP8/VP9. */
export async function pickCodec(W, H, fps, bitrate) {
  if (!supported()) return null;
  const cands = [[`vp09.00.${vp9Level(W, H, fps)}.08`, "V_VP9"], ["vp09.00.40.08", "V_VP9"], ["vp09.00.10.08", "V_VP9"], ["vp8", "V_VP8"]];
  for (const [codec, mux] of cands) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, framerate: fps, bitrate });
      if (r.supported) return { codec, mux };
    } catch { /* następny */ }
  }
  return null;
}

/* ---------------------------------------------------------------- muxer WebM (webmMuxer.ts) */

const concat = (parts) => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Liczba bez znaku big-endian; `len` = stała szerokość. */
function uint(v, len) {
  let n = len ?? 1;
  if (!len) while (n < 8 && v >= 2 ** (8 * n)) n++;
  const out = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  return out;
}

/** Rozmiar elementu jako EBML vint (najkrótszy zapis). */
function vsize(n) {
  let len = 1;
  while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const out = uint(n, len);
  out[0] |= 0x80 >> (len - 1);
  return out;
}

const idBytes = (id) => uint(id);
function el(id, ...payload) {
  const body = concat(payload);
  return concat([idBytes(id), vsize(body.length), body]);
}
const elUint = (id, v, len) => el(id, uint(v, len));
const elStr = (id, s) => el(id, new TextEncoder().encode(s));
function elFloat(id, v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
}

const SEGMENT = 0x18538067, SEEKHEAD = 0x114d9b74, SEEK = 0x4dbb, SEEKID = 0x53ab, SEEKPOS = 0x53ac;
const INFO = 0x1549a966, TIMESCALE = 0x2ad7b1, DURATION = 0x4489, MUXAPP = 0x4d80, WRITEAPP = 0x5741;
const TRACKS = 0x1654ae6b, TRACKENTRY = 0xae, TRACKNUM = 0xd7, TRACKUID = 0x73c5, TRACKTYPE = 0x83, LACING = 0x9c;
const CODECID = 0x86, DEFDUR = 0x23e383, VIDEO = 0xe0, PXW = 0xb0, PXH = 0xba;
const CUES = 0x1c53bb6b, CUEPOINT = 0xbb, CUETIME = 0xb3, CUEPOS = 0xb7, CUETRACK = 0xf7, CUECLUSTER = 0xf1;
const CLUSTER = 0x1f43b675, TIMECODE = 0xe7, SIMPLEBLOCK = 0xa3;
const EBML = 0x1a45dfa3;
/** Najdłuższy względny czas bloku w klastrze (int16 ms) — z zapasem. */
const MAX_REL_MS = 30000;

function simpleBlock(c, clusterMs) {
  const head = new Uint8Array(4);
  head[0] = 0x81; // ścieżka 1 (vint)
  new DataView(head.buffer).setInt16(1, c.ms - clusterMs);
  head[3] = c.key ? 0x80 : 0;
  return el(SIMPLEBLOCK, head, c.data);
}

/**
 * Składa plik: EBML · Segment[SeekHead · Info · Tracks · Cues · Cluster…]. Cały plik w pamięci po kodowaniu, więc rozmiary
 * są znane (Segment ma rozmiar, Info ma Duration, TrackEntry ma DefaultDuration); Cues i SeekHead stoją PRZED klastrami.
 * @param {{codec:"V_VP9"|"V_VP8",width:number,height:number,fps:number}} track
 * @param {{data:Uint8Array,ms:number,key:boolean}[]} chunks
 * @param {number} durationMs
 */
export function muxWebm(track, chunks, durationMs) {
  const clusters = [];
  let cur = null;
  const flush = () => { if (cur) clusters.push({ ms: cur.ms, bytes: el(CLUSTER, elUint(TIMECODE, cur.ms), ...cur.blocks) }); };
  for (const c of chunks) {
    if (!cur || c.key || c.ms - cur.ms > MAX_REL_MS) { flush(); cur = { ms: c.ms, blocks: [] }; }
    cur.blocks.push(simpleBlock(c, cur.ms));
  }
  flush();

  const header = el(EBML, elUint(0x4286, 1), elUint(0x42f7, 1), elUint(0x42f2, 4), elUint(0x42f3, 8),
    elStr(0x4282, "webm"), elUint(0x4287, 4), elUint(0x4285, 2));
  const info = el(INFO, elUint(TIMESCALE, 1_000_000), elFloat(DURATION, durationMs),
    elStr(MUXAPP, "sketch-reveal"), elStr(WRITEAPP, "Sketch Reveal"));
  const tracks = el(TRACKS, el(TRACKENTRY, elUint(TRACKNUM, 1), elUint(TRACKUID, 1), elUint(TRACKTYPE, 1), elUint(LACING, 0),
    elStr(CODECID, track.codec), elUint(DEFDUR, Math.round(1e9 / track.fps)),
    el(VIDEO, elUint(PXW, track.width), elUint(PXH, track.height))));

  // stała szerokość pozycji (8 B) → rozmiary SeekHead i Cues nie zależą od wartości; liczone raz z zerami
  const cuesOf = (pos) => el(CUES, ...clusters.map((c, i) =>
    el(CUEPOINT, elUint(CUETIME, c.ms, 8), el(CUEPOS, elUint(CUETRACK, 1), elUint(CUECLUSTER, pos[i], 8)))));
  const seekOf = (info0, tracks0, cues0) => el(SEEKHEAD,
    el(SEEK, el(SEEKID, idBytes(INFO)), elUint(SEEKPOS, info0, 8)),
    el(SEEK, el(SEEKID, idBytes(TRACKS)), elUint(SEEKPOS, tracks0, 8)),
    el(SEEK, el(SEEKID, idBytes(CUES)), elUint(SEEKPOS, cues0, 8)));
  const seekLen = seekOf(0, 0, 0).length;
  const cuesLen = cuesOf(clusters.map(() => 0)).length;
  const infoAt = seekLen, tracksAt = infoAt + info.length, cuesAt = tracksAt + tracks.length;
  const pos = [];
  let o = cuesAt + cuesLen;
  for (const c of clusters) { pos.push(o); o += c.bytes.length; }
  const body = [seekOf(infoAt, tracksAt, cuesAt), info, tracks, cuesOf(pos), ...clusters.map((c) => c.bytes)];
  let bodyLen = 0;
  for (const b of body) bodyLen += b.length;
  const segHead = concat([idBytes(SEGMENT), (() => { const s = uint(bodyLen, 8); s[0] = 0x01; return s; })()]);
  return new Blob([header, segHead, ...body], { type: "video/webm" });
}

/* ---------------------------------------------------------------- przechwyt warstw WebGL (layerCapture.ts) */

/* Płótna WebGL (efekt, rozbłysk, nakładka szkicu) nie mają preserveDrawingBuffer — po pokazaniu klatki bufor jest
   czyszczony, a drawImage(płótno WebGL) zwraca czerń. Warstwy rysują tylko przy ZMIANIE swojego postępu. Rozwiązanie: na czas
   eksportu metody rysujące WebGL(2)RenderingContext.prototype są owinięte — każdy rysunek do domyślnego bufora śledzonego
   płótna planuje mikrozadanie, które (jeszcze w tym samym tasku, przed pokazaniem) kopiuje płótno do kopii 2D. Kompozycja
   czyta kopię (WebGL) albo samo płótno (2D). Po eksporcie prototypy wracają. */

const DRAW_METHODS = ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements", "clear", "blitFramebuffer"];

function createLayerCapture() {
  const tracked = new Set();
  const cache = new Map();
  const pending = new Set();
  const restore = [];

  const copy = (c) => {
    pending.delete(c);
    if (!c.width || !c.height) return;
    let k = cache.get(c);
    if (!k) { k = document.createElement("canvas"); cache.set(c, k); }
    if (k.width !== c.width || k.height !== c.height) { k.width = c.width; k.height = c.height; }
    const g = k.getContext("2d");
    if (!g) return;
    g.globalCompositeOperation = "copy";
    g.drawImage(c, 0, 0);
  };
  const note = (gl) => {
    const c = gl.canvas;
    if (!(c instanceof HTMLCanvasElement) || !tracked.has(c) || pending.has(c)) return;
    const bound = "DRAW_FRAMEBUFFER_BINDING" in gl ? gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) : gl.getParameter(gl.FRAMEBUFFER_BINDING);
    if (bound) return; // rysunek do FBO — domyślny bufor bez zmian
    pending.add(c);
    queueMicrotask(() => copy(c)); // koniec tego samego taska: bufor jeszcze nie pokazany
  };
  for (const ctor of [typeof WebGLRenderingContext !== "undefined" ? WebGLRenderingContext : null,
    typeof WebGL2RenderingContext !== "undefined" ? WebGL2RenderingContext : null]) {
    if (!ctor) continue;
    const proto = ctor.prototype;
    for (const m of DRAW_METHODS) {
      if (!Object.prototype.hasOwnProperty.call(proto, m)) continue;
      const orig = proto[m];
      const wrapped = function (...a) { const r = orig.apply(this, a); note(this); return r; };
      proto[m] = wrapped;
      restore.push(() => { if (proto[m] === wrapped) proto[m] = orig; });
    }
  }
  return {
    track(canvases) { tracked.clear(); for (const c of canvases) tracked.add(c); },
    source: (c) => cache.get(c) ?? c,
    dispose() { restore.forEach((f) => f()); restore.length = 0; tracked.clear(); cache.clear(); pending.clear(); },
  };
}

const BLEND = {
  normal: "source-over", multiply: "multiply", screen: "screen", "plus-lighter": "lighter", lighten: "lighten",
  darken: "darken", overlay: "overlay",
};

/** <img> z tłem (ślad szkicu: biały pod szkicem) → płótno tło+obraz, keszowane per src/tło. */
const imgCache = new WeakMap();
function imgSource(img, bg) {
  if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return img;
  const key = `${img.currentSrc || img.src}|${bg}|${img.naturalWidth}x${img.naturalHeight}`;
  const hit = imgCache.get(img);
  if (hit && hit.key === key) return hit.c;
  const c = document.createElement("canvas");
  c.width = Math.max(1, img.naturalWidth); c.height = Math.max(1, img.naturalHeight);
  const g = c.getContext("2d");
  if (g) { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height); }
  imgCache.set(img, { key, c });
  return c;
}

const sceneCanvases = (wrapper) => Array.from(wrapper.children).filter((e) => e instanceof HTMLCanvasElement);

/**
 * Rysuje scenę (warstwy wrappera `.sr-cam` w kolejności DOM: efekt, ślad, rozbłysk, nakładka szkicu — z computed
 * opacity i mix-blend-mode) z transformacją kamery wrappera (computed `transform` + `transform-origin`) na `g` w
 * rozmiarze W×H. Każda warstwa wypełnia wrapper (absolute inset 0), więc rysowana jest na 0,0,W,H.
 */
function drawScene(g, wrapper, cap, W, H) {
  const cs = getComputedStyle(wrapper);
  const ww = wrapper.offsetWidth || W, wh = wrapper.offsetHeight || H;
  const sx = W / ww, sy = H / wh;
  let m = new DOMMatrix().scale(sx, sy);
  if (cs.transform && cs.transform !== "none") {
    const [ox, oy] = cs.transformOrigin.split(" ").map((v) => parseFloat(v) || 0);
    m = m.translate(ox, oy).multiply(new DOMMatrix(cs.transform)).translate(-ox, -oy);
  }
  m = m.scale(1 / sx, 1 / sy);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
  g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  g.setTransform(m);
  // „low” = dwuliniowe jak kompozytor (zmierzone w oryginale: 53,5 dB vs podgląd; „high” 45 dB)
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "low";
  for (const e of Array.from(wrapper.children)) {
    if (!(e instanceof HTMLCanvasElement || e instanceof HTMLImageElement)) continue;
    const st = getComputedStyle(e);
    const op = parseFloat(st.opacity);
    if (st.display === "none" || st.visibility === "hidden" || !(op > 0)) continue;
    if (e instanceof HTMLCanvasElement && (!e.width || !e.height)) continue;
    if (e instanceof HTMLImageElement && !e.complete) continue;
    const src = e instanceof HTMLCanvasElement ? cap.source(e) : imgSource(e, st.backgroundColor);
    g.globalAlpha = Math.min(1, op);
    g.globalCompositeOperation = BLEND[st.mixBlendMode] ?? "source-over";
    g.drawImage(src, 0, 0, W, H);
  }
  g.restore();
}

/* ---------------------------------------------------------------- napis → obraz (titleSnapshot.ts) */

/* RÓŻNICA: w oryginale animacje napisu pauzował/ustawiał eksporter (React). Tu robi to sam createTitle
   (`player.title.update` w `setProgress` ustawia `currentTime` wstrzymanych animacji na (p − appearAt)·total), więc eksporter
   tylko robi zdjęcie stanu: klon poddrzewa z zamrożonym computed style KAŻDEGO elementu (animowane wartości już policzone),
   bez <style> i animacji, w SVG <foreignObject> o rozmiarze KONTENERA (napis jest absolute inset-0 w `container`, a nie w ramce),
   viewBox = prostokąt ramki sceny w kontenerze → wektorowo do W×H → <img> → drawImage. Fragmenty poza ramką są przycinane. */

const SKIP = new Set(["animation", "transition", "will-change", "container-type", "container-name", "container", "cursor", "pointer-events"]);
const skipProp = (p) => SKIP.has(p) || p.startsWith("animation-") || p.startsWith("transition-");

function freeze(src, dst) {
  const cs = getComputedStyle(src);
  const parts = [];
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    if (skipProp(p)) continue;
    const v = cs.getPropertyValue(p);
    if (v) parts.push(`${p}:${v}`);
  }
  parts.push("animation:none", "transition:none");
  dst.setAttribute("style", parts.join(";"));
  const s = src.children, d = dst.children;
  for (let i = 0; i < s.length && i < d.length; i++) {
    if (s[i] instanceof HTMLElement) freeze(s[i], d[i]);
  }
}

async function titleImage(root, container, frame, W, H) {
  const cw = container.clientWidth, ch = container.clientHeight;
  if (!cw || !ch) return null;
  const cr = container.getBoundingClientRect(), fr = frame.getBoundingClientRect(), rr = root.getBoundingClientRect();
  const k = cr.width / cw || 1; // ewentualna skala CSS rodziców (rect w px ekranu → px układu)
  const clone = root.cloneNode(true);
  freeze(root, clone); // PRZED usunięciem <style> — freeze paruje dzieci po indeksie
  clone.querySelectorAll("style").forEach((s) => s.remove());
  clone.style.position = "absolute";
  clone.style.left = `${(rr.left - cr.left) / k - container.clientLeft}px`;
  clone.style.top = `${(rr.top - cr.top) / k - container.clientTop}px`;
  clone.style.width = `${rr.width / k}px`;
  clone.style.height = `${rr.height / k}px`;
  clone.style.right = "auto"; clone.style.bottom = "auto";
  const html = new XMLSerializer().serializeToString(clone);
  const fx = (fr.left - cr.left) / k - container.clientLeft, fy = (fr.top - cr.top) / k - container.clientTop;
  const fw = fr.width / k, fh = fr.height / k;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${fx} ${fy} ${fw} ${fh}">`
    + `<foreignObject x="0" y="0" width="${cw}" height="${ch}">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;margin:0;width:${cw}px;height:${ch}px;overflow:hidden">${html}</div>`
    + `</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try { await img.decode(); } catch { return null; }
  return img;
}

/* ---------------------------------------------------------------- eksport */

export class ExportError extends Error {}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Eksport całej osi do WebM (offline, klatka po klatce).
 * @param {object} o
 * @param {import("../player.mjs").RevealPlayer} o.player  przygotowany (po `prepare()`) odtwarzacz
 * @param {{res?:string,fps?:number|string,quality?:string}} [o.options]
 * @param {(fraction:number)=>void} [o.onProgress]  0..1
 * @param {AbortSignal} [o.signal]  przerwanie → DOMException "AbortError"
 * @returns {Promise<Blob>} video/webm
 */
export async function exportWebm({ player, options = {}, onProgress, signal } = {}) {
  if (!player || !player.cam || !player.total || !player.W) throw new ExportError("Odtwarzacz nie jest gotowy (brak prepare()).");
  const opts = { ...DEFAULT_EXPORT, ...options };
  const fps = Number(opts.fps) || DEFAULT_EXPORT.fps;
  const bpp = BPP[opts.quality] ?? BPP.medium;
  const total = player.total;
  const { W, H } = exportSize(player.W, player.H, String(opts.res));
  const pick = await pickCodec(W, H, fps, bpp * W * H * fps);
  if (!pick) {
    throw new ExportError(!supported()
      ? "Ta przeglądarka nie ma WebCodecs (VideoEncoder) — eksport WebM niedostępny. Użyj aktualnego Chrome/Edge/Firefox."
      : `Przeglądarka nie koduje VP9 ani VP8 w rozmiarze ${W}×${H} przy ${fps} kl./s — wybierz niższą rozdzielczość (np. ${W > 1920 ? "1920" : "1280"} px) albo mniej kl./s.`);
  }
  const bitrate = Math.round(Math.min(MAX_BITRATE, Math.max(4e5, bpp * W * H * fps * (pick.mux === "V_VP8" ? 1.5 : 1))));
  const frames = Math.max(1, Math.round(total * fps)) + 1; // t = 0 … total (ostatnia klatka = koniec osi)
  const saved = { p: player.progress, playing: player.playing };
  const abortErr = () => new DOMException("Eksport anulowany", "AbortError");
  if (signal?.aborted) throw abortErr();

  const chunks = [];
  let encErr = null;
  const enc = new VideoEncoder({
    output: (c) => {
      const data = new Uint8Array(c.byteLength);
      c.copyTo(data);
      chunks.push({ data, ms: Math.round(c.timestamp / 1000), key: c.type === "key" });
    },
    error: (e) => { encErr = e; },
  });
  enc.configure({ codec: pick.codec, width: W, height: H, framerate: fps, bitrate, bitrateMode: "variable", latencyMode: "quality" });

  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const g = out.getContext("2d", { alpha: false });
  if (!g) { enc.close(); throw new ExportError("Brak kontekstu 2D dla płótna eksportu."); }
  const cap = createLayerCapture();
  const keyEvery = Math.max(1, Math.round(KEY_EVERY_S * fps));
  try {
    player.playing = false; // setProgress też zatrzymuje
    cap.track(sceneCanvases(player.cam));
    // wymuszenie świeżego rysunku każdej warstwy (dirty-check): skok na koniec osi, potem pętla zaczyna od 0
    player.setProgress(1); await tick();
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw abortErr();
      if (encErr) throw new ExportError(`Błąd kodera: ${String(encErr)}`);
      if (player.disposed) throw new ExportError("Odtwarzacz został zamknięty w trakcie eksportu.");
      const t = Math.min(total, i / fps), p = Math.min(1, t / total);
      cap.track(sceneCanvases(player.cam)); // warstwy mogły zostać przebudowane (auto-jakość)
      player.setProgress(p); // synchronicznie: efekt, szkic, rozbłysk, ślad, kamera i napis (title.update)
      await Promise.resolve(); // mikrozadania kopii WebGL (zaplanowane w setProgress) wykonują się przed tym
      drawScene(g, player.cam, cap, W, H);
      const root = player.container.querySelector("[data-reveal-title]");
      if (root && getComputedStyle(root).visibility !== "hidden") {
        const img = await titleImage(root, player.container, player.frame, W, H);
        if (img) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; g.drawImage(img, 0, 0, W, H); }
      }
      const frame = new VideoFrame(out, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      // backpressure: duże klatki (4K ≈ 33 MB RGBA) — najwyżej 1–2 w kolejce kodera
      while (enc.encodeQueueSize > (W * H > 2_500_000 ? 1 : 4)) await new Promise((r) => setTimeout(r, 5));
      onProgress?.((i + 1) / frames);
      await tick(); // UI (pasek postępu, anuluj) i asynchroniczne rysunki warstw między klatkami
    }
    await enc.flush();
    if (encErr) throw new ExportError(`Błąd kodera: ${String(encErr)}`);
    chunks.sort((a, b) => a.ms - b.ms);
    return muxWebm({ codec: pick.mux, width: W, height: H, fps }, chunks, (frames * 1000) / fps);
  } finally {
    if (enc.state !== "closed") enc.close();
    cap.dispose();
    // stan osi sprzed eksportu (setProgress ustawia też napis); odtwarzanie wznawiamy od tego miejsca
    if (!player.disposed) {
      player.setProgress(saved.p);
      if (saved.playing) player.play();
    }
  }
}

/** Zapis przez <a download>. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.style.display = "none";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

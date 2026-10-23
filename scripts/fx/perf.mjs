/* Wydajność (port frameLimit.ts + fpsMeter.ts + previewScale.ts + autoQuality.ts + FpsBadge/AutoQualityBadge):
   limit klatek, licznik FPS, „rozdzielczość podglądu”, auto-jakość (opt-in). Czysty ES module, bez Foundry. */

/* ---------------------------------------------------------------- opcje */
export const FPS_LIMITS = [0, 60, 30, 24];
export const PREVIEW_RES = [["full", "pełna (obraz)"], ["1.5", "1,5× ekranu"], ["1", "1× ekranu"]];
export const DEFAULT_PERF = { preview: "full", liteTitle: false, fpsLimit: 0, fpsMeter: false, autoQuality: false };

export function sanitizePerf(raw) {
  const o = { ...DEFAULT_PERF };
  if (!raw || typeof raw !== "object") return o;
  if (PREVIEW_RES.some(([v]) => v === raw.preview)) o.preview = raw.preview;
  if (typeof raw.liteTitle === "boolean") o.liteTitle = raw.liteTitle;
  if (FPS_LIMITS.includes(raw.fpsLimit)) o.fpsLimit = raw.fpsLimit;
  if (typeof raw.fpsMeter === "boolean") o.fpsMeter = raw.fpsMeter;
  if (typeof raw.autoQuality === "boolean") o.autoQuality = raw.autoQuality;
  return o;
}

export const PERF_FIELDS = [
  { key: "preview", label: "Rozdzielczość podglądu", type: "select", options: PREVIEW_RES,
    hint: "Płótna efektu, szkicu i rozbłysku w rozmiarze ekranu zamiast obrazu (mniej pikseli do liczenia). Stratne." },
  { key: "liteTitle", label: "Lekkie animacje napisu", type: "check", hint: "Litery bez rozmycia per litera (tańsze dla kompozytora)." },
  { key: "fpsLimit", label: "Limit klatek", type: "select", numeric: true, options: [[0, "bez limitu"], [60, "60 fps"], [30, "30 fps"], [24, "24 fps"]],
    hint: "Pętla renderu najwyżej tyle klatek/s; długość animacji bez zmian." },
  { key: "fpsMeter", label: "Licznik FPS", type: "check", hint: "W rogu podglądu: klatki/s, odstępy, czas JS klatki." },
  { key: "autoQuality", label: "Auto-jakość", type: "check",
    hint: "Gdy FPS trwale < 85% celu: lekki napis → podgląd 1,5× → 1×; wraca po 8 s zapasu. Tylko podgląd, nie eksport." },
];

/* ---------------------------------------------------------------- limit klatek (frameLimit.ts) */
/** Bramka: `(now) => true` = ten tyk renderuje. `limit` ≤ 0 → null (bez bramki). */
export function createFrameGate(limit) {
  if (!(limit > 0)) return null;
  const iv = 1000 / limit;
  let prev = NaN, last = NaN, acc = 0, period = 1000 / 60;
  return (now) => {
    if (Number.isNaN(prev)) { prev = last = now; acc = 0; return true; }
    const d = Math.max(0, now - prev);
    prev = now;
    if (d > 0 && d < 100) period += (d - period) * 0.1;
    acc += d;
    const tol = Math.min(period, iv) / 2;
    if (acc < iv - tol || now - last < iv - 1.8 * tol) return false;
    acc = Math.max(-iv / 2, Math.min(iv / 2, acc - iv));
    last = now;
    return true;
  };
}

/* ---------------------------------------------------------------- licznik FPS (fpsMeter.ts) */
const WINDOW_MS = 1000, IDLE_MS = 500, CAP = 512;

export function createFpsMeter() {
  const t = new Float64Array(CAP), w = new Float32Array(CAP);
  let head = 0, size = 0;
  return {
    tick(now, workMs = 0) { t[head] = now; w[head] = workMs; head = (head + 1) % CAP; if (size < CAP) size++; },
    snapshot(now = performance.now()) {
      let n = 0, first = 0, lastT = 0, worst = 0, work = 0, prev = NaN;
      for (let k = 0; k < size; k++) {
        const i = (head - 1 - k + CAP) % CAP, ti = t[i];
        if (now - ti > WINDOW_MS) break;
        if (n === 0) lastT = ti; else worst = Math.max(worst, prev - ti);
        first = ti; prev = ti; work += w[i]; n++;
      }
      const span = lastT - first;
      return {
        fps: n >= 2 && span > 0 ? ((n - 1) * 1000) / span : 0,
        frames: n,
        frameMs: n >= 2 ? span / (n - 1) : 0,
        worstMs: worst,
        workMs: n ? work / n : 0,
        idle: n === 0 || now - lastT > IDLE_MS,
        lastGapMs: size >= 2 ? t[(head - 1 + CAP) % CAP] - t[(head - 2 + CAP) % CAP] : 0,
        sinceLastMs: size >= 1 ? now - t[(head - 1 + CAP) % CAP] : Infinity,
      };
    },
  };
}

const f1 = (v) => v.toFixed(1).replace(".", ",");

/** Znacznik FPS w rogu hosta; odświeża tekst imperatywnie ~4×/s. Zwraca { el, dispose }. */
export function createFpsBadge(host, meter, limit) {
  const el = document.createElement("span");
  el.className = "sr-fps-badge";
  host.append(el);
  const target = limit > 0 ? limit : 60;
  let lastText = "", lastTone = "";
  const update = () => {
    const s = meter.snapshot();
    const lim = limit > 0 ? ` · limit ${limit}` : "";
    const text = s.idle ? `bezczynny${lim}` : `${Math.round(s.fps)} fps · ${f1(s.frameMs)} ms · max ${Math.round(s.worstMs)} ms · JS ${f1(s.workMs)} ms · ${s.frames} kl.${lim}`;
    const tone = s.idle ? "idle" : s.fps < target * 0.9 ? "warn" : "ok";
    if (text !== lastText) { el.textContent = text; lastText = text; }
    if (tone !== lastTone) { el.dataset.tone = tone; lastTone = tone; }
  };
  update();
  const id = setInterval(update, 250);
  return { el, dispose() { clearInterval(id); el.remove(); } };
}

/* ---------------------------------------------------------------- rozdzielczość podglądu (previewScale.ts) */
export const previewFactor = (r) => (r === "1.5" ? 1.5 : r === "1" ? 1 : 0);
const QUANT = 128;

/** Bok docelowy: k × dłuższy bok elementu × DPR × kamera, w górę do kwantu; 0 = bez limitu. */
export function previewSide(res, el, camera = 1) {
  const k = previewFactor(res);
  if (!k) return 0;
  const w = el ? el.clientWidth : window.innerWidth, h = el ? el.clientHeight : window.innerHeight;
  const px = Math.max(w, h) * (window.devicePixelRatio || 1) * k * Math.max(1, camera);
  return px > 0 ? Math.ceil(px / QUANT) * QUANT : 0;
}

/* ---------------------------------------------------------------- auto-jakość (autoQuality.ts) */
export const AUTO_STEP_LABEL = { lite: "lekki napis", "1.5": "podgląd 1,5×", "1": "podgląd 1×" };
export const AUTO = { sampleMs: 500, downAfter: 6, upAfter: 16, low: 0.85, high: 0.95, graceMs: 2500, oscMs: 10000, backoff0: 30000, backoffMax: 300000, minFrames: 2, slowMs: 15000 };

export function autoLadder(perf) {
  const out = [];
  if (!perf.liteTitle) out.push("lite");
  if (perf.preview === "full") out.push("1.5");
  if (perf.preview !== "1") out.push("1");
  return out;
}

export function applyAuto(perf, level) {
  if (level <= 0) return perf;
  const steps = autoLadder(perf).slice(0, level);
  let preview = perf.preview;
  if (steps.includes("1.5")) preview = "1.5";
  if (steps.includes("1")) preview = "1";
  return { ...perf, liteTitle: perf.liteTitle || steps.includes("lite"), preview };
}

export const autoInit = () => ({ level: 0, low: 0, good: 0, changedAt: -Infinity, upAt: -Infinity, upBlockUntil: 0, backoff: AUTO.backoff0, reason: "" });

export function autoStep(st, snap, target, maxLevel, now) {
  const s = { ...st, level: Math.min(st.level, maxLevel) };
  if (now - s.changedAt < AUTO.graceMs) return { ...s, low: 0, good: 0 };
  let fps;
  if (snap.frames >= AUTO.minFrames && !snap.idle) fps = snap.fps;
  else if (snap.lastGapMs > 300 && snap.lastGapMs < AUTO.slowMs && snap.sinceLastMs < 1.5 * snap.lastGapMs) fps = 1000 / Math.max(snap.lastGapMs, snap.sinceLastMs);
  else return s;
  s.low = fps < AUTO.low * target ? s.low + 1 : 0;
  s.good = fps >= AUTO.high * target ? s.good + 1 : 0;
  if (s.low >= AUTO.downAfter && s.level < maxLevel) {
    if (now - s.upAt < AUTO.oscMs) { s.upBlockUntil = now + s.backoff; s.backoff = Math.min(AUTO.backoffMax, s.backoff * 2); }
    s.level++; s.low = 0; s.good = 0; s.changedAt = now;
    s.reason = `${Math.round(fps)} fps < ${Math.round(AUTO.low * 100)}% z ${target}`;
  } else if (s.good >= AUTO.upAfter && s.level > 0 && now >= s.upBlockUntil) {
    s.level--; s.low = 0; s.good = 0; s.changedAt = now; s.upAt = now;
    s.reason = `${Math.round(fps)} fps ≥ ${Math.round(AUTO.high * 100)}% z ${target}`;
  }
  return s;
}

/**
 * Regulator dla podglądu: próbkuje `meter` co 0,5 s, gdy perf.autoQuality. `onChange(effectivePerf, info)` przy zmianie
 * stopnia. Zwraca { badge el, dispose }. Wyłączony → nic nie robi.
 */
export function createAutoQuality({ host, meter, perf, onChange }) {
  if (!perf.autoQuality) return { dispose() {} };
  const ladder = autoLadder(perf);
  const target = perf.fpsLimit > 0 ? perf.fpsLimit : 60;
  const el = document.createElement("span");
  el.className = "sr-auto-badge";
  host.append(el);
  let st = autoInit();
  const paint = () => {
    const down = st.level > 0;
    el.textContent = down ? `auto: ${ladder.slice(0, st.level).map((s) => AUTO_STEP_LABEL[s]).join(" + ")}` : "auto: pełna jakość";
    el.dataset.down = down ? "1" : "0";
    el.title = st.reason ? `Ostatnia zmiana: ${st.reason}` : "Auto-jakość czuwa";
  };
  paint();
  const id = setInterval(() => {
    const prev = st.level;
    st = autoStep(st, meter.snapshot(performance.now()), target, ladder.length, performance.now());
    if (st.level !== prev) { paint(); onChange?.(applyAuto(perf, st.level), { level: st.level, reason: st.reason }); }
  }, AUTO.sampleMs);
  return { el, dispose() { clearInterval(id); el.remove(); } };
}

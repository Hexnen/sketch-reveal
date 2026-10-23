/**
 * Reveal bench — pomiar czasu GPU klatki efektu (port z repo roleplay: revealBench.ts).
 * Narzędzie deweloperskie, samodzielne (bez Foundry): serwer statyczny w katalogu modułu + tools/bench.html.
 *
 * Czas GPU przez EXT_disjoint_timer_query_webgl2 (TIME_ELAPSED wokół render(), wyniki zbierane asynchronicznie,
 * odrzucane przy GPU_DISJOINT). Dla każdej pary efekt × scena: przygotowanie (whenReady, ms ściany), potem odtwarzanie
 * p = 0 → 1 w `frames` klatkach — mediana / p95 / max GPU ms, CPU ms wywołania render().
 * Bez rozszerzenia: ściana z gl.finish() (zawyżona, oznaczona). Swiftshader = czas CPU rasteryzera, nie GPU.
 * Wynik: tabela + JSON (`window.__revealBench`).
 *
 * Parametry URL: effects=spread,strokes,... scenes=ulica,miasto,baza frames=60 size=1920|image run=1
 */
import { EFFECTS, getEffect } from "../vendor/reveal-core.js";

const SCENES = ["ulica", "miasto", "baza"].map((id) => ({
  id,
  sketchUrl: `../samples/${id}/sketch.png`,
  paintedUrl: `../samples/${id}/painted.png`,
}));

const q = new URLSearchParams(location.search);
const defaultEffects = Array.isArray(EFFECTS) ? EFFECTS.map((e) => e.id).filter(Boolean) : [];
const EFFECT_IDS = (q.get("effects") ?? (defaultEffects.length ? defaultEffects.join(",") : "spread,strokes,watercolor,speedpaint"))
  .split(",").filter(Boolean);
const SCENE_IDS = (q.get("scenes") ?? SCENES.map((s) => s.id).join(",")).split(",").filter(Boolean);
const FRAMES = Math.max(2, Math.min(600, Number(q.get("frames") ?? 60) || 60));
const SIZE = q.get("size") ?? "1920";

const raf = () => new Promise((r) => requestAnimationFrame(r));
const stats = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const at = (k) => s[Math.min(s.length - 1, Math.floor(k * (s.length - 1)))];
  return { median: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), n: s.length };
};

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`nie wczytano obrazu: ${url}`));
    img.src = url;
  });
}

function rendererInfo() {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return "brak WebGL2";
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const t = !!gl.getExtension("EXT_disjoint_timer_query_webgl2");
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return `${r} · timer query: ${t ? "tak" : "NIE (ściana z gl.finish)"} · DPR ${devicePixelRatio}`;
}

async function benchOne(effectId, sceneId) {
  const scene = SCENES.find((s) => s.id === sceneId);
  const effect = getEffect(effectId);
  const base = { effect: effectId, scene: sceneId, canvas: "", prepMs: 0, frames: FRAMES, gpu: null, cpuMedian: 0, wallFinishMedian: null };
  if (!scene || !effect) return { ...base, error: "nieznany efekt/scena" };
  let sketch, painted;
  try {
    [sketch, painted] = await Promise.all([loadImage(scene.sketchUrl), loadImage(scene.paintedUrl)]);
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
  const W = painted.naturalWidth, H = painted.naturalHeight;
  const k = SIZE === "image" ? 1 : Math.min(1, (Number(SIZE) || 1920) / Math.max(W, H));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * k); canvas.height = Math.round(H * k);
  document.getElementById("out").appendChild(canvas);
  const inst = effect.create(canvas);
  try {
    const t0 = performance.now();
    inst.setImages(sketch, painted);
    inst.setParams(effect.defaultParams);
    await inst.whenReady?.();
    const prepMs = performance.now() - t0;
    const gl = canvas.getContext("webgl2"); // ten sam kontekst co efekt
    if (!gl) throw new Error("brak kontekstu WebGL2 na płótnie efektu");
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const pend = [], gpu = [], cpu = [], wall = [];
    let disjoint = 0;
    const collect = () => {
      while (pend.length && gl.getQueryParameter(pend[0], gl.QUERY_RESULT_AVAILABLE)) {
        const qq = pend.shift();
        const ns = gl.getQueryParameter(qq, gl.QUERY_RESULT);
        if (ext && gl.getParameter(ext.GPU_DISJOINT_EXT)) disjoint++; else gpu.push(ns / 1e6);
        gl.deleteQuery(qq);
      }
    };
    inst.setProgress(0); inst.render(); await raf(); // rozgrzewka (kompilacja leniwa, pierwsze uploady)
    for (let i = 0; i < FRAMES; i++) {
      const p = (i + 1) / FRAMES;
      inst.setProgress(p);
      const qq = ext ? gl.createQuery() : null;
      if (qq && ext) gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
      const c0 = performance.now();
      inst.render();
      cpu.push(performance.now() - c0);
      if (qq && ext) { gl.endQuery(ext.TIME_ELAPSED_EXT); pend.push(qq); }
      else { gl.finish(); wall.push(performance.now() - c0); }
      await raf();
      collect();
    }
    for (let t = 0; t < 120 && pend.length; t++) { await raf(); collect(); }
    return {
      ...base, canvas: `${canvas.width}×${canvas.height}`, prepMs: +prepMs.toFixed(0),
      gpu: gpu.length ? stats(gpu) : null, cpuMedian: stats(cpu).median, wallFinishMedian: wall.length ? stats(wall).median : null,
      ...(disjoint ? { error: `GPU_DISJOINT: ${disjoint} odrzuconych` } : {}),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { inst.dispose(); } catch { /* ignore */ }
    canvas.remove();
  }
}

const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function table(rows) {
  const td = (v) => `<td>${v == null ? "–" : esc(v)}</td>`;
  return `<table><tr><th>efekt</th><th>scena</th><th>płótno</th><th>przygot. ms</th><th>GPU med</th><th>GPU p95</th><th>GPU max</th><th>CPU render() med</th><th>ściana+finish med</th><th>uwagi</th></tr>${
    rows.map((r) => `<tr>${td(r.effect)}${td(r.scene)}${td(r.canvas)}${td(r.prepMs)}${td(r.gpu?.median)}${td(r.gpu?.p95)}${td(r.gpu?.max)}${td(r.cpuMedian)}${td(r.wallFinishMedian)}${td(r.error ?? "")}</tr>`).join("")
  }</table>`;
}

async function run() {
  const out = document.getElementById("out");
  const info = rendererInfo();
  out.innerHTML = `<p>${esc(info)}</p><p id="st">…</p>`;
  const rows = [];
  for (const s of SCENE_IDS) for (const e of EFFECT_IDS) {
    document.getElementById("st").textContent = `${e} / ${s}…`;
    rows.push(await benchOne(e, s));
  }
  const result = { renderer: info, size: SIZE, frames: FRAMES, ua: navigator.userAgent, at: new Date().toISOString(), rows };
  window.__revealBench = result;
  out.innerHTML = `<p>${esc(info)}</p>${table(rows)}<p>JSON (skopiuj do docs/reveal-effects/combined-perf.md):</p><pre id="json">${esc(JSON.stringify(result, null, 1))}</pre>`;
}

document.getElementById("go").addEventListener("click", () => { void run(); });
if (q.get("run") === "1") void run();

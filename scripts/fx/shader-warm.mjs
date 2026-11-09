/* Rozgrzewka shaderów (dev/perf-audit.md F4). Pierwsza kompilacja programów WebGL efektu na świeżym profilu przeglądarki
   blokuje wątek główny na ~1 s (synchroniczne getShaderParameter/getProgramParameter zaraz po kompilacji). Tu te same
   programy (te same źródła — ta sama funkcja create() rdzenia) kompilują się zawczasu na osobnym, małym płótnie, z
   KHR_parallel_shader_compile i BEZ zapytań blokujących: czekamy na COMPLETION_STATUS_KHR między zadaniami, potem kontekst
   jest zwalniany. Właściwe przygotowanie trafia już w pamięć programów GPU przeglądarki. Nic nie jest rysowane ani
   pokazywane; bez rozszerzenia rozgrzewka nic nie robi (stan jak dotąd). */
import * as Core from "../../vendor/reveal-core.js";

const done = new Map(); // klucz → Promise<boolean>
/** Diagnostyka (harness): czasy i liczba programów na rodzaj. */
export const stats = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Płótno, którego kontekst WebGL2 kompiluje równolegle i nigdy nie czeka na wynik kompilacji (programy zbierane do `progs`). */
function warmCanvas() {
  const c = document.createElement("canvas");
  c.width = 16; c.height = 16;
  const orig = c.getContext.bind(c);
  const st = { gl: null, ext: null, progs: [], refused: false };
  c.getContext = (type, attrs) => {
    if (type !== "webgl2") return null; // tylko WebGL2 (rdzeń) — inne konteksty = brak rozgrzewki
    if (st.gl) return st.gl;
    const g = orig("webgl2", attrs);
    if (!g) return null;
    const ext = g.getExtension("KHR_parallel_shader_compile");
    if (!ext) { st.refused = true; return null; }
    st.gl = g; st.ext = ext;
    const COMPILE = g.COMPILE_STATUS, LINK = g.LINK_STATUS;
    const gsp = g.getShaderParameter.bind(g), gpp = g.getProgramParameter.bind(g), cp = g.createProgram.bind(g);
    // zapytania synchroniczne (czekają na GPU) zastąpione odpowiedziami bez czekania; rysowanie na tym kontekście nie ma znaczenia
    g.getShaderParameter = (s, p) => (p === COMPILE ? true : gsp(s, p));
    g.getProgramParameter = (pr, p) => (p === LINK ? true : gpp(pr, p));
    g.createProgram = () => { const p = cp(); if (p) st.progs.push(p); return p; };
    g.getUniformLocation = () => null;
    g.getAttribLocation = () => -1;
    g.getUniformBlockIndex = () => g.INVALID_INDEX;
    g.getError = () => g.NO_ERROR;
    g.readPixels = () => {};
    g.drawArrays = () => {}; g.drawElements = () => {}; g.drawArraysInstanced = () => {}; g.drawElementsInstanced = () => {};
    g.useProgram = () => {};
    return g;
  };
  return { c, st };
}

/** Czekaj (bez blokowania) aż GPU skończy kompilację i linkowanie wszystkich programów; potem zwolnij kontekst. */
async function settle(st, maxMs = 30000) {
  const t0 = performance.now();
  const gl = st.gl, ext = st.ext;
  if (!gl) return false;
  const gpp = WebGL2RenderingContext.prototype.getProgramParameter;
  while (performance.now() - t0 < maxMs) {
    if (gl.isContextLost()) return false;
    if (st.progs.every((p) => gpp.call(gl, p, ext.COMPLETION_STATUS_KHR))) break;
    await sleep(50);
  }
  try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* */ }
  return true;
}

const tiny = () => { const c = document.createElement("canvas"); c.width = 8; c.height = 8; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 8, 8); return c; };

async function warmOne(kind) {
  const { c, st } = warmCanvas();
  let inst = null;
  const t0 = performance.now();
  try {
    if (kind === "glow") inst = Core.createGlow(c, {});
    else inst = Core.getEffect(kind).create(c);
  } catch { /* rozgrzewka nieudana — bez skutków */ }
  const rec = { kind, createMs: Math.round(performance.now() - t0), progs: st.progs.length, refused: st.refused, gl: !!st.gl };
  stats.push(rec);
  const ok = await settle(st); // kontekst zwalnia settle(); dispose instancji dopiero potem (jej odroczone loseContext to no-op)
  try { inst?.dispose?.(); } catch { /* */ }
  rec.settleMs = Math.round(performance.now() - t0);
  return ok;
}

/**
 * Rozgrzej programy efektów `effectIds` (i rozbłysku, gdy `glow`) — w tle, po jednym, w czasie bezczynności.
 * Bezpieczne do wołania wielokrotnie (każdy rodzaj raz na sesję).
 */
export function warmShaders(effectIds = [], { glow = false } = {}) {
  const kinds = [...new Set(effectIds.filter((id) => { try { return !!Core.getEffect(id); } catch { return false; } }))];
  if (glow) kinds.push("glow");
  return Promise.all(kinds.map((k) => {
    if (!done.has(k)) {
      done.set(k, new Promise((r) => {
        const go = () => warmOne(k).then(r, () => r(false));
        if (globalThis.requestIdleCallback) requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 200);
      }));
    }
    return done.get(k);
  }));
}

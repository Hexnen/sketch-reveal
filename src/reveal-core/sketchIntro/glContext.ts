/**
 * Odroczone zwalnianie kontekstu WebGL płótna po `dispose()` (szkic i rozbłysk).
 *
 * Problem: `dispose()` usuwa tekstury i programy, ale kontekst (backbuffer, limit ~16 kontekstów na stronę) żyje,
 * dopóki żyje płótno. Natychmiastowy `loseContext()` jest groźny: ten sam `<canvas>` często dostaje nową instancję
 * zaraz po dispose (StrictMode, remount, przełączenie sceny) — a `getContext` zwraca wtedy TEN SAM, utracony kontekst.
 *
 * Rozwiązanie: `releaseGlCanvas` planuje `loseContext()` z opóźnieniem; `claimGlCanvas` (nowa instancja na tym płótnie)
 * anuluje plan. Gdy kontekst już zwolniliśmy, `claimGlCanvas` woła `restoreContext()` i zwraca true — instancja ma
 * czekać na `webglcontextrestored` (i tak obsługuje utratę/odtworzenie kontekstu: zasoby odtwarzane z danych).
 * `restoreContext` jest dozwolone tylko po zdarzeniu `webglcontextlost` z `preventDefault()` — robi to nasz słuchacz.
 */
/** Opóźnienie zwolnienia [ms]: płótno w DOM (może wrócić po przełączniku) dłużej, odłączone — krótko. */
export const GL_RELEASE_MS = { connected: 10_000, detached: 1_000 };

type Ctx = WebGL2RenderingContext | WebGLRenderingContext;
interface Slot {
  gl: Ctx;
  timer: ReturnType<typeof setTimeout> | null;
  ext: WEBGL_lose_context | null;
  /** lost = zwolniony przez nas (czeka na właściciela), restoring = restoreContext w toku. */
  state: "live" | "lost" | "restoring";
  lostFired: boolean;
  wantRestore: boolean;
  /** Ktoś zwolnił płótno w trakcie odtwarzania → po odtworzeniu zaplanuj zwolnienie ponownie. */
  releaseAfterRestore: boolean;
}
const slots = new WeakMap<HTMLCanvasElement, Slot>();

const restore = (s: Slot) => {
  s.wantRestore = false;
  s.state = "restoring";
  try { s.ext?.restoreContext(); } catch { /* kontekst nie do odtworzenia — instancja zostaje bez WebGL */ }
};

function arm(canvas: HTMLCanvasElement, s: Slot) {
  if (s.timer) clearTimeout(s.timer);
  const delay = canvas.isConnected ? GL_RELEASE_MS.connected : GL_RELEASE_MS.detached;
  s.timer = setTimeout(() => {
    s.timer = null;
    if (s.state !== "live" || s.gl.isContextLost()) return;
    const ext = s.gl.getExtension("WEBGL_lose_context");
    if (!ext) return;
    s.ext = ext; s.state = "lost"; s.lostFired = false;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // bez tego restoreContext() byłoby zabronione
      s.lostFired = true;
      if (s.wantRestore) setTimeout(() => restore(s), 0); // właściciel przyszedł przed zdarzeniem utraty
    }, { once: true });
    ext.loseContext();
  }, delay);
}

/**
 * Nowa instancja bierze płótno: anuluj zaplanowane zwolnienie. true = kontekst był zwolniony (albo jest
 * odtwarzany) — nie twórz renderera teraz, poczekaj na `webglcontextrestored`.
 */
export function claimGlCanvas(canvas: HTMLCanvasElement): boolean {
  const s = slots.get(canvas);
  if (!s) return false;
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  s.releaseAfterRestore = false;
  if (s.state === "live") return false;
  if (s.state === "lost") { if (s.lostFired) restore(s); else s.wantRestore = true; }
  return true;
}

/** Instancja zwolniła płótno (dispose): zaplanuj `loseContext()` (anulowane przez `claimGlCanvas`). */
export function releaseGlCanvas(canvas: HTMLCanvasElement, gl: Ctx | null | undefined): void {
  let s = slots.get(canvas);
  if (!s) {
    if (!gl || gl.isContextLost()) return;
    s = { gl, timer: null, ext: null, state: "live", lostFired: false, wantRestore: false, releaseAfterRestore: false };
    slots.set(canvas, s);
    const slot = s;
    canvas.addEventListener("webglcontextrestored", () => {
      if (slot.state === "live") return; // odtworzenie po utracie nie przez nas — nie nasza sprawa
      slot.state = "live";
      if (slot.releaseAfterRestore) { slot.releaseAfterRestore = false; arm(canvas, slot); }
    });
  }
  if (s.state === "restoring" || (s.state === "lost" && s.wantRestore)) { s.wantRestore = false; s.releaseAfterRestore = s.state === "restoring"; return; }
  if (s.state === "lost") return;
  if (gl) s.gl = gl;
  arm(canvas, s);
}

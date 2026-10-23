/**
 * Strażnik kontekstu WebGL instancji efektu (BUGHUNT-effects.md, E1 + E2 + E7). Owija `create()` każdego efektu:
 *
 * E1 — dispose() zwalnia kontekst ODROCZONYM `WEBGL_lose_context.loseContext()` (RELEASE_DELAY_MS), i tylko gdy
 *   płótno nie wróciło do użycia: ponowny create() na tym samym płótnie (StrictMode: mount → cleanup → mount w tym
 *   samym commicie) anuluje zwolnienie, a płótno wciąż podpięte do DOM (`isConnected`) nie jest zwalniane wcale
 *   (ktoś je pokazuje; porzucone płótno studia React odpina od DOM, płótna poza DOM — eksport, adapter, testy —
 *   są zwalniane). Bez tego porzucone konteksty liczą się do limitu Chromium (16) aż do GC, a przepełnienie
 *   zabija NAJSTARSZY kontekst strony (np. PIXI Foundry). create() na płótnie zwolnionym przez nas przywraca
 *   kontekst (`restoreContext`) i buduje instancję po zdarzeniu restored.
 * E2 — `webglcontextlost`: preventDefault (bez tego przeglądarka nie przywraca kontekstu), instancja wewnętrzna
 *   zwalniana (wywołania GL na straconym kontekście to no-op), render() nic nie robi, `isContextLost()` = true.
 *   `webglcontextrestored`: nowa instancja na tym samym płótnie + odtworzenie ostatniego stanu (obrazy, parametry,
 *   postęp) i ponowny render, jeśli wcześniej rysowano. Bez wyjątków (błąd odbudowy → ostrzeżenie, stan „stracony”).
 * E7 — setProgress(NaN) ignorowany (zostaje poprzedni postęp); nieskończone liczby w parametrach nie trafiają do
 *   odtwarzanego stanu (efekty i tak je odrzucają).
 * Strażnik nie wykonuje żadnych wywołań GL w klatce → klatki bajt w bajt jak bez niego. Metody spoza kontraktu
 * (strokeCount, stats, timeline, coverage(…, tune) itp.) są przekazywane do bieżącej instancji (Proxy).
 */
import type { EffectInstance, EffectParams, RevealImageSource } from "../types";

const RELEASE_DELAY_MS = 50;
const pending = new WeakMap<HTMLCanvasElement, ReturnType<typeof setTimeout>>();
const releasedByUs = new WeakMap<HTMLCanvasElement, WEBGL_lose_context>();

function cancelRelease(canvas: HTMLCanvasElement) {
  const t = pending.get(canvas);
  if (t !== undefined) clearTimeout(t);
  pending.delete(canvas);
}

/** Odroczone zwolnienie kontekstu płótna (pomijane, gdy płótno wróciło do użycia albo wisi w DOM). */
export function releaseContextLater(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
  cancelRelease(canvas);
  const t = setTimeout(() => {
    if (pending.get(canvas) !== t) return;
    pending.delete(canvas);
    if (canvas.isConnected || gl.isContextLost()) return;
    const ext = gl.getExtension("WEBGL_lose_context");
    if (!ext) return;
    releasedByUs.set(canvas, ext);
    // preventDefault = przywracalny (ponowny create() na tym płótnie woła restoreContext); zasoby i tak zwolnione
    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault(), { once: true });
    ext.loseContext();
  }, RELEASE_DELAY_MS);
  pending.set(canvas, t);
}

/** Kontekst WebGL2 już istniejący na płótnie (bez tworzenia nowego z domyślnymi atrybutami). */
function existingGl(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    const g = canvas.getContext("webgl2");
    return g instanceof WebGL2RenderingContext ? g : null;
  } catch {
    return null;
  }
}

export interface GuardedInstance extends EffectInstance {
  isContextLost(): boolean;
}

export function guardEffect<I extends EffectInstance>(canvas: HTMLCanvasElement, make: (c: HTMLCanvasElement) => I): I & GuardedInstance {
  cancelRelease(canvas);
  let inner: I | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let lost = false;
  let disposed = false;
  let images: [RevealImageSource, RevealImageSource] | null = null;
  const params: EffectParams = {};
  let progress: number | null = null;
  let rendered = false;
  let waiters: (() => void)[] = [];

  const ext = releasedByUs.get(canvas);
  releasedByUs.delete(canvas);
  const prev = ext ? existingGl(canvas) : null;
  if (ext && prev && prev.isContextLost()) {
    // płótno zwolnione przez nas → przywróć; instancja powstanie w onRestored (create() nie może rzucić później)
    gl = prev;
    lost = true;
    ext.restoreContext();
  } else {
    inner = make(canvas); // błąd (np. brak WebGL2) leci do wołającego jak dotąd
    gl = existingGl(canvas);
  }

  function flushWaiters() {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  }

  function onLost(e: Event) {
    e.preventDefault();
    if (disposed) return;
    lost = true;
    const i = inner;
    inner = null;
    try { i?.dispose(); } catch { /* kontekst stracony — GL to no-op */ }
  }

  function onRestored() {
    if (disposed || !lost) return;
    let next: I;
    try {
      next = make(canvas);
    } catch (e) {
      console.warn("reveal: odtworzenie efektu po utracie kontekstu nie powiodło się", e);
      return;
    }
    inner = next;
    lost = false;
    try {
      if (images) next.setImages(images[0], images[1]);
      if (Object.keys(params).length) next.setParams({ ...params });
      if (progress !== null) next.setProgress(progress);
      if (rendered) next.render();
    } catch (e) {
      console.warn("reveal: odtworzenie stanu efektu po utracie kontekstu", e);
    }
    flushWaiters();
  }

  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  const api: GuardedInstance = {
    setImages(sketch, painted) {
      images = [sketch, painted];
      inner?.setImages(sketch, painted);
    },
    setParams(p) {
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined || (typeof v === "number" && !Number.isFinite(v))) continue;
        params[k] = v;
      }
      inner?.setParams(p);
    },
    setProgress(p) {
      if (Number.isNaN(p)) return;
      progress = p;
      inner?.setProgress(p);
    },
    render() {
      rendered = true;
      inner?.render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      const i = inner;
      inner = null;
      images = null;
      flushWaiters();
      i?.dispose();
      if (gl) releaseContextLater(canvas, gl);
    },
    isReady() {
      return inner ? (inner.isReady?.() ?? true) : false;
    },
    whenReady() {
      if (inner) return inner.whenReady?.() ?? Promise.resolve();
      if (disposed) return Promise.resolve();
      return new Promise<void>((res) => waiters.push(res)).then(() => (inner ? inner.whenReady?.() : undefined));
    },
    isContextLost() {
      return lost || (!!gl && gl.isContextLost());
    },
  };
  // pozostałe metody (coverage, strokeCount, stats…) → bieżąca instancja (brak instancji = undefined, np. coverage)
  return new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key as keyof GuardedInstance];
      const cur = inner as unknown as Record<PropertyKey, unknown> | null;
      const v = cur?.[key];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(cur) : v;
    },
  }) as I & GuardedInstance;
}

/* „Szkic spod malunku” (ślad szkicu) w czystym ES module. Port roleplay/.../reveal/{residue,residueMask,composite}.ts.

   Warstwa = <img> nad płótnem efektu, w wrapperze kamery. Krycie = amount · smoothstep(effectProgress): 0 w fazie szkicu,
   ciągłe, po końcu osi zostaje amount. Dwie ścieżki (Fala 3, combined-perf.md):
   - multiply: <img> szkicu na białym tle, `mix-blend-mode: multiply` → B' = B·(1 − o·(1 − R));
   - maska: <img> czerń + alfa (255 − L), blend normal → B' = B·(1 − o·(1 − L)); ±1 LSB, gdy amount/100·maxErr ≤ 0,5
     (domyślne 10% tak). Maska liczona w workerze (bez długich zadań). Przełączenie w dwóch krokach, każdy stan pośredni
     równoważny: (1) src = maska nadal z multiply na bieli, (2) po `load` maski — bez blendu i tła. Powrót (większe krycie)
     przywraca multiply w tym samym kroku co zmiana src. */

export const DEFAULT_RESIDUE = 10;

/** Pole UI jak „Szkic spod malunku” w SketchSection.tsx (klucz = `residue` w ustawieniach). */
export const RESIDUE_FIELD = {
  key: "residue", label: "Szkic spod malunku", type: "range", min: 0, max: 100, step: 1, unit: "%",
  hint: "Po pokryciu farbą szkic zostawia delikatne linie (multiply); 0 = wyłączone",
};

/** Liczba → 0..100; nie-liczba/NaN → DEFAULT_RESIDUE. Nigdy nie rzuca. */
export function sanitizeResidue(raw) {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : DEFAULT_RESIDUE;
}

/** K4: izolacja sceny (`isolation`) tylko gdy w scenie jest warstwa z blendem (rozbłysk, ślad z multiply, szkic w nakładaniu). */
export const sceneIsolation = (glowOn, residueBlend, overlap) => (glowOn || residueBlend || overlap ? "isolate" : "auto");

const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
export const residueOpacity = (effectProgress, amount) => (Math.max(0, Math.min(100, amount)) / 100) * smooth(effectProgress);

/* ---------------------------------------------------------------- maska (residueMask.ts) */

const WORKER = `
onmessage = async (e) => {
  try {
    const bmp = e.data.bmp || await createImageBitmap(await (await fetch(e.data.src)).blob());
    const w = bmp.width, h = bmp.height, c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0); bmp.close();
    const d = g.getImageData(0, 0, w, h), a = d.data;
    let err = 0;
    for (let o = 0; o < a.length; o += 4) {
      const r = a[o], gg = a[o + 1], b = a[o + 2];
      const mx = r > gg ? (r > b ? r : b) : (gg > b ? gg : b), mn = r < gg ? (r < b ? r : b) : (gg < b ? gg : b);
      const L = (mx + mn + 1) >> 1, e1 = mx - L > L - mn ? mx - L : L - mn;
      if (e1 > err) err = e1;
      a[o] = 0; a[o + 1] = 0; a[o + 2] = 0; a[o + 3] = 255 - L;
    }
    g.putImageData(d, 0, 0);
    postMessage({ blob: await c.convertToBlob({ type: 'image/png' }), maxErr: err });
  } catch (x) { postMessage({ err: String(x) }); }
};`;

const cache = new WeakMap();

/** Maska dla obrazu szkicu (keszowana per obiekt <img>): { blob, maxErr } albo null (brak wsparcia/błąd → zostaje multiply). */
export function residueMask(img) {
  const hit = cache.get(img);
  if (hit) return hit;
  const p = buildMask(img);
  cache.set(img, p);
  return p;
}

async function buildMask(img) {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function"
    || !img.naturalWidth || !img.naturalHeight) return null;
  let url = "", wk = null;
  try {
    const src = img.currentSrc || img.src;
    // http(s)/blob: dekoduje worker; inne (np. data:) — migawka w wątku głównym
    const bmp = /^(https?|blob):/.test(src) ? null : await createImageBitmap(img);
    url = URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" }));
    wk = new Worker(url);
    const w = wk;
    const r = await new Promise((res) => {
      w.onmessage = (e) => res(e.data);
      w.onerror = () => res({ err: "worker" });
      if (bmp) w.postMessage({ bmp }, [bmp]); else w.postMessage({ src: new URL(src, location.href).href });
    });
    return r.blob && typeof r.maxErr === "number" ? { blob: r.blob, maxErr: r.maxErr } : null;
  } catch {
    return null;
  } finally {
    wk?.terminate();
    if (url) URL.revokeObjectURL(url);
  }
}

/** Maska daje ±1 LSB względem multiply przy kryciu ≤ amount%: amount/100 · maxErr ≤ 0,5. */
export const maskExact = (maxErr, amount) => (Math.max(0, Math.min(100, amount)) / 100) * maxErr <= 0.5;

/* ---------------------------------------------------------------- warstwa */

/**
 * @param {{host:HTMLElement, sketchImage:HTMLImageElement, percent:number, onBlendChange?:(blend:boolean)=>void}} o
 *   `host` = wrapper sceny (kamery); <img> jest do niego DOPISYWANY — wstaw/przenieś go samemu, jeśli kolejność warstw ma być inna
 *   (ślad: nad płótnem efektu, POD rozbłyskiem i nakładką szkicu). `onBlendChange(blend)` woła się, gdy `blendMode` się zmieni
 *   (maska załadowana → false; powrót do multiply → true) — tam przelicz `sceneIsolation`.
 * @returns {{el:HTMLImageElement, readonly blendMode:boolean, update:(effectProgress:number)=>void, setPercent:(n:number)=>void, dispose:()=>void}}
 */
export function createResidue({ host, sketchImage, percent, onBlendChange }) {
  const el = document.createElement("img");
  el.alt = ""; el.draggable = false;
  el.className = "sr-residue";
  el.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0;display:none";
  host.appendChild(el);

  let amount = sanitizeResidue(percent), alive = true, mask = null, url = "", loadedSrc = "", blend = false, lastO = NaN, lastEffectP = 0;

  const setBlend = (b) => {
    // multiply + biały podkład albo czysty normal; krycie/display należą do update()
    el.style.mixBlendMode = b ? "multiply" : "";
    el.style.background = b ? "#fff" : "";
    if (b !== blend) { blend = b; onBlendChange?.(b); }
  };

  /** Stan docelowy z (amount, maska, sketchImage): wybór ścieżki blendu + src. */
  const apply = () => {
    if (!alive) return;
    if (!(amount > 0)) { setBlend(false); lastO = NaN; el.style.opacity = "0"; el.style.display = "none"; return; }
    const useMask = !!mask && maskExact(mask.maxErr, amount);
    const src = useMask ? mask.url : sketchImage.src;
    if (el.getAttribute("src") !== src) el.src = src;
    // bez blendu dopiero, gdy <img> faktycznie załadował maskę (każdy stan pośredni = multiply)
    setBlend(!(useMask && loadedSrc === src));
    lastO = NaN;
    api.update(lastEffectP);
  };

  el.addEventListener("load", () => { loadedSrc = el.getAttribute("src") ?? ""; apply(); });

  let maskStarted = false;
  const ensureMask = () => {
    if (maskStarted) return;
    maskStarted = true;
    void residueMask(sketchImage).then(async (m) => {
      if (!alive || !m) return;
      url = URL.createObjectURL(m.blob);
      const pre = new Image();
      pre.src = url; // dekodowanie zawczasu: <img> dostaje gotowy obraz
      try { await pre.decode(); } catch { return; }
      if (!alive) return;
      mask = { url, maxErr: m.maxErr };
      apply();
    });
  };
  if (amount > 0) ensureMask();

  const api = {
    el,
    /** true = warstwa używa `mix-blend-mode` (scena potrzebuje izolacji) — wejście `residueBlend` w sceneIsolation. */
    get blendMode() { return blend; },
    /** effectProgress ∈ [0,1] = TimelineAt.effectProgress dla bieżącego p (0 w fazie szkicu). Tanie: zapis stylu tylko przy zmianie. */
    update(effectProgress) {
      lastEffectP = effectProgress;
      if (!alive) return;
      const o = amount > 0 ? residueOpacity(effectProgress, amount) : 0;
      if (o === lastO) return;
      lastO = o;
      el.style.opacity = String(o);
      el.style.display = o > 0 ? "" : "none";
    },
    /** Nowa wartość suwaka (0 = wyłączone). Ścieżka blendu przeliczana od razu (maska buduje się leniwie przy pierwszym >0). */
    setPercent(n) {
      amount = sanitizeResidue(n);
      if (amount > 0) ensureMask();
      apply();
    },
    dispose() {
      alive = false;
      el.remove();
      if (url) URL.revokeObjectURL(url);
      url = "";
    },
  };
  apply();
  return api;
}

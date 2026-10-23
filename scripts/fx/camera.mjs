/* Kamera sceny reveal: zoom (Ken Burns) + sway (kołysanie) w czystym ES module — bez Reacta i globali Foundry.
   Port 1:1 matematyki z roleplay/.../reveal/{zoom,sway,camera}.ts + zakresów (settings/ranges.ts) i pól UI
   (panels/CameraSection.tsx). Jeden `transform` na wrapperze sceny = sway (wokół środka) ∘ zoom (wokół punktu skupienia).
   Wrapper: transform-origin 50% 50%; tytuł poza wrapperem. z zależy wyłącznie od postępu osi p, sway od czasu t. */

/* ---------------------------------------------------------------- zoom */

/** @typedef {{enabled:boolean,direction:'in'|'out'|'breath',strength:number,until:number,curve:'linear'|'ease',focus:string}} ZoomOpts */
/** @type {ZoomOpts} */
export const DEFAULT_ZOOM = Object.freeze({ enabled: true, direction: "in", strength: 10, until: 100, curve: "ease", focus: "center" });

const ZOOM_DIRECTIONS = [["in", "przybliżenie"], ["out", "oddalenie"], ["breath", "oddech (przybliż i wróć)"]];
const ZOOM_CURVES = [["ease", "łagodna (ease-in-out)"], ["linear", "liniowa"]];

const ORIGINS = {
  "top-left": ["górna-lewa", 0, 0], top: ["góra", 50, 0], "top-right": ["górna-prawa", 100, 0],
  left: ["lewa", 0, 50], center: ["środek", 50, 50], right: ["prawa", 100, 50],
  "bottom-left": ["dolna-lewa", 0, 100], bottom: ["dół", 50, 100], "bottom-right": ["dolna-prawa", 100, 100],
};
const ZOOM_FOCI = Object.entries(ORIGINS).map(([v, o]) => [v, o[0]]);

/** Zoom aktywny = włączony i siła > 0 (inaczej wrapper nie dostaje żadnego stylu). */
export const zoomActive = (o) => !!o && !!o.enabled && o.strength > 0;

/** Maksymalna skala (koniec przybliżenia / start oddalenia) — mnożnik rozdzielczości nakładki szkicu. */
export const zoomMax = (o) => (zoomActive(o) ? 1 + Math.min(100, o.strength) / 100 : 1);

/**
 * z(p) = 1 + s·f(clamp(p / do)); p = postęp całej osi 0..1; do = 0 → od razu wartość końcowa.
 * f: in = ease(x), out = 1 − ease(x), breath = ease(2x) do połowy i z powrotem (koniec = 1).
 */
export function zoomAt(p, o) {
  if (!zoomActive(o)) return 1;
  const u = Math.max(0, Math.min(100, o.until)) / 100;
  const x = u > 0 ? Math.max(0, Math.min(1, p / u)) : 1;
  const ease = (v) => (o.curve === "linear" ? v : 0.5 - 0.5 * Math.cos(Math.PI * v));
  const f = o.direction === "out" ? 1 - ease(x) : o.direction === "breath" ? ease(1 - Math.abs(2 * x - 1)) : ease(x);
  return 1 + (Math.min(100, o.strength) / 100) * f;
}

/** Punkt skupienia jako % pudełka wrappera [x, y]. */
export const zoomOrigin = (focus) => {
  const o = ORIGINS[focus] ?? ORIGINS.center;
  return [o[1], o[2]];
};

/* ---------------------------------------------------------------- sway */

/** @typedef {{enabled:boolean,ampX:number,ampY:number,rot:number,period:number,irregular:number,seed:number,from:number,to:number,live:boolean}} SwayOpts */
/** @type {SwayOpts} */
export const DEFAULT_SWAY = Object.freeze({
  enabled: false, ampX: 1, ampY: 1, rot: 0.3, period: 9, irregular: 0.5, seed: 1, from: 0, to: 100, live: false,
});

export const swayActive = (o) => !!o && !!o.enabled && (o.ampX > 0 || o.ampY > 0 || o.rot > 0);

/** Miękki start / wygaszenie (s); przy krótkim zakresie — połowa zakresu. */
const FADE = 1;
const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const frac = (x) => x - Math.floor(x);
const phase = (seed, i) => frac(Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453) * Math.PI * 2;
const ZERO = Object.freeze({ tx: 0, ty: 0, rot: 0, env: 0 });

/**
 * Stan kołysania w sekundzie t osi (`total` = długość osi): tx/ty w % pudełka, rot w stopniach, env 0..1.
 * Składowa i: (1−k)·sin(ωᵢt+φ) + k·(0,6·sin(1,618·ωᵢt+φ′) + 0,4·sin(0,477·ωᵢt+φ″)); ω_y = 0,83·ω, ω_rot = 0,61·ω.
 */
export function swayAt(t, total, o) {
  if (!swayActive(o)) return ZERO;
  const start = (Math.max(0, Math.min(100, o.from)) / 100) * total;
  const end = Math.max(start, (Math.max(0, Math.min(100, o.to)) / 100) * total);
  const fade = Math.max(1e-3, Math.min(FADE, (end - start) / 2));
  const env = smooth((t - start) / fade) * (o.live ? 1 : smooth((end - t) / fade));
  if (env <= 0) return ZERO;
  const w = (2 * Math.PI) / Math.max(0.5, o.period), k = Math.max(0, Math.min(1, o.irregular));
  const comp = (i, f) => {
    const a = w * f * t;
    return (1 - k) * Math.sin(a + phase(o.seed, i)) +
      k * (0.6 * Math.sin(1.618 * a + phase(o.seed, i + 3)) + 0.4 * Math.sin(0.477 * a + phase(o.seed, i + 6)));
  };
  return { tx: o.ampX * env * comp(0, 1), ty: o.ampY * env * comp(1, 0.83), rot: o.rot * env * comp(2, 0.61), env };
}

/**
 * Skala okrywająca (wokół środka): obraz S·W×S·H zawiera ramkę W×H przy obrocie θ i przesunięciu ±ax·W, ±ay·H.
 * Liczona z amplitud × obwiednia (nie z chwilowego wychylenia); env = 0 → 1.
 */
export function swayCover(o, env, aspect) {
  if (!swayActive(o) || env <= 0) return 1;
  const th = ((o.rot * env) * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const ax = (o.ampX / 100) * env, ay = (o.ampY / 100) * env, a = aspect > 0 ? aspect : 1;
  return Math.max(1, c * (1 + 2 * ax) + (s / a) * (1 + 2 * ay), s * a * (1 + 2 * ax) + c * (1 + 2 * ay)) * (1 + 0.001 * env);
}

/* ---------------------------------------------------------------- kamera */

/** cam = { zoom?: ZoomOpts|null, sway?: SwayOpts|null } */
export const cameraActive = (cam) => zoomActive(cam?.zoom) || swayActive(cam?.sway);

/** Największa skala wrappera (koniec zoomu × pełna skala okrywająca sway) — mnożnik rozdzielczości nakładki szkicu. */
export const cameraMax = (cam, aspect) => zoomMax(cam?.zoom) * swayCover(cam?.sway, 1, aspect);

/** Ciąg transformu dla chwili (p; t s; oś `total` s). Pusty = brak ruchu. Origin wrappera = środek (50% 50%). */
export function cameraTransform(cam, p, t, total, aspect) {
  const parts = [];
  const sw = swayActive(cam?.sway) ? swayAt(t, total, cam.sway) : null;
  if (sw && sw.env > 0) {
    parts.push(`translate(${sw.tx.toFixed(4)}%, ${sw.ty.toFixed(4)}%) rotate(${sw.rot.toFixed(4)}deg) scale(${swayCover(cam.sway, sw.env, aspect).toFixed(5)})`);
  }
  if (zoomActive(cam?.zoom)) {
    const z = zoomAt(p, cam.zoom);
    const [fx, fy] = zoomOrigin(cam.zoom.focus);
    const dx = fx - 50, dy = fy - 50;
    parts.push(dx || dy ? `translate(${dx}%, ${dy}%) scale(${z}) translate(${-dx}%, ${-dy}%)` : `scale(${z})`);
  }
  return parts.join(" ");
}

/**
 * Styl nakładki szkicu (płótna renderowanego w rozmiarze wyświetlania × DPR): przy skali wrappera k płótno ma w layoucie
 * rozmiar ×k i `scale(1/k)`, więc przy skali k piksel płótna = piksel ekranu. Plain object (camelCase — `Object.assign(el.style, …)`);
 * undefined, gdy k ≤ 1 (nic do ustawiania).
 */
export function oversampleStyle(cam, aspect) {
  const k = cameraMax(cam, aspect);
  if (k <= 1) return undefined;
  return { width: `${k * 100}%`, height: `${k * 100}%`, transform: `scale(${1 / k})`, transformOrigin: "0 0" };
}

/**
 * Imperatywny sterownik wrappera (odpowiednik useCamera): `update(p, over)` ustawia `transform` tylko gdy się zmienił.
 * `over` = sekundy po końcu osi (liczone tylko przy sway.live). Bez ruchu styl jest czyszczony (brak warstwy).
 * @param {{el:HTMLElement,camera:{zoom?:object,sway?:object},total:number,aspect:number}} o
 */
export function createCamera({ el, camera, total, aspect }) {
  let cam = camera, tot = total, asp = aspect, last = "", primed = false, lastP = 0, lastOver = 0;
  const clear = () => { el.style.transform = ""; el.style.transformOrigin = ""; el.style.willChange = ""; last = ""; primed = false; };
  const api = {
    /** @param {number} p postęp osi 0..1 @param {number} [over] sekundy po końcu osi */
    update(p, over = 0) {
      lastP = p; lastOver = over;
      if (!cameraActive(cam)) { if (primed) clear(); return; }
      const tr = cameraTransform(cam, p, p * tot + (cam.sway?.live ? over : 0), tot, asp);
      if (primed && tr === last) return;
      if (!primed) { el.style.transformOrigin = "50% 50%"; el.style.willChange = "transform"; primed = true; }
      last = tr;
      el.style.transform = tr || "none";
    },
    /** Zmiana opcji/długości osi/proporcji i natychmiastowe nałożenie na bieżący stan. */
    set({ camera: c = cam, total: t = tot, aspect: a = asp } = {}) { cam = c; tot = t; asp = a; primed && (last = "\0"); api.update(lastP, lastOver); },
    dispose() { clear(); },
  };
  return api;
}

/* ---------------------------------------------------------------- sanityzacja */

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ZOOM_RANGES = { strength: [0, 40], until: [0, 100] };
const SWAY_RANGES = { ampX: [0, 5], ampY: [0, 5], rot: [0, 3], period: [2, 30], irregular: [0, 1], seed: [1, 50], from: [0, 100], to: [0, 100] };

/** Płaskie scalenie z kształtem domyślnych (zgodny typ; wyliczenia z listy), potem przycięcie do zakresów. Nigdy nie rzuca. */
function like(def, raw, enums, ranges) {
  const out = { ...def };
  if (isObj(raw)) {
    for (const k of Object.keys(def)) {
      const d = def[k], x = raw[k];
      if (typeof d === "number") { if (typeof x === "number" && Number.isFinite(x)) out[k] = x; }
      else if (typeof d === "boolean") { if (typeof x === "boolean") out[k] = x; }
      else if (typeof d === "string") { if (typeof x === "string" && (!enums[k] || enums[k].includes(x))) out[k] = x; }
    }
  }
  for (const [k, [lo, hi]] of Object.entries(ranges)) if (typeof out[k] === "number") out[k] = clamp(out[k], lo, hi);
  return out;
}

export function sanitizeZoom(raw) {
  try {
    return like(DEFAULT_ZOOM, raw, {
      direction: ZOOM_DIRECTIONS.map((o) => o[0]), curve: ZOOM_CURVES.map((o) => o[0]), focus: ZOOM_FOCI.map((o) => o[0]),
    }, ZOOM_RANGES);
  } catch { return { ...DEFAULT_ZOOM }; }
}

export function sanitizeSway(raw) {
  try { return like(DEFAULT_SWAY, raw, {}, SWAY_RANGES); } catch { return { ...DEFAULT_SWAY }; }
}

/* ---------------------------------------------------------------- pola UI (CameraSection.tsx) */
/* Klucze względem obiektu zoom / sway. `advanced` = pod „Zaawansowane”. `unit` = przyrostek wartości.
   `showIf` = pole widoczne tylko gdy ten klucz (check) jest włączony (w oryginale: reszta pól po `enabled`). */

export const ZOOM_FIELDS = [
  { key: "enabled", label: "Zoom sceny", type: "check", hint: "Powolne przybliżenie/oddalenie całej sceny (tytuł bez skali)" },
  { key: "direction", label: "Kierunek", type: "select", options: ZOOM_DIRECTIONS, showIf: "enabled" },
  { key: "strength", label: "Siła", type: "range", min: 0, max: 40, step: 1, unit: "%", showIf: "enabled",
    hint: "Powiększenie: na końcu przybliżenia / na starcie oddalenia / w połowie oddechu (10% → skala 1,10)" },
  { key: "until", label: "Do", type: "range", min: 0, max: 100, step: 5, unit: "% osi", showIf: "enabled",
    hint: "Moment osi, w którym zoom się kończy; potem obraz stoi w skali końcowej (oddalenie: pełny obraz)" },
  { key: "curve", label: "Krzywa", type: "select", options: ZOOM_CURVES, advanced: true, showIf: "enabled" },
  { key: "focus", label: "Punkt skupienia", type: "select", options: ZOOM_FOCI, advanced: true, showIf: "enabled" },
];

export const SWAY_FIELDS = [
  { key: "enabled", label: "Kołysanie kamery", type: "check", hint: "Delikatne kołysanie/dryf kamery (handheld)" },
  { key: "ampX", label: "Przesunięcie X", type: "range", min: 0, max: 5, step: 0.1, unit: "%", showIf: "enabled" },
  { key: "ampY", label: "Przesunięcie Y", type: "range", min: 0, max: 5, step: 0.1, unit: "%", showIf: "enabled" },
  { key: "rot", label: "Obrót", type: "range", min: 0, max: 3, step: 0.05, unit: "°", showIf: "enabled" },
  { key: "period", label: "Okres", type: "range", min: 2, max: 30, step: 0.5, unit: " s", showIf: "enabled" },
  { key: "irregular", label: "Nieregularność", type: "range", min: 0, max: 1, step: 0.05, advanced: true, showIf: "enabled",
    hint: "0 = czysta sinusoida; 1 = złożenie trzech niewspółmiernych sinusoid (fazy z ziarna)" },
  { key: "seed", label: "Ziarno", type: "range", min: 1, max: 50, step: 1, advanced: true, showIf: "enabled" },
  { key: "from", label: "Od", type: "range", min: 0, max: 100, step: 5, unit: "% osi", advanced: true, showIf: "enabled",
    hint: "Nie większe niż „Do” (UI powinno przycinać: from = min(from, to))" },
  { key: "to", label: "Do", type: "range", min: 0, max: 100, step: 5, unit: "% osi", advanced: true, showIf: "enabled",
    hint: "Nie mniejsze niż „Od” (UI powinno przycinać: to = max(to, from))" },
  { key: "live", label: "Kontynuuj po końcu osi", type: "check", advanced: true, showIf: "enabled",
    hint: "Po końcu osi kołysanie trwa dalej (tick ~30 fps samego wrappera; pauza/ukryta karta zatrzymują)" },
];

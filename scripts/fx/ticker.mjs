/* Pasek wiadomości (news bar): czysty DOM + Web Animations API, bez Foundry — harness (tools/harness-ticker.html)
   importuje ten plik wprost. Klej Foundry (stan „na antenie”, aktualizacje na żywo, układ względem UI) jest w ticker-play.mjs.

   Trzy wyglądy (`look`), każdy z własnym układem, krojem, logiką koloru i choreografią — wspólny jest tylko rdzeń
   (kolejka wiadomości, pętla / jeden przebieg, aktualizacje na żywo, klapka / przesuw, zejście, ograniczony ruch):

   • broadcast — telewizja: ciemny blok kanału z lewej, belka z tytułem w kolorze akcentu, jasny pasek. Wejście: blok wycina
     się z lewej, pasek wyciąga się z bloku, belka wyrasta zza paska; zmiana wiadomości: pionowa klapka.
   • wire — dalekopis: papierowa taśma wklejona lekko krzywo, kanał i „na żywo” jako odciski pieczątek, tytuł jako
     przyklejony pasek gazety (szeryf), treść pisana maszynowo literą po literze (etykieta czerwoną częścią taśmy barwiącej);
     długi tekst przesuwa się razem z karetką. Wejście: taśma wysuwa się z lewej, pieczątki uderzają, tytuł spada na taśmę;
     zejście: tytuł się odkleja, taśma cofa się w lewo.
   • signal — sygnał (sci-fi): ciemne pasmo ze ściętym końcem, cienka szyna świetlna w kolorze akcentu, szeroki krój
     techniczny. Wejście: szyna rysuje się od lewej, pasmo otwiera się w dół z szyny, zakładka kanału i płytka tytułu wysuwają
     się z niej; zmiana wiadomości: stara gaśnie jak obraz kineskopu (do kreski), nową odsłania przejeżdżająca wiązka;
     zejście: wszystko zwija się do szyny, a szyna gaśnie w prawo.

   prefers-reduced-motion: tylko przenikanie, przesuw zamienia się w klapkę, pisanie maszynowe — w gotowy tekst. */

export const TICKER_MODES = ["loop", "once"];
export const TICKER_STYLES = ["flip", "crawl"];
export const TICKER_LOOKS = ["broadcast", "wire", "signal"];
export const TICKER_SIZES = { s: 0.85, m: 1, l: 1.2 };
export const TICKER_LIMITS = { items: 60, label: 24, text: 280, channel: 40, headline: 90, limitMin: 240 };
export const DEFAULT_TICKER = Object.freeze({
  look: "broadcast", channel: "", headline: "", accent: "#c8102e", live: true, mode: "loop", style: "flip", speed: 1, limitMin: 0, size: "m", items: [],
});

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9]{1,16}$/i;
const line = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (v, lo, hi, d) => { const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export const tickerItemId = () => Math.random().toString(36).slice(2, 10) || "i0";

/** Dowolny obiekt → poprawna konfiguracja paska (nigdy nie rzuca). Pozycje: tablica albo obiekt {0:…,1:…} (expandObject).
    Stare presety (bez `look`) dostają wygląd „broadcast”. */
export function sanitizeTicker(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const src = Array.isArray(r.items) ? r.items : r.items && typeof r.items === "object" ? Object.values(r.items) : [];
  const items = [], seen = new Set();
  for (const it of src) {
    if (!it || typeof it !== "object") continue;
    const text = line(it.text, TICKER_LIMITS.text);
    if (!text) continue;
    let id = typeof it.id === "string" && ID.test(it.id) && !seen.has(it.id) ? it.id : "";
    while (!id || seen.has(id)) id = tickerItemId();
    seen.add(id);
    items.push({ id, label: line(it.label, TICKER_LIMITS.label), text });
    if (items.length >= TICKER_LIMITS.items) break;
  }
  const D = DEFAULT_TICKER;
  return {
    look: TICKER_LOOKS.includes(r.look) ? r.look : D.look,
    channel: line(r.channel, TICKER_LIMITS.channel),
    headline: line(r.headline, TICKER_LIMITS.headline),
    accent: typeof r.accent === "string" && HEX.test(r.accent) ? r.accent.toLowerCase() : D.accent,
    live: typeof r.live === "boolean" ? r.live : D.live,
    mode: TICKER_MODES.includes(r.mode) ? r.mode : D.mode,
    style: TICKER_STYLES.includes(r.style) ? r.style : D.style,
    speed: Math.round(num(r.speed, 0.5, 2, D.speed) * 100) / 100,
    limitMin: Math.round(num(r.limitMin, 0, TICKER_LIMITS.limitMin, D.limitMin)),
    size: typeof r.size === "string" && Object.hasOwn(TICKER_SIZES, r.size) ? r.size : D.size,
    items,
  };
}

/* ---------------------------------------------------------------- kolor */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
function lum(c) {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const TICKER_INK = "#0d1016";
const WHITE = [255, 255, 255], INK = rgb(TICKER_INK);
/** Kolor tekstu na tle `hex`: biały albo atrament — co daje większy kontrast. */
export function inkOn(hex) { const c = rgb(hex); return contrast(c, WHITE) >= contrast(c, INK) ? "#ffffff" : TICKER_INK; }
/** Ciemniejszy wariant akcentu (etykiety pod belką w kolorze akcentu nie mogą się z nią zlewać). */
export const deepen = (hex, k = 0.68) => toHex(rgb(hex).map((v) => v * k));
/**
 * Akcent jako kolor TEKSTU na podłożu `ground` z kontrastem ≥ `min`: na jasnym papierze przyciemniany, na ciemnym paśmie
 * rozjaśniany (barwa zostaje). Żółty akcent na papierze dalekopisu nie może zniknąć, ciemnoczerwony na paśmie sygnału też nie.
 */
export function accentOn(hex, ground, min = 4.5) {
  const g = rgb(ground), dark = lum(g) < 0.2;
  let c = rgb(hex);
  for (let i = 0; i < 24 && contrast(c, g) < min; i++) c = c.map((v) => (dark ? v + (255 - v) * 0.12 : v * 0.88));
  return toHex(c);
}

/** Podłoża wyglądów (tekst i etykiety są do nich dopasowywane). */
const GROUND = { broadcast: "#f1f2f4", wire: "#ebe6d9", signal: "#0b1017" };

/* ---------------------------------------------------------------- czasy */
/** Ile trzymać wiadomość, która mieści się w pasku (czas czytania), w ms. */
export const readHoldMs = (chars, speed = 1) => (Math.min(11, Math.max(3.6, 2.4 + chars * 0.055)) / speed) * 1000;
const crawlPxps = (u, speed) => u * 4.4 * speed;
/** Dalekopis: znaki na sekundę (pisanie maszynowe) i ile trzymać wiadomość po dopisaniu (czytało się w trakcie pisania). */
const typeCps = (speed) => 30 * speed;
const typedHoldMs = (chars, speed) => Math.max(1800 / speed, readHoldMs(chars, speed) * 0.45);

/**
 * Szacowany czas jednego pełnego przebiegu (wejście + wszystkie pozycje + zejście), w ms. Tylko zapas dla GM-a w trybie
 * „jeden przebieg” (gdy jego karta jest w tle) — dokładny koniec wyznacza sam pasek.
 */
export function estimatePassMs(data, viewportPx = 1500, u = 23) {
  const d = sanitizeTicker(data), cw = u * 0.5;
  let ms = 1800;
  if (d.style === "crawl") {
    let w = viewportPx;
    for (const it of d.items) w += it.text.length * cw + it.label.length * cw * 0.85 + u * 3.2;
    return ms + (w / crawlPxps(u, d.speed)) * 1000;
  }
  for (const it of d.items) {
    if (d.look === "wire") { // pisanie maszynowe: czas pisania + krótkie trzymanie (długie teksty przesuwają się z karetką)
      const n = it.text.length + (it.label ? it.label.length + 3 : 0);
      ms += 700 + (n / typeCps(d.speed)) * 1000 + typedHoldMs(it.text.length, d.speed);
      continue;
    }
    const over = it.text.length * cw - (viewportPx - it.label.length * cw - u * 3);
    ms += 700 + (over > 0 ? (1400 + 1800) / d.speed + (over / crawlPxps(u, d.speed)) * 1000 : readHoldMs(it.text.length, d.speed));
  }
  return ms;
}

/* ---------------------------------------------------------------- animacje */
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";   // pewne lądowanie (expo-out)
const EASE_IN = "cubic-bezier(0.7, 0, 0.84, 0)";    // szybkie zejście
const EASE_STAMP = "cubic-bezier(0.3, 0, 0.2, 1)";  // pieczątka: szybki opad, twarde zatrzymanie
const SHUT = "inset(0 100% 0 0)", OPEN = "inset(0 0% 0 0)";
const settle = (a) => (a ? a.finished.then(() => {}, () => {}) : Promise.resolve());
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
/** Wejście: pierwsza klatka trzyma się w czasie opóźnienia (backwards), po końcu element wraca do stanu z CSS (widoczny). */
const enter = (el, kf, o) => el.animate(kf, { fill: "backwards", ...o });
/** Zejście: końcowa klatka zostaje (forwards) aż do usunięcia elementu. */
const leave = (el, kf, o) => el.animate(kf, { fill: "forwards", ...o });
/** Usuń element po animacji zejścia — albo najpóźniej po `ms` (karta w tle wstrzymuje animacje i `finished` nie przychodzi). */
const dropAfter = (el, a, ms = 1200) => { const t = setTimeout(() => el.remove(), ms); settle(a).then(() => { clearTimeout(t); el.remove(); }); };

const STOP_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>`;

export function prefersReducedMotion() {
  try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/* ================================================================ wyglądy
   Każdy wygląd: build (DOM: ustawia bar.brand/channel/liveTag/strap/strapIn/hlMask/headline/line/slot), entry, strapIn,
   frame (element jednej wiadomości), swap (animacje zmiany wiadomości → tablica animacji), headlineSwap, segment (przesuw),
   exit (animacje zejścia → tablica). Opcjonalnie dwell (własny czas trwania wiadomości — dalekopis pisze). */

/** Wspólne elementy kanału: nazwa i znacznik „na żywo” (kropka + tekst). */
function brandParts(b, liveCls = "srn-live") {
  b.channel = mk("span", "srn-channel");
  b.liveTag = mk("span", liveCls);
  b.liveTag.append(mk("i", "srn-dot"), mk("span", "srn-live-text", b.strings.live));
}
function headlineParts(b) {
  b.strap = mk("div", "srn-strap");
  b.strapIn = mk("div", "srn-strap-in");
  b.hlMask = mk("div", "srn-hl-mask");
  b.headline = mk("p", "srn-headline");
  b.hlMask.append(b.headline);
  b.strapIn.append(b.hlMask);
  b.strap.append(b.strapIn);
}
/** Stary tytuł jako duch nad nowym (do animacji zmiany tytułu). */
function headlineGhost(b, text) {
  // najwyżej jeden duch naraz: szybkie zmiany tytułu (albo karta w tle) nie zostawiają stosu starych tytułów
  for (const old of b.hlMask.querySelectorAll(".srn-headline-ghost")) old.remove();
  const g = mk("p", "srn-headline srn-headline-ghost", text);
  g.setAttribute("aria-hidden", "true");
  b.hlMask.append(g);
  return g;
}

/* ---------------------------------------------------------------- broadcast (telewizja) */
const BROADCAST = {
  build(b) {
    b.shadow = mk("div", "srn-shadow");
    b.pack = mk("div", "srn-pack");
    b.brand = mk("div", "srn-brand");
    brandParts(b);
    b.sheen = mk("i", "srn-sheen");
    b.brand.append(b.channel, b.liveTag, b.sheen);
    headlineParts(b);
    b.line = mk("div", "srn-line");
    b.slot = mk("div", "srn-slot");
    b.line.append(b.slot);
    b._stopButton(b.line);
    b.pack.append(b.brand, b.strap, b.line);
    b.el.append(b.shadow, b.pack);
  },
  entry(b) {
    const hasBrand = !b.el.classList.contains("srn-no-brand");
    const b0 = hasBrand ? 170 : 0; // pasek wyciąga się z bloku kanału, gdy blok jest
    if (hasBrand) {
      enter(b.brand, [{ clipPath: SHUT }, { clipPath: OPEN }], { duration: 400, easing: EASE_OUT });
      enter(b.channel, [{ opacity: 0, transform: "translateY(0.45em)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: 210, easing: EASE_OUT });
      enter(b.liveTag, [{ opacity: 0, transform: "translateY(0.45em)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: 290, easing: EASE_OUT });
      if (!b.lite) enter(b.sheen, [{ transform: "translateX(-130%) skewX(-18deg)", opacity: 1 }, { transform: "translateX(260%) skewX(-18deg)", opacity: 1 }], { duration: 760, delay: 330, easing: "cubic-bezier(0.45, 0, 0.2, 1)" });
    }
    enter(b.line, [{ clipPath: SHUT }, { clipPath: OPEN }], { duration: 620, delay: b0, easing: EASE_OUT });
    enter(b.shadow, [{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: b0, easing: "ease-out" });
    if (b.data.headline) BROADCAST.strapIn(b, b0 + 260);
  },
  strapIn(b, delay = 0) {
    enter(b.strapIn, [{ transform: "translateY(101%)" }, { transform: "none" }], { duration: 480, delay, easing: EASE_OUT });
    enter(b.headline, [{ transform: "translateY(115%)" }, { transform: "none" }], { duration: 460, delay: delay + 110, easing: EASE_OUT });
  },
  frame(b, item) {
    const f = mk("div", "srn-frame");
    if (item.label) { const c = mk("span", "srn-chip"); c.append(mk("span", "srn-chip-text", item.label)); f.append(c); }
    const vp = mk("span", "srn-viewport");
    vp.append(mk("span", "srn-text", item.text));
    f.append(vp);
    return f;
  },
  /** Klapka: stara odjeżdża w górę, nowa wjeżdża od dołu; etykieta wycina się z lewej. */
  swap(b, old, frame) {
    const a = [];
    if (old) a.push(leave(old, [{ transform: "none", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0.25 }], { duration: 280, easing: EASE_IN }));
    if (frame) {
      const d = old ? 120 : 0;
      a.push(enter(frame, [{ transform: "translateY(100%)" }, { transform: "none" }], { duration: 480, delay: d, easing: EASE_OUT }));
      const chip = frame.querySelector(".srn-chip");
      if (chip) {
        a.push(enter(chip, [{ clipPath: SHUT }, { clipPath: OPEN }], { duration: 380, delay: d + 140, easing: EASE_OUT }));
        a.push(enter(chip.firstChild, [{ opacity: 0, transform: "translateY(55%)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: d + 240, easing: EASE_OUT }));
      }
      a.push(enter(frame.querySelector(".srn-text"), [{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: d + 60, easing: "ease-out" }));
    }
    return a;
  },
  headlineSwap(b, oldText) {
    // stary tytuł odjeżdża w górę, nowy wjeżdża od dołu (jak zmiana pozycji na pasku)
    const ghost = headlineGhost(b, oldText);
    dropAfter(ghost, leave(ghost, [{ transform: "none" }, { transform: "translateY(-115%)" }], { duration: 260, easing: EASE_IN }));
    enter(b.headline, [{ transform: "translateY(115%)" }, { transform: "none" }], { duration: 460, delay: 90, easing: EASE_OUT });
  },
  segment(b, item) {
    const s = mk("span", "srn-seg");
    if (item.label) s.append(mk("b", "srn-seg-label", item.label));
    s.append(mk("span", "srn-seg-text", item.text), mk("i", "srn-sep"));
    return s;
  },
  exit(b) {
    const done = [];
    const content = b._frame ?? b._track;
    if (content) done.push(leave(content, [{ transform: "none", opacity: 1 }, { transform: "translateY(100%)", opacity: 0.3 }], { duration: 220, easing: EASE_IN }));
    if (b.data.headline) {
      done.push(leave(b.headline, [{ transform: "none" }, { transform: "translateY(115%)" }], { duration: 200, delay: 40, easing: EASE_IN }));
      done.push(leave(b.strapIn, [{ transform: "none" }, { transform: "translateY(101%)" }], { duration: 260, delay: 120, easing: EASE_IN }));
    }
    done.push(leave(b.line, [{ clipPath: OPEN }, { clipPath: SHUT }], { duration: 340, delay: 230, easing: EASE_IN }));
    done.push(leave(b.shadow, [{ opacity: 1 }, { opacity: 0 }], { duration: 300, delay: 300, easing: "ease-in" }));
    if (!b.el.classList.contains("srn-no-brand")) {
      done.push(leave(b.channel, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, delay: 400, easing: "ease-in" }));
      done.push(leave(b.liveTag, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, delay: 400, easing: "ease-in" }));
      done.push(leave(b.brand, [{ clipPath: OPEN }, { clipPath: SHUT }], { duration: 280, delay: 450, easing: EASE_IN }));
    }
    return done;
  },
};

/* ---------------------------------------------------------------- wire (dalekopis) */
/**
 * Prawe krawędzie (px, względem początku tekstu) po 0…n znakach treści `lab` + `tx` (jeden odczyt układu, potem same
 * prostokąty zakresów). Element [k] = szerokość pierwszych k znaków (jednostki UTF-16 — jak slice przy pisaniu).
 */
function typedEnds(lab, tx) {
  const nodes = [lab.firstChild, tx.firstChild].filter((n) => n?.nodeType === 3 && n.length);
  const total = nodes.reduce((a, n) => a + n.length, 0), ends = new Float32Array(total + 1);
  if (!total) return ends;
  const r = document.createRange();
  r.setStart(nodes[0], 0); r.setEnd(nodes[0], 0);
  const x0 = r.getBoundingClientRect().left;
  let k = 0;
  for (const n of nodes) {
    for (let i = 0; i < n.length; i++) {
      r.setStart(n, i); r.setEnd(n, i + 1);
      const right = r.getBoundingClientRect().right - x0;
      k++;
      ends[k] = Math.max(ends[k - 1], right);
    }
  }
  return ends;
}
const WIRE = {
  build(b) {
    b.pack = mk("div", "srn-pack");
    headlineParts(b);                       // przyklejony pasek gazety nad taśmą
    b.line = mk("div", "srn-line");         // taśma
    b.brand = mk("div", "srn-brand");       // pieczątki na początku taśmy
    brandParts(b);
    b.brand.append(b.channel, b.liveTag);
    b.slot = mk("div", "srn-slot");
    b.line.append(b.brand, b.slot);
    b._stopButton(b.line);
    b.pack.append(b.strap, b.line);
    b.el.append(b.pack);
  },
  entry(b) {
    // taśma wysuwa się z lewej (jak wyciągana z dalekopisu), potem uderzają pieczątki, na końcu spada pasek z tytułem
    enter(b.line, [{ transform: "translateX(-104%)" }, { transform: "none" }], { duration: 720, easing: EASE_OUT });
    WIRE.stamp(b.channel, 470);
    WIRE.stamp(b.liveTag, 590);
    if (b.data.headline) WIRE.strapIn(b, 700);
  },
  /** Odcisk pieczątki: z góry, większy i przezroczysty → twardo na papier (obrót zostaje w CSS: właściwość `rotate`). */
  stamp(el, delay) {
    if (!el || el.hidden) return;
    enter(el, [{ opacity: 0, transform: "scale(1.85)" }, { opacity: 1, transform: "scale(0.97)", offset: 0.82 }, { opacity: 1, transform: "none" }], { duration: 230, delay, easing: EASE_STAMP });
  },
  strapIn(b, delay = 0) {
    enter(b.strapIn, [{ opacity: 0, transform: "translateY(-70%) scale(1.04)" }, { opacity: 1, transform: "none" }], { duration: 360, delay, easing: EASE_OUT });
  },
  frame(b, item) {
    const f = mk("div", "srn-frame");
    const vp = mk("span", "srn-viewport");
    const type = mk("span", "srn-type");
    type.setAttribute("aria-hidden", "true");
    const lab = mk("span", "srn-type-label"), tx = mk("span", "srn-text"), caret = mk("i", "srn-caret");
    type.append(lab, tx, caret);
    vp.append(type);
    // czytnik ekranu dostaje całą wiadomość od razu (pisanie znak po znaku byłoby czytane w kółko)
    f.append(vp, mk("span", "srn-sr", item.label ? `${item.label}: ${item.text}` : item.text));
    if (b.reduced) { lab.textContent = WIRE.labelText(item); tx.textContent = item.text; }
    return f;
  },
  labelText: (item) => (item.label ? `${item.label} — ` : ""),
  /** Taśma przesuwa się w lewo (stary tekst odjeżdża), nowy pisze się od początku. */
  swap(b, old, frame) {
    const a = [];
    if (old) a.push(leave(old, [{ transform: "none", opacity: 1 }, { transform: "translateX(-38%)", opacity: 0 }], { duration: 300, easing: EASE_IN }));
    if (frame) a.push(enter(frame, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: old ? 220 : 0, easing: "linear" }));
    return a;
  },
  /** Pisanie maszynowe: etykieta (czerwona część taśmy barwiącej), potem treść; karetka trzyma się w polu widzenia. */
  async dwell(b, item, gen) {
    const frame = b._frame;
    const sp = b.data.speed;
    if (!frame) return;
    if (b.reduced) return b._sleep(readHoldMs(item.text.length + item.label.length * 0.5, sp));
    const vp = frame.querySelector(".srn-viewport"), type = frame.querySelector(".srn-type");
    const lab = type.querySelector(".srn-type-label"), tx = type.querySelector(".srn-text");
    const head = WIRE.labelText(item), full = head + item.text, split = head.length;
    const cps = typeCps(sp), t0 = performance.now();
    let k = 0;
    frame.classList.add("srn-typing");
    // jeden pomiar na wiadomość (zamiast wymuszonego układu strony co znak): szerokość taśmy z całym tekstem i prawe
    // krawędzie kolejnych znaków → szerokość taśmy po k znakach = pełna − (krawędź ostatniego − krawędź k-tego)
    lab.textContent = head; tx.textContent = item.text;
    const ends = typedEnds(lab, tx), fullW = type.scrollWidth, room = vp.clientWidth - b._u * 1.4;
    lab.textContent = ""; tx.textContent = "";
    const endAll = ends[ends.length - 1];
    const advance = () => {
      const over = fullW - (endAll - ends[Math.min(k, ends.length - 1)]) - room;
      type.style.transform = over > 0 ? `translateX(${-over}px)` : "";
    };
    while (k < full.length) {
      if (!b._alive(gen) || b._frame !== frame) return;
      const want = Math.min(full.length, Math.floor(((performance.now() - t0) / 1000) * cps) + 1);
      if (want !== k) {
        k = want;
        lab.textContent = full.slice(0, Math.min(k, split));
        tx.textContent = k > split ? full.slice(split, k) : "";
        advance();
      }
      await b._sleep(28);
    }
    frame.classList.remove("srn-typing");
    await b._sleep(typedHoldMs(item.text.length, sp));
  },
  headlineSwap(b, oldText) {
    // stary pasek z tytułem odkleja się i odpada, nowy spada na jego miejsce
    for (const old of b.strap.querySelectorAll(".srn-strap-ghost")) old.remove();
    const ghost = b.strapIn.cloneNode(true);
    ghost.classList.add("srn-strap-ghost");
    ghost.setAttribute("aria-hidden", "true");
    ghost.querySelector(".srn-headline").textContent = oldText;
    b.strap.append(ghost);
    dropAfter(ghost, leave(ghost, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-55%) rotate(-5deg)" }], { duration: 260, easing: EASE_IN }));
    WIRE.strapIn(b, 140);
  },
  segment(b, item) {
    const s = mk("span", "srn-seg");
    if (item.label) s.append(mk("b", "srn-seg-label", WIRE.labelText(item)));
    s.append(mk("span", "srn-seg-text", item.text), mk("i", "srn-sep"));
    return s;
  },
  exit(b) {
    const done = [];
    const content = b._frame ?? b._track;
    if (content) done.push(leave(content, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in" }));
    if (b.data.headline) done.push(leave(b.strapIn, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-60%) rotate(-6deg)" }], { duration: 280, delay: 40, easing: EASE_IN }));
    done.push(leave(b.line, [{ transform: "none" }, { transform: "translateX(-104%)" }], { duration: 420, delay: 180, easing: EASE_IN }));
    return done;
  },
};

/* ---------------------------------------------------------------- signal (sci-fi) */
const SIGNAL = {
  build(b) {
    b.pack = mk("div", "srn-pack");
    headlineParts(b);                       // płytka z tytułem nad szyną
    b.rail = mk("i", "srn-rail");           // szyna świetlna (krawędź pasma)
    b.scan = mk("i", "srn-scan");
    b.rail.append(b.scan);
    b.line = mk("div", "srn-line");         // ciemne pasmo
    b.brand = mk("div", "srn-brand");       // ścięta zakładka kanału
    brandParts(b);
    b.brand.append(b.channel, b.liveTag);
    b.slot = mk("div", "srn-slot");
    b.line.append(b.brand, b.slot);
    b._stopButton(b.line);
    b.pack.append(b.strap, b.line, b.rail);
    b.el.append(b.pack);
  },
  entry(b) {
    const hasBrand = !b.el.classList.contains("srn-no-brand");
    // szyna rysuje się od lewej, pasmo otwiera się z niej w dół, zakładka i płytka wysuwają się z szyny
    enter(b.rail, [{ transform: "scaleX(0)" }, { transform: "none" }], { duration: 560, easing: "cubic-bezier(0.65, 0, 0.35, 1)" });
    enter(b.line, [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0% 0)" }], { duration: 420, delay: 380, easing: EASE_OUT });
    if (hasBrand) {
      enter(b.brand, [{ clipPath: SHUT }, { clipPath: OPEN }], { duration: 380, delay: 560, easing: EASE_OUT });
      enter(b.channel, [{ opacity: 0, transform: "translateX(-0.5em)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 700, easing: EASE_OUT });
      enter(b.liveTag, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 820, easing: "steps(3, end)" });
    }
    if (b.data.headline) SIGNAL.strapIn(b, 640);
    SIGNAL.scanLoop(b, 1400);
  },
  /** Spokojny przebieg światła po szynie co kilka sekund (bez połysku w trybie lekkim / ograniczonego ruchu). */
  scanLoop(b, delay) {
    if (b.lite || b.reduced || !b.scan) return;
    b._scanAnim = b.scan.animate(
      [{ transform: "translateX(-100%)", opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.3 }, { transform: "translateX(500%)", opacity: 0, offset: 0.38 }, { transform: "translateX(500%)", opacity: 0 }],
      { duration: 7000, delay, iterations: Infinity, easing: "linear" });
  },
  strapIn(b, delay = 0) {
    enter(b.strapIn, [{ clipPath: "inset(100% 0 0 0)" }, { clipPath: "inset(0% 0 0 0)" }], { duration: 420, delay, easing: EASE_OUT });
    enter(b.headline, [{ transform: "translateY(110%)" }, { transform: "none" }], { duration: 460, delay: delay + 80, easing: EASE_OUT });
  },
  frame: (b, item) => BROADCAST.frame(b, item),
  /** Stara gaśnie do poziomej kreski (jak kineskop), nową odsłania wiązka jadąca od lewej. */
  swap(b, old, frame) {
    const a = [];
    if (old) a.push(leave(old, [{ clipPath: "inset(0 0 0 0)", opacity: 1 }, { clipPath: "inset(47% 0 47% 0)", opacity: 0.6, offset: 0.75 }, { clipPath: "inset(50% 0 50% 0)", opacity: 0 }], { duration: 220, easing: EASE_IN }));
    if (frame) {
      const d = old ? 170 : 0;
      // wiązka jedzie do końca tekstu (albo do prawej krawędzi, gdy tekst jest dłuższy niż pasek)
      const chip = frame.querySelector(".srn-chip"), tx = frame.querySelector(".srn-text");
      const run = Math.max(40, Math.min(b._slotWidth, (chip?.offsetWidth ?? 0) + (tx?.offsetWidth ?? 0) + b._u * 1.7));
      const beam = mk("i", "srn-beam");
      frame.append(beam);
      const t = 460;
      a.push(enter(frame, [{ clipPath: "inset(0 calc(100% - 2px) 0 0)" }, { clipPath: `inset(0 calc(100% - ${run}px) 0 0)`, offset: 0.999 }, { clipPath: "inset(0 0 0 0)" }], { duration: t, delay: d, easing: "cubic-bezier(0.25, 0.6, 0.2, 1)" }));
      const ba = beam.animate([{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${run}px)`, opacity: 1, offset: 0.85 }, { transform: `translateX(${run}px)`, opacity: 0 }],
        { duration: t + 120, delay: d, easing: "cubic-bezier(0.25, 0.6, 0.2, 1)", fill: "both" });
      settle(ba).then(() => beam.remove());
      if (chip) a.push(enter(chip, [{ opacity: 0.35 }, { opacity: 1 }], { duration: 240, delay: d + 60, easing: "ease-out" }));
    }
    return a;
  },
  headlineSwap(b, oldText) {
    const ghost = headlineGhost(b, oldText);
    dropAfter(ghost, leave(ghost, [{ clipPath: "inset(0 0 0 0)", opacity: 1 }, { clipPath: "inset(50% 0 50% 0)", opacity: 0 }], { duration: 220, easing: EASE_IN }));
    enter(b.headline, [{ clipPath: SHUT }, { clipPath: OPEN }], { duration: 480, delay: 160, easing: "cubic-bezier(0.25, 0.6, 0.2, 1)" });
  },
  segment(b, item) {
    const s = mk("span", "srn-seg");
    if (item.label) s.append(mk("b", "srn-seg-label", item.label));
    s.append(mk("span", "srn-seg-text", item.text), mk("i", "srn-sep"));
    return s;
  },
  exit(b) {
    const done = [];
    b._scanAnim?.cancel();
    const content = b._frame ?? b._track;
    if (content) done.push(leave(content, [{ clipPath: "inset(0 0 0 0)", opacity: 1 }, { clipPath: "inset(50% 0 50% 0)", opacity: 0 }], { duration: 180, easing: EASE_IN }));
    if (b.data.headline) done.push(leave(b.strapIn, [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(100% 0 0 0)" }], { duration: 220, delay: 40, easing: EASE_IN }));
    if (!b.el.classList.contains("srn-no-brand")) done.push(leave(b.brand, [{ clipPath: OPEN }, { clipPath: SHUT }], { duration: 200, delay: 90, easing: EASE_IN }));
    done.push(leave(b.line, [{ clipPath: "inset(0 0 0% 0)" }, { clipPath: "inset(0 0 100% 0)" }], { duration: 260, delay: 170, easing: EASE_IN }));
    done.push(leave(b.rail, [{ transform: "none", transformOrigin: "100% 50%" }, { transform: "scaleX(0)", transformOrigin: "100% 50%" }], { duration: 300, delay: 380, easing: EASE_IN }));
    return done;
  },
};

const LOOKS = { broadcast: BROADCAST, wire: WIRE, signal: SIGNAL };

/* ================================================================ kolizje z dolnym UI innych modułów */
/** Znane dolne paski innych modułów — tylko podpowiedź (gdy siedzą głębiej w DOM); resztę znajduje przegląd ogólny. */
export const KNOWN_BOTTOM_UI = ["#mm-dir-bar", "#invincible-party"];
/** Nie są przeszkodą: sam pasek, okna aplikacji (rysują się nad paskiem i tak), dymki, menu, nakładki tego modułu. */
const NOT_OBSTACLE = ".srn, .application, .app, .window-app, #tooltip, .locked-tooltip, #context-menu, #notifications, .sketch-reveal-overlay, .sr-sync-hud";
const MIN_BAND = 320;

/** Kandydaci: dzieci <body> i #interface (tam moduły dokładają pływające paski) oraz znane selektory. */
function bottomCandidates(extra) {
  const out = new Set();
  const add = (el) => { if (el instanceof HTMLElement) out.add(el); };
  for (const el of document.body?.children ?? []) add(el);
  for (const el of document.getElementById("interface")?.children ?? []) add(el);
  for (const sel of extra) { try { document.querySelectorAll(sel).forEach(add); } catch { /* zły selektor */ } }
  return out;
}

/** Prostokąty widocznych, pływających (fixed / absolute / sticky) elementów UI w dolnej części ekranu. */
export function bottomObstacles(extra = KNOWN_BOTTOM_UI) {
  const W = innerWidth, H = innerHeight, boxes = [];
  for (const el of bottomCandidates(extra)) {
    if (el.matches(NOT_OBSTACLE)) continue;
    const cs = getComputedStyle(el);
    if (!/^(fixed|absolute|sticky)$/.test(cs.position) || cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= H) continue;
    if (r.width * r.height > W * H * 0.25) continue; // tło, płótno, nakładka pełnoekranowa
    if (r.bottom < H * 0.7) continue;                // nie sięga dołu ekranu (np. baner pauzy na środku)
    boxes.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, el });
  }
  return boxes;
}

/**
 * Odstępy paska {left, right, bottom} poprawione tak, żeby pasek nie zachodził na pływające dolne UI innych modułów:
 * przeszkoda w pasie paska → pasek wjeżdża nad nią; gdy to wymagałoby podniesienia o więcej niż `maxRise` wysokości okna
 * (wysoki panel przy krawędzi), pasek zwęża się od tej strony. Wynik nigdy nie jest niżej niż wejście (pasek makr zostaje
 * odsłonięty). `barHeight` — wysokość paska w px (z belką tytułu).
 */
export function avoidBottomUi(b, { barHeight = 0, gap = 8, maxRise = 0.42, obstacles = null } = {}) {
  const W = innerWidth, H = innerHeight;
  const out = { left: b.left, right: b.right, bottom: b.bottom };
  const boxes = obstacles ?? bottomObstacles();
  const h = Math.max(barHeight, 24);
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const r of boxes) {
      const x0 = out.left, x1 = W - out.right, yTop = H - out.bottom - h, yBot = H - out.bottom;
      if (r.right <= x0 || r.left >= x1 || r.bottom <= yTop || r.top >= yBot) continue; // nie zachodzi
      const rise = H - r.top + gap;
      if (rise + h <= H * maxRise + b.bottom) { out.bottom = Math.max(out.bottom, rise); moved = true; continue; }
      // za wysoko, żeby nad tym wjechać: zwęź pasek od strony, przy której przeszkoda stoi
      const fromLeft = r.left - x0 < x1 - r.right;
      const left = fromLeft ? r.right + gap : out.left, right = fromLeft ? out.right : W - r.left + gap;
      if (W - left - right >= MIN_BAND) { out.left = left; out.right = right; moved = true; }
    }
    if (!moved) break;
  }
  return out;
}

/* ================================================================ pasek */
export class NewsBar {
  /**
   * @param {object} o
   * @param {object} o.data           konfiguracja (sanitizeTicker)
   * @param {HTMLElement} [o.host]    rodzic (domyślnie body); pasek ma position: fixed
   * @param {boolean} [o.reduced]     ograniczony ruch (domyślnie wg prefers-reduced-motion)
   * @param {boolean} [o.lite]        bez połysku przy wejściu i bez przebiegu światła (ustawienie wydajności)
   * @param {{live:string, stop:string, region:string}} [o.strings]
   * @param {(() => void)|null} [o.onStop]   przycisk „zdejmij” (tylko gdy podany — GM / podgląd)
   * @param {(() => void)|null} [o.onFinish] tryb „jeden przebieg”: wszystkie pozycje pokazane (przed zejściem)
   */
  constructor({ data, host = document.body, reduced = prefersReducedMotion(), lite = false, strings = {}, onStop = null, onFinish = null }) {
    this.data = sanitizeTicker(data);
    this.host = host; this.reduced = !!reduced; this.lite = !!lite;
    this.strings = { live: "LIVE", stop: "Take down", region: "News", ...strings };
    this.onStop = onStop; this.onFinish = onFinish;
    this.state = "idle"; this._gen = 0; this._timers = new Set(); this._raf = 0; this._wake = null; this._stale = new Set();
    this._ro = null; this._slotW = 0; this._exitT = 0;
    this._cur = null; this._frame = null; this._lastIdx = 0; this._shown = new Set(); this._bounds = null;
    this.finished = new Promise((res) => { this._resolveFinished = res; });
  }

  get look() { return LOOKS[this.data.look] ?? BROADCAST; }

  /* ---- DOM */
  _build() {
    const root = this.el = mk("section", `srn srn-${this.data.look}`);
    root.setAttribute("role", "region");
    root.setAttribute("aria-roledescription", this.strings.region);
    this._lookId = this.data.look;
    this.stopBtn = null; this.rail = null; this.scan = null; this.shadow = null; this.sheen = null;
    this.look.build(this);
    this._applyLook(this.data);
    if (this._bounds) this.setBounds(this._bounds);
    this.host.append(root);
    this._observe();
  }

  /** Przycisk „zdejmij” (tylko GM / podgląd): jedyne miejsce paska, które łapie wskaźnik. */
  _stopButton(parent) {
    if (!this.onStop) return;
    const b = this.stopBtn = mk("button", "srn-stop");
    b.type = "button"; b.innerHTML = STOP_SVG;
    b.setAttribute("aria-label", this.strings.stop); b.title = this.strings.stop;
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.onStop?.(); });
    parent.append(b);
  }

  /** Kolory, rozmiar, kanał, znacznik na żywo, tytuł — bez animacji (wołane przy budowie i przy aktualizacji). */
  _applyLook(d) {
    const s = this.el.style;
    const deep = deepen(d.accent);
    s.setProperty("--srn-accent", d.accent);
    s.setProperty("--srn-on-accent", inkOn(d.accent));
    s.setProperty("--srn-accent-deep", deep);
    s.setProperty("--srn-on-accent-deep", inkOn(deep));
    // akcent jako tekst na podłożu tego wyglądu (pieczątki na papierze, etykiety na ciemnym paśmie)
    s.setProperty("--srn-accent-ink", accentOn(d.accent, GROUND[this._lookId] ?? GROUND.broadcast));
    s.setProperty("--srn-k", String(TICKER_SIZES[d.size] ?? 1));
    this._uAt = 0;
    this.channel.textContent = d.channel;
    this.channel.hidden = !d.channel;
    this.liveTag.hidden = !d.live;
    const hasBrand = !!(d.channel || d.live);
    this.el.classList.toggle("srn-no-brand", !hasBrand);
    this.el.classList.toggle("srn-has-strap", !!d.headline);
    this.el.classList.toggle("srn-reduced", this.reduced);
    this.el.classList.toggle("srn-lite", this.lite);
    this.headline.textContent = d.headline;
    this.el.setAttribute("aria-label", [d.channel, d.headline].filter(Boolean).join(" — ") || this.strings.region);
    this.slot.setAttribute("aria-live", this._style() === "crawl" ? "off" : "polite");
  }

  /** Odstępy od krawędzi okna (UI Foundry): {left, right, bottom} w px. */
  setBounds(b) {
    this._bounds = b;
    if (!this.el || !b) return;
    for (const k of ["left", "right", "bottom"]) {
      const v = `${Math.round(Math.max(0, Number(b[k]) || 0))}px`;
      if (this.el.style.getPropertyValue(`--srn-${k}`) !== v) this.el.style.setProperty(`--srn-${k}`, v);
    }
  }

  /** Jednostka skali paska w px (= font-size paska; rośnie z wysokością okna i rozmiarem presetu). Czytana tylko po
   *  zmianie: wygląd/rozmiar (_applyLook) albo zmiana rozmiaru paska (ResizeObserver) — nie co kilkaset ms. */
  get _u() {
    if (!this._uAt) {
      this._uAt = 1;
      this._uPx = (this.line && parseFloat(getComputedStyle(this.line).fontSize)) || 23;
    }
    return this._uPx;
  }
  /** Szerokość pola tekstu (px) z pamięci — odświeżana po zmianie rozmiaru (ResizeObserver), nie czytana co klatkę przesuwu. */
  get _slotWidth() {
    if (!this._slotW || !this._ro) this._slotW = this.slot?.clientWidth ?? 0;
    return this._slotW;
  }
  /** Obserwator rozmiaru pola tekstu i linii paska: unieważnia zapamiętaną szerokość pola i jednostkę skali. */
  _observe() {
    this._ro?.disconnect(); this._ro = null;
    this._slotW = 0; this._uAt = 0;
    if (typeof ResizeObserver !== "function") return;
    this._ro = new ResizeObserver(() => { this._slotW = 0; this._uAt = 0; });
    if (this.slot) this._ro.observe(this.slot);
    if (this.line && this.line !== this.slot) this._ro.observe(this.line);
  }
  _style() { return this.reduced ? "flip" : this.data.style; }
  _alive(gen) { return gen === this._gen && this.state === "on"; }
  _sleep(ms) {
    return new Promise((res) => { const t = setTimeout(() => { this._timers.delete(t); res(); }, Math.max(0, ms)); this._timers.add(t); });
  }
  /** Czekaj na aktualizację listy (pusta lista w trybie pętli) — albo najwyżej `ms`. */
  _waitUpdate(ms = 4000) { return new Promise((res) => { this._wake = res; this._sleep(ms).then(res); }); }

  /* ---- wejście */
  start() {
    if (this.state !== "idle") return this;
    this._build();
    this.state = "on";
    const gen = ++this._gen;
    this._entry();
    const fonts = document.fonts?.ready ? Promise.race([document.fonts.ready, this._sleep(1500)]) : Promise.resolve();
    fonts.then(() => { if (this._alive(gen)) this._run(gen); });
    return this;
  }

  _entry() {
    if (this.reduced) {
      enter(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
      return;
    }
    this.look.entry(this);
  }

  /* ---- przebieg */
  _run(gen) {
    if (this._style() === "crawl") this._crawl(gen); else this._flipLoop(gen);
  }

  _finish(gen) {
    if (!this._alive(gen)) return;
    try { this.onFinish?.(); } catch (e) { console.warn("sketch-reveal | ticker onFinish", e); }
    this.exit();
  }

  /** Następna pozycja do pokazania (klapka) wg BIEŻĄCEJ listy — edycje na żywo działają od następnej zmiany. */
  _pickNext() {
    const list = this.data.items;
    if (!list.length) return null;
    const at = this._cur ? list.findIndex((x) => x.id === this._cur.id) : -1;
    if (this.data.mode === "once") {
      const start = at >= 0 ? at + 1 : Math.min(this._lastIdx, list.length);
      for (let k = 0; k < list.length; k++) { const it = list[(start + k) % list.length]; if (!this._shown.has(it.id)) return it; }
      return null;
    }
    // bieżąca usunięta: następną jest ta, która wskoczyła na jej miejsce
    const i = at >= 0 ? at + 1 : this._lastIdx;
    return list[i % list.length];
  }

  async _flipLoop(gen) {
    await this._sleep(this.reduced ? 200 : this.data.look === "wire" ? 900 : 640);
    while (this._alive(gen) && this._style() === "flip") {
      const item = this._pickNext();
      if (!item) {
        if (this.data.mode === "once" && this._shown.size) return this._finish(gen);
        await this._flipTo(null, gen);
        await this._waitUpdate();
        continue;
      }
      const same = this._cur && item.id === this._cur.id && item.text === this._cur.text && item.label === this._cur.label && this._frame;
      if (!same) await this._flipTo(item, gen);
      if (!this._alive(gen)) return;
      this._cur = item; this._shown.add(item.id);
      this._lastIdx = Math.max(0, this.data.items.findIndex((x) => x.id === item.id));
      if (same && this.look.dwell) await this._sleep(typedHoldMs(item.text.length, this.data.speed)); // ta sama (jedyna) wiadomość: nie pisz jej od nowa
      else if (this.look.dwell) await this.look.dwell(this, item, gen);
      else await this._dwell(item, gen);
    }
    if (this._alive(gen)) this._run(gen); // zmiana stylu w trakcie
  }

  /** Zmiana pozycji wg wyglądu; ograniczony ruch: przenikanie. */
  async _flipTo(item, gen) {
    const old = this._frame;
    const frame = item ? this.look.frame(this, item) : null;
    this._frame = frame;
    if (!item) this._cur = null;
    if (frame) this.slot.append(frame);
    let anims;
    if (this.reduced) {
      anims = [];
      if (old) anims.push(leave(old, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in" }));
      if (frame) anims.push(enter(frame, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: old ? 120 : 0, easing: "ease-out" }));
    } else anims = this.look.swap(this, old, frame);
    await Promise.all(anims.map(settle));
    old?.remove();
    void gen;
  }

  /** Pozycja na pasku: krótka — czas czytania; długa — chwila, przewinięcie do końca stałą prędkością, chwila. */
  async _dwell(item, gen) {
    const frame = this._frame;
    const vp = frame?.querySelector(".srn-viewport"), tx = frame?.querySelector(".srn-text");
    const sp = this.data.speed;
    const over = !this.reduced && vp && tx ? tx.scrollWidth - vp.clientWidth : 0;
    if (over > 4) {
      frame.classList.add("srn-over");
      await this._sleep(1400 / sp);
      if (!this._alive(gen) || this._frame !== frame) return;
      const u = this._u, dist = over + u * 0.9;
      const a = tx.animate([{ transform: "none" }, { transform: `translateX(${-dist}px)` }], { duration: (dist / crawlPxps(u, sp)) * 1000, easing: "linear", fill: "forwards" });
      await settle(a);
      if (!this._alive(gen)) return;
      frame.classList.remove("srn-over");
      await this._sleep(1800 / sp);
    } else {
      await this._sleep(readHoldMs(item.text.length + item.label.length * 0.5, sp));
    }
  }

  /* ---- przesuw (crawl) */
  _segment(item) {
    const s = this.look.segment(this, item);
    s.setAttribute("aria-hidden", "true");
    return s;
  }

  _pickCrawl() {
    const list = this.data.items;
    if (!list.length) return null;
    if (this.data.mode === "once") {
      const at = this._cur ? list.findIndex((x) => x.id === this._cur.id) : -1;
      const start = at >= 0 ? at + 1 : Math.min(this._lastIdx, list.length);
      for (let k = 0; k < list.length; k++) { const it = list[(start + k) % list.length]; if (!this._shown.has(it.id)) return it; }
      return null;
    }
    return this._pickNext();
  }

  async _crawl(gen) {
    if (this._frame) { const f = this._frame; this._frame = null; await settle(leave(f, [{ opacity: 1 }, { opacity: 0 }], { duration: 200 })); f.remove(); }
    await this._sleep(this._cur ? 0 : 560);
    if (!this._alive(gen)) return;
    const track = this._track = mk("div", "srn-track");
    this.slot.append(track);
    const segs = [];
    let offset = 0, spawnX = this._slotWidth, last = performance.now();
    const step = (now) => {
      if (!this._alive(gen)) return;
      if (this._style() !== "crawl") { // zmiana stylu: przesuw gaśnie, startuje klapka
        settle(leave(track, [{ opacity: 1 }, { opacity: 0 }], { duration: 220 })).then(() => track.remove());
        this._track = null; this._cur = null;
        return this._flipLoop(gen);
      }
      const dt = Math.min(1, Math.max(0, (now - last) / 1000)); last = now;
      const W = this._slotWidth;
      offset -= crawlPxps(this._u, this.data.speed) * dt;
      if (!segs.length && spawnX + offset < W) spawnX = W - offset; // pusto: następna pozycja wjeżdża od prawej krawędzi
      while (spawnX + offset < W + 16) {
        const it = this._pickCrawl();
        if (!it) break;
        this._cur = it; this._shown.add(it.id);
        this._lastIdx = Math.max(0, this.data.items.findIndex((x) => x.id === it.id));
        const el = this._segment(it);
        track.append(el);
        const w = el.offsetWidth;
        el.style.transform = `translate3d(${spawnX}px,0,0)`;
        segs.push({ el, x: spawnX, w });
        spawnX += w;
      }
      while (segs.length && segs[0].x + segs[0].w + offset < 0) segs.shift().el.remove();
      if (-offset > 50000 && segs.length) { // przesunięcie bazy: duże współrzędne tracą precyzję w transformacjach
        const base = segs[0].x;
        for (const s of segs) { s.x -= base; s.el.style.transform = `translate3d(${s.x}px,0,0)`; }
        spawnX -= base; offset += base;
      }
      track.style.transform = `translate3d(${offset}px,0,0)`;
      if (this.data.mode === "once" && !segs.length && this._shown.size && !this._pickCrawl()) return this._finish(gen);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  /* ---- aktualizacja na żywo */
  update(data) {
    const prev = this.data, d = sanitizeTicker(data);
    this.data = d;
    if (!this.el || this.state === "exiting" || this.state === "gone") return;
    if (d.look !== this._lookId) return this._relook();
    const strapWas = !!prev.headline, strapNow = !!d.headline;
    const hlChanged = strapWas && strapNow && prev.headline !== d.headline;
    this._applyLook(d);
    if (!strapWas && strapNow && !this.reduced) this.look.strapIn(this, 0);
    if (hlChanged && !this.reduced) this.look.headlineSwap(this, prev.headline);
    this._wake?.(); this._wake = null;
  }

  /** Zmiana wyglądu na antenie: stary pasek gaśnie, nowy wchodzi swoją choreografią i leci dalej od następnej wiadomości. */
  _relook() {
    if (this.state !== "on") return;
    const gen = ++this._gen;
    cancelAnimationFrame(this._raf);
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this._wake?.(); this._wake = null;
    this._scanAnim?.cancel(); this._scanAnim = null;
    const old = this.el;
    // stary pasek: usunięty po zejściu albo najpóźniej po 1,2 s (karta w tle); destroy() i koniec zejścia zdejmują go od razu
    this._stale.add(old);
    const drop = () => { clearTimeout(t); old.remove(); this._stale.delete(old); };
    const t = setTimeout(drop, 1200);
    settle(leave(old, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease-in" })).then(drop);
    this._frame = null; this._track = null; this._cur = null;
    this._build();
    this._entry();
    this._sleep(this.reduced ? 0 : 200).then(() => { if (this._alive(gen)) this._run(gen); });
  }

  /* ---- zejście */
  /** Zdejmij pasek z animacją zejścia. Idempotentne; rozwiązuje się po usunięciu z DOM. */
  exit() {
    if (this.state === "idle") { this.state = "gone"; this._resolveFinished(); return this.finished; }
    if (this.state !== "on") return this.finished;
    this.state = "exiting";
    this._gen++;
    cancelAnimationFrame(this._raf);
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this._wake?.();
    if (this.stopBtn) this.stopBtn.disabled = true;
    let done;
    if (this.reduced) {
      this._scanAnim?.cancel();
      done = [leave(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in" })];
    } else done = this.look.exit(this);
    const finalize = () => {
      clearTimeout(this._exitT); this._exitT = 0;
      if (this.state === "gone") return;
      this._scanAnim?.cancel();
      this._teardown();
      this.state = "gone";
      this._resolveFinished();
    };
    Promise.all(done.map(settle)).then(finalize);
    // karta w tle wstrzymuje animacje (finished nie przychodzi) — pasek i tak znika najpóźniej po chwili
    this._exitT = setTimeout(finalize, 1600);
    return this.finished;
  }

  /** Natychmiastowe usunięcie (bez animacji) — np. przy przeładowaniu modułu. */
  destroy() {
    this._gen++;
    cancelAnimationFrame(this._raf);
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    clearTimeout(this._exitT); this._exitT = 0;
    this._scanAnim?.cancel();
    this._teardown();
    this.state = "gone";
    this._resolveFinished();
  }

  /** Zdejmij pasek z DOM razem z niedokończonymi starymi paskami (zmiana wyglądu) i obserwatorem rozmiaru. */
  _teardown() {
    this._ro?.disconnect(); this._ro = null;
    for (const old of this._stale) old.remove();
    this._stale.clear();
    this.el?.remove();
  }
}

export function createNewsBar(opts) { return new NewsBar(opts).start(); }

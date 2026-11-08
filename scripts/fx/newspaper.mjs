/* „Wirująca gazeta” — przejście sceny w stylu filmowej kroniki.
   To, co gracz właśnie widział na płótnie, staje się zdjęciem na pierwszej stronie amerykańskiej gazety (raster, papier,
   winieta, łamy): kamera odjeżdża od zdjęcia i strona osiada na rozmytym tle starej sceny. Po wspólnym starcie strona
   unosi się, wiruje z przyspieszeniem i odlatuje w głąb, a spod niej wyłania się nowa mapa.
   Czysty DOM + Canvas 2D + Web Animations API — bez Foundry (tools/harness-newspaper.html importuje go wprost).

   Dwa wyglądy (oba amerykańskie, nazwy wyłącznie zmyślone):
   - classic — wielkomiejski dziennik z lat 30.–40.: uszy (pogoda, wydanie), szeryfowa winieta, linia numeru z datą i ceną
     w centach, baner EXTRA farbą dodatkową, wąski grotesk wersalikami w nagłówkach, schodkowy podtytuł, raster zdjęcia,
     szpalty z liniami, bylina, dateline „HARBOR CITY, Nov. 8 —”, „Continued on Page 4”, ramka „In Brief”, indeks u dołu.
   - modern — współczesny tabloid: kolorowa belka z winietą i zapowiedziami ze stronami, data po amerykańsku i cena w $,
     etykieta + ogromny ścieśniony nagłówek, kolorowe zdjęcie z belką podpisu, 3 łamy, ramki boczne, rząd kart.
   Każdy czytelny napis to prawdziwy angielski: winietę, nagłówki, podtytuł, etykietę, podpis i nagłówki pozostałych
   artykułów MG edytuje (puste = tekst domyślny wyglądu), a łamy wypełnia neutralna proza agencyjna (prawdziwe zdania).

   Warstwy (od dołu): tło (stara scena rozmyta i przyciemniona) → cień strony → smugi (kopie strony opóźnione o kilka ms,
   widoczne tylko przy dużej prędkości kątowej = rozmycie ruchu) → strona (płótno 2D + czyste zdjęcie, które przenika się
   z rastrem). Wszystkie ruchy to transform/opacity (kompozytor), klatki kluczowe liczone z funkcji pozy (własne krzywe). */

/** Limity znaków pól tekstu (klucz = nazwa pola; `story` — jeden nagłówek z listy, `stories` — ile nagłówków). */
export const NEWSPAPER_LIMITS = Object.freeze({ masthead: 40, kicker: 24, headline: 90, deck: 160, caption: 140, story: 80, stories: 6, place: 32, date: 48 });
/** Pojedyncze pola tekstu strony (lista nagłówków `stories` osobno). Puste = tekst domyślny wyglądu; `kicker` pusty = bez etykiety. */
export const NEWSPAPER_TEXT_KEYS = Object.freeze(["masthead", "kicker", "headline", "deck", "caption", "place", "date"]);
/** Wygląd strony: amerykański dziennik z lat 30.–40. (raster, szeryfy, pożółkły papier) albo współczesny kolorowy tabloid. */
export const NEWSPAPER_STYLES = Object.freeze(["classic", "modern"]);
/** Gdzie trafia każdy z nagłówków listy `stories` (klucze etykiet edytora: SKETCHREVEAL.NewsSlot.*). */
export const NEWSPAPER_SLOTS = Object.freeze({
  classic: Object.freeze(["side", "lower", "brief", "brief", "brief", "brief"]),
  modern: Object.freeze(["teaser", "teaser", "box", "card", "card", "card"]),
});

const frz = (o) => Object.freeze({ ...o, stories: Object.freeze(o.stories) });
/** Tekst domyślny (US English, wyłącznie zmyślone nazwy — żadnych prawdziwych tytułów prasowych). */
export const NEWSPAPER_DEFAULT_TEXT = Object.freeze({
  classic: frz({
    masthead: "The Harbor City Clarion", kicker: "Extra",
    headline: "Mystery Deepens as City Awaits Answers",
    deck: "Witnesses Describe Strange Events Near the Waterfront; Officials Promise a Full Inquiry",
    caption: "The scene as our staff photographer found it only moments ago.",
    place: "Harbor City", date: "",
    stories: ["Council Called to Emergency Session", "Harbor Traffic Halted Until Further Notice", "Night Patrols Doubled Downtown",
      "Museum Reports a Missing Artifact", "Storm Warning Posted Along the Coast", "Railroad Promises Faster Service"],
  }),
  modern: frz({
    masthead: "Metro Flash", kicker: "Exclusive",
    headline: "City on Edge",
    deck: "Witnesses describe a night nobody saw coming, and officials still won't say why.",
    caption: "The scene moments ago, as captured by a reader.",
    place: "Harbor City", date: "",
    stories: ["What we know so far", "Traffic snarled across downtown", "Mayor calls an emergency meeting",
      "Local heroes or vigilantes?", "Weekend storm on the way", "Tickets sell out in minutes"],
  }),
});
export const DEFAULT_NEWSPAPER = Object.freeze({
  style: "classic", masthead: "", headline: "", deck: "", caption: "", stories: Object.freeze([]), place: "", date: "",
  paper: "#ebe3cf", accent: "#d0121b", spinSec: 2.4, turns: 3, direction: "cw", playerSkip: false,
});
/** Czasy (ms): uformowanie strony, chwila na „przeczytanie” przed odlotem, spokojne wejście/wyjście (reduced motion). */
export const PRESS_MS = 1450, HOLD_MS = 450, CALM_IN_MS = 650, CALM_OUT_MS = 900;
/** Najazd kamery na samą mapę, zanim kadr stanie się zdjęciem (gdy na ekranie było widać tło poza sceną). */
export const PUSH_MS = 650;
/** Odsłona nowej mapy: kamera startuje o tyle bliżej i osiada na kadrze bez tła poza sceną (czas = odlot + zapas). */
export const REVEAL_ZOOM = 1.12, REVEAL_TAIL_MS = 600;
export const revealCameraMs = (spinSec) => Math.round(spinSec * 1000 + REVEAL_TAIL_MS);
/** Krzywa osiadania kamery (ta sama w Foundry i w harnessie): szybki ruch pod tłem, łagodne dojście, gdy już widać mapę. */
export const cameraEase = (t) => 1 - (1 - clamp(t, 0, 1)) ** 3;

/* ================================================================ kadrowanie: tylko mapa, bez tła poza sceną */
const near = (a, b, eps) => Math.abs(a - b) <= eps;
/**
 * Kadr zdjęcia: prostokąt o proporcjach `aspect` leżący w całości wewnątrz `scene`, możliwie blisko tego, co widać w `view`
 * (wszystkie prostokąty {x,y,w,h} w tych samych jednostkach — w Foundry: współrzędne świata). Nigdy nie oddala (szerokość
 * ≤ widoku), tylko przybliża i przesuwa tak, żeby tło poza sceną (padding, kolor tła) nie weszło w kadr.
 * Środek: środek widocznej części sceny (gdy jest), inaczej środek widoku — potem dociśnięty do wnętrza sceny.
 */
export function photoCrop(view, scene, aspect) {
  const w = Math.max(1e-6, Math.min(view.w, scene.w, scene.h * aspect)), h = w / aspect;
  const ix0 = Math.max(view.x, scene.x), ix1 = Math.min(view.x + view.w, scene.x + scene.w);
  const iy0 = Math.max(view.y, scene.y), iy1 = Math.min(view.y + view.h, scene.y + scene.h);
  const seen = ix1 > ix0 && iy1 > iy0;
  let cx = seen ? (ix0 + ix1) / 2 : view.x + view.w / 2, cy = seen ? (iy0 + iy1) / 2 : view.y + view.h / 2;
  cx = clamp(cx, scene.x + w / 2, scene.x + scene.w - w / 2);
  cy = clamp(cy, scene.y + h / 2, scene.y + scene.h - h / 2);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
/** Kadr pokrywa się z widokiem (z dokładnością do `eps`) — nic nie trzeba przybliżać. */
export const sameRect = (a, b, eps = 0.5) => near(a.x, b.x, eps) && near(a.y, b.y, eps) && near(a.w, b.w, eps) && near(a.h, b.h, eps);

/**
 * Widok kamery bez tła poza sceną: `view` = {x, y (środek widoku w jedn. świata), scale (px ekranu na jedn.)}, `screen` = {w, h}
 * w px. Skala rośnie do najmniejszej, przy której ekran mieści się w scenie (nigdy nie maleje), środek wraca do wnętrza.
 * `maxScale` — limit zoomu (Foundry: dimensions.scale.max); scena za mała nawet przy nim zostaje wyśrodkowana.
 */
export function coverView(view, scene, screen, maxScale = Infinity) {
  const need = Math.max(screen.w / scene.w, screen.h / scene.h);
  const scale = Math.min(Math.max(view.scale, need), Math.max(maxScale, view.scale));
  const hw = screen.w / 2 / scale, hh = screen.h / 2 / scale;
  const fit = (c, a, len, half) => (half * 2 >= len ? a + len / 2 : clamp(c, a + half, a + len - half));
  return { x: fit(view.x, scene.x, scene.w, hw), y: fit(view.y, scene.y, scene.h, hh), scale };
}

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d, a, b) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? clamp(n, a, b) : d;
};
/** Jedna linia tekstu: znaki sterujące i białe znaki → spacja, przycięcie, limit znaków (po punktach kodowych, bez rozcinania par). */
const line = (v, max) => (typeof v === "string" ? [...v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("").trim() : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

/** Lista nagłówków z tablicy, obiektu {0: …, 1: …} (pola formularza) albo tekstu wieloliniowego. Puste pozycje zostają (= domyślny). */
function storyList(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === "string") arr = v.split(/\r?\n/);
  else if (v && typeof v === "object") for (let i = 0; i < NEWSPAPER_LIMITS.stories; i++) arr.push(Object.hasOwn(v, i) ? v[i] : "");
  const out = arr.slice(0, NEWSPAPER_LIMITS.stories).map((s) => line(s, NEWSPAPER_LIMITS.story));
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/** Konfiguracja gazety z dowolnego wejścia (formularz, import, gniazdo, stary preset) — zawsze poprawny obiekt. */
export function sanitizeNewspaper(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const style = NEWSPAPER_STYLES.includes(r.style) ? r.style : DEFAULT_NEWSPAPER.style;
  const L = NEWSPAPER_LIMITS;
  return {
    style,
    // puste = tekst domyślny wyglądu (stare presety: pusta winieta / nagłówek dawały udawane litery — teraz prawdziwy tekst)
    masthead: line(r.masthead, L.masthead),
    // etykieta: brak klucza = domyślna wyglądu („Extra” / „Exclusive”), pusty tekst = bez etykiety
    kicker: typeof r.kicker === "string" ? line(r.kicker, L.kicker) : NEWSPAPER_DEFAULT_TEXT[style].kicker,
    headline: line(r.headline, L.headline),
    deck: line(r.deck, L.deck),
    caption: line(r.caption, L.caption),
    stories: storyList(r.stories),
    place: line(r.place, L.place),
    date: line(r.date, L.date),
    paper: typeof r.paper === "string" && HEX.test(r.paper) ? r.paper.toLowerCase() : DEFAULT_NEWSPAPER.paper,
    accent: typeof r.accent === "string" && HEX.test(r.accent) ? r.accent.toLowerCase() : DEFAULT_NEWSPAPER.accent,
    spinSec: Math.round(num(r.spinSec, DEFAULT_NEWSPAPER.spinSec, 1, 5) * 10) / 10,
    turns: Math.round(num(r.turns, DEFAULT_NEWSPAPER.turns, 1, 6)),
    direction: r.direction === "ccw" ? "ccw" : "cw",
    playerSkip: r.playerSkip === true,
  };
}

/**
 * Nadpisania tekstu per scena: każde NIEPUSTE pole `ov` zastępuje pole presetu (puste = tekst presetu); nagłówki listy —
 * pozycja po pozycji (pusta linia = nagłówek presetu). Wygląd, kolory i obrót zawsze z presetu.
 */
export function applyNewspaperOverride(base, ov) {
  const b = sanitizeNewspaper(base);
  if (!ov || typeof ov !== "object") return b;
  const o = { ...b };
  for (const k of NEWSPAPER_TEXT_KEYS) { const v = line(ov[k], NEWSPAPER_LIMITS[k]); if (v) o[k] = v; }
  const s = storyList(ov.stories);
  o.stories = Array.from({ length: Math.max(b.stories.length, s.length) }, (_, i) => s[i] || b.stories[i] || "");
  return sanitizeNewspaper(o);
}

const MONTHS_AP = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
/** Data po amerykańsku: „Saturday, November 8, 2026”. */
export const usDate = (d = new Date()) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

/**
 * Tekst do druku: pola konfiguracji, a w miejsce pustych — tekst domyślny wyglądu. `date` puste = dzisiejsza data (US);
 * `short` — skrót daty do datelinii („Nov. 8”), gdy wpisaną datę da się odczytać (inaczej pusty — dateline bez daty).
 */
export function newspaperText(d, now = new Date()) {
  const def = NEWSPAPER_DEFAULT_TEXT[d.style] ?? NEWSPAPER_DEFAULT_TEXT.classic;
  const pick = (k) => d[k] || def[k];
  let when = now;
  if (d.date) { const t = Date.parse(d.date); when = Number.isFinite(t) ? new Date(t) : null; }
  return {
    masthead: pick("masthead"), kicker: d.kicker ?? "", headline: pick("headline"), deck: pick("deck"), caption: pick("caption"),
    place: pick("place"), date: d.date || usDate(now), year: (when ?? now).getFullYear(),
    short: when ? `${MONTHS_AP[when.getMonth()]} ${when.getDate()}` : "",
    stories: def.stories.map((s, i) => d.stories?.[i] || s),
  };
}

export function prefersReducedMotion() {
  try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/** Załaduj krój (regular + bold) zanim strona zostanie narysowana; po limicie czasu rysujemy krojem zastępczym. */
export async function ensurePaperFont(family, timeoutMs = 1500) {
  if (!family || !document.fonts?.load) return false;
  const want = [`400 20px "${family}"`, `700 20px "${family}"`];
  const ok = await Promise.race([Promise.all(want.map((f) => document.fonts.load(f))).then((r) => r.some((x) => x.length > 0)), sleep(timeoutMs).then(() => false)]);
  return !!ok;
}

/* ================================================================ losowość i proza */
function mulberry(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Łamy: neutralna proza agencyjna — prawdziwe zdania, pasujące do każdej sceny (nic nie zdradzają, nikogo nie nazywają).
 * W tempie przejścia tekst jest za mały do czytania, ale w pierwszej chwili fazy „press” strona jest ogromna — wtedy widać
 * zwykłe angielskie zdania, nie bełkot ani szare paski (paski wyglądają jak makieta, nie jak gazeta).
 */
const PROSE = [
  "Officials confirmed late yesterday that the matter is now under formal review.",
  "Witnesses gathered along the street within minutes of the first reports.",
  "Police asked residents to stay indoors until the area could be secured.",
  "A spokesman for the mayor's office declined to comment on the details.",
  "Several shopkeepers said they had noticed nothing unusual earlier in the day.",
  "The council is expected to meet again before the end of the week.",
  "Traffic was diverted around the district for most of the afternoon.",
  "Neighbors described a sudden silence that lasted for several minutes.",
  "Investigators spent the evening interviewing those who were present.",
  "No injuries had been reported by the time this edition went to press.",
  "The harbor master ordered all vessels to remain at their moorings.",
  "Reporters on the scene counted more than two hundred onlookers.",
  "An official statement is expected from city hall this morning.",
  "Older residents compared the scene to events of many years ago.",
  "Some witnesses insisted that the lights had flickered just before.",
  "Firemen stood by through the night as a precaution.",
  "The chief of police promised a full account once the facts are known.",
  "Merchants along the avenue closed their doors early.",
  "A crowd remained near the barricades well past midnight.",
  "City engineers will inspect the site at first light.",
  "Telephone lines in the area were busy for several hours.",
  "Late arrivals found the street roped off and guarded by patrolmen.",
  "Several accounts given to this newspaper could not be confirmed.",
  "The district attorney has asked for patience while the inquiry proceeds.",
  "Schools in the neighborhood will open as usual, officials said.",
  "Railroad officials said service would resume on the regular schedule.",
  "Members of the council disagreed sharply on what should be done next.",
  "A reward has been offered for information leading to an arrest.",
  "The weather bureau forecast clear skies for the remainder of the week.",
  "Hospital staff said they were prepared for any emergency.",
  "Families waited at the corner for news of relatives working nearby.",
  "Detectives are said to be following several promising leads.",
  "The governor's office has been kept informed throughout the day.",
  "Volunteers handed out coffee and blankets to those still waiting.",
  "Insurance agents began arriving shortly after dawn.",
  "It was the third such incident reported this season.",
  "Few details were made public before the evening edition closed.",
  "A full list of closures appears on an inside page.",
  "Residents are urged to report anything unusual to the nearest precinct.",
  "The investigation is expected to continue through the coming week.",
];
const CROSSHEADS = ["Crowds Gather", "Witnesses Speak", "Officials Silent", "Late Developments", "Questions Remain", "Search Continues", "Calls for Calm", "Inquiry Ordered"];

/** Strumień słów z przetasowanych zdań; akapit = 2–3 zdania (`end` na ostatnim słowie akapitu). */
function proseStream(r) {
  const order = PROSE.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  let si = 0, left = 0, queue = [];
  const refill = () => {
    if (left <= 0) left = 2 + Math.floor(r() * 2);
    const ws = PROSE[order[si++ % order.length]].split(" ");
    left--;
    return ws.map((w, i) => ({ w, end: i === ws.length - 1 && left === 0, sent: i === ws.length - 1 }));
  };
  return {
    peek() { if (!queue.length) queue = refill(); return queue[0]; },
    next() { const x = this.peek(); queue.shift(); return x; },
    /** Zakończ bieżący akapit (następne słowo zaczyna nowy). */
    breakPara() { queue = []; left = 0; },
  };
}

/* ================================================================ strona: wspólne narzędzia */
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const inkFor = (paper) => (lum(paper) > 0.2 ? "#1d1a16" : "#f0eadb");
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
/** Kolor z alfą z #rrggbb. */
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

/**
 * Znaki, które mają kroje rdzenia Foundry Amiri i Modesto Condensed (Latin-1 + typograficzna interpunkcja). Tekst z innymi
 * znakami (np. polskie ąęłńśźż — MG może pisać po polsku) idzie w całości krojem zastępczym z pełnym zestawem znaków,
 * zamiast mieszać kroje litera po literze.
 */
const LATIN1 = /^[\u0009\u000a -~ -ÿŒœ–—‘’‚“-„•…‹›€]*$/u;
const covered = (s) => LATIN1.test(s ?? "");
const SERIF_FALLBACK = 'Georgia, "Times New Roman", serif';
const SANS_FALLBACK = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
/** Wersaliki zgodnie z językiem tekstu (polskie znaki też). */
const upper = (s) => s.toLocaleUpperCase();

/** Szerokości znaków z pamięcią podręczną (tysiące słów — measureText raz na znak i krój). */
function measurer(g) {
  const cache = new Map();
  return (s) => {
    const f = g.font;
    let m = cache.get(f);
    if (!m) cache.set(f, (m = new Map()));
    let w = 0;
    for (const ch of s) {
      let cw = m.get(ch);
      if (cw === undefined) { cw = g.measureText(ch).width; m.set(ch, cw); }
      w += cw;
    }
    return w;
  };
}

/**
 * Narzędzia składu na danym kontekście: pomiar, rysowanie ze ściśnięciem poziomym (sx < 1 — krój ścieśniony z normalnego),
 * łamanie wierszy (za długie słowo dzielone twardo) i dopasowanie tekstu do ramki (rozmiar ↓ → wiersze ≤ maxLines;
 * przy minimalnym rozmiarze ostatni wiersz z wielokropkiem; `balance` — wiersze wyrównane długością jak text-wrap: balance).
 */
function typesetter(g) {
  const width = measurer(g);
  const say = (t, x, y, sx = 1, align = "left") => {
    g.textAlign = align;
    if (sx === 1) g.fillText(t, x, y);
    else { g.save(); g.translate(x, y); g.scale(sx, 1); g.fillText(t, 0, 0); g.restore(); }
    g.textAlign = "left";
  };
  const wrapAt = (text, maxW) => {
    const out = [];
    let cur = "";
    for (let wd of text.split(" ")) {
      if (!wd) continue;
      while (width(wd) > maxW && [...wd].length > 1) {
        const ch = [...wd];
        let k = ch.length - 1;
        while (k > 1 && width(ch.slice(0, k).join("")) > maxW) k--;
        if (cur) { out.push(cur); cur = ""; }
        out.push(ch.slice(0, k).join("")); wd = ch.slice(k).join("");
      }
      const nx = cur ? `${cur} ${wd}` : wd;
      if (cur && width(nx) > maxW) { out.push(cur); cur = wd; } else cur = nx;
    }
    if (cur) out.push(cur);
    return out;
  };
  /** `face(size)` → {font, sx}. Zwraca {size, lines, font, sx, truncated}. */
  const fit = (text, { face, maxW, maxLines, max, min, balance = false }) => {
    let size = max, f, lines;
    for (;;) {
      f = face(size); g.font = f.font;
      lines = wrapAt(text, maxW / f.sx);
      if (lines.length <= maxLines || size <= min) break;
      size = Math.max(min, size - Math.max(0.25, (max - min) / 30));
    }
    let truncated = false;
    if (lines.length > maxLines) {
      truncated = true;
      lines = lines.slice(0, maxLines);
      const lim = maxW / f.sx;
      let last = lines[maxLines - 1];
      while ([...last].length > 1 && width(`${last}…`) > lim) {
        const cut = last.replace(/\s*\S+$/, "");
        last = cut && cut !== last ? cut : [...last].slice(0, -1).join("");
      }
      lines[maxLines - 1] = `${last.replace(/[\s,;:.—–-]+$/u, "")}…`;
    } else if (balance && lines.length > 1) {
      const n = lines.length;
      let lo = maxW * 0.35, hi = maxW;
      for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (wrapAt(text, mid / f.sx).length <= n) hi = mid; else lo = mid; }
      lines = wrapAt(text, hi / f.sx);
    }
    g.font = f.font;
    return { size, lines, font: f.font, sx: f.sx, truncated };
  };
  /**
   * Wytłuszczone wejście akapitu (dateline) na początku szpalty bieżącym krojem: długie łamie się na osobne wiersze,
   * ostatni kawałek zostaje w wierszu z tekstem, gdy zajmuje ≤ 70 % szerokości. `y` — linia bazowa pierwszego wiersza,
   * `step` — interlinia. Zwraca {lines: pełne wiersze nad tekstem, sw: wcięcie tekstu w wierszu z tekstem}.
   */
  const leadIn = (text, x, y, w, space, step) => {
    const ls = wrapAt(text, w);
    let last = ls.pop(), lines = 0;
    for (const l of ls) say(l, x, y + step * lines++);
    if (width(last) + space > w * 0.7) { say(last, x, y + step * lines++); last = ""; }
    if (!last) return { lines, sw: 0 };
    say(last, x, y + step * lines);
    return { lines, sw: width(last) + space };
  };
  return { width, say, wrapAt, fit, leadIn };
}

/* ================================================================ strona klasyczna (amerykański dziennik, lata 30.–40.) */
const CLASSIC_EARS = [
  { title: "WEATHER", lines: ["Fair and cooler tonight;", "Sunday partly cloudy,", "light westerly winds."] },
  { title: "HOME EDITION", lines: ["Complete Stock Market", "Closing Prices", "on Page 31"] },
];
const CLASSIC_INDEX = "INSIDE TODAY — Comics, Page 14 · Editorials, Page 10 · Financial, Page 28 · Radio, Page 22 · Sports, Page 18";

/**
 * Pierwsza strona dziennika. `W` — szerokość płótna (px), `photo` — zrzut widoku, `aspect` — proporcje zdjęcia (= ekranu).
 * `fonts` = {serif, sans, cond} (nazwy krojów załadowanych w dokumencie albo null → kroje systemowe).
 * Zwraca { canvas, photoRect, H } (photoRect w px płótna strony).
 */
export function paintPage({ W, photo, aspect, data, seed = 1, fonts = {}, lite = false, cssScale = 1, now = new Date() }) {
  const r = mulberry(seed);
  const T = newspaperText(data, now);
  const u = W / 1000, H = Math.round(W * 1.42);
  const c = mk(W, H), g = c.getContext("2d");
  const ink = inkFor(data.paper), spot = data.accent;
  const { width, say, fit, leadIn } = typesetter(g);
  /** Szeryf: Amiri, gdy ma wszystkie znaki tekstu, inaczej systemowy szeryf z polskimi znakami. */
  const SER = (w, s, txt = "", it = false) => `${it ? "italic " : ""}${w} ${s.toFixed(2)}px ${fonts.serif && covered(txt) ? `"${fonts.serif}", ` : ""}${SERIF_FALLBACK}`;
  /** Wąski grotesk nagłówków: Modesto Condensed, a bez niego (albo bez znaków) Signika ścieśniona do 80 %. */
  const COND = (s, txt = "") => (fonts.cond && covered(txt)
    ? { font: `700 ${s.toFixed(2)}px "${fonts.cond}", ${SANS_FALLBACK}`, sx: 1 }
    : { font: `700 ${s.toFixed(2)}px ${fonts.sans ? `"${fonts.sans}", ` : ""}${SANS_FALLBACK}`, sx: 0.8 });
  g.fillStyle = data.paper; g.fillRect(0, 0, W, H);
  g.fillStyle = ink; g.strokeStyle = ink; g.textBaseline = "alphabetic";
  const m = 48 * u, cw = W - 2 * m;
  const rule = (x, y, w, h) => g.fillRect(x, y, w, h);
  const stream = proseStream(r);
  let crossK = Math.floor(r() * CROSSHEADS.length);

  /**
   * Szpalta justowanej prozy od (x, y) do yEnd: `start` — dateline wytłuszczony na początku pierwszego wiersza, `jump` —
   * kursywą na końcu („Continued on Page 4”), `subs` — śródtytuły. Zwraca y ostatniej linii bazowej.
   */
  const column = (x, y, w, yEnd, { size = 10.2 * u, lead = 12.7 * u, start = "", jump = "", subs = true, src = stream, sentence = false } = {}) => {
    let base = y + size, para0 = !start, sinceSub = 0, first = true;
    const end = jump ? yEnd - lead : yEnd;
    g.font = SER(400, size); const space = width(" ");
    while (base <= end) {
      if (subs && !first && para0 && sinceSub > 12 && r() < 0.24 && base + lead * 2.4 < end) {
        const t = CROSSHEADS[crossK++ % CROSSHEADS.length];
        g.font = SER(700, size * 1.08, t); say(t, x + w / 2, base + lead * 0.5, 1, "center");
        g.font = SER(400, size); base += lead * 1.9; sinceSub = 0;
        continue;
      }
      let cx = x, avail = w;
      if (first && start) {
        g.font = SER(700, size, start);
        const lead0 = leadIn(start, x, base, w, space, lead);
        base += lead0.lines * lead; cx += lead0.sw; avail -= lead0.sw; g.font = SER(400, size);
      } else if (para0) { cx += size * 1.1; avail -= size * 1.1; }
      const ws = []; let tw = 0, paraEnd = false;
      for (;;) {
        const nx = src.peek(), ww = width(nx.w), add = (ws.length ? space : 0) + ww;
        if (ws.length && tw + add > avail) break;
        src.next(); ws.push(nx.w); tw += add;
        if (nx.end || (sentence && nx.sent)) { paraEnd = true; break; }
        if (tw >= avail) break;
      }
      const inner = tw - space * Math.max(0, ws.length - 1);
      let gap = !paraEnd && ws.length > 1 ? (avail - inner) / (ws.length - 1) : space;
      if (gap > space * 3.2) gap = space; // rzadki przypadek: dwa długie słowa — lepiej bez justowania niż „rzeka”
      for (const wd of ws) { say(wd, cx, base); cx += width(wd) + gap; }
      base += lead; sinceSub++; first = false; para0 = paraEnd;
      if (sentence && paraEnd) break; // krótka wiadomość: jedno pełne zdanie
    }
    if (jump) { g.font = SER(400, size * 0.92, jump, true); say(jump, x + w, Math.min(base, yEnd), 1, "right"); g.font = SER(400, size); }
    return base - lead;
  };
  /** Wiersze dopasowanego tekstu wyśrodkowane (albo od lewej) — zwraca y pod ostatnim wierszem. */
  const block = (fitted, x, y, w, pitch, align = "center", asc = 0.8) => {
    g.font = fitted.font;
    fitted.lines.forEach((l, i) => say(l, align === "center" ? x + w / 2 : x, y + fitted.size * asc + i * fitted.size * pitch, fitted.sx, align));
    return y + fitted.size * asc + (fitted.lines.length - 1) * fitted.size * pitch;
  };
  const dateline = (T.short ? `${upper(T.place)}, ${T.short} —` : `${upper(T.place)} —`);

  /* ---- uszy (ramki obok winiety): pogoda i wydanie — stały, prawdziwy tekst */
  const y0 = 34 * u, earW = 150 * u, earH = 76 * u;
  CLASSIC_EARS.forEach((ear, i) => {
    const x = i === 0 ? m : W - m - earW;
    g.lineWidth = 1.4 * u; g.strokeRect(x, y0, earW, earH);
    const f = COND(15 * u, ear.title); g.font = f.font; say(ear.title, x + earW / 2, y0 + 21 * u, f.sx, "center");
    g.font = SER(400, 9.4 * u);
    ear.lines.forEach((l, k) => say(l, x + earW / 2, y0 + 37 * u + k * 11.6 * u, 1, "center"));
  });

  /* ---- winieta (nazwa gazety) między uszami: do 2 wierszy, zmniejszana */
  const npW = cw - 2 * (earW + 22 * u);
  // jeden wiersz, póki litery mają ≥ 46u; dłuższa nazwa — dwa wiersze, ale blok nie wyższy niż uszy
  const npFace = (s) => ({ font: SER(700, s, T.masthead), sx: 1 });
  let np = fit(T.masthead, { face: npFace, maxW: npW, maxLines: 1, max: 84 * u, min: 46 * u });
  if (np.truncated) np = fit(T.masthead, { face: npFace, maxW: npW, maxLines: 2, max: (earH + 4 * u) / (0.68 + 0.98), min: 22 * u, balance: true });
  let npBottom;
  {
    const pitch = 0.98, hBlock = np.size * (0.68 + (np.lines.length - 1) * pitch);
    const top = y0 + (earH - hBlock) / 2 - 3 * u;
    npBottom = block(np, m, top, cw, pitch, "center", 0.68) + np.size * 0.22; // + zejście liter (g, y, p)
  }
  const sloganY = Math.max(y0 + earH + 12 * u, npBottom + 10 * u);
  g.font = SER(400, 8.6 * u);
  say("AN INDEPENDENT NEWSPAPER  ·  ESTABLISHED 1871", W / 2, sloganY, 1, "center");
  let y = sloganY + 8 * u;
  rule(m, y, cw, 1.3 * u); y += 4.2 * u; rule(m, y, cw, 4 * u); y += 6 * u;
  // linia numeru: tom i numer, miejsce i data, cena w centach
  {
    const fol = upper(`${T.place}, ${T.date}`), bl = y + 13 * u;
    g.font = SER(400, 10.5 * u); say("VOL. LXXII — No. 214", m, bl);
    say("THREE CENTS", W - m, bl, 1, "right");
    const f = fit(fol, { face: (s) => ({ font: SER(400, s, fol), sx: 1 }), maxW: cw - 2 * 150 * u, maxLines: 1, max: 10.5 * u, min: 7 * u });
    say(f.lines[0], W / 2, bl, 1, "center");
  }
  y += 19 * u; rule(m, y, cw, 1.3 * u); y += 12 * u;

  /* ---- baner (EXTRA) farbą dodatkową, z liniami po bokach */
  if (T.kicker) {
    const kt = upper(T.kicker);
    const k = fit(kt, { face: (s) => COND(s, kt), maxW: cw * 0.6, maxLines: 1, max: 38 * u, min: 16 * u });
    g.fillStyle = spot;
    const kw = width(k.lines[0]) * k.sx, base = y + k.size * 0.82;
    say(k.lines[0], W / 2, base, k.sx, "center");
    const mid = base - k.size * 0.36, gap = 18 * u;
    rule(m, mid - 1.5 * u, (cw - kw) / 2 - gap, 3 * u); rule(W / 2 + kw / 2 + gap, mid - 1.5 * u, (cw - kw) / 2 - gap, 3 * u);
    g.fillStyle = ink;
    y = base + 12 * u;
  }

  /* ---- nagłówek główny: wąski grotesk wersalikami na całą szerokość, 1–2 wiersze */
  const hlT = upper(T.headline);
  const hl = fit(hlT, { face: (s) => COND(s, hlT), maxW: cw, maxLines: 2, max: 96 * u, min: 34 * u, balance: true });
  y = block(hl, m, y, cw, 0.98, "center", 0.8) + hl.size * 0.24;

  /* ---- podtytuł (deck): szeryf półgruby, wyśrodkowany, nad nim krótka linia */
  rule(W / 2 - 60 * u, y + 2 * u, 120 * u, 1 * u);
  const dk = fit(T.deck, { face: (s) => ({ font: SER(700, s, T.deck), sx: 1 }), maxW: cw * 0.86, maxLines: 3, max: 21 * u, min: 13 * u, balance: true });
  y = block(dk, m, y + 8 * u, cw, 1.2, "center", 0.86) + dk.size * 0.5;
  rule(m, y, cw, 1.3 * u); y += 14 * u;

  /* ---- łam: 5 szpalt; zdjęcie na 4 szpalty (wyśrodkowane, gdy węższe), w 5. artykuł boczny */
  const cols = 5, gap = 18 * u, colW = (cw - gap * (cols - 1)) / cols;
  const colX = (i) => m + i * (colW + gap);
  const lead = 12.7 * u;
  const yLowerMax = Math.round(H * 0.79);
  const capFit = fit(T.caption, { face: (s) => ({ font: SER(700, s, T.caption, true), sx: 1 }), maxW: 4 * colW + 3 * gap, maxLines: 2, max: 11.2 * u, min: 8.6 * u });
  const capH = 12 * u + capFit.lines.length * capFit.size * 1.25;
  const span4 = 4 * colW + 3 * gap;
  let pw = span4, ph = pw / aspect;
  // zdjęcie nie może zjeść szpalt pod sobą (≥ 5 wierszy tekstu nad dolnym artykułem)
  const maxPh = Math.max(0.2 * W, Math.min(0.42 * W, yLowerMax - 14 * u - 5 * lead - capH - y));
  if (ph > maxPh) { ph = maxPh; pw = ph * aspect; }
  const photoRect = { x: m + (span4 - pw) / 2, y, w: pw, h: ph };
  halftone(g, photo, photoRect, (lite ? 3.3 : 2.7) * cssScale, ink, data.paper);
  g.lineWidth = 1 * u; g.strokeRect(photoRect.x, y, pw, ph);
  const bodyTop = y;
  // podpis pod zdjęciem (edytowalny) + „STAFF PHOTO” do prawej
  g.font = SER(400, 7.6 * u); say("STAFF PHOTO", photoRect.x + pw, y + ph + 9.5 * u, 1, "right");
  let yc = block(capFit, photoRect.x, y + ph + 10 * u, pw, 1.25, "left", 0.9) + 11 * u;
  const yLower = clamp(Math.round(yc + 8 * lead + 14 * u), Math.round(H * 0.70), yLowerMax);

  // 5. szpalta: artykuł boczny (nagłówek 1 z listy)
  const k5 = colX(4);
  const s1 = upper(T.stories[0]);
  const sh = fit(s1, { face: (s) => COND(s, s1), maxW: colW, maxLines: 4, max: 23 * u, min: 13 * u, balance: true });
  let y5 = block(sh, k5, bodyTop - 2 * u, colW, 1.02, "center", 0.8) + 9 * u;
  rule(k5 + colW * 0.3, y5, colW * 0.4, 1 * u); y5 += 6 * u;
  const side = proseStream(r);
  column(k5, y5, colW, yLower - 14 * u, { start: dateline, jump: "Continued on Page 4, Column 2", src: side });
  // szpalty 1–4 pod zdjęciem: artykuł główny ciągnie się przez szpalty (bylina, dateline, „ciąg dalszy”)
  g.font = SER(700, 8.4 * u); say("BY A STAFF CORRESPONDENT", colX(0) + colW / 2, yc + 8 * u, 1, "center");
  for (let i = 0; i < 4; i++) {
    const top = i === 0 ? yc + 14 * u : yc;
    column(colX(i), top, colW, yLower - 14 * u, { start: i === 0 ? dateline : "", jump: i === 3 ? "Continued on Page 2, Column 3" : "" });
  }
  // linie między szpaltami
  g.globalAlpha = 0.55;
  for (let i = 1; i < cols; i++) {
    const x = colX(i) - gap / 2 - 0.35 * u, top = i === 4 ? bodyTop : yc - 4 * u;
    rule(x, top, 0.7 * u, (yLower - 10 * u) - top);
  }
  g.globalAlpha = 1;

  /* ---- pod złożeniem: drugi artykuł (szpalty 1–3) + ramka „In Brief” (szpalty 4–5) */
  rule(m, yLower, cw, 1.3 * u); rule(m, yLower + 4 * u, cw, 1.3 * u);
  const yFoot = H - m - 6 * u;
  const w3 = 3 * colW + 2 * gap;
  const s2 = upper(T.stories[1]);
  const lh = fit(s2, { face: (s) => COND(s, s2), maxW: w3, maxLines: 2, max: 36 * u, min: 16 * u, balance: true });
  let yl = block(lh, m, yLower + 12 * u, w3, 1.0, "center", 0.8) + 8 * u;
  rule(m + w3 / 2 - 40 * u, yl, 80 * u, 1 * u); yl += 6 * u;
  const lower = proseStream(r);
  for (let i = 0; i < 3; i++) column(colX(i), yl, colW, yFoot - 18 * u, { start: i === 0 ? dateline : "", subs: false, src: lower, jump: i === 2 ? "Continued on Page 6, Column 1" : "" });
  g.globalAlpha = 0.55;
  for (let i = 1; i < 3; i++) rule(colX(i) - gap / 2 - 0.35 * u, yl - 2 * u, 0.7 * u, yFoot - 20 * u - yl);
  g.globalAlpha = 1;
  // ramka: podwójna linia, „IN BRIEF”, krótkie wiadomości z nagłówkami 3–6 z listy
  const ax = colX(3), aw = 2 * colW + gap, ay = yLower + 14 * u, ah = yFoot - 18 * u - ay;
  g.lineWidth = 2.4 * u; g.strokeRect(ax, ay, aw, ah);
  g.lineWidth = 0.8 * u; g.strokeRect(ax + 6 * u, ay + 6 * u, aw - 12 * u, ah - 12 * u);
  {
    const f = COND(26 * u, "IN BRIEF"); g.font = f.font; say("IN BRIEF", ax + aw / 2, ay + 36 * u, f.sx, "center");
    rule(ax + aw / 2 - 30 * u, ay + 45 * u, 60 * u, 1 * u);
    const ix = ax + 18 * u, iw = aw - 36 * u, bottom = ay + ah - 14 * u;
    let iy = ay + 56 * u;
    const brief = proseStream(r);
    for (let i = 2; i < 6; i++) {
      const t = T.stories[i];
      const bh = fit(t, { face: (s) => ({ font: SER(700, s, t), sx: 1 }), maxW: iw, maxLines: 2, max: 12.4 * u, min: 9.5 * u });
      const need = bh.lines.length * bh.size * 1.15 + 2 * 11.4 * u + 8 * u;
      if (iy + need > bottom) break;
      iy = block(bh, ix, iy, iw, 1.15, "left", 0.86) + 4 * u;
      iy = column(ix, iy, iw, Math.min(bottom, iy + 2.2 * 11.4 * u), { size: 9.2 * u, lead: 11.4 * u, subs: false, src: brief, sentence: true }) + 10 * u;
      brief.breakPara();
    }
  }
  // stopka: indeks wydania
  rule(m, yFoot - 6 * u, cw, 1 * u);
  {
    const f = fit(CLASSIC_INDEX, { face: (s) => ({ font: SER(400, s), sx: 1 }), maxW: cw, maxLines: 1, max: 9 * u, min: 6 * u });
    say(f.lines[0], W / 2, yFoot + 6 * u, 1, "center");
  }

  paperFinish(g, W, H, u, r, data.paper, lite);
  return { canvas: c, photoRect, H };
}

/* ================================================================ strona współczesna (amerykański tabloid w kolorze) */
const MODERN_PAPER = "#f6f5f1";
const MODERN_INSIDE = [["Weather", "A2"], ["Opinion", "A14"], ["Business", "B1"], ["Sports", "C1"], ["Puzzles", "D6"]];
const MODERN_PAGES = [4, 6, 9, 15, 22];

/**
 * Współczesna pierwsza strona w pełnym kolorze: flaga w kolorze akcentu z winietą i dwiema zapowiedziami (wycinki zrzutu
 * + numer strony), pasek z datą i ceną, etykieta + ogromny ścieśniony nagłówek wersalikami, lead szeryfem, kolorowe zdjęcie
 * z belką podpisu, 3 łamy (bylina, dateline, „ciąg dalszy”), boczne ramki, rząd kart. Każdy napis — prawdziwy tekst.
 */
export function paintModern({ W, photo, aspect, data, seed = 1, fonts = {}, lite = false, now = new Date() }) {
  const r = mulberry(seed ^ 0x9e3779b9);
  const T = newspaperText(data, now);
  const u = W / 1000, H = Math.round(W * 1.42);
  const c = mk(W, H), g = c.getContext("2d");
  const { width, say, fit, leadIn } = typesetter(g);
  const acc = data.accent, ink = "#141414", paper = MODERN_PAPER;
  const SANS = `${fonts.sans ? `"${fonts.sans}", ` : ""}${SANS_FALLBACK}`;
  const S = (w, s) => `${w} ${s.toFixed(2)}px ${SANS}`;
  const SE = (w, s, txt = "", it = false) => `${it ? "italic " : ""}${w} ${s.toFixed(2)}px ${fonts.serif && covered(txt) ? `"${fonts.serif}", ` : ""}${SERIF_FALLBACK}`;
  /** Nagłówki „z drewna”: pogrubiony grotesk ścieśniony do 80 % (Signika ma polskie znaki). */
  const WOOD = (s) => ({ font: S(700, s), sx: 0.8 });
  const BOLD = (s) => ({ font: S(700, s), sx: 1 });
  g.fillStyle = paper; g.fillRect(0, 0, W, H);
  const m = 40 * u, cw = W - 2 * m;
  g.textBaseline = "alphabetic";
  const stream = proseStream(r);

  /** Wycinek zrzutu (cover) w prostokącie — kolor, lekko podbity jak druk offsetowy. */
  const photoIn = (x, y, w, h, fx = 0.5, fy = 0.5, zoom = 1) => {
    const sw = photo.width / zoom, sh = photo.height / zoom;
    const k = Math.max(w / sw, h / sh), cw2 = w / k, ch2 = h / k;
    const sx = clamp(photo.width * fx - cw2 / 2, 0, photo.width - cw2), sy = clamp(photo.height * fy - ch2 / 2, 0, photo.height - ch2);
    g.save();
    g.filter = "saturate(1.18) contrast(1.06)";
    g.drawImage(photo, sx, sy, cw2, ch2, x, y, w, h);
    g.restore();
  };
  /** Prozą do lewej (łam współczesny: bez justowania); `start` — wytłuszczony dateline, `jump` — „ciąg dalszy” na końcu. */
  const rag = (x, y, w, yEnd, { size = 10.2 * u, lead = 13.4 * u, color = ink, start = "", jump = "", src = stream } = {}) => {
    let base = y + size, first = true;
    const end = jump ? yEnd - lead : yEnd;
    g.fillStyle = color;
    g.font = S(400, size); const space = width(" ");
    while (base <= end) {
      let cx = x, avail = w;
      if (first && start) {
        g.font = S(700, size);
        const lead0 = leadIn(start, x, base, w, space, lead);
        base += lead0.lines * lead; cx += lead0.sw; avail -= lead0.sw; g.font = S(400, size);
      }
      const ws = []; let tw = 0, paraEnd = false;
      for (;;) {
        const nx = src.peek(), ww = width(nx.w), add = (ws.length ? space : 0) + ww;
        if (ws.length && tw + add > avail) break;
        src.next(); ws.push(nx.w); tw += add;
        if (nx.end) { paraEnd = true; break; }
        if (tw >= avail) break;
      }
      say(ws.join(" "), cx, base);
      base += lead * (paraEnd ? 1.45 : 1); first = false;
    }
    if (jump) { g.font = S(700, size * 0.9); g.fillStyle = acc; say(jump, x, Math.min(base, yEnd)); g.fillStyle = color; g.font = S(400, size); }
    return base;
  };
  const block = (fitted, x, y, pitch, color = ink, asc = 0.82, align = "left", w = 0) => {
    g.font = fitted.font; g.fillStyle = color;
    fitted.lines.forEach((l, i) => say(l, align === "center" ? x + w / 2 : x, y + fitted.size * asc + i * fitted.size * pitch, fitted.sx, align));
    return y + fitted.size * asc + (fitted.lines.length - 1) * fitted.size * pitch;
  };

  /* ---- flaga: kolor akcentu, nazwa białym groteskiem, po prawej dwie zapowiedzi z numerem strony */
  let y = 32 * u;
  const bandH = 132 * u, teaseW = 182 * u, teaseGap = 10 * u, teasers = 2;
  g.fillStyle = acc; g.fillRect(m, y, cw, bandH);
  const mastW = cw - teasers * (teaseW + teaseGap) - 44 * u;
  // jeden wiersz, póki litery mają ≥ 50u; dłuższa nazwa — dwa wiersze mieszczące się w wysokości flagi
  const mFace = (s) => ({ font: S(700, s), sx: 0.92 });
  let mf = fit(T.masthead, { face: mFace, maxW: mastW, maxLines: 1, max: 96 * u, min: 50 * u });
  if (mf.truncated) mf = fit(T.masthead, { face: mFace, maxW: mastW, maxLines: 2, max: (bandH - 26 * u) / (0.72 + 0.94), min: 24 * u, balance: true });
  {
    const pitch = 0.94, hBlock = mf.size * (0.72 + (mf.lines.length - 1) * pitch);
    block(mf, m + 22 * u, y + (bandH - hBlock) / 2 - 2 * u, pitch, "#ffffff", 0.72);
  }
  for (let i = 0; i < teasers; i++) {
    const tx = m + cw - (teasers - i) * (teaseW + teaseGap) + teaseGap - 12 * u, ty = y + 12 * u, th = bandH - 24 * u;
    g.fillStyle = "rgba(255,255,255,0.14)"; g.fillRect(tx, ty, teaseW, th);
    const pwid = teaseW * 0.4;
    photoIn(tx + 6 * u, ty + 6 * u, pwid, th - 12 * u, 0.2 + 0.6 * r(), 0.3 + 0.4 * r(), 2.4);
    const lx = tx + pwid + 14 * u, lw = teaseW - pwid - 22 * u;
    g.font = S(700, 8.6 * u); g.fillStyle = "rgba(255,255,255,0.82)"; say(`PAGE ${MODERN_PAGES[i]}`, lx, ty + 17 * u);
    const tf = fit(T.stories[i], { face: BOLD, maxW: lw, maxLines: 4, max: 13.5 * u, min: 8.6 * u });
    block(tf, lx, ty + 22 * u, 1.14, "#ffffff", 0.9);
  }
  y += bandH;
  // pasek: data po amerykańsku, wydanie i cena w dolarach
  g.fillStyle = "#1b1b1d"; g.fillRect(m, y, cw, 28 * u);
  g.font = S(600, 10.5 * u); g.fillStyle = "rgba(255,255,255,0.92)";
  say(upper(T.date), m + 18 * u, y + 18.5 * u);
  say("LATE EDITION  ·  $2.00", m + cw - 18 * u, y + 18.5 * u, 1, "right");
  y += 28 * u + 20 * u;

  /* ---- etykieta + nagłówek „z drewna” + lead */
  if (T.kicker) {
    const kt = upper(T.kicker);
    const kf = fit(kt, { face: BOLD, maxW: cw * 0.5, maxLines: 1, max: 13 * u, min: 9 * u });
    const kw = width(kf.lines[0]) + 20 * u;
    g.fillStyle = acc; g.fillRect(m, y, kw, 24 * u);
    g.fillStyle = "#ffffff"; say(kf.lines[0], m + 10 * u, y + 17 * u);
    g.font = S(600, 13 * u); g.fillStyle = acc; say("Developing story", m + kw + 12 * u, y + 17 * u);
    y += 34 * u;
  }
  const hlT = upper(T.headline);
  const hl = fit(hlT, { face: WOOD, maxW: cw, maxLines: 3, max: 118 * u, min: 38 * u });
  y = block(hl, m - 2 * u, y, 0.93, ink, 0.8) + 18 * u;
  const dk = fit(T.deck, { face: (s) => ({ font: SE(400, s, T.deck), sx: 1 }), maxW: cw * 0.9, maxLines: 2, max: 18 * u, min: 12 * u });
  y = block(dk, m, y, 1.28, "#444444", 0.86) + dk.size * 0.9;

  /* ---- zdjęcie w kolorze na całą szerokość + belka podpisu (edytowalny podpis) */
  const yCards = H - m - 196 * u;
  let pw = cw, ph = pw / aspect;
  const maxPh = Math.max(0.22 * W, Math.min(0.43 * W, yCards - 24 * u - 190 * u - y));
  if (ph > maxPh) { ph = maxPh; pw = ph * aspect; }
  const photoRect = { x: m + (cw - pw) / 2, y, w: pw, h: ph };
  if (pw < cw - 2 * u) {
    // węższe zdjęcie (wysoki ekran / wysoki nagłówek): pas na całą szerokość wypełniony rozmytą, przyciemnioną kopią
    g.save(); g.beginPath(); g.rect(m, y, cw, ph); g.clip();
    g.filter = `blur(${(14 * u).toFixed(1)}px) brightness(0.55) saturate(1.2)`;
    g.drawImage(photo, m - 20 * u, y - 20 * u - (cw * photo.height / photo.width - ph) / 2, cw + 40 * u, (cw + 40 * u) * photo.height / photo.width);
    g.restore();
  }
  photoIn(photoRect.x, y, pw, ph);
  {
    const cf = fit(T.caption, { face: (s) => ({ font: S(400, s), sx: 1 }), maxW: cw - 40 * u, maxLines: 2, max: 11.5 * u, min: 8.8 * u });
    const capH = 14 * u + cf.lines.length * cf.size * 1.3;
    g.fillStyle = "rgba(10,10,12,0.66)"; g.fillRect(m, y + ph - capH, cw, capH);
    g.fillStyle = acc; g.fillRect(m, y + ph - capH, 6 * u, capH);
    block(cf, m + 18 * u, y + ph - capH + 6 * u, 1.3, "#ffffff", 1.0);
  }
  y += ph + 20 * u;

  /* ---- łam: 3 szpalty tekstu (artykuł główny) + boczna kolumna z ramkami */
  const railW = 0.28 * cw, gap = 20 * u;
  const colsW = cw - railW - gap, colW = (colsW - 2 * gap) / 3;
  const dl = `${upper(T.place)} —`;
  g.font = S(700, 9 * u); g.fillStyle = acc; say("BY STAFF REPORTERS", m, y + 9 * u);
  for (let i = 0; i < 3; i++) rag(m + i * (colW + gap), i === 0 ? y + 16 * u : y, colW, yCards - 24 * u, { start: i === 0 ? dl : "", jump: i === 2 ? "Continued on Page A4" : "" });
  g.fillStyle = "rgba(0,0,0,0.12)";
  for (let i = 1; i < 3; i++) g.fillRect(m + i * (colW + gap) - gap / 2, y, 1 * u, yCards - 24 * u - y);
  // ramka 1 (jasny akcent): nagłówek 3 z listy + tekst
  const rx = m + cw - railW;
  let ry = y;
  const box1H = (yCards - 24 * u - y) * 0.56;
  g.fillStyle = rgba(acc, 0.1); g.fillRect(rx, ry, railW, box1H);
  g.fillStyle = acc; g.fillRect(rx, ry, railW, 5 * u);
  const bf = fit(T.stories[2], { face: BOLD, maxW: railW - 28 * u, maxLines: 4, max: 18 * u, min: 11 * u });
  const by = block(bf, rx + 14 * u, ry + 14 * u, 1.14, ink, 0.86);
  rag(rx + 14 * u, by + 8 * u, railW - 28 * u, ry + box1H - 12 * u, { size: 9.6 * u, lead: 12.6 * u, src: proseStream(r), jump: `Story, Page ${MODERN_PAGES[1] + 1}` });
  ry += box1H + 16 * u;
  // ramka 2 (żółta): spis działów ze stronami
  const box2H = yCards - 24 * u - ry;
  if (box2H > 60 * u) {
    g.fillStyle = "#ffd23f"; g.fillRect(rx, ry, railW, box2H);
    g.font = S(700, 22 * u); g.fillStyle = ink; say("INSIDE", rx + 14 * u, ry + 30 * u);
    const rowH = 17 * u, rows = Math.max(0, Math.min(MODERN_INSIDE.length, Math.floor((box2H - 44 * u) / rowH)));
    for (let i = 0; i < rows; i++) {
      const [name, page] = MODERN_INSIDE[i], yy = ry + 52 * u + i * rowH;
      g.font = S(600, 12 * u); say(name, rx + 14 * u, yy);
      g.font = S(700, 12 * u); say(page, rx + railW - 14 * u, yy, 1, "right");
      g.fillStyle = "rgba(0,0,0,0.18)"; g.fillRect(rx + 14 * u, yy + 5 * u, railW - 28 * u, 0.8 * u); g.fillStyle = ink;
    }
  }

  /* ---- rząd kart u dołu: wycinek zrzutu + nagłówek 4–6 z listy + numer strony */
  g.fillStyle = ink; g.fillRect(m, yCards, cw, 3 * u);
  g.font = S(700, 12 * u); g.fillStyle = acc; say("MORE TOP STORIES", m, yCards + 22 * u);
  const cards = 3, cgap = 18 * u, cwid = (cw - cgap * (cards - 1)) / cards, cy = yCards + 34 * u, cimg = 82 * u;
  for (let i = 0; i < cards; i++) {
    const cx = m + i * (cwid + cgap);
    photoIn(cx, cy, cwid, cimg, 0.15 + 0.7 * r(), 0.2 + 0.6 * r(), 2 + r() * 1.5);
    const cf = fit(T.stories[3 + i], { face: BOLD, maxW: cwid, maxLines: 2, max: 14 * u, min: 9.5 * u });
    const yy = block(cf, cx, cy + cimg + 4 * u, 1.14, ink, 0.95);
    g.font = S(600, 9 * u); g.fillStyle = "#666666"; say(`Page ${MODERN_PAGES[2 + i]}`, cx, yy + 14 * u);
  }
  // stopka
  g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(m, H - m + 2 * u, cw, 1 * u);
  g.fillStyle = "#555555";
  {
    // prawy dolny róg zajmuje zagięty róg strony — stopka w jednym wierszu od lewej
    const foot = `© ${T.year} ${T.masthead}. All rights reserved.  ·  Printed in the U.S.A.`;
    const ff = fit(foot, { face: (s) => ({ font: S(400, s), sx: 1 }), maxW: cw * 0.8, maxLines: 1, max: 9 * u, min: 6 * u });
    say(ff.lines[0], m, H - m + 16 * u);
  }

  paperFinish(g, W, H, u, r, paper, lite, false);
  return { canvas: c, photoRect, H };
}

/**
 * Raster gazetowy: zdjęcie w skali szarości jako kropki farby na siatce obróconej o 45°, pole kropki ∝ zaczernienie.
 * `cell` — skok siatki w px płótna strony.
 */
function halftone(g, src, rect, cell, ink, paper) {
  const sw = Math.max(8, Math.round(rect.w / (cell * 0.5))), sh = Math.max(8, Math.round((sw * rect.h) / rect.w));
  const sc = mk(sw, sh), sg = sc.getContext("2d", { willReadFrequently: true });
  sg.imageSmoothingQuality = "high";
  sg.drawImage(src, 0, 0, sw, sh);
  const px = sg.getImageData(0, 0, sw, sh).data;
  const L = new Float32Array(sw * sh);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) L[i] = (0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]) / 255;
  // „redakcja fotograficzna”: rozciągnij tony (1.–99. percentyl) i rozjaśnij ciemne kadry (średnia → ~0,5),
  // inaczej nocna scena wychodzi jako czarny prostokąt
  const sorted = Float32Array.from(L).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = Math.max(lo + 0.05, sorted[Math.floor(sorted.length * 0.99)]);
  let mean = 0;
  for (let i = 0; i < L.length; i++) { L[i] = clamp((L[i] - lo) / (hi - lo), 0, 1); mean += L[i]; }
  mean = clamp(mean / L.length, 0.02, 0.98);
  const gam = clamp(Math.log(0.5) / Math.log(mean), 0.42, 1.6);
  for (let i = 0; i < L.length; i++) L[i] **= gam;
  g.save();
  g.beginPath(); g.rect(rect.x, rect.y, rect.w, rect.h); g.clip();
  // papier pod zdjęciem minimalnie szarszy (farba „przebija”)
  g.fillStyle = paper; g.fillRect(rect.x, rect.y, rect.w, rect.h);
  g.fillStyle = "rgba(0,0,0,0.05)"; g.fillRect(rect.x, rect.y, rect.w, rect.h);
  g.fillStyle = ink;
  const ca = Math.SQRT1_2, sa = Math.SQRT1_2;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, R = Math.hypot(rect.w, rect.h) / 2 + cell;
  const rmax = cell * 0.74;
  let n = 0;
  g.beginPath();
  for (let v = -R; v <= R; v += cell) {
    for (let uu = -R; uu <= R; uu += cell) {
      const x = cx + uu * ca - v * sa, y = cy + uu * sa + v * ca;
      if (x < rect.x - cell || x > rect.x + rect.w + cell || y < rect.y - cell || y > rect.y + rect.h + cell) continue;
      const fx = clamp(((x - rect.x) / rect.w) * sw, 0, sw - 1), fy = clamp(((y - rect.y) / rect.h) * sh, 0, sh - 1);
      const lx = fx | 0, ly = fy | 0, ax = fx - lx, ay = fy - ly, lx1 = Math.min(sw - 1, lx + 1), ly1 = Math.min(sh - 1, ly + 1);
      const l = (L[ly * sw + lx] * (1 - ax) + L[ly * sw + lx1] * ax) * (1 - ay) + (L[ly1 * sw + lx] * (1 - ax) + L[ly1 * sw + lx1] * ax) * ay;
      // krzywa gazetowa: biel papieru zostaje białą, cienie trochę „zalane”
      const d = clamp((1 - l - 0.07) / 0.8, 0, 1) ** 0.85;
      const rr = rmax * Math.sqrt(d);
      if (rr < 0.3) continue;
      g.moveTo(x + rr, y); g.arc(x, y, rr, 0, Math.PI * 2);
      if (++n % 3000 === 0) { g.fill(); g.beginPath(); }
    }
  }
  g.fill();
  g.restore();
}

/** Faktura papieru, zażółcenie brzegów, zgięcie w pół i zagięty róg. */
function paperFinish(g, W, H, u, r, paper, lite, aged = true) {
  // ziarno: kafel szumu z rzadkimi włóknami, mnożony
  const T = 256, tile = mk(T, T), tg = tile.getContext("2d");
  const id = tg.createImageData(T, T);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = 255 - Math.floor(r() ** 3 * (aged ? 38 : 16));
    id.data[i] = v; id.data[i + 1] = v; id.data[i + 2] = v - 2; id.data[i + 3] = 255;
  }
  tg.putImageData(id, 0, 0);
  tg.strokeStyle = "rgba(90,70,40,0.10)"; tg.lineWidth = 0.7;
  for (let i = 0; i < (aged ? (lite ? 20 : 46) : (lite ? 6 : 14)); i++) {
    const x = r() * T, y = r() * T, a = r() * Math.PI, l = 4 + r() * 14;
    tg.beginPath(); tg.moveTo(x, y); tg.quadraticCurveTo(x + Math.cos(a + 0.4) * l * 0.6, y + Math.sin(a + 0.4) * l * 0.6, x + Math.cos(a) * l, y + Math.sin(a) * l); tg.stroke();
  }
  g.save();
  g.globalCompositeOperation = "multiply";
  g.fillStyle = g.createPattern(tile, "repeat"); g.fillRect(0, 0, W, H);
  // zażółcenie / przybrudzenie brzegów
  const vg = g.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  vg.addColorStop(0, "rgba(255,255,255,0)"); vg.addColorStop(1, aged ? "rgba(150,115,60,0.30)" : "rgba(120,120,130,0.13)");
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  // zgięcie w pół (poziome) — miękki cień z jednej strony
  const fy = H * 0.5, fw = 26 * u;
  const fg = g.createLinearGradient(0, fy - fw, 0, fy + fw);
  fg.addColorStop(0, "rgba(0,0,0,0)"); fg.addColorStop(0.47, "rgba(60,45,25,0.16)"); fg.addColorStop(0.5, "rgba(60,45,25,0.22)"); fg.addColorStop(0.56, "rgba(0,0,0,0.04)"); fg.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = fg; g.fillRect(0, fy - fw, W, fw * 2);
  // ślad drugiego złożenia (pionowy, słaby)
  const vx = W * 0.5, vw = 14 * u;
  const vgr = g.createLinearGradient(vx - vw, 0, vx + vw, 0);
  vgr.addColorStop(0, "rgba(0,0,0,0)"); vgr.addColorStop(0.5, "rgba(60,45,25,0.07)"); vgr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = vgr; g.fillRect(vx - vw, 0, vw * 2, H);
  g.restore();
  // jasny grzbiet zgięcia
  g.save(); g.globalCompositeOperation = "screen";
  g.fillStyle = "rgba(255,250,235,0.35)"; g.fillRect(0, fy + 1.2 * u, W, 1.6 * u);
  g.restore();
  // zagięty róg (prawy dolny): wycięcie + zakładka z cieniem
  const d = 58 * u;
  g.save();
  g.globalCompositeOperation = "destination-out";
  g.beginPath(); g.moveTo(W - d, H); g.lineTo(W, H - d); g.lineTo(W, H); g.closePath(); g.fill();
  g.restore();
  g.save();
  g.shadowColor = "rgba(0,0,0,0.35)"; g.shadowBlur = 10 * u; g.shadowOffsetX = -3 * u; g.shadowOffsetY = -3 * u;
  g.beginPath(); g.moveTo(W - d, H); g.lineTo(W, H - d); g.lineTo(W - d * 0.92, H - d * 0.92); g.closePath();
  const lg = g.createLinearGradient(W - d, H - d, W - d * 0.5, H - d * 0.5);
  lg.addColorStop(0, shade(paper, 0.86)); lg.addColorStop(1, shade(paper, 1.02));
  g.fillStyle = lg; g.fill();
  g.restore();
  // krawędź strony
  g.strokeStyle = aged ? "rgba(60,45,25,0.25)" : "rgba(0,0,0,0.18)"; g.lineWidth = 1.2 * u;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, H - d); g.lineTo(W - d, H); g.lineTo(0, H); g.closePath(); g.stroke();
}
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => clamp(Math.round(v * k), 0, 255);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/* ================================================================ animacja */
const smooth = (a, b, t) => { const x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
const expoOut = (t) => (t >= 1 ? 1 : (1 - 2 ** (-10 * t)) / (1 - 2 ** -10));
const PERSP = 1700;
const tf = (p) => `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) scale(${p.s.toFixed(5)}) perspective(${PERSP}px) rotateZ(${p.rz.toFixed(3)}deg) rotateX(${p.rx.toFixed(3)}deg) rotateY(${p.ry.toFixed(3)}deg)`;

const ROOT_CSS = "position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:strict;";
const ABS = "position:absolute;left:0;top:0;width:100%;height:100%;display:block;";

/**
 * Przejście „gazeta”. `photo` — płótno ze zrzutem widoku (proporcje ekranu). Od razu zasłania ekran zrzutem (bez skoku),
 * potem: `ready` (strona narysowana) → `press()` (zdjęcie staje się gazetą) → `spin()` (odlot, nowa mapa pod spodem).
 * `safe` — odstępy od krawędzi zajęte przez UI {left,right,top,bottom}: strona ląduje na środku wolnego obszaru.
 * Kadr bez tła poza sceną: `photo` to już sama mapa (proporcje ekranu); gdy na ekranie było widać tło sceny, `cover` = zrzut
 * dokładnie tego, co było na ekranie, a `crop` = prostokąt zdjęcia w px ekranu (może wystawać poza ekran). Zasłona zaczyna
 * się od `cover`, a kamera najeżdża na `crop` i przenika w czyste zdjęcie (faza „najazd”, PUSH_MS) — bez skoku.
 */
export function createNewspaper({ host = document.body, photo, cover = null, crop = null, coverBg = "#000", data, reduced = prefersReducedMotion(), lite = false, safe = null, seed = (Math.random() * 2 ** 32) >>> 0, family = null, sansFamily = null, condFamily = null } = {}) {
  const d = sanitizeNewspaper(data);
  const modern = d.style === "modern";
  const dir = d.direction === "ccw" ? -1 : 1;
  const VW = host === document.body ? innerWidth : host.clientWidth || innerWidth;
  const VH = host === document.body ? innerHeight : host.clientHeight || innerHeight;
  const root = document.createElement("div");
  root.className = "srnp-root"; root.style.cssText = ROOT_CSS;
  host.append(root);
  // najazd potrzebny tylko, gdy kadr zdjęcia różni się od ekranu
  const pushIn = !!(cover && crop && crop.w > 1 && crop.h > 1) && !sameRect(crop, { x: 0, y: 0, w: VW, h: VH }, 1);
  // natychmiastowa zasłona: dokładnie to, co było na ekranie
  const first = pushIn ? cover : photo;
  first.style.cssText = `${ABS}`;
  const flat = document.createElement("div");
  flat.style.cssText = `${ABS}background:${/^#[0-9a-f]{3,8}$/i.test(coverBg) ? coverBg : "#000"};overflow:hidden;`;
  flat.append(first);
  root.append(flat);

  const stats = { reduced: !!reduced, lite: !!lite, buildMs: 0, pageW: 0, photoW: photo.width, photoH: photo.height, pushIn, crop: pushIn ? { ...crop } : null };
  const anims = new Set();
  let closed = false, built = null, pressDone = null;
  const play = (el, kf, opts) => {
    const a = el.animate(kf, { fill: "forwards", easing: "linear", ...opts });
    anims.add(a);
    a.finished.catch(() => {}).finally(() => anims.delete(a));
    return a;
  };

  const ready = (async () => {
    // kroje ładowane równolegle; niezaładowany (limit czasu) = null → krój systemowy zamiast metryk fallbacku pod obcą nazwą
    const [fSerif, fSans, fCond] = await Promise.all([
      ensurePaperFont(family, 1200), ensurePaperFont(sansFamily, 1200), modern ? false : ensurePaperFont(condFamily, 1200),
    ]);
    const fonts = { serif: fSerif ? family : null, sans: fSans ? sansFamily : null, cond: fCond ? condFamily : null };
    await frame();
    if (closed) return false;
    const t0 = performance.now();
    const safeA = { left: 16, right: 16, top: 16, bottom: 16, ...(safe ?? {}) };
    const aw = Math.max(200, VW - safeA.left - safeA.right), ah = Math.max(200, VH - safeA.top - safeA.bottom);
    // strona (proporcje 1:1,42) mieści się w 86 % wolnego obszaru
    let restH = ah * 0.86, restW = restH / 1.42;
    if (restW > aw * 0.86) { restW = aw * 0.86; restH = restW * 1.42; }
    const dpr = globalThis.devicePixelRatio || 1;
    const res = lite ? Math.min(1.25, Math.max(1, dpr)) : Math.min(2, Math.max(1.5, dpr));
    const W = Math.round(Math.min(2200, restW * res));
    // cssScale = px płótna strony na 1 px CSS w spoczynku (skok rastra liczony w px ekranu)
    const page = modern
      ? paintModern({ W, photo, aspect: photo.width / photo.height, data: d, seed, fonts, lite })
      : paintPage({ W, photo, aspect: photo.width / photo.height, data: d, seed, fonts, lite, cssScale: W / restW });
    stats.pageW = W; stats.buildMs = Math.round(performance.now() - t0);

    // tło: stara scena mocno rozmyta i przyciemniona (głębia ostrości), statyczne
    const bw = 360, bh = Math.max(1, Math.round((bw * VH) / VW));
    const back = mk(bw, bh), bg = back.getContext("2d");
    bg.filter = "blur(6px) saturate(0.7)";
    bg.drawImage(photo, -12, -12, bw + 24, bh + 24);
    bg.filter = "none";
    bg.fillStyle = "rgba(8,6,4,0.52)"; bg.fillRect(0, 0, bw, bh);
    back.style.cssText = `${ABS}`;
    const vign = document.createElement("div");
    vign.style.cssText = `${ABS}background:radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.55) 100%);`;
    const backdrop = document.createElement("div");
    backdrop.style.cssText = `${ABS}`;
    backdrop.append(back, vign);

    // rama strony w pozycji spoczynku (środek wolnego obszaru)
    const cx = safeA.left + aw / 2, cy = safeA.top + ah / 2;
    const rig = document.createElement("div");
    rig.style.cssText = `position:absolute;left:${(cx - restW / 2).toFixed(2)}px;top:${(cy - restH / 2).toFixed(2)}px;width:${restW.toFixed(2)}px;height:${restH.toFixed(2)}px;transform-origin:50% 50%;`;
    const sheet = document.createElement("div");
    sheet.style.cssText = `${ABS}transform-origin:50% 50%;will-change:transform;backface-visibility:hidden;`;
    page.canvas.style.cssText = `${ABS}`;
    sheet.append(page.canvas);
    // cień: rozmyty prostokąt na osobnym płótnie (statyczny raster, animowane tylko transform/opacity)
    const pad = 0.22;
    const sc = mk(220, Math.round(220 * 1.42)), sg = sc.getContext("2d");
    const sw = sc.width, sh = sc.height, ix = sw * pad / (1 + 2 * pad), iy = sh * pad / (1 + 2 * pad);
    sg.filter = `blur(${Math.round(sw * 0.045)}px)`;
    sg.fillStyle = "rgba(0,0,0,0.9)"; sg.fillRect(ix, iy, sw - 2 * ix, sh - 2 * iy);
    sc.style.cssText = `position:absolute;left:${-pad * 100}%;top:${-pad * 100}%;width:${100 + pad * 200}%;height:${100 + pad * 200}%;display:block;transform-origin:50% 50%;opacity:0;will-change:transform,opacity;`;
    // smugi ruchu: zmniejszone kopie strony
    const ghosts = [];
    if (!lite && !reduced) {
      const gw = Math.round(W * 0.5), gh = Math.round(page.H * 0.5);
      for (let i = 0; i < 3; i++) {
        const gc = mk(gw, gh);
        gc.getContext("2d").drawImage(page.canvas, 0, 0, gw, gh);
        gc.style.cssText = `${ABS}transform-origin:50% 50%;opacity:0;will-change:transform,opacity;`;
        ghosts.push(gc);
      }
    }
    rig.append(sc, ...ghosts, sheet);
    // zdjęcie w skali 1:1 względem ekranu: S = szerokość ekranu / szerokość zdjęcia na stronie w spoczynku
    const pr = page.photoRect, k = restW / W;
    const photoCss = { x: pr.x * k, y: pr.y * k, w: pr.w * k, h: pr.h * k };
    const S = VW / photoCss.w;
    // przesunięcie, przy którym środek zdjęcia (przy skali S) trafia w środek ekranu
    const dx = photoCss.x + photoCss.w / 2 - restW / 2, dy = photoCss.y + photoCss.h / 2 - restH / 2;
    const T0 = { x: VW / 2 - cx - S * dx, y: VH / 2 - cy - S * dy };
    // błysk flesza (faza A): kadr zostaje „sfotografowany” do gazety
    const flash = document.createElement("div");
    flash.style.cssText = `${ABS}background:#fffaf0;opacity:0;mix-blend-mode:screen;`;
    built = { backdrop, rig, sheet, shadow: sc, ghosts, flash, photoCss, restW, restH, S, T0, page };
    return true;
  })().catch((e) => { console.error("newspaper | build", e); return false; });

  /* ---- najazd (przed fazą A), t∈[0,1]: kamera wjeżdża w kadr `crop` — zoom wokół punktu stałego, więc to jeden płynny
     ruch kamery, nie przesuń-i-powiększ. Zrzut ekranu i ostre zdjęcie poruszają się tą samą macierzą (zero rozjazdu),
     zdjęcie przenika się w połowie drogi (upscalowany zrzut nie zdąży się rozmyć na oczach gracza). */
  const pushEase = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
  const pushFrame = (t) => {
    const e = pushEase(clamp(t, 0, 1)), k = VW / crop.w;
    let s, tx, ty;
    if (Math.abs(k - 1) < 1e-3) { s = 1; tx = -e * crop.x; ty = -e * crop.y; } // sam przesuw
    else {
      s = k ** e;
      const fx = (k * crop.x) / (k - 1), fy = (k * crop.y) / (k - 1); // punkt, który zostaje w miejscu
      tx = (1 - s) * fx; ty = (1 - s) * fy;
    }
    const m = (sc, x, y) => `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${sc.toFixed(5)})`;
    return {
      cover: { transform: m(s, tx, ty) },
      // piksel q zdjęcia = punkt crop + q/k zrzutu
      photo: { transform: m(s / k, s * crop.x + tx, s * crop.y + ty), opacity: smooth(0.22, 0.72, t) },
    };
  };
  let pushDone = null;
  function push() {
    if (pushDone) return pushDone;
    pushDone = (async () => {
      if (!pushIn || reduced || closed) return;
      cover.style.transformOrigin = "0 0"; cover.style.willChange = "transform";
      photo.style.cssText = `${ABS}transform-origin:0 0;opacity:0;will-change:transform,opacity;`;
      flat.append(photo);
      const kf = { cover: [], photo: [] }, N = 36;
      for (let i = 0; i <= N; i++) { const f = pushFrame(i / N); kf.cover.push({ ...f.cover, offset: i / N }); kf.photo.push({ ...f.photo, offset: i / N }); }
      const a1 = play(cover, kf.cover, { duration: PUSH_MS }), a2 = play(photo, kf.photo, { duration: PUSH_MS });
      await a2.finished.catch(() => {});
      // stan końcowy wpisany na stałe, animacje zdjęte (zdjęcie zaraz przechodzi do strony z własnymi animacjami)
      a1.cancel(); a2.cancel();
      photo.style.transform = "none"; photo.style.opacity = "1";
      cover.remove();
    })();
    return pushDone;
  }

  const REST_RZ = -2.2 * dir;
  const restPose = () => ({ x: 0, y: 0, s: 1, rz: REST_RZ, rx: 7, ry: 0 });

  /* ---- faza A (uformowanie), t∈[0,1]: błysk flesza na pełnym kadrze, kolor przechodzi w raster (kropki jeszcze duże),
     potem odjazd kamery z wykładniczym hamowaniem i lądowanie (krótka sprężyna obrotu + ledwie widoczne przysiadnięcie) */
  const pressEase = (t) => 0.08 * smooth(0, 0.26, t) + 0.92 * expoOut(clamp((t - 0.18) / 0.82, 0, 1));
  const pressPose = (t) => {
    const e = pressEase(t), b = built;
    const tt = clamp((t - 0.18) / 0.82, 0, 1), spring = 1 - Math.exp(-7 * tt) * Math.cos(9 * tt);
    const settle = 1 - 0.012 * Math.sin(Math.PI * clamp((t - 0.45) / 0.55, 0, 1));
    return { x: b.T0.x * (1 - e), y: b.T0.y * (1 - e), s: b.S ** (1 - e) * settle, rz: REST_RZ * spring, rx: 7 * e, ry: 0 };
  };
  /** Stan wszystkich warstw w chwili t fazy A. */
  const pressFrame = (t) => {
    const p = pressPose(t), e = pressEase(t);
    const flash = t < 0.025 ? 0.55 * (t / 0.025) : 0.55 * (1 - clamp((t - 0.025) / 0.175, 0, 1)) ** 2;
    return {
      sheet: { transform: tf(p) },
      shadow: { transform: tf({ ...p, x: p.x + 4 * e, y: p.y + 16 * e, s: p.s * (1 + 0.025 * e) }), opacity: 0.6 * smooth(0.15, 0.8, t) },
      photo: { opacity: 1 - smooth(0.05, 0.25, t) },
      flash: { opacity: flash },
    };
  };

  /* ---- faza B (odlot), t∈[0,1]: zamach w przeciwną stronę i uniesienie ku kamerze, potem obrót z przyspieszeniem
     (kąt ∝ u^1,9), oddalanie (skala długo duża, znika na końcu), lekkie przechyły 3D, smugi przy dużej prędkości kątowej */
  const A = 0.13;
  const spinPose = (t) => {
    t = clamp(t, 0, 1);
    const uu = clamp((t - A) / (1 - A), 0, 1);
    const wind = t < 2 * A ? -6 * Math.sin((Math.PI * t) / (2 * A)) : 0;
    const lift = 1 + 0.06 * Math.sin((Math.PI / 2) * clamp(t / A, 0, 1));
    return {
      x: 0, y: -VH * 0.05 * uu ** 1.6,
      s: lift * Math.exp(Math.log(0.018 / 1.06) * uu ** 2.6),
      rz: REST_RZ + dir * (wind + d.turns * 360 * uu ** 1.9),
      rx: 7 + 20 * Math.sin(Math.PI * uu) * (1 - 0.3 * uu),
      ry: 13 * Math.sin(1.6 * Math.PI * uu),
    };
  };
  const omega = (t) => Math.abs(spinPose(t + 0.004).rz - spinPose(t - 0.004).rz);
  const LAG = [0.016, 0.032, 0.05], GA = [0.34, 0.2, 0.1];
  /** Stan wszystkich warstw w chwili t fazy B. */
  const spinFrame = (t) => {
    const p = spinPose(t), uu = clamp((t - A) / (1 - A), 0, 1), liftK = clamp(t / A, 0, 1);
    const op = 1 - smooth(0.87, 1, t);
    const sp = clamp(omega(t) / (omega(0.995) || 1), 0, 1);
    const f = {
      sheet: { transform: tf(p), opacity: op },
      shadow: { transform: tf({ ...p, x: p.x + 4 + 20 * liftK * (1 - uu), y: p.y + 16 + 34 * liftK * (1 - uu), s: p.s * (1.025 + 0.06 * liftK) }), opacity: 0.6 * (1 - 0.35 * liftK) * (1 - uu) ** 1.4 },
      backdrop: { opacity: 1 - smooth(0.14, 0.8, t) },
    };
    if (built?.ghosts.length) f.ghosts = LAG.map((lag, i) => ({ transform: tf(spinPose(t - lag)), opacity: GA[i] * smooth(0.12, 0.6, sp) * op }));
    return f;
  };

  /** Klatki kluczowe warstw z funkcji stanu (próbkowanie co ~22 ms, interpolacja liniowa między próbkami). */
  const sample = (frameFn, dur) => {
    const N = Math.round(clamp(dur / 22, 40, 160)), out = {};
    for (let i = 0; i <= N; i++) {
      const t = i / N, f = frameFn(t);
      for (const [k, v] of Object.entries(f)) {
        if (Array.isArray(v)) v.forEach((x, j) => (out[`${k}.${j}`] ??= []).push({ ...x, offset: t }));
        else (out[k] ??= []).push({ ...v, offset: t });
      }
    }
    return out;
  };
  const layer = (key) => {
    const b = built, [name, idx] = key.split(".");
    return name === "ghosts" ? b.ghosts[+idx] : name === "photo" ? photo : b[name];
  };

  const placeAtStart = () => {
    const b = built;
    // czyste zdjęcie (zrzut) przenosi się do strony, dokładnie na miejsce rastra
    photo.style.cssText = `position:absolute;display:block;left:${b.photoCss.x.toFixed(3)}px;top:${b.photoCss.y.toFixed(3)}px;width:${b.photoCss.w.toFixed(3)}px;height:${b.photoCss.h.toFixed(3)}px;`;
    b.sheet.append(photo);
    root.append(b.backdrop, b.rig, b.flash);
    flat.remove();
    for (const gc of b.ghosts) gc.style.transform = tf(restPose());
  };

  /** Faza A: zdjęcie staje się gazetą (kamera odjeżdża, strona osiada). */
  async function press() {
    if (pressDone) return pressDone;
    pressDone = (async () => {
      // najazd rusza od razu (kompozytor), równolegle z rysowaniem strony
      const pushed = push();
      if (!(await ready) || closed) return;
      await pushed;
      if (closed) return;
      const b = built;
      if (reduced) {
        // spokojnie: gotowa strona w spoczynku przenika się ze zrzutem (bez zoomu i obrotu)
        root.append(b.backdrop, b.rig);
        root.append(flat); // zrzut nad stroną, znika
        b.sheet.style.transform = tf(restPose());
        b.shadow.style.transform = tf({ ...restPose(), y: 14, s: 1.02 }); b.shadow.style.opacity = "0.5";
        await play(flat, [{ opacity: 1 }, { opacity: 0 }], { duration: CALM_IN_MS, easing: "ease-out" }).finished.catch(() => {});
        flat.remove();
        return;
      }
      placeAtStart();
      let last = null;
      for (const [k, kf] of Object.entries(sample(pressFrame, PRESS_MS))) last = play(layer(k), kf, { duration: PRESS_MS });
      await last?.finished.catch(() => {});
      if (closed) return;
      b.flash.remove();
      // oczekiwanie na start: bardzo wolny dojazd kamery, żeby kadr nie „zamarł”
      play(b.rig, [{ transform: "scale(1)" }, { transform: "scale(1.035)" }], { duration: 16000, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    })();
    return pressDone;
  }

  /** Faza B: strona unosi się, wiruje z przyspieszeniem i odlatuje; tło znika, odsłaniając nową mapę. */
  async function spin() {
    await press();
    if (closed) return;
    const b = built;
    if (!b) { await close(true); return; }
    if (reduced) {
      play(b.rig, [{ transform: "translateY(0)", opacity: 1 }, { transform: `translateY(${Math.round(VH * 0.03)}px)`, opacity: 0 }], { duration: CALM_OUT_MS, easing: "cubic-bezier(0.7, 0, 0.84, 0)" });
      await play(b.backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: CALM_OUT_MS, easing: "ease-in-out" }).finished.catch(() => {});
      dispose();
      return;
    }
    const dur = d.spinSec * 1000;
    let last = null;
    for (const [k, kf] of Object.entries(sample(spinFrame, dur))) last = play(layer(k), kf, { duration: dur });
    await last?.finished.catch(() => {}); // wszystkie warstwy mają ten sam czas
    if (closed) return;
    dispose();
  }

  /**
   * Narzędzie weryfikacji (harness, konsola): ustaw statyczną klatkę fazy "press" | "spin" w chwili t∈[0,1] — te same funkcje
   * stanu co animacja, ale bez WAAPI (zrzut ekranu zatrzymanej animacji bywa nieaktualny).
   */
  async function seek(phase, t) {
    if (!(await ready) || closed || reduced) return;
    const b = built;
    for (const a of anims) a.cancel();
    anims.clear();
    if (phase === "push") {
      // najazd: tylko gdy był potrzebny i strona jeszcze nie przejęła zdjęcia
      if (!pushIn || b.rig.isConnected) return;
      pushDone = Promise.resolve(); // press() po seek("push") nie odpali drugiego najazdu
      if (!photo.isConnected) { photo.style.cssText = `${ABS}transform-origin:0 0;`; flat.append(photo); }
      cover.style.transformOrigin = "0 0";
      const f = pushFrame(t);
      cover.style.transform = f.cover.transform;
      photo.style.transform = f.photo.transform; photo.style.opacity = String(f.photo.opacity);
      return;
    }
    if (!b.rig.isConnected) placeAtStart();
    if (phase === "spin") { b.flash.remove(); photo.style.opacity = "0"; b.rig.style.transform = "scale(1.035)"; }
    else { if (!b.flash.isConnected) root.append(b.flash); b.rig.style.transform = ""; b.backdrop.style.opacity = "1"; for (const gc of b.ghosts) gc.style.opacity = "0"; }
    const f = phase === "spin" ? spinFrame(t) : pressFrame(t);
    for (const [k, v] of Object.entries(f)) {
      const list = Array.isArray(v) ? v.map((x, j) => [`${k}.${j}`, x]) : [[k, v]];
      for (const [key, st] of list) {
        const el = layer(key);
        if (!el) continue;
        if (st.transform) el.style.transform = st.transform;
        if (st.opacity !== undefined) el.style.opacity = String(st.opacity);
      }
    }
  }

  /** Szybkie zamknięcie (pominięcie / „Zamknij u wszystkich”): całość gaśnie w 250 ms. */
  async function close(fast = true) {
    if (closed) return;
    closed = true;
    const a = root.animate([{ opacity: getComputedStyle(root).opacity }, { opacity: 0 }], { duration: fast ? 250 : 600, easing: "ease-out", fill: "forwards" });
    await a.finished.catch(() => {});
    dispose();
  }

  function dispose() {
    closed = true;
    for (const a of anims) { try { a.cancel(); } catch { /* */ } }
    anims.clear();
    root.remove();
  }

  return { root, ready, press, spin, close, dispose, seek, stats, get closed() { return closed; }, data: d };
}

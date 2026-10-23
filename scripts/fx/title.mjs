/**
 * Napis-plansza lokacji (tytuł nakładany na reveal) — port 1:1 z Reacta (RevealTitle.tsx / titleStyles.ts / titleCss.ts /
 * settings/ranges.ts / panels/TitleSection.tsx) na czysty ES module (vanilla DOM, bez globali Foundry).
 *
 * Różnica architektoniczna (jedyna): oryginał gra animacje CSS w czasie rzeczywistym od chwili pojawienia się napisu.
 * Tu te SAME animacje CSS (te same keyframes, opóźnienia, czasy) są wstrzymane i ustawiane imperatywnie przez Web
 * Animations (`animation.currentTime`) na t = (progress − appearAt) · totalSeconds, więc napis jest deterministyczny
 * względem postępu osi (scrub w obie strony, p < appearAt = brak napisu). DOM budowany raz na zmianę opcji.
 */

// ───────────────────────────── style (titleStyles.ts) ─────────────────────────────

export const TITLE_STYLES = [
  { value: "serif", label: "Kinowy (szeryf)" },
  { value: "noir", label: "Noir (grotesk)" },
  { value: "neon", label: "Neon (migoczący)" },
  { value: "typewriter", label: "Maszyna do pisania" },
  { value: "script", label: "Odręczny (przeciągnięcie)" },
  { value: "gold", label: "Złoty grawer" },
  { value: "minimal", label: "Minimal (cienki)" },
  { value: "stencil", label: "Szablon (grunge)" },
  { value: "gothic", label: "Gotyk (łamane)" },
  { value: "retro", label: "Retrofala (chrom)" },
  { value: "glitch", label: "Glitch (RGB)" },
  { value: "outline", label: "Obrys → wypełnienie" },
  { value: "comic", label: "Komiks (pop)" },
  { value: "ember", label: "Żar (ogień)" },
  { value: "chalk", label: "Kreda (tablica)" },
  { value: "marquee", label: "Szyld teatralny" },
  { value: "frost", label: "Lód (szron)" },
  { value: "blood", label: "Krew (horror)" },
  { value: "toxic", label: "Toksyczny (slime)" },
  { value: "western", label: "Western (poszukiwany)" },
  { value: "cyber", label: "Cyberpunk" },
  { value: "elegant", label: "Elegancki (kursywa)" },
];

export const TITLE_PLACES = [
  { value: "bottom", label: "na dole" },
  { value: "center", label: "od razu na środku" },
  { value: "slide", label: "z przejściem na środek" },
];

export const TITLE_EXITS = [
  { value: "none", label: "bez zaniku" },
  { value: "blur", label: "rozmycie" },
  { value: "blurzoom", label: "rozmycie z przybliżeniem" },
  { value: "focus", label: "wyjście z ostrości" },
  { value: "ghost", label: "duch (migotliwe rozmycie)" },
  { value: "spread", label: "rozpłynięcie (litery się rozjeżdżają)" },
  { value: "wave", label: "fala rozmycia" },
  { value: "smoke", label: "dym" },
  { value: "dust", label: "rozsypanie (pył)" },
  { value: "wind", label: "zdmuchnięcie" },
];

const GLITCH_SH = "-0.04em 0 rgba(255,42,109,.75), 0.04em 0 rgba(5,217,232,.75), 0 2px 14px rgba(0,0,0,.9)";
const DEF_SHADOW = "0 2px 14px rgba(0,0,0,.9), 0 0 3px rgba(0,0,0,.7), 0 0 28px rgba(0,0,0,.45)";

const STYLES = {
  serif: {
    font: "'Cormorant Garamond','Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif",
    weight: 500, size: 5.2, spacing: ".22em", transform: "uppercase", enter: "blur",
    color: "#f3ead7", line: "linear-gradient(90deg, transparent, #d9b46a 25%, #f3dc9b 50%, #d9b46a 75%, transparent)",
  },
  noir: {
    font: "'Oswald','Bebas Neue','Arial Narrow',Impact,sans-serif",
    weight: 600, size: 6, spacing: ".12em", transform: "uppercase", enter: "blur",
    color: "#f2f2f2", line: "linear-gradient(90deg, transparent, #d1344a 20%, #d1344a 80%, transparent)",
  },
  neon: {
    font: "'Monoton','Tilt Neon','Futura','Century Gothic','Trebuchet MS',sans-serif",
    weight: 400, size: 5.6, spacing: ".14em", transform: "uppercase", enter: "flicker",
    color: "#ffeaf3", shadow: "0 0 3px #fff, 0 0 10px #ff4d8d, 0 0 24px #ff2d78, 0 0 52px #e0125f, 0 0 90px #b30f4d",
    line: "linear-gradient(90deg, transparent, #ff4d8d 20%, #ffd0e2 50%, #ff4d8d 80%, transparent)", lineGlow: "0 0 10px #ff2d78, 0 0 22px #e0125f",
  },
  typewriter: {
    font: "'Courier Prime','Courier New',Courier,monospace",
    weight: 700, size: 4.4, spacing: ".06em", transform: "uppercase", enter: "type",
    color: "#efe8d4", line: "linear-gradient(90deg, transparent, rgba(239,232,212,.55) 20%, rgba(239,232,212,.55) 80%, transparent)",
  },
  script: {
    font: "'Snell Roundhand','Segoe Script','Brush Script MT','Lucida Handwriting','Apple Chancery',cursive",
    weight: 400, size: 7.4, spacing: ".02em", transform: "none", enter: "wipe",
    color: "#fff3df", line: "linear-gradient(90deg, transparent, rgba(255,243,223,.6) 30%, rgba(255,243,223,.6) 70%, transparent)",
  },
  gold: {
    font: "'Cinzel','Trajan Pro','Cormorant SC','Palatino Linotype',Georgia,serif",
    weight: 600, size: 5, spacing: ".2em", transform: "uppercase", enter: "blur",
    color: "#e8c46e", shadow: "none", filter: "drop-shadow(0 2px 5px rgba(0,0,0,.75)) drop-shadow(0 0 14px rgba(255,200,90,.28))",
    gradient: "linear-gradient(180deg, #fff6cf 0%, #f2d27a 38%, #b07a22 52%, #f6dc8d 74%, #fff2bb 100%)",
    line: "linear-gradient(90deg, transparent, #b07a22 20%, #fff0b0 50%, #b07a22 80%, transparent)",
  },
  minimal: {
    font: "'Inter','Helvetica Neue',Helvetica,Arial,sans-serif",
    weight: 200, size: 3.8, spacing: ".5em", transform: "uppercase", enter: "blur",
    color: "#ffffff", shadow: "0 1px 12px rgba(0,0,0,.8), 0 0 2px rgba(0,0,0,.5)",
    line: "linear-gradient(90deg, transparent, rgba(255,255,255,.8) 50%, transparent)",
  },
  stencil: {
    font: "'Stardos Stencil','Saira Stencil One','Black Ops One',Impact,'Haettenschweiler',sans-serif",
    weight: 700, size: 6.2, spacing: ".08em", transform: "uppercase", enter: "blur",
    color: "#e9e4d4", filter: "url(#rvt-rough)",
    line: "linear-gradient(90deg, transparent, #e9e4d4 15%, #e9e4d4 85%, transparent)",
  },
  gothic: {
    font: "'UnifrakturCook','UnifrakturMaguntia','Old English Text MT','Blackadder ITC',serif",
    weight: 700, size: 6.4, spacing: ".04em", transform: "none", enter: "blur",
    color: "#ebe1cd", shadow: "0 0 3px #000, 0 0 16px rgba(170,25,25,.6), 0 0 42px rgba(120,10,10,.45)",
    line: "linear-gradient(90deg, transparent, #8c1c1c 20%, #d9b46a 50%, #8c1c1c 80%, transparent)",
  },
  retro: {
    font: "'Audiowide','Orbitron','Eurostile','Arial Black',Impact,sans-serif",
    weight: 800, size: 5.4, spacing: ".06em", transform: "uppercase", enter: "blur", italic: true,
    color: "#ffd0f2", shadow: "none", filter: "drop-shadow(0 0 2px #ff6ad5) drop-shadow(0 0 18px rgba(255,106,213,.55)) drop-shadow(0 3px 0 rgba(60,20,120,.8))",
    gradient: "linear-gradient(180deg, #ffffff 0%, #ffd9f5 34%, #8f6bff 50%, #ff6ad5 66%, #ffe6fb 100%)",
    line: "linear-gradient(90deg, transparent, #ff6ad5 20%, #6ad5ff 80%, transparent)", lineGlow: "0 0 10px #ff6ad5",
  },
  glitch: {
    font: "'Rajdhani','Share Tech Mono','Consolas','Lucida Console',monospace",
    weight: 700, size: 5, spacing: ".1em", transform: "uppercase", enter: "glitch",
    color: "#eef6ff", shadow: GLITCH_SH,
    line: "linear-gradient(90deg, transparent, #05d9e8 25%, #ff2a6d 75%, transparent)",
  },
  outline: {
    font: "'Playfair Display','Didot','Bodoni MT','Palatino Linotype',Georgia,serif",
    weight: 800, size: 5.6, spacing: ".1em", transform: "uppercase", enter: "outline",
    color: "#f6f1e6", stroke: "1.4px #f6f1e6", line: "linear-gradient(90deg, transparent, rgba(246,241,230,.7) 25%, rgba(246,241,230,.7) 75%, transparent)",
  },
  comic: {
    font: "'Bangers','Impact','Haettenschweiler','Arial Black',sans-serif",
    weight: 400, size: 6.6, spacing: ".06em", transform: "uppercase", enter: "pop", italic: true,
    color: "#ffd23f", stroke: "1.6px #1a1a1a", shadow: "3px 3px 0 #d1344a, 6px 6px 0 #1a1a1a",
    line: "linear-gradient(90deg, transparent, #d1344a 15%, #ffd23f 50%, #d1344a 85%, transparent)",
  },
  ember: {
    font: "'Cinzel Decorative','Cinzel','Trajan Pro','Palatino Linotype',Georgia,serif",
    weight: 700, size: 5.2, spacing: ".18em", transform: "uppercase", enter: "flicker",
    color: "#ffb347", shadow: "none", filter: "drop-shadow(0 0 8px rgba(255,120,30,.75)) drop-shadow(0 0 26px rgba(255,70,0,.5)) drop-shadow(0 2px 3px rgba(0,0,0,.8))",
    gradient: "linear-gradient(180deg, #fff3b0 0%, #ffb347 38%, #ff5a1f 68%, #9a1c08 100%)",
    line: "linear-gradient(90deg, transparent, #ff5a1f 20%, #ffd27a 50%, #ff5a1f 80%, transparent)", lineGlow: "0 0 10px rgba(255,90,31,.8)",
  },
  chalk: {
    font: "'Patrick Hand','Chalkboard SE','Bradley Hand','Comic Sans MS',cursive",
    weight: 400, size: 6, spacing: ".06em", transform: "none", enter: "wipe",
    color: "#f2f0e6", shadow: "0 0 6px rgba(255,255,255,.35), 1px 1px 0 rgba(0,0,0,.35)", filter: "url(#rvt-rough)",
    line: "linear-gradient(90deg, transparent, rgba(242,240,230,.7) 20%, rgba(242,240,230,.7) 80%, transparent)",
  },
  marquee: {
    font: "'Rye','Playbill','Bodoni MT Black','Rockwell Extra Bold','Georgia',serif",
    weight: 800, size: 5.4, spacing: ".1em", transform: "uppercase", enter: "flicker",
    color: "#ffe9a8", stroke: "1.2px #7a1f12", shadow: "0 0 10px #ffb300, 0 0 26px rgba(255,150,0,.65), 0 3px 0 #5a1208",
    line: "linear-gradient(90deg, transparent, #ffb300 15%, #fff1c2 50%, #ffb300 85%, transparent)", lineGlow: "0 0 12px rgba(255,170,0,.9)",
  },
  frost: {
    font: "'Cinzel','Trajan Pro','Palatino Linotype',Georgia,serif",
    weight: 600, size: 5.2, spacing: ".2em", transform: "uppercase", enter: "blur",
    color: "#dff6ff", shadow: "none", filter: "drop-shadow(0 0 3px rgba(190,240,255,.9)) drop-shadow(0 0 20px rgba(110,200,255,.55)) drop-shadow(0 2px 3px rgba(0,30,60,.7))",
    gradient: "linear-gradient(180deg, #ffffff 0%, #cdeeff 42%, #7ec8f0 60%, #e6f8ff 100%)",
    line: "linear-gradient(90deg, transparent, #7ec8f0 20%, #ffffff 50%, #7ec8f0 80%, transparent)", lineGlow: "0 0 10px rgba(150,220,255,.8)",
  },
  blood: {
    font: "'Creepster','Nosifer','Eater','Chiller','Impact',fantasy",
    weight: 400, size: 6.2, spacing: ".05em", transform: "none", enter: "blur",
    color: "#d41b1b", shadow: "0 0 3px #000, 0 3px 0 #4a0505, 0 0 22px rgba(190,10,10,.7), 0 0 50px rgba(120,0,0,.5)",
    line: "linear-gradient(90deg, transparent, #6e0a0a 20%, #d41b1b 50%, #6e0a0a 80%, transparent)", lineGlow: "0 0 8px rgba(200,20,20,.8)",
  },
  toxic: {
    font: "'Bungee Shade','Bungee','Rubik Mono One','Arial Black',Impact,sans-serif",
    weight: 400, size: 4.8, spacing: ".04em", transform: "uppercase", enter: "glitch",
    color: "#b6ff3c", shadow: "0 0 4px #e8ff9a, 0 0 14px #7dff00, 0 0 34px rgba(90,220,0,.7), 0 0 70px rgba(40,160,0,.5)",
    line: "linear-gradient(90deg, transparent, #7dff00 20%, #e8ff9a 50%, #7dff00 80%, transparent)", lineGlow: "0 0 10px #7dff00",
  },
  western: {
    font: "'Rye','Playbill','Rockwell Extra Bold','Clarendon','Georgia',serif",
    weight: 800, size: 5.6, spacing: ".05em", transform: "uppercase", enter: "pop",
    color: "#ecd29b", stroke: "1.4px #4a2c12", shadow: "2px 2px 0 #4a2c12, 4px 4px 0 rgba(30,15,5,.8), 0 0 14px rgba(0,0,0,.6)",
    line: "linear-gradient(90deg, transparent, #8a5a22 15%, #ecd29b 50%, #8a5a22 85%, transparent)",
  },
  cyber: {
    font: "'Orbitron','Rajdhani','Eurostile','Bank Gothic','Arial Black',sans-serif",
    weight: 800, size: 4.8, spacing: ".14em", transform: "uppercase", enter: "glitch",
    color: "#fcee0a", shadow: "3px 3px 0 rgba(0,240,255,.85), -2px -1px 0 rgba(255,0,110,.7), 0 0 18px rgba(252,238,10,.4)",
    line: "linear-gradient(90deg, transparent, #fcee0a 15%, #00f0ff 85%, transparent)", lineGlow: "0 0 10px rgba(0,240,255,.7)",
  },
  elegant: {
    font: "'Cormorant Garamond','Playfair Display','Palatino Linotype','Book Antiqua',Georgia,serif",
    weight: 300, size: 6.4, spacing: ".1em", transform: "none", enter: "blur", italic: true,
    color: "#faf5ea", shadow: "0 1px 14px rgba(0,0,0,.85), 0 0 3px rgba(0,0,0,.5)",
    line: "linear-gradient(90deg, transparent, rgba(250,245,234,.7) 50%, transparent)",
  },
};

// ───────────────────────────── opcje / sanityzacja / pola formularza ─────────────────────────────

export const DEFAULT_TITLE = {
  enabled: false, text: "Aleja za barem", subtitle: "Dreamhaven", appearAt: 0.6, style: "serif", place: "center",
  hold: 0.9, exit: "blur", stay: 2.5, shade: 0.5, scale: 1,
};

/** Zakresy = min/max suwaków (ranges.ts → TITLE_RANGES). */
const TITLE_RANGES = { appearAt: [0, 0.95], scale: [0.4, 2.5], shade: [0, 1], stay: [0, 8], hold: [0, 4] };

const values = (list) => list.map((o) => o.value);
const ENUMS = { style: values(TITLE_STYLES), place: values(TITLE_PLACES), exit: values(TITLE_EXITS) };
const HEX6 = /^#[0-9a-f]{6}$/i;
/** Jak `hexOr` z ranges.ts (TitleOpts nie ma dziś kolorów; zostawione dla pól typu color). */
const hexOr = (v, def) => (typeof v === "string" && HEX6.test(v) ? v.toLowerCase() : def);

/**
 * Tekst napisu: samotne surogaty i znaki sterujące psułyby serializację XML eksportu (obraz SVG) albo rzucały URIError,
 * a bardzo długi tekst = tysiące animacji — stąd oczyszczenie i limit 200 znaków.
 */
function cleanText(x) {
  let s = typeof x.toWellFormed === "function" ? x.toWellFormed() : x;
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
  return s.length > 200 ? s.slice(0, 200) : s;
}

/** Dowolny obiekt → poprawne opcje napisu (zakresy, wyliczenia, typy). Nigdy nie rzuca. */
export function sanitizeTitle(raw) {
  const out = { ...DEFAULT_TITLE };
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const k of Object.keys(DEFAULT_TITLE)) {
      const d = DEFAULT_TITLE[k], x = raw[k];
      if (typeof d === "number") {
        if (typeof x === "number" && Number.isFinite(x)) {
          const r = TITLE_RANGES[k];
          out[k] = r ? Math.max(r[0], Math.min(r[1], x)) : x;
        }
      } else if (typeof d === "boolean") {
        if (typeof x === "boolean") out[k] = x;
      } else if (typeof d === "string") {
        const allowed = ENUMS[k];
        if ((k === "text" || k === "subtitle") && typeof x === "string") out[k] = cleanText(x);
        else if (typeof x === "string" && (!allowed || allowed.includes(x))) out[k] = x;
        else if (/color/i.test(k)) out[k] = hexOr(x, d);
      }
    }
  } catch { /* zwróć to, co jest */ }
  return out;
}

const toOptions = (list) => list.map((o) => [o.value, o.label]);

/**
 * Opis pól formularza (TitleSection.tsx). Pola `advanced` to „Zaawansowane”. Opcjonalnie:
 *  - `showIf: { key, is?, not? }` — pole widoczne tylko gdy opts[key] === is / !== not (w oryginale: „Czas stania” tylko
 *    gdy zanik ≠ „bez zaniku”, „Zwłoka…” tylko gdy pozycja = „z przejściem na środek”),
 *  - `percent: true` — wartość suwaka (0..1) pokazywana jako „NN%”, `suffix` (np. „ osi”), `prefix` (np. „×”), `unit` (np. „ s”),
 *  - `placeholder` — pola tekstowe.
 */
export const TITLE_FIELDS = [
  { key: "enabled", label: "Napis", type: "check" },
  { key: "text", label: "Tytuł", type: "text", placeholder: "Tytuł" },
  { key: "subtitle", label: "Podtytuł", type: "text", placeholder: "(opcjonalny)" },
  { key: "style", label: "Styl", type: "select", options: toOptions(TITLE_STYLES) },
  { key: "place", label: "Pozycja", type: "select", options: toOptions(TITLE_PLACES) },
  { key: "exit", label: "Zanik", type: "select", options: toOptions(TITLE_EXITS) },
  { key: "appearAt", label: "Pojawia się od", type: "range", min: 0, max: 0.95, step: 0.05, percent: true, suffix: " osi",
    hint: "Kiedy napis się pojawia (moment całej osi przejścia)" },
  { key: "scale", label: "Wielkość", type: "range", min: 0.4, max: 2.5, step: 0.05, prefix: "×",
    hint: "Wielkość napisu (skaluje się razem z obrazem)" },
  { key: "shade", label: "Tło", type: "range", min: 0, max: 1, step: 0.05, percent: true,
    hint: "Miękkie przyciemnienie tylko za napisem (0 = brak, reszta obrazu nietknięta)" },
  { key: "stay", label: "Czas stania", type: "range", min: 0, max: 8, step: 0.25, unit: " s", advanced: true,
    showIf: { key: "exit", not: "none" }, hint: "Jak długo napis stoi, zanim zacznie znikać" },
  { key: "hold", label: "Zwłoka przed przesunięciem", type: "range", min: 0, max: 4, step: 0.1, unit: " s", advanced: true,
    showIf: { key: "place", is: "slide" }, hint: "Zwłoka po pełnym wejściu napisu, zanim zacznie się przesuwać na środek" },
];

// ───────────────────────────── CSS (titleCss.ts + zamienniki klas Tailwinda) ─────────────────────────────

const KEYFRAMES = `
@keyframes rvt-letter { 0% { opacity: 0; filter: blur(12px); transform: translate3d(0,.32em,0); }
  55% { opacity: .85; filter: blur(2px); } 100% { opacity: 1; filter: blur(0); transform: translate3d(0,0,0); } }
@keyframes rvt-line { from { transform: scaleX(0); opacity: 0; } to { transform: scaleX(1); opacity: 1; } }
@keyframes rvt-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes rvt-move { from { transform: translate3d(0, calc(45cqh - 100%), 0) scale(1); }
  to { transform: translate3d(0,-50%,0) scale(1.22); } }
@keyframes rvt-gone { to { visibility: hidden; } }
@keyframes rvt-fadeout { from { opacity: 1; } to { opacity: 0; } }
@keyframes rvt-x-blur { from { opacity: 1; filter: blur(0); transform: scale(1); }
  to { opacity: 0; filter: blur(18px); transform: scale(1.1); } }
@keyframes rvt-x-smoke { 0% { opacity: 1; filter: blur(0); transform: translate3d(0,0,0) scale(1) rotate(0); }
  35% { opacity: .8; filter: blur(3px); }
  100% { opacity: 0; filter: blur(16px); color: #c9c9c9; transform: translate3d(var(--dx),calc(var(--dy) * -1),0) scale(1.7) rotate(var(--rot)); } }
@keyframes rvt-x-dust { 0% { opacity: 1; filter: blur(0); transform: translate3d(0,0,0) rotate(0) scale(1); }
  100% { opacity: 0; filter: blur(2px); transform: translate3d(var(--dx),var(--dy),0) rotate(var(--rot)) scale(.6); } }
@keyframes rvt-x-wind { 0% { opacity: 1; filter: blur(0); transform: translate3d(0,0,0) skewX(0) scale(1); }
  100% { opacity: 0; filter: blur(8px); transform: translate3d(var(--dx),var(--dy),0) skewX(-22deg) scale(1.1); } }
@keyframes rvt-x-bzoom { from { opacity: 1; filter: blur(0); transform: scale(1); } to { opacity: 0; filter: blur(22px); transform: scale(1.75); } }
@keyframes rvt-x-focus { from { opacity: 1; filter: blur(0); transform: scale(1); } to { opacity: 0; filter: blur(14px); transform: scale(.9); } }
@keyframes rvt-x-ghost { 0% { opacity: 1; filter: blur(0); } 15% { opacity: .35; filter: blur(2px); } 30% { opacity: .9; filter: blur(1px); }
  50% { opacity: .25; filter: blur(5px); } 70% { opacity: .6; filter: blur(9px); } 100% { opacity: 0; filter: blur(20px); } }
@keyframes rvt-x-spread { from { opacity: 1; filter: blur(0); transform: translate3d(0,0,0) scale(1); }
  to { opacity: 0; filter: blur(14px); transform: translate3d(var(--dx),0,0) scale(1.35); } }
@keyframes rvt-x-wave { from { opacity: 1; filter: blur(0); transform: translate3d(0,0,0); } to { opacity: 0; filter: blur(14px); transform: translate3d(0,-.15em,0); } }
@keyframes rvt-x-fade { from { opacity: 1; } to { opacity: 0; } }
@keyframes rvt-x-sub { from { opacity: .85; filter: blur(0); transform: translate3d(0,0,0); }
  to { opacity: 0; filter: blur(10px); transform: translate3d(0,-.8em,0); } }
@keyframes rvt-puff { 0% { visibility: visible; opacity: 0; transform: translate3d(0,0,0) scale(.3); }
  30% { opacity: .65; } 99% { visibility: visible; } 100% { visibility: hidden; opacity: 0; transform: translate3d(var(--px),calc(var(--py) * -1),0) scale(var(--ps)); } }
@keyframes rvt-flick { 0% { opacity: 0; } 8% { opacity: .9; } 14% { opacity: .05; } 22% { opacity: 1; } 30% { opacity: .15; }
  38% { opacity: .8; } 46% { opacity: 0; } 58% { opacity: 1; } 66% { opacity: .55; } 100% { opacity: 1; } }
@keyframes rvt-hum { 0%, 91%, 100% { opacity: 1; } 92% { opacity: .35; } 94% { opacity: 1; } 96% { opacity: .5; } 98% { opacity: 1; } }
@keyframes rvt-glitch { 0% { opacity: 0; transform: translate3d(-.15em,0,0) skewX(20deg); text-shadow: -.12em 0 #ff2a6d, .12em 0 #05d9e8; }
  15% { opacity: 1; transform: translate3d(.12em,0,0) skewX(-14deg); } 30% { opacity: .2; transform: translate3d(-.08em,.04em,0); }
  45% { opacity: 1; transform: translate3d(.05em,-.03em,0) skewX(8deg); text-shadow: .08em 0 #ff2a6d, -.08em 0 #05d9e8; }
  60% { opacity: .6; transform: translate3d(0,0,0); } 80% { opacity: 1; }
  100% { opacity: 1; transform: none; text-shadow: ${GLITCH_SH}; } }
@keyframes rvt-gloop { 0%, 92%, 100% { transform: none; } 93% { transform: translate3d(.08em,0,0) skewX(-12deg); }
  95% { transform: translate3d(-.1em,.02em,0); } 97% { transform: none; } }
@keyframes rvt-fillin { from { color: transparent; } to { color: var(--fill); } }
@keyframes rvt-pop { 0% { opacity: 0; transform: scale(.2) rotate(-12deg); } 60% { opacity: 1; transform: scale(1.25) rotate(4deg); }
  100% { opacity: 1; transform: none; } }
@keyframes rvt-type { from { opacity: 0; } to { opacity: 1; } }
@keyframes rvt-wipe { from { clip-path: inset(-100% 100% -100% -100%); } to { clip-path: inset(-100% -100% -100% -100%); } }
@keyframes rvt-cpass { 0% { opacity: 1; } 99% { opacity: 1; } 100% { opacity: 0; } }
@keyframes rvt-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes rvt-sub { from { opacity: 0; letter-spacing: .6em; } to { opacity: .85; letter-spacing: .38em; } }
`;

/** „Lekkie animacje”: te same keyframes bez `filter: blur` (nazwy rvtl-…); ta sama zamiana regexem co w oryginale (LITE_CSS). */
const LITE_KEYFRAMES = KEYFRAMES.replace(/filter:\s*blur\([^)]*\);?\s*/g, "").replace(/@keyframes rvt-/g, "@keyframes rvtl-");

const BASE_CSS = `
.sr-title { position: absolute; inset: 0; pointer-events: none; container-type: size; font-size: 16px; }
.sr-title, .sr-title * { box-sizing: border-box; }
.sr-title svg { display: block; }
.rvt-block { position: absolute; left: 6%; right: 6%; top: 50%; display: flex; flex-direction: column; align-items: center; text-align: center; }
.rvt-halo { position: absolute; }
.rvt-inner { display: flex; flex-direction: column; align-items: center; }
.rvt-h2 { position: relative; margin: 0; line-height: 1; }
.rvt-word { display: inline-block; white-space: nowrap; }
.rvt-letter { display: inline-block; position: relative; }
.rvt-cur { position: absolute; font-style: normal; }
.rvt-gap { display: inline-block; width: .42em; }
.rvt-line { position: relative; margin-top: 1.1em; height: 1px; width: min(60%, 34rem); transform-origin: center; }
.rvt-sub { position: relative; margin: .9em 0 0; text-transform: uppercase; }
.rvt-puff { visibility: hidden; position: absolute; left: 50%; top: 50%; width: .9em; height: .9em; margin: -.45em 0 0 -.45em; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, rgba(238,238,238,.6), rgba(200,200,200,.28) 45%, transparent 70%); filter: blur(5px); }
.rvt-lite .rvt-puff { filter: none; }
.sr-title svg.rvt-defs { position: absolute; width: 0; height: 0; }
@media (prefers-reduced-motion: reduce) { .rvt-block { animation: none !important; transform: translate3d(0,-50%,0) scale(1.22) !important; } }
`;

let cssUsers = 0;
function acquireCss() {
  if (!document.getElementById("sr-title-css")) {
    const st = document.createElement("style");
    st.id = "sr-title-css";
    st.textContent = BASE_CSS + KEYFRAMES + LITE_KEYFRAMES;
    document.head.appendChild(st);
  }
  cssUsers++;
}
function releaseCss() {
  if (--cssUsers <= 0) { cssUsers = 0; document.getElementById("sr-title-css")?.remove(); }
}

// ───────────────────────────── grafemy ─────────────────────────────

let segmenter = null;
try { if (typeof Intl !== "undefined" && Intl.Segmenter) segmenter = new Intl.Segmenter("pl", { granularity: "grapheme" }); } catch { segmenter = null; }
/** Grafemy tekstu (Intl.Segmenter; bez niego — punkty kodowe). */
export function graphemes(t) {
  return segmenter ? Array.from(segmenter.segment(t), (x) => x.segment) : Array.from(t);
}

// ───────────────────────────── narzędzia ─────────────────────────────

const rnd = (i, k) => ((Math.imul(i + 1, 2654435761) ^ Math.imul(k + 7, 40503)) >>> 0) % 1000 / 1000;
const MOVE_DUR = 1.8, EASE = "cubic-bezier(.65,0,.35,1)";
const SVG_NS = "http://www.w3.org/2000/svg";
let roughSeq = 0;

function el(tag, cls, style) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (style) for (const [k, v] of Object.entries(style)) { if (v != null && v !== "") (k.startsWith("--") ? e.style.setProperty(k, v) : (e.style[k] = v)); }
  return e;
}

/**
 * Słowo szersze niż kadr: font zmniejszany tak, by najszersze słowo zmieściło się w szerokości (na środku blok ma
 * scale(1.22)); gdy i tak < 10 px — słowa łamią się między literami. Napis mieszczący się w kadrze nie jest dotykany.
 */
function fitWords(h2, box, fontCqw, place) {
  if (!h2 || !box || !box.isConnected) return;
  const base = `max(10px, ${fontCqw.toFixed(2)}cqw)`;
  if (h2.style.fontSize !== base) h2.style.fontSize = base;
  const words = Array.from(h2.children).filter((e) => e.tagName === "SPAN" && e.classList.contains("rvt-word"));
  words.forEach((w) => { if (w.style.whiteSpace) { w.style.whiteSpace = ""; w.style.maxWidth = ""; } });
  const room = box.clientWidth / (place === "bottom" ? 1 : 1.22);
  const widest = words.reduce((m, w) => Math.max(m, w.offsetWidth), 0);
  if (!(room > 0) || widest <= room) return;
  const cqw = fontCqw * (room / widest) * 0.92; // zapas: glify (kursywa, cienie, szeryfy) wystają poza pudełka liter
  h2.style.fontSize = `max(10px, ${cqw.toFixed(3)}cqw)`;
  if ((cqw * box.clientWidth) / 100 < 10) {
    const max = `${((92 * room) / box.clientWidth).toFixed(2)}cqw`;
    words.forEach((w) => { w.style.whiteSpace = "normal"; w.style.maxWidth = max; });
  }
}

// ───────────────────────────── createTitle ─────────────────────────────

export function createTitle({ host, opts, lite = false }) {
  acquireCss();
  let o = sanitizeTitle(opts);
  let isLite = !!lite;
  let root = null;
  let anims = [];
  let lastProgress = 0, lastTotal = 10;
  let lastT = null, shown = false, needFit = false;
  let fitArgs = null;
  let disposed = false;
  let fontsHooked = false;
  let builtDuration = 0; // sekundy własnego zegara napisu do końca zaniku (dla odtwarzacza: oś musi być tak długa)

  function teardown() {
    builtDuration = 0;
    root?.remove();
    root = null; anims = []; lastT = null; shown = false; fitArgs = null;
  }

  function build() {
    teardown();
    if (!o.text.trim()) return;
    const s = STYLES[o.style];
    const P = isLite ? "rvtl-" : "rvt-";
    const ex = o.exit;
    // litery = grafemy; odstępy znormalizowane do jednej spacji (indeksy liter zgadzają się z liczbą liter)
    const words = o.text.trim().split(/\s+/).map(graphemes);
    const count = words.reduce((n, w) => n + w.length, 0) + words.length - 1;
    // zegar wejścia: litery → linia → (zwłoka) → przesunięcie na środek
    const lineAt = s.enter === "type" ? 0.25 + count * 0.09 + 0.2
      : s.enter === "wipe" ? 0.25 + 0.9 + count * 0.07
      : s.enter === "flicker" ? 1.5 + 0.25
      : s.enter === "glitch" ? 0.25 + count * 0.07 + 0.6
      : s.enter === "outline" ? 0.25 + count * 0.055 + 1.4
      : s.enter === "pop" ? 0.25 + count * 0.06 + 0.5
      : 0.25 + count * 0.055;
    const enterEnd = lineAt + 1.1;
    const moveAt = enterEnd + Math.max(0, o.hold);
    const fontCqw = s.size * o.scale;
    const moveAnim = `${MOVE_DUR}s ${EASE} ${moveAt}s both`;
    const slide = o.place === "slide";
    const exitAt = (slide ? moveAt + MOVE_DUR : enterEnd) + Math.max(0, o.stay);

    const letterExit = (i, n) => {
      if (ex === "smoke") {
        const d = exitAt + rnd(i, 1) * 0.9;
        return { anim: `${P}x-smoke ${(2.0 + rnd(i, 2) * 0.8).toFixed(2)}s cubic-bezier(.3,.1,.3,1) ${d.toFixed(2)}s forwards`,
          vars: { "--dx": `${((rnd(i, 3) - 0.5) * 1.4).toFixed(2)}em`, "--dy": `${(0.9 + rnd(i, 4) * 1.6).toFixed(2)}em`, "--rot": `${((rnd(i, 5) - 0.5) * 40).toFixed(1)}deg` } };
      }
      if (ex === "dust") {
        const d = exitAt + rnd(i, 1) * 0.5;
        return { anim: `${P}x-dust ${(1.6 + rnd(i, 2) * 0.8).toFixed(2)}s cubic-bezier(.4,0,.8,.6) ${d.toFixed(2)}s forwards`,
          vars: { "--dx": `${((rnd(i, 3) - 0.5) * 3.2).toFixed(2)}em`, "--dy": `${(1.2 + rnd(i, 4) * 2.4).toFixed(2)}em`, "--rot": `${((rnd(i, 5) - 0.5) * 220).toFixed(0)}deg` } };
      }
      if (ex === "spread") {
        const mid = Math.max(1, (n - 1) / 2);
        return { anim: `${P}x-spread 1.8s cubic-bezier(.4,0,.8,.5) ${(exitAt + rnd(i, 1) * 0.3).toFixed(2)}s forwards`,
          vars: { "--dx": `${(((i - mid) / mid) * 1.1).toFixed(2)}em` } };
      }
      if (ex === "wave") return { anim: `${P}x-wave 1.3s ease-in ${(exitAt + i * 0.07).toFixed(2)}s forwards`, vars: {} };
      if (ex === "wind") {
        const d = exitAt + (i / Math.max(1, n)) * 0.9;
        return { anim: `${P}x-wind 1.5s cubic-bezier(.5,0,.9,.5) ${d.toFixed(2)}s forwards`,
          vars: { "--dx": `${(5 + rnd(i, 3) * 6).toFixed(1)}em`, "--dy": `${((rnd(i, 4) - 0.6) * 1.6).toFixed(2)}em` } };
      }
      return { anim: undefined, vars: {} };
    };
    const stagedExit = ex === "smoke" || ex === "dust" || ex === "wind" || ex === "spread" || ex === "wave";
    const INNER_EXIT = {
      blur: `${P}x-blur 2s ease-in`, blurzoom: `${P}x-bzoom 2.2s ease-in`, focus: `${P}x-focus 2s ease-in`, ghost: `${P}x-ghost 2.6s linear`,
    };
    const tailExit = ex === "none" ? undefined : `${P}x-fade 1.4s ease-in ${(exitAt + (stagedExit ? 0.2 : 0)).toFixed(2)}s forwards`;

    // ── korzeń
    root = el("div", "sr-title" + (isLite ? " rvt-lite" : ""));
    root.setAttribute("aria-label", o.text);
    root.setAttribute("data-reveal-title", "");
    root.style.visibility = "hidden";
    const goneAt = exitAt + Math.max(4, count * 0.07 + 1.5); // wave: ostatnia litera startuje po i·0,07 s + 1,3 s
    builtDuration = ex === "none" ? exitAt : goneAt;
    if (ex !== "none") root.style.animation = `${P}gone .01s linear ${goneAt.toFixed(2)}s forwards`;

    // ── filtr „rough” (stencil, chalk)
    let filterCss = s.filter;
    if (s.filter && s.filter.includes("rvt-rough")) {
      const id = `rvt-rough-${++roughSeq}`;
      filterCss = s.filter.replace("#rvt-rough", `#${id}`);
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("class", "rvt-defs"); svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = `<filter id="${id}" x="-50%" y="-200%" width="200%" height="500%">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4" result="n"></feTurbulence>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="2.4"></feDisplacementMap></filter>`;
      root.appendChild(svg);
    }

    // ── blok (pozycja tylko przez transform)
    const block = el("div", "rvt-block");
    block.style.transform = o.place === "bottom" ? "translate3d(0, calc(45cqh - 100%), 0)" : "translate3d(0,-50%,0) scale(1.22)";
    if (slide) {
      block.style.transform = "translate3d(0, calc(45cqh - 100%), 0)";
      block.style.animation = `${P}move ${moveAnim}`;
    }
    root.appendChild(block);

    // ── halo (tło za napisem)
    if (o.shade > 0) {
      const halo = el("div", "rvt-halo");
      halo.setAttribute("aria-hidden", "true");
      halo.style.inset = "-45% -14%";
      halo.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,${(0.5 * o.shade).toFixed(3)}), rgba(0,0,0,${(0.22 * o.shade).toFixed(3)}) 45%, transparent 72%)`;
      halo.style.animation = [`${P}fade 1.2s ease-out backwards`, ex !== "none" ? `${P}x-fade 1.8s ease-in ${(exitAt + 0.3).toFixed(2)}s forwards` : ""].filter(Boolean).join(", ");
      block.appendChild(halo);
    }

    const inner = el("div", "rvt-inner");
    if (INNER_EXIT[ex]) inner.style.animation = `${INNER_EXIT[ex]} ${exitAt.toFixed(2)}s forwards`;
    block.appendChild(inner);

    // ── tytuł
    const h2 = el("h2", "rvt-h2");
    h2.style.fontFamily = s.font;
    h2.style.fontWeight = String(s.weight);
    h2.style.fontSize = `max(10px, ${fontCqw.toFixed(2)}cqw)`;
    h2.style.letterSpacing = s.spacing;
    h2.style.textTransform = s.transform;
    h2.style.color = s.color;
    h2.style.textShadow = s.shadow ?? DEF_SHADOW;
    if (filterCss) h2.style.filter = filterCss;
    h2.style.fontStyle = s.italic ? "italic" : "normal";
    if (s.enter !== "outline" && s.stroke) h2.style.webkitTextStroke = s.stroke;
    if (s.enter === "wipe") h2.style.animation = `${P}wipe ${(0.9 + count * 0.07).toFixed(2)}s cubic-bezier(.4,.1,.3,1) 0.25s backwards`;
    inner.appendChild(h2);

    let off = 0;
    words.forEach((word, wi) => {
      const start = off;
      off += word.length + 1;
      const wspan = el("span", "rvt-word");
      word.forEach((ch, i) => {
        const idx = start + i;
        const le = letterExit(idx, count);
        const last = idx === count - 1;
        const flickAt = 0.25 + rnd(idx, 21) * 1.0;
        const enter = s.enter === "flicker"
          ? [`${P}flick ${(0.7 + rnd(idx, 22) * 0.5).toFixed(2)}s linear ${flickAt.toFixed(2)}s backwards`,
             rnd(idx, 23) > 0.7 ? `${P}hum ${(3 + rnd(idx, 24) * 3).toFixed(1)}s linear ${(flickAt + 1.6).toFixed(2)}s infinite` : ""].filter(Boolean).join(", ")
          : s.enter === "type" ? `${P}type .01s steps(1,end) ${(0.25 + idx * 0.09).toFixed(2)}s backwards`
          : s.enter === "wipe" ? ""
          : s.enter === "glitch"
            ? [`${P}glitch ${(0.5 + rnd(idx, 31) * 0.4).toFixed(2)}s linear ${(0.25 + idx * 0.07).toFixed(2)}s backwards`,
               rnd(idx, 32) > 0.55 ? `${P}gloop ${(3 + rnd(idx, 33) * 4).toFixed(1)}s linear ${(1.4 + idx * 0.07 + rnd(idx, 34)).toFixed(2)}s infinite` : ""].filter(Boolean).join(", ")
          : s.enter === "outline"
            ? `${P}letter 1s cubic-bezier(.22,.8,.24,1) ${0.25 + idx * 0.055}s backwards, ${P}fillin .9s ease-out ${(0.25 + count * 0.055 + 0.5).toFixed(2)}s both`
          : s.enter === "pop" ? `${P}pop .55s cubic-bezier(.3,1.5,.5,1) ${(0.25 + idx * 0.06).toFixed(2)}s backwards`
          : `${P}letter 1s cubic-bezier(.22,.8,.24,1) ${0.25 + idx * 0.055}s backwards`;
        const anim = [enter, le.anim].filter(Boolean).join(", ");
        const lspan = el("span", "rvt-letter");
        if (anim) lspan.style.animation = anim;
        if (s.gradient) {
          lspan.style.background = s.gradient;
          lspan.style.webkitBackgroundClip = "text";
          lspan.style.backgroundClip = "text";
          lspan.style.color = "transparent";
        } else if (s.enter === "outline") {
          lspan.style.setProperty("--fill", s.color);
          lspan.style.color = "transparent";
          lspan.style.webkitTextStroke = s.stroke;
        }
        for (const [k, v] of Object.entries(le.vars)) lspan.style.setProperty(k, v);
        lspan.appendChild(document.createTextNode(ch));
        if (s.enter === "type") {
          const cur = el("i", "rvt-cur");
          cur.setAttribute("aria-hidden", "true");
          cur.style.right = "-.12em"; cur.style.top = "8%"; cur.style.width = ".09em"; cur.style.height = "84%";
          cur.style.background = s.color; cur.style.opacity = "0";
          cur.style.animation = last
            ? [`${P}blink 1s steps(1) ${(0.25 + idx * 0.09).toFixed(2)}s infinite`, ex !== "none" ? `${P}x-fade .3s linear ${exitAt.toFixed(2)}s forwards` : ""].filter(Boolean).join(", ")
            : `${P}cpass .09s steps(1,end) ${(0.25 + idx * 0.09).toFixed(2)}s forwards`;
          lspan.appendChild(cur);
        }
        if (ex === "smoke") {
          for (const k of [0, 1]) {
            const puff = el("i", "rvt-puff");
            puff.setAttribute("aria-hidden", "true");
            puff.style.animation = `${P}puff ${(2.2 + rnd(idx, 8 + k) * 0.8).toFixed(2)}s ease-out ${(exitAt + rnd(idx, 1) * 0.9 + k * 0.15).toFixed(2)}s forwards`;
            puff.style.setProperty("--px", `${((rnd(idx, 10 + k) - 0.5) * 1.8).toFixed(2)}em`);
            puff.style.setProperty("--py", `${(1.2 + rnd(idx, 12 + k) * 2).toFixed(2)}em`);
            puff.style.setProperty("--ps", `${(2 + rnd(idx, 14 + k) * 1.8).toFixed(2)}`);
            lspan.appendChild(puff);
          }
        }
        wspan.appendChild(lspan);
      });
      if (wi < words.length - 1) {
        const gap = el("span", "rvt-gap");
        gap.setAttribute("aria-hidden", "true");
        wspan.appendChild(gap);
      }
      h2.appendChild(wspan);
    });

    // ── linia
    const line = el("div", "rvt-line");
    line.style.background = s.line;
    if (s.lineGlow) line.style.boxShadow = s.lineGlow;
    line.style.animation = [`${P}line 1.1s cubic-bezier(.22,.8,.24,1) ${lineAt}s backwards`, stagedExit ? tailExit : ""].filter(Boolean).join(", ");
    inner.appendChild(line);

    // ── podtytuł
    if (o.subtitle.trim()) {
      const p = el("p", "rvt-sub");
      p.style.opacity = "0.85";
      p.style.fontSize = `max(8px, ${(1.5 * o.scale).toFixed(2)}cqw)`;
      p.style.fontFamily = s.font;
      p.style.color = s.color;
      p.style.letterSpacing = ".38em";
      p.style.textShadow = "0 1px 10px rgba(0,0,0,.9)";
      p.style.animation = [`${P}sub 1.2s ease-out ${(lineAt + 0.25).toFixed(2)}s backwards`,
        stagedExit ? `${P}x-sub 1.6s ease-in ${(exitAt + 0.1).toFixed(2)}s forwards` : ""].filter(Boolean).join(", ");
      p.textContent = o.subtitle;
      inner.appendChild(p);
    }

    host.appendChild(root);
    fitArgs = { h2, box: root, fontCqw, place: o.place };
    fitWords(h2, root, fontCqw, o.place);
    needFit = !root.clientWidth; // host jeszcze bez układu → dopasuj przy pierwszym pokazaniu
    collect();
    if (!fontsHooked && document.fonts?.ready) {
      fontsHooked = true;
      document.fonts.ready.then(() => { if (!disposed && fitArgs && fitArgs.h2.isConnected) fitWords(fitArgs.h2, fitArgs.box, fitArgs.fontCqw, fitArgs.place); });
    }
  }

  /** Zbiera animacje CSS napisu i wstrzymuje je (czas ustawia `apply`). */
  function collect() {
    anims = [];
    if (!root || !root.isConnected) return;
    try {
      anims = root.getAnimations({ subtree: true });
      for (const a of anims) a.pause();
    } catch { anims = []; }
  }

  function apply(tSec) {
    if (!root) return;
    if (!anims.length || anims[0].playState === "idle") collect();
    const ms = tSec * 1000;
    for (const a of anims) {
      try { a.currentTime = ms; } catch { /* ignore */ }
    }
  }

  function update(progress, totalSeconds) {
    if (disposed) return;
    lastProgress = Number.isFinite(progress) ? progress : 0;
    lastTotal = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 10;
    if (!root) return;
    const on = o.enabled && !!o.text.trim() && lastProgress >= o.appearAt;
    if (!on) {
      if (shown) { apply(0); root.style.visibility = "hidden"; shown = false; lastT = null; }
      return;
    }
    if (!shown) {
      root.style.visibility = "";
      shown = true;
      if (needFit && fitArgs) { fitWords(fitArgs.h2, fitArgs.box, fitArgs.fontCqw, fitArgs.place); needFit = !root.clientWidth; }
      lastT = null;
    }
    const t = Math.max(0, (lastProgress - o.appearAt) * lastTotal);
    if (t === lastT) return;
    lastT = t;
    apply(t);
  }

  function setOpts(next) {
    if (disposed) return;
    const n = sanitizeTitle(next);
    const rebuild = !root || ["text", "subtitle", "style", "place", "exit", "hold", "stay", "shade", "scale"].some((k) => n[k] !== o[k]);
    o = n;
    if (rebuild) build();
    shown = false; lastT = null;
    update(lastProgress, lastTotal);
  }

  function setLite(v) {
    v = !!v;
    if (disposed || v === isLite) return;
    isLite = v;
    build();
    shown = false; lastT = null;
    update(lastProgress, lastTotal);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    teardown();
    releaseCss();
  }

  build();
  return { update, setOpts, setLite, dispose, duration: () => builtDuration };
}

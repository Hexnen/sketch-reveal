/* „Wirująca gazeta” — przejście sceny w stylu filmowej kroniki.
   To, co gracz właśnie widział na płótnie, staje się zdjęciem na pierwszej stronie gazety (raster, papier, winieta,
   nieczytelny tekst): kamera odjeżdża od zdjęcia i strona osiada na rozmytym tle starej sceny. Po wspólnym starcie strona
   unosi się, wiruje z przyspieszeniem i odlatuje w głąb, a spod niej wyłania się nowa mapa.
   Czysty DOM + Canvas 2D + Web Animations API — bez Foundry (tools/harness-newspaper.html importuje go wprost).

   Warstwy (od dołu): tło (stara scena rozmyta i przyciemniona) → cień strony → smugi (kopie strony opóźnione o kilka ms,
   widoczne tylko przy dużej prędkości kątowej = rozmycie ruchu) → strona (płótno 2D + czyste zdjęcie, które przenika się
   z rastrem). Wszystkie ruchy to transform/opacity (kompozytor), klatki kluczowe liczone z funkcji pozy (własne krzywe). */

export const NEWSPAPER_LIMITS = Object.freeze({ masthead: 40, headline: 90 });
export const DEFAULT_NEWSPAPER = Object.freeze({
  style: "classic", masthead: "Kurier Wieczorny", headline: "", paper: "#ebe3cf", accent: "#d0121b",
  spinSec: 2.4, turns: 3, direction: "cw", playerSkip: false,
});
/** Wygląd strony: dawny dziennik (raster, szeryfy, pożółkły papier) albo współczesny kolorowy tabloid. */
export const NEWSPAPER_STYLES = Object.freeze(["classic", "modern"]);
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
const line = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

/** Konfiguracja gazety z dowolnego wejścia (formularz, import, gniazdo) — zawsze poprawny obiekt. */
export function sanitizeNewspaper(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    style: NEWSPAPER_STYLES.includes(r.style) ? r.style : DEFAULT_NEWSPAPER.style,
    // pusta winieta = też udawane litery (klucz obecny, ale pusty); brak klucza = domyślna nazwa
    masthead: typeof r.masthead === "string" ? line(r.masthead, NEWSPAPER_LIMITS.masthead) : DEFAULT_NEWSPAPER.masthead,
    headline: line(r.headline, NEWSPAPER_LIMITS.headline),
    paper: typeof r.paper === "string" && HEX.test(r.paper) ? r.paper.toLowerCase() : DEFAULT_NEWSPAPER.paper,
    accent: typeof r.accent === "string" && HEX.test(r.accent) ? r.accent.toLowerCase() : DEFAULT_NEWSPAPER.accent,
    spinSec: Math.round(num(r.spinSec, DEFAULT_NEWSPAPER.spinSec, 1, 5) * 10) / 10,
    turns: Math.round(num(r.turns, DEFAULT_NEWSPAPER.turns, 1, 6)),
    direction: r.direction === "ccw" ? "ccw" : "cw",
    playerSkip: r.playerSkip === true,
  };
}

export function prefersReducedMotion() {
  try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/** Załaduj krój (regular + bold) zanim strona zostanie narysowana; po limicie czasu rysujemy krojem zastępczym. */
export async function ensurePaperFont(family, timeoutMs = 1500) {
  if (!family || !document.fonts?.load) return false;
  const want = [`400 20px "${family}"`, `700 20px "${family}"`];
  const ok = await Promise.race([Promise.all(want.map((f) => document.fonts.load(f))).then((r) => r.every((x) => x.length > 0)), sleep(timeoutMs).then(() => false)]);
  return !!ok;
}

/* ================================================================ losowość i „tekst” */
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
const CONS = "bcdfghjklmnprstwzbcdkmnprstlnrstwz", VOW = "aeiouyaeioaeo";
/** Słowo z losowych liter (naprzemiennie spółgłoski/samogłoski) — z daleka wygląda jak tekst, z bliska nic nie znaczy. */
function word(r, len = 2 + Math.min(10, Math.floor(-Math.log(1 - r()) * 3.2))) {
  let s = "", v = r() < 0.35;
  for (let i = 0; i < len; i++) {
    const pool = v ? VOW : CONS;
    s += pool[Math.floor(r() * pool.length)];
    if (r() < (v ? 0.8 : 0.72)) v = !v;
  }
  return s;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const words = (r, n, caps = false) => Array.from({ length: n }, () => (caps ? cap(word(r)) : word(r))).join(" ");

/* ================================================================ strona */
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const inkFor = (paper) => (lum(paper) > 0.2 ? "#1d1a16" : "#f0eadb");
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const serif = (fam) => `${fam ? `"${fam}", ` : ""}Georgia, "Times New Roman", serif`;

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
 * Narysuj pierwszą stronę. `W` — szerokość płótna (px), `photo` — zrzut widoku, `aspect` — proporcje zdjęcia (= ekranu).
 * Zwraca { canvas, photoRect } (photoRect w px płótna strony).
 */
export function paintPage({ W, photo, aspect, data, seed = 1, family = null, lite = false, cssScale = 1 }) {
  const r = mulberry(seed);
  const u = W / 1000, H = Math.round(W * 1.42);
  const c = mk(W, H), g = c.getContext("2d");
  const ink = inkFor(data.paper);
  const width = measurer(g);
  const F = (w, s, it = false) => `${it ? "italic " : ""}${w} ${s.toFixed(2)}px ${serif(family)}`;
  g.fillStyle = data.paper; g.fillRect(0, 0, W, H);
  g.fillStyle = ink; g.strokeStyle = ink; g.textBaseline = "alphabetic";
  const m = 48 * u, cw = W - 2 * m;
  const rule = (x, y, w, h) => g.fillRect(x, y, w, h);

  /** Kolumna justowanego tekstu od (x, y) do yEnd; zwraca y końca. */
  const column = (x, y, w, yEnd, { size = 10.6 * u, lead = 13.2 * u, drop = false, subs = true } = {}) => {
    let base = y + size, lineInPara = 0, paraLen = 3 + Math.floor(r() * 9), sinceSub = 0, dropLines = 0, dropW = 0;
    if (drop) {
      g.font = F(700, size * 3.25);
      const L = cap(word(r, 1)).toUpperCase();
      dropW = width(L) + 4 * u;
      g.fillText(L, x, y + size * 2.95);
      dropLines = 3;
    }
    g.font = F(400, size);
    const space = width(" ");
    while (base <= yEnd) {
      if (subs && sinceSub > 16 && lineInPara === 0 && r() < 0.18 && base + lead * 2.6 < yEnd) {
        // śródtytuł: wolna linia, pogrubione 1–2 słowa na środku
        g.font = F(700, size * 1.12);
        const t = words(r, 1 + Math.floor(r() * 2), true);
        g.textAlign = "center"; g.fillText(t, x + w / 2, base + lead * 0.55); g.textAlign = "left";
        g.font = F(400, size);
        base += lead * 1.9; sinceSub = 0;
        continue;
      }
      const indent = (dropLines > 0 ? dropW : 0) + (lineInPara === 0 && !drop ? size * 1.1 : 0);
      const avail = w - indent;
      const last = lineInPara === paraLen - 1;
      const target = last ? avail * (0.25 + r() * 0.6) : avail;
      const ws = []; let tw = 0;
      for (;;) {
        const wd = word(r), ww = width(wd);
        if (tw + ww + (ws.length ? space : 0) > target) { if (!ws.length) { ws.push(wd.slice(0, 3)); tw = width(ws[0]); } break; }
        tw += ww + (ws.length ? space : 0); ws.push(wd);
      }
      const gap = !last && ws.length > 1 ? (avail - (tw - space * (ws.length - 1))) / (ws.length - 1) : space;
      let cx = x + indent;
      for (const wd of ws) { g.fillText(wd, cx, base); cx += width(wd) + gap; }
      base += lead; sinceSub++;
      if (dropLines > 0) dropLines--;
      drop = false;
      if (++lineInPara >= paraLen) { lineInPara = 0; paraLen = 3 + Math.floor(r() * 9); }
    }
    return base - lead;
  };
  /** Kilka linii lewego wyrównania (podpis, nadtytuł) w szerokości w. */
  const lines = (x, y, w, n, size, font, lead = size * 1.25, align = "left") => {
    g.font = font; g.textAlign = align;
    for (let i = 0; i < n; i++) {
      const target = i === n - 1 ? w * (0.4 + r() * 0.45) : w * (0.9 + r() * 0.1);
      let t = word(r); while (width(`${t} x`) < target) { const nx = `${t} ${word(r)}`; if (width(nx) > w) break; t = nx; }
      g.fillText(i === 0 ? cap(t) : t, align === "center" ? x + w / 2 : align === "right" ? x + w : x, y + size + i * lead);
    }
    g.textAlign = "left";
    return y + n * lead;
  };

  /* ---- uszy (ramki obok winiety) */
  let y = 40 * u;
  const ear = (x) => {
    g.lineWidth = 1.4 * u; g.strokeRect(x, y, 150 * u, 74 * u);
    g.font = F(700, 15 * u); g.textAlign = "center"; g.fillText(cap(word(r, 6)), x + 75 * u, y + 24 * u);
    lines(x + 10 * u, y + 30 * u, 130 * u, 3, 8.6 * u, F(400, 8.6 * u), 11 * u, "center");
  };
  ear(m); ear(W - m - 150 * u);

  /* ---- winieta */
  const mast = data.masthead || `${cap(word(r, 5))} ${cap(word(r, 7))}`;
  let ms = 92 * u;
  g.font = F(700, ms);
  const mastMax = cw - 2 * 172 * u;
  while (width(mast) > mastMax && ms > 34 * u) { ms -= 2 * u; g.font = F(700, ms); }
  g.textAlign = "center"; g.fillText(mast, W / 2, y + 47 * u + ms * 0.36); g.textAlign = "left";
  y += 92 * u;
  rule(m, y, cw, 1.3 * u); y += 4.2 * u; rule(m, y, cw, 4 * u); y += 6 * u;
  // linia daty: trzy krótkie wpisy (lewa, środek, prawa) — też udawane
  g.font = F(400, 10.5 * u);
  const dl = y + 13 * u;
  g.fillText(words(r, 3, true), m, dl);
  g.textAlign = "center"; g.fillText(words(r, 4, true), W / 2, dl);
  g.textAlign = "right"; g.fillText(words(r, 2, true), W - m, dl); g.textAlign = "left";
  y += 19 * u; rule(m, y, cw, 1.3 * u); y += 16 * u;

  /* ---- nagłówek: tekst MG (do 2 linii, zmniejszany) albo udawany, rozciągnięty na całą szerokość */
  const wrap = (text, font, w) => {
    g.font = font;
    const out = []; let cur = "";
    for (const wd of text.split(" ")) {
      const nx = cur ? `${cur} ${wd}` : wd;
      if (cur && width(nx) > w) { out.push(cur); cur = wd; } else cur = nx;
    }
    if (cur) out.push(cur);
    return out;
  };
  let hs, hl;
  if (data.headline) {
    hs = 64 * u;
    hl = wrap(data.headline, F(700, hs), cw);
    while ((hl.length > 2 || hl.some((l) => width(l) > cw)) && hs > 30 * u) { hs -= 2 * u; hl = wrap(data.headline, F(700, hs), cw); }
    hl = hl.slice(0, 2);
  } else {
    hs = 60 * u;
    const ws = [cap(word(r, 4 + Math.floor(r() * 4))), cap(word(r, 3 + Math.floor(r() * 5))), cap(word(r, 5 + Math.floor(r() * 4)))];
    g.font = F(700, hs);
    hs = clamp((hs * cw * 0.95) / width(ws.join(" ")), 44 * u, 70 * u);
    g.font = F(700, hs);
    while (width(ws.join(" ")) > cw && ws.length > 1) ws.pop();
    hl = [ws.join(" ")];
  }
  g.font = F(700, hs); g.textAlign = "center";
  hl.forEach((l, i) => g.fillText(l, W / 2, y + hs * 0.8 + i * hs * 1.04));
  y += hs * 0.8 + (hl.length - 1) * hs * 1.04 + hs * 0.36;
  // podtytuł (kursywa)
  g.font = F(400, 21 * u, true);
  g.fillText(cap(words(r, 7 + Math.floor(r() * 3))), W / 2, y + 20 * u); g.textAlign = "left";
  y += 34 * u; rule(m, y, cw, 1.3 * u); y += 16 * u;

  /* ---- siatka łamu: 5 kolumn; zdjęcie na 4 kolumny, 5. kolumna z nadtytułem i tekstem */
  const cols = 5, gap = 18 * u, colW = (cw - gap * (cols - 1)) / cols;
  const colX = (i) => m + i * (colW + gap);
  let pw = 4 * colW + 3 * gap, ph = pw / aspect;
  const maxPh = 0.42 * W;
  if (ph > maxPh) { ph = maxPh; pw = ph * aspect; }
  const photoRect = { x: m, y, w: pw, h: ph };
  halftone(g, photo, photoRect, (lite ? 3.3 : 2.7) * cssScale, ink, data.paper);
  g.lineWidth = 1 * u; g.strokeRect(m, y, pw, ph);
  const bodyTop = y;
  // podpis pod zdjęciem + „fot.” wyrównane do prawej
  let yc = lines(m, y + ph + 5 * u, pw, 2, 11.2 * u, F(400, 11.2 * u, true), 14 * u);
  g.font = F(400, 8.4 * u); g.textAlign = "right"; g.fillText(words(r, 2).toUpperCase(), m + pw, yc + 11 * u); g.textAlign = "left";
  yc += 22 * u;
  const yLower = Math.round(H * 0.752);
  // 5. kolumna: nadtytuł + linia + tekst
  const k5 = colX(4);
  let y5 = lines(k5, bodyTop - 4 * u, colW, 3, 18.5 * u, F(700, 18.5 * u), 20 * u);
  y5 += 8 * u; rule(k5 + colW * 0.3, y5, colW * 0.4, 1 * u); y5 += 6 * u;
  column(k5, y5, colW, yLower - 14 * u);
  // kolumny 1–4 pod zdjęciem (pierwsza z inicjałem)
  for (let i = 0; i < 4; i++) column(colX(i), yc, colW, yLower - 14 * u, { drop: i === 0 });
  // linie między kolumnami
  g.globalAlpha = 0.55;
  for (let i = 1; i < cols; i++) {
    const x = colX(i) - gap / 2 - 0.35 * u;
    rule(x, i === 4 ? bodyTop : yc - 4 * u, 0.7 * u, (yLower - 10 * u) - (i === 4 ? bodyTop : yc - 4 * u));
  }
  g.globalAlpha = 1;

  /* ---- dół strony: drugi artykuł (kolumny 1–3) + ramka ogłoszenia (kolumny 4–5) */
  rule(m, yLower, cw, 1.3 * u); rule(m, yLower + 4 * u, cw, 1.3 * u);
  const yFoot = H - m - 6 * u;
  const w3 = 3 * colW + 2 * gap;
  let yl = lines(m, yLower + 12 * u, w3, 2, 31 * u, F(700, 31 * u), 33 * u);
  yl += 10 * u;
  for (let i = 0; i < 3; i++) column(colX(i), yl, colW, yFoot - 18 * u, { subs: false, drop: i === 0 });
  g.globalAlpha = 0.55;
  for (let i = 1; i < 3; i++) rule(colX(i) - gap / 2 - 0.35 * u, yl - 2 * u, 0.7 * u, yFoot - 20 * u - yl);
  g.globalAlpha = 1;
  // ogłoszenie: podwójna ramka, duże słowo, rysunek z kreskowania, drobny tekst, „cena”
  const ax = colX(3), aw = 2 * colW + gap, ay = yLower + 14 * u, ah = yFoot - 18 * u - ay;
  g.lineWidth = 2.4 * u; g.strokeRect(ax, ay, aw, ah);
  g.lineWidth = 0.8 * u; g.strokeRect(ax + 6 * u, ay + 6 * u, aw - 12 * u, ah - 12 * u);
  g.font = F(700, 30 * u); g.textAlign = "center";
  g.fillText(word(r, 7).toUpperCase(), ax + aw / 2, ay + 44 * u);
  const ccx = ax + aw / 2, ccy = ay + ah * 0.5, cr = Math.min(aw * 0.22, ah * 0.2);
  g.save(); g.beginPath(); g.arc(ccx, ccy, cr, 0, Math.PI * 2); g.clip();
  g.lineWidth = 1.1 * u;
  for (let k = -cr * 2; k < cr * 2; k += 4.2 * u) { g.beginPath(); g.moveTo(ccx + k - cr, ccy - cr); g.lineTo(ccx + k + cr, ccy + cr); g.stroke(); }
  g.restore();
  g.lineWidth = 1.6 * u; g.beginPath(); g.arc(ccx, ccy, cr, 0, Math.PI * 2); g.stroke();
  // blask (sierp w kolorze papieru) — kreskowana kula jak w drzeworycie reklamowym
  g.beginPath(); g.arc(ccx - cr * 0.28, ccy - cr * 0.3, cr * 0.42, Math.PI * 0.95, Math.PI * 1.75); g.lineWidth = 5 * u; g.strokeStyle = data.paper; g.stroke();
  g.strokeStyle = ink; g.lineWidth = 1 * u;
  lines(ax + 18 * u, ccy + cr + 10 * u, aw - 36 * u, 2, 10 * u, F(400, 10 * u, true), 13 * u, "center");
  g.font = F(700, 22 * u); g.textAlign = "center"; g.fillText(cap(word(r, 5)), ax + aw / 2, ay + ah - 18 * u); g.textAlign = "left";
  // stopka
  rule(m, yFoot - 6 * u, cw, 1 * u);
  g.font = F(400, 9 * u); g.fillText(words(r, 2, true), m, yFoot + 6 * u);
  g.textAlign = "right"; g.fillText(words(r, 3, true), W - m, yFoot + 6 * u); g.textAlign = "left";

  paperFinish(g, W, H, u, r, data.paper, lite);
  return { canvas: c, photoRect, H };
}

/**
 * Raster gazetowy: zdjęcie w skali szarości jako kropki farby na siatce obróconej o 45°, pole kropki ∝ zaczernienie.
 * `cell` — skok siatki w px płótna strony.
 */
/* ================================================================ strona współczesna (kolorowy dziennik / tabloid) */
const sans = (fam) => `${fam ? `"${fam}", ` : ""}"Segoe UI", "Helvetica Neue", Arial, sans-serif`;
const MODERN_PAPER = "#f6f5f1";
/** Kolor z alfą z #rrggbb. */
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

/**
 * Współczesna pierwsza strona w pełnym kolorze: blok winiety w kolorze akcentu z zajawkami (wycinki zrzutu), pasek działów,
 * etykieta „pilne” + wielki bezszeryfowy nagłówek, kolorowe zdjęcie na całą szerokość z belką podpisu, łam 3 kolumny
 * (tekst wyrównany do lewej, pogrubione wejście) + boczna kolumna z kolorowymi ramkami, rząd kart u dołu. Tekst udawany.
 */
function paintModern({ W, photo, aspect, data, seed = 1, family = null, sansFamily = null, lite = false }) {
  const r = mulberry(seed ^ 0x9e3779b9);
  const u = W / 1000, H = Math.round(W * 1.42);
  const c = mk(W, H), g = c.getContext("2d");
  const width = measurer(g);
  const acc = data.accent, ink = "#141414", paper = MODERN_PAPER;
  const S = (w, s) => `${w} ${s.toFixed(2)}px ${sans(sansFamily)}`;
  const SE = (w, s, it = false) => `${it ? "italic " : ""}${w} ${s.toFixed(2)}px ${serif(family)}`;
  g.fillStyle = paper; g.fillRect(0, 0, W, H);
  const m = 40 * u, cw = W - 2 * m;
  g.textBaseline = "alphabetic";

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
  /** Linie tekstu wyrównane do lewej (łam współczesny: bez justowania). */
  const rag = (x, y, w, yEnd, { size = 10.4 * u, lead = 13.6 * u, color = ink, lead_in = true } = {}) => {
    let base = y + size, first = lead_in;
    g.fillStyle = color;
    while (base <= yEnd) {
      const paraLines = 3 + Math.floor(r() * 6);
      for (let i = 0; i < paraLines && base <= yEnd; i++) {
        let cx = x;
        if (first) {
          // pogrubione wejście w tekst (2 słowa wersalikami)
          g.font = S(700, size);
          const t = `${word(r, 4).toUpperCase()} ${word(r, 5).toUpperCase()} `;
          g.fillText(t, cx, base); cx += width(t); first = false;
        }
        g.font = S(400, size);
        const target = i === paraLines - 1 ? w * (0.3 + r() * 0.5) : w * (0.82 + r() * 0.18);
        let t = "";
        for (;;) { const nx = t ? `${t} ${word(r)}` : word(r); if (cx - x + width(nx) > target) break; t = nx; }
        g.fillText(t, cx, base);
        base += lead;
      }
      base += lead * 0.45;
    }
    return base;
  };
  const lines = (x, y, w, n, font, lead, color = ink, align = "left") => {
    g.font = font; g.fillStyle = color; g.textAlign = align;
    for (let i = 0; i < n; i++) {
      const target = i === n - 1 ? w * (0.45 + r() * 0.4) : w * (0.88 + r() * 0.1);
      let t = cap(word(r));
      for (;;) { const nx = `${t} ${word(r)}`; if (width(nx) > target) break; t = nx; }
      g.fillText(t, align === "center" ? x + w / 2 : x, y + lead * (i + 0.8));
    }
    g.textAlign = "left";
    return y + n * lead;
  };

  /* ---- blok winiety: kolor akcentu, nazwa białą bezszeryfową, po prawej dwie zajawki z wycinkami zrzutu */
  let y = m * 0.8;
  const bandH = 128 * u;
  g.fillStyle = acc; g.fillRect(m, y, cw, bandH);
  const mast = data.masthead || `${cap(word(r, 5))} ${cap(word(r, 6))}`;
  const teaseW = 150 * u, teaseGap = 10 * u, teasers = W > 0 ? 2 : 0;
  const mastMax = cw - teasers * (teaseW + teaseGap) - 40 * u;
  let ms = 84 * u;
  g.font = S(700, ms);
  while (width(mast) > mastMax && ms > 30 * u) { ms -= 2 * u; g.font = S(700, ms); }
  g.fillStyle = "#ffffff";
  g.fillText(mast, m + 22 * u, y + bandH * 0.5 + ms * 0.34);
  g.font = S(600, 10.5 * u); g.fillStyle = "rgba(255,255,255,0.85)";
  g.fillText(words(r, 4, true).toUpperCase(), m + 24 * u, y + bandH - 14 * u);
  for (let i = 0; i < teasers; i++) {
    const tx = m + cw - (teasers - i) * (teaseW + teaseGap), ty = y + 12 * u, th = bandH - 24 * u;
    g.fillStyle = "rgba(255,255,255,0.14)"; g.fillRect(tx, ty, teaseW, th);
    photoIn(tx + 6 * u, ty + 6 * u, teaseW * 0.42, th - 12 * u, 0.2 + 0.6 * r(), 0.3 + 0.4 * r(), 2.4);
    lines(tx + teaseW * 0.42 + 12 * u, ty + 4 * u, teaseW * 0.55 - 16 * u, 3, S(700, 11 * u), 14 * u, "#ffffff");
  }
  y += bandH;
  // pasek działów (ciemny)
  g.fillStyle = "#1b1b1d"; g.fillRect(m, y, cw, 26 * u);
  g.font = S(600, 10.5 * u); g.fillStyle = "rgba(255,255,255,0.9)";
  let nx = m + 18 * u;
  for (let i = 0; i < 7; i++) { const t = word(r, 4 + Math.floor(r() * 4)).toUpperCase(); if (nx + width(t) > m + cw - 18 * u) break; g.fillText(t, nx, y + 17.5 * u); nx += width(t) + 26 * u; }
  y += 26 * u + 22 * u;

  /* ---- etykieta + nagłówek (MG albo udawany) */
  g.font = S(700, 13 * u);
  const kick = word(r, 5).toUpperCase(), kw = width(kick) + 20 * u;
  g.fillStyle = acc; g.fillRect(m, y, kw, 24 * u);
  g.fillStyle = "#ffffff"; g.fillText(kick, m + 10 * u, y + 17 * u);
  g.font = S(600, 13 * u); g.fillStyle = acc; g.fillText(cap(words(r, 3)), m + kw + 12 * u, y + 17 * u);
  y += 34 * u;
  let hs = 70 * u, hl;
  const wrap = (text, font, w) => {
    g.font = font; const out = []; let cur = "";
    for (const wd of text.split(" ")) { const n2 = cur ? `${cur} ${wd}` : wd; if (cur && width(n2) > w) { out.push(cur); cur = wd; } else cur = n2; }
    if (cur) out.push(cur); return out;
  };
  const htext = data.headline || `${cap(word(r, 6))} ${word(r, 3)} ${word(r, 7)} ${word(r, 4)} ${word(r, 6)}`;
  hl = wrap(htext, S(700, hs), cw);
  while ((hl.length > 2 || hl.some((l) => width(l) > cw)) && hs > 34 * u) { hs -= 2 * u; hl = wrap(htext, S(700, hs), cw); }
  hl = hl.slice(0, 2);
  g.font = S(700, hs); g.fillStyle = ink;
  hl.forEach((l, i) => g.fillText(l, m - 2 * u, y + hs * 0.84 + i * hs * 0.98));
  y += hs * 0.84 + (hl.length - 1) * hs * 0.98 + 16 * u;
  // lead (serif, szary) — współczesne dzienniki łączą bezszeryfowe tytuły z szeryfowym leadem
  y = lines(m, y, cw * 0.86, 2, SE(400, 17 * u), 22 * u, "#444") + 12 * u;

  /* ---- zdjęcie w kolorze na całą szerokość + belka podpisu */
  let pw = cw, ph = pw / aspect;
  const maxPh = 0.43 * W;
  if (ph > maxPh) { ph = maxPh; pw = ph * aspect; }
  const photoRect = { x: m + (cw - pw) / 2, y, w: pw, h: ph };
  if (pw < cw - 2 * u) {
    // węższe zdjęcie (wysoki ekran): pas na całą szerokość wypełniony rozmytą, przyciemnioną kopią — jak w portalach
    g.save(); g.beginPath(); g.rect(m, y, cw, ph); g.clip();
    g.filter = `blur(${(14 * u).toFixed(1)}px) brightness(0.55) saturate(1.2)`;
    g.drawImage(photo, m - 20 * u, y - 20 * u - (cw * photo.height / photo.width - ph) / 2, cw + 40 * u, (cw + 40 * u) * photo.height / photo.width);
    g.restore();
  }
  photoIn(photoRect.x, y, pw, ph);
  // belka podpisu w dolnej części zdjęcia (półprzezroczysta czerń, akcent z lewej)
  const capH = 30 * u;
  g.fillStyle = "rgba(10,10,12,0.62)"; g.fillRect(photoRect.x, y + ph - capH, pw, capH);
  g.fillStyle = acc; g.fillRect(photoRect.x, y + ph - capH, 6 * u, capH);
  g.font = S(400, 11.5 * u); g.fillStyle = "#ffffff";
  g.fillText(cap(words(r, 9)), photoRect.x + 16 * u, y + ph - capH / 2 + 4 * u);
  y += ph + 20 * u;

  /* ---- łam: 3 kolumny tekstu + boczna kolumna z ramkami */
  const railW = 0.28 * cw, gap = 20 * u;
  const colsW = cw - railW - gap, colW = (colsW - 2 * gap) / 3;
  const yCards = H - m - 190 * u;
  for (let i = 0; i < 3; i++) rag(m + i * (colW + gap), y, colW, yCards - 24 * u, { lead_in: i === 0 });
  g.fillStyle = "rgba(0,0,0,0.12)";
  for (let i = 1; i < 3; i++) g.fillRect(m + i * (colW + gap) - gap / 2, y, 1 * u, yCards - 24 * u - y);
  // boczna kolumna: ramka w kolorze akcentu (jasna) + żółta ramka „w liczbach”
  const rx = m + cw - railW;
  let ry = y;
  const box1H = (yCards - 24 * u - y) * 0.52;
  g.fillStyle = rgba(acc, 0.1); g.fillRect(rx, ry, railW, box1H);
  g.fillStyle = acc; g.fillRect(rx, ry, railW, 5 * u);
  let by = lines(rx + 14 * u, ry + 14 * u, railW - 28 * u, 3, S(700, 17 * u), 21 * u);
  rag(rx + 14 * u, by + 6 * u, railW - 28 * u, ry + box1H - 14 * u, { size: 9.8 * u, lead: 12.8 * u, lead_in: false });
  ry += box1H + 16 * u;
  const box2H = yCards - 24 * u - ry;
  if (box2H > 60 * u) {
    g.fillStyle = "#ffd23f"; g.fillRect(rx, ry, railW, box2H);
    g.font = S(700, 40 * u); g.fillStyle = ink;
    g.fillText(word(r, 3).toUpperCase(), rx + 14 * u, ry + 52 * u);
    lines(rx + 14 * u, ry + 62 * u, railW - 28 * u, Math.max(1, Math.min(4, Math.floor((box2H - 72 * u) / (15 * u)))), S(600, 11.5 * u), 15 * u);
  }

  /* ---- rząd kart u dołu: wycinek zrzutu + tytuł */
  g.fillStyle = ink; g.fillRect(m, yCards, cw, 3 * u);
  g.font = S(700, 12 * u); g.fillStyle = acc; g.fillText(word(r, 6).toUpperCase(), m, yCards + 22 * u);
  const cards = 3, cgap = 18 * u, cwid = (cw - cgap * (cards - 1)) / cards, cy = yCards + 34 * u, cimg = 82 * u;
  for (let i = 0; i < cards; i++) {
    const cx = m + i * (cwid + cgap);
    photoIn(cx, cy, cwid, cimg, 0.15 + 0.7 * r(), 0.2 + 0.6 * r(), 2 + r() * 1.5);
    lines(cx, cy + cimg + 4 * u, cwid, 2, S(700, 13 * u), 16 * u);
  }
  // stopka
  g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(m, H - m + 2 * u, cw, 1 * u);
  g.font = S(400, 9 * u); g.fillStyle = "#555";
  g.fillText(words(r, 3, true), m, H - m + 16 * u);
  g.textAlign = "right"; g.fillText(words(r, 2, true), W - m, H - m + 16 * u); g.textAlign = "left";

  paperFinish(g, W, H, u, r, paper, lite, false);
  return { canvas: c, photoRect, H };
}

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
export function createNewspaper({ host = document.body, photo, cover = null, crop = null, coverBg = "#000", data, reduced = prefersReducedMotion(), lite = false, safe = null, seed = (Math.random() * 2 ** 32) >>> 0, family = null, sansFamily = null } = {}) {
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
    if (family) await ensurePaperFont(family, 1200);
    if (modern && sansFamily) await ensurePaperFont(sansFamily, 1200);
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
      ? paintModern({ W, photo, aspect: photo.width / photo.height, data: d, seed, family, sansFamily, lite })
      : paintPage({ W, photo, aspect: photo.width / photo.height, data: d, seed, family, lite, cssScale: W / restW });
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

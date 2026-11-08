/* „Wirująca gazeta” — warstwa filmowa (ruch, światło, obiektyw). Strona i jej grafika powstają w newspaper.mjs; tu jest
   wszystko, co robi z przejścia ujęcie z filmu, a nie animację interfejsu:

   - światło studyjne: lampa z lewej u góry. Normalna strony liczona z tej samej pozy co transform (rotateZ·rotateX·rotateY),
     więc przy każdym obrocie strona ciemnieje, gdy odwraca się od lampy, i błyska odbiciem, gdy ją „łapie” (połysk papieru
     to miękka plama, która w przestrzeni ekranu zostaje przy lampie, a po stronie wędruje);
   - migawka: smugi = kopie strony wstępnie rozmyte (raz, przy budowie), opóźnione o stały ułamek czasu → łuk smugi rośnie
     z prędkością kątową jak przy migawce 180°;
   - przeostrzenie (rack focus): nowa mapa wyłania się nieostra i „wskakuje” w ostrość, gdy gazeta odlatuje (backdrop-filter
     na jednej warstwie, tylko w czasie odlotu; pomijane w trybie lite i bez wsparcia przeglądarki);
   - taśma: ziarno (płótno z szumem przesuwane skokowo 24 razy na sekundę — sam transform), winieta obiektywu, a w wyglądzie
     klasycznym lekkie migotanie projektora; wszystko gaśnie razem ze starą sceną, nowa mapa zostaje czysta;
   - kamera z ręki: przy czekaniu na wspólny start bardzo wolny najazd z oddechem (dryf ułamka procenta), przy odlocie stara
     scena w tle zawirowuje lekko w przeciwną stronę.

   Każdy ruch to transform / opacity / filtr tła na warstwie kompozytora; klatki liczone z funkcji pozy (te same w seek()).
   Ograniczony ruch nie używa niczego z tego pliku (spokojne przenikanie w newspaper.mjs). */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, t) => { const x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
const RAD = Math.PI / 180;
const ABS = "position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none;";
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
function prng(seed) {
  let a = (seed ^ 0x2545f491) >>> 0 || 1;
  return () => { a ^= a << 13; a >>>= 0; a ^= a >>> 17; a ^= a << 5; a >>>= 0; return a / 4294967296; };
}

/* ---------------------------------------------------------------- migawka (smugi ruchu) */
/** Opóźnienia smug (ułamek czasu odlotu) i krycie — gęsto i krótko: smuga ~100 ms przy 2,4 s, ciągła, nie „schodki”. */
export const SHUTTER = Object.freeze({ lag: Object.freeze([0.007, 0.014, 0.021, 0.028, 0.036]), alpha: Object.freeze([0.3, 0.23, 0.17, 0.11, 0.06]) });

/**
 * Kopie strony do smug: jedna zmniejszona i rozmyta (raz, przy budowie), pozostałe to jej kopie (drawImage). Rozmycie
 * ~0,6 % szerokości strony — na ekranie kilka px, czyli „rozmazany papier”, a nie druga, ostra strona.
 */
export function shutterGhosts(page, n = SHUTTER.lag.length) {
  const gw = Math.max(64, Math.round(page.width * 0.34)), gh = Math.max(64, Math.round((page.height * gw) / page.width));
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = mk(gw, gh), g = c.getContext("2d");
    if (i === 0) { g.filter = `blur(${(gw * 0.006).toFixed(2)}px)`; g.drawImage(page, 0, 0, gw, gh); g.filter = "none"; }
    else g.drawImage(out[0], 0, 0);
    out.push(c);
  }
  return out;
}

/* ---------------------------------------------------------------- światło studyjne */
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
/** Kierunek do lampy (CSS: x w prawo, y w dół, z do widza): z lewej u góry, z przodu. */
const LIGHT = norm([-0.45, -0.55, 0.7]);
const HALF = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
/** Normalna strony po transformacji rotateZ(rz) rotateX(rx) rotateY(ry) (kolejność jak w tf() w newspaper.mjs). */
function normal(p) {
  const th = (p.ry || 0) * RAD, ph = (p.rx || 0) * RAD, ps = (p.rz || 0) * RAD;
  const x = Math.sin(th), y = -Math.cos(th) * Math.sin(ph), z = Math.cos(th) * Math.cos(ph);
  return [x * Math.cos(ps) - y * Math.sin(ps), x * Math.sin(ps) + y * Math.cos(ps), z];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Oświetlenie strony w spoczynku (pochylenie 7°): punkt odniesienia — w spoczynku strona nie jest ani przyciemniona, ani rozjaśniona. */
const REST_NDL = dot(normal({ rx: 7 }), LIGHT);

/**
 * Stan światła dla pozy `p`: `shade` — przyciemnienie, gdy strona odwraca się od lampy; `sheen` — odbicie (plama w miejscu,
 * gdzie lampa odbija się w papierze: w przestrzeni ekranu blisko lampy, przesuwa się z pochyleniem; w układzie strony
 * obrócona o −rz, bo warstwa jest w środku obracanej strony). `k` — siła (0…1, np. narastanie w fazie formowania).
 */
export function lightState(p, { restW, restH, gloss = 0.7, k = 1 }) {
  const n = normal(p);
  const spec = smooth(0.935, 0.999, dot(n, HALF));
  const shade = clamp((REST_NDL - dot(n, LIGHT)) * 1.15, 0, 0.5);
  const size = Math.max(restW, restH);
  // miejsce odbicia na ekranie (px od środka strony), potem do układu strony
  const ox = LIGHT[0] * 0.34 * size - n[0] * 0.9 * size, oy = LIGHT[1] * 0.34 * size - n[1] * 0.9 * size;
  const a = -(p.rz || 0) * RAD, s = 1 / Math.max(0.2, Math.cos((p.rx || 0) * RAD));
  const lx = ox * Math.cos(a) - oy * Math.sin(a), ly = (ox * Math.sin(a) + oy * Math.cos(a)) * s;
  return {
    sheen: { transform: `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`, opacity: +(gloss * spec * k).toFixed(4) },
    shade: { opacity: +(shade * k).toFixed(4) },
  };
}

/**
 * Warstwy światła w środku strony: przyciemnienie i plama połysku, przycięte maską z kanału alfa strony (zagięty róg
 * i każdy inny kształt papieru, jaki narysuje malarz strony). Maska: mała kopia alfy (≤ 160 px) jako obraz.
 */
function lightLayers(page, { restW, restH, modern }) {
  const wrap = document.createElement("div");
  wrap.style.cssText = `${ABS}overflow:hidden;`;
  try {
    const mw = Math.min(160, page.width), mh = Math.max(1, Math.round((page.height * mw) / page.width));
    const m = mk(mw, mh);
    m.getContext("2d").drawImage(page, 0, 0, mw, mh);
    const url = m.toDataURL("image/png");
    wrap.style.maskImage = wrap.style.webkitMaskImage = `url("${url}")`;
    wrap.style.maskSize = wrap.style.webkitMaskSize = "100% 100%";
    wrap.style.maskRepeat = wrap.style.webkitMaskRepeat = "no-repeat";
  } catch { /* bez maski: światło w prostokącie strony (overflow) */ }
  const shade = document.createElement("div");
  shade.style.cssText = `${ABS}background:${modern ? "#0b0d12" : "#120c06"};opacity:0;will-change:opacity;`;
  const size = Math.max(restW, restH) * 1.15;
  // ciepła żarówka studyjna w dzienniku z lat 40., neutralna lampa we współczesnym
  const tint = modern ? "255,255,255" : "255,243,214";
  const sheen = document.createElement("div");
  sheen.style.cssText = `position:absolute;pointer-events:none;left:${((restW - size) / 2).toFixed(1)}px;top:${((restH - size) / 2).toFixed(1)}px;width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;`
    + `background:radial-gradient(circle at 50% 50%, rgba(${tint},0.62) 0%, rgba(${tint},0.30) 18%, rgba(${tint},0.08) 42%, rgba(${tint},0) 66%);opacity:0;will-change:transform,opacity;`;
  wrap.append(shade, sheen);
  return { wrap, shade, sheen };
}

/* ---------------------------------------------------------------- taśma i obiektyw */
const GRAIN_PAD = 96;
/** Płótno ziarna większe od ekranu o margines (skoki o kilkadziesiąt px nie odsłaniają krawędzi), w połowie rozdzielczości. */
function grainCanvas(VW, VH, r, strength) {
  const T = 128, tile = mk(T, T), tg = tile.getContext("2d"), id = tg.createImageData(T, T);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = r(), dark = v < 0.5, a = ((Math.abs(v - 0.5) * 2) ** 2.2) * strength;
    const c = dark ? 0 : 255;
    id.data[i] = c; id.data[i + 1] = c; id.data[i + 2] = c; id.data[i + 3] = Math.round(a * 255);
  }
  tg.putImageData(id, 0, 0);
  const cw = VW + 2 * GRAIN_PAD, ch = VH + 2 * GRAIN_PAD;
  const c = mk(cw / 2, ch / 2), g = c.getContext("2d");
  g.fillStyle = g.createPattern(tile, "repeat"); g.fillRect(0, 0, c.width, c.height);
  c.style.cssText = `position:absolute;display:block;pointer-events:none;left:${-GRAIN_PAD}px;top:${-GRAIN_PAD}px;width:${cw}px;height:${ch}px;will-change:transform;`;
  return c;
}

/**
 * Cały zestaw filmowy jednej gazety. Zwraca elementy (klucze do warstw animacji: film, focus, sheen, shade), smugi i
 * funkcje stanu dla faz press / spin oraz pętle (ziarno, migotanie) i kamerę z ręki dla czekania.
 */
export function cinema({ page, restW, restH, VW, VH, modern = false, lite = false, seed = 1 }) {
  const r = prng(seed);
  const light = lightLayers(page, { restW, restH, modern });
  const gloss = modern ? 0.55 : 0.7;

  const film = document.createElement("div");
  film.style.cssText = `${ABS}opacity:0;will-change:opacity;`;
  const vign = document.createElement("div");
  vign.style.cssText = `${ABS}background:radial-gradient(ellipse 75% 70% at 50% 48%, rgba(0,0,0,0) 55%, ${modern ? "rgba(0,0,0,0.34)" : "rgba(22,13,4,0.5)"} 100%);`;
  const grain = grainCanvas(VW, VH, r, modern ? 0.16 : 0.24);
  film.append(vign, grain);
  let flick = null;
  if (!modern && !lite) {
    flick = document.createElement("div");
    flick.style.cssText = `${ABS}background:#000;opacity:0;will-change:opacity;`;
    film.append(flick);
  }

  // przeostrzenie nowej mapy: filtr tła tylko tam, gdzie przeglądarka go ma (i nie w lite)
  let focus = null;
  try { if (!lite && globalThis.CSS?.supports?.("backdrop-filter", "blur(2px)")) { focus = document.createElement("div"); focus.style.cssText = `${ABS}`; } } catch { /* */ }
  const FOCUS_PX = Math.max(5, Math.min(14, Math.min(VW, VH) * 0.011));

  const ghosts = lite ? [] : shutterGhosts(page);
  const aspect = Math.max(VW / VH, VH / VW);

  /** Stan warstw filmowych w fazie formowania (t∈[0,1], `p` — poza strony). Pierwsza klatka = dokładnie zrzut ekranu. */
  const press = (t, p) => ({
    film: { opacity: smooth(0.08, 0.45, t) },
    ...lightState(p, { restW, restH, gloss, k: smooth(0.12, 0.42, t) }),
  });
  /** Stan w fazie odlotu: światło z pozy, taśma i nieostrość gasną, tło starej sceny zawirowuje w przeciwną stronę. */
  const spin = (t, p, dir) => {
    const s = 1 + 0.14 * smooth(0, 1, t);
    const rot = (-dir * (0.75 * (s - 1)) / aspect) / RAD;
    const f = {
      film: { opacity: 1 - smooth(0.42, 0.9, t) },
      backdrop: { transform: `scale(${s.toFixed(4)}) rotate(${rot.toFixed(3)}deg)` },
      ...lightState(p, { restW, restH, gloss, k: 1 - smooth(0.82, 0.97, t) }),
    };
    // promień nie schodzi poniżej 1,5 px (małe promienie = inna ścieżka rozmycia w Chromium, skok klatki przy przełączeniu);
    // resztę nieostrości zdejmuje przenikanie warstwy
    if (focus) f.focus = { backdropFilter: `blur(${(1.5 + (FOCUS_PX - 1.5) * (1 - smooth(0.3, 0.8, t))).toFixed(2)}px)`, opacity: 1 - smooth(0.72, 0.9, t) };
    return f;
  };

  /** Pętle taśmy (ziarno 24 kl./s, migotanie projektora) — `play(el, kf, opts)` z newspaper.mjs (rejestruje animację). */
  const loops = (play) => {
    if (lite) return;
    const N = 9, kf = [];
    for (let i = 0; i <= N; i++) {
      const j = i % N;
      const x = j ? Math.round((r() * 2 - 1) * GRAIN_PAD * 0.9) : 0, y = j ? Math.round((r() * 2 - 1) * GRAIN_PAD * 0.9) : 0;
      kf.push({ transform: `translate(${x}px, ${y}px)`, offset: i / N, easing: "step-end" });
    }
    play(grain, kf, { duration: (N * 1000) / 24, iterations: Infinity });
    if (flick) {
      const M = 29, fk = [];
      for (let i = 0; i <= M; i++) fk.push({ opacity: i % M ? +(0.012 + r() * 0.04 * (r() < 0.15 ? 1.8 : 1)).toFixed(3) : 0.02, offset: i / M, easing: "step-end" });
      play(flick, fk, { duration: (M * 1000) / 24, iterations: Infinity });
    }
  };

  /**
   * Kamera z ręki na czas czekania na wspólny start: bardzo wolny najazd (jak wcześniej, do 1,035) + oddech — dryf
   * o ułamek procenta i ledwie widoczny przechył (sumy wolnych sinusów, bez rytmu). Klatki dla elementu z całą stroną.
   */
  const handheld = (ms = 16000) => {
    const N = 80, out = [], A = Math.min(VW, VH) * 0.0022, ease = (x) => 1 - (1 - x) ** 4;
    const ph = [r() * 6.28, r() * 6.28, r() * 6.28];
    for (let i = 0; i <= N; i++) {
      const t = i / N, sec = (t * ms) / 1000, env = smooth(0, 0.08, t);
      const x = env * A * (Math.sin(sec * 0.83 + ph[0]) + 0.45 * Math.sin(sec * 2.1 + ph[1]));
      const y = env * A * (Math.sin(sec * 0.61 + ph[1]) + 0.4 * Math.sin(sec * 1.7 + ph[2]));
      const rz = env * 0.09 * Math.sin(sec * 0.47 + ph[2]);
      out.push({ transform: `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${(1 + 0.035 * ease(t)).toFixed(5)}) rotate(${rz.toFixed(3)}deg)`, offset: t });
    }
    return out;
  };

  /** Wepnij warstwy: światło do strony (nad czystym zdjęciem), nieostrość pod tłem starej sceny, taśma na wierzch. */
  const mount = (root, sheet, backdrop) => {
    sheet.append(light.wrap);
    if (focus) root.insertBefore(focus, backdrop.isConnected ? backdrop : root.firstChild);
    root.append(film);
  };

  return { els: { film, focus, sheen: light.sheen, shade: light.shade }, ghosts, press, spin, loops, handheld, mount };
}

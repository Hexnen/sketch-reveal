/**
 * KLASYCZNY detektor świateł (`detector: "legacy"`, domyślny) — ręcznie strojona heurystyka sprzed detektora
 * adaptacyjnego, przywrócona 1:1 (2026-10-22, glow.md „Wybór detektora”). Rdzeń bez DOM: piksele RGBA w
 * rozdzielczości analizy (≤ 768 px, kopię robi dyspozytor `analyzeLights` w analyze.ts).
 *
 * 1. Wynik „światła” s = ½Y + ½V + 0,35·sat·V minus 0,7 × lokalna średnia luminancji (box ~4,5% przekątnej).
 *    Maska bazowa s > t0.
 * 2. Klucz sceny (średnia Y, udział jasnych pikseli): scena dzienna/jasna dopuszcza tylko małe rdzenie V ≥ 0,97
 *    z wyraźnym spadkiem poświaty (+ tarcze).
 * 3. Tarcze (słońce/księżyc): okrągłe, prawie białe plamy w górnej części kadru, wyraźnie jaśniejsze od otoczenia
 *    — osobna klasa etykiet (nie zlewają się z niebem), rodzaj „okno” z flagą `disc`.
 * 4. Komponenty spójne + cechy (analyzeLegacyFeatures.ts). Komponent > maxCompFrac kadru (albo bbox szerszy niż
 *    maxCompBBox) → redukcja do rdzenia V ≥ coreV i drugi przebieg; rdzeń dalej za duży → odrzucony.
 *    Rdzeń dziedziczy barwę rodzica (białe litery z różową poświatą to nadal neon).
 * 5. Pewność „emiter”: neon wymaga nasyconego, jasnego rdzenia (c90, p95) i spadku poświaty; okno/latarnia
 *    ciepłe; skóra (barwa 340–35°, średnie nasycenie) i achromatyczne płaszczyzny odpadają. Łączna powierzchnia
 *    emiterów ≤ maxEmitFrac (nadmiar od najmniej pewnych).
 * 6. Oprawy, rodzaje, odbicia, oświetlone, tekstura — analyzeLegacyFixtures.ts (+ wnętrza: analyzeLegacyKinds.ts).
 * Progi: analyzeLegacyOpts.ts (stałe); wspólne suwaki/przełączniki z GlowDetectOptions.
 */
import { makeSlicer } from "./params";
import { legacyBoxBlur, labelAndMeasureLegacy, legacyRoundness, type LegacyPlanes, type LegacyRaw } from "./analyzeLegacyFeatures";
import { buildLegacyFixtures } from "./analyzeLegacyFixtures";
import { glowingCore, legacyEffective, legacySceneKey, skinLike, ss, type LegacyDetectOptions } from "./analyzeLegacyOpts";
import type { GlowDetectOptions, SceneKey } from "./analyzeOpts";
import { markLegacyInterior } from "./analyzeLegacyKinds";
import type { GlowAnalysis } from "./analyzeTypes";

const REF_DIAG = 1173; // przekątna 1024×572 — progi powierzchni/odległości strojone w tej skali

/** Klasyczna detekcja: `opts` = pełne (rozwiązane) opcje wspólne; progi klasyczne dokłada legacyEffective. */
export async function detectLegacyLights(px: Uint8ClampedArray, aw: number, ah: number, opts: GlowDetectOptions,
  t0 = performance.now()): Promise<GlowAnalysis> {
  const o: LegacyDetectOptions = legacyEffective(opts);
  const slice = makeSlicer(8);
  const N = aw * ah, diagA = Math.hypot(aw, ah), k = diagA / REF_DIAG;
  const V = new Float32Array(N), C = new Float32Array(N), Y = new Float32Array(N), S = new Float32Array(N), M = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = px[i * 4] / 255, gg = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    V[i] = mx; C[i] = mx - mn; M[i] = y; Y[i] = y;
    S[i] = 0.5 * y + 0.5 * mx + 0.35 * (mx > 0 ? (mx - mn) / mx : 0) * mx;
  }
  const scene = legacySceneKey(Y, o);
  await slice();
  const R = Math.max(2, Math.round(0.039 * diagA)); // dwa przebiegi box ≈ uniform_filter(46) ×2 w skali ref
  legacyBoxBlur(M, aw, ah, R >> 1);
  await slice();
  legacyBoxBlur(M, aw, ah, R >> 1);
  await slice();
  const P: LegacyPlanes = { V, C, Y, px, aw, ah };
  const cls = new Uint8Array(N);
  for (let i = 0; i < N; i++) cls[i] = S[i] - 0.7 * M[i] > o.t0 ? 1 : 0;

  if (o.discs) await addDiscs(cls, P, k, diagA, o, slice);

  // przebieg 1; za duży komponent → rdzeń V ≥ coreV; rdzeń nadal za duży albo średni i niepewny → rdzeń V ≥ 0,99;
  // na końcu za duże → odrzucone. Rdzeń dziedziczy barwę rodzica (białe litery z różową poświatą to nadal neon).
  let { lab, raws } = await labelAndMeasureLegacy(cls, P, k, slice);
  const tooBig = (r: LegacyRaw) => r.area > o.maxCompFrac * N || r.x1 - r.x0 + 1 > o.maxCompBBox * aw;
  for (const lvl of [o.coreV, 0.99]) {
    for (const rw of raws) scoreRaw(rw, k, N, scene, o);
    const big = raws.map((r) => r.cls === 1 && (tooBig(r) || (r.parent >= 0 && r.conf < 0.15 && r.area > 0.002 * N)));
    if (!big.some(Boolean)) break;
    const parentOf = new Int32Array(N).fill(-1), carryOf = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      const id = lab[i]; if (!id) continue;
      if (!big[id - 1]) carryOf[i] = id - 1;
      else if (V[i] >= lvl) parentOf[i] = id - 1; else cls[i] = 0;
    }
    const prev = raws;
    ({ lab, raws } = await labelAndMeasureLegacy(cls, P, k, slice));
    for (let i = 0; i < N; i++) {
      const id = lab[i]; if (!id || parentOf[i] < 0) continue;
      const rw = raws[id - 1]; if (rw.parent >= 0) continue;
      rw.parent = parentOf[i];
      const pr = prev[rw.parent];
      rw.note = "rdzeń"; rw.pskin = pr.pskin || skinLike(pr.hue, pr.sat);
      if (rw.c90 < 0.3 && pr.c90 > rw.c90 && !pr.white) { rw.c90 = pr.c90; rw.hue = pr.hue; rw.sat = pr.sat; rw.warm = pr.warm; }
    }
    // komponenty nieredukowane (te same piksele) zachowują dziedzictwo z wcześniejszego poziomu
    for (let i = 0; i < N; i++) {
      const id = lab[i]; if (!id || carryOf[i] < 0) continue;
      const rw = raws[id - 1], pr = prev[carryOf[i]]; if (rw.parent >= 0 || pr.parent < 0) continue;
      rw.parent = pr.parent; rw.pskin = pr.pskin; rw.note = pr.note;
      rw.c90 = Math.max(rw.c90, pr.c90); rw.hue = pr.hue; rw.sat = pr.sat; rw.warm = pr.white ? rw.warm : pr.warm;
    }
  }
  for (const rw of raws) if (rw.cls === 1 && tooBig(rw)) { rw.drop = true; rw.note = "rdzeń za duży"; }
  await slice();
  for (const rw of raws) scoreRaw(rw, k, N, scene, o);
  rescueSign(raws, k, N, diagA, scene, o);
  markLegacyInterior(raws, lab, P, k, diagA, scene, o);
  capTotal(raws, N, o);
  return buildLegacyFixtures(raws, lab, M, P, diagA, k, t0, slice, o, scene);
}

function scoreRaw(rw: LegacyRaw, k: number, N: number, scene: SceneKey, o: LegacyDetectOptions) {
  if (rw.drop) { rw.conf = 0; return; }
  if (rw.white) { rw.white = false; rw.warm = false; } // idempotentnie: „białe” ustawia ta funkcja, a nie pomiar
  // tarcza: w dzień słabsza (gain 0,4 + 0,6·conf) — słońce jest już przepalone, światło dałoby tylko szeroki bloom
  if (rw.cls === 2) { rw.conf = scene.day > 0.5 ? 0.3 : 1; rw.note = "tarcza"; return; }
  const area = ss(6 * k * k, 30 * k * k, rw.area);
  let conf: number;
  if (rw.warm) conf = ss(0.8, 0.95, rw.p95) * ss(o.warmC90[0], o.warmC90[1], rw.c90) * ss(o.warmFall[0], o.warmFall[1], rw.fall) * area;
  else conf = ss(o.neonP95[0], o.neonP95[1], rw.p95) * ss(o.neonC90[0], o.neonC90[1], rw.c90) * ss(o.neonFall[0], o.neonFall[1], rw.fall) * area;
  if (skinLike(rw.hue, rw.sat) && (rw.pskin || !glowingCore(rw.p95, rw.c90, rw.fall))) { conf *= 0.1; rw.note ||= "skóra"; }
  // scena dzienna: zostają tylko małe rdzenie V ≥ 0,97 z wyraźnym spadkiem poświaty
  const dayOk = ss(0.96, 0.99, rw.p95) * ss(1.5, 2.0, rw.fall) * (rw.area <= 0.004 * N ? 1 : 0);
  if (scene.day > 0) { const d = Math.min(conf, dayOk); conf = conf + (d - conf) * scene.day; if (scene.day > 0.5 && conf < 0.15) rw.note ||= "dzień"; }
  // białe światło nocą: mały, przepalony rdzeń (≥ 30% pikseli „białego żaru”) z wyraźnym spadkiem
  if (conf < 0.15 && scene.day < 0.5 && !rw.pskin && rw.p95 >= 0.97 && rw.coreSat >= (rw.area <= 0.002 * N ? 0.3 : 0.5) * rw.area && rw.area <= o.maxCompFrac * N) {
    const wc = ss(1.15, 1.4, rw.fall) * area;
    // ciepła poświata wokół białego żaru → latarnia/żarówka; chłodna/achromatyczna → okno (nigdy neon)
    if (wc > conf) { conf = wc; if (!rw.warm) { rw.warm = true; rw.white = true; } rw.note = "białe światło"; }
  }
  // W5: ciemniej namalowane okno nocą — ciepłe, małe, z bardzo wyraźnym spadkiem poświaty (≥ 1,6)
  if (conf < 0.15 && scene.day < 0.3 && rw.warm && !rw.pskin && rw.p95 >= 0.75 && rw.c90 >= 0.3 && rw.area <= 0.001 * N) {
    const dc = 0.45 * ss(1.55, 1.75, rw.fall) * area; // < 0,5: nie zostaje „rodzicem” odbić
    if (dc > conf) { conf = dc; rw.note = "ciemne okno"; }
  }
  // suwak „Czułość”: 1 → bez zmian; > 1 podnosi pewność (więcej komponentów przekracza progi 0,15/0,5)
  rw.conf = o.sensitivity === 1 ? conf : Math.min(1, conf * Math.pow(o.sensitivity, 1.5));
}

/** Litery szyldu: małe, słabsze komponenty nie-ciepłe obok pewnego neonu (≥ 0,5) — łagodne progi sprzed poprawek. */
function rescueSign(raws: LegacyRaw[], k: number, N: number, diagA: number, scene: SceneKey, o: LegacyDetectOptions) {
  if (scene.day > 0.5) return;
  const anchors = raws.filter((r) => r.cls === 1 && !r.drop && !r.warm && r.conf >= 0.5);
  if (!anchors.length) return;
  const gap = o.signGap * diagA;
  const near = (rw: LegacyRaw) => anchors.some((a) => Math.hypot(Math.max(0, Math.max(a.x0, rw.x0) - Math.min(a.x1, rw.x1)), Math.max(0, Math.max(a.y0, rw.y0) - Math.min(a.y1, rw.y1))) <= gap);
  for (const rw of raws) {
    // duże białe światło tuż przy neonie to przepalona litera tego szyldu (białe „V” obok różowego „S”);
    // małe białe (okna z TV obok szyldu) zostają oknami
    if (rw.white && rw.area > 0.002 * N && near(rw)) { rw.white = false; rw.warm = false; rw.note = "białe przy neonie"; continue; }
    if (rw.cls !== 1 || rw.drop || rw.warm || rw.conf >= 0.15 || rw.area > o.signMaxFrac * N || rw.coreSat >= 0.25 * rw.area) continue;
    if (!near(rw)) continue;
    // ≥ 0,15 → własna litera; 0,02–0,15 → słaby członek (rama) dołącza do najbliższej oprawy neonu
    const c = ss(0.8, 0.95, rw.p95) * ss(0.12, 0.3, rw.c90) * ss(1.0, 1.3, rw.fall) * ss(6 * k * k, 30 * k * k, rw.area);
    if (c > rw.conf && c >= 0.02) { rw.conf = c; rw.note = "szyld"; }
  }
}

/** Łączna powierzchnia emiterów ≤ maxEmitFrac kadru: nadmiar odpada od najmniej pewnych. LED poza limitem (≤ 64 ×
 *  0,008% kadru — z założenia drobne). */
function capTotal(raws: LegacyRaw[], N: number, o: LegacyDetectOptions) {
  const em = raws.filter((r) => r.cls === 1 && !r.drop && !r.led && r.conf >= 0.1).sort((a, b) => b.conf - a.conf || a.area - b.area);
  let acc = 0;
  for (const r of em) {
    acc += r.area;
    if (acc > o.maxEmitFrac * N) { r.drop = true; r.conf = 0; r.note = "limit łączny"; }
  }
}

/** Tarcze: prawie białe, okrągłe, w górnych 60% kadru, jaśniejsze od pierścienia wokół o ≥ 0,1 Y.
 *  Zaakceptowane dostają klasę 2; poświata wokół (do 1,7 promienia) przestaje być kandydatem (to poświata tarczy). */
async function addDiscs(cls: Uint8Array, P: LegacyPlanes, k: number, diagA: number, o: LegacyDetectOptions, slice: () => Promise<void>) {
  const { V, C, Y, aw, ah } = P, N = aw * ah;
  const dm = new Uint8Array(N);
  for (let i = 0; i < N; i++) dm[i] = Y[i] >= 0.86 && C[i] < 0.35 * V[i] ? 1 : 0;
  const { lab, raws } = await labelAndMeasureLegacy(dm, P, k, slice);
  const minA = Math.PI * (o.discMinR * diagA) ** 2;
  const ok = raws.map((r) => {
    if (r.area < minA || r.area > o.discMaxFrac * N) return false;
    const bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1, asp = bw / bh;
    if (asp < 0.75 || asp > 1.33) return false;
    const cx = r.sx / r.area, cy = r.sy / r.area;
    if (cy > 0.6 * ah || legacyRoundness(r) < o.discRound) return false;
    let s = 0, n = 0;
    for (let a = 0; a < 48; a++) for (const f of [1.35, 1.6, 1.85]) {
      const x = Math.round(cx + Math.cos(a * Math.PI / 24) * r.rmax * f), y = Math.round(cy + Math.sin(a * Math.PI / 24) * r.rmax * f);
      if (x >= 0 && y >= 0 && x < aw && y < ah) { s += Y[y * aw + x]; n++; }
    }
    return n > 0 && r.sY / r.area - s / n >= 0.1;
  });
  if (!ok.some(Boolean)) return;
  // maska tarczy = jej wnętrze (0,6 promienia): brzeg i namalowana poświata (do 1,7 promienia) wypadają z kandydatów
  for (let d = 0; d < raws.length; d++) {
    if (!ok[d]) continue;
    const r = raws[d], cx = r.sx / r.area, cy = r.sy / r.area, rr = r.rmax * 1.7;
    for (let y = Math.max(0, Math.floor(cy - rr)); y <= Math.min(ah - 1, Math.ceil(cy + rr)); y++)
      for (let x = Math.max(0, Math.floor(cx - rr)); x <= Math.min(aw - 1, Math.ceil(cx + rr)); x++) {
        const i = y * aw + x, dd = Math.hypot(x - cx, y - cy);
        if (dd > rr) continue;
        cls[i] = lab[i] === d + 1 && dd <= 0.6 * r.rmax ? 2 : 0;
      }
  }
}

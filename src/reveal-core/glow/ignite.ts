/**
 * Zapłon źródeł — czysta funkcja postępu p (bezstanowa, skrubowalna w obie strony).
 * Każda oprawa ma własne opóźnienie (kolejność: jasność + los z ziarna) i własną krzywą:
 *  - neon: kilka „stuknięć” jaśniej/ciemniej (czas w SEKUNDACH, więc ≥ 2 klatki), potem dojście do 1
 *    z drobnym brzęczeniem, które wygasa; litery mają przesunięcia, czasem jedna „spóźniona”,
 *  - okno: łagodne narastanie (żarówka za zasłoną),
 *  - latarnia: rozgrzewanie lampy sodowej — słaby czerwonawy żar, potem powolne dojście do pełni (cieplej na
 *    starcie: `warm` w tabeli), przy migotaniu dwa krótkie błyski startera,
 *  - oświetlone (stożek światła, kałuże): poziom rodzica × siła.
 * Przy p ≥ 1 każde źródło ma DOKŁADNIE 1 (stan końcowy stały), przy p ≤ 0 wszędzie 0.
 */
import { KIND_LAMP, KIND_LED, KIND_LIT, KIND_NEON, KIND_SCREEN, KIND_SKY, KIND_WINDOW, type GlowAnalysis } from "./analyze";
import { LIT_DELAY_S, lifeLevel, lifeSeed } from "./life";
import { rng, smoothstep as ss, type GlowParams } from "./params";

export const TABLE_SIZE = 256;
export const MAX_LAMPS = 4;

interface Tick { t0: number; w: number; l: number }
interface Member { off: number; ticks: Tick[]; settle: number }
/** big 0..1: duża oprawa (≥ BIG_AREA kadru) — bez stuknięć, gładki zapłon (bezpiecznik migotania, B3). */
interface FixPlan { delay: number; spanP: number; span: number; members: Member[]; big: number; bloomK: number }

export interface Plan { fix: FixPlan[]; key: string }

// neon, okno, latarnia, (oświetlone — nieużywane), ekran, LED, świetlik
const SPAN_S = [1.3, 1.1, 2.4, 1, 1.2, 1.2, 2.2];
/** Udział kadru, od którego oprawa traci stuknięcia (pełne przejście do gładkiego zapłonu przy BIG_AREA). */
const SMALL_AREA = 0.006, BIG_AREA = 0.02;
/** Powyżej tej powierzchni (udział kadru) energia bloomu oprawy jest stała (siła ∝ 1/powierzchnia, ≥ 0,1) —
 *  duże źródła nie zalewają kadru mgłą (VS: 2,5% kadru → 0,16). */
const BLOOM_AREA = 0.004;
/** Najmniejszy szyld (udział kadru), który daje odbicia w kałużach (BAR/HOTEL ≈ 0,09%). */
const REFL_AREA = 0.0004, REFL_MAX = 0.01;

/** Siła bloomu i rdzenia HDR wg rodzaju (neon, okno, latarnia, —, ekran, LED, świetlik). Ekran: rdzeń umiarkowany
 *  (treść ma zostać czytelna), świetlik: delikatny bloom, LED: mocny bloom małego punktu. */
const BLOOM_K = [2.6, 1.0, 1.4, 0.1, 1.3, 2.2, 0.6];
const CORE_K = [1.0, 0.55, 0.45, 0.45, 0.6, 1.2, 0.3];

const colorSat = (c: number[]) => { const mx = Math.max(...c); return mx > 0 ? 1 - Math.min(...c) / mx : 0; };

/** Udział kadru oprawy, „duża” 0..1 i współczynnik bloomu (powierzchnia; achromatyczny neon — mniej). */
function fixtureScale(an: GlowAnalysis, fi: number): { big: number; bloomK: number } {
  const f = an.fixtures[fi];
  const a = f.members.reduce((s, ci) => s + an.comps[ci].area, 0) / Math.max(1, an.aw * an.ah);
  const big = ss(SMALL_AREA, BIG_AREA, a);
  let bloomK = Math.max(0.1, Math.min(1, BLOOM_AREA / Math.max(a, 1e-9)));
  if (f.kind === KIND_NEON) {
    bloomK *= 0.55 + 0.45 * ss(0.12, 0.4, colorSat(f.color)); // białe/szare „neony” są już przepalone — energia nie idzie w mgłę
  }
  return { big, bloomK };
}

export function buildPlan(an: GlowAnalysis, p: GlowParams): Plan {
  const F = an.fixtures;
  const emitters = F.map((_, i) => i).filter((i) => F[i].kind !== KIND_LIT);
  const order = [...emitters].sort((a, b) => F[b].bright * F[b].conf - F[a].bright * F[a].conf);
  const rank = new Map<number, number>();
  order.forEach((f, i) => rank.set(f, order.length > 1 ? i / (order.length - 1) : 0));
  // kolejność = ½ jasność (najjaśniejsze pierwsze) + ½ los; potem równe rozłożenie po osi (ostatnie źródło startuje
  // na końcu rozrzutu — bez „martwej” połowy fazy przy kilku źródłach)
  const R0 = rng(p.seed * 31 + 5);
  const u0 = new Map<number, number>();
  for (const fi of emitters) u0.set(fi, 0.5 * R0() + 0.5 * (rank.get(fi) ?? 0));
  const byU = [...emitters].sort((a, b) => u0.get(a)! - u0.get(b)!);
  const uOf = new Map<number, number>();
  byU.forEach((fi, i) => uOf.set(fi, byU.length > 1 ? Math.max(0, Math.min(1, (i + 0.35 * (R0() - 0.5)) / (byU.length - 1))) : 0));
  const fix: FixPlan[] = F.map((f, fi) => {
    const R = rng(p.seed * 7919 + fi * 104729 + 13);
    const { big, bloomK } = fixtureScale(an, fi);
    const span = SPAN_S[f.kind];
    const spanP = Math.min(0.85, span / Math.max(0.5, p.duration));
    const u = uOf.get(fi) ?? 0;
    const delay = f.kind === KIND_LIT ? 0 : u * p.stagger * (1 - spanP);
    const members: Member[] = f.members.map((_, mi) => {
      const ticks: Tick[] = [];
      let off = 0, settle = 0;
      if (f.kind === KIND_NEON) {
        off = mi === 0 ? 0 : R() * 0.06;
        if (f.members.length >= 3 && mi === 1 + Math.floor(R() * (f.members.length - 1)) && R() < 0.5 * p.flicker + 0.15) off = 0.2;
        // ten sam ciąg losowań co bez bezpiecznika (bez zmian dla małych opraw); duże: bez stuknięć
        const n0 = Math.round(p.flicker * (1.5 + R() * 3.5)), n = big >= 1 ? 0 : n0;
        let t = 0.02 + R() * 0.06;
        for (let i = 0; i < n; i++) {
          const w = (0.035 + R() * 0.09) / span;
          ticks.push({ t0: t, w, l: 0.35 + R() * 0.85 });
          t += w + (0.04 + R() * 0.16) / span;
        }
        settle = Math.min(0.7, t);
        if (n && settle === 0.7) { const s = 0.7 / t; for (const k of ticks) { k.t0 *= s; k.w *= s; } }
      } else if (f.kind === KIND_SCREEN) {
        // włączanie ekranu: przemiatanie z góry na dół (panel po panelu, kawałki treści wg wysokości w obrysie),
        // krótki błysk zasilania (mały ekran, migotanie > 0), potem narastanie z migotaniem skanowania
        const b = f.box, cy = an.comps[f.members[mi]].cy;
        off = b ? 0.3 * Math.max(0, Math.min(1, (cy - b[1]) / Math.max(1e-3, b[3] - b[1]))) : 0;
        // błysk zasilania także dla dużych ekranów (pojedynczy, słabszy: 0,15–0,3 — nie seria błysków)
        if (p.flicker > 0.05) ticks.push({ t0: 0.02, w: 0.07 / span, l: (0.25 + 0.3 * p.flicker) * (1 - 0.45 * big) });
        settle = 0.14 + 0.05 * R();
      } else if (f.kind === KIND_LED) {
        // lampki szafy zapalają się po kolei (kaskada), część z krótkim „mrugnięciem” rozruchu
        off = 0.7 * R();
        if (R() < 0.4 * p.flicker) ticks.push({ t0: 0.01, w: 0.05 / span, l: 0.8 });
        settle = ticks.length ? 0.01 + 0.1 / span : 0;
      } else if (f.kind === KIND_LAMP && p.flicker > 0.05 && big < 1) {
        ticks.push({ t0: 0.02, w: 0.05 / span, l: 0.35 + 0.3 * p.flicker }, { t0: 0.02 + 0.12 / span, w: 0.04 / span, l: 0.25 + 0.3 * p.flicker });
      }
      return { off, ticks, settle };
    });
    return { delay, spanP, span, members, big, bloomK };
  });
  return { fix, key: "" };
}

function pulse(t: number, k: Tick): number {
  const e = Math.min(k.w / 3, 0.012);
  return k.l * ss(k.t0, k.t0 + e, t) * (1 - ss(k.t0 + k.w - e, k.t0 + k.w, t));
}

/** Poziom członka oprawy przy czasie lokalnym τ (0..1 w oknie zapłonu oprawy). */
function level(kind: number, tau: number, m: Member, flicker: number, span: number, big = 0): number {
  // ekran: własny bezpiecznik (płytkie zapady skanowania skalowane `big`), bez wygładzania niżej
  const v = levelRaw(kind, tau, m, kind === KIND_SCREEN ? flicker * (1 - 0.5 * big) : flicker, span);
  if (big <= 0 || tau <= 0 || tau >= 1 || kind === KIND_SCREEN) return v;
  // średnie oprawy: zapady stuknięć spłycone (dno = gładkie narastanie), im większa, tym płycej
  const smooth = ss(0, 1, tau);
  return v + (Math.max(v, smooth) - v) * big;
}

function levelRaw(kind: number, tau: number, m: Member, flicker: number, span: number): number {
  let t = m.off > 0 ? (tau - m.off) / (1 - m.off) : tau;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (kind === KIND_NEON) {
    if (!m.ticks.length) return ss(0, 0.3, t);
    let v = 0.05 * flicker * ss(0, 0.06, t); // żarzenie przed zapłonem
    for (const k of m.ticks) v = Math.max(v, pulse(t, k));
    if (t > m.settle) {
      const s = t - m.settle;
      let on = 1 - Math.exp(-s * 18);
      on += 0.07 * flicker * Math.sin(s * span * Math.PI * 2 * 9) * Math.exp(-s * 5); // brzęczenie, wygasa
      v = Math.max(v, on);
    }
    return v + (1 - v) * ss(0.9, 1, t);
  }
  if (kind === KIND_SCREEN) {
    let v = 0;
    for (const k of m.ticks) v = Math.max(v, pulse(t, k));
    // narastanie od „czerni ekranu” z migotaniem skanowania (7 Hz, ≤ 30%·flicker), które wygasa przed końcem
    const rise = ss(m.settle, 0.6, t), sc = 1 - 0.3 * flicker * (0.5 + 0.5 * Math.sin(t * span * Math.PI * 2 * 7)) * (1 - ss(0.4, 0.8, t));
    return Math.max(v, rise * sc) + (1 - Math.max(v, rise * sc)) * ss(0.9, 1, t);
  }
  if (kind === KIND_LED) {
    let v = 0;
    for (const k of m.ticks) v = Math.max(v, pulse(t, k));
    return Math.max(v, ss(m.settle, m.settle + 0.05, t));
  }
  if (kind === KIND_SKY) return ss(0, 1, t);
  if (kind === KIND_LAMP) {
    let v = 0.16 * ss(0, 0.08, t) + 0.84 * Math.pow(ss(0.12, 1, t), 1.3);
    for (const k of m.ticks) v = Math.max(v, pulse(t, k));
    return v;
  }
  // okno: łagodne narastanie
  const s = ss(0, 1, t);
  return s * s * (3 - 2 * s) * 0.6 + s * 0.4;
}

export interface Ignition {
  /** TABLE_SIZE × RGBA: poziom, siła bloomu, siła rdzenia HDR, ocieplenie. */
  table: Float32Array;
  /** Latarnie: [cx, cy, r, poziom] × MAX_LAMPS i barwy [r,g,b,ocieplenie] × MAX_LAMPS. */
  lamps: Float32Array; lampColors: Float32Array; nLamps: number;
  /** Odbicia neonów (kałuże pod szyldem): [cx, półszerokość, dół oprawy, poziom] i barwy [r,g,b,0] × MAX_LAMPS. */
  refl: Float32Array; reflColors: Float32Array; nRefl: number;
  /** Średni poziom zapłonu (ważony) — głębia cieni/„adaptacja oka”. */
  global: number;
}

/**
 * `idle` = sekundy od końca zapłonu (życie po zapłonie, life.ts). Działa tylko przy prog ≥ 1, `p.life` i
 * `p.lifeAmount > 0`; inaczej wynik jest identyczny jak bez tego argumentu.
 */
export function computeIgnition(
  an: GlowAnalysis, plan: Plan, p: GlowParams, prog: number, out?: Ignition, idle = 0,
  /** Bramka pokrycia per komponent 0..1 (miejsce jeszcze niepomalowane przez efekt koloru → 0); null = 1. */
  gate: Float32Array | null = null,
): Ignition {
  const ig: Ignition = out ?? { table: new Float32Array(TABLE_SIZE * 4), lamps: new Float32Array(MAX_LAMPS * 4),
    lampColors: new Float32Array(MAX_LAMPS * 4), nLamps: 0, global: 0,
    refl: new Float32Array(MAX_LAMPS * 4), reflColors: new Float32Array(MAX_LAMPS * 4), nRefl: 0 };
  ig.table.fill(0); ig.lamps.fill(0); ig.lampColors.fill(0); ig.refl.fill(0); ig.reflColors.fill(0);
  const F = an.fixtures, C = an.comps;
  const lead = new Float32Array(F.length);
  const live = prog >= 1 && idle > 0 && p.life && p.lifeAmount > 0;
  /** Poziom rodzica dla odbić i plam światła: przy życiu z lekkim opóźnieniem (w fazie ze źródłem). */
  const leadLit = live ? new Float32Array(F.length) : lead;
  let gs = 0, gw = 0, nl = 0;
  const lampIdx = F.map((_, i) => i).filter((i) => F[i].kind === KIND_LAMP).sort((a, b) => F[b].conf - F[a].conf).slice(0, MAX_LAMPS);
  // odbicia (kałuże pod szyldem) tylko dla barwnych neonów: dla białego/szarego „tej samej chromatyczności” jest
  // każda jasna powierzchnia pod nim (twarze, włosy — VS)
  // …i tylko dla szyldu (REFL_AREA..REFL_MAX kadru): odbicie iskry albo wielkiego napisu na pół kadru (VS) to fałsz
  const reflOk = (i: number) => {
    const a = F[i].members.reduce((s, ci) => s + C[ci].area, 0) / (an.aw * an.ah);
    // ekran: odbicie na podłodze pod panelem (barwny, ≤ 8% kadru)
    if (F[i].kind === KIND_SCREEN) return !!F[i].box && F[i].conf >= 0.4 && colorSat(F[i].color) >= 0.35 && a <= 0.08;
    return F[i].kind === KIND_NEON && F[i].conf >= 0.4 && colorSat(F[i].color) >= 0.5 && a >= REFL_AREA && a <= REFL_MAX;
  };
  const neonIdx = F.map((_, i) => i).filter(reflOk).sort((a, b) => F[b].conf - F[a].conf).slice(0, MAX_LAMPS);
  let nr = 0;
  for (let fi = 0; fi < F.length; fi++) {
    const f = F[fi]; if (f.kind === KIND_LIT) continue;
    const pl = plan.fix[fi];
    const tau = prog >= 1 ? 1 : (prog - pl.delay) / pl.spanP;
    const gain = 0.4 + 0.6 * f.conf;
    f.members.forEach((ci, mi) => {
      let lv = prog >= 1 ? 1 : prog <= 0 ? 0 : level(f.kind, tau, pl.members[mi], p.flicker, pl.span, pl.big);
      if (live) lv *= lifeLevel(f.kind, idle, lifeSeed(p.seed, fi), mi, f.members.length, p.lifeAmount, pl.big);
      if (gate) lv *= gate[ci] ?? 1;
      if (mi === 0) lead[fi] = lv;
      const g = 0.4 + 0.6 * C[ci].conf, o = ci * 4;
      ig.table[o] = lv;
      ig.table[o + 1] = BLOOM_K[f.kind] * g * pl.bloomK;
      // tarcza (słońce/księżyc): rdzeń ze znakiem minus = shader liczy maskę bez lokalnej średniej (tarcza na jasnym niebie)
      ig.table[o + 2] = CORE_K[f.kind] * g * (f.disc ? -1 : 1);
      // ocieplenie; −1 = „bez przepalenia i bez ocieplenia” (ekran, świetlik: treść/barwa zostaje, przyrost miękko ściśnięty)
      ig.table[o + 3] = f.kind === KIND_NEON || f.kind === KIND_LED ? 0 : f.kind === KIND_SCREEN || f.kind === KIND_SKY ? -1
        : p.warmth + (f.kind === KIND_LAMP ? (1 - lv) * 1.1 : 0);
    });
    if (live) leadLit[fi] = lifeLevel(f.kind, idle - LIT_DELAY_S, lifeSeed(p.seed, fi), 0, f.members.length, p.lifeAmount, pl.big)
      * (gate ? gate[f.members[0]] ?? 1 : 1);
    const w = f.conf * Math.sqrt(f.members.reduce((s, ci) => s + C[ci].area, 0));
    gs += lead[fi] * w; gw += w;
    const ni = neonIdx.indexOf(fi);
    if (ni >= 0) {
      const b = f.box;
      ig.refl.set(b ? [(b[0] + b[2]) / 2, Math.max((b[2] - b[0]) / 2, 0.02), b[3], leadLit[fi] * gain * 0.6]
        : [f.cx, Math.max(f.r * an.ah / an.aw, 0.02), f.cy + f.r, leadLit[fi] * gain], nr * 4);
      ig.reflColors.set([f.color[0], f.color[1], f.color[2], 0], nr * 4);
      nr++;
    }
    const li = lampIdx.indexOf(fi);
    if (li >= 0) {
      ig.lamps.set([f.cx, f.cy, f.r, lead[fi] * gain], nl * 4);
      ig.lampColors.set([f.color[0], f.color[1], f.color[2], p.warmth + (1 - lead[fi]) * 1.1], nl * 4);
      nl++;
    }
  }
  for (let fi = 0; fi < F.length; fi++) {
    const f = F[fi]; if (f.kind !== KIND_LIT || f.parent < 0) continue;
    const lv = leadLit[f.parent] * f.gain;
    for (const ci of f.members) {
      const o = ci * 4;
      ig.table[o] = gate ? lv * (gate[ci] ?? 1) : lv; ig.table[o + 1] = 0.1; ig.table[o + 2] = 0.45;
      ig.table[o + 3] = F[f.parent].kind === KIND_WINDOW || F[f.parent].kind === KIND_LAMP ? p.warmth : 0;
    }
  }
  ig.nLamps = nl; ig.nRefl = nr;
  ig.global = gw > 0 ? gs / gw : 0;
  return ig;
}

export { KIND_LAMP, KIND_LED, KIND_LIT, KIND_NEON, KIND_SCREEN, KIND_SKY, KIND_WINDOW };

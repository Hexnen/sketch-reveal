/**
 * Wspólny „sterownik papieru” (paper driver) — JEDNO źródło prawdy dla koloru i faktury papieru we wszystkich
 * efektach koloru i w fazie szkicu. Raport, pomiary i formuły: docs/reveal-effects/paper-audit.md.
 *
 * Model (piksel obrazu `px` = uv · rozmiar obrazu, ten sam układ w każdym efekcie i w fazie szkicu):
 *   h(px)  = wysokość papieru cold-press 0..1 (grudki fbm + włókna), średnio ≈ 0,5 — paperHeight()
 *   M(px)  = 1 + amp · (h − 0,5),  amp = paperTexture · PAPER_GRAIN_GAIN   (mnożnik o średniej ≈ 1)
 *   papier pod szkicem  = tint · M                              (od p=0 do zakrycia farbą)
 *   „Przedłuż na całość” WYŁ.: wynik = mix(szkic·tint·M, farba, pokrycie) → p=1 = painted bajt w bajt
 *   „Przedłuż na całość” WŁ.:  wynik = mix(szkic·tint,   farba, pokrycie) · M → p=1 = painted · M
 * W obu trybach klatka p=0 = szkic · tint · M (ten sam szew z fazą szkicu). Papier WYŁ.: tint = biały, amp = 0
 * (czysty oryginał szkicu, jak „Szkic na białym”). Ziarno nie zależy od ziarna efektu (stały seed papieru) —
 * identyczne we wszystkich efektach. Koszt: efekty czytają wysokość z tekstury liczonej raz (createPaperTexture,
 * PAPER_TEX_GLSL) — 1 odczyt/piksel; faza szkicu liczy szum analitycznie (PAPER_GLSL, ~6 value-noise/piksel).
 */
import type { EffectParams, EffectParamValue, ParamSpec } from "./types";

export interface PaperParams {
  /** Papier wł./wył. (wył. = czysta biel, oryginał szkicu bez tintu i ziarna). */
  paper: boolean;
  /** Kolor papieru (#rrggbb) — mnoży szkic (biel szkicu → ten kolor). */
  paperColor: string;
  /** Faktura (siła ziarna) 0..1. */
  paperTexture: number;
  /** Skala ziarna w px obrazu (rozmiar grudki). */
  paperScale: number;
  /** Przedłuż fakturę na całość: ziarno także na farbie i na gotowym obrazie (p=1 = painted · M). */
  paperExtend: boolean;
}

/** Domyślny papier: biały (#fdfdfd, jak próbka szkicu); kremowy #f6f1e6 jest presetem. */
export const PAPER_DEFAULTS: PaperParams = {
  paper: true,
  paperColor: "#fdfdfd",
  paperTexture: 0.5,
  paperScale: 3,
  paperExtend: false,
};

export const PAPER_KEYS = Object.keys(PAPER_DEFAULTS) as (keyof PaperParams)[];

/** amp przy paperTexture = 1 (σ(M) ≈ 1,6 % przy 0,5 — jak dotychczasowe ziarno `spread`). */
export const PAPER_GRAIN_GAIN = 0.3;

export const PAPER_PARAM_SPECS: ParamSpec[] = [
  { key: "paperTexture", label: "Faktura papieru", min: 0, max: 1, step: 0.05, hint: "Siła ziarna papieru (0 = gładki)" },
  { key: "paperScale", label: "Skala ziarna (px)", min: 1, max: 10, step: 0.5, hint: "Rozmiar grudki papieru w pikselach obrazu" },
];

export const PAPER_COLORS: { label: string; value: string }[] = [
  { label: "kremowy", value: "#f6f1e6" },
  { label: "biały (jak próbka szkicu)", value: "#fdfdfd" },
  { label: "kość słoniowa", value: "#f8f2dc" },
  { label: "szary", value: "#ebebe8" },
  { label: "pergamin", value: "#efe2c4" },
];

const HEX = /^#?([0-9a-f]{6})$/i;

export function parsePaperColor(s: string): [number, number, number] {
  const m = HEX.exec(s.trim());
  if (!m) return parsePaperColor(PAPER_DEFAULTS.paperColor);
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function bool(v: EffectParamValue | undefined): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1) return true;
  if (v === "false" || v === 0) return false;
  return undefined;
}

/** Częściowa aktualizacja (brakujące / złe klucze zostają). */
export function mergePaper(base: PaperParams, p: Partial<EffectParams> | Partial<PaperParams>): PaperParams {
  const q = p as Partial<EffectParams>;
  const out = { ...base };
  const on = bool(q.paper), ext = bool(q.paperExtend);
  if (on !== undefined) out.paper = on;
  if (ext !== undefined) out.paperExtend = ext;
  if (typeof q.paperColor === "string" && HEX.test(q.paperColor.trim())) out.paperColor = q.paperColor.trim().toLowerCase();
  const t = Number(q.paperTexture);
  if (q.paperTexture !== undefined && Number.isFinite(t)) out.paperTexture = Math.max(0, Math.min(1, t));
  const s = Number(q.paperScale);
  if (q.paperScale !== undefined && Number.isFinite(s)) out.paperScale = Math.max(0.5, Math.min(20, s));
  return out;
}

/** Klucz zmian (dirty-check renderów). */
export function paperKey(p: PaperParams): string {
  return PAPER_KEYS.map((k) => p[k]).join("|");
}

/** Wartości uniformów (CPU) — te same dla każdego efektu. */
export function paperUniformValues(p: PaperParams) {
  const on = p.paper;
  return {
    tint: on ? parsePaperColor(p.paperColor) : ([1, 1, 1] as [number, number, number]),
    amp: on ? p.paperTexture * PAPER_GRAIN_GAIN : 0,
    scale: Math.max(0.5, p.paperScale),
    ext: on && p.paperExtend ? 1 : 0,
  };
}

const PAPER_UNIFORMS = /* glsl */ `
uniform vec3 u_ppTint;
uniform float u_ppAmp;
uniform float u_ppScale;
uniform float u_ppExt;
`;

/** Szum papieru (prefiks pp_ — bez kolizji z szumem efektów); wymaga uniformu u_ppScale. */
export const PAPER_NOISE_GLSL = /* glsl */ `
float pp_hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + 0.4142);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float pp_vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(pp_hash(i), pp_hash(i + vec2(1, 0)), w.x), mix(pp_hash(i + vec2(0, 1)), pp_hash(i + vec2(1, 1)), w.x), w.y);
}
// Papier cold-press: grudki (fbm) + włókna. 0..1, niżej = dolina.
float paperHeight(vec2 px) {
  vec2 q = px / max(u_ppScale, 0.5);
  vec2 r = q * 0.45;
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * pp_vnoise(r); r = mat2(1.6, 1.2, -1.2, 1.6) * r + 7.1; a *= 0.5; }
  float b = s / 0.9375 * 0.55 + pp_vnoise(q * 1.7) * 0.3;
  return b + pp_vnoise(vec2(q.x * 0.25 + q.y * 0.08, q.y * 2.6) + 17.0) * 0.15;
}
`;

const PAPER_MIX = /* glsl */ `
float paperMod(vec2 px) { return u_ppAmp > 0.0 ? 1.0 + u_ppAmp * (paperHeightAt(px) - 0.5) : 1.0; }
vec3 paperUnder(float M) { return u_ppTint * mix(M, 1.0, u_ppExt); }
vec3 paperOver(vec3 c, float M) { return c * mix(1.0, M, u_ppExt); }
`;

/**
 * GLSL ES 3.00 — wariant ANALITYCZNY (szum liczony w każdym pikselu; faza szkicu, płótno w rozdzielczości
 * wyświetlania). Uniformy: u_ppTint, u_ppAmp, u_ppScale, u_ppExt. Funkcje: paperHeight(px) 0..1,
 * paperMod(px) = M, paperUnder(M) = papier pod szkicem, paperOver(c, M) = przebieg końcowy.
 */
export const PAPER_GLSL = PAPER_UNIFORMS + PAPER_NOISE_GLSL + /* glsl */ `
float paperHeightAt(vec2 px) { return paperHeight(px); }
` + PAPER_MIX;

/**
 * Wariant TEKSTUROWY (efekty): wysokość papieru liczona RAZ na (rozmiar obrazu, skala) do tekstury
 * `u_ppTex` (createPaperTexture) — w klatce jeden odczyt zamiast ~6 value-noise. Te same funkcje co PAPER_GLSL;
 * px w środkach tekseli = dokładnie wartość analityczna (16 bit: hi/lo w RG, liniowo interpolowalne).
 */
export const PAPER_TEX_GLSL = PAPER_UNIFORMS + /* glsl */ `
uniform sampler2D u_ppTex;
float paperHeightAt(vec2 px) {
  vec2 hl = texture(u_ppTex, px / vec2(textureSize(u_ppTex, 0))).rg;
  return hl.r + hl.g / 255.0;
}
` + PAPER_MIX;

const PAPER_TEX_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform float u_ppScale;
out vec4 o;
${PAPER_NOISE_GLSL}
void main() {
  // wiersz 0 tekstury ↔ px.y ∈ [0,1) obrazu (ta sama konwencja co uv·rozmiar w efektach)
  float h = clamp(paperHeight(gl_FragCoord.xy), 0.0, 1.0) * 255.0;
  float hi = floor(h);
  o = vec4(hi / 255.0, h - hi, 0.0, 1.0);
}`;

const FULL_VERT = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Tekstura wysokości papieru dla PAPER_TEX_GLSL. `ensure(w, h, p)` przelicza tylko przy zmianie rozmiaru obrazu
 * lub skali ziarna (kolor, faktura, przedłuż = same uniformy). UWAGA: zmienia stan GL (FBO → null, program, VAO,
 * viewport, wiązanie TEXTURE_2D aktywnej jednostki) — wołać na początku klatki, przed wiązaniem tekstur efektu.
 */
export function createPaperTexture(gl: WebGL2RenderingContext) {
  const sh = (type: number, src: string) => {
    const x = gl.createShader(type)!;
    gl.shaderSource(x, src);
    gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(`paper: ${gl.getShaderInfoLog(x)}`);
    return x;
  };
  const prog = gl.createProgram()!;
  const vs = sh(gl.VERTEX_SHADER, FULL_VERT), fs = sh(gl.FRAGMENT_SHADER, PAPER_TEX_FRAG);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`paper: ${gl.getProgramInfoLog(prog)}`);
  const uScale = gl.getUniformLocation(prog, "u_ppScale");
  const tex = gl.createTexture()!;
  const fbo = gl.createFramebuffer()!;
  const vao = gl.createVertexArray();
  let key = "";
  // E2: po utracie kontekstu tekstura jest martwa — następne ensure() liczy od nowa (zamiast „gotowe” na trupie)
  const onLost = () => { key = ""; };
  gl.canvas.addEventListener("webglcontextlost", onLost);
  return {
    tex,
    /** true, gdy tekstura gotowa (papier z fakturą); false = faktura 0 / papier wył. (shader nie czyta tekstury). */
    ensure(w: number, h: number, p: PaperParams): boolean {
      if (!p.paper || p.paperTexture <= 0 || w < 1 || h < 1) return false;
      const k = `${w}x${h}|${Math.max(0.5, p.paperScale)}`;
      if (k === key) return true;
      key = k;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // RG8 (shader czyta tylko .rg): −2 B/px względem RGBA8, te same wartości unorm8 → klatki bajt w bajt
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog);
      gl.uniform1f(uScale, Math.max(0.5, p.paperScale));
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return true;
    },
    dispose() {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      gl.deleteProgram(prog);
      gl.deleteVertexArray(vao);
      gl.canvas.removeEventListener("webglcontextlost", onLost);
      key = "";
    },
  };
}

/** Jednostka „pustej” tekstury papieru: sampler u_ppTex musi wskazywać teksturę float/unorm także wtedy, gdy shader
 * jej nie czyta (WebGL waliduje typy wszystkich samplerów programu przy draw) — bez tego przy papierze wył. / fakturze 0
 * u_ppTex = jednostka 0, a tam bywa tekstura całkowitoliczbowa (watercolor: RGBA32UI) → GL_INVALID_OPERATION. */
const PAPER_DUMMY_UNIT = 15;
const dummies = new WeakMap<WebGL2RenderingContext, WebGLTexture>();
const hooked = new WeakSet<WebGL2RenderingContext>();
/** Bez `gl.isTexture()` w klatce (synchroniczny round-trip do procesu GPU — K3 w combined-perf.md): ważność
 * śledzimy zdarzeniem — po `webglcontextrestored` ten sam obiekt `gl` ma nowe zasoby, więc tworzymy teksturę od nowa. */
function dummyTex(gl: WebGL2RenderingContext): WebGLTexture {
  let t = dummies.get(gl);
  if (t) return t;
  if (!hooked.has(gl)) {
    hooked.add(gl);
    // także przy utracie: odbudowa instancji (effects/guard.ts) może rysować w handlerze restored PRZED tym słuchaczem
    gl.canvas.addEventListener("webglcontextlost", () => dummies.delete(gl));
    gl.canvas.addEventListener("webglcontextrestored", () => dummies.delete(gl));
  }
  t = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0 + PAPER_DUMMY_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 0, 0, 255]));
  dummies.set(gl, t);
  return t;
}

/** Lokalizacje uniformów papieru w programie + ustawianie z PaperParams. */
export function paperUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram) {
  const L = {
    tint: gl.getUniformLocation(prog, "u_ppTint"), amp: gl.getUniformLocation(prog, "u_ppAmp"),
    scale: gl.getUniformLocation(prog, "u_ppScale"), ext: gl.getUniformLocation(prog, "u_ppExt"),
    tex: gl.getUniformLocation(prog, "u_ppTex"),
  };
  /**
   * Wymaga aktywnego programu (gl.useProgram(prog)). `off` = papier wyłączony (np. przebiegi pomiarowe).
   * `tex` (PAPER_TEX_GLSL): [tekstura z createPaperTexture, jednostka] — null = brak faktury (amp = 0, bez odczytu).
   */
  return (p: PaperParams, off = false, tex?: [WebGLTexture, number] | null) => {
    const q = off ? { ...p, paper: false } : p;
    const v = paperUniformValues(q);
    if (L.tex) {
      if (tex && v.amp > 0) {
        gl.activeTexture(gl.TEXTURE0 + tex[1]);
        gl.bindTexture(gl.TEXTURE_2D, tex[0]);
        gl.uniform1i(L.tex, tex[1]);
      } else {
        v.amp = 0;
        const t = dummyTex(gl);
        gl.activeTexture(gl.TEXTURE0 + PAPER_DUMMY_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.uniform1i(L.tex, PAPER_DUMMY_UNIT);
      }
    }
    gl.uniform3f(L.tint, v.tint[0], v.tint[1], v.tint[2]);
    gl.uniform1f(L.amp, v.amp);
    gl.uniform1f(L.scale, v.scale);
    gl.uniform1f(L.ext, v.ext);
  };
}

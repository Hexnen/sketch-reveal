/* „Inteligentne wykrywanie świateł (AI)” dla fazy rozbłysku — port src/lib/roleplay/revealLights.ts + api/lightHints.ts
   (repo roleplay). Różnica architektoniczna: w Foundry nie ma backendu, więc GM wywołuje model wizyjny (OpenRouter)
   z przeglądarki własnym kluczem; wynik (zwalidowane LightHint[]) zapisuje się W PRESECIE — gracze tylko go czytają,
   nie potrzebują klucza i nic nie kosztuje przy kolejnych odtworzeniach. */
import { sanitizeHints } from "../../vendor/reveal-core.js";

export const REVEAL_LIGHTS_MODEL = "google/gemini-2.5-flash-lite";
export const REVEAL_LIGHTS_PROMPT_VERSION = 2;
const TIMEOUT_MS = 60_000, MAX_SIDE = 1024;
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export const REVEAL_LIGHTS_PROMPT = `You are a lighting analyst for a "lights turn on" animation over a painted/illustrated image.
List every LIGHT SOURCE and LIGHT-EMITTING SURFACE visible in the image.

Include: neon signs and tubes (each sign separately), lit windows, lamps/street lights/lanterns/sconces, sun, moon,
screens/monitors/TVs, LED indicators, skylights, holograms, candles, fire/torches, glowing magic or other emitters.
EXCLUDE (these are NOT sources): reflections of lights (puddles, glass, metal, wet ground), surfaces merely lit by a
light (bright walls, light cones on the ground, lit faces or skin), white or pale objects, clouds, plain sky without a
visible sun/moon, specular highlights in eyes or hair, unlit windows, dark lamps that are switched off.
If the scene is daytime and nothing emits light, return an empty list. Do not guess: only list what you can see.

Return ONLY JSON: {"lights":[{"kind":"neon|window|lamp|sun|moon|screen|led|skylight|hologram|candle|fire|other",
"box":[ymin,xmin,ymax,xmax],"color":"#rrggbb","intensity":0..1,"flicker":0..1,"confidence":0..1,"label":"short name"}]}
- box: tight box around the glowing part only (not the halo), integers 0..1000 relative to image height/width.
- color: the color of the emitted light. intensity: how bright it shines. flicker: tendency to flicker
  (neon/fire high, sun/window low). confidence: how sure you are this is a real emitting source.
- At most 24 entries; group many tiny identical lights (e.g. a row of small windows) into a few boxes.
- Never repeat an entry. label: 1-4 words. Output compact JSON on one line.`;

/** Wyciąga JSON z odpowiedzi modelu (płot markdown, dopisek przed/po, ucięta lista → ratuje kompletne obiekty). */
export function parseModelJson(text) {
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const cands = [raw];
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) cands.push(raw.slice(a, b + 1));
  const c = raw.indexOf("["), d = raw.lastIndexOf("]");
  if (c >= 0 && d > c) cands.push(raw.slice(c, d + 1));
  for (const s of cands) { try { return JSON.parse(s); } catch { /* następny */ } }
  const objs = [];
  for (const m of raw.matchAll(/\{[^{}\[\]]*(?:\[[^\[\]]*\][^{}\[\]]*)*\}/g)) { try { objs.push(JSON.parse(m[0])); } catch { /* pomiń */ } }
  if (objs.length) return objs;
  throw new Error("niepoprawny JSON");
}

/** Obraz → JPEG data URL o dłuższym boku ≤ 1024 px. */
function encode(img) {
  const w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const cw = Math.max(16, Math.round(w * k)), ch = Math.max(16, Math.round(h * k));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, cw, ch);
  return { url: c.toDataURL("image/jpeg", 0.9), w: cw, h: ch };
}

async function loadImage(src) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  return img;
}

async function callModel(apiKey, dataUrl) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Foundry Sketch Reveal" },
    body: JSON.stringify({
      model: REVEAL_LIGHTS_MODEL, temperature: 0, max_tokens: 2000, frequency_penalty: 0.3,
      response_format: { type: "json_object" }, usage: { include: true },
      messages: [{ role: "user", content: [{ type: "text", text: REVEAL_LIGHTS_PROMPT }, { type: "image_url", image_url: { url: dataUrl } }] }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`OpenRouter ${res.status}: ${String(json?.error?.message || res.statusText || "błąd").slice(0, 300)}`);
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
  return {
    text: String(json?.choices?.[0]?.message?.content ?? ""),
    cost: Number(json?.usage?.cost) || 0,
    prompt: Number(json?.usage?.prompt_tokens) || 0,
    completion: Number(json?.usage?.completion_tokens) || 0,
  };
}

/**
 * Wykrywa światła na obrazie `imageUrl` (jedno wywołanie + najwyżej jeden retry).
 * @returns {{hints: object[], model: string, cost: number, tokens: {prompt:number, completion:number}, ms: number, attempts: number}}
 */
export async function detectLightHints(imageUrl, apiKey) {
  if (!apiKey?.trim()) throw new Error("Brak klucza OpenRouter (ustawienia modułu).");
  const enc = encode(await loadImage(imageUrl));
  const aspect = enc.w / enc.h;
  const t0 = Date.now();
  let cost = 0, prompt = 0, completion = 0, lastErr = null, attempts = 0;
  for (attempts = 1; attempts <= 2; attempts++) {
    try {
      const r = await callModel(apiKey.trim(), enc.url);
      cost += r.cost; prompt += r.prompt; completion += r.completion;
      const parsed = parseModelJson(r.text);
      const ok = Array.isArray(parsed) || (parsed && typeof parsed === "object" && Object.values(parsed).some(Array.isArray));
      if (!ok) throw new Error("brak listy świateł w JSON");
      return { hints: sanitizeHints(parsed, { aspect }), model: REVEAL_LIGHTS_MODEL, cost, tokens: { prompt, completion }, ms: Date.now() - t0, attempts };
    } catch (e) {
      lastErr = e;
      if (e?.retryable === false) throw e;
      if (attempts === 1) await new Promise((res) => setTimeout(res, e?.retryable ? 4000 : 500));
    }
  }
  throw new Error(`Model wizyjny nie zwrócił poprawnej listy świateł (${lastErr?.message ?? lastErr}; koszt prób $${cost.toFixed(6)}).`);
}

/**
 * Shadery fazy „rozbłysk” (GLSL ES 3.00). Obraz i tekstura analizy są „z góry na dół” (jak getImageData),
 * bufory bloomu w orientacji GL — stąd `iuv = vec2(uv.x, 1 - uv.y)` w przebiegach czytających obraz.
 * Bufory bloomu: RGBA16F (EXT_color_buffer_float) albo RGBA8 z kodowaniem sqrt(x/8) (uEnc = 1).
 */

export const VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o;
uniform vec2 uOut;      // rozmiar celu w px
uniform int uEnc;
vec3 dec(vec4 v){ return uEnc == 1 ? v.rgb * v.rgb * 8.0 : v.rgb; }
vec4 enc(vec3 x){ return uEnc == 1 ? vec4(sqrt(clamp(x / 8.0, 0.0, 1.0)), 1.0) : vec4(x, 1.0); }
`;

const LIGHT = `
uniform sampler2D uImg;   // obraz sRGB (RGBA8, LINEAR)
uniform sampler2D uAna;   // R = id źródła, G = lokalna średnia luminancji
uniform sampler2D uTab;   // 256×1 RGBA32F: poziom, siła bloomu, siła rdzenia, ocieplenie
uniform vec2 uAnaSize;
uniform float uThr, uKnee, uSatB;
vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 l){ l = max(l, 0.0); return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, l)); }
float lightMask(vec3 c, float mean){
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float s = 0.5 * y + 0.5 * mx + uSatB * (mx - mn);
  return smoothstep(uThr - uKnee, uThr + uKnee, s - 0.7 * mean);
}
vec4 tabAt(ivec2 p){
  ivec2 m = ivec2(uAnaSize) - 1;
  int id = int(texelFetch(uAna, clamp(p, ivec2(0), m), 0).r * 255.0 + 0.5);
  return texelFetch(uTab, ivec2(id, 0), 0);
}
uniform sampler2D uSrcMap; // mapa źródeł (tabela rozwinięta po id w rozdzielczości analizy, RGBA16F, LINEAR)
uniform int uUseMap;
/** Dwuliniowo interpolowane wartości tabeli po id (id nie da się filtrować — filtrujemy wynik). */
vec4 srcAtManual(vec2 iuv){
  vec2 t = iuv * uAnaSize - 0.5;
  ivec2 i = ivec2(floor(t)); vec2 f = fract(t);
  return mix(mix(tabAt(i), tabAt(i + ivec2(1, 0)), f.x), mix(tabAt(i + ivec2(0, 1)), tabAt(i + ivec2(1, 1)), f.x), f.y);
}
/** Z mapy (1 próbka dwuliniowa sprzętowo) albo ręcznie (fallback bez float RT — 8 pobrań). */
vec4 srcAt(vec2 iuv){ return uUseMap == 1 ? texture(uSrcMap, iuv) : srcAtManual(iuv); }
vec3 warmTint(float a){ return max(vec3(1.0 + 0.12 * a, 1.0 - 0.07 * a, 1.0 - 0.4 * a), vec3(0.05)); }
`;

/** Jasny przebieg: emisja (liniowa, barwa źródła) w rozdzielczości bloomu, z prefiltrem Karisa (bez „świetlików”). */
export const FS_BRIGHT = HEAD + LIGHT + `
uniform vec2 uImgTexel;
uniform float uGain;
uniform int uPre;
vec3 emis(vec2 iuv){
  vec4 s = srcAt(iuv);
  if (s.r * s.g <= 0.0) return vec3(0.0);   // poza źródłami: bez próbki obrazu i pow (ten sam wynik)
  vec3 c = texture(uImg, iuv).rgb;
  float m = lightMask(c, s.b < 0.0 ? 0.0 : texture(uAna, iuv).g);   // tarcza (s.b < 0): bez lokalnej średniej
  return toLin(c) * warmTint(max(s.a, 0.0)) * (m * s.r * s.g);
}
void main(){
  vec2 uv = gl_FragCoord.xy / uOut, iuv = vec2(uv.x, 1.0 - uv.y);
  vec3 e;
  if (uPre == 1) {
    vec2 d = uImgTexel;
    vec3 a = emis(iuv + vec2(-d.x, -d.y)), b = emis(iuv + vec2(d.x, -d.y)), c = emis(iuv + vec2(-d.x, d.y)), f = emis(iuv + d);
    vec4 w = 1.0 / (1.0 + vec4(dot(a, vec3(.3,.5,.2)), dot(b, vec3(.3,.5,.2)), dot(c, vec3(.3,.5,.2)), dot(f, vec3(.3,.5,.2))));
    e = (a * w.x + b * w.y + c * w.z + f * w.w) / (w.x + w.y + w.z + w.w);
  } else e = emis(iuv);
  o = enc(e * uGain);
}`;

/** Dual-Kawase w dół: środek ×4 + 4 rogi (każdy dwuliniowo = 2×2). */
export const FS_DOWN = HEAD + `
uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec2 uv = gl_FragCoord.xy / uOut, h = uTexel;
  vec3 s = dec(texture(uSrc, uv)) * 4.0 + dec(texture(uSrc, uv - h)) + dec(texture(uSrc, uv + h))
    + dec(texture(uSrc, uv + vec2(h.x, -h.y))) + dec(texture(uSrc, uv - vec2(h.x, -h.y)));
  o = enc(s / 8.0);
}`;

/** Dual-Kawase w górę (namiot 8 próbek) + dodanie własnego poziomu z wagą. */
export const FS_UP = HEAD + `
uniform sampler2D uSrc; uniform sampler2D uSelf; uniform vec2 uTexel; uniform float uW; uniform float uWsrc;
void main(){
  vec2 uv = gl_FragCoord.xy / uOut, h = uTexel * 0.5;
  vec3 s = dec(texture(uSrc, uv + vec2(-2.0 * h.x, 0.0))) + dec(texture(uSrc, uv + vec2(2.0 * h.x, 0.0)))
    + dec(texture(uSrc, uv + vec2(0.0, -2.0 * h.y))) + dec(texture(uSrc, uv + vec2(0.0, 2.0 * h.y)))
    + 2.0 * (dec(texture(uSrc, uv + h)) + dec(texture(uSrc, uv - h)) + dec(texture(uSrc, uv + vec2(h.x, -h.y))) + dec(texture(uSrc, uv - vec2(h.x, -h.y))));
  o = enc(s / 12.0 * uWsrc + dec(texture(uSelf, uv)) * uW);
}`;

/** Smugi anamorficzne: poziome rozmycie o rosnącym kroku (3 przebiegi = szeroki, gładki ogon). */
export const FS_STREAK = HEAD + `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uStep; uniform float uCut;
void main(){
  vec2 uv = gl_FragCoord.xy / uOut;
  vec3 s = vec3(0.0); float ws = 0.0;
  for (int k = -4; k <= 4; k++) {
    float w = pow(0.72, abs(float(k)));
    vec3 e = dec(texture(uSrc, uv + vec2(float(k) * uStep * uTexel.x, 0.0)));
    if (uCut > 0.0) e *= max(0.0, 1.0 - uCut / max(1e-4, max(e.r, max(e.g, e.b))));
    s += e * w; ws += w;
  }
  o = enc(s / ws);
}`;

/** Mapa źródeł: id → wiersz tabeli, w rozdzielczości analizy (raz na klatkę, ~0,3 Mpx, 2 pobrania/px). */
export const FS_SRCMAP = HEAD + `
uniform sampler2D uAna; uniform sampler2D uTab;
void main(){
  int id = int(texelFetch(uAna, ivec2(gl_FragCoord.xy), 0).r * 255.0 + 0.5);
  o = texelFetch(uTab, ivec2(id, 0), 0);
}`;

/** Kopia obrazu 1:1 (p = 0: bajt w bajt); w trybie przyrostu (uMode > 0) — czerń (zero światła). */
export const FS_BLIT = HEAD + `
uniform sampler2D uImg; uniform int uMode;
void main(){ vec2 uv = gl_FragCoord.xy / uOut; o = uMode > 0 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(texture(uImg, vec2(uv.x, 1.0 - uv.y)).rgb, 1.0); }`;

/**
 * Kompozycja w pełnej rozdzielczości. Pseudo-HDR: x = T⁻¹(obraz) (odwrotność ramienia tonemappingu na max kanale —
 * barwa zachowana), dodatki (rdzeń HDR źródła, bloom × (wrap + albedo), halo latarni, smugi) w przestrzeni liniowej,
 * potem T (filmowe ramię; nadmiar energii > ~2,4 „bieli” rdzeń neonu). Wynik = obraz + (T(x + Δ) − T(x)),
 * więc przy Δ = 0 piksel jest DOKŁADNIE obrazem (ciemne obszary bez źródeł nietknięte).
 */
export const FS_COMPOSITE = HEAD + LIGHT + `
uniform sampler2D uBloom; uniform sampler2D uStreak;
uniform float uCore, uBloomAmt, uWrap, uStreakAmt, uHalo, uRadius, uContrast, uGlobal, uAspect;
uniform vec4 uLamp[4]; uniform vec4 uLampCol[4]; uniform int uNL;
uniform vec4 uRefl[4]; uniform vec4 uReflCol[4]; uniform int uNR; uniform float uReflAmt;
uniform float uBloomFloor; // próg ogona poświaty (liniowo)
uniform float uDarkCap;  // limit rozjaśnienia ciemnych pikseli szarym światłem (sRGB, Y)
uniform int uMode;       // 0 = pełny obraz, 1 = sam przyrost (CSS plus-lighter), 2 = przyrost pod CSS screen
const float A = 0.6;
float T(float x){ return x <= A ? x : A + (1.0 - A) * (1.0 - exp(-(x - A) / (1.0 - A))); }
float Ti(float y){ y = min(y, 0.9985); return y <= A ? y : A - (1.0 - A) * log(1.0 - (y - A) / (1.0 - A)); }
vec3 tm(vec3 x){
  float n = max(x.r, max(x.g, x.b));
  if (n <= A) return x;
  float t = T(n);
  return mix(x * (t / n), vec3(t), smoothstep(2.4, 12.0, n) * 0.7);
}
float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
void main(){
  vec2 uv = gl_FragCoord.xy / uOut, iuv = vec2(uv.x, 1.0 - uv.y);
  vec3 c = texture(uImg, iuv).rgb, l = toLin(c);
  float mean = texture(uAna, iuv).g;
  vec4 s = srcAt(iuv);
  float m = lightMask(c, s.b < 0.0 ? 0.0 : mean);   // tarcza (s.b < 0): bez lokalnej średniej
  s.b = abs(s.b);
  // s.a < 0: ekran/świetlik — bez ocieplenia i bez przepalenia rdzenia (treść ekranu zostaje czytelna)
  float noBurn = clamp(-s.a, 0.0, 1.0);
  s.a = max(s.a, 0.0);
  float n = max(l.r, max(l.g, l.b));
  vec3 x = n > A ? l * (Ti(n) / n) : l;
  float hot = n * n * n;                    // rdzeń: najjaśniejsze piksele źródła rosną najmocniej
  vec3 bl = dec(texture(uBloom, uv)) * uBloomAmt;
  float bLum = dot(bl, vec3(0.2126, 0.7152, 0.0722));
  vec3 add = x * warmTint(s.a) * (m * hot * s.r * s.b * uCore);
  // skończony zasięg poświaty: słaby ogon (poniżej uBloomFloor luminancji liniowej) odcięty miękko — inaczej szerokie
  // skale bloomu dużego źródła podnoszą o kilka LSB pół kadru (ciemne sRGB jest strome: 0,001 lin. ≈ 3/255)
  bl *= bLum > 0.0 ? max(bLum - uBloomFloor, 0.0) / bLum : 0.0;
  add += bl * (uWrap + l);
  for (int i = 0; i < 4; i++) {
    if (i >= uNL) break;
    vec4 L = uLamp[i];
    vec2 d = (iuv - L.xy) * vec2(uAspect, 1.0);
    d.y /= d.y > 0.0 ? 1.45 : 0.85;           // halo ciągnie w dół (światło pada na ulicę)
    float R = max(L.z * 5.0, 0.025) * (0.6 + uRadius);
    float f = pow(1.0 + dot(d, d) / (R * R), -1.6);
    // kształt z obrazu: halo idzie za namalowanym światłem (lokalna średnia jasności, rozmyta), nie czysta elipsa
    f *= mix(0.3, 1.0, smoothstep(0.05, 0.32, mean));
    add += uLampCol[i].rgb * warmTint(uLampCol[i].a) * (L.w * uHalo * f) * (0.1 + 0.75 * l);
    // żarnik: mały, gorący punkt w oprawie (białawy) — źródło czyta się jako najjaśniejsze miejsce, nie stożek
    float r0 = max(L.z * 1.3, 0.004);
    float f0 = pow(1.0 + dot(d, d) / (r0 * r0), -2.0);
    add += mix(uLampCol[i].rgb, vec3(1.0), 0.5) * (L.w * uCore * 0.9 * f0);
  }
  // odbicia neonów: piksele pod szyldem o tej samej chromatyczności (mokra nawierzchnia, kałuże) rozbłyskują z nim
  float ch = n - min(l.r, min(l.g, l.b));
  for (int i = 0; i < 4; i++) {
    if (i >= uNR) break;
    vec4 R = uRefl[i];
    float dx = (iuv.x - R.x) / (R.y * 1.6);
    float col = exp(-dx * dx) * smoothstep(R.z, R.z + 0.05, iuv.y);
    float hue = smoothstep(0.95, 0.99, dot(normalize(l + 1e-4), normalize(uReflCol[i].rgb))) * smoothstep(0.03, 0.12, ch);
    add += x * uReflCol[i].rgb * (R.w * uReflAmt * col * hue);
  }
  add += dec(texture(uStreak, uv)) * uStreakAmt * vec3(0.85, 0.95, 1.15);
  if (max(add.r, max(add.g, add.b)) <= 0.0 && dot(bl, bl) <= 0.0) { o = uMode > 0 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(c, 1.0); return; }
  vec3 outL = l + max(tm(x + add) - tm(x), 0.0);   // dodane światło nie odejmuje żadnego kanału (bez „przesycania” okien)
  // głębia cieni: piksele ciemniejsze od otoczenia lekko ciemnieją przy płonących światłach (tylko przyciemnia)
  float yP = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // tylko w zasięgu poświaty (prox) i nie tam, gdzie światło realnie pada (lit) — dalekie ciemności nietknięte
  float lit = smoothstep(0.05, 0.3, dot(add, vec3(0.3, 0.5, 0.2)));
  float prox = smoothstep(0.0015, 0.02, dot(bl, vec3(0.3, 0.5, 0.2)));
  outL *= 1.0 - uContrast * uGlobal * 0.35 * smoothstep(0.0, 0.18, mean - yP) * prox * (1.0 - lit);
  vec3 outS = c + (toSrgb(outL) - toSrgb(l));
  vec3 dS = outS - c;
  // emiter (rdzeń źródła) może przepalić do bieli; reszta (stożek, oświetlone ściany, poświata) dostaje
  // miękkie ograniczenie zapasu do bieli — bez przepaleń, barwa zachowana (wspólny współczynnik kanałów)
  // rdzeń emitera: obręb źródła (s.g: siła bloomu — oświetlone 0,1, emitery wyżej) i jasny piksel; neon (s.a = 0,
  // bez ocieplenia) bieleje od niższej jasności, ciepłe źródła tylko w samym żarze (stożek latarni się nie przepala)
  float em = smoothstep(0.11, 0.18, s.g) * smoothstep(s.a > 0.01 ? 0.86 : 0.45, s.a > 0.01 ? 0.97 : 0.75, max(c.r, max(c.g, c.b)));
  vec3 hr = max(vec3(1.0) - c, 0.0) * 0.94 + 0.002;
  vec3 pos = max(dS, 0.0);
  float tq = max(pos.r / hr.r, max(pos.g / hr.g, pos.b / hr.b));
  float kq = tq > 1e-4 ? (1.0 - exp(-tq)) / tq : 1.0;
  // ciemne tło: szare światło (białe źródła, szeroki bloom) podnosi czerń najwyżej o ~uDarkCap (bez „mgły”);
  // barwna poświata (neon na ciemnym murze) ma limit wyższy
  float dY = dot(pos, vec3(0.2126, 0.7152, 0.0722));
  float dMx = max(pos.r, max(pos.g, pos.b)), dSat = dMx > 1e-5 ? 1.0 - min(pos.r, min(pos.g, pos.b)) / dMx : 0.0;
  float cap = uDarkCap * (1.0 + 3.0 * smoothstep(0.25, 0.7, dSat)) + smoothstep(0.1, 0.45, yP);
  float kc = dY > 1e-5 ? 1.0 / pow(1.0 + pow(dY / cap, 4.0), 0.25) : 1.0;
  outS = c + dS * mix(min(kq, kc), 1.0, em * (1.0 - noBurn));
  float dev = max(abs(outS.r - c.r), max(abs(outS.g - c.g), abs(outS.b - c.b)));
  float tri = hash(gl_FragCoord.xy) + hash(gl_FragCoord.yx + 17.0) - 1.0;   // trójkątny dither ±1 LSB
  outS += tri / 255.0 * smoothstep(0.0, 1.5 / 255.0, dev);
  outS = clamp(outS, 0.0, 1.0);
  // przyrost: c 8-bit + round(Δ·255) = round(outS·255) — plus-lighter odtwarza pełny wynik (bez przyciemnień contrast)
  if (uMode == 1) o = vec4(max(outS - c, 0.0), 1.0);
  else if (uMode == 2) o = vec4(clamp(max(outS - c, 0.0) / max(vec3(1.0) - c, vec3(1.0 / 255.0)), 0.0, 1.0), 1.0);
  else o = vec4(outS, 1.0);
}`;

/**
 * Tania klatka „życia” (jakość med/low, K6): stan końcowy (idle = 0) z pamięci podręcznej × stosunek poziomu
 * najbliższego źródła (tabela uRatio po id z mapy najbliższego komponentu) — bez łańcucha bloomu i bez kompozycji.
 * uMode 0: obraz + (zapamiętany − obraz)·r; 1/2: zapamiętany przyrost·r (kodowanie screen też jest liniowe w Δ).
 */
export const FS_IDLE = HEAD + `
uniform sampler2D uCache; uniform sampler2D uNear; uniform sampler2D uRatio; uniform sampler2D uImg;
uniform vec2 uAnaSize; uniform int uMode;
void main(){
  vec2 uv = gl_FragCoord.xy / uOut, iuv = vec2(uv.x, 1.0 - uv.y);
  ivec2 m = ivec2(uAnaSize) - 1;
  int id = int(texelFetch(uNear, clamp(ivec2(iuv * uAnaSize), ivec2(0), m), 0).r * 255.0 + 0.5);
  float r = texelFetch(uRatio, ivec2(id, 0), 0).r;
  vec3 v = texelFetch(uCache, ivec2(gl_FragCoord.xy), 0).rgb;
  if (uMode == 0) { vec3 c = texture(uImg, iuv).rgb; o = vec4(clamp(c + (v - c) * r, 0.0, 1.0), 1.0); }
  else o = vec4(clamp(v * r, 0.0, 1.0), 1.0);
}`;

# Sketch Reveal (Foundry v14)

Splashe i przejścia scen „szkic → obraz malowany” (efekty WebGL z `reveal-core` z repo
[Hexnen/roleplay](https://github.com/Hexnen/roleplay), gałąź `feat/foundry-sketch-reveal`).

## Użycie
- **Menedżer**: lewy pasek narzędzi sceny → przycisk **Reveal** (pędzel, pod Journal Notes; tylko GM). Presety: splashe i przejścia; wbudowane
  przykłady (ulica / miasto / baza) są tylko do odczytu — zduplikuj, żeby edytować.
- **Per scena**: konfiguracja sceny → zakładka **Reveal** (obok Miscellaneous): preset, wyzwalacz, własne obrazy
  (puste malowane = tło sceny), nadpisania konfiguracji presetu (zapisują się tylko różnice).
- **Splash dla wszystkich**: najpierw każdy klient przygotowuje się za zasłoną, GM startuje dopiero, gdy wszyscy
  aktywni zgłoszą gotowość (limit 90 s, potem ostrzeżenie kto nie zdążył). „Wstępnie załaduj” rozgrzewa cache u wszystkich.
- **Przejście sceny**: zasłona w `canvasInit`, odtwarzanie w `canvasReady`; każdy klient gra własne po pełnym przygotowaniu.

## Co jest w presecie
Efekt koloru (spread / speedpaint / strokes / watercolor, z parametrami), faza rysowania szkicu, papier, zoom i kołysanie
kamery, ślad szkicu pod malunkiem, napis (22 style, 10 zaników, podtytuł), rozbłysk świateł (glow, żywe światło,
wykrywanie), czas przytrzymania/rozpłynięcia. Podpowiedzi świateł z AI (przycisk w sekcji rozbłysku, klucz OpenRouter
w ustawieniach modułu, tylko GM) zapisują się w presecie — gracze klucza nie potrzebują.

## Ustawienia klienta (wydajność)
Rozdzielczość podglądu, limit klatek, lekkie animacje napisu, licznik FPS, auto-jakość — ustawienia modułu (per klient).

## Budowanie bundla
`src/reveal-core` to kopia rdzenia; `vendor/reveal-core.js` składa `src/entry.ts`:
`npm install && npm run build`. Teksty: `python tools/write-lang.py`. Test odtwarzacza bez Foundry:
serwer statyczny w katalogu modułu + `tools/harness.html?set=ulica&effect=spread`.

## Bench

Pomiar GPU ms/klatkę (narzędzie deweloperskie): serwer statyczny w katalogu modułu i
`tools/bench.html?run=1&effects=spread&scenes=ulica&frames=60&size=1920` (parametry: effects, scenes, frames, size, run).
Wynik: tabela + JSON (`window.__revealBench`).

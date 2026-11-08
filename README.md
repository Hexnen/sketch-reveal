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

## Pasek wiadomości (news bar)
Trzeci rodzaj presetu: telewizyjny pasek nad mapą (blok kanału + znacznik „na żywo”, belka z tytułem, pasek z listą
wiadomości). Bez obrazów. Tryb: pętla (do zdjęcia; opcjonalne auto-zdjęcie po N min) albo jeden przebieg (każda
wiadomość raz, potem schodzi sam). Styl: klapka (po jednej, długie przewijają się do końca) albo przesuw (ciągły).
Wygląd (`ticker.look`, pole „Wygląd”; stare presety = `broadcast`):
- `broadcast` — telewizja: ciemny blok kanału, belka w kolorze akcentu, jasny pasek; wiadomość podjeżdża od dołu.
- `wire` — dalekopis: papierowa taśma wsuwa się z lewej, kanał i „na żywo” odbijają się jak pieczątki, tytuł to
  przyklejony wycinek (Amiri), wiadomości są wystukiwane maszynowo litera po literze (Courier New), stara odjeżdża w lewo.
- `signal` — sygnał (sci-fi): ciemne pasmo ze ściętym końcem na szynie świetlnej w kolorze akcentu (Bruno Ace), pasmo
  otwiera się w dół z szyny, stara wiadomość gaśnie do kreski jak kineskop, nową odsłania promień skanera.
Wygląd zmieniony w trakcie nadawania przełącza pasek u wszystkich (krótkie przenikanie). Ograniczony ruch / tryb lite
działają we wszystkich trzech. Lista wiadomości w edytorze to „scenariusz wydania”: wiersz = etykieta + tekst
bez ramek pól; Enter dzieli w miejscu kursora, Backspace na początku łączy z poprzednią, Alt+↑/↓ lub uchwyt
przestawia, „ETYKIETA | tekst” albo wklejka wielu linii (też z tabulatorem) wypełnia wiersze, Ctrl+Enter = „Zastosuj”.
„ETYKIETA |” na początku tekstu działa przy każdym sposobie wpisania (klawisz po klawiszu, wklejenie jednej linii,
autouzupełnienie, IME) i zastępuje dotychczasową etykietę wiersza; Backspace tuż po zamianie ją cofa.
GM nadaje z menedżera (ikona anteny), makrem z paska (przeciągnij miniaturę — makro jest przełącznikiem) albo z konsoli:
`game.modules.get("sketch-reveal").api.ticker.start(id)` / `.stop()` / `.toggle(id)` / `.onAir()` / `.preview(data)`.
Pasek stoi między kolumną narzędzi a paskiem bocznym, nad paskiem makr, i ustępuje pływającemu dolnemu UI innych
modułów (np. pasek reżysera moinen-maps, HUD drużyny): co 0,7 s mierzy widoczne elementy fixed/absolute przy dole
ekranu i wjeżdża nad nie (za wysokie — zwęża się od ich strony). Kliknięcia nadal przechodzą przez pasek.
Stan „na antenie” jest ustawieniem świata (`tickerState`), więc widzą go też gracze, którzy weszli później. Zapis presetu
w trakcie nadawania zmienia pasek u wszystkich od następnej wiadomości (przycisk „Zastosuj” zapisuje bez zamykania).
Podgląd silnika bez Foundry: `tools/harness-ticker.html?auto` przez serwer statyczny w katalogu modułu
(parametry: `look=wire|signal|broadcast`, `hud=1` — atrapy dolnych HUD-ów innych modułów, `style=crawl`, `mode=once`, `reduced=1`, `lite=1`, `light=1`, `ui=0`, `min`,
`slow=5` — zwolnione tempo, `lang=en`; panel zawiera prawdziwy edytor listy z `ticker-form.mjs`).

## Wirująca gazeta (przejście sceny)

Preset rodzaju „gazeta” zamienia widok każdego gracza w zdjęcie na pierwszej stronie amerykańskiej gazety; strona
wiruje, odlatuje, a spod niej wyłania się nowa scena. Dwa wyglądy:

- **Klasyczny dziennik z USA (lata 30.–40.)** — szeryfowa winieta między ramkami pogody i wydania, linia numeru
  z datą i ceną w centach, baner EXTRA farbą akcentu, wąski grotesk wersalikami w nagłówkach, rastrowe zdjęcie,
  5 łamów z liniami, bylina, dateline („HARBOR CITY, Nov. 8 —”), „Continued on Page 4”, ramka „In Brief”, indeks.
- **Współczesny tabloid z USA** — kolorowa flaga z winietą i zapowiedziami stron, data po amerykańsku i cena w $,
  etykieta + ogromny ścieśniony nagłówek, kolorowe zdjęcie z belką podpisu, 3 łamy, ramki boczne, karty „More top stories”.

Nazwy są zmyślone (domyślnie „The Harbor City Clarion” i „Metro Flash”). Każdy czytelny tekst to prawdziwy angielski:
w edytorze presetu sekcja **Pierwsza strona** to szkic pisany wprost (winieta, miejsce, data, baner, nagłówek,
podtytuł, podpis zdjęcia i 6 pozostałych nagłówków — rubryka z lewej mówi, gdzie stanie wiersz). Pusty wiersz drukuje
szary tekst domyślny; pusty baner = bez banera; pusta data = dzisiejsza. Łamy wypełnia neutralna proza agencyjna
(prawdziwe zdania, nic nie zdradzają). Długie nagłówki same się zmniejszają, zawijają i — w ostateczności — skracają
z wielokropkiem. Tekst z polskimi znakami drukuje się krojem zastępczym (Georgia / Signika), bo Amiri i Modesto
Condensed z rdzenia Foundry ich nie mają.

W zakładce sceny **Reveal**, gdy wybrany jest preset-gazeta, sekcja **Pierwsza strona tej sceny** nadpisuje teksty
presetu dla tej jednej sceny (pole puste = tekst presetu, pokazany na szaro); wygląd, kolory i obrót są zawsze
z presetu. Przycisk podglądu uwzględnia niezapisane zmiany.

Test bez Foundry: `tools/harness-newspaper.html` (zestawy tekstów: domyślne, długie, jednowyrazowe, polskie;
„strona w 1:1” pokazuje samą stronę do czytania). Kopie Modesto Condensed w `tools/fonts` są tylko lokalne
(licencja Fontspring, w `.gitignore`).

## Media Optimizer (opcjonalnie)
Z modułem [Media Optimizer (Local)](https://github.com/Hexnen/local-media-optimizer) edytor presetu ma przycisk **Zoptymalizuj obrazy**:
kopie szkicu i malunku jako WebP ≤ 4096 px (szkic q0,95, malunek q0,88) trafiają do `worlds/<świat>/sketch-reveal/images/`,
preset dostaje nowe ścieżki, oryginały zostają. Każdy klient i tak skaluje obrazy do limitu tekstur przy starcie, więc zysk to
głównie rozmiar pobierania (np. 13,9 MB → 2,5 MB). Upload idzie z `optimized: true`, żeby optymalizator nie kodował pliku drugi raz;
tak samo oznaczona jest ikona makra. Bez modułu przycisk się nie pokazuje.

## AI Image Gen (opcjonalnie)
Z modułem [AI Image Gen](https://github.com/Hexnen/ai-image-gen) (tylko GM) edytor presetu i zakładka **Reveal** sceny mają dwa przyciski:
- **Wygeneruj malunek (AI)**: opis obrazu, liczba wersji i (gdy scena ma tło) opcja „użyj tła sceny jako referencji”; proporcje bierze z tła sceny albo z obecnego malunku.
- **Szkic z malunku (AI)**: szkic powstaje jako *edycja* malunku (malunek jest referencją), więc oba obrazy mają ten sam kadr, kompozycję i proporcje — tego wymaga efekt szkic → malunek.

Przed startem dialog pokazuje szacowany koszt, a przy braku klucza API ostrzeżenie. Wersje wybierasz w oknie wyboru AI Image Gen; nic nie jest zapisywane przed wyborem.
Wynik trafia do `worlds/<świat>/sketch-reveal/images/` (WebP ≤ 4096 px; malunek q0,88, szkic q0,95) i od razu do pola presetu/sceny.
Model, dostawca, prompt i budżet ustawiasz w AI Image Gen (okno konfiguracji → grupa **Sketch Reveal**: typy „Malunek” i „Szkic z malunku”, z gotowymi promptami do edycji).
Moduły działają niezależnie: bez AI Image Gen przyciski się nie pokazują, a AI Image Gen bez Sketch Reveal po prostu nie ma tej grupy.

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

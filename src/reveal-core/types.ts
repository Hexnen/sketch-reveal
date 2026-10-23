/**
 * Wspólny kontrakt efektów reveal (szkic → obraz malowany). Patrz docs/FOUNDRY-SKETCH-REVEAL-SPEC.md,
 * sekcja „Wiele efektów”. ZASADA: istniejących typów nie zmieniamy — tylko dopisujemy nowe/opcjonalne pola.
 */

/** Wartości parametrów efektu — płaskie (UI i flagi sceny Foundry je serializują). */
export type EffectParamValue = number | boolean | string;
export type EffectParams = Record<string, EffectParamValue>;

/** Opis suwaka generowanego przez UI. Efekt nie dotyka Reacta. */
export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Opcjonalnie: krótki opis do tooltipa. */
  hint?: string;
}

export type RevealImageSource = ImageBitmap | HTMLImageElement;

export interface EffectInstance {
  setImages(sketch: RevealImageSource, painted: RevealImageSource): void;
  /** Częściowa aktualizacja parametrów (brakujące klucze zostają). */
  setParams(p: Partial<EffectParams>): void;
  /** Postęp CZASOWY 0..1 (easing to sprawa efektu). p >= 1 → czysty obraz kolorowy. */
  setProgress(p: number): void;
  render(): void;
  dispose(): void;
  /** Opcjonalnie: efekt z ciężkim preprocessingiem (np. lista pociągnięć) — true, gdy gotowy do odtwarzania. */
  isReady?(): boolean;
  /** Opcjonalnie: obietnica gotowości (zegar odtwarzacza ma na nią poczekać). */
  whenReady?(): Promise<void>;
  /**
   * Opcjonalnie: mapa pokrycia farbą BEZ odczytu z GPU (zastępuje odczyt płótna przez bramkę glow). Zwraca siatkę
   * `w×h` (komórki zwykle ≤ 64×64, wiersze od góry) z postępem efektu p∈[0,1], przy którym dana komórka jest już
   * (prawie) w pełni pokryta kolorem — liczoną z danych CPU efektu (pole czasu spread, pole kolejności speedpaint,
   * pole Tb watercolor, lista pociągnięć strokes). Wartości > 1 = nigdy nie pokryta przed końcem. Ten sam układ
   * współrzędnych co obraz (uv); null = efekt nie umie (rdzeń wraca do odczytu płótna). Wołane rzadko, wynik cache'owany.
   */
  coverage?(w: number, h: number): Float32Array | null;
  /**
   * Opcjonalnie: true, gdy kontekst WebGL jest stracony (reset GPU/sterownika, limit kontekstów). Efekty z rejestru
   * (effects/guard.ts) same odtwarzają stan po `webglcontextrestored`; do tego czasu render() nic nie rysuje —
   * UI może pokazać komunikat zamiast pustego płótna.
   */
  isContextLost?(): boolean;
}

export interface RevealEffect {
  id: string;
  label: string;
  defaultParams: EffectParams;
  paramSpecs: ParamSpec[];
  create(canvas: HTMLCanvasElement): EffectInstance;
  /** false = efekt ma stan (nie da się skrubować wstecz) i resetuje się sam przy p=0. Domyślnie true. */
  scrubbable?: boolean;
  /** Opcjonalnie: parametry tekstowe/wyboru (np. tryb) — UI renderuje <select>. */
  choiceSpecs?: { key: string; label: string; options: string[] }[];
}

/** Parametry efektu `speedpaint` (domyślne, suwaki, tryby jakości). */
import type { EffectParams, ParamSpec } from "../../types";

export const SPEEDPAINT_DEFAULTS = {
  stages: 4,
  brushSize: 0.1,
  strokeLength: 3.2,
  strokeDirection: 0.3,
  flatness: 0.85,
  detailLag: 0.6,
  lineErase: 0.45,
  rhythm: 0.3,
  spread: 0.6,
  stageDelay: 0.08,
  stageDur: 0.14,
  hold: 0.02,
  regionBias: 0.2,
  frontJitter: 0.6,
  evenPace: 1,
  bristle: 1,
  originX: 0.5,
  originY: 0.3,
  seed: 7,
} satisfies EffectParams;

export type SpParams = typeof SPEEDPAINT_DEFAULTS;

export const PARAM_SPECS: ParamSpec[] = [
  { key: "stages", label: "Etapy", min: 2, max: 6, step: 1, hint: "Liczba warstw pociągnięć: blokowanie → formy → detal (ostatnia = obraz)" },
  { key: "brushSize", label: "Pędzel (blokowanie)", min: 0.03, max: 0.25, step: 0.005, hint: "Szerokość pędzla 1. etapu jako ułamek wysokości obrazu; kolejne etapy ×½" },
  { key: "strokeLength", label: "Długość pociągnięć", min: 1, max: 5, step: 0.1, hint: "Długość / szerokość pociągnięcia" },
  { key: "strokeDirection", label: "Kierunek pociągnięć", min: 0, max: 1, step: 0.05, hint: "0 = wzdłuż form obrazu, 1 = jednolite kreskowanie po skosie" },
  { key: "flatness", label: "Płaskość plam", min: 0, max: 1, step: 0.05, hint: "1 = plamy jednolitego koloru, 0 = gradient wewnątrz pociągnięcia" },
  { key: "detailLag", label: "Światła po detalu", min: 0, max: 1, step: 0.05, hint: "Jak długo światła (okna, latarnia, neon, kałuże) czekają w lokalnym etapie detalu, zanim rozbłysną od rdzenia" },
  { key: "lineErase", label: "Linie na podmalówce", min: 0, max: 1, step: 0.05, hint: "Siła linii szkicu na podmalówce (słabną z etapem, znikają pod detalem); 0 = brak" },
  { key: "spread", label: "Rozpiętość frontu", min: 0.2, max: 0.8, step: 0.01, hint: "Jaką część czasu front malowania wędruje od tła do pierwszego planu (większa = bardziej lokalnie)" },
  { key: "stageDelay", label: "Opóźnienie etapu", min: 0.03, max: 0.25, step: 0.01, hint: "O ile każdy kolejny etap idzie za poprzednim w tym samym miejscu" },
  { key: "stageDur", label: "Czas etapu (lokalnie)", min: 0.05, max: 0.3, step: 0.01, hint: "Ile trwa jeden etap w danym miejscu (detal 1.4×)" },
  { key: "hold", label: "Szkic na starcie", min: 0, max: 0.15, step: 0.005, hint: "Ile czasu sam szkic przed pierwszym pociągnięciem" },
  { key: "regionBias", label: "Malowanie obszarami", min: 0, max: 0.6, step: 0.02, hint: "Waga regionów koloru w kolejności (cała ściana/ulica jako jednostka)" },
  { key: "frontJitter", label: "Postrzępienie frontu", min: 0, max: 1, step: 0.05, hint: "Drobny szum kolejności: obszar malowany po kawałku zamiast jednym frontem (mniejsze skoki)" },
  { key: "evenPace", label: "Równe tempo", min: 0, max: 1, step: 0.05, hint: "1 = oś czasu przemapowana tak, by obraz zmieniał się równomiernie do końca (kalibracja na starcie)" },
  { key: "rhythm", label: "Nierówny rytm", min: 0, max: 1, step: 0.05, hint: "Serie pociągnięć i pauzy zamiast równego tempa" },
  { key: "bristle", label: "Faktura włosia", min: 0, max: 2, step: 0.05 },
  { key: "originX", label: "Tło — X", min: 0, max: 1, step: 0.01, hint: "Skąd zaczyna się malowanie (najdalszy plan)" },
  { key: "originY", label: "Tło — Y", min: 0, max: 1, step: 0.01 },
  { key: "seed", label: "Ziarno", min: 0, max: 999, step: 1 },
];

export function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

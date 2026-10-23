/**
 * Rejestr efektów reveal. Każdy efekt żyje w effects/<id>/ i eksportuje `effect: RevealEffect`.
 * Nowy efekt: dopisz import + wpis w EFFECTS (scala orkiestrator / właściciel rdzenia).
 */
import type { RevealEffect } from "../types";
import { effect as speedpaint } from "./speedpaint";
import { effect as spread } from "./spread";
import { effect as strokes } from "./strokes";
import { effect as watercolor } from "./watercolor";

export const EFFECTS: RevealEffect[] = [spread, speedpaint, strokes, watercolor];

export function getEffect(id: string): RevealEffect {
  return EFFECTS.find((e) => e.id === id) ?? EFFECTS[0];
}

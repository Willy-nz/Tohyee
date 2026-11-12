import { add, cmp, dec, divide, mul, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * Stock units (decision 1424). A stock unit (SU) is the year's feed of one
 * 55 kg ewe rearing one lamb. No New Zealand body publishes one official
 * table, and Beef + Lamb New Zealand's survey reports use stock units
 * without printing their factors. Tohyee's defaults are the widely used
 * table of livestock (stock) units for each class, as published by
 * RuralFind (https://www.ruralfind.co.nz/?p=257, read 5 November 2026),
 * which is the table farm consultants and the Lincoln University Farm
 * Technical Manual use. Where the table has a range of weights, the row
 * used is named. Each organisation can change any factor.
 *
 * Browser-safe: no server imports.
 */

export const STOCK_UNIT_SOURCE =
  "Livestock unit table published by RuralFind (ruralfind.co.nz, read 5 Nov 2026): 1 SU is a 55 kg ewe rearing one lamb, about 520–550 kg DM a year.";

export type StockUnitDefault = { kind: string; classCode: string; factor: string; basis: string };

/** Tohyee's default factor for each IRD class, and which row of the table it is. */
export const STOCK_UNIT_DEFAULTS: readonly StockUnitDefault[] = [
  // Sheep
  { kind: "sheep", classCode: "ewe_hoggets", factor: "0.70", basis: "Hogget, 30 kg pre-winter" },
  { kind: "sheep", classCode: "ram_wether_hoggets", factor: "0.70", basis: "Hogget, 30 kg pre-winter" },
  { kind: "sheep", classCode: "two_tooth_ewes", factor: "1.00", basis: "Ewe, 55 kg, 100% lambs weaned" },
  { kind: "sheep", classCode: "ma_ewes", factor: "1.00", basis: "Ewe, 55 kg, 100% lambs weaned" },
  { kind: "sheep", classCode: "r5_ewes", factor: "1.00", basis: "Ewe, 55 kg, 100% lambs weaned" },
  { kind: "sheep", classCode: "ma_wethers", factor: "0.85", basis: "Ewe, 45 kg (no wether row; check)" },
  { kind: "sheep", classCode: "breeding_rams", factor: "0.80", basis: "Ram, 75 kg" },
  // Beef cattle
  { kind: "beef_cattle", classCode: "r1_heifers", factor: "3.50", basis: "Weaners, 135–270 kg" },
  { kind: "beef_cattle", classCode: "r2_heifers", factor: "4.60", basis: "Heifers, steers and bulls, rapid growing" },
  { kind: "beef_cattle", classCode: "ma_cows", factor: "5.30", basis: "Breeding cow, 450 kg" },
  { kind: "beef_cattle", classCode: "r1_steers_bulls", factor: "3.50", basis: "Weaners, 135–270 kg" },
  { kind: "beef_cattle", classCode: "r2_steers_bulls", factor: "4.60", basis: "Heifers, steers and bulls, rapid growing" },
  { kind: "beef_cattle", classCode: "r3_steers_bulls", factor: "6.00", basis: "Heifers, steers and bulls, 600 kg" },
  { kind: "beef_cattle", classCode: "breeding_bulls", factor: "6.00", basis: "Heifers, steers and bulls, 600 kg" },
  // Dairy cattle
  { kind: "dairy_cattle", classCode: "r1_heifers", factor: "4.50", basis: "Friesian yearling, 225–430 kg" },
  { kind: "dairy_cattle", classCode: "r2_heifers", factor: "6.10", basis: "Cow, 350 kg (no in-calf heifer row; check)" },
  { kind: "dairy_cattle", classCode: "ma_cows", factor: "8.00", basis: "Cow, 450 kg, 200 kg fat" },
  { kind: "dairy_cattle", classCode: "r1_steers_bulls", factor: "4.50", basis: "Friesian yearling, 225–430 kg" },
  { kind: "dairy_cattle", classCode: "r2_steers_bulls", factor: "4.60", basis: "Heifers, steers and bulls, rapid growing" },
  { kind: "dairy_cattle", classCode: "r3_steers_bulls", factor: "6.00", basis: "Heifers, steers and bulls, 600 kg" },
  { kind: "dairy_cattle", classCode: "breeding_bulls", factor: "6.00", basis: "Heifers, steers and bulls, 600 kg" },
  // Red deer
  { kind: "deer_red", classCode: "r1_hinds", factor: "1.20", basis: "Hind, 6–15 months" },
  { kind: "deer_red", classCode: "r2_hinds", factor: "1.80", basis: "Hind, 15–27 months" },
  { kind: "deer_red", classCode: "ma_hinds", factor: "1.90", basis: "Mature hind, 100 kg" },
  { kind: "deer_red", classCode: "r1_stags", factor: "1.20", basis: "Hind, 6–15 months (stag row unreadable; check)" },
  { kind: "deer_red", classCode: "r2_stags", factor: "2.10", basis: "Stag, 15–27 months" },
  { kind: "deer_red", classCode: "breeding_stags", factor: "2.20", basis: "Mature stag, 185 kg" },
  // Other deer: the table says 0.4–0.5 of red deer for fallow.
  { kind: "deer_other", classCode: "r1_hinds", factor: "0.55", basis: "Fallow: 0.45 × red" },
  { kind: "deer_other", classCode: "r2_hinds", factor: "0.80", basis: "Fallow: 0.45 × red" },
  { kind: "deer_other", classCode: "ma_hinds", factor: "0.85", basis: "Fallow: 0.45 × red" },
  { kind: "deer_other", classCode: "r1_stags", factor: "0.55", basis: "Fallow: 0.45 × red" },
  { kind: "deer_other", classCode: "r2_stags", factor: "0.95", basis: "Fallow: 0.45 × red" },
  { kind: "deer_other", classCode: "breeding_stags", factor: "1.00", basis: "Fallow: 0.45 × red" },
  // Angora goats
  { kind: "goats_angora", classCode: "r1_does", factor: "0.50", basis: "Angora hoggets" },
  { kind: "goats_angora", classCode: "ma_does", factor: "0.70", basis: "Angora does, other" },
  { kind: "goats_angora", classCode: "r1_bucks_wethers", factor: "0.50", basis: "Angora hoggets" },
  { kind: "goats_angora", classCode: "bucks_wethers", factor: "0.80", basis: "Angora bucks, other" },
  { kind: "goats_angora", classCode: "breeding_bucks", factor: "1.00", basis: "Angora bucks, stud" },
  // Cashmere goats
  { kind: "goats_cashmere", classCode: "r1_does", factor: "0.50", basis: "Angora hoggets (no cashmere young row; check)" },
  { kind: "goats_cashmere", classCode: "ma_does", factor: "0.70", basis: "Cashmere does" },
  { kind: "goats_cashmere", classCode: "r1_bucks_wethers", factor: "0.50", basis: "Angora hoggets (no cashmere young row; check)" },
  { kind: "goats_cashmere", classCode: "bucks_wethers", factor: "0.70", basis: "Cashmere bucks" },
  { kind: "goats_cashmere", classCode: "breeding_bucks", factor: "0.70", basis: "Cashmere bucks" },
  // Dairy goats
  { kind: "goats_dairy", classCode: "r1_does", factor: "1.00", basis: "Half a milking doe (no young row; check)" },
  { kind: "goats_dairy", classCode: "does", factor: "2.00", basis: "Dairy does, grass only, 550 L" },
  { kind: "goats_dairy", classCode: "breeding_bucks", factor: "2.00", basis: "Dairy does, grass only (no buck row; check)" },
  { kind: "goats_dairy", classCode: "culls", factor: "1.50", basis: "Dairy does, browsing" },
  // Pigs (decision 1604): the table has no pig rows, and pigs are mostly fed grain rather than grazed. 0 until a farm sets its own.
  ...["weaners", "growing_10_17", "growing_over_17", "sows_under_1", "sows_over_1", "breeding_boars"].map((classCode) => ({
    kind: "pigs",
    classCode,
    factor: "0.00",
    basis: "No pig row in the table (pigs are mostly fed grain, not grazed); set your own",
  })),
];

export type StockUnitFactor = StockUnitDefault & { changed: boolean; defaultFactor: string };

/** The factors in use: the organisation's changes over the defaults. */
export function factorsWith(changes: ReadonlyArray<{ kind: string; classCode: string; factor: string }>): StockUnitFactor[] {
  return STOCK_UNIT_DEFAULTS.map((entry) => {
    const change = changes.find((row) => row.kind === entry.kind && row.classCode === entry.classCode);
    return { ...entry, factor: change ? toFixedString(dec(change.factor), 2) : entry.factor, defaultFactor: entry.factor, changed: Boolean(change) };
  });
}

export function factorFor(factors: readonly StockUnitFactor[], kind: string, classCode: string): string | null {
  return factors.find((entry) => entry.kind === kind && entry.classCode === classCode)?.factor ?? null;
}

export type Stocking = {
  head: number;
  /** Stock units, to one decimal place. */
  stockUnits: string;
  hectares: string | null;
  /** Per effective hectare, one decimal place; null with no area. */
  suPerHa: string | null;
  headPerHa: string | null;
};

/** Stock units and per-hectare figures for some mobs on an area (decision 1424). */
export function stocking(mobs: ReadonlyArray<{ head: number; kind: string; classCode: string }>, hectares: string | null, factors: readonly StockUnitFactor[]): Stocking {
  let su = ZERO_DECIMAL;
  let head = 0;
  for (const mob of mobs) {
    head += mob.head;
    const factor = factorFor(factors, mob.kind, mob.classCode);
    if (factor) su = add(su, mul(dec(factor), dec(String(mob.head))));
  }
  const area = hectares && cmp(dec(hectares), ZERO_DECIMAL) > 0 ? dec(hectares) : null;
  return {
    head,
    stockUnits: toFixedString(su, 1),
    hectares: area ? toFixedString(area, 2) : null,
    suPerHa: area ? toFixedString(divide(su, area, 1), 1) : null,
    headPerHa: area ? toFixedString(divide(dec(String(head)), area, 1), 1) : null,
  };
}

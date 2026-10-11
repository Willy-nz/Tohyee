/**
 * The livestock Tohyee records (decision 503: dairy cattle, beef cattle and
 * sheep first), using the classes in IRD's national average market values
 * determination (NAMV 2026), so the herd scheme can value each class.
 * Shared with the browser, so no server imports.
 *
 * Every class is an animal's age at balance date ("rising one-year" = born
 * in the spring before it). Births go into the youngest classes; once a year,
 * at balance date, ageing moves each class to the next (LV1).
 */

export const LIVESTOCK_KINDS = ["dairy_cattle", "beef_cattle", "sheep"] as const;
export type LivestockKind = (typeof LIVESTOCK_KINDS)[number];

export const KIND_NAMES: Readonly<Record<LivestockKind, string>> = {
  dairy_cattle: "Dairy cattle",
  beef_cattle: "Beef cattle",
  sheep: "Sheep",
};

/** How the national standard cost scheme groups a class (LV6, LV11; decision 503: mature = rising two and older). */
export type NscGroup = "rising_1" | "mature" | "unsupported";

export type LivestockClass = {
  kind: LivestockKind;
  code: string;
  name: string;
  /** Born into this class (the youngest classes). */
  birth: boolean;
  /** Where ageing moves it at balance date; null = it stays. */
  agesTo: string | null;
  /** Ageing splits it: some stay, the rest move to `agesTo` (mixed-age ewes, rising three and four, to rising five). */
  agesInPart?: boolean;
  nsc: NscGroup;
  /** Breeding bulls and rams: special herd scheme rules, not checked yet, so refused when valuing. */
  maleBreeding?: boolean;
};

const cattle = (kind: LivestockKind): LivestockClass[] => [
  { kind, code: "r1_heifers", name: "Rising one-year heifers", birth: true, agesTo: "r2_heifers", nsc: "rising_1" },
  { kind, code: "r2_heifers", name: "Rising two-year heifers", birth: false, agesTo: "ma_cows", nsc: "mature" },
  { kind, code: "ma_cows", name: "Mixed-age cows", birth: false, agesTo: null, nsc: "mature" },
  { kind, code: "r1_steers_bulls", name: "Rising one-year steers and bulls", birth: true, agesTo: "r2_steers_bulls", nsc: "rising_1" },
  // Rising three-year male non-breeding cattle have an NSC of their own, not built yet.
  { kind, code: "r2_steers_bulls", name: "Rising two-year steers and bulls", birth: false, agesTo: "r3_steers_bulls", nsc: "unsupported" },
  { kind, code: "r3_steers_bulls", name: "Rising three-year and older steers and bulls", birth: false, agesTo: null, nsc: "unsupported" },
  { kind, code: "breeding_bulls", name: "Breeding bulls", birth: false, agesTo: null, nsc: "unsupported", maleBreeding: true },
];

export const LIVESTOCK_CLASSES: readonly LivestockClass[] = [
  ...cattle("dairy_cattle"),
  ...cattle("beef_cattle"),
  { kind: "sheep", code: "ewe_hoggets", name: "Ewe hoggets", birth: true, agesTo: "two_tooth_ewes", nsc: "rising_1" },
  { kind: "sheep", code: "ram_wether_hoggets", name: "Ram and wether hoggets", birth: true, agesTo: "ma_wethers", nsc: "rising_1" },
  { kind: "sheep", code: "two_tooth_ewes", name: "Two-tooth ewes", birth: false, agesTo: "ma_ewes", nsc: "mature" },
  {
    kind: "sheep",
    code: "ma_ewes",
    name: "Mixed-age ewes (rising three and four)",
    birth: false,
    agesTo: "r5_ewes",
    agesInPart: true,
    nsc: "mature",
  },
  { kind: "sheep", code: "r5_ewes", name: "Rising five-year and older ewes", birth: false, agesTo: null, nsc: "mature" },
  { kind: "sheep", code: "ma_wethers", name: "Mixed-age wethers", birth: false, agesTo: null, nsc: "mature" },
  { kind: "sheep", code: "breeding_rams", name: "Breeding rams", birth: false, agesTo: null, nsc: "unsupported", maleBreeding: true },
];

export function classKey(kind: string, code: string): string {
  return `${kind}.${code}`;
}

export function findClass(kind: string, code: string): LivestockClass | undefined {
  return LIVESTOCK_CLASSES.find((entry) => entry.kind === kind && entry.code === code);
}

export function classesOf(kind: LivestockKind): LivestockClass[] {
  return LIVESTOCK_CLASSES.filter((entry) => entry.kind === kind);
}

export function className(kind: string, code: string): string {
  return findClass(kind, code)?.name ?? code;
}

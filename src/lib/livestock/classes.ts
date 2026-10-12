/**
 * The livestock Tohyee records (decision 503: dairy cattle, beef cattle and
 * sheep; decision 508 adds deer and goats; pigs are left out for now), using the classes in IRD's national average market values
 * determination (NAMV 2026), so the herd scheme can value each class.
 * Shared with the browser, so no server imports.
 *
 * Every class is an animal's age at balance date ("rising one-year" = born
 * in the spring before it). Births go into the youngest classes; once a year,
 * at balance date, ageing moves each class to the next (LV1).
 */

export const LIVESTOCK_KINDS = ["dairy_cattle", "beef_cattle", "sheep", "deer_red", "deer_other", "goats_angora", "goats_cashmere", "goats_dairy"] as const;
export type LivestockKind = (typeof LIVESTOCK_KINDS)[number];

export const KIND_NAMES: Readonly<Record<LivestockKind, string>> = {
  dairy_cattle: "Dairy cattle",
  beef_cattle: "Beef cattle",
  sheep: "Sheep",
  deer_red: "Deer (red, wapiti, elk)",
  deer_other: "Deer (other breeds)",
  goats_angora: "Goats (Angora)",
  goats_cashmere: "Goats (cashmere or cashgora)",
  goats_dairy: "Goats (dairy)",
};

/** Which IRD national standard cost a kind uses: both deer kinds share deer's, Angora and cashmere goats share meat and fibre's (NSC 2026). */
export const NSC_RATE_KIND: Readonly<Record<LivestockKind, string>> = {
  dairy_cattle: "dairy_cattle",
  beef_cattle: "beef_cattle",
  sheep: "sheep",
  deer_red: "deer",
  deer_other: "deer",
  goats_angora: "goats_meat_fibre",
  goats_cashmere: "goats_meat_fibre",
  goats_dairy: "goats_dairy",
};

/** NSC rates are by IRD's kinds: deer and meat-and-fibre goats each cover two of Tohyee's kinds. */
export const NSC_KIND_NAMES: Readonly<Record<string, string>> = {
  dairy_cattle: "Dairy cattle",
  beef_cattle: "Beef cattle",
  sheep: "Sheep",
  deer: "Deer",
  goats_meat_fibre: "Goats (meat and fibre)",
  goats_dairy: "Goats (dairy)",
};

/** The Chatham Islands herd value ratio (0.3) is for sheep and beef cattle only (OS 25/02 para 52). */
export const CHATHAM_KINDS: readonly LivestockKind[] = ["sheep", "beef_cattle"];

/** How the national standard cost scheme groups a class (LV6, LV11; decision 503: mature = rising two and older). */
/** rising_2: beef males between rising one and rising three, adding NSC each year (LV17, decision 506). */
export type NscGroup = "rising_1" | "rising_2" | "mature" | "unsupported";

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
  // Beef males add NSC until rising three, then join the mature group (LV17); dairy has no rising three NSC, so not under NSC.
  { kind, code: "r2_steers_bulls", name: "Rising two-year steers and bulls", birth: false, agesTo: "r3_steers_bulls", nsc: kind === "beef_cattle" ? "rising_2" : "unsupported" },
  { kind, code: "r3_steers_bulls", name: "Rising three-year and older steers and bulls", birth: false, agesTo: null, nsc: kind === "beef_cattle" ? "mature" : "unsupported" },
  { kind, code: "breeding_bulls", name: "Breeding bulls", birth: false, agesTo: null, nsc: "unsupported", maleBreeding: true },
];

const deer = (kind: LivestockKind): LivestockClass[] => [
  { kind, code: "r1_hinds", name: "Rising one-year hinds", birth: true, agesTo: "r2_hinds", nsc: "rising_1" },
  { kind, code: "r2_hinds", name: "Rising two-year hinds", birth: false, agesTo: "ma_hinds", nsc: "mature" },
  { kind, code: "ma_hinds", name: "Mixed-age hinds", birth: false, agesTo: null, nsc: "mature" },
  { kind, code: "r1_stags", name: "Rising one-year stags", birth: true, agesTo: "r2_stags", nsc: "rising_1" },
  { kind, code: "r2_stags", name: "Rising two-year and older stags (non-breeding)", birth: false, agesTo: null, nsc: "mature" },
  { kind, code: "breeding_stags", name: "Breeding stags", birth: false, agesTo: null, nsc: "unsupported", maleBreeding: true },
];

const fibreGoats = (kind: LivestockKind): LivestockClass[] => [
  { kind, code: "r1_does", name: "Rising one-year does", birth: true, agesTo: "ma_does", nsc: "rising_1" },
  { kind, code: "ma_does", name: "Mixed-age does", birth: false, agesTo: null, nsc: "mature" },
  { kind, code: "r1_bucks_wethers", name: "Rising one-year bucks (non-breeding) and wethers", birth: true, agesTo: "bucks_wethers", nsc: "rising_1" },
  { kind, code: "bucks_wethers", name: "Bucks (non-breeding) and wethers over one year", birth: false, agesTo: null, nsc: "mature" },
  { kind, code: "breeding_bucks", name: "Breeding bucks", birth: false, agesTo: null, nsc: "unsupported", maleBreeding: true },
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
  ...deer("deer_red"),
  ...deer("deer_other"),
  ...fibreGoats("goats_angora"),
  ...fibreGoats("goats_cashmere"),
  { kind: "goats_dairy", code: "r1_does", name: "Rising one-year does", birth: true, agesTo: "does", nsc: "rising_1" },
  { kind: "goats_dairy", code: "does", name: "Does over one year", birth: false, agesTo: null, nsc: "mature" },
  { kind: "goats_dairy", code: "breeding_bucks", name: "Breeding bucks", birth: false, agesTo: null, nsc: "unsupported", maleBreeding: true },
  { kind: "goats_dairy", code: "culls", name: "Other dairy goats (culls)", birth: false, agesTo: null, nsc: "mature" },
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

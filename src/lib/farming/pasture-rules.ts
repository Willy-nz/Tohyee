import { add, dec, type Decimal, divide, isZero, mul, roundHalfUp, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * Pasture and feed figures (examples PF1-PF6, decision 559). Pure and
 * browser-safe. Records only: nothing judges a cover high or low, and no
 * feed plan or target is made.
 */

export const PASTURE_METHODS = ["plate_meter", "visual", "measured_other", "satellite", "model"] as const;
export type PastureMethod = (typeof PASTURE_METHODS)[number];
export const PASTURE_METHOD_LABELS: Record<PastureMethod, string> = {
  plate_meter: "Plate meter",
  visual: "Visual",
  measured_other: "Other measurement",
  satellite: "Satellite (estimate)",
  model: "Model (estimate)",
};
/** Satellite and model readings are estimates, labelled so everywhere (PF1). */
export const isEstimate = (method: PastureMethod) => method === "satellite" || method === "model";
export const MAX_COVER = 20000;

export const SUPPLEMENT_UNITS = ["kg_dm", "kg_as_fed", "t_as_fed", "bales", "other"] as const;
export type SupplementUnit = (typeof SUPPLEMENT_UNITS)[number];
export const SUPPLEMENT_UNIT_LABELS: Record<SupplementUnit, string> = {
  kg_dm: "kg DM",
  kg_as_fed: "kg as fed",
  t_as_fed: "tonnes as fed",
  bales: "bales",
  other: "other",
};

export type Reading = { id: string; paddockId: string; measuredOn: string; cover: number; method: PastureMethod };
export type Grazing = { paddockId: string; inOn: string; outOn: string | null };

export type Growth =
  | { kind: "rate"; from: string; to: string; kgDmPerHaPerDay: string }
  | { kind: "none"; from: string; to: string; reason: "grazed" | "different_methods" | "same_day" };

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Growth between each reading of a paddock and its previous one (PF2): the
 * rise ÷ days, half up to one place, only by the same method and with no
 * grazing overlapping the days between.
 */
export function growthBetween(earlier: Reading, later: Reading, grazings: Grazing[]): Growth {
  const span = { from: earlier.measuredOn, to: later.measuredOn };
  const length = days(earlier.measuredOn, later.measuredOn);
  if (length <= 0) return { kind: "none", ...span, reason: "same_day" };
  if (earlier.method !== later.method) return { kind: "none", ...span, reason: "different_methods" };
  // A grazing overlaps if it starts before the later reading and ends after the earlier one: a pre-grazing reading on the
  // day in, or a post-grazing reading on the day out, doesn't count it.
  const grazed = grazings.some((grazing) => grazing.paddockId === later.paddockId && grazing.inOn < later.measuredOn && (grazing.outOn === null || grazing.outOn > earlier.measuredOn));
  if (grazed) return { kind: "none", ...span, reason: "grazed" };
  const rate = roundHalfUp(divide(dec(String(later.cover - earlier.cover)), dec(String(length)), 6), 1);
  return { kind: "rate", ...span, kgDmPerHaPerDay: toFixedString(rate, 1) };
}

export type CoverPaddock = { paddockId: string; name: string; hectares: string | null; latest: Reading | null };

export type FarmCover = {
  onDate: string;
  /** Area-weighted average of the latest readings, to the kg; null with none. */
  averageKgDmPerHa: number | null;
  totalKgDm: number;
  hectares: string;
  oldestReading: string | null;
  estimates: number;
  readings: number;
  noReading: string[];
  noArea: string[];
  /** Highest cover first (PF4). */
  wedge: Array<{ paddockId: string; name: string; hectares: string; cover: number; measuredOn: string; method: PastureMethod; estimate: boolean }>;
};

/** Farm cover on a date from each paddock's latest reading on or before it (PF3, PF4). */
export function farmCover(onDate: string, paddocks: CoverPaddock[]): FarmCover {
  let total = ZERO_DECIMAL;
  let area = ZERO_DECIMAL;
  const noReading: string[] = [];
  const noArea: string[] = [];
  const wedge: FarmCover["wedge"] = [];
  for (const paddock of paddocks) {
    if (!paddock.latest) {
      noReading.push(paddock.name);
      continue;
    }
    if (paddock.hectares === null || isZero(dec(paddock.hectares))) {
      noArea.push(paddock.name);
      continue;
    }
    const ha = dec(paddock.hectares);
    total = add(total, mul(ha, dec(String(paddock.latest.cover))));
    area = add(area, ha);
    wedge.push({ paddockId: paddock.paddockId, name: paddock.name, hectares: paddock.hectares, cover: paddock.latest.cover, measuredOn: paddock.latest.measuredOn, method: paddock.latest.method, estimate: isEstimate(paddock.latest.method) });
  }
  wedge.sort((a, b) => b.cover - a.cover || a.name.localeCompare(b.name));
  const average = isZero(area) ? null : Number(toFixedString(roundHalfUp(divide(total, area, 6), 0), 0));
  return {
    onDate,
    averageKgDmPerHa: average,
    totalKgDm: Number(toFixedString(roundHalfUp(total, 0), 0)),
    hectares: toFixedString(area, 2),
    oldestReading: wedge.reduce<string | null>((oldest, entry) => (oldest === null || entry.measuredOn < oldest ? entry.measuredOn : oldest), null),
    estimates: wedge.filter((entry) => entry.estimate).length,
    readings: wedge.length,
    noReading,
    noArea,
    wedge,
  };
}

/** What a grazing ate (PF5): with both covers and the paddock's area; per head with a head count. */
export function grazingEaten(input: { preCover: number | null; postCover: number | null; hectares: string | null; head: number | null }): { perHa: number; totalKgDm: number | null; perHead: string | null } | null {
  if (input.preCover === null || input.postCover === null) return null;
  const perHa = input.preCover - input.postCover;
  if (input.hectares === null) return { perHa, totalKgDm: null, perHead: null };
  const total = roundHalfUp(mul(dec(String(perHa)), dec(input.hectares)), 0);
  const perHead = input.head && input.head > 0 ? toFixedString(roundHalfUp(divide(total, dec(String(input.head)), 6), 1), 1) : null;
  return { perHa, totalKgDm: Number(toFixedString(total, 0)), perHead };
}

export type SupplementLine = { fedOn: string; feed: string; quantity: string; unit: SupplementUnit; kgDm: string | null };

/** kg DM fed (PF6): a quantity in kg DM is its own kg DM; anything else counts only with its kg DM typed. */
export function supplementKgDm(line: SupplementLine): Decimal | null {
  if (line.unit === "kg_dm") return dec(line.quantity);
  return line.kgDm === null ? null : dec(line.kgDm);
}

export function supplementTotals(lines: SupplementLine[]): { kgDm: string; notCounted: SupplementLine[] } {
  let total = ZERO_DECIMAL;
  const notCounted: SupplementLine[] = [];
  for (const line of lines) {
    const kg = supplementKgDm(line);
    if (kg === null) notCounted.push(line);
    else total = add(total, kg);
  }
  return { kgDm: toFixedString(total, 2), notCounted };
}

/** A whole number of kg DM/ha from 0 to 20,000, or null (PF1, PF7). */
export function parseCover(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, "");
  if (!/^\d{1,5}$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value <= MAX_COVER ? value : null;
}


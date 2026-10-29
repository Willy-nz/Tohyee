import { abs, add, dec, type Decimal, divide, isZero, mul, roundHalfUp, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * Pasture and feed figures (examples PF1-PF6, decision 559). Pure and
 * browser-safe. Records only: nothing judges a cover high or low, and no
 * feed plan or target is made.
 */

/** The methods a person (or a file) gives a reading. */
export const PASTURE_METHODS = ["plate_meter", "visual", "measured_other", "satellite", "model"] as const;
/**
 * A reading made only when a person accepts an AI's estimate from a photo
 * (#503, decision 1162). Never typed or imported: only accepting makes one.
 */
export const PHOTO_ESTIMATE_METHOD = "photo_ai" as const;
export type PastureMethod = (typeof PASTURE_METHODS)[number] | typeof PHOTO_ESTIMATE_METHOD;
export const PASTURE_METHOD_LABELS: Record<PastureMethod, string> = {
  plate_meter: "Plate meter",
  visual: "Visual",
  measured_other: "Other measurement",
  satellite: "Satellite (estimate)",
  model: "Model (estimate)",
  photo_ai: "AI estimate from a photo, not measured",
};
/** Satellite, model and photo readings are estimates, labelled so everywhere (PF1, decision 1162). */
export const isEstimate = (method: PastureMethod) => method === "satellite" || method === "model" || method === PHOTO_ESTIMATE_METHOD;
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


// Photo estimates beside other readings (#503, decision 1166) -------------------------------------------

export const CALIBRATION_WINDOWS = [0, 1, 2, 3, 7] as const;
export const DEFAULT_CALIBRATION_WINDOW = 2;

export type CalibrationEstimate = { id: string; paddockId: string; takenOn: string; cover: number };
export type CalibrationReading = { id: string; paddockId: string; measuredOn: string; cover: number; method: PastureMethod };
export type CalibrationPair = { estimateId: string; readingId: string; paddockId: string; takenOn: string; measuredOn: string; estimate: number; reading: number; difference: number };
export type CalibrationGroup = {
  /** The other reading's method: each method is compared on its own. */
  method: PastureMethod;
  count: number;
  /** The average of estimate − reading, to the kg (negative: estimates were lower). */
  averageDifference: number;
  /** The average size of the difference, either way, to the kg. */
  averageGap: number;
  /** The most below and the most above (estimate − reading). */
  lowest: number;
  highest: number;
  pairs: CalibrationPair[];
};

/** A whole number of days from 0 to 14, or the default. */
export function parseCalibrationWindow(input: unknown): number | null {
  if (input === undefined || input === null || input === "") return DEFAULT_CALIBRATION_WINDOW;
  const value = Number(input);
  return Number.isInteger(value) && value >= 0 && value <= 14 ? value : null;
}

/**
 * Each photo estimate beside the nearest other reading of the same paddock
 * within `windowDays` of the photo's day, for each method on its own
 * (decision 1166): nearest first, then the reading on or before the photo,
 * then the latest recorded. Readings that are themselves from photos are
 * never compared. Nothing is adjusted: these are only the differences.
 */
export function calibrationPairs(estimates: CalibrationEstimate[], readings: CalibrationReading[], windowDays: number): Map<PastureMethod, CalibrationPair[]> {
  const groups = new Map<PastureMethod, CalibrationPair[]>();
  for (const estimate of estimates) {
    const best = new Map<PastureMethod, { reading: CalibrationReading; rank: [number, number, number] }>();
    for (const reading of readings) {
      if (reading.method === PHOTO_ESTIMATE_METHOD || reading.paddockId !== estimate.paddockId) continue;
      const offset = days(estimate.takenOn, reading.measuredOn);
      if (Math.abs(offset) > windowDays) continue;
      // Lower is better: nearest, then on or before the photo, then the latest recorded.
      const rank: [number, number, number] = [Math.abs(offset), offset > 0 ? 1 : 0, -Number(reading.id)];
      const current = best.get(reading.method);
      if (!current || (rank[0] - current.rank[0] || rank[1] - current.rank[1] || rank[2] - current.rank[2]) < 0) best.set(reading.method, { reading, rank });
    }
    for (const [method, { reading }] of best) {
      const pair: CalibrationPair = { estimateId: estimate.id, readingId: reading.id, paddockId: estimate.paddockId, takenOn: estimate.takenOn, measuredOn: reading.measuredOn, estimate: estimate.cover, reading: reading.cover, difference: estimate.cover - reading.cover };
      groups.set(method, [...(groups.get(method) ?? []), pair]);
    }
  }
  return groups;
}

/** The average and spread of the differences, by method, most checks first (decision 1166). */
export function calibrationSummary(estimates: CalibrationEstimate[], readings: CalibrationReading[], windowDays: number): CalibrationGroup[] {
  const result: CalibrationGroup[] = [];
  for (const [method, pairs] of calibrationPairs(estimates, readings, windowDays)) {
    const count = dec(String(pairs.length));
    let total = ZERO_DECIMAL;
    let totalGap = ZERO_DECIMAL;
    for (const pair of pairs) {
      total = add(total, dec(String(pair.difference)));
      totalGap = add(totalGap, abs(dec(String(pair.difference))));
    }
    const whole = (value: Decimal) => Number(toFixedString(roundHalfUp(divide(value, count, 6), 0), 0));
    result.push({
      method,
      count: pairs.length,
      averageDifference: whole(total),
      averageGap: whole(totalGap),
      lowest: Math.min(...pairs.map((pair) => pair.difference)),
      highest: Math.max(...pairs.map((pair) => pair.difference)),
      pairs: [...pairs].sort((a, b) => b.takenOn.localeCompare(a.takenOn) || a.paddockId.localeCompare(b.paddockId)),
    });
  }
  return result.sort((a, b) => b.count - a.count || a.method.localeCompare(b.method));
}

const kg = (value: number) => `${Math.abs(value).toLocaleString("en-NZ")} kg DM/ha`;

/**
 * The group in plain, neutral words: "Photo estimates were 180 kg DM/ha
 * lower than plate meter readings on average, over 12 checks within 2 days.
 * The differences ran from 420 lower to 90 higher; an estimate was 230
 * kg DM/ha away on average." Says how many checks, never good or bad.
 */
export function calibrationText(group: CalibrationGroup, windowDays: number): string {
  const what = PASTURE_METHOD_LABELS[group.method].replace(/ \(estimate\)$/, "").toLowerCase();
  const checks = `${group.count} check${group.count === 1 ? "" : "s"} within ${windowDays === 0 ? "the same day" : `${windowDays} day${windowDays === 1 ? "" : "s"}`}`;
  const side = (value: number) => (value === 0 ? "the same" : `${kg(value)} ${value < 0 ? "lower" : "higher"}`);
  const average = group.averageDifference === 0 ? `Photo estimates were the same as ${what} readings on average` : `Photo estimates were ${side(group.averageDifference)} than ${what} readings on average`;
  if (group.count === 1) return `${average}, over ${checks}.`;
  const range = group.lowest === group.highest ? `Every difference was ${side(group.lowest)}.` : `The differences ran from ${side(group.lowest)} to ${side(group.highest)}; an estimate was ${kg(group.averageGap)} away on average.`;
  return `${average}, over ${checks}. ${range}`;
}

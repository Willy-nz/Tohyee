/**
 * Modelled pasture cover from satellite greenness (#612 phase 3, MCV1-MCV8,
 * decision 1596). Pure: pairs of a measured cover reading and the same
 * paddock's greenness (NDVI) a few days apart are fitted with a straight
 * line, and the line is checked on satellite dates it wasn't fitted on
 * (leave one date out), by season, and on the organisation's other farms.
 * Exact arithmetic (decimal.ts), as for every quantity in Tohyee.
 *
 * Nothing here decides anything: it says how far off the line has been, and
 * a person decides whether that's good enough to show.
 */
import { abs, add, cmp, dec, divide, isZero, mul, roundHalfUp, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/** A measured reading and a clear satellite view of the same paddock close enough in time to compare (MCV2). */
export type CoverPair = { farmId: string; paddockId: string; sceneId: string; imageOn: string; measuredOn: string; ndvi: string; cover: number };

/** A reading and a view at most this many days apart are paired (MCV2). */
export const PAIR_DAYS = 3;
/** At least this many pairs, on this many satellite dates, before a line is offered (MCV4). */
export const MIN_PAIRS = 12;
export const MIN_DATES = 4;
/** Estimates are rounded to this many kg DM/ha: they aren't more exact than that. */
export const ROUND_TO = 10;

export type Line = { intercept: string; slope: string };

export type Season = "summer" | "autumn" | "winter" | "spring";
export const SEASON_WORDS: Record<Season, string> = { summer: "Summer (Dec-Feb)", autumn: "Autumn (Mar-May)", winter: "Winter (Jun-Aug)", spring: "Spring (Sep-Nov)" };

/** The season of a date, as New Zealand counts them (MCV5). */
export function seasonOf(date: string): Season {
  const month = Number(date.slice(5, 7));
  if (month === 12 || month <= 2) return "summer";
  if (month <= 5) return "autumn";
  if (month <= 8) return "winter";
  return "spring";
}

/** Least squares: cover = intercept + slope × NDVI. Null when the greenness doesn't vary (nothing to fit). */
export function fitLine(pairs: readonly Pick<CoverPair, "ndvi" | "cover">[]): Line | null {
  if (pairs.length < 2) return null;
  const n = dec(String(pairs.length));
  const xs = pairs.map((pair) => dec(pair.ndvi));
  const ys = pairs.map((pair) => dec(String(pair.cover)));
  const meanX = divide(sum(xs), n, 12);
  const meanY = divide(sum(ys), n, 12);
  let sxy = ZERO_DECIMAL;
  let sxx = ZERO_DECIMAL;
  xs.forEach((x, index) => {
    const dx = sub(x, meanX);
    sxy = add(sxy, mul(dx, sub(ys[index], meanY)));
    sxx = add(sxx, mul(dx, dx));
  });
  if (isZero(roundHalfUp(sxx, 8))) return null;
  const slope = divide(sxy, sxx, 8);
  const intercept = sub(meanY, mul(slope, meanX));
  return { intercept: toFixedString(roundHalfUp(intercept, 4), 4), slope: toFixedString(slope, 4) };
}

/** The line's cover for a greenness, rounded to ten and never below nothing. */
export function predict(line: Line, ndvi: string): number {
  const raw = add(dec(line.intercept), mul(dec(line.slope), dec(ndvi)));
  const tens = roundHalfUp(divide(raw, dec(String(ROUND_TO)), 6), 0);
  const value = Number(toFixedString(mul(tens, dec(String(ROUND_TO))), 0));
  return value < 0 ? 0 : value;
}

export type ErrorSummary = {
  pairs: number;
  /** Average of how far off, either way (kg DM/ha). */
  meanError: number;
  /** Average of estimate minus measured: positive reads high (kg DM/ha). */
  bias: number;
  /** Nine in ten were off by this much or less (kg DM/ha): the band shown with an estimate. */
  likelyWithin: number;
};

/** How far off a set of (estimate, measured) were. */
export function summarise(results: readonly { predicted: number; measured: number }[]): ErrorSummary | null {
  if (results.length === 0) return null;
  const n = dec(String(results.length));
  const errors = results.map((result) => sub(dec(String(result.predicted)), dec(String(result.measured))));
  const sizes = errors.map(abs).sort(cmp);
  // The 90th percentile, nearest rank: the smallest error at least 90% of the pairs are within.
  const rank = Math.max(1, Math.ceil((90 * results.length) / 100));
  return {
    pairs: results.length,
    meanError: Number(toFixedString(roundHalfUp(divide(sum(sizes), n, 4), 0), 0)),
    bias: Number(toFixedString(roundHalfUp(divide(sum(errors), n, 4), 0), 0)),
    likelyWithin: Number(toFixedString(sizes[rank - 1], 0)),
  };
}

export type Validation = {
  line: Line | null;
  pairs: number;
  dates: number;
  ndviRange: { min: string; max: string } | null;
  /** Each satellite date left out in turn, the line fitted without it (MCV3). */
  withheldDates: ErrorSummary | null;
  bySeason: Array<{ season: Season } & ErrorSummary>;
  /** Fitted on the organisation's other farms, checked on this one (MCV3); null with no other farm's readings. */
  otherFarms: ErrorSummary | null;
  /** Why no line is offered yet, if not. */
  notReady: string | null;
};

/**
 * MCV3-MCV5: the farm's line and how it did on dates and farms it wasn't
 * fitted on. `others` are the organisation's other farms' pairs, used only
 * for the other-farms check.
 */
export function validate(pairs: readonly CoverPair[], others: readonly CoverPair[] = []): Validation {
  const dates = [...new Set(pairs.map((pair) => pair.sceneId))];
  const ndvis = pairs.map((pair) => dec(pair.ndvi)).sort(cmp);
  const range = ndvis.length > 0 ? { min: toFixedString(ndvis[0], 4), max: toFixedString(ndvis[ndvis.length - 1], 4) } : null;
  const empty = { pairs: pairs.length, dates: dates.length, ndviRange: range, withheldDates: null, bySeason: [], otherFarms: null };
  if (pairs.length < MIN_PAIRS || dates.length < MIN_DATES) {
    return {
      ...empty,
      line: null,
      notReady: `It needs at least ${MIN_PAIRS} measured readings on at least ${MIN_DATES} satellite dates, each within ${PAIR_DAYS} days of a clear view of the same paddock. So far: ${pairs.length} on ${dates.length}.`,
    };
  }
  const line = fitLine(pairs);
  if (!line) return { ...empty, line: null, notReady: "The paddocks' greenness hardly varies across the readings, so there's nothing to fit a line to yet." };

  const withheld: Array<{ predicted: number; measured: number; season: Season }> = [];
  for (const sceneId of dates) {
    const rest = pairs.filter((pair) => pair.sceneId !== sceneId);
    const fitted = fitLine(rest);
    if (!fitted) continue;
    for (const pair of pairs.filter((candidate) => candidate.sceneId === sceneId)) {
      withheld.push({ predicted: predict(fitted, pair.ndvi), measured: pair.cover, season: seasonOf(pair.imageOn) });
    }
  }
  const bySeason = (["summer", "autumn", "winter", "spring"] as Season[]).flatMap((season) => {
    const summary = summarise(withheld.filter((result) => result.season === season));
    return summary ? [{ season, ...summary }] : [];
  });
  const otherLine = fitLine(others);
  const otherFarms = otherLine && others.length >= MIN_PAIRS ? summarise(pairs.map((pair) => ({ predicted: predict(otherLine, pair.ndvi), measured: pair.cover }))) : null;
  return { ...empty, line, withheldDates: summarise(withheld), bySeason, otherFarms, notReady: null };
}

export type ModelledCover = { cover: number; low: number; high: number; outsideRange: boolean };

/** An estimate with its band (MCV6): never below nothing, and flagged when the greenness is outside what the line was checked on. */
export function modelledCover(model: { line: Line; likelyWithin: number; ndviMin: string; ndviMax: string }, ndvi: string): ModelledCover {
  const cover = predict(model.line, ndvi);
  const value = dec(ndvi);
  return {
    cover,
    low: Math.max(0, cover - model.likelyWithin),
    high: cover + model.likelyWithin,
    outsideRange: cmp(value, dec(model.ndviMin)) < 0 || cmp(value, dec(model.ndviMax)) > 0,
  };
}

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
export type CoverPair = {
  farmId: string;
  paddockId: string;
  sceneId: string;
  imageOn: string;
  measuredOn: string;
  ndvi: string;
  cover: number;
  /** Rain (mm) and mean temperature (°C) in the 14 days before the picture (MCV9), when known. */
  rain14?: string | null;
  temperature14?: string | null;
};

/** A reading and a view at most this many days apart are paired (MCV2). */
export const PAIR_DAYS = 3;
/** At least this many pairs, on this many satellite dates, before a line is offered (MCV4). */
export const MIN_PAIRS = 12;
export const MIN_DATES = 4;
/** Estimates are rounded to this many kg DM/ha: they aren't more exact than that. */
export const ROUND_TO = 10;

export type Line = { intercept: string; slope: string; rain?: string; temperature?: string };
export type Terms = "greenness" | "rain" | "rain_temperature";
export const TERMS_WORDS: Record<Terms, string> = { greenness: "Greenness only", rain: "Greenness and rain", rain_temperature: "Greenness, rain and temperature" };

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

/**
 * MCV9: least squares with greenness and the weather before the picture, by
 * the normal equations solved exactly. Null when they can't be told apart.
 */
export function fitWithWeather(pairs: readonly CoverPair[], terms: Exclude<Terms, "greenness">): Line | null {
  const rows = pairs.map((pair) => {
    const x = [dec("1"), dec(pair.ndvi), dec(pair.rain14!)];
    if (terms === "rain_temperature") x.push(dec(pair.temperature14!));
    return { x, y: dec(String(pair.cover)) };
  });
  const k = rows[0]?.x.length ?? 0;
  if (rows.length <= k) return null;
  // The augmented normal equations [XᵀX | Xᵀy], solved by Gauss-Jordan elimination.
  const m = Array.from({ length: k }, (_, i) => [
    ...Array.from({ length: k }, (_, j) => sum(rows.map((row) => mul(row.x[i], row.x[j])))),
    sum(rows.map((row) => mul(row.x[i], row.y))),
  ]);
  for (let col = 0; col < k; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < k; row += 1) if (cmp(abs(m[row][col]), abs(m[pivot][col])) > 0) pivot = row;
    if (isZero(roundHalfUp(m[pivot][col], 6))) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const lead = m[col][col];
    m[col] = m[col].map((value) => divide(value, lead, 14));
    for (let row = 0; row < k; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      m[row] = m[row].map((value, j) => sub(value, mul(factor, m[col][j])));
    }
  }
  const coefficient = (i: number) => toFixedString(roundHalfUp(m[i][k], 4), 4);
  return { intercept: coefficient(0), slope: coefficient(1), rain: coefficient(2), ...(terms === "rain_temperature" ? { temperature: coefficient(3) } : {}) };
}

/** The line's cover for a greenness (and the weather, if it uses it), rounded to ten and never below nothing. */
export function predict(line: Line, ndvi: string, weather: { rain14?: string | null; temperature14?: string | null } = {}): number {
  let raw = add(dec(line.intercept), mul(dec(line.slope), dec(ndvi)));
  if (line.rain !== undefined) raw = add(raw, mul(dec(line.rain), dec(weather.rain14 ?? "0")));
  if (line.temperature !== undefined) raw = add(raw, mul(dec(line.temperature), dec(weather.temperature14 ?? "0")));
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
  /**
   * MCV9: the same check with the weather before each picture, on the readings whose weather is known, beside
   * greenness alone on those same readings. Null when too few readings have their weather known.
   */
  weather: {
    pairs: number;
    dates: number;
    greennessOnly: ErrorSummary;
    options: Array<{ terms: Exclude<Terms, "greenness">; line: Line; withheldDates: ErrorSummary }>;
    /** The terms that did best on dates they weren't fitted on: greenness alone unless the weather did better. */
    best: Terms;
  } | null;
  /** Readings whose weather isn't known yet (MCV9). */
  weatherMissing: number;
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
  const weatherMissing = pairs.filter((pair) => pair.rain14 === null || pair.rain14 === undefined).length;
  const empty = { pairs: pairs.length, dates: dates.length, ndviRange: range, withheldDates: null, bySeason: [], otherFarms: null, weather: null, weatherMissing };
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
  return { ...empty, line, withheldDates: summarise(withheld), bySeason, otherFarms, notReady: null, weather: weatherCheck(pairs) };
}

/** Each satellite date left out in turn, with a fitter: the errors on the dates left out. */
function leaveDatesOut(pairs: readonly CoverPair[], fit: (rest: readonly CoverPair[]) => Line | null): Array<{ predicted: number; measured: number }> {
  const out: Array<{ predicted: number; measured: number }> = [];
  for (const sceneId of new Set(pairs.map((pair) => pair.sceneId))) {
    const fitted = fit(pairs.filter((pair) => pair.sceneId !== sceneId));
    if (!fitted) continue;
    for (const pair of pairs.filter((candidate) => candidate.sceneId === sceneId)) out.push({ predicted: predict(fitted, pair.ndvi, pair), measured: pair.cover });
  }
  return out;
}

/**
 * MCV9: greenness alone against greenness with rain (and temperature), on the
 * same readings and the same left-out dates. The weather is used only when
 * it was off by less on average.
 */
function weatherCheck(pairs: readonly CoverPair[]): Validation["weather"] {
  const known = pairs.filter((pair) => pair.rain14 !== null && pair.rain14 !== undefined);
  const dates = new Set(known.map((pair) => pair.sceneId)).size;
  if (known.length < MIN_PAIRS || dates < MIN_DATES) return null;
  const greennessOnly = summarise(leaveDatesOut(known, fitLine));
  if (!greennessOnly) return null;
  const options: NonNullable<Validation["weather"]>["options"] = [];
  const candidates: Array<{ terms: Exclude<Terms, "greenness">; pairs: readonly CoverPair[] }> = [{ terms: "rain", pairs: known }];
  const withTemperature = known.filter((pair) => pair.temperature14 !== null && pair.temperature14 !== undefined);
  if (withTemperature.length === known.length) candidates.push({ terms: "rain_temperature", pairs: known });
  for (const candidate of candidates) {
    const line = fitWithWeather(candidate.pairs, candidate.terms);
    const withheldDates = summarise(leaveDatesOut(candidate.pairs, (rest) => fitWithWeather(rest, candidate.terms)));
    if (line && withheldDates) options.push({ terms: candidate.terms, line, withheldDates });
  }
  let best: Terms = "greenness";
  let bestError = greennessOnly.meanError;
  for (const option of options) {
    if (option.withheldDates.meanError < bestError) {
      best = option.terms;
      bestError = option.withheldDates.meanError;
    }
  }
  return { pairs: known.length, dates, greennessOnly, options, best };
}

export type ModelledCover = { cover: number; low: number; high: number; outsideRange: boolean };

/** An estimate with its band (MCV6): never below nothing, and flagged when the greenness is outside what the line was checked on. */
export function modelledCover(
  model: { line: Line; likelyWithin: number; ndviMin: string; ndviMax: string },
  ndvi: string,
  weather: { rain14?: string | null; temperature14?: string | null } = {},
): ModelledCover | null {
  // A line that uses the weather needs it for this date.
  if (model.line.rain !== undefined && (weather.rain14 === null || weather.rain14 === undefined)) return null;
  if (model.line.temperature !== undefined && (weather.temperature14 === null || weather.temperature14 === undefined)) return null;
  const cover = predict(model.line, ndvi, weather);
  const value = dec(ndvi);
  return {
    cover,
    low: Math.max(0, cover - model.likelyWithin),
    high: cover + model.likelyWithin,
    outsideRange: cmp(value, dec(model.ndviMin)) < 0 || cmp(value, dec(model.ndviMax)) > 0,
  };
}

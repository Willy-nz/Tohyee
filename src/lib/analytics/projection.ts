import type { Grain } from "@/lib/analytics/query";

/**
 * Linear projection (#387, decision 692): a chart's straight-line trend
 * carried on past the last date shown. It was labelled "Forecast"; it is not
 * a forecast of the books (that's the cash flow forecast), and it is only
 * drawn on a series it can be honest about:
 *
 * - The groups are dates at one grain (day, week, month, quarter or year),
 *   oldest first. Groups that aren't dates, dates sorted by value or newest
 *   first, and blank dates are refused, with the reason shown on the chart.
 * - The tile doesn't keep only its top N groups, and its answer wasn't cut
 *   short: either would leave periods out without saying so.
 * - Missing periods between the first and last are put back as gaps: on the
 *   axis, with no value (never zero), and left out of the fit, so the line is
 *   fitted on real time positions. The chart says how many were missing.
 * - At least two periods have a value.
 *
 * The projected periods run on at the grain itself (the next months, the
 * next weeks), so their labels never imply a spacing the data doesn't have.
 */

export const PROJECTION_GRAINS: Grain[] = ["day", "week", "month", "quarter", "year"];

/** What the chart knows about where its groups came from (the tile's question and its answer). */
export type ProjectionSource = {
  /** The date grain the tile groups by; null when it groups by something else. Left out: worked out from the dates. */
  grain?: Grain | null;
  sort?: { by: "category" | "value"; direction: "asc" | "desc" };
  /** The tile's Top N. */
  limit?: number | null;
  /** The answer was cut at the row limit. */
  truncated?: boolean;
};

export type ProjectionPlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      grain: Grain;
      /** Every period from the first to the last, oldest first, with any missing ones put back. */
      periods: string[];
      /** Periods put back because the data had nothing for them. */
      missing: string[];
      /** The projected periods after the last one. */
      future: string[];
    };

/** At most this many periods between the first and last (a daily chart over many years is refused, not drawn as a wall of gaps). */
const MAX_PERIODS = 5000;

const GRAIN_NAMES: Record<Grain, [string, string]> = {
  day: ["day", "days"],
  week: ["week", "weeks"],
  month: ["month", "months"],
  quarter: ["quarter", "quarters"],
  year: ["year", "years"],
};

export function periodName(grain: Grain, count: number): string {
  return `${count} ${GRAIN_NAMES[grain][count === 1 ? 0 : 1]}`;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function utc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** The date `count` periods on from `value` (which starts a period). */
export function addPeriods(value: string, grain: Grain, count: number): string {
  const date = utc(value);
  if (grain === "day") date.setUTCDate(date.getUTCDate() + count);
  else if (grain === "week") date.setUTCDate(date.getUTCDate() + 7 * count);
  else date.setUTCMonth(date.getUTCMonth() + count * (grain === "month" ? 1 : grain === "quarter" ? 3 : 12));
  return date.toISOString().slice(0, 10);
}

/** Whether a date is the start of a period at this grain (weeks start on Monday, as DuckDB's date_trunc). */
function startsPeriod(value: string, grain: Grain): boolean {
  const date = utc(value);
  if (grain === "day") return true;
  if (grain === "week") return date.getUTCDay() === 1;
  if (date.getUTCDate() !== 1) return false;
  if (grain === "month") return true;
  if (grain === "quarter") return date.getUTCMonth() % 3 === 0;
  return date.getUTCMonth() === 0;
}

/** The coarsest grain every date starts a period of (a chart whose tile isn't known). */
function inferGrain(dates: string[]): Grain {
  for (const grain of ["year", "quarter", "month", "week"] as const) {
    if (dates.every((value) => startsPeriod(value, grain))) {
      // Only a year (or quarter) apart where the dates say so: 1 Jan 2026 and 1 Jan 2027 are years, 1 Jan and 1 Apr are quarters.
      if (grain === "year" && !dates.every((value, index) => index === 0 || utc(value).getUTCFullYear() !== utc(dates[index - 1]).getUTCFullYear())) continue;
      if (grain === "quarter" && dates.some((value, index) => index > 0 && monthsBetween(dates[index - 1], value) % 3 !== 0)) continue;
      if (grain === "week" && dates.some((value, index) => index > 0 && (utc(value).getTime() - utc(dates[index - 1]).getTime()) % (7 * 86400000) !== 0)) continue;
      return grain;
    }
  }
  return "day";
}

function monthsBetween(from: string, to: string): number {
  const a = utc(from);
  const b = utc(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
}

/**
 * Whether a projection can be drawn on these groups (in the order the chart
 * has them), and if so the periods to draw. `usable` says, for each group,
 * whether any value projected has a number there.
 */
export function projectionPlan(categories: unknown[], usable: boolean[], length: number, source: ProjectionSource = {}): ProjectionPlan {
  if (source.grain === null) return { ok: false, reason: "it needs the chart grouped by a date (by day, week, month, quarter or year)" };
  if (source.limit) return { ok: false, reason: `the tile keeps only its top ${source.limit} groups, so some periods are left out` };
  if (source.truncated) return { ok: false, reason: "the answer was cut short at the row limit, so later periods are missing" };
  if (source.sort?.by === "value") return { ok: false, reason: "the groups are sorted by value, not by date" };
  if (source.sort?.direction === "desc") return { ok: false, reason: "the dates are newest first; sort them oldest first" };
  if (categories.some((value) => value === null || value === undefined || value === "")) return { ok: false, reason: "some rows have no date" };
  if (!categories.every(isIsoDate)) return { ok: false, reason: "it needs the chart grouped by a date (by day, week, month, quarter or year)" };
  const dates = categories as string[];
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index] <= dates[index - 1]) return { ok: false, reason: "the dates aren't in order, oldest first" };
  }
  const grain = source.grain ?? inferGrain(dates);
  if (!dates.every((value) => startsPeriod(value, grain))) return { ok: false, reason: `the dates don't each start a ${GRAIN_NAMES[grain][0]}` };
  if (usable.filter(Boolean).length < 2) return { ok: false, reason: "it needs at least two periods with a value" };

  const periods: string[] = [];
  const seen = new Set(dates);
  const missing: string[] = [];
  for (let period = dates[0]; period <= dates[dates.length - 1]; period = addPeriods(period, grain, 1)) {
    periods.push(period);
    if (!seen.has(period)) missing.push(period);
    if (periods.length > MAX_PERIODS) return { ok: false, reason: `there are more than ${MAX_PERIODS.toLocaleString("en-NZ")} periods from the first date to the last` };
  }
  const last = periods[periods.length - 1];
  const future = Array.from({ length }, (_unused, index) => addPeriods(last, grain, index + 1));
  return { ok: true, grain, periods, missing, future };
}

/** The sentence under a chart about its projection: what's drawn, or why it isn't. */
export function projectionNote(plan: ProjectionPlan, length: number): string {
  if (!plan.ok) return `Linear projection not shown: ${plan.reason}.`;
  const gaps = plan.missing.length
    ? ` ${periodName(plan.grain, plan.missing.length)} with no data ${plan.missing.length === 1 ? "is" : "are"} shown as a gap, not zero, and left out of the line.`
    : "";
  return `Linear projection: the straight-line trend of the dates shown, carried on ${periodName(plan.grain, length)} (shaded). It isn't a forecast of the books; for that, see the cash flow forecast.${gaps}`;
}

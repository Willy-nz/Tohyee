/**
 * Opportunity stages, probability and forecast figures (examples
 * CRMS1-CRMS10), after Salesforce's stage types, forecast categories and
 * cumulative forecast rollups (decisions 76-90).
 *
 * Browser-safe: no server imports, so screens can use the same rules.
 */
import { add, cmp, dec, type Decimal, divide, mul, mulDiv, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

export const STAGE_TYPES = ["open", "won", "lost"] as const;
export type StageType = (typeof STAGE_TYPES)[number];
export const STAGE_TYPE_LABELS: Record<StageType, string> = { open: "Open", won: "Closed won", lost: "Closed lost" };

export const FORECAST_CATEGORIES = ["pipeline", "best_case", "commit", "closed", "omitted"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];
export const FORECAST_CATEGORY_LABELS: Record<ForecastCategory, string> = {
  pipeline: "Pipeline",
  best_case: "Best case",
  commit: "Commit",
  closed: "Closed",
  omitted: "Omitted",
};

/** An organisation's opportunity stage (CRMS2). */
export type OpportunityStageSetup = {
  id: string;
  /** Fixed, like Salesforce's API name; opportunities and the API use it (decision 77). */
  key: string;
  name: string;
  sortOrder: number;
  type: StageType;
  /** Default probability, a whole per cent 0-100. */
  probability: number;
  forecastCategory: ForecastCategory;
  isActive: boolean;
  /** How many opportunities are in it. */
  opportunityCount: number;
};

export const MAX_STAGE_NAME = 40;

export function isStageType(value: unknown): value is StageType {
  return typeof value === "string" && (STAGE_TYPES as readonly string[]).includes(value);
}

export function isForecastCategory(value: unknown): value is ForecastCategory {
  return typeof value === "string" && (FORECAST_CATEGORIES as readonly string[]).includes(value);
}

/** A probability typed or sent: a whole number from 0 to 100, else null. */
export function parseProbability(input: unknown): number | null {
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim().replace(/%$/, "").trim() : "";
  if (!/^\d{1,3}$/.test(text)) return null;
  const value = Number(text);
  return value >= 0 && value <= 100 ? value : null;
}

/**
 * What's wrong with a stage's own probability and forecast category for its
 * type (decision 79), or null: Closed won is 100% Closed, Closed lost is 0%
 * Omitted, Open is never Closed.
 */
export function stageRuleProblem(type: StageType, probability: number, category: ForecastCategory): string | null {
  if (type === "won" && (probability !== 100 || category !== "closed")) return "A Closed won stage is 100% and in the Closed forecast category.";
  if (type === "lost" && (probability !== 0 || category !== "omitted")) return "A Closed lost stage is 0% and in the Omitted forecast category.";
  if (type === "open" && category === "closed") return "Only a Closed won stage can be in the Closed forecast category.";
  return null;
}

/** The same rule for an opportunity in a stage of this type (CRMS5). */
export function opportunityRuleProblem(type: StageType, probability: number, category: ForecastCategory): string | null {
  if (type === "won" && (probability !== 100 || category !== "closed")) return "A won opportunity is 100% and in the Closed forecast category.";
  if (type === "lost" && (probability !== 0 || category !== "omitted")) return "A lost opportunity is 0% and in the Omitted forecast category.";
  if (type === "open" && category === "closed") return "Only a won opportunity can be in the Closed forecast category.";
  return null;
}

/** The forecast categories an opportunity in a stage of this type can be in. */
export function categoriesFor(type: StageType): ForecastCategory[] {
  if (type === "won") return ["closed"];
  if (type === "lost") return ["omitted"];
  return ["pipeline", "best_case", "commit", "omitted"];
}

/** A key for a new stage made from its name (decision 77): "Negotiation/review" -> "negotiation_review". */
export function stageKeyFrom(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30)
    .replace(/_+$/g, "");
  return /^[a-z]/.test(slug) ? slug : `stage_${slug}`.replace(/_+$/g, "");
}

/** Amount × probability, rounded half up to the currency's smallest unit (decision 88). */
export function weightedAmount(amount: string, probability: number, minorUnits: number): string {
  return toFixedString(mulDiv(dec(amount), dec(String(probability)), dec("100"), minorUnits), minorUnits);
}

/** What the forecast adds up for one opportunity. */
export type ForecastItem = {
  amount: string;
  /** Already rounded (weightedAmount). */
  weightedAmount: string;
  forecastCategory: ForecastCategory;
  stageType: StageType;
};

export const FORECAST_MEASURES = ["closed", "commit", "bestCase", "pipeline", "weighted"] as const;
export type ForecastMeasure = (typeof FORECAST_MEASURES)[number];
export const FORECAST_MEASURE_LABELS: Record<ForecastMeasure, string> = {
  closed: "Closed",
  commit: "Commit",
  bestCase: "Best case",
  pipeline: "Open pipeline",
  weighted: "Weighted pipeline",
};

/**
 * Whether an opportunity counts toward a forecast figure: Salesforce's
 * cumulative rollups (decision 85). Closed = Closed; Commit = Commit +
 * Closed; Best case = Best case + Commit + Closed; Open pipeline = Pipeline
 * + Best case + Commit on open opportunities; Weighted = open and not
 * Omitted. Omitted is in none.
 */
export function inMeasure(item: Pick<ForecastItem, "forecastCategory" | "stageType">, measure: ForecastMeasure): boolean {
  const category = item.forecastCategory;
  switch (measure) {
    case "closed":
      return category === "closed";
    case "commit":
      return category === "commit" || category === "closed";
    case "bestCase":
      return category === "best_case" || category === "commit" || category === "closed";
    case "pipeline":
    case "weighted":
      return item.stageType === "open" && (category === "pipeline" || category === "best_case" || category === "commit");
  }
}

export type ForecastFigures = Record<ForecastMeasure, string> & { count: number };

/** The forecast figures for a set of opportunities in one currency. */
export function forecastFigures(items: readonly ForecastItem[], minorUnits: number): ForecastFigures {
  const totals: Record<ForecastMeasure, Decimal> = { closed: ZERO_DECIMAL, commit: ZERO_DECIMAL, bestCase: ZERO_DECIMAL, pipeline: ZERO_DECIMAL, weighted: ZERO_DECIMAL };
  for (const item of items) {
    for (const measure of FORECAST_MEASURES) {
      if (!inMeasure(item, measure)) continue;
      totals[measure] = add(totals[measure], dec(measure === "weighted" ? item.weightedAmount : item.amount));
    }
  }
  return {
    closed: toFixedString(totals.closed, minorUnits),
    commit: toFixedString(totals.commit, minorUnits),
    bestCase: toFixedString(totals.bestCase, minorUnits),
    pipeline: toFixedString(totals.pipeline, minorUnits),
    weighted: toFixedString(totals.weighted, minorUnits),
    count: items.length,
  };
}

/** Closed ÷ quota as a percentage to 2 decimal places, half up; null without a quota (decision 89). */
export function attainment(closed: string, quota: string | null): string | null {
  if (quota === null || cmp(dec(quota), ZERO_DECIMAL) <= 0) return null;
  return toFixedString(divide(mul(dec(closed), dec("100")), dec(quota), 2), 2);
}

export const FORECAST_PERIODS = ["month", "quarter"] as const;
export type ForecastPeriodKind = (typeof FORECAST_PERIODS)[number];

export type ForecastPeriod = { start: string; end: string; label: string };

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ymd(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function monthsAfter(start: string, months: number): string {
  return ymd(Number(start.slice(0, 4)), Number(start.slice(5, 7)) + months, 1);
}

/**
 * The month or quarter a date is in (decision 86). Quarters are three
 * months of the financial year, which starts the month after
 * `yearEndMonth`: with a March year end, Oct-Dec is a quarter; with a May
 * year end, Sep-Nov is.
 */
export function periodContaining(date: string, kind: ForecastPeriodKind, yearEndMonth: number): ForecastPeriod {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  let startYear = year;
  let startMonth = month;
  if (kind === "quarter") {
    const firstMonth = (yearEndMonth % 12) + 1;
    const offset = (((month - firstMonth) % 12) + 12) % 12;
    const back = offset % 3;
    startMonth = month - back;
    if (startMonth < 1) {
      startMonth += 12;
      startYear -= 1;
    }
  }
  const start = ymd(startYear, startMonth, 1);
  return periodFrom(start, kind);
}

function periodFrom(start: string, kind: ForecastPeriodKind): ForecastPeriod {
  const length = kind === "quarter" ? 3 : 1;
  const next = monthsAfter(start, length);
  const end = ymd(Number(next.slice(0, 4)), Number(next.slice(5, 7)), 0);
  const first = `${SHORT_MONTHS[Number(start.slice(5, 7)) - 1]}`;
  const last = `${SHORT_MONTHS[Number(end.slice(5, 7)) - 1]}`;
  const label = kind === "month" ? `${first} ${start.slice(0, 4)}` : start.slice(0, 4) === end.slice(0, 4) ? `${first}-${last} ${start.slice(0, 4)}` : `${first} ${start.slice(0, 4)}-${last} ${end.slice(0, 4)}`;
  return { start, end, label };
}

/** `count` periods in a row, starting with the one containing `from`. */
export function forecastPeriods(from: string, kind: ForecastPeriodKind, count: number, yearEndMonth: number): ForecastPeriod[] {
  const periods: ForecastPeriod[] = [periodContaining(from, kind, yearEndMonth)];
  while (periods.length < count) periods.push(periodFrom(monthsAfter(periods.at(-1)!.start, kind === "quarter" ? 3 : 1), kind));
  return periods;
}

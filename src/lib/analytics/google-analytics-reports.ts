import { dec, roundHalfUp, toFixedString, toPlainString } from "@/lib/money/decimal";
import { ValidationError } from "@/lib/errors";

/**
 * Google Analytics (GA4) website data in Analytics (decisions 606-609;
 * examples GA1-GA8): which daily reports are asked of Google's Data API
 * (`runReport`) and how each answer becomes a table in the organisation's
 * analytics copy. Pure, so it can be tested without Google.
 *
 * Names are GA4's current API names (Google's "API Dimensions & Metrics"
 * and "Predefined reports" pages, read 20 Oct 2026): `keyEvents` replaced
 * `conversions` on 6 May 2024 (the Data API changelog).
 *
 * Browser-safe.
 */

/** Every Google Analytics table starts with this; other sources can't use it. */
export const GA_TABLE_PREFIX = "google_analytics_";
/** How a Google Analytics load is recorded in the load history (like the books' `tohyee_*`). */
export const GA_LOAD_TABLE_NAME = "google_analytics_*";
export const GA_SOURCE_NAME = "Google Analytics";

/** Months of history loaded: 13 by default (this month and the same month last year). */
export const GA_DEFAULT_HISTORY_MONTHS = 13;
export const GA_MAX_HISTORY_MONTHS = 60;

/** Rows asked for in one request (Google allows up to 250,000; the default is 10,000). */
export const GA_PAGE_SIZE = 50_000;
/** A report with more rows than this isn't loaded: choose fewer months. */
export const GA_MAX_ROWS_PER_REPORT = 500_000;

export type GaColumnType = "DATE" | "VARCHAR" | "BIGINT" | "DECIMAL(18,2)" | "DECIMAL(18,6)";
export type GaColumn = { name: string; type: GaColumnType; dimension?: string; metric?: string };
export type GaReport = { table: string; label: string; noun: string; description: string; columns: GaColumn[] };

const COUNT = "BIGINT";
const MONEY = "DECIMAL(18,2)";
const RATIO = "DECIMAL(18,6)";

const date: GaColumn = { name: "date", type: "DATE", dimension: "date" };
const users: GaColumn = { name: "active_users", type: COUNT, metric: "activeUsers" };
const newUsers: GaColumn = { name: "new_users", type: COUNT, metric: "newUsers" };
const sessions: GaColumn = { name: "sessions", type: COUNT, metric: "sessions" };
const engaged: GaColumn = { name: "engaged_sessions", type: COUNT, metric: "engagedSessions" };
const views: GaColumn = { name: "page_views", type: COUNT, metric: "screenPageViews" };
// Key events can be fractional when Google shares one between channels, so two places.
const keyEvents: GaColumn = { name: "key_events", type: MONEY, metric: "keyEvents" };
const revenue: GaColumn = { name: "revenue", type: MONEY, metric: "totalRevenue" };

const PER_DAY = "Users are counted each day, so adding days together counts someone who came on two days twice.";

/** The reports loaded, one table each, every one by day. */
export const GA_REPORTS: GaReport[] = [
  {
    table: "google_analytics_daily",
    label: "Website by day",
    noun: "days",
    description: `Visitors, sessions, page views, key events and revenue for each day. ${PER_DAY}`,
    columns: [date, users, newUsers, sessions, engaged, views, { name: "engagement_rate", type: RATIO, metric: "engagementRate" }, keyEvents, revenue],
  },
  {
    table: "google_analytics_traffic",
    label: "Website traffic sources",
    noun: "source rows",
    description: `Where each day's sessions came from: channel, source and medium. ${PER_DAY}`,
    columns: [
      date,
      { name: "channel", type: "VARCHAR", dimension: "sessionDefaultChannelGroup" },
      { name: "source", type: "VARCHAR", dimension: "sessionSource" },
      { name: "medium", type: "VARCHAR", dimension: "sessionMedium" },
      sessions,
      users,
      engaged,
      keyEvents,
      revenue,
    ],
  },
  {
    table: "google_analytics_pages",
    label: "Website pages",
    noun: "page rows",
    description: `Views of each page (its path and title) each day. ${PER_DAY}`,
    columns: [
      date,
      { name: "page_path", type: "VARCHAR", dimension: "pagePath" },
      { name: "page_title", type: "VARCHAR", dimension: "pageTitle" },
      views,
      users,
    ],
  },
  {
    table: "google_analytics_countries",
    label: "Website countries",
    noun: "country rows",
    description: `Visitors by the country they came from, each day. ${PER_DAY}`,
    columns: [date, { name: "country", type: "VARCHAR", dimension: "country" }, users, newUsers, sessions],
  },
  {
    table: "google_analytics_devices",
    label: "Website devices",
    noun: "device rows",
    description: `Visitors by device (desktop, mobile or tablet), each day. ${PER_DAY}`,
    columns: [date, { name: "device", type: "VARCHAR", dimension: "deviceCategory" }, users, sessions, views],
  },
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The first day loaded: the start of the month `months - 1` before this one,
 * so 13 months from 20 Oct 2026 is 1 Oct 2025 (this month and the same month
 * last year, whole).
 */
export function gaHistoryStart(today: string, months: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new ValidationError("Today isn't a date.");
  if (!Number.isInteger(months) || months < 1 || months > GA_MAX_HISTORY_MONTHS) {
    throw new ValidationError(`Load between 1 and ${GA_MAX_HISTORY_MONTHS} months.`);
  }
  const [year, month] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1 - (months - 1), 1));
  return `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-01`;
}

/** The body of one `runReport` request: a page of a report, ordered so pages don't overlap. */
export function gaReportRequest(report: GaReport, startDate: string, offset: number, limit = GA_PAGE_SIZE) {
  const dimensions = report.columns.filter((column) => column.dimension).map((column) => ({ name: column.dimension! }));
  const metrics = report.columns.filter((column) => column.metric).map((column) => ({ name: column.metric! }));
  return {
    dateRanges: [{ startDate, endDate: "today" }],
    dimensions,
    metrics,
    orderBys: dimensions.map((dimension) => ({ dimension: { dimensionName: dimension.name } })),
    keepEmptyRows: false,
    offset: String(offset),
    limit: String(limit),
  };
}

export type GaReportResponse = {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string; type?: string }>;
  rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>;
  rowCount?: number;
  metadata?: { currencyCode?: string; timeZone?: string; dataLossFromOtherRow?: boolean; subjectToThresholding?: boolean };
};

/** "20240131" (GA4's date) as "2024-01-31". */
export function gaDate(value: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) throw new ValidationError(`Google Analytics sent a date Tohyee can't read: "${value.slice(0, 20)}".`);
  const [, year, month, day] = match;
  const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(day)) {
    throw new ValidationError(`Google Analytics sent a date Tohyee can't read: "${value}".`);
  }
  return `${year}-${month}-${day}`;
}

/**
 * A metric's text as a plain decimal string, without going through a
 * binary number: Google sends metrics as text, which can be "12",
 * "0.6666666666666666" or, for very small or large numbers, "1.5E-5".
 */
export function gaNumber(value: string): string {
  const text = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!match) throw new ValidationError(`Google Analytics sent a number Tohyee can't read: "${text.slice(0, 30)}".`);
  const [, sign, whole, fraction = "", exponentText] = match;
  const exponent = exponentText ? Number(exponentText) : 0;
  let digits = `${whole}${fraction}`;
  let point = whole.length + exponent;
  if (point <= 0) {
    digits = `${"0".repeat(1 - point)}${digits}`;
    point = 1;
  } else if (point > digits.length) {
    digits = digits.padEnd(point, "0");
  }
  const plain = `${sign}${digits.slice(0, point)}${point < digits.length ? `.${digits.slice(point)}` : ""}`;
  return toPlainString(dec(plain));
}

function cell(column: GaColumn, value: string | undefined): string | null {
  if (value === undefined || value === null) return null;
  switch (column.type) {
    case "DATE":
      return gaDate(value);
    case "VARCHAR":
      return value.slice(0, 2000);
    case "BIGINT":
      return toPlainString(roundHalfUp(dec(gaNumber(value)), 0));
    case "DECIMAL(18,2)":
      return toFixedString(dec(gaNumber(value)), 2);
    case "DECIMAL(18,6)":
      return toFixedString(dec(gaNumber(value)), 6);
  }
}

/**
 * One page of a report's answer as table rows, in the report's column order.
 * Columns are matched to Google's headers by name, so a different order in
 * the answer doesn't swap them; a header that's missing is an error rather
 * than an empty column.
 */
export function gaRows(report: GaReport, response: GaReportResponse): Array<Array<string | null>> {
  const dimensionNames = (response.dimensionHeaders ?? []).map((header) => header.name);
  const metricNames = (response.metricHeaders ?? []).map((header) => header.name);
  const positions = report.columns.map((column) => {
    const index = column.dimension ? dimensionNames.indexOf(column.dimension) : metricNames.indexOf(column.metric);
    if (index < 0) throw new ValidationError(`Google Analytics didn't send ${column.dimension ?? column.metric} for ${report.label.toLowerCase()}.`);
    return { column, index, from: column.dimension ? ("dimensionValues" as const) : ("metricValues" as const) };
  });
  return (response.rows ?? []).map((row) => positions.map(({ column, index, from }) => cell(column, row[from]?.[index]?.value)));
}

/** The table's columns as DuckDB types, for loading. */
export function gaTableColumns(report: GaReport): Array<{ name: string; type: string }> {
  return report.columns.map((column) => ({ name: column.name, type: column.type }));
}

/** Whether a table is one of Google Analytics' own. */
export function isGaTable(name: string): boolean {
  return name.startsWith(GA_TABLE_PREFIX);
}

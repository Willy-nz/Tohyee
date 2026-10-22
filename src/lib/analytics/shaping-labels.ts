import type { ColumnKind } from "@/lib/analytics/engine";
import type { DatePart, ShapeAggregate, ShapeStep, ShapeTest } from "@/lib/analytics/shaping";

/**
 * Plain words for Prepare data's steps (#376 phase 4, decision 790). Names
 * follow Power Query's where they fit ("Pivot column", "Fill down",
 * "Remove duplicates", "Conditional column", "Index column", "Custom
 * column"), so people who know Power BI find them.
 */
export const STEP_LABELS: Record<ShapeStep["type"], string> = {
  filter: "Filter rows",
  columns: "Keep or remove columns",
  rename: "Rename a column",
  type: "Change a column type",
  split: "Split a column",
  unpivot: "Unpivot columns",
  group: "Group and summarise",
  calculated: "Add a calculated column",
  merge: "Merge another table",
  append: "Append another table",
  pivot: "Pivot column",
  fill: "Fill down or up",
  replace: "Replace values",
  distinct: "Remove duplicates",
  conditional: "Conditional column",
  dateParts: "Date parts",
  sort: "Sort rows",
  index: "Index column",
  formula: "Custom column (formula)",
};

/** The order steps are offered in "Step to add": rows, then columns, then other tables. */
export const STEP_ORDER: Array<ShapeStep["type"]> = [
  "filter",
  "sort",
  "distinct",
  "fill",
  "replace",
  "columns",
  "rename",
  "type",
  "split",
  "calculated",
  "formula",
  "conditional",
  "dateParts",
  "index",
  "group",
  "pivot",
  "unpivot",
  "merge",
  "append",
];

/** Date parts, in the order they are offered. (Here, not in shaping.ts, so the page doesn't load DuckDB.) */
export const DATE_PARTS: readonly DatePart[] = [
  "year",
  "quarter",
  "month",
  "month_name",
  "week",
  "day",
  "day_of_week",
  "day_name",
  "financial_year",
  "financial_quarter",
];

export const DATE_PART_LABELS: Record<DatePart, string> = {
  year: "Year",
  quarter: "Quarter (1-4)",
  month: "Month (1-12)",
  month_name: "Month name",
  week: "Week of the year (ISO, weeks start Monday)",
  day: "Day of the month",
  day_of_week: "Day of the week (Monday 1 to Sunday 7)",
  day_name: "Day name",
  financial_year: "Financial year (the year it ends in)",
  financial_quarter: "Quarter of the financial year (1-4)",
};

/** As on Data sources. */
export const COLUMN_KIND_LABELS: Record<ColumnKind, string> = {
  text: "Text",
  money: "Money (2 decimals)",
  quantity: "Quantity (4 decimals)",
  decimal: "Number (6 decimals)",
  integer: "Whole number",
  date: "Date",
  timestamp: "Date and time",
  boolean: "Yes / no (true or false)",
};

export const AGGREGATE_LABELS: Record<ShapeAggregate, string> = {
  sum: "Add up (sum)",
  average: "Average",
  count: "Count rows",
  smallest: "Smallest",
  largest: "Largest",
};

export const TEST_LABELS: Record<ShapeTest, string> = {
  is: "is",
  "is not": "is not",
  contains: "contains",
  "more than": "is more than",
  "at least": "is at least",
  "less than": "is less than",
  "at most": "is at most",
  "is empty": "is blank",
  "is not empty": "is not blank",
};

/** A short summary of what a step does, for the Applied steps list. */
export function stepSummary(step: ShapeStep): string {
  const list = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", "));
  switch (step.type) {
    case "pivot":
      return `${step.column} into ${step.columns.length} column${step.columns.length === 1 ? "" : "s"}`;
    case "unpivot":
      return step.other ? `all but ${list(step.columns)}` : list(step.columns);
    case "fill":
      return `${step.direction} · ${list(step.columns)}`;
    case "replace":
      return `${step.find === null ? "blank" : `"${step.find}"`} → ${step.replaceWith === null ? "blank" : `"${step.replaceWith}"`} · ${list(step.columns)}`;
    case "distinct":
      return `by ${list(step.columns)}`;
    case "conditional":
    case "index":
    case "formula":
      return step.name;
    case "dateParts":
      return `${step.column} · ${step.parts.length} part${step.parts.length === 1 ? "" : "s"}`;
    case "sort":
      return list(step.by.map((entry) => `${entry.column} ${entry.descending ? "↓" : "↑"}`));
    case "columns":
      return `${step.action} ${list(step.columns)}`;
    case "group":
      return step.by.length ? `by ${list(step.by)}` : "all rows";
    case "calculated":
      return step.name;
    case "merge":
    case "append":
      return step.table;
    default:
      return step.column;
  }
}

/** Rows after a step and the change from the step before, e.g. "1,204 rows (−36)". */
export function rowCountText(counts: string[] | undefined, step: number): string | null {
  const after = counts?.[step + 1];
  const before = counts?.[step];
  if (after === undefined || before === undefined) return null;
  const rows = Number(after);
  const change = rows - Number(before);
  const words = `${rows.toLocaleString("en-NZ")} row${rows === 1 ? "" : "s"}`;
  if (change === 0) return `${words} (no change)`;
  return `${words} (${change > 0 ? "+" : "−"}${Math.abs(change).toLocaleString("en-NZ")})`;
}

/** A column name for a date part that isn't already taken, e.g. sold_year. */
export function datePartName(column: string, part: DatePart, taken: Set<string>): string {
  const base = `${column}_${part}`.slice(0, 60);
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}_${suffix}`;
  return name;
}

/** A column name made from a typed value for Pivot column, e.g. "Jan 2026" → jan_2026. */
export function columnNameForValue(value: string, taken: Set<string>): string {
  let base = value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `value_${base}`.replace(/_+$/, "");
  base = base.slice(0, 60);
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}_${suffix}`;
  return name;
}

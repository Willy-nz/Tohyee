import { ValidationError } from "@/lib/errors";
import { DECIMAL_RESULT, exactAverageSql, exactDivideSql } from "@/lib/analytics/decimal-sql";
import { formulaKeepsMoney, formulaRefs, parseFormula, type FormulaNode } from "@/lib/analytics/formula";
import { lastDays, lastMonths, presetRange } from "@/lib/analytics/date-ranges";
import { columnKind, FILTER_OPS, MAX_LAST_DAYS, MAX_LAST_MONTHS, opAllowed, valueKind } from "@/lib/analytics/filters";
import { cmp, dec } from "@/lib/money/decimal";
import { todayIsoDate } from "@/lib/dates";
import { previousPeriod, previousYear } from "@/lib/analytics/periods";

/**
 * A dashboard tile's question, turned into SQL for DuckDB (analytics step 3).
 * Field names are only ever ones the table really has (checked against its
 * columns), quoted as identifiers; every value a person types is passed as
 * a parameter, never put into the SQL text. Money stays exact: sums of
 * decimals come back as decimal strings.
 */

export type Grain = "day" | "week" | "month" | "quarter" | "year";
export type PivotGrain = "month" | "quarter" | "year";
export type Aggregate = "sum" | "avg" | "min" | "max" | "count" | "count_distinct";
export type FilterOp =
  | "eq"
  | "neq"
  | "in"
  | "not_in"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "blank"
  | "not_blank"
  | "last_days"
  | "last_months"
  | "this_financial_year"
  | "last_financial_year";
export type Visual =
  | "column"
  | "bar"
  | "line"
  | "area"
  | "combo"
  | "pie"
  | "donut"
  | "kpi"
  | "table"
  | "pivot"
  | "waterfall"
  | "funnel"
  | "gauge"
  | "bullet"
  | "scatter"
  | "histogram"
  | "boxplot"
  | "treemap"
  | "heatmap"
  | "calendar"
  | "sankey"
  | "filledmap"
  | "pointmap";

export type PivotDimension = { field: string; grain?: PivotGrain };
/** `subColumns` nest under `column` (#376 phase 2, a matrix's column hierarchy); up to two. */
export type PivotSpec = { rows: PivotDimension[]; column: PivotDimension | null; subColumns?: PivotDimension[] };
export const MAX_PIVOT_SUB_COLUMNS = 2;

/** A value worked out from the table's rows (not a formula). */
export type BaseMeasure = {
  aggregate: Aggregate;
  field?: string;
  times?: string;
  negate?: boolean;
  /** Only rows like these count towards this value (#337), e.g. account_type is revenue. */
  where?: Filter[];
  /** A balance: everything up to the dashboard's To date, whatever the From date (#337). */
  asAt?: boolean;
  /**
   * The column naming each row's currency (#387, decision 694): amounts in
   * different currencies aren't added together. Left out, a `foreign_...`
   * column on a table with a `currency` column uses that one.
   */
  currencyField?: string;
  /**
   * Each row is a balance recorded on its date (a snapshot), not a
   * movement (decision 695): the latest row in each period (for each `per`
   * value, e.g. each account) is used, and those are added up. Snapshots
   * are never added across dates.
   */
  snapshot?: { per?: string };
};

/** A named value a formula uses that isn't one of the tile's own values (from a saved or built-in value). */
export type FormulaInput = BaseMeasure & { name: string };

export type Measure = {
  label: string;
  /** "formula": a calculated value (#337, decision 597). */
  aggregate: Aggregate | "formula";
  /** Not needed to count rows. */
  field?: string;
  /** Multiplies `field` row by row first, e.g. quantity x unit_price. */
  times?: string;
  /**
   * Adds the same measure for the same period a year before, or (with no
   * grouping, e.g. a key figure) for the period just before (#334).
   */
  compare?: "previous_year" | "previous_period";
  /** Shows it the other way round: each amount negated, e.g. so credits such as sales show as positive (AB2). */
  negate?: boolean;
  where?: Filter[];
  asAt?: boolean;
  currencyField?: string;
  snapshot?: { per?: string };
  /** A calculated value: e.g. "[Sales] - [Cost of sales]". [Names] are the tile's other values or `inputs`. */
  formula?: string;
  inputs?: FormulaInput[];
};

export type Filter = { field: string; op: FilterOp; value: string | string[]; join?: "or" };

/** Today and the balance date, for filters like "in this financial year" (decision 578). */
export type QueryDates = { today: string; yearEndMonth: number };

export type TileQuery = {
  table: string;
  groupBy: { field: string; grain?: Grain } | null;
  /**
   * A second grouping inside the first (#376 phase 2): the items in each box
   * of a box plot, a heat map's other axis, a Sankey's targets, or one small
   * chart each. Its values come back as the `breakdown` column.
   */
  breakdown?: { field: string; grain?: Grain } | null;
  pivot?: PivotSpec | null;
  measures: Measure[];
  filters: Filter[];
  /** The date field the dashboard's date range applies to. */
  dateField: string | null;
  sort: { by: "category" | "value"; direction: "asc" | "desc" };
  /** Top N (after sorting). */
  limit: number | null;
  /** With no grouping: the first value by month as well, for a key figure's sparkline (#334). */
  sparkline?: boolean;
};

export type ColumnInfo = { name: string; type: string };
export type ValueFormat = "money" | "number" | "integer" | "date" | "text" | "percent" | "boolean";
export type ResultColumn = { key: string; label: string; format: ValueFormat; role: "category" | "measure" };
export type PivotColumn = {
  key: string;
  label: string;
  /** The first column field's value (the only one with a single column field). */
  pivotValue: string | null;
  measure: ResultColumn;
  /** The grand total column. */
  total: boolean;
  /** With nested column fields: the values down the column hierarchy; shorter than the fields for a column subtotal. */
  path?: Array<string | null>;
  subtotal?: boolean;
};
export type PivotRow = {
  key: string;
  kind: "detail" | "subtotal" | "grand_total";
  depth: number;
  dimensions: Array<string | null>;
  cells: Record<string, string | null>;
};
export type PivotData = {
  rowFields: ResultColumn[];
  columnField: ResultColumn | null;
  /** Every column field, outermost first, when there are nested ones (#376 phase 2). */
  columnFields?: ResultColumn[];
  columnValues: Array<string | null>;
  columns: PivotColumn[];
  rows: PivotRow[];
};
export type PivotDrillSelection = {
  depth: number;
  dimensions: Array<string | null>;
  pivotValue: string | null;
  total: boolean;
  /** With nested column fields: the column's values, outermost first (shorter for a column subtotal). */
  pivotPath?: Array<string | null>;
};
export type PivotDrillResult = { columns: ResultColumn[]; rows: Array<Record<string, string | null>>; truncated: boolean };
/** A key figure's first value by month (oldest first), for its sparkline. */
export type TrendPoint = { month: string; value: string | null };
export type QueryResult = {
  columns: ResultColumn[];
  rows: Array<Record<string, string | null>>;
  truncated: boolean;
  pivot?: PivotData;
  trend?: TrendPoint[];
  /**
   * Every row's values worked out again as one total (decision 694), for a
   * table's totals row: a calculated value or an average is worked out from
   * the totals, not added up or averaged from the rows.
   */
  totals?: Record<string, string | null>;
  /** What the figures can't show, e.g. amounts in more than one currency left blank. */
  notes?: string[];
};

/** What a dashboard adds on top of each tile's own filters. */
export type DashboardFilters = {
  from?: string | null;
  to?: string | null;
  /** Slicers: field -> chosen values (applied to tiles whose table has the field). */
  values?: Record<string, string[]>;
  /** Today and the balance date for relative date filters; set by the server, never taken from a request. */
  dates?: QueryDates;
};

export const MAX_ROWS = 5000;

/** Today in the server's time zone with a 31 March balance date, when the caller doesn't say. */
function todayDates(): QueryDates {
  return { today: todayIsoDate(), yearEndMonth: 3 };
}
export const MAX_PIVOT_CELLS = 2000;
export const MAX_PIVOT_DRILL_ROWS = 500;
const GRAINS: Grain[] = ["day", "week", "month", "quarter", "year"];
const PIVOT_GRAINS: PivotGrain[] = ["month", "quarter", "year"];
const AGGREGATES: Aggregate[] = ["sum", "avg", "min", "max", "count", "count_distinct"];
const OPS: readonly FilterOp[] = FILTER_OPS;
/** The tests Analytics had before decision 578: saved tiles may use them on any column, so they aren't limited by type. */
const FIRST_OPS: readonly FilterOp[] = ["eq", "neq", "in", "contains", "gt", "gte", "lt", "lte"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function isDateType(type: string) {
  return type === "DATE" || type.startsWith("TIMESTAMP");
}

function isNumberType(type: string) {
  return /^(DECIMAL|BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|DOUBLE|FLOAT|UBIGINT|UINTEGER)/.test(type);
}

/** Money is how Tohyee loads money columns (decision 356): two decimal places. */
export function formatOfType(type: string): ValueFormat {
  if (type === "BOOLEAN") return "boolean";
  if (/^DECIMAL\(\d+,2\)$/.test(type)) return "money";
  if (type.startsWith("DECIMAL") || type === "DOUBLE" || type === "FLOAT") return "number";
  if (isNumberType(type)) return "integer";
  if (isDateType(type)) return "date";
  return "text";
}

function column(columns: Map<string, string>, name: unknown, what: string): string {
  if (typeof name !== "string" || !columns.has(name)) throw new ValidationError(`${what}: there's no column called ${String(name)}.`);
  return name;
}

function parseFilter(entry: unknown, columns: Map<string, string>, what: string, joins: boolean): Filter {
  const filter = (entry ?? {}) as Record<string, unknown>;
  const field = column(columns, filter.field, what);
  const op = filter.op as FilterOp;
  if (!OPS.includes(op)) throw new ValidationError(`${what}: choose how to compare.`);
  const type = columns.get(field)!;
  if (!FIRST_OPS.includes(op) && !opAllowed(op, type)) throw new ValidationError(`${what}: that test doesn't work on ${field}.`);
  const join = joins && filter.join === "or" ? { join: "or" as const } : {};
  switch (valueKind(op)) {
    case "none":
      return { field, op, value: "", ...join };
    case "list": {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 200) {
        throw new ValidationError(`${what}: choose between 1 and 200 values.`);
      }
      return { field, op, value: filter.value.map(String), ...join };
    }
    case "two": {
      if (!Array.isArray(filter.value) || filter.value.length !== 2 || filter.value.some((value) => typeof value !== "string" || !value.trim())) {
        throw new ValidationError(`${what}: enter both ends of the range.`);
      }
      const [from, to] = filter.value.map((value) => String(value).trim());
      const backwards = isDateType(type) ? DATE.test(from) && DATE.test(to) && from > to : NUMBER.test(from) && NUMBER.test(to) && cmp(dec(from), dec(to)) > 0;
      if (backwards) throw new ValidationError(`${what}: the first value is after the second.`);
      return { field, op, value: [from, to], ...join };
    }
    case "count": {
      const most = op === "last_months" ? MAX_LAST_MONTHS : MAX_LAST_DAYS;
      const count = String(filter.value ?? "").trim();
      if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > most) {
        throw new ValidationError(`${what}: enter a whole number from 1 to ${most}.`);
      }
      return { field, op, value: String(Number(count)), ...join };
    }
    default:
      if (typeof filter.value !== "string" && typeof filter.value !== "number") throw new ValidationError(`${what}: enter a value.`);
      return { field, op, value: String(filter.value), ...join };
  }
}

/** Checks a value worked out from rows: what's added up, of which column, and which rows count. */
function parseBaseMeasure(measure: Record<string, unknown>, columns: Map<string, string>, label: string, pivot: boolean, input = false): BaseMeasure {
  const aggregate = measure.aggregate as Aggregate;
  if (!AGGREGATES.includes(aggregate)) throw new ValidationError(`${label}: choose how to add it up.`);
  if (pivot && aggregate === "count_distinct") throw new ValidationError(`${label}: pivot values can be summed, counted, averaged, or compared by smallest or largest.`);
  const result: BaseMeasure = { aggregate };
  if (aggregate !== "count" || measure.field) {
    result.field = column(columns, measure.field, label);
    if (["sum", "avg"].includes(aggregate) && !isNumberType(columns.get(result.field)!)) {
      throw new ValidationError(`${label}: ${result.field} isn't a number, so it can only be counted.`);
    }
  }
  if (measure.times) {
    if (!["sum", "avg"].includes(aggregate) || !result.field) throw new ValidationError(`${label}: only a sum or average can multiply two columns.`);
    result.times = column(columns, measure.times, label);
    if (!isNumberType(columns.get(result.times)!)) throw new ValidationError(`${label}: ${result.times} isn't a number.`);
  }
  if (measure.negate === true) {
    if (aggregate === "count" || aggregate === "count_distinct") throw new ValidationError(`${label}: a count can't be turned the other way round.`);
    result.negate = true;
  }
  if (measure.where !== undefined && measure.where !== null) {
    if (!Array.isArray(measure.where) || measure.where.length > 10) throw new ValidationError(`${label}: a value can have up to 10 conditions.`);
    if (pivot && measure.where.length) throw new ValidationError(`${label}: pivot values can't have their own conditions.`);
    const where = measure.where.map((entry, index) => parseFilter(entry, columns, `${label} condition ${index + 1}`, false));
    if (where.length) result.where = where;
  }
  if (measure.asAt === true) {
    if (pivot) throw new ValidationError(`${label}: a pivot table can't show balances.`);
    result.asAt = true;
  }
  if (measure.currencyField !== undefined && measure.currencyField !== null && measure.currencyField !== "") {
    result.currencyField = column(columns, measure.currencyField, `${label} currency`);
    if (formatOfType(columns.get(result.currencyField)!) !== "text") throw new ValidationError(`${label}: ${result.currencyField} isn't text, so it can't name a currency.`);
  }
  if (measure.snapshot !== undefined && measure.snapshot !== null && measure.snapshot !== false) {
    const snapshot = (typeof measure.snapshot === "object" ? measure.snapshot : {}) as Record<string, unknown>;
    if (pivot) throw new ValidationError(`${label}: a pivot table can't show balances recorded on each date yet.`);
    if (input) throw new ValidationError(`${label}: a formula can't use a balance recorded on each date yet.`);
    if (aggregate !== "sum") throw new ValidationError(`${label}: a balance recorded on each date is added up as a total of the latest balances.`);
    if (result.asAt) throw new ValidationError(`${label}: choose either a balance up to the To date or a balance recorded on each date.`);
    result.snapshot = snapshot.per ? { per: column(columns, snapshot.per, `${label} balance for each`) } : {};
  }
  return result;
}

/**
 * The column naming a value's currency (decision 694): the one it chose, or
 * for a `foreign_...` amount on a table with a `currency` column (the books
 * copy's foreign totals and amounts), that one. Null: one currency.
 */
export function currencyFieldOf(measure: BaseMeasure, columns: Map<string, string>): string | null {
  if (measure.aggregate === "count" || measure.aggregate === "count_distinct") return null;
  if (measure.currencyField) return measure.currencyField;
  const foreign = [measure.field, measure.times].some((field) => field?.startsWith("foreign_"));
  return foreign && columns.has("currency") ? "currency" : null;
}

/** Checks a tile's question against the table's columns. */
export function parseTileQuery(input: unknown, tables: Map<string, ColumnInfo[]>): TileQuery {
  if (!input || typeof input !== "object") throw new ValidationError("The tile isn't set up properly.");
  const raw = input as Record<string, unknown>;
  const table = raw.table;
  if (typeof table !== "string" || !tables.has(table)) throw new ValidationError(`There's no loaded table called ${String(table)}.`);
  const columns = new Map(tables.get(table)!.map((entry) => [entry.name, entry.type]));

  let groupBy: TileQuery["groupBy"] = null;
  if (raw.groupBy) {
    const group = raw.groupBy as Record<string, unknown>;
    const field = column(columns, group.field, "Group by");
    let grain: Grain | undefined;
    if (isDateType(columns.get(field)!)) {
      grain = GRAINS.includes(group.grain as Grain) ? (group.grain as Grain) : "month";
    }
    groupBy = { field, ...(grain ? { grain } : {}) };
  }

  let breakdown: TileQuery["breakdown"] = null;
  if (raw.breakdown) {
    if (!groupBy) throw new ValidationError("A second grouping needs a first one: choose what to group by.");
    const second = raw.breakdown as Record<string, unknown>;
    const field = column(columns, second.field, "Second grouping");
    let grain: Grain | undefined;
    if (isDateType(columns.get(field)!)) {
      grain = GRAINS.includes(second.grain as Grain) ? (second.grain as Grain) : "month";
    }
    if (field === groupBy.field && grain === groupBy.grain) throw new ValidationError("The second grouping should be different from the first.");
    breakdown = { field, ...(grain ? { grain } : {}) };
  }

  let pivot: PivotSpec | null = null;
  if (raw.pivot !== undefined && raw.pivot !== null) {
    if (groupBy) throw new ValidationError("A pivot table uses its own row and column fields.");
    const rawPivot = raw.pivot as Record<string, unknown>;
    if (!Array.isArray(rawPivot.rows) || rawPivot.rows.length < 1 || rawPivot.rows.length > 5) {
      throw new ValidationError("A pivot table needs between 1 and 5 row fields.");
    }
    const dimension = (entry: unknown, what: string): PivotDimension => {
      const rawDimension = (entry ?? {}) as Record<string, unknown>;
      const field = column(columns, rawDimension.field, what);
      if (!isDateType(columns.get(field)!)) return { field };
      const grain = PIVOT_GRAINS.includes(rawDimension.grain as PivotGrain) ? (rawDimension.grain as PivotGrain) : "month";
      return { field, grain };
    };
    const rows = rawPivot.rows.map((entry, index) => dimension(entry, `Pivot row ${index + 1}`));
    const rawColumn = rawPivot.column;
    const pivotColumn = rawColumn === null || rawColumn === undefined || rawColumn === "" ? null : dimension(rawColumn, "Pivot column");
    let subColumns: PivotDimension[] = [];
    if (rawPivot.subColumns !== undefined && rawPivot.subColumns !== null) {
      if (!Array.isArray(rawPivot.subColumns) || rawPivot.subColumns.length > MAX_PIVOT_SUB_COLUMNS) throw new ValidationError(`A pivot table can have up to ${MAX_PIVOT_SUB_COLUMNS + 1} column fields.`);
      if (rawPivot.subColumns.length && !pivotColumn) throw new ValidationError("Choose the first pivot column before the ones inside it.");
      subColumns = rawPivot.subColumns.map((entry, index) => dimension(entry, `Pivot column ${index + 2}`));
    }
    const fields = [...rows.map((entry) => entry.field), ...(pivotColumn ? [pivotColumn.field] : []), ...subColumns.map((entry) => entry.field)];
    if (new Set(fields).size !== fields.length) throw new ValidationError("A pivot field can only be used once.");
    pivot = { rows, column: pivotColumn, ...(subColumns.length ? { subColumns } : {}) };
  }

  if (!Array.isArray(raw.measures) || raw.measures.length === 0) throw new ValidationError("Add at least one value to show.");
  if (raw.measures.length > 6) throw new ValidationError("A tile can show up to 6 values.");
  const labels = new Set<string>();
  const measures = raw.measures.map((entry, index): Measure => {
    const measure = (entry ?? {}) as Record<string, unknown>;
    const label = typeof measure.label === "string" && measure.label.trim() ? measure.label.trim().slice(0, 80) : `Value ${index + 1}`;
    labels.add(label);
    let result: Measure;
    if (measure.aggregate === "formula") {
      if (pivot) throw new ValidationError(`${label}: a pivot table can't show calculated values.`);
      if (typeof measure.formula !== "string") throw new ValidationError(`${label}: enter a formula, e.g. [Sales] - [Cost of sales].`);
      try {
        parseFormula(measure.formula);
      } catch (error) {
        throw new ValidationError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      result = { label, aggregate: "formula", formula: measure.formula.trim() };
      if (measure.inputs !== undefined && measure.inputs !== null) {
        if (!Array.isArray(measure.inputs) || measure.inputs.length > 20) throw new ValidationError(`${label}: a formula can use up to 20 values.`);
        const names = new Set<string>();
        const inputs = measure.inputs.map((input): FormulaInput => {
          const raw = (input ?? {}) as Record<string, unknown>;
          const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 80) : "";
          if (!name || names.has(name)) throw new ValidationError(`${label}: each value a formula uses needs its own name.`);
          names.add(name);
          return { name, ...parseBaseMeasure(raw, columns, `${label} › ${name}`, false, true) };
        });
        if (inputs.length) result.inputs = inputs;
      }
    } else {
      result = { label, ...parseBaseMeasure(measure, columns, label, Boolean(pivot)) } as Measure;
    }
    if (measure.compare === "previous_year" || measure.compare === "previous_period") {
      if (pivot) throw new ValidationError(`${label}: a pivot table can't compare with another period.`);
      if (breakdown) throw new ValidationError(`${label}: a chart with a second grouping can't compare with another period.`);
      if (groupBy && measure.compare === "previous_period") throw new ValidationError(`${label}: comparing with the previous period is for one total.`);
      if (groupBy && !groupBy.grain) throw new ValidationError(`${label}: comparing with last year needs the tile grouped by a date.`);
      result.compare = measure.compare;
    }
    return result;
  });
  // Every [name] in a formula is one of its inputs or another (not calculated) value of the tile.
  for (const measure of measures) {
    if (measure.aggregate !== "formula") continue;
    for (const name of formulaRefs(parseFormula(measure.formula!))) {
      const input = measure.inputs?.some((entry) => entry.name === name);
      const sibling = measures.some((other) => other !== measure && other.aggregate !== "formula" && other.label === name);
      if (!input && !sibling) {
        throw new ValidationError(
          measures.some((other) => other.label === name)
            ? `${measure.label}: [${name}] is itself calculated; a formula can use values worked out from rows.`
            : `${measure.label}: [${name}] isn't one of this chart's values.`,
        );
      }
    }
  }
  if (labels.size !== measures.length && measures.some((measure) => measure.aggregate === "formula")) {
    throw new ValidationError("Give each value its own name, so a formula knows which one it means.");
  }

  const filters = (Array.isArray(raw.filters) ? raw.filters : []).map((entry, index): Filter => parseFilter(entry, columns, `Filter ${index + 1}`, index > 0));
  if (filters.length > 20) throw new ValidationError("A tile can have up to 20 filters.");

  let dateField: string | null = null;
  if (raw.dateField) {
    dateField = column(columns, raw.dateField, "Date range");
    if (!isDateType(columns.get(dateField)!)) throw new ValidationError(`${dateField} isn't a date.`);
  } else if (groupBy?.grain) {
    dateField = groupBy.field;
  } else if (pivot) {
    dateField = [...pivot.rows, ...(pivot.column ? [pivot.column] : [])].find((dimension) => dimension.grain)?.field ?? null;
  }
  const balances = measures.some((measure) => measure.asAt || measure.inputs?.some((input) => input.asAt));
  if (balances && groupBy?.grain) throw new ValidationError("A balance can't be grouped by date; group by something else or show one total.");
  if (balances && !dateField) throw new ValidationError("A balance needs a date the dashboard's To date applies to.");
  if (measures.some((measure) => measure.snapshot) && !dateField) {
    throw new ValidationError("A balance recorded on each date needs the date it was recorded: choose it as the tile's date.");
  }
  if (!groupBy && !pivot && !dateField && measures.some((measure) => measure.compare)) {
    throw new ValidationError("Comparing with another period needs a date the dashboard's dates apply to.");
  }
  if (raw.sparkline === true && (groupBy || pivot || !dateField)) {
    throw new ValidationError("A trend line is for one total with a date the dashboard's dates apply to.");
  }

  const sortRaw = (raw.sort ?? {}) as Record<string, unknown>;
  const sort: TileQuery["sort"] = {
    by: sortRaw.by === "value" ? "value" : "category",
    direction: sortRaw.direction === "desc" ? "desc" : "asc",
  };
  let limit: number | null = null;
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== "") {
    limit = Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new ValidationError(`Top N must be a whole number from 1 to ${MAX_ROWS}.`);
  }
  return { table, groupBy, ...(breakdown ? { breakdown } : {}), pivot, measures, filters, dateField, sort, limit, ...(raw.sparkline === true ? { sparkline: true } : {}) };
}

type Built = { sql: string; params: unknown[]; columns: ResultColumn[] };

/** One filter as a SQL condition, with every typed value passed as a parameter. */
function conditionSql(filter: Filter, types: Map<string, string>, param: (value: unknown) => string, dates: QueryDates): string {
  const q = quoteIdentifier;
  const typed = (field: string, value: string) => {
    const type = types.get(field)!;
    if (isDateType(type)) {
      if (!DATE.test(value)) throw new ValidationError(`${field}: dates are YYYY-MM-DD.`);
      return `cast(${param(value)} as DATE)`;
    }
    if (isNumberType(type)) {
      if (!/^-?\d+(\.\d+)?$/.test(value.trim())) throw new ValidationError(`${field}: "${value}" isn't a number.`);
      return `cast(${param(value.trim())} as ${type.startsWith("DECIMAL") ? "DECIMAL(38,6)" : type})`;
    }
    if (type === "BOOLEAN") {
      // Shown as Yes and No (decision 577); sent as true and false.
      if (value !== "true" && value !== "false") throw new ValidationError(`${field}: choose Yes or No.`);
      return `cast(${param(value)} as BOOLEAN)`;
    }
    return param(value);
  };
  const dateRange = (field: string, range: { from: string | null; to: string | null }) =>
    `cast(${field} as DATE) between cast(${param(range.from)} as DATE) and cast(${param(range.to)} as DATE)`;
  const field = q(filter.field);
  const text = columnKind(types.get(filter.field)!) === "text";
  switch (filter.op) {
    case "in":
    case "not_in":
      // Like "is not", "is not one of" leaves out blank rows; "or is blank" keeps them.
      return `${field} ${filter.op === "in" ? "in" : "not in"} (${(filter.value as string[]).map((value) => typed(filter.field, value)).join(", ")})`;
    case "contains":
      return `contains(lower(cast(${field} as VARCHAR)), lower(${param(String(filter.value))}))`;
    case "blank":
      return text ? `(${field} is null or trim(${field}) = '')` : `${field} is null`;
    case "not_blank":
      return text ? `(${field} is not null and trim(${field}) <> '')` : `${field} is not null`;
    case "between": {
      const [from, to] = filter.value as string[];
      return `${field} between ${typed(filter.field, from)} and ${typed(filter.field, to)}`;
    }
    case "last_days":
      return dateRange(field, lastDays(Number(filter.value), dates.today));
    case "last_months":
      return dateRange(field, lastMonths(Number(filter.value), dates.today));
    case "this_financial_year":
    case "last_financial_year":
      return dateRange(field, presetRange(filter.op, dates.today, dates.yearEndMonth));
    default: {
      const symbol = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.op as "eq" | "neq" | "gt" | "gte" | "lt" | "lte"];
      return `${field} ${symbol} ${typed(filter.field, String(filter.value))}`;
    }
  }
}

function filterSql(
  query: TileQuery,
  types: Map<string, string>,
  dashboard: DashboardFilters,
  param: (value: unknown) => string,
  shiftYears = 0,
  /** With a balance on the tile, the From date goes on each other value instead (decision 597). */
  skipFrom = false,
): string {
  const dates = dashboard.dates ?? todayDates();
  const q = quoteIdentifier;
  const where: string[] = [];
  // Filters joined with "or" form a group; the groups are joined with "and" (decision 578).
  const groups: string[][] = [];
  query.filters.forEach((filter, index) => {
    if (index > 0 && filter.join === "or") groups[groups.length - 1].push(conditionSql(filter, types, param, dates));
    else groups.push([conditionSql(filter, types, param, dates)]);
  });
  for (const group of groups) where.push(group.length === 1 ? group[0] : `(${group.join(" or ")})`);
  for (const [field, values] of Object.entries(dashboard.values ?? {})) {
    if (!types.has(field) || values.length === 0) continue;
    where.push(`cast(${q(field)} as VARCHAR) in (${values.slice(0, 200).map((value) => param(String(value))).join(", ")})`);
  }
  if (query.dateField) {
    const shifted = shiftYears ? ` + interval ${shiftYears} year` : "";
    if (dashboard.from && !skipFrom) {
      if (!DATE.test(dashboard.from)) throw new ValidationError("The From date is YYYY-MM-DD.");
      where.push(`cast(${q(query.dateField)} as DATE)${shifted} >= cast(${param(dashboard.from)} as DATE)`);
    }
    if (dashboard.to) {
      if (!DATE.test(dashboard.to)) throw new ValidationError("The To date is YYYY-MM-DD.");
      where.push(`cast(${q(query.dateField)} as DATE)${shifted} <= cast(${param(dashboard.to)} as DATE)`);
    }
  }
  return where.length ? ` where ${where.join(" and ")}` : "";
}

/**
 * A field's different values (up to 500) in the rows a tile reads, after
 * the tile's own filters (decision 697: a report viewer's slicer values).
 * The dashboard's dates and slicers aren't applied: only `dates` for
 * relative filters ("this financial year").
 */
export function buildDistinctValuesSql(query: TileQuery, tableColumns: ColumnInfo[], field: string, dashboard: Pick<DashboardFilters, "dates">): Built {
  const types = new Map(tableColumns.map((entry) => [entry.name, entry.type]));
  if (!types.has(field)) throw new ValidationError(`There's no column ${field} in ${query.table}.`);
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const q = quoteIdentifier;
  const where = filterSql({ ...query, dateField: null }, types, { dates: dashboard.dates }, param);
  const notBlank = `${q(field)} is not null`;
  const sql = `select distinct cast(${q(field)} as VARCHAR) as value from ${q(query.table)}${where ? `${where} and ${notBlank}` : ` where ${notBlank}`} order by 1 limit 500`;
  return { sql, params, columns: [] };
}

/** The SQL for a tile, with the dashboard's date range and slicers applied. */
export function buildTileSql(query: TileQuery, tableColumns: ColumnInfo[], dashboard: DashboardFilters = {}): Built {
  const types = new Map(tableColumns.map((entry) => [entry.name, entry.type]));
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const q = quoteIdentifier;

  // A balance counts everything up to the To date, so the From date moves from the tile's rows onto each other value.
  const balances = query.measures.some((measure) => measure.asAt || measure.inputs?.some((input) => input.asAt));
  const conditions = (shiftYears: number, dates: DashboardFilters = dashboard) => filterSql(query, types, dates, param, shiftYears, balances);

  /** Which rows count towards a value: its own conditions, and with a balance on the tile, the From date. */
  const ruleSql = (measure: BaseMeasure, dates: DashboardFilters) => {
    const rules = (measure.where ?? []).map((filter) => conditionSql(filter, types, param, dashboard.dates ?? todayDates()));
    if (balances && !measure.asAt && query.dateField && dates.from) {
      if (!DATE.test(dates.from)) throw new ValidationError("The From date is YYYY-MM-DD.");
      rules.push(`cast(${q(query.dateField)} as DATE) >= cast(${param(dates.from)} as DATE)`);
    }
    return rules;
  };
  // Balances recorded on each date (decision 695): each one's latest date in its group, worked out by a window over the rows.
  const snapshots = new Map<BaseMeasure, string>();
  query.measures.forEach((measure, index) => {
    if (measure.snapshot) snapshots.set(measure as BaseMeasure, `_tohyee_latest_${index}`);
  });
  const recordedOn = `cast(${q(query.dateField ?? "")} as DATE)`;
  const conditionsOf = (measure: BaseMeasure, dates: DashboardFilters) => {
    const rules = ruleSql(measure, dates);
    const latest = snapshots.get(measure);
    if (latest) rules.push(`${recordedOn} = ${q(latest)}`);
    return rules;
  };
  const baseSql = (measure: BaseMeasure, dates: DashboardFilters) => {
    const rules = conditionsOf(measure, dates);
    const only = (sql: string) => (rules.length ? `(case when ${rules.join(" and ")} then ${sql} end)` : sql);
    if (measure.aggregate === "count") return measure.field ? `count(${only(q(measure.field))})` : rules.length ? `count(${only("1")})` : "count(*)";
    if (measure.aggregate === "count_distinct") return `count(distinct ${only(q(measure.field!))})`;
    const plain = measure.times ? `(${q(measure.field!)} * ${q(measure.times)})` : q(measure.field!);
    const value = only(measure.negate ? `(-${plain})` : plain);
    if (measure.aggregate === "avg") return exactAverageSql(value);
    return `${measure.aggregate}(${value})`;
  };
  const inputOf = (measure: Measure, name: string): BaseMeasure =>
    measure.inputs?.find((input) => input.name === name) ?? (query.measures.find((other) => other.aggregate !== "formula" && other.label === name) as BaseMeasure);
  /**
   * Amounts in more than one currency aren't added together (decision 694):
   * alongside a value whose rows name their currency, how many currencies
   * it has in each group (unless the tile is grouped by the currency).
   */
  const currencyOf = (measure: BaseMeasure) => {
    const field = currencyFieldOf(measure, types);
    return field && query.groupBy?.field !== field ? field : null;
  };
  const checkedInputs = (measure: Measure): BaseMeasure[] =>
    measure.aggregate === "formula"
      ? formulaRefs(parseFormula(measure.formula!)).map((name) => inputOf(measure, name)).filter((input) => currencyOf(input))
      : currencyOf(measure as BaseMeasure)
        ? [measure as BaseMeasure]
        : [];
  const checked = query.measures.map((measure) => checkedInputs(measure).length > 0);
  const currencyCheckSql = (measure: Measure, dates: DashboardFilters) => {
    const counts = checkedInputs(measure).map((input) => {
      const rules = [...conditionsOf(input, dates), `${q(input.field!)} is not null`];
      return `count(distinct case when ${rules.join(" and ")} then ${q(currencyOf(input)!)} end)`;
    });
    return counts.length === 1 ? counts[0] : `greatest(${counts.join(", ")})`;
  };
  /** A calculated value in exact decimals (DECIMAL(38,6)); dividing by zero gives no value. */
  const formulaSql = (measure: Measure, dates: DashboardFilters) => {
    const decimal = (sql: string) => `cast(${sql} as ${DECIMAL_RESULT})`;
    const days = dates.from && dates.to && DATE.test(dates.from) && DATE.test(dates.to)
      ? Math.round((Date.parse(`${dates.to}T00:00:00Z`) - Date.parse(`${dates.from}T00:00:00Z`)) / 86_400_000) + 1
      : null;
    const compile = (node: FormulaNode): string => {
      switch (node.kind) {
        case "number":
          return decimal(param(node.value));
        case "ref":
          // A value with no rows counts as zero here, as on a profit and loss (no cost of sales is 0.00).
          return decimal(`coalesce(${baseSql(inputOf(measure, node.name), dates)}, 0)`);
        case "days":
          return days === null || days < 1 ? `cast(null as ${DECIMAL_RESULT})` : decimal(param(String(days)));
        case "negate":
          return `(-(${compile(node.operand)}))`;
        case "binary":
          return node.op === "/" ? exactDivideSql(compile(node.left), compile(node.right)) : decimal(`(${compile(node.left)} ${node.op} ${compile(node.right)})`);
      }
    };
    return compile(parseFormula(measure.formula!));
  };
  const measureSql = (measure: Measure, dates: DashboardFilters) =>
    measure.aggregate === "formula" ? formulaSql(measure, dates) : baseSql(measure as BaseMeasure, dates);
  const baseFormat = (measure: BaseMeasure): ValueFormat => {
    if (measure.aggregate === "count" || measure.aggregate === "count_distinct") return "integer";
    const formats = [measure.field, measure.times].filter(Boolean).map((field) => formatOfType(types.get(field!)!));
    if (formats.includes("money")) return "money";
    if (formats.every((format) => format === "integer") && measure.aggregate !== "avg") return "integer";
    return formats[0] === "date" ? "date" : "number";
  };
  const measureFormat = (measure: Measure): ValueFormat => {
    if (measure.aggregate === "formula") {
      return formulaKeepsMoney(parseFormula(measure.formula!), (name) => baseFormat(inputOf(measure, name)) === "money") ? "money" : "number";
    }
    if (measure.aggregate === "count" || measure.aggregate === "count_distinct") return "integer";
    const formats = [measure.field, measure.times].filter(Boolean).map((field) => formatOfType(types.get(field!)!));
    if (formats.includes("money")) return "money";
    if (formats.every((format) => format === "integer") && measure.aggregate !== "avg") return "integer";
    return formats[0] === "date" ? "date" : "number";
  };

  const columns: ResultColumn[] = [];
  let category = "";
  if (query.groupBy) {
    const field = q(query.groupBy.field);
    category = query.groupBy.grain ? `cast(date_trunc('${query.groupBy.grain}', ${field}) as DATE)` : field;
    columns.push({
      key: "category",
      label: query.groupBy.field,
      format: query.groupBy.grain ? "date" : formatOfType(types.get(query.groupBy.field)!),
      role: "category",
    });
  }
  let second = "";
  if (query.groupBy && query.breakdown) {
    const field = q(query.breakdown.field);
    second = query.breakdown.grain ? `cast(date_trunc('${query.breakdown.grain}', ${field}) as DATE)` : field;
    columns.push({
      key: "breakdown",
      label: query.breakdown.field,
      format: query.breakdown.grain ? "date" : formatOfType(types.get(query.breakdown.field)!),
      role: "category",
    });
  }
  query.measures.forEach((measure, index) => {
    columns.push({ key: `m${index}`, label: measure.label, format: measureFormat(measure), role: "measure" });
    if (measure.compare === "previous_year") columns.push({ key: `m${index}_py`, label: `${measure.label} last year`, format: measureFormat(measure), role: "measure" });
    if (measure.compare === "previous_period") columns.push({ key: `m${index}_pp`, label: `${measure.label} previous period`, format: measureFormat(measure), role: "measure" });
  });

  const select = (shiftYears: number, dates: DashboardFilters = dashboard) => {
    const shiftedCategory =
      shiftYears && query.groupBy?.grain
        ? `cast(date_trunc('${query.groupBy.grain}', ${q(query.groupBy.field)} + interval ${shiftYears} year) as DATE)`
        : category;
    const parts = [
      ...(query.groupBy ? [`${shiftedCategory} as category`] : []),
      ...(second ? [`${second} as breakdown`] : []),
      ...query.measures.map((measure, index) => `${measureSql(measure, dates)} as m${index}`),
      ...query.measures.flatMap((measure, index) => (checked[index] ? [`${currencyCheckSql(measure, dates)} as m${index}_ccy`] : [])),
    ];
    let from = `${q(query.table)}${conditions(shiftYears, dates)}`;
    if (snapshots.size) {
      // The latest date each snapshot balance has in its group (and for each `per` value), over the tile's rows.
      const windows = [...snapshots].map(([measure, alias]) => {
        const rules = ruleSql(measure, dates);
        const partition = [...(query.groupBy ? [shiftedCategory] : []), ...(measure.snapshot?.per ? [q(measure.snapshot.per)] : [])];
        const date = rules.length ? `case when ${rules.join(" and ")} then ${recordedOn} end` : recordedOn;
        return `max(${date}) over (${partition.length ? `partition by ${partition.join(", ")}` : ""}) as ${q(alias)}`;
      });
      from = `(select *, ${windows.join(", ")} from ${from}) as ${q("_tohyee_rows")}`;
    }
    return `select ${parts.join(", ")} from ${from}${query.groupBy ? " group by all" : ""}`;
  };

  const order = (alias: string) => {
    if (!query.groupBy) return "";
    const by = query.sort.by === "value" ? `${alias}m0` : `${alias}category`;
    // With a second grouping, its values come in order within each group.
    const then = second ? (query.sort.by === "value" ? `, ${alias}category asc nulls last, ${alias}breakdown asc nulls last` : `, ${alias}breakdown asc nulls last`) : "";
    return ` order by ${by} ${query.sort.direction} nulls last${then}`;
  };
  const limit = ` limit ${Math.min(query.limit ?? MAX_ROWS + 1, MAX_ROWS + 1)}`;

  const compares = query.measures.some((measure) => measure.compare);
  let sql: string;
  if (compares && query.groupBy) {
    const previous = query.measures
      .map((measure, index) => (measure.compare ? `, previous.m${index} as m${index}_py${checked[index] ? `, previous.m${index}_ccy as m${index}_py_ccy` : ""}` : ""))
      .join("");
    const current = query.measures.map((_measure, index) => `, current.m${index}${checked[index] ? `, current.m${index}_ccy` : ""}`).join("");
    sql = `with current as (${select(0)}), previous as (${select(1)}) select current.category${current}${previous} from current left join previous on previous.category = current.category${order("current.")}${limit}`;
  } else if (compares) {
    // One total compared with another date range (decision 594): the same question asked of those dates.
    const parts: string[] = [];
    const ctes: string[] = [`current as (${select(0)})`];
    query.measures.forEach((measure, index) => {
      parts.push(`current.m${index}`);
      if (checked[index]) parts.push(`current.m${index}_ccy`);
      if (!measure.compare) return;
      const suffix = measure.compare === "previous_year" ? "py" : "pp";
      const range = measure.compare === "previous_year" ? previousYear(dashboard.from, dashboard.to) : previousPeriod(dashboard.from, dashboard.to);
      if (!range) {
        parts.push(`cast(null as VARCHAR) as m${index}_${suffix}`);
        return;
      }
      const name = `${suffix}${index}`;
      ctes.push(`${name} as (${select(0, { ...dashboard, from: range.from, to: range.to })})`);
      parts.push(`${name}.m${index} as m${index}_${suffix}`);
      if (checked[index]) parts.push(`${name}.m${index}_ccy as m${index}_${suffix}_ccy`);
    });
    const joined = ctes.map((cte) => cte.slice(0, cte.indexOf(" as ("))).join(" cross join ");
    sql = `with ${ctes.join(", ")} select ${parts.join(", ")} from ${joined}`;
  } else {
    sql = `${select(0)}${order("")}${limit}`;
  }
  return { sql, params, columns };
}

export type PivotBuilt = {
  sql: string;
  countSql: string;
  params: unknown[];
  rowFields: ResultColumn[];
  columnField: ResultColumn | null;
  columnFields: ResultColumn[];
  measures: ResultColumn[];
  hasColumn: boolean;
};

/** Aggregate only pivot cells in DuckDB; source rows never leave the server. */
export function buildPivotSql(query: TileQuery, tableColumns: ColumnInfo[], dashboard: DashboardFilters = {}): PivotBuilt {
  if (!query.pivot) throw new ValidationError("Choose row fields for the pivot table.");
  const pivot = query.pivot;
  const types = new Map(tableColumns.map((entry) => [entry.name, entry.type]));
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const q = quoteIdentifier;
  const internalAlias = (base: string) => {
    let name = base;
    while (types.has(name)) name = `_${name}`;
    return name;
  };
  const expression = (dimension: PivotDimension) => {
    const field = q(dimension.field);
    return dimension.grain ? `cast(date_trunc('${dimension.grain}', ${field}) as DATE)` : field;
  };
  const rowExpressions = pivot.rows.map(expression);
  // The column fields, outermost first (#376 phase 2: up to three, nested).
  const columnDimensions = pivot.column ? [pivot.column, ...(pivot.subColumns ?? [])] : [];
  const columnExpressions = columnDimensions.map(expression);
  const columnExpression = columnExpressions[0] ?? null;
  const rowAliases = pivot.rows.map((_dimension, index) => internalAlias(`_tohyee_pivot_row_${index}`));
  const columnAliases = columnDimensions.map((_dimension, index) => internalAlias(index === 0 ? "_tohyee_pivot_column" : `_tohyee_pivot_column_${index}`));
  const filter = filterSql(query, types, dashboard, param);
  const filteredColumns = [
    "*",
    ...rowExpressions.map((entry, index) => `${entry} as ${q(rowAliases[index])}`),
    ...columnExpressions.map((entry, index) => `${entry} as ${q(columnAliases[index])}`),
  ];
  const filtered = `with filtered as (select ${filteredColumns.join(", ")} from ${q(query.table)}${filter})`;
  const rowGroups = (depth: number) => rowAliases.slice(0, depth).map(q);
  const columnGroups = (depth: number) => columnAliases.slice(0, depth).map(q);
  const rowGroupingSets = Array.from({ length: pivot.rows.length + 1 }, (_, index) => {
    const fields = rowGroups(pivot.rows.length - index);
    return `(${fields.join(", ")})`;
  });
  // Every column, and with nested fields every column subtotal, counts towards the size limit.
  const columnGroupsSql =
    columnAliases.length === 1
      ? `select ${q(columnAliases[0])} from filtered group by ${q(columnAliases[0])}`
      : `select ${columnAliases.map(q).join(", ")} from filtered group by grouping sets (${Array.from({ length: columnAliases.length }, (_, index) => `(${columnGroups(columnAliases.length - index).join(", ")})`).join(", ")})`;
  const countSql = `${filtered}, row_groups as (select ${rowAliases.map(q).join(", ")} from filtered group by grouping sets (${rowGroupingSets.join(", ")}))` +
    `${columnExpression ? `, column_groups as (${columnGroupsSql})` : ""} ` +
    `select (select count(*) from row_groups) as row_groups${columnExpression ? ", (select count(*) from column_groups) as column_groups" : ""}`;

  const groupingSets: string[] = [];
  for (let depth = pivot.rows.length; depth >= 0; depth -= 1) {
    const prefix = rowGroups(depth);
    for (let columnDepth = columnAliases.length; columnDepth >= 0; columnDepth -= 1) {
      groupingSets.push(`(${[...prefix, ...columnGroups(columnDepth)].join(", ")})`);
    }
  }
  const aggregate = (measure: Measure) => {
    if (measure.aggregate === "count") return measure.field ? `count(${q(measure.field)})` : "count(*)";
    const plain = measure.times ? `(${q(measure.field!)} * ${q(measure.times)})` : q(measure.field!);
    const value = measure.negate ? `(-${plain})` : plain;
    return measure.aggregate === "avg" ? exactAverageSql(value) : `${measure.aggregate}(${value})`;
  };
  const measureFormat = (measure: Measure): ValueFormat => {
    if (measure.aggregate === "count" || measure.aggregate === "count_distinct") return "integer";
    const formats = [measure.field, measure.times].filter(Boolean).map((field) => formatOfType(types.get(field!)!));
    if (formats.includes("money")) return "money";
    if (formats.every((format) => format === "integer") && measure.aggregate !== "avg") return "integer";
    return formats[0] === "date" ? "date" : "number";
  };
  const rowFields = pivot.rows.map((dimension, index): ResultColumn => ({
    key: rowAliases[index],
    label: dimension.field,
    format: dimension.grain ? "date" : formatOfType(types.get(dimension.field)!),
    role: "category",
  }));
  const columnFields = columnDimensions.map((dimension, index): ResultColumn => ({
    key: index === 0 ? "pivot_column" : `pivot_column_${index}`,
    label: dimension.field,
    format: dimension.grain ? "date" : formatOfType(types.get(dimension.field)!),
    role: "category",
  }));
  const columnField = columnFields[0] ?? null;
  const measures = query.measures.map((measure, index): ResultColumn => ({
    key: `m${index}`,
    label: measure.label,
    format: measureFormat(measure),
    role: "measure",
  }));
  const grouped = [
    ...rowAliases.map((alias, index) => `cast(${q(alias)} as VARCHAR) as ${q(`r${index}`)}, grouping(${q(alias)}) as ${q(`g${index}`)}`),
    ...(columnExpression
      ? columnAliases.flatMap((alias, index) => [
          `cast(${q(alias)} as VARCHAR) as ${index === 0 ? "pivot_column" : `pivot_column_${index}`}`,
          `grouping(${q(alias)}) as ${index === 0 ? "gc" : `gc_${index}`}`,
        ])
      : [`null::VARCHAR as pivot_column`, "0 as gc"]),
    ...query.measures.map((measure, index) => `${aggregate(measure)} as ${q(`m${index}`)}`),
    // How many currencies each cell adds up (decision 694), so a subtotal over two currencies is left blank.
    ...query.measures.flatMap((measure, index) => {
      const currency = measure.aggregate === "formula" ? null : currencyFieldOf(measure as BaseMeasure, types);
      return currency ? [`count(distinct case when ${q(measure.field!)} is not null then ${q(currency)} end) as ${q(`m${index}_ccy`)}`] : [];
    }),
  ];
  // Each group's rows, then its subtotal, then the next group; the grand total last. Rows sort by
  // their fields, smallest first (the editor has no order for a pivot: each column has its own values).
  const rowOrder = rowAliases.map((alias) => `grouping(${q(alias)}), ${q(alias)} asc nulls last`);
  // A column's subtotal comes after the columns inside it.
  const columnOrder = columnAliases.flatMap((alias) => [`grouping(${q(alias)})`, `${q(alias)} asc nulls last`]);
  const sql = `${filtered} select ${grouped.join(", ")} from filtered group by grouping sets (${groupingSets.join(", ")}) ` +
    `order by ${[...rowOrder, ...columnOrder].join(", ")}`;
  return { sql, countSql, params, rowFields, columnField, columnFields, measures, hasColumn: columnExpression !== null };
}

export type PivotDrillBuilt = { sql: string; params: unknown[]; columns: ResultColumn[] };

/** Read only the saved tile's grouping and measure fields for one selected pivot cell. */
export function buildPivotDrillSql(
  query: TileQuery,
  tableColumns: ColumnInfo[],
  dashboard: DashboardFilters,
  selection: PivotDrillSelection,
): PivotDrillBuilt {
  if (!query.pivot) throw new ValidationError("That tile isn't a pivot table.");
  if (
    !Number.isInteger(selection.depth) ||
    selection.depth < 0 ||
    selection.depth > query.pivot.rows.length ||
    !Array.isArray(selection.dimensions) ||
    selection.dimensions.length !== query.pivot.rows.length ||
    selection.dimensions.some((value) => value !== null && typeof value !== "string") ||
    typeof selection.total !== "boolean" ||
    (query.pivot.column ? (selection.pivotValue !== null && typeof selection.pivotValue !== "string") : selection.total || selection.pivotValue !== null) ||
    (selection.pivotPath !== undefined &&
      (!Array.isArray(selection.pivotPath) ||
        selection.pivotPath.length < 1 ||
        selection.pivotPath.length > 1 + (query.pivot.subColumns?.length ?? 0) ||
        !query.pivot.column ||
        selection.pivotPath.some((value) => value !== null && typeof value !== "string")))
  ) {
    throw new ValidationError("That pivot cell can't be opened.");
  }
  const types = new Map(tableColumns.map((entry) => [entry.name, entry.type]));
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const q = quoteIdentifier;
  const conditions = filterSql(query, types, dashboard, param);
  const extra: string[] = [];
  const expression = (dimension: PivotDimension) => {
    const field = q(dimension.field);
    return dimension.grain ? `cast(date_trunc('${dimension.grain}', ${field}) as DATE)` : field;
  };
  for (let index = 0; index < selection.depth; index += 1) {
    const dimension = query.pivot.rows[index];
    const value = selection.dimensions[index];
    const field = expression(dimension);
    extra.push(value === null ? `${field} is null` : `cast(${field} as VARCHAR) = ${param(value)}`);
  }
  if (query.pivot.column && !selection.total) {
    // With nested column fields, every value down the column's path; otherwise the one column value.
    const columnDimensions = [query.pivot.column, ...(query.pivot.subColumns ?? [])];
    const path = selection.pivotPath ?? [selection.pivotValue];
    path.forEach((value, index) => {
      const field = expression(columnDimensions[index]);
      extra.push(value === null ? `${field} is null` : `cast(${field} as VARCHAR) = ${param(value)}`);
    });
  }
  const where = conditions
    ? `${conditions}${extra.length ? ` and ${extra.join(" and ")}` : ""}`
    : extra.length
      ? ` where ${extra.join(" and ")}`
      : "";
  const fields = [
    ...query.pivot.rows.map((dimension) => dimension.field),
    ...(query.pivot.column ? [query.pivot.column.field] : []),
    ...(query.pivot.subColumns ?? []).map((dimension) => dimension.field),
    ...query.measures.flatMap((measure) => [measure.field, measure.times].filter((field): field is string => Boolean(field))),
    ...(query.dateField ? [query.dateField] : []),
  ].filter((field, index, all) => all.indexOf(field) === index);
  const measureFields = new Set(query.measures.flatMap((measure) => [measure.field, measure.times].filter((field): field is string => Boolean(field))));
  const columns = fields.map((field, index): ResultColumn => ({
    key: `d${index}`,
    label: field,
    format: formatOfType(types.get(field)!),
    role: measureFields.has(field) ? "measure" : "category",
  }));
  const selected = fields.map((field, index) => `${q(field)} as ${q(`d${index}`)}`);
  const sql = `select ${selected.join(", ")} from ${q(query.table)}${where} ` +
    `order by ${query.pivot.rows.map((dimension) => `${q(dimension.field)} asc nulls last`).join(", ")} limit ${MAX_PIVOT_DRILL_ROWS + 1}`;
  return { sql, params, columns };
}

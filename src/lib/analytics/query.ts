import { ValidationError } from "@/lib/errors";
import { exactAverageSql } from "@/lib/analytics/decimal-sql";

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
export type FilterOp = "eq" | "neq" | "in" | "contains" | "gt" | "gte" | "lt" | "lte";
export type Visual = "column" | "bar" | "line" | "area" | "combo" | "pie" | "donut" | "kpi" | "table" | "pivot";

export type PivotDimension = { field: string; grain?: PivotGrain };
export type PivotSpec = { rows: PivotDimension[]; column: PivotDimension | null };

export type Measure = {
  label: string;
  aggregate: Aggregate;
  /** Not needed to count rows. */
  field?: string;
  /** Multiplies `field` row by row first, e.g. quantity x unit_price. */
  times?: string;
  /** Adds the same measure for the same period a year before. */
  compare?: "previous_year";
  /** Shows it the other way round: each amount negated, e.g. so credits such as sales show as positive (AB2). */
  negate?: boolean;
};

export type Filter = { field: string; op: FilterOp; value: string | string[] };

export type TileQuery = {
  table: string;
  groupBy: { field: string; grain?: Grain } | null;
  pivot?: PivotSpec | null;
  measures: Measure[];
  filters: Filter[];
  /** The date field the dashboard's date range applies to. */
  dateField: string | null;
  sort: { by: "category" | "value"; direction: "asc" | "desc" };
  /** Top N (after sorting). */
  limit: number | null;
};

export type ColumnInfo = { name: string; type: string };
export type ValueFormat = "money" | "number" | "integer" | "date" | "text" | "percent";
export type ResultColumn = { key: string; label: string; format: ValueFormat; role: "category" | "measure" };
export type PivotColumn = { key: string; label: string; pivotValue: string | null; measure: ResultColumn; total: boolean };
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
  columnValues: Array<string | null>;
  columns: PivotColumn[];
  rows: PivotRow[];
};
export type PivotDrillSelection = { depth: number; dimensions: Array<string | null>; pivotValue: string | null; total: boolean };
export type PivotDrillResult = { columns: ResultColumn[]; rows: Array<Record<string, string | null>>; truncated: boolean };
export type QueryResult = { columns: ResultColumn[]; rows: Array<Record<string, string | null>>; truncated: boolean; pivot?: PivotData };

/** What a dashboard adds on top of each tile's own filters. */
export type DashboardFilters = {
  from?: string | null;
  to?: string | null;
  /** Slicers: field -> chosen values (applied to tiles whose table has the field). */
  values?: Record<string, string[]>;
};

export const MAX_ROWS = 5000;
export const MAX_PIVOT_CELLS = 2000;
export const MAX_PIVOT_DRILL_ROWS = 500;
const GRAINS: Grain[] = ["day", "week", "month", "quarter", "year"];
const PIVOT_GRAINS: PivotGrain[] = ["month", "quarter", "year"];
const AGGREGATES: Aggregate[] = ["sum", "avg", "min", "max", "count", "count_distinct"];
const OPS: FilterOp[] = ["eq", "neq", "in", "contains", "gt", "gte", "lt", "lte"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    const fields = [...rows.map((entry) => entry.field), ...(pivotColumn ? [pivotColumn.field] : [])];
    if (new Set(fields).size !== fields.length) throw new ValidationError("A pivot field can only be used once.");
    pivot = { rows, column: pivotColumn };
  }

  if (!Array.isArray(raw.measures) || raw.measures.length === 0) throw new ValidationError("Add at least one value to show.");
  if (raw.measures.length > 6) throw new ValidationError("A tile can show up to 6 values.");
  const measures = raw.measures.map((entry, index): Measure => {
    const measure = (entry ?? {}) as Record<string, unknown>;
    const aggregate = measure.aggregate as Aggregate;
    if (!AGGREGATES.includes(aggregate)) throw new ValidationError(`Value ${index + 1}: choose how to add it up.`);
    if (pivot && aggregate === "count_distinct") throw new ValidationError(`Value ${index + 1}: pivot values can be summed, counted, averaged, or compared by smallest or largest.`);
    const label = typeof measure.label === "string" && measure.label.trim() ? measure.label.trim().slice(0, 80) : `Value ${index + 1}`;
    const result: Measure = { label, aggregate };
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
    if (measure.compare === "previous_year") {
      if (pivot) throw new ValidationError(`${label}: a pivot table can't compare with last year.`);
      if (!groupBy?.grain) throw new ValidationError(`${label}: comparing with last year needs the tile grouped by a date.`);
      result.compare = "previous_year";
    }
    return result;
  });

  const filters = (Array.isArray(raw.filters) ? raw.filters : []).map((entry, index): Filter => {
    const filter = (entry ?? {}) as Record<string, unknown>;
    const field = column(columns, filter.field, `Filter ${index + 1}`);
    const op = filter.op as FilterOp;
    if (!OPS.includes(op)) throw new ValidationError(`Filter ${index + 1}: choose how to compare.`);
    if (op === "in") {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 200) {
        throw new ValidationError(`Filter ${index + 1}: choose between 1 and 200 values.`);
      }
      return { field, op, value: filter.value.map(String) };
    }
    if (typeof filter.value !== "string" && typeof filter.value !== "number") throw new ValidationError(`Filter ${index + 1}: enter a value.`);
    return { field, op, value: String(filter.value) };
  });
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
  return { table, groupBy, pivot, measures, filters, dateField, sort, limit };
}

type Built = { sql: string; params: unknown[]; columns: ResultColumn[] };

function filterSql(
  query: TileQuery,
  types: Map<string, string>,
  dashboard: DashboardFilters,
  param: (value: unknown) => string,
  shiftYears = 0,
): string {
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
    return param(value);
  };
  const where: string[] = [];
  for (const filter of query.filters) {
    const field = q(filter.field);
    switch (filter.op) {
      case "in":
        where.push(`${field} in (${(filter.value as string[]).map((value) => typed(filter.field, value)).join(", ")})`);
        break;
      case "contains":
        where.push(`contains(lower(cast(${field} as VARCHAR)), lower(${param(String(filter.value))}))`);
        break;
      default: {
        const symbol = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.op];
        where.push(`${field} ${symbol} ${typed(filter.field, String(filter.value))}`);
      }
    }
  }
  for (const [field, values] of Object.entries(dashboard.values ?? {})) {
    if (!types.has(field) || values.length === 0) continue;
    where.push(`cast(${q(field)} as VARCHAR) in (${values.slice(0, 200).map((value) => param(String(value))).join(", ")})`);
  }
  if (query.dateField) {
    const shifted = shiftYears ? ` + interval ${shiftYears} year` : "";
    if (dashboard.from) {
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

/** The SQL for a tile, with the dashboard's date range and slicers applied. */
export function buildTileSql(query: TileQuery, tableColumns: ColumnInfo[], dashboard: DashboardFilters = {}): Built {
  const types = new Map(tableColumns.map((entry) => [entry.name, entry.type]));
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const q = quoteIdentifier;

  const conditions = (shiftYears: number) => filterSql(query, types, dashboard, param, shiftYears);

  const measureSql = (measure: Measure) => {
    if (measure.aggregate === "count") return measure.field ? `count(${q(measure.field)})` : "count(*)";
    if (measure.aggregate === "count_distinct") return `count(distinct ${q(measure.field!)})`;
    const plain = measure.times ? `(${q(measure.field!)} * ${q(measure.times)})` : q(measure.field!);
    const value = measure.negate ? `(-${plain})` : plain;
    if (measure.aggregate === "avg") return exactAverageSql(value);
    return `${measure.aggregate}(${value})`;
  };
  const measureFormat = (measure: Measure): ValueFormat => {
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
  query.measures.forEach((measure, index) => {
    columns.push({ key: `m${index}`, label: measure.label, format: measureFormat(measure), role: "measure" });
    if (measure.compare) columns.push({ key: `m${index}_py`, label: `${measure.label} last year`, format: measureFormat(measure), role: "measure" });
  });

  const select = (shiftYears: number) => {
    const shiftedCategory =
      shiftYears && query.groupBy?.grain
        ? `cast(date_trunc('${query.groupBy.grain}', ${q(query.groupBy.field)} + interval ${shiftYears} year) as DATE)`
        : category;
    const parts = [
      ...(query.groupBy ? [`${shiftedCategory} as category`] : []),
      ...query.measures.map((measure, index) => `${measureSql(measure)} as m${index}`),
    ];
    return `select ${parts.join(", ")} from ${q(query.table)}${conditions(shiftYears)}${query.groupBy ? " group by all" : ""}`;
  };

  const order = (alias: string) => {
    if (!query.groupBy) return "";
    const by = query.sort.by === "value" ? `${alias}m0` : `${alias}category`;
    return ` order by ${by} ${query.sort.direction} nulls last`;
  };
  const limit = ` limit ${Math.min(query.limit ?? MAX_ROWS + 1, MAX_ROWS + 1)}`;

  const compares = query.measures.some((measure) => measure.compare);
  let sql: string;
  if (compares && query.groupBy) {
    const previous = query.measures
      .map((measure, index) => (measure.compare ? `, previous.m${index} as m${index}_py` : ""))
      .join("");
    const current = query.measures.map((_measure, index) => `, current.m${index}`).join("");
    sql = `with current as (${select(0)}), previous as (${select(1)}) select current.category${current}${previous} from current left join previous on previous.category = current.category${order("current.")}${limit}`;
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
  const columnExpression = pivot.column ? expression(pivot.column) : null;
  const rowAliases = pivot.rows.map((_dimension, index) => internalAlias(`_tohyee_pivot_row_${index}`));
  const pivotAlias = internalAlias("_tohyee_pivot_column");
  const filter = filterSql(query, types, dashboard, param);
  const filteredColumns = [
    "*",
    ...rowExpressions.map((entry, index) => `${entry} as ${q(rowAliases[index])}`),
    ...(columnExpression ? [`${columnExpression} as ${q(pivotAlias)}`] : []),
  ];
  const filtered = `with filtered as (select ${filteredColumns.join(", ")} from ${q(query.table)}${filter})`;
  const rowGroups = (depth: number) => rowAliases.slice(0, depth).map(q);
  const rowGroupingSets = Array.from({ length: pivot.rows.length + 1 }, (_, index) => {
    const fields = rowGroups(pivot.rows.length - index);
    return `(${fields.join(", ")})`;
  });
  const countSql = `${filtered}, row_groups as (select ${rowAliases.map(q).join(", ")} from filtered group by grouping sets (${rowGroupingSets.join(", ")}))` +
    `${columnExpression ? `, column_groups as (select ${q(pivotAlias)} from filtered group by ${q(pivotAlias)})` : ""} ` +
    `select (select count(*) from row_groups) as row_groups${columnExpression ? ", (select count(*) from column_groups) as column_groups" : ""}`;

  const groupingSets: string[] = [];
  for (let depth = pivot.rows.length; depth >= 0; depth -= 1) {
    const prefix = rowGroups(depth);
    if (columnExpression) {
      groupingSets.push(`(${[...prefix, q(pivotAlias)].join(", ")})`, `(${prefix.join(", ")})`);
    } else {
      groupingSets.push(`(${prefix.join(", ")})`);
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
  const columnField = pivot.column
    ? {
        key: "pivot_column",
        label: pivot.column.field,
        format: pivot.column.grain ? "date" as const : formatOfType(types.get(pivot.column.field)!),
        role: "category" as const,
      }
    : null;
  const measures = query.measures.map((measure, index): ResultColumn => ({
    key: `m${index}`,
    label: measure.label,
    format: measureFormat(measure),
    role: "measure",
  }));
  const grouped = [
    ...rowAliases.map((alias, index) => `cast(${q(alias)} as VARCHAR) as ${q(`r${index}`)}, grouping(${q(alias)}) as ${q(`g${index}`)}`),
    ...(columnExpression
      ? [`cast(${q(pivotAlias)} as VARCHAR) as pivot_column`, `grouping(${q(pivotAlias)}) as gc`]
      : [`null::VARCHAR as pivot_column`, "0 as gc"]),
    ...query.measures.map((measure, index) => `${aggregate(measure)} as ${q(`m${index}`)}`),
  ];
  const groupingId = `grouping_id(${rowAliases.map(q).join(", ")})`;
  const order = query.sort.by === "value"
    ? `${q("m0")} ${query.sort.direction} nulls last`
    : `${q(rowAliases[0])} ${query.sort.direction} nulls last`;
  const columnOrder = columnExpression ? `, grouping(${q(pivotAlias)}), ${q(pivotAlias)} asc nulls last` : "";
  const sql = `${filtered} select ${grouped.join(", ")} from filtered group by grouping sets (${groupingSets.join(", ")}) ` +
    `order by ${groupingId}, ${order}${columnOrder}`;
  return { sql, countSql, params, rowFields, columnField, measures, hasColumn: columnExpression !== null };
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
    (query.pivot.column ? (selection.pivotValue !== null && typeof selection.pivotValue !== "string") : selection.total || selection.pivotValue !== null)
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
    const field = expression(query.pivot.column);
    extra.push(
      selection.pivotValue === null
        ? `${field} is null`
        : `cast(${field} as VARCHAR) = ${param(selection.pivotValue)}`,
    );
  }
  const where = conditions
    ? `${conditions}${extra.length ? ` and ${extra.join(" and ")}` : ""}`
    : extra.length
      ? ` where ${extra.join(" and ")}`
      : "";
  const fields = [
    ...query.pivot.rows.map((dimension) => dimension.field),
    ...(query.pivot.column ? [query.pivot.column.field] : []),
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

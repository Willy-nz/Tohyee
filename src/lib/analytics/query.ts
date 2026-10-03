import { ValidationError } from "@/lib/errors";

/**
 * A dashboard tile's question, turned into SQL for DuckDB (analytics step 3).
 * Field names are only ever ones the table really has (checked against its
 * columns), quoted as identifiers; every value a person types is passed as
 * a parameter, never put into the SQL text. Money stays exact: sums of
 * decimals come back as decimal strings.
 */

export type Grain = "day" | "week" | "month" | "quarter" | "year";
export type Aggregate = "sum" | "avg" | "min" | "max" | "count" | "count_distinct";
export type FilterOp = "eq" | "neq" | "in" | "contains" | "gt" | "gte" | "lt" | "lte";
export type Visual = "column" | "bar" | "line" | "area" | "combo" | "pie" | "donut" | "kpi" | "table";

export type Measure = {
  label: string;
  aggregate: Aggregate;
  /** Not needed to count rows. */
  field?: string;
  /** Multiplies `field` row by row first, e.g. quantity x unit_price. */
  times?: string;
  /** Adds the same measure for the same period a year before. */
  compare?: "previous_year";
};

export type Filter = { field: string; op: FilterOp; value: string | string[] };

export type TileQuery = {
  table: string;
  groupBy: { field: string; grain?: Grain } | null;
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
export type QueryResult = { columns: ResultColumn[]; rows: Array<Record<string, string | null>>; truncated: boolean };

/** What a dashboard adds on top of each tile's own filters. */
export type DashboardFilters = {
  from?: string | null;
  to?: string | null;
  /** Slicers: field -> chosen values (applied to tiles whose table has the field). */
  values?: Record<string, string[]>;
};

export const MAX_ROWS = 5000;
const GRAINS: Grain[] = ["day", "week", "month", "quarter", "year"];
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

  if (!Array.isArray(raw.measures) || raw.measures.length === 0) throw new ValidationError("Add at least one value to show.");
  if (raw.measures.length > 6) throw new ValidationError("A tile can show up to 6 values.");
  const measures = raw.measures.map((entry, index): Measure => {
    const measure = (entry ?? {}) as Record<string, unknown>;
    const aggregate = measure.aggregate as Aggregate;
    if (!AGGREGATES.includes(aggregate)) throw new ValidationError(`Value ${index + 1}: choose how to add it up.`);
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
    if (measure.compare === "previous_year") {
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
  return { table, groupBy, measures, filters, dateField, sort, limit };
}

type Built = { sql: string; params: unknown[]; columns: ResultColumn[] };

/** The SQL for a tile, with the dashboard's date range and slicers applied. */
export function buildTileSql(query: TileQuery, tableColumns: ColumnInfo[], dashboard: DashboardFilters = {}): Built {
  const types = new Map(tableColumns.map((entry) => [entry.name, entry.type]));
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const q = quoteIdentifier;

  // Values are compared as the column's own type.
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

  const conditions = (shiftYears: number) => {
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
      // Last year's figures use the same range a year earlier.
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
  };

  const measureSql = (measure: Measure) => {
    if (measure.aggregate === "count") return measure.field ? `count(${q(measure.field)})` : "count(*)";
    if (measure.aggregate === "count_distinct") return `count(distinct ${q(measure.field!)})`;
    const value = measure.times ? `(${q(measure.field!)} * ${q(measure.times)})` : q(measure.field!);
    if (measure.aggregate === "avg") return `cast(avg(${value}) as DECIMAL(38,6))`;
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

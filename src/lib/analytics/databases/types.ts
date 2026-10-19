import type { ColumnKind } from "@/lib/analytics/engine";
import type { DatabaseEngine } from "@/lib/analytics/databases/config";

/**
 * How an external database's columns load into DuckDB (decision 605). The
 * database says what each column is, so nothing is guessed from values:
 * exact decimals stay exact decimals (money when they have up to two
 * places), dates stay dates, date-times keep their local time, yes/no stays
 * yes/no, and binary data (files, images, map shapes) can't be loaded.
 * Every value travels as text and DuckDB converts it, as with files.
 *
 * Browser-safe.
 */

export type ExternalColumn = {
  name: string;
  /** The database's own name for the type, lower case: "numeric", "datetime2", "newdecimal". */
  type: string;
  precision: number | null;
  scale: number | null;
  /** MySQL: a binary string or blob rather than text. */
  binary?: boolean;
  /** MySQL: the column's display length (TINYINT(1) is a yes/no). */
  length?: number | null;
};

export type ColumnSuggestion = {
  kind: ColumnKind;
  /** False for binary data, which isn't loaded. */
  loadable: boolean;
};

const MONEY_WORDS = /(price|amount|cost|total|sales|revenue|spend|value|fee|gst|tax|net|gross|margin|profit|discount|balance|paid)/i;
const QUANTITY_WORDS = /(qty|quantity|units|hours|weight|litres|liters|kg)/i;

function decimalKind(column: ExternalColumn): ColumnKind {
  const scale = column.scale;
  if (scale === 0 && column.precision !== null && column.precision <= 18) return "integer";
  if (scale !== null && scale <= 2) return "money";
  if (scale !== null && scale <= 4 && QUANTITY_WORDS.test(column.name)) return "quantity";
  if (scale === null && MONEY_WORDS.test(column.name)) return "money";
  return "decimal";
}

const BINARY = { kind: "text" as ColumnKind, loadable: false };
const kind = (value: ColumnKind): ColumnSuggestion => ({ kind: value, loadable: true });

function postgresKind(column: ExternalColumn): ColumnSuggestion {
  switch (column.type) {
    case "int2":
    case "int4":
    case "int8":
    case "smallint":
    case "integer":
    case "bigint":
    case "oid":
      return kind("integer");
    case "numeric":
    case "decimal":
      return kind(decimalKind(column));
    case "money":
      return kind("money");
    case "float4":
    case "float8":
    case "real":
    case "double precision":
      return kind(QUANTITY_WORDS.test(column.name) ? "quantity" : "decimal");
    case "bool":
    case "boolean":
      return kind("boolean");
    case "date":
      return kind("date");
    case "timestamp":
    case "timestamptz":
      return kind("timestamp");
    case "bytea":
    case "geometry":
    case "geography":
      return BINARY;
    default:
      return kind("text");
  }
}

function mysqlKind(column: ExternalColumn): ColumnSuggestion {
  switch (column.type) {
    case "tiny":
      return kind(column.length === 1 ? "boolean" : "integer");
    case "short":
    case "long":
    case "int24":
    case "longlong":
    case "year":
      return kind("integer");
    case "decimal":
    case "newdecimal":
      return kind(decimalKind(column));
    case "float":
    case "double":
      return kind(QUANTITY_WORDS.test(column.name) ? "quantity" : "decimal");
    case "bit":
      return kind(column.length === 1 ? "boolean" : "integer");
    case "date":
    case "newdate":
      return kind("date");
    case "datetime":
    case "timestamp":
      return kind("timestamp");
    case "geometry":
    case "vector":
      return BINARY;
    case "tiny_blob":
    case "medium_blob":
    case "long_blob":
    case "blob":
    case "var_string":
    case "string":
    case "varchar":
      return column.binary ? BINARY : kind("text");
    default:
      return kind("text");
  }
}

function sqlServerKind(column: ExternalColumn): ColumnSuggestion {
  switch (column.type) {
    case "tinyint":
    case "smallint":
    case "int":
    case "bigint":
      return kind("integer");
    case "decimal":
    case "numeric":
      return kind(decimalKind(column));
    case "money":
    case "smallmoney":
      return kind("money");
    case "float":
    case "real":
      return kind(QUANTITY_WORDS.test(column.name) ? "quantity" : "decimal");
    case "bit":
      return kind("boolean");
    case "date":
      return kind("date");
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
      return kind("timestamp");
    case "binary":
    case "varbinary":
    case "image":
    case "timestamp":
    case "rowversion":
    case "geography":
    case "geometry":
    case "hierarchyid":
    case "udt":
      return BINARY;
    default:
      return kind("text");
  }
}

/** How a database column loads, unless someone changes it. */
export function suggestColumn(engine: DatabaseEngine, column: ExternalColumn): ColumnSuggestion {
  if (engine === "postgres") return postgresKind(column);
  if (engine === "mysql") return mysqlKind(column);
  return sqlServerKind(column);
}

/** A name quoted for the database: "name" (PostgreSQL), `name` (MySQL), [name] (SQL Server). */
export function quoteName(engine: DatabaseEngine, name: string): string {
  if (engine === "mysql") return `\`${name.replaceAll("`", "``")}\``;
  if (engine === "sqlserver") return `[${name.replaceAll("]", "]]")}]`;
  return `"${name.replaceAll('"', '""')}"`;
}

/** schema.table, quoted; MySQL's "schema" is the connection's database, so it's left out. */
export function quoteObject(engine: DatabaseEngine, schema: string | null, table: string): string {
  return schema && engine !== "mysql" ? `${quoteName(engine, schema)}.${quoteName(engine, table)}` : quoteName(engine, table);
}

export const QUERY_ALIAS = "tohyee_q";

/**
 * The expression Tohyee selects for a column, so its value arrives as exact
 * text: SQL Server's decimals and money (which its driver would otherwise
 * turn into floating-point numbers), its dates in ISO form and its
 * date-times without their offset; PostgreSQL's money as a plain number;
 * MySQL's BIT as a number.
 */
export function selectExpression(engine: DatabaseEngine, column: ExternalColumn): string {
  const ref = `${QUERY_ALIAS}.${quoteName(engine, column.name)}`;
  if (engine === "postgres") {
    return column.type === "money" ? `(${ref})::numeric` : ref;
  }
  if (engine === "mysql") {
    return column.type === "bit" ? `cast(${ref} as unsigned)` : ref;
  }
  switch (column.type) {
    case "decimal":
    case "numeric":
      return `convert(varchar(64), ${ref})`;
    case "money":
    case "smallmoney":
      return `convert(varchar(64), ${ref}, 2)`;
    case "float":
    case "real":
      return `convert(varchar(64), ${ref}, 2)`;
    case "date":
      return `convert(varchar(10), ${ref}, 23)`;
    case "datetime":
    case "datetime2":
    case "smalldatetime":
      return `convert(varchar(27), ${ref}, 121)`;
    case "datetimeoffset":
      return `convert(varchar(27), convert(datetime2, ${ref}), 121)`;
    case "bit":
      return `convert(varchar(1), ${ref})`;
    case "uniqueidentifier":
    case "time":
    case "xml":
    case "sql_variant":
      return `convert(nvarchar(max), ${ref})`;
    default:
      return ref;
  }
}

/**
 * Tohyee's SELECT around a table or a typed query: only the chosen
 * columns, each as text-friendly values, and at most `limit` rows.
 */
export function outerSelect(engine: DatabaseEngine, inner: string, columns: readonly ExternalColumn[], limit: number): string {
  const list = columns.map((column) => `${selectExpression(engine, column)} as ${quoteName(engine, column.name)}`).join(", ");
  // The inner query goes on its own lines, so a comment can't swallow the closing bracket.
  if (engine === "sqlserver") return `select top (${limit}) ${list} from (\n${inner}\n) as ${QUERY_ALIAS}`;
  return `select ${list} from (\n${inner}\n) as ${QUERY_ALIAS} limit ${limit}`;
}

/** The query that only finds a result's columns. */
export function describeSelect(engine: DatabaseEngine, inner: string): string {
  if (engine === "sqlserver") return `select top (0) * from (\n${inner}\n) as ${QUERY_ALIAS}`;
  return `select * from (\n${inner}\n) as ${QUERY_ALIAS} limit 0`;
}

/**
 * A value as the text DuckDB converts: dates and date-times lose any time
 * zone offset (the local time is kept), and MySQL's zero dates are blank.
 */
export function valueText(value: unknown, columnKind: ColumnKind): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (value instanceof Date) text = Number.isNaN(value.getTime()) ? "" : value.toISOString().replace("T", " ").replace("Z", "");
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "bigint") text = String(value);
  else if (value instanceof Uint8Array) return null;
  else text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (columnKind === "date" || columnKind === "timestamp") {
    if (/^0000-00-00/.test(text)) return null;
    if (columnKind === "timestamp") text = text.replace(/(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(?:[+-]\d{2}(?::?\d{2})?|Z)$/, "$1");
  }
  return text;
}

/** "CustomerName", "customer name" and "CUSTOMER_NAME" all become customer_name. */
export function snakeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
}

/** The analytics table name for a database table: "dbo.SalesOrders" becomes sales_orders. */
export function tableNameFor(table: string, taken: readonly string[]): string {
  const base =
    snakeName(table)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || "data";
  let start = /^[a-z]/.test(base) ? base : `t_${base}`;
  if (start.startsWith("tohyee_")) start = `x_${start}`;
  let name = start;
  for (let n = 2; taken.includes(name); n += 1) name = `${start}_${n}`;
  return name;
}

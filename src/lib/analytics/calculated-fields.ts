import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { exactDivideSql } from "@/lib/analytics/decimal-sql";
import { listTables } from "@/lib/analytics/engine";
import { parseFieldFormula, type FieldNode } from "@/lib/analytics/formula";
import { formatOfType, quoteIdentifier, type ColumnInfo } from "@/lib/analytics/query";
import { requireAnalytics } from "@/lib/analytics/sources";
import { getOrganisationSettings } from "@/lib/organisations/settings";

/**
 * Calculated fields on a data source (#376 phase 4, decision 772; Looker
 * Studio's calculated fields on a data source as the reference): a formula
 * worked out on each row of a loaded table, saved on that table under a
 * name, so every report's tiles can group, filter and add it up like any of
 * the table's own columns. Its type is worked out (and checked) from the
 * formula, and it only ever reads the same table's own columns, so it can't
 * show anything the table doesn't (decision 697).
 */

export type FieldKind = "money" | "number" | "integer" | "text" | "date" | "boolean";

export type CalculatedField = {
  id: string;
  table: string;
  name: string;
  formula: string;
  description: string | null;
  /** The DuckDB type of its values, e.g. VARCHAR; null when it no longer works on its table. */
  type: string | null;
  /** Why it no longer works (a column it uses was removed), when it doesn't. */
  error?: string;
  /** Its SQL, worked out on each row (server only, never sent). */
  sql?: string;
};

const SQL_TYPES: Record<FieldKind, string> = {
  money: "DECIMAL(38,2)",
  number: "DECIMAL(38,6)",
  integer: "BIGINT",
  text: "VARCHAR",
  date: "DATE",
  boolean: "BOOLEAN",
};

const KIND_WORDS: Record<FieldKind | "blank", string> = {
  money: "money",
  number: "a number",
  integer: "a whole number",
  text: "text",
  date: "a date",
  boolean: "yes or no",
  blank: "blank",
};

type Typed = { sql: string; kind: FieldKind | "blank"; /** A number typed into the formula, and its decimal places. */ literal?: number };

const numeric = (kind: Typed["kind"]) => kind === "money" || kind === "number" || kind === "integer";
const cast = (typed: Typed, kind: FieldKind) => `cast(${typed.sql} as ${SQL_TYPES[kind]})`;
/** Money with a typed number of up to two places stays money (e.g. [amount] + 10). */
const moneyLike = (typed: Typed) => typed.kind === "money" || (typed.literal !== undefined && typed.literal <= 2);

/** One kind for two results (IF, CASE, IFBLANK), or why there isn't one. */
function unify(values: Typed[], what: string): FieldKind | "blank" {
  const kinds = values.map((value) => value.kind).filter((kind) => kind !== "blank");
  if (!kinds.length) return "blank";
  if (kinds.every(numeric)) {
    const known = values.filter((value) => value.kind !== "blank");
    if (known.some((value) => value.kind === "money") && known.every(moneyLike)) return "money";
    if (kinds.every((kind) => kind === "integer")) return "integer";
    return "number";
  }
  const first = kinds[0];
  if (kinds.some((kind) => kind !== first)) {
    throw new ValidationError(`${what} gives ${[...new Set(kinds)].map((kind) => KIND_WORDS[kind]).join(" and ")}; each result should be the same kind (use TEXT() to turn a number into text).`);
  }
  return first;
}

const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * A calculated field's SQL and kind, from its formula and its table's own
 * columns. Every column is quoted and checked; text is quoted with its
 * quotes doubled; numbers are only digits. `yearEndMonth` is the balance
 * month, for FINANCIAL_YEAR and FINANCIAL_QUARTER.
 */
export function compileField(formula: string, columns: ColumnInfo[], yearEndMonth: number): { sql: string; kind: FieldKind } {
  const tree = parseFieldFormula(formula);
  const types = new Map(columns.filter((column) => !column.expression).map((column) => [column.name, column.type]));
  const end = Number.isInteger(yearEndMonth) && yearEndMonth >= 1 && yearEndMonth <= 12 ? yearEndMonth : 3;
  const need = (value: Typed, kinds: Array<FieldKind | "numeric">, what: string) => {
    const ok = kinds.some((kind) => (kind === "numeric" ? numeric(value.kind) : value.kind === kind)) || value.kind === "blank";
    if (!ok) throw new ValidationError(`${what} needs ${kinds.map((kind) => (kind === "numeric" ? "a number" : KIND_WORDS[kind])).join(" or ")}, not ${KIND_WORDS[value.kind]}.`);
  };
  const count = (name: string, args: FieldNode[], least: number, most = least) => {
    if (args.length < least || args.length > most) {
      throw new ValidationError(`${name} takes ${least === most ? least : `${least} to ${most}`} value${most === 1 ? "" : "s"}.`);
    }
  };
  const wholeLiteral = (node: FieldNode, name: string, low: number, high: number): number => {
    if (node.kind !== "number" || node.value.includes(".") || Number(node.value) < low || Number(node.value) > high) {
      throw new ValidationError(`${name}'s last value is a whole number from ${low} to ${high}.`);
    }
    return Number(node.value);
  };

  const compile = (node: FieldNode): Typed => {
    switch (node.kind) {
      case "number": {
        const places = node.value.includes(".") ? node.value.split(".")[1].length : 0;
        return { sql: `cast(${node.value} as ${places ? "DECIMAL(38,6)" : "BIGINT"})`, kind: places ? "number" : "integer", literal: places };
      }
      case "text":
        return { sql: text(node.value), kind: "text" };
      case "boolean":
        return { sql: node.value ? "true" : "false", kind: "boolean" };
      case "blank":
        return { sql: "null", kind: "blank" };
      case "ref": {
        const type = types.get(node.name);
        if (!type) throw new ValidationError(`There's no column called [${node.name}] in this table${columns.some((column) => column.name === node.name) ? " (a calculated field can't use another calculated field)" : ""}.`);
        const format = formatOfType(type);
        const kind: FieldKind = format === "percent" ? "number" : (format as FieldKind);
        return { sql: kind === "date" ? `cast(${quoteIdentifier(node.name)} as DATE)` : quoteIdentifier(node.name), kind };
      }
      case "negate": {
        const operand = compile(node.operand);
        need(operand, ["numeric"], "A minus sign");
        return { sql: `(-${operand.sql})`, kind: operand.kind, ...(operand.literal !== undefined ? { literal: operand.literal } : {}) };
      }
      case "not": {
        const operand = compile(node.operand);
        need(operand, ["boolean"], "NOT");
        return { sql: `(not ${operand.sql})`, kind: "boolean" };
      }
      case "logic": {
        const left = compile(node.left);
        const right = compile(node.right);
        need(left, ["boolean"], node.op.toUpperCase());
        need(right, ["boolean"], node.op.toUpperCase());
        return { sql: `(${left.sql} ${node.op} ${right.sql})`, kind: "boolean" };
      }
      case "binary": {
        const left = compile(node.left);
        const right = compile(node.right);
        if ((left.kind === "text" || right.kind === "text") && node.op === "+") throw new ValidationError("Use CONCAT to join text, e.g. CONCAT([first], \" \", [last]).");
        need(left, ["numeric"], `${node.op}`);
        need(right, ["numeric"], `${node.op}`);
        if (node.op === "/") return { sql: exactDivideSql(left.sql, right.sql), kind: "number" };
        if (node.op === "*") {
          const kind: FieldKind = left.kind === "integer" && right.kind === "integer" ? "integer" : "number";
          return { sql: `cast((${left.sql} * ${right.sql}) as ${SQL_TYPES[kind]})`, kind };
        }
        const money = (left.kind === "money" || right.kind === "money") && moneyLike(left) && moneyLike(right);
        const kind: FieldKind = money ? "money" : left.kind === "integer" && right.kind === "integer" ? "integer" : left.kind === "blank" || right.kind === "blank" ? "number" : "number";
        return { sql: `cast((${left.sql} ${node.op} ${right.sql}) as ${SQL_TYPES[kind]})`, kind };
      }
      case "compare": {
        const left = compile(node.left);
        const right = compile(node.right);
        // A date compared with typed text: the text is a date, YYYY-MM-DD.
        const asDate = (value: Typed, other: Typed) => {
          if (value.kind === "text" && other.kind === "date") {
            const raw = node.left.kind === "text" && value === left ? node.left.value : node.right.kind === "text" ? node.right.value : "";
            if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ValidationError("Compare a date with a date written YYYY-MM-DD, e.g. [sale_date] >= \"2026-04-01\".");
            return { sql: `cast(${value.sql} as DATE)`, kind: "date" as const };
          }
          return value;
        };
        const a = asDate(left, right);
        const b = asDate(right, left);
        const fits = (numeric(a.kind) && numeric(b.kind)) || a.kind === b.kind || a.kind === "blank" || b.kind === "blank";
        if (!fits) throw new ValidationError(`${KIND_WORDS[a.kind]} can't be compared with ${KIND_WORDS[b.kind]}.`);
        if (a.kind === "blank" || b.kind === "blank") throw new ValidationError("Use IS_BLANK() to test for a blank value.");
        return { sql: `(${a.sql} ${node.op} ${b.sql})`, kind: "boolean" };
      }
      case "case": {
        const whens = node.whens.map((branch) => {
          const when = compile(branch.when);
          need(when, ["boolean"], "WHEN");
          return { when, then: compile(branch.then) };
        });
        const otherwise = node.otherwise ? compile(node.otherwise) : { sql: "null", kind: "blank" as const };
        const kind = unify([...whens.map((branch) => branch.then), otherwise], "This CASE");
        if (kind === "blank") return { sql: "null", kind };
        return { sql: `(case ${whens.map((branch) => `when ${branch.when.sql} then ${cast(branch.then, kind)}`).join(" ")} else ${cast(otherwise, kind)} end)`, kind };
      }
      case "call":
        return call(node.name, node.args);
    }
  };

  const call = (name: string, args: FieldNode[]): Typed => {
    switch (name) {
      case "IF": {
        count(name, args, 2, 3);
        const condition = compile(args[0]);
        need(condition, ["boolean"], "IF's first value");
        const yes = compile(args[1]);
        const no = args[2] ? compile(args[2]) : { sql: "null", kind: "blank" as const };
        const kind = unify([yes, no], "This IF");
        if (kind === "blank") return { sql: "null", kind };
        return { sql: `(case when ${condition.sql} then ${cast(yes, kind)} else ${cast(no, kind)} end)`, kind };
      }
      case "IFBLANK": {
        count(name, args, 2);
        const value = compile(args[0]);
        const instead = compile(args[1]);
        const kind = unify([value, instead], "This IFBLANK");
        if (kind === "blank") return { sql: "null", kind };
        return { sql: `coalesce(${cast(value, kind)}, ${cast(instead, kind)})`, kind };
      }
      case "IS_BLANK": {
        count(name, args, 1);
        const value = compile(args[0]);
        return { sql: value.kind === "text" ? `(${value.sql} is null or trim(${value.sql}) = '')` : `(${value.sql} is null)`, kind: "boolean" };
      }
      case "UPPER":
      case "LOWER":
      case "TRIM": {
        count(name, args, 1);
        const value = compile(args[0]);
        need(value, ["text"], name);
        return { sql: `${name.toLowerCase()}(${value.sql})`, kind: "text" };
      }
      case "LENGTH": {
        count(name, args, 1);
        const value = compile(args[0]);
        need(value, ["text"], name);
        return { sql: `cast(length(${value.sql}) as BIGINT)`, kind: "integer" };
      }
      case "LEFT":
      case "RIGHT": {
        count(name, args, 2);
        const value = compile(args[0]);
        need(value, ["text"], name);
        const length = wholeLiteral(args[1], name, 0, 1000);
        return { sql: `${name.toLowerCase()}(${value.sql}, ${length})`, kind: "text" };
      }
      case "REPLACE": {
        count(name, args, 3);
        const [value, find, put] = args.map(compile);
        [value, find, put].forEach((entry) => need(entry, ["text"], name));
        return { sql: `replace(${value.sql}, ${find.sql}, ${put.sql})`, kind: "text" };
      }
      case "CONTAINS": {
        count(name, args, 2);
        const [value, find] = args.map(compile);
        need(value, ["text"], name);
        need(find, ["text"], name);
        return { sql: `contains(lower(${value.sql}), lower(${find.sql}))`, kind: "boolean" };
      }
      case "CONCAT": {
        count(name, args, 2, 20);
        return { sql: `concat(${args.map((arg) => `coalesce(cast(${compile(arg).sql} as VARCHAR), '')`).join(", ")})`, kind: "text" };
      }
      case "TEXT": {
        count(name, args, 1);
        return { sql: `cast(${compile(args[0]).sql} as VARCHAR)`, kind: "text" };
      }
      case "ROUND": {
        count(name, args, 1, 2);
        const value = compile(args[0]);
        need(value, ["numeric"], name);
        const places = args[1] ? wholeLiteral(args[1], name, 0, 6) : 0;
        const kind: FieldKind = value.kind === "money" && places === 2 ? "money" : places === 0 ? "integer" : "number";
        // Half away from zero, as Tohyee rounds money (DuckDB rounds decimals that way).
        return { sql: `cast(round(cast(${value.sql} as DECIMAL(38,6)), ${places}) as ${SQL_TYPES[kind]})`, kind };
      }
      case "ABS": {
        count(name, args, 1);
        const value = compile(args[0]);
        need(value, ["numeric"], name);
        return { sql: `abs(${value.sql})`, kind: value.kind };
      }
      case "YEAR":
      case "QUARTER":
      case "MONTH":
      case "DAY":
      case "WEEKDAY":
      case "MONTH_NAME":
      case "FINANCIAL_YEAR":
      case "FINANCIAL_QUARTER": {
        count(name, args, 1);
        const value = compile(args[0]);
        need(value, ["date"], name);
        const date = value.sql;
        const sql = {
          YEAR: `year(${date})`,
          QUARTER: `quarter(${date})`,
          MONTH: `month(${date})`,
          DAY: `day(${date})`,
          // Monday is 1, Sunday 7 (ISO).
          WEEKDAY: `isodow(${date})`,
          MONTH_NAME: `strftime(${date}, '%b')`,
          // The year a financial year ends in (decision 755: FY2027 ends in 2027).
          FINANCIAL_YEAR: end === 12 ? `year(${date})` : `year(${date} - interval ${end} month) + 1`,
          FINANCIAL_QUARTER: `((month(${date}) - ${end} + 11) % 12) // 3 + 1`,
        }[name];
        return name === "MONTH_NAME" ? { sql, kind: "text" } : { sql: `cast(${sql} as BIGINT)`, kind: "integer" };
      }
      case "DAYS_BETWEEN": {
        count(name, args, 2);
        const [from, to] = args.map(compile);
        need(from, ["date"], name);
        need(to, ["date"], name);
        return { sql: `cast(date_diff('day', ${from.sql}, ${to.sql}) as BIGINT)`, kind: "integer" };
      }
      default:
        throw new ValidationError(`${name}() isn't a function a formula knows. See the list under the formula box.`);
    }
  };

  const result = compile(tree);
  if (result.kind === "blank") throw new ValidationError("That formula is always blank.");
  return { sql: cast(result, result.kind), kind: result.kind };
}

/** The functions a calculated field can use, for the help under the formula box. */
export const FIELD_FUNCTIONS = [
  "IF(test, then, otherwise)",
  "CASE WHEN test THEN value … ELSE value END",
  "AND, OR, NOT, = <> < <= > >=",
  "IS_BLANK(value), IFBLANK(value, instead)",
  "UPPER, LOWER, TRIM, LENGTH, LEFT(text, n), RIGHT(text, n), REPLACE(text, find, put), CONTAINS(text, find), CONCAT(…), TEXT(value)",
  "YEAR, QUARTER, MONTH, DAY, WEEKDAY, MONTH_NAME, FINANCIAL_YEAR, FINANCIAL_QUARTER, DAYS_BETWEEN(from, to)",
  "+ - * /, ROUND(number, places), ABS(number)",
];

/** A table's columns with its working calculated fields added (each with its SQL, for the query's FROM). */
export function withFields(tables: Map<string, ColumnInfo[]>, fields: readonly CalculatedField[] | undefined): Map<string, ColumnInfo[]> {
  if (!fields?.length) return tables;
  const result = new Map(tables);
  for (const field of fields) {
    const columns = result.get(field.table);
    if (!columns || !field.sql || !field.type || columns.some((column) => column.name === field.name)) continue;
    result.set(field.table, [...columns, { name: field.name, type: field.type, expression: field.sql }]);
  }
  return result;
}

type Row = { id: string; table_name: string; name: string; formula: string; description: string | null };

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Every calculated field, each worked out against its table as loaded now. */
export async function listFields(tx: OrgTx, tables?: Map<string, ColumnInfo[]>): Promise<CalculatedField[]> {
  await requireAnalytics(tx);
  const result = await tx.query<Row>("select id::text, table_name, name, formula, description from analytics_fields order by table_name, name, analytics_fields.id");
  if (!result.rows.length) return [];
  const loaded = tables ?? (await listTables(tx.organisationId));
  const yearEnd = (await getOrganisationSettings(tx)).financialYearEndMonth;
  return result.rows.map((row) => {
    const base = { id: row.id, table: row.table_name, name: row.name, formula: row.formula, description: row.description };
    const columns = loaded.get(row.table_name);
    if (!columns) return { ...base, type: null, error: `The table ${row.table_name} isn't loaded.` };
    try {
      const compiled = compileField(row.formula, columns, yearEnd);
      return { ...base, type: SQL_TYPES[compiled.kind], sql: compiled.sql };
    } catch (error) {
      return { ...base, type: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** A field as it's sent to the browser: never its SQL. */
export function publicField(field: CalculatedField): Omit<CalculatedField, "sql"> {
  const { sql: _sql, ...rest } = field;
  void _sql;
  return rest;
}

/** The reports (and saved values) that use a field, by name: a tile on its table naming it anywhere in its question, or a slicer on it. */
export async function fieldUsage(tx: OrgTx, table: string, name: string): Promise<string[]> {
  const quoted = JSON.stringify(name);
  const reports = await tx.query<{ name: string; tiles: Array<{ query?: { table?: string } | null; drill?: unknown }>; settings: { slicers?: Array<{ table?: string; field?: string }>; pages?: unknown } }>(
    "select name, tiles, settings from analytics_dashboards order by lower(name), analytics_dashboards.id",
  );
  const used = reports.rows
    .filter((report) =>
      (report.tiles ?? []).some((tile) => tile.query?.table === table && JSON.stringify([tile.query, tile.drill ?? null]).includes(quoted)) ||
      (report.settings?.slicers ?? []).some((slicer) => slicer.table === table && slicer.field === name) ||
      JSON.stringify(report.settings?.pages ?? null).includes(quoted),
    )
    .map((report) => report.name);
  const measures = await tx.query<{ name: string }>("select name from analytics_measures where table_name = $1 and definition::text like $2 order by lower(name)", [table, `%${quoted.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`]);
  return [...used, ...measures.rows.map((row) => `the saved value ${row.name}`)];
}

async function checked(tx: OrgTx, input: Record<string, unknown>, current: CalculatedField | null) {
  const tables = await listTables(tx.organisationId);
  const table = current?.table ?? (typeof input.table === "string" ? input.table : "");
  const columns = tables.get(table);
  if (!columns) throw new ValidationError(`There's no loaded table called ${table || "that"}.`);
  const name = input.name === undefined && current ? current.name : typeof input.name === "string" ? input.name.trim() : "";
  if (!NAME.test(name)) throw new ValidationError("Name the field in small letters, numbers and underscores, starting with a letter, e.g. size_band (up to 63 characters).");
  if (columns.some((column) => column.name === name)) throw new ValidationError(`${table} already has a column called ${name}.`);
  const formula = input.formula === undefined && current ? current.formula : typeof input.formula === "string" ? input.formula.trim() : "";
  const description = input.description === undefined && current ? current.description : typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 300) : null;
  const yearEnd = (await getOrganisationSettings(tx)).financialYearEndMonth;
  const compiled = compileField(formula, columns, yearEnd);
  return { table, name, formula, description, compiled };
}

export async function createField(tx: OrgTx, input: Record<string, unknown>): Promise<CalculatedField> {
  await requireAnalytics(tx);
  const { table, name, formula, description, compiled } = await checked(tx, input, null);
  const existing = await tx.query("select 1 from analytics_fields where table_name = $1 and name = $2", [table, name]);
  if (existing.rows.length) throw new ValidationError(`There's already a calculated field called ${name} on ${table}.`);
  const result = await tx.query<{ id: string }>(
    "insert into analytics_fields (table_name, name, formula, description, created_by_email, updated_by_email) values ($1, $2, $3, $4, $5, $5) returning id::text",
    [table, name, formula, description, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "analytics.field_saved", entityType: "analytics_field", entityId: result.rows[0].id, details: { table, name } });
  return { id: result.rows[0].id, table, name, formula, description, type: SQL_TYPES[compiled.kind] };
}

async function currentField(tx: OrgTx, id: string): Promise<CalculatedField> {
  const fieldId = /^\d{1,18}$/.test(id) ? id : "0";
  const fields = await listFields(tx);
  const field = fields.find((entry) => entry.id === fieldId);
  if (!field) throw new NotFoundError("That calculated field wasn't found.");
  return field;
}

/**
 * Changes a field's formula or description (decision 772: a field is
 * shared, so a change shows in every tile using it). A field that reports
 * or saved values use can't be renamed or change its kind of value; the
 * refusal names them.
 */
export async function updateField(tx: OrgTx, id: string, input: Record<string, unknown>): Promise<CalculatedField & { usedBy: string[] }> {
  await requireAnalytics(tx);
  const current = await currentField(tx, id);
  const next = await checked(tx, input, current);
  const usedBy = await fieldUsage(tx, current.table, current.name);
  if (usedBy.length && next.name !== current.name) throw new ConflictError(`${current.name} can't be renamed while it's used by ${usedBy.join(", ")}.`);
  if (usedBy.length && current.type && SQL_TYPES[next.compiled.kind] !== current.type) {
    throw new ConflictError(`${current.name} would change from ${typeWords(current.type)} to ${KIND_WORDS[next.compiled.kind]}, which would break ${usedBy.join(", ")}. Save it as a new field instead.`);
  }
  if (next.name !== current.name) {
    const clash = await tx.query("select 1 from analytics_fields where table_name = $1 and name = $2 and id <> $3", [current.table, next.name, current.id]);
    if (clash.rows.length) throw new ValidationError(`There's already a calculated field called ${next.name} on ${current.table}.`);
  }
  await tx.query("update analytics_fields set name = $2, formula = $3, description = $4, updated_by_email = $5, updated_at = now() where id = $1", [current.id, next.name, next.formula, next.description, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "analytics.field_changed", entityType: "analytics_field", entityId: current.id, details: { table: current.table, name: next.name, usedBy: usedBy.length } });
  return { id: current.id, table: current.table, name: next.name, formula: next.formula, description: next.description, type: SQL_TYPES[next.compiled.kind], usedBy };
}

/** Removes a field nothing uses; one in use is refused, naming what uses it. */
export async function deleteField(tx: OrgTx, id: string): Promise<void> {
  await requireAnalytics(tx);
  const current = await currentField(tx, id);
  const usedBy = await fieldUsage(tx, current.table, current.name);
  if (usedBy.length) throw new ConflictError(`${current.name} is used by ${usedBy.join(", ")}. Take it off those first.`);
  await tx.query("delete from analytics_fields where id = $1", [current.id]);
  await writeAuditEvent(tx, { eventType: "analytics.field_deleted", entityType: "analytics_field", entityId: current.id, details: { table: current.table, name: current.name } });
}

function typeWords(type: string): string {
  const kind = (Object.entries(SQL_TYPES).find(([, sql]) => sql === type)?.[0] ?? "text") as FieldKind;
  return KIND_WORDS[kind];
}

/** The loaded tables with the organisation's calculated fields, for checking a tile's question in a transaction. */
export async function tablesWithFields(tx: OrgTx): Promise<Map<string, ColumnInfo[]>> {
  const tables = await listTables(tx.organisationId);
  return withFields(tables, await listFields(tx, tables));
}

import { writeAuditEvent } from "@/lib/audit";
import { isIsoDate } from "@/lib/date-entry";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { isDecimalString } from "@/lib/money/decimal";
import { optionalString, requireArray, requireOneOf, requireString } from "@/lib/validation";

/*
 * The AI's own tables (examples AIW5, AIW6): the AI decides what tables it
 * needs and their columns, and fills them from files, the notebook and the
 * books, however the source was laid out. Values are kept as typed JSON:
 * numbers as exact decimal text, dates as YYYY-MM-DD. Totals and averages are
 * worked out by PostgreSQL in numeric, never in floating point.
 */

export const COLUMN_TYPES = ["text", "number", "date", "boolean"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export type DatasetColumn = { name: string; type: ColumnType; description?: string };
export type Dataset = { id: string; name: string; description: string; columns: DatasetColumn[]; sourceNote: string | null; rowCount: number; updatedAt: string };
export type DatasetValue = string | boolean | null;

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_DATASETS = 100;
const MAX_COLUMNS = 60;
const MAX_ROWS = 50_000;
const MAX_ROWS_PER_CALL = 2_000;

function parseColumns(input: unknown): DatasetColumn[] {
  const columns = requireArray(input, "columns", MAX_COLUMNS).map((raw, index): DatasetColumn => {
    const column = (raw ?? {}) as Record<string, unknown>;
    const name = requireString(column.name, `Column ${index + 1}'s name`, { maxLength: 63 });
    if (!NAME.test(name)) throw new ValidationError(`Column "${name}": use lower-case letters, numbers and _, starting with a letter.`);
    const description = optionalString(column.description, `Column ${name}'s description`, { maxLength: 500 });
    return { name, type: requireOneOf(column.type, `Column ${name}'s type`, COLUMN_TYPES), ...(description ? { description } : {}) };
  });
  if (columns.length === 0) throw new ValidationError("A table needs at least one column.");
  if (new Set(columns.map((column) => column.name)).size !== columns.length) throw new ValidationError("Two columns have the same name.");
  return columns;
}

type DatasetRow = { id: string; name: string; description: string; columns: DatasetColumn[]; source_note: string | null; row_count: number; updated_at: string };

const SELECT = `select d.id::text, d.name, d.description, d.columns, d.source_note,
    (select count(*)::int from ai_dataset_rows r where r.dataset_id = d.id) as row_count,
    to_char(d.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
  from ai_datasets d`;

const toDataset = (row: DatasetRow): Dataset => ({
  id: row.id,
  name: row.name,
  description: row.description,
  columns: row.columns,
  sourceNote: row.source_note,
  rowCount: row.row_count,
  updatedAt: row.updated_at,
});

export async function listDatasets(tx: OrgTx): Promise<Dataset[]> {
  return (await tx.query<DatasetRow>(`${SELECT} where d.archived_at is null order by d.name`)).rows.map(toDataset);
}

export async function getDataset(tx: OrgTx, nameInput: unknown): Promise<Dataset> {
  const name = requireString(nameInput, "The table", { maxLength: 63 });
  const row = (await tx.query<DatasetRow>(`${SELECT} where d.name = $1 and d.archived_at is null`, [name])).rows[0];
  if (!row) throw new NotFoundError(`There's no table "${name}". list_datasets shows them.`);
  return toDataset(row);
}

/** Makes a table (AIW5), or changes an existing one's description and columns (rows must still fit). */
export async function saveDataset(tx: OrgTx, input: { name: unknown; description: unknown; columns: unknown; sourceNote?: unknown }): Promise<Dataset> {
  const name = requireString(input.name, "The table name", { maxLength: 63 });
  if (!NAME.test(name)) throw new ValidationError("Table names use lower-case letters, numbers and _, starting with a letter.");
  const description = requireString(input.description, "The description", { maxLength: 2000 });
  const columns = parseColumns(input.columns);
  const sourceNote = optionalString(input.sourceNote, "sourceNote", { maxLength: 2000 });
  const existing = (await tx.query<{ id: string }>("select id::text from ai_datasets where name = $1 and archived_at is null for update", [name])).rows[0];
  if (existing) {
    const rows = await tx.query<{ data: Record<string, DatasetValue> }>("select data from ai_dataset_rows where dataset_id = $1", [existing.id]);
    for (const row of rows.rows) checkRow(columns, row.data, "An existing row");
    await tx.query("update ai_datasets set description = $2, columns = $3::jsonb, source_note = $4, updated_at = now() where id = $1", [existing.id, description, JSON.stringify(columns), sourceNote]);
  } else {
    const count = await tx.query<{ n: number }>("select count(*)::int as n from ai_datasets where archived_at is null");
    if (count.rows[0].n >= MAX_DATASETS) throw new ValidationError(`There are already ${MAX_DATASETS} tables. Archive some first.`);
    await tx.query("insert into ai_datasets (name, description, columns, source_note, created_by_email) values ($1, $2, $3::jsonb, $4, $5)", [
      name,
      description,
      JSON.stringify(columns),
      sourceNote,
      tx.actor.email,
    ]);
  }
  await writeAuditEvent(tx, { eventType: existing ? "ai_dataset.changed" : "ai_dataset.created", entityType: "ai_dataset", entityId: name, details: { columns: columns.map((column) => column.name) } });
  return getDataset(tx, name);
}

/** Checks a row against the columns and returns it as stored: exact decimal text for numbers, YYYY-MM-DD for dates. */
function checkRow(columns: DatasetColumn[], raw: unknown, label: string): Record<string, DatasetValue> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(`${label} must be an object of column -> value.`);
  const values = raw as Record<string, unknown>;
  const known = new Set(columns.map((column) => column.name));
  for (const key of Object.keys(values)) if (!known.has(key)) throw new ValidationError(`${label} has "${key}", which isn't a column.`);
  const row: Record<string, DatasetValue> = {};
  for (const column of columns) {
    const value = values[column.name];
    if (value === undefined || value === null || value === "") {
      row[column.name] = null;
      continue;
    }
    switch (column.type) {
      case "number": {
        const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/,/g, "") : "";
        if (!isDecimalString(text) || text.replace(/^-/, "").replace(".", "").length > 30) throw new ValidationError(`${label}: ${column.name} should be a number, not ${JSON.stringify(value)}.`);
        row[column.name] = text;
        break;
      }
      case "date":
        if (typeof value !== "string" || !isIsoDate(value)) throw new ValidationError(`${label}: ${column.name} should be a date as YYYY-MM-DD, not ${JSON.stringify(value)}.`);
        row[column.name] = value;
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new ValidationError(`${label}: ${column.name} should be true or false.`);
        row[column.name] = value;
        break;
      default: {
        const text = String(value);
        if (text.length > 2000) throw new ValidationError(`${label}: ${column.name} is longer than 2,000 characters.`);
        row[column.name] = text;
      }
    }
  }
  return row;
}

/** Adds rows to a table (AIW5), or replaces all of them first when `replace` is true (re-organising the AI's own table). */
export async function addDatasetRows(tx: OrgTx, input: { name: unknown; rows: unknown; replace?: unknown }): Promise<Dataset> {
  const dataset = await getDataset(tx, input.name);
  await tx.query("select 1 from ai_datasets where id = $1 for update", [dataset.id]);
  const rows = requireArray(input.rows, "rows", MAX_ROWS_PER_CALL).map((raw, index) => checkRow(dataset.columns, raw, `Row ${index + 1}`));
  if (input.replace === true) await tx.query("delete from ai_dataset_rows where dataset_id = $1", [dataset.id]);
  const next = (await tx.query<{ n: number }>("select coalesce(max(row_no), 0)::int as n from ai_dataset_rows where dataset_id = $1", [dataset.id])).rows[0].n;
  const current = input.replace === true ? 0 : dataset.rowCount;
  if (current + rows.length > MAX_ROWS) throw new ValidationError(`A table can have up to ${MAX_ROWS.toLocaleString("en-NZ")} rows.`);
  if (rows.length > 0) {
    await tx.query(
      `insert into ai_dataset_rows (dataset_id, row_no, data)
       select $1, $2 + ordinality, value from jsonb_array_elements($3::jsonb) with ordinality`,
      [dataset.id, next, JSON.stringify(rows)],
    );
  }
  await tx.query("update ai_datasets set updated_at = now() where id = $1", [dataset.id]);
  await writeAuditEvent(tx, { eventType: "ai_dataset.rows_added", entityType: "ai_dataset", entityId: dataset.name, details: { rows: rows.length, replaced: input.replace === true } });
  return getDataset(tx, dataset.name);
}

export async function archiveDataset(tx: OrgTx, nameInput: unknown): Promise<void> {
  const dataset = await getDataset(tx, nameInput);
  await tx.query("update ai_datasets set archived_at = now() where id = $1", [dataset.id]);
  await writeAuditEvent(tx, { eventType: "ai_dataset.archived", entityType: "ai_dataset", entityId: dataset.name, details: {} });
}

export const AGGREGATES = ["sum", "avg", "min", "max", "count"] as const;
export const OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains"] as const;
export const GRAINS = ["day", "month", "year"] as const;

export type DatasetQuery = {
  name: unknown;
  groupBy?: unknown;
  measures?: unknown;
  filters?: unknown;
  sort?: unknown;
  limit?: unknown;
};

export type QueryResult = { columns: string[]; rows: Array<Record<string, string | boolean | null>>; truncated: boolean };

/**
 * Reads a table (AIW6): its rows, or with `measures`, totals grouped by up to
 * three columns (a date column by day, month or year). Filters compare as the
 * column's type. All values come back as text, numbers exact.
 */
export async function queryDataset(tx: OrgTx, input: DatasetQuery): Promise<QueryResult> {
  const dataset = await getDataset(tx, input.name);
  const columns = new Map(dataset.columns.map((column) => [column.name, column]));
  const params: unknown[] = [dataset.id];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const columnOf = (name: unknown, label: string) => {
    const column = typeof name === "string" ? columns.get(name) : undefined;
    if (!column) throw new ValidationError(`${label}: "${String(name)}" isn't a column of ${dataset.name}.`);
    return column;
  };
  const typed = (column: DatasetColumn) => {
    const ref = `(data ->> ${param(column.name)})`;
    return column.type === "number" ? `${ref}::numeric` : column.type === "date" ? `${ref}::date` : column.type === "boolean" ? `${ref}::boolean` : ref;
  };

  const where: string[] = ["dataset_id = $1"];
  for (const [index, raw] of requireArray(input.filters ?? [], "filters", 20).entries()) {
    const filter = (raw ?? {}) as Record<string, unknown>;
    const column = columnOf(filter.field, `Filter ${index + 1}`);
    const op = requireOneOf(filter.op, `Filter ${index + 1}'s op`, OPERATORS);
    if (op === "contains") {
      where.push(`(data ->> ${param(column.name)}) ilike ${param(`%${String(filter.value ?? "").replace(/[\\%_]/g, (match) => `\\${match}`)}%`)}`);
      continue;
    }
    if (filter.value === null || filter.value === undefined) {
      where.push(`(data ->> ${param(column.name)}) is ${op === "ne" ? "not " : ""}null`);
      continue;
    }
    const checked = checkRow([column], { [column.name]: filter.value }, `Filter ${index + 1}`)[column.name];
    const sql = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
    const cast = column.type === "number" ? "::numeric" : column.type === "date" ? "::date" : column.type === "boolean" ? "::boolean" : "";
    where.push(`${typed(column)} ${sql} ${param(String(checked))}${cast}`);
  }
  const limit = Math.min(Math.max(Number(input.limit ?? 200) || 200, 1), 1000);
  const measures = requireArray(input.measures ?? [], "measures", 10).map((raw, index) => {
    const measure = (raw ?? {}) as Record<string, unknown>;
    const aggregate = requireOneOf(measure.aggregate, `Measure ${index + 1}'s aggregate`, AGGREGATES);
    if (aggregate === "count") return { label: typeof measure.label === "string" && measure.label ? measure.label : "count", sql: "count(*)" };
    const column = columnOf(measure.field, `Measure ${index + 1}`);
    if (column.type !== "number" && (aggregate === "sum" || aggregate === "avg")) throw new ValidationError(`Measure ${index + 1}: ${column.name} isn't a number column.`);
    const label = typeof measure.label === "string" && measure.label ? measure.label : `${aggregate}_${column.name}`;
    const body = aggregate === "avg" ? `round(avg(${typed(column)}), 4)` : `${aggregate}(${typed(column)})`;
    return { label, sql: body };
  });

  if (measures.length === 0) {
    const rows = await tx.query<{ data: Record<string, DatasetValue> }>(
      `select data from ai_dataset_rows where ${where.join(" and ")} order by row_no limit ${param(limit + 1)}`,
      params,
    );
    return {
      columns: dataset.columns.map((column) => column.name),
      rows: rows.rows.slice(0, limit).map((row) => row.data as Record<string, string | boolean | null>),
      truncated: rows.rows.length > limit,
    };
  }

  const groups = requireArray(input.groupBy ?? [], "groupBy", 3).map((raw, index) => {
    const group = (typeof raw === "string" ? { field: raw } : (raw ?? {})) as Record<string, unknown>;
    const column = columnOf(group.field, `Group ${index + 1}`);
    if (group.grain !== undefined && group.grain !== null) {
      const grain = requireOneOf(group.grain, `Group ${index + 1}'s grain`, GRAINS);
      if (column.type !== "date") throw new ValidationError(`Group ${index + 1}: only date columns have a grain.`);
      const format = grain === "day" ? "YYYY-MM-DD" : grain === "month" ? "YYYY-MM" : "YYYY";
      return { label: column.name, sql: `to_char((data ->> ${param(column.name)})::date, '${format}')` };
    }
    return { label: column.name, sql: `(data ->> ${param(column.name)})` };
  });
  const select = [...groups.map((group, index) => `${group.sql} as g${index}`), ...measures.map((measure, index) => `(${measure.sql})::text as m${index}`)];
  const sortInput = (input.sort ?? null) as { by?: unknown; direction?: unknown } | null;
  const direction = sortInput?.direction === "desc" ? "desc" : "asc";
  const labels = [...groups.map((group) => group.label), ...measures.map((measure) => measure.label)];
  let orderBy = groups.length > 0 ? groups.map((_, index) => `g${index}`).join(", ") : "1";
  if (sortInput?.by !== undefined) {
    const at = labels.indexOf(String(sortInput.by));
    if (at < 0) throw new ValidationError(`sort.by must be one of: ${labels.join(", ")}.`);
    const target = at < groups.length ? `g${at}` : `(${measures[at - groups.length].sql})`;
    orderBy = `${target} ${direction} nulls last`;
  }
  const sql = `select ${select.join(", ")} from ai_dataset_rows where ${where.join(" and ")}
    ${groups.length > 0 ? `group by ${groups.map((_, index) => `g${index}`).join(", ")}` : ""} order by ${orderBy} limit ${param(limit + 1)}`;
  const result = await tx.query<Record<string, string | null>>(sql, params);
  const rows = result.rows.slice(0, limit).map((row) => {
    const out: Record<string, string | null> = {};
    groups.forEach((group, index) => (out[group.label] = row[`g${index}`]));
    measures.forEach((measure, index) => (out[measure.label] = row[`m${index}`]));
    return out;
  });
  return { columns: labels, rows, truncated: result.rows.length > limit };
}

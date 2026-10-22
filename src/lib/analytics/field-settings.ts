import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { parseNumberFormat, type NumberFormat } from "@/lib/analytics/chart-format";
import { listTables, runBuiltQuery } from "@/lib/analytics/engine";
import { formatOfType, quoteIdentifier, sourceSql, type Aggregate, type ColumnInfo } from "@/lib/analytics/query";
import { requireAnalytics } from "@/lib/analytics/sources";

/**
 * Field settings on a loaded table (#376 phase 4, decision 775; Power BI's
 * column properties "Sort by column", "Summarization", "Format", "Display
 * folder" and "Description" as the references): how a column's groups are
 * ordered (by another column, e.g. month names by month number), how it's
 * added up when it's first chosen as a value, how its values are shown
 * when a chart hasn't chosen a format, and where it sits in the field list.
 * None of these change what a figure is.
 */
export type FieldSettings = {
  /** Groups of this field are ordered by this column (one value of it for each value of the field). */
  sortBy?: string;
  /** How the field is added up when it's chosen as a value; "none": it's for grouping, not adding up (e.g. a year). */
  summarise?: Aggregate | "none";
  /** How its values are shown when a chart hasn't chosen otherwise. */
  number?: NumberFormat;
  /** The folder it's listed under in the field list. */
  folder?: string;
  description?: string;
};

export type SavedFieldSettings = { table: string; field: string; settings: FieldSettings };

const SUMMARISE: Array<Aggregate | "none"> = ["sum", "avg", "min", "max", "count", "count_distinct", "none"];

/** A table's columns with their saved settings. */
export function withFieldSettings(tables: Map<string, ColumnInfo[]>, saved: readonly SavedFieldSettings[] | undefined): Map<string, ColumnInfo[]> {
  if (!saved?.length) return tables;
  const result = new Map(tables);
  for (const [table, columns] of tables) {
    const own = saved.filter((entry) => entry.table === table);
    if (!own.length) continue;
    result.set(
      table,
      columns.map((column) => {
        const found = own.find((entry) => entry.field === column.name);
        // A sort column that has gone from the table is ignored, not an error.
        if (!found) return column;
        const settings = { ...found.settings };
        if (settings.sortBy && !columns.some((other) => other.name === settings.sortBy)) delete settings.sortBy;
        return { ...column, settings };
      }),
    );
  }
  return result;
}

/** Checks a field's settings against its table (unknown settings dropped, bad ones refused). */
export function parseFieldSettings(input: unknown, field: ColumnInfo, columns: ColumnInfo[]): FieldSettings {
  const raw = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const label = field.name.replaceAll("_", " ");
  const result: FieldSettings = {};
  if (raw.sortBy !== undefined && raw.sortBy !== null && raw.sortBy !== "") {
    const sortBy = String(raw.sortBy);
    if (field.type === "DATE" || field.type.startsWith("TIMESTAMP")) throw new ValidationError(`${label} is a date, so its groups are already in date order.`);
    if (sortBy === field.name) throw new ValidationError(`${label} is already sorted by itself; choose another column.`);
    const column = columns.find((entry) => entry.name === sortBy);
    if (!column) throw new ValidationError(`There's no column called ${sortBy} to sort ${label} by.`);
    if ((column as { related?: unknown }).related || (field as { related?: unknown }).related) throw new ValidationError("A related table's field is sorted on its own table.");
    result.sortBy = sortBy;
  }
  if (raw.summarise !== undefined && raw.summarise !== null && raw.summarise !== "") {
    const summarise = raw.summarise as Aggregate | "none";
    if (!SUMMARISE.includes(summarise)) throw new ValidationError(`Choose how ${label} is added up from the list.`);
    const numeric = ["money", "number", "integer"].includes(formatOfType(field.type));
    if ((summarise === "sum" || summarise === "avg") && !numeric) throw new ValidationError(`${label} isn't a number, so it can't be added up or averaged.`);
    result.summarise = summarise;
  }
  const number = parseNumberFormat(raw.number, label);
  if (number) result.number = number;
  if (typeof raw.folder === "string" && raw.folder.trim()) {
    const folder = raw.folder.trim();
    if (folder.length > 40) throw new ValidationError("A folder name can be up to 40 characters.");
    result.folder = folder;
  }
  if (typeof raw.description === "string" && raw.description.trim()) {
    const description = raw.description.trim();
    if (description.length > 300) throw new ValidationError("A description can be up to 300 characters.");
    result.description = description;
  }
  return result;
}

/**
 * A sort column must have one value for each value of the field (Power BI
 * refuses it otherwise), or the order would be a guess: checked on the data.
 */
export async function checkSortBy(organisationId: string, table: string, columns: ColumnInfo[], field: string, sortBy: string): Promise<void> {
  const q = quoteIdentifier;
  const sql = `select cast(${q(field)} as VARCHAR) as value, count(distinct ${q(sortBy)}) as orders from ${sourceSql(table, columns)} where ${q(field)} is not null group by 1 having count(distinct ${q(sortBy)}) > 1 order by 2 desc, 1 limit 1`;
  const [clash] = await runBuiltQuery(organisationId, sql, []);
  if (clash) {
    throw new ValidationError(`${field.replaceAll("_", " ")} can't be sorted by ${sortBy.replaceAll("_", " ")}: "${clash.value}" has ${clash.orders} different ${sortBy.replaceAll("_", " ")} values. Each value needs one, as a month name has one month number.`);
  }
}

type Row = { table_name: string; field_name: string; settings: FieldSettings };

export async function listFieldSettings(tx: OrgTx): Promise<SavedFieldSettings[]> {
  await requireAnalytics(tx);
  const result = await tx.query<Row>("select table_name, field_name, settings from analytics_field_settings order by table_name, field_name");
  return result.rows.map((row) => ({ table: row.table_name, field: row.field_name, settings: row.settings }));
}

/**
 * Saves a field's settings (bookkeepers and up), replacing what it had; no
 * settings left removes the row. `tables` are the loaded tables with the
 * organisation's calculated fields, so those can have settings too.
 */
export async function saveFieldSettings(tx: OrgTx, input: Record<string, unknown>, tables?: Map<string, ColumnInfo[]>): Promise<SavedFieldSettings> {
  await requireAnalytics(tx);
  const loaded = tables ?? (await listTables(tx.organisationId));
  const table = typeof input.table === "string" ? input.table : "";
  const columns = loaded.get(table);
  if (!columns) throw new ValidationError(`There's no loaded table called ${table || "that"}.`);
  const name = typeof input.field === "string" ? input.field : "";
  const field = columns.find((column) => column.name === name);
  if (!field) throw new ValidationError(`${table} has no field called ${name || "that"}.`);
  const settings = parseFieldSettings(input.settings, field, columns);
  if (settings.sortBy) await checkSortBy(tx.organisationId, table, columns, name, settings.sortBy);
  if (!Object.keys(settings).length) {
    await tx.query("delete from analytics_field_settings where table_name = $1 and field_name = $2", [table, name]);
  } else {
    await tx.query(
      `insert into analytics_field_settings (table_name, field_name, settings, updated_by_email) values ($1, $2, $3::jsonb, $4)
       on conflict (table_name, field_name) do update set settings = excluded.settings, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [table, name, JSON.stringify(settings), tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: "analytics.field_settings_saved", entityType: "analytics_field", entityId: `${table}.${name}`, details: { table, field: name, settings: Object.keys(settings) } });
  return { table, field: name, settings };
}

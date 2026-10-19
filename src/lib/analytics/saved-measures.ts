import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { parseNumberFormat, type NumberFormat } from "@/lib/analytics/chart-format";
import { listTables } from "@/lib/analytics/engine";
import { builtInMeasures, measureFromSaved, type MeasureDefinition, type SavedMeasure } from "@/lib/analytics/measure-library";
import { parseTileQuery, type ColumnInfo } from "@/lib/analytics/query";
import { requireAnalytics } from "@/lib/analytics/sources";

/** Values saved on a data source (#337, decision 597), and the books copy's built-in ones. */

type Row = {
  id: string;
  table_name: string;
  name: string;
  description: string | null;
  definition: MeasureDefinition;
  number_format: NumberFormat | null;
};

const toMeasure = (row: Row): SavedMeasure => ({
  id: row.id,
  table: row.table_name,
  name: row.name,
  description: row.description,
  definition: row.definition,
  ...(row.number_format ? { number: row.number_format } : {}),
});

/** Every table's saved values: built-in ones first, then the organisation's own by name. */
export async function listMeasures(tx: OrgTx): Promise<SavedMeasure[]> {
  await requireAnalytics(tx);
  const tables = await listTables(tx.organisationId);
  const result = await tx.query<Row>("select id::text, table_name, name, description, definition, number_format from analytics_measures order by table_name, lower(name), id");
  const builtIns = [...tables.entries()].flatMap(([name, columns]) => builtInMeasures(name, columns));
  return [...builtIns, ...result.rows.map(toMeasure)];
}

/** Checks a definition by asking it as a question of its table, so a saved value always works. */
function checkDefinition(definition: unknown, table: string, columns: ColumnInfo[], tables: Map<string, ColumnInfo[]>, name: string): MeasureDefinition {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new ValidationError("Say how the value is worked out.");
  const raw = definition as Record<string, unknown>;
  if (raw.kind !== "base" && raw.kind !== "formula") throw new ValidationError("Say how the value is worked out.");
  const dateField = columns.find((column) => column.type === "DATE" || column.type.startsWith("TIMESTAMP"))?.name ?? null;
  const measure = measureFromSaved({ id: null, table, name, description: null, definition: raw as MeasureDefinition });
  const query = parseTileQuery({ table, groupBy: null, measures: [measure], filters: [], dateField }, tables);
  const parsed = query.measures[0];
  if (parsed.aggregate === "formula") return { kind: "formula", formula: parsed.formula!, inputs: parsed.inputs ?? [] };
  const { label: _label, compare: _compare, formula: _formula, inputs: _inputs, ...rest } = parsed;
  void _label;
  void _compare;
  void _formula;
  void _inputs;
  return { kind: "base", ...(rest as Omit<typeof rest, "aggregate"> & { aggregate: Exclude<typeof rest.aggregate, "formula"> }) };
}

export async function createMeasure(tx: OrgTx, input: Record<string, unknown>): Promise<SavedMeasure> {
  await requireAnalytics(tx);
  const tables = await listTables(tx.organisationId);
  const table = typeof input.table === "string" ? input.table : "";
  const columns = tables.get(table);
  if (!columns) throw new ValidationError(`There's no loaded table called ${table || "that"}.`);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80 || /[[\]]/.test(name)) throw new ValidationError("Give the value a name (up to 80 characters, no square brackets).");
  if (builtInMeasures(table, columns).some((measure) => measure.name.toLowerCase() === name.toLowerCase())) {
    throw new ValidationError(`${name} is one of the built-in values; choose another name.`);
  }
  const existing = await tx.query("select 1 from analytics_measures where table_name = $1 and lower(name) = lower($2)", [table, name]);
  if (existing.rows.length) throw new ValidationError(`There's already a value called ${name} on ${table}.`);
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 300) : null;
  const definition = checkDefinition(input.definition, table, columns, tables, name);
  const number = parseNumberFormat(input.number, name) ?? null;
  const result = await tx.query<Row>(
    `insert into analytics_measures (table_name, name, description, definition, number_format, created_by_email)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6) returning id::text, table_name, name, description, definition, number_format`,
    [table, name, description, JSON.stringify(definition), number ? JSON.stringify(number) : null, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "analytics.measure_saved", entityType: "analytics_measure", entityId: result.rows[0].id, details: { table, name } });
  return toMeasure(result.rows[0]);
}

export async function deleteMeasure(tx: OrgTx, id: string): Promise<void> {
  await requireAnalytics(tx);
  const measureId = /^\d{1,18}$/.test(id) ? id : "0";
  const result = await tx.query<{ table_name: string; name: string }>("delete from analytics_measures where id = $1 returning table_name, name", [measureId]);
  if (!result.rows[0]) throw new NotFoundError("That saved value wasn't found.");
  // Charts already using it keep their own copy of how it's worked out.
  await writeAuditEvent(tx, { eventType: "analytics.measure_deleted", entityType: "analytics_measure", entityId: measureId, details: { table: result.rows[0].table_name, name: result.rows[0].name } });
}

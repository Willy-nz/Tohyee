import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { listTables, runBuiltQuery } from "@/lib/analytics/engine";
import { mergeCheckSql } from "@/lib/analytics/shaping";
import { formatOfType, quoteIdentifier, type ColumnInfo } from "@/lib/analytics/query";
import { requireAnalytics } from "@/lib/analytics/sources";

/**
 * Relationships between tables (#376 phase 4, decision 774; Power BI's
 * star model as the reference): a fact table's rows (e.g. invoice lines)
 * each match at most one row of a dimension table (e.g. contacts) on a
 * key, so a tile on the fact table can group and filter by the dimension's
 * fields. Only many-to-one is allowed, and it's checked on the data before
 * it's saved and before every answer that uses it, with #399's merge check
 * (decision 693): a dimension with two rows for one key would repeat the
 * fact's rows and count amounts again, so it's refused. A dimension's
 * numbers can't be added up through it (they'd repeat on each fact row).
 */

export type Relationship = {
  id: string;
  /** The many side, e.g. tohyee_invoice_lines. */
  table: string;
  field: string;
  /** The one side, e.g. tohyee_contacts. */
  dimension: string;
  dimensionField: string;
  /** The name its fields go by on the fact table: <name>.<field>, e.g. customer.region. */
  name: string;
  /** The dimension key's type as loaded, for comparing keys (worked out when listed). */
  keyType?: string;
};

/** A related column on a fact table, as `withRelationships` adds it. */
export type RelatedColumn = ColumnInfo & { related: { relationship: string; dimension: string; field: string } };

const NAME = /^[a-z][a-z0-9_]{0,30}$/;

/** Whether a column comes from a related table (its name is <relationship>.<field>; tables' own columns never have a dot). */
export function isRelatedColumn(name: string): boolean {
  return name.includes(".");
}

/**
 * A fact table's columns with each relationship's dimension fields added as
 * <name>.<field> (not the dimension's key, which is the fact's own field).
 * Relationships on tables that aren't loaded, or whose columns are gone, add
 * nothing.
 */
export function withRelationships(tables: Map<string, ColumnInfo[]>, relationships: readonly Relationship[] | undefined): Map<string, ColumnInfo[]> {
  if (!relationships?.length) return tables;
  const result = new Map(tables);
  for (const relationship of relationships) {
    const fact = result.get(relationship.table);
    const dimension = tables.get(relationship.dimension)?.filter((column) => !column.expression && !isRelatedColumn(column.name));
    if (!fact || !dimension || !fact.some((column) => column.name === relationship.field) || !dimension.some((column) => column.name === relationship.dimensionField)) continue;
    const added: RelatedColumn[] = dimension
      .filter((column) => column.name !== relationship.dimensionField)
      .map((column) => {
        // A dimension field's own settings come with it (decision 775), its sort column under the same name.
        const settings = column.settings ? { ...column.settings, ...(column.settings.sortBy ? { sortBy: `${relationship.name}.${column.settings.sortBy}` } : {}) } : undefined;
        return { name: `${relationship.name}.${column.name}`, type: column.type, ...(settings ? { settings } : {}), related: { relationship: relationship.name, dimension: relationship.dimension, field: column.name } };
      });
    result.set(relationship.table, [...fact, ...added.filter((column) => !fact.some((existing) => existing.name === column.name))]);
  }
  return result;
}

/** How two key columns are compared: as they are when they're the same kind, otherwise as text. */
function keyEquals(left: string, leftType: string, right: string, rightType: string): string {
  const same = formatOfType(leftType) === formatOfType(rightType) || (["integer", "number", "money"].includes(formatOfType(leftType)) && ["integer", "number", "money"].includes(formatOfType(rightType)));
  return same ? `${left} = ${right}` : `cast(${left} as VARCHAR) = cast(${right} as VARCHAR)`;
}

/**
 * The join a tile's table needs for the related columns it has, as the
 * FROM of the fact table (`sourceSql` puts calculated fields over it). Each
 * dimension is joined once, by its key, keeping every fact row (a fact row
 * with no match has blank dimension fields).
 */
export function relatedSourceSql(table: string, columns: ColumnInfo[], relationships: readonly Relationship[]): string | null {
  const related = columns.filter((column): column is RelatedColumn => Boolean((column as RelatedColumn).related));
  if (!related.length) return null;
  const used = relationships.filter((relationship) => relationship.table === table && related.some((column) => column.related.relationship === relationship.name));
  if (!used.length) return null;
  const q = quoteIdentifier;
  const types = new Map(columns.map((column) => [column.name, column.type]));
  const joins = used.map((relationship, index) => {
    const alias = q(`_tohyee_d${index}`);
    return { relationship, alias, on: keyEquals(`${q("_tohyee_f")}.${q(relationship.field)}`, types.get(relationship.field) ?? "VARCHAR", `${alias}.${q(relationship.dimensionField)}`, relationship.keyType ?? "VARCHAR") };
  });
  const selected = related
    .map((column) => {
      const join = joins.find((entry) => entry.relationship.name === column.related.relationship);
      return join ? `${join.alias}.${q(column.related.field)} as ${q(column.name)}` : null;
    })
    .filter(Boolean);
  return `(select ${q("_tohyee_f")}.*, ${selected.join(", ")} from ${q(table)} as ${q("_tohyee_f")}${joins.map((join) => ` left join ${q(join.relationship.dimension)} as ${join.alias} on ${join.on}`).join("")})`;
}

type CheckAnswer = { right_repeats: string | null; right_most: string | null; right_example: string | null; unmatched: string | null; rows: string | null };

/**
 * Checks a relationship on the data (decision 774, #399's merge check): the
 * dimension must have at most one row for each key (blank keys never
 * match). Gives how many fact rows have no match, for a note.
 */
export async function checkRelationship(organisationId: string, relationship: Relationship): Promise<{ unmatched: number; rows: number }> {
  const sql = mergeCheckSql(`_tohyee_facts as (select * from ${quoteIdentifier(relationship.table)})`, {
    step: 0,
    table: relationship.dimension,
    join: "left",
    columns: [relationship.field],
    withColumns: [relationship.dimensionField],
    numbers: [],
    source: "_tohyee_facts",
  });
  const [answer] = (await runBuiltQuery(organisationId, sql, [])) as CheckAnswer[];
  if (Number(answer?.right_repeats ?? 0) > 0) {
    throw new ValidationError(
      `${relationship.name}: ${relationship.dimension} has more than one row for the same ${relationship.dimensionField} (${answer.right_example ?? "one value"} has ${answer.right_most} rows), so each ${relationship.table} row would be repeated and its amounts counted more than once (one invoice of 100.00 with three lines would become 300.00). A relationship needs ${relationship.dimensionField} to be different on every row of ${relationship.dimension}; many-to-many isn't allowed.`,
    );
  }
  return { unmatched: Number(answer?.unmatched ?? 0), rows: Number(answer?.rows ?? 0) };
}

/** The note for fact rows with no match: their dimension fields are blank. */
export function unmatchedNote(relationship: Relationship, check: { unmatched: number; rows: number }): string | null {
  if (!check.unmatched) return null;
  const words = (table: string) => table.replace(/^tohyee_/, "").replaceAll("_", " ");
  return `${check.unmatched.toLocaleString("en-NZ")} of ${check.rows.toLocaleString("en-NZ")} ${words(relationship.table)} rows have no matching ${words(relationship.dimension)} row, so their ${relationship.name} fields are blank.`;
}

/** The relationships a tile's question uses (any <name>.<field> it names). */
export function relationshipsUsed(query: unknown, table: string, relationships: readonly Relationship[]): Relationship[] {
  const text = JSON.stringify(query ?? null);
  return relationships.filter((relationship) => relationship.table === table && text.includes(`"${relationship.name}.`));
}

type Row = { id: string; fact_table: string; fact_field: string; dimension_table: string; dimension_field: string; name: string };

const toRelationship = (row: Row): Relationship => ({ id: row.id, table: row.fact_table, field: row.fact_field, dimension: row.dimension_table, dimensionField: row.dimension_field, name: row.name });

/** Every relationship, with the dimension key's type for comparing keys. */
export async function listRelationships(tx: OrgTx, tables?: Map<string, ColumnInfo[]>): Promise<Relationship[]> {
  await requireAnalytics(tx);
  const result = await tx.query<Row>("select id::text, fact_table, fact_field, dimension_table, dimension_field, name from analytics_relationships order by fact_table, name, analytics_relationships.id");
  if (!result.rows.length) return [];
  const loaded = tables ?? (await listTables(tx.organisationId));
  return result.rows.map((row) => {
    const relationship = toRelationship(row);
    const keyType = loaded.get(relationship.dimension)?.find((column) => column.name === relationship.dimensionField)?.type;
    return keyType ? { ...relationship, keyType } : relationship;
  });
}

/**
 * Saves a relationship after checking it on the data: both tables and
 * columns exist, the dimension is another table, its key is different on
 * every row, and the name isn't taken on the fact table. Gives how many fact
 * rows have no match.
 */
export async function createRelationship(tx: OrgTx, input: Record<string, unknown>): Promise<{ relationship: Relationship; note: string | null }> {
  await requireAnalytics(tx);
  const tables = await listTables(tx.organisationId);
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const table = text(input.table);
  const field = text(input.field);
  const dimension = text(input.dimension);
  const dimensionField = text(input.dimensionField);
  const name = text(input.name).toLowerCase() || dimension.replace(/^tohyee_/, "").replace(/s$/, "");
  const columns = tables.get(table);
  const dimensionColumns = tables.get(dimension);
  if (!columns) throw new ValidationError(`There's no loaded table called ${table || "that"}.`);
  if (!dimensionColumns) throw new ValidationError(`There's no loaded table called ${dimension || "that"} to relate to.`);
  if (table === dimension) throw new ValidationError("A table can't be related to itself.");
  if (!columns.some((column) => column.name === field)) throw new ValidationError(`${table} has no column called ${field || "that"}.`);
  const key = dimensionColumns.find((column) => column.name === dimensionField);
  if (!key) throw new ValidationError(`${dimension} has no column called ${dimensionField || "that"}.`);
  if (!NAME.test(name)) throw new ValidationError("Name the relationship in small letters, numbers and underscores, e.g. customer; its fields are then customer.region and so on.");
  const taken = await tx.query("select 1 from analytics_relationships where fact_table = $1 and name = $2", [table, name]);
  if (taken.rows.length) throw new ValidationError(`${table} already has a relationship called ${name}.`);
  // One hop only: a dimension isn't also related onwards from here, so its own related fields aren't brought in.
  const relationship: Relationship = { id: "", table, field, dimension, dimensionField, name };
  const check = await checkRelationship(tx.organisationId, relationship);
  const result = await tx.query<{ id: string }>(
    "insert into analytics_relationships (fact_table, fact_field, dimension_table, dimension_field, name, created_by_email) values ($1, $2, $3, $4, $5, $6) returning id::text",
    [table, field, dimension, dimensionField, name, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "analytics.relationship_saved", entityType: "analytics_relationship", entityId: result.rows[0].id, details: { table, dimension, name } });
  const saved = { ...relationship, id: result.rows[0].id };
  return { relationship: saved, note: unmatchedNote(saved, check) };
}

/** The reports and saved values that use a relationship's fields. */
export async function relationshipUsage(tx: OrgTx, relationship: Relationship): Promise<string[]> {
  const prefix = `"${relationship.name}.`;
  const reports = await tx.query<{ name: string; tiles: Array<{ query?: { table?: string } | null; drill?: unknown }>; settings: { slicers?: Array<{ table?: string; field?: string }> } }>(
    "select name, tiles, settings from analytics_dashboards order by lower(name), analytics_dashboards.id",
  );
  const used = reports.rows
    .filter(
      (report) =>
        (report.tiles ?? []).some((tile) => tile.query?.table === relationship.table && JSON.stringify([tile.query, tile.drill ?? null, (tile as { switches?: unknown }).switches ?? null]).includes(prefix)) ||
        (report.settings?.slicers ?? []).some((slicer) => slicer.table === relationship.table && (slicer.field ?? "").startsWith(`${relationship.name}.`)),
    )
    .map((report) => report.name);
  const measures = await tx.query<{ name: string }>("select name from analytics_measures where table_name = $1 and position($2 in definition::text) > 0 order by lower(name)", [relationship.table, prefix]);
  return [...used, ...measures.rows.map((row) => `the saved value ${row.name}`)];
}

/** Removes a relationship no report uses; one in use is refused, naming the reports. */
export async function deleteRelationship(tx: OrgTx, id: string): Promise<void> {
  await requireAnalytics(tx);
  const relationshipId = /^\d{1,18}$/.test(id) ? id : "0";
  const result = await tx.query<Row>("select id::text, fact_table, fact_field, dimension_table, dimension_field, name from analytics_relationships where id = $1", [relationshipId]);
  if (!result.rows[0]) throw new NotFoundError("That relationship wasn't found.");
  const relationship = toRelationship(result.rows[0]);
  const usedBy = await relationshipUsage(tx, relationship);
  if (usedBy.length) throw new ConflictError(`${relationship.name} is used by ${usedBy.join(", ")}. Take its fields off those first.`);
  await tx.query("delete from analytics_relationships where id = $1", [relationship.id]);
  await writeAuditEvent(tx, { eventType: "analytics.relationship_deleted", entityType: "analytics_relationship", entityId: relationship.id, details: { table: relationship.table, name: relationship.name } });
}

import type { OrgTx } from "@/lib/db/org-transaction";
import { listTables } from "@/lib/analytics/engine";
import { listFields, withFields, type CalculatedField } from "@/lib/analytics/calculated-fields";
import { hiddenFarmTables } from "@/lib/analytics/farm-access";
import { checkRelationship, listRelationships, relatedSourceSql, relationshipsUsed, unmatchedNote, withRelationships, type Relationship } from "@/lib/analytics/relationships";
import type { ColumnInfo } from "@/lib/analytics/query";

/**
 * The organisation's data model for Analytics questions: its calculated
 * fields (decision 772) and relationships (decision 774). Read inside the
 * organisation's transaction and passed to the code that answers tiles
 * (which runs outside it), so a report viewer's saved tile gets the same
 * model. Relationships touching a table the member can't use (farm tables,
 * decision 744) are left out, so they can't reach it through another table.
 */
export type AnalyticsModel = { fields: CalculatedField[]; relationships: Relationship[] };

export async function loadModel(tx: OrgTx, tables?: Map<string, ColumnInfo[]>): Promise<AnalyticsModel> {
  const loaded = tables ?? (await listTables(tx.organisationId));
  const hidden = await hiddenFarmTables(tx);
  const fields = (await listFields(tx, loaded)).filter((field) => !hidden?.has(field.table));
  const relationships = (await listRelationships(tx, loaded)).filter((relationship) => !hidden?.has(relationship.table) && !hidden?.has(relationship.dimension));
  return { fields, relationships };
}

/** Every table's columns with the model's fields and related columns, for listing fields and checking saved tiles (nothing is joined). */
export function modelTables(tables: Map<string, ColumnInfo[]>, model: AnalyticsModel | undefined): Map<string, ColumnInfo[]> {
  return withRelationships(withFields(tables, model?.fields), model?.relationships);
}

/** The loaded tables with the model, inside a transaction (saving reports and values). */
export async function tablesWithModel(tx: OrgTx): Promise<Map<string, ColumnInfo[]>> {
  const tables = await listTables(tx.organisationId);
  return modelTables(tables, await loadModel(tx, tables));
}

/**
 * The tables for answering one question: calculated fields, and only the
 * relationships the question uses, each checked on the data first (a
 * dimension that now has two rows for one key is refused) and joined on
 * the question's table. Notes say how many rows had no match.
 */
export async function questionTables(
  organisationId: string,
  tables: Map<string, ColumnInfo[]>,
  model: AnalyticsModel | undefined,
  question: unknown,
): Promise<{ tables: Map<string, ColumnInfo[]>; notes: string[] }> {
  const withCalculated = withFields(tables, model?.fields);
  const table = (question as { table?: unknown } | null)?.table;
  if (typeof table !== "string" || !model?.relationships.length) return { tables: withCalculated, notes: [] };
  const used = relationshipsUsed(question, table, model.relationships);
  if (!used.length) return { tables: withCalculated, notes: [] };
  const notes: string[] = [];
  for (const relationship of used) {
    const note = unmatchedNote(relationship, await checkRelationship(organisationId, relationship));
    if (note) notes.push(note);
  }
  const related = withRelationships(withCalculated, used);
  const columns = related.get(table) ?? [];
  const join = relatedSourceSql(table, columns, used);
  if (join && columns.length) related.set(table, [{ ...columns[0], join }, ...columns.slice(1)]);
  return { tables: related, notes };
}

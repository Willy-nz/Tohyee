import type { DatasetColumn } from "@/lib/ai-workspace/datasets";
import type { TableCopy, TableCopyRow } from "@/lib/analytics/engine";
import type { OrgTx } from "@/lib/db/org-transaction";

/*
 * The AI's own tables in the organisation's analytics file (#693, decision
 * 1626), as `tohyee_ai_<name>` tables copied with the books, so a report
 * over them is an Analytics report like any other and nobody keeps two kinds
 * of dashboard. Row for row, as the AI saved them: nothing is worked out
 * here. The same people can read them as before (a viewer or higher reads
 * the AI's tables on its own screens, and Analytics tables need the same).
 */

export const AI_TABLE_PREFIX = "tohyee_ai_";
/** A number that fits this exactly is a number in Analytics; one that doesn't is kept as text, never rounded. */
export const AI_NUMBER = "DECIMAL(28,6)";
const NUMBER_DECIMALS = 6;
const NUMBER_DIGITS = 22;
const TABLE_NAME_LENGTH = 63;
const BATCH = 5000;

/** The Analytics table an AI table is copied to, or null when its name is too long for one. */
export function aiAnalyticsTable(name: string): string | null {
  const table = `${AI_TABLE_PREFIX}${name}`;
  return table.length <= TABLE_NAME_LENGTH ? table : null;
}

type DatasetRow = { id: string; name: string; columns: DatasetColumn[] };

function duckType(column: DatasetColumn, exact: boolean): string {
  if (column.type === "number") return exact ? AI_NUMBER : "VARCHAR";
  if (column.type === "date") return "DATE";
  if (column.type === "boolean") return "BOOLEAN";
  return "VARCHAR";
}

/**
 * Which number columns fit DECIMAL(28,6) without losing anything. The AI's
 * numbers are exact decimal text of any size; DuckDB would round a seventh
 * decimal place and refuse a 23-digit number, which would stop the whole
 * copy of the books, so a column with either goes over as text.
 */
async function exactColumns(tx: OrgTx, dataset: DatasetRow): Promise<Set<string>> {
  const numbers = dataset.columns.filter((column) => column.type === "number");
  if (numbers.length === 0) return new Set();
  const checks = numbers.map(
    (_column, index) =>
      `coalesce(bool_and(data->>$${index + 2} is null or (scale((data->>$${index + 2})::numeric) <= ${NUMBER_DECIMALS} and abs((data->>$${index + 2})::numeric) < 1e${NUMBER_DIGITS})), true) as c${index}`,
  );
  const result = await tx.query<Record<string, boolean>>(`select ${checks.join(", ")} from ai_dataset_rows where dataset_id = $1`, [dataset.id, ...numbers.map((column) => column.name)]);
  return new Set(numbers.filter((_column, index) => result.rows[0]?.[`c${index}`] === true).map((column) => column.name));
}

export async function readAiTables(tx: OrgTx): Promise<TableCopy[]> {
  const datasets = await tx.query<DatasetRow>("select id::text, name, columns from ai_datasets where archived_at is null order by name");
  const tables: TableCopy[] = [];
  let cursors = 0;
  for (const dataset of datasets.rows) {
    const name = aiAnalyticsTable(dataset.name);
    if (!name || dataset.columns.length === 0) continue;
    const exact = await exactColumns(tx, dataset);
    const columns = dataset.columns;
    const toRow = (data: Record<string, unknown>): TableCopyRow =>
      columns.map((column) => {
        const value = data[column.name];
        return value === null || value === undefined ? null : String(value);
      });
    // Read when the table is copied, a batch at a time (a table can have 50,000 rows).
    const cursor = `tohyee_ai_tables_${++cursors}`;
    const id = dataset.id;
    async function* batches(): AsyncIterable<TableCopyRow[]> {
      // The id is this database's own bigint, read just above; a cursor's query can't take parameters.
      if (!/^\d+$/.test(id)) return;
      await tx.query(`declare ${cursor} no scroll cursor for select data from ai_dataset_rows where dataset_id = ${id} order by row_no`);
      try {
        for (;;) {
          const batch = await tx.query<{ data: Record<string, unknown> }>(`fetch forward ${BATCH} from ${cursor}`);
          if (batch.rows.length > 0) yield batch.rows.map((row) => toRow(row.data));
          if (batch.rows.length < BATCH) break;
        }
      } finally {
        await tx.query(`close ${cursor}`).catch(() => undefined);
      }
    }
    tables.push({ name, columns: columns.map((column) => ({ name: column.name, type: duckType(column, exact.has(column.name)) })), rows: batches() });
  }
  return tables;
}

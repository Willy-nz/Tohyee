import type { OrgTx } from "@/lib/db/org-transaction";
import type { Dashboard } from "@/lib/analytics/dashboards";
import { BOOKS_SOURCE_NAME, BOOKS_TABLE_NAME } from "@/lib/analytics/books";
import { GA_LOAD_TABLE_NAME, GA_SOURCE_NAME } from "@/lib/analytics/google-analytics-reports";
import { GSC_LOAD_TABLE_NAME, GSC_SOURCE_NAME, GSC_TABLE_PREFIX } from "@/lib/analytics/search-console-reports";
import { META_LOAD_TABLE_NAME, META_SOURCE_NAME, META_TABLE_PREFIX, metaTableChanges } from "@/lib/analytics/meta-reports";
import { quoteIdentifier } from "@/lib/analytics/query";

/**
 * How fresh a report's data is (#387, decision 698): for each source its
 * tiles read, when it was last loaded successfully, the latest date in the
 * data the tiles go by, and whether the latest attempt failed or is still
 * running. "Refreshed" only ever means a load that finished and was swapped
 * in; an attempt that failed leaves the last good data in place, which is
 * then shown as stale, never as updated.
 */
export type SourceFreshness = {
  /** The source as Load history names it (e.g. "Books and CRM", a CSV source's name, a shaped table's name). */
  name: string;
  tables: string[];
  /** The last load that finished and was swapped in; null when none is recorded. */
  refreshedAt: string | null;
  /** The latest attempt failed after the last good load: the data is the last good copy. */
  failedAt: string | null;
  running: boolean;
  /** The latest date in the data the tiles go by (their date fields), when they have one. */
  dataThrough: string | null;
  /** The first day Google or Meta may still change (Search Console, decision 1183; Meta, decision 1196); left out for other sources. */
  mayChangeFrom?: string | null;
};

export type ReportFreshness = {
  sources: SourceFreshness[];
  /** Two or more sources last refreshed more than an hour apart, so the tiles may not agree. */
  mixed: boolean;
};

/** The load history key a table's loads are recorded under (the books copy and Google Analytics load many tables at once). */
export function loadKeyOf(table: string): { tableName: string; sourceless: boolean } {
  if (table.startsWith("tohyee_")) return { tableName: BOOKS_TABLE_NAME, sourceless: true };
  if (table.startsWith("google_analytics_")) return { tableName: GA_LOAD_TABLE_NAME, sourceless: true };
  if (table.startsWith(GSC_TABLE_PREFIX)) return { tableName: GSC_LOAD_TABLE_NAME, sourceless: true };
  if (table.startsWith(META_TABLE_PREFIX)) return { tableName: META_LOAD_TABLE_NAME, sourceless: true };
  return { tableName: table, sourceless: false };
}

type RunFacts = { status: "running" | "ok" | "failed"; source_name: string; started_at: Date; finished_at: Date | null };

/** Two loads further apart than this make a report's sources "refreshed at different times". */
const MIXED_MS = 60 * 60 * 1000;

/** The load facts for a report's sources, read in the organisation's transaction (no DuckDB). */
export async function reportLoadFacts(tx: OrgTx, dashboard: Dashboard): Promise<Array<Omit<SourceFreshness, "dataThrough"> & { key: string }>> {
  const tables = [...new Set(dashboard.tiles.flatMap((tile) => (tile.query ? [tile.query.table] : [])))];
  const byKey = new Map<string, string[]>();
  for (const table of tables) {
    const key = loadKeyOf(table).tableName;
    byKey.set(key, [...(byKey.get(key) ?? []), table]);
  }
  const facts: Array<Omit<SourceFreshness, "dataThrough"> & { key: string }> = [];
  for (const [key, keyTables] of byKey) {
    const sourceless = loadKeyOf(keyTables[0]).sourceless;
    const runs = await tx.query<RunFacts>(
      `select status, source_name, started_at, finished_at from analytics_load_runs
        where table_name = $1 ${sourceless ? "and source_id is null and shaped_table_id is null" : ""}
        order by started_at desc, analytics_load_runs.id desc limit 50`,
      [key],
    );
    const latest = runs.rows[0];
    const good = runs.rows.find((run) => run.status === "ok" && run.finished_at);
    const fallbackName = key === BOOKS_TABLE_NAME ? BOOKS_SOURCE_NAME : key === GA_LOAD_TABLE_NAME ? GA_SOURCE_NAME : key === GSC_LOAD_TABLE_NAME ? GSC_SOURCE_NAME : key === META_LOAD_TABLE_NAME ? META_SOURCE_NAME : key;
    facts.push({
      key,
      name: (good ?? latest)?.source_name ?? fallbackName,
      tables: keyTables,
      refreshedAt: good?.finished_at ? new Date(good.finished_at).toISOString() : null,
      failedAt: latest?.status === "failed" && latest !== good ? new Date(latest.finished_at ?? latest.started_at).toISOString() : null,
      running: latest?.status === "running",
    });
  }
  return facts;
}

/** The date fields a report's tiles on a table go by: their date range field, or a date they're grouped by. */
export function tileDateFields(dashboard: Dashboard, table: string): string[] {
  const fields = new Set<string>();
  for (const tile of dashboard.tiles) {
    if (!tile.query || tile.query.table !== table) continue;
    if (tile.query.dateField) fields.add(tile.query.dateField);
    else if (tile.query.groupBy?.grain) fields.add(tile.query.groupBy.field);
  }
  return [...fields];
}

/** The SQL for the latest date in a table's date fields (DuckDB). */
export function dataThroughSql(table: string, fields: string[]): string | null {
  if (fields.length === 0) return null;
  const latest = fields.map((field) => `max(cast(${quoteIdentifier(field)} as DATE))`);
  return `select cast(${latest.length === 1 ? latest[0] : `greatest(${latest.join(", ")})`} as VARCHAR) as through from ${quoteIdentifier(table)}`;
}

/** The SQL for the first day of a Search Console or Meta table that may still change (DuckDB), or null for other tables. */
export function mayChangeSql(table: string): string | null {
  if (!table.startsWith(GSC_TABLE_PREFIX) && !metaTableChanges(table)) return null;
  return `select cast(min(${quoteIdentifier("date")}) as VARCHAR) as changing from ${quoteIdentifier(table)} where ${quoteIdentifier("may_still_change")}`;
}

/** Puts the load facts and the data-through dates together, and says whether the sources are from different times. */
export function combineFreshness(facts: Array<Omit<SourceFreshness, "dataThrough">>, through: Map<string, string | null>, changing: Map<string, string | null> = new Map()): ReportFreshness {
  const sources = facts.map((fact) => {
    const dates = fact.tables.map((table) => through.get(table) ?? null).filter((value): value is string => value !== null);
    const source: SourceFreshness = { name: fact.name, tables: fact.tables, refreshedAt: fact.refreshedAt, failedAt: fact.failedAt, running: fact.running, dataThrough: dates.length ? dates.sort().at(-1)! : null };
    const from = fact.tables.map((table) => changing.get(table) ?? null).filter((value): value is string => value !== null).sort()[0];
    if (from) source.mayChangeFrom = from;
    return source;
  });
  const times = sources.flatMap((source) => (source.refreshedAt ? [Date.parse(source.refreshedAt)] : []));
  return { sources, mixed: times.length > 1 && Math.max(...times) - Math.min(...times) > MIXED_MS };
}

import { writeAuditEvent } from "@/lib/audit";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import {
  assertTableName,
  COLUMN_TYPES,
  type ColumnKind,
  dropTable,
  loadCsv,
  type LoadColumn,
  resolveSourceFile,
  TOHYEE_TABLE_PREFIX,
} from "@/lib/analytics/engine";
import { organisationSourceFolder } from "@/lib/analytics/folders";
import { rebuildShapedTablesForTable } from "@/lib/analytics/shaped-tables";

/**
 * Analytics sources and loads (decisions 353-358): which file in the
 * organisation's folder loads into which table, with which columns as which
 * types, and the record of every load.
 */

export type AnalyticsSource = {
  id: string;
  name: string;
  tableName: string;
  fileName: string;
  delimiter: string;
  columns: LoadColumn[];
  reloadDaily: boolean;
  createdByEmail: string;
  createdAt: string;
  updatedByEmail: string;
  updatedAt: string;
  lastLoad: LoadRun | null;
};

export type LoadRun = {
  id: string;
  shapeId?: string | null;
  sourceId: string | null;
  sourceName: string;
  tableName: string;
  fileName: string;
  trigger: "schedule" | "manual";
  status: "running" | "ok" | "failed";
  startedAt: string;
  finishedAt: string | null;
  rowsLoaded: string | null;
  milliseconds: number | null;
  error: string | null;
  requestedByEmail: string | null;
};

/** Refuses analytics commands while the module is off (decision 353). */
export async function requireAnalytics(tx: OrgTx): Promise<void> {
  const result = await tx.query<{ analytics_enabled: boolean }>("select analytics_enabled from organisation_settings where id = true");
  if (result.rows[0]?.analytics_enabled !== true) {
    throw new ConflictError("Analytics is off. An admin can turn it on in Settings › Modules.");
  }
}

type RunRow = {
  id: string;
  shape_id: string | null;
  source_id: string | null;
  source_name: string;
  table_name: string;
  file_name: string;
  trigger: "schedule" | "manual";
  status: "running" | "ok" | "failed";
  started_at: Date;
  finished_at: Date | null;
  rows_loaded: string | null;
  milliseconds: number | null;
  error: string | null;
  requested_by_email: string | null;
};

const RUN_COLUMNS =
  "id::text, shaped_table_id::text as shape_id, source_id::text, source_name, table_name, file_name, trigger, status, started_at, finished_at, rows_loaded::text, milliseconds, error, requested_by_email";

function toRun(row: RunRow): LoadRun {
  return {
    id: row.id,
    shapeId: row.shape_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    tableName: row.table_name,
    fileName: row.file_name,
    trigger: row.trigger,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    rowsLoaded: row.rows_loaded,
    milliseconds: row.milliseconds,
    error: row.error,
    requestedByEmail: row.requested_by_email,
  };
}

type SourceRow = {
  id: string;
  name: string;
  table_name: string;
  file_name: string;
  delimiter: string;
  columns: LoadColumn[];
  reload_daily: boolean;
  created_by_email: string;
  created_at: Date;
  updated_by_email: string;
  updated_at: Date;
};

export async function listSources(tx: OrgTx): Promise<AnalyticsSource[]> {
  const sources = await tx.query<SourceRow>(
    `select id::text, name, table_name, file_name, delimiter, columns, reload_daily, created_by_email, created_at, updated_by_email, updated_at
       from analytics_sources order by name, id`,
  );
  const runs = await tx.query<RunRow>(
    `select distinct on (source_id) ${RUN_COLUMNS} from analytics_load_runs where source_id is not null order by source_id, started_at desc, id desc`,
  );
  const last = new Map(runs.rows.map((row) => [row.source_id, toRun(row)]));
  return sources.rows.map((row) => ({
    id: row.id,
    name: row.name,
    tableName: row.table_name,
    fileName: row.file_name,
    delimiter: row.delimiter,
    columns: row.columns,
    reloadDaily: row.reload_daily,
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
    updatedByEmail: row.updated_by_email,
    updatedAt: new Date(row.updated_at).toISOString(),
    lastLoad: last.get(row.id) ?? null,
  }));
}

export async function getSource(tx: OrgTx, id: string): Promise<AnalyticsSource> {
  const source = (await listSources(tx)).find((row) => row.id === id);
  if (!source) throw new NotFoundError("That data source wasn't found.");
  return source;
}

export async function recentLoads(tx: OrgTx, limit = 50): Promise<LoadRun[]> {
  const result = await tx.query<RunRow>(`select ${RUN_COLUMNS} from analytics_load_runs order by started_at desc, id desc limit $1`, [limit]);
  return result.rows.map(toRun);
}

function parseColumns(input: unknown): LoadColumn[] {
  if (!Array.isArray(input) || input.length === 0) throw new ValidationError("Choose at least one column to load.");
  if (input.length > 500) throw new ValidationError("A source can load up to 500 columns.");
  const names = new Set<string>();
  const sources = new Set<string>();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new ValidationError(`Column ${index + 1} isn't set up properly.`);
    const { source, name, kind } = raw as Record<string, unknown>;
    if (typeof source !== "string" || !source) throw new ValidationError(`Column ${index + 1} needs the heading it comes from.`);
    if (typeof name !== "string") throw new ValidationError(`Column ${index + 1} needs a name.`);
    try {
      assertTableName(name);
    } catch {
      throw new ValidationError(`The column name "${name}" must start with a letter and use only lower-case letters, digits and _.`);
    }
    if (typeof kind !== "string" || !(kind in COLUMN_TYPES)) throw new ValidationError(`Choose a type for ${name}.`);
    if (names.has(name)) throw new ValidationError(`Two columns are both called ${name}.`);
    if (sources.has(source)) throw new ValidationError(`The heading "${source}" is chosen twice.`);
    names.add(name);
    sources.add(source);
    return { source, name, kind: kind as ColumnKind };
  });
}

function parseSourceInput(input: Record<string, unknown>, current?: AnalyticsSource) {
  const name = input.name === undefined && current ? current.name : typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) throw new ValidationError("Give the source a name (up to 100 characters).");
  const tableName = input.tableName === undefined && current ? current.tableName : String(input.tableName ?? "");
  try {
    assertTableName(tableName);
  } catch {
    throw new ValidationError("The table name must start with a letter and use only lower-case letters, digits and _.");
  }
  if (!current && tableName.startsWith(TOHYEE_TABLE_PREFIX)) {
    throw new ValidationError("Table names starting with tohyee_ are kept for the copy of the books.");
  }
  const fileName = input.fileName === undefined && current ? current.fileName : typeof input.fileName === "string" ? input.fileName.trim() : "";
  if (!fileName || fileName.length > 500) throw new ValidationError("Choose the file.");
  const delimiter = input.delimiter === undefined ? (current?.delimiter ?? ",") : String(input.delimiter);
  if (delimiter.length !== 1) throw new ValidationError("The separator must be one character.");
  const columns = input.columns === undefined && current ? current.columns : parseColumns(input.columns);
  if (input.reloadDaily !== undefined && typeof input.reloadDaily !== "boolean") throw new ValidationError("reloadDaily must be true or false.");
  const reloadDaily = input.reloadDaily === undefined ? (current?.reloadDaily ?? true) : input.reloadDaily;
  return { name, tableName, fileName, delimiter, columns, reloadDaily };
}

/** Sets up a file to load. Admins and owners; the file must be in the organisation's folder. */
export async function createSource(tx: OrgTx, input: Record<string, unknown>): Promise<AnalyticsSource> {
  await requireAnalytics(tx);
  const values = parseSourceInput(input);
  const folder = await organisationSourceFolder(tx.organisationId);
  if (!folder) throw new ConflictError("A server admin needs to choose this organisation's analytics folder first.");
  resolveSourceFile(folder, values.fileName);
  const taken = await tx.query("select 1 from analytics_sources where table_name = $1", [values.tableName]);
  if (taken.rows.length > 0) throw new ConflictError(`Another source already loads into ${values.tableName}.`);
  const shaped = await tx.query("select 1 from analytics_shaped_tables where table_name = $1", [values.tableName]);
  if (shaped.rows.length > 0) throw new ConflictError(`A shaped table already uses ${values.tableName}.`);
  const result = await tx.query<{ id: string }>(
    `insert into analytics_sources (name, table_name, file_name, delimiter, columns, reload_daily, created_by_email, updated_by_email)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $7) returning id::text`,
    [values.name, values.tableName, values.fileName, values.delimiter, JSON.stringify(values.columns), values.reloadDaily, tx.actor.email],
  );
  const id = result.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "analytics.source_created",
    entityType: "analytics_source",
    entityId: id,
    details: { name: values.name, tableName: values.tableName, fileName: values.fileName, columns: values.columns.length },
  });
  return getSource(tx, id);
}

/** Changes a source. The table name stays (reports will refer to it). */
export async function updateSource(tx: OrgTx, id: string, input: Record<string, unknown>): Promise<AnalyticsSource> {
  await requireAnalytics(tx);
  const current = await getSource(tx, id);
  if (input.tableName !== undefined && input.tableName !== current.tableName) {
    throw new ValidationError("A source's table name can't change. Remove the source and set it up again instead.");
  }
  const values = parseSourceInput(input, current);
  if (values.fileName !== current.fileName) {
    const folder = await organisationSourceFolder(tx.organisationId);
    if (!folder) throw new ConflictError("A server admin needs to choose this organisation's analytics folder first.");
    resolveSourceFile(folder, values.fileName);
  }
  await tx.query(
    `update analytics_sources set name = $2, file_name = $3, delimiter = $4, columns = $5::jsonb, reload_daily = $6,
            updated_by_email = $7, updated_at = now() where id = $1`,
    [id, values.name, values.fileName, values.delimiter, JSON.stringify(values.columns), values.reloadDaily, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "analytics.source_updated",
    entityType: "analytics_source",
    entityId: id,
    details: { name: values.name, fileName: values.fileName, columns: values.columns.length, reloadDaily: values.reloadDaily },
  });
  return getSource(tx, id);
}

/**
 * Removes a source. Its load history stays; its loaded table is dropped by
 * the caller after this commits (`dropTable`), since it's only loaded data.
 */
export async function deleteSource(tx: OrgTx, id: string): Promise<{ tableName: string }> {
  await requireAnalytics(tx);
  const current = await getSource(tx, id);
  const running = await tx.query("select 1 from analytics_load_runs where source_id = $1 and status = 'running'", [id]);
  if (running.rows.length > 0) throw new ConflictError("That source is loading. Try again when it's finished.");
  await tx.query("delete from analytics_sources where id = $1", [id]);
  await writeAuditEvent(tx, {
    eventType: "analytics.source_deleted",
    entityType: "analytics_source",
    entityId: id,
    details: { name: current.name, tableName: current.tableName },
  });
  return { tableName: current.tableName };
}

export async function removeSource(organisation: OrganisationRecord, actor: Actor, id: string): Promise<void> {
  const { tableName } = await withOrganisationTransaction(organisation, actor, (tx) => deleteSource(tx, id));
  await dropTable(organisation.id, tableName);
}

// A load that's been "running" this long was cut off (the server stopped).
const STALE_AFTER_MINUTES = 60;

/**
 * Loads one source now (decision 357). The record of the load is written
 * before and after, each in its own short transaction; the file is read
 * outside any PostgreSQL transaction.
 */
export async function runLoad(
  organisation: OrganisationRecord,
  actor: Actor,
  sourceId: string,
  trigger: "schedule" | "manual",
): Promise<LoadRun> {
  const started = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    await tx.query(
      `update analytics_load_runs set status = 'failed', finished_at = now(), error = 'The load was cut off (the server stopped).'
        where status = 'running' and started_at < now() - make_interval(mins => $1)`,
      [STALE_AFTER_MINUTES],
    );
    const source = await getSource(tx, sourceId);
    const busy = await tx.query("select 1 from analytics_load_runs where source_id = $1 and status = 'running'", [sourceId]);
    if (busy.rows.length > 0) throw new ConflictError("That source is already loading.");
    const run = await tx.query<{ id: string }>(
      `insert into analytics_load_runs (source_id, source_name, table_name, file_name, trigger, requested_by_email)
       values ($1, $2, $3, $4, $5, $6) returning id::text`,
      [source.id, source.name, source.tableName, source.fileName, trigger, trigger === "manual" ? actor.email : null],
    );
    return { runId: run.rows[0].id, source };
  });

  let outcome: { rows: number; milliseconds: number } | null = null;
  let error: string | null = null;
  try {
    const folder = await organisationSourceFolder(organisation.id);
    if (!folder) throw new ValidationError("This organisation's analytics folder isn't chosen any more.");
    const file = resolveSourceFile(folder, started.source.fileName);
    outcome = await loadCsv({
      organisationId: organisation.id,
      sourceFolder: folder,
      file,
      table: started.source.tableName,
      columns: started.source.columns,
      delimiter: started.source.delimiter,
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const run = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const result = await tx.query<RunRow>(
      `update analytics_load_runs set status = $2, finished_at = now(), rows_loaded = $3, milliseconds = $4, error = $5
        where id = $1 returning ${RUN_COLUMNS}`,
      [started.runId, error ? "failed" : "ok", outcome ? String(outcome.rows) : null, outcome?.milliseconds ?? null, error],
    );
    return toRun(result.rows[0]);
  });
  if (run.status === "ok") {
    try {
      await rebuildShapedTablesForTable(organisation, actor, started.source.tableName, trigger);
    } catch (caught) {
      console.warn(`[tohyee] Shaped tables after loading ${started.source.tableName}:`, caught instanceof Error ? caught.message : caught);
    }
  }
  return run;
}

/** The latest copy of the books (analytics step 2), or null. */
export async function lastBooksRun(tx: OrgTx): Promise<LoadRun | null> {
  const result = await tx.query<RunRow>(
    `select ${RUN_COLUMNS} from analytics_load_runs where source_id is null and table_name = 'tohyee_*' order by started_at desc, id desc limit 1`,
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

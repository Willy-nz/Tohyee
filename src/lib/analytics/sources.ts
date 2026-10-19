import { writeAuditEvent } from "@/lib/audit";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import {
  assertTableName,
  COLUMN_TYPES,
  type ColumnKind,
  dropTable,
  loadRows,
  loadSourceFile,
  type LoadColumn,
  resolveSourceFile,
  TOHYEE_TABLE_PREFIX,
} from "@/lib/analytics/engine";
import { organisationSourceFolder } from "@/lib/analytics/folders";
import { type DatabaseEngine, parseRowLimit } from "@/lib/analytics/databases/config";
import { connectionSecret, getConnection, parseQuerySpec, readSourceRows, settingsOf, sourceLabel } from "@/lib/analytics/databases/connections";
import { rebuildShapedTablesForTable, shapesUsing } from "@/lib/analytics/shaped-tables";

/**
 * Analytics sources and loads (decisions 353-358): which file in the
 * organisation's folder loads into which table, with which columns as which
 * types, and the record of every load.
 */

/** Where a database source reads from (decisions 602-605); null for a file. */
export type DatabaseSourceSpec = {
  connectionId: string;
  connectionName: string;
  engine: DatabaseEngine;
  schema: string | null;
  table: string | null;
  /** The typed SELECT; only admins and owners see it. */
  query: string | null;
  rowLimit: number;
};

export type AnalyticsSource = {
  id: string;
  name: string;
  tableName: string;
  /** The file, or for a database source what it reads ("Sales database › dbo.Orders"). */
  fileName: string;
  database: DatabaseSourceSpec | null;
  sheetName: string | null;
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
  sheet_name: string | null;
  delimiter: string;
  columns: LoadColumn[];
  reload_daily: boolean;
  created_by_email: string;
  created_at: Date;
  updated_by_email: string;
  updated_at: Date;
  connection_id: string | null;
  connection_name: string | null;
  connection_engine: DatabaseEngine | null;
  db_schema: string | null;
  db_table: string | null;
  db_query: string | null;
  row_limit: number | null;
};

export async function listSources(tx: OrgTx): Promise<AnalyticsSource[]> {
  const sources = await tx.query<SourceRow>(
    `select s.id::text, s.name, s.table_name, s.file_name, s.sheet_name, s.delimiter, s.columns, s.reload_daily, s.created_by_email, s.created_at,
            s.updated_by_email, s.updated_at, s.connection_id::text, c.name as connection_name, c.engine as connection_engine,
            s.db_schema, s.db_table, s.db_query, s.row_limit
       from analytics_sources s left join analytics_db_connections c on c.id = s.connection_id
      order by s.name, s.id`,
  );
  const runs = await tx.query<RunRow>(
    `select distinct on (source_id) ${RUN_COLUMNS} from analytics_load_runs where source_id is not null order by source_id, started_at desc, id desc`,
  );
  const last = new Map(runs.rows.map((row) => [row.source_id, toRun(row)]));
  return sources.rows.map((row) => ({
    id: row.id,
    name: row.name,
    tableName: row.table_name,
    fileName: row.connection_id ? sourceLabel(row.connection_name ?? "Database", { schema: row.db_schema, table: row.db_table, query: row.db_query }) : row.file_name,
    database: row.connection_id
      ? {
          connectionId: row.connection_id,
          connectionName: row.connection_name ?? "",
          engine: row.connection_engine ?? "postgres",
          schema: row.db_schema,
          table: row.db_table,
          query: row.db_query,
          rowLimit: row.row_limit ?? 0,
        }
      : null,
    sheetName: row.sheet_name,
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

/**
 * Sources as a member below admin sees them: a database source's typed
 * query stays with the admins and owners who manage it.
 */
export function sourcesForViewer(sources: AnalyticsSource[]): AnalyticsSource[] {
  return sources.map((source) => (source.database ? { ...source, database: { ...source.database, query: null } } : source));
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
  const sheetInput = input.sheetName === undefined ? (current && current.fileName === fileName ? current.sheetName : null) : input.sheetName;
  const sheetName = sheetInput === null || sheetInput === "" ? null : typeof sheetInput === "string" ? sheetInput : null;
  if (sheetInput !== null && sheetInput !== "" && sheetName === null) throw new ValidationError("Choose a valid Excel sheet.");
  if (sheetName !== null && (sheetName.length > 31 || /[\u0000-\u001f\u007f]/.test(sheetName))) {
    throw new ValidationError("An Excel sheet name must be 1 to 31 characters.");
  }
  if (sheetName !== null && !/\.xlsx$/i.test(fileName)) throw new ValidationError("Choose a sheet only for an .xlsx file.");
  const delimiter = input.delimiter === undefined ? (current?.delimiter ?? ",") : String(input.delimiter);
  if (delimiter.length !== 1) throw new ValidationError("The separator must be one character.");
  const columns = input.columns === undefined && current ? current.columns : parseColumns(input.columns);
  if (input.reloadDaily !== undefined && typeof input.reloadDaily !== "boolean") throw new ValidationError("reloadDaily must be true or false.");
  const reloadDaily = input.reloadDaily === undefined ? (current?.reloadDaily ?? true) : input.reloadDaily;
  return { name, tableName, fileName, sheetName, delimiter, columns, reloadDaily };
}

/** Checks a database source's name, table, columns and what it reads (decision 602). */
async function parseDatabaseSourceInput(tx: OrgTx, input: Record<string, unknown>, current?: AnalyticsSource) {
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
  if (current && input.connectionId !== undefined && String(input.connectionId) !== current.database?.connectionId) {
    throw new ValidationError("A source's database connection can't change. Set up a new source instead.");
  }
  const connection = await getConnection(tx, current?.database?.connectionId ?? input.connectionId);
  const changesWhat = input.table !== undefined || input.query !== undefined || input.schema !== undefined;
  const spec = changesWhat || !current?.database
    ? parseQuerySpec(connection.engine, input)
    : current.database.query
      ? { query: current.database.query }
      : { schema: current.database.schema, table: current.database.table! };
  const rowLimit = input.rowLimit === undefined && current?.database ? current.database.rowLimit : parseRowLimit(input.rowLimit);
  const columns = input.columns === undefined && current ? current.columns : parseColumns(input.columns);
  if (input.reloadDaily !== undefined && typeof input.reloadDaily !== "boolean") throw new ValidationError("reloadDaily must be true or false.");
  const reloadDaily = input.reloadDaily === undefined ? (current?.reloadDaily ?? true) : input.reloadDaily;
  const schema = spec.query ? null : (spec.schema ?? null);
  const table = spec.query ? null : spec.table!;
  const query = spec.query ?? null;
  return { name, tableName, connection, schema, table, query, rowLimit, columns, reloadDaily, label: sourceLabel(connection.name, { schema, table, query }) };
}

async function createDatabaseSource(tx: OrgTx, input: Record<string, unknown>): Promise<AnalyticsSource> {
  const values = await parseDatabaseSourceInput(tx, input);
  await ensureTableFree(tx, values.tableName);
  const result = await tx.query<{ id: string }>(
    `insert into analytics_sources (name, table_name, file_name, delimiter, columns, reload_daily, connection_id, db_schema, db_table, db_query, row_limit,
                                    created_by_email, updated_by_email)
     values ($1, $2, $3, ',', $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $11) returning id::text`,
    [values.name, values.tableName, values.label, JSON.stringify(values.columns), values.reloadDaily, values.connection.id, values.schema, values.table, values.query, values.rowLimit, tx.actor.email],
  );
  const id = result.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "analytics.source_created",
    entityType: "analytics_source",
    entityId: id,
    details: { name: values.name, tableName: values.tableName, connection: values.connection.name, reads: values.query ? "query" : `${values.schema ? `${values.schema}.` : ""}${values.table}`, columns: values.columns.length },
  });
  return getSource(tx, id);
}

async function ensureTableFree(tx: OrgTx, tableName: string): Promise<void> {
  const taken = await tx.query("select 1 from analytics_sources where table_name = $1", [tableName]);
  if (taken.rows.length > 0) throw new ConflictError(`Another source already loads into ${tableName}.`);
  const shaped = await tx.query("select 1 from analytics_shaped_tables where table_name = $1", [tableName]);
  if (shaped.rows.length > 0) throw new ConflictError(`A shaped table already uses ${tableName}.`);
}

/** Sets up a file to load. Admins and owners; the file must be in the organisation's folder. */
export async function createSource(tx: OrgTx, input: Record<string, unknown>): Promise<AnalyticsSource> {
  await requireAnalytics(tx);
  if (input.connectionId !== undefined && input.connectionId !== null) return createDatabaseSource(tx, input);
  const values = parseSourceInput(input);
  const folder = await organisationSourceFolder(tx.organisationId);
  if (!folder) throw new ConflictError("A server admin needs to choose this organisation's analytics folder first.");
  resolveSourceFile(folder, values.fileName);
  await ensureTableFree(tx, values.tableName);
  const result = await tx.query<{ id: string }>(
    `insert into analytics_sources (name, table_name, file_name, sheet_name, delimiter, columns, reload_daily, created_by_email, updated_by_email)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8) returning id::text`,
    [values.name, values.tableName, values.fileName, values.sheetName, values.delimiter, JSON.stringify(values.columns), values.reloadDaily, tx.actor.email],
  );
  const id = result.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "analytics.source_created",
    entityType: "analytics_source",
    entityId: id,
    details: { name: values.name, tableName: values.tableName, fileName: values.fileName, sheetName: values.sheetName, columns: values.columns.length },
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
  if (current.database) {
    const values = await parseDatabaseSourceInput(tx, input, current);
    await tx.query(
      `update analytics_sources set name = $2, file_name = $3, columns = $4::jsonb, reload_daily = $5, db_schema = $6, db_table = $7, db_query = $8,
              row_limit = $9, updated_by_email = $10, updated_at = now() where id = $1`,
      [id, values.name, values.label, JSON.stringify(values.columns), values.reloadDaily, values.schema, values.table, values.query, values.rowLimit, tx.actor.email],
    );
    await writeAuditEvent(tx, {
      eventType: "analytics.source_updated",
      entityType: "analytics_source",
      entityId: id,
      details: { name: values.name, reads: values.query ? "query" : `${values.schema ? `${values.schema}.` : ""}${values.table}`, columns: values.columns.length, reloadDaily: values.reloadDaily, rowLimit: values.rowLimit },
    });
    return getSource(tx, id);
  }
  if (input.connectionId !== undefined && input.connectionId !== null) throw new ValidationError("A file source can't become a database source. Set up a new source instead.");
  const values = parseSourceInput(input, current);
  if (values.fileName !== current.fileName) {
    const folder = await organisationSourceFolder(tx.organisationId);
    if (!folder) throw new ConflictError("A server admin needs to choose this organisation's analytics folder first.");
    resolveSourceFile(folder, values.fileName);
  }
  await tx.query(
    `update analytics_sources set name = $2, file_name = $3, sheet_name = $4, delimiter = $5, columns = $6::jsonb, reload_daily = $7,
            updated_by_email = $8, updated_at = now() where id = $1`,
    [id, values.name, values.fileName, values.sheetName, values.delimiter, JSON.stringify(values.columns), values.reloadDaily, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "analytics.source_updated",
    entityType: "analytics_source",
    entityId: id,
    details: { name: values.name, fileName: values.fileName, sheetName: values.sheetName, columns: values.columns.length, reloadDaily: values.reloadDaily },
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
  const users = await shapesUsing(tx, current.tableName);
  if (users.length > 0) {
    throw new ConflictError(`The shaped table${users.length === 1 ? "" : "s"} ${users.join(", ")} ${users.length === 1 ? "uses" : "use"} this source. Change or remove ${users.length === 1 ? "it" : "them"} first.`);
  }
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
    // A database source's password is read here and used only after this transaction (no network calls inside it).
    let secret: { settings: ReturnType<typeof settingsOf>; password: string } | null = null;
    if (source.database) {
      try {
        const found = await connectionSecret(tx, source.database.connectionId);
        secret = { settings: settingsOf(found.connection), password: found.password };
      } catch (caught) {
        secret = null;
        return { runId: run.rows[0].id, source, secret, secretError: caught instanceof Error ? caught.message : String(caught) };
      }
    }
    return { runId: run.rows[0].id, source, secret, secretError: null as string | null };
  });

  let outcome: { rows: number; milliseconds: number } | null = null;
  let error: string | null = null;
  try {
    if (started.source.database) {
      outcome = await loadDatabaseSource(organisation.id, started.source, started.source.database, started.secret, started.secretError);
    } else {
    const folder = await organisationSourceFolder(organisation.id);
    if (!folder) throw new ValidationError("This organisation's analytics folder isn't chosen any more.");
    const file = resolveSourceFile(folder, started.source.fileName);
    outcome = await loadSourceFile({
      organisationId: organisation.id,
      sourceFolder: folder,
      file,
      table: started.source.tableName,
      columns: started.source.columns,
      delimiter: started.source.delimiter,
      sheetName: started.source.sheetName,
    });
    }
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

/** Reads a database source and loads it (decisions 602-605), outside any PostgreSQL transaction. */
async function loadDatabaseSource(
  organisationId: string,
  source: AnalyticsSource,
  database: DatabaseSourceSpec,
  secret: { settings: ReturnType<typeof settingsOf>; password: string } | null,
  secretError: string | null,
): Promise<{ rows: number; milliseconds: number }> {
  if (!secret) throw new ValidationError(secretError ?? "The database connection's password couldn't be read. Enter it again on the connection.");
  const started = performance.now();
  const reading = await readSourceRows({
    settings: secret.settings,
    password: secret.password,
    spec: database.query ? { query: database.query } : { schema: database.schema, table: database.table! },
    columns: source.columns,
    rowLimit: database.rowLimit,
  });
  try {
    const loaded = await loadRows({ organisationId, table: source.tableName, columns: source.columns, rows: reading.batches });
    return { rows: loaded.rows, milliseconds: Math.round(performance.now() - started) };
  } finally {
    await reading.close();
  }
}

/** The latest copy of the books (analytics step 2), or null. */
export async function lastBooksRun(tx: OrgTx): Promise<LoadRun | null> {
  const result = await tx.query<RunRow>(
    `select ${RUN_COLUMNS} from analytics_load_runs where source_id is null and table_name = 'tohyee_*' order by started_at desc, id desc limit 1`,
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

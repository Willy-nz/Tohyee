import { writeAuditEvent } from "@/lib/audit";
import { columnNameFrom, type ColumnKind, type LoadColumn } from "@/lib/analytics/engine";
import {
  type ConnectionSettings,
  DATABASE_ENGINES,
  type DatabaseEngine,
  type Encryption,
  parseConnectionSettings,
  parsePassword,
  sameDestination,
} from "@/lib/analytics/databases/config";
import { type DriverModules, type ExternalObject, type ExternalSession, friendlyError, openSession, realDrivers } from "@/lib/analytics/databases/drivers";
import { checkReadOnlyQuery } from "@/lib/analytics/databases/guard";
import { type ExternalColumn, outerSelect, quoteObject, snakeName, suggestColumn, valueText } from "@/lib/analytics/databases/types";
import { businessTimeZone } from "@/lib/dates";
import { coreDatabaseName, organisationDatabasePrefix } from "@/lib/db/connection";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

/**
 * Connections to external databases for Analytics (decisions 602-604). The
 * password is encrypted with the server's key (src/lib/secrets) and never
 * leaves the server: not to the browser, the logs or the audit trail. Only
 * admins and owners reach these (the routes check), as with every other
 * source setup. Network calls are made outside any PostgreSQL transaction.
 */

export type DatabaseConnection = {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number | null;
  instanceName: string | null;
  database: string;
  username: string;
  encryption: Encryption;
  /** Always true: the password is kept, never shown. */
  hasPassword: boolean;
  sourceCount: number;
  createdByEmail: string;
  createdAt: string;
  updatedByEmail: string;
  updatedAt: string;
};

type ConnectionRow = {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number | null;
  instance_name: string | null;
  database_name: string;
  username: string;
  encryption: Encryption;
  source_count: number;
  created_by_email: string;
  created_at: Date;
  updated_by_email: string;
  updated_at: Date;
};

// Never the password: it's read only by connectionSecret.
const CONNECTION_COLUMNS = `c.id::text, c.name, c.engine, c.host, c.port, c.instance_name, c.database_name, c.username, c.encryption,
  (select count(*)::int from analytics_sources s where s.connection_id = c.id) as source_count,
  c.created_by_email, c.created_at, c.updated_by_email, c.updated_at`;

function toConnection(row: ConnectionRow): DatabaseConnection {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    host: row.host,
    port: row.port,
    instanceName: row.instance_name,
    database: row.database_name,
    username: row.username,
    encryption: row.encryption,
    hasPassword: true,
    sourceCount: row.source_count,
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
    updatedByEmail: row.updated_by_email,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function settingsOf(connection: Pick<DatabaseConnection, "engine" | "host" | "port" | "instanceName" | "database" | "username" | "encryption">): ConnectionSettings {
  return {
    engine: connection.engine,
    host: connection.host,
    port: connection.port,
    instanceName: connection.instanceName,
    database: connection.database,
    username: connection.username,
    encryption: connection.encryption,
  };
}

function connectionId(value: unknown): string {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d{0,17}$/.test(text)) throw new ValidationError("Choose a database connection.");
  return text;
}

export async function listConnections(tx: OrgTx): Promise<DatabaseConnection[]> {
  const result = await tx.query<ConnectionRow>(`select ${CONNECTION_COLUMNS} from analytics_db_connections c order by lower(c.name), c.id`);
  return result.rows.map(toConnection);
}

export async function getConnection(tx: OrgTx, id: unknown): Promise<DatabaseConnection> {
  const result = await tx.query<ConnectionRow>(`select ${CONNECTION_COLUMNS} from analytics_db_connections c where c.id = $1`, [connectionId(id)]);
  if (!result.rows[0]) throw new NotFoundError("That database connection wasn't found.");
  return toConnection(result.rows[0]);
}

/** The connection with its password, for connecting. Server side only. */
export async function connectionSecret(tx: OrgTx, id: unknown): Promise<{ connection: DatabaseConnection; password: string }> {
  const connection = await getConnection(tx, id);
  const stored = await tx.query<{ password_ciphertext: string }>("select password_ciphertext from analytics_db_connections where id = $1", [connection.id]);
  return { connection, password: decryptSecret(stored.rows[0].password_ciphertext) };
}

function connectionName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw new ValidationError("Give the connection a name (up to 100 characters).");
  return value.trim();
}

/**
 * Tohyee's own PostgreSQL databases (the server's and each organisation's)
 * can't be a source: an organisation's admin mustn't be able to read the
 * server's database, or another organisation's, even with a login for it.
 */
export async function refuseTohyeeDatabase(settings: ConnectionSettings): Promise<void> {
  if (settings.engine !== "postgres") return;
  let names: string[];
  let prefix: string;
  try {
    names = [coreDatabaseName()];
    prefix = organisationDatabasePrefix();
    const registered = await coreQuery<{ database_name: string }>("select database_name from organisations");
    names.push(...registered.rows.map((row) => row.database_name));
  } catch {
    // Without the server's database (unit tests) there's nothing of Tohyee's to protect.
    return;
  }
  const wanted = settings.database.toLowerCase();
  if (names.some((name) => name.toLowerCase() === wanted) || wanted.startsWith(prefix.toLowerCase())) {
    throw new ValidationError("That's one of Tohyee's own databases. Use Books and CRM for this organisation's own data.");
  }
}

/* -------------------------------------------------------------------------- */
/* Time limits                                                                 */
/* -------------------------------------------------------------------------- */

export const CONNECT_TIMEOUT_MS = 15_000;
/** Testing a connection, listing tables and previews. */
export const PREVIEW_TIMEOUT_MS = 30_000;
export const DEFAULT_LOAD_TIMEOUT_MS = 10 * 60_000;

/** How long a load may take in all; server admins can change it with TOHYEE_ANALYTICS_DATABASE_SECONDS. */
export function databaseLoadTimeoutMs(): number {
  const seconds = Number.parseInt(process.env.TOHYEE_ANALYTICS_DATABASE_SECONDS ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_LOAD_TIMEOUT_MS;
}

function sessionOptions(timeoutMs: number) {
  return { timeoutMs, connectTimeoutMs: CONNECT_TIMEOUT_MS, timeZone: businessTimeZone() };
}

async function withSession<T>(
  settings: ConnectionSettings,
  password: string,
  timeoutMs: number,
  work: (session: ExternalSession) => Promise<T>,
  drivers: DriverModules,
): Promise<T> {
  const session = await openSession(settings, password, sessionOptions(timeoutMs), drivers);
  try {
    return await work(session);
  } catch (error) {
    throw friendlyError(settings.engine, error, "query", settings, timeoutMs);
  } finally {
    await session.close();
  }
}

/** Connects and lists the tables, so a connection is only saved when it works. */
export async function testConnection(settings: ConnectionSettings, password: string, drivers: DriverModules = realDrivers): Promise<{ tables: number; views: number }> {
  await refuseTohyeeDatabase(settings);
  return withSession(settings, password, PREVIEW_TIMEOUT_MS, async (session) => {
    const objects = await session.objects();
    return { tables: objects.filter((entry) => entry.kind === "table").length, views: objects.filter((entry) => entry.kind === "view").length };
  }, drivers);
}

/* -------------------------------------------------------------------------- */
/* Saving connections                                                          */
/* -------------------------------------------------------------------------- */

async function ensureNameFree(tx: OrgTx, name: string, except?: string): Promise<void> {
  const taken = await tx.query("select 1 from analytics_db_connections where lower(name) = lower($1) and ($2::bigint is null or id <> $2::bigint)", [name, except ?? null]);
  if (taken.rows.length > 0) throw new ConflictError(`Another connection is already called ${name}.`);
}

function auditDetails(name: string, settings: ConnectionSettings) {
  // Where it points, never the password.
  return { name, engine: settings.engine, host: settings.host, port: settings.port, instanceName: settings.instanceName, database: settings.database, username: settings.username, encryption: settings.encryption };
}

export async function requireAnalyticsOn(tx: OrgTx): Promise<void> {
  const result = await tx.query<{ analytics_enabled: boolean }>("select analytics_enabled from organisation_settings where id = true");
  if (result.rows[0]?.analytics_enabled !== true) throw new ConflictError("Analytics is off. An admin can turn it on in Settings › Modules.");
}

/**
 * Tests a connection someone typed (or changes to a saved one), outside any
 * transaction. A saved password is only reused when it would go to the same
 * server and database as the same user: changing where a connection points
 * needs the password typed again, so it can't be sent somewhere else.
 */
export async function checkConnectionInput(
  organisation: OrganisationRecord,
  actor: Actor,
  input: Record<string, unknown>,
  savedId?: string,
  drivers: DriverModules = realDrivers,
): Promise<{ settings: ConnectionSettings; password: string; result: { tables: number; views: number } }> {
  const settings = parseConnectionSettings(input);
  const typed = parsePassword(input.password, !savedId);
  let password = typed;
  if (password === null && savedId) {
    const saved = await withOrganisationTransaction(organisation, actor, async (tx) => {
      await requireAnalyticsOn(tx);
      return connectionSecret(tx, savedId);
    }, { readOnly: true });
    if (!sameDestination(settings, settingsOf(saved.connection))) {
      throw new ValidationError("Enter the password again: the server, database or user has changed.");
    }
    password = saved.password;
  }
  const result = await testConnection(settings, password!, drivers);
  return { settings, password: password!, result };
}

export async function saveNewConnection(tx: OrgTx, input: Record<string, unknown>, settings: ConnectionSettings, password: string): Promise<DatabaseConnection> {
  await requireAnalyticsOn(tx);
  const name = connectionName(input.name);
  await ensureNameFree(tx, name);
  const result = await tx.query<{ id: string }>(
    `insert into analytics_db_connections (name, engine, host, port, instance_name, database_name, username, password_ciphertext, encryption, created_by_email, updated_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning id::text`,
    [name, settings.engine, settings.host, settings.port, settings.instanceName, settings.database, settings.username, encryptSecret(password), settings.encryption, tx.actor.email],
  );
  const id = result.rows[0].id;
  await writeAuditEvent(tx, { eventType: "analytics.database_connection_created", entityType: "analytics_db_connection", entityId: id, details: auditDetails(name, settings) });
  return getConnection(tx, id);
}

export async function saveConnectionChanges(
  tx: OrgTx,
  id: string,
  input: Record<string, unknown>,
  settings: ConnectionSettings,
  password: string,
): Promise<DatabaseConnection> {
  await requireAnalyticsOn(tx);
  const current = await getConnection(tx, id);
  if (current.engine !== settings.engine) throw new ValidationError("A connection's kind of database can't change. Add a new connection instead.");
  const name = input.name === undefined ? current.name : connectionName(input.name);
  await ensureNameFree(tx, name, id);
  await tx.query(
    `update analytics_db_connections set name = $2, host = $3, port = $4, instance_name = $5, database_name = $6, username = $7,
            password_ciphertext = $8, encryption = $9, updated_by_email = $10, updated_at = now() where id = $1`,
    [id, name, settings.host, settings.port, settings.instanceName, settings.database, settings.username, encryptSecret(password), settings.encryption, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "analytics.database_connection_updated",
    entityType: "analytics_db_connection",
    entityId: id,
    details: { ...auditDetails(name, settings), passwordChanged: input.password !== undefined && input.password !== null && input.password !== "" },
  });
  return getConnection(tx, id);
}

export async function deleteConnection(tx: OrgTx, id: unknown): Promise<void> {
  await requireAnalyticsOn(tx);
  const current = await getConnection(tx, id);
  if (current.sourceCount > 0) {
    throw new ConflictError(`${current.sourceCount === 1 ? "A source uses" : `${current.sourceCount} sources use`} this connection. Remove ${current.sourceCount === 1 ? "it" : "them"} first.`);
  }
  await tx.query("delete from analytics_db_connections where id = $1", [current.id]);
  await writeAuditEvent(tx, {
    eventType: "analytics.database_connection_deleted",
    entityType: "analytics_db_connection",
    entityId: current.id,
    details: { name: current.name, engine: current.engine, host: current.host, database: current.database },
  });
}

/* -------------------------------------------------------------------------- */
/* Tables, previews and loads                                                  */
/* -------------------------------------------------------------------------- */

/** What a source reads: one table or view, or one typed SELECT. */
export type DatabaseQuerySpec = { schema: string | null; table: string; query?: null } | { schema?: null; table?: null; query: string };

function objectName(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidationError(`Choose a ${what}.`);
  return value;
}

/** Checks a table choice or a typed query. A typed query must pass the read-only check. */
export function parseQuerySpec(engine: DatabaseEngine, input: Record<string, unknown>): DatabaseQuerySpec {
  const hasQuery = typeof input.query === "string" && input.query.trim() !== "";
  const hasTable = typeof input.table === "string" && input.table !== "";
  if (hasQuery && hasTable) throw new ValidationError("Choose a table or write a query, not both.");
  if (hasQuery) return { query: checkReadOnlyQuery(input.query, engine) };
  if (!hasTable) throw new ValidationError("Choose a table or view, or write a query.");
  const schema = input.schema === undefined || input.schema === null || input.schema === "" || engine === "mysql" ? null : objectName(input.schema, "schema");
  return { schema, table: objectName(input.table, "table or view") };
}

/** The query inside Tohyee's own SELECT. */
export function innerQuery(engine: DatabaseEngine, spec: DatabaseQuerySpec): string {
  if (spec.query) return checkReadOnlyQuery(spec.query, engine);
  return `select * from ${quoteObject(engine, spec.schema ?? null, spec.table!)}`;
}

function checkColumns(columns: ExternalColumn[]): void {
  if (columns.length === 0) throw new ValidationError("That gives no columns.");
  const seen = new Set<string>();
  for (const column of columns) {
    if (!column.name) throw new ValidationError("Every column needs a name. Give calculated columns one with AS.");
    const key = column.name.toLowerCase();
    if (seen.has(key)) throw new ValidationError(`Two columns are both called ${column.name}. Give one another name with AS.`);
    seen.add(key);
  }
}

export type PreviewColumn = {
  source: string;
  name: string;
  kind: ColumnKind;
  loadable: boolean;
  /** The database's type, e.g. numeric(12,2). */
  detected: string;
  examples: string[];
};

function typeText(column: ExternalColumn): string {
  if (column.precision !== null && column.scale !== null) return `${column.type}(${column.precision},${column.scale})`;
  return column.type;
}

const PREVIEW_ROWS = 20;

export async function listObjects(organisation: OrganisationRecord, actor: Actor, id: unknown, drivers: DriverModules = realDrivers): Promise<ExternalObject[]> {
  const { connection, password } = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalyticsOn(tx);
    return connectionSecret(tx, id);
  }, { readOnly: true });
  const settings = settingsOf(connection);
  await refuseTohyeeDatabase(settings);
  return withSession(settings, password, PREVIEW_TIMEOUT_MS, (session) => session.objects(), drivers);
}

/** A table's or query's columns, how each would load, and its first rows. */
export async function previewQuery(
  organisation: OrganisationRecord,
  actor: Actor,
  id: unknown,
  input: Record<string, unknown>,
  drivers: DriverModules = realDrivers,
): Promise<{ columns: PreviewColumn[]; rows: string[][] }> {
  const { connection, password } = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalyticsOn(tx);
    return connectionSecret(tx, id);
  }, { readOnly: true });
  const settings = settingsOf(connection);
  const spec = parseQuerySpec(settings.engine, input);
  await refuseTohyeeDatabase(settings);
  return withSession(settings, password, PREVIEW_TIMEOUT_MS, async (session) => {
    const inner = innerQuery(settings.engine, spec);
    const described = await session.describe(inner);
    checkColumns(described);
    const taken = new Set<string>();
    const columns = described.map((column) => {
      const suggestion = suggestColumn(settings.engine, column);
      return { column, suggestion, name: columnNameFrom(snakeName(column.name), taken) };
    });
    const readable = columns.filter((entry) => entry.suggestion.loadable);
    const rows: string[][] = [];
    if (readable.length > 0) {
      for await (const row of session.rows(outerSelect(settings.engine, inner, readable.map((entry) => entry.column), PREVIEW_ROWS))) {
        rows.push(readable.map((entry, index) => valueText(row[index], entry.suggestion.kind) ?? ""));
        if (rows.length >= PREVIEW_ROWS) break;
      }
    }
    const shown = columns.map((entry) => {
      const at = readable.indexOf(entry);
      return {
        source: entry.column.name,
        name: entry.name,
        kind: entry.suggestion.kind,
        loadable: entry.suggestion.loadable,
        detected: typeText(entry.column),
        examples: at < 0 ? [] : rows.slice(0, 3).map((row) => row[at]),
      };
    });
    // The rows line up with every column; binary ones are blank.
    return { columns: shown, rows: rows.map((row) => shown.map((column) => { const at = readable.findIndex((entry) => entry.column.name === column.source); return at < 0 ? "" : row[at]; })) };
  }, drivers);
}

const LOAD_BATCH = 2000;

/**
 * Reads a source's rows for loading (decision 603): the chosen columns only,
 * as text, a batch at a time, stopping with an error (not a partial load)
 * past the row limit or the time limit. The session closes when the rows
 * have been read or reading stops.
 */
export async function readSourceRows(input: {
  settings: ConnectionSettings;
  password: string;
  spec: DatabaseQuerySpec;
  columns: readonly LoadColumn[];
  rowLimit: number;
  timeoutMs?: number;
  drivers?: DriverModules;
}): Promise<{ batches: AsyncIterable<Array<string | null>[]>; close: () => Promise<void> }> {
  const { settings, password, spec, columns, rowLimit } = input;
  const timeoutMs = input.timeoutMs ?? databaseLoadTimeoutMs();
  await refuseTohyeeDatabase(settings);
  const session = await openSession(settings, password, sessionOptions(timeoutMs), input.drivers ?? realDrivers);
  let external: ExternalColumn[];
  let inner: string;
  try {
    inner = innerQuery(settings.engine, spec);
    const described = await session.describe(inner);
    checkColumns(described);
    const byName = new Map(described.map((column) => [column.name, column]));
    external = columns.map((column) => {
      const found = byName.get(column.source);
      if (!found) throw new ValidationError(`The column ${column.source} isn't there any more. Edit the source to choose its columns again.`);
      if (!suggestColumn(settings.engine, found).loadable) throw new ValidationError(`${column.source} is binary data, which can't be loaded.`);
      return found;
    });
  } catch (error) {
    await session.close();
    throw friendlyError(settings.engine, error, "query", settings, timeoutMs);
  }
  const started = Date.now();
  const sql = outerSelect(settings.engine, inner, external, rowLimit + 1);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await session.close();
  };
  const batches = (async function* () {
    let count = 0;
    let batch: Array<string | null>[] = [];
    try {
      for await (const row of session.rows(sql)) {
        count += 1;
        if (count > rowLimit) {
          throw new ValidationError(
            `There are more than ${rowLimit.toLocaleString("en-NZ")} rows, the source's limit, so nothing was loaded. Filter the query, or raise the limit.`,
          );
        }
        if (Date.now() - started > timeoutMs) {
          throw new ValidationError(`Reading took more than ${Math.round(timeoutMs / 60_000)} minutes, so Tohyee stopped. Filter the query to fewer rows.`);
        }
        batch.push(columns.map((column, index) => valueText(row[index], column.kind)));
        if (batch.length >= LOAD_BATCH) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    } catch (error) {
      throw friendlyError(settings.engine, error, "query", settings, timeoutMs);
    } finally {
      await close();
    }
  })();
  return { batches, close };
}

/** "Sales database › dbo.Orders" or "Sales database › query". */
export function sourceLabel(connectionNameText: string, spec: { schema: string | null; table: string | null; query: string | null }): string {
  if (spec.query) return `${connectionNameText} › query`;
  return `${connectionNameText} › ${spec.schema ? `${spec.schema}.` : ""}${spec.table}`;
}

export { DATABASE_ENGINES };

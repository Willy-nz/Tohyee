import net from "node:net";
import { ValidationError } from "@/lib/errors";
import { type ConnectionSettings, DATABASE_ENGINES, type DatabaseEngine } from "@/lib/analytics/databases/config";
import { describeSelect, type ExternalColumn } from "@/lib/analytics/databases/types";

/**
 * Talking to an external database (decisions 602-604). Server only: each
 * driver (pg, mysql2, mssql) is loaded the first time it's needed. Every
 * session reads only: PostgreSQL and MySQL run each query in a read-only
 * transaction (and PostgreSQL's whole session defaults to read only), each
 * query has a time limit, and errors are turned into plain messages that
 * don't pass on the driver's own text about the connection.
 *
 * The drivers are passed in (`DriverModules`) so tests can use fakes for
 * MySQL and SQL Server, which aren't available to test against here.
 */

export type ExternalObject = { schema: string | null; name: string; kind: "table" | "view" };

export interface ExternalSession {
  /** The tables and views this user can see (up to MAX_OBJECTS). */
  objects(): Promise<ExternalObject[]>;
  /** A query's columns, without reading any rows. */
  describe(inner: string): Promise<ExternalColumn[]>;
  /** A query's rows, as arrays in column order, read a batch at a time. */
  rows(sql: string): AsyncIterable<unknown[]>;
  close(): Promise<void>;
}

export type SessionOptions = {
  /** Each query stops after this long. */
  timeoutMs: number;
  /** Connecting stops after this long. */
  connectTimeoutMs: number;
  /** Date-times with a time zone are read in this one (PostgreSQL). */
  timeZone: string;
};

export const MAX_OBJECTS = 2000;
const FETCH_ROWS = 2000;

/** What Tohyee uses of each driver: enough for real modules and for fakes. */
export type PgModule = {
  Client: new (config: Record<string, unknown>) => {
    connect(): Promise<unknown>;
    query(query: string | { text: string; rowMode?: "array"; values?: unknown[] }, values?: unknown[]): Promise<{
      rows: unknown[];
      fields: Array<{ name: string; dataTypeID: number; dataTypeModifier: number }>;
    }>;
    end(): Promise<void>;
    on(event: "error", listener: (error: unknown) => void): unknown;
  };
};

export type MysqlField = { name: string; columnType: number; columnLength: number; decimals: number; flags: number; characterSet: number };
export type MysqlConnection = {
  query(options: { sql: string; rowsAsArray?: boolean; timeout?: number }): Promise<[unknown, MysqlField[] | undefined]>;
  end(): Promise<void>;
  on?(event: "error", listener: (error: unknown) => void): unknown;
  connection: { query(options: { sql: string; rowsAsArray?: boolean; timeout?: number }): { stream(options?: { highWaterMark?: number }): AsyncIterable<unknown> } };
};
export type MysqlModule = { createConnection(config: Record<string, unknown>): Promise<MysqlConnection> };

export type MssqlColumn = { name: string; type?: { declaration?: string } | null; precision?: number; scale?: number; length?: number; udt?: { name?: string } };
export type MssqlRequest = {
  arrayRowMode: boolean | null;
  query(sql: string): Promise<{ recordset?: unknown[]; columns?: MssqlColumn[][] }>;
  toReadableStream(options?: { highWaterMark?: number }): AsyncIterable<unknown> & { destroy(error?: Error): unknown };
  cancel?(): unknown;
};
export type MssqlPool = {
  connect(): Promise<unknown>;
  request(): MssqlRequest;
  close(): Promise<unknown>;
  on?(event: "error", listener: (error: unknown) => void): unknown;
};
export type MssqlModule = { ConnectionPool: new (config: Record<string, unknown>) => MssqlPool };

export type DriverModules = {
  pg: () => Promise<PgModule>;
  mysql: () => Promise<MysqlModule>;
  mssql: () => Promise<MssqlModule>;
};

// Loaded only when a database source is used, and only on the server.
export const realDrivers: DriverModules = {
  pg: async () => ((await import("pg")).default as unknown as PgModule),
  mysql: async () => ((await import("mysql2/promise")).default as unknown as MysqlModule),
  mssql: async () => ((await import("mssql")).default as unknown as MssqlModule),
};

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

type DriverError = { code?: unknown; errno?: unknown; number?: unknown; message?: unknown; originalError?: unknown; cause?: unknown };

function details(error: unknown): { code: string; number: number | null; message: string } {
  const seen: DriverError[] = [];
  let current: unknown = error;
  while (current && typeof current === "object" && seen.length < 5) {
    seen.push(current as DriverError);
    const next = (current as DriverError).originalError ?? (current as DriverError).cause;
    current = next;
  }
  const codes = seen.map((entry) => (typeof entry.code === "string" ? entry.code : "")).filter(Boolean);
  const numbers = seen.map((entry) => (typeof entry.number === "number" ? entry.number : typeof entry.errno === "number" ? entry.errno : null)).filter((n) => n !== null);
  const messages = seen.map((entry) => (typeof entry.message === "string" ? entry.message : "")).filter(Boolean);
  return { code: codes.join(" "), number: (numbers[0] as number | undefined) ?? null, message: messages.join(" | ") };
}

/** The first line of the database's own message about a query, shortened. */
function databaseSaid(message: string): string {
  const line = (message.split("|")[0].split("\n").find((part) => part.trim()) ?? "").trim();
  const cleaned = line.replace(/^(error|requesterror|queryerror):\s*/i, "").slice(0, 300);
  return cleaned ? ` The database said: ${cleaned}` : "";
}

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|ERR_SSL|EPROTO|HANDSHAKE_NO_SSL_SUPPORT/;

/**
 * A plain message for a failure. While connecting, only what kind of
 * failure it was (the driver's own text can describe the network or server);
 * once connected, a query's error is the database's first line about it.
 */
export function friendlyError(engine: DatabaseEngine, error: unknown, stage: "connect" | "query", settings: Pick<ConnectionSettings, "host" | "port" | "database" | "username">, timeoutMs: number): ValidationError {
  if (error instanceof ValidationError) return error;
  const { code, number, message } = details(error);
  const where = settings.port ? `${settings.host} (port ${settings.port})` : settings.host;
  const seconds = Math.round(timeoutMs / 1000);
  const text = `${code} ${message}`;
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(code) || (stage === "connect" && /getaddrinfo/.test(message))) {
    return new ValidationError(`Tohyee couldn't find a server called ${settings.host}. Check the name, or use its IP address.`);
  }
  if (/EINSTLOOKUP/.test(code) || /instance/i.test(message) && /lookup|not found|failed to get/i.test(message)) {
    return new ValidationError("SQL Server didn't say where that instance is. Check the instance name and that the SQL Server Browser service is running, or enter the port instead.");
  }
  if (/ECONNREFUSED/.test(code) || (stage === "connect" && /ECONNREFUSED/.test(message))) {
    return new ValidationError(`Nothing answered at ${where}. Check the port, that the database server accepts network connections, and that its firewall lets this computer in.`);
  }
  if (/EHOSTUNREACH|ENETUNREACH/.test(text)) {
    return new ValidationError(`Tohyee can't reach ${settings.host} from this server. Check it's on the same network (or VPN) and switched on.`);
  }
  if (/redirected/i.test(message) && code.includes("TOHYEE_REDIRECT")) {
    return new ValidationError("The server asked Tohyee to connect somewhere else instead. Tohyee doesn't follow that: enter the server it was sent to.");
  }
  if (TLS_CODES.test(code) || (stage === "connect" && /does not support SSL|ssl|tls|certificate|secure connection|encrypt/i.test(message))) {
    if (/does not support SSL|HANDSHAKE_NO_SSL_SUPPORT|doesn't support|not support/i.test(text)) {
      return new ValidationError("That server doesn't use encryption. Choose Don't encrypt if it's on your own network, or turn encryption on at the server.");
    }
    const trust = engine === "sqlserver" ? "Encrypt, trust the server's certificate" : "Encrypt (don't check the certificate)";
    return new ValidationError(`The server's certificate couldn't be checked. Choose ${trust} if the server uses its own certificate, or install a certificate that matches its name.`);
  }
  // Logins.
  const badLogin =
    (engine === "postgres" && /^(28P01|28000)$/.test(code.split(" ")[0] ?? "")) ||
    (engine === "mysql" && (number === 1045 || /ER_ACCESS_DENIED_ERROR/.test(code))) ||
    (engine === "sqlserver" && /ELOGIN/.test(code) && !/cannot open database/i.test(message));
  if (badLogin) {
    if (engine === "postgres" && /pg_hba|no .*entry for host/i.test(message)) {
      return new ValidationError("The PostgreSQL server doesn't let this computer connect as that user. Its pg_hba.conf file needs a line for Tohyee's server.");
    }
    return new ValidationError(`The user name or password wasn't accepted for ${settings.username}.`);
  }
  const noDatabase =
    (engine === "postgres" && /3D000/.test(code)) ||
    (engine === "mysql" && (number === 1049 || number === 1044 || /ER_BAD_DB_ERROR|ER_DBACCESS_DENIED_ERROR/.test(code))) ||
    (engine === "sqlserver" && (number === 4060 || /cannot open database/i.test(message)));
  if (noDatabase) return new ValidationError(`There's no database called ${settings.database}, or ${settings.username} can't open it.`);
  // Time limits.
  // A query's own error can mention a column called "timeout", so after connecting only known phrases count.
  const timedOut =
    /ETIMEDOUT|ETIMEOUT|PROTOCOL_SEQUENCE_TIMEOUT|57014|ER_QUERY_TIMEOUT/.test(code) ||
    number === 3024 ||
    (stage === "connect"
      ? /timeout|timed out/i.test(message)
      : /canceling statement due to statement timeout|maximum statement execution time|Query read timeout|inactivity timeout|Timeout: Request failed/i.test(message));
  if (timedOut) {
    return stage === "connect"
      ? new ValidationError(`${where} didn't answer within ${seconds} seconds. Check the server name, port and firewall.`)
      : new ValidationError(`The database took more than ${seconds} seconds, so Tohyee stopped. Filter the query to fewer rows, or ask for less.`);
  }
  if (/25006|ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION/.test(code) || number === 1792) {
    return new ValidationError("Tohyee only reads from the database, so it can't run something that changes data.");
  }
  if (/ECONNRESET|PROTOCOL_CONNECTION_LOST|ECONNCLOSED|ESOCKET|EPIPE|Connection terminated/i.test(text)) {
    return new ValidationError(`The connection to ${settings.host} closed unexpectedly. Check the server and try again.`);
  }
  if (stage === "connect") {
    return new ValidationError(`Tohyee couldn't connect to the ${DATABASE_ENGINES[engine].label} database at ${where}. Check the details and try again.`);
  }
  return new ValidationError(`The query didn't work.${databaseSaid(message)}`);
}

/* -------------------------------------------------------------------------- */
/* PostgreSQL                                                                 */
/* -------------------------------------------------------------------------- */

// Every value as the server's own text, so numbers and dates are exact.
const RAW_TEXT_TYPES = { getTypeParser: () => (value: string) => value };

function safeTimeZone(zone: string): string {
  return /^[A-Za-z][A-Za-z0-9_+\-/]{0,60}$/.test(zone) ? zone : "UTC";
}

function numericTypmod(modifier: number): { precision: number | null; scale: number | null } {
  if (!Number.isInteger(modifier) || modifier < 4) return { precision: null, scale: null };
  const value = modifier - 4;
  return { precision: (value >> 16) & 0xffff, scale: value & 0xffff };
}

async function openPostgres(settings: ConnectionSettings, password: string, options: SessionOptions, drivers: DriverModules): Promise<ExternalSession> {
  const pg = await drivers.pg();
  const client = new pg.Client({
    host: settings.host,
    port: settings.port ?? DATABASE_ENGINES.postgres.defaultPort,
    database: settings.database,
    user: settings.username,
    password,
    ssl: settings.encryption === "off" ? false : { rejectUnauthorized: settings.encryption === "verify" },
    connectionTimeoutMillis: options.connectTimeoutMs,
    statement_timeout: options.timeoutMs,
    query_timeout: options.timeoutMs + 5_000,
    application_name: "Tohyee analytics",
    // The whole session reads only, as well as each transaction.
    options: `-c default_transaction_read_only=on -c TimeZone=${safeTimeZone(options.timeZone)} -c DateStyle=ISO`,
    types: RAW_TEXT_TYPES,
  });
  // A dropped connection is reported by the query that was waiting; this keeps it from stopping the server.
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  const readOnly = async <T>(work: () => Promise<T>): Promise<T> => {
    await client.query("begin");
    await client.query("set transaction read only");
    try {
      return await work();
    } finally {
      await client.query("rollback").catch(() => undefined);
    }
  };
  return {
    async objects() {
      return readOnly(async () => {
        const result = await client.query({
          text: `select table_schema, table_name, table_type from information_schema.tables
                  where table_schema not in ('pg_catalog', 'information_schema') and table_schema not like 'pg\\_%'
                  order by table_schema, table_name limit ${MAX_OBJECTS}`,
          rowMode: "array",
        });
        return (result.rows as string[][]).map(([schema, name, type]) => ({ schema, name, kind: type === "VIEW" ? "view" : "table" }));
      });
    },
    async describe(inner) {
      return readOnly(async () => {
        const result = await client.query({ text: describeSelect("postgres", inner), rowMode: "array" });
        const oids = [...new Set(result.fields.map((field) => field.dataTypeID))];
        const types = await client.query({
          text: `select t.oid::text, coalesce(b.typname, t.typname)::text from pg_type t
                   left join pg_type b on t.typtype = 'd' and b.oid = t.typbasetype where t.oid = any($1::oid[])`,
          values: [oids],
          rowMode: "array",
        });
        const names = new Map((types.rows as string[][]).map(([oid, name]) => [Number(oid), name]));
        return result.fields.map((field) => {
          const type = names.get(field.dataTypeID) ?? "text";
          const { precision, scale } = type === "numeric" ? numericTypmod(field.dataTypeModifier) : { precision: null, scale: null };
          return { name: field.name, type, precision, scale };
        });
      });
    },
    rows(sql) {
      return (async function* () {
        await client.query("begin");
        try {
          await client.query("set transaction read only");
          await client.query(`declare tohyee_rows no scroll cursor for ${sql}`);
          for (;;) {
            const batch = await client.query({ text: `fetch forward ${FETCH_ROWS} from tohyee_rows`, rowMode: "array" });
            for (const row of batch.rows as unknown[][]) yield row;
            if (batch.rows.length < FETCH_ROWS) break;
          }
        } finally {
          await client.query("rollback").catch(() => undefined);
        }
      })();
    },
    async close() {
      await client.end().catch(() => undefined);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* MySQL                                                                      */
/* -------------------------------------------------------------------------- */

/** MySQL's column type codes (its protocol's, which don't change). */
const MYSQL_TYPES: Record<number, string> = {
  0x00: "decimal", 0x01: "tiny", 0x02: "short", 0x03: "long", 0x04: "float", 0x05: "double", 0x06: "null",
  0x07: "timestamp", 0x08: "longlong", 0x09: "int24", 0x0a: "date", 0x0b: "time", 0x0c: "datetime", 0x0d: "year",
  0x0e: "newdate", 0x0f: "varchar", 0x10: "bit", 0xf2: "vector", 0xf5: "json", 0xf6: "newdecimal", 0xf7: "enum",
  0xf8: "set", 0xf9: "tiny_blob", 0xfa: "medium_blob", 0xfb: "long_blob", 0xfc: "blob", 0xfd: "var_string",
  0xfe: "string", 0xff: "geometry",
};
const MYSQL_BINARY_CHARSET = 63;
const MYSQL_UNSIGNED = 32;

export function mysqlColumn(field: MysqlField): ExternalColumn {
  const type = MYSQL_TYPES[field.columnType] ?? "varchar";
  const decimal = type === "decimal" || type === "newdecimal";
  const precision = decimal ? Math.max(1, field.columnLength - (field.decimals > 0 ? 1 : 0) - (field.flags & MYSQL_UNSIGNED ? 0 : 1)) : null;
  return {
    name: field.name,
    type,
    precision,
    scale: decimal ? field.decimals : null,
    binary: field.characterSet === MYSQL_BINARY_CHARSET && /blob|string|varchar/.test(type),
    length: field.columnLength,
  };
}

async function openMysql(settings: ConnectionSettings, password: string, options: SessionOptions, drivers: DriverModules): Promise<ExternalSession> {
  const mysql = await drivers.mysql();
  const connection = await mysql.createConnection({
    host: settings.host,
    port: settings.port ?? DATABASE_ENGINES.mysql.defaultPort,
    database: settings.database,
    user: settings.username,
    password,
    ssl: settings.encryption === "off" ? undefined : { rejectUnauthorized: settings.encryption === "verify" },
    connectTimeout: options.connectTimeoutMs,
    // The server can't ask Tohyee for files on this computer (LOAD DATA LOCAL), and only one statement runs at a time.
    flags: "-LOCAL_FILES",
    multipleStatements: false,
    // Exact text for decimals, big whole numbers and dates.
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    timezone: "local",
  });
  connection.on?.("error", () => undefined);
  const run = (sql: string) => connection.query({ sql, rowsAsArray: true, timeout: options.timeoutMs });
  try {
    await run("set session transaction read only");
    // MySQL's own time limit for SELECTs (MariaDB's has another name); the driver's timeout covers both.
    await run(`set session max_execution_time = ${Math.round(options.timeoutMs)}`).catch(() =>
      run(`set session max_statement_time = ${Math.round(options.timeoutMs / 1000)}`).catch(() => undefined),
    );
  } catch (error) {
    await connection.end().catch(() => undefined);
    throw error;
  }
  const readOnly = async <T>(work: () => Promise<T>): Promise<T> => {
    await run("start transaction read only");
    try {
      return await work();
    } finally {
      await run("rollback").catch(() => undefined);
    }
  };
  return {
    async objects() {
      return readOnly(async () => {
        const [rows] = await run(
          `select table_name, table_type from information_schema.tables where table_schema = database() order by table_name limit ${MAX_OBJECTS}`,
        );
        return (rows as string[][]).map(([name, type]) => ({ schema: null, name, kind: /VIEW/i.test(type) ? "view" : "table" }));
      });
    },
    async describe(inner) {
      return readOnly(async () => {
        const [, fields] = await run(describeSelect("mysql", inner));
        return (fields ?? []).map(mysqlColumn);
      });
    },
    rows(sql) {
      return (async function* () {
        await run("start transaction read only");
        try {
          const stream = connection.connection.query({ sql, rowsAsArray: true, timeout: options.timeoutMs }).stream({ highWaterMark: FETCH_ROWS });
          for await (const row of stream) yield row as unknown[];
        } finally {
          await run("rollback").catch(() => undefined);
        }
      })();
    },
    async close() {
      await connection.end().catch(() => undefined);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* SQL Server                                                                 */
/* -------------------------------------------------------------------------- */

class RedirectRefused extends Error {
  code = "TOHYEE_REDIRECT";
  constructor() {
    super("The server redirected the connection.");
  }
}

/**
 * Opens the TCP connection for the SQL Server driver, only to the server
 * that was entered. SQL Server can send a client on to another server after
 * it has logged in (Azure's redirect, availability groups); following that
 * would send the password somewhere nobody chose, so it's refused.
 */
export function sqlServerConnector(host: string) {
  return (target: { host: string; port: number }, _lookup: unknown, signal?: AbortSignal): Promise<net.Socket> => {
    if (target.host.toLowerCase() !== host.toLowerCase()) return Promise.reject(new RedirectRefused());
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: target.host, port: target.port });
      const abort = () => {
        socket.destroy();
        reject(new Error("The connection was cancelled (timeout)."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        signal?.removeEventListener("abort", abort);
        resolve(socket);
      });
      socket.once("error", (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
    });
  };
}

export function sqlServerColumn(column: MssqlColumn): ExternalColumn {
  const type = column.udt?.name ? (["geography", "geometry", "hierarchyid"].includes(column.udt.name.toLowerCase()) ? column.udt.name.toLowerCase() : "udt") : (column.type?.declaration ?? "nvarchar").toLowerCase();
  const decimal = type === "decimal" || type === "numeric";
  return {
    name: column.name,
    type,
    precision: decimal && typeof column.precision === "number" ? column.precision : null,
    scale: decimal && typeof column.scale === "number" ? column.scale : null,
  };
}

async function openSqlServer(settings: ConnectionSettings, password: string, options: SessionOptions, drivers: DriverModules): Promise<ExternalSession> {
  const mssql = await drivers.mssql();
  const pool = new mssql.ConnectionPool({
    server: settings.host,
    port: settings.instanceName ? undefined : (settings.port ?? DATABASE_ENGINES.sqlserver.defaultPort),
    database: settings.database,
    user: settings.username,
    password,
    connectionTimeout: options.connectTimeoutMs,
    requestTimeout: options.timeoutMs,
    pool: { max: 1, min: 0 },
    options: {
      encrypt: settings.encryption !== "off",
      trustServerCertificate: settings.encryption === "require",
      instanceName: settings.instanceName ?? undefined,
      appName: "Tohyee analytics",
      abortTransactionOnError: true,
      connector: sqlServerConnector(settings.host),
    },
  });
  pool.on?.("error", () => undefined);
  try {
    await pool.connect();
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
  const request = (arrayRows = true) => {
    const made = pool.request();
    made.arrayRowMode = arrayRows;
    return made;
  };
  return {
    async objects() {
      const result = await request().query(
        `select top (${MAX_OBJECTS}) table_schema, table_name, table_type from information_schema.tables order by table_schema, table_name`,
      );
      return ((result.recordset ?? []) as string[][]).map(([schema, name, type]) => ({ schema, name, kind: /VIEW/i.test(type) ? "view" : "table" }));
    },
    async describe(inner) {
      const result = await request().query(describeSelect("sqlserver", inner));
      return (result.columns?.[0] ?? []).map(sqlServerColumn);
    },
    rows(sql) {
      return (async function* () {
        const made = request();
        const stream = made.toReadableStream({ highWaterMark: FETCH_ROWS });
        // In stream mode errors arrive through the stream; the promise itself only settles.
        made.query(sql).catch(() => undefined);
        try {
          for await (const row of stream) yield row as unknown[];
        } finally {
          stream.destroy();
        }
      })();
    },
    async close() {
      await pool.close().catch(() => undefined);
    },
  };
}

/* -------------------------------------------------------------------------- */

/** Connects to the database, or throws a plain-language ValidationError. */
export async function openSession(
  settings: ConnectionSettings,
  password: string,
  options: SessionOptions,
  drivers: DriverModules = realDrivers,
): Promise<ExternalSession> {
  try {
    if (settings.engine === "postgres") return await openPostgres(settings, password, options, drivers);
    if (settings.engine === "mysql") return await openMysql(settings, password, options, drivers);
    return await openSqlServer(settings, password, options, drivers);
  } catch (error) {
    throw friendlyError(settings.engine, error, "connect", settings, options.connectTimeoutMs);
  }
}

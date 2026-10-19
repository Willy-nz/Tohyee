import { ValidationError } from "@/lib/errors";

/**
 * External databases as Analytics sources (decisions 602-605): which kinds
 * of database, how a connection is described, and the limits on a load.
 * Browser-safe: no drivers here.
 */

export type DatabaseEngine = "postgres" | "mysql" | "sqlserver";

/**
 * How the connection is encrypted: not at all, encrypted without checking
 * the server's certificate (SQL Server's "trust server certificate"), or
 * encrypted with the certificate checked against the server's name.
 */
export type Encryption = "off" | "require" | "verify";

export const DATABASE_ENGINES: Record<DatabaseEngine, { label: string; defaultPort: number }> = {
  sqlserver: { label: "Microsoft SQL Server", defaultPort: 1433 },
  postgres: { label: "PostgreSQL", defaultPort: 5432 },
  mysql: { label: "MySQL", defaultPort: 3306 },
};

export function isDatabaseEngine(value: unknown): value is DatabaseEngine {
  return value === "postgres" || value === "mysql" || value === "sqlserver";
}

export type ConnectionSettings = {
  engine: DatabaseEngine;
  host: string;
  /** Null for a SQL Server named instance, whose port SQL Server Browser gives. */
  port: number | null;
  database: string;
  username: string;
  encryption: Encryption;
  /** SQL Server only: e.g. SQLEXPRESS. */
  instanceName: string | null;
};

/** A row limit for a source when none is chosen, and the most it can be. */
export const DEFAULT_ROW_LIMIT = 1_000_000;
export const MAX_ROW_LIMIT = 5_000_000;

/** The most a typed query can be. */
export const MAX_QUERY_LENGTH = 20_000;

const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^\[?[0-9A-Fa-f:.]{2,45}\]?$/;
const INSTANCE = /^[A-Za-z_][A-Za-z0-9_$#-]{0,15}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`Enter the ${what}.`);
  const trimmed = value.trim();
  if (trimmed.length > max || CONTROL.test(trimmed)) throw new ValidationError(`The ${what} must be up to ${max} characters, on one line.`);
  return trimmed;
}

/**
 * The server's name or address, without a web address or port. A SQL Server
 * written as SERVER\INSTANCE is split into the server and its instance.
 */
export function parseHost(value: unknown, engine: DatabaseEngine): { host: string; instanceName: string | null } {
  const raw = text(value, "server name or address", 260);
  let host = raw;
  let instanceName: string | null = null;
  if (engine === "sqlserver" && raw.includes("\\")) {
    const [server, instance, ...rest] = raw.split("\\");
    if (rest.length > 0 || !server || !instance) throw new ValidationError("Write a SQL Server instance as SERVER\\INSTANCE, e.g. OFFICE-PC\\SQLEXPRESS.");
    host = server;
    instanceName = instance;
  }
  if (/:\/\/|[/@\s?#]/.test(host)) {
    throw new ValidationError("Enter only the server's name or IP address (e.g. 192.168.1.20 or accounts-server), without http://, a user or a path.");
  }
  if (IPV4.test(host)) return { host, instanceName };
  if (host.includes(":")) {
    if (!IPV6.test(host) || (host.match(/:/g) ?? []).length < 2) throw new ValidationError("Put the port in the Port box, not after the server's name.");
    return { host: host.replace(/^\[|\]$/g, ""), instanceName };
  }
  if (!HOST_NAME.test(host)) throw new ValidationError("That isn't a valid server name. Use letters, digits, - and dots, or an IP address.");
  return { host, instanceName };
}

function port(value: unknown, engine: DatabaseEngine, instanceName: string | null): number | null {
  if (value === undefined || value === null || value === "") {
    return engine === "sqlserver" && instanceName ? null : DATABASE_ENGINES[engine].defaultPort;
  }
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new ValidationError("The port must be a number from 1 to 65535.");
  return number;
}

/** Checks what someone typed for a connection (everything but the password). */
export function parseConnectionSettings(input: Record<string, unknown>): ConnectionSettings {
  if (!isDatabaseEngine(input.engine)) throw new ValidationError("Choose SQL Server, PostgreSQL or MySQL.");
  const engine = input.engine;
  const parsed = parseHost(input.host, engine);
  let instanceName = parsed.instanceName;
  if (engine === "sqlserver" && typeof input.instanceName === "string" && input.instanceName.trim()) {
    const typed = input.instanceName.trim();
    if (instanceName && instanceName.toLowerCase() !== typed.toLowerCase()) {
      throw new ValidationError("The instance is given twice, differently. Use the Instance box only.");
    }
    instanceName = typed;
  }
  if (instanceName !== null) {
    if (engine !== "sqlserver") throw new ValidationError("Only SQL Server has named instances.");
    if (!INSTANCE.test(instanceName)) throw new ValidationError("A SQL Server instance name is up to 16 letters, digits and _, e.g. SQLEXPRESS.");
  }
  const encryption = input.encryption === undefined ? "require" : input.encryption;
  if (encryption !== "off" && encryption !== "require" && encryption !== "verify") throw new ValidationError("Choose how the connection is encrypted.");
  return {
    engine,
    host: parsed.host,
    port: port(input.port, engine, instanceName),
    database: text(input.database, "database name", 128),
    username: text(input.username, "user name", 128),
    encryption,
    instanceName,
  };
}

/** A typed password: kept exactly as typed (spaces count), never trimmed. */
export function parsePassword(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ValidationError("Enter the password.");
    return null;
  }
  if (typeof value !== "string" || value.length > 1024) throw new ValidationError("The password must be up to 1,024 characters.");
  return value;
}

/** Whether two settings send the password to the same place as the same user. */
export function sameDestination(a: ConnectionSettings, b: ConnectionSettings): boolean {
  return (
    a.engine === b.engine &&
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.port === b.port &&
    (a.instanceName ?? "").toLowerCase() === (b.instanceName ?? "").toLowerCase() &&
    a.database === b.database &&
    a.username === b.username
  );
}

export function parseRowLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_ROW_LIMIT;
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > MAX_ROW_LIMIT) {
    throw new ValidationError(`The row limit must be a whole number from 1 to ${MAX_ROW_LIMIT.toLocaleString("en-NZ")}.`);
  }
  return number;
}

/** Where a connection points, for people to read: "accounts-server:1433 › Sales". */
export function describeConnection(settings: Pick<ConnectionSettings, "host" | "port" | "instanceName" | "database">): string {
  const server = settings.instanceName ? `${settings.host}\\${settings.instanceName}` : settings.port ? `${settings.host}:${settings.port}` : settings.host;
  return `${server} › ${settings.database}`;
}

import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { ValidationError } from "@/lib/errors";

/**
 * The analytics engine (decisions 353-357): one DuckDB file per organisation
 * in the analytics folder, holding only loaded data. Everything that defines
 * what's loaded lives in the organisation's PostgreSQL database; this file
 * can always be rebuilt by loading again.
 */

/** Where the analytics files are kept (not the folder sources are read from). */
export function analyticsFolder(): string {
  const configured = process.env.TOHYEE_ANALYTICS_DIR?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData || "C:\\ProgramData", "Tohyee", "analytics");
  }
  return path.join(process.cwd(), "analytics");
}

const ORGANISATION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function analyticsFilePath(organisationId: string): string {
  if (!ORGANISATION_ID.test(organisationId)) throw new ValidationError("Unknown organisation.");
  return path.join(analyticsFolder(), `${organisationId}.duckdb`);
}

/**
 * How a column is loaded. Money and quantities are exact decimals, never
 * floating-point numbers (decision 356).
 */
export type ColumnKind = "text" | "integer" | "money" | "quantity" | "decimal" | "date" | "timestamp" | "boolean";

export const COLUMN_TYPES: Record<ColumnKind, string> = {
  text: "VARCHAR",
  integer: "BIGINT",
  money: "DECIMAL(18,2)",
  quantity: "DECIMAL(18,4)",
  decimal: "DECIMAL(18,6)",
  date: "DATE",
  timestamp: "TIMESTAMP",
  boolean: "BOOLEAN",
};

export type LoadColumn = {
  /** The column's heading in the file. */
  source: string;
  /** The column's name in the table (letters, digits and underscores). */
  name: string;
  kind: ColumnKind;
};

const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function assertTableName(name: string): void {
  if (!TABLE_NAME.test(name) || name.startsWith("_tohyee")) {
    throw new ValidationError("A table name must start with a letter and use only lower-case letters, digits and _.");
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// One DuckDB instance per file per process: DuckDB lets only one process
// write a file, and connections from one instance share it safely.
const instances = new Map<string, Promise<DuckDBInstance>>();

async function instanceFor(organisationId: string): Promise<DuckDBInstance> {
  const file = analyticsFilePath(organisationId);
  let instance = instances.get(file);
  if (!instance) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Extensions are never downloaded at run time (the server may be
    // offline, and it's code from the internet).
    instance = DuckDBInstance.create(file, { autoinstall_known_extensions: "false" });
    instances.set(file, instance);
    instance.catch(() => instances.delete(file));
  }
  return instance;
}

// Loads and other writes for one organisation run one at a time.
const queues = new Map<string, Promise<unknown>>();

function serialise<T>(organisationId: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(organisationId) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(organisationId, settled);
  void settled.then(() => {
    if (queues.get(organisationId) === settled) queues.delete(organisationId);
  });
  return next;
}

export async function withAnalytics<T>(organisationId: string, work: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const instance = await instanceFor(organisationId);
  const connection = await instance.connect();
  try {
    return await work(connection);
  } finally {
    connection.closeSync();
  }
}

/** Closes an organisation's analytics file (tests, and before deleting it). */
export async function closeAnalytics(organisationId: string): Promise<void> {
  const file = analyticsFilePath(organisationId);
  const instance = instances.get(file);
  if (!instance) return;
  instances.delete(file);
  await queues.get(organisationId);
  (await instance).closeSync();
}

/** True when `file` is inside `folder` (after resolving `..` and links). */
export function isInsideFolder(folder: string, file: string): boolean {
  const realFolder = fs.realpathSync(folder);
  const realFile = fs.realpathSync(file);
  const relative = path.relative(realFolder, realFile);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export type CsvLoadResult = { rows: number; milliseconds: number };

/**
 * Loads a CSV file into `table`, replacing it only if the whole file loads
 * (decision 357). The file must be inside `sourceFolder` (decision 358).
 * Columns not listed are left out; a listed column missing from the file,
 * or a value that isn't the column's type, fails the load.
 */
export async function loadCsv(input: {
  organisationId: string;
  sourceFolder: string;
  file: string;
  table: string;
  columns: readonly LoadColumn[];
  delimiter?: string;
}): Promise<CsvLoadResult> {
  assertTableName(input.table);
  if (input.columns.length === 0) throw new ValidationError("Choose at least one column to load.");
  const names = new Set<string>();
  for (const column of input.columns) {
    assertTableName(column.name);
    if (names.has(column.name)) throw new ValidationError(`Two columns are both called ${column.name}.`);
    names.add(column.name);
    if (!(column.kind in COLUMN_TYPES)) throw new ValidationError(`Unknown column type for ${column.name}.`);
  }
  if (!fs.existsSync(input.file) || !isInsideFolder(input.sourceFolder, input.file)) {
    throw new ValidationError("That file isn't in this organisation's analytics folder.");
  }
  const delimiter = input.delimiter ?? ",";
  if (delimiter.length !== 1) throw new ValidationError("The separator must be one character.");

  return serialise(input.organisationId, () =>
    withAnalytics(input.organisationId, async (connection) => {
      const started = performance.now();
      const staging = `_tohyee_load_${input.table}`;
      // Every column is read as text and converted explicitly, so DuckDB
      // never guesses a type (it guesses prices as floating-point numbers).
      const select = input.columns
        .map((column) => {
          const value = `nullif(trim(${quoteIdentifier(column.source)}), '')`;
          const converted = column.kind === "text" ? value : `cast(${value} as ${COLUMN_TYPES[column.kind]})`;
          return `${converted} as ${quoteIdentifier(column.name)}`;
        })
        .join(", ");
      await connection.run(`drop table if exists ${quoteIdentifier(staging)}`);
      try {
        await connection.run(
          `create table ${quoteIdentifier(staging)} as select ${select} from read_csv(${quoteString(input.file)}, ` +
            `header = true, all_varchar = true, delim = ${quoteString(delimiter)})`,
        );
        const count = await connection.runAndReadAll(`select count(*)::bigint as n from ${quoteIdentifier(staging)}`);
        const rows = Number(count.getRows()[0][0]);
        await connection.run("begin transaction");
        try {
          await connection.run(`drop table if exists ${quoteIdentifier(input.table)}`);
          await connection.run(`alter table ${quoteIdentifier(staging)} rename to ${quoteIdentifier(input.table)}`);
          await connection.run("commit");
        } catch (error) {
          await connection.run("rollback");
          throw error;
        }
        return { rows, milliseconds: Math.round(performance.now() - started) };
      } catch (error) {
        await connection.run(`drop table if exists ${quoteIdentifier(staging)}`).catch(() => undefined);
        throw new ValidationError(loadErrorMessage(error));
      }
    }),
  );
}

/** DuckDB's error, first line only, without its internal prefixes. */
export function loadErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split("\n").find((part) => part.trim()) ?? "The file couldn't be loaded.";
  return line.replace(/^(Conversion|Invalid Input|Binder|IO|Parser) Error:\s*/, "").trim();
}

/**
 * Runs SQL that Tohyee itself built on an organisation's analytics data.
 * Never pass SQL a person typed: the connection can write.
 */
export async function queryAnalytics(organisationId: string, sql: string): Promise<Record<string, unknown>[]> {
  return withAnalytics(organisationId, async (connection) => {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjectsJson() as Record<string, unknown>[];
  });
}

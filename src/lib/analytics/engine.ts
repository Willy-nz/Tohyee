import fs from "node:fs";
import path from "node:path";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { ValidationError } from "@/lib/errors";
import { analyticsFilePath } from "@/lib/analytics/paths";

export { analyticsFilePath, analyticsFolder } from "@/lib/analytics/paths";

/**
 * The analytics engine (decisions 353-357): one DuckDB file per organisation
 * in the analytics folder, holding only loaded data. Everything that defines
 * what's loaded lives in the organisation's PostgreSQL database; this file
 * can always be rebuilt by loading again.
 */

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

/**
 * DuckDB is loaded the first time analytics is used, not when the server
 * starts, so a missing or broken DuckDB can never stop the books opening.
 */
async function duckdb(): Promise<typeof import("@duckdb/node-api")> {
  return import("@duckdb/node-api");
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
    instance = duckdb().then(({ DuckDBInstance }) => DuckDBInstance.create(file, { autoinstall_known_extensions: "false" }));
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

/** Turns a file's position inside a folder (with / between folders) into its path, refusing anything outside it. */
export function resolveSourceFile(sourceFolder: string, fileName: string): string {
  if (typeof fileName !== "string" || !fileName.trim() || fileName.includes("\0")) throw new ValidationError("Choose a file.");
  const file = path.resolve(sourceFolder, ...fileName.split("/"));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !isInsideFolder(sourceFolder, file)) {
    throw new ValidationError("That file isn't in this organisation's analytics folder.");
  }
  return file;
}

export type SourceFile = { name: string; sizeBytes: number; modifiedAt: string };

const DATA_FILE = /\.(csv|tsv|txt)$/i;

/** The CSV files in a folder and the folders inside it (three levels), newest first. */
export function listSourceFiles(sourceFolder: string): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (folder: string, prefix: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && depth < 3) walk(full, name, depth + 1);
      else if (entry.isFile() && DATA_FILE.test(entry.name)) {
        const stat = fs.statSync(full);
        found.push({ name, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
      if (found.length >= 500) return;
    }
  };
  walk(sourceFolder, "", 1);
  return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export type InspectedColumn = { source: string; name: string; kind: ColumnKind; detected: string; examples: string[] };

const MONEY_WORDS = /(price|amount|cost|total|sales|revenue|spend|value|fee|gst|tax|net|gross|margin|profit|discount|balance|paid|\$)/i;

/** A table or column name from a heading: "Unit price ($)" becomes unit_price. */
export function columnNameFrom(heading: string, taken: Set<string>): string {
  let name = heading
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  if (!name || !/^[a-z]/.test(name)) name = `column_${name || taken.size + 1}`;
  if (name.startsWith("_tohyee")) name = `x${name}`;
  let unique = name;
  for (let n = 2; taken.has(unique); n += 1) unique = `${name}_${n}`;
  taken.add(unique);
  return unique;
}

/** Suggests how to load a column from DuckDB's guess and its heading. People confirm it (decision 356). */
export function suggestKind(detected: string, heading: string): ColumnKind {
  const type = detected.toUpperCase();
  if (type === "BOOLEAN") return "boolean";
  if (type === "DATE") return "date";
  if (type.startsWith("TIMESTAMP")) return "timestamp";
  if (["BIGINT", "INTEGER", "SMALLINT", "TINYINT", "HUGEINT", "UBIGINT", "UINTEGER"].includes(type)) {
    if (MONEY_WORDS.test(heading)) return "money";
    return /(qty|quantity|units|hours|weight)/i.test(heading) ? "quantity" : "integer";
  }
  if (type === "DOUBLE" || type === "FLOAT" || type.startsWith("DECIMAL")) {
    if (MONEY_WORDS.test(heading)) return "money";
    if (/(qty|quantity|units|hours|weight)/i.test(heading)) return "quantity";
    return "decimal";
  }
  return "text";
}

let scratch: Promise<DuckDBInstance> | null = null;

/**
 * A look at a file before it's set up: its headings, DuckDB's guess at each
 * column's type, a suggested way to load it, and the first rows as text.
 * Uses a scratch in-memory database, never the organisation's file.
 */
export async function inspectCsv(sourceFolder: string, fileName: string, delimiter?: string): Promise<{ columns: InspectedColumn[]; rows: string[][]; delimiter: string }> {
  const file = resolveSourceFile(sourceFolder, fileName);
  if (delimiter !== undefined && delimiter.length !== 1) throw new ValidationError("The separator must be one character.");
  if (!scratch) {
    scratch = duckdb().then(({ DuckDBInstance }) => DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false" }));
    scratch.catch(() => {
      scratch = null;
    });
  }
  const connection = await (await scratch).connect();
  try {
    const options = delimiter ? `, delim = ${quoteString(delimiter)}` : "";
    let sniffed: Record<string, unknown> | undefined;
    try {
      const sniff = await connection.runAndReadAll(`select Delimiter as delimiter from sniff_csv(${quoteString(file)}${options})`);
      sniffed = sniff.getRowObjectsJson()[0] as Record<string, unknown> | undefined;
    } catch (error) {
      throw new ValidationError(`That file couldn't be read as a CSV: ${loadErrorMessage(error)}`);
    }
    const chosen = delimiter ?? (typeof sniffed?.delimiter === "string" && sniffed.delimiter.length === 1 ? sniffed.delimiter : ",");
    const source = `read_csv(${quoteString(file)}, header = true, delim = ${quoteString(chosen)}, sample_size = 20480)`;
    const described = await connection.runAndReadAll(`describe select * from ${source}`);
    const types = described.getRowObjectsJson() as Array<{ column_name: string; column_type: string }>;
    const sample = await connection.runAndReadAll(
      `select * from read_csv(${quoteString(file)}, header = true, delim = ${quoteString(chosen)}, all_varchar = true) limit 20`,
    );
    const rows = (sample.getRows() as unknown[][]).map((row) => row.map((value) => (value === null ? "" : String(value))));
    const taken = new Set<string>();
    const columns = types.map((column, index) => ({
      source: column.column_name,
      name: columnNameFrom(column.column_name, taken),
      kind: suggestKind(column.column_type, column.column_name),
      detected: column.column_type,
      examples: rows.slice(0, 3).map((row) => row[index] ?? ""),
    }));
    return { columns, rows, delimiter: chosen };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`That file couldn't be read as a CSV: ${loadErrorMessage(error)}`);
  } finally {
    connection.closeSync();
  }
}

/** Drops a loaded table (when its source is removed). */
export function dropTable(organisationId: string, table: string): Promise<void> {
  assertTableName(table);
  return serialise(organisationId, () =>
    withAnalytics(organisationId, async (connection) => {
      await connection.run(`drop table if exists ${quoteIdentifier(table)}`);
    }),
  );
}

/** The organisation's loaded tables and their columns (DuckDB's types). */
export async function listTables(organisationId: string): Promise<Map<string, Array<{ name: string; type: string }>>> {
  const fs = await import("node:fs");
  const tables = new Map<string, Array<{ name: string; type: string }>>();
  // No file yet means nothing has been loaded; don't make an empty one.
  if (!fs.existsSync(analyticsFilePath(organisationId))) return tables;
  const rows = await withAnalytics(organisationId, async (connection) => {
    const reader = await connection.runAndReadAll(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema = 'main' and table_name not like '\\_tohyee%' escape '\\' order by table_name, ordinal_position`,
    );
    return reader.getRowObjectsJson() as Array<{ table_name: string; column_name: string; data_type: string }>;
  });
  for (const row of rows) {
    const list = tables.get(row.table_name) ?? [];
    list.push({ name: row.column_name, type: row.data_type });
    tables.set(row.table_name, list);
  }
  return tables;
}

/** Runs a query Tohyee built (with its values as parameters) and returns its rows as text, so decimals stay exact. */
export async function runBuiltQuery(organisationId: string, sql: string, params: unknown[]): Promise<Array<Record<string, string | null>>> {
  return withAnalytics(organisationId, async (connection) => {
    const reader = await connection.runAndReadAll(sql, params as never);
    return (reader.getRowObjectsJson() as Array<Record<string, unknown>>).map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null || value === undefined ? null : String(value)])),
    );
  });
}

/** A table copied into the analytics file: its columns (DuckDB types) and its rows as text. */
export type TableCopy = { name: string; columns: Array<{ name: string; type: string }>; rows: Array<Array<string | null>> };

export const TOHYEE_TABLE_PREFIX = "tohyee_";

/**
 * Replaces every `tohyee_*` table with these (analytics step 2). Each is
 * written to a staging table first; only when all have loaded are they
 * swapped in together, and `tohyee_*` tables not in the set (e.g. the CRM's,
 * once it's off) are dropped. Values go in as text and DuckDB converts them
 * to each column's type, so decimals stay exact.
 */
export function replaceTohyeeTables(organisationId: string, tables: readonly TableCopy[]): Promise<void> {
  for (const table of tables) {
    if (!table.name.startsWith(TOHYEE_TABLE_PREFIX)) throw new ValidationError(`${table.name} isn't a Tohyee table.`);
    assertTableName(table.name);
    for (const column of table.columns) assertTableName(column.name);
  }
  return serialise(organisationId, () =>
    withAnalytics(organisationId, async (connection) => {
      const staging = (name: string) => quoteIdentifier(`_tohyee_load_${name}`);
      try {
        for (const table of tables) {
          await connection.run(`drop table if exists ${staging(table.name)}`);
          await connection.run(
            `create table ${staging(table.name)} (${table.columns.map((column) => `${quoteIdentifier(column.name)} ${column.type}`).join(", ")})`,
          );
          const appender = await connection.createAppender(`_tohyee_load_${table.name}`);
          for (const row of table.rows) {
            for (const value of row) {
              if (value === null || value === undefined) appender.appendNull();
              else appender.appendVarchar(value);
            }
            appender.endRow();
          }
          appender.closeSync();
        }
        const existing = await connection.runAndReadAll(
          `select table_name from information_schema.tables where table_schema = 'main' and starts_with(table_name, 'tohyee_')`,
        );
        const keep = new Set(tables.map((table) => table.name));
        await connection.run("begin transaction");
        try {
          for (const [name] of existing.getRows() as Array<[string]>) {
            if (!keep.has(name)) await connection.run(`drop table ${quoteIdentifier(name)}`);
          }
          for (const table of tables) {
            await connection.run(`drop table if exists ${quoteIdentifier(table.name)}`);
            await connection.run(`alter table ${staging(table.name)} rename to ${quoteIdentifier(table.name)}`);
          }
          await connection.run("commit");
        } catch (error) {
          await connection.run("rollback");
          throw error;
        }
      } catch (error) {
        for (const table of tables) await connection.run(`drop table if exists ${staging(table.name)}`).catch(() => undefined);
        throw new ValidationError(`The books couldn't be copied: ${loadErrorMessage(error)}`);
      }
    }),
  );
}


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { ValidationError } from "@/lib/errors";
import { organisationSourceFolder } from "@/lib/analytics/folders";
import { analyticsFilePath, analyticsWorkFolder } from "@/lib/analytics/paths";
import {
  checkXlsxArchive,
  chooseSheet,
  defaultSheet,
  MAX_XLSX_FILE_BYTES,
  writeXlsxSheetCsv,
  XLSX_LOAD_LIMITS,
  XLSX_MESSAGES,
  xlsxStructure,
} from "@/lib/analytics/xlsx";

export { analyticsFilePath, analyticsFolder, analyticsWorkFolder } from "@/lib/analytics/paths";

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
type Opened = { instance: Promise<DuckDBInstance>; folder: string | null };
const instances = new Map<string, Opened>();

/**
 * The folders DuckDB may read and write: the organisation's source folder and
 * its own work folder. Not the analytics folder: that holds every
 * organisation's file. DuckDB opens its own database file regardless.
 */
function allowedFolders(work: string, folder: string | null): string[] {
  const folders = [work];
  if (folder) {
    folders.push(folder);
    try {
      folders.push(fs.realpathSync(folder));
    } catch {
      // A folder that has gone is checked again when it's used.
    }
  }
  return [...new Set(folders.map((entry) => (entry.endsWith(path.sep) ? entry : entry + path.sep)))];
}

/**
 * How much memory one organisation's DuckDB may use, and how much it may
 * spill to its work folder's `tmp` (issue 150). Without these DuckDB takes
 * most of the server's memory and, when it spills, up to about 90% of the
 * free disk, which PostgreSQL and backups share. Past either limit the query
 * fails instead. Server admins can change them with these settings, as DuckDB
 * sizes ("512MiB", "4GiB").
 */
export const DEFAULT_MEMORY_LIMIT = "1GiB";
export const DEFAULT_TEMP_DIRECTORY_LIMIT = "2GiB";

const DUCKDB_SIZE = /^\d+(\.\d+)?\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i;

function sizeSetting(name: string, fallback: string): string {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  if (DUCKDB_SIZE.test(configured)) return configured;
  console.warn(`[tohyee] ${name} should be a size like 1GiB or 512MiB; using ${fallback}.`);
  return fallback;
}

export function analyticsMemoryLimit(): string {
  return sizeSetting("TOHYEE_ANALYTICS_MEMORY_LIMIT", DEFAULT_MEMORY_LIMIT);
}

export function analyticsTempDirectoryLimit(): string {
  return sizeSetting("TOHYEE_ANALYTICS_TEMP_LIMIT", DEFAULT_TEMP_DIRECTORY_LIMIT);
}

async function open(organisationId: string, file: string, folder: string | null): Promise<DuckDBInstance> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const work = analyticsWorkFolder(organisationId);
  fs.mkdirSync(work, { recursive: true });
  const { DuckDBInstance } = await duckdb();
  // Extensions are never downloaded at run time (the server may be
  // offline, and it's code from the internet).
  const instance = await DuckDBInstance.create(file, { autoinstall_known_extensions: "false" });
  // Defence in depth (decision 377): DuckDB may only touch this
  // organisation's source folder and its own work folder, and the setting
  // can't be changed back, so no query can read other files on the server
  // or another organisation's analytics file.
  const setup = await instance.connect();
  try {
    await setup.run(`set temp_directory = ${quoteString(path.join(work, "tmp"))}`);
    await setup.run(`set memory_limit = ${quoteString(analyticsMemoryLimit())}`);
    await setup.run(`set max_temp_directory_size = ${quoteString(analyticsTempDirectoryLimit())}`);
    const list = allowedFolders(work, folder).map(quoteString).join(", ");
    await setup.run(`set allowed_directories = [${list}]`);
    await setup.run("set enable_external_access = false");
    await setup.run("set lock_configuration = true");
  } finally {
    setup.closeSync();
  }
  return instance;
}

async function instanceFor(organisationId: string, folderHint?: string): Promise<DuckDBInstance> {
  const file = analyticsFilePath(organisationId);
  // The folder can be changed from the server app or the command line too,
  // so it's checked each time; a change reopens the file with the new folder.
  // Without the server's database (the benchmark tool, unit tests) the
  // caller's folder is used, and otherwise none, which is the stricter choice.
  const folder = await organisationSourceFolder(organisationId).catch(() => folderHint ?? null);
  const current = instances.get(file);
  if (current && current.folder === folder) return current.instance;
  if (current) {
    // Not waiting for queued work here: this can be called from inside it.
    // A load running at that moment fails and is tried again.
    instances.delete(file);
    (await current.instance.catch(() => null))?.closeSync();
  }
  const instance = open(organisationId, file, folder);
  instances.set(file, { instance, folder });
  instance.catch(() => {
    if (instances.get(file)?.instance === instance) instances.delete(file);
  });
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

export async function withAnalytics<T>(
  organisationId: string,
  work: (connection: DuckDBConnection) => Promise<T>,
  folderHint?: string,
): Promise<T> {
  const instance = await instanceFor(organisationId, folderHint);
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
  const opened = instances.get(file);
  if (!opened) return;
  instances.delete(file);
  await queues.get(organisationId);
  (await opened.instance).closeSync();
}

/** True when `file` is inside `folder` (after resolving `..` and links). */
export function isInsideFolder(folder: string, file: string): boolean {
  const realFolder = fs.realpathSync(folder);
  const realFile = fs.realpathSync(file);
  const relative = path.relative(realFolder, realFile);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export type CsvLoadResult = { rows: number; milliseconds: number };

/** A sheet copied out of a workbook stops at this size (a 50 MB workbook rarely makes more than a few hundred MB). */
const MAX_XLSX_CSV_BYTES = 1024 * 1024 * 1024;

function validateLoadInput(input: {
  sourceFolder: string;
  file: string;
  table: string;
  columns: readonly LoadColumn[];
}): void {
  assertTableName(input.table);
  if (input.columns.length === 0) throw new ValidationError("Choose at least one column to load.");
  const names = new Set<string>();
  for (const column of input.columns) {
    assertTableName(column.name);
    if (names.has(column.name)) throw new ValidationError(`Two columns are both called ${column.name}.`);
    names.add(column.name);
    if (!Object.hasOwn(COLUMN_TYPES, column.kind)) throw new ValidationError(`Unknown column type for ${column.name}.`);
  }
  if (!fs.existsSync(input.file) || !isInsideFolder(input.sourceFolder, input.file)) {
    throw new ValidationError("That file isn't in this organisation's analytics folder.");
  }
}

async function loadCsvInto(connection: DuckDBConnection, input: {
  file: string;
  table: string;
  columns: readonly LoadColumn[];
  delimiter: string;
  quote?: string;
}): Promise<CsvLoadResult> {
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
        `header = true, all_varchar = true, delim = ${quoteString(input.delimiter)}` +
        (input.quote ? `, quote = ${quoteString(input.quote)}, escape = ${quoteString(input.quote)}` : "") + ")",
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
}

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
  validateLoadInput(input);
  const delimiter = input.delimiter ?? ",";
  if (delimiter.length !== 1) throw new ValidationError("The separator must be one character.");

  return serialise(input.organisationId, () =>
    withAnalytics(input.organisationId, (connection) => loadCsvInto(connection, { ...input, delimiter }), input.sourceFolder),
  );
}

function validateXlsxFile(sourceFolder: string, file: string): void {
  if (!fs.existsSync(file) || !isInsideFolder(sourceFolder, file)) {
    throw new ValidationError("That file isn't in this organisation's analytics folder.");
  }
  const extension = path.extname(file).toLowerCase();
  if (extension === ".xls") throw new ValidationError("Older Excel files (.xls) aren't supported. Open it in Excel and save it as an Excel workbook (.xlsx).");
  if (extension === ".xlsm") throw new ValidationError(XLSX_MESSAGES.macros);
  if (extension !== ".xlsx") throw new ValidationError("Choose an Excel workbook (.xlsx).");
  if (fs.statSync(file).size > MAX_XLSX_FILE_BYTES) throw new ValidationError("Excel workbooks must be 50 MB or smaller.");
}

function validateSheetName(sheetName?: string | null): string | undefined {
  if (sheetName === undefined || sheetName === null || sheetName === "") return undefined;
  if (typeof sheetName !== "string" || sheetName.length > 31 || /[\u0000-\u001f\u007f]/.test(sheetName)) {
    throw new ValidationError("An Excel sheet name must be 1 to 31 characters.");
  }
  return sheetName;
}

/** Checks a workbook and finds its sheets (decision 376). */
async function openXlsx(sourceFolder: string, file: string) {
  validateXlsxFile(sourceFolder, file);
  const checked = await checkXlsxArchive(file, XLSX_LOAD_LIMITS);
  return { checked, structure: await xlsxStructure(checked) };
}

/** Rows read for a preview: enough for DuckDB's type guess (its sample is 20,480 rows). */
const XLSX_PREVIEW_ROWS = 20_481;

/**
 * A look at an Excel sheet, like inspectCsv: its sheets, headings, suggested
 * types and first rows. A sheet that isn't there any more falls back to the
 * first, so setup can carry on.
 */
export async function inspectXlsx(
  sourceFolder: string,
  fileName: string,
  sheetName?: string,
): Promise<Awaited<ReturnType<typeof inspectCsv>> & { sheets: string[]; hiddenSheets: string[]; sheetName: string }> {
  const chosen = validateSheetName(sheetName);
  const file = resolveSourceFile(sourceFolder, fileName);
  const { checked, structure } = await openXlsx(sourceFolder, file);
  const sheet = structure.sheets.find((candidate) => candidate.name === chosen) ?? defaultSheet(structure);
  // The scratch CSV is checked by inspectCsv's own throwaway database, limited to this folder.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-xlsx-"));
  try {
    const csvFile = path.join(folder, "sheet.csv");
    await writeXlsxSheetCsv(file, checked, structure, sheet, csvFile, { maxBytes: MAX_XLSX_CSV_BYTES, maxRows: XLSX_PREVIEW_ROWS });
    const inspected = await inspectCsv(folder, "sheet.csv", ",");
    return {
      ...inspected,
      sheets: structure.sheets.map((candidate) => candidate.name),
      hiddenSheets: structure.sheets.filter((candidate) => candidate.hidden).map((candidate) => candidate.name),
      sheetName: sheet.name,
    };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Temporary sheet copies sit in the organisation's own work folder, the only
 * part of the analytics folder its DuckDB may read (decision 377).
 */
const XLSX_SCRATCH_PREFIX = "xlsx-";

function removeStaleXlsxScratch(workFolder: string): void {
  // Left behind only if the server stopped mid-load.
  const prefix = XLSX_SCRATCH_PREFIX;
  let names: string[] = [];
  try {
    names = fs.readdirSync(workFolder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(workFolder, name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // Gone already.
    }
  }
}

/**
 * Loads one sheet of an Excel workbook into `table` through the same path as
 * a CSV (decision 376): every cell as text, the same explicit casts, the same
 * staging table swapped in only when the whole sheet has loaded.
 */
export async function loadXlsx(input: {
  organisationId: string;
  sourceFolder: string;
  file: string;
  table: string;
  columns: readonly LoadColumn[];
  sheetName?: string | null;
}): Promise<CsvLoadResult> {
  const sheetName = validateSheetName(input.sheetName);
  validateLoadInput(input);
  const { checked, structure } = await openXlsx(input.sourceFolder, input.file);
  const sheet = chooseSheet(structure, sheetName);
  const workFolder = analyticsWorkFolder(input.organisationId);
  return serialise(input.organisationId, async () => {
    fs.mkdirSync(workFolder, { recursive: true });
    removeStaleXlsxScratch(workFolder);
    const folder = fs.mkdtempSync(path.join(workFolder, XLSX_SCRATCH_PREFIX));
    try {
      const csvFile = path.join(folder, "sheet.csv");
      await writeXlsxSheetCsv(input.file, checked, structure, sheet, csvFile, { maxBytes: MAX_XLSX_CSV_BYTES });
      return await withAnalytics(
        input.organisationId,
        (connection) => loadCsvInto(connection, { ...input, file: csvFile, delimiter: ",", quote: '"' }),
        input.sourceFolder,
      );
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
}

/** Looks at a CSV or Excel file for setup. */
export async function inspectSourceFile(
  sourceFolder: string,
  fileName: string,
  delimiter?: string,
  sheetName?: string,
): Promise<Awaited<ReturnType<typeof inspectCsv>> & { sheets?: string[]; hiddenSheets?: string[]; sheetName?: string }> {
  if (isExcelFileName(fileName)) {
    const file = resolveSourceFile(sourceFolder, fileName);
    validateXlsxFile(sourceFolder, file);
    return inspectXlsx(sourceFolder, fileName, sheetName);
  }
  return inspectCsv(sourceFolder, fileName, delimiter);
}

/** .xlsx, and the Excel files that are refused with a reason (.xls, .xlsm). */
export function isExcelFileName(fileName: string): boolean {
  return /\.(xlsx|xlsm|xls)$/i.test(fileName);
}

/** Loads a source's file, CSV or Excel. */
export async function loadSourceFile(input: {
  organisationId: string;
  sourceFolder: string;
  file: string;
  table: string;
  columns: readonly LoadColumn[];
  delimiter?: string;
  sheetName?: string | null;
}): Promise<CsvLoadResult> {
  if (isExcelFileName(input.file)) return loadXlsx(input);
  return loadCsv(input);
}

/** A shaped-table build stopped by its time limit (its message is shown as it is). */
class ShapedBuildStopped extends Error {}

/**
 * Building a shaped table stops after this long (issue 150), so a merge that
 * multiplies rows can't hold the organisation's write queue (and its disk)
 * indefinitely. Server admins can change it with
 * TOHYEE_ANALYTICS_BUILD_SECONDS.
 */
export const DEFAULT_BUILD_TIME_LIMIT_MS = 5 * 60_000;

export function shapedTableBuildTimeLimitMs(): number {
  const seconds = Number.parseInt(process.env.TOHYEE_ANALYTICS_BUILD_SECONDS ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_BUILD_TIME_LIMIT_MS;
}

function describeDuration(milliseconds: number): string {
  if (milliseconds >= 60_000 && milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

export async function replaceTableFromSelect(
  organisationId: string,
  table: string,
  sql: string,
  params: unknown[],
  options: { timeLimitMs?: number } = {},
): Promise<CsvLoadResult> {
  assertTableName(table);
  if (table.startsWith(TOHYEE_TABLE_PREFIX)) throw new ValidationError("Table names starting with tohyee_ are kept for the copy of the books.");
  const timeLimitMs = options.timeLimitMs ?? shapedTableBuildTimeLimitMs();
  return serialise(organisationId, () =>
    withAnalytics(organisationId, async (connection) => {
      const started = performance.now();
      const staging = `_tohyee_shape_${table}`;
      await connection.run(`drop table if exists ${quoteIdentifier(staging)}`);
      try {
        // The same time limit as questions (runBuiltQuery), for the build itself.
        let stopped = false;
        const timer = setTimeout(() => {
          stopped = true;
          connection.interrupt();
        }, timeLimitMs);
        try {
          await connection.runAndReadAll(`create table ${quoteIdentifier(staging)} as ${sql}`, params as never);
        } catch (error) {
          if (stopped) {
            throw new ShapedBuildStopped(
              `The shaped table took more than ${describeDuration(timeLimitMs)} to build, so it was stopped and the last copy kept. ` +
                "Filter or group the data sooner, or merge on columns that match fewer rows.",
            );
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
        const count = await connection.runAndReadAll(`select count(*)::bigint as n from ${quoteIdentifier(staging)}`);
        const rows = Number(count.getRows()[0][0]);
        await connection.run("begin transaction");
        try {
          await connection.run(`drop table if exists ${quoteIdentifier(table)}`);
          await connection.run(`alter table ${quoteIdentifier(staging)} rename to ${quoteIdentifier(table)}`);
          await connection.run("commit");
        } catch (error) {
          await connection.run("rollback");
          throw error;
        }
        return { rows, milliseconds: Math.round(performance.now() - started) };
      } catch (error) {
        await connection.run(`drop table if exists ${quoteIdentifier(staging)}`).catch(() => undefined);
        if (error instanceof ShapedBuildStopped) throw new ValidationError(error.message);
        throw new ValidationError(`The shaped table couldn't be rebuilt: ${loadErrorMessage(error)}`);
      }
    }),
  );
}

/** Previews (shaping) stop after this long. */
export const PREVIEW_TIME_LIMIT_MS = 10_000;

/** Every other question (dashboard tiles, pivots, drill-ins, exports) stops after this long (decision 379). */
export const TILE_TIME_LIMIT_MS = 30_000;

export async function previewSelect(
  organisationId: string,
  sql: string,
  params: unknown[],
): Promise<Array<Record<string, string | null>>> {
  return runBuiltQuery(organisationId, `select * from (${sql}) as preview limit 100`, params, {
    timeLimitMs: PREVIEW_TIME_LIMIT_MS,
    tooLong: "That took too long to preview. Filter or group the data sooner, or use fewer merges.",
  });
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

// .xls and .xlsm are listed so choosing one says why it can't be loaded.
const DATA_FILE = /\.(csv|tsv|txt|xlsx|xlsm|xls)$/i;

/** The CSV and Excel files in a folder and the folders inside it (three levels), newest first. */
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


/**
 * A look at a file before it's set up: its headings, DuckDB's guess at each
 * column's type, a suggested way to load it, and the first rows as text.
 * Uses a scratch in-memory database, never the organisation's file.
 */
export async function inspectCsv(sourceFolder: string, fileName: string, delimiter?: string): Promise<{ columns: InspectedColumn[]; rows: string[][]; delimiter: string }> {
  const file = resolveSourceFile(sourceFolder, fileName);
  if (delimiter !== undefined && delimiter.length !== 1) throw new ValidationError("The separator must be one character.");
  // A throwaway in-memory database that can only read this organisation's folder (decision 377).
  const { DuckDBInstance } = await duckdb();
  const scratch = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false" });
  const connection = await scratch.connect();
  const folders = [sourceFolder, ...(() => { try { return [fs.realpathSync(sourceFolder)]; } catch { return []; } })()]
    .map((entry) => (entry.endsWith(path.sep) ? entry : entry + path.sep));
  await connection.run(`set allowed_directories = [${[...new Set(folders)].map(quoteString).join(", ")}]`);
  await connection.run("set enable_external_access = false");
  await connection.run("set lock_configuration = true");
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
    scratch.closeSync();
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
export async function runBuiltQuery(
  organisationId: string,
  sql: string,
  params: unknown[],
  options: { timeLimitMs?: number; tooLong?: string } = {},
): Promise<Array<Record<string, string | null>>> {
  return withAnalytics(organisationId, async (connection) => {
    // A time limit stops a heavy question (a big tile, or a preview with many merges) tying up the server.
    let stopped = false;
    const timer = setTimeout(() => {
      stopped = true;
      connection.interrupt();
    }, options.timeLimitMs ?? TILE_TIME_LIMIT_MS);
    try {
      const reader = await connection.runAndReadAll(sql, params as never);
      return (reader.getRowObjectsJson() as Array<Record<string, unknown>>).map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null || value === undefined ? null : String(value)])),
      );
    } catch (error) {
      if (stopped) {
        throw new ValidationError(
          options.tooLong ?? "That took more than 30 seconds, so it was stopped. Filter the tile to fewer rows, or group by fewer fields.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
}

/** One row of a copied table, as text. */
export type TableCopyRow = Array<string | null>;

/**
 * A table copied into the analytics file: its columns (DuckDB types) and its
 * rows as text, either all at once or (for big tables such as the ledger
 * lines) as batches read while they're appended, so memory stays bounded.
 */
export type TableCopy = {
  name: string;
  columns: Array<{ name: string; type: string }>;
  rows: TableCopyRow[] | AsyncIterable<TableCopyRow[]>;
};

async function* rowBatches(rows: TableCopy["rows"]): AsyncIterable<TableCopyRow[]> {
  if (Array.isArray(rows)) yield rows;
  else yield* rows;
}

export const TOHYEE_TABLE_PREFIX = "tohyee_";

/**
 * Replaces every `tohyee_*` table with these (analytics step 2). Each is
 * written to a staging table first; only when all have loaded are they
 * swapped in together, and `tohyee_*` tables not in the set (e.g. the CRM's,
 * once it's off) are dropped. Values go in as text and DuckDB converts them
 * to each column's type, so decimals stay exact. Returns how many rows were
 * copied. Batched tables are read as they're appended, so they must still be
 * readable when this runs (inside the read's transaction).
 */
export function replaceTohyeeTables(organisationId: string, tables: readonly TableCopy[]): Promise<number> {
  for (const table of tables) {
    if (!table.name.startsWith(TOHYEE_TABLE_PREFIX)) throw new ValidationError(`${table.name} isn't a Tohyee table.`);
    assertTableName(table.name);
    for (const column of table.columns) assertTableName(column.name);
  }
  return serialise(organisationId, () =>
    withAnalytics(organisationId, async (connection) => {
      const staging = (name: string) => quoteIdentifier(`_tohyee_load_${name}`);
      let copied = 0;
      try {
        for (const table of tables) {
          await connection.run(`drop table if exists ${staging(table.name)}`);
          await connection.run(
            `create table ${staging(table.name)} (${table.columns.map((column) => `${quoteIdentifier(column.name)} ${column.type}`).join(", ")})`,
          );
          const appender = await connection.createAppender(`_tohyee_load_${table.name}`);
          try {
            for await (const batch of rowBatches(table.rows)) {
              for (const row of batch) {
                for (const value of row) {
                  if (value === null || value === undefined) appender.appendNull();
                  else appender.appendVarchar(value);
                }
                appender.endRow();
              }
              copied += batch.length;
              // Each batch goes into the staging table before the next is read.
              appender.flushSync();
            }
            appender.closeSync();
          } catch (error) {
            try {
              appender.closeSync();
            } catch {
              // The first error is the one worth reporting.
            }
            throw error;
          }
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
        return copied;
      } catch (error) {
        for (const table of tables) await connection.run(`drop table if exists ${staging(table.name)}`).catch(() => undefined);
        throw new ValidationError(`The books couldn't be copied: ${loadErrorMessage(error)}`);
      }
    }),
  );
}

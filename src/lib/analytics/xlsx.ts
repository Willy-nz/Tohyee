import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import zlib from "node:zlib";
import yauzl from "yauzl";
import { ValidationError } from "@/lib/errors";

/**
 * Reading Excel workbooks (.xlsx) safely (decision 376).
 *
 * An .xlsx is a ZIP of XML files. It's checked in two steps:
 *
 * 1. Every entry listed in the ZIP's central directory is unpacked and
 *    counted (limits on entries, total size, compression ratio and the size
 *    of the parts that ExcelJS keeps in memory), and the CRC is checked.
 *    Macros, encryption and binary workbooks are refused here.
 * 2. ExcelJS reads ZIP local headers one after another, so it could be shown
 *    entries the central directory doesn't list. It's never given the file:
 *    Tohyee builds a fresh stream of only the parts it needs, unpacks them
 *    itself (stopping at the size the check found) and hands them over
 *    uncompressed.
 */

export const MAX_XLSX_FILE_BYTES = 50 * 1024 * 1024;

export type XlsxLimits = { expandedBytes: number; entries: number; ratio: number };

/** Limits for loading: a 50 MB workbook may unpack to 250 MB of XML. */
export const XLSX_LOAD_LIMITS: XlsxLimits = { expandedBytes: 250 * 1024 * 1024, entries: 2000, ratio: 1000 };

// Parts ExcelJS holds in memory while it reads a sheet, and the parts read to find the sheets.
const SHARED_STRINGS_LIMIT = 64 * 1024 * 1024;
const PART_LIMITS: Record<string, number> = {
  "[content_types].xml": 4 * 1024 * 1024,
  "xl/workbook.xml": 4 * 1024 * 1024,
  "xl/_rels/workbook.xml.rels": 4 * 1024 * 1024,
  "xl/styles.xml": 8 * 1024 * 1024,
  "xl/sharedstrings.xml": SHARED_STRINGS_LIMIT,
};
const KEPT_PARTS = new Set(["[content_types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]);

const CFB_SIGNATURE = Buffer.from("d0cf11e0a1b11ae1", "hex");

export const XLSX_MESSAGES = {
  lockedOrOld:
    "This file is password-protected, or it's an older Excel file (.xls) with an .xlsx name. " +
    "Remove the password or save it as an ordinary Excel workbook (.xlsx), then try again.",
  macros: "Excel files with macros (.xlsm) aren't supported. Save the workbook as an ordinary Excel workbook (.xlsx) without macros.",
  binary: "Binary Excel workbooks (.xlsb) aren't supported. Save the workbook as an ordinary Excel workbook (.xlsx).",
  notWorkbook: "That file isn't an Excel workbook (.xlsx), or it's damaged.",
  unsafe: "The Excel workbook contains unsafe files or unpacks to more than the limit.",
  damaged: "The Excel workbook is damaged.",
} as const;

type ZipEntry = {
  name: string;
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  method: number;
};

export type CheckedXlsx = {
  /** Entries by lower-case name. */
  entries: Map<string, ZipEntry>;
  /** Small parts read during the check, by lower-case name. */
  parts: Map<string, Buffer>;
  /** What the whole workbook unpacks to. */
  expandedBytes: number;
};

function safeEntryName(name: string): boolean {
  if (!name || name.length > 512 || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  const parts = name.split("/");
  if (parts.at(-1) === "") parts.pop();
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function hasCfbSignature(source: string | Buffer): boolean {
  if (Buffer.isBuffer(source)) return source.subarray(0, 8).equals(CFB_SIGNATURE);
  const signature = Buffer.alloc(8);
  const descriptor = fs.openSync(source, "r");
  try {
    fs.readSync(descriptor, signature, 0, signature.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return signature.equals(CFB_SIGNATURE);
}

/**
 * Step 1: checks a workbook (a file or the bytes of an attachment) without
 * trusting any size it states. Throws a ValidationError saying what's wrong.
 */
export async function checkXlsxArchive(source: string | Buffer, limits: XlsxLimits): Promise<CheckedXlsx> {
  // Password-protected workbooks (and old .xls files) are OLE compound files, not ZIPs.
  if (hasCfbSignature(source)) throw new ValidationError(XLSX_MESSAGES.lockedOrOld);
  const options: yauzl.Options = { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: false };
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    const done = (error: Error | null, opened?: yauzl.ZipFile) => {
      if (error || !opened) reject(new ValidationError(XLSX_MESSAGES.notWorkbook));
      else resolve(opened);
    };
    if (Buffer.isBuffer(source)) yauzl.fromBuffer(source, options, done);
    else yauzl.open(source, options, done);
  });
  const entries = new Map<string, ZipEntry>();
  const parts = new Map<string, Buffer>();
  let expandedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const fail = (error?: unknown) => {
      if (done) return;
      done = true;
      zip.close();
      reject(error instanceof ValidationError ? error : new ValidationError(XLSX_MESSAGES.unsafe));
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (done) return;
      done = true;
      zip.close();
      resolve();
    });
    zip.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        if (entry.generalPurposeBitFlag & (1 | 64)) throw new ValidationError(XLSX_MESSAGES.lockedOrOld);
        const key = entry.fileName.normalize("NFC").toLowerCase();
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        const directory = entry.fileName.endsWith("/");
        if (entries.size + 1 > limits.entries || !safeEntryName(entry.fileName) || entries.has(key) ||
            ![0, 8].includes(entry.compressionMethod) ||
            (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) ||
            !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
            (directory && entry.uncompressedSize !== 0) ||
            entry.uncompressedSize > (PART_LIMITS[key] ?? Infinity) ||
            entry.uncompressedSize > Math.max(1, entry.compressedSize) * limits.ratio ||
            expandedBytes + entry.uncompressedSize > limits.expandedBytes) {
          throw new ValidationError(XLSX_MESSAGES.unsafe);
        }
        entries.set(key, {
          name: entry.fileName,
          offset: entry.relativeOffsetOfLocalHeader,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          crc32: entry.crc32,
          method: entry.compressionMethod,
        });
        expandedBytes += entry.uncompressedSize;
        if (!directory) {
          const stream = await new Promise<Readable>((accept, refuse) => {
            zip.openReadStream(entry, (error, content) => (error || !content ? refuse(error) : accept(content)));
          });
          const kept: Buffer[] = [];
          let size = 0;
          let crc = 0;
          try {
            for await (const chunk of stream) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += buffer.length;
              // Counted as it unpacks: a size the ZIP understates can't get past this.
              if (size > entry.uncompressedSize) throw new ValidationError(XLSX_MESSAGES.unsafe);
              crc = zlib.crc32(buffer, crc);
              if (KEPT_PARTS.has(key)) kept.push(buffer);
            }
          } finally {
            stream.destroy();
          }
          if (size !== entry.uncompressedSize || crc !== entry.crc32) throw new ValidationError(XLSX_MESSAGES.damaged);
          if (KEPT_PARTS.has(key)) parts.set(key, Buffer.concat(kept, size));
        }
        if (!done) zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  const names = [...entries.keys()];
  const contentTypes = parts.get("[content_types].xml")?.toString("utf8") ?? "";
  if (names.some((name) => name.endsWith("vbaproject.bin") || name.endsWith("vbaprojectsignature.bin")) ||
      /macroEnabled|vbaProject/i.test(contentTypes)) {
    throw new ValidationError(XLSX_MESSAGES.macros);
  }
  if (entries.has("xl/workbook.bin")) throw new ValidationError(XLSX_MESSAGES.binary);
  if (!parts.has("xl/workbook.xml") || !parts.has("xl/_rels/workbook.xml.rels")) throw new ValidationError(XLSX_MESSAGES.notWorkbook);
  return { entries, parts, expandedBytes };
}

// ---------------------------------------------------------------------------
// Step 2: a clean stream for ExcelJS.

type StreamPart = { name: string; bytes: Buffer } | { name: string; entry: ZipEntry };

function localHeader(name: string, size: number, crc: number): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 name; sizes are in this header
  header.writeUInt16LE(0, 8); // stored: Tohyee has already unpacked it
  header.writeUInt32LE(crc >>> 0, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes]);
}

async function* unpackEntry(handle: fs.promises.FileHandle, entry: ZipEntry): AsyncGenerator<Buffer> {
  const head = Buffer.alloc(30);
  const { bytesRead } = await handle.read(head, 0, 30, entry.offset);
  if (bytesRead !== 30 || head.readUInt32LE(0) !== 0x04034b50) throw new ValidationError(XLSX_MESSAGES.damaged);
  let position = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  let remaining = entry.compressedSize;
  const raw = Readable.from((async function* () {
    while (remaining > 0) {
      const chunk = Buffer.alloc(Math.min(256 * 1024, remaining));
      const read = await handle.read(chunk, 0, chunk.length, position);
      if (read.bytesRead === 0) throw new ValidationError(XLSX_MESSAGES.damaged);
      position += read.bytesRead;
      remaining -= read.bytesRead;
      yield chunk.subarray(0, read.bytesRead);
    }
  })(), { objectMode: false });
  const unpacked = entry.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
  raw.on("error", (error) => unpacked.destroy(error));
  let size = 0;
  let crc = 0;
  try {
    for await (const chunk of unpacked) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      // The file may have changed since it was checked: never pass on more than was checked.
      if (size > entry.uncompressedSize) throw new ValidationError(XLSX_MESSAGES.damaged);
      crc = zlib.crc32(buffer, crc);
      yield buffer;
    }
  } finally {
    unpacked.destroy();
    raw.destroy();
  }
  if (size !== entry.uncompressedSize || crc !== entry.crc32) throw new ValidationError(XLSX_MESSAGES.damaged);
}

function partsStream(file: string | null, parts: StreamPart[]): Readable {
  return Readable.from((async function* () {
    const handle = file ? await fs.promises.open(file, "r") : null;
    try {
      for (const part of parts) {
        if ("bytes" in part) {
          yield localHeader(part.name, part.bytes.length, zlib.crc32(part.bytes));
          yield part.bytes;
        } else {
          if (!handle) throw new ValidationError(XLSX_MESSAGES.damaged);
          yield localHeader(part.name, part.entry.uncompressedSize, part.entry.crc32);
          yield* unpackEntry(handle, part.entry);
        }
      }
      // An empty end-of-archive record, so the reader knows it's finished.
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      yield end;
    } finally {
      await handle?.close();
    }
  })(), { objectMode: false });
}

type ExcelJsWorkbookReader = InstanceType<typeof import("exceljs").stream.xlsx.WorkbookReader>;

async function workbookReader(input: Readable): Promise<ExcelJsWorkbookReader> {
  const ExcelJS = await import("exceljs");
  return new ExcelJS.stream.xlsx.WorkbookReader(input, {
    worksheets: "emit",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "cache",
    entries: "ignore",
  });
}

export type XlsxSheet = { name: string; part: string };
export type XlsxStructure = { sheets: XlsxSheet[]; date1904: boolean; sharedStrings: string | null; styles: string | null };

const RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

function partFromTarget(target: string): string {
  const resolved = target.startsWith("/") ? target.slice(1) : path.posix.normalize(`xl/${target}`);
  return resolved.normalize("NFC").toLowerCase();
}

/** The workbook's worksheets in tab order, and the parts needed to read them. */
export async function xlsxStructure(checked: CheckedXlsx): Promise<XlsxStructure> {
  const reader = await workbookReader(partsStream(null, [
    { name: "xl/workbook.xml", bytes: checked.parts.get("xl/workbook.xml")! },
    { name: "xl/_rels/workbook.xml.rels", bytes: checked.parts.get("xl/_rels/workbook.xml.rels")! },
  ]));
  try {
    for await (const worksheet of reader) void worksheet;
  } catch (error) {
    throw new ValidationError(`That Excel workbook couldn't be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = reader as unknown as {
    model?: { sheets?: Array<{ name?: string; rId?: string }> };
    workbookRels?: Array<{ Id?: string; Type?: string; Target?: string; TargetMode?: string }>;
    properties?: { model?: { date1904?: boolean } };
  };
  const relationships = (parsed.workbookRels ?? []).filter((rel) => rel.TargetMode !== "External" && typeof rel.Target === "string");
  const target = (type: string) => {
    const rel = relationships.find((candidate) => candidate.Type === RELATIONSHIP + type);
    const part = rel ? partFromTarget(rel.Target!) : null;
    return part && checked.entries.has(part) ? part : null;
  };
  const sheets: XlsxSheet[] = [];
  for (const sheet of parsed.model?.sheets ?? []) {
    const rel = relationships.find((candidate) => candidate.Id === sheet.rId);
    // Chart sheets and dialog sheets have no rows to load.
    if (!rel || rel.Type !== RELATIONSHIP + "worksheet" || typeof sheet.name !== "string") continue;
    const part = partFromTarget(rel.Target!);
    if (checked.entries.has(part)) sheets.push({ name: sheet.name, part });
  }
  if (sheets.length === 0) throw new ValidationError("That Excel workbook has no sheets.");
  // Excel writes date1904="1"; other programs may write "true".
  const workbookXml = checked.parts.get("xl/workbook.xml")!.toString("utf8");
  const date1904 = Boolean(parsed.properties?.model?.date1904) ||
    /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(workbookXml);
  return { sheets, date1904, sharedStrings: target("sharedStrings"), styles: target("styles") };
}

// ---------------------------------------------------------------------------
// Cells to text. Every value is written as text and converted by the same
// explicit casts as a CSV (decision 356), so money is never a guessed float.

/** A number as plain decimal text: the shortest text that reads back as the same number, never 1e-7. */
export function excelNumberText(value: number): string {
  if (!Number.isFinite(value)) return "#NUM!";
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = "", exponent] = match;
  const digits = (whole + fraction).replace(/^0+(?=\d)/, "");
  const point = whole.length + Number(exponent);
  let plain: string;
  if (point <= 0) plain = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) plain = digits + "0".repeat(point - digits.length);
  else plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + plain;
}

function isDateFormat(format: string | undefined): boolean {
  if (!format) return false;
  return /[ymdhsb]/i.test(format.replace(/\[[^\]]*]/g, "").replace(/"[^"]*"/g, ""));
}

function hasTime(format: string | undefined): boolean {
  if (!format) return false;
  return /[hs]/i.test(format.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[(?![hms]+\])[^\]]*]/gi, ""));
}

/** Excel's day number as a date (1900 or 1904 date system), as ExcelJS reads plain date cells. */
function excelSerialToDate(serial: number, date1904: boolean): Date {
  return new Date(Math.round((serial - 25569 + (date1904 ? 1462 : 0)) * 86_400_000));
}

function dateText(value: Date, format: string | undefined): string {
  if (Number.isNaN(value.getTime())) return "#NUM!";
  const iso = value.toISOString();
  if (!hasTime(format)) return iso.slice(0, 10);
  return iso.slice(0, 23).replace("T", " ").replace(/\.000$/, "");
}

/** One cell's value as the text a CSV export of it would hold. */
export function excelCellText(value: unknown, format: string | undefined, date1904: boolean): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return excelNumberText(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return dateText(value, format);
  if (typeof value === "object") {
    const cell = value as { richText?: Array<{ text?: unknown }>; formula?: unknown; sharedFormula?: unknown; result?: unknown; text?: unknown; error?: unknown };
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
    if ("formula" in cell || "sharedFormula" in cell || "result" in cell) {
      // A formula: its value as Excel last worked it out. ExcelJS doesn't turn
      // a date-formatted formula's number into a date, so that's done here.
      const result = cell.result;
      if (typeof result === "number") {
        // An error result (#N/A, #DIV/0! ...): ExcelJS keeps only that it wasn't a number.
        if (Number.isNaN(result)) return "#ERROR!";
        if (isDateFormat(format)) return dateText(excelSerialToDate(result, date1904), format);
      }
      return excelCellText(result, format, date1904);
    }
    if ("error" in cell) return String(cell.error ?? "#VALUE!");
    if ("text" in cell) return excelCellText(cell.text, format, date1904);
  }
  return "";
}

function csvField(value: string): string {
  return /[,"\r\n]/.test(value) || value !== value.trim() ? `"${value.replaceAll('"', '""')}"` : value;
}

function columnLetters(column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

const SYNTHETIC_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${RELATIONSHIP}worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const EMPTY_SHARED_STRINGS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>';

function syntheticWorkbook(date1904: boolean): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<workbookPr${date1904 ? ' date1904="1"' : ""}/><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

/** Chooses a sheet by name, or the first (tab order) when none is given. */
export function chooseSheet(structure: XlsxStructure, sheetName?: string): XlsxSheet {
  if (!sheetName) return structure.sheets[0];
  const sheet = structure.sheets.find((candidate) => candidate.name === sheetName);
  if (!sheet) throw new ValidationError(`The sheet "${sheetName}" wasn't found in this Excel workbook.`);
  return sheet;
}

/**
 * Writes one sheet as a CSV file: the first row with a value is the
 * headings, empty rows are skipped, and short rows are padded. A value to
 * the right of the last heading fails, as an extra column in a CSV does.
 */
export async function writeXlsxSheetCsv(
  file: string,
  checked: CheckedXlsx,
  structure: XlsxStructure,
  sheet: XlsxSheet,
  destination: string,
  limits: { maxBytes: number; maxRows?: number },
): Promise<void> {
  const parts: StreamPart[] = [
    { name: "xl/workbook.xml", bytes: Buffer.from(syntheticWorkbook(structure.date1904)) },
    { name: "xl/_rels/workbook.xml.rels", bytes: Buffer.from(SYNTHETIC_RELS) },
  ];
  // Styles and shared strings go before the sheet, so dates are recognised
  // and ExcelJS never has to park the sheet in a temporary file.
  if (structure.styles) parts.push({ name: "xl/styles.xml", entry: checked.entries.get(structure.styles)! });
  parts.push(structure.sharedStrings
    ? { name: "xl/sharedStrings.xml", entry: checked.entries.get(structure.sharedStrings)! }
    : { name: "xl/sharedStrings.xml", bytes: Buffer.from(EMPTY_SHARED_STRINGS) });
  parts.push({ name: "xl/worksheets/sheet1.xml", entry: checked.entries.get(sheet.part)! });
  const input = partsStream(file, parts);
  const reader = await workbookReader(input);
  const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const writing = finished(output);
  let width = -1;
  let rows = 0;
  let bytes = 0;
  try {
    reading: for await (const worksheet of reader) {
      for await (const row of worksheet) {
        const values: string[] = [];
        row.eachCell({ includeEmpty: false }, (cell, column) => {
          let value: unknown = cell.value;
          // ExcelJS leaves a formula's result out of cell.value when it's 0,
          // false or "" (so a total of 0 would load as empty); cell.result keeps it.
          if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
            value = { formula: true, result: cell.result };
          }
          values[column - 1] = excelCellText(value, cell.numFmt, structure.date1904);
        });
        let last = values.length - 1;
        while (last >= 0 && !values[last]) last -= 1;
        if (last < 0) continue; // an empty row
        if (width < 0) {
          width = last + 1;
        } else if (last + 1 > width) {
          throw new ValidationError(
            `Row ${row.number} has a value in column ${columnLetters(last + 1)}, which has no heading. Add a heading or remove the value.`,
          );
        }
        const line = Array.from({ length: width }, (_, index) => csvField(values[index] ?? "")).join(",") + "\r\n";
        bytes += Buffer.byteLength(line);
        if (bytes > limits.maxBytes) throw new ValidationError("That Excel sheet is too large to load.");
        if (!output.write(line)) await once(output, "drain");
        rows += 1;
        if (limits.maxRows !== undefined && rows >= limits.maxRows) break reading;
      }
    }
    output.end();
    await writing;
  } catch (error) {
    output.destroy();
    await writing.catch(() => undefined);
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`That Excel workbook couldn't be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  } finally {
    input.destroy();
  }
  if (width < 0) throw new ValidationError(`The sheet "${sheet.name}" is empty.`);
}

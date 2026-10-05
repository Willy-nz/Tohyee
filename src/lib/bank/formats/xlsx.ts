import { inflateRawSync } from "node:zlib";
import { RowError } from "@/lib/bank/formats/common";

/**
 * A small reader for Excel .xlsx files: the first worksheet's cells as text,
 * row by row. An .xlsx file is a zip of XML files; this reads the zip's
 * central directory, inflates the parts it needs with Node's zlib, and reads
 * shared strings and cell values. Dates stay as Excel serial numbers, which
 * the date reader understands. Formulas give their last calculated value.
 * Older binary .xls files aren't supported.
 */

const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
/** Everything inflated from one file together (#134: a small zip could otherwise unpack many large sheets). */
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** Excel's own limits: column XFD and row 1,048,576. */
const MAX_COLUMNS = 16_384;
/** More rows than any statement or import Tohyee reads (imports stop at 5,000). */
export const MAX_XLSX_ROWS = 100_000;
/** Cells kept in all, so a few rows can't claim the last column each and use up memory. */
const MAX_CELLS = 2_000_000;

type ZipEntry = { method: number; compressedSize: number; size: number; localOffset: number };

/** The zip's parts Tohyee may read, unpacked only when asked for (#134). */
function readZip(bytes: Buffer): (name: string) => Buffer | undefined {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new RowError("This isn't an .xlsx file (it isn't a zip archive). Older .xls files aren't supported: save it as .xlsx or CSV.");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, ZipEntry>();
  for (let entry = 0; entry < count; entry += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new RowError("The .xlsx file is damaged.");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    entries.set(name, { method, compressedSize, size, localOffset });
  }
  let inflated = 0;
  const cache = new Map<string, Buffer>();
  return (name) => {
    const cached = cache.get(name);
    if (cached) return cached;
    const entry = entries.get(name);
    if (!entry) return undefined;
    if (entry.size > MAX_ENTRY_BYTES || inflated + entry.size > MAX_TOTAL_BYTES) throw new RowError("The spreadsheet is too large to import.");
    if (entry.localOffset + 30 > bytes.length) throw new RowError("The .xlsx file is damaged.");
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(start, start + entry.compressedSize);
    let out: Buffer;
    try {
      if (entry.method === 0) out = Buffer.from(data);
      else if (entry.method === 8) out = inflateRawSync(data, { maxOutputLength: Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - inflated) });
      else throw new RowError("The .xlsx file uses a compression method Tohyee can't read.");
    } catch (error) {
      if (error instanceof RowError) throw error;
      // The size in the zip's directory can lie; zlib stops at the limit.
      throw new RowError("The spreadsheet is too large to import, or damaged.");
    }
    inflated += out.length;
    cache.set(name, out);
    return out;
  };
}

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

function textRuns(xml: string): string {
  let out = "";
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += decodeXml(match[1] ?? "");
  }
  return out;
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "A";
  // Excel's last column is XFD (16,384); a longer reference can't be real (#134).
  if (letters.length > 3) throw new RowError("The spreadsheet has a cell past Excel's last column.");
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  if (index > MAX_COLUMNS) throw new RowError("The spreadsheet has a cell past Excel's last column.");
  return index - 1;
}

/** The first worksheet of an .xlsx file as rows of cell text. */
export function readXlsxRows(bytes: Buffer, maxRows = MAX_XLSX_ROWS): string[][] {
  const part = readZip(bytes);
  const workbook = part("xl/workbook.xml")?.toString("utf8");
  const rels = part("xl/_rels/workbook.xml.rels")?.toString("utf8");
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (workbook && rels) {
    const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
    const target = firstSheet
      ? new RegExp(`<Relationship\\b[^>]*\\bId="${firstSheet}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1] ??
        new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstSheet}"`).exec(rels)?.[1]
      : undefined;
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = /^xl\/worksheets\/[^/]+\.xml$/.test(sheetPath) ? part(sheetPath)?.toString("utf8") : undefined;
  if (!sheet) throw new RowError("The spreadsheet has no worksheet Tohyee can read.");
  const shared: string[] = [];
  const sharedXml = part("xl/sharedStrings.xml")?.toString("utf8");
  if (sharedXml) {
    for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(match[1]));
  }
  const rows: string[][] = [];
  let cellsKept = 0;
  // Empty rows are left out at the end anyway, so the row numbers in the file aren't trusted or padded to (#134).
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) throw new RowError(`The spreadsheet has more than ${maxRows.toLocaleString("en-NZ")} rows. Split it into smaller files.`);
    const cells: string[] = [];
    let next = 0;
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1];
      const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
      const column = reference ? columnIndex(reference) : next;
      next = column + 1;
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
      const inner = cellMatch[2] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = textRuns(inner);
      else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
      else if (raw !== undefined && (type === undefined || type === "n") && Number.isFinite(Number(raw))) {
        // Excel keeps numbers as binary floating point: 86.25 can come back as 86.250000000000014.
        value = String(Number(Number(raw).toPrecision(15)));
      } else if (raw !== undefined) value = decodeXml(raw);
      cells[column] = value;
    }
    cellsKept += cells.length;
    if (cellsKept > MAX_CELLS) throw new RowError("The spreadsheet is too large to import.");
    rows.push(Array.from(cells, (cell) => cell ?? ""));
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

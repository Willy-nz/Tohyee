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

function readZip(bytes: Buffer): Map<string, Buffer> {
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
  const files = new Map<string, Buffer>();
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
    if (size > MAX_ENTRY_BYTES) throw new RowError("The spreadsheet is too large to import.");
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(start, start + compressedSize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
    else throw new RowError("The .xlsx file uses a compression method Tohyee can't read.");
  }
  return files;
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
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** The first worksheet of an .xlsx file as rows of cell text. */
export function readXlsxRows(bytes: Buffer): string[][] {
  const files = readZip(bytes);
  const workbook = files.get("xl/workbook.xml")?.toString("utf8");
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (workbook && rels) {
    const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
    const target = firstSheet
      ? new RegExp(`<Relationship\\b[^>]*\\bId="${firstSheet}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1] ??
        new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstSheet}"`).exec(rels)?.[1]
      : undefined;
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = files.get(sheetPath)?.toString("utf8");
  if (!sheet) throw new RowError("The spreadsheet has no worksheet Tohyee can read.");
  const shared: string[] = [];
  const sharedXml = files.get("xl/sharedStrings.xml")?.toString("utf8");
  if (sharedXml) {
    for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(match[1]));
  }
  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(/\br="(\d+)"/.exec(rowMatch[1])?.[1] ?? rows.length + 1);
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
    while (rows.length < rowNumber - 1) rows.push([]);
    rows.push(Array.from(cells, (cell) => cell ?? ""));
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

import { decodeText, type ParsedStatementLine, RowError, type StatementFormat } from "@/lib/bank/formats/common";
import { readCamt053, readMt940, readOfx, readQif } from "@/lib/bank/formats/statements";
import { parseDelimited, readTable, type TableLayout } from "@/lib/bank/formats/table";
import { readXlsxRows } from "@/lib/bank/formats/xlsx";

export type { ParsedStatementLine, StatementFormat } from "@/lib/bank/formats/common";
export { STATEMENT_FORMAT_LABELS } from "@/lib/bank/formats/common";
export { LAYOUT_FIELD_LABELS, LAYOUT_FIELDS, parseLayout, type TableLayout } from "@/lib/bank/formats/table";

/** What a statement file holds: its transactions, anything that couldn't be read, and for tables the columns. */
export type StatementFile = {
  format: StatementFormat;
  lines: ParsedStatementLine[];
  errors: string[];
  closingBalance: { amount: string; date: string | null } | null;
  accountNumber: string | null;
  /** Currencies the file says it's in; empty when it doesn't say (FXB10). */
  currencies: string[];
  /** CSV and Excel only: the column headings, the first rows as text, and the layout used. */
  table: { headers: string[]; sampleRows: string[][]; layout: TableLayout } | null;
};

export const MAX_STATEMENT_FILE_BYTES = 10 * 1024 * 1024;

/** Works out a file's format from its contents first and its name second. */
export function detectFormat(fileName: string, bytes: Buffer): StatementFormat {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return "xlsx";
  const head = decodeText(bytes.subarray(0, 4096));
  if (/OFXHEADER|<OFX>/i.test(head)) return "ofx";
  if (/camt\.053|<BkToCstmrStmt>/i.test(head)) return "camt053";
  if (/^\s*!Type:/im.test(head) || /^\s*!Account/im.test(head)) return "qif";
  if (/^:20:/m.test(head) && /^:6[01][FM]?:/m.test(decodeText(bytes.subarray(0, 65536)))) return "mt940";
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (["ofx", "qfx", "qbo"].includes(extension)) return "ofx";
  if (extension === "qif") return "qif";
  if (["sta", "mt940", "940"].includes(extension)) return "mt940";
  if (extension === "xls") {
    throw new RowError("Older Excel files (.xls) aren't supported. Open it in Excel and save it as .xlsx or CSV.");
  }
  return "csv";
}

/** Reads a statement file. For CSV and Excel, `layout` picks the columns; without one it's worked out. */
export function readStatementFile(fileName: string, bytes: Buffer, layout?: TableLayout | null): StatementFile {
  if (bytes.length === 0) throw new RowError("The file is empty.");
  if (bytes.length > MAX_STATEMENT_FILE_BYTES) throw new RowError("The file is larger than 10 MB. Split it into smaller date ranges.");
  const format = detectFormat(fileName, bytes);
  if (format === "csv" || format === "xlsx") {
    const rows = format === "xlsx" ? readXlsxRows(bytes) : parseDelimited(decodeText(bytes));
    if (rows.length === 0) throw new RowError("The file has no rows.");
    const result = readTable(rows, layout);
    const start = Math.max(result.layout.headerRow + 1, 0);
    return {
      format,
      lines: result.lines,
      errors: result.errors,
      closingBalance: null,
      accountNumber: null,
      currencies: result.currencies,
      table: { headers: result.headers, sampleRows: rows.slice(start, start + 8), layout: result.layout },
    };
  }
  const text = decodeText(bytes);
  const result =
    format === "ofx"
      ? readOfx(text)
      : format === "qif"
        ? readQif(text, layout?.dateOrder)
        : format === "camt053"
          ? readCamt053(text)
          : readMt940(text);
  return { format, ...result, table: null };
}

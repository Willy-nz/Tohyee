import { decodeText, RowError } from "@/lib/bank/formats/common";
import { parseDelimited } from "@/lib/bank/formats/table";
import { readXlsxRows } from "@/lib/bank/formats/xlsx";
import { fromCsvCell } from "@/lib/csv";
import { ValidationError } from "@/lib/errors";
import { findHeaderRow, headingsOf, IMPORT_KINDS, type ImportKind } from "@/lib/import/fields";
import { optionalString, requireOneOf } from "@/lib/validation";

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

export type ImportFile = {
  fileName: string;
  /** Every row of the first sheet, as text. */
  rows: string[][];
  /** Where the headings are (0-based), and what they say. */
  headerRow: number;
  headings: string[];
};

/**
 * Reads a CSV or Excel (.xlsx) file for an import, with the same readers as
 * bank statement files (`@/lib/bank/formats`): CSV in UTF-8 or Windows-1252,
 * the first worksheet of an .xlsx. Nothing is saved; the rows go back to the
 * import screen to be mapped.
 */
export function readImportFile(input: { kind: unknown; fileName: unknown; fileBase64: unknown }): ImportFile {
  const kind = requireOneOf(input.kind, "kind", IMPORT_KINDS) as ImportKind;
  const fileName = optionalString(input.fileName, "fileName", { maxLength: 255 }) ?? "file";
  if (typeof input.fileBase64 !== "string" || input.fileBase64.length === 0) {
    throw new ValidationError("Choose a CSV or Excel file.");
  }
  if (input.fileBase64.length > Math.ceil((MAX_IMPORT_FILE_BYTES * 4) / 3) + 4) {
    throw new ValidationError("The file is larger than 10 MB. Split it into smaller files.");
  }
  const bytes = Buffer.from(input.fileBase64, "base64");
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  let rows: string[][];
  try {
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
      rows = readXlsxRows(bytes);
    } else if (extension === "xls") {
      throw new ValidationError("Older Excel files (.xls) aren't supported. Open it in Excel and save it as .xlsx or CSV.");
    } else {
      rows = parseDelimited(decodeText(bytes), { keepBlankRows: true });
    }
  } catch (error) {
    if (error instanceof RowError) throw new ValidationError(error.message);
    throw error;
  }
  // A cell Tohyee exported with an apostrophe (so it can't run as a formula, #148) comes back without it (IM16).
  rows = rows.map((row) => row.map((cell) => fromCsvCell(cell ?? "")));
  while (rows.length > 0 && !rows[rows.length - 1].some((cell) => cell.trim() !== "")) rows.pop();
  if (rows.length === 0) throw new ValidationError("The file has no rows.");
  if (rows.length > MAX_IMPORT_ROWS + 20) {
    throw new ValidationError(`The file has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.`);
  }
  const headerRow = findHeaderRow(kind, rows);
  return { fileName, rows, headerRow, headings: headingsOf(rows, headerRow) };
}

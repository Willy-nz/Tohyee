import ExcelJS from "exceljs";
import { checkXlsxArchive, type XlsxLimits } from "@/lib/analytics/xlsx";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Files for the AI (examples AIW3, AIW4): people drop in whatever they have,
 * in whatever shape it comes (an agent's spreadsheet, a herd export, a
 * contractor's notes), and the AI reads them and organises what it finds into
 * its own tables. Text files are read as they are; Excel workbooks are read
 * sheet by sheet as CSV. Files are archived, never deleted.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** How much text one read returns; longer files are read in parts with `offset`. */
export const READ_CHUNK = 100_000;

const TEXT_TYPES = /\.(csv|tsv|txt|json|md|xml|tab)$/i;
const EXCEL_TYPES = /\.xlsx$/i;

/**
 * A workbook is checked before it's opened (decision 534), as everywhere else
 * Tohyee reads Excel: no macros, encryption or unsafe parts, and it may unpack
 * to at most 64 MB, because the whole workbook is opened in memory to read
 * every sheet. Bigger workbooks can be saved as CSV instead.
 */
const AI_XLSX_LIMITS: XlsxLimits = { expandedBytes: 64 * 1024 * 1024, entries: 2000, ratio: 1000 };

export type AiFile = { id: string; fileName: string; contentType: string; sizeBytes: number; note: string | null; uploadedByEmail: string; uploadedAt: string };

type Row = { id: string; file_name: string; content_type: string; size_bytes: number; note: string | null; uploaded_by_email: string; uploaded_at: string };

const toFile = (row: Row): AiFile => ({
  id: row.id,
  fileName: row.file_name,
  contentType: row.content_type,
  sizeBytes: row.size_bytes,
  note: row.note,
  uploadedByEmail: row.uploaded_by_email,
  uploadedAt: row.uploaded_at,
});

const COLUMNS = `id::text, file_name, content_type, size_bytes, note, uploaded_by_email,
  to_char(uploaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as uploaded_at`;

export async function listAiFiles(tx: OrgTx): Promise<AiFile[]> {
  const rows = await tx.query<Row>(`select ${COLUMNS} from ai_files where archived_at is null order by id desc limit 500`);
  return rows.rows.map(toFile);
}

/** Adds a file (AIW3): text or Excel, up to 10 MB, sent as base64. */
export async function addAiFile(tx: OrgTx, input: { fileName: unknown; contentBase64: unknown; note?: unknown }): Promise<AiFile> {
  const fileName = requireString(input.fileName, "The file name", { maxLength: 255 }).replace(/[\\/]/g, "_");
  if (!TEXT_TYPES.test(fileName) && !EXCEL_TYPES.test(fileName)) {
    throw new ValidationError("The AI can read CSV, TSV, text, JSON and Excel (.xlsx) files. Save other files as one of those first.");
  }
  if (typeof input.contentBase64 !== "string" || input.contentBase64 === "") throw new ValidationError("The file is empty.");
  const content = Buffer.from(input.contentBase64, "base64");
  if (content.length === 0) throw new ValidationError("The file is empty.");
  if (content.length > MAX_FILE_BYTES) throw new ValidationError("Files can be up to 10 MB.");
  if (EXCEL_TYPES.test(fileName)) await checkXlsxArchive(content, AI_XLSX_LIMITS);
  const note = optionalString(input.note, "note", { maxLength: 1000 });
  const contentType = EXCEL_TYPES.test(fileName) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/plain";
  const row = await tx.query<Row>(
    `insert into ai_files (file_name, content_type, size_bytes, content, note, uploaded_by_email) values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
    [fileName, contentType, content.length, content, note, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "ai_file.added", entityType: "ai_file", entityId: row.rows[0].id, details: { fileName, sizeBytes: content.length } });
  return toFile(row.rows[0]);
}

export async function archiveAiFile(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "fileId");
  const result = await tx.query("update ai_files set archived_at = now() where id = $1 and archived_at is null", [id]);
  if (result.rowCount === 0) throw new NotFoundError("File not found.");
  await writeAuditEvent(tx, { eventType: "ai_file.archived", entityType: "ai_file", entityId: id, details: {} });
}

/** A cell as text for CSV: dates as YYYY-MM-DD, formulas as their result. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
    return "";
  }
  return String(value);
}

const csvCell = (text: string) => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** The file's content as text (AIW4): Excel sheets become "## Sheet: name" then CSV. */
export async function aiFileText(tx: OrgTx, idInput: unknown): Promise<{ file: AiFile; text: string }> {
  const id = requireId(idInput, "fileId");
  const row = (await tx.query<Row & { content: Buffer }>(`select ${COLUMNS}, content from ai_files where id = $1 and archived_at is null`, [id])).rows[0];
  if (!row) throw new NotFoundError("File not found.");
  const file = toFile(row);
  if (!/\.(xlsx|xlsm)$/i.test(file.fileName)) return { file, text: row.content.toString("utf8") };
  // Checked again on reading: files added before the check (and any .xlsm) are refused here if unsafe.
  await checkXlsxArchive(row.content, AI_XLSX_LIMITS);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(row.content as unknown as ArrayBuffer);
  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    parts.push(`## Sheet: ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (sheetRow) => {
      const values = Array.isArray(sheetRow.values) ? sheetRow.values.slice(1) : [];
      parts.push(values.map((value) => csvCell(cellText(value as ExcelJS.CellValue))).join(","));
    });
  });
  return { file, text: parts.join("\n") };
}

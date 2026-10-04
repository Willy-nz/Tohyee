import ExcelJS from "exceljs";
import { ValidationError } from "@/lib/errors";
import { CONTENT_WIDTH, PdfWriter, type Column } from "@/lib/pdf/writer";
import { REPORT_EXPORTS, type ReportExportCell, type ReportExportData, type ReportExportTable } from "@/lib/reports/export-types";

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 40;
/** An analytics pivot (decision 375) can be up to 2,000 value cells wide, plus its row fields. */
const MAX_PIVOT_COLUMNS = 2_005;
const MAX_CELL_LENGTH = 2_000;

export type ReportExportFormat = "csv" | "xlsx" | "pdf";

export function parseReportExport(input: unknown): ReportExportData {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Report export data must be an object.");
  const data = input as Record<string, unknown>;
  if (typeof data.report !== "string" || !REPORT_EXPORTS.includes(data.report as (typeof REPORT_EXPORTS)[number])) {
    throw new ValidationError("Choose a standard report to export.");
  }
  const text = (value: unknown, label: string) => {
    if (typeof value !== "string" || value.length > MAX_CELL_LENGTH) throw new ValidationError(`${label} is too long or isn't text.`);
    return value;
  };
  if (!Array.isArray(data.tables) || data.tables.length > 25) throw new ValidationError("The report has too many tables to export.");
  const maxColumns = data.report === "analytics-pivot" ? MAX_PIVOT_COLUMNS : MAX_COLUMNS;
  let rowCount = 0;
  const tables: ReportExportTable[] = data.tables.map((table, tableIndex) => {
    if (!table || typeof table !== "object" || Array.isArray(table)) throw new ValidationError(`Report table ${tableIndex + 1} is invalid.`);
    const candidate = table as Record<string, unknown>;
    if (!Array.isArray(candidate.columns) || candidate.columns.length === 0 || candidate.columns.length > maxColumns) {
      throw new ValidationError(`Report table ${tableIndex + 1} has too many columns.`);
    }
    if (!Array.isArray(candidate.rows)) throw new ValidationError(`Report table ${tableIndex + 1} has invalid rows.`);
    rowCount += candidate.rows.length;
    if (rowCount > MAX_ROWS) throw new ValidationError("The report has too many rows to export.");
    const columns = candidate.columns.map((column, index) => text(column, `Column ${index + 1}`));
    const rows = candidate.rows.map((row, rowIndex) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new ValidationError(`Report row ${rowIndex + 1} is invalid.`);
      const cells = (row as { cells?: unknown }).cells;
      if (!Array.isArray(cells) || cells.length > columns.length) throw new ValidationError(`Report row ${rowIndex + 1} has too many cells.`);
      return {
        kind: (row as { kind?: unknown }).kind === "section" || (row as { kind?: unknown }).kind === "total" ? (row as { kind: "section" | "total" }).kind : undefined,
        cells: cells.map((cell, cellIndex): ReportExportCell => {
          if (!cell || typeof cell !== "object" || Array.isArray(cell)) throw new ValidationError(`Cell ${cellIndex + 1} in report row ${rowIndex + 1} is invalid.`);
          const value = cell as Record<string, unknown>;
          const result: ReportExportCell = { text: text(value.text, `Cell ${cellIndex + 1}`) };
          if (value.numeric === true) {
            if (typeof value.value !== "string" || !DECIMAL.test(value.value) || !Number.isFinite(Number(value.value))) {
              throw new ValidationError(`Cell ${cellIndex + 1} in report row ${rowIndex + 1} isn't a valid number.`);
            }
            result.value = value.value;
            result.numeric = true;
          }
          return result;
        }),
      };
    });
    return { title: candidate.title == null ? undefined : text(candidate.title, `Table ${tableIndex + 1} heading`), columns, rows };
  });
  const basis = data.basis == null ? null : text(data.basis, "Basis");
  if (!Array.isArray(data.filters) || data.filters.length > 30) throw new ValidationError("The report has too many filters to export.");
  const producedAt = text(data.producedAt, "Produced date");
  if (!Number.isFinite(Date.parse(producedAt))) throw new ValidationError("The produced date isn't valid.");
  return {
    report: data.report as ReportExportData["report"],
    organisationName: text(data.organisationName, "Organisation name"),
    title: text(data.title, "Report name"),
    period: text(data.period, "Period"),
    basis,
    filters: data.filters.map((filter, index) => text(filter, `Filter ${index + 1}`)),
    producedAt,
    tables,
  };
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !DECIMAL.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function headingRows(data: ReportExportData): string[][] {
  return [
    [data.organisationName],
    [data.title],
    ["Period", data.period],
    ...(data.basis ? [["Basis", data.basis]] : []),
    ...data.filters.map((filter) => ["Filter", filter]),
    ["Produced", data.producedAt],
    [],
  ];
}

/**
 * Excel keeps 15 significant digits, so a longer exact value (e.g. a large
 * analytics total) goes in as its decimal text rather than a rounded number.
 */
function fitsExcelNumber(value: string): boolean {
  const digits = value.replace(/^-/, "").replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  return digits.length <= 15;
}

function exportCellValue(cell: ReportExportCell): string {
  return cell.numeric ? cell.value! : cell.text;
}

export function reportCsv(data: ReportExportData): string {
  const rows = [...headingRows(data)];
  for (const table of data.tables) {
    if (table.title) rows.push([table.title]);
    rows.push(table.columns);
    rows.push(...table.rows.map((row) => Array.from({ length: table.columns.length }, (_, index) => exportCellValue(row.cells[index] ?? { text: "" }))));
    rows.push([]);
  }
  return rows.map((row) => `${row.map(csvCell).join(",")}\r\n`).join("");
}

export async function reportXlsx(data: ReportExportData): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Tohyee";
  workbook.subject = data.title;
  workbook.created = new Date(data.producedAt);
  const sheet = workbook.addWorksheet("Report");
  for (const row of headingRows(data)) sheet.addRow(row);
  let headerRow = 1;
  for (const table of data.tables) {
    if (table.title) {
      const title = sheet.addRow([table.title]);
      title.font = { bold: true };
    }
    const header = sheet.addRow(table.columns);
    headerRow = header.number;
    header.font = { bold: true };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2F1ED" } };
    for (const item of table.rows) {
      const row = sheet.addRow(
        Array.from({ length: table.columns.length }, (_, index) => {
          const cell = item.cells[index] ?? { text: "" };
          if (!cell.numeric) return cell.text;
          return fitsExcelNumber(cell.value!) ? Number(cell.value) : cell.value!;
        }),
      );
      if (item.kind === "section" || item.kind === "total") row.font = { bold: true };
      if (item.kind === "total") row.border = { top: { style: "thin", color: { argb: "FF35423D" } } };
      for (const [index, cell] of item.cells.entries()) {
        if (cell.numeric && fitsExcelNumber(cell.value!)) row.getCell(index + 1).numFmt = "#,##0.00;[Red](#,##0.00)";
      }
    }
    sheet.addRow([]);
  }
  const columns = data.tables.flatMap((table) => table.columns);
  sheet.columns = columns.slice(0, Math.max(...data.tables.map((table) => table.columns.length))).map((headerName, index) => ({
    key: `column${index + 1}`,
    width: Math.max(index === 0 ? 24 : 14, Math.min(40, headerName.length + 2)),
  }));
  sheet.views = [{ state: "frozen", ySplit: headerRow }];
  const result = await workbook.xlsx.writeBuffer();
  return result instanceof Uint8Array ? result : new Uint8Array(result);
}

export async function reportPdf(data: ReportExportData): Promise<Uint8Array> {
  const writer = await PdfWriter.create({
    title: data.title,
    author: data.organisationName,
    footer: `${data.organisationName} · ${data.title}`,
  });
  writer.text(data.organisationName, { size: 16, bold: true, gap: 4 });
  writer.text(data.title, { size: 13, bold: true, gap: 3 });
  writer.text(`Period: ${data.period}`);
  if (data.basis) writer.text(`Basis: ${data.basis}`);
  for (const filter of data.filters) writer.text(`Filter: ${filter}`);
  writer.text(`Produced: ${data.producedAt}`, { muted: true, gap: 10 });
  for (const table of data.tables) {
    if (table.title) writer.text(table.title, { size: 11, bold: true, gap: 3 });
    const columns: Column[] = table.columns.map((header, index) => ({
      header,
      width: index === 0 ? 2.5 : 1,
      align: index === 0 ? "left" : "right",
    }));
    const rows = table.rows.map((row) => Array.from({ length: table.columns.length }, (_, index) => row.cells[index]?.text ?? ""));
    writer.table(columns, rows, {
      width: CONTENT_WIDTH,
      rowKinds: table.rows.map((row) => row.kind ?? "normal"),
    });
    writer.space(10);
  }
  return writer.finish();
}

export function reportFileName(data: ReportExportData, format: ReportExportFormat): string {
  return `tohyee-${data.report}.${format}`;
}

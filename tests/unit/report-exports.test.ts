import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { REPORT_EXPORTS, type ReportExportData } from "@/lib/reports/export-types";
import { reportCsv, reportPdf, reportXlsx } from "@/lib/reports/export-files";

const report = (name: ReportExportData["report"]): ReportExportData => ({
  report: name,
  organisationName: "Kōwhai Trust",
  title: "Profit and loss",
  period: "1 Apr 2026 to 30 Apr 2026",
  basis: "Accrual",
  filters: ["Location: Otago"],
  producedAt: "2026-10-03T01:30:00.000Z",
  tables: [
    {
      columns: ["Account", "Amount", "Count"],
      rows: [
        { kind: "section", cells: [{ text: "Trading income" }, { text: "" }, { text: "" }] },
        { cells: [{ text: "4000 · Sales" }, { text: "$1,234.56", value: "1234.56", numeric: true }, { text: "1", value: "1", numeric: true }] },
        { kind: "total", cells: [{ text: "Total trading income" }, { text: "$1,234.56", value: "1234.56", numeric: true }, { text: "1", value: "1", numeric: true }] },
      ],
    },
  ],
});

describe("standard report exports", () => {
  it.each(REPORT_EXPORTS)("%s CSV keeps the report's decimal total", (name) => {
    const csv = reportCsv(report(name));

    expect(csv).toContain("Kōwhai Trust");
    expect(csv).toContain("Location: Otago");
    expect(csv).toContain("4000 · Sales,1234.56");
    expect(csv).toContain("Total trading income,1234.56");
  });

  it("writes decimal money into numeric Excel cells", async () => {
    const bytes = await reportXlsx(report("profit-and-loss"));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet("Report")!;
    const row = sheet.getRows(1, sheet.rowCount)!.find((candidate) => candidate.getCell(1).value === "Total trading income")!;

    expect(row.getCell(2).type).toBe(ExcelJS.ValueType.Number);
    expect(row.getCell(2).value).toBe(1234.56);
    expect(row.getCell(3).type).toBe(ExcelJS.ValueType.Number);
    expect(row.getCell(3).value).toBe(1);
  });

  it("exports an empty report with its heading block", () => {
    const csv = reportCsv({ ...report("profit-and-loss"), tables: [] });

    expect(csv).toContain("Kōwhai Trust");
    expect(csv).toContain("Period,1 Apr 2026 to 30 Apr 2026");
    expect(csv).toContain("Location: Otago");
  });

  it("writes an Excel workbook for an empty report", async () => {
    const bytes = await reportXlsx({ ...report("profit-and-loss"), tables: [] });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    expect(workbook.getWorksheet("Report")?.getCell(1, 1).value).toBe("Kōwhai Trust");
  });

  it("writes PDF reports with the same heading and a readable table", async () => {
    const bytes = await reportPdf(report("profit-and-loss"));

    expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe("%PDF");
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

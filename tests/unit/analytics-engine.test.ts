import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyticsFilePath,
  closeAnalytics,
  loadCsv,
  loadXlsx,
  inspectXlsx,
  queryAnalytics,
  type LoadColumn,
} from "@/lib/analytics/engine";

const ORG = "analytics-test";
let root: string;
let sources: string;

const columns: LoadColumn[] = [
  { source: "order_date", name: "order_date", kind: "date" },
  { source: "Region", name: "region", kind: "text" },
  { source: "qty", name: "quantity", kind: "quantity" },
  { source: "unit price", name: "unit_price", kind: "money" },
];

function writeCsv(name: string, text: string): string {
  const file = path.join(sources, name);
  fs.writeFileSync(file, text);
  return file;
}

async function writeXlsx(name: string, worksheets: Array<{ name: string; rows: unknown[][] }>): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of worksheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) worksheet.addRow(row);
    worksheet.getColumn(1).numFmt = "yyyy-mm-dd";
  }
  const file = path.join(sources, name);
  await workbook.xlsx.writeFile(file);
  return file;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-analytics-"));
  sources = path.join(root, "sources");
  fs.mkdirSync(sources);
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("analytics engine (decisions 354-358)", () => {
  it("keeps each organisation's data in its own file in the analytics folder", () => {
    expect(analyticsFilePath(ORG)).toBe(path.join(root, "data", `${ORG}.duckdb`));
    expect(() => analyticsFilePath("../other")).toThrow();
  });

  it("loads money as exact decimals, never floating-point numbers", async () => {
    // 0.1 + 0.2 is the classic floating-point trap.
    const file = writeCsv(
      "sales.csv",
      "order_date,Region,qty,unit price,ignored\n2026-01-05,Otago,1,0.10,x\n2026-01-06,Otago,1,0.20,y\n2026-01-07, Canterbury ,2.5,19.99,z\n",
    );
    const result = await loadCsv({ organisationId: ORG, sourceFolder: sources, file, table: "sales", columns });
    expect(result.rows).toBe(3);

    const rows = await queryAnalytics(
      ORG,
      `select region, sum(quantity * unit_price)::varchar as total, typeof(sum(unit_price)) as type
       from sales group by region order by region`,
    );
    expect(rows).toEqual([
      { region: "Canterbury", total: "49.975000", type: "DECIMAL(38,2)" },
      { region: "Otago", total: "0.300000", type: "DECIMAL(38,2)" },
    ]);
    const described = await queryAnalytics(ORG, "select column_name, column_type from (describe sales)");
    expect(described.map((row) => row.column_name)).toEqual(["order_date", "region", "quantity", "unit_price"]);
    expect(described.find((row) => row.column_name === "order_date")?.column_type).toBe("DATE");
  });

  it("leaves yesterday's table in place when a load fails (decision 357)", async () => {
    const bad = writeCsv("bad.csv", "order_date,Region,qty,unit price\n2026-02-01,Otago,1,12.50\nnot a date,Otago,1,3.00\n");
    await expect(
      loadCsv({ organisationId: ORG, sourceFolder: sources, file: bad, table: "sales", columns }),
    ).rejects.toThrow(/not a date/);
    const rows = await queryAnalytics(ORG, "select count(*)::int as n from sales");
    expect(rows).toEqual([{ n: 3 }]);
    const tables = await queryAnalytics(ORG, "select table_name from information_schema.tables order by 1");
    expect(tables).toEqual([{ table_name: "sales" }]);
  });

  it("refuses a file missing a chosen column", async () => {
    const file = writeCsv("short.csv", "order_date,Region\n2026-02-01,Otago\n");
    await expect(
      loadCsv({ organisationId: ORG, sourceFolder: sources, file, table: "sales", columns }),
    ).rejects.toThrow(/qty/);
  });

  it("only reads files inside the organisation's folder (decision 358)", async () => {
    const outside = path.join(root, "secret.csv");
    fs.writeFileSync(outside, "order_date,Region,qty,unit price\n");
    for (const file of [outside, path.join(sources, "..", "secret.csv")]) {
      await expect(
        loadCsv({ organisationId: ORG, sourceFolder: sources, file, table: "sales", columns }),
      ).rejects.toThrow(/analytics folder/);
    }
  });

  it("previews sheets and loads the chosen Excel sheet with dates and exact money", async () => {
    const file = await writeXlsx("sales.xlsx", [
      {
        name: "First",
        rows: [
          ["Order date", "Region", "Unit price"],
          [new Date("2026-01-05T00:00:00.000Z"), "Otago", 0.1],
          [new Date("2026-01-06T00:00:00.000Z"), "Otago", 0.2],
          [new Date("2026-01-07T00:00:00.000Z"), "Otago", 0.30000000000000004],
        ],
      },
      {
        name: "Second",
        rows: [
          ["Order date", "Region", "Unit price"],
          [new Date("2026-02-01T00:00:00.000Z"), "Canterbury", 1.25],
        ],
      },
    ]);

    const preview = await inspectXlsx(sources, "sales.xlsx", "Second");
    expect(preview.sheets).toEqual(["First", "Second"]);
    expect(preview.sheetName).toBe("Second");
    expect(preview.rows[0]).toEqual(["2026-02-01", "Canterbury", "1.25"]);
    expect(preview.columns.map((column) => [column.name, column.kind])).toEqual([
      ["order_date", "date"],
      ["region", "text"],
      ["unit_price", "money"],
    ]);
    expect((await inspectXlsx(sources, "sales.xlsx", "Removed sheet")).sheetName).toBe("First");

    await loadXlsx({
      organisationId: ORG,
      sourceFolder: sources,
      file,
      table: "xlsx_sales",
      columns: [
        { source: "Order date", name: "order_date", kind: "date" },
        { source: "Region", name: "region", kind: "text" },
        { source: "Unit price", name: "unit_price", kind: "money" },
      ],
      sheetName: "First",
    });
    expect(await queryAnalytics(ORG, "select order_date::varchar as day, sum(unit_price)::varchar as total from xlsx_sales group by 1 order by 1")).toEqual([
      { day: "2026-01-05", total: "0.10" },
      { day: "2026-01-06", total: "0.20" },
      { day: "2026-01-07", total: "0.30" },
    ]);
    expect(await queryAnalytics(ORG, "select sum(unit_price)::varchar as total from xlsx_sales")).toEqual([{ total: "0.60" }]);

    const invalid = await writeXlsx("bad-sales.xlsx", [{
      name: "Bad",
      rows: [["Order date", "Region", "Unit price"], ["not a date", "Otago", 5]],
    }]);
    await expect(loadXlsx({
      organisationId: ORG,
      sourceFolder: sources,
      file: invalid,
      table: "xlsx_sales",
      columns: [
        { source: "Order date", name: "order_date", kind: "date" },
        { source: "Region", name: "region", kind: "text" },
        { source: "Unit price", name: "unit_price", kind: "money" },
      ],
    })).rejects.toThrow(/not a date/);
    expect(await queryAnalytics(ORG, "select sum(unit_price)::varchar as total from xlsx_sales")).toEqual([{ total: "0.60" }]);

    await loadXlsx({
      organisationId: ORG,
      sourceFolder: sources,
      file,
      table: "xlsx_default",
      columns: [
        { source: "Order date", name: "order_date", kind: "date" },
        { source: "Region", name: "region", kind: "text" },
        { source: "Unit price", name: "unit_price", kind: "money" },
      ],
    });
    expect(await queryAnalytics(ORG, "select region, count(*)::int as n from xlsx_default group by 1")).toEqual([{ region: "Otago", n: 3 }]);
  });

  it.each([
    ["old.xls", Buffer.from("not an Excel workbook"), /\.xls\b/i],
    ["macros.xlsm", Buffer.from("not an Excel workbook"), /\.xlsm\b/i],
    ["locked.xlsx", Buffer.from("d0cf11e0a1b11ae1", "hex"), /password-protected/i],
  ])("refuses unsupported Excel file %s", async (name, contents, message) => {
    const file = path.join(sources, name);
    fs.writeFileSync(file, contents);
    await expect(loadXlsx({
      organisationId: ORG,
      sourceFolder: sources,
      file,
      table: "xlsx_refused",
      columns: [{ source: "value", name: "value", kind: "text" }],
    })).rejects.toThrow(message);
  });

  it("refuses Excel workbooks larger than 50 MB before reading them", async () => {
    const file = path.join(sources, "too-large.xlsx");
    const descriptor = fs.openSync(file, "w");
    try {
      fs.ftruncateSync(descriptor, 50 * 1024 * 1024 + 1);
    } finally {
      fs.closeSync(descriptor);
    }
    await expect(loadXlsx({
      organisationId: ORG,
      sourceFolder: sources,
      file,
      table: "xlsx_too_large",
      columns: [{ source: "value", name: "value", kind: "text" }],
    })).rejects.toThrow(/50 MB/);
  });

  it("refuses table and column names that could be read as SQL", async () => {
    const file = writeCsv("ok.csv", "a\n1\n");
    for (const table of ['sales"; drop table sales; --', "Sales", "_tohyee_x", ""]) {
      await expect(
        loadCsv({ organisationId: ORG, sourceFolder: sources, file, table, columns: [{ source: "a", name: "a", kind: "integer" }] }),
      ).rejects.toThrow(/table name/);
    }
  });
});

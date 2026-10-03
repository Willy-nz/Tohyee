import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyticsFilePath,
  closeAnalytics,
  loadCsv,
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

  it("refuses table and column names that could be read as SQL", async () => {
    const file = writeCsv("ok.csv", "a\n1\n");
    for (const table of ['sales"; drop table sales; --', "Sales", "_tohyee_x", ""]) {
      await expect(
        loadCsv({ organisationId: ORG, sourceFolder: sources, file, table, columns: [{ source: "a", name: "a", kind: "integer" }] }),
      ).rejects.toThrow(/table name/);
    }
  });
});

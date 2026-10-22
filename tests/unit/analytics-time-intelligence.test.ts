import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTile } from "@/lib/analytics/dashboards";
import { closeAnalytics, listTables, loadCsv } from "@/lib/analytics/engine";
import { parseTileQuery } from "@/lib/analytics/query";
import { describePeriod, periodRange } from "@/lib/analytics/time-intelligence";

/** Time intelligence (#376 phase 4, decision 771; examples TI1-TI8). Made-up data. */

const ORG = "time-intelligence-test";
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-time-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  const folder = path.join(root, "src");
  fs.mkdirSync(folder);
  const file = path.join(folder, "sales.csv");
  fs.writeFileSync(
    file,
    [
      "date,region,amount",
      "2024-02-29,North,10.00",
      "2025-03-15,North,100.00",
      "2025-04-10,North,200.00",
      "2025-06-30,South,50.00",
      "2025-07-01,North,70.00",
      "2025-10-29,South,30.00",
      "2026-02-28,North,40.00",
      "2026-04-05,South,300.00",
      "2026-05-20,North,60.00",
      "2026-10-15,North,25.00",
      "2027-02-28,North,8.00",
      "2028-02-29,North,5.00",
    ].join("\n") + "\n",
  );
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file,
    table: "sales",
    columns: [
      { source: "date", name: "sale_date", kind: "date" },
      { source: "region", name: "region", kind: "text" },
      { source: "amount", name: "amount", kind: "money" },
    ] as never,
  });
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

const sales = { label: "Sales", aggregate: "sum", field: "amount" };
const total = (measures: unknown[], extra: Record<string, unknown> = {}) => ({
  table: "sales",
  groupBy: null,
  measures,
  filters: [],
  dateField: "sale_date",
  sort: { by: "category", direction: "asc" },
  limit: null,
  ...extra,
});
const march = { today: "2026-10-22", yearEndMonth: 3 };
const rows = (result: Awaited<ReturnType<typeof runTile>>) => result.rows.map((row) => [row.category, row.m0]);

describe("TI1: year, quarter and month to date as at the To date", () => {
  it("with a 31 March balance date, whatever the From date", async () => {
    const result = await runTile(
      ORG,
      total([
        { ...sales, label: "YTD", period: "ytd" },
        { ...sales, label: "QTD", period: "qtd" },
        { ...sales, label: "MTD", period: "mtd" },
        { ...sales, label: "Last 12 months", period: "rolling_12" },
        { ...sales, label: "In the dates" },
      ]),
      { from: "2026-10-01", to: "2026-10-22", dates: march },
    );
    // FY2027 from 1 April 2026: 300 + 60 + 25; Q3 from 1 October; 12 months from 1 November 2025: 40 + 300 + 60 + 25.
    expect(result.rows[0]).toMatchObject({ m0: "385.00", m1: "25.00", m2: "25.00", m3: "425.00", m4: "25.00" });
  });

  it("uses today when the dashboard has no To date", async () => {
    const result = await runTile(ORG, total([{ ...sales, period: "ytd" }]), { dates: march });
    expect(result.rows[0].m0).toBe("385.00");
  });

  it("follows a 30 June balance date", async () => {
    const result = await runTile(ORG, total([{ ...sales, period: "ytd", compare: "previous_year" }]), { to: "2026-10-22", dates: { today: "2026-10-22", yearEndMonth: 6 } });
    // FY2027 from 1 July 2026: 25.00; a year before, 1 July to 22 October 2025: 70.00 (29 October is after 22 October).
    expect(result.rows[0]).toMatchObject({ m0: "25.00", m0_py: "70.00" });
  });
});

describe("TI2: same period last year", () => {
  it("is the year to date a year before, to the same day", async () => {
    const result = await runTile(ORG, total([{ ...sales, period: "ytd", compare: "previous_year" }]), { to: "2026-10-22", dates: march });
    // 1 April to 22 October 2025: 200 + 50 + 70 (30.00 on 29 October is after 22 October).
    expect(result.rows[0]).toMatchObject({ m0: "385.00", m0_py: "320.00" });
    expect(result.columns.map((column) => column.label)).toEqual(["Sales", "Sales last year"]);
  });

  it("is blank, not 0, when last year has no rows (a first, partial year)", async () => {
    const result = await runTile(ORG, total([{ ...sales, period: "ytd", compare: "previous_year" }]), { to: "2025-06-30", dates: march });
    expect(result.rows[0]).toMatchObject({ m0: "250.00", m0_py: null });
  });

  it("goes from 29 February to 28 February", async () => {
    const result = await runTile(
      ORG,
      total([
        { ...sales, period: "ytd", compare: "previous_year" },
        { ...sales, label: "Last 12 months", period: "rolling_12" },
      ]),
      { to: "2028-02-29", dates: march },
    );
    // FY2028 from 1 April 2027: 5.00; a year before, 1 April 2026 to 28 February 2027: 300 + 60 + 25 + 8; 12 months from 1 March 2027: 5.00.
    expect(result.rows[0]).toMatchObject({ m0: "5.00", m0_py: "393.00", m1: "5.00" });
    expect(periodRange("rolling_12", "2028-02-29", 3)).toEqual({ from: "2027-03-01", to: "2028-02-29" });
  });
});

describe("TI3: groups that aren't dates", () => {
  it("works each group's year to date out, with last year beside it", async () => {
    const result = await runTile(
      ORG,
      total([{ ...sales, period: "ytd", compare: "previous_year" }], { groupBy: { field: "region" } }),
      { from: "2026-10-01", to: "2026-10-22", dates: march },
    );
    expect(result.rows).toEqual([
      { category: "North", m0: "85.00", m0_py: "270.00" },
      { category: "South", m0: "300.00", m0_py: "50.00" },
    ]);
  });
});

describe("TI4: a chart by month", () => {
  it("shows each month's year to date, counting months before the From date, and starts again each financial year", async () => {
    const result = await runTile(
      ORG,
      total([{ ...sales, period: "ytd" }, { ...sales, label: "Month" }], { groupBy: { field: "sale_date", grain: "month" } }),
      { from: "2025-06-15", to: "2026-05-31", dates: march },
    );
    expect(result.rows.map((row) => [row.category, row.m0, row.m1])).toEqual([
      // June's year to date has April; the month itself only its rows from 15 June.
      ["2025-06-01", "250.00", "50.00"],
      ["2025-07-01", "320.00", "70.00"],
      ["2025-10-01", "350.00", "30.00"],
      ["2026-02-01", "390.00", "40.00"],
      ["2026-04-01", "300.00", "300.00"],
      ["2026-05-01", "360.00", "60.00"],
    ]);
  });

  it("shows quarter to date by financial quarter", async () => {
    const result = await runTile(ORG, total([{ ...sales, period: "qtd" }], { groupBy: { field: "sale_date", grain: "month" } }), { from: "2025-04-01", to: "2025-10-31", dates: march });
    expect(rows(result)).toEqual([
      ["2025-04-01", "200.00"],
      ["2025-06-01", "250.00"],
      ["2025-07-01", "70.00"],
      ["2025-10-01", "30.00"],
    ]);
  });

  it("shows the last 12 calendar months at each month", async () => {
    const result = await runTile(ORG, total([{ ...sales, period: "rolling_12" }], { groupBy: { field: "sale_date", grain: "month" } }), { from: "2026-02-01", to: "2026-04-30", dates: march });
    // February 2026: March 2025 to February 2026 (100 + 200 + 50 + 70 + 30 + 40); April: May 2025 to April 2026 (50 + 70 + 30 + 40 + 300).
    expect(rows(result)).toEqual([
      ["2026-02-01", "490.00"],
      ["2026-04-01", "490.00"],
    ]);
  });

  it("totals a table as the year to date at the To date", async () => {
    const result = await runTile(ORG, total([{ ...sales, period: "ytd" }], { groupBy: { field: "sale_date", grain: "month" } }), { from: "2026-04-01", to: "2026-10-22", dates: march }, { totals: true });
    expect(result.totals?.m0).toBe("385.00");
  });

  it("works a formula out from the years to date of what it names", async () => {
    const result = await runTile(
      ORG,
      total(
        [
          { label: "Share", aggregate: "formula", formula: "[North] / [All]", period: "ytd", inputs: [{ name: "North", ...sales, where: [{ field: "region", op: "eq", value: "North" }] }, { name: "All", ...sales }] },
        ],
        { groupBy: { field: "sale_date", grain: "month" } },
      ),
      { from: "2025-06-01", to: "2025-06-30", dates: march },
    );
    // To June 2025: North 200 of 250.
    expect(rows(result)).toEqual([["2025-06-01", "0.800000"]]);
  });
});

describe("TI5: what's refused", () => {
  it("explains what can't be worked out", async () => {
    const tables = await listTables(ORG);
    const byMonth = { groupBy: { field: "sale_date", grain: "month" } };
    expect(() => parseTileQuery(total([{ ...sales, period: "mtd" }], byMonth), tables)).toThrow(/shorter period/);
    expect(() => parseTileQuery(total([{ ...sales, period: "ytd", compare: "previous_year" }], byMonth), tables)).toThrow(/can't also compare/);
    expect(() => parseTileQuery(total([{ label: "Average", aggregate: "avg", field: "amount", period: "ytd" }], byMonth), tables)).toThrow(/only works for a total or a count/);
    expect(() => parseTileQuery(total([{ ...sales, asAt: true, period: "ytd" }]), tables)).toThrow(/already as at its date/);
    expect(() => parseTileQuery(total([{ ...sales, period: "ytd" }], { dateField: null }), tables)).toThrow(/needs a date/);
    expect(() => parseTileQuery(total([{ ...sales, period: "ytd", quick: "rank" }], { groupBy: { field: "region" } }), tables)).toThrow(/not both/);
    expect(() => parseTileQuery(total([{ ...sales, period: "decade" }]), tables)).toThrow(/choose year, quarter or month/);
    expect(parseTileQuery(total([{ label: "Average", aggregate: "avg", field: "amount", period: "ytd" }]), tables).measures[0].period).toBe("ytd");
  });

  it("says what it means", () => {
    expect(describePeriod("ytd", { grouped: false, dated: false })).toMatch(/balance date/);
    expect(describePeriod("ytd", { grouped: false, dated: true })).toMatch(/starts again from nothing/);
  });
});

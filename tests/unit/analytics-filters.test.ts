import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTile } from "@/lib/analytics/dashboards";
import { closeAnalytics, replaceTableFromSelect } from "@/lib/analytics/engine";
import { changeFilter, filterComplete, opsFor } from "@/lib/analytics/filters";
import type { DashboardFilters, Filter, QueryDates } from "@/lib/analytics/query";

/** Made-up ledger lines for a made-up organisation (decision 578's examples). */
const ROWS = [
  ["2025-03-31", "revenue", "-100.00", "Old year sale"],
  ["2025-04-01", "revenue", "-1000.00", "Sale"],
  ["2025-12-15", "expense", "300.00", null],
  ["2026-03-31", "asset", "500.00", ""],
  ["2026-04-01", "liability", "-200.00", "  "],
  ["2026-08-31", "equity", "-50.00", "Drawings"],
  ["2026-09-21", "revenue", "-400.00", "Spring sale"],
  ["2026-10-14", "expense", "120.00", "Fuel"],
  ["2026-10-20", "expense", "80.00", "Repairs"],
  [null, "expense", "7.00", "Undated"],
];

const ORG = "filters-test";
let root: string;
/** 20 October 2026, with a 31 March balance date. */
const DATES: QueryDates = { today: "2026-10-20", yearEndMonth: 3 };

function total(filters: Filter[], dates: DashboardFilters["dates"] = DATES) {
  return runTile(
    ORG,
    {
      table: "ledger",
      groupBy: null,
      measures: [
        { label: "Amount", aggregate: "sum", field: "amount" },
        { label: "Lines", aggregate: "count" },
      ],
      filters,
      dateField: null,
      sort: { by: "category", direction: "asc" },
      limit: null,
    },
    { dates },
  ).then((result) => [result.rows[0].m0, result.rows[0].m1]);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-filters-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  const values = ROWS.map(([date, accountClass, amount, note]) =>
    `(${date ? `DATE '${date}'` : "null::DATE"}, '${accountClass}', ${amount}::DECIMAL(18,2), ${note === null ? "null::VARCHAR" : `'${note}'`})`,
  ).join(", ");
  await replaceTableFromSelect(ORG, "ledger", `select * from (values ${values}) as t(posting_date, account_class, amount, note)`, []);
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("tile filters (decision 578)", () => {
  it("is one of / is not one of: net profit is revenue and expense lines", async () => {
    // One filter instead of three "is not" filters (#332).
    expect(await total([{ field: "account_class", op: "not_in", value: ["asset", "liability", "equity"] }])).toEqual(["-993.00", "7"]);
    expect(await total([{ field: "account_class", op: "in", value: ["revenue", "expense"] }])).toEqual(["-993.00", "7"]);
    expect(await total([{ field: "amount", op: "in", value: ["80", "120.00"] }])).toEqual(["200.00", "2"]);
  });

  it("is blank / is not blank: empty and space-only text count as blank", async () => {
    expect(await total([{ field: "note", op: "blank", value: "" }])).toEqual(["600.00", "3"]);
    expect(await total([{ field: "note", op: "not_blank", value: "" }])).toEqual(["-1343.00", "7"]);
    expect(await total([{ field: "posting_date", op: "blank", value: "" }])).toEqual(["7.00", "1"]);
  });

  it("between includes both ends, for dates and numbers", async () => {
    expect(await total([{ field: "posting_date", op: "between", value: ["2026-04-01", "2026-09-21"] }])).toEqual(["-650.00", "3"]);
    expect(await total([{ field: "amount", op: "between", value: ["80", "300"] }])).toEqual(["500.00", "3"]);
    await expect(total([{ field: "amount", op: "between", value: ["300", "80"] }])).rejects.toThrow(/first value is after the second/);
    await expect(total([{ field: "amount", op: "between", value: ["80", ""] }])).rejects.toThrow(/both ends/);
  });

  it("in the last N days counts today; in the last N months is this month and the whole months before", async () => {
    // 21 Sep to 20 Oct 2026.
    expect(await total([{ field: "posting_date", op: "last_days", value: "30" }])).toEqual(["-200.00", "3"]);
    expect(await total([{ field: "posting_date", op: "last_days", value: "1" }])).toEqual(["80.00", "1"]);
    // 1 Aug to 20 Oct 2026.
    expect(await total([{ field: "posting_date", op: "last_months", value: "3" }])).toEqual(["-250.00", "4"]);
    await expect(total([{ field: "posting_date", op: "last_days", value: "0" }])).rejects.toThrow(/whole number from 1 to 3660/);
    await expect(total([{ field: "posting_date", op: "last_months", value: "121" }])).rejects.toThrow(/whole number from 1 to 120/);
  });

  it("this and last financial year follow the balance date", async () => {
    // 1 Apr 2026 to 31 Mar 2027.
    expect(await total([{ field: "posting_date", op: "this_financial_year", value: "" }])).toEqual(["-450.00", "5"]);
    // 1 Apr 2025 to 31 Mar 2026.
    expect(await total([{ field: "posting_date", op: "last_financial_year", value: "" }])).toEqual(["-200.00", "3"]);
    // A 31 August balance date: 1 Sep 2026 to 31 Aug 2027, and 1 Sep 2025 to 31 Aug 2026.
    expect(await total([{ field: "posting_date", op: "this_financial_year", value: "" }], { today: DATES.today, yearEndMonth: 8 })).toEqual(["-200.00", "3"]);
    expect(await total([{ field: "posting_date", op: "last_financial_year", value: "" }], { today: DATES.today, yearEndMonth: 8 })).toEqual(["550.00", "4"]);
  });

  it("joins filters marked or into a group, and groups with and", async () => {
    // (revenue or expense) and on or after 1 Oct 2026.
    const filters: Filter[] = [
      { field: "account_class", op: "eq", value: "revenue" },
      { field: "account_class", op: "eq", value: "expense", join: "or" },
      { field: "posting_date", op: "gte", value: "2026-10-01" },
    ];
    expect(await total(filters)).toEqual(["200.00", "2"]);
    // Without the or, both classes can't match at once.
    expect(await total(filters.map((filter) => ({ ...filter, join: undefined })))).toEqual([null, "0"]);
    // "Is not one of" leaves blank notes out, like "is not"; "or is blank" keeps them.
    expect(await total([{ field: "note", op: "not_in", value: ["Sale"] }])).toEqual(["-43.00", "8"]);
    expect(
      await total([
        { field: "note", op: "not_in", value: ["Sale"] },
        { field: "note", op: "blank", value: "", join: "or" },
      ]),
    ).toEqual(["257.00", "9"]);
  });

  it("refuses a test that doesn't fit the column, but keeps the first tests working on any column", async () => {
    await expect(total([{ field: "note", op: "last_days", value: "3" }])).rejects.toThrow(/that test doesn't work on note/);
    await expect(total([{ field: "account_class", op: "between", value: ["a", "b"] }])).rejects.toThrow(/that test doesn't work/);
    expect(await total([{ field: "note", op: "gt", value: "S" }])).toEqual(["-1393.00", "3"]);
    await expect(total([{ field: "account_class", op: "in", value: [] }])).rejects.toThrow(/between 1 and 200 values/);
  });
});

describe("filter choices in the editor", () => {
  it("offers tests that fit the column, in words for dates", () => {
    expect(opsFor("VARCHAR").map((op) => op.value)).toEqual(["eq", "neq", "in", "not_in", "contains", "blank", "not_blank"]);
    expect(opsFor("BOOLEAN").map((op) => op.value)).toEqual(["eq", "neq", "blank", "not_blank"]);
    const dates = opsFor("DATE");
    expect(dates.map((op) => op.label)).toEqual([
      "is",
      "is not",
      "after",
      "on or after",
      "before",
      "on or before",
      "between",
      "in the last … days",
      "in the last … months",
      "in this financial year",
      "in last financial year",
      "is blank",
      "is not blank",
    ]);
    expect(opsFor("DECIMAL(18,2)").map((op) => op.value)).toContain("between");
  });

  it("knows when a filter is ready, and resets its value when the test needs a different kind", () => {
    expect(filterComplete({ field: "a", op: "blank", value: "" })).toBe(true);
    expect(filterComplete({ field: "a", op: "in", value: [] })).toBe(false);
    expect(filterComplete({ field: "a", op: "between", value: ["1", ""] })).toBe(false);
    expect(filterComplete({ field: "a", op: "last_days", value: "30" })).toBe(true);
    expect(filterComplete({ field: "a", op: "eq", value: " " })).toBe(false);
    const columns = [
      { name: "account_class", type: "VARCHAR" },
      { name: "posting_date", type: "DATE" },
    ];
    const start: Filter = { field: "account_class", op: "eq", value: "revenue" };
    expect(changeFilter(start, { op: "neq" }, columns)).toEqual({ field: "account_class", op: "neq", value: "revenue" });
    expect(changeFilter(start, { op: "in" }, columns)).toEqual({ field: "account_class", op: "in", value: [] });
    // "contains" doesn't work on dates, so the test goes back to "is".
    expect(changeFilter({ ...start, op: "contains" }, { field: "posting_date" }, columns)).toEqual({ field: "posting_date", op: "eq", value: "" });
    expect(changeFilter({ field: "posting_date", op: "eq", value: "" }, { op: "between" }, columns).value).toEqual(["", ""]);
    expect(changeFilter(start, { join: "or" }, columns)).toEqual({ ...start, join: "or" });
  });
});

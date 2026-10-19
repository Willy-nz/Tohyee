import { describe, expect, it } from "vitest";
import { formulaKeepsMoney, formulaRefs, formulaText, parseFormula } from "@/lib/analytics/formula";
import { builtInMeasures, definitionToSave, measureFromSaved } from "@/lib/analytics/measure-library";
import { buildTileSql, parseTileQuery, type Measure } from "@/lib/analytics/query";

const columns = [
  { name: "posting_date", type: "DATE" },
  { name: "account_type", type: "VARCHAR" },
  { name: "system_account", type: "VARCHAR" },
  { name: "amount", type: "DECIMAL(18,2)" },
  { name: "quantity", type: "DECIMAL(18,4)" },
];
const tables = new Map([["ledger", columns], ["tohyee_ledger_lines", columns]]);

describe("formulas (#337)", () => {
  it("parses with the usual order of operations, without running anything", () => {
    expect(formulaText(parseFormula("[Revenue] - [Expenses] * 2"))).toBe("([Revenue] - ([Expenses] * 2))");
    expect(formulaText(parseFormula("([Gross profit]) / [Sales]"))).toBe("([Gross profit] / [Sales])");
    expect(formulaText(parseFormula("-[A] + 1.5"))).toBe("(-([A]) + 1.5)");
    expect(formulaText(parseFormula("[Accounts receivable] * DAYS / [Sales]"))).toBe("(([Accounts receivable] * days) / [Sales])");
    expect(formulaRefs(parseFormula("[A] + [B] - [A]"))).toEqual(["A", "B"]);
  });

  it("explains what's wrong", () => {
    expect(() => parseFormula("")).toThrow("Enter a formula");
    expect(() => parseFormula("[A] +")).toThrow("stops too early");
    expect(() => parseFormula("([A] + 1")).toThrow("isn't closed");
    expect(() => parseFormula("[A] 2")).toThrow("something extra");
    expect(() => parseFormula("Sales - 1")).toThrow('"Sales" isn\'t something a formula knows');
    expect(() => parseFormula("process.exit()")).toThrow();
    expect(() => parseFormula("[A]; drop table x")).toThrow('can\'t have ";"');
    expect(() => parseFormula("[A")).toThrow("square brackets");
    expect(() => parseFormula("x".repeat(501))).toThrow("500");
    expect(() => parseFormula("(".repeat(40) + "1" + ")".repeat(40))).toThrow("too many brackets");
  });

  it("knows when the answer is still money", () => {
    const money = (name: string) => name !== "Count";
    expect(formulaKeepsMoney(parseFormula("[A] - [B]"), money)).toBe(true);
    expect(formulaKeepsMoney(parseFormula("[A] / [B]"), money)).toBe(false);
    expect(formulaKeepsMoney(parseFormula("[A] - [Count]"), money)).toBe(false);
    expect(formulaKeepsMoney(parseFormula("[A] * 2"), money)).toBe(false);
  });
});

describe("calculated values in a tile's question (#337)", () => {
  const ask = (measures: unknown[], extra: Record<string, unknown> = {}) => parseTileQuery({ table: "ledger", groupBy: null, measures, filters: [], dateField: "posting_date", ...extra }, tables);
  const revenue = { label: "Revenue", aggregate: "sum", field: "amount", negate: true, where: [{ field: "account_type", op: "eq", value: "revenue" }] };
  const expenses = { label: "Expenses", aggregate: "sum", field: "amount", where: [{ field: "account_type", op: "in", value: ["expense", "depreciation"] }] };

  it("uses the tile's other values by name, in exact decimals, with values passed as parameters", () => {
    const query = ask([revenue, expenses, { label: "Profit", aggregate: "formula", formula: "[Revenue] - [Expenses]" }]);
    const built = buildTileSql(query, columns, { from: "2026-04-01", to: "2026-04-30" });
    expect(built.columns.map((column) => [column.label, column.format])).toEqual([
      ["Revenue", "money"],
      ["Expenses", "money"],
      ["Profit", "money"],
    ]);
    expect(built.sql).toContain("case when \"account_type\" = $");
    expect(built.sql).toContain("as DECIMAL(38,6)");
    expect(built.sql).not.toContain("revenue");
    expect(built.params).toEqual(expect.arrayContaining(["revenue", "expense", "depreciation", "2026-04-01", "2026-04-30"]));
  });

  it("divides exactly, with days from the dashboard's dates", () => {
    const query = ask([revenue, { label: "Per day", aggregate: "formula", formula: "[Revenue] / days" }]);
    const built = buildTileSql(query, columns, { from: "2026-04-01", to: "2026-04-30" });
    expect(built.columns[1].format).toBe("number");
    expect(built.sql).toContain("HUGEINT");
    expect(built.params).toContain("30");
    expect(buildTileSql(query, columns, {}).sql).toContain("cast(null as DECIMAL(38,6))");
  });

  it("refuses formulas that use unknown or calculated values, or names used twice", () => {
    expect(() => ask([revenue, { label: "X", aggregate: "formula", formula: "[Costs] * 2" }])).toThrow("[Costs] isn't one of this chart's values");
    expect(() => ask([revenue, { label: "X", aggregate: "formula", formula: "[Revenue]" }, { label: "Y", aggregate: "formula", formula: "[X] * 2" }])).toThrow("[X] is itself calculated");
    expect(() => ask([revenue, { ...revenue }, { label: "X", aggregate: "formula", formula: "[Revenue]" }])).toThrow("its own name");
    expect(() => ask([{ label: "X", aggregate: "formula", formula: "[A] +" }])).toThrow("X: The formula stops too early");
    expect(() => ask([{ ...revenue, where: [{ field: "nope", op: "eq", value: "x" }] }])).toThrow("Revenue condition 1: there's no column called nope");
  });

  it("keeps balances to the To date and moves the From date onto the other values", () => {
    const query = ask([{ label: "Bank", aggregate: "sum", field: "amount", asAt: true, where: [{ field: "account_type", op: "eq", value: "bank" }] }, revenue]);
    const built = buildTileSql(query, columns, { from: "2026-04-01", to: "2026-04-30" });
    const where = built.sql.slice(built.sql.indexOf(" where "));
    expect(where).toContain("<= cast(");
    expect(where).not.toContain(">= cast(");
    // The From date is a condition on Revenue only.
    expect(built.sql.match(/>= cast\(/g)).toHaveLength(1);
    expect(() => ask([{ label: "Bank", aggregate: "sum", field: "amount", asAt: true }], { groupBy: { field: "posting_date", grain: "month" } })).toThrow("can't be grouped by date");
  });
});

describe("saved values (#337)", () => {
  it("offers the books copy's built-in values only where their columns are", () => {
    expect(builtInMeasures("tohyee_ledger_lines", columns)).toHaveLength(11);
    expect(builtInMeasures("tohyee_ledger_lines", columns.filter((column) => column.name !== "system_account")).map((measure) => measure.name)).not.toContain("Accounts receivable");
    expect(builtInMeasures("sales", columns)).toEqual([]);
    const margin = builtInMeasures("tohyee_ledger_lines", columns).find((measure) => measure.name === "Gross margin %")!;
    expect(measureFromSaved(margin, "Margin")).toMatchObject({ label: "Margin", aggregate: "formula", formula: "([Sales] - [Cost of sales]) / [Sales]" });
    // Each built-in is a valid question on its own.
    for (const measure of builtInMeasures("tohyee_ledger_lines", columns)) {
      expect(() => parseTileQuery({ table: "tohyee_ledger_lines", groupBy: null, measures: [measureFromSaved(measure)], filters: [], dateField: "posting_date" }, tables)).not.toThrow();
    }
  });

  it("saves a formula with the chart's values it uses copied in", () => {
    const revenue: Measure = { label: "Revenue", aggregate: "sum", field: "amount", negate: true, compare: "previous_year" };
    const formula: Measure = { label: "Double", aggregate: "formula", formula: "[Revenue] * 2" };
    expect(definitionToSave(formula, [revenue, formula])).toEqual({
      kind: "formula",
      formula: "[Revenue] * 2",
      inputs: [{ name: "Revenue", aggregate: "sum", field: "amount", negate: true }],
    });
    expect(definitionToSave(revenue, [revenue])).toEqual({ kind: "base", aggregate: "sum", field: "amount", negate: true });
    expect(() => definitionToSave({ ...formula, formula: "[Nope]" }, [formula])).toThrow("[Nope]");
  });
});

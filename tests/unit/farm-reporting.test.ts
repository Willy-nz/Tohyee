import { describe, expect, it } from "vitest";
import { farmForValues, perUnit, splitByFarm } from "@/lib/farming/farm-reporting-rules";
import { dec } from "@/lib/money/decimal";

const groups = [
  { key: "wages", label: "Wages" },
  { key: "animal_health", label: "Animal health" },
  { key: "grazing", label: "Grazing" },
];
const grouping = new Map([
  ["6200", "wages"],
  ["6400", "animal_health"],
  ["6500", "grazing"],
]);
const line = (accountId: string, accountType: string, accountClass: string, farmId: string | null, amount: string) => ({ accountId, accountType, accountClass, farmId, amount });

/** FR2-FR6 (docs/ACCOUNTING-EXAMPLES.md), with FK1-FK3's year and totals. */
const lines = [
  line("4000", "revenue", "revenue", "home", "1500000.00"),
  line("4000", "revenue", "revenue", "runoff", "500000.00"),
  line("6200", "expense", "expense", "home", "80000.00"),
  line("6200", "expense", "expense", "runoff", "30000.00"),
  line("6200", "expense", "expense", null, "10000.00"),
  line("6400", "expense", "expense", "home", "24000.00"),
  line("6400", "expense", "expense", "runoff", "12000.00"),
  // Not working expenses (FK1): left out of every column.
  line("6300", "expense", "expense", null, "50000.00"),
  line("6090", "expense", "expense", null, "30000.00"),
];
const farms = [
  { id: "home", name: "Home farm", figures: { effectiveHa: "150.00", peakCows: 450, stockUnits: "3600.0", milkSolidsKg: "180000.0" } },
  { id: "runoff", name: "Runoff", figures: { effectiveHa: "50.00", peakCows: 150, stockUnits: "1200.0", milkSolidsKg: "60000.0" } },
];
const organisationFigures = { effectiveHa: "200.00", peakCows: 600, stockUnits: "4800.0", milkSolidsKg: "240000.0" };

const row = (split: ReturnType<typeof splitByFarm>, key: string) => split.rows.find((entry) => entry.key === key)!.cells;

describe("FR farm-level benchmarks", () => {
  const split = splitByFarm({ lines, grouping, groups, farms, organisationFigures });
  it("FR2-FR3 splits by farm, keeps Not allocated visible, and the total is FK3's", () => {
    expect(split.columns.map((column) => column.label)).toEqual(["Home farm", "Runoff", "Not allocated", "Total"]);
    const amounts = (key: string) => Object.fromEntries(Object.entries(row(split, key)).map(([column, cell]) => [column, cell.amount]));
    expect(amounts("revenue")).toEqual({ home: "1500000.00", runoff: "500000.00", none: "0.00", total: "2000000.00" });
    expect(amounts("wages")).toEqual({ home: "80000.00", runoff: "30000.00", none: "10000.00", total: "120000.00" });
    expect(amounts("fwe")).toEqual({ home: "104000.00", runoff: "42000.00", none: "10000.00", total: "156000.00" });
    expect(amounts("surplus")).toEqual({ home: "1396000.00", runoff: "458000.00", none: "-10000.00", total: "1844000.00" });
  });
  it("FR4 divides each farm by its own figures, the total by the organisation's, and Not allocated by nothing", () => {
    expect(row(split, "fwe").home).toEqual({ amount: "104000.00", perKgMs: "0.58", perHa: "693.33", perCow: "231.11", perSu: "28.89" });
    expect(row(split, "surplus").runoff).toEqual({ amount: "458000.00", perKgMs: "7.63", perHa: "9160.00", perCow: "3053.33", perSu: "381.67" });
    expect(row(split, "fwe").none).toEqual({ amount: "10000.00", perKgMs: null, perHa: null, perCow: null, perSu: null });
    // FK3 unchanged.
    expect(row(split, "fwe").total).toEqual({ amount: "156000.00", perKgMs: "0.65", perHa: "780.00", perCow: "260.00", perSu: "32.50" });
  });
  it("FR4 never divides by another farm's or the organisation's figures when a farm's aren't entered", () => {
    const blank = splitByFarm({ lines, grouping, groups, farms: [farms[0], { ...farms[1], figures: { effectiveHa: null, peakCows: null, stockUnits: null, milkSolidsKg: "60000.0" } }], organisationFigures });
    expect(row(blank, "fwe").runoff).toEqual({ amount: "42000.00", perKgMs: "0.70", perHa: null, perCow: null, perSu: null });
    const none = splitByFarm({ lines, grouping, groups, farms: [{ ...farms[0], figures: null }, farms[1]], organisationFigures });
    expect(row(none, "fwe").home).toEqual({ amount: "104000.00", perKgMs: null, perHa: null, perCow: null, perSu: null });
  });
  it("FR5 a journal moving shared wages to the farms empties Not allocated and leaves the total alone", () => {
    const moved = splitByFarm({
      lines: [...lines, line("6200", "expense", "expense", null, "-10000.00"), line("6200", "expense", "expense", "home", "7500.00"), line("6200", "expense", "expense", "runoff", "2500.00")],
      grouping,
      groups,
      farms,
      organisationFigures,
    });
    expect(Object.fromEntries(Object.entries(row(moved, "wages")).map(([column, cell]) => [column, cell.amount]))).toEqual({ home: "87500.00", runoff: "32500.00", none: "0.00", total: "120000.00" });
  });
  it("FR6 a transfer between farms on one account nets to nothing in the total", () => {
    const grazed = splitByFarm({
      lines: [...lines, line("6500", "expense", "expense", "home", "20000.00"), line("6500", "expense", "expense", "runoff", "-20000.00")],
      grouping,
      groups,
      farms,
      organisationFigures,
    });
    expect(Object.fromEntries(Object.entries(row(grazed, "grazing")).map(([column, cell]) => [column, cell.amount]))).toEqual({ home: "20000.00", runoff: "-20000.00", none: "0.00", total: "0.00" });
    expect(row(grazed, "surplus").home.amount).toBe("1376000.00");
    expect(row(grazed, "surplus").runoff.amount).toBe("478000.00");
    expect(row(grazed, "surplus").total.amount).toBe("1844000.00");
  });
  it("FR3 a line tagged with a farm that isn't a column is Not allocated", () => {
    const one = splitByFarm({ lines, grouping, groups, farms: [farms[0]], organisationFigures });
    expect(row(one, "revenue").none.amount).toBe("500000.00");
    expect(row(one, "revenue").total.amount).toBe("2000000.00");
  });
  it("FR1 values under a farm's value count for it; values with no farm above count for none", () => {
    const values = [
      { id: "1", parentId: null },
      { id: "2", parentId: "1" },
      { id: "3", parentId: null },
      { id: "4", parentId: "2" },
    ];
    expect(Object.fromEntries(farmForValues(values, new Map([["1", "runoff"]])))).toEqual({ "1": "runoff", "2": "runoff", "4": "runoff" });
  });
  it("rounds per-unit amounts half up to the cent", () => {
    expect(perUnit(dec("1396000.00"), farms[0].figures).perKgMs).toBe("7.76");
  });
});

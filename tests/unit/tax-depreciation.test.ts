import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { monthsToYearEnd, type TaxAssetInput, taxDepreciationYears } from "@/lib/tax/income/depreciation";

const asset = (overrides: Partial<TaxAssetInput>): TaxAssetInput => ({
  cost: dec("10000"),
  method: "dv",
  rate: dec("30"),
  businessUsePercent: dec("100"),
  investmentBoost: false,
  availableOn: "2024-05-20",
  opening: null,
  disposal: null,
  ...overrides,
});

const pick = (rows: ReturnType<typeof taxDepreciationYears>, ...fields: Array<keyof (typeof rows)[number]>) => rows.map((row) => fields.map((field) => row[field]));

describe("tax depreciation (ITX11-ITX17, from IRD's published rules, not yet reviewed)", () => {
  it("counts part months as whole months to 31 March", () => {
    expect(monthsToYearEnd("2024-05-20")).toBe(11);
    expect(monthsToYearEnd("2026-03-01")).toBe(1);
    expect(monthsToYearEnd("2026-04-30")).toBe(12);
  });

  it("ITX12 diminishing value, part year and private use", () => {
    expect(pick(taxDepreciationYears(asset({}), 2026), "incomeYear", "months", "depreciation", "closingAtv")).toEqual([
      [2025, 11, "2750.00", "7250.00"],
      [2026, 12, "2175.00", "5075.00"],
    ]);
    const mixed = taxDepreciationYears(asset({ businessUsePercent: dec("70") }), 2025);
    expect(pick(mixed, "depreciation", "depreciationClaimed", "closingAtv")).toEqual([["2750.00", "1925.00", "7250.00"]]);
  });

  it("ITX13 straight line until it's used up", () => {
    const rows = taxDepreciationYears(asset({ cost: dec("1200"), method: "sl", rate: dec("21"), availableOn: "2024-04-15" }), 2030);
    expect(pick(rows, "incomeYear", "depreciation", "closingAtv")).toEqual([
      [2025, "252.00", "948.00"],
      [2026, "252.00", "696.00"],
      [2027, "252.00", "444.00"],
      [2028, "252.00", "192.00"],
      [2029, "192.00", "0.00"],
      [2030, "0.00", "0.00"],
    ]);
  });

  it("ITX14 Investment Boost with straight line, then a sale", () => {
    const rows = taxDepreciationYears(
      asset({ cost: dec("100000"), method: "sl", rate: dec("20"), investmentBoost: true, availableOn: "2026-04-01", disposal: { date: "2029-06-30", proceeds: dec("40000") } }),
      2031,
    );
    expect(pick(rows, "incomeYear", "investmentBoost", "depreciation", "recovered", "closingAtv")).toEqual([
      [2027, "20000.00", "16000.00", "0.00", "64000.00"],
      [2028, "0.00", "16000.00", "0.00", "48000.00"],
      [2029, "0.00", "16000.00", "0.00", "32000.00"],
      [2030, "0.00", "0.00", "8000.00", "0.00"],
    ]);
    expect(rows[3].disposed).toBe(true);
  });

  it("ITX15 Investment Boost with diminishing value, part year", () => {
    const rows = taxDepreciationYears(asset({ cost: dec("2500"), rate: dec("25"), investmentBoost: true, availableOn: "2025-05-23" }), 2026);
    expect(pick(rows, "investmentBoost", "depreciation", "closingAtv")).toEqual([["500.00", "458.33", "1541.67"]]);
  });

  it("ITX16 mixed use claims the business share of the boost and depreciation", () => {
    const rows = taxDepreciationYears(asset({ cost: dec("45000"), businessUsePercent: dec("50"), investmentBoost: true, availableOn: "2026-03-01" }), 2026);
    expect(pick(rows, "investmentBoost", "boostClaimed", "depreciation", "depreciationClaimed", "closingAtv")).toEqual([["9000.00", "4500.00", "900.00", "450.00", "35100.00"]]);
  });

  it("ITX17 low-value write-off, recovery and a loss on sale", () => {
    const laptop = taxDepreciationYears(asset({ cost: dec("950"), method: "low_value", rate: null, availableOn: "2025-07-10", disposal: { date: "2027-05-01", proceeds: dec("300") } }), 2028);
    expect(pick(laptop, "incomeYear", "depreciation", "recovered", "closingAtv")).toEqual([
      [2026, "950.00", "0.00", "0.00"],
      [2027, "0.00", "0.00", "0.00"],
      [2028, "0.00", "300.00", "0.00"],
    ]);
    const car = taxDepreciationYears(
      asset({ cost: dec("20000"), businessUsePercent: dec("85"), opening: { incomeYear: 2027, atv: dec("7864") }, disposal: { date: "2026-09-01", proceeds: dec("6000") } }),
      2027,
    );
    expect(pick(car, "incomeYear", "openingAtv", "loss")).toEqual([[2027, "7864.00", "1584.40"]]);
    // The part above cost isn't taxable: recovered is at most cost less ATV.
    const gain = taxDepreciationYears(asset({ cost: dec("1000"), method: "sl", rate: dec("50"), availableOn: "2025-04-01", disposal: { date: "2026-06-01", proceeds: dec("1500") } }), 2027);
    expect(gain.at(-1)).toMatchObject({ incomeYear: 2027, recovered: "500.00" });
    // Not depreciable (land): no depreciation and no tax effect on sale.
    const land = taxDepreciationYears(asset({ method: "not_depreciable", rate: null, availableOn: "2025-04-01", disposal: { date: "2026-06-01", proceeds: dec("5000") } }), 2027);
    expect(pick(land, "depreciation", "recovered", "loss")).toEqual([
      ["0.00", "0.00", "0.00"],
      ["0.00", "0.00", "0.00"],
    ]);
  });
});

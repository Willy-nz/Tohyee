import { describe, expect, it } from "vitest";
import { allowedBoxes, allowedRoles, defaultBox, defaultRole } from "@/lib/tax/income/ir10-boxes";

describe("IR10 boxes for accounts (ITX19, not yet reviewed)", () => {
  it("defaults by account type", () => {
    const box = (type: Parameters<typeof defaultBox>[0]["type"], systemKey: string | null = null) => defaultBox({ code: "9999", name: "Anything", type, systemKey });
    expect([box("revenue"), box("other_income"), box("direct_costs"), box("expense"), box("depreciation")]).toEqual([2, 10, 4, 24, 13]);
    expect([box("bank"), box("current_asset", "accounts_receivable"), box("current_asset"), box("inventory"), box("fixed_asset"), box("non_current_asset")]).toEqual([31, 30, 32, 32, 38, 42]);
    expect([box("current_liability", "accounts_payable"), box("current_liability"), box("credit_card"), box("non_current_liability"), box("equity")]).toEqual([45, 47, 47, 49, 51]);
  });

  it("uses the starting chart only while the account keeps its starting code and name", () => {
    expect(defaultBox({ code: "4200", name: "Interest income", type: "other_income", systemKey: null })).toBe(7);
    expect(defaultBox({ code: "4200", name: "Commission received", type: "other_income", systemKey: null })).toBe(10);
    expect(defaultBox({ code: "6200", name: "Wages and salaries", type: "expense", systemKey: null })).toBe(22);
    expect(defaultBox({ code: "1650", name: "Accumulated depreciation - motor vehicles", type: "fixed_asset", systemKey: null })).toBe(33);
    expect(defaultRole({ code: "3100", name: "Owner drawings", type: "equity", systemKey: null })).toBe("drawings");
    expect(defaultRole({ code: "3100", name: "Share capital", type: "equity", systemKey: null })).toBeNull();
  });

  it("limits boxes and roles to what suits the account", () => {
    expect(allowedBoxes("expense")).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    expect(allowedBoxes("direct_costs")).toEqual([4]);
    expect(allowedBoxes("non_current_liability")).toEqual([44, 45, 46, 47, 49]);
    expect(allowedRoles("equity")).toEqual(["drawings", "dividends_paid", "current_account"]);
    expect(allowedRoles("expense")).toEqual([]);
  });
});

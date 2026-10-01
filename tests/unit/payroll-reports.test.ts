import { describe, expect, it } from "vitest";
import {
  assertReportRange,
  csvCell,
  fteFor,
  groupLabourCost,
  type LabourCostRow,
  monthsBetween,
  parseLabourCostGroupBy,
  parsePayrollReportName,
  parseStandardWeek,
  splitToPlaces,
  toCsv,
  UNRECORDED_RD,
} from "@/lib/payroll/report-figures";

/**
 * Pure rules of the payroll reports: examples PREP1, PREP2, PREP5, PREP8 in
 * docs/ACCOUNTING-EXAMPLES.md ("Payroll reports"), decisions 103, 104, 107,
 * 109 and 111.
 */

const ITEMS = { ordinary: "i-ordinary", overtime: "i-overtime", tool: "i-tool", reimbursement: "i-reimbursement", kiwisaver: "i-kiwisaver" };
const ORDER = [ITEMS.ordinary, ITEMS.overtime, ITEMS.tool, ITEMS.reimbursement, ITEMS.kiwisaver];
const NAMES: Record<string, string> = {
  [ITEMS.ordinary]: "Ordinary time",
  [ITEMS.overtime]: "Overtime",
  [ITEMS.tool]: "Tool allowance",
  [ITEMS.reimbursement]: "Reimbursement",
  [ITEMS.kiwisaver]: "KiwiSaver employer contribution",
};

function row(employee: string, item: string, amount: string, department: string | null, project: string | null = null): LabourCostRow {
  return {
    amount,
    payItemId: item,
    payItemName: NAMES[item],
    isReimbursement: item === ITEMS.reimbursement,
    departmentId: department,
    departmentName: department,
    projectId: project,
    projectName: project,
    rdActivityId: null,
    rdActivityName: null,
    employeeId: employee,
    employeeName: employee,
  };
}

/** PREP1's postings: PAYRUN-2, PAYRUN-3 and PAYRUN-4 (PRUN1's figures). */
const PREP1: LabourCostRow[] = [
  row("Hemi Walker", ITEMS.ordinary, "1615.39", "Sales"),
  row("Hemi Walker", ITEMS.ordinary, "1076.92", "Operations"),
  row("Hemi Walker", ITEMS.kiwisaver, "56.54", "Sales"),
  row("Hemi Walker", ITEMS.kiwisaver, "37.69", "Operations"),
  row("Kiri Tane", ITEMS.ordinary, "2000.00", "Sales"),
  row("Sione Fifita", ITEMS.ordinary, "720.00", "Operations", "Cafe rebrand"),
  row("Sione Fifita", ITEMS.overtime, "135.00", "Operations", "Cafe rebrand"),
  row("Sione Fifita", ITEMS.tool, "25.00", "Operations", "Cafe rebrand"),
  row("Sione Fifita", ITEMS.reimbursement, "42.60", "Operations", "Cafe rebrand"),
  row("Sione Fifita", ITEMS.kiwisaver, "30.80", "Operations", "Cafe rebrand"),
  row("Aroha Ngata", ITEMS.ordinary, "3500.00", "Sales"),
  row("Aroha Ngata", ITEMS.kiwisaver, "122.50", "Sales"),
];

describe("payroll reports: labour cost (PREP1, PREP2)", () => {
  it("PREP1: by Department, reimbursements on their own line (decision 103)", () => {
    const result = groupLabourCost(PREP1, "department", ORDER);
    expect(result.payItemIds).toEqual([ITEMS.ordinary, ITEMS.overtime, ITEMS.tool, ITEMS.kiwisaver]);
    expect(result.groups.map((group) => [group.label, group.amounts, group.total])).toEqual([
      ["Operations", { [ITEMS.ordinary]: "1796.92", [ITEMS.overtime]: "135.00", [ITEMS.tool]: "25.00", [ITEMS.kiwisaver]: "68.49" }, "2025.41"],
      ["Sales", { [ITEMS.ordinary]: "7115.39", [ITEMS.kiwisaver]: "179.04" }, "7294.43"],
    ]);
    expect(result.totals).toEqual({ [ITEMS.ordinary]: "8912.31", [ITEMS.overtime]: "135.00", [ITEMS.tool]: "25.00", [ITEMS.kiwisaver]: "247.53" });
    expect(result.total).toBe("9319.84");
    expect(result.reimbursements).toBe("42.60");
  });

  it("PREP1: by project, pay item and employee, with 'No project' last", () => {
    expect(groupLabourCost(PREP1, "project", ORDER).groups.map((group) => [group.key, group.label, group.total])).toEqual([
      ["Cafe rebrand", "Cafe rebrand", "910.80"],
      [null, "No project", "8409.04"],
    ]);
    expect(groupLabourCost(PREP1, "pay_item", ORDER).groups.map((group) => [group.label, group.total])).toEqual([
      ["KiwiSaver employer contribution", "247.53"],
      ["Ordinary time", "8912.31"],
      ["Overtime", "135.00"],
      ["Tool allowance", "25.00"],
    ]);
    expect(groupLabourCost(PREP1, "employee", ORDER).groups.map((group) => [group.label, group.total])).toEqual([
      ["Aroha Ngata", "3622.50"],
      ["Hemi Walker", "2786.54"],
      ["Kiri Tane", "2000.00"],
      ["Sione Fifita", "910.80"],
    ]);
  });

  it("PREP2: R&D activity, with pay runs from before timesheets shown as not recorded (decision 104)", () => {
    const rd = (activity: string | null, amount: string, item = ITEMS.ordinary): LabourCostRow => ({
      ...row("x", item, amount, null),
      rdActivityId: activity,
      rdActivityName: activity === "c1" ? "C1 Prototype and field-test a low-power soil-moisture sensor" : null,
    });
    const result = groupLabourCost(
      [rd("c1", "2400.00"), rd("c1", "84.00", ITEMS.kiwisaver), rd("c1", "900.00"), rd(null, "800.00"), rd(null, "300.00"), rd(UNRECORDED_RD, "10.00")],
      "rd_activity",
      ORDER,
    );
    expect(result.groups.map((group) => [group.key, group.label, group.total])).toEqual([
      ["c1", "C1 Prototype and field-test a low-power soil-moisture sensor", "3384.00"],
      [UNRECORDED_RD, "Not recorded (pay run approved before timesheets)", "10.00"],
      [null, "No R&D activity", "1100.00"],
    ]);
    expect(result.total).toBe("4494.00");
  });

  it("chooses how to group and which report", () => {
    expect(parseLabourCostGroupBy(undefined)).toBe("department");
    expect(parseLabourCostGroupBy("rd_activity")).toBe("rd_activity");
    expect(() => parseLabourCostGroupBy("contact")).toThrow("Group labour cost by one of");
    expect(parsePayrollReportName("labour-cost")).toBe("labour-cost");
    expect(() => parsePayrollReportName("leave")).toThrow("Choose a report");
  });
});

describe("payroll reports: headcount and FTE (PREP5, decision 107)", () => {
  it("FTE is usual hours ÷ the standard week, 4 places half up, at most 1; a salary is 1, assumed", () => {
    expect(fteFor("32.00", "40.00")).toEqual({ fte: "0.8000", assumed: false });
    expect(fteFor("20.00", "40.00")).toEqual({ fte: "0.5000", assumed: false });
    expect(fteFor("32.00", "37.50")).toEqual({ fte: "0.8533", assumed: false });
    expect(fteFor("45.00", "40.00")).toEqual({ fte: "1.0000", assumed: false });
    expect(fteFor("0.01", "40.00")).toEqual({ fte: "0.0003", assumed: false }); // 0.00025 rounds half up
    expect(fteFor(null, "40.00")).toEqual({ fte: "1.0000", assumed: true });
  });

  it("the standard week defaults to 40.00 and must be more than 0, at most 168, 2 decimals (PREP8)", () => {
    expect(parseStandardWeek(undefined)).toBe("40.00");
    expect(parseStandardWeek("")).toBe("40.00");
    expect(parseStandardWeek("37.5")).toBe("37.50");
    expect(() => parseStandardWeek("0")).toThrow("Standard week must not be zero.");
    expect(() => parseStandardWeek("168.01")).toThrow("Standard week can't be more than 168 hours.");
    expect(() => parseStandardWeek("37.555")).toThrow("Standard week can have at most 2 decimal places.");
  });

  it("FTE by Department splits by the allocation and adds back exactly", () => {
    expect(splitToPlaces("1.0000", ["60", "40"], 4)).toEqual(["0.6000", "0.4000"]);
    expect(splitToPlaces("0.8000", ["33.33", "33.33", "33.34"], 4)).toEqual(["0.2667", "0.2666", "0.2667"]);
    expect(splitToPlaces("0.9375", ["50", "50"], 4)).toEqual(["0.4688", "0.4687"]);
  });

  it("months cover the range, each 1st to last day", () => {
    expect(monthsBetween("2026-10-14", "2026-11-03")).toEqual([
      { month: "2026-10", start: "2026-10-01", end: "2026-10-31" },
      { month: "2026-11", start: "2026-11-01", end: "2026-11-30" },
    ]);
    expect(monthsBetween("2027-12-01", "2028-02-29").map((month) => month.end)).toEqual(["2027-12-31", "2028-01-31", "2028-02-29"]);
  });
});

describe("payroll reports: ranges and CSV (PREP8, decisions 109, 111)", () => {
  it("refuses a backwards range or more than 5 years", () => {
    expect(() => assertReportRange("2026-10-31", "2026-10-01")).toThrow("The start date must be on or before the end date.");
    expect(() => assertReportRange("2021-10-01", "2026-09-30")).not.toThrow();
    expect(() => assertReportRange("2021-10-01", "2026-10-01")).toThrow("Choose 5 years or less.");
  });

  it("writes CSV with CR LF, quotes and formula guards", () => {
    expect(toCsv([["Department", "Labour cost"], ["Sales", "7294.43"], ["Ops, \"north\"", "-12.50"]])).toBe(
      'Department,Labour cost\r\nSales,7294.43\r\n"Ops, ""north""",-12.50\r\n',
    );
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("@here")).toBe("'@here");
    expect(csvCell(null)).toBe("");
  });
});

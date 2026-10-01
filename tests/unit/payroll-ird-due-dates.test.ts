import { describe, expect, it } from "vitest";
import { irdPeriodContaining, irdPeriodFromStart, irdPeriodsBetween } from "@/lib/payroll/ird-due-dates";

/**
 * Examples PPAY4 and PPAY9 in docs/ACCOUNTING-EXAMPLES.md ("NZ payroll —
 * paying wages and IRD"): IRD's payment periods by pay date and their due
 * dates, from IRD's "Paying deductions to Inland Revenue" (23 Mar 2026) and
 * "When to pay" (1 Apr 2026).
 */
describe("IRD payroll periods and due dates (PPAY4, PPAY9)", () => {
  it("PPAY4: pay runs paid on 14 Oct 2026 are in October, due Friday 20 Nov 2026 for a monthly payer", () => {
    expect(irdPeriodContaining("2026-10-14", "monthly")).toEqual({
      frequency: "monthly",
      start: "2026-10-01",
      end: "2026-10-31",
      dueDate: "2026-11-20",
      dueWeekday: "Friday",
      payBy: "2026-11-20",
    });
  });

  it("PPAY9: monthly payers pay by the 20th of the following month; a weekend moves to the Monday", () => {
    expect(irdPeriodFromStart("2026-11-01", "monthly")).toMatchObject({
      end: "2026-11-30",
      dueDate: "2026-12-20",
      dueWeekday: "Sunday",
      payBy: "2026-12-21",
    });
    expect(irdPeriodFromStart("2026-12-01", "monthly")).toMatchObject({ end: "2026-12-31", dueDate: "2027-01-20", payBy: "2027-01-20" });
    expect(irdPeriodFromStart("2027-02-01", "monthly")).toMatchObject({ end: "2027-02-28", dueDate: "2027-03-20", payBy: "2027-03-22" });
  });

  it("PPAY9: twice-monthly payers pay 1st-15th by the 20th, 16th-end by the 5th, and 16-31 December by 15 January", () => {
    expect(irdPeriodContaining("2026-10-14", "twice_monthly")).toMatchObject({
      start: "2026-10-01",
      end: "2026-10-15",
      dueDate: "2026-10-20",
      dueWeekday: "Tuesday",
    });
    expect(irdPeriodContaining("2026-10-16", "twice_monthly")).toMatchObject({
      start: "2026-10-16",
      end: "2026-10-31",
      dueDate: "2026-11-05",
      dueWeekday: "Thursday",
    });
    expect(irdPeriodFromStart("2026-11-16", "twice_monthly")).toMatchObject({
      end: "2026-11-30",
      dueDate: "2026-12-05",
      dueWeekday: "Saturday",
      payBy: "2026-12-07",
    });
    expect(irdPeriodFromStart("2026-12-16", "twice_monthly")).toMatchObject({
      end: "2026-12-31",
      dueDate: "2027-01-15",
      dueWeekday: "Friday",
      payBy: "2027-01-15",
    });
  });

  it("PPAY6: a period must be one of IRD's", () => {
    expect(() => irdPeriodFromStart("2026-10-14", "monthly")).toThrow("For monthly IRD payments the period starts on the 1st of a month.");
    expect(() => irdPeriodFromStart("2026-10-14", "twice_monthly")).toThrow(
      "For IRD payments twice a month the period starts on the 1st or the 16th of a month.",
    );
    expect(() => irdPeriodFromStart("2026-02-30", "monthly")).toThrow("not a real date");
  });

  it("lists the periods that cover a range of pay dates, oldest first", () => {
    expect(irdPeriodsBetween(["2026-10-14", "2026-09-30", "2026-10-02"], "monthly").map((period) => period.start)).toEqual([
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(irdPeriodsBetween(["2026-10-14", "2026-10-16"], "twice_monthly").map((period) => [period.start, period.end])).toEqual([
      ["2026-10-01", "2026-10-15"],
      ["2026-10-16", "2026-10-31"],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { dec, mul, sum, toFixedString } from "@/lib/money/decimal";
import { addDays } from "@/lib/payroll/leave/dates";
import { averageWeeklyEarnings, earningsBetween, type PeriodEarnings } from "@/lib/payroll/leave/earnings";
import { annualDatesWithOpening, checkOpeningBalances, type OpeningBalanceFigures, type OpeningEarningsRow, openingDaysBetween, openingPeriods } from "@/lib/payroll/leave/opening";
import { unitsOf } from "@/lib/payroll/leave/quantity";
import { days, familyViolenceLeaveBalance, sickEntitlementDates, sickLeaveBalance } from "@/lib/payroll/leave/sick";

/**
 * Examples HL43-HL48 in docs/ACCOUNTING-EXAMPLES.md (opening balances,
 * decision 168), the pure parts: checking what's entered, the entitlement
 * dates after the opening date, sick leave from an opening balance, and the
 * earnings rows inside AWE, ADP and 8% windows. Hemi: 30.00 an hour, Monday
 * to Friday, 8 hours a day, started Mon 4 Mar 2024, opening balances as at
 * Sun 4 Oct 2026.
 */

const START = "2024-03-04";
const AS_AT = "2026-10-04";

/** Hemi's 52 weekly rows, Mon 6 Oct 2025 to Sun 4 Oct 2026 (HL43). */
function hemiRows(): OpeningEarningsRow[] {
  const rows: OpeningEarningsRow[] = [];
  for (let monday = "2025-10-06"; monday <= "2026-09-28"; monday = addDays(monday, 7)) {
    const gross = monday === "2025-10-27" ? "1320.00" : monday === "2025-12-15" ? "2200.00" : "1200.00";
    rows.push({ periodStart: monday, periodEnd: addDays(monday, 6), gross, irregular: monday === "2025-12-15" ? "1000.00" : "0", days: 5 });
  }
  return rows;
}

function hemi(overrides: Partial<OpeningBalanceFigures> = {}): OpeningBalanceFigures {
  return {
    asAt: AS_AT,
    annualWeeks: "2.5",
    annualLastEntitled: "2026-03-04",
    annualCashedUpWeeks: "0.5",
    annualAdvancePaid: "0",
    sickDays: "14",
    familyViolenceDays: "10",
    alternativeHolidays: ["2025-10-27"],
    earnings: hemiRows(),
    ...overrides,
  };
}

const check = (figures: OpeningBalanceFigures, approvedPeriods: Array<{ periodStart: string; periodEnd: string }> = []) =>
  checkOpeningBalances({ figures, startDate: START, finishDate: null, unpaid: [], approvedPeriods });

/** Monday to Friday, 8 hours a day: how a day weighs when a row is only partly inside a window. */
const weekday = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dec(day === 0 || day === 6 ? "0" : "8");
};

describe("Opening balances (HL43-HL48)", () => {
  it("HL43: Hemi's opening balances are accepted, 52 rows totalling 63,520.00", () => {
    expect(() => check(hemi())).not.toThrow();
    const rows = hemiRows();
    expect(rows).toHaveLength(52);
    expect(toFixedString(sum(rows.map((row) => dec(row.gross))), 2)).toBe("63520.00");
    const gross = earningsBetween(openingPeriods(rows), "2025-10-06", AS_AT, weekday).gross;
    expect(toFixedString(gross, 2)).toBe("63520.00");
  });

  it("HL43: annual holidays arise again 12 months after the last entitlement; sick leave from the start date", () => {
    expect(annualDatesWithOpening({ startDate: START, unpaid: [], until: "2027-03-31", asAt: AS_AT, lastEntitled: "2026-03-04" })).toEqual(["2026-03-04", "2027-03-04"]);
    // Unpaid leave after the opening date that doesn't count moves the next anniversary (decision 14); before it, it's in the last date given.
    const unpaid = [
      { start: "2025-06-02", end: "2025-06-29", statutory: false, agreedToCount: false },
      { start: "2026-11-02", end: "2026-11-22", statutory: false, agreedToCount: false },
    ];
    expect(annualDatesWithOpening({ startDate: START, unpaid, until: "2027-03-31", asAt: AS_AT, lastEntitled: "2026-03-04" })).toEqual(["2026-03-04", "2027-03-25"]);
    expect(sickEntitlementDates(START, "2026-10-04").at(-1)).toBe("2026-09-04");
  });

  it("HL43: the running 8% since 4 Mar 2026 is 2,937.60 (720.00 for Wed-Fri of the 2-8 Mar row, 36,000.00 after)", () => {
    const gross = earningsBetween(openingPeriods(hemiRows()), "2026-03-04", AS_AT, weekday).gross;
    expect(toFixedString(gross, 2)).toBe("36720.00");
    expect(toFixedString(mul(gross, dec("0.08")), 2)).toBe("2937.60");
  });

  it("HL44: AWE to Sun 11 Oct 2026 is 63,520.00 ÷ 52 with Tohyee's first week", () => {
    const periods: PeriodEarnings[] = [...openingPeriods(hemiRows()), { periodStart: "2026-10-05", periodEnd: "2026-10-11", gross: "1200.00", irregular: "0" }];
    const awe = averageWeeklyEarnings({ periods, windowEnd: "2026-10-11", weight: weekday });
    expect(toFixedString(awe.gross, 2)).toBe("63520.00");
    expect(toFixedString(awe.weekly, 2)).toBe("1221.54");
  });

  it("HL45: sick leave from an opening balance of 14 days; at most 10 carry over on 4 Sep 2027", () => {
    const opening = { date: AS_AT, balance: days("14") };
    const dates = sickEntitlementDates(START, "2027-09-30").filter((date) => date > AS_AT);
    const after = sickLeaveBalance(dates, [{ date: "2026-10-21", quantity: days("1") }], "2026-10-21", opening);
    expect(toFixedString(unitsOf(after.balance), 2)).toBe("13.00");
    const next = sickLeaveBalance(dates, [{ date: "2026-10-21", quantity: days("1") }], "2027-09-04", opening);
    expect(toFixedString(unitsOf(next.balance), 2)).toBe("20.00");
    const entitled = next.events.find((event) => event.kind === "entitled");
    expect(entitled && toFixedString(unitsOf(entitled.lapsed), 2)).toBe("3.00");
    // Family violence leave doesn't carry over (s 72H).
    const violence = familyViolenceLeaveBalance(dates, [], "2027-09-04", { date: AS_AT, balance: days("10") });
    expect(toFixedString(unitsOf(violence.balance), 2)).toBe("10.00");
  });

  it("HL48: refuses gaps, overlaps, rows past the opening date and rows over Tohyee's own pay periods", () => {
    const gap = hemiRows().filter((row) => row.periodStart !== "2026-01-12");
    expect(() => check(hemi({ earnings: gap }))).toThrow("There's a gap in the earnings rows from 2026-01-12 to 2026-01-18.");
    const overlap = [...hemiRows(), { periodStart: "2026-09-30", periodEnd: "2026-10-04", gross: "600", irregular: "0", days: 3 }];
    expect(() => check(hemi({ earnings: overlap }))).toThrow("overlap");
    const past = [...hemiRows(), { periodStart: "2026-10-05", periodEnd: "2026-10-11", gross: "1200", irregular: "0", days: 5 }];
    expect(() => check(hemi({ earnings: past }))).toThrow("runs past the opening date (2026-10-04)");
    // Tohyee already paid 21 Sep-4 Oct 2026 (typed holiday pay, HL43): rows end on Sun 20 Sep.
    const tohyee = [
      { periodStart: "2026-09-21", periodEnd: "2026-09-27" },
      { periodStart: "2026-09-28", periodEnd: "2026-10-04" },
    ];
    expect(() => check(hemi(), tohyee)).toThrow("runs past 2026-09-20");
    const toTwentieth = hemiRows().filter((row) => row.periodEnd <= "2026-09-20");
    expect(() => check(hemi({ earnings: toTwentieth }), tohyee)).not.toThrow();
  });

  it("HL48: refuses a negative balance without the advance paid, and the advance without a negative balance", () => {
    expect(() => check(hemi({ annualWeeks: "-0.5" }))).toThrow("give the holiday pay already paid");
    expect(() => check(hemi({ annualWeeks: "-0.5", annualAdvancePaid: "610.77" }))).not.toThrow();
    expect(() => check(hemi({ annualAdvancePaid: "100" }))).toThrow("negative annual holiday balance only");
    expect(() => check(hemi({ annualLastEntitled: null }))).toThrow("Give the date last entitled to annual holidays: 12 months from the start was 2025-03-04");
    expect(() => check(hemi({ annualCashedUpWeeks: "1.5" }))).toThrow("from 0 to 1");
    expect(() => check(hemi({ alternativeHolidays: ["2026-10-26"] }))).toThrow("between the start date and the opening date");
  });

  it("HL48: ADP over a row only partly inside the 52 weeks is refused; whole rows count their days", () => {
    const rows = hemiRows();
    expect(openingDaysBetween(rows, "2025-10-06", AS_AT)).toBe(260);
    expect(() => openingDaysBetween(rows, "2025-10-12", AS_AT)).toThrow("only partly inside the 52 weeks (2025-10-06 to 2025-10-12)");
  });
});

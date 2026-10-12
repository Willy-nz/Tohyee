import { describe, expect, it } from "vitest";
import {
  countedAmount,
  daysBetween,
  enteredAfterText,
  incomeYearDates,
  incomeYearLabel,
  incomeYearOf,
  isEnteredLate,
  rdShare,
  usageSplit,
} from "@/lib/rd/amounts";

describe("R&D income years", () => {
  it("numbers an income year by the year it ends in, with a 31 March balance date", () => {
    expect(incomeYearOf("2026-04-01", 3)).toBe(2027);
    expect(incomeYearOf("2027-03-31", 3)).toBe(2027);
    expect(incomeYearOf("2026-03-31", 3)).toBe(2026);
    expect(incomeYearLabel(2027, 3)).toBe("2026-27");
    expect(incomeYearDates(2027, 3)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
  });

  it("uses the organisation's own balance date: a late one counts toward the tax year before it", () => {
    expect(incomeYearDates(2026, 6)).toEqual({ start: "2025-07-01", end: "2026-06-30" });
    expect(incomeYearOf("2025-07-01", 6)).toBe(2026);
    expect(incomeYearLabel(2026, 6)).toBe("2025-26");
    expect(incomeYearOf("2026-09-30", 9)).toBe(2026);
  });

  it("an early balance date (October to March) counts toward the tax year after it (IRD SPS 08/04)", () => {
    // The year to 30 Nov 2006 is the 2006-07 income year.
    expect(incomeYearOf("2006-11-30", 11)).toBe(2007);
    expect(incomeYearOf("2005-12-01", 11)).toBe(2007);
    expect(incomeYearLabel(2007, 11)).toBe("2006-07");
    expect(incomeYearDates(2007, 11)).toEqual({ start: "2005-12-01", end: "2006-11-30" });
    // 30 Nov 2025, as #243 asked: 2026, agreeing with livestock.
    expect(incomeYearOf("2025-11-30", 11)).toBe(2026);
    // A calendar year: 2026 counts toward 2026-27.
    expect(incomeYearOf("2026-06-15", 12)).toBe(2027);
    expect(incomeYearDates(2027, 12)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(incomeYearLabel(2027, 12)).toBe("2026-27");
    // The year to 31 Jan 2008 is 2007-08 (no change for January to March).
    expect(incomeYearOf("2008-01-31", 1)).toBe(2008);
  });
});

describe("R&D shares", () => {
  it("RD8: the bill line's 4,000.00 excluding GST counts at 100%, less 1,000.00 not used by year end", () => {
    expect(rdShare("4000.00", "100", 2)).toBe("4000.00");
    expect(countedAmount("4000.00", "1000.00", "0", 2)).toBe("3000.00");
  });

  it("RD9: the receipt's 200.00 excluding GST counts", () => {
    expect(rdShare("200.00", "100.00", 2)).toBe("200.00");
  });

  it("RD12: the contractor's own ineligible costs come off", () => {
    expect(countedAmount("3100.00", "0", "0", 2)).toBe("3100.00");
    expect(countedAmount("3100.00", "0", "400.00", 2)).toBe("2700.00");
  });

  it("RD13: the overseas bill counts at the bill's rate, 9,000.00", () => {
    expect(rdShare("9000.00", "100", 2)).toBe("9000.00");
  });

  it("rounds a share down to the cent, never up (decision 50)", () => {
    expect(rdShare("100.00", "33.33", 2)).toBe("33.33");
    expect(rdShare("0.05", "50", 2)).toBe("0.02");
    expect(rdShare("2472.00", "62.34", 2)).toBe("1541.04");
    expect(rdShare("1000", "15", 0)).toBe("150");
    expect(rdShare("999", "33.33", 0)).toBe("332");
  });

  it("RD11: FA-0007's 2,400.00 tax depreciation and Investment Boost is split by its usage log", () => {
    const split = usageSplit("2400.00", [{ key: "C1", hours: "300" }, { key: null, hours: "600" }], 2);
    expect(split.shares).toEqual([{ key: "C1", hours: "300.00", amount: "800.00" }]);
    expect(split.totalHours).toBe("900.00");
    expect(split.otherHours).toBe("600.00");
    expect(split.other).toBe("1600.00");
    // Book depreciation would have given 500.00; it's never used.
    expect(usageSplit("1500.00", [{ key: "C1", hours: "300" }, { key: null, hours: "600" }], 2).shares[0].amount).toBe("500.00");
  });

  it("RD11: usage shares are rounded down and the rest goes to other work", () => {
    const split = usageSplit("1000.00", [{ key: "C1", hours: "1" }, { key: "S1", hours: "1" }, { key: null, hours: "1" }], 2);
    expect(split.shares.map((share) => share.amount)).toEqual(["333.33", "333.33"]);
    expect(split.other).toBe("333.34");
    expect(usageSplit("1000.00", [], 2)).toEqual({ shares: [], totalHours: "0.00", otherHours: "0.00", other: "1000.00" });
  });
});

describe("R&D contemporaneous records", () => {
  it("RD21: entered 2 days after the work isn't flagged", () => {
    expect(daysBetween("2026-07-01", "2026-07-03")).toBe(2);
    expect(isEnteredLate(2)).toBe(false);
    expect(enteredAfterText(2)).toBe("entered 2 days after the work");
  });

  it("RD22: entered 214 days after the work is flagged", () => {
    expect(daysBetween("2026-08-14", "2027-03-16")).toBe(214);
    expect(isEnteredLate(214)).toBe(true);
  });

  it("flags only more than 14 days (decision 38)", () => {
    expect(isEnteredLate(14)).toBe(false);
    expect(isEnteredLate(15)).toBe(true);
    expect(enteredAfterText(0)).toBe("entered on the day of the work");
    expect(enteredAfterText(1)).toBe("entered 1 day after the work");
  });

  it("RD23: changed 17 days after entry", () => {
    expect(daysBetween("2026-07-03", "2026-07-20")).toBe(17);
  });
});

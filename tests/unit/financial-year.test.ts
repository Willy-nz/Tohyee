import { describe, expect, it } from "vitest";
import { addDays, financialYearEnd, financialYearStart, isMonthEndDate, monthEndOf, monthLabel, monthStartOf } from "@/lib/financial-year";

describe("financial year start", () => {
  it("31 March year end (NZ standard balance date)", () => {
    expect(financialYearStart("2026-03-31", 3)).toBe("2025-04-01");
    expect(financialYearStart("2026-04-01", 3)).toBe("2026-04-01");
    expect(financialYearStart("2026-12-31", 3)).toBe("2026-04-01");
    expect(financialYearStart("2027-01-15", 3)).toBe("2026-04-01");
  });

  it("December year end is the calendar year", () => {
    expect(financialYearStart("2026-01-01", 12)).toBe("2026-01-01");
    expect(financialYearStart("2026-12-31", 12)).toBe("2026-01-01");
  });

  it("June and January year ends", () => {
    expect(financialYearStart("2026-06-30", 6)).toBe("2025-07-01");
    expect(financialYearStart("2026-07-01", 6)).toBe("2026-07-01");
    expect(financialYearStart("2026-01-31", 1)).toBe("2025-02-01");
    expect(financialYearStart("2026-02-01", 1)).toBe("2026-02-01");
  });

  it("refuses a month that doesn't exist", () => {
    expect(() => financialYearStart("2026-01-01", 0)).toThrow();
    expect(() => financialYearStart("2026-01-01", 13)).toThrow();
  });
});

describe("period close dates (YE1-YE4, PC1)", () => {
  it("financial year ends", () => {
    expect(financialYearEnd("2025-07-10", 3)).toBe("2026-03-31");
    expect(financialYearEnd("2026-03-31", 3)).toBe("2026-03-31");
    expect(financialYearEnd("2026-04-01", 3)).toBe("2027-03-31");
    expect(financialYearEnd("2026-04-30", 6)).toBe("2026-06-30");
    expect(financialYearEnd("2026-02-10", 12)).toBe("2026-12-31");
    expect(financialYearEnd("2027-06-01", 2)).toBe("2028-02-29");
  });

  it("months and days", () => {
    expect(monthStartOf("2026-06-15")).toBe("2026-06-01");
    expect(monthEndOf("2026-02-10")).toBe("2026-02-28");
    expect(monthEndOf("2028-02-10")).toBe("2028-02-29");
    expect(monthEndOf("2026-12-01")).toBe("2026-12-31");
    expect(isMonthEndDate("2026-06-30")).toBe(true);
    expect(isMonthEndDate("2026-06-29")).toBe(false);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(monthLabel("2026-06-30")).toBe("June 2026");
  });
});

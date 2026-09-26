import { describe, expect, it } from "vitest";
import { financialYearStart } from "@/lib/financial-year";

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

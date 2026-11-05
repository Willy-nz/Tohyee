import { describe, expect, it } from "vitest";
import { comparedText, monthTotals, mmText, parseMm, rainTotals, seasonOf, seasonTotals, spanTotal, tryMm, yearEarlier } from "@/lib/farming/rainfall-rules";

/** Rainfall's rules (RF2, RF5, RF6; decisions 1451-1456, not yet reviewed). */
describe("rainfall rules", () => {
  it("RF2 takes millimetres to one place, from 0 to 2,000", () => {
    expect(parseMm("12")).toBe("12.0");
    expect(parseMm(" 4.5 mm ")).toBe("4.5");
    expect(parseMm("0")).toBe("0.0");
    expect(parseMm(7.2)).toBe("7.2");
    expect(() => parseMm("1.25")).toThrow("at most 1 decimal place");
    expect(() => parseMm("-1")).toThrow("can't be negative");
    expect(() => parseMm("2000.1")).toThrow("from 0 to 2,000");
    expect(() => parseMm("")).toThrow("required");
    expect(tryMm("lots")).toBeNull();
    expect(mmText("1234.0")).toBe("1,234 mm");
    expect(mmText("0.5")).toBe("0.5 mm");
    expect(mmText(null)).toBe("No readings");
  });

  it("RF5 adds a period's readings and counts the days read; a day with no reading isn't dry", () => {
    const readings = [
      { readOn: "2026-10-01", mm: "12.5" },
      { readOn: "2026-10-02", mm: "0.0" },
      { readOn: "2026-10-31", mm: "3.2" },
      { readOn: "2026-11-01", mm: "8.0" },
    ];
    expect(spanTotal(readings, "2026-10-01", "2026-10-31")).toEqual({ from: "2026-10-01", to: "2026-10-31", mm: "15.7", days: 31, daysRead: 3 });
    expect(spanTotal(readings, "2026-09-01", "2026-09-30").mm).toBeNull();
  });

  it("RF5 compares this month so far with the same days last year", () => {
    const readings = [
      { readOn: "2025-11-03", mm: "10.0" },
      { readOn: "2025-11-20", mm: "40.0" },
      { readOn: "2026-11-02", mm: "6.5" },
    ];
    const totals = rainTotals(readings, "2026-11-05");
    expect(totals.thisMonth.current).toMatchObject({ from: "2026-11-01", to: "2026-11-05", mm: "6.5", days: 5, daysRead: 1 });
    // 20 November 2025 is after the 5th, so it isn't in "the same time last year".
    expect(totals.thisMonth.lastYear).toMatchObject({ from: "2025-11-01", to: "2025-11-05", mm: "10.0" });
    expect(comparedText(totals.thisMonth)).toBe("3.5 mm less than last year");
    expect(totals.last12Months.current).toMatchObject({ from: "2025-11-06", to: "2026-11-05", mm: "46.5" });
    expect(totals.last12Months.lastYear).toMatchObject({ from: "2024-11-06", to: "2025-11-05", mm: "10.0" });
    expect(totals.thisSeason).toMatchObject({ label: "Spring 2026 so far", toDate: true });
    expect(totals.thisSeason.current).toMatchObject({ from: "2026-09-01", to: "2026-11-05", mm: "6.5" });
  });

  it("RF5 shows 12 months, oldest first, each with the same month last year", () => {
    const months = monthTotals([{ readOn: "2025-12-25", mm: "30.0" }, { readOn: "2024-12-01", mm: "5.0" }], "2026-11-05");
    expect(months).toHaveLength(12);
    expect(months[0]).toMatchObject({ key: "2025-12", label: "Dec 2025", toDate: false });
    expect(months[0].current.mm).toBe("30.0");
    expect(months[0].lastYear).toMatchObject({ from: "2024-12-01", to: "2024-12-31", mm: "5.0" });
    expect(months[11]).toMatchObject({ key: "2026-11", toDate: true });
    expect(months[11].current.to).toBe("2026-11-05");
  });

  it("RF6 uses New Zealand's seasons; summer runs over the new year", () => {
    expect(seasonOf("2027-01-15")).toEqual({ key: "2026-summer", label: "Summer 2026-27", from: "2026-12-01", to: "2027-02-28", season: "summer" });
    expect(seasonOf("2028-02-29").to).toBe("2028-02-29");
    expect(seasonOf("2026-06-01")).toMatchObject({ label: "Winter 2026", from: "2026-06-01", to: "2026-08-31" });
    expect(seasonOf("2026-03-31").label).toBe("Autumn 2026");
    const seasons = seasonTotals([{ readOn: "2026-01-10", mm: "22.0" }, { readOn: "2025-01-10", mm: "11.0" }], "2026-11-05");
    expect(seasons.map((season) => season.label)).toEqual(["Summer 2025-26", "Autumn 2026", "Winter 2026", "Spring 2026"]);
    expect([seasons[0].current.mm, seasons[0].lastYear.mm, seasons[0].lastYear.from]).toEqual(["22.0", "11.0", "2024-12-01"]);
    expect(comparedText(seasons[0])).toBe("11 mm more than last year");
  });

  it("RF5 a year earlier from 29 February is 28 February", () => {
    expect(yearEarlier("2028-02-29")).toBe("2027-02-28");
    expect(yearEarlier("2026-11-05")).toBe("2025-11-05");
  });
});

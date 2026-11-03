import { describe, expect, it } from "vitest";
import { columnHeading, producedAtText, reportPresetFor, reportPresetRange, statementAsAt, statementPeriod } from "@/lib/reports/report-dates";

describe("report date presets (decision 1350)", () => {
  it("works out Xero's presets from today, with a May balance date", () => {
    const today = "2026-11-04";
    expect(reportPresetRange("this_month", today, 5)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(reportPresetRange("last_month", today, 5)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(reportPresetRange("this_quarter", today, 5)).toEqual({ from: "2026-09-01", to: "2026-11-30" });
    expect(reportPresetRange("last_quarter", today, 5)).toEqual({ from: "2026-06-01", to: "2026-08-31" });
    expect(reportPresetRange("this_financial_year", today, 5)).toEqual({ from: "2026-06-01", to: "2027-05-31" });
    expect(reportPresetRange("last_financial_year", today, 5)).toEqual({ from: "2025-06-01", to: "2026-05-31" });
  });

  it("uses calendar quarters with a March balance date, across a year end", () => {
    expect(reportPresetRange("this_quarter", "2026-11-04", 3)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(reportPresetRange("last_quarter", "2026-02-10", 3)).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(reportPresetRange("last_month", "2026-01-15", 3)).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("names the preset the dates match, or custom", () => {
    expect(reportPresetFor({ from: "2026-10-01", to: "2026-10-31" }, "2026-11-04", 3)).toBe("last_month");
    expect(reportPresetFor({ from: "2026-06-01", to: "2026-11-04" }, "2026-11-04", 5)).toBe("custom");
    expect(reportPresetFor({ from: null, to: "2026-10-31" }, "2026-11-04", 3, true)).toBe("last_month");
  });
});

describe("statement wording", () => {
  it("words a month, a financial year and other dates as Xero does", () => {
    expect(statementPeriod("2026-10-01", "2026-10-31", 3)).toBe("For the month ended 31 October 2026");
    expect(statementPeriod("2026-04-01", "2027-03-31", 3)).toBe("For the year ended 31 March 2027");
    expect(statementPeriod("2026-06-01", "2026-11-04", 5)).toBe("For the period 1 June 2026 to 4 November 2026");
    expect(statementAsAt("2026-11-04")).toBe("As at 4 November 2026");
  });

  it("heads the amount column with the period", () => {
    expect(columnHeading("2026-10-01", "2026-10-31")).toBe("Oct 2026");
    expect(columnHeading("2026-06-01", "2026-11-04")).toBe("1 Jun-4 Nov 2026");
    expect(columnHeading("2025-06-01", "2026-05-31")).toBe("1 Jun 2025-31 May 2026");
    expect(columnHeading(null, "2026-11-04")).toBe("4 Nov 2026");
  });

  it("gives the produced time in New Zealand time, whatever the server's zone", () => {
    expect(producedAtText("2026-11-03T20:05:00.000Z")).toBe("4 Nov 2026, 9:05 am");
    expect(producedAtText("2026-07-01T02:30:00.000Z")).toBe("1 Jul 2026, 2:30 pm");
  });
});

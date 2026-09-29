import { describe, expect, it } from "vitest";
import { datesBetween, describeSchedule, nextDate } from "@/lib/repeating/schedule";

/** Examples RI1, RI5 and RI6 in docs/ACCOUNTING-EXAMPLES.md ("Repeating invoices"). */
describe("repeating invoice dates", () => {
  it("RI1: monthly from the 31st falls on each month's last day when it's shorter", () => {
    const schedule = { period: "month" as const, every: 1, startDate: "2026-01-31", endDate: null };
    expect(datesBetween(schedule, "2026-01-01", "2026-05-31")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    expect(nextDate(schedule, "2026-03-01")).toBe("2026-03-31");
    expect(describeSchedule(schedule)).toBe("Every month");
  });

  it("RI5: every 2 weeks until the end date", () => {
    const schedule = { period: "week" as const, every: 2, startDate: "2026-01-05", endDate: "2026-02-02" };
    expect(datesBetween(schedule, "2026-01-05", "2026-02-10")).toEqual(["2026-01-05", "2026-01-19", "2026-02-02"]);
    expect(nextDate(schedule, "2026-02-03")).toBeNull();
    expect(describeSchedule(schedule)).toBe("Every 2 weeks");
  });

  it("RI6: every 3 months from the 31st, and the 29th in a leap year", () => {
    const quarterly = { period: "month" as const, every: 3, startDate: "2026-08-31", endDate: null };
    expect(datesBetween(quarterly, "2026-08-31", "2027-05-31")).toEqual(["2026-08-31", "2026-11-30", "2027-02-28", "2027-05-31"]);
    const leap = { period: "month" as const, every: 1, startDate: "2028-01-29", endDate: null };
    expect(datesBetween(leap, "2028-01-01", "2028-03-31")).toEqual(["2028-01-29", "2028-02-29", "2028-03-29"]);
  });
});

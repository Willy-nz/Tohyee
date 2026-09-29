import { describe, expect, it } from "vitest";
import { chargeWithMarkup, durationMinutes, exactHours, formatMinutes, minutesAsHours, timeAmount, timeInvoiceLine } from "@/lib/projects/amounts";

/** Pure project maths from examples PJ3-PJ7 in docs/ACCOUNTING-EXAMPLES.md ("Projects and time tracking"). */
describe("project amounts", () => {
  it("PJ3: durations are whole minutes, from hours and minutes", () => {
    expect(durationMinutes("2", "30")).toBe(150);
    expect(durationMinutes("1", "15")).toBe(75);
    expect(durationMinutes("", "45")).toBe(45);
    expect(durationMinutes(4, null)).toBe(240);
    expect(durationMinutes("24", "0")).toBe(1440);
    expect(() => durationMinutes("0", "0")).toThrow("at least 1 minute");
    expect(() => durationMinutes("24", "1")).toThrow("at most 24 h");
    expect(() => durationMinutes("0", "1.5")).toThrow("whole number");
    expect(() => durationMinutes("-1", "0")).toThrow("whole number");
    expect([formatMinutes(150), formatMinutes(45), formatMinutes(240), formatMinutes(0)]).toEqual(["2 h 30 min", "45 min", "4 h", "0 min"]);
    expect(minutesAsHours(225)).toBe("3.75");
  });

  it("PJ3: time costs minutes x cost rate / 60, rounded to the cent", () => {
    expect(timeAmount(150, "40")).toBe("100.00");
    expect(timeAmount(75, "30")).toBe("37.50");
    expect(timeAmount(45, "40")).toBe("30.00");
    expect(timeAmount(240, "30")).toBe("120.00");
    expect(timeAmount(150, "0")).toBe("0.00");
    // 10 minutes at 33.33 is 5.555: half away from zero.
    expect(timeAmount(10, "33.33")).toBe("5.56");
  });

  it("PJ4: an expense's charge is cost x (100 + markup) / 100", () => {
    expect(chargeWithMarkup("200.00", "10")).toBe("220.00");
    expect(chargeWithMarkup("40.00", "0")).toBe("40.00");
    expect(chargeWithMarkup("33.33", "12.5")).toBe("37.50");
  });

  it("PJ5, PJ6: a task's time is invoiced as its hours at the rate", () => {
    expect(timeAmount(225, "90")).toBe("337.50");
    expect(timeInvoiceLine("Design", 225, "90.00")).toEqual({ description: "Design (3 h 45 min)", quantity: "3.75", unitPrice: "90", amount: "337.50" });
  });

  it("PJ7: hours that aren't exact to 4 places are invoiced as 1 at the amount", () => {
    expect(exactHours(12)).toBe("0.2");
    expect(exactHours(10)).toBeNull();
    expect(exactHours(3)).toBe("0.05");
    expect(timeInvoiceLine("Design", 10, "90")).toEqual({ description: "Design (10 min)", quantity: "1", unitPrice: "15.00", amount: "15.00" });
    expect(timeInvoiceLine("Design", 12, "90")).toEqual({ description: "Design (12 min)", quantity: "0.2", unitPrice: "90", amount: "18.00" });
  });
});

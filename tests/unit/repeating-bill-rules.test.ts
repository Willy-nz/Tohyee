import { describe, expect, it } from "vitest";
import { billDueDate, billNumberFor, describeBillDue, numberPatternProblem } from "@/lib/repeating/bill-rules";

/** Examples RB1-RB3 in docs/ACCOUNTING-EXAMPLES.md ("Repeating bills"): the pure number and due date rules. */
describe("repeating bill numbers and due dates", () => {
  it("RB1: a pattern needs {date} or {n}, or {month} when it repeats monthly", () => {
    expect(numberPatternProblem("RENT", "month")).toMatch(/needs \{date\} or \{n\} \(or \{month\}\)/);
    expect(numberPatternProblem("RENT-{month}", "month")).toBeNull();
    expect(numberPatternProblem("RENT-{month}", "week")).toMatch(/needs \{date\} or \{n\} in it/);
    expect(numberPatternProblem("W{n}", "week")).toBeNull();
    expect(numberPatternProblem("HP {date}", "week")).toBeNull();
    // RB11: no pattern is fine for drafts; approving needs a number.
    expect(numberPatternProblem("  ", "month")).toBeNull();
    expect(numberPatternProblem("", "month", "approve")).toMatch(/^Bills without a supplier's invoice number are saved as drafts/);
    expect(numberPatternProblem("RENT-{month}", "month", "approve")).toBeNull();
    expect(billNumberFor(null, "2026-01-31", 1)).toBeNull();
    expect(describeBillDue("terms", 0)).toBe("By the supplier's payment terms");
  });

  it("RB2: RENT-{month}, due the 20th of the following month", () => {
    expect([billNumberFor("RENT-{month}", "2026-01-31", 1), billDueDate("2026-01-31", "day_of_next_month", 20)]).toEqual(["RENT-2026-01", "2026-02-20"]);
    expect([billNumberFor("RENT-{month}", "2026-02-28", 2), billDueDate("2026-02-28", "day_of_next_month", 20)]).toEqual(["RENT-2026-02", "2026-03-20"]);
    expect(billDueDate("2026-12-31", "day_of_next_month", 31)).toBe("2027-01-31");
    expect(billDueDate("2026-01-15", "day_of_next_month", 31)).toBe("2026-02-28");
    expect(describeBillDue("day_of_next_month", 20)).toBe("20th of the following month");
  });

  it("RB3: {n} and {date} numbers; 30 days after the bill date; 7 days after the end of the bill month", () => {
    expect(billNumberFor("Invoice {n}", "2026-01-31", 1)).toBe("Invoice 1");
    expect(billNumberFor("HP {date}", "2026-02-28", 2)).toBe("HP 2026-02-28");
    expect(billDueDate("2026-01-31", "days_after", 30)).toBe("2026-03-02");
    expect(billDueDate("2026-02-28", "days_after", 30)).toBe("2026-03-30");
    expect(billDueDate("2026-01-31", "days_after_month_end", 7)).toBe("2026-02-07");
    expect(billDueDate("2026-02-10", "days_after_month_end", 7)).toBe("2026-03-07");
    expect(describeBillDue("days_after", 30)).toBe("30 days after the bill date");
    expect(describeBillDue("days_after", 0)).toBe("On the bill date");
  });
});

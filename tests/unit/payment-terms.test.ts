import { describe, expect, it } from "vitest";
import { describeTerm, dueDateFor } from "@/lib/customers/terms";

/** Example RC1 in docs/ACCOUNTING-EXAMPLES.md ("Richer customers"). */
describe("payment terms (RC1)", () => {
  it("20th of the following month", () => {
    const term = { kind: "day_of_next_month", days: 20 } as const;
    expect(dueDateFor("2026-06-15", term)).toBe("2026-07-20");
    expect(dueDateFor("2026-12-31", term)).toBe("2027-01-20");
    expect(describeTerm(term)).toBe("20th of the following month");
  });

  it("N days after the invoice date, and due on receipt", () => {
    expect(dueDateFor("2026-06-15", { kind: "days_after_invoice", days: 30 })).toBe("2026-07-15");
    expect(dueDateFor("2026-06-15", { kind: "days_after_invoice", days: 0 })).toBe("2026-06-15");
    expect(dueDateFor("2026-12-20", { kind: "days_after_invoice", days: 14 })).toBe("2027-01-03");
  });

  it("N days after the end of the invoice month", () => {
    expect(dueDateFor("2026-06-15", { kind: "days_after_month_end", days: 30 })).toBe("2026-07-30");
    expect(dueDateFor("2028-02-03", { kind: "days_after_month_end", days: 1 })).toBe("2028-03-01");
  });

  it("a day the following month doesn't have becomes its last day", () => {
    expect(dueDateFor("2026-01-10", { kind: "day_of_next_month", days: 31 })).toBe("2026-02-28");
    expect(dueDateFor("2028-01-10", { kind: "day_of_next_month", days: 31 })).toBe("2028-02-29");
    expect(describeTerm({ kind: "day_of_next_month", days: 31 })).toBe("31st of the following month");
    expect(describeTerm({ kind: "day_of_next_month", days: 12 })).toBe("12th of the following month");
    expect(describeTerm({ kind: "day_of_next_month", days: 22 })).toBe("22nd of the following month");
  });
});

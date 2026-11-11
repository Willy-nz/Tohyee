import { describe, expect, it } from "vitest";
import { cancellingPairs } from "@/lib/reports/cancelling-pairs";

const item = (journalLineId: string, date: string, amount: string, baseAmount = amount) => ({ journalLineId, date, amount, baseAmount });

/** BK46 in docs/ACCOUNTING-EXAMPLES.md (not yet reviewed). Made-up amounts. */
describe("pairs that cancel out", () => {
  it("BK46: leaves out exact opposites in the same month, each once", () => {
    const items = [
      item("1", "2026-10-10", "776.73"),
      item("2", "2026-10-12", "-776.73"),
      item("3", "2026-10-14", "-776.73"),
      item("4", "2026-10-31", "50.00"),
      item("5", "2026-11-01", "-50.00"),
      item("6", "2026-10-20", "-12.00"),
    ];
    // 1 and 2 cancel; 3 is left (nothing else to cancel it); 4 and 5 are in different months.
    expect([...cancellingPairs(items)].sort()).toEqual(["1", "2"]);
  });

  it("BK46: the base amounts must cancel too", () => {
    expect(cancellingPairs([item("1", "2026-10-01", "100.00", "160.00"), item("2", "2026-10-02", "-100.00", "-158.00")]).size).toBe(0);
  });
});

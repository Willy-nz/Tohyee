import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { bucketFor, dayBefore, daysBetween, emptyBuckets, toAmounts } from "@/lib/reports/ageing";

/** docs/ACCOUNTING-EXAMPLES.md, "Aged payables" and "Customer statements": the pure ageing maths. */
describe("ageing", () => {
  it("AGP1: days past due as at 31 July 2026 and their buckets", () => {
    expect(daysBetween("2026-03-31", "2026-07-31")).toBe(122);
    expect(daysBetween("2026-05-15", "2026-07-31")).toBe(77);
    expect(daysBetween("2026-07-20", "2026-07-31")).toBe(11);
    expect(daysBetween("2026-08-20", "2026-07-31")).toBe(-20);
    expect([122, 77, 11, -20].map(bucketFor)).toEqual(["over90", "days61to90", "days1to30", "current"]);
    // Due on the day is current; the edges of each bucket.
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(bucketFor)).toEqual([
      "current",
      "days1to30",
      "days1to30",
      "days31to60",
      "days31to60",
      "days61to90",
      "days61to90",
      "over90",
    ]);
  });

  it("AGP1: totals are the buckets less credit", () => {
    const buckets = emptyBuckets();
    buckets.current = dec("230.00");
    buckets.days1to30 = dec("115");
    buckets.days61to90 = dec("345.00");
    buckets.over90 = dec("200.00");
    buckets.credit = dec("23.00");
    expect(toAmounts(buckets, 2)).toEqual({
      current: "230.00",
      days1to30: "115.00",
      days31to60: "0.00",
      days61to90: "345.00",
      over90: "200.00",
      credit: "23.00",
      total: "867.00",
    });
  });

  it("CST1: the opening balance is the day before the start, across months and years", () => {
    expect(dayBefore("2026-06-01")).toBe("2026-05-31");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(dayBefore("2028-03-01")).toBe("2028-02-29");
    expect(dayBefore("2027-01-01")).toBe("2026-12-31");
  });
});

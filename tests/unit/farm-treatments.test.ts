import { describe, expect, it } from "vitest";
import { laterDate, meatSafeOn, milkSafeFrom, toBase, withholdingText } from "@/lib/farming/treatment-rules";

describe("withholding (TRT1-TRT2, decision 1432)", () => {
  it("counts meat days from the treatment day and milk hours from the end of it", () => {
    expect(meatSafeOn("2026-10-01", 14)).toBe("2026-10-15");
    expect(meatSafeOn("2026-10-01", null)).toBeNull();
    expect(milkSafeFrom("2026-10-01", 96)).toBe("2026-10-06");
    expect(milkSafeFrom("2026-10-01", 36)).toBe("2026-10-04");
    expect(milkSafeFrom("2026-10-01", 0)).toBe("2026-10-01");
    expect(laterDate("2026-10-05", null)).toBe("2026-10-05");
    expect(withholdingText({ meatSafeOn: "2026-10-15", milkSafeFrom: "2026-10-03" }, "2026-10-04")).toBe("Withholding: safe for slaughter from 2026-10-15");
    expect(withholdingText({ meatSafeOn: "2026-10-04", milkSafeFrom: null }, "2026-10-04")).toBeNull();
  });

  it("adds product stock in base units (TRT7)", () => {
    expect(toBase("250", "mL")).toEqual({ quantity: "0.25", unit: "L" });
    expect(toBase("1.5", "t")).toEqual({ quantity: "1500", unit: "kg" });
    expect(toBase("3", "doses")).toEqual({ quantity: "3", unit: "doses" });
    expect(toBase("3", "bottles")).toBeNull();
  });
});

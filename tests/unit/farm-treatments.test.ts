import { describe, expect, it } from "vitest";
import { laterDate, meatSafeOn, milkBasisText, milkSafeFrom, parseTimeGiven, safeText, toBase, withholdingText } from "@/lib/farming/treatment-rules";

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

  it("counts milk hours from the time given exactly, in the farm's time, when it's known (TRT2a)", () => {
    expect(milkSafeFrom("2026-10-01", 96, "07:30")).toBe("2026-10-05T07:30");
    expect(milkSafeFrom("2026-10-01", 36, "18:00")).toBe("2026-10-03T06:00");
    expect(milkSafeFrom("2026-10-01", 0, "07:30")).toBe("2026-10-01T07:30");
    // Across the start of daylight saving (27 Sep 2026, 2 am to 3 am): 48 real hours.
    expect(milkSafeFrom("2026-09-26", 48, "08:00")).toBe("2026-09-28T09:00");
    expect(milkBasisText("07:30")).toBe("from 7:30 am");
    expect(milkBasisText(null)).toBe("from end of day, no time given");
    expect(safeText("2026-10-05T07:30")).toBe("2026-10-05 7:30 am");
    expect(parseTimeGiven("7:30")).toBe("07:30");
    expect(parseTimeGiven("25:00")).toBeUndefined();
    expect(parseTimeGiven("")).toBeNull();
    expect(withholdingText({ meatSafeOn: null, milkSafeFrom: "2026-10-05T07:30" }, "2026-10-05")).toBe("Withholding: milk safe from 2026-10-05 7:30 am");
    expect(laterDate("2026-10-06", "2026-10-06T07:30")).toBe("2026-10-06T07:30");
  });

  it("adds product stock in base units (TRT7)", () => {
    expect(toBase("250", "mL")).toEqual({ quantity: "0.25", unit: "L" });
    expect(toBase("1.5", "t")).toEqual({ quantity: "1500", unit: "kg" });
    expect(toBase("3", "doses")).toEqual({ quantity: "3", unit: "doses" });
    expect(toBase("3", "bottles")).toBeNull();
  });
});

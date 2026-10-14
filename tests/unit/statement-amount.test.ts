import { describe, expect, it } from "vitest";
import { statementAmount } from "@/lib/reports/financial-statements";

describe("statement amounts (FS3)", () => {
  it("groups thousands, brackets negatives and shows nothing as a dash", () => {
    expect(statementAmount("1234.56")).toBe("1,234.56");
    expect(statementAmount("1234567.00")).toBe("1,234,567.00");
    expect(statementAmount("-300.00")).toBe("(300.00)");
    expect(statementAmount("0.00")).toBe("-");
    expect(statementAmount("-0.00")).toBe("-");
    expect(statementAmount("12.50")).toBe("12.50");
    expect(statementAmount(null)).toBe("");
  });
});

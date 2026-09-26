import { describe, expect, it } from "vitest";
import { formatGstNumber } from "@/lib/format";

describe("formatGstNumber", () => {
  it("groups 9- and 8-digit GST numbers", () => {
    expect(formatGstNumber("123456789")).toBe("123-456-789");
    expect(formatGstNumber("12345678")).toBe("12-345-678");
  });

  it("leaves anything else as it is", () => {
    expect(formatGstNumber(null)).toBe("");
    expect(formatGstNumber("")).toBe("");
    expect(formatGstNumber("1234")).toBe("1234");
    expect(formatGstNumber("1234567890")).toBe("1234567890");
  });
});

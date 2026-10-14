import { describe, expect, it } from "vitest";
import { akahuAccountNumber } from "@/lib/bank/akahu/settings";

describe("Akahu account numbers for spotting a joint account linked twice (#257)", () => {
  it("treats a 2- and 3-digit NZ suffix as the same account", () => {
    expect(akahuAccountNumber("03-0123-0456789-00")).toBe("0301230456789000");
    expect(akahuAccountNumber("03-0123-0456789-00")).toBe(akahuAccountNumber("03-0123-0456789-000"));
    expect(akahuAccountNumber("03 0123 0456789 000")).toBe("0301230456789000");
    expect(akahuAccountNumber("03-0123-0456789-01")).not.toBe(akahuAccountNumber("03-0123-0456789-00"));
  });

  it("keeps other numbers as digits, and ignores what isn't a number", () => {
    expect(akahuAccountNumber("GB33 BUKB 2020 1555 5555 55")).toBe("3320201555555555");
    expect(akahuAccountNumber("12")).toBeNull();
    expect(akahuAccountNumber(null)).toBeNull();
    expect(akahuAccountNumber(undefined)).toBeNull();
  });
});

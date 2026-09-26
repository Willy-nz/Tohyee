import { describe, expect, it } from "vitest";
import {
  add,
  cmp,
  dec,
  divide,
  mul,
  mulDiv,
  parseDecimalInput,
  roundHalfUp,
  sub,
  toFixedString,
  toPlainString,
} from "@/lib/money/decimal";

const s = (value: ReturnType<typeof dec>) => toPlainString(value);

describe("exact decimals", () => {
  it("R1: adds and subtracts across different scales without floating point", () => {
    expect(s(add(dec("0.1"), dec("0.2")))).toBe("0.3");
    expect(s(sub(dec("1.20"), dec("0.3")))).toBe("0.9");
    expect(s(add(dec("-1.20"), dec("0.30")))).toBe("-0.9");
  });

  it("multiplies exactly", () => {
    expect(s(mul(dec("999"), dec("2.57")))).toBe("2567.43");
    expect(s(mul(dec("1.5"), dec("-0.25")))).toBe("-0.375");
  });

  it("divides correctly when the two numbers have different decimal places", () => {
    // Regression: an earlier version returned 333 here (scaled by the wrong operand).
    expect(s(divide(dec("9.99"), dec("3"), 8))).toBe("3.33");
    expect(s(divide(dec("2567.43"), dec("999"), 2))).toBe("2.57");
    expect(s(divide(dec("6.66666667"), dec("2"), 8))).toBe("3.33333334");
    expect(s(divide(dec("10"), dec("2.5"), 4))).toBe("4");
  });

  it("R3: rounds half away from zero", () => {
    expect(s(roundHalfUp(dec("2.345"), 2))).toBe("2.35");
    expect(s(roundHalfUp(dec("2.344"), 2))).toBe("2.34");
    expect(s(roundHalfUp(dec("-2.345"), 2))).toBe("-2.35");
    expect(s(divide(dec("10"), dec("3"), 2))).toBe("3.33");
    expect(s(divide(dec("20"), dec("3"), 2))).toBe("6.67");
    expect(s(divide(dec("-20"), dec("3"), 2))).toBe("-6.67");
  });

  it("computes a*b/c with a single rounding", () => {
    // 1 unit out of 3 worth $10.00 -> $3.33; 2 units -> $6.67
    expect(s(mulDiv(dec("1"), dec("10"), dec("3"), 2))).toBe("3.33");
    expect(s(mulDiv(dec("2"), dec("10"), dec("3"), 2))).toBe("6.67");
  });

  it("compares and formats", () => {
    expect(cmp(dec("1.50"), dec("1.5"))).toBe(0);
    expect(cmp(dec("1.05"), dec("1.5"))).toBe(-1);
    expect(toFixedString(dec("3.5"), 2)).toBe("3.50");
    expect(toFixedString(dec("-0.004"), 2)).toBe("0.00");
  });
});

describe("parseDecimalInput", () => {
  it("accepts plain numbers and normalises them", () => {
    expect(parseDecimalInput("12.50", "amount", { maxScale: 2 })).toBe("12.5");
    expect(parseDecimalInput(0.1, "amount", { maxScale: 2 })).toBe("0.1");
    expect(parseDecimalInput("100.00", "amount", { maxScale: 2 })).toBe("100");
  });

  it("rejects too many decimal places for the currency", () => {
    expect(() => parseDecimalInput("3.333", "amount", { maxScale: 2 })).toThrow(/at most 2 decimal places/);
    expect(() => parseDecimalInput("3.5", "amount", { maxScale: 0 })).toThrow(/whole number/);
  });

  it("rejects negatives, zero and junk unless allowed", () => {
    expect(() => parseDecimalInput("-1", "amount", { maxScale: 2 })).toThrow(/negative/);
    expect(() => parseDecimalInput("0", "amount", { maxScale: 2 })).toThrow(/zero/);
    expect(parseDecimalInput("0", "amount", { maxScale: 2, allowZero: true })).toBe("0");
    expect(() => parseDecimalInput("1e5", "amount", { maxScale: 2 })).toThrow(/plain number/);
    expect(() => parseDecimalInput("12,00", "amount", { maxScale: 2 })).toThrow(/plain number/);
    expect(() => parseDecimalInput(null, "amount", { maxScale: 2 })).toThrow(/must be a number/);
  });
});

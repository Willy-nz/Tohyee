import { describe, expect, it } from "vitest";
import { akahuMoney } from "@/lib/bank/akahu/client";
import { lineFromAkahu } from "@/lib/bank/akahu/sync";
import { abs, dec, neg, toFixedString } from "@/lib/money/decimal";

/** Issue #147: Akahu's JSON numbers become money as decimals, never through toFixed. */
describe("Akahu money", () => {
  it("keeps cents exactly, with two places", () => {
    expect(akahuMoney(-46, "amount")).toBe("-46.00");
    expect(akahuMoney(115, "amount")).toBe("115.00");
    expect(akahuMoney(0.1, "amount")).toBe("0.10");
    expect(akahuMoney(-1234567.89, "amount")).toBe("-1234567.89");
    expect(akahuMoney(0, "balance")).toBe("0.00");
  });

  it("refuses anything finer than cents rather than rounding it", () => {
    // (1.005).toFixed(2) is "1.00": the half cent would quietly go.
    expect(() => akahuMoney(1.005, "Akahu's amount for transaction trans_1")).toThrow("Akahu's amount for transaction trans_1 can have at most 2 decimal places.");
    expect(() => akahuMoney(1e-7, "Akahu's amount")).toThrow("Akahu's amount must be a plain number like 12.34.");
    expect(() => akahuMoney(Number.NaN, "Akahu's amount")).toThrow("Akahu's amount must be a number.");
  });

  it("a statement line from a transaction", () => {
    const line = lineFromAkahu({
      _id: "trans_1",
      _account: "acc_1",
      date: "2026-05-20T12:00:00.000Z",
      description: "Z ENERGY",
      amount: -46,
      balance: 1203.5,
      merchant: { name: "Z Energy" },
    });
    expect(line).toMatchObject({ date: "2026-05-21", amount: "-46.00", balance: "1203.50", externalId: "akahu:trans_1" });
    expect(() =>
      lineFromAkahu({ _id: "trans_2", _account: "acc_1", date: "2026-05-20T12:00:00.000Z", description: "x", amount: 1.005 }),
    ).toThrow("Akahu's amount for transaction trans_2 can have at most 2 decimal places.");
  });

  it("a card owing nothing is 0.00, not -0.00", () => {
    expect(toFixedString(neg(abs(dec(akahuMoney(0, "account balance")))), 2)).toBe("0.00");
  });
});

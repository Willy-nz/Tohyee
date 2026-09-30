import { describe, expect, it } from "vitest";
import { parsePastedRates, rateInEffect } from "@/lib/fx/rate-text";

/** Examples MC52-MC53 (pasted rates and the rate in effect), not yet approved by Jess. */
describe("pasted exchange rates", () => {
  it("MC53: reads commas or tabs, NZ or ISO dates, skips a heading and blank lines", () => {
    expect(parsePastedRates("Currency,Date,Rate,Note\nUSD,31/08/2026,1.62,RBNZ month end\n\nEUR\t2026-08-31\t1.85\r\ngbp, 1/9/2026, 2.05\n")).toEqual([
      { line: 2, currencyCode: "USD", effectiveDate: "2026-08-31", rate: "1.62", note: "RBNZ month end" },
      { line: 4, currencyCode: "EUR", effectiveDate: "2026-08-31", rate: "1.85", note: null },
      { line: 5, currencyCode: "gbp", effectiveDate: "2026-09-01", rate: "2.05", note: null },
    ]);
  });

  it("MC53: refuses a line without three values, and nothing pasted", () => {
    expect(() => parsePastedRates("USD, 2026-08-31\n")).toThrow(/Line 1: expected currency, effective date, rate/);
    expect(() => parsePastedRates("USD, 2026-08-31, , x\n")).toThrow(/Line 1/);
    expect(() => parsePastedRates("  \n")).toThrow(/Paste at least one rate/);
    expect(() => parsePastedRates("Currency,Date,Rate\n")).toThrow(/Paste at least one rate/);
  });
});

describe("the rate in effect", () => {
  const rates = [
    { currencyCode: "USD", effectiveDate: "2026-08-31", rate: "1.62", archivedAt: null },
    { currencyCode: "USD", effectiveDate: "2026-08-01", rate: "1.66", archivedAt: "2026-08-02T00:00:00.000Z" },
    { currencyCode: "USD", effectiveDate: "2026-08-01", rate: "1.65", archivedAt: null },
    { currencyCode: "USD", effectiveDate: "2026-07-01", rate: "1.6", archivedAt: null },
  ];

  it("MC48, MC53: the latest effective date on or before the date, archived entries skipped", () => {
    expect(rateInEffect(rates, "USD", "2026-08-31")?.rate).toBe("1.62");
    expect(rateInEffect(rates, "USD", "2026-08-15")?.rate).toBe("1.65");
    expect(rateInEffect(rates, "USD", "2026-07-01")?.rate).toBe("1.6");
    expect(rateInEffect(rates, "USD", "2026-06-30")).toBeNull();
    expect(rateInEffect(rates, "EUR", "2026-08-31")).toBeNull();
  });
});

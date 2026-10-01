import { describe, expect, it } from "vitest";
import { add, cmp, dec, mul, sub, toPlainString } from "@/lib/money/decimal";
import { RATES_2025_26 } from "@/lib/payroll/rates/2025-26";
import { RATES_2026_27 } from "@/lib/payroll/rates/2026-27";
import { type Dated, PAYROLL_RATE_EDITIONS, type PayrollRatesEdition, payrollRatesOn } from "@/lib/payroll/rates";

function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function datedLists(edition: PayrollRatesEdition): [string, Dated<unknown>[]][] {
  return [
    ["incomeTax", edition.incomeTax],
    ["accEarnersLevy", edition.accEarnersLevy],
    ["independentEarnerTaxCredit", edition.independentEarnerTaxCredit],
    ["secondaryTaxRates", edition.secondaryTaxRates],
    ["flatTaxRates", edition.flatTaxRates],
    ["studentLoan", edition.studentLoan],
    ["kiwiSaver", edition.kiwiSaver],
    ["esct", edition.esct],
  ];
}

/** Rate + levy, as the spec prints it (e.g. "12.25"). */
function withLevy(rate: string, levy: string): string {
  return toPlainString(add(dec(rate), dec(levy)));
}

describe("IRD payroll rates by pay date", () => {
  it("PR1: picks the edition covering the pay date", () => {
    expect(payrollRatesOn("2025-04-01").edition.id).toBe("2025-26");
    expect(payrollRatesOn("2026-03-31").edition.id).toBe("2025-26");
    expect(payrollRatesOn("2026-04-01").edition.id).toBe("2026-27");
    expect(payrollRatesOn("2027-03-31").edition.id).toBe("2026-27");
    expect(payrollRatesOn("2026-03-31").accEarnersLevy.rate).toBe("1.67");
    expect(payrollRatesOn("2026-04-01").accEarnersLevy.rate).toBe("1.75");
  });

  it("PR1: refuses pay dates no edition covers, and bad dates", () => {
    expect(() => payrollRatesOn("2025-03-31")).toThrow(
      "Not supported yet (refused rather than guessed): Tohyee has no IRD payroll rates for pay dates on 2025-03-31",
    );
    expect(() => payrollRatesOn("2027-04-01")).toThrow("Not supported yet (refused rather than guessed)");
    expect(() => payrollRatesOn("2026-02-30")).toThrow("not a real date");
    expect(() => payrollRatesOn("1/4/2026")).toThrow("YYYY-MM-DD");
  });

  it("PR1: picks a value by its own dates when an edition has several", () => {
    const split: PayrollRatesEdition = {
      ...RATES_2026_27,
      accEarnersLevy: [
        { ...RATES_2026_27.accEarnersLevy[0], to: "2026-09-30" },
        {
          ...RATES_2026_27.accEarnersLevy[0],
          from: "2026-10-01",
          value: { ...RATES_2026_27.accEarnersLevy[0].value, rate: "9.99" },
        },
      ],
    };
    const editions = [RATES_2025_26, split];
    expect(payrollRatesOn("2026-09-30", editions).accEarnersLevy.rate).toBe("1.75");
    expect(payrollRatesOn("2026-10-01", editions).accEarnersLevy.rate).toBe("9.99");
    expect(payrollRatesOn("2026-10-01", editions).incomeTax).toBe(RATES_2026_27.incomeTax[0].value);
  });
});

describe("IRD payroll rate files", () => {
  it("editions are in order, a year each, with no gaps or overlaps", () => {
    expect(PAYROLL_RATE_EDITIONS.map((edition) => edition.id)).toEqual(["2025-26", "2026-27"]);
    PAYROLL_RATE_EDITIONS.forEach((edition, index) => {
      const startYear = Number(edition.from.slice(0, 4));
      expect(edition.from).toBe(`${startYear}-04-01`);
      expect(edition.to).toBe(`${startYear + 1}-03-31`);
      expect(edition.id).toBe(`${startYear}-${String(startYear + 1).slice(2)}`);
      if (index > 0) {
        expect(edition.from).toBe(nextDay(PAYROLL_RATE_EDITIONS[index - 1].to));
      }
    });
  });

  it("every rate covers its edition's whole year exactly once and cites the spec", () => {
    for (const edition of PAYROLL_RATE_EDITIONS) {
      for (const [name, list] of datedLists(edition)) {
        expect(list.length, `${edition.id} ${name}`).toBeGreaterThan(0);
        expect(list[0].from, `${edition.id} ${name}`).toBe(edition.from);
        expect(list[list.length - 1].to, `${edition.id} ${name}`).toBe(edition.to);
        list.forEach((entry, index) => {
          expect(entry.from <= entry.to, `${edition.id} ${name}`).toBe(true);
          expect(entry.source, `${edition.id} ${name}`).toMatch(/page/);
          if (index > 0) {
            expect(entry.from, `${edition.id} ${name}`).toBe(nextDay(list[index - 1].to));
          }
        });
      }
    }
  });

  it("names, edition, URL, read date and hash of every IRD document", () => {
    for (const edition of PAYROLL_RATE_EDITIONS) {
      for (const document of [edition.specification, ...edition.crossChecks]) {
        expect(document.document).not.toBe("");
        expect(document.edition).not.toBe("");
        expect(document.url).toMatch(/^https:\/\/www\.ird\.govt\.nz\/.+\.pdf$/);
        expect(document.read).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(edition.specification.document).toBe("Payroll Calculations & Business Rules Specification");
    }
    expect(RATES_2025_26.specification.edition).toContain("1 April 2025 to 31 March 2026");
    expect(RATES_2026_27.specification.edition).toContain("1 April 2026 to 31 March 2027");
  });

  it("income tax brackets join up and the spec's subtractions match the rates", () => {
    for (const edition of PAYROLL_RATE_EDITIONS) {
      for (const { value: brackets } of edition.incomeTax) {
        expect(brackets[0].from).toBe("0");
        expect(brackets[0].subtract).toBe("0");
        expect(brackets[brackets.length - 1].to).toBeNull();
        for (let index = 1; index < brackets.length; index += 1) {
          const previous = brackets[index - 1];
          const bracket = brackets[index];
          expect(bracket.from).toBe(String(Number(previous.to) + 1));
          // At the boundary both formulas give the same tax, so the subtraction
          // is the previous one plus the rate change on the boundary.
          const boundary = dec(previous.to as string);
          const expected = add(
            dec(previous.subtract),
            mul(boundary, mul(sub(dec(bracket.rate), dec(previous.rate)), dec("0.01"))),
          );
          expect(cmp(dec(bracket.subtract), expected), `${edition.id} ${bracket.from}`).toBe(0);
        }
      }
    }
  });

  it("ESCT bands join up", () => {
    for (const edition of PAYROLL_RATE_EDITIONS) {
      for (const { value: bands } of edition.esct) {
        expect(bands[0].from).toBe("0");
        expect(bands[bands.length - 1].to).toBeNull();
        for (let index = 1; index < bands.length; index += 1) {
          expect(bands[index].from).toBe(String(Number(bands[index - 1].to) + 1));
        }
      }
    }
  });

  it("PR1: rates plus the levy are the combined rates each spec prints", () => {
    const check = (edition: PayrollRatesEdition, printed: Record<string, string>) => {
      const levy = edition.accEarnersLevy[0].value.rate;
      const rates = { ...edition.secondaryTaxRates[0].value, ...edition.flatTaxRates[0].value };
      expect(
        Object.fromEntries(Object.entries(rates).map(([code, rate]) => [code, withLevy(rate, levy)])),
      ).toEqual(printed);
    };
    // 2025-26 spec 5.5-5.8, pages 20-25; 2026-27 spec 5.5-5.8, pages 26-31.
    check(RATES_2025_26, {
      SB: "12.17",
      S: "19.17",
      SH: "31.67",
      ST: "34.67",
      SA: "40.67",
      ND: "46.67",
      NSW: "12.17",
      CAE: "19.17",
      EDW: "19.17",
    });
    check(RATES_2026_27, {
      SB: "12.25",
      S: "19.25",
      SH: "31.75",
      ST: "34.75",
      SA: "40.75",
      ND: "46.75",
      NSW: "12.25",
      CAE: "19.25",
      EDW: "19.25",
    });
  });

  it("PR1: KiwiSaver rates by year", () => {
    expect(payrollRatesOn("2026-03-31").kiwiSaver).toEqual({
      employeeRates: ["3", "4", "6", "8", "10"],
      defaultEmployeeRate: "3",
      minimumEmployerRate: "3",
      temporaryRateReduction: null,
    });
    expect(payrollRatesOn("2026-04-01").kiwiSaver).toEqual({
      employeeRates: ["3.5", "4", "6", "8", "10"],
      defaultEmployeeRate: "3.5",
      minimumEmployerRate: "3.5",
      temporaryRateReduction: { employeeRate: "3", employerRate: "3" },
    });
  });
});

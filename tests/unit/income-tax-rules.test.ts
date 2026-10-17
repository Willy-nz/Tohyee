import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import {
  endOfYearTaxDue,
  incomeYearLabel,
  incomeYearDates,
  incomeYearOf,
  instalmentDates,
  onTimeBy,
  standardSchedule,
  suggestedIncomeYear,
  taxOn,
  workpaper,
  type WorkpaperAccount,
} from "@/lib/tax/income/rules";

const account = (code: string, name: string, side: "income" | "expense", amount: string, treatment: WorkpaperAccount["treatment"] = "full", businessUsePercent: string | null = null): WorkpaperAccount => ({
  accountId: code,
  code,
  name,
  side,
  amount: dec(amount),
  treatment,
  businessUsePercent: businessUsePercent === null ? null : dec(businessUsePercent),
});

describe("income tax rules (ITX1-ITX10, from IRD's published rules, not yet reviewed)", () => {
  it("ITX1 income years run 1 April to 31 March", () => {
    expect(incomeYearLabel(2026)).toBe("2026 income year (1 Apr 2025 to 31 Mar 2026)");
    expect(incomeYearOf("2026-03-31")).toBe(2026);
    expect(incomeYearOf("2026-04-01")).toBe(2027);
  });

  it("ITX3 a company's accounting profit to taxable income, tax and RIT", () => {
    const result = workpaper({
      type: "company",
      year: 2026,
      accounts: [
        account("4000", "Sales", "income", "480000"),
        account("7040", "Capital gains on disposal of fixed assets", "income", "3000", "not_taxable"),
        account("5000", "Purchases", "expense", "180000"),
        account("6100", "Wages", "expense", "150000"),
        account("6200", "Entertainment", "expense", "2400", "entertainment_50"),
        account("6210", "Fines", "expense", "350", "not_deductible"),
        account("6220", "Motor vehicle", "expense", "9000", "business_use", "80"),
        account("6300", "Depreciation", "expense", "12000"),
        account("6900", "Other expenses", "expense", "60000"),
      ],
      typedAdjustments: [{ description: "Holiday pay accrued but not paid within 63 days", amount: dec("4000") }],
      otherIncome: dec("0"),
      lossesBroughtForward: dec("10000"),
      taxCredits: dec("140"),
    });
    expect(result.netProfit).toBe("69250.00");
    expect(result.adjustments.map((entry) => [entry.description, entry.amount])).toEqual([
      ["7040 Capital gains on disposal of fixed assets: not taxable", "-3000.00"],
      ["6200 Entertainment: entertainment, half not deductible", "1200.00"],
      ["6210 Fines: not deductible", "350.00"],
      ["6220 Motor vehicle: private use (20%)", "1800.00"],
      ["Holiday pay accrued but not paid within 63 days", "4000.00"],
    ]);
    expect(result).toMatchObject({
      beforeLosses: "73600.00",
      lossesUsed: "10000.00",
      taxableIncome: "63600.00",
      lossCarriedForward: "0.00",
      tax: "17808.00",
      taxCredits: "140.00",
      rit: "17668.00",
    });
  });

  it("ITX4 individual rates for 2026 and 2025, rounded once", () => {
    expect(taxOn(dec("71000"), "individual", 2026)).toEqual(dec("13520.50"));
    expect(taxOn(dec("71000"), "individual", 2025)).toEqual(dec("13795.22"));
    const result = workpaper({
      type: "individual",
      year: 2026,
      accounts: [account("4000", "Sales", "income", "100000"), account("6000", "Costs", "expense", "30000")],
      typedAdjustments: [],
      otherIncome: dec("1000"),
      lossesBroughtForward: dec("0"),
      taxCredits: dec("330"),
    });
    expect(result).toMatchObject({ taxableIncome: "71000.00", tax: "13520.50", rit: "13190.50" });
    // A loss gives no tax and is carried forward with what wasn't used.
    const loss = workpaper({
      type: "company",
      year: 2026,
      accounts: [account("4000", "Sales", "income", "10000"), account("6000", "Costs", "expense", "15000")],
      typedAdjustments: [],
      otherIncome: dec("0"),
      lossesBroughtForward: dec("2000"),
      taxCredits: dec("100"),
    });
    expect(loss).toMatchObject({ taxableIncome: "-5000.00", tax: "0.00", lossesUsed: "0.00", lossCarriedForward: "7000.00", taxToPay: "-100.00", rit: "0.00" });
  });

  it("ITX5 standard option with last year's return filed on time", () => {
    const schedule = standardSchedule({
      year: 2027,
      instalmentCount: 3,
      lastYear: { amount: dec("17668"), typed: true },
      lastYearFiledOn: "2026-06-20",
      twoYearsAgo: null,
      payments: [],
      today: "2026-10-16",
    });
    expect(schedule.kind).toBe("schedule");
    if (schedule.kind !== "schedule") return;
    expect(schedule.instalments.map((instalment) => [instalment.dueDate, instalment.amount])).toEqual([
      ["2026-08-28", "6183.80"],
      ["2027-01-15", "6183.80"],
      ["2027-05-07", "6183.80"],
    ]);
    expect(schedule.total).toBe("18551.40");
    // Amounts that don't divide evenly: the last instalment is what's left.
    const uneven = standardSchedule({ year: 2027, instalmentCount: 3, lastYear: { amount: dec("10000"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16" });
    expect(uneven.kind === "schedule" && uneven.instalments.map((instalment) => instalment.amount)).toEqual(["3500.00", "3500.00", "3500.00"]);
    const odd = standardSchedule({ year: 2027, instalmentCount: 3, lastYear: { amount: dec("10000.01"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16" });
    expect(odd.kind === "schedule" && odd.instalments.map((instalment) => instalment.amount)).toEqual(["3500.00", "3500.00", "3500.01"]);
  });

  it("ITX6 last year's return filed late: two years ago plus 10% until it's filed", () => {
    const base = { year: 2027, instalmentCount: 3 as const, lastYear: { amount: dec("17668"), typed: true }, twoYearsAgo: dec("12000"), today: "2027-02-01" };
    const afterFirst = standardSchedule({
      ...base,
      lastYearFiledOn: "2026-10-10",
      payments: [
        { date: "2026-08-28", amount: dec("4400") },
        { date: "2027-01-14", amount: dec("7967.60") },
      ],
    });
    expect(afterFirst.kind === "schedule" && afterFirst.instalments.map((instalment) => instalment.amount)).toEqual(["4400.00", "7967.60", "6183.80"]);
    // An instalment that's due and not paid is caught up in the next one.
    const unpaid = standardSchedule({ ...base, lastYearFiledOn: "2026-10-10", payments: [{ date: "2026-08-28", amount: dec("4400") }] });
    expect(unpaid.kind === "schedule" && unpaid.instalments.map((instalment) => instalment.amount)).toEqual(["4400.00", "7967.60", "14151.40"]);
    // The shortfall is counted once: instalment 3's own share is 6,183.80 and 7,967.60 of it is caught up; the year's total
    // stays 18,551.40 (it was once the sum of what's due, 26,519.00).
    if (unpaid.kind !== "schedule") throw new Error("expected a schedule");
    expect(unpaid.instalments.map((instalment) => [instalment.ownAmount, instalment.catchUp])).toEqual([["4400.00", "0.00"], ["7967.60", "0.00"], ["6183.80", "7967.60"]]);
    expect(unpaid.total).toBe("18551.40");
    expect(afterFirst.kind === "schedule" && afterFirst.total).toBe("18551.40");
    // Before the second instalment is due, it's assumed paid as worked out.
    const early = standardSchedule({ ...base, today: "2026-10-16", lastYearFiledOn: "2026-10-10", payments: [{ date: "2026-08-28", amount: dec("4400") }] });
    expect(early.kind === "schedule" && early.instalments.map((instalment) => instalment.amount)).toEqual(["4400.00", "7967.60", "6183.80"]);
    const afterSecond = standardSchedule({
      ...base,
      today: "2027-03-01",
      lastYearFiledOn: "2027-02-20",
      payments: [
        { date: "2026-08-28", amount: dec("4400") },
        { date: "2027-01-15", amount: dec("4400") },
      ],
    });
    expect(afterSecond.kind === "schedule" && afterSecond.instalments.map((instalment) => instalment.amount)).toEqual(["4400.00", "4400.00", "9751.40"]);
    // Not filed yet: the last instalment uses Tohyee's estimate and says so.
    const notFiled = standardSchedule({ ...base, lastYear: { amount: dec("17668"), typed: false }, lastYearFiledOn: null, payments: [], today: "2026-08-01" });
    expect(notFiled.kind === "schedule" && notFiled.instalments.map((instalment) => [instalment.amount, instalment.estimate])).toEqual([
      ["4400.00", false],
      ["4400.00", false],
      ["9751.40", true],
    ]);
    // Without the RIT from two years ago, it says what to type.
    const missing = standardSchedule({ ...base, twoYearsAgo: null, lastYearFiledOn: "2026-10-10", payments: [] });
    expect(missing.kind).toBe("unknown");
    expect(missing.notes[0]).toContain("2025 income year plus 10%");
    expect(afterFirst.kind === "schedule" && afterFirst.instalments[1].basis).toBe("RIT for the 2026 income year: 17,668.00 + 5% = 18,551.40, x 2 ÷ 3 = 12,367.60, less 4,400.00 paid towards the year before 15 Jan 2027");
  });

  it("ITX7 six-monthly GST filers pay twice", () => {
    const schedule = standardSchedule({ year: 2027, instalmentCount: 2, lastYear: { amount: dec("17668"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16" });
    expect(schedule.kind === "schedule" && schedule.instalments.map((instalment) => [instalment.dueDate, instalment.amount])).toEqual([
      ["2026-10-28", "9275.70"],
      ["2027-05-07", "9275.70"],
    ]);
    const late = standardSchedule({ year: 2027, instalmentCount: 2, lastYear: { amount: dec("17668"), typed: true }, lastYearFiledOn: "2026-11-01", twoYearsAgo: dec("12000"), payments: [], today: "2026-11-16" });
    expect(late.kind).toBe("unknown");
  });

  it("ITX8 last year's RIT of 5,000 or less means no instalments", () => {
    const schedule = standardSchedule({ year: 2027, instalmentCount: 3, lastYear: { amount: dec("4800"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16" });
    expect(schedule.kind).toBe("not_provisional");
    expect(standardSchedule({ year: 2027, instalmentCount: 3, lastYear: { amount: dec("5000"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16" }).kind).toBe("not_provisional");
    expect(standardSchedule({ year: 2027, instalmentCount: 3, lastYear: null, lastYearFiledOn: null, twoYearsAgo: null, payments: [], today: "2026-10-16" }).kind).toBe("unknown");
  });

  it("ITX10 due dates move to the next business day", () => {
    expect(endOfYearTaxDue(2026, false)).toBe("2027-02-07");
    expect(endOfYearTaxDue(2026, true)).toBe("2027-04-07");
    // Sunday 7 Feb 2027; Waitangi Day (Saturday 6 Feb) is observed Monday 8 Feb.
    expect(onTimeBy("2027-02-07")).toEqual({ date: "2027-02-09", holidaysChecked: true });
    expect(onTimeBy("2027-08-28")).toEqual({ date: "2027-08-30", holidaysChecked: true });
    expect(onTimeBy("2026-08-28")).toEqual({ date: "2026-08-28", holidaysChecked: true });
    expect(onTimeBy("2026-02-07")).toEqual({ date: "2026-02-09", holidaysChecked: true });
    // Years not on the holiday list: weekends only, and it says so.
    expect(onTimeBy("2030-02-07")).toEqual({ date: "2030-02-07", holidaysChecked: false });
  });

  it("ITX38 suggests the income year a payment is towards", () => {
    expect(["2026-08-28", "2027-01-15", "2027-02-07", "2027-03-20", "2027-04-07", "2027-05-07", "2027-06-30", "2027-07-15"].map((date) => suggestedIncomeYear(date))).toEqual([2027, 2027, 2026, 2026, 2026, 2027, null, null]);
  });

  it("ITX41 income years for late and early balance dates (SPS 24/01)", () => {
    expect(incomeYearDates(2026, 5)).toEqual({ start: "2025-06-01", end: "2026-05-31" });
    expect(incomeYearDates(2026, 10)).toEqual({ start: "2024-11-01", end: "2025-10-31" });
    expect(incomeYearDates(2026, 1)).toEqual({ start: "2025-02-01", end: "2026-01-31" });
    expect(incomeYearOf("2026-05-31", 5)).toBe(2026);
    expect(incomeYearOf("2026-06-01", 5)).toBe(2027);
    expect(incomeYearOf("2025-10-31", 10)).toBe(2026);
  });

  it("ITX42 instalment dates match every row of schedule 3 part A", () => {
    // Income Tax Act 2007 schedule 3 part A: for each balance date month, the dates in the 3rd to 14th months after it.
    const table: Record<number, string[]> = {
      10: ["28 Jan", "28 Feb", "28 Mar", "7 May", "28 May", "28 Jun", "28 Jul", "28 Aug", "28 Sep", "28 Oct", "28 Nov", "15 Jan"],
      11: ["28 Feb", "28 Mar", "7 May", "28 May", "28 Jun", "28 Jul", "28 Aug", "28 Sep", "28 Oct", "28 Nov", "15 Jan", "28 Jan"],
      12: ["28 Mar", "7 May", "28 May", "28 Jun", "28 Jul", "28 Aug", "28 Sep", "28 Oct", "28 Nov", "15 Jan", "28 Jan", "28 Feb"],
      1: ["7 May", "28 May", "28 Jun", "28 Jul", "28 Aug", "28 Sep", "28 Oct", "28 Nov", "15 Jan", "28 Jan", "28 Feb", "28 Mar"],
      2: ["28 May", "28 Jun", "28 Jul", "28 Aug", "28 Sep", "28 Oct", "28 Nov", "15 Jan", "28 Jan", "28 Feb", "28 Mar", "7 May"],
      3: ["28 Jun", "28 Jul", "28 Aug", "28 Sep", "28 Oct", "28 Nov", "15 Jan", "28 Jan", "28 Feb", "28 Mar", "7 May", "28 May"],
      4: ["28 Jul", "28 Aug", "28 Sep", "28 Oct", "28 Nov", "15 Jan", "28 Jan", "28 Feb", "28 Mar", "7 May", "28 May", "28 Jun"],
      5: ["28 Aug", "28 Sep", "28 Oct", "28 Nov", "15 Jan", "28 Jan", "28 Feb", "28 Mar", "7 May", "28 May", "28 Jun", "28 Jul"],
      6: ["28 Sep", "28 Oct", "28 Nov", "15 Jan", "28 Jan", "28 Feb", "28 Mar", "7 May", "28 May", "28 Jun", "28 Jul", "28 Aug"],
      7: ["28 Oct", "28 Nov", "15 Jan", "28 Jan", "28 Feb", "28 Mar", "7 May", "28 May", "28 Jun", "28 Jul", "28 Aug", "28 Sep"],
      8: ["28 Nov", "15 Jan", "28 Jan", "28 Feb", "28 Mar", "7 May", "28 May", "28 Jun", "28 Jul", "28 Aug", "28 Sep", "28 Oct"],
      9: ["15 Jan", "28 Jan", "28 Feb", "28 Mar", "7 May", "28 May", "28 Jun", "28 Jul", "28 Aug", "28 Sep", "28 Oct", "28 Nov"],
    };
    const label = (date: string) => `${Number(date.slice(8))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(date.slice(5, 7)) - 1]}`;
    for (const [month, row] of Object.entries(table)) {
      const endMonth = Number(month);
      // Columns C, G, K are the 5th, 9th and 13th months; E and K the 7th and 13th.
      expect(instalmentDates(2027, 3, endMonth).map(label), `month ${month}`).toEqual([row[2], row[6], row[10]]);
      expect(instalmentDates(2027, 2, endMonth).map(label), `month ${month}`).toEqual([row[4], row[10]]);
    }
    expect(instalmentDates(2027, 3, 6)).toEqual(["2026-11-28", "2027-03-28", "2027-07-28"]);
    expect(instalmentDates(2027, 3, 3)).toEqual(["2026-08-28", "2027-01-15", "2027-05-07"]);
  });

  it("ITX43 end-of-year tax dates, with April to September in the calendar year after the balance date", () => {
    expect(endOfYearTaxDue(2026, false, 10)).toBe("2026-09-07");
    expect(endOfYearTaxDue(2026, true, 10)).toBe("2026-11-07");
    expect(endOfYearTaxDue(2026, false, 2)).toBe("2027-01-07");
    expect(endOfYearTaxDue(2026, false, 3)).toBe("2027-02-07");
    expect(endOfYearTaxDue(2026, false, 5)).toBe("2027-02-07");
    expect(endOfYearTaxDue(2026, true, 5)).toBe("2027-04-07");
    expect(endOfYearTaxDue(2026, false, 9)).toBe("2027-02-07");
    expect(endOfYearTaxDue(2027, false, 6)).toBe("2028-02-07");
    expect(suggestedIncomeYear("2026-08-28", 5)).toBeNull();
  });
});

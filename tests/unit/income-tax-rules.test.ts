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
  type AllocationStatus,
  type AppliesTo,
  type Payment,
  type WorkpaperAccount,
} from "@/lib/tax/income/rules";

/** A payment to IRD: bank date, amount, and (optionally) where it's allocated and how sure that is. */
const pay = (date: string, amount: string, appliesTo?: AppliesTo, status: AllocationStatus = "confirmed", effectiveOn: string | null = null): Payment => ({
  date,
  effectiveOn,
  amount: dec(amount),
  allocations: appliesTo === undefined ? [] : [{ appliesTo, amount: dec(amount), status }],
});

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
      extensionOfTime: false,
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
    const uneven = standardSchedule({ year: 2027, instalmentCount: 3, lastYear: { amount: dec("10000"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16", extensionOfTime: false });
    expect(uneven.kind === "schedule" && uneven.instalments.map((instalment) => instalment.amount)).toEqual(["3500.00", "3500.00", "3500.00"]);
    const odd = standardSchedule({ year: 2027, instalmentCount: 3, lastYear: { amount: dec("10000.01"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16", extensionOfTime: false });
    expect(odd.kind === "schedule" && odd.instalments.map((instalment) => instalment.amount)).toEqual(["3500.00", "3500.00", "3500.01"]);
  });

  it("ITX6 last year's return filed late with an extension of time: two years ago plus 10% until it's filed", () => {
    const base = { year: 2027, instalmentCount: 3 as const, lastYear: { amount: dec("17668"), typed: true }, twoYearsAgo: dec("12000"), today: "2027-02-01", extensionOfTime: true };
    const afterFirst = standardSchedule({
      ...base,
      lastYearFiledOn: "2026-10-10",
      // The 14 Jan payment is directed to instalment 2: its date alone doesn't make it a payment for instalment 1.
      payments: [pay("2026-08-28", "4400", 1), pay("2027-01-14", "7967.60", 2)],
    });
    expect(afterFirst.kind === "schedule" && afterFirst.instalments.map((instalment) => instalment.amount)).toEqual(["4400.00", "7967.60", "6183.80"]);
    expect(afterFirst.kind === "schedule" && afterFirst.instalments.map((instalment) => instalment.remaining)).toEqual(["0.00", "0.00", "6183.80"]);
    // An instalment that's due and not paid is caught up in the next one.
    const unpaid = standardSchedule({ ...base, lastYearFiledOn: "2026-10-10", payments: [pay("2026-08-28", "4400", 1)] });
    expect(unpaid.kind === "schedule" && unpaid.instalments.map((instalment) => instalment.amount)).toEqual(["4400.00", "7967.60", "14151.40"]);
    // The shortfall is counted once: instalment 3's own share is 6,183.80 and 7,967.60 of it is caught up; the year's total
    // stays 18,551.40 (it was once the sum of what's due, 26,519.00).
    if (unpaid.kind !== "schedule") throw new Error("expected a schedule");
    expect(unpaid.instalments.map((instalment) => [instalment.ownAmount, instalment.catchUp])).toEqual([["4400.00", "0.00"], ["7967.60", "0.00"], ["6183.80", "7967.60"]]);
    expect(unpaid.instalments.map((instalment) => instalment.remaining)).toEqual(["0.00", "7967.60", "14151.40"]);
    expect(unpaid.total).toBe("18551.40");
    expect(afterFirst.kind === "schedule" && afterFirst.total).toBe("18551.40");
    // Before the second instalment is due, it's assumed paid as worked out, and the schedule says that's an assumption.
    const early = standardSchedule({ ...base, today: "2026-10-16", lastYearFiledOn: "2026-10-10", payments: [pay("2026-08-28", "4400", 1)] });
    if (early.kind !== "schedule") throw new Error("expected a schedule");
    expect(early.instalments.map((instalment) => instalment.amount)).toEqual(["4400.00", "7967.60", "6183.80"]);
    expect(early.instalments.map((instalment) => instalment.assumption === null)).toEqual([true, true, false]);
    expect(early.instalments[2].assumption).toContain("instalment 2 is paid as worked out (7,967.60)");
    const afterSecond = standardSchedule({
      ...base,
      today: "2027-03-01",
      lastYearFiledOn: "2027-02-20",
      payments: [pay("2026-08-28", "4400", 1), pay("2027-01-15", "4400", 2)],
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
    expect(afterFirst.kind === "schedule" && afterFirst.instalments[1].basis).toBe("RIT for the 2026 income year: 17,668.00 + 5% = 18,551.40, x 2 ÷ 3 = 12,367.60, less 4,400.00 paid for instalment 1");
  });

  it("ITX67 without an extension of time, last year's RIT plus 5% even when its return is filed late", () => {
    const base = { year: 2027, instalmentCount: 3 as const, twoYearsAgo: dec("12000"), today: "2027-02-01", extensionOfTime: false, payments: [] };
    const late = standardSchedule({ ...base, lastYear: { amount: dec("17668"), typed: true }, lastYearFiledOn: "2026-10-10" });
    if (late.kind !== "schedule") throw new Error("expected a schedule");
    expect(late.instalments.map((instalment) => [instalment.amount, instalment.estimate])).toEqual([["6183.80", false], ["6183.80", false], ["6183.80", false]]);
    expect(late.total).toBe("18551.40");
    expect(late.notes.join(" ")).toContain("no extension of time");
    // Not filed yet: Tohyee's estimate of last year's RIT, marked as one on every instalment.
    const notFiled = standardSchedule({ ...base, lastYear: { amount: dec("17668"), typed: false }, lastYearFiledOn: null });
    if (notFiled.kind !== "schedule") throw new Error("expected a schedule");
    expect(notFiled.instalments.map((instalment) => [instalment.amount, instalment.estimate])).toEqual([["6183.80", true], ["6183.80", true], ["6183.80", true]]);
    expect(notFiled.notes.join(" ")).toContain("Tohyee's estimate");
    // With no figure for last year at all, it still says so rather than guessing.
    expect(standardSchedule({ ...base, lastYear: null, lastYearFiledOn: null }).kind).toBe("unknown");
  });

  it("ITX7 six-monthly GST filers pay twice", () => {
    const schedule = standardSchedule({ year: 2027, instalmentCount: 2, lastYear: { amount: dec("17668"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16", extensionOfTime: false });
    expect(schedule.kind === "schedule" && schedule.instalments.map((instalment) => [instalment.dueDate, instalment.amount])).toEqual([
      ["2026-10-28", "9275.70"],
      ["2027-05-07", "9275.70"],
    ]);
    const late = standardSchedule({ year: 2027, instalmentCount: 2, lastYear: { amount: dec("17668"), typed: true }, lastYearFiledOn: "2026-11-01", twoYearsAgo: dec("12000"), payments: [], today: "2026-11-16", extensionOfTime: true });
    expect(late.kind).toBe("unknown");
    // ITX67: with no extension of time, last year plus 5% applies, so the two instalments can be worked out.
    const lateNoExtension = standardSchedule({ year: 2027, instalmentCount: 2, lastYear: { amount: dec("17668"), typed: true }, lastYearFiledOn: "2026-11-01", twoYearsAgo: dec("12000"), payments: [], today: "2026-11-16", extensionOfTime: false });
    expect(lateNoExtension.kind === "schedule" && lateNoExtension.instalments.map((instalment) => instalment.amount)).toEqual(["9275.70", "9275.70"]);
  });

  it("ITX8 last year's RIT of 5,000 or less means no instalments", () => {
    const schedule = standardSchedule({ year: 2027, instalmentCount: 3, lastYear: { amount: dec("4800"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16", extensionOfTime: false });
    expect(schedule.kind).toBe("not_provisional");
    expect(standardSchedule({ year: 2027, instalmentCount: 3, lastYear: { amount: dec("5000"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, payments: [], today: "2026-10-16", extensionOfTime: false }).kind).toBe("not_provisional");
    expect(standardSchedule({ year: 2027, instalmentCount: 3, lastYear: null, lastYearFiledOn: null, twoYearsAgo: null, payments: [], today: "2026-10-16", extensionOfTime: false }).kind).toBe("unknown");
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

describe("provisional tax payments and allocation (ITX6A-ITX6H, as delegated, not yet reviewed by an accountant)", () => {
  const onTime = { year: 2027, instalmentCount: 3 as const, lastYear: { amount: dec("17668"), typed: true }, lastYearFiledOn: "2026-06-20", twoYearsAgo: null, extensionOfTime: false, today: "2027-02-01" };
  const late = { year: 2027, instalmentCount: 3 as const, lastYear: { amount: dec("17668"), typed: true }, lastYearFiledOn: "2026-10-10", twoYearsAgo: dec("12000"), extensionOfTime: true, today: "2027-02-01" };
  const schedule = (input: Parameters<typeof standardSchedule>[0]) => {
    const result = standardSchedule(input);
    if (result.kind !== "schedule") throw new Error("expected a schedule");
    return result;
  };
  const column = (result: ReturnType<typeof schedule>, key: "amount" | "paid" | "remaining" | "remainingWithForecast" | "creditAfter" | "paidLate" | "forecastPaid") =>
    result.instalments.map((instalment) => instalment[key]);

  it("ITX6A an excess towards instalment 1 reduces instalment 2, with no cap at instalment 1's amount", () => {
    // Late-filed return: 6,000.00 confirmed towards instalment 1 (worked out at 4,400.00).
    const p1 = schedule({ ...late, payments: [pay("2026-08-28", "6000", 1)] });
    expect(column(p1, "amount")).toEqual(["4400.00", "6367.60", "12551.40"]);
    // 12,367.60 by instalment 2 less the 6,000.00: 6,367.60 more is needed by 15 Jan 2027 (it was 7,967.60 with the cap).
    expect(column(p1, "remaining")).toEqual(["0.00", "6367.60", "12551.40"]);
    expect(column(p1, "creditAfter")).toEqual(["1600.00", "0.00", "0.00"]);
    const both = schedule({ ...late, payments: [pay("2026-08-28", "6000", 1), pay("2027-01-15", "6367.60", 2)] });
    expect(column(both, "amount")).toEqual(["4400.00", "6367.60", "6183.80"]);
    // The final balance: 18,551.40 - 6,000.00 - 6,367.60 = 6,183.80. The year's total stays 18,551.40.
    expect(column(both, "remaining")).toEqual(["0.00", "0.00", "6183.80"]);
    expect(both.total).toBe("18551.40");
    // On time: the instalments stay 6,183.80 each; the 1,816.20 excess is carried as a credit towards instalment 2.
    const standard = schedule({ ...onTime, payments: [pay("2026-08-28", "8000", 1)] });
    expect(column(standard, "amount")).toEqual(["6183.80", "6183.80", "6183.80"]);
    expect(column(standard, "creditAfter")).toEqual(["1816.20", "0.00", "0.00"]);
    expect(column(standard, "remaining")).toEqual(["0.00", "4367.60", "10551.40"]);
  });

  it("ITX6B a partial payment leaves the rest still needed, and catches up in a late-filed return's next instalment", () => {
    const standard = schedule({ ...onTime, payments: [pay("2026-08-28", "3000", 1)] });
    expect(column(standard, "paid")).toEqual(["3000.00", "0.00", "0.00"]);
    expect(column(standard, "remaining")).toEqual(["3183.80", "9367.60", "15551.40"]);
    const filedLate = schedule({ ...late, payments: [pay("2026-08-28", "3000", 1)] });
    // 12,367.60 - 3,000.00 = 9,367.60: instalment 2's own 7,967.60 plus 1,400.00 caught up.
    expect(filedLate.instalments[1]).toMatchObject({ amount: "9367.60", ownAmount: "7967.60", catchUp: "1400.00", remaining: "9367.60" });
  });

  it("ITX6C a late payment counts towards its instalment and is marked late, by IRD's effective date, not the bank date", () => {
    const lateOne = schedule({ ...onTime, payments: [pay("2026-09-10", "6183.80", 1, "confirmed", "2026-09-10")] });
    expect(lateOne.instalments[0]).toMatchObject({ paid: "6183.80", paidLate: "6183.80", remaining: "0.00" });
    // Left the bank on 27 Aug but IRD's effective date is 31 Aug: late.
    const effective = schedule({ ...onTime, payments: [pay("2026-08-27", "6183.80", 1, "evidenced", "2026-08-31")] });
    expect(effective.instalments[0].paidLate).toBe("6183.80");
    // With no effective date yet, the bank date stands in.
    const bankOnly = schedule({ ...onTime, payments: [pay("2026-08-27", "6183.80", 1, "evidenced")] });
    expect(bankOnly.instalments[0].paidLate).toBe("0.00");
  });

  it("ITX6D paid on the due date, or the next business day after a weekend due date, is on time", () => {
    const sameDay = schedule({ ...onTime, payments: [pay("2026-08-28", "6183.80", 1, "confirmed", "2026-08-28")] });
    expect(sameDay.instalments[0]).toMatchObject({ paid: "6183.80", paidLate: "0.00", remaining: "0.00" });
    // 28 Aug 2027 is a Saturday, so the 2028 year's first instalment is on time by Monday 30 Aug 2027.
    const weekend = schedule({ ...onTime, year: 2028, lastYearFiledOn: "2027-06-20", today: "2027-09-01", payments: [pay("2027-08-30", "6183.80", 1, "confirmed", "2027-08-30")] });
    expect(weekend.instalments[0]).toMatchObject({ dueDate: "2027-08-28", paidLate: "0.00" });
    expect(weekend.instalments[0].onTimeBy.date).toBe("2027-08-30");
  });

  it("ITX6E a payment directed to instalment 2 reduces instalment 2 and isn't relabelled instalment 1", () => {
    const directed = schedule({ ...onTime, payments: [pay("2026-08-20", "4000", 2)] });
    expect(column(directed, "paid")).toEqual(["0.00", "4000.00", "0.00"]);
    expect(column(directed, "remaining")).toEqual(["6183.80", "8367.60", "14551.40"]);
    // A payment between instalments 1 and 2 with no allocation is awaiting reconciliation: its date doesn't make it either.
    const between = schedule({ ...onTime, payments: [pay("2026-12-01", "6183.80")] });
    expect(column(between, "paid")).toEqual(["0.00", "0.00", "0.00"]);
    expect(between.allocation).toMatchObject({ awaiting: "6183.80", awaitingCount: 1 });
    expect(between.notes.join(" ")).toContain("awaiting reconciliation");
  });

  it("ITX6F a reversed payment counts for nothing", () => {
    const reversed = schedule({ ...onTime, payments: [{ ...pay("2026-08-28", "6183.80", 1), reversed: true }] });
    expect(column(reversed, "paid")).toEqual(["0.00", "0.00", "0.00"]);
    expect(column(reversed, "remaining")).toEqual(["6183.80", "12367.60", "18551.40"]);
    expect(reversed.allocation).toMatchObject({ reversed: "6183.80", awaiting: "0.00", awaitingCount: 0 });
  });

  it("ITX6G reallocating moves the payment, and forecast assumptions are shown but never counted as paid", () => {
    const toOne = schedule({ ...onTime, payments: [pay("2026-08-28", "6183.80", 1)] });
    const toTwo = schedule({ ...onTime, payments: [pay("2026-08-28", "6183.80", 2)] });
    expect(column(toOne, "remaining")).toEqual(["0.00", "6183.80", "12367.60"]);
    expect(column(toTwo, "remaining")).toEqual(["6183.80", "6183.80", "12367.60"]);
    const forecast = schedule({ ...onTime, payments: [pay("2026-08-28", "6183.80", 1, "forecast")] });
    expect(column(forecast, "paid")).toEqual(["0.00", "0.00", "0.00"]);
    expect(column(forecast, "forecastPaid")).toEqual(["6183.80", "0.00", "0.00"]);
    expect(column(forecast, "remaining")).toEqual(["6183.80", "12367.60", "18551.40"]);
    expect(column(forecast, "remainingWithForecast")).toEqual(["0.00", "6183.80", "12367.60"]);
    expect(forecast.allocation).toMatchObject({ awaiting: "6183.80", awaitingForecast: "6183.80", awaitingCount: 1 });
  });

  it("ITX6H each payment counts once, and a surplus is a credit, never a negative demand", () => {
    // One 6,000.00 payment allocated twice over: only 6,000.00 counts.
    const twice: Payment = { date: "2026-08-28", amount: dec("6000"), allocations: [{ appliesTo: 1, amount: dec("6000"), status: "confirmed" }, { appliesTo: 2, amount: dec("6000"), status: "confirmed" }] };
    const once = schedule({ ...onTime, payments: [twice] });
    expect(column(once, "paid")).toEqual(["6000.00", "0.00", "0.00"]);
    // Split across two instalments: each part counts where it's allocated.
    const split: Payment = { date: "2026-08-28", amount: dec("10000"), allocations: [{ appliesTo: 1, amount: dec("6183.80"), status: "confirmed" }, { appliesTo: 2, amount: dec("3816.20"), status: "evidenced" }] };
    expect(column(schedule({ ...onTime, payments: [split] }), "remaining")).toEqual(["0.00", "2367.60", "8551.40"]);
    // 20,000.00 allocated to the instalments: nothing more is needed and 1,448.60 is a credit.
    const surplus = schedule({ ...onTime, payments: [pay("2026-08-28", "6183.80", 1), pay("2027-01-15", "6183.80", 2), pay("2027-05-07", "7632.40", 3)], today: "2027-05-10" });
    expect(column(surplus, "remaining")).toEqual(["0.00", "0.00", "0.00"]);
    expect(surplus.allocation.credit).toBe("1448.60");
    expect(surplus.total).toBe("18551.40");
    expect(surplus.notes.join(" ")).toContain("1,448.60 more than the year's provisional tax");
    // End-of-year tax allocations aren't instalment payments.
    const endOfYear = schedule({ ...onTime, payments: [pay("2027-02-07", "500", "end_of_year")] });
    expect(endOfYear.allocation.endOfYear).toBe("500.00");
    expect(column(endOfYear, "paid")).toEqual(["0.00", "0.00", "0.00"]);
    // An allocation to an instalment the schedule doesn't have (instalment 3 for a six-monthly GST filer).
    const twoInstalments = schedule({ ...onTime, instalmentCount: 2, payments: [pay("2026-10-28", "9275.70", 3)] });
    expect(twoInstalments.allocation.unmatched).toBe("9275.70");
  });
});

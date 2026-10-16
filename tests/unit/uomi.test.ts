import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { requirements, underpaymentInterest, underpaymentRateOn } from "@/lib/tax/income/uomi";

const pay = (date: string, amount: string) => ({ date, amount: dec(amount) });

describe("use-of-money interest (ITX44-ITX48, from IRD's pages, not yet reviewed)", () => {
  it("ITX44 rates by the date they started", () => {
    expect(underpaymentRateOn("2026-01-16")).toEqual(dec("8.97"));
    expect(underpaymentRateOn("2026-01-15")).toEqual(dec("9.89"));
    expect(underpaymentRateOn("2025-05-08")).toEqual(dec("9.89"));
    expect(underpaymentRateOn("2019-01-01")).toBeNull();
  });

  it("ITX45 RIT under 60,000: interest only from the day after the end-of-year date", () => {
    const due = requirements({ rit: dec("17668"), instalments: [{ due: "2026-08-28", amount: dec("5000") }, { due: "2027-01-15", amount: dec("5000") }, { due: "2027-05-07", amount: dec("5000") }], endOfYearDue: "2027-02-09" });
    expect(due).toEqual([{ due: "2027-02-09", amount: dec("17668") }]);
    const payments = [pay("2026-08-28", "5000"), pay("2027-01-15", "5000"), pay("2027-05-07", "5000")];
    // The instalments were on time, but 2,668.00 of the end-of-year tax (with the third instalment still to come) was due 9 Feb.
    const late = underpaymentInterest({ requirements: due, payments: [pay("2026-08-28", "5000"), pay("2027-01-15", "5000"), pay("2027-02-01", "5000"), pay("2027-03-09", "2668")], asAt: "2027-12-31", today: "2027-12-31" });
    expect(late.interest).toBe("18.36");
    expect(late.periods).toEqual([{ from: "2027-02-10", to: "2027-03-09", days: 28, outstanding: "2668.00", rate: "8.97", interest: "18.36" }]);
    const onTime = underpaymentInterest({ requirements: due, payments: [...payments.slice(0, 2), pay("2027-02-09", "7668")], asAt: "2027-12-31", today: "2027-12-31" });
    expect(onTime.interest).toBe("0.00");
  });

  it("ITX46 RIT of 60,000 or more: from the day after the last instalment, and late earlier instalments", () => {
    const instalments = [{ due: "2026-08-28", amount: dec("6183.80") }, { due: "2027-01-15", amount: dec("6183.80") }, { due: "2027-05-07", amount: dec("6183.80") }];
    const due = requirements({ rit: dec("90000"), instalments, endOfYearDue: "2028-02-07" });
    expect(due.map((entry) => [entry.due, entry.amount])).toEqual([
      ["2026-08-28", dec("6183.80")],
      ["2027-01-15", dec("6183.80")],
      ["2027-05-07", dec("77632.40")],
    ]);
    const onTime = underpaymentInterest({ requirements: due, payments: [pay("2026-08-28", "6183.80"), pay("2027-01-15", "6183.80"), pay("2027-05-07", "6183.80"), pay("2028-02-07", "71448.60")], asAt: "2028-02-07", today: "2028-02-07" });
    expect(onTime.interest).toBe("4846.21");
    const lateFirst = underpaymentInterest({ requirements: due, payments: [pay("2026-09-27", "6183.80")], asAt: "2026-12-31", today: "2026-12-31" });
    expect(lateFirst.interest).toBe("45.59");
  });

  it("ITX44 nothing while $100 or less is unpaid; future days use the latest rate and say so", () => {
    const due = [{ due: "2027-02-09", amount: dec("100") }];
    expect(underpaymentInterest({ requirements: due, payments: [], asAt: "2027-06-30", today: "2027-06-30" }).interest).toBe("0.00");
    const future = underpaymentInterest({ requirements: [{ due: "2027-02-09", amount: dec("1000") }], payments: [], asAt: "2027-03-01", today: "2026-10-17" });
    expect(future.usesLatestRateForFuture).toBe(true);
  });

  it("ITX47 no end-of-year date, no requirement", () => {
    expect(requirements({ rit: dec("17668"), instalments: null, endOfYearDue: null })).toEqual([]);
  });
});

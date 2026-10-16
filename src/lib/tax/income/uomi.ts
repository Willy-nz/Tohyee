import { addDays } from "@/lib/financial-year";
import { add, cmp, dec, type Decimal, divide, isPositive, mul, roundHalfUp, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import { INTEREST_THRESHOLD, money } from "@/lib/tax/income/rules";

/*
 * Use-of-money interest on underpaid income tax, an estimate (examples
 * ITX44-ITX48, decision 552). Pure and browser-safe. From IRD's pages, read
 * 17 Oct 2026 and not yet reviewed: "Interest on overpayments and
 * underpayments (UOMI)" (the rates table; calculated daily, "does not
 * compound"; nothing on $100 or less) and "Interest on provisional tax" (the
 * $60,000 rules for the standard option).
 */

/** IRD's rates by the date they started, newest first (percent a year). */
export const UOMI_RATES: ReadonlyArray<{ from: string; underpayment: string; overpayment: string }> = [
  { from: "2026-01-16", underpayment: "8.97", overpayment: "2.25" },
  { from: "2025-05-08", underpayment: "9.89", overpayment: "3.27" },
  { from: "2025-01-16", underpayment: "10.88", overpayment: "4.30" },
  { from: "2023-08-29", underpayment: "10.91", overpayment: "4.67" },
  { from: "2023-05-09", underpayment: "10.39", overpayment: "3.53" },
  { from: "2023-01-17", underpayment: "9.21", overpayment: "2.31" },
  { from: "2022-08-30", underpayment: "7.96", overpayment: "1.22" },
  { from: "2022-05-10", underpayment: "7.28", overpayment: "0.00" },
  { from: "2020-05-08", underpayment: "7.00", overpayment: "0.00" },
  { from: "2019-08-29", underpayment: "8.35", overpayment: "0.81" },
];
export const UOMI_RATES_SOURCE = "IRD, \"Interest on overpayments and underpayments (UOMI)\", read 17 Oct 2026.";
const NO_INTEREST_UP_TO = dec("100");

export function underpaymentRateOn(date: string): Decimal | null {
  const rate = UOMI_RATES.find((entry) => entry.from <= date);
  return rate ? dec(rate.underpayment) : null;
}

/** An amount that falls due: interest can run from the day after `due`. */
export type Requirement = { due: string; amount: Decimal };

/**
 * What must be paid by when, for interest (ITX45, ITX46, ITX48): with RIT
 * under 60,000.00, or no instalments, all of it by the end-of-year date; with
 * 60,000.00 or more, each earlier instalment's smaller of (the instalment) and
 * (RIT ÷ the number of instalments), and the rest of the RIT by the last
 * instalment. Dates are the dates payments are on time by.
 */
export function requirements(input: { rit: Decimal; instalments: Array<{ due: string; amount: Decimal }> | null; endOfYearDue: string | null }): Requirement[] {
  if (!isPositive(input.rit)) return [];
  if (!input.instalments || input.instalments.length === 0 || cmp(input.rit, INTEREST_THRESHOLD) < 0) {
    return input.endOfYearDue ? [{ due: input.endOfYearDue, amount: input.rit }] : [];
  }
  const count = input.instalments.length;
  const share = divide(input.rit, dec(String(count)), 2);
  const result: Requirement[] = [];
  let sofar = ZERO_DECIMAL;
  input.instalments.forEach((instalment, index) => {
    if (index === count - 1) {
      result.push({ due: instalment.due, amount: sub(input.rit, sofar) });
      return;
    }
    const amount = cmp(instalment.amount, share) < 0 ? instalment.amount : share;
    sofar = add(sofar, amount);
    result.push({ due: instalment.due, amount });
  });
  return result;
}

export type InterestPeriod = { from: string; to: string; days: number; outstanding: string; rate: string; interest: string };
export type InterestResult = { interest: string; periods: InterestPeriod[]; ratesKnownTo: string; usesLatestRateForFuture: boolean };

/**
 * Interest on what's unpaid each day, from the day after each amount falls
 * due to `asAt` (ITX44): simple, daily, x rate ÷ 365, nothing while $100 or
 * less is unpaid. A payment counts from the day after it's made (so the day
 * it's paid is charged), and goes to the earliest amount due first.
 */
export function underpaymentInterest(input: { requirements: Requirement[]; payments: Array<{ date: string; amount: Decimal }>; asAt: string; today: string }): InterestResult {
  const periods: Array<{ from: string; to: string; days: number; outstanding: Decimal; rate: Decimal; interest: Decimal }> = [];
  let total = ZERO_DECIMAL;
  let usesLatestRateForFuture = false;
  if (input.requirements.length > 0) {
    const first = input.requirements.reduce((earliest, entry) => (entry.due < earliest ? entry.due : earliest), input.requirements[0].due);
    for (let day = addDays(first, 1); day <= input.asAt; day = addDays(day, 1)) {
      const required = input.requirements.filter((entry) => entry.due < day).reduce((sum, entry) => add(sum, entry.amount), ZERO_DECIMAL);
      const paid = input.payments.filter((entry) => entry.date < day).reduce((sum, entry) => add(sum, entry.amount), ZERO_DECIMAL);
      const owing = sub(required, paid);
      const outstanding = cmp(owing, NO_INTEREST_UP_TO) > 0 ? owing : ZERO_DECIMAL;
      const rate = underpaymentRateOn(day) ?? ZERO_DECIMAL;
      if (day > input.today && isPositive(outstanding)) usesLatestRateForFuture = true;
      const last = periods[periods.length - 1];
      if (last && cmp(last.outstanding, outstanding) === 0 && cmp(last.rate, rate) === 0 && addDays(last.to, 1) === day) {
        last.to = day;
        last.days += 1;
      } else {
        periods.push({ from: day, to: day, days: 1, outstanding, rate, interest: ZERO_DECIMAL });
      }
    }
  }
  for (const period of periods) {
    period.interest = divide(mul(mul(period.outstanding, period.rate), dec(String(period.days))), dec("36500"), 6);
    total = add(total, period.interest);
  }
  return {
    interest: money(roundHalfUp(total, 2)),
    periods: periods
      .filter((period) => isPositive(period.outstanding))
      .map((period) => ({ from: period.from, to: period.to, days: period.days, outstanding: money(period.outstanding), rate: money(period.rate), interest: money(roundHalfUp(period.interest, 2)) })),
    ratesKnownTo: UOMI_RATES[0].from,
    usesLatestRateForFuture,
  };
}

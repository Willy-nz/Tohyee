import { addDays } from "@/lib/financial-year";
import { incomeYearDates as rdIncomeYearDates, incomeYearOf as rdIncomeYearOf } from "@/lib/rd/amounts";
import { add, cmp, dec, type Decimal, divide, isNegative, isPositive, isZero, mul, roundHalfUp, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { publicHolidayYear } from "@/lib/payroll/leave/public-holiday-dates";

/*
 * Income tax rules (examples ITX1-ITX10, decision 545). Pure and
 * browser-safe. Written from IRD's published pages, read 16 Oct 2026 through
 * a summarising fetch tool, and not yet reviewed by an accountant:
 * - "Tax rates for individuals" (rates for 1 Apr 2024 to 31 Mar 2025, and
 *   from 1 Apr 2025);
 * - "Work out provisional tax using the standard option" (5% and 10%
 *   uplifts, the table for a return filed late, 28 Aug / 15 Jan / 7 May for a
 *   31 March balance date);
 * - IR289 Provisional tax (April 2025): provisional tax when last year's RIT
 *   is more than $5,000; six-monthly GST filers pay on 28 Oct and 7 May;
 *   end-of-year tax "by 7 February (or 7 April if you have a tax agent with an
 *   extension of time)";
 * - IR328 tax calendar 2026-27: "If a due date falls on a weekend or public
 *   holiday you can file or pay on the next business day without incurring
 *   penalties."
 * Only a 31 March balance date and the 2025 income year onwards (ITX1).
 */

export const TAXPAYER_TYPES = ["company", "individual"] as const;
export type TaxpayerType = (typeof TAXPAYER_TYPES)[number];
export const TAXPAYER_TYPE_LABELS: Record<TaxpayerType, string> = { company: "Company", individual: "Individual (sole trader)" };

export const FIRST_SUPPORTED_INCOME_YEAR = 2025;
/** "More than $5,000" of RIT last year makes someone a provisional taxpayer (IR289). */
export const PROVISIONAL_THRESHOLD = dec("5000");
/** Standard option interest runs from the end-of-year tax date when the year's RIT is under this (IRD "Interest on provisional tax"). */
export const INTEREST_THRESHOLD = dec("60000");

export const NOT_REVIEWED_NOTE =
  "These figures follow IRD's published rules as Tohyee reads them. They haven't been reviewed by an accountant yet, so check them before relying on them.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "7 Feb 2027". */
export function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function weekdayName(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/**
 * An income year's dates for a balance date at the end of `endMonth` (ITX41,
 * IRD SPS 24/01 para 9, the same rule as R&D's): with 31 March, the 2026
 * income year is 1 April 2025 to 31 March 2026; a late balance date (April to
 * September) corresponds to the tax year ending the 31 March before it (31 May
 * 2026 is the 2026 income year); an early one (October to February) to the
 * tax year ending the 31 March after it (31 October 2025 is the 2026 income
 * year).
 */
export function incomeYearDates(year: number, endMonth = 3): { start: string; end: string } {
  return rdIncomeYearDates(year, endMonth);
}

export function incomeYearLabel(year: number, endMonth = 3): string {
  const { start, end } = incomeYearDates(year, endMonth);
  return `${year} income year (${shortDate(start)} to ${shortDate(end)})`;
}

/** The income year a date is in, for a balance date at the end of `endMonth`. */
export function incomeYearOf(date: string, endMonth = 3): number {
  return rdIncomeYearOf(date, endMonth);
}

export function isSupportedIncomeYear(year: number): boolean {
  return Number.isInteger(year) && year >= FIRST_SUPPORTED_INCOME_YEAR && year <= 2100;
}

export type TaxBand = { from: string; to: string | null; rate: string };
export type TaxRates = { bands: TaxBand[]; source: string };

const INDIVIDUAL_2025: TaxBand[] = [
  { from: "0", to: "14000", rate: "0.105" },
  { from: "14000", to: "15600", rate: "0.1282" },
  { from: "15600", to: "48000", rate: "0.175" },
  { from: "48000", to: "53500", rate: "0.2164" },
  { from: "53500", to: "70000", rate: "0.30" },
  { from: "70000", to: "78100", rate: "0.3099" },
  { from: "78100", to: "180000", rate: "0.33" },
  { from: "180000", to: null, rate: "0.39" },
];

const INDIVIDUAL_FROM_2026: TaxBand[] = [
  { from: "0", to: "15600", rate: "0.105" },
  { from: "15600", to: "53500", rate: "0.175" },
  { from: "53500", to: "78100", rate: "0.30" },
  { from: "78100", to: "180000", rate: "0.33" },
  { from: "180000", to: null, rate: "0.39" },
];

/** The rates for a taxpayer and income year (ITX3, ITX4). */
export function taxRates(type: TaxpayerType, year: number): TaxRates {
  if (!isSupportedIncomeYear(year)) throw new Error(`Income year ${year} isn't supported.`);
  if (type === "company") return { bands: [{ from: "0", to: null, rate: "0.28" }], source: "Company rate 28%." };
  if (year === 2025) return { bands: INDIVIDUAL_2025, source: "IRD's individual rates for 1 April 2024 to 31 March 2025." };
  return { bands: INDIVIDUAL_FROM_2026, source: "IRD's individual rates from 1 April 2025." };
}

/** Tax on taxable income: worked out exactly across the bands and rounded once to the cent, half up (ITX4). Nothing on a loss. */
export function taxOn(income: Decimal, type: TaxpayerType, year: number): Decimal {
  if (!isPositive(income)) return ZERO_DECIMAL;
  let tax = ZERO_DECIMAL;
  for (const band of taxRates(type, year).bands) {
    const from = dec(band.from);
    if (cmp(income, from) <= 0) break;
    const top = band.to === null || cmp(income, dec(band.to)) < 0 ? income : dec(band.to);
    tax = add(tax, mul(sub(top, from), dec(band.rate)));
  }
  return roundHalfUp(tax, 2);
}

// --- Working days -----------------------------------------------------------

/** National public holidays for a year, with those that fall on a weekend moved to the next free weekday. Null when the year isn't on Tohyee's list. */
function holidaysIn(year: number): Set<string> | null {
  const data = publicHolidayYear(year);
  if (!data) return null;
  const days = new Set(data.national.map((holiday) => holiday.date));
  for (const holiday of [...data.national].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!holiday.transfer || !isWeekend(holiday.date)) continue;
    let moved = holiday.date;
    while (isWeekend(moved) || days.has(moved)) moved = addDays(moved, 1);
    days.add(moved);
  }
  return days;
}

function isWeekend(date: string): boolean {
  const day = weekdayName(date);
  return day === "Saturday" || day === "Sunday";
}

export type OnTimeBy = { date: string; holidaysChecked: boolean };

/** The date a payment due on `date` is on time by: the next business day when it's a weekend or national public holiday (ITX10). */
export function onTimeBy(date: string): OnTimeBy {
  let day = date;
  let holidaysChecked = true;
  for (;;) {
    const holidays = holidaysIn(Number(day.slice(0, 4)));
    if (!holidays) holidaysChecked = false;
    if (!isWeekend(day) && !holidays?.has(day)) return { date: day, holidaysChecked };
    day = addDays(day, 1);
  }
}

// --- Due dates ---------------------------------------------------------------

/** "2026-08" plus `count` months. */
function addMonthsTo(month: string, count: number): { year: number; month: number } {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/**
 * A provisional tax date: the 28th of the month that's `monthsAfter` months
 * after the balance date before the income year, except that 28 December is
 * 15 January and 28 April is 7 May (Income Tax Act 2007 schedule 3 part A,
 * ITX42).
 */
function instalmentDate(previousBalanceDate: string, monthsAfter: number): string {
  const { year, month } = addMonthsTo(previousBalanceDate.slice(0, 7), monthsAfter);
  if (month === 12) return `${year + 1}-01-15`;
  if (month === 4) return `${year}-05-07`;
  return `${year}-${String(month).padStart(2, "0")}-28`;
}

/**
 * Standard option instalment due dates for an income year: the 5th, 9th and
 * 13th months after the balance date before it (7th and 13th for six-monthly
 * GST filers). With 31 March: 28 Aug, 15 Jan, 7 May (two: 28 Oct, 7 May).
 */
export function instalmentDates(year: number, count: 2 | 3, endMonth = 3): string[] {
  const previous = addDays(incomeYearDates(year, endMonth).start, -1);
  return (count === 3 ? [5, 9, 13] : [7, 13]).map((months) => instalmentDate(previous, months));
}

/**
 * End-of-year (terminal) tax for an income year (ITX43): the 7th of the 11th
 * month after the balance date, or of the 13th with a tax agent's extension
 * of time (with 31 March: 7 Feb and 7 Apr), from the last two columns of
 * schedule 3 part A. For April to September balance dates the schedule says
 * February and April, and which year that is hasn't been checked yet, so
 * Tohyee returns null rather than guess.
 */
export function endOfYearTaxDue(year: number, agentExtension: boolean, endMonth = 3): string | null {
  if (endMonth >= 4 && endMonth <= 9) return null;
  const end = incomeYearDates(year, endMonth).end;
  const { year: dueYear, month } = addMonthsTo(end.slice(0, 7), agentExtension ? 13 : 11);
  return `${dueYear}-${String(month).padStart(2, "0")}-07`;
}

// --- Standard provisional tax -----------------------------------------------

export type RitFigure = { amount: Decimal; typed: boolean };
export type Payment = { date: string; amount: Decimal };

export type Instalment = {
  number: number;
  dueDate: string;
  onTimeBy: OnTimeBy;
  amount: string;
  /** How the amount was worked out, in words. */
  basis: string;
  /** Uses Tohyee's estimate of last year's RIT rather than IRD's figure. */
  estimate: boolean;
};

export type ProvisionalSchedule =
  | { kind: "schedule"; instalments: Instalment[]; total: string; notes: string[] }
  | { kind: "not_provisional"; notes: string[] }
  | { kind: "unknown"; notes: string[] };

/** A Decimal as a plain 2-place string ("18551.40"). */
export function money(value: Decimal): string {
  return toFixedString(value, 2);
}

/** "18,551.40": for sentences. */
export function moneyText(value: Decimal): string {
  const [whole, cents] = toFixedString(value, 2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

const UPLIFT_5 = dec("1.05");
const UPLIFT_10 = dec("1.10");

/**
 * The standard option schedule for an income year (ITX5-ITX8).
 * - `lastYear`: last year's RIT, typed from IRD's assessment (with the date
 *   the return was filed) or Tohyee's estimate (not filed yet).
 * - `twoYearsAgo`: the RIT two years ago, used while last year's return is
 *   filed late.
 * - `payments`: payments to IRD towards this income year.
 * - `today`: earlier instalments not due yet are assumed paid as worked out.
 */
export function standardSchedule(input: {
  year: number;
  instalmentCount: 2 | 3;
  lastYear: RitFigure | null;
  lastYearFiledOn: string | null;
  twoYearsAgo: Decimal | null;
  payments: Payment[];
  today: string;
  /** The balance date's month (default 31 March). */
  endMonth?: number;
}): ProvisionalSchedule {
  const { year, lastYear, twoYearsAgo } = input;
  const label = (offset: number) => `the ${year - offset} income year`;
  if (!lastYear) {
    return { kind: "unknown", notes: [`Tohyee doesn't know the residual income tax (RIT) for ${label(1)} yet, so it can't tell whether provisional tax is due. Type it from IRD's assessment once the return is filed.`] };
  }
  const estimateNote = lastYear.typed ? [] : [`The RIT for ${label(1)} is Tohyee's estimate from the books, not IRD's figure; type IRD's figure once the return is filed.`];
  if (cmp(lastYear.amount, PROVISIONAL_THRESHOLD) <= 0) {
    return {
      kind: "not_provisional",
      notes: [
        `The RIT for ${label(1)} is ${moneyText(lastYear.amount)}, which isn't more than 5,000.00, so no provisional tax instalments are due under the standard option. This year's tax is all due as end-of-year tax; voluntary payments before then can reduce interest.`,
        ...estimateNote,
      ],
    };
  }
  const dates = instalmentDates(year, input.instalmentCount, input.endMonth ?? 3);
  const total = roundHalfUp(mul(lastYear.amount, UPLIFT_5), 2);
  const filedOn = lastYear.typed ? input.lastYearFiledOn : null;
  // A return filed on the next business day after a due date on a weekend or holiday counts as filed on the due date.
  const filedBy = (index: number) => filedOn !== null && filedOn <= onTimeBy(dates[index]).date;
  const notes = [...estimateNote];
  const amounts: Array<{ amount: Decimal; basis: string; estimate: boolean }> = [];
  const paidBefore = (date: string) => input.payments.filter((payment) => payment.date < date).reduce((sum, payment) => add(sum, payment.amount), ZERO_DECIMAL);
  // What's been paid towards the instalments before number `index` (0-based): payments dated before its due date, up to what
  // those instalments were, so a payment made early for this one isn't counted twice; until they're all due, they count as
  // paid as worked out (ITX6).
  const paidTowards = (index: number) => {
    const earlier = amounts.slice(0, index).reduce((sum, entry) => add(sum, entry.amount), ZERO_DECIMAL);
    if (!dates.slice(0, index).every((date) => date <= input.today)) return earlier;
    const actual = paidBefore(dates[index]);
    return cmp(actual, earlier) < 0 ? actual : earlier;
  };
  const uplifted = `${moneyText(lastYear.amount)} + 5% = ${moneyText(total)}`;

  if (filedBy(0)) {
    const share = divide(total, dec(String(input.instalmentCount)), 2);
    for (let index = 0; index < dates.length; index += 1) {
      const last = index === dates.length - 1;
      const amount = last ? sub(total, mul(share, dec(String(dates.length - 1)))) : share;
      amounts.push({ amount, basis: `RIT for ${label(1)}: ${uplifted}, ÷ ${input.instalmentCount}${last ? ", less the other instalments so they add up" : ""}`, estimate: false });
    }
  } else if (input.instalmentCount === 2) {
    return {
      kind: "unknown",
      notes: [`${label(1).replace(/^the/, "The")} return wasn't filed by ${shortDate(dates[0])}. Tohyee can't work out the two-instalment schedule for a late return yet (IRD's table is for three instalments).`, ...estimateNote],
    };
  } else {
    if (!twoYearsAgo) {
      return {
        kind: "unknown",
        notes: [`${label(1).replace(/^the/, "The")} return ${filedOn ? "was filed after" : "isn't filed yet, so from"} ${shortDate(dates[0])} the instalments use the RIT for ${label(2)} plus 10%. Type that RIT from IRD's assessment.`, ...estimateNote],
      };
    }
    const early = divide(mul(twoYearsAgo, UPLIFT_10), dec("3"), 2);
    const earlyBasis = `RIT for ${label(2)}: ${moneyText(twoYearsAgo)} + 10% = ${moneyText(mul(twoYearsAgo, UPLIFT_10))}, ÷ 3 (last year's return wasn't filed by the first instalment)`;
    amounts.push({ amount: early, basis: earlyBasis, estimate: false });
    if (filedBy(1)) {
      const twoThirds = divide(mul(total, dec("2")), dec("3"), 2);
      amounts.push({ amount: sub(twoThirds, paidTowards(1)), basis: `RIT for ${label(1)}: ${uplifted}, x 2 ÷ 3 = ${moneyText(twoThirds)}, less ${moneyText(paidTowards(1))} paid towards the year before ${shortDate(dates[1])}`, estimate: false });
    } else {
      amounts.push({ amount: early, basis: earlyBasis, estimate: false });
    }
    const paid = paidTowards(2);
    amounts.push({
      amount: sub(total, paid),
      basis: `RIT for ${label(1)}: ${uplifted}, less ${moneyText(paid)} paid towards the year before ${shortDate(dates[2])}`,
      estimate: !lastYear.typed,
    });
    if (!lastYear.typed) notes.push(`The last instalment uses Tohyee's estimate of the RIT for ${label(1)}; it changes once IRD's figure is typed.`);
  }

  const instalments: Instalment[] = amounts.map((entry, index) => ({
    number: index + 1,
    dueDate: dates[index],
    onTimeBy: onTimeBy(dates[index]),
    amount: money(isNegative(entry.amount) ? ZERO_DECIMAL : entry.amount),
    basis: entry.basis,
    estimate: entry.estimate,
  }));
  const sum = instalments.reduce((acc, instalment) => add(acc, dec(instalment.amount)), ZERO_DECIMAL);
  return { kind: "schedule", instalments, total: money(sum), notes };
}

// --- Taxable income ----------------------------------------------------------

export const TREATMENTS = ["full", "not_deductible", "entertainment_50", "business_use", "not_taxable"] as const;
export type Treatment = (typeof TREATMENTS)[number];
export const TREATMENT_LABELS: Record<Treatment, string> = {
  full: "Counts in full",
  not_deductible: "Not deductible",
  entertainment_50: "Entertainment, 50% deductible",
  business_use: "Business use %",
  not_taxable: "Not taxable",
};
/** Which treatments suit income accounts and which suit expense accounts (ITX2). */
export const INCOME_TREATMENTS: readonly Treatment[] = ["full", "not_taxable"];
export const EXPENSE_TREATMENTS: readonly Treatment[] = ["full", "not_deductible", "entertainment_50", "business_use"];

export type WorkpaperAccount = {
  accountId: string;
  code: string;
  name: string;
  side: "income" | "expense";
  /** In the account's natural direction: income and costs both positive. */
  amount: Decimal;
  treatment: Treatment;
  businessUsePercent: Decimal | null;
};

export type Adjustment = { description: string; amount: string; accountId: string | null };

export type Workpaper = {
  netProfit: string;
  adjustments: Adjustment[];
  otherIncome: string;
  beforeLosses: string;
  lossesBroughtForward: string;
  lossesUsed: string;
  taxableIncome: string;
  lossCarriedForward: string;
  tax: string;
  taxCredits: string;
  /** Tax less credits: negative is a refund. */
  taxToPay: string;
  /** Residual income tax: tax to pay, but never below nil. */
  rit: string;
};

/** The adjustment an account's treatment makes to taxable income (ITX2, ITX3): positive adds. */
export function accountAdjustment(account: WorkpaperAccount): Decimal {
  switch (account.treatment) {
    case "not_deductible":
      return account.side === "expense" ? account.amount : ZERO_DECIMAL;
    case "entertainment_50":
      return account.side === "expense" ? divide(account.amount, dec("2"), 2) : ZERO_DECIMAL;
    case "business_use": {
      if (account.side !== "expense" || !account.businessUsePercent) return ZERO_DECIMAL;
      return divide(mul(account.amount, sub(dec("100"), account.businessUsePercent)), dec("100"), 2);
    }
    case "not_taxable":
      return account.side === "income" ? mul(account.amount, dec("-1")) : ZERO_DECIMAL;
    default:
      return ZERO_DECIMAL;
  }
}

function adjustmentText(account: WorkpaperAccount): string {
  const name = `${account.code} ${account.name}`;
  switch (account.treatment) {
    case "not_deductible":
      return `${name}: not deductible`;
    case "entertainment_50":
      return `${name}: entertainment, half not deductible`;
    case "business_use":
      return `${name}: private use (${account.businessUsePercent ? toPlainString(sub(dec("100"), account.businessUsePercent)) : "0"}%)`;
    case "not_taxable":
      return `${name}: not taxable`;
    default:
      return name;
  }
}

/** Accounting profit to taxable income, tax and RIT (ITX3, ITX4). */
export function workpaper(input: {
  type: TaxpayerType;
  year: number;
  accounts: WorkpaperAccount[];
  typedAdjustments: Array<{ description: string; amount: Decimal }>;
  otherIncome: Decimal;
  lossesBroughtForward: Decimal;
  taxCredits: Decimal;
}): Workpaper {
  let netProfit = ZERO_DECIMAL;
  const adjustments: Adjustment[] = [];
  let adjusted = ZERO_DECIMAL;
  for (const account of input.accounts) {
    netProfit = account.side === "income" ? add(netProfit, account.amount) : sub(netProfit, account.amount);
    const adjustment = accountAdjustment(account);
    if (isZero(adjustment)) continue;
    adjusted = add(adjusted, adjustment);
    adjustments.push({ description: adjustmentText(account), amount: money(adjustment), accountId: account.accountId });
  }
  for (const typed of input.typedAdjustments) {
    adjusted = add(adjusted, typed.amount);
    adjustments.push({ description: typed.description, amount: money(typed.amount), accountId: null });
  }
  const otherIncome = input.type === "individual" ? input.otherIncome : ZERO_DECIMAL;
  const beforeLosses = add(add(netProfit, adjusted), otherIncome);
  let lossesUsed = ZERO_DECIMAL;
  let taxable = beforeLosses;
  let carried = input.lossesBroughtForward;
  if (isPositive(beforeLosses)) {
    lossesUsed = cmp(input.lossesBroughtForward, beforeLosses) < 0 ? input.lossesBroughtForward : beforeLosses;
    taxable = sub(beforeLosses, lossesUsed);
    carried = sub(input.lossesBroughtForward, lossesUsed);
  } else {
    carried = sub(input.lossesBroughtForward, beforeLosses);
  }
  const tax = taxOn(taxable, input.type, input.year);
  const taxToPay = sub(tax, input.taxCredits);
  return {
    netProfit: money(netProfit),
    adjustments,
    otherIncome: money(otherIncome),
    beforeLosses: money(beforeLosses),
    lossesBroughtForward: money(input.lossesBroughtForward),
    lossesUsed: money(lossesUsed),
    taxableIncome: money(taxable),
    lossCarriedForward: money(carried),
    tax: money(tax),
    taxCredits: money(input.taxCredits),
    taxToPay: money(taxToPay),
    rit: money(isNegative(taxToPay) ? ZERO_DECIMAL : taxToPay),
  };
}

/**
 * The income year a payment to IRD on this date is most likely towards (ITX38),
 * for a 31 March balance date: August to January, that year's instalments;
 * February and March, end-of-year tax for the year before; April, end-of-year
 * tax under a tax agent's extension; May, the last instalment of the year just
 * ended. June and July: no suggestion. A person confirms it.
 */
export function suggestedIncomeYear(date: string, endMonth = 3): number | null {
  // Worked out only for a 31 March balance date (ITX38).
  if (endMonth !== 3) return null;
  const month = Number(date.slice(5, 7));
  const year = incomeYearOf(date);
  if (month >= 8 || month === 1) return year;
  if (month === 2 || month === 3 || month === 5) return year - 1;
  if (month === 4) return year - 2;
  return null;
}

import { financialYearStart } from "@/lib/financial-year";
import { add, cmp, dec, type Decimal, isNegative, mul, mulDiv, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Depreciation maths for fixed assets (examples FA3-FA10). Browser-safe: no
 * server imports, so screens can show the same figures.
 *
 * Depreciation is worked out in whole months. Within each financial year an
 * asset's depreciation so far is
 *
 *   diminishing value (DV): book value at the start of the year x rate x months / 12
 *   straight line (SL):     cost x rate x months / 12
 *
 * where "months" counts from the start of the year (or the asset's first
 * month, if later) to the month being charged, and "the start of the year"
 * for an asset bought (or brought in with an opening balance) during the year
 * is when its depreciation starts. That figure is rounded once to cents, half
 * away from zero, and a run charges it less what's already been charged in
 * that year, so monthly runs add up to exactly what one run for the year
 * would. Depreciation never takes the book value below the residual value
 * (zero unless one is set). "No depreciation" (e.g. land) charges nothing.
 *
 * The rates are whatever the organisation typed in: Tohyee has no built-in
 * IRD rates.
 */

export const DEPRECIATION_METHODS = ["dv", "sl", "none"] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export const DEPRECIATION_METHOD_LABELS: Record<DepreciationMethod, string> = {
  dv: "Diminishing value",
  sl: "Straight line",
  none: "No depreciation",
};

/** Months are "YYYY-MM". */
export type Month = string;

export function monthOf(date: string): Month {
  return date.slice(0, 7);
}

export function monthIndex(month: Month): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

export function monthFromIndex(index: number): Month {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function addMonths(month: Month, count: number): Month {
  return monthFromIndex(monthIndex(month) + count);
}

/** Months from `from` to `to`, both included (0 if `to` is before `from`). */
export function monthsBetween(from: Month, to: Month): number {
  return Math.max(0, monthIndex(to) - monthIndex(from) + 1);
}

/** Last day (YYYY-MM-DD) of a month. */
export function monthEnd(month: Month): string {
  const next = addMonths(month, 1);
  const last = new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, 0));
  return `${month}-${String(last.getUTCDate()).padStart(2, "0")}`;
}

export function isMonthEnd(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && monthEnd(monthOf(date)) === date;
}

export type FirstMonthRule = "full_month" | "next_month";
export type DisposalMonthRule = "include" | "exclude";

export type AssetBasis = {
  method: DepreciationMethod;
  /** Annual rate as a percentage ("30" is 30%); null for "no depreciation". */
  rate: string | null;
  cost: string;
  residualValue: string;
  /** Depreciation brought in when the register was started (0 for a new asset). */
  openingAccumulated: string;
  /** The first month depreciation is charged for. */
  firstMonth: Month;
};

/**
 * The first month an asset is depreciated for: the month after its opening
 * balance date if it has one, otherwise the month it was bought (a whole
 * month, FA3) or the month after (FA7), by the organisation's setting.
 */
export function firstDepreciationMonth(purchaseDate: string, openingDate: string | null, rule: FirstMonthRule): Month {
  if (openingDate) return addMonths(monthOf(openingDate), 1);
  return rule === "full_month" ? monthOf(purchaseDate) : addMonths(monthOf(purchaseDate), 1);
}

/** The last month a disposal charges depreciation for (FA8): the disposal month, or the month before. */
export function lastMonthBeforeDisposal(disposalDate: string, rule: DisposalMonthRule): Month {
  return rule === "include" ? monthOf(disposalDate) : addMonths(monthOf(disposalDate), -1);
}

/** Depreciation already charged: a run's or disposal's months in one financial year. */
export type ChargedSegment = { financialYearStart: string; fromMonth: Month; toMonth: Month; amount: string };

export type PlannedSegment = { financialYearStart: string; fromMonth: Month; toMonth: Month; months: number; amount: string };

/** The month after the last one charged, or the asset's first month. */
export function nextUnchargedMonth(basis: Pick<AssetBasis, "firstMonth">, charged: readonly ChargedSegment[]): Month {
  const last = charged.reduce<Month | null>((latest, segment) => (latest === null || segment.toMonth > latest ? segment.toMonth : latest), null);
  if (last === null) return basis.firstMonth;
  const after = addMonths(last, 1);
  return after > basis.firstMonth ? after : basis.firstMonth;
}

/**
 * Depreciation for the months after what's been charged, up to and including
 * `throughMonth`: one segment per financial year, each rounded once. Empty
 * when there's nothing to charge (no depreciation, or nothing new).
 */
export function planDepreciation(
  basis: AssetBasis,
  charged: readonly ChargedSegment[],
  throughMonth: Month,
  yearEndMonth: number,
  scale: number,
): PlannedSegment[] {
  if (basis.method === "none" || basis.rate === null) return [];
  const rate = dec(basis.rate);
  const cost = dec(basis.cost);
  const floor = dec(basis.residualValue);
  let accumulated = add(dec(basis.openingAccumulated), sum(charged.map((segment) => dec(segment.amount))));
  const chargedInYear = new Map<string, Decimal>();
  for (const segment of charged) {
    chargedInYear.set(segment.financialYearStart, add(chargedInYear.get(segment.financialYearStart) ?? ZERO_DECIMAL, dec(segment.amount)));
  }
  const planned: PlannedSegment[] = [];
  let month = nextUnchargedMonth(basis, charged);
  while (month <= throughMonth) {
    const yearStart = financialYearStart(`${month}-01`, yearEndMonth);
    const yearStartMonth = monthOf(yearStart);
    const yearEndMonthOfSegment = addMonths(yearStartMonth, 11);
    const segmentEnd = throughMonth < yearEndMonthOfSegment ? throughMonth : yearEndMonthOfSegment;
    const firstInYear = basis.firstMonth > yearStartMonth ? basis.firstMonth : yearStartMonth;
    const monthsSoFar = monthsBetween(firstInYear, segmentEnd);
    const inYear = chargedInYear.get(yearStart) ?? ZERO_DECIMAL;
    // Book value when this year's depreciation started: cost less everything charged before it.
    const base = basis.method === "sl" ? cost : sub(cost, sub(accumulated, inYear));
    const soFar = mulDiv(mul(base, rate), dec(String(monthsSoFar)), dec("1200"), scale);
    let amount = sub(soFar, inYear);
    if (isNegative(amount)) amount = ZERO_DECIMAL;
    const room = sub(sub(cost, floor), accumulated);
    if (cmp(amount, room) > 0) amount = isNegative(room) ? ZERO_DECIMAL : room;
    accumulated = add(accumulated, amount);
    chargedInYear.set(yearStart, add(inYear, amount));
    planned.push({
      financialYearStart: yearStart,
      fromMonth: month,
      toMonth: segmentEnd,
      months: monthsBetween(month, segmentEnd),
      amount: toFixedString(amount, scale),
    });
    month = addMonths(segmentEnd, 1);
  }
  return planned;
}

export type DisposalFigures = {
  cost: string;
  accumulatedDepreciation: string;
  bookValue: string;
  proceeds: string;
  /** Proceeds above book value, up to the cost: depreciation charged that the sale shows wasn't needed. */
  depreciationRecovered: string;
  /** Proceeds above the cost. */
  capitalGain: string;
  /** Book value not recovered by the proceeds. */
  loss: string;
};

/** How a disposal splits (FA8-FA10): book value + recovered + capital gain - loss = proceeds. */
export function disposalFigures(costInput: string, accumulatedInput: string, proceedsInput: string, scale: number): DisposalFigures {
  const cost = dec(costInput);
  const accumulated = dec(accumulatedInput);
  const proceeds = dec(proceedsInput);
  const bookValue = sub(cost, accumulated);
  let recovered = ZERO_DECIMAL;
  let capital = ZERO_DECIMAL;
  let loss = ZERO_DECIMAL;
  if (cmp(proceeds, bookValue) >= 0) {
    const upToCost = cmp(proceeds, cost) > 0 ? cost : proceeds;
    recovered = sub(upToCost, bookValue);
    capital = cmp(proceeds, cost) > 0 ? sub(proceeds, cost) : ZERO_DECIMAL;
  } else {
    loss = sub(bookValue, proceeds);
  }
  const fixed = (value: Decimal) => toFixedString(value, scale);
  return {
    cost: fixed(cost),
    accumulatedDepreciation: fixed(accumulated),
    bookValue: fixed(bookValue),
    proceeds: fixed(proceeds),
    depreciationRecovered: fixed(recovered),
    capitalGain: fixed(capital),
    loss: fixed(loss),
  };
}

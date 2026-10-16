import { cmp, dec, type Decimal, divide, mul, roundHalfUp, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import { incomeYearOf, money } from "@/lib/tax/income/rules";

/*
 * Tax depreciation and Investment Boost (examples ITX11-ITX17, decision 546).
 * Pure and browser-safe. From IRD's pages, read 16 Oct 2026 and not yet
 * reviewed: "Work out diminishing value depreciation" and "Work out
 * straight-line depreciation" (rate x months used ÷ 12, "Count part-months
 * as whole months", business-use percentage); "Claiming depreciation"
 * (low-value assets up to $1,000 from 17 March 2021); IR260 (no depreciation
 * in the year of disposal except buildings; depreciation recovered is the
 * lesser of depreciation that could have been deducted and the sale price
 * above the adjusted tax value; a loss is deductible); Investment Boost
 * pages (20% of the cost of new assets first available for use on or after
 * 22 May 2025, then depreciation "as usual on the remaining 80%").
 * Where they're silent (rounding, ATV of a part-private asset, scaling
 * recovered amounts by business use), decision 546 says what Tohyee does.
 */

export const TAX_DEPRECIATION_METHODS = ["dv", "sl", "low_value", "not_depreciable"] as const;
export type TaxDepreciationMethod = (typeof TAX_DEPRECIATION_METHODS)[number];
export const TAX_DEPRECIATION_METHOD_LABELS: Record<TaxDepreciationMethod, string> = {
  dv: "Diminishing value",
  sl: "Straight line",
  low_value: "Low-value write-off",
  not_depreciable: "Not depreciable",
};

export const INVESTMENT_BOOST_FROM = "2025-05-22";
export const INVESTMENT_BOOST_RATE = dec("0.20");
export const LOW_VALUE_LIMIT = dec("1000");
export const LOW_VALUE_FROM = "2021-03-17";

export type TaxAssetInput = {
  cost: Decimal;
  method: TaxDepreciationMethod;
  /** Percent, e.g. 30 for 30%. Null for low-value and not depreciable. */
  rate: Decimal | null;
  businessUsePercent: Decimal;
  investmentBoost: boolean;
  availableOn: string;
  /** For an asset with tax history before Tohyee: its ATV at the start of an income year. */
  opening: { incomeYear: number; atv: Decimal } | null;
  disposal: { date: string; proceeds: Decimal } | null;
};

export type TaxAssetYear = {
  incomeYear: number;
  months: number;
  openingAtv: string;
  investmentBoost: string;
  depreciation: string;
  /** The business-use share of the boost and depreciation: what's deducted. */
  boostClaimed: string;
  depreciationClaimed: string;
  recovered: string;
  loss: string;
  closingAtv: string;
  disposed: boolean;
};

/** Months from the month of `date` to the end of its income year (31 March), counting part months as whole. */
export function monthsToYearEnd(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const endYear = incomeYearOf(date);
  return endYear * 12 + 3 - (year * 12 + month) + 1;
}

function share(amount: Decimal, percent: Decimal): Decimal {
  return roundHalfUp(divide(mul(amount, percent), dec("100"), 6), 2);
}

function min(a: Decimal, b: Decimal): Decimal {
  return cmp(a, b) <= 0 ? a : b;
}

/** An asset's tax depreciation year by year, up to and including `throughYear` (ITX12-ITX17). */
export function taxDepreciationYears(input: TaxAssetInput, throughYear: number): TaxAssetYear[] {
  const acquiredYear = incomeYearOf(input.availableOn);
  const startYear = input.opening ? input.opening.incomeYear : acquiredYear;
  const disposalYear = input.disposal ? incomeYearOf(input.disposal.date) : null;
  const boostAmount = input.investmentBoost ? roundHalfUp(mul(input.cost, INVESTMENT_BOOST_RATE), 2) : ZERO_DECIMAL;
  // Straight line runs on the cost less any Investment Boost (IRD: "the remaining 80%").
  const slBase = sub(input.cost, boostAmount);
  let atv = input.opening ? input.opening.atv : input.cost;
  const rows: TaxAssetYear[] = [];
  for (let year = startYear; year <= throughYear; year += 1) {
    const opening = atv;
    if (disposalYear !== null && year === disposalYear) {
      let recovered = ZERO_DECIMAL;
      let loss = ZERO_DECIMAL;
      if (input.method !== "not_depreciable") {
        const proceeds = input.disposal!.proceeds;
        if (cmp(proceeds, atv) > 0) recovered = min(sub(proceeds, atv), sub(input.cost, atv));
        else loss = sub(atv, proceeds);
      }
      rows.push({
        incomeYear: year,
        months: 0,
        openingAtv: money(opening),
        investmentBoost: "0.00",
        depreciation: "0.00",
        boostClaimed: "0.00",
        depreciationClaimed: "0.00",
        recovered: money(share(recovered, input.businessUsePercent)),
        loss: money(share(loss, input.businessUsePercent)),
        closingAtv: "0.00",
        disposed: true,
      });
      break;
    }
    const first = !input.opening && year === acquiredYear;
    const months = first ? monthsToYearEnd(input.availableOn) : 12;
    let boost = ZERO_DECIMAL;
    let depreciation = ZERO_DECIMAL;
    if (input.method === "low_value") {
      if (first) depreciation = atv;
    } else if (input.method === "dv" || input.method === "sl") {
      if (first) {
        boost = boostAmount;
        atv = sub(atv, boost);
      }
      const rate = input.rate ?? ZERO_DECIMAL;
      const base = input.method === "dv" ? atv : slBase;
      depreciation = roundHalfUp(divide(mul(mul(base, rate), dec(String(months))), dec("1200"), 6), 2);
      depreciation = min(depreciation, atv);
    }
    atv = sub(atv, depreciation);
    rows.push({
      incomeYear: year,
      months,
      openingAtv: money(opening),
      investmentBoost: money(boost),
      depreciation: money(depreciation),
      boostClaimed: money(share(boost, input.businessUsePercent)),
      depreciationClaimed: money(share(depreciation, input.businessUsePercent)),
      recovered: "0.00",
      loss: "0.00",
      closingAtv: money(atv),
      disposed: false,
    });
  }
  return rows;
}

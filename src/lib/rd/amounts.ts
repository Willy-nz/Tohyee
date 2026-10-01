import { ValidationError } from "@/lib/errors";
import { addDays, financialYearEnd, financialYearStart, isFinancialYearEndMonth } from "@/lib/financial-year";
import { cmp, dec, divideTruncated, isZero, mul, sub, sum, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";

/**
 * R&D Tax Incentive figures for stage R2 (docs/ACCOUNTING-EXAMPLES.md RD8,
 * RD11-RD13, RD21-RD23; docs/DECISIONS.md 30-50). Browser-safe, so the R&D
 * screens show the same figures as the server. Every R&D share is rounded
 * down to the cent so a claim is never overstated (decisions 32 and 50).
 */

/** The supplementary return's categories a cost line can be tagged with (IR1240 p 104; IR1060). */
export const RD_LINE_CATEGORIES = ["employee", "materials_overheads", "contract", "approved_research_provider"] as const;
export type RdLineCategory = (typeof RD_LINE_CATEGORIES)[number];
/** Line categories plus R&D tax depreciation, which comes only from fixed assets (RD11). */
export type RdCategory = RdLineCategory | "depreciation";

export const RD_CATEGORY_LABELS: Record<RdCategory, string> = {
  employee: "Employee related costs",
  materials_overheads: "Materials, consumables and overheads",
  depreciation: "R&D tax depreciation",
  contract: "Contract expenditure",
  approved_research_provider: "Approved research provider",
};

/**
 * Why tagged expenditure isn't eligible (Schedule 21B Part B and LY 5; IR1240
 * p 16, p 74-84). Reasons Tohyee works out itself in the claim report (the
 * minimum, the maximum, the overseas limit, goods not used by year end) aren't
 * chosen here; GST, unpaid time and exchange gains and losses are never tagged.
 */
export const RD_INELIGIBLE_REASONS = {
  someone_elses: { label: "Someone else's eligible expenditure", source: "LY 5(3); IR1240 p 74" },
  acquiring_depreciable_property: { label: "Acquiring depreciable property", source: "Sch 21B B cl 2; IR1240 p 76" },
  depreciable_tangible_property: {
    label: "Cost of depreciable tangible property (except prototypes used only for R&D)",
    source: "Sch 21B B cl 3; IR1240 p 76-77",
  },
  depreciation_already_eligible: {
    label: "Depreciation where the cost was already eligible; pooled property; loss on sale",
    source: "Sch 21B B cl 4-6; IR1240 p 77-78",
  },
  associates: { label: "Associates: depreciation, profit margins, leases above market", source: "Sch 21B B cl 7-9; IR1240 p 78" },
  mining: { label: "Mining", source: "Sch 21B B cl 3B; IR1240 p 79" },
  acquiring_land: { label: "Acquiring land", source: "Sch 21B B cl 10; IR1240 p 79" },
  interest_financing: { label: "Interest and financing", source: "Sch 21B B cl 11-12; IR1240 p 79" },
  working_out_entitlement: { label: "Working out the R&D entitlement", source: "Sch 21B B cl 13; IR1240 p 79" },
  corporate_governance: { label: "Corporate governance", source: "Sch 21B B cl 13B; IR1240 p 79" },
  intangible_property: { label: "Intangible property other than software (e.g. royalties)", source: "Sch 21B B cl 14; IR1240 p 80" },
  bespoke_software: { label: "Bespoke software; internal software development over $25 million", source: "Sch 21B B cl 15-16; IR1240 p 80, p 85" },
  above_market_gifts_technology: { label: "Above market value; gifts; ineligible technology", source: "Sch 21B B cl 17-19; IR1240 p 80-82" },
  commercialisation: { label: "Commercialisation", source: "Sch 21B B cl 20; IR1240 p 79" },
  decommissioning_remediation: { label: "Decommissioning; remediating land", source: "Sch 21B B cl 20B-20C; IR1240 p 80" },
  government_grant: { label: "Government and local authority grants (including co-funding)", source: "Sch 21B B cl 21; IR1240 p 82-84" },
  foreign_tax_credit: { label: "Gets a foreign R&D tax credit", source: "Sch 21B B cl 23; IR1240 p 84" },
  other: { label: "Other (say why in the note)", source: "" },
} as const;
export type RdIneligibleReason = keyof typeof RD_INELIGIBLE_REASONS;
export const RD_INELIGIBLE_REASON_CODES = Object.keys(RD_INELIGIBLE_REASONS) as RdIneligibleReason[];

/** The flags the supplementary return asks about (IR1240 p 105). */
export const RD_FLAGS = ["overseas", "commercialProduction", "internalSoftware", "feedstock"] as const;
export type RdFlag = (typeof RD_FLAGS)[number];
export const RD_FLAG_LABELS: Record<RdFlag, string> = {
  overseas: "Overseas",
  commercialProduction: "Commercial production",
  internalSoftware: "Internal software development",
  feedstock: "Feedstock",
};

/** Records entered more than this many days after the work are flagged "entered late" (decision 38). */
export const RD_LATE_AFTER_DAYS = 14;

/** Activities are core or supporting; only supporting ones can be overseas (LY 2; IR1240 p 11-12). */
export const RD_ACTIVITY_KINDS = ["core", "supporting"] as const;
export type RdActivityKind = (typeof RD_ACTIVITY_KINDS)[number];
export const RD_PLACES = ["nz", "overseas"] as const;
export type RdPlace = (typeof RD_PLACES)[number];
export const RD_PLACE_LABELS: Record<RdPlace, string> = { nz: "New Zealand", overseas: "Overseas" };

const HUNDRED = dec("100");

/**
 * An income year is the organisation's financial year, numbered by the
 * calendar year it ends in: with a 31 March balance date, 1 Apr 2026 - 31 Mar
 * 2027 is 2027, shown as "2026-27".
 */
export function incomeYearOf(date: string, yearEndMonth: number): number {
  return Number(financialYearEnd(date, yearEndMonth).slice(0, 4));
}

/** First and last day of an income year. */
export function incomeYearDates(year: number, yearEndMonth: number): { start: string; end: string } {
  if (!Number.isInteger(year) || year < 2000 || year > 2999) throw new ValidationError("An income year must be a year like 2027.");
  if (!isFinancialYearEndMonth(yearEndMonth)) throw new Error(`Invalid financial year end month: ${yearEndMonth}`);
  const end = financialYearEnd(`${year}-${String(yearEndMonth).padStart(2, "0")}-01`, yearEndMonth);
  return { start: financialYearStart(end, yearEndMonth), end };
}

/** "2026-27" for a year spanning two calendar years, "2026" for a calendar year. */
export function incomeYearLabel(year: number, yearEndMonth: number): string {
  if (yearEndMonth === 12) return String(year);
  return `${year - 1}-${String(year % 100).padStart(2, "0")}`;
}

/** The first day after an income year. */
export function incomeYearAfter(year: number, yearEndMonth: number): string {
  return addDays(incomeYearDates(year, yearEndMonth).end, 1);
}

/**
 * A line's R&D share: amount × percentage / 100, rounded down to the base
 * currency's minor unit (RD8: 4,000.00 at 100% is 4,000.00).
 */
export function rdShare(lineAmount: string, percentage: string, scale: number): string {
  return toFixedString(divideTruncated(mul(dec(lineAmount), dec(percentage)), HUNDRED, scale), scale);
}

/**
 * What a tag counts towards its category: its share less what wasn't used by
 * year end (decision 41) and the contractor's own ineligible costs (LY 6;
 * RD12). Never below zero.
 */
export function countedAmount(amount: string, unusedAmount: string, contractorIneligibleAmount: string, scale: number): string {
  const counted = sub(sub(dec(amount), dec(unusedAmount)), dec(contractorIneligibleAmount));
  return toFixedString(cmp(counted, ZERO_DECIMAL) < 0 ? ZERO_DECIMAL : counted, scale);
}

/**
 * Splits an asset's tax depreciation (with Investment Boost) by its usage
 * log (RD11): each activity gets total × its hours / all hours logged,
 * rounded down to the cent; the rest is other work. Hours on other work have
 * the key null.
 */
export function usageSplit(
  total: string,
  hours: ReadonlyArray<{ key: string | null; hours: string }>,
  scale: number,
): { shares: { key: string; hours: string; amount: string }[]; totalHours: string; otherHours: string; other: string } {
  const allHours: Decimal = sum(hours.map((row) => dec(row.hours)));
  const byKey = new Map<string, Decimal>();
  let other: Decimal = ZERO_DECIMAL;
  for (const row of hours) {
    if (row.key == null) other = sum([other, dec(row.hours)]);
    else byKey.set(row.key, sum([byKey.get(row.key) ?? ZERO_DECIMAL, dec(row.hours)]));
  }
  const shares = [...byKey.entries()].map(([key, keyHours]) => ({
    key,
    hours: toFixedString(keyHours, 2),
    amount: toFixedString(isZero(allHours) ? ZERO_DECIMAL : divideTruncated(mul(dec(total), keyHours), allHours, scale), scale),
  }));
  const rest = sub(dec(total), sum(shares.map((share) => dec(share.amount))));
  return { shares, totalHours: toFixedString(allHours, 2), otherHours: toFixedString(other, 2), other: toFixedString(rest, scale) };
}

/** Whole days from one YYYY-MM-DD date to another (later is positive). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Flagged when entered more than 14 days after the work (decision 38; RD21, RD22). */
export function isEnteredLate(daysAfterWork: number): boolean {
  return daysAfterWork > RD_LATE_AFTER_DAYS;
}

/** "entered 2 days after the work", "entered on the day of the work". */
export function enteredAfterText(daysAfterWork: number): string {
  if (daysAfterWork <= 0) return "entered on the day of the work";
  return `entered ${daysAfterWork} day${daysAfterWork === 1 ? "" : "s"} after the work`;
}

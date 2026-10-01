import { add, cmp, dec, divideTruncated, isZero, mul, sub, sum, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";
import type { RdActivityKind, RdCategory } from "@/lib/rd/amounts";

/**
 * The R&D tax credit worked out from the amounts that count (examples RD16-RD20,
 * RD26, RD36, RD40; decisions 30-32, 43, 44, 60, 62). Pure and browser-safe.
 *
 * Income Tax Act 2007 (checked 1 Oct 2026, docs/sources/income-tax-act-ly-and-esct.md):
 * - LY 4(1)(a): eligible expenditure "is $50,000 or more for the year";
 *   LY 4(1)(b) and Sch 21B B cl 24: otherwise only expenditure for an approved
 *   research provider counts.
 * - LY 4(2): credit = 0.15 × total eligible R&D expenditure; LY 4(3): at most
 *   $120 million.
 * - LY 7(2), (5), (6): foreign R&D expenditure counts only up to
 *   0.1 × total NZ R&D expenditure ÷ 0.9.
 * Every figure is rounded down to the cent so a claim is never overstated.
 */

/** LY 4(1)(a). */
export const RD_MINIMUM_EXPENDITURE = "50000";
/** LY 4(3)(a). */
export const RD_MAXIMUM_EXPENDITURE = "120000000";
/** LY 4(2), as a percentage. */
export const RD_CREDIT_PERCENT = "15";
/** LY 7(5): the overseas limit is 0.1 / 0.9 = 1/9 of NZ eligible expenditure. */
const OVERSEAS_DIVISOR = dec("9");
const HUNDRED = dec("100");

export const RD_CLAIM_CATEGORIES: readonly RdCategory[] = ["materials_overheads", "depreciation", "employee", "contract", "approved_research_provider"];

/** Amounts that count, for one activity and category, before the overseas limit. */
export type ClaimBucketInput = {
  activityId: string;
  activityCode: string;
  projectName: string;
  kind: RdActivityKind;
  category: RdCategory;
  overseas: boolean;
  internalSoftware: boolean;
  commercialProduction: boolean;
  /** Supporting activity from the year before its core activity's first year (RD4). */
  carriedIn: boolean;
  amount: string;
};

export type ClaimBucket = ClaimBucketInput & {
  /** After the overseas limit. */
  counted: string;
  overLimit: string;
  /** What goes in the return: the counted amount, or 0 when the minimum isn't met (only approved research provider expenditure then). */
  claimed: string;
};

export type ClaimStatus = "meets_minimum" | "approved_research_provider_only" | "under_minimum" | "nothing";

export type ClaimProject = {
  projectName: string;
  categories: Record<RdCategory, string>;
  overseasSpent: string;
  overseasCounted: string;
  overseasOverLimit: string;
  total: string;
  coreAmount: string;
  supportingAmount: string;
  /** Core activities' share of the total, % to two decimals rounded down (decision 44); null when nothing is claimed. */
  coreShare: string | null;
  internalSoftware: string;
  commercialProduction: string;
  carriedIn: string;
};

export type ClaimFigures = {
  buckets: ClaimBucket[];
  nzTotal: string;
  overseasSpent: string;
  overseasLimit: string;
  overseasCounted: string;
  overseasOverLimit: string;
  totalEligible: string;
  approvedResearchProvider: string;
  status: ClaimStatus;
  minimum: string;
  maximum: string;
  overMaximum: string;
  /** Total eligible expenditure the credit is worked on. */
  claimed: string;
  credit: string;
  coreShare: string | null;
  categories: Record<RdCategory, string>;
  projects: ClaimProject[];
};

function percentDown(part: Decimal, whole: Decimal): string | null {
  if (isZero(whole)) return null;
  return toFixedString(divideTruncated(mul(part, HUNDRED), whole, 2), 2);
}

/**
 * Shares `limit` across `amounts` in proportion, each rounded down to the
 * cent, with the cents left over going one each to the largest remainders
 * (the earlier first on a tie) so the parts add up to the limit (decision 60).
 */
function shareOut(amounts: Decimal[], limit: Decimal, scale: number): Decimal[] {
  const total = sum(amounts);
  if (isZero(total)) return amounts.map(() => ZERO_DECIMAL);
  const parts = amounts.map((amount) => divideTruncated(mul(amount, limit), total, scale));
  // Exact remainder × total, compared without dividing.
  const remainders = amounts.map((amount, index) => sub(mul(amount, limit), mul(parts[index], total)));
  const cent = dec(scale === 0 ? "1" : `0.${"0".repeat(scale - 1)}1`);
  let left = sub(limit, sum(parts));
  const order = remainders.map((remainder, index) => ({ remainder, index })).sort((a, b) => cmp(b.remainder, a.remainder) || a.index - b.index);
  for (const { index } of order) {
    if (cmp(left, cent) < 0) break;
    parts[index] = add(parts[index], cent);
    left = sub(left, cent);
  }
  return parts;
}

function emptyCategories(zero: string): Record<RdCategory, string> {
  return { materials_overheads: zero, depreciation: zero, employee: zero, contract: zero, approved_research_provider: zero };
}

export function calculateClaim(inputs: readonly ClaimBucketInput[], scale: number): ClaimFigures {
  const fixed = (value: Decimal) => toFixedString(value, scale);
  const zero = fixed(ZERO_DECIMAL);
  const nz = sum(inputs.filter((input) => !input.overseas).map((input) => dec(input.amount)));
  const overseas = inputs.filter((input) => input.overseas);
  const overseasSpent = sum(overseas.map((input) => dec(input.amount)));
  const limit = divideTruncated(nz, OVERSEAS_DIVISOR, scale);
  const overseasCounted = cmp(overseasSpent, limit) <= 0 ? overseasSpent : limit;
  const overseasShares = cmp(overseasSpent, limit) <= 0 ? overseas.map((input) => dec(input.amount)) : shareOut(overseas.map((input) => dec(input.amount)), limit, scale);

  let overseasIndex = 0;
  const counted = inputs.map((input) => (input.overseas ? overseasShares[overseasIndex++] : dec(input.amount)));
  const totalEligible = add(nz, overseasCounted);
  const approvedResearchProvider = sum(inputs.map((input, index) => (input.category === "approved_research_provider" ? counted[index] : ZERO_DECIMAL)));
  const minimum = dec(RD_MINIMUM_EXPENDITURE);
  const maximum = dec(RD_MAXIMUM_EXPENDITURE);
  const status: ClaimStatus = isZero(totalEligible)
    ? "nothing"
    : cmp(totalEligible, minimum) >= 0
      ? "meets_minimum"
      : !isZero(approvedResearchProvider)
        ? "approved_research_provider_only"
        : "under_minimum";
  const claimedBuckets = inputs.map((input, index) =>
    status === "meets_minimum" || (status === "approved_research_provider_only" && input.category === "approved_research_provider") ? counted[index] : ZERO_DECIMAL,
  );
  const claimedTotal = sum(claimedBuckets);
  const overMaximum = cmp(claimedTotal, maximum) > 0 ? sub(claimedTotal, maximum) : ZERO_DECIMAL;
  const claimed = cmp(claimedTotal, maximum) > 0 ? maximum : claimedTotal;
  const credit = divideTruncated(mul(claimed, dec(RD_CREDIT_PERCENT)), HUNDRED, scale);

  const buckets: ClaimBucket[] = inputs.map((input, index) => ({
    ...input,
    amount: fixed(dec(input.amount)),
    counted: fixed(counted[index]),
    overLimit: fixed(sub(dec(input.amount), counted[index])),
    claimed: fixed(claimedBuckets[index]),
  }));

  const projectNames = [...new Set(inputs.map((input) => input.projectName))].sort((a, b) => a.localeCompare(b));
  const projects: ClaimProject[] = projectNames.map((projectName) => {
    const mine = buckets.filter((bucket) => bucket.projectName === projectName);
    const total = (list: ClaimBucket[], field: "claimed" | "amount" | "counted" | "overLimit") => sum(list.map((bucket) => dec(bucket[field])));
    const categories = emptyCategories(zero);
    for (const category of RD_CLAIM_CATEGORIES) categories[category] = fixed(total(mine.filter((bucket) => bucket.category === category), "claimed"));
    const projectTotal = total(mine, "claimed");
    const core = total(mine.filter((bucket) => bucket.kind === "core"), "claimed");
    const abroad = mine.filter((bucket) => bucket.overseas);
    return {
      projectName,
      categories,
      overseasSpent: fixed(total(abroad, "amount")),
      overseasCounted: fixed(total(abroad, "claimed")),
      overseasOverLimit: fixed(total(abroad, "overLimit")),
      total: fixed(projectTotal),
      coreAmount: fixed(core),
      supportingAmount: fixed(sub(projectTotal, core)),
      coreShare: percentDown(core, projectTotal),
      internalSoftware: fixed(total(mine.filter((bucket) => bucket.internalSoftware), "claimed")),
      commercialProduction: fixed(total(mine.filter((bucket) => bucket.commercialProduction), "claimed")),
      carriedIn: fixed(total(mine.filter((bucket) => bucket.carriedIn), "claimed")),
    };
  });

  const categories = emptyCategories(zero);
  for (const category of RD_CLAIM_CATEGORIES) {
    categories[category] = fixed(sum(buckets.filter((bucket) => bucket.category === category).map((bucket) => dec(bucket.claimed))));
  }
  const coreClaimed = sum(buckets.filter((bucket) => bucket.kind === "core").map((bucket) => dec(bucket.claimed)));

  return {
    buckets,
    nzTotal: fixed(nz),
    overseasSpent: fixed(overseasSpent),
    overseasLimit: fixed(limit),
    overseasCounted: fixed(overseasCounted),
    overseasOverLimit: fixed(sub(overseasSpent, overseasCounted)),
    totalEligible: fixed(totalEligible),
    approvedResearchProvider: fixed(approvedResearchProvider),
    status,
    minimum: fixed(minimum),
    maximum: fixed(maximum),
    overMaximum: fixed(overMaximum),
    claimed: fixed(claimed),
    credit: fixed(credit),
    coreShare: percentDown(coreClaimed, claimedTotal),
    categories,
    projects,
  };
}

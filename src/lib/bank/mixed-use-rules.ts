import { add, cmp, dec, isPositive, isZero, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Personal and mixed-use accounts (#545, examples MU1-MU14, decisions
 * 1308-1315): the rules that need no database, shared with the browser.
 */

export const ACCOUNT_USAGES = ["business", "mixed", "personal"] as const;
export type AccountUsage = (typeof ACCOUNT_USAGES)[number];

export const USAGE_LABELS: Record<AccountUsage, string> = {
  business: "Business only",
  mixed: "Mixed use",
  personal: "Personal",
};

/** One line each, for the guided choice (MU1). */
export const USAGE_SHORT: Record<AccountUsage, string> = {
  business: "Every line is the business's. Reconcile as usual.",
  mixed: "Some business, some household. Review each line.",
  personal: "Household account. Lines are private unless you pick one out.",
};

export const REVIEW_DECISIONS = ["business", "private", "split", "refund"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const DECISION_LABELS: Record<ReviewDecision, string> = {
  business: "Business",
  private: "Private",
  split: "Split",
  refund: "Refund",
};

/**
 * What a line can be reviewed as (MU2-MU8): money out is business, private
 * or split; money in is private or a refund of a business purchase. Money in
 * is never an expense or income here, so a card repayment can't be counted
 * as a business expense a second time (MU7).
 */
export function decisionsFor(amount: string): ReviewDecision[] {
  return amount.startsWith("-") ? ["business", "split", "private"] : ["refund", "private"];
}

/** Why `decision` doesn't suit a line of this amount, or null. */
export function decisionRefusal(decision: ReviewDecision, amount: string): string | null {
  if (decisionsFor(amount).includes(decision)) return null;
  if (amount.startsWith("-")) return "Money out can be business, split or private.";
  return "Money in on a mixed-use or personal account can only be a refund of a business purchase, or private (a card repayment, or household money).";
}

/**
 * The business and private parts of a line (MU2-MU4, MU8), as positive
 * amounts with the currency's places. `business` is what the person said is
 * business (for business: the whole line).
 */
export function lineParts(
  decision: ReviewDecision,
  amount: string,
  business: string | null,
  scale = 2,
): { business: string; private: string } {
  const total = dec(amount.replace(/^-/, ""));
  const fixed = (value: ReturnType<typeof dec>) => toFixedString(value, scale);
  if (decision === "private") return { business: fixed(ZERO_DECIMAL), private: fixed(total) };
  if (decision === "business") return { business: fixed(total), private: fixed(ZERO_DECIMAL) };
  if (business === null) throw new Error("A business amount is needed.");
  const part = dec(business);
  if (!isPositive(part)) throw new RangeError("The business part must be more than 0.00.");
  if (decision === "split" && cmp(part, total) >= 0) {
    throw new RangeError(`The business part must be less than the line (${fixed(total)}). If it's all business, choose Business.`);
  }
  if (cmp(part, total) > 0) throw new RangeError(`The business part can't be more than the line (${fixed(total)}).`);
  return { business: fixed(part), private: fixed(sub(total, part)) };
}

/** Whether any of these tax code categories carries GST (null: no tax code). */
export function claimsGst(categories: ReadonlyArray<string | null>): boolean {
  return categories.some((category) => category !== null && category !== "out_of_scope");
}

/**
 * A person claiming GST on a business part (MU5): only with the receipt or
 * tax invoice in hand. `status` is the organisation's GST status on the
 * line's date. Not registered is left to the posting itself (NR2).
 */
export function personGstRefusal(status: "registered" | "not_registered" | "unconfirmed", withGst: boolean, receiptHeld: boolean): string | null {
  if (!withGst || status === "not_registered" || receiptHeld) return null;
  return "To claim GST on a purchase from a personal or mixed-use account, tick that you have the receipt or tax invoice. Otherwise choose no GST.";
}

export type RefundPair = { accountCode: string; taxCode: string | null; amount: string };

/**
 * Whether a refund's lines reverse the original (MU8): each line uses one of
 * the original's account and tax code pairs, and per pair the refunds so far
 * plus this one are at most the original. Returns why not, or null.
 */
export function refundRefusal(original: readonly RefundPair[], earlier: readonly RefundPair[], refund: readonly RefundPair[]): string | null {
  const pairKey = (pair: RefundPair) => `${pair.accountCode.toLowerCase()}|${pair.taxCode ?? ""}`;
  const totals = (pairs: readonly RefundPair[]) => {
    const map = new Map<string, ReturnType<typeof dec>>();
    for (const pair of pairs) map.set(pairKey(pair), add(map.get(pairKey(pair)) ?? ZERO_DECIMAL, dec(pair.amount)));
    return map;
  };
  const allowed = totals(original);
  const used = totals(earlier);
  const asked = totals(refund);
  for (const pair of refund) {
    if (!allowed.has(pairKey(pair))) {
      return `A refund uses the original purchase's accounts and tax codes. ${pair.accountCode}${pair.taxCode ? ` with ${pair.taxCode}` : " with no GST"} wasn't on it.`;
    }
  }
  for (const [key, amount] of asked) {
    const left = sub(allowed.get(key)!, used.get(key) ?? ZERO_DECIMAL);
    if (cmp(amount, left) > 0) {
      const [account, tax] = key.split("|");
      return `That's more than is left to refund on ${account}${tax ? ` with ${tax}` : ""}: ${toFixedString(left, 2)}.`;
    }
  }
  return null;
}

/** What's left of an original's business part after earlier refunds, for showing. */
export function refundLeft(originalBusiness: string, earlierRefunds: readonly string[]): string {
  const left = earlierRefunds.reduce((total, amount) => sub(total, dec(amount)), dec(originalBusiness));
  return toFixedString(isZero(left) ? ZERO_DECIMAL : left, 2);
}

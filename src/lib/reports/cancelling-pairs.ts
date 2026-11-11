import { add, dec, isZero } from "@/lib/money/decimal";

/**
 * BK46 (Jess's issue 1, minor): pairs of items in the same month that cancel
 * out exactly (a payout's transfer and the journal that removed the same
 * payout counted twice, say). Each item is in at most one pair, taken in
 * date order; both the amount and the base amount must cancel, so leaving
 * the pairs out changes no total. Returns the ids to leave out.
 */
export function cancellingPairs<T extends { journalLineId: string; date: string; amount: string; baseAmount: string }>(items: readonly T[]): Set<string> {
  const hidden = new Set<string>();
  const sorted = [...items].sort((a, b) => (a.date === b.date ? Number(BigInt(a.journalLineId) - BigInt(b.journalLineId)) : a.date < b.date ? -1 : 1));
  for (let i = 0; i < sorted.length; i += 1) {
    const item = sorted[i];
    if (hidden.has(item.journalLineId) || isZero(dec(item.amount))) continue;
    const month = item.date.slice(0, 7);
    for (let j = i + 1; j < sorted.length; j += 1) {
      const other = sorted[j];
      if (other.date.slice(0, 7) !== month) break;
      if (hidden.has(other.journalLineId)) continue;
      if (isZero(add(dec(item.amount), dec(other.amount))) && isZero(add(dec(item.baseAmount), dec(other.baseAmount)))) {
        hidden.add(item.journalLineId);
        hidden.add(other.journalLineId);
        break;
      }
    }
  }
  return hidden;
}

import { add, type Decimal, neg, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Ageing maths shared by aged receivables (RC9-RC11), aged payables
 * (AGP1-AGP3) and customer statements (CST1-CST3): how many days past its due
 * date a document is on a date, which bucket that puts it in, and the bucket
 * totals less unused credit. Pure, so it's unit tested on its own.
 */

export const AGE_BUCKETS = ["current", "days1to30", "days31to60", "days61to90", "over90"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export type AgedAmounts = Record<AgeBucket, string> & { credit: string; total: string };

export type Buckets = Record<AgeBucket | "credit", Decimal>;

export function emptyBuckets(): Buckets {
  return { current: ZERO_DECIMAL, days1to30: ZERO_DECIMAL, days31to60: ZERO_DECIMAL, days61to90: ZERO_DECIMAL, over90: ZERO_DECIMAL, credit: ZERO_DECIMAL };
}

export function addBuckets(left: Buckets, right: Buckets): Buckets {
  const out = emptyBuckets();
  for (const key of [...AGE_BUCKETS, "credit"] as const) out[key] = add(left[key], right[key]);
  return out;
}

/** The buckets as strings, with the total (the buckets less the credit). */
export function toAmounts(buckets: Buckets, scale: number): AgedAmounts {
  const total = sum([...AGE_BUCKETS.map((key) => buckets[key]), neg(buckets.credit)]);
  const out = { credit: toFixedString(buckets.credit, scale), total: toFixedString(total, scale) } as AgedAmounts;
  for (const key of AGE_BUCKETS) out[key] = toFixedString(buckets[key], scale);
  return out;
}

/** Current (not yet due, or due that day), 1-30, 31-60, 61-90 or over 90 days past due. */
export function bucketFor(daysOverdue: number): AgeBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "days1to30";
  if (daysOverdue <= 60) return "days31to60";
  if (daysOverdue <= 90) return "days61to90";
  return "over90";
}

/** Whole days from one YYYY-MM-DD date to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The day before a YYYY-MM-DD date. */
export function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

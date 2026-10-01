import { abs, add, dec, isNegative, isZero, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * The pure part of posting the leave liability (decision 177; decisions
 * 182-187; HL52-HL56): the change in the liability by Department since the
 * last posting not voided, and the journal lines for it. Amounts are cents
 * strings; nothing here rounds.
 */

/** The liability for one Department (null: no Department). */
export type DepartmentLiability = { departmentId: string | null; liability: string };

export type DepartmentChange = { departmentId: string | null; previous: string; current: string; change: string };

const keyOf = (departmentId: string | null) => departmentId ?? "";

/**
 * Each Department's change: the liability now less what the last posting
 * not voided left for it. Departments in either list, those now first in
 * their order, then those only posted before. Unchanged ones are left out.
 */
export function liabilityChanges(current: readonly DepartmentLiability[], previous: readonly DepartmentLiability[]): DepartmentChange[] {
  const before = new Map<string, DepartmentLiability>();
  for (const entry of previous) {
    const existing = before.get(keyOf(entry.departmentId));
    before.set(keyOf(entry.departmentId), { departmentId: entry.departmentId, liability: toFixedString(add(dec(existing?.liability ?? "0"), dec(entry.liability)), 2) });
  }
  const now = new Map<string, DepartmentLiability>();
  for (const entry of current) {
    const existing = now.get(keyOf(entry.departmentId));
    now.set(keyOf(entry.departmentId), { departmentId: entry.departmentId, liability: toFixedString(add(dec(existing?.liability ?? "0"), dec(entry.liability)), 2) });
  }
  const changes: DepartmentChange[] = [];
  const keys = [...now.keys(), ...[...before.keys()].filter((key) => !now.has(key))];
  for (const key of keys) {
    const departmentId = (now.get(key) ?? before.get(key)!).departmentId;
    const previousAmount = dec(before.get(key)?.liability ?? "0");
    const currentAmount = dec(now.get(key)?.liability ?? "0");
    const change = sub(currentAmount, previousAmount);
    if (isZero(change)) continue;
    changes.push({ departmentId, previous: toFixedString(previousAmount, 2), current: toFixedString(currentAmount, 2), change: toFixedString(change, 2) });
  }
  return changes;
}

export type PostingLine = {
  /** The tracking group the lines are tagged with (Department tags, or "" when advanced features are off). */
  group: string;
  account: "expense" | "liability";
  debit: string;
  credit: string;
};

/**
 * The journal lines for the changes, two per tracking group: a rise is Dr
 * leave expense / Cr employee entitlements (HL52), a fall Dr employee
 * entitlements / Cr leave expense (HL53). Changes in the same group are
 * netted first (all Departments are one group when advanced features are
 * off); a group that nets to 0.00 has no lines.
 */
export function postingLines(changes: ReadonlyArray<{ group: string; change: string }>): PostingLine[] {
  const groups = new Map<string, ReturnType<typeof dec>>();
  for (const entry of changes) groups.set(entry.group, add(groups.get(entry.group) ?? ZERO_DECIMAL, dec(entry.change)));
  const lines: PostingLine[] = [];
  for (const [group, change] of groups) {
    if (isZero(change)) continue;
    const amount = toFixedString(abs(change), 2);
    if (isNegative(change)) {
      lines.push({ group, account: "liability", debit: amount, credit: "0.00" }, { group, account: "expense", debit: "0.00", credit: amount });
    } else {
      lines.push({ group, account: "expense", debit: amount, credit: "0.00" }, { group, account: "liability", debit: "0.00", credit: amount });
    }
  }
  return lines;
}

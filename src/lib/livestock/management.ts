import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { addDays, financialYearStart, monthEndOf } from "@/lib/financial-year";
import { add, dec, type Decimal, mul, parseDecimalInput, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requireArray, requireOneOf, requireString } from "@/lib/validation";
import { classKey, className, findClass, KIND_NAMES, LIVESTOCK_CLASSES, LIVESTOCK_KINDS, type LivestockKind } from "./classes";
import { herdBalancesAt, requireLivestock, requireYearEnd } from "./movements";

/*
 * Monthly management valuations (LV18-LV20, decision 506): stock on hand at
 * each month end at the farm's own values per head, with each month's change
 * split into quantity and price. A report only: it never posts, and never
 * changes tax values, elections or an approved valuation.
 */

export type ManagementValue = { kind: LivestockKind; classCode: string; className: string; effectiveMonth: string; amount: string };

const money = (value: Decimal) => toFixedString(value, 2);

export async function listManagementValues(tx: OrgTx): Promise<ManagementValue[]> {
  const rows = await tx.query<{ kind: LivestockKind; class_code: string; effective_month: string; amount: string }>(
    "select kind, class_code, effective_month::text, amount::text from livestock_management_values order by effective_month, kind, class_code",
  );
  return rows.rows.map((row) => ({ kind: row.kind, classCode: row.class_code, className: className(row.kind, row.class_code), effectiveMonth: row.effective_month, amount: row.amount }));
}

/** Sets values per head from a month on (one value for a whole year is one row from its first month). Bookkeepers and up. */
export async function setManagementValues(tx: OrgTx, input: { effectiveMonth: unknown; lines: unknown }): Promise<ManagementValue[]> {
  await requireLivestock(tx);
  const date = parseIsoDate(input.effectiveMonth, "From month");
  const effectiveMonth = `${date.slice(0, 7)}-01`;
  const lines = requireArray(input.lines, "lines", 100);
  for (const [index, raw] of lines.entries()) {
    const line = (raw ?? {}) as Record<string, unknown>;
    const label = `Line ${index + 1}`;
    const kind = requireOneOf(line.kind, `${label} kind`, LIVESTOCK_KINDS);
    const classCode = requireString(line.classCode, `${label} class`, { maxLength: 50 });
    if (!findClass(kind, classCode)) throw new ValidationError(`${label}: ${KIND_NAMES[kind]} has no class "${classCode}".`);
    if (line.amount === null || line.amount === "") {
      await tx.query("delete from livestock_management_values where kind = $1 and class_code = $2 and effective_month = $3", [kind, classCode, effectiveMonth]);
      continue;
    }
    const amount = parseDecimalInput(line.amount, `${label} value per head`, { maxScale: 2, allowZero: true });
    await tx.query(
      `insert into livestock_management_values (kind, class_code, effective_month, amount, updated_by_email) values ($1, $2, $3, $4::numeric, $5)
       on conflict (kind, class_code, effective_month) do update set amount = excluded.amount, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [kind, classCode, effectiveMonth, amount, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: "livestock.management_values_set", entityType: "livestock_settings", entityId: "1", details: { effectiveMonth, lines: lines.length } });
  return listManagementValues(tx);
}

export type ManagementMonth = {
  monthEnd: string;
  head: number;
  value: string;
  /** Change from the month before: head changes at last month's values, and value changes on this month's head. */
  change: string;
  quantityChange: string;
  priceChange: string;
  classes: Array<{ kind: LivestockKind; classCode: string; className: string; head: number; perHead: string | null; value: string }>;
};

export type ManagementReport = {
  yearStart: string;
  yearEnd: string;
  opening: { monthEnd: string; head: number; value: string };
  months: ManagementMonth[];
  /** Classes with stock but no value per head (valued at 0.00 until one is set). */
  missingValues: Array<{ kind: LivestockKind; classCode: string; className: string }>;
};

/** Stock on hand at management values for each month end of a year (LV18, LV19). */
export async function managementReport(tx: OrgTx, input: { yearEnd: unknown }): Promise<ManagementReport> {
  const settings = await requireLivestock(tx);
  const yearEnd = requireYearEnd(settings, input.yearEnd);
  const yearStart = financialYearStart(yearEnd, settings.financialYearEndMonth);
  const openingDate = addDays(yearStart, -1);
  const monthEnds: string[] = [];
  for (let date = monthEndOf(yearStart); date <= yearEnd; date = monthEndOf(addDays(date, 1))) monthEnds.push(date);
  const balances = await herdBalancesAt(tx, [openingDate, ...monthEnds]);
  const values = await listManagementValues(tx);
  const perHead = (key: string, date: string): string | null => {
    let found: string | null = null;
    for (const value of values) {
      if (classKey(value.kind, value.classCode) === key && value.effectiveMonth <= date) found = value.amount;
    }
    return found;
  };
  const missing = new Set<string>();
  // The opening is valued at the year's first values, so a value set for the whole year covers it.
  const valueAt = (date: string, priceDate = date) => {
    const heads = balances.get(date) ?? new Map<string, number>();
    const classes: ManagementMonth["classes"] = [];
    let total = ZERO_DECIMAL;
    let head = 0;
    for (const definition of LIVESTOCK_CLASSES) {
      const key = classKey(definition.kind, definition.code);
      const count = heads.get(key) ?? 0;
      if (count === 0) continue;
      const rate = perHead(key, priceDate);
      if (rate === null) missing.add(key);
      const value = rate === null ? ZERO_DECIMAL : mul(dec(String(count)), dec(rate));
      classes.push({ kind: definition.kind, classCode: definition.code, className: definition.name, head: count, perHead: rate, value: money(value) });
      total = add(total, value);
      head += count;
    }
    return { classes, total, head, heads };
  };
  const opening = valueAt(openingDate, yearStart);
  let previous = { date: yearStart, ...opening };
  const months: ManagementMonth[] = [];
  for (const monthEnd of monthEnds) {
    const current = valueAt(monthEnd);
    // Quantity: the change in head at last month's values per head; price: the change in values on this month's head.
    let quantity = ZERO_DECIMAL;
    for (const definition of LIVESTOCK_CLASSES) {
      const key = classKey(definition.kind, definition.code);
      const delta = (current.heads.get(key) ?? 0) - (previous.heads.get(key) ?? 0);
      if (delta === 0) continue;
      const rate = perHead(key, previous.date) ?? perHead(key, monthEnd) ?? "0";
      quantity = add(quantity, mul(dec(String(delta)), dec(rate)));
    }
    const change = sub(current.total, previous.total);
    months.push({
      monthEnd,
      head: current.head,
      value: money(current.total),
      change: money(change),
      quantityChange: money(quantity),
      priceChange: money(sub(change, quantity)),
      classes: current.classes,
    });
    previous = { date: monthEnd, ...current };
  }
  return {
    yearStart,
    yearEnd,
    opening: { monthEnd: openingDate, head: opening.head, value: money(opening.total) },
    months,
    missingValues: [...missing].map((key) => {
      const [kind, code] = key.split(".");
      return { kind: kind as LivestockKind, classCode: code, className: className(kind, code) };
    }),
  };
}

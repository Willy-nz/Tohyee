import { RECEIVABLES_SQL } from "@/lib/customers/service";
import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, type Decimal, isZero, neg, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Aged receivables (examples RC9-RC11): what each customer owes as at a date,
 * by how long it's been due (from each invoice's due date), less credit not
 * yet used, worked out from the documents. With `rollUp` a parent customer
 * also shows the total of it and its sub-customers (RC10). The total equals
 * accounts receivable on the balance sheet as at the same date.
 */

export const AGE_BUCKETS = ["current", "days1to30", "days31to60", "days61to90", "over90"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export type AgedAmounts = Record<AgeBucket, string> & { credit: string; total: string };

export type AgedInvoice = { id: string; invoiceNumber: string | null; invoiceDate: string; dueDate: string; daysOverdue: number; amountDue: string };

export type AgedRow = {
  contactId: string;
  name: string;
  parentContactId: string | null;
  /** 0 for a top-level customer; 1 for its subs, and so on (only with roll-up). */
  depth: number;
  /** This customer's own figures. */
  amounts: AgedAmounts;
  /** With roll-up, this customer and everything under it; null when it has no subs with a balance. */
  rolledUp: AgedAmounts | null;
  invoices: AgedInvoice[];
};

export type AgedReceivables = { asAt: string; rollUp: boolean; currencyCode: string; rows: AgedRow[]; total: AgedAmounts };

type Buckets = Record<AgeBucket | "credit", Decimal>;

function emptyBuckets(): Buckets {
  return { current: ZERO_DECIMAL, days1to30: ZERO_DECIMAL, days31to60: ZERO_DECIMAL, days61to90: ZERO_DECIMAL, over90: ZERO_DECIMAL, credit: ZERO_DECIMAL };
}

function addBuckets(left: Buckets, right: Buckets): Buckets {
  const out = emptyBuckets();
  for (const key of [...AGE_BUCKETS, "credit"] as const) out[key] = add(left[key], right[key]);
  return out;
}

function toAmounts(buckets: Buckets, scale: number): AgedAmounts {
  const total = sum([...AGE_BUCKETS.map((key) => buckets[key]), neg(buckets.credit)]);
  const out = { credit: toFixedString(buckets.credit, scale), total: toFixedString(total, scale) } as AgedAmounts;
  for (const key of AGE_BUCKETS) out[key] = toFixedString(buckets[key], scale);
  return out;
}

function bucketFor(daysOverdue: number): AgeBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "days1to30";
  if (daysOverdue <= 60) return "days31to60";
  if (daysOverdue <= 90) return "days61to90";
  return "over90";
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export async function agedReceivables(tx: OrgTx, input: { asAt?: unknown; rollUp?: unknown }): Promise<AgedReceivables> {
  const asAt = parseOptionalIsoDate(input.asAt, "asAt") ?? todayIsoDate();
  const rollUp = input.rollUp === true || input.rollUp === "true";
  const scale = currencyMinorUnits(tx.baseCurrency);
  const invoiceRows = await tx.query<{
    id: string;
    contact_id: string;
    invoice_number: string | null;
    invoice_date: string;
    due_date: string;
    amount_due: string;
  }>(
    `${RECEIVABLES_SQL}
     select id, contact_id, invoice_number, invoice_date, due_date, amount_due::text from invoices
      where amount_due <> 0 order by due_date, id`,
    [asAt],
  );
  const creditRows = await tx.query<{ contact_id: string; unused: string }>(
    `${RECEIVABLES_SQL}
     select contact_id, sum(unused)::text as unused from credit where unused <> 0 group by contact_id`,
    [asAt],
  );
  const contactRows = await tx.query<{ id: string; name: string; parent_contact_id: string | null }>(
    "select id, name, parent_contact_id from contacts",
  );

  const own = new Map<string, { buckets: Buckets; invoices: AgedInvoice[] }>();
  const entry = (id: string) => {
    let found = own.get(id);
    if (!found) {
      found = { buckets: emptyBuckets(), invoices: [] };
      own.set(id, found);
    }
    return found;
  };
  for (const row of invoiceRows.rows) {
    const daysOverdue = daysBetween(row.due_date, asAt);
    const target = entry(row.contact_id);
    const bucket = bucketFor(daysOverdue);
    target.buckets[bucket] = add(target.buckets[bucket], dec(row.amount_due));
    target.invoices.push({
      id: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      dueDate: row.due_date,
      daysOverdue: Math.max(daysOverdue, 0),
      amountDue: toFixedString(dec(row.amount_due), scale),
    });
  }
  for (const row of creditRows.rows) {
    const target = entry(row.contact_id);
    target.buckets.credit = add(target.buckets.credit, dec(row.unused));
  }

  const contacts = new Map(contactRows.rows.map((row) => [row.id, row]));
  const byName = (a: string, b: string) => (contacts.get(a)?.name ?? "").localeCompare(contacts.get(b)?.name ?? "", "en-NZ", { sensitivity: "base" }) || Number(a) - Number(b);
  const hasBalance = (id: string) => {
    const found = own.get(id);
    return Boolean(found && ([...AGE_BUCKETS, "credit"] as const).some((key) => !isZero(found.buckets[key])));
  };
  const rowFor = (id: string, depth: number, rolled: Buckets | null): AgedRow => ({
    contactId: id,
    name: contacts.get(id)?.name ?? `#${id}`,
    parentContactId: contacts.get(id)?.parent_contact_id ?? null,
    depth,
    amounts: toAmounts(own.get(id)?.buckets ?? emptyBuckets(), scale),
    rolledUp: rolled ? toAmounts(rolled, scale) : null,
    invoices: own.get(id)?.invoices ?? [],
  });

  const rows: AgedRow[] = [];
  if (!rollUp) {
    for (const id of [...own.keys()].filter(hasBalance).sort(byName)) rows.push(rowFor(id, 0, null));
  } else {
    const children = new Map<string, string[]>();
    for (const row of contactRows.rows) {
      if (row.parent_contact_id) children.set(row.parent_contact_id, [...(children.get(row.parent_contact_id) ?? []), row.id]);
    }
    // Totals for each customer and everything under it (the database keeps the tree shallow and loop-free).
    const rolled = new Map<string, Buckets>();
    const total = (id: string): Buckets => {
      const cached = rolled.get(id);
      if (cached) return cached;
      const result = (children.get(id) ?? []).reduce((acc, child) => addBuckets(acc, total(child)), own.get(id)?.buckets ?? emptyBuckets());
      rolled.set(id, result);
      return result;
    };
    const anyBalance = (id: string): boolean => hasBalance(id) || (children.get(id) ?? []).some(anyBalance);
    const walk = (id: string, depth: number) => {
      const subs = (children.get(id) ?? []).filter(anyBalance).sort(byName);
      rows.push(rowFor(id, depth, subs.length > 0 ? total(id) : null));
      for (const child of subs) walk(child, depth + 1);
    };
    const tops = contactRows.rows.filter((row) => !row.parent_contact_id && anyBalance(row.id)).map((row) => row.id).sort(byName);
    for (const id of tops) walk(id, 0);
  }

  const grand = [...own.values()].reduce((acc, value) => addBuckets(acc, value.buckets), emptyBuckets());
  return { asAt, rollUp, currencyCode: tx.baseCurrency, rows, total: toAmounts(grand, scale) };
}

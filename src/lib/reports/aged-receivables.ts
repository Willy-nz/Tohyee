import { RECEIVABLES_SQL } from "@/lib/customers/service";
import type { CustomValues } from "@/lib/custom-fields/values";
import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, type Decimal, dec, isZero, neg, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { AGE_BUCKETS, type AgedAmounts, addBuckets, type Buckets, bucketFor, daysBetween, emptyBuckets, toAmounts } from "@/lib/reports/ageing";

/**
 * Aged receivables (examples RC9-RC11): what each customer owes as at a date,
 * by how long it's been due (from each invoice's due date), less credit not
 * yet used, worked out from the documents. With `rollUp` a parent customer
 * also shows the total of it and its sub-customers (RC10). The total equals
 * accounts receivable on the balance sheet as at the same date.
 */

export { AGE_BUCKETS, type AgeBucket, type AgedAmounts } from "@/lib/reports/ageing";

export type AgedInvoice = {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  dueDate: string;
  daysOverdue: number;
  /** In the invoice's currency. */
  amountDue: string;
  currencyCode: string;
  /** In the base currency, at the invoice's own rate (MC9); the same as amountDue for a base-currency invoice. */
  amountDueBase: string;
  customFields: CustomValues;
};

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
  /** A customer in another currency (MC9): its currency and what it owes in it (invoices less unused credit); null otherwise. */
  foreign: { currencyCode: string; total: string } | null;
};

export type AgedReceivables = {
  asAt: string;
  rollUp: boolean;
  /** The base currency: every bucket and total is in it, foreign-currency documents at their own rates (MC9). */
  currencyCode: string;
  rows: AgedRow[];
  total: AgedAmounts;
  /**
   * An unrealised FX revaluation of open foreign-currency invoices on accounts receivable on the date (MC8,
   * reversed the next day): the documents' total plus it is the ledger balance. 0.00 on other dates.
   */
  revaluation: string;
};

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
    currency_code: string;
    amount_due_base: string;
    custom_fields: CustomValues;
  }>(
    `${RECEIVABLES_SQL}
     select id, contact_id, invoice_number, invoice_date, due_date, amount_due::text, currency_code, amount_due_base::text, custom_fields from invoices
      where amount_due <> 0 or amount_due_base <> 0 order by due_date, id`,
    [asAt],
  );
  const creditRows = await tx.query<{ contact_id: string; unused: string; unused_base: string }>(
    `${RECEIVABLES_SQL}
     select contact_id, sum(unused)::text as unused, sum(unused_base)::text as unused_base from credit
      where unused <> 0 or unused_base <> 0 group by contact_id`,
    [asAt],
  );
  const contactRows = await tx.query<{ id: string; name: string; parent_contact_id: string | null; currency_code: string | null }>(
    "select id, name, parent_contact_id, currency_code from contacts",
  );

  // Buckets are in the base currency; a foreign-currency customer's own-currency total is kept beside them (MC9).
  const own = new Map<string, { buckets: Buckets; invoices: AgedInvoice[]; foreign: Decimal }>();
  const entry = (id: string) => {
    let found = own.get(id);
    if (!found) {
      found = { buckets: emptyBuckets(), invoices: [], foreign: ZERO_DECIMAL };
      own.set(id, found);
    }
    return found;
  };
  for (const row of invoiceRows.rows) {
    const daysOverdue = daysBetween(row.due_date, asAt);
    const target = entry(row.contact_id);
    const bucket = bucketFor(daysOverdue);
    target.buckets[bucket] = add(target.buckets[bucket], dec(row.amount_due_base));
    target.foreign = add(target.foreign, dec(row.amount_due));
    target.invoices.push({
      id: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      dueDate: row.due_date,
      daysOverdue: Math.max(daysOverdue, 0),
      amountDue: toFixedString(dec(row.amount_due), currencyMinorUnits(row.currency_code)),
      currencyCode: row.currency_code,
      amountDueBase: toFixedString(dec(row.amount_due_base), scale),
      customFields: row.custom_fields ?? {},
    });
  }
  for (const row of creditRows.rows) {
    const target = entry(row.contact_id);
    target.buckets.credit = add(target.buckets.credit, dec(row.unused_base));
    target.foreign = sub(target.foreign, dec(row.unused));
  }

  const contacts = new Map(contactRows.rows.map((row) => [row.id, row]));
  const foreignOf = (id: string) => {
    const currency = contacts.get(id)?.currency_code;
    return currency && currency !== tx.baseCurrency
      ? { currencyCode: currency, total: toFixedString(own.get(id)?.foreign ?? ZERO_DECIMAL, currencyMinorUnits(currency)) }
      : null;
  };
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
    foreign: foreignOf(id),
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
  return {
    asAt,
    rollUp,
    currencyCode: tx.baseCurrency,
    rows,
    total: toAmounts(grand, scale),
    revaluation: await controlRevaluation(tx, "accounts_receivable", asAt),
  };
}

/**
 * What FX revaluations of open foreign-currency documents add to accounts
 * receivable or payable as at a date (MC8, MC9), in the account's normal
 * direction: each is reversed the next day, so it's 0.00 except on a
 * revaluation date.
 */
export async function controlRevaluation(tx: OrgTx, systemKey: "accounts_receivable" | "accounts_payable", asAt: string): Promise<string> {
  const row = (
    await tx.query<{ amount: string }>(
      `select coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as amount
         from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id
        where a.system_key = $1 and l.fx_kind = 'revaluation' and j.posting_date <= $2`,
      [systemKey, asAt],
    )
  ).rows[0];
  const amount = dec(row.amount);
  return toFixedString(systemKey === "accounts_receivable" ? amount : neg(amount), currencyMinorUnits(tx.baseCurrency));
}

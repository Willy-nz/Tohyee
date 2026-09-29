import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, isZero, sub, toFixedString } from "@/lib/money/decimal";
import { AGE_BUCKETS, type AgedAmounts, addBuckets, type Buckets, bucketFor, daysBetween, emptyBuckets, toAmounts } from "@/lib/reports/ageing";

/**
 * Aged payables (examples AGP1-AGP3): what the organisation owes each
 * supplier as at a date, by how long each bill has been due (from its due
 * date), less supplier credit not yet used, worked out from the documents as
 * they stood on that date. It mirrors aged receivables (RC9-RC11). Supplier
 * overpayments and prepayments aren't built, so there's no other credit. The
 * total equals accounts payable on the balance sheet as at the same date;
 * the ledger balance is returned beside it so a difference shows.
 */

/**
 * Bills and unused supplier credit as at `$1` (null for now): the same rules
 * as the bill screens (payments and credit applied lower what's due) but
 * with everything dated after the date, or voided on or before it, left out.
 */
export const PAYABLES_SQL = `
with params as (select coalesce($1::date, 'infinity'::date) as as_at),
live_payments as (
  select p.* from supplier_payments p, params
   where p.payment_date <= params.as_at and (p.void_date is null or p.void_date > params.as_at)
),
live_apps as (
  select a.* from supplier_credit_note_applications a, params
   where a.application_date <= params.as_at and (a.removal_date is null or a.removal_date > params.as_at)
),
bills_due as (
  select b.id, b.contact_id, b.supplier_invoice_number, b.bill_date, b.due_date,
         b.total
         - coalesce((select sum(p.amount) from live_payments p where p.bill_id = b.id), 0)
         - coalesce((select sum(a.amount) from live_apps a where a.bill_id = b.id), 0) as amount_due
    from bills b, params
   where b.status in ('approved', 'voided') and b.bill_date <= params.as_at
     and (b.void_date is null or b.void_date > params.as_at)
),
credit as (
  select n.id, n.contact_id, n.supplier_credit_note_number, n.credit_note_date,
         n.total
         - coalesce((select sum(a.amount) from live_apps a where a.credit_note_id = n.id), 0)
         - coalesce((select sum(r.amount) from supplier_credit_note_refunds r, params
                      where r.credit_note_id = n.id and r.refund_date <= params.as_at
                        and (r.void_date is null or r.void_date > params.as_at)), 0) as unused
    from supplier_credit_notes n, params
   where n.status in ('approved', 'voided') and n.credit_note_date <= params.as_at
     and (n.void_date is null or n.void_date > params.as_at)
)`;

export type AgedBill = { id: string; supplierInvoiceNumber: string; billDate: string; dueDate: string; daysOverdue: number; amountDue: string };
export type AgedSupplierCredit = { id: string; supplierCreditNoteNumber: string; creditNoteDate: string; unused: string };

export type AgedPayablesRow = {
  contactId: string;
  name: string;
  amounts: AgedAmounts;
  bills: AgedBill[];
  credits: AgedSupplierCredit[];
};

export type AgedPayables = {
  asAt: string;
  currencyCode: string;
  rows: AgedPayablesRow[];
  total: AgedAmounts;
  /** Accounts payable in the ledger on the date (a credit balance, shown positive), and the report less it. */
  payablesAccount: { code: string; name: string; balance: string; difference: string } | null;
};

export async function agedPayables(tx: OrgTx, input: { asAt?: unknown }): Promise<AgedPayables> {
  const asAt = parseOptionalIsoDate(input.asAt, "asAt") ?? todayIsoDate();
  const scale = currencyMinorUnits(tx.baseCurrency);
  const billRows = await tx.query<{
    id: string;
    contact_id: string;
    supplier_invoice_number: string;
    bill_date: string;
    due_date: string;
    amount_due: string;
  }>(
    `${PAYABLES_SQL}
     select id::text, contact_id::text, supplier_invoice_number, bill_date, due_date, amount_due::text from bills_due
      where amount_due <> 0 order by due_date, id`,
    [asAt],
  );
  const creditRows = await tx.query<{ id: string; contact_id: string; supplier_credit_note_number: string; credit_note_date: string; unused: string }>(
    `${PAYABLES_SQL}
     select id::text, contact_id::text, supplier_credit_note_number, credit_note_date, unused::text from credit
      where unused <> 0 order by credit_note_date, id`,
    [asAt],
  );
  const contactRows = await tx.query<{ id: string; name: string }>("select id::text, name from contacts");
  const names = new Map(contactRows.rows.map((row) => [row.id, row.name]));

  const own = new Map<string, { buckets: Buckets; bills: AgedBill[]; credits: AgedSupplierCredit[] }>();
  const entry = (id: string) => {
    let found = own.get(id);
    if (!found) {
      found = { buckets: emptyBuckets(), bills: [], credits: [] };
      own.set(id, found);
    }
    return found;
  };
  for (const row of billRows.rows) {
    const daysOverdue = daysBetween(row.due_date, asAt);
    const target = entry(row.contact_id);
    const bucket = bucketFor(daysOverdue);
    target.buckets[bucket] = add(target.buckets[bucket], dec(row.amount_due));
    target.bills.push({
      id: row.id,
      supplierInvoiceNumber: row.supplier_invoice_number,
      billDate: row.bill_date,
      dueDate: row.due_date,
      daysOverdue: Math.max(daysOverdue, 0),
      amountDue: toFixedString(dec(row.amount_due), scale),
    });
  }
  for (const row of creditRows.rows) {
    const target = entry(row.contact_id);
    target.buckets.credit = add(target.buckets.credit, dec(row.unused));
    target.credits.push({
      id: row.id,
      supplierCreditNoteNumber: row.supplier_credit_note_number,
      creditNoteDate: row.credit_note_date,
      unused: toFixedString(dec(row.unused), scale),
    });
  }

  const hasBalance = (id: string) => ([...AGE_BUCKETS, "credit"] as const).some((key) => !isZero(own.get(id)!.buckets[key]));
  const rows = [...own.keys()]
    .filter(hasBalance)
    .sort((a, b) => (names.get(a) ?? "").localeCompare(names.get(b) ?? "", "en-NZ", { sensitivity: "base" }) || Number(a) - Number(b))
    .map((id) => ({ contactId: id, name: names.get(id) ?? `#${id}`, amounts: toAmounts(own.get(id)!.buckets, scale), bills: own.get(id)!.bills, credits: own.get(id)!.credits }));
  const grand = [...own.values()].reduce((acc, value) => addBuckets(acc, value.buckets), emptyBuckets());
  const total = toAmounts(grand, scale);

  const account = await tx.query<{ code: string; name: string; balance: string }>(
    `select a.code, a.name,
            coalesce((select sum(l.credit_amount - l.debit_amount) from ledger_journal_lines l
                        join ledger_journals j on j.id = l.journal_id
                       where l.account_id = a.id and j.posting_date <= $1), 0)::text as balance
       from accounts a where a.system_key = 'accounts_payable'`,
    [asAt],
  );
  const payable = account.rows[0];
  return {
    asAt,
    currencyCode: tx.baseCurrency,
    rows,
    total,
    payablesAccount: payable
      ? {
          code: payable.code,
          name: payable.name,
          balance: toFixedString(dec(payable.balance), scale),
          difference: toFixedString(sub(dec(total.total), dec(payable.balance)), scale),
        }
      : null,
  };
}

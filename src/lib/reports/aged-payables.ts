import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { CustomValues } from "@/lib/custom-fields/values";
import type { OrgTx } from "@/lib/db/org-transaction";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, type Decimal, dec, isZero, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { controlRevaluation } from "@/lib/reports/aged-receivables";
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
bills_open as (
  select b.id, b.contact_id, b.supplier_invoice_number, b.bill_date, b.due_date, b.currency_code, b.base_total, b.custom_fields,
         b.total
         - coalesce((select sum(p.amount) from live_payments p where p.bill_id = b.id), 0)
         - coalesce((select sum(a.amount) from live_apps a where a.bill_id = b.id), 0) as amount_due,
         -- A foreign-currency bill's open base value at its own rate (MC9).
         b.base_total
         - coalesce((select sum(p.base_cleared) from live_payments p where p.bill_id = b.id), 0)
         - coalesce((select sum(a.bill_base) from live_apps a where a.bill_id = b.id), 0) as base_due
    from bills b, params
   where b.status in ('approved', 'voided') and b.bill_date <= params.as_at
     and (b.void_date is null or b.void_date > params.as_at)
),
bills_due as (
  select id, contact_id, supplier_invoice_number, bill_date, due_date, currency_code, custom_fields, amount_due,
         case when base_total is null then amount_due else base_due end as amount_due_base
    from bills_open
),
credit as (
  select n.id, n.contact_id, n.supplier_credit_note_number, n.credit_note_date, n.currency_code, n.custom_fields,
         n.total
         - coalesce((select sum(a.amount) from live_apps a where a.credit_note_id = n.id), 0)
         - coalesce((select sum(r.amount) from supplier_credit_note_refunds r, params
                      where r.credit_note_id = n.id and r.refund_date <= params.as_at
                        and (r.void_date is null or r.void_date > params.as_at)), 0) as unused,
         -- A foreign-currency credit note's unused base value at its own rate (MC10, MC18).
         coalesce(n.base_total
                  - coalesce((select sum(a.credit_note_base) from live_apps a where a.credit_note_id = n.id), 0)
                  - coalesce((select sum(r.base_cleared) from supplier_credit_note_refunds r, params
                               where r.credit_note_id = n.id and r.refund_date <= params.as_at
                                 and (r.void_date is null or r.void_date > params.as_at)), 0),
                  n.total
                  - coalesce((select sum(a.amount) from live_apps a where a.credit_note_id = n.id), 0)
                  - coalesce((select sum(r.amount) from supplier_credit_note_refunds r, params
                               where r.credit_note_id = n.id and r.refund_date <= params.as_at
                                 and (r.void_date is null or r.void_date > params.as_at)), 0)) as unused_base
    from supplier_credit_notes n, params
   where n.status in ('approved', 'voided') and n.credit_note_date <= params.as_at
     and (n.void_date is null or n.void_date > params.as_at)
)`;

export type AgedBill = {
  id: string;
  supplierInvoiceNumber: string;
  billDate: string;
  dueDate: string;
  daysOverdue: number;
  /** In the bill's currency. */
  amountDue: string;
  currencyCode: string;
  /** In the base currency, at the bill's own rate (MC9). */
  amountDueBase: string;
  customFields: CustomValues;
};
export type AgedSupplierCredit = {
  id: string;
  supplierCreditNoteNumber: string;
  creditNoteDate: string;
  unused: string;
  currencyCode: string;
  unusedBase: string;
  customFields: CustomValues;
};

export type AgedPayablesRow = {
  contactId: string;
  name: string;
  amounts: AgedAmounts;
  bills: AgedBill[];
  credits: AgedSupplierCredit[];
  /** A supplier in another currency (MC9): its currency and what's owed in it; null otherwise. */
  foreign: { currencyCode: string; total: string } | null;
};

export type AgedPayables = {
  asAt: string;
  currencyCode: string;
  rows: AgedPayablesRow[];
  total: AgedAmounts;
  /** An unrealised FX revaluation of open foreign-currency bills on the date (MC8, reversed the next day); 0.00 on other dates. */
  revaluation: string;
  /** Accounts payable in the ledger on the date (a credit balance, shown positive), and the report plus any revaluation less it. */
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
    currency_code: string;
    amount_due_base: string;
    custom_fields: CustomValues;
  }>(
    `${PAYABLES_SQL}
     select id::text, contact_id::text, supplier_invoice_number, bill_date, due_date, amount_due::text, currency_code, amount_due_base::text, custom_fields
       from bills_due
      where amount_due <> 0 or amount_due_base <> 0 order by due_date, bills_due.id`,
    [asAt],
  );
  const creditRows = await tx.query<{
    id: string;
    contact_id: string;
    supplier_credit_note_number: string;
    credit_note_date: string;
    unused: string;
    currency_code: string;
    unused_base: string;
    custom_fields: CustomValues;
  }>(
    `${PAYABLES_SQL}
     select id::text, contact_id::text, supplier_credit_note_number, credit_note_date, unused::text, currency_code, unused_base::text, custom_fields from credit
      where unused <> 0 or unused_base <> 0 order by credit_note_date, credit.id`,
    [asAt],
  );
  const contactRows = await tx.query<{ id: string; name: string; currency_code: string | null }>("select id::text, name, currency_code from contacts");
  const names = new Map(contactRows.rows.map((row) => [row.id, row.name]));
  const currencies = new Map(contactRows.rows.map((row) => [row.id, row.currency_code]));

  // Buckets are in the base currency; a foreign-currency supplier's own-currency total is kept beside them (MC9).
  const own = new Map<string, { buckets: Buckets; bills: AgedBill[]; credits: AgedSupplierCredit[]; foreign: Decimal }>();
  const entry = (id: string) => {
    let found = own.get(id);
    if (!found) {
      found = { buckets: emptyBuckets(), bills: [], credits: [], foreign: ZERO_DECIMAL };
      own.set(id, found);
    }
    return found;
  };
  for (const row of billRows.rows) {
    const daysOverdue = daysBetween(row.due_date, asAt);
    const target = entry(row.contact_id);
    const bucket = bucketFor(daysOverdue);
    target.buckets[bucket] = add(target.buckets[bucket], dec(row.amount_due_base));
    target.foreign = add(target.foreign, dec(row.amount_due));
    target.bills.push({
      id: row.id,
      supplierInvoiceNumber: row.supplier_invoice_number,
      billDate: row.bill_date,
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
    target.credits.push({
      id: row.id,
      supplierCreditNoteNumber: row.supplier_credit_note_number,
      creditNoteDate: row.credit_note_date,
      unused: toFixedString(dec(row.unused), currencyMinorUnits(row.currency_code)),
      currencyCode: row.currency_code,
      unusedBase: toFixedString(dec(row.unused_base), scale),
      customFields: row.custom_fields ?? {},
    });
  }
  const foreignOf = (id: string) => {
    const currency = currencies.get(id);
    return currency && currency !== tx.baseCurrency
      ? { currencyCode: currency, total: toFixedString(own.get(id)!.foreign, currencyMinorUnits(currency)) }
      : null;
  };

  const hasBalance = (id: string) => ([...AGE_BUCKETS, "credit"] as const).some((key) => !isZero(own.get(id)!.buckets[key]));
  const rows = [...own.keys()]
    .filter(hasBalance)
    .sort((a, b) => (names.get(a) ?? "").localeCompare(names.get(b) ?? "", "en-NZ", { sensitivity: "base" }) || Number(a) - Number(b))
    .map((id) => ({
      contactId: id,
      name: names.get(id) ?? `#${id}`,
      amounts: toAmounts(own.get(id)!.buckets, scale),
      bills: own.get(id)!.bills,
      credits: own.get(id)!.credits,
      foreign: foreignOf(id),
    }));
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
  const revaluation = await controlRevaluation(tx, "accounts_payable", asAt);
  return {
    asAt,
    currencyCode: tx.baseCurrency,
    rows,
    total,
    revaluation,
    payablesAccount: payable
      ? {
          code: payable.code,
          name: payable.name,
          balance: toFixedString(dec(payable.balance), scale),
          difference: toFixedString(sub(add(dec(total.total), dec(revaluation)), dec(payable.balance)), scale),
        }
      : null,
  };
}

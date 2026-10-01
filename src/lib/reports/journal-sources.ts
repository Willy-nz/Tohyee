/**
 * Where each posted journal came from (examples ATX1-ATX5, JR1-JR3): the
 * document, payment, refund or bank transaction that posted it, with its
 * number, contact and the screen that shows it. Journals posted by hand,
 * corrections, stock movements and FX revaluations open the journal itself.
 * Nothing here is stored: it's read from the documents' journal columns.
 */

export type JournalSourceType =
  | "invoice"
  | "customer_payment"
  | "customer_payment_batch"
  | "customer_overpayment_refund"
  | "sales_credit_note"
  | "sales_credit_note_refund"
  | "bill"
  | "supplier_payment"
  | "supplier_payment_batch"
  | "supplier_credit_note"
  | "supplier_credit_note_refund"
  | "bank_transaction"
  | "bank_transfer"
  | "expense_claim"
  | "expense_claim_payment"
  | "fixed_asset_depreciation"
  | "fixed_asset_disposal"
  | "journal";

export type JournalSource = {
  type: JournalSourceType;
  /** e.g. "Invoice INV-0001", "Void of bill PS-101", "Manual journal OPEN". */
  label: string;
  /** The screen that shows it. */
  href: string;
  contactId: string | null;
  contactName: string | null;
};

/**
 * A `sources` CTE (journal_id, source_type, link_id, number, contact_id):
 * one row per journal posted by a document or payment. The parts of a
 * payment for several invoices or bills share the batch's journal, so only
 * the batch is listed.
 */
export const JOURNAL_SOURCES_SQL = `
sources (journal_id, source_type, link_id, number, contact_id) as (
  select j, 'invoice', i.id, i.invoice_number, i.contact_id
    from sales_invoices i cross join lateral (values (i.approval_journal_id), (i.void_journal_id)) v(j) where j is not null
  union all
  select j, 'customer_payment', i.id, i.invoice_number, i.contact_id
    from customer_payments p join sales_invoices i on i.id = p.invoice_id
    cross join lateral (values (p.journal_id), (p.void_journal_id)) v(j) where j is not null and p.batch_id is null
  union all
  select j, 'customer_payment_batch', b.id, b.reference, b.contact_id
    from customer_payment_batches b cross join lateral (values (b.journal_id), (b.void_journal_id)) v(j) where j is not null
  union all
  select j, 'customer_overpayment_refund', p.id, i.invoice_number, i.contact_id
    from customer_overpayment_refunds r join customer_payments p on p.id = r.payment_id join sales_invoices i on i.id = p.invoice_id
    cross join lateral (values (r.journal_id), (r.void_journal_id)) v(j) where j is not null
  union all
  select j, 'sales_credit_note', n.id, n.credit_note_number, n.contact_id
    from sales_credit_notes n cross join lateral (values (n.approval_journal_id), (n.void_journal_id)) v(j) where j is not null
  union all
  select j, 'sales_credit_note_refund', n.id, n.credit_note_number, n.contact_id
    from sales_credit_note_refunds r join sales_credit_notes n on n.id = r.credit_note_id
    cross join lateral (values (r.journal_id), (r.void_journal_id)) v(j) where j is not null
  union all
  select j, 'bill', b.id, b.supplier_invoice_number, b.contact_id
    from bills b cross join lateral (values (b.approval_journal_id), (b.void_journal_id)) v(j) where j is not null
  union all
  select j, 'supplier_payment', b.id, b.supplier_invoice_number, b.contact_id
    from supplier_payments p join bills b on b.id = p.bill_id
    cross join lateral (values (p.journal_id), (p.void_journal_id)) v(j) where j is not null and p.batch_id is null
  union all
  select j, 'supplier_payment_batch', b.id, b.reference, b.contact_id
    from supplier_payment_batches b cross join lateral (values (b.journal_id), (b.void_journal_id)) v(j) where j is not null
  union all
  select j, 'supplier_credit_note', n.id, n.supplier_credit_note_number, n.contact_id
    from supplier_credit_notes n cross join lateral (values (n.approval_journal_id), (n.void_journal_id)) v(j) where j is not null
  union all
  select j, 'supplier_credit_note_refund', n.id, n.supplier_credit_note_number, n.contact_id
    from supplier_credit_note_refunds r join supplier_credit_notes n on n.id = r.credit_note_id
    cross join lateral (values (r.journal_id), (r.void_journal_id)) v(j) where j is not null
  union all
  select j, 'bank_transaction', t.account_id, t.reference, t.contact_id
    from bank_transactions t cross join lateral (values (t.journal_id), (t.void_journal_id)) v(j) where j is not null
  union all
  select j, 'bank_transfer', t.from_account_id, t.reference, null::bigint
    from bank_transfers t cross join lateral (values (t.journal_id), (t.void_journal_id)) v(j) where j is not null
  union all
  select j, 'expense_claim', x.id, 'CLAIM-' || x.id, null::bigint
    from expense_claims x cross join lateral (values (x.approval_journal_id), (x.void_journal_id)) v(j) where j is not null
  union all
  select j, 'expense_claim_payment', p.claim_id, 'CLAIM-' || p.claim_id, null::bigint
    from expense_claim_payments p cross join lateral (values (p.journal_id), (p.void_journal_id)) v(j) where j is not null
  union all
  select j, 'fixed_asset_depreciation', r.id, 'DEP-' || to_char(r.period_end, 'YYYY-MM'), null::bigint
    from fixed_asset_depreciation_runs r cross join lateral (values (r.journal_id), (r.rollback_journal_id)) v(j) where j is not null
  union all
  select j, 'fixed_asset_disposal', f.id, f.asset_number, null::bigint
    from fixed_asset_disposals d join fixed_assets f on f.id = d.asset_id
    cross join lateral (values (d.journal_id), (d.undo_journal_id)) v(j) where j is not null
)`;

/** Columns to select alongside a journal `j` joined to `sources s` and `contacts sc` (all left joins). */
export const SOURCE_COLUMNS = `s.source_type, s.link_id::text as source_link_id, s.number as source_number,
  s.contact_id::text as source_contact_id, sc.name as source_contact_name`;

/** The joins that go with SOURCE_COLUMNS, for a query over `ledger_journals j`. */
export const SOURCE_JOINS = `left join sources s on s.journal_id = j.id
  left join contacts sc on sc.id = s.contact_id`;

export type SourceRow = {
  source_type: Exclude<JournalSourceType, "journal"> | null;
  source_link_id: string | null;
  source_number: string | null;
  source_contact_id: string | null;
  source_contact_name: string | null;
};

const NAMES: Record<Exclude<JournalSourceType, "journal">, { label: string; href: (id: string) => string }> = {
  invoice: { label: "invoice", href: (id) => `/operations/invoices/${id}` },
  customer_payment: { label: "payment on invoice", href: (id) => `/operations/invoices/${id}` },
  customer_payment_batch: { label: "payment for several invoices", href: (id) => `/operations/customer-payments/${id}` },
  customer_overpayment_refund: { label: "refund of overpayment on", href: (id) => `/operations/overpayments/${id}` },
  sales_credit_note: { label: "credit note", href: (id) => `/operations/credit-notes/${id}` },
  sales_credit_note_refund: { label: "refund of credit note", href: (id) => `/operations/credit-notes/${id}` },
  bill: { label: "bill", href: (id) => `/operations/bills/${id}` },
  supplier_payment: { label: "payment of bill", href: (id) => `/operations/bills/${id}` },
  supplier_payment_batch: { label: "payment for several bills", href: (id) => `/operations/supplier-payments/${id}` },
  supplier_credit_note: { label: "supplier credit note", href: (id) => `/operations/supplier-credit-notes/${id}` },
  supplier_credit_note_refund: { label: "refund of supplier credit note", href: (id) => `/operations/supplier-credit-notes/${id}` },
  bank_transaction: { label: "bank transaction", href: (id) => `/operations/bank-accounts/${id}` },
  bank_transfer: { label: "transfer", href: (id) => `/operations/bank-accounts/${id}` },
  expense_claim: { label: "expense claim", href: (id) => `/operations/expense-claims/${id}` },
  expense_claim_payment: { label: "payment of expense claim", href: (id) => `/operations/expense-claims/${id}` },
  fixed_asset_depreciation: { label: "depreciation run", href: (id) => `/operations/fixed-assets/depreciation?run=${id}` },
  fixed_asset_disposal: { label: "disposal of", href: (id) => `/operations/fixed-assets/${id}` },
};

const ORIGIN_NAMES: Record<string, string> = {
  manual: "Manual journal",
  correction: "Correction",
  inventory: "Stock movement",
  fx_revaluation: "FX revaluation",
  opening_balance: "Opening balances",
  payroll: "Payroll",
};

/** The source of a journal from its row. `isReversal` marks a void (or a correction's reversal). */
export function journalSource(
  journal: { id: string; origin: string; reference: string; correctionKind: string | null },
  row: SourceRow,
): JournalSource {
  if (!row.source_type || !row.source_link_id) {
    const base = ORIGIN_NAMES[journal.origin] ?? "Journal";
    const kind = journal.correctionKind === "reversal" ? "Reversal" : journal.correctionKind === "replacement" ? "Replacement" : base;
    return {
      type: "journal",
      label: `${kind} ${journal.reference}`,
      href: `/operations/ledger-journals?journal=${journal.id}`,
      contactId: null,
      contactName: null,
    };
  }
  const name = NAMES[row.source_type];
  const number = row.source_number ?? "";
  const text = `${name.label}${number ? ` ${number}` : ""}`;
  return {
    type: row.source_type,
    label: journal.correctionKind === "reversal" ? `Void of ${text}` : `${text.charAt(0).toUpperCase()}${text.slice(1)}`,
    href: name.href(row.source_link_id),
    contactId: row.source_contact_id,
    contactName: row.source_contact_name,
  };
}

import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, neg, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  basisChangeAdjustment,
  calculateGstBoxes,
  changedGstBoxes,
  countsWhenSettled,
  GST_STANDARD_RATE,
  type GstAdjustment,
  type GstBoxChange,
  type GstBoxes,
  type GstReturnFigures,
  gstInOutstanding,
  parseGstAdjustments,
  parseGstPeriod,
  settlementShares,
} from "@/lib/reports/gst-boxes";
import type { GstBasis, TaxCategory } from "@/lib/tax/categories";
import { optionalSource, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * The GST return (NZ GST101A, boxes 5-15), worked out from approved documents
 * on the organisation's GST basis. On the invoice basis a sales invoice,
 * sales credit note, bill or supplier credit note counts on the date it was
 * approved (its own date) and again, the other way, on the date it was
 * voided (G1-G9). On the payments basis they count when they're settled -
 * paid, credited or refunded - each settlement counting the document's lines
 * in proportion; on the hybrid basis sales count as on the invoice basis and
 * purchases as on the payments basis (G10-G19). Bank transactions (BK6, BK7,
 * BK11) count on their date on every basis: spend money like a bill, receive
 * money like an invoice. Drafts, manual journals, stock movements and FX
 * revaluations never count. See "GST return" in docs/ACCOUNTING-EXAMPLES.md.
 */

export const GST_EVENT_TYPES = [
  "invoice_approved",
  "invoice_voided",
  "credit_note_approved",
  "credit_note_voided",
  "bill_approved",
  "bill_voided",
  "supplier_credit_note_approved",
  "supplier_credit_note_voided",
  "bank_transaction_posted",
  "bank_transaction_voided",
  "customer_payment",
  "customer_payment_voided",
  "credit_note_applied",
  "credit_note_application_removed",
  "credit_note_refunded",
  "credit_note_refund_voided",
  "overpayment_applied",
  "overpayment_application_removed",
  "supplier_payment",
  "supplier_payment_voided",
  "supplier_credit_note_applied",
  "supplier_credit_note_application_removed",
  "supplier_credit_note_refunded",
  "supplier_credit_note_refund_voided",
] as const;
export type GstEventType = (typeof GST_EVENT_TYPES)[number];

export type GstDocumentType = "sales_invoice" | "sales_credit_note" | "bill" | "supplier_credit_note" | "bank_transaction";
export type GstLineBox = "5" | "6" | "11";

/** One document line in a GST event, with the boxes it counts in (none when it's left out). */
export type GstReturnLine = {
  side: "sales" | "purchases";
  eventType: GstEventType;
  eventDate: string;
  documentType: GstDocumentType;
  documentId: string;
  documentNumber: string;
  reference: string | null;
  contactId: string;
  contactName: string;
  documentLineOrder: number;
  description: string;
  taxCode: string | null;
  category: TaxCategory;
  taxRate: string;
  /** Including GST; negative for credit notes and voids. For a settlement, the line's share. */
  amount: string;
  gst: string;
  boxes: GstLineBox[];
  /** For a settlement (payments and hybrid bases): the amount settled and the document's total. */
  settledAmount: string | null;
  documentTotal: string | null;
};

const MONEY_SCALE = 2;
const money = (value: string) => toFixedString(dec(value), MONEY_SCALE);

/** A document line in an event, before a settlement's share is worked out. */
type RawEventRow = {
  side: "sales" | "purchases";
  event_type: GstEventType;
  event_date: string;
  sign: number;
  settlement_id: string | null;
  settled: string | null;
  document_total: string;
  document_type: GstDocumentType;
  document_id: string;
  document_number: string;
  reference: string | null;
  contact_id: string;
  contact_name: string;
  document_line_order: number;
  description: string;
  tax_code: string | null;
  category: TaxCategory;
  tax_rate: string;
  line_amount: string;
  line_gst: string;
};

/** A counted line as it was filed. */
type StoredLineRow = Omit<RawEventRow, "sign" | "settlement_id" | "settled" | "document_total" | "line_amount" | "line_gst"> & {
  amount: string;
  gst: string;
  settled_amount: string | null;
  document_total: string | null;
};

/** Settlements: payments, credit applied, refunds and overpayments applied, and their voids and removals. */
const SETTLEMENTS_SQL = `
  select 'sales' as side, 'customer_payment' as event_type, p.payment_date as event_date, 1 as sign,
         'sales_invoice' as document_type, p.invoice_id as document_id, p.id as settlement_id,
         p.amount - p.overpayment_amount as settled
    from customer_payments p
   where $3 and p.payment_date between $1 and $2 and p.amount > p.overpayment_amount
  union all
  select 'sales', 'customer_payment_voided', p.void_date, -1, 'sales_invoice', p.invoice_id, p.id,
         p.amount - p.overpayment_amount
    from customer_payments p
   where $3 and p.status = 'voided' and p.void_date between $1 and $2 and p.amount > p.overpayment_amount
  union all
  select 'sales', 'credit_note_applied', a.application_date, 1, 'sales_invoice', a.invoice_id, a.id, a.amount
    from sales_credit_note_applications a
   where $3 and a.application_date between $1 and $2
  union all
  select 'sales', 'credit_note_applied', a.application_date, -1, 'sales_credit_note', a.credit_note_id, a.id, a.amount
    from sales_credit_note_applications a
   where $3 and a.application_date between $1 and $2
  union all
  select 'sales', 'credit_note_application_removed', a.removal_date, -1, 'sales_invoice', a.invoice_id, a.id, a.amount
    from sales_credit_note_applications a
   where $3 and a.status = 'removed' and a.removal_date between $1 and $2
  union all
  select 'sales', 'credit_note_application_removed', a.removal_date, 1, 'sales_credit_note', a.credit_note_id, a.id,
         a.amount
    from sales_credit_note_applications a
   where $3 and a.status = 'removed' and a.removal_date between $1 and $2
  union all
  select 'sales', 'credit_note_refunded', r.refund_date, -1, 'sales_credit_note', r.credit_note_id, r.id, r.amount
    from sales_credit_note_refunds r
   where $3 and r.refund_date between $1 and $2
  union all
  select 'sales', 'credit_note_refund_voided', r.void_date, 1, 'sales_credit_note', r.credit_note_id, r.id, r.amount
    from sales_credit_note_refunds r
   where $3 and r.status = 'voided' and r.void_date between $1 and $2
  union all
  select 'sales', 'overpayment_applied', a.application_date, 1, 'sales_invoice', a.invoice_id, a.id, a.amount
    from customer_overpayment_applications a
   where $3 and a.application_date between $1 and $2
  union all
  select 'sales', 'overpayment_application_removed', a.removal_date, -1, 'sales_invoice', a.invoice_id, a.id, a.amount
    from customer_overpayment_applications a
   where $3 and a.status = 'removed' and a.removal_date between $1 and $2
  union all
  select 'purchases', 'supplier_payment', p.payment_date, 1, 'bill', p.bill_id, p.id, p.amount
    from supplier_payments p
   where $4 and p.payment_date between $1 and $2
  union all
  select 'purchases', 'supplier_payment_voided', p.void_date, -1, 'bill', p.bill_id, p.id, p.amount
    from supplier_payments p
   where $4 and p.status = 'voided' and p.void_date between $1 and $2
  union all
  select 'purchases', 'supplier_credit_note_applied', a.application_date, 1, 'bill', a.bill_id, a.id, a.amount
    from supplier_credit_note_applications a
   where $4 and a.application_date between $1 and $2
  union all
  select 'purchases', 'supplier_credit_note_applied', a.application_date, -1, 'supplier_credit_note', a.credit_note_id,
         a.id, a.amount
    from supplier_credit_note_applications a
   where $4 and a.application_date between $1 and $2
  union all
  select 'purchases', 'supplier_credit_note_application_removed', a.removal_date, -1, 'bill', a.bill_id, a.id, a.amount
    from supplier_credit_note_applications a
   where $4 and a.status = 'removed' and a.removal_date between $1 and $2
  union all
  select 'purchases', 'supplier_credit_note_application_removed', a.removal_date, 1, 'supplier_credit_note',
         a.credit_note_id, a.id, a.amount
    from supplier_credit_note_applications a
   where $4 and a.status = 'removed' and a.removal_date between $1 and $2
  union all
  select 'purchases', 'supplier_credit_note_refunded', r.refund_date, -1, 'supplier_credit_note', r.credit_note_id,
         r.id, r.amount
    from supplier_credit_note_refunds r
   where $4 and r.refund_date between $1 and $2
  union all
  select 'purchases', 'supplier_credit_note_refund_voided', r.void_date, 1, 'supplier_credit_note', r.credit_note_id,
         r.id, r.amount
    from supplier_credit_note_refunds r
   where $4 and r.status = 'voided' and r.void_date between $1 and $2`;

/**
 * Every line of every GST event dated in the period, in one statement so the
 * figures come from one consistent snapshot. $3 is true when sales count when
 * settled, $4 when purchases do. A line's amount including GST is its net
 * amount plus its GST (whatever the document's amounts mode); a document's
 * total is the sum of its lines.
 */
const EVENT_LINES_SQL = `
with events as (
  select 'sales' as side, 'invoice_approved' as event_type, i.invoice_date as event_date, 1 as sign,
         'sales_invoice' as document_type, i.id as document_id, null::bigint as settlement_id,
         null::numeric as settled
    from sales_invoices i
   where not $3 and i.status in ('approved', 'voided') and i.invoice_date between $1 and $2
  union all
  select 'sales', 'invoice_voided', i.void_date, -1, 'sales_invoice', i.id, null, null
    from sales_invoices i
   where not $3 and i.status = 'voided' and i.void_date between $1 and $2
  union all
  select 'sales', 'credit_note_approved', n.credit_note_date, -1, 'sales_credit_note', n.id, null, null
    from sales_credit_notes n
   where not $3 and n.status in ('approved', 'voided') and n.credit_note_date between $1 and $2
  union all
  select 'sales', 'credit_note_voided', n.void_date, 1, 'sales_credit_note', n.id, null, null
    from sales_credit_notes n
   where not $3 and n.status = 'voided' and n.void_date between $1 and $2
  union all
  select 'purchases', 'bill_approved', b.bill_date, 1, 'bill', b.id, null, null
    from bills b
   where not $4 and b.status in ('approved', 'voided') and b.bill_date between $1 and $2
  union all
  select 'purchases', 'bill_voided', b.void_date, -1, 'bill', b.id, null, null
    from bills b
   where not $4 and b.status = 'voided' and b.void_date between $1 and $2
  union all
  select 'purchases', 'supplier_credit_note_approved', s.credit_note_date, -1, 'supplier_credit_note', s.id, null, null
    from supplier_credit_notes s
   where not $4 and s.status in ('approved', 'voided') and s.credit_note_date between $1 and $2
  union all
  select 'purchases', 'supplier_credit_note_voided', s.void_date, 1, 'supplier_credit_note', s.id, null, null
    from supplier_credit_notes s
   where not $4 and s.status = 'voided' and s.void_date between $1 and $2
  union all
  select case t.kind when 'spend' then 'purchases' else 'sales' end, 'bank_transaction_posted', t.transaction_date, 1,
         'bank_transaction', t.id, null, null
    from bank_transactions t
   where t.transaction_date between $1 and $2
  union all
  select case t.kind when 'spend' then 'purchases' else 'sales' end, 'bank_transaction_voided', t.void_date, -1,
         'bank_transaction', t.id, null, null
    from bank_transactions t
   where t.status = 'voided' and t.void_date between $1 and $2
  union all
  ${SETTLEMENTS_SQL}
),
documents as (
  select 'sales_invoice' as document_type, id as document_id, invoice_number as document_number, reference, contact_id
    from sales_invoices
  union all
  select 'sales_credit_note', id, credit_note_number, reference, contact_id from sales_credit_notes
  union all
  select 'bill', id, supplier_invoice_number, null, contact_id from bills
  union all
  select 'supplier_credit_note', id, supplier_credit_note_number, reference, contact_id from supplier_credit_notes
  union all
  select 'bank_transaction', id, coalesce(reference, 'BT-' || id), reference, contact_id from bank_transactions
),
document_lines as (
  select 'sales_invoice' as document_type, invoice_id as document_id, line_order, description, tax_code_id,
         tax_rate, net_amount, tax_amount
    from sales_invoice_lines
  union all
  select 'sales_credit_note', credit_note_id, line_order, description, tax_code_id, tax_rate, net_amount, tax_amount
    from sales_credit_note_lines
  union all
  select 'bill', bill_id, line_order, description, tax_code_id, tax_rate, net_amount, tax_amount
    from bill_lines
  union all
  select 'supplier_credit_note', credit_note_id, line_order, description, tax_code_id, tax_rate, net_amount,
         tax_amount
    from supplier_credit_note_lines
  union all
  select 'bank_transaction', bank_transaction_id, line_order, description, tax_code_id, tax_rate, net_amount, tax_amount
    from bank_transaction_lines
)
select e.side, e.event_type, e.event_date, e.sign, e.settlement_id::text, e.settled::text,
       (sum(l.net_amount + l.tax_amount) over (partition by e.event_type, e.document_type, e.document_id,
                                                           e.settlement_id))::text as document_total,
       e.document_type, e.document_id::text, d.document_number, d.reference,
       d.contact_id::text, c.name as contact_name, l.line_order as document_line_order, l.description,
       t.code as tax_code, coalesce(t.category, 'out_of_scope') as category, l.tax_rate::text,
       (l.net_amount + l.tax_amount)::text as line_amount, l.tax_amount::text as line_gst
  from events e
  join documents d on d.document_type = e.document_type and d.document_id = e.document_id
  join document_lines l on l.document_type = e.document_type and l.document_id = e.document_id
  join contacts c on c.id = d.contact_id
  left join tax_codes t on t.id = l.tax_code_id
 order by e.side desc, e.event_date, e.document_type, e.document_id, e.event_type, e.settlement_id, l.line_order`;

/** Sales: standard -> Box 5, zero rated -> Boxes 5 and 6. Purchases: standard -> Box 11. Anything else is left out. */
function boxesFor(side: "sales" | "purchases", category: TaxCategory): GstLineBox[] {
  if (side === "sales") {
    if (category === "standard") return ["5"];
    if (category === "zero_rated") return ["5", "6"];
    return [];
  }
  return category === "standard" ? ["11"] : [];
}

const DOCUMENT_LABELS: Record<GstDocumentType, string> = {
  sales_invoice: "invoice",
  sales_credit_note: "credit note",
  bill: "bill",
  supplier_credit_note: "supplier credit note",
  bank_transaction: "bank transaction",
};

function toLine(
  row: Omit<StoredLineRow, "amount" | "gst" | "settled_amount" | "document_total">,
  counted: { amount: string; gst: string; settledAmount: string | null; documentTotal: string | null },
): GstReturnLine {
  return {
    side: row.side,
    eventType: row.event_type,
    eventDate: row.event_date,
    documentType: row.document_type,
    documentId: row.document_id,
    documentNumber: row.document_number,
    reference: row.reference,
    contactId: row.contact_id,
    contactName: row.contact_name,
    documentLineOrder: row.document_line_order,
    description: row.description,
    taxCode: row.tax_code,
    category: row.category,
    taxRate: row.tax_rate,
    amount: money(counted.amount),
    gst: money(counted.gst),
    boxes: boxesFor(row.side, row.category),
    settledAmount: counted.settledAmount === null ? null : money(counted.settledAmount),
    documentTotal: counted.documentTotal === null ? null : money(counted.documentTotal),
  };
}

function storedLine(row: StoredLineRow): GstReturnLine {
  return toLine(row, {
    amount: row.amount,
    gst: row.gst,
    settledAmount: row.settled_amount,
    documentTotal: row.document_total,
  });
}

/**
 * The counted lines from the event rows: a document approved or voided
 * counts its lines whole; a settlement counts each line's share of the
 * amount settled (G11, G12).
 */
function eventLines(rows: readonly RawEventRow[]): GstReturnLine[] {
  const lines: GstReturnLine[] = [];
  let index = 0;
  while (index < rows.length) {
    const first = rows[index];
    let end = index + 1;
    while (
      end < rows.length &&
      rows[end].event_type === first.event_type &&
      rows[end].document_type === first.document_type &&
      rows[end].document_id === first.document_id &&
      rows[end].settlement_id === first.settlement_id
    ) {
      end += 1;
    }
    const group = rows.slice(index, end);
    const signed = (value: string) => toFixedString(first.sign < 0 ? neg(dec(value)) : dec(value), MONEY_SCALE);
    if (first.settled === null) {
      for (const row of group) {
        lines.push(toLine(row, { amount: signed(row.line_amount), gst: signed(row.line_gst), settledAmount: null, documentTotal: null }));
      }
    } else {
      const shares = settlementShares(
        group.map((row) => ({ amount: row.line_amount, gst: row.line_gst })),
        first.settled,
        first.document_total,
      );
      group.forEach((row, position) => {
        lines.push(
          toLine(row, {
            amount: signed(shares[position].amount),
            gst: signed(shares[position].gst),
            settledAmount: first.settled,
            documentTotal: first.document_total,
          }),
        );
      });
    }
    index = end;
  }
  return lines;
}

/** Adds up the counted lines into boxes 5-15. */
function figuresFrom(lines: readonly GstReturnLine[], adjustments: readonly GstAdjustment[]): GstReturnFigures {
  let box5 = ZERO_DECIMAL;
  let box6 = ZERO_DECIMAL;
  let box11 = ZERO_DECIMAL;
  let salesGst = ZERO_DECIMAL;
  let purchasesGst = ZERO_DECIMAL;
  for (const line of lines) {
    if (line.boxes.length === 0) continue;
    const amount = dec(line.amount);
    if (line.boxes.includes("5")) box5 = add(box5, amount);
    if (line.boxes.includes("6")) box6 = add(box6, amount);
    if (line.boxes.includes("11")) box11 = add(box11, amount);
    if (line.side === "sales") salesGst = add(salesGst, dec(line.gst));
    else purchasesGst = add(purchasesGst, dec(line.gst));
  }
  const text = (value: typeof box5) => toFixedString(value, MONEY_SCALE);
  return calculateGstBoxes({
    box5: text(box5),
    box6: text(box6),
    box11: text(box11),
    salesGst: text(salesGst),
    purchasesGst: text(purchasesGst),
    adjustments,
  });
}

/**
 * Reads the period's GST event lines on a basis and works out the boxes.
 * Refuses when a counted standard-rated line has a rate other than 15%,
 * naming the documents.
 */
async function workOut(
  tx: OrgTx,
  basis: GstBasis,
  periodStart: string,
  periodEnd: string,
  adjustments: readonly GstAdjustment[],
): Promise<{ figures: GstReturnFigures; lines: GstReturnLine[] }> {
  const result = await tx.query<RawEventRow>(EVENT_LINES_SQL, [
    periodStart,
    periodEnd,
    countsWhenSettled(basis, "sales"),
    countsWhenSettled(basis, "purchases"),
  ]);
  const lines = eventLines(result.rows);
  const otherRates = new Map<string, string>();
  for (const line of lines) {
    if (line.category === "standard" && cmp(dec(line.taxRate), dec(GST_STANDARD_RATE)) !== 0) {
      otherRates.set(
        `${line.documentType}:${line.documentId}`,
        `${DOCUMENT_LABELS[line.documentType]} ${line.documentNumber} (${line.contactName})`,
      );
    }
  }
  if (otherRates.size > 0) {
    throw new ValidationError(
      `GST returns only handle standard-rated GST at 15%. These documents in the period have standard-rated lines at another rate: ${[
        ...otherRates.values(),
      ].join("; ")}. Other GST rates aren't supported yet.`,
    );
  }
  return { figures: figuresFrom(lines, adjustments), lines };
}

async function gstBasis(tx: OrgTx, options: { lock: boolean }): Promise<GstBasis> {
  const result = await tx.query<{ gst_basis: GstBasis }>(
    `select gst_basis from organisation_settings where id = true${options.lock ? " for update" : ""}`,
  );
  return result.rows[0].gst_basis;
}

/**
 * What was still owed at the end of a day, with its GST (G20, G22): approved
 * documents dated on or before it and not voided by then, less what had
 * settled them by then (payments, refunds and applications not voided or
 * removed by then). Credit notes count negative.
 */
const OUTSTANDING_SQL = `
with outstanding as (
  select 'sales' as side, i.total, i.tax_total, 1 as sign,
         i.total
         - coalesce((select sum(p.amount - p.overpayment_amount) from customer_payments p
                      where p.invoice_id = i.id and p.payment_date <= $1
                        and (p.status = 'active' or p.void_date > $1)), 0)
         - coalesce((select sum(a.amount) from sales_credit_note_applications a
                      where a.invoice_id = i.id and a.application_date <= $1
                        and (a.status = 'active' or a.removal_date > $1)), 0)
         - coalesce((select sum(a.amount) from customer_overpayment_applications a
                      where a.invoice_id = i.id and a.application_date <= $1
                        and (a.status = 'active' or a.removal_date > $1)), 0) as owed
    from sales_invoices i
   where i.status in ('approved', 'voided') and i.invoice_date <= $1 and (i.status = 'approved' or i.void_date > $1)
  union all
  select 'sales', n.total, n.tax_total, -1,
         n.total
         - coalesce((select sum(a.amount) from sales_credit_note_applications a
                      where a.credit_note_id = n.id and a.application_date <= $1
                        and (a.status = 'active' or a.removal_date > $1)), 0)
         - coalesce((select sum(r.amount) from sales_credit_note_refunds r
                      where r.credit_note_id = n.id and r.refund_date <= $1
                        and (r.status = 'active' or r.void_date > $1)), 0)
    from sales_credit_notes n
   where n.status in ('approved', 'voided') and n.credit_note_date <= $1 and (n.status = 'approved' or n.void_date > $1)
  union all
  select 'purchases', b.total, b.tax_total, 1,
         b.total
         - coalesce((select sum(p.amount) from supplier_payments p
                      where p.bill_id = b.id and p.payment_date <= $1
                        and (p.status = 'active' or p.void_date > $1)), 0)
         - coalesce((select sum(a.amount) from supplier_credit_note_applications a
                      where a.bill_id = b.id and a.application_date <= $1
                        and (a.status = 'active' or a.removal_date > $1)), 0)
    from bills b
   where b.status in ('approved', 'voided') and b.bill_date <= $1 and (b.status = 'approved' or b.void_date > $1)
  union all
  select 'purchases', s.total, s.tax_total, -1,
         s.total
         - coalesce((select sum(a.amount) from supplier_credit_note_applications a
                      where a.credit_note_id = s.id and a.application_date <= $1
                        and (a.status = 'active' or a.removal_date > $1)), 0)
         - coalesce((select sum(r.amount) from supplier_credit_note_refunds r
                      where r.credit_note_id = s.id and r.refund_date <= $1
                        and (r.status = 'active' or r.void_date > $1)), 0)
    from supplier_credit_notes s
   where s.status in ('approved', 'voided') and s.credit_note_date <= $1 and (s.status = 'approved' or s.void_date > $1)
)
select side, total::text, tax_total::text, (owed * sign)::text as owed
  from outstanding
 where owed <> 0`;

export type GstBasisChange = {
  /** The basis of the latest return filed before this period. */
  from: GstBasis;
  to: GstBasis;
  /** The end of that return's period: what was outstanding then is adjusted for. */
  asAt: string;
  lastReturnId: string;
  debtorsGst: string;
  creditorsGst: string;
  /** The Box 9 or Box 13 adjustment IR546 calls for; null when it's 0.00. */
  suggestion: GstAdjustment | null;
};

/**
 * When the latest return filed before the period was on another basis, the
 * GST on debtors and creditors at the end of its period and the IR546
 * adjustment for the change (G20-G22). Null when there's no change to adjust
 * for.
 */
async function basisChangeFor(tx: OrgTx, basis: GstBasis, periodStart: string): Promise<GstBasisChange | null> {
  const previous = await tx.query<{ id: string; period_end: string; gst_basis: GstBasis }>(
    `select id::text, period_end, gst_basis from gst_returns where period_end < $1
      order by period_end desc limit 1`,
    [periodStart],
  );
  const last = previous.rows[0];
  if (!last || last.gst_basis === basis) return null;
  const outstanding = await tx.query<{ side: "sales" | "purchases"; total: string; tax_total: string; owed: string }>(
    OUTSTANDING_SQL,
    [last.period_end],
  );
  let debtors = ZERO_DECIMAL;
  let creditors = ZERO_DECIMAL;
  for (const row of outstanding.rows) {
    const gst = dec(gstInOutstanding(row.owed, row.tax_total, row.total));
    if (row.side === "sales") debtors = add(debtors, gst);
    else creditors = add(creditors, gst);
  }
  const debtorsGst = toFixedString(debtors, MONEY_SCALE);
  const creditorsGst = toFixedString(creditors, MONEY_SCALE);
  return {
    from: last.gst_basis,
    to: basis,
    asAt: last.period_end,
    lastReturnId: last.id,
    debtorsGst,
    creditorsGst,
    suggestion: basisChangeAdjustment({ from: last.gst_basis, to: basis, asAt: last.period_end, debtorsGst, creditorsGst }),
  };
}

export type FiledGstReturnSummary = {
  id: string;
  periodStart: string;
  periodEnd: string;
  basis: GstBasis;
  currencyCode: string;
  boxes: GstBoxes;
  filedAt: string;
  filedByEmail: string;
};

type FiledRow = {
  id: string;
  request_hash: string;
  period_start: string;
  period_end: string;
  gst_basis: GstBasis;
  currency_code: string;
  box5: string;
  box6: string;
  box7: string;
  box8: string;
  box9: string;
  box10: string;
  box11: string;
  box12: string;
  box13: string;
  box14: string;
  box15: string;
  sales_gst: string;
  purchases_gst: string;
  filed_at: string;
  filed_by_email: string;
};

const FILED_COLUMNS = `id::text, request_hash, period_start, period_end, gst_basis, currency_code,
  box5::text, box6::text, box7::text, box8::text, box9::text, box10::text, box11::text, box12::text, box13::text,
  box14::text, box15::text, sales_gst::text, purchases_gst::text, filed_at, filed_by_email`;

function toSummary(row: FiledRow): FiledGstReturnSummary {
  return {
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    basis: row.gst_basis,
    currencyCode: row.currency_code,
    boxes: {
      box5: money(row.box5),
      box6: money(row.box6),
      box7: money(row.box7),
      box8: money(row.box8),
      box9: money(row.box9),
      box10: money(row.box10),
      box11: money(row.box11),
      box12: money(row.box12),
      box13: money(row.box13),
      box14: money(row.box14),
      box15: money(row.box15),
    },
    filedAt: row.filed_at,
    filedByEmail: row.filed_by_email,
  };
}

/** Filed returns that share at least one day with the period. */
async function overlappingReturns(tx: OrgTx, periodStart: string, periodEnd: string): Promise<FiledGstReturnSummary[]> {
  const result = await tx.query<FiledRow>(
    `select ${FILED_COLUMNS} from gst_returns
      where daterange(period_start, period_end, '[]') && daterange($1::date, $2::date, '[]')
      order by period_start`,
    [periodStart, periodEnd],
  );
  return result.rows.map(toSummary);
}

/**
 * Works out a GST return for a period, with any Box 9 and Box 13
 * adjustments. Nothing is stored.
 */
export async function calculateGstReturn(
  tx: OrgTx,
  input: { periodStart: unknown; periodEnd: unknown; adjustments?: unknown },
) {
  const { periodStart, periodEnd, months } = parseGstPeriod(input.periodStart, input.periodEnd);
  const adjustments = parseGstAdjustments(input.adjustments);
  const basis = await gstBasis(tx, { lock: false });
  const { figures, lines } = await workOut(tx, basis, periodStart, periodEnd, adjustments);
  return {
    periodStart,
    periodEnd,
    months,
    basis,
    currencyCode: tx.baseCurrency,
    ...figures,
    adjustments,
    lines,
    /** Filed returns that cover any day of this period. */
    filedReturns: await overlappingReturns(tx, periodStart, periodEnd),
    /** The IR546 adjustment when the basis changed since the last filed return. */
    basisChange: await basisChangeFor(tx, basis, periodStart),
  };
}

export async function listGstReturns(tx: OrgTx): Promise<{ gstReturns: FiledGstReturnSummary[] }> {
  const result = await tx.query<FiledRow>(`select ${FILED_COLUMNS} from gst_returns order by period_start desc`);
  return { gstReturns: result.rows.map(toSummary) };
}

export type FiledGstReturn = FiledGstReturnSummary & {
  months: number;
  gstOnTransactions: GstReturnFigures["gstOnTransactions"];
  adjustments: GstAdjustment[];
  lines: GstReturnLine[];
  /** The figures worked out now for the same period, basis and adjustments. */
  current: GstReturnFigures | null;
  /** Why the current figures couldn't be worked out, if they couldn't. */
  currentError: string | null;
  changedSinceFiled: boolean;
  changes: GstBoxChange[];
};

async function loadGstReturn(tx: OrgTx, id: string): Promise<FiledRow | null> {
  const result = await tx.query<FiledRow>(`select ${FILED_COLUMNS} from gst_returns where id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * A filed return exactly as it was filed, and whether the figures worked out
 * now for the same period differ ("Changed since filed"), box by box.
 */
export async function getGstReturn(tx: OrgTx, gstReturnIdInput: unknown): Promise<FiledGstReturn> {
  const id = requireId(gstReturnIdInput, "gstReturnId");
  const row = await loadGstReturn(tx, id);
  if (!row) {
    throw new NotFoundError("GST return not found.");
  }
  const summary = toSummary(row);
  const adjustments = await tx.query<{ box: "9" | "13"; description: string; amount: string }>(
    `select box, description, amount::text from gst_return_adjustments where gst_return_id = $1 order by line_order`,
    [id],
  );
  const lines = await tx.query<StoredLineRow>(
    `select side, event_type, event_date, document_type, document_id::text, document_number, reference,
            contact_id::text, contact_name, document_line_order, description, tax_code, category, tax_rate::text,
            amount::text, gst_amount::text as gst, settled_amount::text, document_total::text
       from gst_return_lines where gst_return_id = $1 order by line_order`,
    [id],
  );
  const storedAdjustments = adjustments.rows.map((adjustment) => ({ ...adjustment, amount: money(adjustment.amount) }));
  const storedFigures = calculateGstBoxes({
    box5: summary.boxes.box5,
    box6: summary.boxes.box6,
    box11: summary.boxes.box11,
    salesGst: row.sales_gst,
    purchasesGst: row.purchases_gst,
    adjustments: storedAdjustments,
  });

  let current: GstReturnFigures | null = null;
  let currentError: string | null = null;
  // Always on the basis it was filed on, even if the organisation's has changed (G19).
  try {
    current = (await workOut(tx, row.gst_basis, row.period_start, row.period_end, storedAdjustments)).figures;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    currentError = error.message;
  }
  const changes = current ? changedGstBoxes(summary.boxes, current.boxes) : [];
  return {
    ...summary,
    months: parseGstPeriod(row.period_start, row.period_end).months,
    gstOnTransactions: storedFigures.gstOnTransactions,
    adjustments: storedAdjustments,
    lines: lines.rows.map(storedLine),
    current,
    currentError,
    changedSinceFiled: changes.length > 0,
    changes,
  };
}

/**
 * Marks a return as filed: stores the period, basis, adjustments, every box
 * and the counted lines as they are now, with who filed it. Idempotent. Two
 * filed returns can't cover the same day. Filing posts no journal and sends
 * nothing to IRD.
 */
export async function fileGstReturn(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; periodStart: unknown; periodEnd: unknown; adjustments?: unknown },
): Promise<{ created: boolean; gstReturn: FiledGstReturn }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const { periodStart, periodEnd } = parseGstPeriod(input.periodStart, input.periodEnd);
  const adjustments = parseGstAdjustments(input.adjustments);
  const hash = requestHash("gst_return", { periodStart, periodEnd, adjustments });

  // One filing at a time, so overlapping periods and retries are checked
  // against every return filed before this one. Also keeps the basis steady.
  const basis = await gstBasis(tx, { lock: true });
  const existing = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from gst_returns where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "GST return");
    return { created: false, gstReturn: await getGstReturn(tx, existing.rows[0].id) };
  }
  const overlapping = await overlappingReturns(tx, periodStart, periodEnd);
  if (overlapping.length > 0) {
    const filed = overlapping[0];
    throw new ConflictError(
      `A GST return for ${filed.periodStart} to ${filed.periodEnd} has already been filed, and returns can't cover the same day twice. Amending a filed return isn't supported yet.`,
    );
  }

  const { figures, lines } = await workOut(tx, basis, periodStart, periodEnd, adjustments);
  const counted = lines.filter((line) => line.boxes.length > 0);
  const { boxes, gstOnTransactions } = figures;
  const inserted = await tx.query<{ id: string }>(
    `insert into gst_returns (command_source, idempotency_key, request_hash, period_start, period_end, gst_basis,
                              currency_code, box5, box6, box7, box8, box9, box10, box11, box12, box13, box14, box15,
                              sales_gst, purchases_gst, adjustment_count, line_count, filed_by_user_id, filed_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric,
             $13::numeric, $14::numeric, $15::numeric, $16::numeric, $17::numeric, $18::numeric, $19::numeric,
             $20::numeric, $21, $22, $23, $24)
     returning id::text`,
    [
      source,
      idempotencyKey,
      hash,
      periodStart,
      periodEnd,
      basis,
      tx.baseCurrency,
      boxes.box5,
      boxes.box6,
      boxes.box7,
      boxes.box8,
      boxes.box9,
      boxes.box10,
      boxes.box11,
      boxes.box12,
      boxes.box13,
      boxes.box14,
      boxes.box15,
      gstOnTransactions.sales,
      gstOnTransactions.purchases,
      adjustments.length,
      counted.length,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const id = inserted.rows[0].id;
  if (adjustments.length > 0) {
    await tx.query(
      `insert into gst_return_adjustments (gst_return_id, line_order, box, description, amount)
       select $1, entry.ordinality, entry.value->>'box', entry.value->>'description', (entry.value->>'amount')::numeric
         from jsonb_array_elements($2::jsonb) with ordinality as entry(value, ordinality)`,
      [id, JSON.stringify(adjustments)],
    );
  }
  if (counted.length > 0) {
    await tx.query(
      `insert into gst_return_lines (gst_return_id, line_order, side, event_type, event_date, document_type,
                                     document_id, document_number, reference, contact_id, contact_name,
                                     document_line_order, description, tax_code, category, tax_rate, amount,
                                     gst_amount, boxes, settled_amount, document_total)
       select $1, entry.ordinality, entry.value->>'side', entry.value->>'eventType', (entry.value->>'eventDate')::date,
              entry.value->>'documentType', (entry.value->>'documentId')::bigint, entry.value->>'documentNumber',
              entry.value->>'reference', (entry.value->>'contactId')::bigint, entry.value->>'contactName',
              (entry.value->>'documentLineOrder')::integer, entry.value->>'description', entry.value->>'taxCode',
              entry.value->>'category', (entry.value->>'taxRate')::numeric, (entry.value->>'amount')::numeric,
              (entry.value->>'gst')::numeric,
              array(select jsonb_array_elements_text(entry.value->'boxes')),
              (entry.value->>'settledAmount')::numeric, (entry.value->>'documentTotal')::numeric
         from jsonb_array_elements($2::jsonb) with ordinality as entry(value, ordinality)`,
      [id, JSON.stringify(counted)],
    );
  }
  await writeAuditEvent(tx, {
    eventType: "gst_return.filed",
    entityType: "gst_return",
    entityId: id,
    details: { periodStart, periodEnd, basis, box15: boxes.box15, adjustments: adjustments.length, lines: counted.length },
  });
  return { created: true, gstReturn: await getGstReturn(tx, id) };
}

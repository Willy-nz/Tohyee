import { getContact } from "@/lib/contacts/service";
import { RECEIVABLES_SQL } from "@/lib/customers/service";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, type Decimal, isZero, neg, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { type AgedAmounts, addBuckets, type Buckets, bucketFor, dayBefore, daysBetween, emptyBuckets, toAmounts } from "@/lib/reports/ageing";

/**
 * Customer statements (examples CST1-CST5), like Xero's: an **activity**
 * statement for a date range (the balance owed before it, each invoice,
 * credit note, payment and refund in it, their voids, and the balance at
 * the end), and an **outstanding** statement as at a date (each invoice
 * still owed and each credit not yet used). Both end with the balance aged
 * by due date as at the statement's date. Credit and overpayments applied to
 * invoices move nothing between the customer and the organisation, so they
 * aren't lines. With `includeSubCustomers` a parent's statement covers it
 * and everything under it (the richer-customers tree), each line naming its
 * customer. The balance is the customer's accounts receivable, the same as
 * aged receivables. Worked out from the documents; nothing is stored.
 */

export type StatementLineType =
  | "invoice"
  | "invoice_voided"
  | "credit_note"
  | "credit_note_voided"
  | "payment"
  | "payment_voided"
  | "refund"
  | "refund_voided";

export type StatementLine = {
  date: string;
  type: StatementLineType;
  /** e.g. "Invoice INV-0001", "Payment", "Refund of CN-0001". */
  description: string;
  reference: string | null;
  contactId: string;
  contactName: string;
  href: string;
  /** Adds to what's owed (invoices, refunds, voided credit and payments). */
  amount: string;
  /** Takes off what's owed (credit notes, payments, voided invoices and refunds). */
  payment: string;
  balance: string;
};

export type OutstandingLine = {
  type: "invoice" | "credit_note" | "overpayment";
  documentId: string;
  number: string;
  date: string;
  dueDate: string | null;
  contactId: string;
  contactName: string;
  href: string;
  /** The document's total (the overpayment's amount), positive. */
  original: string;
  /** Still owed (an invoice), or credit left as a negative amount. */
  outstanding: string;
  /** The same in the base currency, at the document's own rate (MC9). */
  outstandingBase: string;
  daysOverdue: number;
};

type StatementCustomer = { id: string; name: string; billingAddress: string | null; email: string | null };

type StatementBase = {
  customer: StatementCustomer;
  includeSubCustomers: boolean;
  /** The customers covered (the parent first, then its subs by name). */
  customers: { id: string; name: string }[];
  /** The customer's currency (MC9): every amount is in it, except the ones marked base. */
  currencyCode: string;
  /** The organisation's base currency. */
  baseCurrency: string;
  /** Aged as at the statement date, by each invoice's due date, less unused credit. */
  ageing: AgedAmounts;
};

export type ActivityStatement = StatementBase & {
  kind: "activity";
  from: string;
  to: string;
  opening: string;
  lines: StatementLine[];
  totalAmount: string;
  totalPayment: string;
  closing: string;
  /** The closing balance in the base currency, at the documents' own rates (MC9). */
  closingBase: string;
};

export type OutstandingStatement = StatementBase & {
  kind: "outstanding";
  asAt: string;
  lines: OutstandingLine[];
  balance: string;
  /** The balance in the base currency, at the documents' own rates (MC9). */
  balanceBase: string;
};

async function customersCovered(tx: OrgTx, contactId: string, includeSubs: boolean): Promise<{ id: string; name: string }[]> {
  if (!includeSubs) {
    const found = await tx.query<{ id: string; name: string }>("select id::text, name from contacts where id = $1", [contactId]);
    return found.rows;
  }
  const tree = await tx.query<{ id: string; name: string; depth: number }>(
    `with recursive tree as (
       select id, name, 0 as depth from contacts where id = $1
       union all
       select c.id, c.name, t.depth + 1 from contacts c join tree t on c.parent_contact_id = t.id
     ) select id::text, name, depth from tree order by depth, lower(name), tree.id`,
    [contactId],
  );
  return tree.rows.map(({ id, name }) => ({ id, name }));
}

async function startStatement(
  tx: OrgTx,
  input: { contactId?: unknown; includeSubCustomers?: unknown },
): Promise<{ customer: StatementCustomer; includeSubCustomers: boolean; customers: { id: string; name: string }[]; ids: string[]; currencyCode: string }> {
  const contact = await getContact(tx, input.contactId);
  if (!contact.isCustomer) throw new ValidationError(`${contact.name} isn't a customer, so there's no statement for them.`);
  const includeSubCustomers = input.includeSubCustomers === true || input.includeSubCustomers === "true";
  const customers = await customersCovered(tx, contact.id, includeSubCustomers);
  const ids = customers.map((customer) => customer.id);
  // A statement is in the customer's currency (MC9); sub-customers in other currencies can't be added in.
  const currencies = await tx.query<{ currency: string }>(
    "select distinct coalesce(currency_code, $2) as currency from contacts where id = any($1::bigint[])",
    [ids, tx.baseCurrency],
  );
  if (currencies.rows.length > 1) {
    throw new ValidationError(
      `${contact.name} and its sub-customers are in different currencies (${currencies.rows.map((row) => row.currency).join(", ")}), so they can't share a statement yet. Make one statement per customer.`,
    );
  }
  return {
    customer: { id: contact.id, name: contact.name, billingAddress: contact.postalAddress, email: contact.email },
    includeSubCustomers,
    customers,
    ids,
    currencyCode: currencies.rows[0]?.currency ?? tx.baseCurrency,
  };
}

/** Invoices owed and credit unused as at a date for some customers, and their ageing. */
async function outstandingAsAt(tx: OrgTx, ids: string[], asAt: string, names: Map<string, string>, currencyCode: string) {
  const scale = currencyMinorUnits(currencyCode);
  const baseScale = currencyMinorUnits(tx.baseCurrency);
  const rows = await tx.query<{
    type: OutstandingLine["type"];
    document_id: string;
    link_id: string;
    number: string | null;
    date: string;
    due_date: string | null;
    contact_id: string;
    original: string;
    outstanding: string;
    outstanding_base: string;
  }>(
    `${RECEIVABLES_SQL}
     select 'invoice' as type, i.id::text as document_id, i.id::text as link_id, i.invoice_number as number, i.invoice_date as date,
            i.due_date, i.contact_id::text, s.total::text as original, i.amount_due::text as outstanding,
            i.amount_due_base::text as outstanding_base, i.id as sort_id
       from invoices i join sales_invoices s on s.id = i.id
      where (i.amount_due <> 0 or i.amount_due_base <> 0) and i.contact_id = any($2::bigint[])
     union all
     select 'credit_note', id::text, id::text, credit_note_number, credit_note_date, null, contact_id::text, total::text, (-unused)::text,
            (-coalesce(base_unused, unused))::text, id
       from credit_notes_open where (unused <> 0 or coalesce(base_unused, 0) <> 0) and contact_id = any($2::bigint[])
     union all
     select 'overpayment', id::text, id::text, invoice_number, payment_date, null, contact_id::text, overpayment_amount::text, (-unused)::text,
            (-coalesce(base_unused, unused))::text, id
       from overpayments_open where (unused <> 0 or coalesce(base_unused, 0) <> 0) and contact_id = any($2::bigint[])
     order by date, type desc, sort_id`,
    [asAt, ids],
  );
  let buckets: Buckets = emptyBuckets();
  const lines: OutstandingLine[] = rows.rows.map((row) => {
    const outstanding = dec(row.outstanding);
    const daysOverdue = row.due_date ? daysBetween(row.due_date, asAt) : 0;
    const own = emptyBuckets();
    if (row.type === "invoice") own[bucketFor(daysOverdue)] = outstanding;
    else own.credit = neg(outstanding);
    buckets = addBuckets(buckets, own);
    const href =
      row.type === "invoice"
        ? `/operations/invoices/${row.link_id}`
        : row.type === "credit_note"
          ? `/operations/credit-notes/${row.link_id}`
          : `/operations/overpayments/${row.link_id}`;
    return {
      type: row.type,
      documentId: row.document_id,
      number: row.type === "overpayment" ? `Overpayment on ${row.number ?? ""}`.trim() : (row.number ?? `#${row.document_id}`),
      date: row.date,
      dueDate: row.due_date,
      contactId: row.contact_id,
      contactName: names.get(row.contact_id) ?? `#${row.contact_id}`,
      href,
      original: toFixedString(dec(row.original), scale),
      outstanding: toFixedString(outstanding, scale),
      outstandingBase: toFixedString(dec(row.outstanding_base), baseScale),
      daysOverdue: Math.max(daysOverdue, 0),
    };
  });
  const balanceBase = toFixedString(sum(lines.map((line) => dec(line.outstandingBase))), baseScale);
  return { lines, ageing: toAmounts(buckets, scale), balanceBase };
}

/** The statement's balance as at a date (from the documents; the same as aged receivables). */
async function balanceAsAt(tx: OrgTx, ids: string[], asAt: string): Promise<Decimal> {
  const result = await tx.query<{ balance: string }>(
    `${RECEIVABLES_SQL}
     select (coalesce((select sum(amount_due) from invoices where contact_id = any($2::bigint[])), 0)
             - coalesce((select sum(unused) from credit where contact_id = any($2::bigint[])), 0))::text as balance`,
    [asAt, ids],
  );
  return dec(result.rows[0].balance);
}

/**
 * Everything that changed what the customers owe between two dates: each
 * row adds (`sign` 1) or takes off (-1) its amount. Payments for several
 * invoices show once, for the whole batch (less any overpayment kept, which
 * is shown on its own part as usual).
 */
const ACTIVITY_SQL = `
select * from (
  select i.invoice_date as date, 'invoice' as type, i.id::text as link_id, i.invoice_number as number, i.reference,
         i.contact_id::text, i.total::text as amount, 1 as sign, 1 as step, i.id as sort_id
    from sales_invoices i
   where i.status in ('approved', 'voided') and i.contact_id = any($3::bigint[]) and i.invoice_date between $1 and $2
  union all
  select i.void_date, 'invoice_voided', i.id::text, i.invoice_number, i.reference, i.contact_id::text, i.total::text, -1, 2, i.id
    from sales_invoices i
   where i.status = 'voided' and i.contact_id = any($3::bigint[]) and i.void_date between $1 and $2
  union all
  select n.credit_note_date, 'credit_note', n.id::text, n.credit_note_number, n.reference, n.contact_id::text, n.total::text, -1, 3, n.id
    from sales_credit_notes n
   where n.status in ('approved', 'voided') and n.contact_id = any($3::bigint[]) and n.credit_note_date between $1 and $2
  union all
  select n.void_date, 'credit_note_voided', n.id::text, n.credit_note_number, n.reference, n.contact_id::text, n.total::text, 1, 4, n.id
    from sales_credit_notes n
   where n.status = 'voided' and n.contact_id = any($3::bigint[]) and n.void_date between $1 and $2
  union all
  select p.payment_date, 'payment', i.id::text, i.invoice_number, p.reference, i.contact_id::text, p.amount::text, -1, 5, p.id
    from customer_payments p join sales_invoices i on i.id = p.invoice_id
   where p.batch_id is null and i.contact_id = any($3::bigint[]) and p.payment_date between $1 and $2
  union all
  select p.void_date, 'payment_voided', i.id::text, i.invoice_number, p.reference, i.contact_id::text, p.amount::text, 1, 6, p.id
    from customer_payments p join sales_invoices i on i.id = p.invoice_id
   where p.batch_id is null and p.status = 'voided' and i.contact_id = any($3::bigint[]) and p.void_date between $1 and $2
  union all
  select b.payment_date, 'batch_payment', b.id::text, null, b.reference, b.contact_id::text, b.amount::text, -1, 5, b.id
    from customer_payment_batches b
   where b.contact_id = any($3::bigint[]) and b.payment_date between $1 and $2
  union all
  select b.void_date, 'batch_payment_voided', b.id::text, null, b.reference, b.contact_id::text, b.amount::text, 1, 6, b.id
    from customer_payment_batches b
   where b.status = 'voided' and b.contact_id = any($3::bigint[]) and b.void_date between $1 and $2
  union all
  select r.refund_date, 'refund', n.id::text, n.credit_note_number, r.reference, n.contact_id::text, r.amount::text, 1, 7, r.id
    from sales_credit_note_refunds r join sales_credit_notes n on n.id = r.credit_note_id
   where n.contact_id = any($3::bigint[]) and r.refund_date between $1 and $2
  union all
  select r.void_date, 'refund_voided', n.id::text, n.credit_note_number, r.reference, n.contact_id::text, r.amount::text, -1, 8, r.id
    from sales_credit_note_refunds r join sales_credit_notes n on n.id = r.credit_note_id
   where r.status = 'voided' and n.contact_id = any($3::bigint[]) and r.void_date between $1 and $2
  union all
  select r.refund_date, 'overpayment_refund', p.id::text, i.invoice_number, r.reference, i.contact_id::text, r.amount::text, 1, 7, r.id
    from customer_overpayment_refunds r join customer_payments p on p.id = r.payment_id join sales_invoices i on i.id = p.invoice_id
   where i.contact_id = any($3::bigint[]) and r.refund_date between $1 and $2
  union all
  select r.void_date, 'overpayment_refund_voided', p.id::text, i.invoice_number, r.reference, i.contact_id::text, r.amount::text, -1, 8, r.id
    from customer_overpayment_refunds r join customer_payments p on p.id = r.payment_id join sales_invoices i on i.id = p.invoice_id
   where r.status = 'voided' and i.contact_id = any($3::bigint[]) and r.void_date between $1 and $2
) activity
order by date, step, sort_id`;

type ActivityRow = {
  date: string;
  type: StatementLineType | "batch_payment" | "batch_payment_voided" | "overpayment_refund" | "overpayment_refund_voided";
  link_id: string;
  number: string | null;
  reference: string | null;
  contact_id: string;
  amount: string;
  sign: number;
};

function describe(row: ActivityRow): { type: StatementLineType; description: string; href: string } {
  const number = row.number ?? "";
  switch (row.type) {
    case "invoice":
      return { type: "invoice", description: `Invoice ${number}`, href: `/operations/invoices/${row.link_id}` };
    case "invoice_voided":
      return { type: "invoice_voided", description: `Invoice ${number} voided`, href: `/operations/invoices/${row.link_id}` };
    case "credit_note":
      return { type: "credit_note", description: `Credit note ${number}`, href: `/operations/credit-notes/${row.link_id}` };
    case "credit_note_voided":
      return { type: "credit_note_voided", description: `Credit note ${number} voided`, href: `/operations/credit-notes/${row.link_id}` };
    case "payment":
      return { type: "payment", description: `Payment on ${number}`, href: `/operations/invoices/${row.link_id}` };
    case "payment_voided":
      return { type: "payment_voided", description: `Payment on ${number} voided`, href: `/operations/invoices/${row.link_id}` };
    case "batch_payment":
      return { type: "payment", description: "Payment", href: `/operations/customer-payments/${row.link_id}` };
    case "batch_payment_voided":
      return { type: "payment_voided", description: "Payment voided", href: `/operations/customer-payments/${row.link_id}` };
    case "refund":
      return { type: "refund", description: `Refund of credit note ${number}`, href: `/operations/credit-notes/${row.link_id}` };
    case "refund_voided":
      return { type: "refund_voided", description: `Refund of credit note ${number} voided`, href: `/operations/credit-notes/${row.link_id}` };
    case "overpayment_refund":
      return { type: "refund", description: `Refund of overpayment on ${number}`, href: `/operations/overpayments/${row.link_id}` };
    case "overpayment_refund_voided":
      return { type: "refund_voided", description: `Refund of overpayment on ${number} voided`, href: `/operations/overpayments/${row.link_id}` };
  }
}

export async function activityStatement(
  tx: OrgTx,
  input: { contactId?: unknown; from?: unknown; to?: unknown; includeSubCustomers?: unknown },
): Promise<ActivityStatement> {
  const to = parseOptionalIsoDate(input.to, "to") ?? todayIsoDate();
  const from = parseIsoDate(input.from, "from");
  if (from > to) throw new ValidationError("The start date must be on or before the end date.");
  const start = await startStatement(tx, input);
  const names = new Map(start.customers.map((customer) => [customer.id, customer.name]));
  const scale = currencyMinorUnits(start.currencyCode);
  const money = (value: Decimal) => toFixedString(value, scale);

  const opening = await balanceAsAt(tx, start.ids, dayBefore(from));
  const rows = await tx.query<ActivityRow>(ACTIVITY_SQL, [from, to, start.ids]);
  let balance = opening;
  const adds: Decimal[] = [];
  const takes: Decimal[] = [];
  const lines = rows.rows.map((row): StatementLine => {
    const amount = dec(row.amount);
    balance = row.sign > 0 ? add(balance, amount) : sub(balance, amount);
    (row.sign > 0 ? adds : takes).push(amount);
    const { type, description, href } = describe(row);
    return {
      date: row.date,
      type,
      description,
      reference: row.reference,
      contactId: row.contact_id,
      contactName: names.get(row.contact_id) ?? `#${row.contact_id}`,
      href,
      amount: row.sign > 0 ? money(amount) : money(ZERO_DECIMAL),
      payment: row.sign < 0 ? money(amount) : money(ZERO_DECIMAL),
      balance: money(balance),
    };
  });
  const { ageing, balanceBase } = await outstandingAsAt(tx, start.ids, to, names, start.currencyCode);
  return {
    kind: "activity",
    customer: start.customer,
    includeSubCustomers: start.includeSubCustomers,
    customers: start.customers,
    currencyCode: start.currencyCode,
    baseCurrency: tx.baseCurrency,
    from,
    to,
    opening: money(opening),
    lines,
    totalAmount: money(sum(adds)),
    totalPayment: money(sum(takes)),
    closing: money(balance),
    closingBase: balanceBase,
    ageing,
  };
}

export async function outstandingStatement(
  tx: OrgTx,
  input: { contactId?: unknown; asAt?: unknown; includeSubCustomers?: unknown },
): Promise<OutstandingStatement> {
  const asAt = parseOptionalIsoDate(input.asAt, "asAt") ?? todayIsoDate();
  const start = await startStatement(tx, input);
  const names = new Map(start.customers.map((customer) => [customer.id, customer.name]));
  const scale = currencyMinorUnits(start.currencyCode);
  const { lines, ageing, balanceBase } = await outstandingAsAt(tx, start.ids, asAt, names, start.currencyCode);
  const balance = sum(lines.map((line) => dec(line.outstanding)));
  return {
    kind: "outstanding",
    customer: start.customer,
    includeSubCustomers: start.includeSubCustomers,
    customers: start.customers,
    currencyCode: start.currencyCode,
    baseCurrency: tx.baseCurrency,
    asAt,
    lines,
    balance: toFixedString(isZero(balance) ? ZERO_DECIMAL : balance, scale),
    balanceBase,
    ageing,
  };
}

import { type BankAccount, listBankAccounts } from "@/lib/bank/accounts";
import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { dec, toFixedString } from "@/lib/money/decimal";
import { gstPeriodEnd, parseGstPeriod } from "@/lib/reports/gst-boxes";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import type { GstBasis } from "@/lib/tax/categories";

/**
 * Home (examples H1-H4): bank accounts, money owed to you, bills to pay and
 * the next GST return. Worked out when it's opened; nothing is stored.
 */

export type AmountsDue = {
  total: string;
  count: number;
  overdueTotal: string;
  overdueCount: number;
};

export type NextGstReturn =
  | { status: "none_filed" }
  | {
      status: "ready";
      periodStart: string;
      periodEnd: string;
      basis: GstBasis;
      box15: string;
    }
  | { status: "error"; periodStart: string; periodEnd: string; message: string };

export type HomeSummary = {
  today: string;
  currencyCode: string;
  bankAccounts: BankAccount[];
  owedToYou: AmountsDue;
  billsToPay: AmountsDue;
  nextGstReturn: NextGstReturn;
};

const money = (value: string) => toFixedString(dec(value), 2);

type DueRow = { total: string; count: number; overdue_total: string; overdue_count: number };

function toDue(row: DueRow): AmountsDue {
  return {
    total: money(row.total),
    count: row.count,
    overdueTotal: money(row.overdue_total),
    overdueCount: row.overdue_count,
  };
}

/**
 * Approved invoices with something still due (H2): the total less the invoice
 * part of active payments, active credit applied and active overpayment
 * credit applied. Overdue means due before today.
 */
const OWED_SQL = `
with due as (
  select i.due_date, i.total - tohyee_invoice_settled(i.id) as amount_due
    from sales_invoices i
   where i.status = 'approved'
)
select coalesce(sum(amount_due), 0)::text as total, count(*)::integer as count,
       coalesce(sum(amount_due) filter (where due_date < $1), 0)::text as overdue_total,
       (count(*) filter (where due_date < $1))::integer as overdue_count
  from due
 where amount_due > 0`;

/** Approved bills with something still to pay (H3): less active supplier payments and supplier credit applied. */
const BILLS_SQL = `
with due as (
  select b.due_date,
         b.total
         - coalesce((select sum(p.amount) from supplier_payments p where p.bill_id = b.id and p.status = 'active'), 0)
         - coalesce((select sum(a.amount) from supplier_credit_note_applications a
                      where a.bill_id = b.id and a.status = 'active'), 0) as amount_due
    from bills b
   where b.status = 'approved'
)
select coalesce(sum(amount_due), 0)::text as total, count(*)::integer as count,
       coalesce(sum(amount_due) filter (where due_date < $1), 0)::text as overdue_total,
       (count(*) filter (where due_date < $1))::integer as overdue_count
  from due
 where amount_due > 0`;

function monthsBetween(start: string, end: string): number {
  return parseGstPeriod(start, end).months;
}

/**
 * The period straight after the latest filed GST return, the same length, with
 * its Box 15 so far (H4). Tohyee doesn't guess a period when none is filed.
 */
async function nextGstReturn(tx: OrgTx): Promise<NextGstReturn> {
  const latest = await tx.query<{ period_start: string; period_end: string }>(
    "select period_start, period_end from gst_returns order by period_end desc limit 1",
  );
  const last = latest.rows[0];
  if (!last) return { status: "none_filed" };
  const next = new Date(`${last.period_end}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const periodStart = next.toISOString().slice(0, 10);
  const periodEnd = gstPeriodEnd(periodStart, monthsBetween(last.period_start, last.period_end));
  try {
    const report = await calculateGstReturn(tx, { periodStart, periodEnd });
    return { status: "ready", periodStart, periodEnd, basis: report.basis, box15: report.boxes.box15 };
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return { status: "error", periodStart, periodEnd, message: error.message };
  }
}

export async function getHomeSummary(tx: OrgTx, input: { today?: unknown } = {}): Promise<HomeSummary> {
  const today = parseOptionalIsoDate(input.today, "today") ?? todayIsoDate();
  const bankAccounts = (await listBankAccounts(tx)).filter((account) => account.isActive);
  const owed = await tx.query<DueRow>(OWED_SQL, [today]);
  const bills = await tx.query<DueRow>(BILLS_SQL, [today]);
  return {
    today,
    currencyCode: tx.baseCurrency,
    bankAccounts,
    owedToYou: toDue(owed.rows[0]),
    billsToPay: toDue(bills.rows[0]),
    nextGstReturn: await nextGstReturn(tx),
  };
}

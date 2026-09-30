import { type BankAccount, listBankAccounts } from "@/lib/bank/accounts";
import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { dec, toFixedString } from "@/lib/money/decimal";
import { gstPeriodAfter } from "@/lib/reports/gst-boxes";
import { calculateGstReturn, latestFiledGstPeriod, loadGstPeriodSetting } from "@/lib/reports/gst-return";
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
  -- In the base currency: a foreign-currency invoice at its own rate (MC9).
  select i.due_date,
         case when i.base_total is null then i.total - tohyee_invoice_settled(i.id)
              when i.total = tohyee_invoice_settled(i.id) then 0
              else i.base_total - tohyee_invoice_base_settled(i.id) end as amount_due
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
  -- In the base currency: a foreign-currency bill at its own rate (MC9).
  select b.due_date,
         coalesce(b.base_total, b.total)
         - coalesce((select sum(coalesce(p.base_cleared, p.amount)) from supplier_payments p where p.bill_id = b.id and p.status = 'active'), 0)
         - coalesce((select sum(coalesce(a.bill_base, a.amount)) from supplier_credit_note_applications a
                      where a.bill_id = b.id and a.status = 'active'), 0) as amount_due
    from bills b
   where b.status = 'approved'
)
select coalesce(sum(amount_due), 0)::text as total, count(*)::integer as count,
       coalesce(sum(amount_due) filter (where due_date < $1), 0)::text as overdue_total,
       (count(*) filter (where due_date < $1))::integer as overdue_count
  from due
 where amount_due > 0`;

/**
 * The period straight after the latest filed GST return, with its Box 15 so
 * far (H4): to the end of the GST period setting's period (GP3), or without
 * a setting the same length as that return. Tohyee doesn't guess a period
 * when none is filed.
 */
async function nextGstReturn(tx: OrgTx): Promise<NextGstReturn> {
  const last = await latestFiledGstPeriod(tx);
  if (!last) return { status: "none_filed" };
  const { periodStart, periodEnd } = gstPeriodAfter(await loadGstPeriodSetting(tx), last);
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

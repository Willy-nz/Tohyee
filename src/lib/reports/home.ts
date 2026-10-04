import { listBankAccounts } from "@/lib/bank/accounts";
import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { addDays, financialYearStart, monthEndOf, monthStartOf } from "@/lib/financial-year";
import { add, dec, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { paydayFilingDueDate } from "@/lib/payroll/payday-filing";
import { financialYearEndMonth, profitAndLoss } from "@/lib/reports/financial";
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
  cashInBank: string;
  owedToYou: AmountsDue;
  billsToPay: AmountsDue;
  billsDueThisWeek: number;
  nextGstReturn: NextGstReturn;
  profitByMonth: Array<{ monthStart: string; netProfit: string }>;
  toDo: {
    paydayFilingsDue: number;
    accountsToReconcile: number;
    feedsToReconnect: number;
    draftsToApprove: number;
  };
  recentActivity: Array<{ journalId: string; postingDate: string; reference: string; description: string; amount: string }>;
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

const BILLS_DUE_THIS_WEEK_SQL = `
with due as (
  select b.due_date,
         coalesce(b.base_total, b.total)
         - coalesce((select sum(coalesce(p.base_cleared, p.amount)) from supplier_payments p where p.bill_id = b.id and p.status = 'active'), 0)
         - coalesce((select sum(coalesce(a.bill_base, a.amount)) from supplier_credit_note_applications a
                      where a.bill_id = b.id and a.status = 'active'), 0) as amount_due
    from bills b
   where b.status = 'approved'
)
select (count(*) filter (where due_date >= $1 and due_date <= $2 and amount_due > 0))::integer as count
  from due`;

const DRAFTS_SQL = `
select (
  (select count(*) from sales_invoices where status = 'draft')
  + (select count(*) from bills where status = 'draft')
  + (select count(*) from purchase_orders where status = 'draft')
  + (select count(*) from sales_orders where status = 'draft')
  + (select count(*) from quotes where status = 'draft')
  + (select count(*) from repeating_invoices where status = 'draft')
  + (select count(*) from repeating_bills where status = 'draft')
  + (select count(*) from ledger_journal_drafts where status = 'draft')
)::integer as count`;

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
  const cashInBank = toFixedString(
    bankAccounts
      .filter((account) => account.accountType === "bank")
      .reduce((sum, account) => add(sum, dec(account.ledgerBalance)), ZERO_DECIMAL),
    2,
  );
  const owed = await tx.query<DueRow>(OWED_SQL, [today]);
  const bills = await tx.query<DueRow>(BILLS_SQL, [today]);
  const billsDueThisWeek = await tx.query<{ count: number }>(BILLS_DUE_THIS_WEEK_SQL, [today, addDays(today, 6)]);
  const drafts = await tx.query<{ count: number }>(DRAFTS_SQL);
  const payRuns = await tx.query<{ pay_date: string }>(
    "select pay_date::text from payroll_pay_runs where status = 'approved' and pay_date >= $1::date order by pay_date desc limit 40",
    [addDays(today, -21)],
  );
  const yearStart = financialYearStart(today, await financialYearEndMonth(tx));
  const months: Array<{ monthStart: string; netProfit: string }> = [];
  for (let month = monthStartOf(yearStart); month <= monthStartOf(today); month = monthStartOf(addDays(monthEndOf(month), 1))) {
    const to = monthEndOf(month) > today ? today : monthEndOf(month);
    const report = await profitAndLoss(tx, { from: month, to });
    months.push({ monthStart: month, netProfit: report.netProfit });
  }
  const journals = await tx.query<{ id: string; posting_date: string; reference: string; description: string | null; total_debit: string }>(
    "select id::text, posting_date::text, reference, description, total_debit::text from ledger_journals order by id desc limit 4",
  );
  return {
    today,
    currencyCode: tx.baseCurrency,
    cashInBank,
    owedToYou: toDue(owed.rows[0]),
    billsToPay: toDue(bills.rows[0]),
    billsDueThisWeek: billsDueThisWeek.rows[0]?.count ?? 0,
    nextGstReturn: await nextGstReturn(tx),
    profitByMonth: months,
    toDo: {
      paydayFilingsDue: payRuns.rows.filter((row) => paydayFilingDueDate(row.pay_date) <= today).length,
      accountsToReconcile: bankAccounts.reduce((sum, account) => sum + account.unreconciledCount, 0),
      feedsToReconnect: bankAccounts.filter((account) => account.feed.active && account.feed.lastSyncStatus === "failed").length,
      draftsToApprove: drafts.rows[0]?.count ?? 0,
    },
    recentActivity: journals.rows.map((row) => ({
      journalId: row.id,
      postingDate: row.posting_date,
      reference: row.reference,
      description: row.description ?? "Manual journal",
      amount: money(row.total_debit),
    })),
  };
}

import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  addDays,
  financialYearEnd,
  financialYearStart,
  isMonthEndDate,
  monthEndOf,
  monthLabel,
  monthStartOf,
} from "@/lib/financial-year";
import { previewDepreciationRun } from "@/lib/fixed-assets/runs";
import { formatDate, formatMoney } from "@/lib/format";
import { foreignAccountState } from "@/lib/ledger/foreign";
import { getPeriodControls, type PeriodControls, setLockDate } from "@/lib/ledger/period-controls";
import { currencyMinorUnits } from "@/lib/money/currency";
import { dec, isNegative, isZero, neg, sub, toFixedString } from "@/lib/money/decimal";
import { agedPayables } from "@/lib/reports/aged-payables";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { bankReconciliationReport } from "@/lib/reports/bank-reconciliation";
import { financialYearEndMonth } from "@/lib/reports/financial";
import { describeGstPeriodSetting, gstPeriodAfter } from "@/lib/reports/gst-boxes";
import { latestFiledGstPeriod, loadGstPeriodSetting } from "@/lib/reports/gst-return";
import { requireString } from "@/lib/validation";

/**
 * Period close, like NetSuite's Period Close Checklist (examples PC1-PC12):
 * periods are calendar months, closed in order; closing one runs checks
 * Tohyee can work out itself, then moves the lock date to its last day.
 * There are no closing journals: the balance sheet works retained earnings
 * out when it runs (YE1-YE4).
 */

export type PeriodStatus = "open" | "closed" | "partly_locked";

export type PeriodMonth = {
  start: string;
  end: string;
  label: string;
  status: PeriodStatus;
  hasPostings: boolean;
  /** It can be closed now: every earlier month with postings is closed. */
  canClose: boolean;
};

export type PeriodYear = {
  start: string;
  end: string;
  status: "open" | "closed";
  months: PeriodMonth[];
};

export type PeriodHistoryEntry = {
  id: string;
  eventType: string;
  actorEmail: string | null;
  createdAt: string;
  periodEnd: string | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  warningsAccepted: string[];
};

export type PeriodList = {
  lockDate: string | null;
  financialYearEndMonth: number;
  /** The earliest month that can be closed now, if any. */
  nextToClose: string | null;
  years: PeriodYear[];
  history: PeriodHistoryEntry[];
};

function statusOf(month: { start: string; end: string }, lockDate: string | null): PeriodStatus {
  if (lockDate === null || lockDate < month.start) return "open";
  return lockDate >= month.end ? "closed" : "partly_locked";
}

/** The first month with postings that isn't closed yet (its first posting's date). */
async function firstOpenPosting(tx: OrgTx, lockDate: string | null): Promise<string | null> {
  const found = await tx.query<{ first: string | null }>(
    "select min(posting_date)::text as first from ledger_journals where $1::date is null or posting_date > $1",
    [lockDate],
  );
  return found.rows[0].first;
}

/**
 * The financial years and their months, newest first, from the first month
 * with postings (or the lock date) to this month, with their status (PC1).
 */
export async function listPeriods(tx: OrgTx, input: { today?: unknown } = {}): Promise<PeriodList> {
  const today = parseOptionalIsoDate(input.today, "today") ?? todayIsoDate();
  const yearEndMonth = await financialYearEndMonth(tx);
  const { lockDate } = await getPeriodControls(tx);
  const range = await tx.query<{ first: string | null; last: string | null }>(
    "select min(posting_date)::text as first, max(posting_date)::text as last from ledger_journals",
  );
  const postingMonths = new Set(
    (await tx.query<{ month: string }>("select distinct to_char(posting_date, 'YYYY-MM') as month from ledger_journals")).rows.map((row) => row.month),
  );
  const candidates = [range.rows[0].first, lockDate, today].filter((date): date is string => date !== null);
  const first = monthStartOf(candidates.reduce((min, date) => (date < min ? date : min)));
  const lastCandidates = [range.rows[0].last, today].filter((date): date is string => date !== null);
  const last = monthEndOf(lastCandidates.reduce((max, date) => (date > max ? date : max)));
  const openPosting = await firstOpenPosting(tx, lockDate);
  const closableUpTo = openPosting ? monthEndOf(openPosting) : null;

  const years: PeriodYear[] = [];
  for (let yearStart = financialYearStart(first, yearEndMonth); yearStart <= last; ) {
    const yearEnd = financialYearEnd(yearStart, yearEndMonth);
    const months: PeriodMonth[] = [];
    for (let start = yearStart; start <= yearEnd && start <= last; start = addDays(monthEndOf(start), 1)) {
      if (monthEndOf(start) < first) continue;
      const end = monthEndOf(start);
      const status = statusOf({ start, end }, lockDate);
      months.push({
        start,
        end,
        label: monthLabel(start),
        status,
        hasPostings: postingMonths.has(start.slice(0, 7)),
        canClose: status !== "closed" && (closableUpTo === null || end <= closableUpTo),
      });
    }
    years.push({ start: yearStart, end: yearEnd, status: lockDate !== null && lockDate >= yearEnd ? "closed" : "open", months: months.reverse() });
    yearStart = addDays(yearEnd, 1);
  }
  years.reverse();
  const nextToClose =
    years
      .flatMap((year) => year.months)
      .filter((month) => month.canClose)
      .map((month) => month.end)
      .sort()[0] ?? null;
  return { lockDate, financialYearEndMonth: yearEndMonth, nextToClose, years, history: await periodHistory(tx) };
}

async function periodHistory(tx: OrgTx): Promise<PeriodHistoryEntry[]> {
  const events = await tx.query<{ id: string; event_type: string; actor_email: string | null; created_at: string; details: Record<string, unknown> }>(
    `select id::text, event_type, actor_email, created_at, details from audit_events
      where entity_type = 'accounting_period_controls'
      order by audit_events.id desc limit 50`,
  );
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const lock = (value: unknown) => (value && typeof value === "object" ? text((value as { lockDate?: unknown }).lockDate) : null);
  return events.rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    actorEmail: row.actor_email,
    createdAt: row.created_at,
    periodEnd: text(row.details.periodEnd),
    from: lock(row.details.from),
    to: lock(row.details.to),
    reason: text(row.details.reason),
    warningsAccepted: Array.isArray(row.details.warningsAccepted)
      ? row.details.warningsAccepted.map((warning) => (warning && typeof warning === "object" ? String((warning as { title?: unknown }).title ?? "") : ""))
      : [],
  }));
}

export type CheckStatus = "pass" | "warning" | "not_applicable";

export type CheckItem = { label: string; detail: string; href: string | null };

export type PeriodCheck = {
  key: "bank" | "drafts" | "depreciation" | "fx_revaluation" | "stock" | "negative_stock" | "receivables" | "payables" | "gst" | "opening_balance";
  title: string;
  status: CheckStatus;
  summary: string;
  items: CheckItem[];
  fix: { href: string; label: string } | null;
};

export type PeriodChecklist = {
  periodEnd: string;
  label: string;
  /** The first day the close covers: the day after the lock date (null: from the start). */
  from: string | null;
  status: PeriodStatus;
  checks: PeriodCheck[];
  warnings: number;
};

function parsePeriodEnd(input: unknown): string {
  const periodEnd = parseIsoDate(input, "periodEnd");
  if (!isMonthEndDate(periodEnd)) {
    throw new ValidationError("Periods are months: give the month's last day, e.g. 2026-06-30.");
  }
  return periodEnd;
}

const longDate = formatDate;

/** A ledger balance (debits less credits) as at a date for the account with this system key. */
async function systemAccountBalance(tx: OrgTx, systemKey: string, asAt: string): Promise<{ id: string; code: string; name: string; balance: string } | null> {
  const found = await tx.query<{ id: string; code: string; name: string; balance: string }>(
    `select a.id::text, a.code, a.name,
            coalesce((select sum(l.debit_amount - l.credit_amount) from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
                       where l.account_id = a.id and j.posting_date <= $2), 0)::text as balance
       from accounts a where a.system_key = $1`,
    [systemKey, asAt],
  );
  return found.rows[0] ?? null;
}

function pass(key: PeriodCheck["key"], title: string, summary: string, fix: PeriodCheck["fix"] = null): PeriodCheck {
  return { key, title, status: "pass", summary, items: [], fix };
}

function notApplicable(key: PeriodCheck["key"], title: string, summary: string): PeriodCheck {
  return { key, title, status: "not_applicable", summary, items: [], fix: null };
}

async function bankCheck(tx: OrgTx, periodEnd: string, money: (value: string) => string): Promise<PeriodCheck> {
  const title = "Bank accounts reconciled";
  const accounts = await tx.query<{ id: string; code: string; name: string }>(
    `select a.id::text, a.code, a.name from accounts a
      where a.account_type in ('bank', 'credit_card')
        and (exists (select 1 from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id where l.account_id = a.id and j.posting_date <= $1)
          or exists (select 1 from bank_statement_lines b where b.account_id = a.id and b.status <> 'deleted' and b.line_date <= $1))
      order by a.code`,
    [periodEnd],
  );
  if (accounts.rows.length === 0) return notApplicable("bank", title, `No bank or credit card account has anything on or before ${longDate(periodEnd)}.`);
  const items: CheckItem[] = [];
  for (const account of accounts.rows) {
    const label = `${account.code} ${account.name}`;
    const href = `/operations/reports?report=bankrec&account=${account.id}&asAt=${periodEnd}`;
    try {
      const report = await bankReconciliationReport(tx, { accountId: account.id, asAt: periodEnd });
      const unreconciled = report.bankNotInTohyee.items;
      if (report.statementBalance === null) {
        // PC3, decided 1 Oct 2026 following NetSuite (its close doesn't require bank statements): a warning, not a block.
        items.push({
          label,
          detail: `No statement balance is known at ${longDate(periodEnd)}: no bank statement or feed covers that date, so Tohyee can't check this account against the bank. Import the statement to that date, or, if this account has no statements (cash, a loan or a clearing account), an owner or admin can accept this warning when closing.`,
          href: `/operations/bank-accounts/${account.id}`,
        });
      } else if (unreconciled.length > 0) {
        items.push({
          label,
          detail: `${unreconciled.length} statement ${unreconciled.length === 1 ? "line" : "lines"} on or before ${longDate(periodEnd)} not reconciled (${money(report.bankNotInTohyee.total)}).`,
          href: `/operations/bank-accounts/${account.id}`,
        });
      } else if (!report.explained) {
        items.push({ label, detail: `The statement balance ${money(report.statementBalance)} isn't explained: ${money(report.notExplained ?? "0")} left over.`, href });
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      items.push({ label, detail: error.message, href: `/operations/bank-accounts/${account.id}` });
    }
  }
  if (items.length === 0) {
    return pass("bank", title, `${accounts.rows.length === 1 ? "The account is" : `All ${accounts.rows.length} accounts are`} reconciled to ${longDate(periodEnd)}.`);
  }
  return {
    key: "bank",
    title,
    status: "warning",
    summary: `${items.length} of ${accounts.rows.length} ${accounts.rows.length === 1 ? "account isn't" : "accounts aren't"} reconciled to ${longDate(periodEnd)}.`,
    items,
    fix: { href: `/operations/reports?report=bankrec&asAt=${periodEnd}`, label: "Bank reconciliation report" },
  };
}

async function draftsCheck(tx: OrgTx, from: string | null, periodEnd: string, money: (value: string) => string): Promise<PeriodCheck> {
  const title = "No drafts left in the period";
  const drafts = await tx.query<{ kind: string; id: string; date: string; who: string; total: string; path: string }>(
    `select * from (
       select 'Invoice' as kind, i.id::text, i.invoice_date::text as date, c.name as who, i.total::text as total, 'invoices' as path
         from sales_invoices i join contacts c on c.id = i.contact_id where i.status = 'draft' and i.invoice_date <= $2 and ($1::date is null or i.invoice_date >= $1)
       union all
       select 'Credit note', n.id::text, n.credit_note_date::text, c.name, n.total::text, 'credit-notes'
         from sales_credit_notes n join contacts c on c.id = n.contact_id where n.status = 'draft' and n.credit_note_date <= $2 and ($1::date is null or n.credit_note_date >= $1)
       union all
       select 'Bill', b.id::text, b.bill_date::text, c.name, b.total::text, 'bills'
         from bills b join contacts c on c.id = b.contact_id where b.status = 'draft' and b.bill_date <= $2 and ($1::date is null or b.bill_date >= $1)
       union all
       select 'Supplier credit note', n.id::text, n.credit_note_date::text, c.name, n.total::text, 'supplier-credit-notes'
         from supplier_credit_notes n join contacts c on c.id = n.contact_id where n.status = 'draft' and n.credit_note_date <= $2 and ($1::date is null or n.credit_note_date >= $1)
       union all
       select case when e.status = 'draft' then 'Expense claim' else 'Expense claim (submitted)' end, e.id::text, e.claim_date::text, e.claimant_email, e.total::text, 'expense-claims'
         from expense_claims e where e.status in ('draft', 'submitted') and e.claim_date <= $2 and ($1::date is null or e.claim_date >= $1)
     ) d order by date, kind, id::bigint`,
    [from, periodEnd],
  );
  if (drafts.rows.length === 0) return pass("drafts", title, "No draft invoices, credit notes, bills, supplier credit notes or expense claims are dated in the period.");
  return {
    key: "drafts",
    title,
    status: "warning",
    summary: `${drafts.rows.length} ${drafts.rows.length === 1 ? "draft is" : "drafts are"} dated in the period: approve or delete ${drafts.rows.length === 1 ? "it" : "them"}, or change the date.`,
    items: drafts.rows.map((row) => ({
      label: `${row.kind}, ${longDate(row.date)}`,
      detail: `${row.who}, ${money(row.total)}`,
      href: `/operations/${row.path}/${row.id}`,
    })),
    fix: null,
  };
}

async function depreciationCheck(tx: OrgTx, periodEnd: string, money: (value: string) => string): Promise<PeriodCheck> {
  const title = "Depreciation run to the period end";
  const fix = { href: "/operations/fixed-assets/depreciation", label: "Run depreciation" };
  const assets = await tx.query<{ count: string }>("select count(*)::text as count from fixed_assets where status = 'registered' and purchase_date <= $1", [periodEnd]);
  if (assets.rows[0].count === "0") return notApplicable("depreciation", title, `No fixed assets were registered on ${longDate(periodEnd)}.`);
  const last = (await tx.query<{ period_end: string | null }>("select max(period_end)::text as period_end from fixed_asset_depreciation_runs where status = 'active'")).rows[0].period_end;
  if (last !== null && last >= periodEnd) return pass("depreciation", title, `Depreciation has been run to ${longDate(last)}.`);
  const preview = await previewDepreciationRun(tx, periodEnd);
  if (preview.lines.length === 0 || isZero(dec(preview.total))) {
    return pass("depreciation", title, `There's no depreciation to charge to ${longDate(periodEnd)}.`);
  }
  return {
    key: "depreciation",
    title,
    status: "warning",
    summary: `Depreciation of ${money(preview.total)} to ${longDate(periodEnd)} hasn't been run (${last ? `last run to ${longDate(last)}` : "never run"}).`,
    items: [],
    fix,
  };
}

async function fxCheck(tx: OrgTx, periodEnd: string): Promise<PeriodCheck> {
  const title = "Foreign-currency balances revalued";
  const accounts = await tx.query<{ id: string; code: string; name: string; currency_code: string; revalued: boolean }>(
    `select a.id::text, a.code, a.name, a.currency_code,
            exists (select 1 from ledger_fx_revaluation_run_items i join ledger_fx_revaluation_runs r on r.id = i.run_id
                     where i.account_id = a.id and r.revaluation_date = $1) as revalued
       from accounts a where a.currency_code is not null and a.currency_code <> $2 order by a.code`,
    [periodEnd, tx.baseCurrency],
  );
  const needing: typeof accounts.rows = [];
  for (const account of accounts.rows) {
    const state = await foreignAccountState(tx, account.id, periodEnd);
    const hasBalance = !isZero(dec(state.baseBalance)) || (state.foreignBalance !== null && !isZero(dec(state.foreignBalance)));
    if (hasBalance) needing.push(account);
  }
  if (needing.length === 0) return notApplicable("fx_revaluation", title, `No foreign-currency account has a balance on ${longDate(periodEnd)}.`);
  const missing = needing.filter((account) => !account.revalued);
  if (missing.length === 0) return pass("fx_revaluation", title, `Revalued on ${longDate(periodEnd)}.`);
  return {
    key: "fx_revaluation",
    title,
    status: "warning",
    summary: `${missing.length} foreign-currency ${missing.length === 1 ? "account hasn't" : "accounts haven't"} been revalued on ${longDate(periodEnd)}.`,
    items: missing.map((account) => ({ label: `${account.code} ${account.name}`, detail: `${account.currency_code} balance not revalued at ${longDate(periodEnd)}.`, href: null })),
    fix: { href: "/operations/fx-revaluation", label: "FX revaluation" },
  };
}

async function stockChecks(tx: OrgTx, periodEnd: string, money: (value: string) => string): Promise<PeriodCheck[]> {
  const stockTitle = "Stock equals the inventory account";
  const negativeTitle = "No stock below zero";
  const moved = await tx.query<{ value: string; count: string }>(
    "select coalesce(sum(value_delta), 0)::text as value, count(*)::text as count from inventory_movements where movement_date <= $1",
    [periodEnd],
  );
  const account = await systemAccountBalance(tx, "inventory", periodEnd);
  const stockValue = moved.rows[0].value;
  if (moved.rows[0].count === "0" && (!account || isZero(dec(account.balance)))) {
    return [
      notApplicable("stock", stockTitle, `No stock on or before ${longDate(periodEnd)}.`),
      notApplicable("negative_stock", negativeTitle, `No stock on or before ${longDate(periodEnd)}.`),
    ];
  }
  const checks: PeriodCheck[] = [];
  const ledger = account?.balance ?? "0";
  const difference = sub(dec(stockValue), dec(ledger));
  checks.push(
    isZero(difference)
      ? pass("stock", stockTitle, `Stock on hand ${money(stockValue)} equals ${account?.code ?? "the inventory account"} at ${longDate(periodEnd)}.`)
      : {
          key: "stock",
          title: stockTitle,
          status: "warning",
          summary: `Stock on hand ${money(stockValue)} but ${account?.code ?? "the inventory account"} ${money(ledger)} at ${longDate(periodEnd)} (difference ${money(toFixedString(difference, 2))}).`,
          items: [],
          fix: { href: "/operations/reports?report=stock", label: "Stock valuation" },
        },
  );
  const below = await tx.query<{ item_code: string; location: string | null; quantity: string }>(
    `select m.item_code, v.name as location, sum(m.quantity_delta)::text as quantity
       from inventory_movements m left join tracking_values v on v.id = m.location_value_id
      where m.movement_date <= $1
      group by m.item_code, m.location_value_id, v.name
     having sum(m.quantity_delta) < 0
      order by m.item_code, v.name nulls first`,
    [periodEnd],
  );
  checks.push(
    below.rows.length === 0
      ? pass("negative_stock", negativeTitle, `Nothing was below zero on ${longDate(periodEnd)}.`)
      : {
          key: "negative_stock",
          title: negativeTitle,
          status: "warning",
          summary: `${below.rows.length} ${below.rows.length === 1 ? "item was" : "items were"} below zero on ${longDate(periodEnd)}: sales were costed before the stock came in.`,
          items: below.rows.map((row) => ({ label: row.location ? `${row.item_code} at ${row.location}` : row.item_code, detail: `${row.quantity} on hand`, href: null })),
          fix: { href: "/operations/inventory", label: "Stock" },
        },
  );
  return checks;
}

async function ledgerCheck(
  tx: OrgTx,
  key: "receivables" | "payables",
  periodEnd: string,
  money: (value: string) => string,
): Promise<PeriodCheck> {
  const title = key === "receivables" ? "Receivables equal accounts receivable" : "Payables equal accounts payable";
  const account = await systemAccountBalance(tx, key === "receivables" ? "accounts_receivable" : "accounts_payable", periodEnd);
  if (!account) return notApplicable(key, title, "There's no control account.");
  const documents = key === "receivables" ? (await agedReceivables(tx, { asAt: periodEnd })).total.total : (await agedPayables(tx, { asAt: periodEnd })).total.total;
  const ledger = key === "receivables" ? account.balance : toFixedString(neg(dec(account.balance)), 2);
  const difference = sub(dec(documents), dec(ledger));
  const report = key === "receivables" ? "Aged receivables" : "Aged payables";
  if (isZero(difference)) {
    return pass(key, title, `${report} ${money(documents)} equals ${account.code} ${account.name} at ${longDate(periodEnd)}.`);
  }
  return {
    key,
    title,
    status: "warning",
    summary: `${report} ${money(documents)} but ${account.code} ${account.name} ${money(ledger)} at ${longDate(periodEnd)} (difference ${money(toFixedString(difference, 2))}): something was posted to the control account directly.`,
    items: [],
    fix: { href: `/operations/reports?report=transactions&account=${account.id}&to=${periodEnd}`, label: `${account.code} transactions` },
  };
}

/**
 * Every GST period after the latest filed return that ends by the month end
 * must be filed. The periods come from the GST period setting (GP5); without
 * one, each is the same length as the latest filed return (PC8).
 */
async function gstCheck(tx: OrgTx, periodEnd: string): Promise<PeriodCheck> {
  const title = "GST returns filed";
  const fix = { href: "/operations/gst-return", label: "GST return" };
  const last = await latestFiledGstPeriod(tx);
  const setting = await loadGstPeriodSetting(tx);
  if (!last) {
    const registered = (await tx.query<{ gst_number: string | null }>("select gst_number from organisation_settings where id = true")).rows[0].gst_number;
    if (!registered) return notApplicable("gst", title, "No GST number is set and no GST return has been filed in Tohyee.");
    return {
      key: "gst",
      title,
      status: "warning",
      summary: "No GST return has been filed in Tohyee yet, so it can't tell which GST periods end by then. File the latest one.",
      items: [],
      fix,
    };
  }
  const unfiled: CheckItem[] = [];
  for (let next = gstPeriodAfter(setting, last); next.periodEnd <= periodEnd; next = gstPeriodAfter(setting, next)) {
    unfiled.push({ label: `${longDate(next.periodStart)} to ${longDate(next.periodEnd)}`, detail: "Not filed yet.", href: "/operations/gst-return" });
  }
  const basis = setting ? `GST period setting: ${describeGstPeriodSetting(setting)}.` : "No GST period setting, so each period is as long as the latest filed return (set it in Settings).";
  if (unfiled.length === 0) return pass("gst", title, `Filed to ${longDate(last.periodEnd)}. ${basis}`);
  return {
    key: "gst",
    title,
    status: "warning",
    summary: `${unfiled.length} GST ${unfiled.length === 1 ? "return ends" : "returns end"} by ${longDate(periodEnd)} and ${unfiled.length === 1 ? "isn't" : "aren't"} filed. ${basis}`,
    items: unfiled,
    fix,
  };
}

async function openingBalanceCheck(tx: OrgTx, periodEnd: string, money: (value: string) => string): Promise<PeriodCheck> {
  const title = "Opening balance account at 0.00";
  const account = await systemAccountBalance(tx, "conversion_clearing", periodEnd);
  if (!account) return notApplicable("opening_balance", title, "There's no opening balance account.");
  if (isZero(dec(account.balance))) return pass("opening_balance", title, `${account.code} ${account.name} is 0.00 at ${longDate(periodEnd)}.`);
  const balance = dec(account.balance);
  return {
    key: "opening_balance",
    title,
    status: "warning",
    summary: `${account.code} ${account.name} is ${money(toFixedString(isNegative(balance) ? neg(balance) : balance, 2))} ${isNegative(balance) ? "Cr" : "Dr"} at ${longDate(periodEnd)}: opening balances don't add up yet.`,
    items: [],
    fix: { href: `/operations/reports?report=transactions&account=${account.id}&to=${periodEnd}`, label: `${account.code} transactions` },
  };
}

/**
 * The checklist for closing the month ending `periodEnd` (PC2-PC9). It posts
 * nothing; every check is worked out from the books when it runs.
 */
export async function periodChecklist(tx: OrgTx, input: { periodEnd: unknown }): Promise<PeriodChecklist> {
  const periodEnd = parsePeriodEnd(input.periodEnd);
  const { lockDate } = await getPeriodControls(tx);
  const from = lockDate !== null && lockDate < periodEnd ? addDays(lockDate, 1) : lockDate === null ? null : monthStartOf(periodEnd);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: string) => formatMoney(toFixedString(dec(value), scale), scale);
  const checks: PeriodCheck[] = [
    await bankCheck(tx, periodEnd, money),
    await draftsCheck(tx, from, periodEnd, money),
    await depreciationCheck(tx, periodEnd, money),
    await fxCheck(tx, periodEnd),
    ...(await stockChecks(tx, periodEnd, money)),
    await ledgerCheck(tx, "receivables", periodEnd, money),
    await ledgerCheck(tx, "payables", periodEnd, money),
    await gstCheck(tx, periodEnd),
    await openingBalanceCheck(tx, periodEnd, money),
  ];
  return {
    periodEnd,
    label: monthLabel(periodEnd),
    from,
    status: statusOf({ start: monthStartOf(periodEnd), end: periodEnd }, lockDate),
    checks,
    warnings: checks.filter((check) => check.status === "warning").length,
  };
}

export type CloseResult = { changed: boolean; controls: PeriodControls; checklist: PeriodChecklist | null };

/**
 * Closes the month ending `periodEnd` (PC10, PC11): the lock date moves to
 * it, so nothing dated on or before it can be posted. Earlier months with
 * postings must be closed first. With every check passing a bookkeeper can
 * close; with warnings only an owner or admin can, after confirming
 * (`acknowledgeWarnings`), and the warnings they accepted are in the audit
 * log. Closing an already closed month changes nothing.
 */
export async function closePeriod(tx: OrgTx, role: Role, input: { periodEnd: unknown; acknowledgeWarnings?: unknown }): Promise<CloseResult> {
  const periodEnd = parsePeriodEnd(input.periodEnd);
  const current = await getPeriodControls(tx, { forUpdate: true });
  if (current.lockDate !== null && current.lockDate >= periodEnd) {
    return { changed: false, controls: current, checklist: null };
  }
  const openPosting = await firstOpenPosting(tx, current.lockDate);
  if (openPosting !== null && openPosting < monthStartOf(periodEnd)) {
    throw new ValidationError(`Close ${monthLabel(openPosting)} first: it has postings and is still open. Months are closed in order.`);
  }
  const checklist = await periodChecklist(tx, { periodEnd });
  const warnings = checklist.checks.filter((check) => check.status === "warning");
  if (warnings.length > 0) {
    const list = warnings.map((check) => check.title.toLowerCase()).join("; ");
    if (!roleAtLeast(role, "admin")) {
      throw new ForbiddenError(`${monthLabel(periodEnd)} has ${warnings.length} ${warnings.length === 1 ? "check" : "checks"} that need attention (${list}). Fix ${warnings.length === 1 ? "it" : "them"}, or ask an owner or admin to close it anyway.`);
    }
    if (input.acknowledgeWarnings !== true) {
      throw new ValidationError(`${monthLabel(periodEnd)} has ${warnings.length} ${warnings.length === 1 ? "check" : "checks"} that need attention (${list}). Confirm to close it anyway.`);
    }
  }
  const yearEndMonth = await financialYearEndMonth(tx);
  const controls = await setLockDate(tx, current, periodEnd, {
    eventType: "ledger.period_closed",
    details: {
      periodEnd,
      financialYearClosed: financialYearEnd(periodEnd, yearEndMonth) === periodEnd,
      warningsAccepted: warnings.map((check) => ({ key: check.key, title: check.title, summary: check.summary })),
    },
  });
  return { changed: true, controls, checklist };
}

/**
 * Reopens the month ending `periodEnd` (owners and admins, with a reason;
 * PC12): the lock date moves to the day before it starts, so every later
 * closed month reopens too, as in NetSuite. Reopening an open month changes
 * nothing.
 */
export async function reopenPeriod(tx: OrgTx, role: Role, input: { periodEnd: unknown; reason: unknown }): Promise<CloseResult> {
  if (!roleAtLeast(role, "admin")) {
    throw new ForbiddenError("Only an owner or admin can reopen a period.");
  }
  const periodEnd = parsePeriodEnd(input.periodEnd);
  const reason = requireString(input.reason, "reason", { maxLength: 500 });
  const current = await getPeriodControls(tx, { forUpdate: true });
  const start = monthStartOf(periodEnd);
  if (current.lockDate === null || current.lockDate < start) {
    return { changed: false, controls: current, checklist: null };
  }
  const controls = await setLockDate(tx, current, addDays(start, -1), { eventType: "ledger.period_reopened", details: { periodEnd, reason } });
  return { changed: true, controls, checklist: null };
}

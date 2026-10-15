import { writeAuditEvent } from "@/lib/audit";
import type { AccountType } from "@/lib/accounts/types";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addDays, financialYearEnd, financialYearStart } from "@/lib/financial-year";
import { add, cmp, dec, type Decimal, divide, isZero, mul, neg, roundHalfUp, sub, toFixedString } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { financialYearEndMonth } from "@/lib/reports/financial";
import {
  ASSET_CATEGORIES,
  CATEGORIES_BY_CLASS,
  ENTITY_FIELDS,
  EQUITY_CATEGORIES,
  EXPENSE_CATEGORIES,
  LIABILITY_CATEGORIES,
  OPERATING_CASH_CATEGORIES,
  OTHER_RECEIPT_KEYS,
  REPORT_FORMATS,
  type ReportFormat,
  REVENUE_CATEGORIES,
} from "@/lib/reports/performance-categories";
import { optionalString, requireArray, requireOneOf, requireString } from "@/lib/validation";

/*
 * Tier 3 and Tier 4 not-for-profit performance reports (examples NPR1-NPR10,
 * decision 536). Every account is put in one of XRB's minimum categories
 * (chosen, or suggested from its type); the statements total the books by
 * category, and the cash statements put each movement in cash in the
 * category of what it was for. See docs/ACCOUNTING-EXAMPLES.md.
 */

// ---------------------------------------------------------------------------
// Settings: the format and the entity information

export type EntityInformation = Record<string, string>;
export type PerformanceSettings = { format: ReportFormat; entity: EntityInformation; notForProfit: boolean };

export async function getPerformanceSettings(tx: OrgTx): Promise<PerformanceSettings> {
  const row = (await tx.query<{ format: ReportFormat; entity: EntityInformation }>("select format, entity from performance_report_settings where id = 1")).rows[0];
  const organisation = await getOrganisationSettings(tx);
  return { format: row?.format ?? "special_purpose", entity: row?.entity ?? {}, notForProfit: organisation.notForProfitEnabled };
}

export async function savePerformanceSettings(tx: OrgTx, input: { format?: unknown; entity?: unknown }): Promise<PerformanceSettings> {
  const current = await getPerformanceSettings(tx);
  const format = input.format === undefined ? current.format : requireOneOf(input.format, "format", REPORT_FORMATS);
  let entity = current.entity;
  if (input.entity !== undefined) {
    const raw = (input.entity ?? {}) as Record<string, unknown>;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("entity must be an object.");
    entity = {};
    for (const field of ENTITY_FIELDS) {
      const value = optionalString(raw[field.key], field.label, { maxLength: field.long ? 2000 : 200 });
      if (value) entity[field.key] = value;
    }
  }
  await tx.query(
    `insert into performance_report_settings (id, format, entity, updated_by_email) values (1, $1, $2::jsonb, $3)
     on conflict (id) do update set format = excluded.format, entity = excluded.entity, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [format, JSON.stringify(entity), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "reports.performance_settings_saved", entityType: "organisation", entityId: tx.organisationId, details: { format, from: current.format } });
  return getPerformanceSettings(tx);
}

// ---------------------------------------------------------------------------
// Categories

type AccountRow = { id: string; code: string; name: string; account_class: string; account_type: AccountType; system_key: string | null; is_active: boolean };

const PAYROLL_PAYABLES = new Set(["paye_payable", "kiwisaver_payable", "esct_payable", "student_loan_payable", "wages_payable", "payroll_deductions_payable"]);

/** The category Tohyee suggests from an account's type (NPR "Categories"). */
export function suggestedCategory(account: { account_class: string; account_type: AccountType; system_key: string | null }): string {
  switch (account.account_type) {
    case "revenue":
    case "other_income":
      return "rev_other";
    case "direct_costs":
    case "expense":
    case "depreciation":
      return "exp_other";
    case "bank":
    case "credit_card":
      return "as_cash";
    case "inventory":
      return "as_inventory";
    case "fixed_asset":
      return "as_ppe";
    case "non_current_asset":
      return "as_other";
    case "current_asset":
      return "as_debtors";
    case "current_liability":
      return account.system_key && PAYROLL_PAYABLES.has(account.system_key) ? "li_employee" : "li_creditors";
    case "non_current_liability":
      return "li_loans";
    default:
      return "eq_accumulated";
  }
}

export type AccountCategory = {
  accountId: string;
  code: string;
  name: string;
  accountClass: string;
  accountType: AccountType;
  category: string;
  /** True when it's Tohyee's suggestion rather than a choice. */
  suggested: boolean;
  /** Balance sheet accounts: the operating category their cash goes to, or null. */
  cashCategory: string | null;
};

async function accountsWithCategories(tx: OrgTx): Promise<Array<AccountRow & { category: string; suggested: boolean; cash_category: string | null }>> {
  const rows = await tx.query<AccountRow & { chosen: string | null; cash_category: string | null }>(
    `select a.id::text, a.code, a.name, a.account_class, a.account_type, a.system_key, a.is_active, c.category as chosen, c.cash_category
       from accounts a left join performance_report_categories c on c.account_id = a.id
      order by a.code`,
  );
  return rows.rows.map((row) => {
    // A credit card counts as cash (NPR7), so its "cash" category is cash even though it's a liability.
    const suggestion = row.account_type === "credit_card" ? "li_overdraft" : suggestedCategory(row);
    return { ...row, category: row.chosen ?? suggestion, suggested: row.chosen === null };
  });
}

export async function listAccountCategories(tx: OrgTx): Promise<AccountCategory[]> {
  const rows = await accountsWithCategories(tx);
  return rows
    .filter((row) => row.is_active || !row.suggested)
    .map((row) => ({
      accountId: row.id,
      code: row.code,
      name: row.name,
      accountClass: row.account_class,
      accountType: row.account_type,
      category: row.category,
      suggested: row.suggested,
      cashCategory: row.cash_category,
    }));
}

/** Chooses an account's category (and, for a balance sheet account, its cash's operating category). `category` null goes back to the suggestion. */
export async function setAccountCategory(tx: OrgTx, input: { accountCode: unknown; category: unknown; cashCategory?: unknown }): Promise<AccountCategory[]> {
  const code = requireString(input.accountCode, "The account", { maxLength: 20 });
  const account = (await tx.query<AccountRow>("select id::text, code, name, account_class, account_type, system_key, is_active from accounts where lower(code) = lower($1)", [code])).rows[0];
  if (!account) throw new NotFoundError(`There's no account ${code}.`);
  if (input.category === null || input.category === "") {
    await tx.query("delete from performance_report_categories where account_id = $1", [account.id]);
  } else {
    const allowed = (account.account_type === "credit_card" ? [...LIABILITY_CATEGORIES, ...ASSET_CATEGORIES] : CATEGORIES_BY_CLASS[account.account_class]).map((entry) => entry.key);
    const category = requireOneOf(input.category, "category", allowed);
    const balanceSheet = ["asset", "liability", "equity"].includes(account.account_class);
    const cashCategory =
      input.cashCategory === undefined || input.cashCategory === null || input.cashCategory === ""
        ? null
        : balanceSheet
          ? requireOneOf(input.cashCategory, "cashCategory", OPERATING_CASH_CATEGORIES.map((entry) => entry.key))
          : (() => {
              throw new ValidationError("Only balance sheet accounts take a cash category; revenue and expenses use their own.");
            })();
    await tx.query(
      `insert into performance_report_categories (account_id, category, cash_category, updated_by_email) values ($1, $2, $3, $4)
       on conflict (account_id) do update set category = excluded.category, cash_category = excluded.cash_category, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [account.id, category, cashCategory, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: "reports.performance_category_set", entityType: "account", entityId: account.id, details: { category: input.category ?? null, cashCategory: input.cashCategory ?? null } });
  return listAccountCategories(tx);
}

// ---------------------------------------------------------------------------
// Service performance

export type ServiceMeasure = { label: string; current: string; prior: string };
export type ServiceActivity = { name: string; description: string; measures: ServiceMeasure[] };

export async function getServicePerformance(tx: OrgTx, yearEndInput: unknown): Promise<{ yearEnd: string; activities: ServiceActivity[]; saved: boolean }> {
  const yearEnd = await checkedYearEnd(tx, yearEndInput);
  const row = (await tx.query<{ activities: ServiceActivity[] }>("select activities from service_performance where year_end = $1", [yearEnd])).rows[0];
  return { yearEnd, activities: row?.activities ?? [], saved: Boolean(row) };
}

export async function saveServicePerformance(tx: OrgTx, input: { yearEnd: unknown; activities: unknown }) {
  const yearEnd = await checkedYearEnd(tx, input.yearEnd);
  const activities = requireArray(input.activities, "activities", 50).map((raw, index): ServiceActivity => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const label = `Activity ${index + 1}`;
    return {
      name: requireString(entry.name, `${label}'s name`, { maxLength: 200 }),
      description: optionalString(entry.description, `${label}'s description`, { maxLength: 4000 }) ?? "",
      measures: requireArray(entry.measures ?? [], `${label}'s measures`, 30).map((m, measureIndex) => {
        const measure = (m ?? {}) as Record<string, unknown>;
        return {
          label: requireString(measure.label, `${label}, measure ${measureIndex + 1}`, { maxLength: 300 }),
          current: optionalString(measure.current, "This year", { maxLength: 100 }) ?? "",
          prior: optionalString(measure.prior, "Last year", { maxLength: 100 }) ?? "",
        };
      }),
    };
  });
  if (activities.length === 0) {
    await tx.query("delete from service_performance where year_end = $1", [yearEnd]);
  } else {
    await tx.query(
      `insert into service_performance (year_end, activities, updated_by_email) values ($1, $2::jsonb, $3)
       on conflict (year_end) do update set activities = excluded.activities, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [yearEnd, JSON.stringify(activities), tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: "reports.service_performance_saved", entityType: "organisation", entityId: tx.organisationId, details: { yearEnd, activities: activities.length } });
  return getServicePerformance(tx, yearEnd);
}

async function checkedYearEnd(tx: OrgTx, input: unknown): Promise<string> {
  const yearEnd = parseIsoDate(input, "The year end");
  if (financialYearEnd(yearEnd, await financialYearEndMonth(tx)) !== yearEnd) throw new ValidationError("That isn't a financial year end.");
  return yearEnd;
}

// ---------------------------------------------------------------------------
// The figures

const ZERO = dec("0");
const cents = (value: Decimal) => toFixedString(roundHalfUp(value, 2), 2);
type Totals = Map<string, Decimal>;
const bump = (totals: Totals, key: string, amount: Decimal) => totals.set(key, add(totals.get(key) ?? ZERO, amount));

export type CategoryAmount = { key: string; amount: string };

export type CashFigures = {
  opening: string;
  closing: string;
  /** Operating receipts by revenue category (positive is cash in). */
  receipts: CategoryAmount[];
  /** Operating payments by expense category (positive is cash out). */
  payments: CategoryAmount[];
  /** Net GST received, or paid when negative; zero when not registered. */
  gst: string;
  /** Other activities: receipts positive, payments positive under their own keys. */
  otherReceipts: CategoryAmount[];
  otherPayments: CategoryAmount[];
  /** Closing balance by cash account (Tier 4's "represented by"). */
  accounts: Array<{ code: string; name: string; amount: string }>;
};

export type YearFigures = {
  from: string;
  to: string;
  revenue: CategoryAmount[];
  expenses: CategoryAmount[];
  surplus: string;
  assets: { current: CategoryAmount[]; nonCurrent: CategoryAmount[]; total: string };
  liabilities: { current: CategoryAmount[]; nonCurrent: CategoryAmount[]; total: string };
  equity: CategoryAmount[];
  netAssets: string;
  cash: CashFigures;
  /** Balance sheet accounts other than cash with a balance (Tier 4 notes, NPR5). */
  significantAssets: Array<{ code: string; name: string; amount: string }>;
  significantLiabilities: Array<{ code: string; name: string; amount: string }>;
};

const CURRENT_TYPES = new Set(["bank", "current_asset", "inventory", "current_liability", "credit_card"]);

function ordered(totals: Totals, order: Array<{ key: string }>, negate = false): CategoryAmount[] {
  return order
    .filter((entry) => totals.has(entry.key) && !isZero(roundHalfUp(totals.get(entry.key)!, 2)))
    .map((entry) => ({ key: entry.key, amount: cents(negate ? neg(totals.get(entry.key)!) : totals.get(entry.key)!) }));
}

const sumOf = (rows: CategoryAmount[]) => rows.reduce((total, row) => add(total, dec(row.amount)), ZERO);

/** The year's figures by category (NPR1-NPR5). */
export async function yearFigures(tx: OrgTx, from: string, to: string): Promise<YearFigures> {
  const accounts = await accountsWithCategories(tx);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const balances = await tx.query<{ account_id: string; period: string; to_date: string }>(
    `select l.account_id::text,
            coalesce(sum(case when j.posting_date >= $1 then l.debit_amount - l.credit_amount else 0 end), 0)::text as period,
            coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as to_date
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
      where j.posting_date <= $2
      group by l.account_id`,
    [from, to],
  );
  const revenue: Totals = new Map();
  const expenses: Totals = new Map();
  const assetsCurrent: Totals = new Map();
  const assetsNon: Totals = new Map();
  const liabCurrent: Totals = new Map();
  const liabNon: Totals = new Map();
  const equity: Totals = new Map();
  const significantAssets: YearFigures["significantAssets"] = [];
  const significantLiabilities: YearFigures["significantLiabilities"] = [];
  let surplus = ZERO;
  let earlierResults = ZERO;
  for (const row of balances.rows) {
    const account = byId.get(row.account_id);
    if (!account) continue;
    const period = dec(row.period);
    const toDate = dec(row.to_date);
    if (account.account_class === "revenue" || account.account_class === "expense") {
      // Debit-positive: revenue is negative. Earlier years' results are accumulated surpluses.
      earlierResults = add(earlierResults, sub(toDate, period));
      surplus = sub(surplus, period);
      if (account.account_class === "revenue") bump(revenue, account.category, neg(period));
      else bump(expenses, account.category, period);
      continue;
    }
    if (isZero(toDate)) continue;
    const current = CURRENT_TYPES.has(account.account_type);
    const isCash = account.category === "as_cash" || account.category === "li_overdraft";
    if (account.account_class === "asset" || (account.account_type === "credit_card" && account.category.startsWith("as_"))) {
      bump(current ? assetsCurrent : assetsNon, account.category, toDate);
      if (!isCash) significantAssets.push({ code: account.code, name: account.name, amount: cents(toDate) });
    } else if (account.account_class === "liability") {
      bump(current ? liabCurrent : liabNon, account.category, neg(toDate));
      if (!isCash) significantLiabilities.push({ code: account.code, name: account.name, amount: cents(neg(toDate)) });
    } else {
      bump(equity, account.category, neg(toDate));
    }
  }
  significantAssets.sort((a, b) => a.code.localeCompare(b.code));
  significantLiabilities.sort((a, b) => a.code.localeCompare(b.code));
  bump(equity, "eq_accumulated", neg(earlierResults));
  bump(equity, "eq_accumulated", surplus);
  const assetOrder = ASSET_CATEGORIES;
  const liabilityOrder = LIABILITY_CATEGORIES;
  const assets = { current: ordered(assetsCurrent, assetOrder), nonCurrent: ordered(assetsNon, assetOrder), total: "0" };
  assets.total = cents(add(sumOf(assets.current), sumOf(assets.nonCurrent)));
  const liabilities = { current: ordered(liabCurrent, liabilityOrder), nonCurrent: ordered(liabNon, liabilityOrder), total: "0" };
  liabilities.total = cents(add(sumOf(liabilities.current), sumOf(liabilities.nonCurrent)));
  return {
    from,
    to,
    revenue: ordered(revenue, REVENUE_CATEGORIES),
    expenses: ordered(expenses, EXPENSE_CATEGORIES),
    surplus: cents(surplus),
    assets,
    liabilities,
    equity: ordered(equity, EQUITY_CATEGORIES),
    netAssets: cents(sub(dec(assets.total), dec(liabilities.total))),
    cash: await cashFigures(tx, accounts, from, to),
    significantAssets,
    significantLiabilities,
  };
}

type Line = { accountId: string; amount: Decimal };

/**
 * The year's cash by category (NPR3, NPR4, NPR6-NPR8). Each journal that
 * moves cash is split by what was on the other side: a customer or supplier
 * payment by the lines of the invoice or bill it paid, in proportion.
 */
async function cashFigures(tx: OrgTx, accounts: Awaited<ReturnType<typeof accountsWithCategories>>, from: string, to: string): Promise<CashFigures> {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const cashIds = accounts.filter((account) => account.category === "as_cash" || account.category === "li_overdraft").map((account) => account.id);
  const balances = await tx.query<{ account_id: string; opening: string; closing: string }>(
    `select l.account_id::text,
            coalesce(sum(case when j.posting_date < $1 then l.debit_amount - l.credit_amount else 0 end), 0)::text as opening,
            coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as closing
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
      where j.posting_date <= $2 and l.account_id = any($3::bigint[])
      group by l.account_id`,
    [from, to, cashIds],
  );
  let opening = ZERO;
  let closing = ZERO;
  const accountsOut: CashFigures["accounts"] = [];
  for (const row of balances.rows) {
    opening = add(opening, dec(row.opening));
    closing = add(closing, dec(row.closing));
    if (!isZero(dec(row.closing))) {
      const account = byId.get(row.account_id)!;
      accountsOut.push({ code: account.code, name: account.name, amount: cents(dec(row.closing)) });
    }
  }
  accountsOut.sort((a, b) => a.code.localeCompare(b.code));

  const lines = await tx.query<{ journal_id: string; account_id: string; amount: string }>(
    `select l.journal_id::text, l.account_id::text, (l.debit_amount - l.credit_amount)::text as amount
       from ledger_journal_lines l
      where l.journal_id in (
              select distinct x.journal_id from ledger_journal_lines x join ledger_journals j on j.id = x.journal_id
               where j.posting_date between $1 and $2 and x.account_id = any($3::bigint[]))
      order by l.journal_id, l.line_order`,
    [from, to, cashIds],
  );
  const journals = new Map<string, Line[]>();
  for (const row of lines.rows) {
    const list = journals.get(row.journal_id) ?? [];
    list.push({ accountId: row.account_id, amount: dec(row.amount) });
    journals.set(row.journal_id, list);
  }
  const ids = [...journals.keys()];
  // Payments and the documents they paid (NPR6): the payment's journal, its amount, and the document's journal.
  const paid = await tx.query<{ journal_id: string; amount: string; document_journal_id: string }>(
    `select p.journal_id::text, p.amount::text, i.approval_journal_id::text as document_journal_id
       from customer_payments p join sales_invoices i on i.id = p.invoice_id
      where p.journal_id = any($1::bigint[]) and i.approval_journal_id is not null
     union all
     select p.void_journal_id::text, p.amount::text, i.approval_journal_id::text
       from customer_payments p join sales_invoices i on i.id = p.invoice_id
      where p.void_journal_id = any($1::bigint[]) and i.approval_journal_id is not null
     union all
     select p.journal_id::text, p.amount::text, b.approval_journal_id::text
       from supplier_payments p join bills b on b.id = p.bill_id
      where p.journal_id = any($1::bigint[]) and b.approval_journal_id is not null
     union all
     select p.void_journal_id::text, p.amount::text, b.approval_journal_id::text
       from supplier_payments p join bills b on b.id = p.bill_id
      where p.void_journal_id = any($1::bigint[]) and b.approval_journal_id is not null`,
    [ids],
  );
  const paidBy = new Map<string, Array<{ amount: Decimal; documentJournalId: string }>>();
  for (const row of paid.rows) {
    const list = paidBy.get(row.journal_id) ?? [];
    list.push({ amount: dec(row.amount), documentJournalId: row.document_journal_id });
    paidBy.set(row.journal_id, list);
  }
  const documentIds = [...new Set(paid.rows.map((row) => row.document_journal_id))];
  const documentLines = new Map<string, Line[]>();
  if (documentIds.length > 0) {
    const rows = await tx.query<{ journal_id: string; account_id: string; amount: string }>(
      `select journal_id::text, account_id::text, (debit_amount - credit_amount)::text as amount from ledger_journal_lines where journal_id = any($1::bigint[]) order by journal_id, line_order`,
      [documentIds],
    );
    for (const row of rows.rows) {
      const list = documentLines.get(row.journal_id) ?? [];
      list.push({ accountId: row.account_id, amount: dec(row.amount) });
      documentLines.set(row.journal_id, list);
    }
  }

  const isControl = (accountId: string) => {
    const key = byId.get(accountId)?.system_key;
    return key === "accounts_receivable" || key === "accounts_payable";
  };
  const isCashAccount = (accountId: string) => cashIds.includes(accountId);

  /** A non-cash line as the cash it explains: debit-positive amount d means cash of -d. Returns category keys and cash amounts. */
  const classify = (accountId: string, cash: Decimal): string => {
    const account = byId.get(accountId)!;
    if (account.system_key === "gst") return "gst";
    if (account.system_key === "fixed_asset_disposal" || account.system_key === "fixed_asset_capital_gain") return "oa_sale_ppe";
    if (account.account_class === "revenue" || account.account_class === "expense") return account.category;
    if (account.cash_category) return account.cash_category;
    if (account.system_key && PAYROLL_PAYABLES.has(account.system_key)) return "exp_employees";
    const inward = cmp(cash, ZERO) > 0;
    switch (account.category) {
      case "li_employee":
        return "exp_employees";
      case "as_inventory":
        return "exp_commercial";
      case "as_ppe":
        return inward ? "oa_sale_ppe" : "oa_buy_ppe";
      case "as_investments":
        return inward ? "oa_sale_investments" : "oa_buy_investments";
      case "li_loans":
        return inward ? "oa_loans_received" : "oa_loans_repaid";
      case "eq_capital":
        return inward ? "oa_capital_received" : "oa_capital_distributed";
      default:
        return inward ? "rev_other" : "exp_other";
    }
  };

  const totals: Totals = new Map();
  for (const [journalId, journalLines] of journals) {
    const cashMove = journalLines.filter((line) => isCashAccount(line.accountId)).reduce((total, line) => add(total, line.amount), ZERO);
    if (isZero(cashMove)) continue;
    // The lines that explain the cash, as debit-positive amounts summing to -cashMove.
    let explaining: Line[] = [];
    for (const line of journalLines.filter((entry) => !isCashAccount(entry.accountId))) {
      const payments = paidBy.get(journalId);
      if (isControl(line.accountId) && payments && payments.length > 0) {
        const paymentTotal = payments.reduce((total, payment) => add(total, payment.amount), ZERO);
        for (const payment of payments) {
          const share = divide(mul(line.amount, payment.amount), paymentTotal, 10);
          const docLines = (documentLines.get(payment.documentJournalId) ?? []).filter((entry) => !isControl(entry.accountId));
          const docTotal = docLines.reduce((total, entry) => add(total, entry.amount), ZERO);
          if (isZero(docTotal)) {
            explaining.push({ accountId: line.accountId, amount: share });
            continue;
          }
          for (const docLine of docLines) explaining.push({ accountId: docLine.accountId, amount: divide(mul(docLine.amount, share), docTotal, 10) });
        }
      } else {
        explaining.push(line);
      }
    }
    explaining = explaining.filter((line) => !isZero(line.amount));
    // To the cent, with any rounding left on the largest line, so the journal's cash adds up exactly.
    const rounded = explaining.map((line) => ({ key: classify(line.accountId, neg(line.amount)), cash: roundHalfUp(neg(line.amount), 2) }));
    const residue = sub(cashMove, rounded.reduce((total, line) => add(total, line.cash), ZERO));
    if (!isZero(residue) && rounded.length > 0) {
      let largest = 0;
      rounded.forEach((line, index) => {
        if (cmp(abs(line.cash), abs(rounded[largest].cash)) > 0) largest = index;
      });
      rounded[largest].cash = add(rounded[largest].cash, residue);
    }
    for (const line of rounded) bump(totals, line.key, line.cash);
  }

  const receipts: Totals = new Map();
  const payments: Totals = new Map();
  const otherIn: Totals = new Map();
  const otherOut: Totals = new Map();
  let gst = ZERO;
  for (const [key, amount] of totals) {
    if (key === "gst") gst = add(gst, amount);
    else if (key.startsWith("rev_")) bump(receipts, key, amount);
    else if (key.startsWith("exp_")) bump(payments, key, neg(amount));
    else if (OTHER_RECEIPT_KEYS.includes(key)) bump(otherIn, key, amount);
    else bump(otherOut, key, neg(amount));
  }
  return {
    opening: cents(opening),
    closing: cents(closing),
    receipts: ordered(receipts, REVENUE_CATEGORIES),
    payments: ordered(payments, EXPENSE_CATEGORIES),
    gst: cents(gst),
    otherReceipts: ordered(otherIn, OTHER_RECEIPTS_ORDER),
    otherPayments: ordered(otherOut, OTHER_PAYMENTS_ORDER),
    accounts: accountsOut,
  };
}

const abs = (value: Decimal) => (cmp(value, ZERO) < 0 ? neg(value) : value);
const OTHER_RECEIPTS_ORDER = [{ key: "oa_sale_ppe" }, { key: "oa_sale_investments" }, { key: "oa_loans_received" }, { key: "oa_capital_received" }];
const OTHER_PAYMENTS_ORDER = [{ key: "oa_buy_ppe" }, { key: "oa_buy_investments" }, { key: "oa_loans_repaid" }, { key: "oa_capital_distributed" }];

/** This year's and last year's figures for a year end. */
export async function performanceFigures(tx: OrgTx, yearEndInput: unknown): Promise<{ yearEnd: string; current: YearFigures; prior: YearFigures }> {
  const yearEnd = await checkedYearEnd(tx, yearEndInput);
  const month = await financialYearEndMonth(tx);
  const from = financialYearStart(yearEnd, month);
  const priorEnd = addDays(from, -1);
  return { yearEnd, current: await yearFigures(tx, from, yearEnd), prior: await yearFigures(tx, financialYearStart(priorEnd, month), priorEnd) };
}

/** How many accounts with activity are still on Tohyee's suggested category (shown on the screen). */
export async function suggestedCount(tx: OrgTx): Promise<number> {
  const rows = await accountsWithCategories(tx);
  const used = await tx.query<{ account_id: string }>("select distinct account_id::text from ledger_journal_lines");
  const usedIds = new Set(used.rows.map((row) => row.account_id));
  return rows.filter((row) => row.suggested && usedIds.has(row.id)).length;
}

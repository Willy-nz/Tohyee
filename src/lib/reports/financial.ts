import {
  ACCOUNT_TYPES,
  type AccountClass,
  type AccountType,
  isDebitNormal,
} from "@/lib/accounts/types";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { financialYearStart } from "@/lib/financial-year";
import { currencyMinorUnits } from "@/lib/money/currency";
import {
  add,
  cmp,
  dec,
  type Decimal,
  divide,
  isNegative,
  isZero,
  neg,
  sub,
  toFixedString,
  toPlainString,
  ZERO_DECIMAL,
} from "@/lib/money/decimal";

type Money = (value: Decimal) => string;

/** Formats report amounts with the base currency's minor units, e.g. "1250.00". */
function moneyFormatter(tx: OrgTx): Money {
  const scale = currencyMinorUnits(tx.baseCurrency);
  return (value) => toFixedString(value, scale);
}

type AccountTotalsRow = {
  id: string;
  code: string;
  name: string;
  account_class: AccountClass;
  account_type: AccountType;
  debits: string;
  credits: string;
};

async function financialYearEndMonth(tx: OrgTx): Promise<number> {
  const result = await tx.query<{ financial_year_end_month: number }>(
    "select financial_year_end_month from organisation_settings where id = true",
  );
  return result.rows[0].financial_year_end_month;
}

async function accountTotals(tx: OrgTx, from: string | null, to: string): Promise<AccountTotalsRow[]> {
  const result = await tx.query<AccountTotalsRow>(
    `select a.id, a.code, a.name, a.account_class, a.account_type,
            coalesce(sum(l.debit_amount), 0)::text as debits,
            coalesce(sum(l.credit_amount), 0)::text as credits
       from accounts a
       join ledger_journal_lines l on l.account_id = a.id
       join ledger_journals j on j.id = l.journal_id
      where j.posting_date <= $2
        and ($1::date is null or j.posting_date >= $1)
      group by a.id
      order by a.code`,
    [from, to],
  );
  return result.rows;
}

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  accountClass: AccountClass;
  accountType: AccountType;
  debit: string;
  credit: string;
};

/** Every account's net balance as at a date, in debit or credit column. */
export async function trialBalance(tx: OrgTx, input: { asAt?: unknown }) {
  const asAt = parseOptionalIsoDate(input.asAt, "asAt") ?? todayIsoDate();
  const money = moneyFormatter(tx);
  const rows: TrialBalanceRow[] = [];
  let totalDebit = ZERO_DECIMAL;
  let totalCredit = ZERO_DECIMAL;
  for (const row of await accountTotals(tx, null, asAt)) {
    const net = sub(dec(row.debits), dec(row.credits));
    if (isZero(net)) continue;
    const debit = isNegative(net) ? ZERO_DECIMAL : net;
    const credit = isNegative(net) ? neg(net) : ZERO_DECIMAL;
    totalDebit = add(totalDebit, debit);
    totalCredit = add(totalCredit, credit);
    rows.push({
      accountId: row.id,
      code: row.code,
      name: row.name,
      accountClass: row.account_class,
      accountType: row.account_type,
      debit: money(debit),
      credit: money(credit),
    });
  }
  return {
    asAt,
    currencyCode: tx.baseCurrency,
    rows,
    totalDebit: money(totalDebit),
    totalCredit: money(totalCredit),
    balanced: cmp(totalDebit, totalCredit) === 0,
  };
}

type ReportLine = { accountId: string; code: string; name: string; amount: string };
type ReportSection = { key: string; label: string; lines: ReportLine[]; total: string };

/** Balance in the account's natural direction (credits for income, debits for costs). */
function naturalAmount(row: AccountTotalsRow): Decimal {
  const net = sub(dec(row.debits), dec(row.credits));
  return isDebitNormal(row.account_class) ? net : neg(net);
}

function buildSections(
  rows: AccountTotalsRow[],
  types: readonly AccountType[],
  money: Money,
): { sections: ReportSection[]; total: Decimal } {
  let grand = ZERO_DECIMAL;
  const sections: ReportSection[] = [];
  for (const type of types) {
    const lines = rows
      .filter((row) => row.account_type === type)
      .map((row) => ({ row, amount: naturalAmount(row) }))
      .filter(({ amount }) => !isZero(amount));
    if (lines.length === 0) continue;
    let total = ZERO_DECIMAL;
    for (const { amount } of lines) total = add(total, amount);
    grand = add(grand, total);
    sections.push({
      key: type,
      label: ACCOUNT_TYPES[type].label,
      lines: lines.map(({ row, amount }) => ({
        accountId: row.id,
        code: row.code,
        name: row.name,
        amount: money(amount),
      })),
      total: money(total),
    });
  }
  return { sections, total: grand };
}

/**
 * Income and expenses between two dates (inclusive). Without a `from` date it
 * covers the financial year to date.
 */
export async function profitAndLoss(tx: OrgTx, input: { from?: unknown; to?: unknown }) {
  const to = parseOptionalIsoDate(input.to, "to") ?? todayIsoDate();
  const from =
    input.from == null || input.from === ""
      ? financialYearStart(to, await financialYearEndMonth(tx))
      : parseIsoDate(input.from, "from");
  if (from > to) {
    throw new ValidationError("'from' must be on or before 'to'.");
  }
  const money = moneyFormatter(tx);
  const rows = await accountTotals(tx, from, to);
  const trading = buildSections(rows, ["revenue"], money);
  const costOfSales = buildSections(rows, ["direct_costs"], money);
  const otherIncome = buildSections(rows, ["other_income"], money);
  const expenses = buildSections(rows, ["expense", "depreciation"], money);
  const grossProfit = sub(trading.total, costOfSales.total);
  const netProfit = sub(add(grossProfit, otherIncome.total), expenses.total);
  return {
    from,
    to,
    currencyCode: tx.baseCurrency,
    revenue: { sections: trading.sections, total: money(trading.total) },
    costOfSales: { sections: costOfSales.sections, total: money(costOfSales.total) },
    grossProfit: money(grossProfit),
    otherIncome: { sections: otherIncome.sections, total: money(otherIncome.total) },
    expenses: { sections: expenses.sections, total: money(expenses.total) },
    netProfit: money(netProfit),
  };
}

/** Income minus expenses across the given account totals. */
function earningsOf(rows: AccountTotalsRow[]): Decimal {
  let earnings = ZERO_DECIMAL;
  for (const row of rows) {
    if (row.account_class === "revenue") earnings = add(earnings, naturalAmount(row));
    if (row.account_class === "expense") earnings = sub(earnings, naturalAmount(row));
  }
  return earnings;
}

/**
 * Assets, liabilities and equity as at a date. There are no year-end closing
 * journals: profit is worked out when the report runs and shown as two equity
 * lines so the sheet balances:
 * - current year earnings: profit from the start of this financial year;
 * - earnings from previous years: all profit before that.
 */
export async function balanceSheet(tx: OrgTx, input: { asAt?: unknown }) {
  const asAt = parseOptionalIsoDate(input.asAt, "asAt") ?? todayIsoDate();
  const money = moneyFormatter(tx);
  const yearStart = financialYearStart(asAt, await financialYearEndMonth(tx));
  const rows = await accountTotals(tx, null, asAt);
  const assets = buildSections(
    rows,
    ["bank", "current_asset", "inventory", "fixed_asset", "non_current_asset"],
    money,
  );
  const liabilities = buildSections(rows, ["credit_card", "current_liability", "non_current_liability"], money);
  const equity = buildSections(rows, ["equity"], money);

  const allEarnings = earningsOf(rows);
  const currentYearEarnings = earningsOf(await accountTotals(tx, yearStart, asAt));
  const previousYearsEarnings = sub(allEarnings, currentYearEarnings);
  const totalEquity = add(equity.total, allEarnings);
  const liabilitiesAndEquity = add(liabilities.total, totalEquity);
  return {
    asAt,
    financialYearStart: yearStart,
    currencyCode: tx.baseCurrency,
    assets: { sections: assets.sections, total: money(assets.total) },
    liabilities: { sections: liabilities.sections, total: money(liabilities.total) },
    equity: {
      sections: equity.sections,
      previousYearsEarnings: money(previousYearsEarnings),
      currentYearEarnings: money(currentYearEarnings),
      total: money(totalEquity),
    },
    liabilitiesAndEquity: money(liabilitiesAndEquity),
    balanced: cmp(assets.total, liabilitiesAndEquity) === 0,
  };
}

export async function inventoryValuation(tx: OrgTx) {
  const money = moneyFormatter(tx);
  const result = await tx.query<{
    item_code: string;
    on_hand_quantity: string;
    carrying_value: string;
    last_movement_date: string | null;
  }>(
    `select item_code, on_hand_quantity, carrying_value, last_movement_date
       from inventory_item_balances
      where on_hand_quantity <> 0 or carrying_value <> 0
      order by item_code`,
  );
  let total = ZERO_DECIMAL;
  const items = result.rows.map((row) => {
    total = add(total, dec(row.carrying_value));
    return {
      itemCode: row.item_code,
      quantity: row.on_hand_quantity,
      value: money(dec(row.carrying_value)),
      averageCost: isZero(dec(row.on_hand_quantity))
        ? null
        : toPlainString(divide(dec(row.carrying_value), dec(row.on_hand_quantity), 4)),
      lastMovementDate: row.last_movement_date,
    };
  });
  return { currencyCode: tx.baseCurrency, items, totalValue: money(total) };
}

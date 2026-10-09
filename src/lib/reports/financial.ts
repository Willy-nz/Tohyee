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

export type AccountTotalsRow = {
  id: string;
  code: string;
  name: string;
  account_class: AccountClass;
  account_type: AccountType;
  debits: string;
  credits: string;
};

export async function financialYearEndMonth(tx: OrgTx): Promise<number> {
  const result = await tx.query<{ financial_year_end_month: number }>(
    "select financial_year_end_month from organisation_settings where id = true",
  );
  return result.rows[0].financial_year_end_month;
}

/** Only lines tagged with one of these values of a tracking category (TC8). */
export type TrackingFilter = { categoryId: string; valueIds: string[] };

export async function accountTotals(
  tx: OrgTx,
  from: string | null,
  to: string,
  filter: TrackingFilter | null = null,
): Promise<AccountTotalsRow[]> {
  const result = await tx.query<AccountTotalsRow>(
    `select a.id, a.code, a.name, a.account_class, a.account_type,
            coalesce(sum(l.debit_amount), 0)::text as debits,
            coalesce(sum(l.credit_amount), 0)::text as credits
       from accounts a
       join ledger_journal_lines l on l.account_id = a.id
       join ledger_journals j on j.id = l.journal_id
      where j.posting_date <= $2
        and ($1::date is null or j.posting_date >= $1)
        and ($3::text is null or (l.tracking ->> $3::text) = any($4::text[]))
      group by a.id
      order by a.code`,
    [from, to, filter?.categoryId ?? null, filter?.valueIds ?? []],
  );
  return result.rows;
}

export type TrialBalanceRow = {
  /** Null only for the retained earnings line when there's no retained earnings account. */
  accountId: string | null;
  code: string;
  name: string;
  accountClass: AccountClass;
  accountType: AccountType;
  debit: string;
  credit: string;
  /**
   * Only on the retained earnings line: the profit of every financial year
   * before this one, included in its debit or credit. It's worked out, not
   * posted, so it isn't in the account's transactions.
   */
  previousYearsEarnings?: string;
};

/**
 * The trial balance as at a date, like NetSuite's (TB1-TB4): balance sheet
 * accounts show every posting to the date; income and expense (profit and
 * loss) accounts show only this financial year's postings, from the first
 * day of the financial year the date is in; and the profit of every earlier
 * year is added to retained earnings, the same figure as the balance
 * sheet's retained earnings (P2), so the trial balance still balances.
 * Nothing is posted at a year end (YE1-YE4).
 *
 * NetSuite's Trial Balance report: for income statement accounts it
 * "includes only transactions posted from the beginning of the ... year up
 * to the As of date", and retained earnings is "the sum of cumulative net
 * income and amounts posted directly to the retained earnings account".
 */
export async function trialBalance(tx: OrgTx, input: { asAt?: unknown }) {
  const asAt = parseOptionalIsoDate(input.asAt, "asAt") ?? todayIsoDate();
  const money = moneyFormatter(tx);
  const yearStart = financialYearStart(asAt, await financialYearEndMonth(tx));
  const all = await accountTotals(tx, null, asAt);
  const thisYearRows = await accountTotals(tx, yearStart, asAt);
  const thisYear = new Map(thisYearRows.map((row) => [row.id, row]));
  const previousYearsEarnings = sub(earningsOf(all), earningsOf(thisYearRows));
  const retainedAccount = (
    await tx.query<{ id: string; code: string; name: string; account_class: AccountClass; account_type: AccountType }>(
      "select id::text, code, name, account_class, account_type from accounts where system_key = 'retained_earnings' and account_class = 'equity'",
    )
  ).rows[0];
  const netOf = (row: AccountTotalsRow | undefined) => (row ? sub(dec(row.debits), dec(row.credits)) : ZERO_DECIMAL);

  type Entry = { row: Omit<AccountTotalsRow, "debits" | "credits">; net: Decimal; retained: boolean };
  const entries: Entry[] = [];
  for (const row of all) {
    if (row.id === retainedAccount?.id) continue;
    const profitAndLoss = row.account_class === "revenue" || row.account_class === "expense";
    entries.push({ row, net: profitAndLoss ? netOf(thisYear.get(row.id)) : netOf(row), retained: false });
  }
  // Earnings are credits, so previous years' profit lowers the debit balance.
  entries.push({
    row: retainedAccount ?? { id: "", code: "", name: "Retained earnings", account_class: "equity", account_type: "equity" },
    net: sub(netOf(all.find((row) => row.id === retainedAccount?.id)), previousYearsEarnings),
    retained: true,
  });
  entries.sort((a, b) => (a.row.code < b.row.code ? -1 : a.row.code > b.row.code ? 1 : 0));

  const rows: TrialBalanceRow[] = [];
  let totalDebit = ZERO_DECIMAL;
  let totalCredit = ZERO_DECIMAL;
  for (const { row, net, retained } of entries) {
    if (isZero(net)) continue;
    const debit = isNegative(net) ? ZERO_DECIMAL : net;
    const credit = isNegative(net) ? neg(net) : ZERO_DECIMAL;
    totalDebit = add(totalDebit, debit);
    totalCredit = add(totalCredit, credit);
    rows.push({
      accountId: row.id === "" ? null : row.id,
      code: row.code,
      name: row.name,
      accountClass: row.account_class,
      accountType: row.account_type,
      debit: money(debit),
      credit: money(credit),
      ...(retained ? { previousYearsEarnings: money(previousYearsEarnings) } : {}),
    });
  }
  return {
    asAt,
    /** Income and expense accounts show postings from this day, the first of the financial year. */
    financialYearStart: yearStart,
    /** Profit of every financial year before this one, included in retained earnings. */
    previousYearsEarnings: money(previousYearsEarnings),
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
export function naturalAmount(row: AccountTotalsRow): Decimal {
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
export function earningsOf(rows: AccountTotalsRow[]): Decimal {
  let earnings = ZERO_DECIMAL;
  for (const row of rows) {
    if (row.account_class === "revenue") earnings = add(earnings, naturalAmount(row));
    if (row.account_class === "expense") earnings = sub(earnings, naturalAmount(row));
  }
  return earnings;
}

/**
 * Assets, liabilities and equity as at a date. There are no year-end closing
 * journals (like NetSuite): profit is worked out when the report runs
 * (P2, YE1-YE4):
 * - current year earnings: profit from the start of this financial year;
 * - retained earnings: the retained earnings account's own balance plus all
 *   profit before this financial year (`previousYearsEarnings`), so a
 *   year's profit moves into it on the first day of the next year.
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
  const retainedAccount = (
    await tx.query<{ id: string; code: string; name: string }>(
      "select id::text, code, name from accounts where system_key = 'retained_earnings' and account_class = 'equity'",
    )
  ).rows[0];
  const retainedRow = retainedAccount ? rows.find((row) => row.id === retainedAccount.id) : undefined;
  const retainedBalance = retainedRow ? naturalAmount(retainedRow) : ZERO_DECIMAL;
  const equity = buildSections(
    rows.filter((row) => row.id !== retainedAccount?.id),
    ["equity"],
    money,
  );

  const allEarnings = earningsOf(rows);
  const currentYearEarnings = earningsOf(await accountTotals(tx, yearStart, asAt));
  const previousYearsEarnings = sub(allEarnings, currentYearEarnings);
  const retainedEarnings = add(retainedBalance, previousYearsEarnings);
  const totalEquity = add(add(equity.total, retainedBalance), allEarnings);
  const liabilitiesAndEquity = add(liabilities.total, totalEquity);
  return {
    asAt,
    financialYearStart: yearStart,
    currencyCode: tx.baseCurrency,
    assets: { sections: assets.sections, total: money(assets.total) },
    liabilities: { sections: liabilities.sections, total: money(liabilities.total) },
    equity: {
      /** Equity accounts other than retained earnings. */
      sections: equity.sections,
      retainedEarnings: {
        account: retainedAccount ?? null,
        accountBalance: money(retainedBalance),
        previousYearsEarnings: money(previousYearsEarnings),
        total: money(retainedEarnings),
      },
      previousYearsEarnings: money(previousYearsEarnings),
      currentYearEarnings: money(currentYearEarnings),
      total: money(totalEquity),
    },
    liabilitiesAndEquity: money(liabilitiesAndEquity),
    balanced: cmp(assets.total, liabilitiesAndEquity) === 0,
  };
}

/**
 * Stock on hand and its value by item and location (ST3, ST12), with the
 * inventory account's balance beside it: they're always equal to the cent.
 */
export async function inventoryValuation(tx: OrgTx) {
  const money = moneyFormatter(tx);
  const result = await tx.query<{
    item_code: string;
    item_name: string | null;
    base_unit: string | null;
    location_value_id: string | null;
    location_name: string | null;
    on_hand_quantity: string;
    carrying_value: string;
    last_movement_date: string | null;
  }>(
    `select b.item_code, i.name as item_name, i.base_unit, b.location_value_id, v.name as location_name,
            b.on_hand_quantity, b.carrying_value, b.last_movement_date
       from inventory_item_balances b
       left join items i on lower(i.code) = lower(b.item_code)
       left join tracking_values v on v.id = b.location_value_id
      where b.on_hand_quantity <> 0 or b.carrying_value <> 0
      order by lower(b.item_code), v.name nulls first`,
  );
  const account = await tx.query<{ code: string | null; balance: string }>(
    `select a.code, coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as balance
       from accounts a left join ledger_journal_lines l on l.account_id = a.id
      where a.system_key = 'inventory' group by a.code`,
  );
  let total = ZERO_DECIMAL;
  const items = result.rows.map((row) => {
    total = add(total, dec(row.carrying_value));
    return {
      itemCode: row.item_code,
      itemName: row.item_name,
      unit: row.base_unit,
      locationValueId: row.location_value_id,
      locationName: row.location_name,
      quantity: row.on_hand_quantity,
      value: money(dec(row.carrying_value)),
      averageCost: isZero(dec(row.on_hand_quantity))
        ? null
        : toPlainString(divide(dec(row.carrying_value), dec(row.on_hand_quantity), 4)),
      lastMovementDate: row.last_movement_date,
    };
  });
  return {
    currencyCode: tx.baseCurrency,
    items,
    totalValue: money(total),
    inventoryAccountCode: account.rows[0]?.code ?? null,
    inventoryAccountBalance: money(dec(account.rows[0]?.balance ?? "0")),
  };
}

export type SplitColumn = { key: string; label: string; valueId: string | null };
export type SplitLine = { accountId: string; code: string; name: string; amounts: Record<string, string> };
export type SplitSection = { key: string; label: string; lines: SplitLine[]; totals: Record<string, string> };
export type SplitGroup = { sections: SplitSection[]; totals: Record<string, string> };
export type ProfitAndLossSplit = Awaited<ReturnType<typeof profitAndLossSplit>>;

/**
 * Profit and loss split by a tracking category (TC7): one column per
 * top-level value (values under it count in its column), "Not set" for
 * untagged lines, and the total, which equals the profit and loss.
 */
export async function profitAndLossSplit(tx: OrgTx, input: { from?: unknown; to?: unknown; categoryId: unknown }) {
  const categoryId = typeof input.categoryId === "string" && /^[1-9]\d{0,17}$/.test(input.categoryId) ? input.categoryId : null;
  if (!categoryId) throw new ValidationError("Choose a tracking category to split by.");
  const category = await tx.query<{ name: string }>("select name from tracking_categories where id = $1", [categoryId]);
  if (!category.rows[0]) throw new ValidationError("There's no such tracking category.");
  const plain = await profitAndLoss(tx, { from: input.from, to: input.to });
  const money = moneyFormatter(tx);
  const rows = await tx.query<AccountTotalsRow & { bucket: string | null }>(
    `with recursive roots as (
       select id, id as root_id from tracking_values where category_id = $3 and parent_id is null
       union all
       select v.id, r.root_id from tracking_values v join roots r on v.parent_id = r.id
     )
     select a.id, a.code, a.name, a.account_class, a.account_type, r.root_id::text as bucket,
            coalesce(sum(l.debit_amount), 0)::text as debits,
            coalesce(sum(l.credit_amount), 0)::text as credits
       from accounts a
       join ledger_journal_lines l on l.account_id = a.id
       join ledger_journals j on j.id = l.journal_id
       left join roots r on r.id::text = (l.tracking ->> $3::text)
      where j.posting_date between $1 and $2
        and a.account_class in ('revenue', 'expense')
      group by a.id, r.root_id
      order by a.code`,
    [plain.from, plain.to, categoryId],
  );
  const tops = await tx.query<{ id: string; name: string; is_active: boolean }>(
    "select id::text, name, is_active from tracking_values where category_id = $1 and parent_id is null order by lower(name), tracking_values.id",
    [categoryId],
  );
  const used = new Set(rows.rows.map((row) => row.bucket));
  const columns: SplitColumn[] = [
    ...tops.rows.filter((row) => row.is_active || used.has(row.id)).map((row) => ({ key: row.id, label: row.name, valueId: row.id })),
    { key: "none", label: "Not set", valueId: null },
    { key: "total", label: "Total", valueId: null },
  ];
  const keyOf = (bucket: string | null) => bucket ?? "none";
  const zeroTotals = () => Object.fromEntries(columns.map((c) => [c.key, ZERO_DECIMAL])) as Record<string, Decimal>;
  const format = (totals: Record<string, Decimal>) => Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, money(v)]));

  const group = (types: readonly AccountType[]) => {
    const groupTotals = zeroTotals();
    const sections: SplitSection[] = [];
    for (const type of types) {
      const byAccount = new Map<string, { row: AccountTotalsRow; amounts: Record<string, Decimal> }>();
      for (const row of rows.rows.filter((r) => r.account_type === type)) {
        const entry = byAccount.get(row.id) ?? { row, amounts: zeroTotals() };
        const amount = naturalAmount(row);
        entry.amounts[keyOf(row.bucket)] = add(entry.amounts[keyOf(row.bucket)], amount);
        entry.amounts.total = add(entry.amounts.total, amount);
        byAccount.set(row.id, entry);
      }
      const lines = [...byAccount.values()].filter((entry) => !isZero(entry.amounts.total) || Object.values(entry.amounts).some((v) => !isZero(v)));
      if (lines.length === 0) continue;
      const totals = zeroTotals();
      for (const entry of lines) for (const column of columns) totals[column.key] = add(totals[column.key], entry.amounts[column.key]);
      for (const column of columns) groupTotals[column.key] = add(groupTotals[column.key], totals[column.key]);
      sections.push({
        key: type,
        label: ACCOUNT_TYPES[type].label,
        lines: lines.map((entry) => ({ accountId: entry.row.id, code: entry.row.code, name: entry.row.name, amounts: format(entry.amounts) })),
        totals: format(totals),
      });
    }
    return { sections, totals: groupTotals };
  };
  const revenue = group(["revenue"]);
  const costOfSales = group(["direct_costs"]);
  const otherIncome = group(["other_income"]);
  const expenses = group(["expense", "depreciation"]);
  const combine = (fn: (key: string) => Decimal) => Object.fromEntries(columns.map((c) => [c.key, fn(c.key)])) as Record<string, Decimal>;
  const grossProfit = combine((k) => sub(revenue.totals[k], costOfSales.totals[k]));
  const netProfit = combine((k) => sub(add(grossProfit[k], otherIncome.totals[k]), expenses.totals[k]));
  const asGroup = (g: { sections: SplitSection[]; totals: Record<string, Decimal> }): SplitGroup => ({ sections: g.sections, totals: format(g.totals) });
  return {
    from: plain.from,
    to: plain.to,
    currencyCode: tx.baseCurrency,
    category: { id: categoryId, name: category.rows[0].name },
    columns,
    revenue: asGroup(revenue),
    costOfSales: asGroup(costOfSales),
    grossProfit: format(grossProfit),
    otherIncome: asGroup(otherIncome),
    expenses: asGroup(expenses),
    netProfit: format(netProfit),
  };
}

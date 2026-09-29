import { ACCOUNT_TYPES, type AccountClass, type AccountType } from "@/lib/accounts/types";
import { MONTH_PATTERN, monthEndDate, monthStartDate } from "@/lib/budgets/fill";
import { budgetTotals, budgetTrackingFilter, getBudgetSummary, type Budget } from "@/lib/budgets/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { financialYearStart } from "@/lib/financial-year";
import { currencyMinorUnits } from "@/lib/money/currency";
import { abs, add, dec, type Decimal, divide, isZero, mul, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { accountTotals, financialYearEndMonth, naturalAmount } from "@/lib/reports/financial";

/**
 * Budget vs actual (examples BU5, BU6): for whole months, each profit and
 * loss account's actual (from the ledger, filtered to the budget's tracking
 * value when it has one), its budget, the variance (actual less budget) and
 * the variance as a % of the budget (1 decimal place, halves away from zero;
 * blank when the budget is 0.00), with section totals, gross profit and net
 * profit. All in each account's natural direction, as on the profit and loss.
 * Stores nothing and posts nothing.
 */

export type VarianceFigures = { actual: string; budget: string; variance: string; variancePercent: string | null };
export type BudgetVsActualLine = VarianceFigures & { accountId: string; code: string; name: string };
export type BudgetVsActualSection = { key: AccountType; label: string; lines: BudgetVsActualLine[]; total: VarianceFigures };
export type BudgetVsActualGroup = { sections: BudgetVsActualSection[]; total: VarianceFigures };

export type BudgetVsActual = {
  budget: Budget;
  from: string;
  to: string;
  currencyCode: string;
  revenue: BudgetVsActualGroup;
  costOfSales: BudgetVsActualGroup;
  grossProfit: VarianceFigures;
  otherIncome: BudgetVsActualGroup;
  expenses: BudgetVsActualGroup;
  netProfit: VarianceFigures;
};

type Pair = { actual: Decimal; budget: Decimal };

function month(input: unknown, what: string): string | null {
  if (input == null || input === "") return null;
  if (typeof input !== "string" || !MONTH_PATTERN.test(input.trim())) throw new ValidationError(`${what} must be a month like 2026-04.`);
  return input.trim();
}

export async function budgetVsActual(tx: OrgTx, input: { budgetId: unknown; from?: unknown; to?: unknown }): Promise<BudgetVsActual> {
  const budget = await getBudgetSummary(tx, input.budgetId);
  const toMonth = month(input.to, "to") ?? todayIsoDate().slice(0, 7);
  const fromMonth = month(input.from, "from") ?? financialYearStart(monthEndDate(toMonth), await financialYearEndMonth(tx)).slice(0, 7);
  if (fromMonth > toMonth) throw new ValidationError("'from' must be on or before 'to'.");
  const from = monthStartDate(fromMonth);
  const to = monthEndDate(toMonth);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);
  const figures = (pair: Pair): VarianceFigures => {
    const variance = sub(pair.actual, pair.budget);
    return {
      actual: money(pair.actual),
      budget: money(pair.budget),
      variance: money(variance),
      variancePercent: isZero(pair.budget) ? null : toFixedString(divide(mul(variance, dec("100")), abs(pair.budget), 1), 1),
    };
  };

  const accounts = await tx.query<{ id: string; code: string; name: string; account_class: AccountClass; account_type: AccountType }>(
    "select id::text, code, name, account_class, account_type from accounts where account_class in ('revenue', 'expense') order by code",
  );
  const actuals = new Map<string, Decimal>();
  for (const row of await accountTotals(tx, from, to, await budgetTrackingFilter(tx, budget))) actuals.set(String(row.id), naturalAmount(row));
  const budgets = await budgetTotals(tx, budget.id, from, to);

  const group = (types: readonly AccountType[]): { group: BudgetVsActualGroup; pair: Pair } => {
    let groupPair: Pair = { actual: ZERO_DECIMAL, budget: ZERO_DECIMAL };
    const sections: BudgetVsActualSection[] = [];
    for (const type of types) {
      let sectionPair: Pair = { actual: ZERO_DECIMAL, budget: ZERO_DECIMAL };
      const lines: BudgetVsActualLine[] = [];
      for (const account of accounts.rows.filter((row) => row.account_type === type)) {
        const pair = { actual: actuals.get(account.id) ?? ZERO_DECIMAL, budget: budgets.get(account.id) ?? ZERO_DECIMAL };
        if (isZero(pair.actual) && isZero(pair.budget)) continue;
        sectionPair = { actual: add(sectionPair.actual, pair.actual), budget: add(sectionPair.budget, pair.budget) };
        lines.push({ accountId: account.id, code: account.code, name: account.name, ...figures(pair) });
      }
      if (lines.length === 0) continue;
      groupPair = { actual: add(groupPair.actual, sectionPair.actual), budget: add(groupPair.budget, sectionPair.budget) };
      sections.push({ key: type, label: ACCOUNT_TYPES[type].label, lines, total: figures(sectionPair) });
    }
    return { group: { sections, total: figures(groupPair) }, pair: groupPair };
  };
  const revenue = group(["revenue"]);
  const costOfSales = group(["direct_costs"]);
  const otherIncome = group(["other_income"]);
  const expenses = group(["expense", "depreciation"]);
  const combine = (fn: (key: keyof Pair) => Decimal): Pair => ({ actual: fn("actual"), budget: fn("budget") });
  const gross = combine((key) => sub(revenue.pair[key], costOfSales.pair[key]));
  const net = combine((key) => sub(add(gross[key], otherIncome.pair[key]), expenses.pair[key]));
  return {
    budget,
    from,
    to,
    currencyCode: tx.baseCurrency,
    revenue: revenue.group,
    costOfSales: costOfSales.group,
    grossProfit: figures(gross),
    otherIncome: otherIncome.group,
    expenses: expenses.group,
    netProfit: figures(net),
  };
}

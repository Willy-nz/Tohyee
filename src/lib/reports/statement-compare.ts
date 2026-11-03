import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { add, dec, type Decimal, divide, isZero, mul, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  type CompareSetting,
  compareAmountColumns,
  MAX_COMPARE_PERIODS,
  type StatementColumn,
  withPercentColumns,
} from "@/lib/reports/compare-columns";
import { PERIOD_LENGTHS, type PeriodLength } from "@/lib/reports/custom-layout";
import { balanceSheet, filterView, financialYearEndMonth, moneyFormatter, profitAndLoss } from "@/lib/reports/financial";
import { type ParsedTrackingFilter, parseTrackingFilter } from "@/lib/reports/tracking-filter";

/**
 * The standard profit and loss and balance sheet with more than one column
 * (decisions 1353-1354, examples RX1-RX4): earlier periods, a total, a year
 * to date and % of trading income. Each period column is the standard report
 * for its own dates, run as it is, so every column equals the single-column
 * report (CR9); the rows are those reports' rows put side by side.
 */

export type StatementValues = Record<string, string | null>;
export type StatementRowKind = "heading" | "subheading" | "account" | "total" | "grand" | "earnings";

export type StatementRow = {
  key: string;
  kind: StatementRowKind;
  label: string;
  accountId?: string;
  /** Explains a worked-out line (retained earnings, current year earnings). */
  note?: string;
  values: StatementValues;
};

export type MultiColumnStatement = {
  base: "profit_and_loss" | "balance_sheet";
  from: string | null;
  to: string;
  currencyCode: string;
  filter: ReturnType<typeof filterView>;
  columns: StatementColumn[];
  rows: StatementRow[];
  /** Balance sheet only: whether each column balances. */
  balanced?: Record<string, boolean>;
};

function bool(input: unknown): boolean {
  return input === true || input === "true" || input === "1";
}

/** Reads the compare options from a request (query strings or JSON). */
export function parseCompare(input: { compare?: unknown; compareBy?: unknown; total?: unknown; ytd?: unknown; percent?: unknown }): CompareSetting | null {
  const periods = input.compare == null || input.compare === "" ? 0 : Number(input.compare);
  if (!Number.isInteger(periods) || periods < 0 || periods > MAX_COMPARE_PERIODS) {
    throw new ValidationError(`Compare with 0 to ${MAX_COMPARE_PERIODS} earlier periods.`);
  }
  const periodLength = input.compareBy == null || input.compareBy === "" ? "month" : input.compareBy;
  if (typeof periodLength !== "string" || !Object.hasOwn(PERIOD_LENGTHS, periodLength)) {
    throw new ValidationError("Compare by months, quarters or years.");
  }
  const setting: CompareSetting = {
    periods,
    periodLength: periodLength as PeriodLength,
    total: bool(input.total),
    yearToDate: bool(input.ytd),
    percentOfIncome: bool(input.percent),
  };
  if (setting.periods === 0 && !setting.total && !setting.yearToDate && !setting.percentOfIncome) return null;
  return setting;
}

type Group = { sections: Array<{ key: string; label: string; lines: Array<{ accountId: string; code: string; name: string; amount: string }>; total: string }>; total: string };

/** One row per account in any column of these groups, in code order within each section. */
function accountRows(groups: Array<{ key: string; group: Group }>, money: (value: Decimal) => string, keys: string[]): StatementRow[] {
  const sections = new Map<string, { label: string; lines: Map<string, StatementRow> }>();
  for (const { key, group } of groups) {
    for (const section of group.sections) {
      const entry = sections.get(section.key) ?? { label: section.label, lines: new Map() };
      for (const line of section.lines) {
        const row = entry.lines.get(line.accountId) ?? {
          key: `a${line.accountId}`,
          kind: "account" as const,
          label: `${line.code} · ${line.name}`,
          accountId: line.accountId,
          values: Object.fromEntries(keys.map((k) => [k, money(ZERO_DECIMAL)])),
        };
        row.values[key] = line.amount;
        entry.lines.set(line.accountId, row);
      }
      sections.set(section.key, entry);
    }
  }
  const rows: StatementRow[] = [];
  for (const [sectionKey, section] of sections) {
    if (sections.size > 1) rows.push({ key: `s${sectionKey}`, kind: "subheading", label: section.label, values: {} });
    rows.push(...[...section.lines.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)));
  }
  return rows;
}

function valuesOf(reports: Array<{ key: string }>, pick: (index: number) => string): StatementValues {
  return Object.fromEntries(reports.map((report, index) => [report.key, pick(index)]));
}

/** Adds the total column (the periods added up) and the % columns to every row. */
function finish(rows: StatementRow[], columns: StatementColumn[], money: (value: Decimal) => string, income: StatementValues | null): StatementRow[] {
  const periods = columns.filter((column) => column.kind === "period");
  const hasTotal = columns.some((column) => column.kind === "total");
  for (const row of rows) {
    if (row.kind === "heading" || row.kind === "subheading") continue;
    if (hasTotal) {
      let total = ZERO_DECIMAL;
      for (const column of periods) total = add(total, dec(row.values[column.key] ?? "0"));
      row.values.total = money(total);
    }
    if (income) {
      for (const column of columns) {
        if (column.kind !== "percent" || !column.of) continue;
        row.values[column.key] = percentOf(row.values[column.of], income[column.of]);
      }
    }
  }
  return rows;
}

/**
 * An amount as a % of trading income (RX4): to 1 decimal place, halves away
 * from zero; null (shown blank) when there's no trading income.
 */
export function percentOf(amount: string | null | undefined, income: string | null | undefined): string | null {
  if (amount == null || income == null) return null;
  const base = dec(income);
  if (isZero(base)) return null;
  return toFixedString(divide(mul(dec(amount), dec("100")), base, 1), 1);
}

export async function profitAndLossCompare(
  tx: OrgTx,
  input: { from?: unknown; to?: unknown; trackingCategoryId?: unknown; trackingValueId?: unknown },
  setting: CompareSetting,
): Promise<MultiColumnStatement> {
  const filter: ParsedTrackingFilter | null = await parseTrackingFilter(tx, input.trackingCategoryId, input.trackingValueId);
  const first = await profitAndLoss(tx, { from: input.from, to: input.to, filter });
  const money = moneyFormatter(tx);
  const yearEndMonth = await financialYearEndMonth(tx);
  const amountColumns = compareAmountColumns("profit_and_loss", { from: first.from, to: first.to }, setting, yearEndMonth);
  const columns = withPercentColumns(amountColumns, setting.percentOfIncome === true);
  const run = amountColumns.filter((column) => column.kind === "period" || column.kind === "year_to_date");
  // One after another: they share the organisation's transaction.
  const reports: Array<{ key: string; report: typeof first }> = [];
  for (const [index, column] of run.entries()) {
    reports.push({ key: column.key, report: index === 0 ? first : await profitAndLoss(tx, { from: column.from, to: column.to, filter }) });
  }
  const keys = amountColumns.map((column) => column.key);
  const blank = () => Object.fromEntries(keys.map((k) => [k, money(ZERO_DECIMAL)]));
  const group = (
    title: string,
    totalLabel: string,
    pick: (report: (typeof reports)[number]["report"]) => Group,
    key: string,
  ): StatementRow[] => {
    const groups = reports.map(({ key: column, report }) => ({ key: column, group: pick(report) }));
    if (groups.every(({ group: g }) => g.sections.length === 0)) return [];
    return [
      { key: `h${key}`, kind: "heading", label: title, values: {} },
      ...accountRows(groups, money, keys),
      { key: `t${key}`, kind: "total", label: totalLabel, values: { ...blank(), ...valuesOf(reports, (i) => pick(reports[i].report).total) } },
    ];
  };
  const rows: StatementRow[] = [
    ...group("Trading income", "Total trading income", (r) => r.revenue, "revenue"),
    ...group("Cost of sales", "Total cost of sales", (r) => r.costOfSales, "cost"),
    { key: "gross", kind: "total", label: "Gross profit", values: { ...blank(), ...valuesOf(reports, (i) => reports[i].report.grossProfit) } },
    ...group("Other income", "Total other income", (r) => r.otherIncome, "other"),
    ...group("Operating expenses", "Total operating expenses", (r) => r.expenses, "expenses"),
    { key: "net", kind: "grand", label: "Net profit", values: { ...blank(), ...valuesOf(reports, (i) => reports[i].report.netProfit) } },
  ];
  // Trading income per amount column, for the % columns (total column added up below).
  const income: StatementValues = { ...blank(), ...valuesOf(reports, (i) => reports[i].report.revenue.total) };
  if (amountColumns.some((column) => column.kind === "total")) {
    let total = ZERO_DECIMAL;
    for (const column of amountColumns.filter((c) => c.kind === "period")) total = add(total, dec(income[column.key] ?? "0"));
    income.total = money(total);
  }
  return {
    base: "profit_and_loss",
    from: first.from,
    to: first.to,
    currencyCode: tx.baseCurrency,
    filter: first.filter,
    columns,
    rows: finish(rows, columns, money, setting.percentOfIncome ? income : null),
  };
}

export async function balanceSheetCompare(
  tx: OrgTx,
  input: { asAt?: unknown; trackingCategoryId?: unknown; trackingValueId?: unknown },
  setting: CompareSetting,
): Promise<MultiColumnStatement> {
  if (setting.total || setting.yearToDate || setting.percentOfIncome) {
    throw new ValidationError("A balance sheet has no total, year to date or % of trading income column: each column is a balance on a date.");
  }
  const filter = await parseTrackingFilter(tx, input.trackingCategoryId, input.trackingValueId);
  const first = await balanceSheet(tx, { asAt: input.asAt, filter });
  const money = moneyFormatter(tx);
  const yearEndMonth = await financialYearEndMonth(tx);
  const columns = compareAmountColumns("balance_sheet", { from: null, to: first.asAt }, setting, yearEndMonth);
  const reports: Array<{ key: string; report: typeof first }> = [];
  for (const [index, column] of columns.entries()) {
    reports.push({ key: column.key, report: index === 0 ? first : await balanceSheet(tx, { asAt: column.to, filter }) });
  }
  const keys = columns.map((column) => column.key);
  const blank = () => Object.fromEntries(keys.map((k) => [k, money(ZERO_DECIMAL)]));
  type Sheet = (typeof reports)[number]["report"];
  const total = (key: string, kind: StatementRowKind, label: string, pick: (sheet: Sheet) => string): StatementRow => ({
    key,
    kind,
    label,
    values: { ...blank(), ...valuesOf(reports, (i) => pick(reports[i].report)) },
  });
  const term = (title: string, key: string, pick: (sheet: Sheet) => Sheet["assets"]): StatementRow[] => {
    const noun = title.toLowerCase();
    const part = (label: string, partKey: "current" | "nonCurrent"): StatementRow[] => {
      const groups = reports.map(({ key: column, report }) => ({ key: column, group: pick(report)[partKey] }));
      if (groups.every(({ group }) => group.sections.length === 0)) return [];
      return [
        { key: `${key}${partKey}h`, kind: "subheading", label, values: {} },
        ...accountRows(groups, money, keys).filter((row) => row.kind === "account"),
        total(`${key}${partKey}t`, "total", `Total ${label.toLowerCase()}`, (sheet) => pick(sheet)[partKey].total),
      ];
    };
    return [
      { key: `${key}h`, kind: "heading", label: title, values: {} },
      ...part(`Current ${noun}`, "current"),
      ...part(`Non-current ${noun}`, "nonCurrent"),
      total(`${key}t`, "total", `Total ${noun}`, (sheet) => pick(sheet).total),
    ];
  };
  const retained = first.equity.retainedEarnings.account;
  const rows: StatementRow[] = [
    ...term("Assets", "assets", (sheet) => sheet.assets),
    ...term("Liabilities", "liabilities", (sheet) => sheet.liabilities),
    total("netassets", "grand", "Net assets", (sheet) => sheet.netAssets),
    { key: "equityh", kind: "heading", label: "Equity", values: {} },
    ...accountRows(
      reports.map(({ key, report }) => ({ key, group: { sections: report.equity.sections, total: "0" } })),
      money,
      keys,
    ).filter((row) => row.kind === "account"),
    {
      ...total("retained", "earnings", retained ? `${retained.code} · ${retained.name}` : "Retained earnings", (sheet) => sheet.equity.retainedEarnings.total),
      ...(retained ? { accountId: retained.id } : {}),
      note: "Profit before the start of each column's financial year, with anything posted to the account.",
    },
    {
      ...total("current", "earnings", "Current year earnings", (sheet) => sheet.equity.currentYearEarnings),
      note: "Profit since the start of each column's financial year.",
    },
    total("equity", "grand", "Total equity", (sheet) => sheet.equity.total),
  ];
  return {
    base: "balance_sheet",
    from: null,
    to: first.asAt,
    currencyCode: tx.baseCurrency,
    filter: first.filter,
    columns,
    rows,
    balanced: Object.fromEntries(reports.map(({ key, report }) => [key, report.balanced])),
  };
}

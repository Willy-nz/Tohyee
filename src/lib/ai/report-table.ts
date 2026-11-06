import type { CashFlowFigures } from "@/lib/reports/cash-flow-layout";
import type { EquityFigures } from "@/lib/reports/equity-layout";
import type { AnyCustomReportFigures } from "@/lib/reports/custom";
import type { BudgetVsActual, BudgetVsActualGroup, VarianceFigures } from "@/lib/reports/budget-vs-actual";
import type { ProfitAndLossSplit, SplitGroup } from "@/lib/reports/financial";
import { GROSS_PROFIT_LABEL, type MultiColumnStatement, NET_PROFIT_LABEL, PROFIT_AND_LOSS_GROUPS } from "@/lib/reports/statement-compare";

/**
 * One answer shape for the AI's profit and loss style reports (#575,
 * decision 1380): profit_and_loss (plain, compared, split by tracking),
 * budget_vs_actual and run_custom_report all give `columns` and `rows`.
 * Each row's `values` holds its figures by column key (null for a blank).
 * The profit and loss groups have the screen's labels (Trading income, Cost
 * of sales, Gross profit, Other income, Operating expenses, Net profit).
 */

export type ReportTableColumnKind =
  | "period"
  | "total"
  | "year_to_date"
  | "percent"
  | "split"
  | "actual"
  | "budget"
  | "variance"
  | "variance_percent"
  | "difference"
  | "budget_difference";

export type ReportTableColumn = {
  key: string;
  kind: ReportTableColumnKind;
  label: string;
  from?: string | null;
  to?: string | null;
  /** A % column: the amount column it's worked out from. */
  of?: string;
  /** A split column: the tracking value (null for Not set). */
  valueId?: string | null;
};

export type ReportTableRowKind = "heading" | "subheading" | "account" | "group" | "total" | "grand" | "earnings" | "formula" | "text";

export type ReportTableRow = {
  key: string;
  kind: ReportTableRowKind;
  label: string;
  accountId?: string;
  code?: string;
  values: Record<string, string | null>;
  /** A custom report's formula row: money (the default), number or percent. */
  format?: "money" | "number" | "percent";
  note?: string;
  /** A custom report's row hidden on screen. */
  hidden?: boolean;
};

export type ReportTable = {
  report: "profit_and_loss" | "budget_vs_actual" | "custom_report";
  from: string | null;
  to: string | null;
  currencyCode: string;
  columns: ReportTableColumn[];
  rows: ReportTableRow[];
  [extra: string]: unknown;
};

const ROW_KINDS = new Set<ReportTableRowKind>(["heading", "subheading", "account", "group", "total", "grand", "earnings", "formula", "text"]);

/** A compared (or one column) profit and loss: already columns and rows. */
export function statementTable(statement: MultiColumnStatement): ReportTable {
  return {
    report: "profit_and_loss",
    from: statement.from,
    to: statement.to,
    currencyCode: statement.currencyCode,
    filter: statement.filter,
    columns: statement.columns.map((column) => ({
      key: column.key,
      kind: column.kind,
      label: column.label,
      from: column.from,
      to: column.to,
      ...(column.of ? { of: column.of } : {}),
    })),
    rows: statement.rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      label: row.label,
      ...(row.accountId ? { accountId: row.accountId } : {}),
      values: row.values,
      ...(row.note ? { note: row.note } : {}),
    })),
  };
}

type Line = { accountId: string; code: string; name: string; values: Record<string, string | null> };
type Section = { key: string; label: string; lines: Line[] };
type TableGroup = { sections: Section[]; total: Record<string, string | null> };

/** The profit and loss's rows, as the compared report lays them out, from groups whose figures are already by column. */
function profitAndLossRows(groups: Record<(typeof PROFIT_AND_LOSS_GROUPS)[number]["field"], TableGroup>, gross: Record<string, string | null>, net: Record<string, string | null>): ReportTableRow[] {
  const rowsOf = (entry: (typeof PROFIT_AND_LOSS_GROUPS)[number]): ReportTableRow[] => {
    const group = groups[entry.field];
    if (group.sections.length === 0) return [];
    const rows: ReportTableRow[] = [{ key: `h${entry.key}`, kind: "heading", label: entry.title, values: {} }];
    for (const section of group.sections) {
      if (group.sections.length > 1) rows.push({ key: `s${section.key}`, kind: "subheading", label: section.label, values: {} });
      for (const line of [...section.lines].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) {
        rows.push({ key: `a${line.accountId}`, kind: "account", label: `${line.code} · ${line.name}`, accountId: line.accountId, code: line.code, values: line.values });
      }
    }
    rows.push({ key: `t${entry.key}`, kind: "total", label: entry.totalLabel, values: group.total });
    return rows;
  };
  const [revenue, cost, other, expenses] = PROFIT_AND_LOSS_GROUPS;
  return [
    ...rowsOf(revenue),
    ...rowsOf(cost),
    { key: "gross", kind: "total", label: GROSS_PROFIT_LABEL, values: gross },
    ...rowsOf(other),
    ...rowsOf(expenses),
    { key: "net", kind: "grand", label: NET_PROFIT_LABEL, values: net },
  ];
}

/** A profit and loss split by a tracking category: one column per value, Not set and Total. */
export function splitTable(report: ProfitAndLossSplit): ReportTable {
  const group = (source: SplitGroup): TableGroup => ({
    sections: source.sections.map((section) => ({
      key: section.key,
      label: section.label,
      lines: section.lines.map((line) => ({ accountId: line.accountId, code: line.code, name: line.name, values: line.amounts })),
    })),
    total: source.totals,
  });
  return {
    report: "profit_and_loss",
    from: report.from,
    to: report.to,
    currencyCode: report.currencyCode,
    filter: report.filter,
    splitBy: report.category,
    columns: report.columns.map((column) =>
      column.key === "total"
        ? { key: column.key, kind: "total", label: column.label, from: report.from, to: report.to }
        : { key: column.key, kind: "split", label: column.label, from: report.from, to: report.to, valueId: column.valueId },
    ),
    rows: profitAndLossRows(
      { revenue: group(report.revenue), costOfSales: group(report.costOfSales), otherIncome: group(report.otherIncome), expenses: group(report.expenses) },
      report.grossProfit,
      report.netProfit,
    ),
  };
}

const varianceValues = (figures: VarianceFigures) => ({
  actual: figures.actual,
  budget: figures.budget,
  variance: figures.variance,
  variance_pct: figures.variancePercent,
});

/** Budget vs actual: Actual, Budget, Variance and % columns. */
export function budgetTable(report: BudgetVsActual): ReportTable {
  const group = (source: BudgetVsActualGroup): TableGroup => ({
    sections: source.sections.map((section) => ({
      key: section.key,
      label: section.label,
      lines: section.lines.map((line) => ({ accountId: line.accountId, code: line.code, name: line.name, values: varianceValues(line) })),
    })),
    total: varianceValues(source.total),
  });
  return {
    report: "budget_vs_actual",
    from: report.from,
    to: report.to,
    currencyCode: report.currencyCode,
    budget: { id: report.budget.id, name: report.budget.name, trackingLabel: report.budget.trackingLabel, version: report.budget.version },
    filter: report.filter,
    columns: [
      { key: "actual", kind: "actual", label: "Actual", from: report.from, to: report.to },
      { key: "budget", kind: "budget", label: "Budget", from: report.from, to: report.to },
      { key: "variance", kind: "variance", label: "Variance" },
      { key: "variance_pct", kind: "variance_percent", label: "%", of: "budget" },
    ],
    rows: profitAndLossRows(
      { revenue: group(report.revenue), costOfSales: group(report.costOfSales), otherIncome: group(report.otherIncome), expenses: group(report.expenses) },
      varianceValues(report.grossProfit),
      varianceValues(report.netProfit),
    ),
  };
}

/**
 * A custom report's figures: each table's title as a heading, then its rows
 * in order (a group's accounts first when the group shows them, as on the
 * screen), and each text block as a text row.
 */
export function customTable(report: { id: string; title: string; kind: string; publishedAt: string | null }, figures: AnyCustomReportFigures): ReportTable {
  if (figures.base === "cash_flows") return cashFlowTable(report, figures as CashFlowFigures);
  if ("opening" in figures) return equityTable(report, figures);
  const financial = figures as Exclude<AnyCustomReportFigures, CashFlowFigures | EquityFigures>;
  const rows: ReportTableRow[] = [];
  for (const block of financial.blocks) {
    if (block.kind === "text") {
      rows.push({ key: `b${block.id}`, kind: "text", label: block.text, values: {} });
      continue;
    }
    rows.push({ key: `b${block.id}`, kind: "heading", label: block.title, values: {} });
    for (const row of block.rows) {
      if (row.kind === "group" && row.showAccounts) {
        for (const line of row.lines) {
          rows.push({ key: `${row.id}:${line.accountId ?? line.code}`, kind: "account", label: `${line.code} · ${line.name}`, ...(line.accountId ? { accountId: line.accountId } : {}), code: line.code, values: line.values });
        }
      }
      const kind: ReportTableRowKind = ROW_KINDS.has(row.kind as ReportTableRowKind) ? (row.kind as ReportTableRowKind) : "group";
      rows.push({
        key: row.id,
        kind,
        label: row.label,
        values: row.values,
        ...(row.format && row.format !== "money" ? { format: row.format } : {}),
        ...(row.note ? { note: row.note } : {}),
        ...(row.hidden ? { hidden: true } : {}),
      });
    }
  }
  const periods = figures.columns.filter((column) => column.from || column.to);
  return {
    report: "custom_report",
    reportId: report.id,
    title: report.title,
    kind: report.kind,
    publishedAt: report.publishedAt,
    base: figures.base,
    from: periods.map((column) => column.from).filter((date): date is string => Boolean(date)).sort()[0] ?? null,
    to: periods.map((column) => column.to).filter((date): date is string => Boolean(date)).sort().at(-1) ?? null,
    currencyCode: figures.currencyCode,
    filter: financial.filterLabel ?? null,
    columns: figures.columns.map((column) => ({ key: column.key, kind: column.kind, label: column.label, from: column.from, to: column.to })),
    rows,
    notInReport: financial.notInReport,
    inSeveralGroups: financial.inSeveralGroups,
    ...("data" in figures && figures.data !== undefined ? { transactions: figures.data } : {}),
    computedAt: figures.computedAt,
  };
}

/** A cash flows layout's figures (CFL1-CFL4): each section's rows and total, then the last lines. */
function cashFlowTable(report: { id: string; title: string; kind: string; publishedAt: string | null }, figures: CashFlowFigures): ReportTable {
  const rows: ReportTableRow[] = [];
  for (const block of figures.blocks) {
    if (block.kind === "text") {
      rows.push({ key: `b${block.id}`, kind: "text", label: block.text, values: {} });
      continue;
    }
    rows.push({ key: `b${block.id}`, kind: "heading", label: block.title, values: {} });
    for (const row of block.rows) {
      if (row.kind === "group" && row.showLines) for (const line of row.lines) rows.push({ key: `${row.id}:${line.ref}`, kind: "account", label: line.label, values: line.values });
      rows.push({ key: row.id, kind: row.kind === "heading" ? "heading" : "group", label: row.label, values: row.values, ...(row.note ? { note: row.note } : {}), ...(row.hidden ? { hidden: true } : {}) });
    }
    rows.push({ key: `t${block.id}`, kind: "total", label: block.total.label, values: block.total.values });
  }
  for (const line of figures.end) rows.push({ key: line.key, kind: "total", label: line.label, values: line.values });
  const periods = figures.columns.filter((column) => column.from || column.to);
  return {
    report: "custom_report",
    reportId: report.id,
    title: report.title,
    kind: report.kind,
    publishedAt: report.publishedAt,
    base: figures.base,
    from: periods.map((column) => column.from).filter((date): date is string => Boolean(date)).sort()[0] ?? null,
    to: periods.map((column) => column.to).filter((date): date is string => Boolean(date)).sort().at(-1) ?? null,
    currencyCode: figures.currencyCode,
    filter: null,
    columns: figures.columns.map((column) => ({ key: column.key, kind: column.kind, label: column.label, from: column.from, to: column.to })),
    rows,
    notInReport: [],
    inSeveralGroups: [],
    computedAt: figures.computedAt,
  };
}

/** A changes in equity layout's figures (CEL1-CEL4): equity at the start, the rows, then equity at the end. */
function equityTable(report: { id: string; title: string; kind: string; publishedAt: string | null }, figures: EquityFigures): ReportTable {
  const rows: ReportTableRow[] = [{ key: "opening", kind: "total", label: figures.opening.label, values: figures.opening.values }];
  for (const block of figures.blocks) {
    if (block.kind === "text") {
      rows.push({ key: `b${block.id}`, kind: "text", label: block.text, values: {} });
      continue;
    }
    if (block.kind === "group" && block.showLines) for (const line of block.lines) rows.push({ key: `${block.id}:${line.ref}`, kind: "account", label: line.label, values: line.values });
    rows.push({ key: block.id, kind: block.kind === "heading" ? "heading" : "group", label: block.label, values: block.values, ...(block.note ? { note: block.note } : {}), ...(block.hidden ? { hidden: true } : {}) });
  }
  rows.push({ key: "closing", kind: "total", label: figures.closing.label, values: figures.closing.values });
  const periods = figures.columns.filter((column) => column.from || column.to);
  return {
    report: "custom_report",
    reportId: report.id,
    title: report.title,
    kind: report.kind,
    publishedAt: report.publishedAt,
    base: figures.base,
    from: periods.map((column) => column.from).filter((date): date is string => Boolean(date)).sort()[0] ?? null,
    to: periods.map((column) => column.to).filter((date): date is string => Boolean(date)).sort().at(-1) ?? null,
    currencyCode: figures.currencyCode,
    filter: null,
    columns: figures.columns.map((column) => ({ key: column.key, kind: column.kind, label: column.label, from: column.from, to: column.to })),
    rows,
    notInReport: [],
    inSeveralGroups: [],
    computedAt: figures.computedAt,
  };
}

const COLUMN_KINDS = new Set<ReportTableColumnKind>(["period", "total", "year_to_date", "percent", "split", "actual", "budget", "variance", "variance_percent", "difference", "budget_difference"]);

/**
 * What's wrong with an answer that should be a ReportTable (empty when
 * nothing is): the shared shape every report tool's answer is tested
 * against (#575).
 */
export function reportTableProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== "object") return ["not an object"];
  const table = value as Record<string, unknown>;
  if (!["profit_and_loss", "budget_vs_actual", "custom_report"].includes(String(table.report))) problems.push(`report is ${String(table.report)}`);
  for (const field of ["from", "to"]) if (table[field] !== null && typeof table[field] !== "string") problems.push(`${field} isn't text or null`);
  if (typeof table.currencyCode !== "string") problems.push("no currencyCode");
  if (!Array.isArray(table.columns) || table.columns.length === 0) return [...problems, "no columns"];
  if (!Array.isArray(table.rows)) return [...problems, "no rows"];
  const keys = new Set<string>();
  for (const column of table.columns as Array<Record<string, unknown>>) {
    if (typeof column.key !== "string" || keys.has(column.key)) problems.push(`column key ${String(column.key)}`);
    keys.add(String(column.key));
    if (!COLUMN_KINDS.has(column.kind as ReportTableColumnKind)) problems.push(`column ${String(column.key)} kind ${String(column.kind)}`);
    if (typeof column.label !== "string") problems.push(`column ${String(column.key)} has no label`);
  }
  const rowKeys = new Set<string>();
  for (const row of table.rows as Array<Record<string, unknown>>) {
    const name = String(row.key);
    if (typeof row.key !== "string" || rowKeys.has(name)) problems.push(`row key ${name}`);
    rowKeys.add(name);
    if (!ROW_KINDS.has(row.kind as ReportTableRowKind)) problems.push(`row ${name} kind ${String(row.kind)}`);
    if (typeof row.label !== "string") problems.push(`row ${name} has no label`);
    if (!row.values || typeof row.values !== "object" || Array.isArray(row.values)) {
      problems.push(`row ${name} has no values`);
      continue;
    }
    for (const [key, figure] of Object.entries(row.values as Record<string, unknown>)) {
      if (!keys.has(key)) problems.push(`row ${name} has a value for column ${key}, which isn't a column`);
      if (figure !== null && (typeof figure !== "string" || !/^-?\d+(\.\d+)?$/.test(figure))) problems.push(`row ${name} ${key} is ${JSON.stringify(figure)}`);
    }
  }
  return problems;
}

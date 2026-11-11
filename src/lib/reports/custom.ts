import { type AccountClass, type AccountType, isAccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { financialYearStart } from "@/lib/financial-year";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { currencyMinorUnits } from "@/lib/money/currency";
import { abs, add, dec, type Decimal, divide, isZero, mul, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  CUSTOM_REPORT_BASES,
  CUSTOM_REPORT_LIMITS as LIMITS,
  type ComputedBlock,
  type ComputedLine,
  type ComputedRow,
  type CustomReportBase,
  type CustomReportFigures,
  type CustomReportLayout,
  type FinancialReportBase,
  type FormulaTerm,
  lastDayOfMonth,
  PERIOD_LENGTHS,
  type PeriodLength,
  periodColumns,
  type ReportBlock,
  type ReportColumn,
  type ReportColumnsSetting,
  type AddedColumn,
  addedColumnKey,
  type ReportRow,
  type ReportValues,
  type StoredCustomReportLayout,
  type TransactionCustomReportFigures,
  type TransactionReportLayout,
  isCashFlowBase,
  isEquityLayout,
  isTransactionReportBase,
  standardCashFlowLayout,
  standardEquityLayout,
  type CashFlowLayout,
  standardLayout,
  templateLayout,
} from "@/lib/reports/custom-layout";
import { accountTotals, type AccountTotalsRow, earningsOf, financialYearEndMonth, naturalAmount, type TrackingFilter } from "@/lib/reports/financial";
import { budgetTotals } from "@/lib/budgets/service";
import { columnHeading } from "@/lib/reports/report-dates";
import { valueWithDescendants } from "@/lib/tracking/service";
import { optionalSource, requireId, requireIdempotencyKey } from "@/lib/validation";
import { type CashFlowFigures, computeCashFlowLayout, parseCashFlowLayout } from "@/lib/reports/cash-flow-layout";
import { computeEquityLayout, type EquityFigures, parseEquityLayout } from "@/lib/reports/equity-layout";
import {
  computeTransactionCustomReport,
  parseTransactionReportLayout,
  templateTransactionReportLayout,
  validateTransactionTrackingFilter,
} from "@/lib/reports/transaction-custom";

/**
 * Custom reports (examples CR1-CR10). A draft's layout is validated here and
 * its figures worked out from the same account totals as the standard
 * reports; publishing stores a frozen copy. Nothing here posts to the ledger.
 */

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_LAYOUT_BYTES = 200_000;

export function text(input: unknown, what: string, maxLength: number, options: { required: boolean }): string {
  if (input == null) {
    if (options.required) throw new ValidationError(`${what} is required.`);
    return "";
  }
  if (typeof input !== "string") throw new ValidationError(`${what} must be text.`);
  const value = input.trim();
  if (options.required && value.length === 0) throw new ValidationError(`${what} is required.`);
  if (value.length > maxLength) throw new ValidationError(`${what} can be at most ${maxLength.toLocaleString("en-NZ")} characters.`);
  return value;
}

function bool(input: unknown, what: string): boolean {
  if (input == null) return false;
  if (typeof input !== "boolean") throw new ValidationError(`${what} must be true or false.`);
  return input;
}

export function record(input: unknown, what: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError(`${what} is missing.`);
  return input as Record<string, unknown>;
}

export function list(input: unknown, what: string, max: number): unknown[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new ValidationError(`${what} must be a list.`);
  if (input.length > max) throw new ValidationError(`${what} can have at most ${max} entries.`);
  return input;
}

export function parseColumns(base: FinancialReportBase, input: unknown): ReportColumnsSetting {
  const raw = record(input, "The columns");
  const periodEnd = parseIsoDate(raw.periodEnd, "periodEnd");
  if (lastDayOfMonth(periodEnd) !== periodEnd) {
    throw new ValidationError(`The columns must end on the last day of a month (for example ${lastDayOfMonth(periodEnd)}).`);
  }
  const periodLength = raw.periodLength;
  if (typeof periodLength !== "string" || !Object.hasOwn(PERIOD_LENGTHS, periodLength)) {
    throw new ValidationError("The period length must be months, quarters or years.");
  }
  const periodCount = raw.periodCount;
  if (typeof periodCount !== "number" || !Number.isInteger(periodCount) || periodCount < 1 || periodCount > LIMITS.periods) {
    throw new ValidationError(`A report has 1 to ${LIMITS.periods} period columns.`);
  }
  const difference = bool(raw.difference, "difference");
  const percent = bool(raw.percent, "percent");
  const yearToDate = bool(raw.yearToDate, "yearToDate");
  if (difference && periodCount < 2) throw new ValidationError("A difference column needs at least two period columns.");
  if (percent && !difference) throw new ValidationError("A % column needs the difference column.");
  if (yearToDate && base === "balance_sheet") throw new ValidationError("A balance sheet has no year to date column: each column is already as at a date.");
  // A budget column (BU7): profit and loss only, since budgets hold income and expense accounts.
  const budgetId = raw.budgetId == null || raw.budgetId === "" ? null : requireId(raw.budgetId, "budgetId");
  const budgetDifference = bool(raw.budgetDifference, "budgetDifference");
  if (budgetId && base === "balance_sheet") throw new ValidationError("A balance sheet has no budget column: budgets hold profit and loss accounts only.");
  if (budgetDifference && !budgetId) throw new ValidationError("A difference to budget column needs a budget column.");
  const keys = new Set<string>(Array.from({ length: periodCount }, (_, index) => `p${index}`));
  if (difference) keys.add("diff");
  if (yearToDate) keys.add("ytd");
  if (budgetId) keys.add("bud");
  if (budgetId && budgetDifference) keys.add("bdiff");
  const added = parseAddedColumns(base, raw.added, keys);
  return {
    periodEnd,
    periodLength: periodLength as PeriodLength,
    periodCount,
    difference,
    percent,
    yearToDate,
    ...(budgetId ? { budgetId, budgetDifference } : {}),
    ...(added.length > 0 ? { added } : {}),
  };
}

/**
 * Columns added with Add column (LE4-LE9, decision 1580). `amounts` holds the
 * keys of the columns before them that hold amounts; each added column can
 * use those and the amount columns added before it. A Percentage's row is
 * checked once the rows are known.
 */
function parseAddedColumns(base: FinancialReportBase, input: unknown, amounts: Set<string>): AddedColumn[] {
  const ids = new Set<string>();
  return list(input, "The added columns", LIMITS.addedColumns).map((entry, index): AddedColumn => {
    const raw = record(entry, "An added column");
    const what = `Added column ${index + 1}`;
    const id = raw.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id) || ids.has(id)) throw new ValidationError(`${what} needs an id of its own.`);
    ids.add(id);
    const heading = text(raw.heading, `${what}'s heading`, LIMITS.labelLength, { required: false });
    const common = { id, ...(heading ? { heading } : {}) };
    const usable = (value: unknown, which: string) => {
      if (typeof value !== "string" || !amounts.has(value)) throw new ValidationError(`${what}: choose the ${which} from the columns before it.`);
      return value;
    };
    const dates = () => {
      const to = parseIsoDate(raw.to, `${what}'s end date`);
      if (base === "balance_sheet") return { from: null, to };
      const from = parseIsoDate(raw.from, `${what}'s start date`);
      if (from > to) throw new ValidationError(`${what} starts after it ends.`);
      return { from, to };
    };
    let column: AddedColumn;
    switch (raw.kind) {
      case "date":
        column = { ...common, kind: "date", ...dates() };
        break;
      case "budget": {
        if (base === "balance_sheet") throw new ValidationError("A balance sheet has no budget column: budgets hold profit and loss accounts only.");
        const { from, to } = dates();
        column = { ...common, kind: "budget", budgetId: requireId(raw.budgetId, `${what}'s budget`), from: from!, to };
        break;
      }
      case "formula": {
        const terms = list(raw.terms, `${what}'s columns`, LIMITS.termsPerFormula).map((term) => {
          const t = record(term, "A formula's column");
          if (t.sign !== 1 && t.sign !== -1) throw new ValidationError(`${what}: each column is added (1) or taken away (-1).`);
          return { column: usable(t.column, "columns"), sign: t.sign as 1 | -1 };
        });
        if (terms.length === 0) throw new ValidationError(`${what}: add at least one column to the formula.`);
        column = { ...common, kind: "formula", terms };
        break;
      }
      case "notes":
        column = { ...common, kind: "notes" };
        break;
      case "percentage": {
        if (typeof raw.ofRowId !== "string" || !ID_PATTERN.test(raw.ofRowId)) throw new ValidationError(`${what}: choose the row it's a % of.`);
        column = { ...common, kind: "percentage", column: usable(raw.column, "column"), ofRowId: raw.ofRowId };
        break;
      }
      case "variance":
        column = {
          ...common,
          kind: "variance",
          first: usable(raw.first, "first column"),
          second: usable(raw.second, "second column"),
          ...(bool(raw.percentOfSecond, "percentOfSecond") ? { percentOfSecond: true } : {}),
        };
        break;
      default:
        throw new ValidationError(`${what} is a date, budget, formula, notes, percentage or variance column.`);
    }
    // Later columns can use this one when it holds money.
    if (column.kind === "date" || column.kind === "budget" || column.kind === "formula" || (column.kind === "variance" && !column.percentOfSecond)) amounts.add(addedColumnKey(column));
    return column;
  });
}

function parseRow(base: FinancialReportBase, input: unknown, ids: Set<string>): ReportRow {
  const raw = record(input, "A row");
  const id = raw.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new ValidationError("Each row needs an id of letters, numbers, - or _.");
  if (ids.has(id)) throw new ValidationError(`Two rows or blocks share the id ${id}.`);
  ids.add(id);
  const label = text(raw.label, "A row's name", LIMITS.labelLength, { required: true });
  const row = parseRowBody(base, raw, id, label);
  // What any row can carry (decision 1360): hidden, a page break after it, a note.
  const note = text(raw.note, `The note on ${label}`, LIMITS.rowNoteLength, { required: false });
  const cells: Record<string, string> = {};
  if (raw.cells != null) {
    const given = record(raw.cells, `${label}'s notes columns`);
    const entries = Object.entries(given);
    if (entries.length > LIMITS.addedColumns) throw new ValidationError(`${label} has too many notes columns.`);
    for (const [key, value] of entries) {
      if (!/^a_[A-Za-z0-9_-]{1,40}$/.test(key)) throw new ValidationError(`${label}'s notes column ${key} isn't a notes column.`);
      const cell = text(value, `${label}'s note in a notes column`, LIMITS.cellLength, { required: false });
      if (cell) cells[key] = cell;
    }
  }
  return {
    ...row,
    ...(bool(raw.hidden, "hidden") ? { hidden: true } : {}),
    ...(bool(raw.pageBreakAfter, "pageBreakAfter") ? { pageBreakAfter: true } : {}),
    ...(note ? { note } : {}),
    ...(Object.keys(cells).length > 0 ? { cells } : {}),
  };
}

const NUMBER = /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;

function parseRowBody(base: FinancialReportBase, raw: Record<string, unknown>, id: string, label: string): ReportRow {
  switch (raw.kind) {
    case "heading":
      return { id, kind: "heading", label };
    case "group": {
      const types = list(raw.accountTypes, `The account types of ${label}`, 20);
      for (const type of types) {
        if (!isAccountType(type)) throw new ValidationError(`${String(type)} isn't an account type.`);
      }
      const codes = list(raw.accountCodes, `The accounts of ${label}`, LIMITS.accountCodesPerGroup).map((code) =>
        text(code, `An account code in ${label}`, 20, { required: true }),
      );
      if (types.length === 0 && codes.length === 0) throw new ValidationError(`Choose the accounts or account types for ${label}.`);
      const except = list(raw.exceptCodes, `The accounts left out of ${label}`, LIMITS.accountCodesPerGroup).map((code) =>
        text(code, `An account code left out of ${label}`, 20, { required: true }),
      );
      return {
        id,
        kind: "group",
        label,
        accountTypes: [...new Set(types as AccountType[])],
        accountCodes: [...new Set(codes)],
        ...(except.length > 0 && codes.length === 0 ? { exceptCodes: [...new Set(except)] } : {}),
        showAccounts: bool(raw.showAccounts, "showAccounts"),
      };
    }
    case "formula": {
      const operation = raw.operation ?? "sum";
      if (operation !== "sum") {
        if (operation !== "multiply" && operation !== "divide" && operation !== "percent") {
          throw new ValidationError(`${label} must add up rows, multiply, divide or be a % of a row.`);
        }
        const rowRef = (value: unknown, what: string) => {
          if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new ValidationError(`Choose ${what} for ${label}.`);
          return value;
        };
        const a = rowRef(raw.a, "the first row");
        if (operation !== "percent" && raw.by != null && raw.by !== "") {
          const by = String(raw.by).trim();
          if (!NUMBER.test(by)) throw new ValidationError(`${label}: ${String(raw.by)} isn't a number.`);
          return { id, kind: "formula", label, terms: [], operation, a, by };
        }
        return { id, kind: "formula", label, terms: [], operation, a, b: rowRef(raw.b, operation === "percent" ? "the row it's a % of" : "the second row or a number") };
      }
      const terms = list(raw.terms, `The rows ${label} adds up`, LIMITS.termsPerFormula).map((term): FormulaTerm => {
        const t = record(term, `A part of ${label}`);
        if (typeof t.rowId !== "string" || !ID_PATTERN.test(t.rowId)) throw new ValidationError(`A part of ${label} has no row.`);
        if (t.sign !== 1 && t.sign !== -1) throw new ValidationError(`Each part of ${label} is added (1) or subtracted (-1).`);
        return { rowId: t.rowId, sign: t.sign };
      });
      if (terms.length === 0) throw new ValidationError(`Choose the rows ${label} adds up.`);
      return { id, kind: "formula", label, terms };
    }
    case "earnings":
      if (base !== "balance_sheet") throw new ValidationError("Earnings rows are only on balance sheets.");
      if (raw.which !== "previous" && raw.which !== "current") throw new ValidationError(`${label} must be previous or current year earnings.`);
      return { id, kind: "earnings", label, which: raw.which };
    default:
      throw new ValidationError("A row is a heading, a group, a formula or an earnings row.");
  }
}

/** Formulas use rows of their own table, never themselves, directly or through other formulas (CR8). */
/** The rows a formula uses. */
export function formulaUses(row: Extract<ReportRow, { kind: "formula" }>): string[] {
  if ((row.operation ?? "sum") === "sum") return row.terms.map((term) => term.rowId);
  return [row.a!, ...(row.b ? [row.b] : [])];
}

function checkFormulas(rows: ReportRow[]): void {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.kind !== "formula") continue;
    for (const usedId of formulaUses(row)) {
      if (usedId === row.id) throw new ValidationError(`${row.label} can't use itself.`);
      const used = byId.get(usedId);
      if (!used) throw new ValidationError(`${row.label} uses a row that isn't in its table.`);
      if (used.kind === "heading") throw new ValidationError(`${row.label} can't use the heading ${used.label}.`);
      // A % is a % (CR17): adding it to money, or taking a % of it, would mix units.
      if (used.kind === "formula" && used.operation === "percent") {
        throw new ValidationError(`${row.label} can't use ${used.label}: it's a %.`);
      }
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (row: ReportRow) => {
    if (row.kind !== "formula" || state.get(row.id) === "done") return;
    if (state.get(row.id) === "visiting") throw new ValidationError(`${row.label} uses itself through another formula.`);
    state.set(row.id, "visiting");
    for (const usedId of formulaUses(row)) visit(byId.get(usedId)!);
    state.set(row.id, "done");
  };
  rows.forEach(visit);
}

/** Validates a layout from the editor (CR8). Unknown account codes are refused. */
export async function parseLayout(tx: OrgTx, base: FinancialReportBase, input: unknown): Promise<CustomReportLayout> {
  const raw = record(input, "The report");
  if (JSON.stringify(raw).length > MAX_LAYOUT_BYTES) throw new ValidationError("This report is too big to save.");
  const title = text(raw.title, "The title", LIMITS.titleLength, { required: true });
  const columns = parseColumns(base, raw.columns);
  const ids = new Set<string>();
  const blocks = list(raw.blocks, "The tables and notes", LIMITS.blocks).map((entry): ReportBlock => {
    const block = record(entry, "A table or note");
    const id = block.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new ValidationError("Each table and note needs an id of letters, numbers, - or _.");
    if (ids.has(id)) throw new ValidationError(`Two rows or blocks share the id ${id}.`);
    ids.add(id);
    const extras = bool(block.pageBreakAfter, "pageBreakAfter") ? { pageBreakAfter: true } : {};
    if (block.kind === "text") {
      return { id, kind: "text", text: text(block.text, "A note", LIMITS.noteLength, { required: true }), ...extras };
    }
    if (block.kind !== "table") throw new ValidationError("A block is a table or a note.");
    const rows = list(block.rows, "A table's rows", LIMITS.rowsPerTable).map((row) => parseRow(base, row, ids));
    checkFormulas(rows);
    return { id, kind: "table", title: text(block.title, "A table's title", LIMITS.labelLength, { required: false }), rows, ...extras };
  });
  const codes = new Set(
    blocks.flatMap((block) => (block.kind === "table" ? block.rows.flatMap((row) => (row.kind === "group" ? [...row.accountCodes, ...(row.exceptCodes ?? [])] : [])) : [])),
  );
  if (codes.size > 0) {
    const found = await tx.query<{ code: string }>("select code from accounts where code = any($1::text[])", [[...codes]]);
    const known = new Set(found.rows.map((row) => row.code));
    const unknown = [...codes].filter((code) => !known.has(code));
    if (unknown.length > 0) throw new ValidationError(`There's no account ${unknown.join(", ")}.`);
  }
  if (columns.budgetId) {
    const budget = await tx.query("select 1 from budgets where id = $1", [columns.budgetId]);
    if (budget.rowCount === 0) throw new ValidationError("There's no such budget.");
  }
  for (const added of columns.added ?? []) {
    if (added.kind === "budget") {
      const budget = await tx.query("select 1 from budgets where id = $1", [added.budgetId]);
      if (budget.rowCount === 0) throw new ValidationError("There's no such budget.");
    }
    if (added.kind === "percentage" && !ids.has(added.ofRowId)) throw new ValidationError("A percentage column's row isn't in the report.");
  }
  // A row's text only goes in a Notes column that exists.
  const notesKeys = new Set((columns.added ?? []).filter((added) => added.kind === "notes").map(addedColumnKey));
  for (const block of blocks) {
    if (block.kind !== "table") continue;
    for (const row of block.rows) for (const key of Object.keys(row.cells ?? {})) if (!notesKeys.has(key)) delete row.cells![key];
  }
  let filter: CustomReportLayout["filter"] = null;
  if (raw.filter != null) {
    const f = record(raw.filter, "The filter");
    if (base !== "profit_and_loss") throw new ValidationError("Only a profit and loss can be filtered by a tracking category.");
    const categoryId = requireId(f.categoryId, "filter category");
    const valueId = requireId(f.valueId, "filter value");
    const found = await tx.query("select 1 from tracking_values where id = $1 and category_id = $2", [valueId, categoryId]);
    if (found.rowCount === 0) throw new ValidationError("The filter's value isn't in its tracking category.");
    filter = { categoryId, valueId };
  }
  return { title, columns, blocks, ...(filter ? { filter } : {}) };
}

type Account = { id: string; code: string; name: string; accountClass: AccountClass; accountType: AccountType };

const SCOPE: Record<FinancialReportBase, AccountClass[]> = {
  profit_and_loss: ["revenue", "expense"],
  balance_sheet: ["asset", "liability", "equity"],
};

function groupIncludes(row: Extract<ReportRow, { kind: "group" }>, account: Account): boolean {
  if (row.accountCodes.length > 0) return row.accountCodes.includes(account.code);
  return row.accountTypes.includes(account.accountType) && !(row.exceptCodes ?? []).includes(account.code);
}

/**
 * Run instead of the layout's own columns and filter (decision 1359): the
 * standard report's toolbar dates, comparisons and tracking filter, when the
 * standard profit and loss or balance sheet shows its default layout.
 */
export type CustomReportRunOptions = {
  /** Period and year to date columns with their dates, in order. */
  columns?: ReportColumn[];
  /** Replaces the layout's filter; null for none. */
  filter?: { categoryId: string; valueIds: string[]; unassigned?: boolean; label: string } | null;
};

/** Works out a layout's figures (CR1-CR6, CR9, CR16-CR18). */
export async function computeCustomReport(
  tx: OrgTx,
  base: FinancialReportBase,
  layout: CustomReportLayout,
  options: CustomReportRunOptions = {},
): Promise<CustomReportFigures> {
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);
  const yearEndMonth = await financialYearEndMonth(tx);
  const setting: ReportColumnsSetting = options.columns
    ? { ...layout.columns, difference: false, percent: false, yearToDate: false, budgetId: undefined, budgetDifference: false, added: undefined }
    : layout.columns;
  const added = setting.added ?? [];
  let trackingFilter: TrackingFilter | null = null;
  let filterLabel: string | null = null;
  if (options.filter !== undefined) {
    trackingFilter = options.filter;
    filterLabel = options.filter?.label ?? null;
  } else if (layout.filter && base === "profit_and_loss") {
    trackingFilter = { categoryId: layout.filter.categoryId, valueIds: await valueWithDescendants(tx, layout.filter.valueId) };
    const label = await tx.query<{ category: string; value: string }>(
      "select c.name as category, v.name as value from tracking_values v join tracking_categories c on c.id = v.category_id where v.id = $1",
      [layout.filter.valueId],
    );
    filterLabel = label.rows[0] ? `${label.rows[0].category}: ${label.rows[0].value}` : null;
  }

  // The columns that hold amounts: each period, and the year to date.
  const amountColumns: ReportColumn[] = options.columns ? options.columns.map((column) => ({ ...column })) : periodColumns(base, setting);
  if (setting.yearToDate && base === "profit_and_loss") {
    const from = financialYearStart(setting.periodEnd, yearEndMonth);
    amountColumns.push({ key: "ytd", kind: "year_to_date", label: "Year to date", from, to: setting.periodEnd });
  }
  // The budget for the first period (BU7).
  let budgetAmounts: Map<string, Decimal> | null = null;
  if (setting.budgetId && base === "profit_and_loss") {
    const first = amountColumns[0];
    const found = await tx.query<{ name: string }>("select name from budgets where id = $1", [setting.budgetId]);
    budgetAmounts = await budgetTotals(tx, setting.budgetId, first.from!, first.to!);
    amountColumns.push({ key: "bud", kind: "budget", label: `Budget (${found.rows[0]?.name ?? `#${setting.budgetId}`})`, from: first.from, to: first.to });
  }
  // Added date and budget columns hold amounts too (LE5, LE6).
  const budgetMaps = new Map<string, Map<string, Decimal>>();
  if (budgetAmounts) budgetMaps.set("bud", budgetAmounts);
  for (const column of added) {
    const key = addedColumnKey(column);
    if (column.kind === "date") {
      const label = column.heading || columnHeading(column.from, column.to);
      amountColumns.push({ key, kind: "date", label, from: column.from, to: column.to });
    } else if (column.kind === "budget") {
      const found = await tx.query<{ name: string }>("select name from budgets where id = $1", [column.budgetId]);
      budgetMaps.set(key, await budgetTotals(tx, column.budgetId, column.from, column.to));
      amountColumns.push({ key, kind: "budget", label: column.heading || `Budget (${found.rows[0]?.name ?? `#${column.budgetId}`})`, from: column.from, to: column.to });
    }
  }
  // Period and year to date amounts open their accounts' transactions: a profit
  // and loss from the column's start, a balance sheet from its financial year's (decision 1356).
  for (const column of amountColumns) {
    if (column.kind === "period" || column.kind === "year_to_date" || column.kind === "date") {
      column.drillFrom = base === "balance_sheet" ? financialYearStart(column.to!, yearEndMonth) : column.from;
    }
  }
  const columns: ReportColumn[] = [...amountColumns.filter((c) => c.kind === "period")];
  if (setting.difference) columns.push({ key: "diff", kind: "difference", label: "Difference", from: null, to: null });
  if (setting.percent) columns.push({ key: "pct", kind: "percent", label: "%", from: null, to: null });
  columns.push(...amountColumns.filter((c) => c.kind === "budget" && c.key === "bud"));
  if (budgetAmounts && setting.budgetDifference) columns.push({ key: "bdiff", kind: "budget_difference", label: "Actual less budget", from: null, to: null });
  columns.push(...amountColumns.filter((c) => c.kind === "year_to_date"));
  // Added columns, in their order, after the rest (LE4).
  for (const column of added) {
    const key = addedColumnKey(column);
    if (column.kind === "date" || column.kind === "budget") {
      columns.push(amountColumns.find((entry) => entry.key === key)!);
      continue;
    }
    const label =
      column.heading ||
      (column.kind === "formula" ? "Formula" : column.kind === "notes" ? "Notes" : column.kind === "percentage" ? "%" : column.percentOfSecond ? "Variance %" : "Variance");
    const format = column.kind === "notes" ? ("text" as const) : column.kind === "percentage" || (column.kind === "variance" && column.percentOfSecond) ? ("percent" as const) : undefined;
    columns.push({ key, kind: column.kind, label, from: null, to: null, ...(format ? { format } : {}) });
  }

  const accountsResult = await tx.query<{ id: string; code: string; name: string; account_class: AccountClass; account_type: AccountType }>(
    "select id, code, name, account_class, account_type from accounts order by code",
  );
  const accounts: Account[] = accountsResult.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    accountClass: row.account_class,
    accountType: row.account_type,
  }));

  // Each account's amount in its natural direction, per amount column, and the earnings lines.
  const amounts = new Map<string, Map<string, Decimal>>();
  const earnings = new Map<string, { previous: Decimal; current: Decimal }>();
  for (const column of amountColumns) {
    if (column.kind === "budget") {
      amounts.set(column.key, budgetMaps.get(column.key) ?? new Map());
      continue;
    }
    const totals: AccountTotalsRow[] = await accountTotals(tx, column.from, column.to!, trackingFilter);
    const byAccount = new Map<string, Decimal>();
    for (const row of totals) byAccount.set(row.id, naturalAmount(row));
    amounts.set(column.key, byAccount);
    if (base === "balance_sheet") {
      const current = earningsOf(await accountTotals(tx, financialYearStart(column.to!, yearEndMonth), column.to!, trackingFilter));
      earnings.set(column.key, { current, previous: sub(earningsOf(totals), current) });
    }
  }
  const amountOf = (accountId: string, columnKey: string) => amounts.get(columnKey)?.get(accountId) ?? ZERO_DECIMAL;
  const hasAmount = (accountId: string) => amountColumns.some((column) => !isZero(amountOf(accountId, column.key)));

  type Values = Map<string, Decimal | null>;
  type Format = "money" | "number" | "percent";
  const shown = (value: Decimal | null, format: Format) => (value == null ? null : format === "percent" ? toFixedString(value, 1) : money(value));
  /** `rowValues` gives another row's amounts in this table, for a Percentage column; `cells`, a row's Notes text. */
  type Context = { rowValues?: (rowId: string) => Values | null; cells?: Record<string, string> };
  const withDerived = (values: Values, format: Format = "money", context: Context = {}): ReportValues => {
    const out: ReportValues = {};
    const numbers = new Map(values);
    for (const column of amountColumns) out[column.key] = shown(values.get(column.key) ?? (format === "money" ? ZERO_DECIMAL : null), format);
    if (setting.difference) {
      const first = values.get("p0") ?? null;
      const second = values.get("p1") ?? null;
      const difference = first == null || second == null ? null : sub(first, second);
      out.diff = shown(difference, format);
      numbers.set("diff", difference);
      if (setting.percent) {
        // A change in a % is in points, so it has no % change of its own.
        out.pct = difference == null || second == null || isZero(second) || format === "percent" ? null : toFixedString(divide(mul(difference, dec("100")), abs(second), 1), 1);
      }
    }
    if (budgetAmounts && setting.budgetDifference) {
      const actual = values.get("p0") ?? null;
      const budget = values.get("bud") ?? null;
      const budgetDifference = actual == null || budget == null ? null : sub(actual, budget);
      out.bdiff = shown(budgetDifference, format);
      numbers.set("bdiff", budgetDifference);
    }
    // Added columns, in order (LE7-LE9): each can use the amounts before it.
    const percentOf = (part: Decimal | null, whole: Decimal | null) => (part == null || whole == null || isZero(whole) ? null : toFixedString(divide(mul(part, dec("100")), abs(whole), 1), 1));
    for (const column of added) {
      const key = addedColumnKey(column);
      if (column.kind === "formula") {
        let total: Decimal | null = ZERO_DECIMAL;
        for (const term of column.terms) {
          const part = numbers.get(term.column) ?? null;
          total = total == null || part == null ? null : term.sign === 1 ? add(total, part) : sub(total, part);
        }
        numbers.set(key, total);
        out[key] = shown(total, format);
      } else if (column.kind === "variance") {
        const first = numbers.get(column.first) ?? null;
        const second = numbers.get(column.second) ?? null;
        const variance = first == null || second == null ? null : sub(first, second);
        if (column.percentOfSecond) out[key] = format === "percent" ? null : percentOf(variance, second);
        else {
          numbers.set(key, variance);
          out[key] = shown(variance, format);
        }
      } else if (column.kind === "percentage") {
        const whole = context.rowValues?.(column.ofRowId)?.get(column.column) ?? null;
        out[key] = format === "money" ? percentOf(numbers.get(column.column) ?? null, whole) : null;
      } else if (column.kind === "notes") {
        out[key] = context.cells?.[key] ?? null;
      }
    }
    return out;
  };
  const accountValues = (account: Account) => new Map(amountColumns.map((column) => [column.key, amountOf(account.id, column.key)]));

  const inGroups = new Set<string>();
  const inSeveralGroups: CustomReportFigures["inSeveralGroups"] = [];
  const blocks: ComputedBlock[] = layout.blocks.map((block): ComputedBlock => {
    const blockExtras = block.pageBreakAfter ? { pageBreakAfter: true } : {};
    if (block.kind === "text") return { id: block.id, kind: "text", text: block.text, ...blockExtras };
    const rowsById = new Map(block.rows.map((row) => [row.id, row]));
    const memo = new Map<string, Values>();
    const groupsOfAccount = new Map<string, string[]>();
    const formatOf = (row: ReportRow): Format =>
      row.kind !== "formula" || (row.operation ?? "sum") === "sum"
        ? row.kind === "formula" && row.terms.some((term) => formatOf(rowsById.get(term.rowId)!) === "number")
          ? "number"
          : "money"
        : row.operation === "percent"
          ? "percent"
          : row.operation === "divide" && !row.by
            ? "number"
            : formatOf(rowsById.get(row.a!)!) === "number"
              ? "number"
              : "money";
    const valuesOf = (row: ReportRow): Values => {
      const known = memo.get(row.id);
      if (known) return known;
      const values: Values = new Map();
      for (const column of amountColumns) {
        let total: Decimal | null = ZERO_DECIMAL;
        if (row.kind === "group") {
          for (const account of accounts) if (groupIncludes(row, account)) total = add(total!, amountOf(account.id, column.key));
        } else if (row.kind === "formula" && (row.operation ?? "sum") === "sum") {
          for (const term of row.terms) {
            const part = valuesOf(rowsById.get(term.rowId)!).get(column.key) ?? null;
            // A blank part (a division by 0.00) makes the sum blank too.
            total = total == null || part == null ? null : term.sign === 1 ? add(total, part) : sub(total, part);
          }
        } else if (row.kind === "formula") {
          total = operate(row, valuesOf(rowsById.get(row.a!)!).get(column.key) ?? null, row.by ? dec(row.by) : (valuesOf(rowsById.get(row.b!)!).get(column.key) ?? null));
        } else if (row.kind === "earnings") {
          const found = earnings.get(column.key);
          total = found ? found[row.which] : ZERO_DECIMAL;
        }
        values.set(column.key, total);
      }
      memo.set(row.id, values);
      return values;
    };
    const rowValues = (rowId: string) => {
      const found = rowsById.get(rowId);
      return found && found.kind !== "heading" ? valuesOf(found) : null;
    };
    const rows = block.rows.map((row): ComputedRow => {
      const extras = { ...(row.hidden ? { hidden: true } : {}), ...(row.pageBreakAfter ? { pageBreakAfter: true } : {}), ...(row.note ? { note: row.note } : {}) };
      if (row.kind === "heading") return { id: row.id, kind: "heading", label: row.label, values: {}, showAccounts: false, lines: [], ...extras };
      const lines: ComputedLine[] = [];
      if (row.kind === "group") {
        for (const account of accounts) {
          if (!groupIncludes(row, account)) continue;
          inGroups.add(account.id);
          if (!hasAmount(account.id)) continue;
          groupsOfAccount.set(account.id, [...(groupsOfAccount.get(account.id) ?? []), row.label]);
          lines.push({ code: account.code, name: account.name, values: withDerived(accountValues(account), "money", { rowValues }), accountId: String(account.id) });
        }
      }
      const format = formatOf(row);
      return {
        id: row.id,
        kind: row.kind,
        label: row.label,
        values: withDerived(valuesOf(row), format, { rowValues, cells: row.cells }),
        ...(format === "money" ? {} : { format }),
        ...extras,
        showAccounts: row.kind === "group" && row.showAccounts,
        lines,
        ...(row.kind === "group" ? { accountIds: lines.map((line) => line.accountId!) } : {}),
      };
    });
    for (const [accountId, groups] of groupsOfAccount) {
      if (groups.length < 2) continue;
      const account = accounts.find((entry) => entry.id === accountId)!;
      inSeveralGroups.push({ tableTitle: block.title, code: account.code, name: account.name, groups });
    }
    return { id: block.id, kind: "table", title: block.title, rows, ...blockExtras };
  });

  const notInReport = accounts
    .filter((account) => SCOPE[base].includes(account.accountClass) && !inGroups.has(account.id) && hasAmount(account.id))
    .map((account) => ({ code: account.code, name: account.name, values: withDerived(accountValues(account)) }));

  return {
    title: layout.title,
    base,
    currencyCode: tx.baseCurrency,
    columns,
    blocks,
    notInReport,
    inSeveralGroups,
    filterLabel,
    computedAt: new Date().toISOString(),
  };
}

/**
 * A × ÷ or % of formula (decision 1361, CR17), in decimal maths: × and ÷
 * keep 6 places until shown (money is then rounded to the currency's cents,
 * halves away from zero), a % is to 1 place. Dividing by 0.00, or using a
 * blank, gives a blank.
 */
function operate(row: Extract<ReportRow, { kind: "formula" }>, a: Decimal | null, b: Decimal | null): Decimal | null {
  if (a == null || b == null) return null;
  switch (row.operation) {
    case "multiply":
      return mul(a, b);
    case "divide":
      return isZero(b) ? null : divide(a, b, 6);
    case "percent":
      return isZero(b) ? null : divide(mul(a, dec("100")), b, 6);
    default:
      return null;
  }
}

export type CustomReport = {
  id: string;
  kind: "draft" | "published";
  base: CustomReportBase;
  title: string;
  layout: StoredCustomReportLayout;
  version: number;
  publishedFromId: string | null;
  publishedAt: string | null;
  publishedByEmail: string | null;
  archivedAt: string | null;
  archivedByEmail: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedByEmail: string | null;
  updatedAt: string;
};

export type CustomReportView = "drafts" | "published" | "archived";

type ReportRecord = {
  id: string;
  kind: "draft" | "published";
  base: CustomReportBase;
  title: string;
  layout: StoredCustomReportLayout;
  version: number;
  published_from_id: string | null;
  published_at: string | null;
  published_by_email: string | null;
  archived_at: string | null;
  archived_by_email: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_by_email: string | null;
  updated_at: string;
};

const COLUMNS = `id, kind, base, title, layout, version, published_from_id, published_at, published_by_email,
  archived_at, archived_by_email, created_by_email, created_at, updated_by_email, updated_at`;

function toReport(row: ReportRecord): CustomReport {
  return {
    id: row.id,
    kind: row.kind,
    base: row.base,
    title: row.title,
    layout: row.layout,
    version: row.version,
    publishedFromId: row.published_from_id,
    publishedAt: row.published_at,
    publishedByEmail: row.published_by_email,
    archivedAt: row.archived_at,
    archivedByEmail: row.archived_by_email,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
  };
}

async function findReport(tx: OrgTx, id: string, lock = false): Promise<CustomReport> {
  const found = await tx.query<ReportRecord>(`select ${COLUMNS} from custom_reports where id = $1${lock ? " for update" : ""}`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Report not found.");
  return toReport(found.rows[0]);
}

export async function listCustomReports(tx: OrgTx, viewInput: unknown): Promise<CustomReport[]> {
  const view = viewInput ?? "drafts";
  if (view !== "drafts" && view !== "published" && view !== "archived") throw new ValidationError("view must be drafts, published or archived.");
  const where =
    view === "archived" ? "archived_at is not null" : view === "published" ? "kind = 'published' and archived_at is null" : "kind = 'draft' and archived_at is null";
  const found = await tx.query<ReportRecord>(`select ${COLUMNS} from custom_reports where ${where} order by coalesce(published_at, updated_at) desc, id desc limit 500`);
  return found.rows.map(toReport);
}

/** A report and its figures: worked out now for a draft, as stored for a published copy (CR7). */
export type AnyCustomReportFigures = CustomReportFigures | TransactionCustomReportFigures | CashFlowFigures | EquityFigures;

async function computeSavedReport(tx: OrgTx, base: CustomReportBase, layout: StoredCustomReportLayout): Promise<AnyCustomReportFigures> {
  if (isEquityLayout(base, layout)) return computeEquityLayout(tx, layout);
  if (isTransactionReportBase(base)) return computeTransactionCustomReport(tx, base, layout as TransactionReportLayout);
  if (isCashFlowBase(base)) return computeCashFlowLayout(tx, layout as CashFlowLayout);
  return computeCustomReport(tx, base as FinancialReportBase, layout as CustomReportLayout);
}

export async function getCustomReport(tx: OrgTx, idInput: unknown): Promise<{ report: CustomReport; figures: AnyCustomReportFigures }> {
  const id = requireId(idInput, "reportId");
  const report = await findReport(tx, id);
  if (report.kind === "published") {
    const stored = await tx.query<{ snapshot: AnyCustomReportFigures }>("select snapshot from custom_reports where id = $1", [id]);
    return { report, figures: stored.rows[0].snapshot };
  }
  return { report, figures: await computeSavedReport(tx, report.base, report.layout) };
}

function parseBase(input: unknown): CustomReportBase {
  if (typeof input !== "string" || !Object.hasOwn(CUSTOM_REPORT_BASES, input)) {
    throw new ValidationError("Choose one of the available standard reports.");
  }
  return input as CustomReportBase;
}

/** Starts a draft as a copy of a standard report (CR1, CR6). */
export async function createCustomReport(
  tx: OrgTx,
  command: { source?: unknown; idempotencyKey: unknown; base: unknown; periodEnd?: unknown; layout?: unknown; start?: unknown },
): Promise<{ created: boolean; report: CustomReport }> {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const base = parseBase(command.base);
  const periodEnd = command.periodEnd == null || command.periodEnd === "" ? lastDayOfMonth(todayIsoDate()) : parseIsoDate(command.periodEnd, "periodEnd");
  // A profit and loss or balance sheet starts from its template, the standard
  // report's rows (`start: "standard"`, Edit layout, decision 1359), or a
  // layout given ("Save as" from the editor).
  // Changes in equity starts as a layout (CEL1); one given as a list stays a list (CRS1).
  const layout: StoredCustomReportLayout = isCashFlowBase(base)
    ? command.layout == null
      ? standardCashFlowLayout(periodEnd)
      : await parseCashFlowLayout(tx, command.layout)
    : base === "changes_in_equity" && (command.layout == null || isEquityLayout(base, command.layout))
      ? command.layout == null
        ? standardEquityLayout(periodEnd)
        : await parseEquityLayout(tx, command.layout)
    : isTransactionReportBase(base)
    ? command.layout == null
      ? templateTransactionReportLayout(base, periodEnd)
      : await parseTransactionReportLayout(tx, base, command.layout)
    : command.layout != null
      ? await parseLayout(tx, base as FinancialReportBase, command.layout)
      : command.start === "standard"
        ? standardLayout(base as FinancialReportBase, periodEnd)
        : templateLayout(base as FinancialReportBase, periodEnd);
  if (isTransactionReportBase(base) && !isEquityLayout(base, layout)) await validateTransactionTrackingFilter(tx, (layout as TransactionReportLayout).filters);
  const hash = requestHash("custom_report_create", { base, layout });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id, request_hash from custom_reports where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "report");
    return { created: false, report: await findReport(tx, earlier.rows[0].id) };
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into custom_reports (kind, base, title, layout, command_source, idempotency_key, request_hash, created_by_user_id, created_by_email, updated_by_email)
     values ('draft', $1, $2, $3::jsonb, $4, $5, $6, $7, $8, $8) returning id`,
    [base, layout.title, JSON.stringify(layout), source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "custom_report.created", entityType: "custom_report", entityId: id, details: { base } });
  return { created: true, report: await findReport(tx, id) };
}

/** Saves a draft's layout (CR2-CR5). `version` must be the one the editor loaded. */
export async function updateCustomReport(
  tx: OrgTx,
  idInput: unknown,
  command: { layout: unknown; version: unknown },
): Promise<{ report: CustomReport; figures: AnyCustomReportFigures }> {
  const id = requireId(idInput, "reportId");
  const current = await findReport(tx, id, true);
  if (current.kind === "published") throw new ConflictError("A published report can't be changed. Change its draft and publish again.");
  if (current.archivedAt) throw new ConflictError("This report is archived. Bring it back to change it.");
  if (command.version !== current.version) {
    throw new ConflictError("Someone else has changed this report since you opened it. Reload it to see their changes.");
  }
  // A changes in equity report stays a layout or a list, as it was made (CEL5).
  const layout: StoredCustomReportLayout = isCashFlowBase(current.base)
    ? await parseCashFlowLayout(tx, command.layout)
    : isEquityLayout(current.base, current.layout)
      ? await parseEquityLayout(tx, command.layout)
    : isTransactionReportBase(current.base)
    ? await parseTransactionReportLayout(tx, current.base, command.layout)
    : await parseLayout(tx, current.base as FinancialReportBase, command.layout);
  if (isTransactionReportBase(current.base) && !isEquityLayout(current.base, layout)) await validateTransactionTrackingFilter(tx, (layout as TransactionReportLayout).filters);
  await tx.query(
    `update custom_reports set title = $2, layout = $3::jsonb, version = version + 1, updated_by_email = $4, updated_at = now() where id = $1`,
    [id, layout.title, JSON.stringify(layout), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "custom_report.updated", entityType: "custom_report", entityId: id, details: { title: layout.title } });
  const report = await findReport(tx, id);
  return { report, figures: await computeSavedReport(tx, report.base, report.layout) };
}

/** A draft's figures for a layout that isn't saved yet, so the editor can show changes before Save (decision 1360). Saves nothing. */
export async function previewCustomReport(tx: OrgTx, idInput: unknown, layoutInput: unknown): Promise<AnyCustomReportFigures> {
  const id = requireId(idInput, "reportId");
  const report = await findReport(tx, id);
  if (report.kind === "published") throw new ConflictError("A published report can't be changed.");
  if (isEquityLayout(report.base, report.layout)) return computeEquityLayout(tx, await parseEquityLayout(tx, layoutInput));
  if (isTransactionReportBase(report.base)) return computeTransactionCustomReport(tx, report.base, await parseTransactionReportLayout(tx, report.base, layoutInput));
  if (isCashFlowBase(report.base)) return computeCashFlowLayout(tx, await parseCashFlowLayout(tx, layoutInput));
  return computeCustomReport(tx, report.base as FinancialReportBase, await parseLayout(tx, report.base as FinancialReportBase, layoutInput));
}

/** Keeps a frozen copy of a draft: its layout and today's figures (CR7). */
export async function publishCustomReport(
  tx: OrgTx,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; report: CustomReport }> {
  const id = requireId(idInput, "reportId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const draft = await findReport(tx, id, true);
  const hash = requestHash("custom_report_publish", { id, version: draft.version });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id, request_hash from custom_reports where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "publish");
    return { created: false, report: await findReport(tx, earlier.rows[0].id) };
  }
  if (draft.kind !== "draft") throw new ConflictError("This report is already published.");
  if (draft.archivedAt) throw new ConflictError("This report is archived. Bring it back to publish it.");
  const figures = await computeSavedReport(tx, draft.base, draft.layout);
  const inserted = await tx.query<{ id: string }>(
    `insert into custom_reports (kind, base, title, layout, command_source, idempotency_key, request_hash, published_from_id,
                                 snapshot, published_by_email, published_at, created_by_user_id, created_by_email, updated_by_email)
     values ('published', $1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9, now(), $10, $9, $9) returning id`,
    [draft.base, draft.title, JSON.stringify(draft.layout), source, idempotencyKey, hash, id, JSON.stringify(figures), tx.actor.email, tx.actor.userId],
  );
  const publishedId = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "custom_report.published",
    entityType: "custom_report",
    entityId: publishedId,
    details: { draftId: id, title: draft.title },
  });
  return { created: true, report: await findReport(tx, publishedId) };
}

/** Archives a draft or published report, or brings it back (CR7). Doing it twice changes nothing. */
export async function setCustomReportArchived(tx: OrgTx, idInput: unknown, archived: boolean): Promise<CustomReport> {
  const id = requireId(idInput, "reportId");
  const report = await findReport(tx, id, true);
  if (Boolean(report.archivedAt) === archived) return report;
  // An archived draft stops being a default layout (decision 1359).
  if (archived) await tx.query("delete from report_layout_defaults where custom_report_id = $1", [id]);
  await tx.query(
    archived
      ? "update custom_reports set archived_at = now(), archived_by_email = $2 where id = $1"
      : "update custom_reports set archived_at = null, archived_by_email = null where id = $1",
    archived ? [id, tx.actor.email] : [id],
  );
  await writeAuditEvent(tx, {
    eventType: archived ? "custom_report.archived" : "custom_report.restored",
    entityType: "custom_report",
    entityId: id,
    details: { title: report.title },
  });
  return findReport(tx, id);
}

/** Deletes a draft. Published reports are archived instead (CR7). */
export async function deleteCustomReport(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "reportId");
  const report = await findReport(tx, id, true);
  if (report.kind === "published") throw new ConflictError("A published report can't be deleted. Archive it instead.");
  await tx.query("delete from report_layout_defaults where custom_report_id = $1", [id]);
  await tx.query("delete from custom_reports where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "custom_report.deleted", entityType: "custom_report", entityId: id, details: { title: report.title } });
}

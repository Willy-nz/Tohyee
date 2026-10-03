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
  type ReportRow,
  type ReportValues,
  type StoredCustomReportLayout,
  type TransactionCustomReportFigures,
  type TransactionReportLayout,
  isTransactionReportBase,
  templateLayout,
} from "@/lib/reports/custom-layout";
import { accountTotals, type AccountTotalsRow, earningsOf, financialYearEndMonth, naturalAmount, type TrackingFilter } from "@/lib/reports/financial";
import { budgetTotals } from "@/lib/budgets/service";
import { valueWithDescendants } from "@/lib/tracking/service";
import { optionalSource, requireId, requireIdempotencyKey } from "@/lib/validation";
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

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_LAYOUT_BYTES = 200_000;

function text(input: unknown, what: string, maxLength: number, options: { required: boolean }): string {
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

function record(input: unknown, what: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError(`${what} is missing.`);
  return input as Record<string, unknown>;
}

function list(input: unknown, what: string, max: number): unknown[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new ValidationError(`${what} must be a list.`);
  if (input.length > max) throw new ValidationError(`${what} can have at most ${max} entries.`);
  return input;
}

function parseColumns(base: FinancialReportBase, input: unknown): ReportColumnsSetting {
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
  return {
    periodEnd,
    periodLength: periodLength as PeriodLength,
    periodCount,
    difference,
    percent,
    yearToDate,
    ...(budgetId ? { budgetId, budgetDifference } : {}),
  };
}

function parseRow(base: FinancialReportBase, input: unknown, ids: Set<string>): ReportRow {
  const raw = record(input, "A row");
  const id = raw.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new ValidationError("Each row needs an id of letters, numbers, - or _.");
  if (ids.has(id)) throw new ValidationError(`Two rows or blocks share the id ${id}.`);
  ids.add(id);
  const label = text(raw.label, "A row's name", LIMITS.labelLength, { required: true });
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
      return {
        id,
        kind: "group",
        label,
        accountTypes: [...new Set(types as AccountType[])],
        accountCodes: [...new Set(codes)],
        showAccounts: bool(raw.showAccounts, "showAccounts"),
      };
    }
    case "formula": {
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
function checkFormulas(rows: ReportRow[]): void {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.kind !== "formula") continue;
    for (const term of row.terms) {
      if (term.rowId === row.id) throw new ValidationError(`${row.label} can't use itself.`);
      const used = byId.get(term.rowId);
      if (!used) throw new ValidationError(`${row.label} uses a row that isn't in its table.`);
      if (used.kind === "heading") throw new ValidationError(`${row.label} can't use the heading ${used.label}.`);
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (row: ReportRow) => {
    if (row.kind !== "formula" || state.get(row.id) === "done") return;
    if (state.get(row.id) === "visiting") throw new ValidationError(`${row.label} uses itself through another formula.`);
    state.set(row.id, "visiting");
    for (const term of row.terms) visit(byId.get(term.rowId)!);
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
    if (block.kind === "text") {
      return { id, kind: "text", text: text(block.text, "A note", LIMITS.noteLength, { required: true }) };
    }
    if (block.kind !== "table") throw new ValidationError("A block is a table or a note.");
    const rows = list(block.rows, "A table's rows", LIMITS.rowsPerTable).map((row) => parseRow(base, row, ids));
    checkFormulas(rows);
    return { id, kind: "table", title: text(block.title, "A table's title", LIMITS.labelLength, { required: false }), rows };
  });
  const codes = new Set(blocks.flatMap((block) => (block.kind === "table" ? block.rows.flatMap((row) => (row.kind === "group" ? row.accountCodes : [])) : [])));
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
  return row.accountCodes.length > 0 ? row.accountCodes.includes(account.code) : row.accountTypes.includes(account.accountType);
}

/** Works out a layout's figures (CR1-CR6, CR9). */
export async function computeCustomReport(tx: OrgTx, base: FinancialReportBase, layout: CustomReportLayout): Promise<CustomReportFigures> {
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);
  const yearEndMonth = await financialYearEndMonth(tx);
  const setting = layout.columns;
  let trackingFilter: TrackingFilter | null = null;
  let filterLabel: string | null = null;
  if (layout.filter && base === "profit_and_loss") {
    trackingFilter = { categoryId: layout.filter.categoryId, valueIds: await valueWithDescendants(tx, layout.filter.valueId) };
    const label = await tx.query<{ category: string; value: string }>(
      "select c.name as category, v.name as value from tracking_values v join tracking_categories c on c.id = v.category_id where v.id = $1",
      [layout.filter.valueId],
    );
    filterLabel = label.rows[0] ? `${label.rows[0].category}: ${label.rows[0].value}` : null;
  }

  // The columns that hold amounts: each period, and the year to date.
  const amountColumns: ReportColumn[] = periodColumns(base, setting);
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
  const columns: ReportColumn[] = [...amountColumns.filter((c) => c.kind === "period")];
  if (setting.difference) columns.push({ key: "diff", kind: "difference", label: "Difference", from: null, to: null });
  if (setting.percent) columns.push({ key: "pct", kind: "percent", label: "%", from: null, to: null });
  columns.push(...amountColumns.filter((c) => c.kind === "budget"));
  if (budgetAmounts && setting.budgetDifference) columns.push({ key: "bdiff", kind: "budget_difference", label: "Actual less budget", from: null, to: null });
  columns.push(...amountColumns.filter((c) => c.kind === "year_to_date"));

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
      amounts.set(column.key, budgetAmounts ?? new Map());
      continue;
    }
    const totals: AccountTotalsRow[] = await accountTotals(tx, column.from, column.to!, trackingFilter);
    const byAccount = new Map<string, Decimal>();
    for (const row of totals) byAccount.set(row.id, naturalAmount(row));
    amounts.set(column.key, byAccount);
    if (base === "balance_sheet") {
      const current = earningsOf(await accountTotals(tx, financialYearStart(column.to!, yearEndMonth), column.to!));
      earnings.set(column.key, { current, previous: sub(earningsOf(totals), current) });
    }
  }
  const amountOf = (accountId: string, columnKey: string) => amounts.get(columnKey)?.get(accountId) ?? ZERO_DECIMAL;
  const hasAmount = (accountId: string) => amountColumns.some((column) => !isZero(amountOf(accountId, column.key)));

  const withDerived = (values: Map<string, Decimal>): ReportValues => {
    const out: ReportValues = {};
    for (const column of amountColumns) out[column.key] = money(values.get(column.key) ?? ZERO_DECIMAL);
    if (setting.difference) {
      const first = values.get("p0") ?? ZERO_DECIMAL;
      const second = values.get("p1") ?? ZERO_DECIMAL;
      const difference = sub(first, second);
      out.diff = money(difference);
      if (setting.percent) {
        out.pct = isZero(second) ? null : toFixedString(divide(mul(difference, dec("100")), abs(second), 1), 1);
      }
    }
    if (budgetAmounts && setting.budgetDifference) {
      out.bdiff = money(sub(values.get("p0") ?? ZERO_DECIMAL, values.get("bud") ?? ZERO_DECIMAL));
    }
    return out;
  };
  const accountValues = (account: Account) => new Map(amountColumns.map((column) => [column.key, amountOf(account.id, column.key)]));

  const inGroups = new Set<string>();
  const inSeveralGroups: CustomReportFigures["inSeveralGroups"] = [];
  const blocks: ComputedBlock[] = layout.blocks.map((block): ComputedBlock => {
    if (block.kind === "text") return { id: block.id, kind: "text", text: block.text };
    const rowsById = new Map(block.rows.map((row) => [row.id, row]));
    const memo = new Map<string, Map<string, Decimal>>();
    const groupsOfAccount = new Map<string, string[]>();
    const valuesOf = (row: ReportRow): Map<string, Decimal> => {
      const known = memo.get(row.id);
      if (known) return known;
      const values = new Map<string, Decimal>();
      for (const column of amountColumns) {
        let total = ZERO_DECIMAL;
        if (row.kind === "group") {
          for (const account of accounts) if (groupIncludes(row, account)) total = add(total, amountOf(account.id, column.key));
        } else if (row.kind === "formula") {
          for (const term of row.terms) {
            const part = valuesOf(rowsById.get(term.rowId)!).get(column.key) ?? ZERO_DECIMAL;
            total = term.sign === 1 ? add(total, part) : sub(total, part);
          }
        } else if (row.kind === "earnings") {
          const found = earnings.get(column.key);
          total = found ? found[row.which] : ZERO_DECIMAL;
        }
        values.set(column.key, total);
      }
      memo.set(row.id, values);
      return values;
    };
    const rows = block.rows.map((row): ComputedRow => {
      if (row.kind === "heading") return { id: row.id, kind: "heading", label: row.label, values: {}, showAccounts: false, lines: [] };
      const lines: ComputedLine[] = [];
      if (row.kind === "group") {
        for (const account of accounts) {
          if (!groupIncludes(row, account)) continue;
          inGroups.add(account.id);
          if (!hasAmount(account.id)) continue;
          groupsOfAccount.set(account.id, [...(groupsOfAccount.get(account.id) ?? []), row.label]);
          lines.push({ code: account.code, name: account.name, values: withDerived(accountValues(account)) });
        }
      }
      return {
        id: row.id,
        kind: row.kind,
        label: row.label,
        values: withDerived(valuesOf(row)),
        showAccounts: row.kind === "group" && row.showAccounts,
        lines,
      };
    });
    for (const [accountId, groups] of groupsOfAccount) {
      if (groups.length < 2) continue;
      const account = accounts.find((entry) => entry.id === accountId)!;
      inSeveralGroups.push({ tableTitle: block.title, code: account.code, name: account.name, groups });
    }
    return { id: block.id, kind: "table", title: block.title, rows };
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
export type AnyCustomReportFigures = CustomReportFigures | TransactionCustomReportFigures;

async function computeSavedReport(tx: OrgTx, base: CustomReportBase, layout: StoredCustomReportLayout): Promise<AnyCustomReportFigures> {
  if (isTransactionReportBase(base)) return computeTransactionCustomReport(tx, base, layout as TransactionReportLayout);
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
  command: { source?: unknown; idempotencyKey: unknown; base: unknown; periodEnd?: unknown; layout?: unknown },
): Promise<{ created: boolean; report: CustomReport }> {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const base = parseBase(command.base);
  const periodEnd = command.periodEnd == null || command.periodEnd === "" ? lastDayOfMonth(todayIsoDate()) : parseIsoDate(command.periodEnd, "periodEnd");
  const layout: StoredCustomReportLayout = isTransactionReportBase(base)
    ? command.layout == null
      ? templateTransactionReportLayout(base, periodEnd)
      : await parseTransactionReportLayout(tx, base, command.layout)
    : templateLayout(base as FinancialReportBase, periodEnd);
  if (isTransactionReportBase(base)) await validateTransactionTrackingFilter(tx, (layout as TransactionReportLayout).filters);
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
  const layout: StoredCustomReportLayout = isTransactionReportBase(current.base)
    ? await parseTransactionReportLayout(tx, current.base, command.layout)
    : await parseLayout(tx, current.base as FinancialReportBase, command.layout);
  if (isTransactionReportBase(current.base)) await validateTransactionTrackingFilter(tx, (layout as TransactionReportLayout).filters);
  await tx.query(
    `update custom_reports set title = $2, layout = $3::jsonb, version = version + 1, updated_by_email = $4, updated_at = now() where id = $1`,
    [id, layout.title, JSON.stringify(layout), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "custom_report.updated", entityType: "custom_report", entityId: id, details: { title: layout.title } });
  const report = await findReport(tx, id);
  return { report, figures: await computeSavedReport(tx, report.base, report.layout) };
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
  await tx.query("delete from custom_reports where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "custom_report.deleted", entityType: "custom_report", entityId: id, details: { title: report.title } });
}

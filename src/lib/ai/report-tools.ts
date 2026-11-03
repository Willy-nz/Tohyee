import { randomBytes } from "node:crypto";
import type { AiTool, JsonSchema } from "@/lib/ai/tools";
import { createCustomReport, getCustomReport, listCustomReports } from "@/lib/reports/custom";
import { CUSTOM_REPORT_BASES, type FinancialReportBase, isTransactionReportBase, lastDayOfMonth, standardLayout, templateLayout } from "@/lib/reports/custom-layout";
import { todayIsoDate } from "@/lib/dates";
import { listLayoutDefaults } from "@/lib/reports/report-layouts";
import { requireIdempotencyKey } from "@/lib/validation";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { budgetVsActual } from "@/lib/reports/budget-vs-actual";
import { balanceSheet, profitAndLoss, profitAndLossSplit, trialBalance } from "@/lib/reports/financial";
import { balanceSheetCompare, parseCompare, profitAndLossCompare } from "@/lib/reports/statement-compare";

/**
 * Report options for a connected AI (decision 1358): the standard profit and
 * loss, balance sheet and trial balance with the same compare and tracking
 * options as the screens (RX1-RX5), and budget vs actual (BU5, BU6, RX6).
 * They only read, through the screens' own report functions.
 */

const DATE: JsonSchema = { type: "string", format: "date", description: "A date as YYYY-MM-DD." };
const ID = (what: string): JsonSchema => ({ type: "string", description: `The ${what}'s id (from list_tracking).` });

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TRACKING_OPTIONS: Record<string, JsonSchema> = {
  trackingCategoryId: ID("tracking category"),
  trackingValueId: {
    type: "string",
    description: 'Only lines tagged with this value of the category (or a value under it), or "unassigned" for lines with no value in it.',
  },
};

export const COMPARE_OPTIONS: Record<string, JsonSchema> = {
  compare: { type: "integer", minimum: 0, maximum: 11, description: "How many earlier periods to show beside the chosen one." },
  compareBy: { type: "string", enum: ["month", "quarter", "year"], description: "The length of each earlier period. Default month." },
  order: {
    type: "string",
    enum: ["oldest_first", "newest_first"],
    description: "Which way the period columns run. Default oldest_first (the chosen period last). Total and Year to date columns always come after the periods.",
  },
};

export const PROFIT_AND_LOSS_SCHEMA = object({
  from: DATE,
  to: DATE,
  ...COMPARE_OPTIONS,
  total: { type: "boolean", description: "Add a Total column: the period columns added up." },
  yearToDate: { type: "boolean", description: "Add a Year to date column: from the start of the financial year to `to`." },
  percentOfIncome: { type: "boolean", description: "Add a % of trading income column beside each amount column (1 decimal place; null when there's no trading income)." },
  splitBy: { type: "string", description: "A tracking category id: one column per top-level value, Not set and Total. Can't be used with compare." },
  ...TRACKING_OPTIONS,
});

export const BALANCE_SHEET_SCHEMA = object({ asAt: DATE, ...COMPARE_OPTIONS, ...TRACKING_OPTIONS });
export const TRIAL_BALANCE_SCHEMA = object({ asAt: DATE, ...TRACKING_OPTIONS });

const tracking = (args: Record<string, unknown>) => ({ trackingCategoryId: args.trackingCategoryId, trackingValueId: args.trackingValueId });

export function runProfitAndLoss(tx: OrgTx, args: Record<string, unknown>): Promise<unknown> {
  const compare = parseCompare({ compare: args.compare, compareBy: args.compareBy, order: args.order, total: args.total, ytd: args.yearToDate, percent: args.percentOfIncome });
  const input = { from: args.from, to: args.to, ...tracking(args) };
  if (args.splitBy != null && args.splitBy !== "") {
    if (compare) throw new ValidationError("Use splitBy or the compare options, not both.");
    return profitAndLossSplit(tx, { ...input, categoryId: args.splitBy });
  }
  return compare ? profitAndLossCompare(tx, input, compare) : profitAndLoss(tx, input);
}

export function runBalanceSheet(tx: OrgTx, args: Record<string, unknown>): Promise<unknown> {
  const compare = parseCompare({ compare: args.compare, compareBy: args.compareBy, order: args.order });
  const input = { asAt: args.asAt, ...tracking(args) };
  return compare ? balanceSheetCompare(tx, input, compare) : balanceSheet(tx, input);
}

export function runTrialBalance(tx: OrgTx, args: Record<string, unknown>): Promise<unknown> {
  return trialBalance(tx, { asAt: args.asAt, ...tracking(args) });
}

const MONTH: JsonSchema = { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "A month as YYYY-MM." };

export const REPORT_READ_TOOLS: readonly AiTool[] = [
  {
    name: "budget_vs_actual",
    title: "Budget vs actual",
    level: "read",
    description:
      "Budget vs actual for whole months: each profit and loss account's actual, budget, variance (actual less budget) and variance % of the budget, with section totals, gross profit and net profit. budgetId from list_budgets. from and to are months (YYYY-MM); without from it starts at the beginning of the financial year. A budget for a tracking value compares with that value's lines only; for a budget without one, a tracking filter limits the actuals (the budget stays the whole budget, and `filter` says so).",
    inputSchema: object({ budgetId: { type: "string", description: "The budget's id (from list_budgets)." }, from: MONTH, to: MONTH, ...TRACKING_OPTIONS }, ["budgetId"]),
    run: (tx, args) => budgetVsActual(tx, { budgetId: args.budgetId, from: args.from, to: args.to, ...tracking(args) }),
  },
  {
    name: "list_custom_reports",
    title: "Custom reports",
    level: "read",
    description:
      "Saved custom reports (decision 1363): drafts (editable, worked out from the ledger when run), published (frozen copies) or archived. Each with its id, title, the standard report it started from, and whether it's the default layout of the standard profit and loss or balance sheet.",
    inputSchema: object({ view: { type: "string", enum: ["drafts", "published", "archived"], description: "Default drafts." } }),
    async run(tx, args) {
      const reports = await listCustomReports(tx, args.view ?? "drafts");
      const defaults = await listLayoutDefaults(tx);
      return {
        reports: reports.map((report) => ({
          reportId: report.id,
          title: report.title,
          kind: report.kind,
          startedFrom: CUSTOM_REPORT_BASES[report.base],
          base: report.base,
          archived: Boolean(report.archivedAt),
          defaultLayoutFor: defaults.find((entry) => entry.reportId === report.id)?.base ?? null,
          updatedAt: report.updatedAt,
          publishedAt: report.publishedAt,
        })),
      };
    },
  },
  {
    name: "run_custom_report",
    title: "Run a custom report",
    level: "read",
    description:
      "A custom report's figures: a draft is worked out from the ledger now; a published report gives its frozen figures as they were when published. Columns, then each table's rows (label, kind, values by column key; a formula row's format is money, number or percent; blank values are null, e.g. dividing by 0.00).",
    inputSchema: object({ reportId: { type: "string", description: "The report's id (from list_custom_reports)." } }, ["reportId"]),
    async run(tx, args) {
      const { report, figures } = await getCustomReport(tx, args.reportId);
      return { reportId: report.id, title: report.title, kind: report.kind, publishedAt: report.publishedAt, figures };
    },
  },
];

/** Making a custom report is drafting: a person reviews, sets it as a default layout or publishes it (decision 1363). */
export const REPORT_WRITE_TOOLS: readonly AiTool[] = [
  {
    name: "create_custom_report_draft",
    title: "Start a custom report",
    level: "draft",
    description:
      "Starts a draft custom report for a person to review in Tohyee: from the standard profit and loss or balance sheet's rows (start: standard), the custom report template (start: template), or a full layout (as run_custom_report's report.layout). Nothing is posted or published, and it doesn't become any report's default layout; a person does that. periodEnd is a month end (default this month). Send the same idempotencyKey to retry.",
    inputSchema: object(
      {
        base: { type: "string", enum: Object.keys(CUSTOM_REPORT_BASES), description: "The standard report it starts from." },
        title: { type: "string", maxLength: 200, description: "Its name; default the standard report's." },
        start: { type: "string", enum: ["standard", "template"], description: "Profit and loss or balance sheet only. Default standard." },
        periodEnd: DATE,
        layout: { type: "object", description: "A whole layout (title, columns, blocks) instead of start." },
        idempotencyKey: { type: "string", description: "8-120 letters, numbers, dots, colons, dashes or underscores; the same key returns the same draft." },
      },
      ["base"],
    ),
    async run(tx, args, context) {
      const key = args.idempotencyKey == null || args.idempotencyKey === "" ? `ai-${randomBytes(12).toString("hex")}` : requireIdempotencyKey(args.idempotencyKey);
      const base = String(args.base ?? "");
      const financial = !isTransactionReportBase(base);
      let layout = args.layout;
      if (layout == null && args.title != null && financial && Object.hasOwn(CUSTOM_REPORT_BASES, base)) {
        // A title on a standard start: the same rows, named.
        const periodEnd = typeof args.periodEnd === "string" && args.periodEnd ? lastDayOfMonth(args.periodEnd) : lastDayOfMonth(todayIsoDate());
        const rows = args.start === "template" ? templateLayout(base as FinancialReportBase, periodEnd) : standardLayout(base as FinancialReportBase, periodEnd);
        layout = { ...rows, title: args.title };
      }
      const { created, report } = await createCustomReport(tx, {
        source: context.source,
        idempotencyKey: key,
        base,
        periodEnd: args.periodEnd,
        layout,
        start: financial ? (args.start ?? "standard") : undefined,
      });
      return {
        created,
        reportId: report.id,
        title: report.title,
        kind: report.kind,
        next: "A person opens it under Reports › Drafts to check it, and can set it as the default layout or publish it. Nothing is posted.",
      };
    },
  },
];

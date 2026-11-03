import type { AiTool, JsonSchema } from "@/lib/ai/tools";
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
  compare: { type: "integer", minimum: 0, maximum: 11, description: "How many earlier periods to show beside the chosen one (newest first)." },
  compareBy: { type: "string", enum: ["month", "quarter", "year"], description: "The length of each earlier period. Default month." },
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
  const compare = parseCompare({ compare: args.compare, compareBy: args.compareBy, total: args.total, ytd: args.yearToDate, percent: args.percentOfIncome });
  const input = { from: args.from, to: args.to, ...tracking(args) };
  if (args.splitBy != null && args.splitBy !== "") {
    if (compare) throw new ValidationError("Use splitBy or the compare options, not both.");
    return profitAndLossSplit(tx, { ...input, categoryId: args.splitBy });
  }
  return compare ? profitAndLossCompare(tx, input, compare) : profitAndLoss(tx, input);
}

export function runBalanceSheet(tx: OrgTx, args: Record<string, unknown>): Promise<unknown> {
  const compare = parseCompare({ compare: args.compare, compareBy: args.compareBy });
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
];

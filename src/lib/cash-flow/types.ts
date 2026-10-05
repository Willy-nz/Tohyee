/**
 * Cash flow forecast (CF1-CF9): what the screens and the server share.
 * Browser-safe.
 */

export const CASH_FLOW_PERIODS = ["day", "week", "month"] as const;
export type CashFlowPeriodKind = (typeof CASH_FLOW_PERIODS)[number];

/** How many periods by default (about 3 months, Cash 360's default) and at most (about 12 months, 3 for days). */
export const CASH_FLOW_LIMITS: Record<CashFlowPeriodKind, { default: number; max: number }> = {
  day: { default: 31, max: 92 },
  week: { default: 13, max: 52 },
  month: { default: 3, max: 12 },
};

export type CashFlowSource =
  | "invoice"
  | "bill"
  | "expense_claim"
  | "repeating_invoice"
  | "repeating_bill"
  | "sales_order"
  | "purchase_order"
  | "item"
  | "average";

export type CashFlowLine = {
  source: CashFlowSource;
  id: string;
  direction: "in" | "out";
  /** When it's expected; an overdue document's due date. */
  date: string;
  label: string;
  currencyCode: string;
  /** In `currencyCode`. */
  amount: string;
  /** In the base currency (at the latest rate on or before today for another currency). */
  baseAmount: string;
  overdue: boolean;
  draft: boolean;
  fromOrder: boolean;
};

export type CashFlowPeriod = {
  start: string;
  end: string;
  moneyIn: string;
  moneyOut: string;
  net: string;
  closing: string;
  lines: CashFlowLine[];
};

export type CashFlowForecast = {
  today: string;
  period: CashFlowPeriodKind;
  count: number;
  currencyCode: string;
  includeDrafts: boolean;
  includeOrders: boolean;
  accounts: { id: string; code: string; name: string; accountType: string; balance: string }[];
  availableAccounts: { id: string; code: string; name: string; accountType: string }[];
  opening: string;
  periods: CashFlowPeriod[];
  lowest: { index: number; closing: string };
  /** The first period that closes below zero, or null. */
  firstBelowZero: number | null;
  /** Amounts left out, e.g. with no exchange rate to convert them (CF8). */
  excluded: { label: string; reason: string }[];
};

export type CashFlowItem = {
  id: string;
  direction: "in" | "out";
  description: string;
  amount: string;
  date: string;
  repeat: "none" | "week" | "month";
  untilDate: string | null;
  version: number;
  createdByEmail: string | null;
  createdAt: string;
  updatedByEmail: string | null;
  updatedAt: string;
};

export type CashFlowAverage = {
  accountId: string;
  accountCode: string;
  accountName: string;
  direction: "in" | "out";
  months: 3 | 6;
  updatedByEmail: string | null;
  updatedAt: string;
};

/** Where a forecast line opens. */
export function cashFlowLineHref(line: Pick<CashFlowLine, "source" | "id">): string | null {
  switch (line.source) {
    case "invoice":
      return `/operations/invoices/${line.id}`;
    case "bill":
      return `/operations/bills/${line.id}`;
    case "expense_claim":
      return `/operations/expense-claims/${line.id}`;
    case "repeating_invoice":
      return `/operations/repeating-invoices/${line.id}`;
    case "repeating_bill":
      return `/operations/repeating-bills/${line.id}`;
    case "sales_order":
      return `/operations/sales-orders/${line.id}`;
    case "purchase_order":
      return `/operations/purchase-orders/${line.id}`;
    default:
      return null;
  }
}

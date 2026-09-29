export const ACCOUNT_CLASSES = ["asset", "liability", "equity", "revenue", "expense"] as const;

export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

/** Account types, each belonging to one class. Reports group by these. */
export const ACCOUNT_TYPES = {
  bank: { accountClass: "asset", label: "Bank" },
  current_asset: { accountClass: "asset", label: "Current asset" },
  inventory: { accountClass: "asset", label: "Inventory" },
  fixed_asset: { accountClass: "asset", label: "Fixed asset" },
  non_current_asset: { accountClass: "asset", label: "Non-current asset" },
  current_liability: { accountClass: "liability", label: "Current liability" },
  credit_card: { accountClass: "liability", label: "Credit card" },
  non_current_liability: { accountClass: "liability", label: "Non-current liability" },
  equity: { accountClass: "equity", label: "Equity" },
  revenue: { accountClass: "revenue", label: "Revenue" },
  other_income: { accountClass: "revenue", label: "Other income" },
  direct_costs: { accountClass: "expense", label: "Direct costs" },
  expense: { accountClass: "expense", label: "Expense" },
  depreciation: { accountClass: "expense", label: "Depreciation" },
} as const satisfies Record<string, { accountClass: AccountClass; label: string }>;

export type AccountType = keyof typeof ACCOUNT_TYPES;

export function isAccountType(value: unknown): value is AccountType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ACCOUNT_TYPES, value);
}

export function classOfType(type: AccountType): AccountClass {
  return ACCOUNT_TYPES[type].accountClass;
}

/**
 * Bank accounts and credit cards: the accounts money moves through. They hold
 * statement lines (bank feeds and imports), and payments, refunds, bank
 * transactions and transfers go through them.
 */
export function isBankOrCreditCard(type: string): boolean {
  return type === "bank" || type === "credit_card";
}

/** Debit-normal classes increase with debits; the rest increase with credits. */
export function isDebitNormal(accountClass: AccountClass): boolean {
  return accountClass === "asset" || accountClass === "expense";
}

/** Accounts other features look up by role rather than by code. */
export const SYSTEM_KEYS = [
  "bank",
  "accounts_receivable",
  "accounts_payable",
  "expense_claims_payable",
  "inventory",
  "gst",
  "cost_of_goods_sold",
  "retained_earnings",
  "unrealised_fx_gain",
  "unrealised_fx_loss",
  "fixed_asset_disposal",
  "fixed_asset_capital_gain",
] as const;

export type SystemKey = (typeof SYSTEM_KEYS)[number];

import type { AccountType } from "@/lib/accounts/types";

/*
 * The IR10 financial statements summary's boxes (IRD's IR10, March 2026; IR10G
 * guide, June 2026), and which boxes an account can go in (examples
 * ITX19-ITX24, decision 547). Browser-safe.
 */

export const IR10_BOX_LABELS: Record<number, string> = {
  1: "Multiple activity indicator",
  2: "Gross income from sales and/or services",
  3: "Opening stock (include work in progress)",
  4: "Purchases",
  5: "Closing stock (include work in progress)",
  6: "Gross profit",
  7: "Interest received",
  8: "Dividends received",
  9: "Rental, lease and licence income",
  10: "Other income",
  11: "Total income",
  12: "Bad debts",
  13: "Accounting depreciation and amortisation",
  14: "Insurance (exclude ACC levies)",
  15: "Interest expense",
  16: "Professional and consulting fees",
  17: "Rates",
  18: "Rental, lease and licence payments",
  19: "Repairs and maintenance",
  20: "Research and development",
  21: "Associated persons' remuneration",
  22: "Salaries and wages paid to employees",
  23: "Contractor and sub-contractor payments",
  24: "Other expenses",
  25: "Total expenses",
  26: "Exceptional items",
  27: "Net profit/loss before tax",
  28: "Tax adjustments",
  29: "Current year taxable profit/loss",
  30: "Accounts receivable (debtors)",
  31: "Cash and deposits",
  32: "Other current assets",
  33: "Vehicles",
  34: "Plant and machinery",
  35: "Furniture and fittings",
  36: "Land",
  37: "Buildings",
  38: "Other fixed assets",
  39: "Intangibles",
  40: "Shares/ownership interests",
  41: "Term deposits",
  42: "Other non-current assets",
  43: "Total assets",
  44: "Provisions",
  45: "Accounts payable (creditors)",
  46: "Current loans",
  47: "Other current liabilities",
  48: "Total current liabilities",
  49: "Non-current liabilities",
  50: "Total liabilities",
  51: "Owners' equity",
  52: "Tax depreciation",
  53: "Untaxed realised gains/receipts",
  54: "Additions to fixed assets",
  55: "Disposals of fixed assets",
  56: "Dividends paid",
  57: "Drawings",
  58: "Current account year-end balances",
  59: "Tax-deductible loss on disposal of fixed assets",
  60: "Total value of Investment Boost asset(s) being claimed",
};

export const IR10_ROLES = ["drawings", "dividends_paid", "current_account"] as const;
export type Ir10Role = (typeof IR10_ROLES)[number];
export const IR10_ROLE_LABELS: Record<Ir10Role, string> = {
  drawings: "Drawings (box 57)",
  dividends_paid: "Dividends paid (box 56)",
  current_account: "Owner or shareholder current account (box 58)",
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** The boxes an account of this type can go in; one box means it's fixed (ITX19). */
export function allowedBoxes(type: AccountType): number[] {
  switch (type) {
    case "revenue":
    case "other_income":
      return [2, 7, 8, 9, 10];
    case "direct_costs":
      return [4];
    case "expense":
    case "depreciation":
      return range(12, 24);
    case "bank":
      return [31];
    case "current_asset":
    case "inventory":
    case "fixed_asset":
    case "non_current_asset":
      return range(30, 42);
    case "current_liability":
    case "credit_card":
    case "non_current_liability":
      return [44, 45, 46, 47, 49];
    case "equity":
      return [51];
  }
}

/** Roles (boxes 56-58) an account of this type can have. */
export function allowedRoles(type: AccountType): Ir10Role[] {
  if (type === "equity") return ["drawings", "dividends_paid", "current_account"];
  if (type === "current_liability" || type === "non_current_liability" || type === "current_asset") return ["current_account"];
  return [];
}

/** Tohyee's starting chart, where the account still has its starting code and name (ITX19). */
const STARTING_CHART: Record<string, { name: string; box?: number; role?: Ir10Role }> = {
  "4200": { name: "Interest income", box: 7 },
  "6080": { name: "Insurance", box: 14 },
  "6090": { name: "Interest expense", box: 15 },
  "6010": { name: "Accounting fees", box: 16 },
  "6100": { name: "Legal fees", box: 16 },
  "6150": { name: "Rent", box: 18 },
  "6160": { name: "Repairs and maintenance", box: 19 },
  "6200": { name: "Wages and salaries", box: 22 },
  "1640": { name: "Motor vehicles", box: 33 },
  "1650": { name: "Accumulated depreciation - motor vehicles", box: 33 },
  "2800": { name: "Term loan", box: 49 },
  "3100": { name: "Owner drawings", role: "drawings" },
};

export type Ir10AccountRef = { code: string; name: string; type: AccountType; systemKey: string | null };

/** The box an account goes in until someone changes it (ITX19). */
export function defaultBox(account: Ir10AccountRef): number {
  const starting = STARTING_CHART[account.code];
  if (starting?.box && starting.name === account.name && allowedBoxes(account.type).includes(starting.box)) return starting.box;
  if (account.systemKey === "accounts_receivable") return 30;
  if (account.systemKey === "accounts_payable") return 45;
  switch (account.type) {
    case "revenue":
      return 2;
    case "other_income":
      return 10;
    case "direct_costs":
      return 4;
    case "expense":
      return 24;
    case "depreciation":
      return 13;
    case "bank":
      return 31;
    case "current_asset":
    case "inventory":
      return 32;
    case "fixed_asset":
      return 38;
    case "non_current_asset":
      return 42;
    case "current_liability":
    case "credit_card":
      return 47;
    case "non_current_liability":
      return 49;
    case "equity":
      return 51;
  }
}

export function defaultRole(account: Ir10AccountRef): Ir10Role | null {
  const starting = STARTING_CHART[account.code];
  return starting?.role && starting.name === account.name ? starting.role : null;
}

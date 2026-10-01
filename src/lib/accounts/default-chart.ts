import type { AccountType, SystemKey } from "@/lib/accounts/types";

export type ChartTemplateAccount = {
  code: string;
  name: string;
  type: AccountType;
  systemKey?: SystemKey;
};

/**
 * Starting chart of accounts for a New Zealand small business. It's a plain
 * starting point: admins can rename, add and archive accounts afterwards.
 * Numbering: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue,
 * 5xxx cost of sales, 6xxx expenses, 7xxx other income and expenses.
 */
export const NZ_DEFAULT_CHART: readonly ChartTemplateAccount[] = [
  { code: "1000", name: "Business bank account", type: "bank", systemKey: "bank" },
  { code: "1100", name: "Accounts receivable", type: "current_asset", systemKey: "accounts_receivable" },
  { code: "1200", name: "Prepayments", type: "current_asset" },
  { code: "1400", name: "Inventory", type: "inventory", systemKey: "inventory" },
  { code: "1600", name: "Office equipment", type: "fixed_asset" },
  { code: "1610", name: "Accumulated depreciation - office equipment", type: "fixed_asset" },
  { code: "1620", name: "Computer equipment", type: "fixed_asset" },
  { code: "1630", name: "Accumulated depreciation - computer equipment", type: "fixed_asset" },
  { code: "1640", name: "Motor vehicles", type: "fixed_asset" },
  { code: "1650", name: "Accumulated depreciation - motor vehicles", type: "fixed_asset" },
  { code: "2000", name: "Accounts payable", type: "current_liability", systemKey: "accounts_payable" },
  { code: "2010", name: "Expense claims payable", type: "current_liability", systemKey: "expense_claims_payable" },
  { code: "2100", name: "GST", type: "current_liability", systemKey: "gst" },
  { code: "2200", name: "PAYE payable", type: "current_liability", systemKey: "paye_payable" },
  { code: "2210", name: "KiwiSaver payable", type: "current_liability", systemKey: "kiwisaver_payable" },
  { code: "2220", name: "ESCT payable", type: "current_liability", systemKey: "esct_payable" },
  { code: "2230", name: "Student loan payable", type: "current_liability", systemKey: "student_loan_payable" },
  { code: "2240", name: "Wages payable", type: "current_liability", systemKey: "wages_payable" },
  { code: "2250", name: "Payroll deductions payable", type: "current_liability", systemKey: "payroll_deductions_payable" },
  { code: "2300", name: "Income tax payable", type: "current_liability" },
  { code: "2400", name: "Credit card", type: "credit_card" },
  { code: "2800", name: "Term loan", type: "non_current_liability" },
  { code: "3000", name: "Owner funds introduced", type: "equity" },
  { code: "3100", name: "Owner drawings", type: "equity" },
  { code: "3200", name: "Retained earnings", type: "equity", systemKey: "retained_earnings" },
  // Opening balances clear through here when existing books are brought in (IM1); always 0.00 afterwards.
  { code: "3900", name: "Opening balance", type: "equity", systemKey: "conversion_clearing" },
  { code: "4000", name: "Sales", type: "revenue" },
  { code: "4100", name: "Other revenue", type: "revenue" },
  { code: "4200", name: "Interest income", type: "other_income" },
  { code: "5000", name: "Cost of goods sold", type: "direct_costs", systemKey: "cost_of_goods_sold" },
  { code: "5100", name: "Freight inwards", type: "direct_costs" },
  { code: "6000", name: "Advertising and marketing", type: "expense" },
  { code: "6010", name: "Accounting fees", type: "expense" },
  { code: "6020", name: "Bank fees", type: "expense" },
  { code: "6030", name: "Cleaning", type: "expense" },
  { code: "6040", name: "Software and subscriptions", type: "expense" },
  { code: "6050", name: "Entertainment", type: "expense" },
  { code: "6060", name: "Freight and courier", type: "expense" },
  { code: "6070", name: "General expenses", type: "expense" },
  { code: "6080", name: "Insurance", type: "expense" },
  { code: "6090", name: "Interest expense", type: "expense" },
  { code: "6100", name: "Legal fees", type: "expense" },
  { code: "6110", name: "Light, power and heating", type: "expense" },
  { code: "6120", name: "Motor vehicle expenses", type: "expense" },
  { code: "6130", name: "Office expenses", type: "expense" },
  { code: "6140", name: "Printing and stationery", type: "expense" },
  { code: "6150", name: "Rent", type: "expense" },
  { code: "6160", name: "Repairs and maintenance", type: "expense" },
  { code: "6170", name: "Telephone and internet", type: "expense" },
  { code: "6180", name: "Travel - national", type: "expense" },
  { code: "6190", name: "Travel - international", type: "expense" },
  { code: "6200", name: "Wages and salaries", type: "expense" },
  { code: "6210", name: "KiwiSaver employer contributions", type: "expense" },
  { code: "6300", name: "Depreciation", type: "depreciation" },
  { code: "7000", name: "Unrealised currency gains", type: "other_income", systemKey: "unrealised_fx_gain" },
  { code: "7010", name: "Unrealised currency losses", type: "expense", systemKey: "unrealised_fx_loss" },
  { code: "7020", name: "Realised currency gains and losses", type: "other_income", systemKey: "realised_fx" },
  { code: "7030", name: "Gain or loss on disposal of fixed assets", type: "other_income", systemKey: "fixed_asset_disposal" },
  { code: "7040", name: "Capital gains on disposal of fixed assets", type: "other_income", systemKey: "fixed_asset_capital_gain" },
  { code: "7050", name: "Rounding gains and losses", type: "other_income", systemKey: "fx_rounding" },
];

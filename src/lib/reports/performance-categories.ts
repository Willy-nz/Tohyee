/*
 * XRB's minimum categories for not-for-profit performance reports (examples
 * NPR1-NPR10): the Tier 3 wording from *Reporting Requirements for Tier 3
 * Not-for-Profit Entities* (paragraphs A60, A89, A108, A154, A175, A194,
 * A199) and the Tier 4 wording from Charities Services' Tier 4 (NFP)
 * template. Safe to use in the browser.
 */

export const REPORT_FORMATS = ["special_purpose", "tier3", "tier4"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_FORMAT_LABELS: Record<ReportFormat, string> = {
  special_purpose: "Special purpose financial statements",
  tier3: "Tier 3 not-for-profit performance report (accrual)",
  tier4: "Tier 4 not-for-profit performance report (cash)",
};

type CategoryDef = { key: string; tier3: string; tier4: string; tier3Cash?: string };

/** Revenue (A60) and, as cash received, A194 and the Tier 4 template. */
export const REVENUE_CATEGORIES: CategoryDef[] = [
  { key: "rev_donations", tier3: "Donations, koha, bequests and other general fundraising activities", tier4: "Donations, koha, bequests and other fundraising" },
  { key: "rev_general_grants", tier3: "General grants", tier4: "General grants received" },
  { key: "rev_capital_grants", tier3: "Capital grants and donations", tier4: "General grants received" },
  { key: "rev_gov_service", tier3: "Government service delivery grants/contracts", tier4: "Service delivery grants/contracts" },
  { key: "rev_nongov_service", tier3: "Non-government service delivery grants/contracts", tier4: "Service delivery grants/contracts" },
  { key: "rev_membership", tier3: "Membership fees and subscriptions", tier4: "Membership fees and subscriptions" },
  { key: "rev_commercial", tier3: "Revenue from commercial activities", tier4: "Sale of goods or services (commercial activities)", tier3Cash: "Gross sales from commercial activities" },
  { key: "rev_investment", tier3: "Interest, dividends and other investment revenue", tier4: "Interest or dividends received", tier3Cash: "Interest, dividends and other investment receipts" },
  { key: "rev_other", tier3: "Other revenue", tier4: "Other cash received", tier3Cash: "Other cash received" },
];

/** Expenses (A89) and, as cash paid, A194 and the Tier 4 template. */
export const EXPENSE_CATEGORIES: CategoryDef[] = [
  { key: "exp_fundraising", tier3: "Expenses related to fundraising", tier4: "Fundraising costs", tier3Cash: "Payments related to public fundraising" },
  { key: "exp_employees", tier3: "Employee remuneration and other related expenses", tier4: "Employee remuneration and other employee related costs", tier3Cash: "Employee remuneration and other related payments" },
  { key: "exp_volunteers", tier3: "Volunteer related expenses", tier4: "Volunteer related costs", tier3Cash: "Volunteer related payments" },
  { key: "exp_commercial", tier3: "Expenses related to commercial activities", tier4: "Costs related to sale of goods or services (commercial activities)", tier3Cash: "Payments related to commercial activities" },
  { key: "exp_service_delivery", tier3: "Other expenses related to service delivery", tier4: "Other costs related to delivery of entity objectives", tier3Cash: "Other payments related to service delivery" },
  { key: "exp_grants_made", tier3: "Grants and donations made", tier4: "Grants and donations paid", tier3Cash: "Grants and donations paid" },
  { key: "exp_other", tier3: "Other expenses", tier4: "Other cash paid", tier3Cash: "Other payments" },
];

/** Assets (A108). */
export const ASSET_CATEGORIES: CategoryDef[] = [
  { key: "as_cash", tier3: "Cash and short-term deposits", tier4: "Cash and bank" },
  { key: "as_debtors", tier3: "Debtors and prepayments", tier4: "Money owed to the entity" },
  { key: "as_inventory", tier3: "Inventory", tier4: "Inventory" },
  { key: "as_ppe", tier3: "Property, plant and equipment", tier4: "Property, plant and equipment" },
  { key: "as_investments", tier3: "Investments", tier4: "Investments" },
  { key: "as_other", tier3: "Other assets", tier4: "Other assets" },
];

/** Liabilities (A154). */
export const LIABILITY_CATEGORIES: CategoryDef[] = [
  { key: "li_overdraft", tier3: "Bank overdraft", tier4: "Bank overdraft" },
  { key: "li_creditors", tier3: "Creditors and accrued expenses", tier4: "Money payable by the entity" },
  { key: "li_employee", tier3: "Employee costs payable", tier4: "Employee costs payable" },
  { key: "li_deferred", tier3: "Deferred revenue", tier4: "Money received in advance" },
  { key: "li_loans", tier3: "Loans", tier4: "Loans and borrowings" },
  { key: "li_other", tier3: "Other liabilities", tier4: "Other liabilities" },
];

/** Accumulated funds (A175). */
export const EQUITY_CATEGORIES: CategoryDef[] = [
  { key: "eq_capital", tier3: "Capital contributed by owners", tier4: "Capital contributed by owners" },
  { key: "eq_accumulated", tier3: "Accumulated surpluses or deficits", tier4: "Accumulated surpluses or deficits" },
  { key: "eq_restricted", tier3: "Restricted and discretionary reserves", tier4: "Restricted and discretionary reserves" },
  { key: "eq_ppe_reserve", tier3: "Property, plant and equipment revaluation reserve", tier4: "Property, plant and equipment revaluation reserve" },
  { key: "eq_investment_reserve", tier3: "Investment revaluation reserves", tier4: "Investment revaluation reserves" },
  { key: "eq_other_reserves", tier3: "Other reserves", tier4: "Other reserves" },
];

/** Cash from other activities (A199 and the Tier 4 template), chosen from the account and the direction of the cash. */
export const OTHER_ACTIVITIES: CategoryDef[] = [
  { key: "oa_sale_ppe", tier3: "Sale of property, plant and equipment", tier4: "Sale of other assets" },
  { key: "oa_sale_investments", tier3: "Sale of investments", tier4: "Sale of investments" },
  { key: "oa_loans_received", tier3: "Cash received from loans from other parties", tier4: "Cash received from loans and borrowings" },
  { key: "oa_capital_received", tier3: "Cash received from owners (capital contributions)", tier4: "Other cash received from other activities" },
  { key: "oa_buy_ppe", tier3: "Payments to acquire property, plant and equipment", tier4: "Purchase of other assets" },
  { key: "oa_buy_investments", tier3: "Payments to purchase investments", tier4: "Purchase of investments" },
  { key: "oa_loans_repaid", tier3: "Repayments of loans from other parties", tier4: "Repayment of loans and borrowings" },
  { key: "oa_capital_distributed", tier3: "Capital distributed to owners", tier4: "Other cash paid for other activities" },
];

export const OTHER_RECEIPT_KEYS = ["oa_sale_ppe", "oa_sale_investments", "oa_loans_received", "oa_capital_received"];

export const GST_LINE = { tier3: "Net GST received or (paid)", tier4: "Total GST paid or refunded" };

/** Every category an account can be put in, by account class. */
export const CATEGORIES_BY_CLASS: Record<string, CategoryDef[]> = {
  revenue: REVENUE_CATEGORIES,
  expense: EXPENSE_CATEGORIES,
  asset: ASSET_CATEGORIES,
  liability: LIABILITY_CATEGORIES,
  equity: EQUITY_CATEGORIES,
};

const ALL = [...REVENUE_CATEGORIES, ...EXPENSE_CATEGORIES, ...ASSET_CATEGORIES, ...LIABILITY_CATEGORIES, ...EQUITY_CATEGORIES, ...OTHER_ACTIVITIES];

/** A category's wording for a tier; `cash` for the statement of cash flows (Tier 3 words some cash lines differently). */
export function categoryLabel(key: string, tier: "tier3" | "tier4", cash = false): string {
  const found = ALL.find((entry) => entry.key === key);
  if (!found) return key;
  if (tier === "tier4") return found.tier4;
  return cash && found.tier3Cash ? found.tier3Cash : found.tier3;
}

/** Operating categories a balance sheet account's cash can be given (NPR: subscriptions in advance as Membership fees). */
export const OPERATING_CASH_CATEGORIES = [...REVENUE_CATEGORIES, ...EXPENSE_CATEGORIES];

/** Entity information fields (Tier 3 section 3, Tier 4 template), in printed order. */
export const ENTITY_FIELDS: Array<{ key: string; label: string; long?: boolean }> = [
  { key: "legalName", label: "Legal name of entity" },
  { key: "entityType", label: "Type of entity and legal basis" },
  { key: "registrationNumber", label: "Registration number" },
  { key: "purpose", label: "Entity's purpose or mission", long: true },
  { key: "structure", label: "Entity structure", long: true },
  { key: "mainSources", label: "Main sources of the entity's cash and resources", long: true },
  { key: "fundraising", label: "Main methods used by the entity to raise funds", long: true },
  { key: "volunteers", label: "Entity's reliance on volunteers and donated goods or services", long: true },
];

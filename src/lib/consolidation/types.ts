/**
 * Consolidation (CO1-CO11): what the screens and the server share.
 * Browser-safe.
 */

export type RateKind = "current" | "average" | "historical";

export type ConsolidationMember = { organisationId: string; name: string; currencyCode: string };

export type ConsolidationGroup = {
  id: string;
  name: string;
  /** Its base currency and year end are the group's. */
  parentOrganisationId: string;
  currencyCode: string;
  version: number;
  /** The parent first. */
  members: ConsolidationMember[];
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
};

export type ConsolidationAdjustment = {
  id: string;
  date: string;
  description: string;
  createdByEmail: string;
  createdAt: string;
  lines: { organisationId: string; accountCode: string; debit: string; credit: string }[];
};

export type ConsolidatedLine = {
  code: string;
  name: string;
  /** Per organisation, in the group's currency. */
  amounts: Record<string, string>;
  /** Per foreign-currency organisation, in its own currency (null for translated-only lines). */
  ownAmounts: Record<string, string> | null;
  eliminations: string;
  consolidated: string;
};

export type ConsolidatedSection = { key: string; label: string; lines: ConsolidatedLine[]; total: ConsolidatedLine };

export type ConsolidatedReport = {
  kind: "profit_and_loss" | "balance_sheet" | "budget_vs_actual";
  group: ConsolidationGroup;
  currencyCode: string;
  from: string | null;
  to: string;
  /** The group's financial year start for `to` (the parent's year end). */
  yearStart: string;
  sections: ConsolidatedSection[];
  /** Net profit (P&L), or the totals (balance sheet). */
  totals: ConsolidatedLine[];
  /** Plain-English notes: intercompany differences, each with the accounts that don't agree. */
  notices: string[];
};

export type BudgetVsActualLine = { code: string; name: string; actual: string; budget: string; variance: string };
export type ConsolidatedBudgetVsActual = {
  group: ConsolidationGroup;
  currencyCode: string;
  from: string;
  to: string;
  lines: BudgetVsActualLine[];
  total: { actual: string; budget: string; variance: string };
};

export type MonthRates = {
  organisationId: string;
  currencyCode: string;
  month: string;
  current: string | null;
  average: string | null;
  historical: string | null;
  /** Kinds an admin changed. */
  changed: RateKind[];
};

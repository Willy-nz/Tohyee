export const REPORT_EXPORTS = [
  "account-transactions",
  "aged-payables",
  "analytics-pivot",
  "aged-receivables",
  "balance-sheet",
  "bank-reconciliation",
  "budget-vs-actual",
  "cash-flow-forecast",
  "customer-statement",
  "fixed-asset-register",
  "gst-audit",
  "gst-return",
  "inventory-valuation",
  "journal-report",
  "profit-and-loss",
  "project-profitability",
  "project-time",
  "sales-by-salesperson",
  "trial-balance",
] as const;

export type ReportExportName = (typeof REPORT_EXPORTS)[number];
export type ReportExportCell = { text: string; value?: string; numeric?: boolean };
export type ReportExportRow = { cells: ReportExportCell[]; kind?: "section" | "total" };
export type ReportExportTable = { title?: string; columns: string[]; rows: ReportExportRow[] };

export type ReportExportData = {
  report: ReportExportName;
  organisationName: string;
  title: string;
  period: string;
  basis: string | null;
  filters: string[];
  producedAt: string;
  tables: ReportExportTable[];
};

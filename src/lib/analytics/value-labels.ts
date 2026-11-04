import { ACCOUNT_CLASS_LABELS, ACCOUNT_TYPES } from "@/lib/accounts/types";

/**
 * Plain words for coded values in the books' Analytics tables (decision
 * 1499): an account type of "current_liability" reads "Current liability",
 * as on the chart of accounts. Only what's shown changes: the tables keep
 * the code, and filters, slicers, clicks and drill-downs still go by it.
 *
 * Browser-safe.
 */

const ACCOUNT_TYPE_LABELS: Record<string, string> = Object.fromEntries(Object.entries(ACCOUNT_TYPES).map(([code, type]) => [code, type.label]));
const DOCUMENT_STATUS_LABELS: Record<string, string> = { approved: "Approved", voided: "Voided" };

const CODED: Record<string, Record<string, Record<string, string>>> = {
  tohyee_ledger_lines: { account_type: ACCOUNT_TYPE_LABELS, account_class: { ...ACCOUNT_CLASS_LABELS } },
  tohyee_invoices: { status: DOCUMENT_STATUS_LABELS },
  tohyee_invoice_lines: { status: DOCUMENT_STATUS_LABELS },
  tohyee_bills: { status: DOCUMENT_STATUS_LABELS },
  tohyee_bill_lines: { status: DOCUMENT_STATUS_LABELS },
};

/** The labels for a coded field's values, or undefined when the field isn't coded. */
export function valueLabelsFor(table: string, field: string): Record<string, string> | undefined {
  return CODED[table]?.[field];
}

/** One value as people read it: its label when the field is coded, otherwise the value. */
export function valueLabel(table: string, field: string, value: string): string {
  return valueLabelsFor(table, field)?.[value] ?? value;
}

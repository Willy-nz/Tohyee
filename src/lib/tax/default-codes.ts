import type { TaxCategory } from "@/lib/tax/categories";

export type TaxCodeTemplate = {
  code: string;
  label: string;
  category: TaxCategory;
  rate: string;
  effectiveFrom: string;
};

/**
 * The standard NZ GST codes a new organisation starts with (like Xero), so
 * invoices and bills can be raised straight away. They apply from
 * 1 October 2010, when GST became 15%; admins can add, rename and deactivate
 * codes afterwards. Migration 0031 gave existing organisations with no tax
 * codes at all the same four (the SQL there is a frozen copy of this list).
 */
export const NZ_DEFAULT_TAX_CODES: readonly TaxCodeTemplate[] = [
  { code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2010-10-01" },
  { code: "ZERO", label: "Zero rated", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" },
  { code: "EXEMPT", label: "Exempt", category: "exempt", rate: "0", effectiveFrom: "2010-10-01" },
  { code: "NONE", label: "No GST", category: "out_of_scope", rate: "0", effectiveFrom: "2010-10-01" },
];

/** Idempotency key for a seeded code (command source `system`). */
export function defaultTaxCodeKey(code: string): string {
  return `nz-default-tax-code-${code.toLowerCase()}`;
}

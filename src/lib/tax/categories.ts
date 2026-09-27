/** Shared with the browser, so no server imports here. */
export const TAX_CATEGORIES = ["standard", "zero_rated", "exempt", "out_of_scope"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

/**
 * How GST returns are worked out: on invoices raised, on payments, or a mix
 * (sales on invoice, purchases on payments). Stored in organisation settings
 * for the GST return, which handles only the invoice basis so far.
 */
export const GST_BASES = ["invoice", "payments", "hybrid"] as const;
export type GstBasis = (typeof GST_BASES)[number];

export const GST_BASIS_LABELS: Readonly<Record<GstBasis, string>> = {
  invoice: "Invoice basis",
  payments: "Payments basis",
  hybrid: "Hybrid basis",
};

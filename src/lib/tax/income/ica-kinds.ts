/** Imputation credit account entry kinds (ITX26, ITX29). Browser-safe. */
export const ICA_KINDS = ["opening", "dividend_paid", "dividend_received", "rwt_deducted", "refund", "other_credit", "other_debit"] as const;
export type IcaKind = (typeof ICA_KINDS)[number];
export const ICA_KIND_LABELS: Record<IcaKind | "tax_paid", string> = {
  opening: "Opening balance",
  tax_paid: "Income tax paid",
  dividend_paid: "Dividend paid",
  dividend_received: "Dividend received",
  rwt_deducted: "RWT deducted",
  refund: "Income tax refund received",
  other_credit: "Other credit",
  other_debit: "Other debit",
};

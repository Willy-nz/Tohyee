import type { AllocationStatus, AppliesTo } from "@/lib/tax/income/rules";

/* Browser-safe names for where a provisional tax payment goes (ITX6A-ITX6H, decision 620). */

export const APPLIES_TO = ["instalment_1", "instalment_2", "instalment_3", "end_of_year"] as const;
export type AppliesToKey = (typeof APPLIES_TO)[number];
export const APPLIES_TO_LABELS: Record<AppliesToKey, string> = {
  instalment_1: "Instalment 1",
  instalment_2: "Instalment 2",
  instalment_3: "Instalment 3",
  end_of_year: "End-of-year tax",
};

export function appliesToNumber(key: AppliesToKey): AppliesTo {
  return key === "end_of_year" ? "end_of_year" : Number(key.slice("instalment_".length));
}

export type TaxAllocation = {
  id: string;
  paymentId: string;
  appliesTo: AppliesToKey;
  amount: string;
  status: AllocationStatus;
  basis: string;
  irdDocumentId: string | null;
  irdDocumentName: string | null;
  createdByEmail: string | null;
  createdAt: string;
  replaced: { at: string; byEmail: string | null; reason: string } | null;
};

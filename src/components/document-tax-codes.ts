"use client";

import { useApiData } from "@/components/hooks";
import { todayInBrowser } from "@/lib/format";
import type { TaxCode } from "@/lib/tax/codes";
import { type GstRegistration, isRegisteredOn } from "@/lib/tax/registration";

type Loaded = { taxCodes: TaxCode[]; gstRegistration?: Pick<GstRegistration, "registered" | "from" | "until"> };

/**
 * The tax codes for document lines (invoices, bills, credit notes, claims,
 * bank lines). While the organisation isn't registered for GST today, only
 * codes with no GST are offered, so new lines start as No GST (issue #180,
 * NR1-NR3). The server checks each document's own date too (NR2, NR5).
 */
export function useDocumentTaxCodes(organisationId: string) {
  const loaded = useApiData<Loaded>("/api/tax/codes", { organisationId });
  const data = loaded.data ? { taxCodes: documentTaxCodes(loaded.data, todayInBrowser()) } : null;
  return { ...loaded, data };
}

/** The codes usable on a document dated `date`. */
export function documentTaxCodes(loaded: Loaded, date: string): TaxCode[] {
  if (!loaded.gstRegistration || isRegisteredOn(loaded.gstRegistration, date)) return loaded.taxCodes;
  return loaded.taxCodes.filter((code) => code.category === "out_of_scope");
}

/** True when every offered code has no GST: the organisation isn't registered, so amounts start as No GST (NR1). */
export function onlyNoGstCodes(taxCodes: readonly TaxCode[]): boolean {
  return taxCodes.length > 0 && taxCodes.every((code) => code.category === "out_of_scope");
}

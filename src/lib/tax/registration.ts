import type { OrgTx } from "@/lib/db/org-transaction";
import type { TaxCategory } from "@/lib/tax/categories";

/**
 * GST registration (issue #180, examples NR1-NR8). `registered` says whether
 * the organisation is registered for GST at all; `from` and `until` (both
 * optional, inclusive, YYYY-MM-DD) limit when. A null `from` means from the
 * start. Shared with the browser, so only the query below touches the
 * database.
 */
export type GstRegistration = { registered: boolean; from: string | null; until: string | null; organisationName: string };

export async function getGstRegistration(tx: OrgTx): Promise<GstRegistration> {
  const result = await tx.query<{ registered: boolean; from: string | null; until: string | null; name: string }>(
    `select gst_registered as registered, gst_registered_from::text as "from", gst_registered_until::text as "until", display_name as name
       from organisation_settings where id = true`,
  );
  const row = result.rows[0];
  return { registered: row?.registered ?? true, from: row?.from ?? null, until: row?.until ?? null, organisationName: row?.name ?? "This organisation" };
}

/** Whether the organisation is registered for GST on this date. */
export function isRegisteredOn(registration: Pick<GstRegistration, "registered" | "from" | "until">, date: string): boolean {
  return (
    registration.registered &&
    (registration.from === null || registration.from <= date) &&
    (registration.until === null || date <= registration.until)
  );
}

/** Whether the organisation is registered for GST at any time between these dates (inclusive). */
export function isRegisteredDuring(registration: Pick<GstRegistration, "registered" | "from" | "until">, start: string, end: string): boolean {
  return (
    registration.registered &&
    (registration.from === null || registration.from <= end) &&
    (registration.until === null || start <= registration.until)
  );
}

/**
 * NR2: while not registered, GST can't be charged or claimed, and only a
 * registered business makes zero-rated or exempt supplies, so only codes
 * with no GST (out of scope) can be used. Returns the refusal, or null.
 */
export function registrationRefusal(
  label: string | null,
  code: string,
  category: TaxCategory,
  registration: GstRegistration,
  date: string,
): string | null {
  if (category === "out_of_scope" || isRegisteredOn(registration, date)) return null;
  const when =
    registration.registered && registration.from !== null && date < registration.from
      ? ` on ${date} (it's registered from ${registration.from})`
      : registration.registered && registration.until !== null && date > registration.until
        ? ` on ${date} (its registration ended ${registration.until})`
        : "";
  const text = `${registration.organisationName} isn't registered for GST${when}, so it can't charge or claim GST. Tax code ${code} can't be used; use a code with no GST.`;
  return label ? `${label}: ${text}` : text;
}

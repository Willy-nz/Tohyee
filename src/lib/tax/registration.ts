import type { OrgTx } from "@/lib/db/org-transaction";
import type { TaxCategory } from "@/lib/tax/categories";

/**
 * GST registration (issue #180, examples NR1-NR8). `registered` says whether
 * the organisation is registered for GST at all; `from` and `until` (both
 * optional, inclusive, YYYY-MM-DD) limit when. A null `from` means from the
 * start. Shared with the browser, so only the query below touches the
 * database.
 */
export type GstRegistration = {
  registered: boolean;
  from: string | null;
  until: string | null;
  organisationName: string;
  /**
   * Whether a person has confirmed the setting above (issue #546, examples
   * GSR1-GSR10). Until then `registered` is only Tohyee's starting guess
   * (NR8: on, with no dates), and automatic posting doesn't rely on it.
   * Missing (older callers) counts as confirmed.
   */
  confirmed?: boolean;
};

export async function getGstRegistration(tx: OrgTx): Promise<GstRegistration> {
  const result = await tx.query<{ registered: boolean; from: string | null; until: string | null; name: string; confirmed: boolean }>(
    `select gst_registered as registered, gst_registered_from::text as "from", gst_registered_until::text as "until", display_name as name,
            gst_registration_confirmed_at is not null as confirmed
       from organisation_settings where id = true`,
  );
  const row = result.rows[0];
  return {
    registered: row?.registered ?? true,
    from: row?.from ?? null,
    until: row?.until ?? null,
    organisationName: row?.name ?? "This organisation",
    confirmed: row?.confirmed ?? false,
  };
}

/**
 * The GST status on a date (issue #546, GSR1-GSR4):
 * - `registered`: a person confirmed the organisation is registered, and the date is inside the registration.
 * - `not_registered`: the setting says not registered on that date (confirmed or not: no GST is the safe default).
 * - `unconfirmed`: the setting says registered, but no one has confirmed it yet.
 */
export type GstStatus = "registered" | "not_registered" | "unconfirmed";

type RegistrationSetting = Pick<GstRegistration, "registered" | "from" | "until" | "confirmed">;

export function gstStatusOn(registration: RegistrationSetting, date: string): GstStatus {
  if (!isRegisteredOn(registration, date)) return "not_registered";
  return registration.confirmed === false ? "unconfirmed" : "registered";
}

/**
 * For automatic posting (sales platforms, payouts, AI coding): true only when
 * the organisation's registration is confirmed and covers `date`. Anything
 * that would charge or claim GST on its own checks this; an `unconfirmed`
 * date waits for a person rather than guessing (GSR3, GSR6).
 */
export function isGstRegisteredOn(registration: RegistrationSetting, date: string): boolean {
  return gstStatusOn(registration, date) === "registered";
}

/** Whether the registration may cover any date from `start` on (open-ended), confirmed or not. */
export function mayBeRegisteredFrom(registration: RegistrationSetting, start: string): boolean {
  return isRegisteredDuring(registration, start, "9999-12-31");
}

/** The sentence automatic posting shows while registration isn't confirmed (GSR3). */
export function unconfirmedMessage(organisationName: string): string {
  return `${organisationName}'s GST registration hasn't been confirmed yet, so Tohyee won't decide its GST on its own. Confirm it in Settings › Organisation (GST).`;
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

/**
 * The GST registration as Settings, MCP's get_organisation and the posting
 * services all see it (#546, GSR9): today's status, whether a person
 * confirmed it, and the dates. One answer everywhere.
 */
export function gstRegistrationSummary(
  settings: {
    displayName: string;
    gstRegistered: boolean;
    gstRegisteredFrom: string | null;
    gstRegisteredUntil: string | null;
    gstRegistrationConfirmedAt: string | null;
    gstRegistrationConfirmedBy: string | null;
  },
  today: string,
): { statusToday: GstStatus; confirmed: boolean; confirmedAt: string | null; confirmedBy: string | null; registered: boolean; from: string | null; until: string | null; note: string } {
  const registration = { registered: settings.gstRegistered, from: settings.gstRegisteredFrom, until: settings.gstRegisteredUntil, confirmed: settings.gstRegistrationConfirmedAt !== null };
  const statusToday = gstStatusOn(registration, today);
  const note =
    statusToday === "unconfirmed"
      ? `${unconfirmedMessage(settings.displayName)} Don't choose GST codes; ask the person.`
      : !registration.confirmed
        ? "Not confirmed: recorded with no GST until a person confirms it in Settings."
        : statusToday === "registered"
          ? "Registered. Only use a GST code when a tax invoice, receipt, bank rule, the contact's usual code or the person supports it; otherwise leave it for review."
          : "Not registered on this date: amounts are recorded in full with no GST.";
  return {
    statusToday,
    confirmed: registration.confirmed,
    confirmedAt: settings.gstRegistrationConfirmedAt,
    confirmedBy: settings.gstRegistrationConfirmedBy,
    registered: settings.gstRegistered,
    from: settings.gstRegisteredFrom,
    until: settings.gstRegisteredUntil,
    note,
  };
}

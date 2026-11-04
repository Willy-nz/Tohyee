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

/** How much of a GST return period the registration covers (#577, examples GSR11-GSR14). */
export type GstPeriodRegistrationStatus = "registered" | "partly_registered" | "not_registered";

export type GstPeriodRegistration = {
  /** `registered`: every day of the period; `partly_registered`: registration starts or ends inside it; `not_registered`: no day of it. */
  status: GstPeriodRegistrationStatus;
  /** Whether a person has confirmed the setting (#546). Not confirmed: the figures rest on Tohyee's starting guess. */
  confirmed: boolean;
  /** The registration setting's own dates (null: open-ended), whether or not registered at all. */
  registered: boolean;
  from: string | null;
  until: string | null;
  /** The days of the period the registration covers, or null when it covers none. */
  coveredFrom: string | null;
  coveredUntil: string | null;
  /** One plain sentence or two for the screen and the AI. */
  note: string;
};

/**
 * The registration for a GST return period (#577): whether it covers the
 * whole period, part of it (registered or deregistered partway through) or
 * none of it, and whether a person has confirmed it. The GST return screen
 * and the AI's gst_return tool both say this instead of showing a return of
 * zeros for a period with no registration.
 */
export function gstRegistrationForPeriod(
  registration: Pick<GstRegistration, "registered" | "from" | "until" | "confirmed" | "organisationName">,
  periodStart: string,
  periodEnd: string,
): GstPeriodRegistration {
  const confirmed = registration.confirmed !== false;
  const base = { confirmed, registered: registration.registered, from: registration.from, until: registration.until };
  const name = registration.organisationName;
  const period = `${periodStart} to ${periodEnd}`;
  if (!isRegisteredDuring(registration, periodStart, periodEnd)) {
    const why = !registration.registered
      ? "Settings say it isn't registered for GST"
      : registration.from !== null && periodEnd < registration.from
        ? `it's registered for GST from ${registration.from}`
        : `its GST registration ended ${registration.until}`;
    return {
      ...base,
      status: "not_registered",
      coveredFrom: null,
      coveredUntil: null,
      note:
        `${name} isn't registered for GST for ${period} (${why}), so there's no GST return for this period: it isn't a nil return.` +
        (confirmed ? "" : " The registration hasn't been confirmed yet; confirm it in Settings › Organisation (GST)."),
    };
  }
  const coveredFrom = registration.from !== null && registration.from > periodStart ? registration.from : periodStart;
  const coveredUntil = registration.until !== null && registration.until < periodEnd ? registration.until : periodEnd;
  const whole = coveredFrom === periodStart && coveredUntil === periodEnd;
  const parts: string[] = [];
  if (!whole) {
    const starts = coveredFrom !== periodStart ? `registration starts ${coveredFrom}` : null;
    const ends = coveredUntil !== periodEnd ? `registration ended ${coveredUntil}` : null;
    parts.push(
      `${name} is registered for GST for only part of ${period} (${[starts, ends].filter(Boolean).join("; ")}). ` +
        `Only ${coveredFrom} to ${coveredUntil} belongs on a GST return; check the period with Inland Revenue.`,
    );
  }
  if (!confirmed) parts.push(`${unconfirmedMessage(name)} These figures assume the setting is right.`);
  return {
    ...base,
    status: whole ? "registered" : "partly_registered",
    coveredFrom,
    coveredUntil,
    note: parts.length ? parts.join(" ") : `${name} is registered for GST for the whole period.`,
  };
}

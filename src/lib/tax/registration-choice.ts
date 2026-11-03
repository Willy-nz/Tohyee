/**
 * The GST question asked when an organisation is created and in Settings
 * (#546, GSR1-GSR2). Shared with the browser, so no server imports here.
 * Nothing is chosen to start with: the person picks one.
 */
export type GstChoiceInput = "" | "registered" | "not_registered" | "unsure";

export const GST_CHOICES: ReadonlyArray<{ value: Exclude<GstChoiceInput, "">; label: string }> = [
  { value: "registered", label: "Yes, registered for GST" },
  { value: "not_registered", label: "No, not registered" },
  { value: "unsure", label: "Not sure yet (start with no GST)" },
];

/** What the create-organisation API takes for a choice: true, false or "unsure" (none chosen counts as unsure). */
export function gstChoiceValue(choice: GstChoiceInput): boolean | "unsure" {
  return choice === "registered" ? true : choice === "not_registered" ? false : "unsure";
}

type SavedRegistration = { gstRegistered: boolean; gstRegisteredFrom: string | null; gstRegisteredUntil: string | null; gstRegistrationConfirmedAt: string | null };
type RegistrationForm = { choice: "" | "registered" | "not_registered"; from: string; until: string };

/** The Settings form's starting answer: nothing chosen until someone has confirmed it (GSR4). */
export function initialRegistrationChoice(saved: SavedRegistration): RegistrationForm["choice"] {
  if (saved.gstRegistrationConfirmedAt === null) return "";
  return saved.gstRegistered ? "registered" : "not_registered";
}

/**
 * What the Settings form sends for GST registration (GSR4-GSR8): nothing
 * while no answer is chosen; the answer, its dates and a confirmation when
 * it's new or changed; `acknowledgeAffectedPeriods` once the person has
 * ticked that they'll correct the months the change reaches.
 */
export function registrationPatch(saved: SavedRegistration, form: RegistrationForm, acknowledged: boolean): Record<string, unknown> {
  if (form.choice === "") return {};
  const registered = form.choice === "registered";
  const next = { gstRegistered: registered, gstRegisteredFrom: registered ? form.from || null : null, gstRegisteredUntil: registered ? form.until || null : null };
  const changed = registrationChanges(saved, form);
  if (!changed && saved.gstRegistrationConfirmedAt !== null) return next;
  return { ...next, gstRegistrationConfirmed: true, ...(changed && acknowledged ? { acknowledgeAffectedPeriods: true } : {}) };
}

/** Whether the form changes the saved registration or its dates (so the months it reaches are shown, GSR8). */
export function registrationChanges(saved: SavedRegistration, form: RegistrationForm): boolean {
  if (form.choice === "") return false;
  const registered = form.choice === "registered";
  return (
    registered !== saved.gstRegistered ||
    (registered && (form.from || null) !== saved.gstRegisteredFrom) ||
    (registered && (form.until || null) !== saved.gstRegisteredUntil)
  );
}

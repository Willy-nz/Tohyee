import { roleAtLeast, type Role } from "@/lib/auth/roles";
import type { CustomField } from "@/lib/custom-fields/values";
import { ValidationError } from "@/lib/errors";

/**
 * CRM record types and page layouts (CRM roadmap items 3 and 4, examples
 * CRT1-CRT13), after Salesforce record types and page layouts (NetSuite
 * custom forms). Browser-safe: the field catalogue and the layout rules are
 * used by the set-up screen and the record page as well as the server.
 */

export const LAYOUT_RECORDS = ["contact", "person", "opportunity"] as const;
export type LayoutRecord = (typeof LAYOUT_RECORDS)[number];

export const LAYOUT_RECORD_NAMES: Record<LayoutRecord, { one: string; many: string; title: string }> = {
  contact: { one: "company", many: "companies", title: "Companies" },
  person: { one: "person", many: "people", title: "People" },
  opportunity: { one: "opportunity", many: "opportunities", title: "Opportunities" },
};

export type StandardFieldKind =
  | "text"
  | "long_text"
  | "email"
  | "phone"
  | "gst"
  | "member"
  | "company"
  | "person"
  | "money"
  | "date"
  | "stage"
  | "datetime";

export type StandardField = {
  key: string;
  label: string;
  kind: StandardFieldKind;
  /** Every record needs it: it stays on every layout, always required, never read-only. */
  locked?: boolean;
  /** Filled in by Tohyee: always read-only, never required. */
  system?: boolean;
  /** Always has a value, so "required" means nothing. */
  alwaysSet?: boolean;
};

const SYSTEM_FIELDS: StandardField[] = [
  { key: "createdAt", label: "Created", kind: "datetime", system: true },
  { key: "updatedAt", label: "Last changed", kind: "datetime", system: true },
];

/** The standard fields of each kind of record that a layout can show (CRT1). */
export const STANDARD_FIELDS: Record<LayoutRecord, readonly StandardField[]> = {
  contact: [
    { key: "name", label: "Company name", kind: "text", locked: true },
    { key: "ownerUserId", label: "Owner", kind: "member" },
    { key: "email", label: "Email", kind: "email" },
    { key: "phone", label: "Phone", kind: "phone" },
    { key: "gstNumber", label: "GST number", kind: "gst" },
    { key: "postalAddress", label: "Billing address", kind: "long_text" },
    { key: "deliveryAddress", label: "Delivery address", kind: "long_text" },
    ...SYSTEM_FIELDS,
  ],
  person: [
    { key: "firstName", label: "First name", kind: "text", locked: true },
    { key: "lastName", label: "Last name", kind: "text" },
    { key: "jobTitle", label: "Job title", kind: "text" },
    { key: "contactId", label: "Company", kind: "company" },
    { key: "email", label: "Email", kind: "email" },
    { key: "phone", label: "Phone", kind: "phone" },
    ...SYSTEM_FIELDS,
  ],
  opportunity: [
    { key: "name", label: "Opportunity", kind: "text", locked: true },
    { key: "contactId", label: "Company", kind: "company", locked: true },
    { key: "pointOfContactId", label: "Point of contact", kind: "person" },
    { key: "ownerUserId", label: "Owner", kind: "member" },
    { key: "amount", label: "Amount (excl. GST)", kind: "money", alwaysSet: true },
    { key: "closeDate", label: "Expected close date", kind: "date" },
    { key: "stage", label: "Stage", kind: "stage", alwaysSet: true },
    ...SYSTEM_FIELDS,
  ],
};

export type LayoutField = { key: string; required: boolean; readOnly: boolean };
export type LayoutSection = { name: string; fields: LayoutField[] };
export type PageLayout = { sections: LayoutSection[] };

export type RecordType = {
  id: string;
  record: LayoutRecord;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  layout: PageLayout;
};

export const MAX_LAYOUT_SECTIONS = 20;
export const MAX_RECORD_TYPE_NAME = 60;
export const MAX_RECORD_TYPE_DESCRIPTION = 300;

const CUSTOM_PREFIX = "custom:";

export function customKey(fieldId: string): string {
  return `${CUSTOM_PREFIX}${fieldId}`;
}

/** The custom field's id for a "custom:<id>" key, or null for a standard field. */
export function customIdOf(key: string): string | null {
  return key.startsWith(CUSTOM_PREFIX) ? key.slice(CUSTOM_PREFIX.length) : null;
}

export function standardField(record: LayoutRecord, key: string): StandardField | undefined {
  return STANDARD_FIELDS[record].find((field) => field.key === key);
}

/**
 * Whether a standard field is used on this record (CRT4): only customers
 * have a delivery address (as on the Contacts screen), so a prospect or a
 * supplier isn't asked for one or shown it.
 */
export function standardFieldApplies(record: LayoutRecord, key: string, contact: { isCustomer: boolean } | null): boolean {
  return !(record === "contact" && key === "deliveryAddress" && contact !== null && !contact.isCustomer);
}

type FieldInfo = Pick<CustomField, "id" | "record" | "label" | "type">;

/** A layout field's label: the standard field's or the custom field's. */
export function layoutFieldLabel(record: LayoutRecord, key: string, customFields: readonly FieldInfo[]): string {
  const id = customIdOf(key);
  if (id === null) return standardField(record, key)?.label ?? key;
  return customFields.find((field) => field.id === id)?.label ?? "A custom field";
}

/** Whether a layout field is required on its type: locked fields always are (CRT1, CRT3). */
export function isRequiredOnLayout(record: LayoutRecord, field: LayoutField): boolean {
  return Boolean(standardField(record, field.key)?.locked) || field.required;
}

/** Whether a layout field is read-only on its type: system fields always are. */
export function isReadOnlyOnLayout(record: LayoutRecord, field: LayoutField): boolean {
  return Boolean(standardField(record, field.key)?.system) || field.readOnly;
}

/**
 * Whether someone with this role may change the field on a record of this
 * type (CRT6, CRT7): bookkeepers and above change fields; read-only ones are
 * for admins and owners only (Salesforce's "Edit Read Only Fields"); system
 * fields for nobody.
 */
export function canEditLayoutField(record: LayoutRecord, field: LayoutField, role: Role): boolean {
  if (standardField(record, field.key)?.system) return false;
  if (!roleAtLeast(role, "bookkeeper")) return false;
  return !field.readOnly || roleAtLeast(role, "admin");
}

/** Every field on the layout, in order. */
export function layoutFields(layout: PageLayout): LayoutField[] {
  return layout.sections.flatMap((section) => section.fields);
}

function parseFlag(input: unknown, what: string): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input !== "boolean") throw new ValidationError(`${what} must be true or false.`);
  return input;
}

function parseLayoutField(rawField: unknown, record: LayoutRecord, customFields: readonly FieldInfo[]): { field: LayoutField; label: string } {
  const kind = LAYOUT_RECORD_NAMES[record];
  const object = typeof rawField === "object" && rawField !== null ? (rawField as { key?: unknown; required?: unknown; readOnly?: unknown }) : null;
  const key = typeof rawField === "string" ? rawField : object?.key;
  if (typeof key !== "string" || key === "") throw new ValidationError("Each field on a layout needs a key.");
  const customId = customIdOf(key);
  const standard = customId === null ? standardField(record, key) : undefined;
  const custom = customId === null ? undefined : customFields.find((field) => field.id === customId);
  if (!standard && !custom) throw new ValidationError(`${customId === null ? key : "That custom field"} isn't a ${kind.one} field.`);
  if (custom && custom.record !== record) throw new ValidationError(`${custom.label} isn't a ${kind.one} field.`);
  const label = standard?.label ?? custom!.label;
  let required = parseFlag(object?.required, `${label}'s required`);
  let readOnly = parseFlag(object?.readOnly, `${label}'s read-only`);
  if (standard?.locked) {
    if (readOnly) throw new ValidationError(`${label} can't be read-only.`);
    required = true;
  }
  if (standard?.system) {
    if (required) throw new ValidationError(`${label} is filled in by Tohyee, so it can't be required.`);
    readOnly = true;
  }
  if (required && standard?.alwaysSet) throw new ValidationError(`${label} always has a value, so it can't be required.`);
  if (required && custom?.type === "checkbox") throw new ValidationError(`${label} is a check box, so it can't be required (unticked is an answer).`);
  if (required && readOnly) throw new ValidationError(`${label} can't be both required and read-only.`);
  return { field: { key, required, readOnly }, label };
}

/**
 * Checks and tidies a layout (CRT3): 1 to 20 sections with names unique
 * ignoring case; each field a standard field of the kind or one of its
 * custom fields, at most once; locked fields stay on, required and never
 * read-only; system fields read-only and never required; a field that is
 * always set or a check box can't be required; a field can't be both
 * required and read-only.
 */
export function normaliseLayout(input: unknown, record: LayoutRecord, customFields: readonly FieldInfo[]): PageLayout {
  if (typeof input !== "object" || input === null || !Array.isArray((input as { sections?: unknown }).sections)) {
    throw new ValidationError("A layout must be a list of sections.");
  }
  const rawSections = (input as { sections: unknown[] }).sections;
  if (rawSections.length === 0) throw new ValidationError("A layout needs at least one section.");
  if (rawSections.length > MAX_LAYOUT_SECTIONS) throw new ValidationError(`A layout can have at most ${MAX_LAYOUT_SECTIONS} sections.`);
  const names = new Set<string>();
  const seen = new Set<string>();
  const sections: LayoutSection[] = rawSections.map((rawSection) => {
    if (typeof rawSection !== "object" || rawSection === null) throw new ValidationError("Each section needs a name and fields.");
    const { name: rawName, fields: rawFields } = rawSection as { name?: unknown; fields?: unknown };
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name.length < 1 || name.length > 60) throw new ValidationError("A section's name must be 1 to 60 characters.");
    if (names.has(name.toLowerCase())) throw new ValidationError(`There are two sections called ${name.toLowerCase()}.`);
    names.add(name.toLowerCase());
    if (rawFields !== undefined && !Array.isArray(rawFields)) throw new ValidationError(`${name}'s fields must be a list.`);
    const fields = ((rawFields as unknown[] | undefined) ?? []).map((rawField) => {
      const { field, label } = parseLayoutField(rawField, record, customFields);
      if (seen.has(field.key)) throw new ValidationError(`${label} is on the layout more than once.`);
      seen.add(field.key);
      return field;
    });
    return { name, fields };
  });
  for (const standard of STANDARD_FIELDS[record]) {
    if (standard.locked && !seen.has(standard.key)) throw new ValidationError(`${standard.label} must stay on the layout.`);
  }
  return { sections };
}

/**
 * Adds a new custom field to a layout (CRT9), as Salesforce adds a new field
 * to its page layouts: at the end of the section with the same name as the
 * field's custom field section, or else at the end of the first section.
 * A layout that already has it is left as it is.
 */
export function withFieldAdded(layout: PageLayout, fieldId: string, sectionName: string | null): PageLayout {
  const key = customKey(fieldId);
  if (layoutFields(layout).some((field) => field.key === key)) return layout;
  const sections = layout.sections.map((section) => ({ ...section, fields: [...section.fields] }));
  const field = { key, required: false, readOnly: false };
  if (sections.length === 0) return { sections: [{ name: "Details", fields: [field] }] };
  const wanted = sectionName ? sections.find((section) => section.name.toLowerCase() === sectionName.toLowerCase()) : undefined;
  (wanted ?? sections[0]).fields.push(field);
  return { sections };
}

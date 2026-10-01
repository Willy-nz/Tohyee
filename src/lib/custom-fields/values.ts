import { parseIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { cmp, dec, toFixedString, toPlainString } from "@/lib/money/decimal";

/**
 * Custom fields (examples CF1-CF10), the parts that don't need the database
 * so screens can use them too: types, what a field can be on, and checking
 * and showing values. Values never reach the ledger.
 */
export const CUSTOM_FIELD_TYPES = [
  "text",
  "long_text",
  "integer",
  "decimal",
  "money",
  "percent",
  "date",
  "checkbox",
  "list",
  "multi_select",
  "email",
  "phone",
  "url",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  long_text: "Long text",
  integer: "Whole number",
  decimal: "Decimal number",
  money: "Money",
  percent: "Percent",
  date: "Date",
  checkbox: "Check box",
  list: "List (choose one)",
  multi_select: "Multiple select",
  email: "Email address",
  phone: "Phone number",
  url: "Web address",
};

export const CUSTOM_FIELD_RECORDS = ["contact", "document", "line", "person", "opportunity"] as const;
export type CustomFieldRecord = (typeof CUSTOM_FIELD_RECORDS)[number];

export const CUSTOM_FIELD_RECORD_LABELS: Record<CustomFieldRecord, string> = {
  contact: "Contacts",
  document: "Documents",
  line: "Lines",
  person: "People",
  opportunity: "Opportunities",
};

/** One record of the kind, for messages: "a person field", "an opportunity field". */
export const CUSTOM_FIELD_RECORD_NAMES: Record<CustomFieldRecord, string> = {
  contact: "a contact",
  document: "a document",
  line: "a line",
  person: "a person",
  opportunity: "an opportunity",
};

export const CONTACT_USES = ["customer", "supplier", "prospect"] as const;
export const DOCUMENT_KINDS = ["invoice", "bill", "credit_note", "supplier_credit_note", "spend", "receive", "journal"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type CustomFieldUse = (typeof CONTACT_USES)[number] | DocumentKind | "person" | "opportunity";

/** What a field of each kind can be used on. */
export const USES_BY_RECORD: Record<CustomFieldRecord, readonly CustomFieldUse[]> = {
  contact: CONTACT_USES,
  document: DOCUMENT_KINDS,
  line: DOCUMENT_KINDS,
  person: ["person"],
  opportunity: ["opportunity"],
};

/** Uses that belong to the CRM: they need the CRM switched on, not Advanced reporting (CRMF1). */
export const CRM_USES: readonly CustomFieldUse[] = ["prospect", "person", "opportunity"];

/** Kinds of record whose fields can be grouped into sections (CRMF6). Lines are a table, so they don't. */
export const SECTION_RECORDS = ["contact", "document", "person", "opportunity"] as const;
export type SectionRecord = (typeof SECTION_RECORDS)[number];

export const CUSTOM_FIELD_USE_LABELS: Record<CustomFieldUse, string> = {
  customer: "customers",
  supplier: "suppliers",
  prospect: "prospects",
  invoice: "invoices",
  bill: "bills",
  credit_note: "credit notes",
  supplier_credit_note: "supplier credit notes",
  spend: "spend money",
  receive: "receive money",
  journal: "journals",
  person: "people",
  opportunity: "opportunities",
};

/** "invoice lines", "bill lines", "spend money lines". */
export function useLabel(record: CustomFieldRecord, use: CustomFieldUse): string {
  if (record !== "line") return CUSTOM_FIELD_USE_LABELS[use];
  return {
    invoice: "invoice lines",
    bill: "bill lines",
    credit_note: "credit note lines",
    supplier_credit_note: "supplier credit note lines",
    spend: "spend money lines",
    receive: "receive money lines",
    journal: "journal lines",
    customer: "customers",
    supplier: "suppliers",
    prospect: "prospects",
    person: "people",
    opportunity: "opportunities",
  }[use];
}

/** Which switches are on. CRM fields follow the CRM; the rest follow Advanced reporting. */
export type CustomFieldSwitches = { advancedFeatures: boolean; crmEnabled: boolean };

export function isSwitchedOn(switches: CustomFieldSwitches, use: CustomFieldUse): boolean {
  return CRM_USES.includes(use) ? switches.crmEnabled : switches.advancedFeatures;
}

/** What a contact's fields are used on: one use for each role it has (CRMF3). */
export function contactUses(contact: { isCustomer: boolean; isSupplier: boolean; isProspect?: boolean }): CustomFieldUse[] {
  const uses: CustomFieldUse[] = [];
  if (contact.isCustomer) uses.push("customer");
  if (contact.isSupplier) uses.push("supplier");
  if (contact.isProspect) uses.push("prospect");
  return uses;
}

export type CustomValue = string | boolean | string[];
/** Field id -> value. A field that isn't set is left out. */
export type CustomValues = Record<string, CustomValue>;

export type CustomFieldOption = { id: string; name: string; isActive: boolean };

export type CustomField = {
  id: string;
  record: CustomFieldRecord;
  label: string;
  help: string | null;
  type: CustomFieldType;
  usedOn: CustomFieldUse[];
  isRequired: boolean;
  defaultValue: CustomValue | null;
  showInList: boolean;
  isActive: boolean;
  sortOrder: number;
  sectionId: string | null;
  options: CustomFieldOption[];
};

/** A named group of fields on a record's page and form (CRMF6). Only groups fields; it never hides them. */
export type CustomFieldSection = { id: string; record: SectionRecord; name: string; sortOrder: number };

export type CustomFieldSetup = CustomFieldSwitches & { sections: CustomFieldSection[]; fields: CustomField[] };

export const CUSTOM_FIELD_LIMITS = { text: 300, longText: 4000, email: 254, phone: 32, url: 999, digits: 15 } as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\-. ]+$/;
const URL_PATTERN = /^https?:\/\/[^\s/$.?#][^\s]*$/i;

function numberText(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== "string") return null;
  return raw.trim();
}

/**
 * A value as stored, or null for "not set". `keptOptions` holds options the
 * record already had, so an archived option can stay (CF7). Throws with the
 * field's label, e.g. "Channel: choose one of its options." (CF2).
 */
export function normaliseCustomValue(
  field: Pick<CustomField, "label" | "type" | "options">,
  raw: unknown,
  keptOptions: ReadonlySet<string> = new Set(),
): CustomValue | null {
  const fail = (message: string): never => {
    throw new ValidationError(`${field.label}: ${message}`);
  };
  if (raw == null) return null;
  const optionOk = (id: string) => {
    const option = field.options.find((entry) => entry.id === id);
    if (!option) fail("choose one of its options.");
    if (!option!.isActive && !keptOptions.has(id)) fail(`${option!.name} is archived.`);
    return id;
  };
  switch (field.type) {
    case "checkbox":
      if (typeof raw !== "boolean") fail("must be ticked or not.");
      return raw === true ? true : null;
    case "multi_select": {
      if (!Array.isArray(raw)) fail("choose any of its options.");
      const ids = [...new Set((raw as unknown[]).map((entry) => (typeof entry === "string" || typeof entry === "number" ? String(entry) : "")))];
      ids.forEach(optionOk);
      const order = field.options.map((option) => option.id);
      ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      return ids.length > 0 ? ids : null;
    }
    default:
      break;
  }
  if (typeof raw !== "string" && typeof raw !== "number") fail("isn't a valid value.");
  const text = String(raw).trim();
  if (text === "") return null;
  switch (field.type) {
    case "text":
      if (text.includes("\n")) fail("can't have more than one line (use a long text field).");
      if (text.length > CUSTOM_FIELD_LIMITS.text) fail(`can be at most ${CUSTOM_FIELD_LIMITS.text} characters.`);
      return text;
    case "long_text":
      if (text.length > CUSTOM_FIELD_LIMITS.longText) fail(`can be at most ${CUSTOM_FIELD_LIMITS.longText} characters.`);
      return text;
    case "integer": {
      const value = numberText(raw)!;
      if (!/^-?\d{1,15}$/.test(value)) fail("must be a whole number, like 12.");
      return toPlainString(dec(value));
    }
    case "decimal": {
      const value = numberText(raw)!;
      if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(value)) fail("must be a number with at most 6 decimal places, like 3.25.");
      return toPlainString(dec(value));
    }
    case "money": {
      const value = numberText(raw)!;
      if (!/^-?\d{1,15}(\.\d{1,2})?$/.test(value)) fail("must be an amount with at most 2 decimal places, like 12.50 (no commas or $).");
      return toFixedString(dec(value), 2);
    }
    case "percent": {
      const value = numberText(raw)!;
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(value) || cmp(dec(value), dec("100")) > 0) fail("must be a percent from 0 to 100, like 12.5.");
      return toPlainString(dec(value));
    }
    case "date":
      return parseIsoDate(text, field.label);
    case "list":
      return optionOk(text);
    case "email":
      if (text.length > CUSTOM_FIELD_LIMITS.email || !EMAIL.test(text)) fail("must be an email address, like accounts@example.co.nz.");
      return text;
    case "phone":
      if (text.length > CUSTOM_FIELD_LIMITS.phone || !PHONE.test(text)) fail("must be a phone number (digits, spaces, +, - and brackets).");
      return text;
    case "url":
      if (text.length > CUSTOM_FIELD_LIMITS.url || !URL_PATTERN.test(text)) fail("must be a web address starting with http:// or https://.");
      return text;
    default:
      return fail("isn't a valid value.");
  }
}

/** A value as text for screens: options by name, dates as typed, "Yes" for a ticked box. */
export function customValueText(field: Pick<CustomField, "type" | "options">, value: CustomValue | undefined): string {
  if (value === undefined || value === null) return "";
  const optionName = (id: string) => field.options.find((option) => option.id === id)?.name ?? `#${id}`;
  if (field.type === "checkbox") return value === true ? "Yes" : "";
  if (field.type === "list") return optionName(String(value));
  if (field.type === "multi_select") return (Array.isArray(value) ? value : []).map(optionName).join(", ");
  if (field.type === "percent") return `${String(value)}%`;
  return String(value);
}

/**
 * Fields that belong on a record: active ones for the use, plus any it
 * already has a value for. With `switches`, a use whose switch is off doesn't
 * count (CRMF8).
 */
export function fieldsFor(
  fields: readonly CustomField[],
  record: CustomFieldRecord,
  uses: readonly CustomFieldUse[],
  values: CustomValues = {},
  switches?: CustomFieldSwitches,
): CustomField[] {
  const live = switches ? uses.filter((use) => isSwitchedOn(switches, use)) : uses;
  return fields.filter(
    (field) => field.record === record && (values[field.id] !== undefined || (field.isActive && field.usedOn.some((use) => live.includes(use)))),
  );
}

/** Each active field's default for a new record (CF3, CF5, CRMF4). */
export function defaultValues(
  fields: readonly CustomField[],
  record: CustomFieldRecord,
  uses: readonly CustomFieldUse[],
  switches?: CustomFieldSwitches,
): CustomValues {
  const out: CustomValues = {};
  for (const field of fieldsFor(fields, record, uses, {}, switches)) {
    if (field.defaultValue !== null) out[field.id] = field.defaultValue;
  }
  return out;
}

/** Fields shown as list columns for records with these uses (CF8, CRMF7). */
export function listColumnsFor(
  fields: readonly CustomField[],
  record: CustomFieldRecord,
  uses: readonly CustomFieldUse[],
  switches?: CustomFieldSwitches,
): CustomField[] {
  return fieldsFor(fields, record, uses, {}, switches).filter((field) => field.showInList);
}

export type CustomFieldGroup = { section: CustomFieldSection | null; fields: CustomField[] };

/**
 * Fields grouped for a page or form (CRMF6): fields with no section first,
 * then each section in its order. Empty groups are left out. A field whose
 * section isn't in `sections` goes with the unsectioned ones.
 */
export function groupBySection(fields: readonly CustomField[], sections: readonly CustomFieldSection[]): CustomFieldGroup[] {
  const byOrder = (a: { sortOrder: number; id: string }, b: { sortOrder: number; id: string }) =>
    a.sortOrder - b.sortOrder || Number(a.id) - Number(b.id);
  const known = new Map(sections.map((section) => [section.id, section]));
  const groups: CustomFieldGroup[] = [{ section: null, fields: [] }];
  for (const section of [...sections].sort(byOrder)) groups.push({ section, fields: [] });
  for (const field of [...fields].sort(byOrder)) {
    const section = field.sectionId ? known.get(field.sectionId) : undefined;
    groups.find((group) => (group.section?.id ?? null) === (section?.id ?? null))!.fields.push(field);
  }
  return groups.filter((group) => group.fields.length > 0);
}

/** Values keyed in id order, so the same values always look the same. */
export function sortedValues(values: CustomValues): CustomValues {
  const out: CustomValues = {};
  for (const key of Object.keys(values).sort((a, b) => Number(a) - Number(b))) out[key] = values[key];
  return out;
}

export function customValuesKey(values: CustomValues | undefined): string {
  return JSON.stringify(sortedValues(values ?? {}));
}

/** Values copied onto a new document of another kind: only active fields also used there (CF6). */
export function copyableValuesFor(
  fields: readonly CustomField[],
  values: CustomValues | undefined,
  record: CustomFieldRecord,
  kind: DocumentKind,
): CustomValues {
  const out: CustomValues = {};
  for (const [id, value] of Object.entries(values ?? {})) {
    const field = fields.find((entry) => entry.id === id);
    if (field && field.record === record && field.isActive && field.usedOn.includes(kind)) out[id] = value;
  }
  return out;
}

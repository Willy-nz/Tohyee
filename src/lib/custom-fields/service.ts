import type { AccountClass } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import {
  CONTACT_USES,
  CUSTOM_FIELD_RECORDS,
  CUSTOM_FIELD_TYPES,
  type CustomField,
  type CustomFieldRecord,
  type CustomFieldSetup,
  type CustomFieldType,
  type CustomFieldUse,
  type CustomValue,
  type CustomValues,
  DOCUMENT_KINDS,
  type DocumentKind,
  normaliseCustomValue,
  sortedValues,
  useLabel,
} from "@/lib/custom-fields/values";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { advancedFeaturesOn } from "@/lib/tracking/service";
import { requireId, requireOneOf } from "@/lib/validation";

/**
 * Custom fields (examples CF1-CF10): set-up, and checking the values put on
 * contacts, documents and lines. Values never change an amount, account, tag
 * or GST box.
 */
export const MAX_CUSTOM_FIELDS = 100;

type FieldRow = {
  id: string;
  record: CustomFieldRecord;
  label: string;
  help: string | null;
  field_type: CustomFieldType;
  used_on: CustomFieldUse[];
  is_required: boolean;
  default_value: CustomValue | null;
  show_in_list: boolean;
  is_active: boolean;
  sort_order: number;
};

export async function getCustomFieldSetup(tx: OrgTx): Promise<CustomFieldSetup> {
  const fields = await tx.query<FieldRow>(
    `select id, record, label, help, field_type, used_on, is_required, default_value, show_in_list, is_active, sort_order
       from custom_fields order by record, sort_order, id`,
  );
  const options = await tx.query<{ id: string; field_id: string; name: string; is_active: boolean }>(
    "select id, field_id, name, is_active from custom_field_options order by sort_order, id",
  );
  return {
    advancedFeatures: await advancedFeaturesOn(tx),
    fields: fields.rows.map((row) => ({
      id: row.id,
      record: row.record,
      label: row.label,
      help: row.help,
      type: row.field_type,
      usedOn: row.used_on,
      isRequired: row.is_required,
      defaultValue: row.default_value,
      showInList: row.show_in_list,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      options: options.rows
        .filter((option) => option.field_id === row.id)
        .map((option) => ({ id: option.id, name: option.name, isActive: option.is_active })),
    })),
  };
}

async function requireAdvanced(tx: OrgTx): Promise<void> {
  if (!(await advancedFeaturesOn(tx))) {
    throw new ConflictError("Advanced features are off. Turn them on in Settings first.");
  }
}

function parseText(input: unknown, what: string, max: number): string {
  if (typeof input !== "string" || !input.trim()) throw new ValidationError(`${what} is required.`);
  const value = input.trim().replace(/\s+/g, " ");
  if (value.length > max) throw new ValidationError(`${what} can be at most ${max} characters.`);
  return value;
}

function parseHelp(input: unknown): string | null {
  if (input == null || (typeof input === "string" && !input.trim())) return null;
  return parseText(input, "The help text", 300);
}

function parseBool(input: unknown, what: string): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "boolean") throw new ValidationError(`${what} must be true or false.`);
  return input;
}

function parseUsedOn(input: unknown, record: CustomFieldRecord): CustomFieldUse[] {
  const allowed: readonly string[] = record === "contact" ? CONTACT_USES : DOCUMENT_KINDS;
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError(record === "contact" ? "Choose customers, suppliers or both." : "Choose at least one kind of document it's used on.");
  }
  const uses = [...new Set(input.map(String))];
  for (const use of uses) {
    if (!allowed.includes(use)) throw new ValidationError(`A ${record} field can't be used on "${use}".`);
  }
  return allowed.filter((use) => uses.includes(use)) as CustomFieldUse[];
}

function checkRequired(type: CustomFieldType, isRequired: boolean): void {
  if (isRequired && type === "checkbox") throw new ValidationError("A check box can't be required (unticked is an answer).");
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function labelTaken(label: string, record: CustomFieldRecord): ConflictError {
  return new ConflictError(`There's already a ${record} field called ${label}.`);
}

async function loadField(tx: OrgTx, id: string): Promise<CustomField> {
  const field = (await getCustomFieldSetup(tx)).fields.find((entry) => entry.id === id);
  if (!field) throw new NotFoundError("Custom field not found.");
  return field;
}

function parseOptionNames(input: unknown): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new ValidationError("Options must be a list of names.");
  const names = input.map((name) => parseText(name, "An option's name", 100));
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name.toLowerCase())) throw new ValidationError(`The option ${name} is listed twice.`);
    seen.add(name.toLowerCase());
  }
  if (names.length > 200) throw new ValidationError("A list can have at most 200 options.");
  return names;
}

/**
 * Adds a field (CF1). For a list or multiple select, `options` are its first
 * option names and a default is given by option name; other defaults are
 * values of the field's type.
 */
export async function createCustomField(
  tx: OrgTx,
  input: {
    record: unknown;
    label: unknown;
    type: unknown;
    usedOn: unknown;
    help?: unknown;
    isRequired?: unknown;
    defaultValue?: unknown;
    showInList?: unknown;
    options?: unknown;
  },
): Promise<CustomFieldSetup> {
  await requireAdvanced(tx);
  const record = requireOneOf(input.record, "record", CUSTOM_FIELD_RECORDS);
  const type = requireOneOf(input.type, "type", CUSTOM_FIELD_TYPES);
  const label = parseText(input.label, "The label", 60);
  const help = parseHelp(input.help);
  const usedOn = parseUsedOn(input.usedOn, record);
  const isRequired = parseBool(input.isRequired, "isRequired") ?? false;
  const showInList = parseBool(input.showInList, "showInList") ?? false;
  checkRequired(type, isRequired);
  const hasOptions = type === "list" || type === "multi_select";
  const optionNames = parseOptionNames(input.options);
  if (hasOptions && optionNames.length === 0) throw new ValidationError("A list needs at least one option.");
  if (!hasOptions && optionNames.length > 0) throw new ValidationError("Only a list or multiple select has options.");

  await tx.query("lock table custom_fields in share row exclusive mode");
  const count = await tx.query<{ count: string }>("select count(*)::text as count from custom_fields");
  if (Number(count.rows[0].count) >= MAX_CUSTOM_FIELDS) throw new ConflictError(`An organisation can have at most ${MAX_CUSTOM_FIELDS} custom fields.`);

  // A default is checked like any value; list defaults name their options.
  const pseudoOptions = optionNames.map((name, index) => ({ id: `new-${index}`, name, isActive: true }));
  let defaultValue: CustomValue | null = null;
  if (input.defaultValue != null && input.defaultValue !== "") {
    const byName = (name: unknown) => pseudoOptions.find((option) => option.name.toLowerCase() === String(name).trim().toLowerCase())?.id ?? String(name);
    const raw = !hasOptions ? input.defaultValue : Array.isArray(input.defaultValue) ? input.defaultValue.map(byName) : byName(input.defaultValue);
    defaultValue = normaliseCustomValue({ label: `${label} default`, type, options: pseudoOptions }, raw);
  }

  let fieldId: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into custom_fields (record, label, help, field_type, used_on, is_required, show_in_list, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, (select coalesce(max(sort_order), 0) + 1 from custom_fields where record = $1))
       returning id`,
      [record, label, help, type, usedOn, isRequired, showInList],
    );
    fieldId = inserted.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error)) throw labelTaken(label, record);
    throw error;
  }
  const optionIds: string[] = [];
  for (const [index, name] of optionNames.entries()) {
    const inserted = await tx.query<{ id: string }>(
      "insert into custom_field_options (field_id, name, sort_order) values ($1, $2, $3) returning id",
      [fieldId, name, index + 1],
    );
    optionIds.push(inserted.rows[0].id);
  }
  if (defaultValue !== null) {
    const realId = (id: string) => optionIds[Number(id.replace("new-", ""))];
    const stored = !hasOptions ? defaultValue : Array.isArray(defaultValue) ? defaultValue.map(realId) : realId(String(defaultValue));
    await tx.query("update custom_fields set default_value = $2::jsonb where id = $1", [fieldId, JSON.stringify(stored)]);
  }
  await writeAuditEvent(tx, {
    eventType: "custom_field.created",
    entityType: "custom_field",
    entityId: fieldId,
    details: { record, label, type, usedOn, isRequired, showInList, options: optionNames },
  });
  return getCustomFieldSetup(tx);
}

/** Changes a field's label, help, where it's used, required, default, list column, or archives or restores it (CF1, CF7). */
export async function updateCustomField(
  tx: OrgTx,
  idInput: unknown,
  input: {
    label?: unknown;
    help?: unknown;
    usedOn?: unknown;
    isRequired?: unknown;
    defaultValue?: unknown;
    showInList?: unknown;
    isActive?: unknown;
    record?: unknown;
    type?: unknown;
  },
): Promise<CustomFieldSetup> {
  await requireAdvanced(tx);
  const field = await loadField(tx, requireId(idInput, "fieldId"));
  if ((input.record !== undefined && input.record !== field.record) || (input.type !== undefined && input.type !== field.type)) {
    throw new ValidationError("A custom field's type and what it's on can't be changed. Archive it and add a new one instead.");
  }
  const label = input.label === undefined ? field.label : parseText(input.label, "The label", 60);
  const help = input.help === undefined ? field.help : parseHelp(input.help);
  const usedOn = input.usedOn === undefined ? field.usedOn : parseUsedOn(input.usedOn, field.record);
  const isRequired = parseBool(input.isRequired, "isRequired") ?? field.isRequired;
  const showInList = parseBool(input.showInList, "showInList") ?? field.showInList;
  const isActive = parseBool(input.isActive, "isActive") ?? field.isActive;
  checkRequired(field.type, isRequired);
  const defaultValue =
    input.defaultValue === undefined
      ? field.defaultValue
      : normaliseCustomValue({ label: `${label} default`, type: field.type, options: field.options }, input.defaultValue === "" ? null : input.defaultValue);
  try {
    await tx.query(
      `update custom_fields
          set label = $2, help = $3, used_on = $4, is_required = $5, default_value = $6::jsonb, show_in_list = $7,
              is_active = $8, updated_at = now()
        where id = $1`,
      [field.id, label, help, usedOn, isRequired, defaultValue === null ? null : JSON.stringify(defaultValue), showInList, isActive],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw labelTaken(label, field.record);
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "custom_field.updated",
    entityType: "custom_field",
    entityId: field.id,
    details: { label, help, usedOn, isRequired, defaultValue, showInList, isActive },
  });
  return getCustomFieldSetup(tx);
}

/** Adds an option to a list or multiple select. */
export async function addCustomFieldOption(tx: OrgTx, fieldIdInput: unknown, input: { name: unknown }): Promise<CustomFieldSetup> {
  await requireAdvanced(tx);
  const field = await loadField(tx, requireId(fieldIdInput, "fieldId"));
  if (field.type !== "list" && field.type !== "multi_select") throw new ValidationError("Only a list or multiple select has options.");
  const name = parseText(input.name, "The option's name", 100);
  if (field.options.length >= 200) throw new ConflictError("A list can have at most 200 options.");
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into custom_field_options (field_id, name, sort_order)
       values ($1, $2, (select coalesce(max(sort_order), 0) + 1 from custom_field_options where field_id = $1)) returning id`,
      [field.id, name],
    );
    await writeAuditEvent(tx, {
      eventType: "custom_field.option_created",
      entityType: "custom_field",
      entityId: field.id,
      details: { optionId: inserted.rows[0].id, name },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`${field.label} already has an option called ${name}.`);
    throw error;
  }
  return getCustomFieldSetup(tx);
}

/** Renames an option, or archives or restores it (CF7). */
export async function updateCustomFieldOption(
  tx: OrgTx,
  optionIdInput: unknown,
  input: { name?: unknown; isActive?: unknown },
): Promise<CustomFieldSetup> {
  await requireAdvanced(tx);
  const optionId = requireId(optionIdInput, "optionId");
  const found = await tx.query<{ field_id: string; name: string; is_active: boolean }>(
    "select field_id, name, is_active from custom_field_options where id = $1",
    [optionId],
  );
  const option = found.rows[0];
  if (!option) throw new NotFoundError("Option not found.");
  const name = input.name === undefined ? option.name : parseText(input.name, "The option's name", 100);
  const isActive = parseBool(input.isActive, "isActive") ?? option.is_active;
  try {
    await tx.query("update custom_field_options set name = $2, is_active = $3, updated_at = now() where id = $1", [optionId, name, isActive]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`That list already has an option called ${name}.`);
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "custom_field.option_updated",
    entityType: "custom_field",
    entityId: option.field_id,
    details: { optionId, name, isActive },
  });
  return getCustomFieldSetup(tx);
}

// ---------------------------------------------------------------------------
// Values on records

export type CustomFieldContext = { advancedFeatures: boolean; fields: Map<string, CustomField> };

export async function loadCustomFieldContext(tx: OrgTx): Promise<CustomFieldContext> {
  const setup = await getCustomFieldSetup(tx);
  return { advancedFeatures: setup.advancedFeatures, fields: new Map(setup.fields.map((field) => [field.id, field])) };
}

/** Values the record already had, so they can stay when a field or option is archived or the switch is off (CF7, CF8). */
export type KeptCustom = ReadonlySet<string>;

export function keptCustom(...maps: ReadonlyArray<CustomValues | undefined>): Set<string> {
  const kept = new Set<string>();
  for (const values of maps) {
    for (const [id, value] of Object.entries(values ?? {})) {
      kept.add(`${id}=${JSON.stringify(value)}`);
      for (const option of Array.isArray(value) ? value : [value]) kept.add(`${id}#${String(option)}`);
    }
  }
  return kept;
}

/** Values as sent: an object of field id -> value, or undefined when they weren't sent. */
export function parseCustomInput(input: unknown, label: string): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  if (input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError(`${label}custom fields must be an object of field -> value.`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) out[requireId(key, `${label}custom field`)] = value;
  return out;
}

/**
 * Checks values for one record and returns them as stored (CF2, CF5, CF7,
 * CF8). `uses` is what the record is: its document kind, or a contact's
 * roles. Values not sent (undefined) mean a new record's defaults.
 */
export function resolveCustomValues(
  ctx: CustomFieldContext,
  raw: Record<string, unknown> | undefined,
  options: { record: CustomFieldRecord; uses: readonly CustomFieldUse[]; label?: string; kept?: KeptCustom },
): CustomValues {
  const prefix = options.label ? `${options.label}: ` : "";
  const kept = options.kept ?? new Set<string>();
  if (raw === undefined) {
    if (!ctx.advancedFeatures) return {};
    const out: CustomValues = {};
    for (const field of ctx.fields.values()) {
      if (field.record === options.record && field.isActive && field.defaultValue !== null && field.usedOn.some((use) => options.uses.includes(use))) {
        out[field.id] = field.defaultValue;
      }
    }
    return sortedValues(out);
  }
  const out: CustomValues = {};
  for (const [id, value] of Object.entries(raw)) {
    const field = ctx.fields.get(id);
    if (!field || field.record !== options.record) throw new ValidationError(`${prefix}there's no ${options.record} custom field ${id}.`);
    const keptOptions = new Set([...kept].filter((entry) => entry.startsWith(`${id}#`)).map((entry) => entry.slice(id.length + 1)));
    let normalised: CustomValue | null;
    try {
      normalised = normaliseCustomValue(field, value, keptOptions);
    } catch (error) {
      if (error instanceof ValidationError) throw new ValidationError(`${prefix}${error.message}`);
      throw error;
    }
    if (normalised === null) continue;
    const already = kept.has(`${id}=${JSON.stringify(normalised)}`);
    if (!already) {
      if (!ctx.advancedFeatures) throw new ValidationError(`${prefix}advanced features are off, so ${field.label} can't be set.`);
      if (!field.isActive) throw new ValidationError(`${prefix}${field.label} is archived.`);
      if (!field.usedOn.some((use) => options.uses.includes(use))) {
        throw new ValidationError(`${prefix}${field.label} isn't used on ${options.uses.map((use) => useLabel(options.record, use)).join(" or ")}.`);
      }
    }
    out[id] = normalised;
  }
  return sortedValues(out);
}

/** The first required field that's missing, or null (CF3, CF4). Lines only need them on income and expense accounts. */
export function missingRequiredField(
  ctx: CustomFieldContext,
  values: CustomValues,
  options: { record: CustomFieldRecord; uses: readonly CustomFieldUse[]; accountClass?: AccountClass },
): string | null {
  if (!ctx.advancedFeatures) return null;
  if (options.record === "line" && options.accountClass !== "revenue" && options.accountClass !== "expense") return null;
  for (const field of ctx.fields.values()) {
    if (
      field.record === options.record &&
      field.isActive &&
      field.isRequired &&
      field.usedOn.some((use) => options.uses.includes(use)) &&
      values[field.id] === undefined
    ) {
      return field.label;
    }
  }
  return null;
}

/** Checks a document and its lines for required fields when it's approved or posted (CF4). */
export function assertRequiredFields(
  ctx: CustomFieldContext,
  kind: DocumentKind,
  body: CustomValues,
  lines: ReadonlyArray<{ values: CustomValues; accountClass: AccountClass }>,
): void {
  const missing = missingRequiredField(ctx, body, { record: "document", uses: [kind] });
  if (missing) throw new ValidationError(`${missing} is required.`);
  lines.forEach((line, index) => {
    const lineMissing = missingRequiredField(ctx, line.values, { record: "line", uses: [kind], accountClass: line.accountClass });
    if (lineMissing) throw new ValidationError(`Line ${index + 1} needs ${lineMissing}.`);
  });
}

/**
 * Resolves a document's body and line values in one go. `kept` holds what
 * the saved draft had; line values not sent get the new line's defaults.
 */
export async function resolveDocumentCustom(
  tx: OrgTx,
  kind: DocumentKind,
  body: Record<string, unknown> | undefined,
  lines: ReadonlyArray<Record<string, unknown> | undefined>,
  kept: KeptCustom = new Set(),
): Promise<{ ctx: CustomFieldContext; body: CustomValues; lines: CustomValues[] }> {
  const ctx = await loadCustomFieldContext(tx);
  return {
    ctx,
    body: resolveCustomValues(ctx, body, { record: "document", uses: [kind], kept }),
    lines: lines.map((raw, index) => resolveCustomValues(ctx, raw, { record: "line", uses: [kind], label: `Line ${index + 1}`, kept })),
  };
}

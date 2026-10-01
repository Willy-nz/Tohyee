import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast, type Role } from "@/lib/auth/roles";
import { crmEnabled, requireCrm } from "@/lib/crm/switch";
import type { CustomFieldContext } from "@/lib/custom-fields/service";
import type { CustomField, CustomValues } from "@/lib/custom-fields/values";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { optionalBoolean, optionalString, requireId, requireString } from "@/lib/validation";
import {
  customIdOf,
  isReadOnlyOnLayout,
  isRequiredOnLayout,
  LAYOUT_RECORD_NAMES,
  LAYOUT_RECORDS,
  type LayoutRecord,
  layoutFieldLabel,
  layoutFields,
  MAX_RECORD_TYPE_DESCRIPTION,
  MAX_RECORD_TYPE_NAME,
  normaliseLayout,
  type PageLayout,
  type RecordType,
  standardField,
  withFieldAdded,
} from "./layout";

/**
 * Record types and their page layouts (examples CRT1-CRT13), after
 * Salesforce record types and page layouts (NetSuite custom forms). Set-up
 * is for admins (the routes check the role) and needs the CRM on. The
 * layout's required and read-only fields are checked here, on every save of
 * a company, person or opportunity while the CRM is on.
 */

type Row = {
  id: string;
  record: LayoutRecord;
  name: string;
  description: string | null;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
  layout: PageLayout;
};

const COLUMNS = "id::text, record, name, description, is_default, is_active, sort_order, layout";
const RECORD_ORDER = "array_position(array['contact', 'person', 'opportunity'], record)";

function toRecordType(row: Row): RecordType {
  return {
    id: row.id,
    record: row.record,
    name: row.name,
    description: row.description,
    isDefault: row.is_default,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    layout: row.layout,
  };
}

function parseRecord(input: unknown): LayoutRecord {
  if (typeof input !== "string" || !(LAYOUT_RECORDS as readonly string[]).includes(input)) {
    throw new ValidationError("A record type is for companies (contact), people (person) or opportunities (opportunity).");
  }
  return input as LayoutRecord;
}

export async function listRecordTypes(tx: OrgTx, options: { record?: unknown } = {}): Promise<RecordType[]> {
  const record = options.record === undefined || options.record === null || options.record === "" ? null : parseRecord(options.record);
  const result = await tx.query<Row>(
    `select ${COLUMNS} from crm_record_types where ($1::text is null or record = $1) order by ${RECORD_ORDER}, sort_order, id`,
    [record],
  );
  return result.rows.map(toRecordType);
}

export async function getRecordType(tx: OrgTx, idInput: unknown): Promise<RecordType> {
  const id = requireId(idInput, "recordTypeId");
  const result = await tx.query<Row>(`select ${COLUMNS} from crm_record_types where id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Record type not found.");
  return toRecordType(result.rows[0]);
}

export async function defaultRecordType(tx: OrgTx, record: LayoutRecord): Promise<RecordType> {
  const result = await tx.query<Row>(`select ${COLUMNS} from crm_record_types where record = $1 and is_default`, [record]);
  if (!result.rows[0]) throw new ConflictError(`There's no default record type for ${LAYOUT_RECORD_NAMES[record].many}.`);
  return toRecordType(result.rows[0]);
}

async function customFieldInfo(tx: OrgTx): Promise<Pick<CustomField, "id" | "record" | "label" | "type">[]> {
  const result = await tx.query<{ id: string; record: CustomField["record"]; label: string; type: CustomField["type"] }>(
    "select id::text, record, label, field_type as type from custom_fields order by id",
  );
  return result.rows;
}

function nameTaken(record: LayoutRecord, name: string): ConflictError {
  return new ConflictError(`There's already a ${LAYOUT_RECORD_NAMES[record].one} record type called ${name.toLowerCase()}.`);
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function parseName(input: unknown): string {
  return requireString(input, "name", { maxLength: MAX_RECORD_TYPE_NAME });
}

function parseDescription(input: unknown): string | null {
  return optionalString(input, "description", { maxLength: MAX_RECORD_TYPE_DESCRIPTION });
}

async function makeDefault(tx: OrgTx, type: { id: string; record: LayoutRecord }): Promise<void> {
  await tx.query("update crm_record_types set is_default = false, updated_at = now() where record = $1 and is_default and id <> $2", [type.record, type.id]);
  await tx.query("update crm_record_types set is_default = true, updated_at = now() where id = $1", [type.id]);
}

/**
 * Adds a record type (CRT2). Its layout starts as a copy of another type's
 * (the default's unless `copyFromId` is given), as Salesforce clones one.
 */
export async function createRecordType(
  tx: OrgTx,
  input: { record: unknown; name: unknown; description?: unknown; copyFromId?: unknown; isDefault?: unknown },
): Promise<RecordType> {
  await requireCrm(tx);
  const record = parseRecord(input.record);
  const name = parseName(input.name);
  const description = parseDescription(input.description);
  const isDefault = optionalBoolean(input.isDefault, "isDefault") ?? false;
  await tx.query("select pg_advisory_xact_lock(hashtext('crm_record_types:' || $1))", [record]);
  const source =
    input.copyFromId === undefined || input.copyFromId === null || input.copyFromId === ""
      ? await defaultRecordType(tx, record)
      : await getRecordType(tx, input.copyFromId);
  if (source.record !== record) throw new ValidationError(`${source.name} isn't a record type for ${LAYOUT_RECORD_NAMES[record].many}.`);
  const order = await tx.query<{ next: number }>("select coalesce(max(sort_order), 0) + 1 as next from crm_record_types where record = $1", [record]);
  let id: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into crm_record_types (record, name, description, sort_order, layout) values ($1, $2, $3, $4, $5::jsonb) returning id::text`,
      [record, name, description, Number(order.rows[0].next), JSON.stringify(source.layout)],
    );
    id = inserted.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken(record, name);
    throw error;
  }
  if (isDefault) await makeDefault(tx, { id, record });
  const created = await getRecordType(tx, id);
  await writeAuditEvent(tx, {
    eventType: "crm.record_type_created",
    entityType: "crm_record_type",
    entityId: id,
    details: { record, name, description, isDefault, copiedFrom: source.name, layout: created.layout },
  });
  return created;
}

/**
 * Changes a record type (CRT2, CRT3): its name, description, whether it's
 * active, whether it's the default (making one the default takes it from the
 * other), its place in the list (`move`) and its layout. The default can't
 * be archived. Each change is in the history, the layout before and after.
 */
export async function updateRecordType(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; description?: unknown; isActive?: unknown; isDefault?: unknown; layout?: unknown; move?: unknown },
): Promise<RecordType> {
  await requireCrm(tx);
  const current = await getRecordType(tx, idInput);
  await tx.query("select pg_advisory_xact_lock(hashtext('crm_record_types:' || $1))", [current.record]);
  await tx.query("select id from crm_record_types where id = $1 for update", [current.id]);
  const name = input.name === undefined ? current.name : parseName(input.name);
  const description = input.description === undefined ? current.description : parseDescription(input.description);
  const isActive = optionalBoolean(input.isActive, "isActive") ?? current.isActive;
  const wantedDefault = optionalBoolean(input.isDefault, "isDefault");
  if (wantedDefault === false && current.isDefault) {
    throw new ValidationError(`${current.name} is the default. To change that, make another type the default.`);
  }
  const isDefault = wantedDefault ?? current.isDefault;
  if (!isActive && isDefault) throw new ValidationError(`${current.name} is the default, so it can't be archived.`);
  const layout = input.layout === undefined ? current.layout : normaliseLayout(input.layout, current.record, await customFieldInfo(tx));
  if (input.move !== undefined && input.move !== "up" && input.move !== "down") throw new ValidationError('move must be "up" or "down".');

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (name !== current.name) changes.name = { from: current.name, to: name };
  if (description !== current.description) changes.description = { from: current.description, to: description };
  if (isActive !== current.isActive) changes.isActive = { from: current.isActive, to: isActive };
  if (isDefault !== current.isDefault) changes.isDefault = { from: current.isDefault, to: isDefault };
  if (JSON.stringify(layout) !== JSON.stringify(current.layout)) changes.layout = { from: current.layout, to: layout };
  if (input.move !== undefined) {
    const siblings = await listRecordTypes(tx, { record: current.record });
    const index = siblings.findIndex((type) => type.id === current.id);
    const other = siblings[input.move === "up" ? index - 1 : index + 1];
    if (other) {
      const order = siblings.map((type) => type.id);
      order[index] = other.id;
      order[siblings.indexOf(other)] = current.id;
      for (const [position, id] of order.entries()) {
        await tx.query("update crm_record_types set sort_order = $2 where id = $1", [id, position + 1]);
      }
      changes.move = { from: index + 1, to: siblings.indexOf(other) + 1 };
    }
  }
  if (Object.keys(changes).length === 0) return current;
  try {
    await tx.query(
      "update crm_record_types set name = $2, description = $3, is_active = $4, layout = $5::jsonb, updated_at = now() where id = $1",
      [current.id, name, description, isActive, JSON.stringify(layout)],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken(current.record, name);
    throw error;
  }
  if (isDefault && !current.isDefault) await makeDefault(tx, current);
  await writeAuditEvent(tx, {
    eventType: "crm.record_type_updated",
    entityType: "crm_record_type",
    entityId: current.id,
    details: { record: current.record, name, changes },
  });
  return getRecordType(tx, current.id);
}

/**
 * The type a record is to have (CRT5): the one asked for, else the one it
 * has, else the default. A new type must be active, for this kind of record,
 * and the CRM must be on.
 */
export async function chooseRecordType(tx: OrgTx, record: LayoutRecord, input: unknown, currentId: string | null): Promise<RecordType> {
  if (input === undefined || input === null || input === "") {
    return currentId ? getRecordType(tx, currentId) : defaultRecordType(tx, record);
  }
  const id = requireId(input, "recordTypeId");
  if (id === currentId) return getRecordType(tx, id);
  const result = await tx.query<Row>(`select ${COLUMNS} from crm_record_types where id = $1`, [id]);
  if (!result.rows[0]) throw new ValidationError(`There's no record type #${id}.`);
  const chosen = toRecordType(result.rows[0]);
  if (chosen.record !== record) throw new ValidationError(`That record type isn't for ${LAYOUT_RECORD_NAMES[record].many}.`);
  if (!(await crmEnabled(tx))) throw new ConflictError("The CRM is off, so a record's type can't change. An admin can turn it on in Settings.");
  if (!chosen.isActive) throw new ValidationError(`${chosen.name} is archived, so it can't be chosen.`);
  return chosen;
}

/** A record's values by layout key: standard fields, and its custom values. */
export type LayoutValues = { standard: Record<string, unknown>; custom: CustomValues };

function valueOf(values: LayoutValues, key: string): unknown {
  const id = customIdOf(key);
  return id === null ? values.standard[key] : values.custom[id];
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  const norm = (value: unknown) => (Array.isArray(value) ? JSON.stringify(value.map(String).sort()) : JSON.stringify(value));
  return norm(a) === norm(b);
}

export type LayoutCheck = {
  record: LayoutRecord;
  /** The type after the save. */
  type: RecordType;
  values: LayoutValues;
  /** The type and values before the save; for a new record, its starting values and no type. */
  before: { type: RecordType | null; values: LayoutValues };
  /** Who is saving; read-only fields are for admins and owners. Unknown counts as not an admin. */
  role: Role | undefined;
  ctx: CustomFieldContext;
  /** Whether a custom field is used on this record now (its uses and switches). */
  applies: (field: CustomField) => boolean;
};

/**
 * Checks a save against the record type's layout (CRT4-CRT6, CRT10, CRT12),
 * only while the CRM is on: each required field on the type must have a
 * value (a custom field only where it applies and is active), and someone
 * who isn't an admin can't change a field that is read-only on the type the
 * record had or is getting.
 */
export async function checkAgainstLayout(tx: OrgTx, check: LayoutCheck): Promise<void> {
  if (!check.ctx.crmEnabled) return;
  const { record, type, values, before, ctx } = check;
  const many = LAYOUT_RECORD_NAMES[record].many;
  const labels = [...ctx.fields.values()];
  for (const field of layoutFields(type.layout)) {
    if (!isRequiredOnLayout(record, field)) continue;
    const id = customIdOf(field.key);
    if (id === null) {
      const standard = standardField(record, field.key);
      if (!standard || standard.system || standard.alwaysSet) continue;
    } else {
      const custom = ctx.fields.get(id);
      if (!custom || !custom.isActive || !check.applies(custom)) continue;
    }
    if (isBlank(valueOf(values, field.key))) {
      throw new ValidationError(`${layoutFieldLabel(record, field.key, labels)} is required on ${type.name} ${many}.`);
    }
  }
  if (check.role && roleAtLeast(check.role, "admin")) return;
  const types = before.type && before.type.id !== type.id ? [before.type, type] : [type];
  for (const checked of types) {
    for (const field of layoutFields(checked.layout)) {
      if (!isReadOnlyOnLayout(record, field) || standardField(record, field.key)?.system) continue;
      if (!sameValue(valueOf(before.values, field.key), valueOf(values, field.key))) {
        throw new ForbiddenError(`${layoutFieldLabel(record, field.key, labels)} is read-only on ${checked.name} ${many}. Ask an admin to change it.`);
      }
    }
  }
}

/**
 * Puts a new custom field on every layout of its kind (CRT9): in the
 * section named like its custom field section, else the first section.
 */
export async function addFieldToLayouts(tx: OrgTx, field: { id: string; record: string; sectionId: string | null }): Promise<void> {
  if (!(LAYOUT_RECORDS as readonly string[]).includes(field.record)) return;
  const section = field.sectionId
    ? ((await tx.query<{ name: string }>("select name from custom_field_sections where id = $1", [field.sectionId])).rows[0]?.name ?? null)
    : null;
  for (const type of await listRecordTypes(tx, { record: field.record })) {
    const layout = withFieldAdded(type.layout, field.id, section);
    if (layout !== type.layout) {
      await tx.query("update crm_record_types set layout = $2::jsonb, updated_at = now() where id = $1", [type.id, JSON.stringify(layout)]);
    }
  }
}

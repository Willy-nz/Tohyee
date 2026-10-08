import { createSalesOrder, getSalesOrder, type SalesOrder } from "@/lib/sales-orders/service";
import { writeAuditEvent } from "@/lib/audit";
import { updateContact } from "@/lib/contacts/service";
import { dueDateFromTerms } from "@/lib/customers/service";
import { keptCustom, loadCustomFieldContext, missingRequiredField, parseCustomInput, resolveCustomValues } from "@/lib/custom-fields/service";
import { type CustomValues, customValuesKey, defaultValues, isSwitchedOn } from "@/lib/custom-fields/values";
import type { Role } from "@/lib/auth/roles";
import { checkAgainstLayout, chooseRecordType, getRecordType, type LayoutValues } from "@/lib/crm/record-types/service";
import type { RecordType } from "@/lib/crm/record-types/layout";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { parseRateInput } from "@/lib/fx/documents";
import { createInvoice, getInvoice, type Invoice } from "@/lib/invoices/service";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { parseOptionalIsoDate } from "@/lib/dates";
import { listMembers } from "@/lib/organisations/members";
import { syncedFor } from "@/lib/crm/mail/service";
import { crmEnabled, requireCrm, requirePeople } from "@/lib/crm/switch";
import { requireAccounting } from "@/lib/organisations/accounting-switch";
import {
  type ForecastCategory,
  isForecastCategory,
  type OpportunityStageSetup,
  opportunityRuleProblem,
  parseProbability,
  type StageType,
  weightedAmount,
} from "@/lib/crm/forecast-figures";
import { chooseStage, listStages } from "@/lib/crm/stages";
import { optionalId, optionalString, requireId, requireString } from "@/lib/validation";
import { contactSalesTaxCodeFor } from "@/lib/tax/contact-tax";

/**
 * The CRM module (examples MOD1, CRM1-CRM9), after Twenty
 * (https://github.com/twentyhq/twenty, AGPL-3.0): its companies (Tohyee's
 * contacts), people, opportunities with Twenty's pipeline stages, tasks, and
 * notes (here activities: calls, meetings and notes), and a timeline per
 * company. Only an opportunity's invoice ever reaches the ledger, and only
 * when that draft is approved. An opportunity is in its company's currency,
 * and so is its invoice (MC68, MC69), as a NetSuite transaction starts in the
 * customer's currency.
 */

/**
 * An opportunity's stage is the key of one of the organisation's own stages
 * (CRMS1, decision 77); the six starting stages keep the keys new,
 * screening, meeting, proposal, won and lost. A stage's type (Open, Closed
 * won, Closed lost), not its name, says whether it's open or won.
 */
export type OpportunityStage = string;

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", done: "Done" };

export const ACTIVITY_KINDS = ["call", "meeting", "note"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = { call: "Call", meeting: "Meeting", note: "Note" };

export type TeamMember = { userId: string; displayName: string; email: string };

export type Person = {
  id: string;
  contactId: string | null;
  contactName: string | null;
  firstName: string;
  lastName: string | null;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  /** The company's primary contact for invoices (RC6); at most one per company. */
  isPrimary: boolean;
  isArchived: boolean;
  /** Custom field values (CRMF4); they never change anything else. */
  customFields: CustomValues;
  /** The CRM record type (CRT1): its page layout and required and read-only fields. */
  recordTypeId: string;
  recordTypeName: string;
};

export type Opportunity = {
  id: string;
  name: string;
  contactId: string;
  contactName: string;
  pointOfContactId: string | null;
  pointOfContactName: string | null;
  ownerUserId: string | null;
  /** In `currencyCode`, the company's currency (MC68), excluding GST. */
  amount: string;
  currencyCode: string;
  closeDate: string | null;
  stage: OpportunityStage;
  /** The stage's name now, its type, and the opportunity's own probability and forecast category (CRMS5). */
  stageName: string;
  stageType: StageType;
  /** A whole per cent; starts as the stage's and can be changed (decision 80). */
  probability: number;
  forecastCategory: ForecastCategory;
  /** Amount × probability, rounded half up to the currency's smallest unit (decision 88). */
  weightedAmount: string;
  position: number;
  invoiceId: string | null;
  /** The sales order a won opportunity made instead of an invoice (CRM5b, decision 327). */
  salesOrderId: string | null;
  salesOrderNumber: string | null;
  invoiceNumber: string | null;
  /** Custom field values (CRMF5); they never change the amount, stage or invoice. */
  customFields: CustomValues;
  /** The CRM record type (CRT1, CRT10); it never changes the amount, stage or invoice. */
  recordTypeId: string;
  recordTypeName: string;
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  title: string;
  body: string | null;
  dueDate: string | null;
  status: TaskStatus;
  assigneeUserId: string | null;
  contactId: string | null;
  contactName: string | null;
  personId: string | null;
  personName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  completedAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
};

export type Activity = {
  id: string;
  kind: ActivityKind;
  happenedAt: string;
  subject: string;
  body: string | null;
  contactId: string | null;
  contactName: string | null;
  personId: string | null;
  personName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  createdByEmail: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// The switch and the team

export { crmEnabled, requireCrm };

/** The organisation's members, who can own opportunities and be assigned tasks. */
export async function listTeam(tx: OrgTx): Promise<TeamMember[]> {
  const members = await listMembers(tx.organisationId);
  return members.filter((member) => member.isActive).map((member) => ({ userId: member.userId, displayName: member.displayName, email: member.email }));
}

async function parseMember(tx: OrgTx, input: unknown, what: string): Promise<string | null> {
  if (input == null || input === "") return null;
  if (typeof input !== "string") throw new ValidationError(`${what} must be a member of the organisation.`);
  const members = await listMembers(tx.organisationId);
  if (!members.some((member) => member.userId === input)) throw new ValidationError(`${what} must be a member of the organisation.`);
  return input;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmail(input: unknown): string | null {
  const email = optionalString(input, "email", { maxLength: 254 });
  if (email !== null && !EMAIL.test(email)) throw new ValidationError("Enter a valid email address, like aroha@example.co.nz.");
  return email;
}

/**
 * Checks a person's or opportunity's custom field values (CRMF4, CRMF5,
 * CRMF8): the ones sent, the saved ones when none are sent, or a new
 * record's defaults. A required field must be set while the CRM is on.
 */
async function crmCustomValues(
  tx: OrgTx,
  record: "person" | "opportunity",
  input: unknown,
  saved: CustomValues | null,
): Promise<CustomValues> {
  const raw = parseCustomInput(input, "");
  const ctx = await loadCustomFieldContext(tx);
  const uses = [record] as const;
  const values = resolveCustomValues(ctx, raw === undefined && saved ? saved : raw, { record, uses, kept: keptCustom(saved ?? {}) });
  const missing = missingRequiredField(ctx, values, { record, uses });
  if (missing) throw new ValidationError(`${missing} is required.`);
  return values;
}

/** Who is saving: read-only fields on a record type are for admins and owners (CRT6). */
export type SaveOptions = { role?: Role };

/**
 * Checks a person's or opportunity's values against its record type's page
 * layout (CRT3, CRT6): required fields on that type, and read-only ones for
 * anyone but an admin or owner. A new record's "before" values are what it
 * would get without them being sent.
 */
async function checkCrmLayout(
  tx: OrgTx,
  record: "person" | "opportunity",
  type: RecordType,
  values: LayoutValues,
  before: { type: RecordType; values: LayoutValues } | null,
  options: SaveOptions,
  startingStage = "new",
): Promise<void> {
  const ctx = await loadCustomFieldContext(tx);
  const uses = [record] as const;
  const standardDefaults: Record<string, unknown> = record === "opportunity" ? { amount: "0.00", stage: startingStage } : {};
  await checkAgainstLayout(tx, {
    record,
    type,
    values,
    before: before ?? { type: null, values: { standard: standardDefaults, custom: defaultValues([...ctx.fields.values()], record, uses, ctx) } },
    role: options.role,
    ctx,
    applies: (field) => field.usedOn.includes(record) && isSwitchedOn(ctx, record),
  });
}

/** The values for the history: the new ones, and the old ones only when they changed (CRMF4). */
function customHistory(values: CustomValues, saved: CustomValues | null): { customFields: CustomValues; customFieldsFrom?: CustomValues } {
  if (saved === null || customValuesKey(values) === customValuesKey(saved)) return { customFields: values };
  return { customFields: values, customFieldsFrom: saved };
}

async function requireContact(tx: OrgTx, id: string): Promise<{ id: string; name: string }> {
  const found = await tx.query<{ id: string; name: string }>("select id, name from contacts where id = $1", [id]);
  if (!found.rows[0]) throw new ValidationError(`There's no contact #${id}.`);
  return found.rows[0];
}

// ---------------------------------------------------------------------------
// People (CRM2)

const PERSON_SELECT = `select p.id, p.contact_id, c.name as contact_name, p.first_name, p.last_name, p.job_title, p.email, p.phone, p.is_primary, p.is_archived,
    p.custom_fields, p.record_type_id, t.name as record_type_name
  from crm_people p left join contacts c on c.id = p.contact_id join crm_record_types t on t.id = p.record_type_id`;

type PersonRow = {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  first_name: string;
  last_name: string | null;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  is_archived: boolean;
  custom_fields: CustomValues;
  record_type_id: string;
  record_type_name: string;
};

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: [row.first_name, row.last_name].filter(Boolean).join(" "),
    jobTitle: row.job_title,
    email: row.email,
    phone: row.phone,
    isPrimary: row.is_primary,
    isArchived: row.is_archived,
    customFields: row.custom_fields ?? {},
    recordTypeId: row.record_type_id,
    recordTypeName: row.record_type_name,
  };
}

export async function listPeople(
  tx: OrgTx,
  options: { contactId?: unknown; search?: unknown; includeArchived?: boolean } = {},
): Promise<Person[]> {
  const contactId = optionalId(options.contactId, "contactId");
  const search = optionalString(options.search, "search", { maxLength: 100 });
  const pattern = search === null ? null : `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const result = await tx.query<PersonRow>(
    `${PERSON_SELECT}
      where ($1::bigint is null or p.contact_id = $1) and ($2::boolean or not p.is_archived)
        and ($3::text is null or p.first_name ilike $3 or p.last_name ilike $3 or p.email ilike $3 or c.name ilike $3)
      order by lower(p.first_name), lower(coalesce(p.last_name, '')), p.id`,
    [contactId, options.includeArchived ?? false, pattern],
  );
  return result.rows.map(toPerson);
}

export async function getPerson(tx: OrgTx, idInput: unknown): Promise<Person> {
  const id = requireId(idInput, "personId");
  const result = await tx.query<PersonRow>(`${PERSON_SELECT} where p.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Person not found.");
  return toPerson(result.rows[0]);
}

type PersonInput = {
  contactId?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  jobTitle?: unknown;
  email?: unknown;
  phone?: unknown;
  isPrimary?: unknown;
  isArchived?: unknown;
  customFields?: unknown;
  /** A CRM record type for people (CRT5); the default for a new person. */
  recordTypeId?: unknown;
};

function personLayoutValues(values: { firstName: string; lastName: string | null; jobTitle: string | null; contactId: string | null; email: string | null; phone: string | null }, custom: CustomValues): LayoutValues {
  const { firstName, lastName, jobTitle, contactId, email, phone } = values;
  return { standard: { firstName, lastName, jobTitle, contactId, email, phone }, custom };
}

async function personValues(tx: OrgTx, input: PersonInput, current: Person | null) {
  const contactId = input.contactId === undefined ? (current?.contactId ?? null) : optionalId(input.contactId === "" ? null : input.contactId, "contactId");
  if (contactId) await requireContact(tx, contactId);
  if (input.isArchived !== undefined && typeof input.isArchived !== "boolean") throw new ValidationError("isArchived must be true or false.");
  if (input.isPrimary !== undefined && typeof input.isPrimary !== "boolean") throw new ValidationError("isPrimary must be true or false.");
  const isArchived = input.isArchived === undefined ? (current?.isArchived ?? false) : (input.isArchived as boolean);
  // Archived people and people at no company can't be the primary contact (RC6).
  const wantedPrimary = input.isPrimary === undefined ? (current?.isPrimary ?? false) : (input.isPrimary as boolean);
  if (wantedPrimary && input.isPrimary === true && !contactId) throw new ValidationError("Only someone at a company can be its primary contact.");
  if (wantedPrimary && input.isPrimary === true && isArchived) throw new ValidationError("An archived person can't be the primary contact.");
  const isPrimary = wantedPrimary && Boolean(contactId) && !isArchived && (current === null || contactId === current.contactId || input.isPrimary === true);
  return {
    contactId,
    firstName: input.firstName === undefined && current ? current.firstName : requireString(input.firstName, "first name", { maxLength: 100 }),
    lastName: input.lastName === undefined ? (current?.lastName ?? null) : optionalString(input.lastName, "last name", { maxLength: 100 }),
    jobTitle: input.jobTitle === undefined ? (current?.jobTitle ?? null) : optionalString(input.jobTitle, "job title", { maxLength: 100 }),
    email: input.email === undefined ? (current?.email ?? null) : parseEmail(input.email),
    phone: input.phone === undefined ? (current?.phone ?? null) : optionalString(input.phone, "phone", { maxLength: 50 }),
    isPrimary,
    isArchived,
  };
}

/** Making someone the primary contact takes it from whoever had it at that company (RC6). */
async function clearOtherPrimary(tx: OrgTx, contactId: string | null, personId: string | null): Promise<void> {
  if (!contactId) return;
  await tx.query("select id from contacts where id = $1 for update", [contactId]);
  await tx.query("update crm_people set is_primary = false, updated_at = now() where contact_id = $1 and is_primary and id <> coalesce($2::bigint, 0)", [
    contactId,
    personId,
  ]);
}

export async function createPerson(tx: OrgTx, input: PersonInput, options: SaveOptions = {}): Promise<Person> {
  await requirePeople(tx);
  const values = await personValues(tx, input, null);
  const customFields = await crmCustomValues(tx, "person", input.customFields, null);
  const recordType = await chooseRecordType(tx, "person", input.recordTypeId, null);
  await checkCrmLayout(tx, "person", recordType, personLayoutValues(values, customFields), null, options);
  if (values.isPrimary) await clearOtherPrimary(tx, values.contactId, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into crm_people (contact_id, first_name, last_name, job_title, email, phone, is_primary, custom_fields, record_type_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) returning id`,
    [
      values.contactId,
      values.firstName,
      values.lastName,
      values.jobTitle,
      values.email,
      values.phone,
      values.isPrimary,
      JSON.stringify(customFields),
      recordType.id,
    ],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "crm.person_created",
    entityType: "crm_person",
    entityId: id,
    details: { ...values, customFields, recordType: recordType.name },
  });
  return getPerson(tx, id);
}

export async function updatePerson(tx: OrgTx, idInput: unknown, input: PersonInput, options: SaveOptions = {}): Promise<Person> {
  await requirePeople(tx);
  const current = await getPerson(tx, idInput);
  const values = await personValues(tx, input, current);
  const customFields = await crmCustomValues(tx, "person", input.customFields, current.customFields);
  const recordType = await chooseRecordType(tx, "person", input.recordTypeId, current.recordTypeId);
  const currentType = recordType.id === current.recordTypeId ? recordType : await getRecordType(tx, current.recordTypeId);
  await checkCrmLayout(
    tx,
    "person",
    recordType,
    personLayoutValues(values, customFields),
    { type: currentType, values: personLayoutValues(current, current.customFields) },
    options,
  );
  if (values.isPrimary) await clearOtherPrimary(tx, values.contactId, current.id);
  await tx.query(
    `update crm_people set contact_id = $2, first_name = $3, last_name = $4, job_title = $5, email = $6, phone = $7, is_archived = $8,
            is_primary = $9, custom_fields = $10::jsonb, record_type_id = $11, updated_at = now()
      where id = $1`,
    [
      current.id,
      values.contactId,
      values.firstName,
      values.lastName,
      values.jobTitle,
      values.email,
      values.phone,
      values.isArchived,
      values.isPrimary,
      JSON.stringify(customFields),
      recordType.id,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "crm.person_updated",
    entityType: "crm_person",
    entityId: current.id,
    details: {
      ...values,
      ...customHistory(customFields, current.customFields),
      recordType: recordType.name,
      ...(recordType.id !== current.recordTypeId ? { recordTypeFrom: current.recordTypeName } : {}),
    },
  });
  return getPerson(tx, current.id);
}

// ---------------------------------------------------------------------------
// Opportunities (CRM3-CRM5, CRM9)

const OPPORTUNITY_SELECT = `select o.id, o.name, o.contact_id, c.name as contact_name, o.point_of_contact_id,
    nullif(concat_ws(' ', p.first_name, p.last_name), '') as point_of_contact_name, o.owner_user_id, o.amount::text, o.currency_code,
    o.close_date::text, o.stage, s.name as stage_name, s.stage_type, o.probability, o.forecast_category, o.position, o.invoice_id, o.sales_order_id::text, so.so_number as sales_order_number,
    i.invoice_number, o.custom_fields, o.created_at, o.updated_at, o.record_type_id, t.name as record_type_name
  from crm_opportunities o
  join crm_opportunity_stages s on s.key = o.stage
  join contacts c on c.id = o.contact_id
  join crm_record_types t on t.id = o.record_type_id
  left join crm_people p on p.id = o.point_of_contact_id
  left join sales_invoices i on i.id = o.invoice_id
  left join sales_orders so on so.id = o.sales_order_id`;

type OpportunityRow = {
  id: string;
  name: string;
  contact_id: string;
  contact_name: string;
  point_of_contact_id: string | null;
  point_of_contact_name: string | null;
  owner_user_id: string | null;
  amount: string;
  currency_code: string;
  close_date: string | null;
  stage: OpportunityStage;
  stage_name: string;
  stage_type: StageType;
  probability: number;
  forecast_category: ForecastCategory;
  position: number;
  invoice_id: string | null;
  sales_order_id: string | null;
  sales_order_number: string | null;
  invoice_number: string | null;
  custom_fields: CustomValues;
  created_at: string;
  updated_at: string;
  record_type_id: string;
  record_type_name: string;
};

function toOpportunity(row: OpportunityRow): Opportunity {
  return {
    id: row.id,
    name: row.name,
    contactId: row.contact_id,
    contactName: row.contact_name,
    pointOfContactId: row.point_of_contact_id,
    pointOfContactName: row.point_of_contact_name,
    ownerUserId: row.owner_user_id,
    amount: toFixedString(dec(row.amount), 2),
    currencyCode: row.currency_code,
    closeDate: row.close_date,
    stage: row.stage,
    stageName: row.stage_name,
    stageType: row.stage_type,
    probability: row.probability,
    forecastCategory: row.forecast_category,
    weightedAmount: weightedAmount(row.amount, row.probability, currencyMinorUnits(row.currency_code)),
    position: row.position,
    invoiceId: row.invoice_id,
    salesOrderId: row.sales_order_id,
    salesOrderNumber: row.sales_order_number,
    invoiceNumber: row.invoice_number,
    customFields: row.custom_fields ?? {},
    recordTypeId: row.record_type_id,
    recordTypeName: row.record_type_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listOpportunities(tx: OrgTx, options: { contactId?: unknown; personId?: unknown } = {}): Promise<Opportunity[]> {
  const contactId = optionalId(options.contactId, "contactId");
  const personId = optionalId(options.personId, "personId");
  const result = await tx.query<OpportunityRow>(
    `${OPPORTUNITY_SELECT}
      where ($1::bigint is null or o.contact_id = $1) and ($2::bigint is null or o.point_of_contact_id = $2)
      order by s.sort_order, o.position, o.id`,
    [contactId, personId],
  );
  return result.rows.map(toOpportunity);
}

export async function getOpportunity(tx: OrgTx, idInput: unknown): Promise<Opportunity> {
  const id = requireId(idInput, "opportunityId");
  const result = await tx.query<OpportunityRow>(`${OPPORTUNITY_SELECT} where o.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Opportunity not found.");
  return toOpportunity(result.rows[0]);
}

function parseAmount(input: unknown): string {
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim().replace(/^\$/, "") : "";
  if (text === "") return "0.00";
  if (!/^-?\d{1,15}(\.\d{1,2})?$/.test(text)) throw new ValidationError("The amount must be a number with at most 2 decimal places, like 2400.00.");
  if (cmp(dec(text), dec("0")) < 0) throw new ValidationError("The amount can't be negative.");
  return toFixedString(dec(text), 2);
}

type OpportunityInput = {
  name?: unknown;
  contactId?: unknown;
  pointOfContactId?: unknown;
  ownerUserId?: unknown;
  amount?: unknown;
  closeDate?: unknown;
  stage?: unknown;
  /** A whole per cent; the stage's when not sent (CRMS5). */
  probability?: unknown;
  /** pipeline, best_case, commit, closed or omitted; the stage's when not sent (CRMS5). */
  forecastCategory?: unknown;
  customFields?: unknown;
  /** A CRM record type for opportunities (CRT10); the default for a new one. */
  recordTypeId?: unknown;
};

function opportunityLayoutValues(
  values: { name: string; contactId: string; pointOfContactId: string | null; ownerUserId: string | null; amount: string; closeDate: string | null; stage: OpportunityStage },
  custom: CustomValues,
): LayoutValues {
  const { name, contactId, pointOfContactId, ownerUserId, amount, closeDate, stage } = values;
  return { standard: { name, contactId, pointOfContactId, ownerUserId, amount, closeDate, stage }, custom };
}

/**
 * An opportunity's probability and forecast category (CRMS5, decision 80):
 * the ones sent, else the new stage's when the stage changes, else the ones
 * it has. They must fit the stage's type.
 */
function forecastValues(input: OpportunityInput, stage: OpportunityStageSetup, current: Opportunity | null): { probability: number; forecastCategory: ForecastCategory } {
  const moved = current === null || current.stage !== stage.key;
  let probability = moved ? stage.probability : current.probability;
  if (input.probability !== undefined && input.probability !== null && input.probability !== "") {
    const parsed = parseProbability(input.probability);
    if (parsed === null) throw new ValidationError("The probability must be a whole number from 0 to 100.");
    probability = parsed;
  }
  let forecastCategory = moved ? stage.forecastCategory : current.forecastCategory;
  if (input.forecastCategory !== undefined && input.forecastCategory !== null && input.forecastCategory !== "") {
    if (!isForecastCategory(input.forecastCategory)) throw new ValidationError("The forecast category must be pipeline, best_case, commit, closed or omitted.");
    forecastCategory = input.forecastCategory;
  }
  const problem = opportunityRuleProblem(stage.type, probability, forecastCategory);
  if (problem) throw new ValidationError(problem);
  return { probability, forecastCategory };
}

async function opportunityValues(tx: OrgTx, input: OpportunityInput, current: Opportunity | null, stage: OpportunityStageSetup) {
  const contactId = input.contactId === undefined && current ? current.contactId : requireId(input.contactId, "contactId");
  await requireContact(tx, contactId);
  if (current?.invoiceId && contactId !== current.contactId) {
    throw new ConflictError("This opportunity has made an invoice, so its company can't change.");
  }
  if (current?.salesOrderId && contactId !== current.contactId) {
    throw new ConflictError("This opportunity has made a sales order, so its company can't change.");
  }
  // The amount is in the company's currency (MC68).
  const currencyCode = (await tx.query<{ currency_code: string | null }>("select currency_code from contacts where id = $1", [contactId])).rows[0]?.currency_code ?? tx.baseCurrency;
  const amount = input.amount === undefined ? (current?.amount ?? "0.00") : parseAmount(input.amount);
  if (currencyMinorUnits(currencyCode) < 2 && cmp(dec(amount), dec(toFixedString(dec(amount), currencyMinorUnits(currencyCode)))) !== 0) {
    throw new ValidationError(`The amount is in ${currencyCode}, which has no cents, so it must be a whole number.`);
  }
  const pointOfContactId =
    input.pointOfContactId === undefined ? (current?.pointOfContactId ?? null) : optionalId(input.pointOfContactId === "" ? null : input.pointOfContactId, "pointOfContactId");
  if (pointOfContactId) {
    const person = await getPerson(tx, pointOfContactId);
    if (person.contactId !== contactId) throw new ValidationError(`${person.fullName} doesn't work at that company.`);
  }
  return {
    name: input.name === undefined && current ? current.name : requireString(input.name, "name", { maxLength: 200 }),
    contactId,
    pointOfContactId,
    ownerUserId: input.ownerUserId === undefined ? (current?.ownerUserId ?? null) : await parseMember(tx, input.ownerUserId, "The owner"),
    amount,
    currencyCode,
    closeDate: input.closeDate === undefined ? (current?.closeDate ?? null) : parseOptionalIsoDate(input.closeDate, "close date"),
    stage: stage.key,
    ...forecastValues(input, stage, current),
  };
}

async function nextPosition(tx: OrgTx, stage: OpportunityStage): Promise<number> {
  const result = await tx.query<{ position: number }>("select coalesce(max(position), 0) + 1 as position from crm_opportunities where stage = $1", [stage]);
  return Number(result.rows[0].position);
}

export async function createOpportunity(tx: OrgTx, input: OpportunityInput, options: SaveOptions = {}): Promise<Opportunity> {
  await requireCrm(tx);
  const recordType = await chooseRecordType(tx, "opportunity", input.recordTypeId, null);
  const stage = await chooseStage(tx, input.stage, null, recordType.id);
  const values = await opportunityValues(tx, input, null, stage);
  const customFields = await crmCustomValues(tx, "opportunity", input.customFields, null);
  const startingStage = await chooseStage(tx, undefined, null, recordType.id);
  await checkCrmLayout(tx, "opportunity", recordType, opportunityLayoutValues(values, customFields), null, options, startingStage.key);
  const inserted = await tx.query<{ id: string }>(
    `insert into crm_opportunities (name, contact_id, point_of_contact_id, owner_user_id, amount, close_date, stage, position, created_by_email, currency_code,
                                    custom_fields, record_type_id, probability, forecast_category)
     values ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14) returning id`,
    [
      values.name,
      values.contactId,
      values.pointOfContactId,
      values.ownerUserId,
      values.amount,
      values.closeDate,
      values.stage,
      await nextPosition(tx, values.stage),
      tx.actor.email,
      values.currencyCode,
      JSON.stringify(customFields),
      recordType.id,
      values.probability,
      values.forecastCategory,
    ],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "crm.opportunity_created",
    entityType: "crm_opportunity",
    entityId: id,
    details: { ...values, customFields, recordType: recordType.name },
  });
  return getOpportunity(tx, id);
}

/** Changes an opportunity; a new stage puts it at the end of that column (CRM4). Refused once it has made an invoice. */
export async function updateOpportunity(tx: OrgTx, idInput: unknown, input: OpportunityInput, options: SaveOptions = {}): Promise<Opportunity> {
  await requireCrm(tx);
  const current = await getOpportunity(tx, idInput);
  await tx.query("select id from crm_opportunities where id = $1 for update", [current.id]);
  const recordType = await chooseRecordType(tx, "opportunity", input.recordTypeId, current.recordTypeId);
  if (current.invoiceId && input.stage !== undefined && input.stage !== current.stage) {
    throw new ConflictError("This opportunity has made an invoice, so its stage can't change.");
  }
  if (current.salesOrderId && input.stage !== undefined && input.stage !== current.stage) {
    throw new ConflictError("This opportunity has made a sales order, so its stage can't change.");
  }
  const stage = await chooseStage(tx, input.stage, { key: current.stage, recordTypeId: current.recordTypeId }, recordType.id);
  const values = await opportunityValues(tx, input, current, stage);
  const customFields = await crmCustomValues(tx, "opportunity", input.customFields, current.customFields);
  const currentType = recordType.id === current.recordTypeId ? recordType : await getRecordType(tx, current.recordTypeId);
  await checkCrmLayout(
    tx,
    "opportunity",
    recordType,
    opportunityLayoutValues(values, customFields),
    { type: currentType, values: opportunityLayoutValues(current, current.customFields) },
    options,
  );
  const position = values.stage === current.stage ? current.position : await nextPosition(tx, values.stage);
  await tx.query(
    `update crm_opportunities set name = $2, contact_id = $3, point_of_contact_id = $4, owner_user_id = $5, amount = $6::numeric,
            close_date = $7, stage = $8, position = $9, currency_code = $10, custom_fields = $11::jsonb, record_type_id = $12,
            probability = $13, forecast_category = $14, updated_at = now()
      where id = $1`,
    [
      current.id,
      values.name,
      values.contactId,
      values.pointOfContactId,
      values.ownerUserId,
      values.amount,
      values.closeDate,
      values.stage,
      position,
      values.currencyCode,
      JSON.stringify(customFields),
      recordType.id,
      values.probability,
      values.forecastCategory,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "crm.opportunity_updated",
    entityType: "crm_opportunity",
    entityId: current.id,
    details: {
      ...values,
      ...(values.stage !== current.stage ? { stageFrom: current.stage } : {}),
      ...customHistory(customFields, current.customFields),
      recordType: recordType.name,
      ...(recordType.id !== current.recordTypeId ? { recordTypeFrom: current.recordTypeName } : {}),
    },
  });
  return getOpportunity(tx, current.id);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Makes a draft invoice from a won opportunity (CRM5): one line with its name
 * and amount, the first active revenue account and the standard GST code
 * (no tax if there isn't one), dated today and due on the customer's payment
 * terms, or in 20 days if they have none (RC1). A prospect
 * becomes a customer. Making it again returns the same invoice.
 *
 * For a company in another currency (MC69) the invoice is in it, at the rate
 * typed or else the one any new invoice for that date starts with, with the
 * same standard GST code as an NZD one (revised 1 Oct 2026: standard-rated
 * GST works on foreign-currency invoices, MC71). It's a draft, so the tax
 * code can be changed before it's approved. The company's own default sales
 * tax code, or with Foreign trade on the tax code for exports for an
 * overseas company, comes before the standard code (EX15).
 */
export async function makeInvoiceFromOpportunity(
  tx: OrgTx,
  idInput: unknown,
  input: { exchangeRate?: unknown } = {},
): Promise<{ created: boolean; invoice: Invoice }> {
  await requireCrm(tx);
  // MOD3: no invoice while Accounting is off.
  await requireAccounting(tx);
  const typedRate = parseRateInput(input.exchangeRate);
  const current = await getOpportunity(tx, idInput);
  await tx.query("select id from crm_opportunities where id = $1 for update", [current.id]);
  const locked = await getOpportunity(tx, current.id);
  if (locked.invoiceId) return { created: false, invoice: await getInvoice(tx, locked.invoiceId) };
  if (locked.salesOrderId) throw new ConflictError("This opportunity already has a sales order.");
  // The stage's type, not its name, says it's won (CRMS4, decision 82).
  if (locked.stageType !== "won") throw new ConflictError("Only a won opportunity can make an invoice. Move it to a Closed won stage first.");
  const contact = await tx.query<{ is_customer: boolean }>("select is_customer from contacts where id = $1", [locked.contactId]);
  if (!contact.rows[0]?.is_customer) await updateContact(tx, locked.contactId, { isCustomer: true });
  const today = todayIsoDate();
  const account = await tx.query<{ code: string }>(
    "select code from accounts where is_active and account_class = 'revenue' order by code limit 1",
  );
  if (!account.rows[0]) throw new ValidationError("There's no active revenue account to invoice to.");
  const foreign = locked.currencyCode !== tx.baseCurrency;
  if (!foreign && typedRate != null) throw new ValidationError(`This opportunity is in ${tx.baseCurrency}, so its invoice has no exchange rate.`);
  const taxCode = await tx.query<{ code: string }>(
    `select code from tax_codes where is_active and category = 'standard' and available_on in ('sales', 'both') and effective_from <= $1
        and (effective_to is null or effective_to >= $1) order by id limit 1`,
    [today],
  );
  // The company's own default sales tax code, or the tax code for exports, comes first (EX15).
  const gst = (await contactSalesTaxCodeFor(tx, locked.contactId)) ?? taxCode.rows[0]?.code ?? null;
  const { invoice } = await createInvoice(
    tx,
    {
      source: "crm",
      idempotencyKey: `opportunity-${locked.id}`,
      contactId: locked.contactId,
      invoiceDate: today,
      // The customer's payment terms if they have any (RC1), else 20 days.
      dueDate: (await dueDateFromTerms(tx, locked.contactId, today)) ?? addDays(today, 20),
      amountsMode: gst ? "exclusive" : "no_tax",
      reference: locked.name.slice(0, 100),
      lines: [{ description: locked.name, quantity: "1", unitPrice: locked.amount, accountCode: account.rows[0].code, taxCode: gst }],
      ...(typedRate != null ? { exchangeRate: typedRate } : {}),
    },
    { foreignCurrency: true, feature: "CRM invoices" },
  );
  if (invoice.currencyCode !== locked.currencyCode) {
    throw new ConflictError(`This opportunity is in ${locked.currencyCode}, but ${locked.contactName}'s invoices are in ${invoice.currencyCode}.`);
  }
  await tx.query("update crm_opportunities set invoice_id = $2, updated_at = now() where id = $1", [locked.id, invoice.id]);
  await writeAuditEvent(tx, {
    eventType: "crm.opportunity_invoiced",
    entityType: "crm_opportunity",
    entityId: locked.id,
    details: { invoiceId: invoice.id },
  });
  return { created: true, invoice };
}

/**
 * Makes a draft sales order from a won opportunity instead of an invoice
 * (CRM5b, decision 327; NetSuite's opportunity to sales order): one line
 * with its name and amount, the first active revenue account and the same
 * tax code an invoice would get (EX15), dated today, in the company's
 * currency with no rate (SO10). A prospect becomes a customer. Making it
 * again returns the same sales order; an opportunity with an invoice can't
 * make one. Posts nothing.
 */
export async function makeSalesOrderFromOpportunity(tx: OrgTx, idInput: unknown): Promise<{ created: boolean; salesOrder: SalesOrder }> {
  await requireCrm(tx);
  await requireAccounting(tx);
  const current = await getOpportunity(tx, idInput);
  await tx.query("select id from crm_opportunities where id = $1 for update", [current.id]);
  const locked = await getOpportunity(tx, current.id);
  if (locked.salesOrderId) return { created: false, salesOrder: await getSalesOrder(tx, locked.salesOrderId) };
  if (locked.invoiceId) throw new ConflictError("This opportunity already has an invoice.");
  if (locked.stageType !== "won") throw new ConflictError("Only a won opportunity can make a sales order. Move it to a Closed won stage first.");
  const contact = await tx.query<{ is_customer: boolean }>("select is_customer from contacts where id = $1", [locked.contactId]);
  if (!contact.rows[0]?.is_customer) await updateContact(tx, locked.contactId, { isCustomer: true });
  const today = todayIsoDate();
  const account = await tx.query<{ code: string }>("select code from accounts where is_active and account_class = 'revenue' order by code limit 1");
  if (!account.rows[0]) throw new ValidationError("There's no active revenue account to sell to.");
  const taxCode = await tx.query<{ code: string }>(
    `select code from tax_codes where is_active and category = 'standard' and available_on in ('sales', 'both') and effective_from <= $1
        and (effective_to is null or effective_to >= $1) order by id limit 1`,
    [today],
  );
  const gst = (await contactSalesTaxCodeFor(tx, locked.contactId)) ?? taxCode.rows[0]?.code ?? null;
  const { salesOrder } = await createSalesOrder(tx, {
    source: "crm",
    idempotencyKey: `opportunity-so-${locked.id}`,
    contactId: locked.contactId,
    orderDate: today,
    amountsMode: gst ? "exclusive" : "no_tax",
    reference: locked.name.slice(0, 100),
    lines: [{ description: locked.name, quantity: "1", unitPrice: locked.amount, accountCode: account.rows[0].code, taxCode: gst }],
  });
  if (salesOrder.currencyCode !== locked.currencyCode) {
    throw new ConflictError(`This opportunity is in ${locked.currencyCode}, but ${locked.contactName}'s sales orders are in ${salesOrder.currencyCode}.`);
  }
  await tx.query("update crm_opportunities set sales_order_id = $2, updated_at = now() where id = $1", [locked.id, salesOrder.id]);
  await writeAuditEvent(tx, {
    eventType: "crm.opportunity_sales_order",
    entityType: "crm_opportunity",
    entityId: locked.id,
    details: { salesOrderId: salesOrder.id },
  });
  return { created: true, salesOrder };
}

// ---------------------------------------------------------------------------
// Targets shared by tasks and activities

type Targets = { contactId: string | null; personId: string | null; opportunityId: string | null };

async function parseTargets(tx: OrgTx, input: { contactId?: unknown; personId?: unknown; opportunityId?: unknown }, current: Targets | null): Promise<Targets> {
  const pick = (value: unknown, now: string | null, what: string) => (value === undefined ? now : optionalId(value === "" ? null : value, what));
  const targets = {
    contactId: pick(input.contactId, current?.contactId ?? null, "contactId"),
    personId: pick(input.personId, current?.personId ?? null, "personId"),
    opportunityId: pick(input.opportunityId, current?.opportunityId ?? null, "opportunityId"),
  };
  if (targets.contactId) await requireContact(tx, targets.contactId);
  if (targets.personId) await getPerson(tx, targets.personId);
  if (targets.opportunityId) await getOpportunity(tx, targets.opportunityId);
  return targets;
}

const TARGET_JOINS = `left join contacts c on c.id = x.contact_id
  left join crm_people p on p.id = x.person_id
  left join crm_opportunities o on o.id = x.opportunity_id`;
const TARGET_COLUMNS = `x.contact_id, c.name as contact_name, x.person_id,
  nullif(concat_ws(' ', p.first_name, p.last_name), '') as person_name, x.opportunity_id, o.name as opportunity_name`;

type TargetRow = {
  contact_id: string | null;
  contact_name: string | null;
  person_id: string | null;
  person_name: string | null;
  opportunity_id: string | null;
  opportunity_name: string | null;
};

function targetsOf(row: TargetRow) {
  return {
    contactId: row.contact_id,
    contactName: row.contact_name,
    personId: row.person_id,
    personName: row.person_name,
    opportunityId: row.opportunity_id,
    opportunityName: row.opportunity_name,
  };
}

/**
 * Records about a company include ones about its people and its
 * opportunities, so the company page shows them all.
 */
const ABOUT_CONTACT = `($1::bigint is null or x.contact_id = $1 or p.contact_id = $1 or o.contact_id = $1)`;

// ---------------------------------------------------------------------------
// Tasks (CRM6)

type TaskRow = TargetRow & {
  id: string;
  title: string;
  body: string | null;
  due_date: string | null;
  status: TaskStatus;
  assignee_user_id: string | null;
  completed_at: string | null;
  created_by_email: string | null;
  created_at: string;
};

const TASK_SELECT = `select x.id, x.title, x.body, x.due_date::text, x.status, x.assignee_user_id, x.completed_at, x.created_by_email, x.created_at,
  ${TARGET_COLUMNS} from crm_tasks x ${TARGET_JOINS}`;

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    dueDate: row.due_date,
    status: row.status,
    assigneeUserId: row.assignee_user_id,
    ...targetsOf(row),
    completedAt: row.completed_at,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export async function listTasks(
  tx: OrgTx,
  options: { contactId?: unknown; personId?: unknown; opportunityId?: unknown; open?: boolean; assigneeUserId?: unknown } = {},
): Promise<Task[]> {
  const contactId = optionalId(options.contactId, "contactId");
  const personId = optionalId(options.personId, "personId");
  const opportunityId = optionalId(options.opportunityId, "opportunityId");
  const assignee = typeof options.assigneeUserId === "string" && options.assigneeUserId ? options.assigneeUserId : null;
  const result = await tx.query<TaskRow>(
    `${TASK_SELECT}
      where ${ABOUT_CONTACT} and ($2::bigint is null or x.person_id = $2) and ($3::bigint is null or x.opportunity_id = $3)
        and (not $4::boolean or x.status <> 'done') and ($5::text is null or x.assignee_user_id = $5)
      order by x.status = 'done', x.due_date nulls last, x.id`,
    [contactId, personId, opportunityId, options.open ?? false, assignee],
  );
  return result.rows.map(toTask);
}

async function getTask(tx: OrgTx, id: string): Promise<Task> {
  const result = await tx.query<TaskRow>(`${TASK_SELECT} where x.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Task not found.");
  return toTask(result.rows[0]);
}

type TaskInput = {
  title?: unknown;
  body?: unknown;
  dueDate?: unknown;
  status?: unknown;
  assigneeUserId?: unknown;
  contactId?: unknown;
  personId?: unknown;
  opportunityId?: unknown;
};

async function taskValues(tx: OrgTx, input: TaskInput, current: Task | null) {
  if (input.status !== undefined && !(TASK_STATUSES as readonly unknown[]).includes(input.status)) {
    throw new ValidationError("The status must be todo, in_progress or done.");
  }
  return {
    title: input.title === undefined && current ? current.title : requireString(input.title, "title", { maxLength: 200 }),
    body: input.body === undefined ? (current?.body ?? null) : optionalString(input.body, "details", { maxLength: 4000 }),
    dueDate: input.dueDate === undefined ? (current?.dueDate ?? null) : parseOptionalIsoDate(input.dueDate, "due date"),
    status: (input.status ?? current?.status ?? "todo") as TaskStatus,
    assigneeUserId: input.assigneeUserId === undefined ? (current?.assigneeUserId ?? null) : await parseMember(tx, input.assigneeUserId, "The assignee"),
    ...(await parseTargets(tx, input, current)),
  };
}

export async function createTask(tx: OrgTx, input: TaskInput): Promise<Task> {
  await requireCrm(tx);
  const v = await taskValues(tx, input, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into crm_tasks (title, body, due_date, status, assignee_user_id, contact_id, person_id, opportunity_id, created_by_email, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $4 = 'done' then now() end) returning id`,
    [v.title, v.body, v.dueDate, v.status, v.assigneeUserId, v.contactId, v.personId, v.opportunityId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.task_created", entityType: "crm_task", entityId: id, details: v });
  return getTask(tx, id);
}

export async function updateTask(tx: OrgTx, idInput: unknown, input: TaskInput): Promise<Task> {
  await requireCrm(tx);
  const current = await getTask(tx, requireId(idInput, "taskId"));
  const v = await taskValues(tx, input, current);
  await tx.query(
    `update crm_tasks set title = $2, body = $3, due_date = $4, status = $5, assignee_user_id = $6, contact_id = $7, person_id = $8,
            opportunity_id = $9, completed_at = case when $5 = 'done' then coalesce(completed_at, now()) end, updated_at = now()
      where id = $1`,
    [current.id, v.title, v.body, v.dueDate, v.status, v.assigneeUserId, v.contactId, v.personId, v.opportunityId],
  );
  await writeAuditEvent(tx, {
    eventType: "crm.task_updated",
    entityType: "crm_task",
    entityId: current.id,
    details: { ...v, ...(v.status !== current.status ? { statusFrom: current.status } : {}) },
  });
  return getTask(tx, current.id);
}

// ---------------------------------------------------------------------------
// Activities (CRM7)

type ActivityRow = TargetRow & {
  id: string;
  kind: ActivityKind;
  happened_at: string;
  subject: string;
  body: string | null;
  created_by_email: string | null;
  created_at: string;
};

const ACTIVITY_SELECT = `select x.id, x.kind, x.happened_at, x.subject, x.body, x.created_by_email, x.created_at, ${TARGET_COLUMNS}
  from crm_activities x ${TARGET_JOINS}`;

function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    kind: row.kind,
    happenedAt: new Date(row.happened_at).toISOString(),
    subject: row.subject,
    body: row.body,
    ...targetsOf(row),
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export async function listActivities(
  tx: OrgTx,
  options: { contactId?: unknown; personId?: unknown; opportunityId?: unknown } = {},
): Promise<Activity[]> {
  const contactId = optionalId(options.contactId, "contactId");
  const personId = optionalId(options.personId, "personId");
  const opportunityId = optionalId(options.opportunityId, "opportunityId");
  const result = await tx.query<ActivityRow>(
    `${ACTIVITY_SELECT}
      where ${ABOUT_CONTACT} and ($2::bigint is null or x.person_id = $2) and ($3::bigint is null or x.opportunity_id = $3)
      order by x.happened_at desc, x.id desc
      limit 500`,
    [contactId, personId, opportunityId],
  );
  return result.rows.map(toActivity);
}

async function getActivity(tx: OrgTx, id: string): Promise<Activity> {
  const result = await tx.query<ActivityRow>(`${ACTIVITY_SELECT} where x.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Activity not found.");
  return toActivity(result.rows[0]);
}

type ActivityInput = {
  kind?: unknown;
  happenedAt?: unknown;
  subject?: unknown;
  body?: unknown;
  contactId?: unknown;
  personId?: unknown;
  opportunityId?: unknown;
};

function parseHappenedAt(input: unknown): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input))) throw new ValidationError("When it happened must be a date and time.");
  return new Date(input).toISOString();
}

async function activityValues(tx: OrgTx, input: ActivityInput, current: Activity | null) {
  if (input.kind !== undefined && !(ACTIVITY_KINDS as readonly unknown[]).includes(input.kind)) {
    throw new ValidationError("The kind must be call, meeting or note.");
  }
  const targets = await parseTargets(tx, input, current);
  if (!targets.contactId && !targets.personId && !targets.opportunityId) {
    throw new ValidationError("An activity must be about a company, a person or an opportunity.");
  }
  return {
    kind: (input.kind ?? current?.kind ?? "note") as ActivityKind,
    happenedAt: input.happenedAt === undefined ? (current?.happenedAt ?? new Date().toISOString()) : parseHappenedAt(input.happenedAt),
    subject: input.subject === undefined && current ? current.subject : requireString(input.subject, "subject", { maxLength: 200 }),
    body: input.body === undefined ? (current?.body ?? null) : optionalString(input.body, "details", { maxLength: 10000 }),
    ...targets,
  };
}

export async function createActivity(tx: OrgTx, input: ActivityInput): Promise<Activity> {
  await requireCrm(tx);
  const v = await activityValues(tx, input, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into crm_activities (kind, happened_at, subject, body, contact_id, person_id, opportunity_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [v.kind, v.happenedAt, v.subject, v.body, v.contactId, v.personId, v.opportunityId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.activity_created", entityType: "crm_activity", entityId: id, details: v });
  return getActivity(tx, id);
}

export async function updateActivity(tx: OrgTx, idInput: unknown, input: ActivityInput): Promise<Activity> {
  await requireCrm(tx);
  const current = await getActivity(tx, requireId(idInput, "activityId"));
  const v = await activityValues(tx, input, current);
  await tx.query(
    `update crm_activities set kind = $2, happened_at = $3, subject = $4, body = $5, contact_id = $6, person_id = $7, opportunity_id = $8,
            updated_at = now()
      where id = $1`,
    [current.id, v.kind, v.happenedAt, v.subject, v.body, v.contactId, v.personId, v.opportunityId],
  );
  await writeAuditEvent(tx, { eventType: "crm.activity_updated", entityType: "crm_activity", entityId: current.id, details: v });
  return getActivity(tx, current.id);
}

// ---------------------------------------------------------------------------
// The CRM's Home (CRM10)

export type CrmHome = {
  /** The business date the tasks were judged due by. */
  today: string;
  /** The signed-in person's open opportunities, in pipeline order. */
  opportunities: Opportunity[];
  /** Their amounts per currency, base currency first; never added across currencies (MC68). */
  totals: Array<{ currencyCode: string; amount: string; count: number }>;
  /** The signed-in person's tasks that aren't done and are due today or earlier, oldest due first. */
  tasks: Task[];
  /** The organisation's most recent calls, meetings and notes, newest first. */
  activities: Activity[];
};

const HOME_ACTIVITIES = 10;

/** What the signed-in person (`tx.actor`) has on: read-only (example CRM10). */
export async function crmHome(tx: OrgTx): Promise<CrmHome> {
  const today = todayIsoDate();
  const me = tx.actor.userId;
  const opportunities = me
    ? (
        await tx.query<OpportunityRow>(
          `${OPPORTUNITY_SELECT}
            where o.owner_user_id = $1 and s.stage_type = 'open'
            order by s.sort_order, o.position, o.id`,
          [me],
        )
      ).rows.map(toOpportunity)
    : [];
  const sums = new Map<string, { amount: Decimal; count: number }>();
  for (const opportunity of opportunities) {
    const sum = sums.get(opportunity.currencyCode) ?? { amount: ZERO_DECIMAL, count: 0 };
    sums.set(opportunity.currencyCode, { amount: add(sum.amount, dec(opportunity.amount)), count: sum.count + 1 });
  }
  const totals = [...sums.entries()]
    .sort(([a], [b]) => (a === tx.baseCurrency ? -1 : b === tx.baseCurrency ? 1 : a.localeCompare(b)))
    .map(([currencyCode, sum]) => ({ currencyCode, amount: toFixedString(sum.amount, 2), count: sum.count }));
  const tasks = me
    ? (
        await tx.query<TaskRow>(
          `${TASK_SELECT}
            where x.assignee_user_id = $1 and x.status <> 'done' and x.due_date <= $2::date
            order by x.due_date, x.id`,
          [me, today],
        )
      ).rows.map(toTask)
    : [];
  const activities = (
    await tx.query<ActivityRow>(`${ACTIVITY_SELECT} order by x.happened_at desc, x.id desc limit $1`, [HOME_ACTIVITIES])
  ).rows.map(toActivity);
  return { today, opportunities, totals, tasks, activities };
}

// ---------------------------------------------------------------------------
// Companies and the timeline (CRM8)

export type CompanySummary = {
  contactId: string;
  name: string;
  isCustomer: boolean;
  isSupplier: boolean;
  isProspect: boolean;
  isArchived: boolean;
  people: number;
  openTasks: number;
  /** Open opportunities (in an Open stage, not Closed won or lost), excluding GST, in `currencyCode`. */
  openPipeline: string;
  /** The company's currency (MC68): its opportunities and documents are in it. */
  currencyCode: string;
  lastActivityAt: string | null;
  /** The company's contact custom field values, for list columns (CRMF7). */
  customFields: CustomValues;
};

export async function listCompanies(tx: OrgTx, options: { search?: unknown; includeArchived?: boolean } = {}): Promise<CompanySummary[]> {
  const search = optionalString(options.search, "search", { maxLength: 100 });
  const pattern = search === null ? null : `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const result = await tx.query<{
    id: string;
    name: string;
    is_customer: boolean;
    is_supplier: boolean;
    is_prospect: boolean;
    is_archived: boolean;
    currency_code: string | null;
    people: string;
    open_tasks: string;
    open_pipeline: string;
    last_activity_at: string | null;
    custom_fields: CustomValues;
  }>(
    `select c.id, c.name, c.is_customer, c.is_supplier, c.is_prospect, c.is_archived, c.currency_code, c.custom_fields,
            (select count(*) from crm_people p where p.contact_id = c.id and not p.is_archived)::text as people,
            (select count(*) from crm_tasks t
               left join crm_people p on p.id = t.person_id left join crm_opportunities o on o.id = t.opportunity_id
              where t.status <> 'done' and (t.contact_id = c.id or p.contact_id = c.id or o.contact_id = c.id))::text as open_tasks,
            (select coalesce(sum(o.amount), 0) from crm_opportunities o
              where o.contact_id = c.id and o.stage in (select key from crm_opportunity_stages where stage_type = 'open'))::text as open_pipeline,
            (select max(a.happened_at) from crm_activities a
               left join crm_people p on p.id = a.person_id left join crm_opportunities o on o.id = a.opportunity_id
              where a.contact_id = c.id or p.contact_id = c.id or o.contact_id = c.id) as last_activity_at
       from contacts c
      where ($1::boolean or not c.is_archived) and ($2::text is null or c.name ilike $2 or c.email ilike $2)
      order by lower(c.name), c.id`,
    [options.includeArchived ?? false, pattern],
  );
  return result.rows.map((row) => ({
    contactId: row.id,
    name: row.name,
    isCustomer: row.is_customer,
    isSupplier: row.is_supplier,
    isProspect: row.is_prospect,
    isArchived: row.is_archived,
    people: Number(row.people),
    openTasks: Number(row.open_tasks),
    openPipeline: toFixedString(dec(row.open_pipeline), 2),
    currencyCode: row.currency_code ?? tx.baseCurrency,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
    customFields: row.custom_fields ?? {},
  }));
}

export type TimelineEntry = {
  kind:
    | "activity"
    | "task"
    | "opportunity_created"
    | "opportunity_stage"
    | "invoice"
    | "credit_note"
    | "customer_payment"
    | "bill"
    | "supplier_payment"
    | "email"
    | "meeting";
  at: string;
  title: string;
  detail: string | null;
  amount: string | null;
  href: string | null;
  by: string | null;
};

/**
 * Everything that happened with a company, newest first (CRM8): its CRM
 * records and its approved documents and payments.
 */
export async function companyTimeline(tx: OrgTx, contactIdInput: unknown): Promise<TimelineEntry[]> {
  const contactId = requireId(contactIdInput, "contactId");
  await requireContact(tx, contactId);
  return timelineFor(tx, { contactId });
}

/**
 * A person's timeline for their record page (CRT11): their activities,
 * tasks, the opportunities they're the point of contact for, and their
 * synced emails and meetings.
 */
export async function personTimeline(tx: OrgTx, personIdInput: unknown): Promise<TimelineEntry[]> {
  const person = await getPerson(tx, personIdInput);
  return timelineFor(tx, { personId: person.id });
}

/**
 * An opportunity's timeline for its record page (CRT11): its activities,
 * tasks, stage changes, and its invoice once approved and paid.
 */
export async function opportunityTimeline(tx: OrgTx, opportunityIdInput: unknown): Promise<TimelineEntry[]> {
  const opportunity = await getOpportunity(tx, opportunityIdInput);
  return timelineFor(tx, { opportunityId: opportunity.id });
}

/** One row of an opportunity's stage history (CRMS6). Probability and category are null for changes made before they were kept. */
export type StageHistoryEntry = {
  at: string;
  by: string | null;
  stage: OpportunityStage;
  stageName: string;
  amount: string;
  probability: number | null;
  forecastCategory: ForecastCategory | null;
  weightedAmount: string | null;
  closeDate: string | null;
};

/**
 * An opportunity's stage history, newest first (CRMS6, decision 83), after
 * Salesforce's Stage History: a row when it was added and whenever its
 * stage, amount, probability, forecast category or expected close date
 * changed, with who and when. It's read from the audit history.
 */
export async function opportunityStageHistory(tx: OrgTx, opportunityIdInput: unknown): Promise<StageHistoryEntry[]> {
  const opportunity = await getOpportunity(tx, opportunityIdInput);
  const minor = currencyMinorUnits(opportunity.currencyCode);
  const stageNames = new Map((await listStages(tx)).map((stage) => [stage.key, stage.name]));
  const events = await tx.query<{ details: Record<string, unknown>; actor_email: string | null; created_at: string }>(
    `select details, actor_email, created_at from audit_events
      where entity_type = 'crm_opportunity' and entity_id = $1 and event_type in ('crm.opportunity_created', 'crm.opportunity_updated')
      order by id`,
    [opportunity.id],
  );
  const rows: StageHistoryEntry[] = [];
  let last: StageHistoryEntry | null = null;
  for (const event of events.rows) {
    const d = event.details;
    const stage = String(d.stage ?? last?.stage ?? opportunity.stage);
    const amount = toFixedString(dec(String(d.amount ?? last?.amount ?? "0")), 2);
    const probability = typeof d.probability === "number" ? d.probability : null;
    const forecastCategory = isForecastCategory(d.forecastCategory) ? d.forecastCategory : null;
    const closeDate = d.closeDate === undefined ? (last?.closeDate ?? null) : ((d.closeDate as string | null) ?? null);
    const changed =
      last === null ||
      stage !== last.stage ||
      amount !== last.amount ||
      closeDate !== last.closeDate ||
      (probability !== null && last.probability !== null && probability !== last.probability) ||
      (forecastCategory !== null && last.forecastCategory !== null && forecastCategory !== last.forecastCategory);
    const entry: StageHistoryEntry = {
      at: new Date(event.created_at).toISOString(),
      by: event.actor_email,
      stage,
      stageName: stageNames.get(stage) ?? stage,
      amount,
      probability,
      forecastCategory,
      weightedAmount: probability === null ? null : weightedAmount(amount, probability, minor),
      closeDate,
    };
    if (changed) rows.push(entry);
    last = entry;
  }
  return rows.reverse();
}

type TimelineTarget = { contactId: string } | { personId: string } | { opportunityId: string };

async function timelineFor(tx: OrgTx, target: TimelineTarget): Promise<TimelineEntry[]> {
  const contactId = "contactId" in target ? target.contactId : null;
  const personId = "personId" in target ? target.personId : null;
  const opportunityId = "opportunityId" in target ? target.opportunityId : null;
  const entries: TimelineEntry[] = [];
  for (const activity of await listActivities(tx, target)) {
    entries.push({
      kind: "activity",
      at: activity.happenedAt,
      title: `${ACTIVITY_KIND_LABELS[activity.kind]}: ${activity.subject}`,
      detail: [activity.personName, activity.opportunityName, activity.body].filter(Boolean).join(" · ") || null,
      amount: null,
      href: null,
      by: activity.createdByEmail,
    });
  }
  for (const task of await listTasks(tx, target)) {
    entries.push({
      kind: "task",
      at: task.completedAt ? new Date(task.completedAt).toISOString() : new Date(task.createdAt).toISOString(),
      title: `Task ${task.status === "done" ? "done" : "added"}: ${task.title}`,
      detail: [task.dueDate ? `due ${task.dueDate}` : null, TASK_STATUS_LABELS[task.status]].filter(Boolean).join(" · "),
      amount: null,
      href: "/crm/tasks",
      by: task.createdByEmail,
    });
  }
  const events = await tx.query<{ entity_id: string; event_type: string; details: Record<string, unknown>; actor_email: string | null; created_at: string; name: string }>(
    `select e.entity_id, e.event_type, e.details, e.actor_email, e.created_at, o.name
       from audit_events e join crm_opportunities o on o.id::text = e.entity_id
      where e.entity_type = 'crm_opportunity'
        and (o.contact_id = $1 or o.point_of_contact_id = $2 or o.id = $3)
        and (e.event_type = 'crm.opportunity_created' or (e.event_type = 'crm.opportunity_updated' and e.details ? 'stageFrom'))`,
    [contactId, personId, opportunityId],
  );
  const stageNames = new Map((await listStages(tx)).map((stage) => [stage.key, stage.name]));
  const stageName = (key: unknown) => stageNames.get(String(key)) ?? String(key);
  for (const event of events.rows) {
    const stage = event.details.stage;
    const from = event.details.stageFrom;
    entries.push({
      kind: event.event_type === "crm.opportunity_created" ? "opportunity_created" : "opportunity_stage",
      at: new Date(event.created_at).toISOString(),
      title: event.event_type === "crm.opportunity_created" ? `Opportunity added: ${event.name}` : `Opportunity ${event.name}: ${stageName(from)} → ${stageName(stage)}`,
      detail: event.event_type === "crm.opportunity_created" ? stageName(stage) : null,
      amount: event.event_type === "crm.opportunity_created" ? toFixedString(dec(String(event.details.amount ?? "0")), 2) : null,
      href: `/crm/opportunities/${event.entity_id}`,
      by: event.actor_email,
    });
  }
  const documents = await tx.query<{ kind: TimelineEntry["kind"]; id: string; label: string; at: string; amount: string; by: string | null }>(
    `select 'invoice' as kind, id::text, coalesce(invoice_number, 'Invoice') as label, approved_at as at, total::text as amount, approved_by_email as by
       from sales_invoices where contact_id = $1 and approved_at is not null
     union all
     select 'credit_note', id::text, coalesce(credit_note_number, 'Credit note'), approved_at, total::text, approved_by_email
       from sales_credit_notes where contact_id = $1 and approved_at is not null
     union all
     select 'customer_payment', p.invoice_id::text, coalesce(i.invoice_number, 'Invoice'), p.created_at, p.amount::text, p.created_by_email
       from customer_payments p join sales_invoices i on i.id = p.invoice_id where i.contact_id = $1 and p.status = 'active'
     union all
     select 'bill', id::text, supplier_invoice_number, approved_at, total::text, approved_by_email
       from bills where contact_id = $1 and approved_at is not null
     union all
     select 'supplier_payment', p.bill_id::text, b.supplier_invoice_number, p.created_at, p.amount::text, p.created_by_email
       from supplier_payments p join bills b on b.id = p.bill_id where b.contact_id = $1 and p.status = 'active'
     union all
     select 'invoice', i.id::text, coalesce(i.invoice_number, 'Invoice'), i.approved_at, i.total::text, i.approved_by_email
       from crm_opportunities o join sales_invoices i on i.id = o.invoice_id where o.id = $2 and i.approved_at is not null
     union all
     select 'customer_payment', p.invoice_id::text, coalesce(i.invoice_number, 'Invoice'), p.created_at, p.amount::text, p.created_by_email
       from crm_opportunities o join sales_invoices i on i.id = o.invoice_id join customer_payments p on p.invoice_id = i.id
      where o.id = $2 and p.status = 'active'`,
    [contactId, opportunityId],
  );
  const titles: Record<string, string> = {
    invoice: "Invoice approved",
    credit_note: "Credit note approved",
    customer_payment: "Payment received for",
    bill: "Bill approved",
    supplier_payment: "Payment made for",
  };
  const hrefs: Record<string, (id: string) => string> = {
    invoice: (id) => `/operations/invoices/${id}`,
    credit_note: (id) => `/operations/credit-notes/${id}`,
    customer_payment: (id) => `/operations/invoices/${id}`,
    bill: (id) => `/operations/bills/${id}`,
    supplier_payment: (id) => `/operations/bills/${id}`,
  };
  for (const doc of documents.rows) {
    entries.push({
      kind: doc.kind,
      at: new Date(doc.at).toISOString(),
      title: `${titles[doc.kind]} ${doc.label}`,
      detail: null,
      amount: toFixedString(dec(doc.amount), 2),
      href: hrefs[doc.kind](doc.id),
      by: doc.by,
    });
  }
  // Synced emails and meetings (MAIL6), hidden where their mailbox's owner chose so (MAIL7).
  const synced = opportunityId ? { emails: [], meetings: [] } : await syncedFor(tx, { contactId, personId });
  for (const email of synced.emails) {
    entries.push({
      kind: "email",
      at: email.sentAt,
      title: `${email.direction === "sent" ? "Email sent" : "Email received"}: ${email.subject ?? "(no subject)"}`,
      detail: [email.direction === "sent" ? `to ${email.toEmails.join(", ")}` : `from ${email.fromName ?? email.fromEmail}`, email.preview]
        .filter(Boolean)
        .join(" · "),
      amount: null,
      href: null,
      by: email.mailbox,
    });
  }
  for (const meeting of synced.meetings) {
    entries.push({
      kind: "meeting",
      at: meeting.startsAt,
      title: `Meeting: ${meeting.title ?? "(no title)"}`,
      detail: [meeting.location, meeting.attendeeEmails.join(", ")].filter(Boolean).join(" · "),
      amount: null,
      href: null,
      by: meeting.mailbox,
    });
  }
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// ---------------------------------------------------------------------------
// Record pages (CRT11)

export type RelatedDocument = {
  id: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  status: "draft" | "approved" | "voided";
  currencyCode: string;
  total: string;
};

export type CompanyRelated = {
  /** The newest 50 invoices, drafts included; `invoiceCount` counts them all. */
  invoices: RelatedDocument[];
  invoiceCount: number;
  creditNotes: RelatedDocument[];
  creditNoteCount: number;
  notesCount: number;
  filesCount: number;
};

const RELATED_LIMIT = 50;

/**
 * A company's related lists for its record page (CRT11), after Salesforce's
 * related lists on an account: its invoices and credit notes (drafts too, as
 * the operations lists show them) and how many notes and files it has.
 */
export async function companyRelated(tx: OrgTx, contactIdInput: unknown): Promise<CompanyRelated> {
  const contactId = requireId(contactIdInput, "contactId");
  await requireContact(tx, contactId);
  type Row = { id: string; number: string | null; date: string; due_date: string | null; status: RelatedDocument["status"]; currency_code: string; total: string };
  const toDocument = (row: Row): RelatedDocument => ({
    id: row.id,
    number: row.number,
    date: row.date,
    dueDate: row.due_date,
    status: row.status,
    currencyCode: row.currency_code,
    total: toFixedString(dec(row.total), 2),
  });
  const invoices = await tx.query<Row>(
    `select id, invoice_number as number, invoice_date::text as date, due_date::text, status, currency_code, total::text
       from sales_invoices where contact_id = $1 order by invoice_date desc, id desc limit ${RELATED_LIMIT}`,
    [contactId],
  );
  const creditNotes = await tx.query<Row>(
    `select id, credit_note_number as number, credit_note_date::text as date, null as due_date, status, currency_code, total::text
       from sales_credit_notes where contact_id = $1 order by credit_note_date desc, id desc limit ${RELATED_LIMIT}`,
    [contactId],
  );
  const counts = await tx.query<{ invoices: number; credit_notes: number; notes: number; files: number }>(
    `select (select count(*)::int from sales_invoices where contact_id = $1) as invoices,
            (select count(*)::int from sales_credit_notes where contact_id = $1) as credit_notes,
            (select count(*)::int from record_notes where record_type = 'contact' and record_id = $1 and deleted_at is null) as notes,
            (select count(*)::int from record_attachments where record_type = 'contact' and record_id = $1 and removed_at is null) as files`,
    [contactId],
  );
  return {
    invoices: invoices.rows.map(toDocument),
    invoiceCount: counts.rows[0].invoices,
    creditNotes: creditNotes.rows.map(toDocument),
    creditNoteCount: counts.rows[0].credit_notes,
    notesCount: counts.rows[0].notes,
    filesCount: counts.rows[0].files,
  };
}

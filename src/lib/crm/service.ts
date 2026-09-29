import { writeAuditEvent } from "@/lib/audit";
import { updateContact } from "@/lib/contacts/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { createInvoice, getInvoice, type Invoice } from "@/lib/invoices/service";
import { cmp, dec, toFixedString } from "@/lib/money/decimal";
import { parseOptionalIsoDate } from "@/lib/dates";
import { listMembers } from "@/lib/organisations/members";
import { optionalId, optionalString, requireId, requireString } from "@/lib/validation";

/**
 * The CRM module (examples MOD1, CRM1-CRM9), after Twenty
 * (https://github.com/twentyhq/twenty, AGPL-3.0): its companies (Tohyee's
 * contacts), people, opportunities with Twenty's pipeline stages, tasks, and
 * notes (here activities: calls, meetings and notes), and a timeline per
 * company. Only an opportunity's invoice ever reaches the ledger, and only
 * when that draft is approved.
 */

export const OPPORTUNITY_STAGES = ["new", "screening", "meeting", "proposal", "won", "lost"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];
export const OPPORTUNITY_STAGE_LABELS: Record<OpportunityStage, string> = {
  new: "New",
  screening: "Screening",
  meeting: "Meeting",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};
/** Open opportunities are still being worked on. */
export const OPEN_STAGES: readonly OpportunityStage[] = ["new", "screening", "meeting", "proposal"];

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
  isArchived: boolean;
};

export type Opportunity = {
  id: string;
  name: string;
  contactId: string;
  contactName: string;
  pointOfContactId: string | null;
  pointOfContactName: string | null;
  ownerUserId: string | null;
  amount: string;
  closeDate: string | null;
  stage: OpportunityStage;
  position: number;
  invoiceId: string | null;
  invoiceNumber: string | null;
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

export async function crmEnabled(tx: OrgTx): Promise<boolean> {
  const result = await tx.query<{ crm_enabled: boolean }>("select crm_enabled from organisation_settings where id = true");
  return result.rows[0]?.crm_enabled === true;
}

/** Refuses CRM commands while the module is off (MOD1). */
export async function requireCrm(tx: OrgTx): Promise<void> {
  if (!(await crmEnabled(tx))) throw new ConflictError("The CRM is off. An admin can turn it on in Settings.");
}

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

async function requireContact(tx: OrgTx, id: string): Promise<{ id: string; name: string }> {
  const found = await tx.query<{ id: string; name: string }>("select id, name from contacts where id = $1", [id]);
  if (!found.rows[0]) throw new ValidationError(`There's no contact #${id}.`);
  return found.rows[0];
}

// ---------------------------------------------------------------------------
// People (CRM2)

const PERSON_SELECT = `select p.id, p.contact_id, c.name as contact_name, p.first_name, p.last_name, p.job_title, p.email, p.phone, p.is_archived
  from crm_people p left join contacts c on c.id = p.contact_id`;

type PersonRow = {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  first_name: string;
  last_name: string | null;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  is_archived: boolean;
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
    isArchived: row.is_archived,
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

type PersonInput = { contactId?: unknown; firstName?: unknown; lastName?: unknown; jobTitle?: unknown; email?: unknown; phone?: unknown; isArchived?: unknown };

async function personValues(tx: OrgTx, input: PersonInput, current: Person | null) {
  const contactId = input.contactId === undefined ? (current?.contactId ?? null) : optionalId(input.contactId === "" ? null : input.contactId, "contactId");
  if (contactId) await requireContact(tx, contactId);
  if (input.isArchived !== undefined && typeof input.isArchived !== "boolean") throw new ValidationError("isArchived must be true or false.");
  return {
    contactId,
    firstName: input.firstName === undefined && current ? current.firstName : requireString(input.firstName, "first name", { maxLength: 100 }),
    lastName: input.lastName === undefined ? (current?.lastName ?? null) : optionalString(input.lastName, "last name", { maxLength: 100 }),
    jobTitle: input.jobTitle === undefined ? (current?.jobTitle ?? null) : optionalString(input.jobTitle, "job title", { maxLength: 100 }),
    email: input.email === undefined ? (current?.email ?? null) : parseEmail(input.email),
    phone: input.phone === undefined ? (current?.phone ?? null) : optionalString(input.phone, "phone", { maxLength: 50 }),
    isArchived: input.isArchived === undefined ? (current?.isArchived ?? false) : (input.isArchived as boolean),
  };
}

export async function createPerson(tx: OrgTx, input: PersonInput): Promise<Person> {
  await requireCrm(tx);
  const values = await personValues(tx, input, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into crm_people (contact_id, first_name, last_name, job_title, email, phone) values ($1, $2, $3, $4, $5, $6) returning id`,
    [values.contactId, values.firstName, values.lastName, values.jobTitle, values.email, values.phone],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.person_created", entityType: "crm_person", entityId: id, details: values });
  return getPerson(tx, id);
}

export async function updatePerson(tx: OrgTx, idInput: unknown, input: PersonInput): Promise<Person> {
  await requireCrm(tx);
  const current = await getPerson(tx, idInput);
  const values = await personValues(tx, input, current);
  await tx.query(
    `update crm_people set contact_id = $2, first_name = $3, last_name = $4, job_title = $5, email = $6, phone = $7, is_archived = $8, updated_at = now()
      where id = $1`,
    [current.id, values.contactId, values.firstName, values.lastName, values.jobTitle, values.email, values.phone, values.isArchived],
  );
  await writeAuditEvent(tx, { eventType: "crm.person_updated", entityType: "crm_person", entityId: current.id, details: values });
  return getPerson(tx, current.id);
}

// ---------------------------------------------------------------------------
// Opportunities (CRM3-CRM5, CRM9)

const OPPORTUNITY_SELECT = `select o.id, o.name, o.contact_id, c.name as contact_name, o.point_of_contact_id,
    nullif(concat_ws(' ', p.first_name, p.last_name), '') as point_of_contact_name, o.owner_user_id, o.amount::text,
    o.close_date::text, o.stage, o.position, o.invoice_id, i.invoice_number, o.created_at, o.updated_at
  from crm_opportunities o
  join contacts c on c.id = o.contact_id
  left join crm_people p on p.id = o.point_of_contact_id
  left join sales_invoices i on i.id = o.invoice_id`;

type OpportunityRow = {
  id: string;
  name: string;
  contact_id: string;
  contact_name: string;
  point_of_contact_id: string | null;
  point_of_contact_name: string | null;
  owner_user_id: string | null;
  amount: string;
  close_date: string | null;
  stage: OpportunityStage;
  position: number;
  invoice_id: string | null;
  invoice_number: string | null;
  created_at: string;
  updated_at: string;
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
    closeDate: row.close_date,
    stage: row.stage,
    position: row.position,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
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
      order by array_position(array['new','screening','meeting','proposal','won','lost'], o.stage), o.position, o.id`,
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

function parseStage(input: unknown): OpportunityStage {
  if (typeof input !== "string" || !(OPPORTUNITY_STAGES as readonly string[]).includes(input)) {
    throw new ValidationError(`The stage must be one of ${OPPORTUNITY_STAGES.join(", ")}.`);
  }
  return input as OpportunityStage;
}

type OpportunityInput = {
  name?: unknown;
  contactId?: unknown;
  pointOfContactId?: unknown;
  ownerUserId?: unknown;
  amount?: unknown;
  closeDate?: unknown;
  stage?: unknown;
};

async function opportunityValues(tx: OrgTx, input: OpportunityInput, current: Opportunity | null) {
  const contactId = input.contactId === undefined && current ? current.contactId : requireId(input.contactId, "contactId");
  await requireContact(tx, contactId);
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
    amount: input.amount === undefined ? (current?.amount ?? "0.00") : parseAmount(input.amount),
    closeDate: input.closeDate === undefined ? (current?.closeDate ?? null) : parseOptionalIsoDate(input.closeDate, "close date"),
    stage: input.stage === undefined ? (current?.stage ?? "new") : parseStage(input.stage),
  };
}

async function nextPosition(tx: OrgTx, stage: OpportunityStage): Promise<number> {
  const result = await tx.query<{ position: number }>("select coalesce(max(position), 0) + 1 as position from crm_opportunities where stage = $1", [stage]);
  return Number(result.rows[0].position);
}

export async function createOpportunity(tx: OrgTx, input: OpportunityInput): Promise<Opportunity> {
  await requireCrm(tx);
  const values = await opportunityValues(tx, input, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into crm_opportunities (name, contact_id, point_of_contact_id, owner_user_id, amount, close_date, stage, position, created_by_email)
     values ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9) returning id`,
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
    ],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.opportunity_created", entityType: "crm_opportunity", entityId: id, details: values });
  return getOpportunity(tx, id);
}

/** Changes an opportunity; a new stage puts it at the end of that column (CRM4). Refused once it has made an invoice. */
export async function updateOpportunity(tx: OrgTx, idInput: unknown, input: OpportunityInput): Promise<Opportunity> {
  await requireCrm(tx);
  const current = await getOpportunity(tx, idInput);
  await tx.query("select id from crm_opportunities where id = $1 for update", [current.id]);
  const values = await opportunityValues(tx, input, current);
  if (current.invoiceId && values.stage !== current.stage) {
    throw new ConflictError("This opportunity has made an invoice, so its stage can't change.");
  }
  const position = values.stage === current.stage ? current.position : await nextPosition(tx, values.stage);
  await tx.query(
    `update crm_opportunities set name = $2, contact_id = $3, point_of_contact_id = $4, owner_user_id = $5, amount = $6::numeric,
            close_date = $7, stage = $8, position = $9, updated_at = now()
      where id = $1`,
    [current.id, values.name, values.contactId, values.pointOfContactId, values.ownerUserId, values.amount, values.closeDate, values.stage, position],
  );
  await writeAuditEvent(tx, {
    eventType: "crm.opportunity_updated",
    entityType: "crm_opportunity",
    entityId: current.id,
    details: { ...values, ...(values.stage !== current.stage ? { stageFrom: current.stage } : {}) },
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
 * (no tax if there isn't one), dated today and due in 20 days. A prospect
 * becomes a customer. Making it again returns the same invoice.
 */
export async function makeInvoiceFromOpportunity(tx: OrgTx, idInput: unknown): Promise<{ created: boolean; invoice: Invoice }> {
  await requireCrm(tx);
  const current = await getOpportunity(tx, idInput);
  await tx.query("select id from crm_opportunities where id = $1 for update", [current.id]);
  const locked = await getOpportunity(tx, current.id);
  if (locked.invoiceId) return { created: false, invoice: await getInvoice(tx, locked.invoiceId) };
  if (locked.stage !== "won") throw new ConflictError("Only a won opportunity can make an invoice. Mark it as Won first.");
  const contact = await tx.query<{ is_customer: boolean }>("select is_customer from contacts where id = $1", [locked.contactId]);
  if (!contact.rows[0]?.is_customer) await updateContact(tx, locked.contactId, { isCustomer: true });
  const today = todayIsoDate();
  const account = await tx.query<{ code: string }>(
    "select code from accounts where is_active and account_class = 'revenue' order by code limit 1",
  );
  if (!account.rows[0]) throw new ValidationError("There's no active revenue account to invoice to.");
  const taxCode = await tx.query<{ code: string }>(
    `select code from tax_codes where is_active and category = 'standard' and effective_from <= $1
        and (effective_to is null or effective_to >= $1) order by id limit 1`,
    [today],
  );
  const gst = taxCode.rows[0]?.code ?? null;
  const { invoice } = await createInvoice(tx, {
    source: "crm",
    idempotencyKey: `opportunity-${locked.id}`,
    contactId: locked.contactId,
    invoiceDate: today,
    dueDate: addDays(today, 20),
    amountsMode: gst ? "exclusive" : "no_tax",
    reference: locked.name.slice(0, 100),
    lines: [{ description: locked.name, quantity: "1", unitPrice: locked.amount, accountCode: account.rows[0].code, taxCode: gst }],
  });
  await tx.query("update crm_opportunities set invoice_id = $2, updated_at = now() where id = $1", [locked.id, invoice.id]);
  await writeAuditEvent(tx, {
    eventType: "crm.opportunity_invoiced",
    entityType: "crm_opportunity",
    entityId: locked.id,
    details: { invoiceId: invoice.id },
  });
  return { created: true, invoice };
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
  /** Open opportunities (not Won or Lost), excluding GST. */
  openPipeline: string;
  lastActivityAt: string | null;
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
    people: string;
    open_tasks: string;
    open_pipeline: string;
    last_activity_at: string | null;
  }>(
    `select c.id, c.name, c.is_customer, c.is_supplier, c.is_prospect, c.is_archived,
            (select count(*) from crm_people p where p.contact_id = c.id and not p.is_archived)::text as people,
            (select count(*) from crm_tasks t
               left join crm_people p on p.id = t.person_id left join crm_opportunities o on o.id = t.opportunity_id
              where t.status <> 'done' and (t.contact_id = c.id or p.contact_id = c.id or o.contact_id = c.id))::text as open_tasks,
            (select coalesce(sum(o.amount), 0) from crm_opportunities o
              where o.contact_id = c.id and o.stage in ('new', 'screening', 'meeting', 'proposal'))::text as open_pipeline,
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
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
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
    | "supplier_payment";
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
  const entries: TimelineEntry[] = [];
  for (const activity of await listActivities(tx, { contactId })) {
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
  for (const task of await listTasks(tx, { contactId })) {
    entries.push({
      kind: "task",
      at: task.completedAt ? new Date(task.completedAt).toISOString() : new Date(task.createdAt).toISOString(),
      title: `Task ${task.status === "done" ? "done" : "added"}: ${task.title}`,
      detail: [task.dueDate ? `due ${task.dueDate}` : null, TASK_STATUS_LABELS[task.status]].filter(Boolean).join(" · "),
      amount: null,
      href: "/operations/crm/tasks",
      by: task.createdByEmail,
    });
  }
  const events = await tx.query<{ entity_id: string; event_type: string; details: Record<string, unknown>; actor_email: string | null; created_at: string; name: string }>(
    `select e.entity_id, e.event_type, e.details, e.actor_email, e.created_at, o.name
       from audit_events e join crm_opportunities o on o.id::text = e.entity_id
      where e.entity_type = 'crm_opportunity' and o.contact_id = $1
        and (e.event_type = 'crm.opportunity_created' or (e.event_type = 'crm.opportunity_updated' and e.details ? 'stageFrom'))`,
    [contactId],
  );
  for (const event of events.rows) {
    const stage = event.details.stage as OpportunityStage;
    const from = event.details.stageFrom as OpportunityStage | undefined;
    entries.push({
      kind: event.event_type === "crm.opportunity_created" ? "opportunity_created" : "opportunity_stage",
      at: new Date(event.created_at).toISOString(),
      title: event.event_type === "crm.opportunity_created" ? `Opportunity added: ${event.name}` : `Opportunity ${event.name}: ${OPPORTUNITY_STAGE_LABELS[from!]} → ${OPPORTUNITY_STAGE_LABELS[stage]}`,
      detail: event.event_type === "crm.opportunity_created" ? OPPORTUNITY_STAGE_LABELS[stage] : null,
      amount: event.event_type === "crm.opportunity_created" ? toFixedString(dec(String(event.details.amount ?? "0")), 2) : null,
      href: "/operations/crm/pipeline",
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
       from supplier_payments p join bills b on b.id = p.bill_id where b.contact_id = $1 and p.status = 'active'`,
    [contactId],
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
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

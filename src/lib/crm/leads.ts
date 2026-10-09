import { writeAuditEvent } from "@/lib/audit";
import { decodeText, RowError } from "@/lib/bank/formats/common";
import { parseDelimited } from "@/lib/bank/formats/table";
import { readXlsxRows } from "@/lib/bank/formats/xlsx";
import { createContact } from "@/lib/contacts/service";
import { type CrmScope, ownerFor, seesLead } from "@/lib/crm/access";
import { createOpportunity, createPerson, getPerson } from "@/lib/crm/service";
import { requireCrm } from "@/lib/crm/switch";
import { fromCsvCell } from "@/lib/csv";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import {
  type Lead,
  type LeadImportResult,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  LEAD_STATUS_LABELS,
  LEAD_STATUSES,
  type LeadSource,
  type LeadStatus,
  MAX_LEAD_IMPORT_ROWS,
} from "@/lib/crm/lead-types";
import { listMembers } from "@/lib/organisations/members";
import { optionalId, optionalSource, optionalString, requireId, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Leads (decision 492, #216): enquiries before they're customers, after
 * Salesforce's leads. A lead is new, then being worked, then either
 * unqualified (with a reason) or converted into a company (an existing one or
 * a new prospect), a person there and optionally an opportunity. Its tasks
 * and activities stay with it and also get the new company and person, so
 * nothing of its history is lost. Leads are never deleted.
 *
 * Who sees one: its owner (and their sales manager, as deals); one nobody
 * owns yet is seen by sales managers and by viewers and up (`seesLead`).
 */
export { LEAD_SOURCE_LABELS, LEAD_SOURCES, LEAD_STATUS_LABELS, LEAD_STATUSES, MAX_LEAD_IMPORT_ROWS };
export type { Lead, LeadImportResult, LeadSource, LeadStatus };

type LeadRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  description: string | null;
  source: LeadSource;
  source_detail: string | null;
  status: LeadStatus;
  unqualified_reason: string | null;
  needs_review: boolean;
  owner_user_id: string | null;
  converted_at: string | null;
  converted_contact_id: string | null;
  converted_person_id: string | null;
  converted_opportunity_id: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

const LEAD_COLUMNS = `l.id::text, l.first_name, l.last_name, l.company_name, l.email, l.phone, l.job_title, l.description, l.source,
  l.source_detail, l.status, l.unqualified_reason, l.needs_review, l.owner_user_id, l.converted_at,
  l.converted_contact_id::text, l.converted_person_id::text, l.converted_opportunity_id::text, l.created_by_email, l.created_at, l.updated_at`;

function toLead(row: LeadRow): Lead {
  const person = [row.first_name, row.last_name].filter(Boolean).join(" ");
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    name: person || row.company_name || row.email || "Lead",
    companyName: row.company_name,
    email: row.email,
    phone: row.phone,
    jobTitle: row.job_title,
    description: row.description,
    source: row.source,
    sourceDetail: row.source_detail,
    status: row.status,
    unqualifiedReason: row.unqualified_reason,
    needsReview: row.needs_review,
    ownerUserId: row.owner_user_id,
    convertedAt: row.converted_at,
    convertedContactId: row.converted_contact_id,
    convertedPersonId: row.converted_person_id,
    convertedOpportunityId: row.converted_opportunity_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQL limiting leads to the scope's (see `seesLead`), adding the owners as the next parameter. */
function leadScopeSql(scope: CrmScope | undefined, params: unknown[]): string {
  if (!scope || scope.owners === null) return "true";
  params.push(scope.owners);
  return `(l.owner_user_id = any($${params.length}::text[])${scope.role === "sales_manager" ? " or l.owner_user_id is null" : ""})`;
}

export async function listLeads(
  tx: OrgTx,
  options: { status?: unknown; search?: unknown; needsReview?: unknown; ownerUserId?: unknown; scope?: CrmScope } = {},
): Promise<Lead[]> {
  const status = options.status == null || options.status === "" || options.status === "open" ? null : requireOneOf(options.status, "status", LEAD_STATUSES);
  const openOnly = options.status === "open";
  const search = optionalString(options.search, "search", { maxLength: 100 });
  const pattern = search === null ? null : `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const owner = typeof options.ownerUserId === "string" && options.ownerUserId !== "" ? options.ownerUserId : null;
  const params: unknown[] = [status, openOnly, pattern, options.needsReview === true || options.needsReview === "true", owner];
  const scoped = leadScopeSql(options.scope, params);
  const result = await tx.query<LeadRow>(
    `select ${LEAD_COLUMNS} from crm_leads l
      where ($1::text is null or l.status = $1) and (not $2::boolean or l.status in ('new', 'working'))
        and ($3::text is null or concat_ws(' ', l.first_name, l.last_name, l.company_name, l.email, l.phone) ilike $3)
        and (not $4::boolean or l.needs_review)
        and ($5::text is null or ($5 = 'none' and l.owner_user_id is null) or l.owner_user_id = $5)
        and ${scoped}
      order by l.needs_review desc, l.created_at desc, l.id desc
      limit 1000`,
    params,
  );
  return result.rows.map(toLead);
}

export async function getLead(tx: OrgTx, idInput: unknown, scope?: CrmScope): Promise<Lead> {
  const id = requireId(idInput, "leadId");
  const result = await tx.query<LeadRow>(`select ${LEAD_COLUMNS} from crm_leads l where l.id = $1`, [id]);
  const row = result.rows[0];
  if (!row || !seesLead(scope, row.owner_user_id)) throw new NotFoundError("Lead not found.");
  return toLead(row);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(input: unknown, what: string, maxLength: number): string | null {
  return optionalString(input, what, { maxLength });
}

export type LeadInput = {
  firstName?: unknown;
  lastName?: unknown;
  companyName?: unknown;
  email?: unknown;
  phone?: unknown;
  jobTitle?: unknown;
  description?: unknown;
  ownerUserId?: unknown;
  sourceDetail?: unknown;
};

async function parseOwner(tx: OrgTx, input: unknown): Promise<string | null> {
  if (input == null || input === "") return null;
  if (typeof input !== "string") throw new ValidationError("The owner must be a member of the organisation.");
  const members = await listMembers(tx.organisationId);
  if (!members.some((member) => member.userId === input && member.isActive)) throw new ValidationError("The owner must be a member of the organisation.");
  return input;
}

async function leadValues(tx: OrgTx, input: LeadInput, current: Lead | null, scope: CrmScope | undefined) {
  const pick = (value: unknown, now: string | null, what: string, max: number) => (value === undefined ? now : text(value, what, max));
  const values = {
    firstName: pick(input.firstName, current?.firstName ?? null, "first name", 100),
    lastName: pick(input.lastName, current?.lastName ?? null, "last name", 100),
    companyName: pick(input.companyName, current?.companyName ?? null, "company", 200),
    email: pick(input.email, current?.email ?? null, "email", 254),
    phone: pick(input.phone, current?.phone ?? null, "phone", 50),
    jobTitle: pick(input.jobTitle, current?.jobTitle ?? null, "job title", 100),
    description: pick(input.description, current?.description ?? null, "description", 4000),
    sourceDetail: pick(input.sourceDetail, current?.sourceDetail ?? null, "source", 300),
    ownerUserId: ownerFor(
      scope,
      input.ownerUserId === undefined ? (current?.ownerUserId ?? null) : await parseOwner(tx, input.ownerUserId),
      current?.ownerUserId ?? null,
    ),
  };
  if (values.email !== null && !EMAIL.test(values.email)) throw new ValidationError("Enter a valid email address, like aroha@example.co.nz.");
  if (!values.firstName && !values.lastName && !values.companyName && !values.email) {
    throw new ValidationError("A lead needs at least a name, a company or an email.");
  }
  return values;
}

async function insertLead(
  tx: OrgTx,
  values: Awaited<ReturnType<typeof leadValues>>,
  command: { source: LeadSource; commandSource: string | null; idempotencyKey: string | null; needsReview: boolean },
): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `insert into crm_leads (command_source, idempotency_key, first_name, last_name, company_name, email, phone, job_title, description,
                            source, source_detail, needs_review, owner_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id::text`,
    [
      command.commandSource,
      command.idempotencyKey,
      values.firstName,
      values.lastName,
      values.companyName,
      values.email,
      values.phone,
      values.jobTitle,
      values.description,
      command.source,
      values.sourceDetail,
      command.needsReview,
      values.ownerUserId,
      tx.actor.email || null,
    ],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.lead_created", entityType: "crm_lead", entityId: id, details: { ...values, source: command.source } });
  return id;
}

/**
 * A lead from the web form or an email (decision 493): unassigned and to
 * review. `idempotencyKey` (per form submission or email) makes a repeat do
 * nothing. Returns null for a repeat.
 */
export async function createIntakeLead(
  tx: OrgTx,
  input: LeadInput,
  command: { source: "web_form" | "email"; commandSource: string; idempotencyKey: string },
): Promise<Lead | null> {
  const earlier = await tx.query("select 1 from crm_leads where command_source = $1 and idempotency_key = $2", [command.commandSource, command.idempotencyKey]);
  if ((earlier.rowCount ?? 0) > 0) return null;
  const values = await leadValues(tx, { ...input, ownerUserId: null }, null, undefined);
  const id = await insertLead(tx, values, { source: command.source, commandSource: command.commandSource, idempotencyKey: command.idempotencyKey, needsReview: true });
  return getLead(tx, id);
}

/** A lead typed in (source "manual"). A retry with the same key returns the same lead. */
export async function createLead(
  tx: OrgTx,
  input: LeadInput & { source?: unknown; idempotencyKey?: unknown },
  scope?: CrmScope,
): Promise<{ created: boolean; lead: Lead }> {
  await requireCrm(tx);
  const commandSource = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const earlier = await tx.query<{ id: string }>("select id::text from crm_leads where command_source = $1 and idempotency_key = $2", [
    commandSource,
    idempotencyKey,
  ]);
  if (earlier.rows[0]) return { created: false, lead: await getLead(tx, earlier.rows[0].id, scope) };
  // Its owner is whoever adds it unless they choose someone (as Salesforce).
  const values = await leadValues(tx, { ...input, ownerUserId: input.ownerUserId === undefined ? tx.actor.userId || null : input.ownerUserId }, null, scope);
  const id = await insertLead(tx, values, { source: "manual", commandSource, idempotencyKey, needsReview: false });
  return { created: true, lead: await getLead(tx, id, scope) };
}

/**
 * Changes a lead's details, owner or status (new, working, or unqualified
 * with a reason), or marks a web form or email lead as looked at. A converted
 * lead doesn't change.
 */
export async function updateLead(
  tx: OrgTx,
  idInput: unknown,
  input: LeadInput & { status?: unknown; unqualifiedReason?: unknown; reviewed?: unknown },
  scope?: CrmScope,
): Promise<Lead> {
  await requireCrm(tx);
  const current = await getLead(tx, idInput, scope);
  await tx.query("select id from crm_leads where id = $1 for update", [current.id]);
  if (current.status === "converted") throw new ConflictError("This lead has been converted, so it doesn't change. Change its company, person or opportunity instead.");
  const values = await leadValues(tx, input, current, scope);
  const status = input.status === undefined ? current.status : requireOneOf(input.status, "status", ["new", "working", "unqualified"] as const);
  const reason =
    status === "unqualified"
      ? (input.unqualifiedReason === undefined ? current.unqualifiedReason : text(input.unqualifiedReason, "reason", 500)) ?? null
      : null;
  if (status === "unqualified" && !reason) throw new ValidationError("Say why the lead isn't qualified.");
  const needsReview = input.reviewed === true ? false : current.needsReview;
  await tx.query(
    `update crm_leads set first_name = $2, last_name = $3, company_name = $4, email = $5, phone = $6, job_title = $7, description = $8,
            source_detail = $9, owner_user_id = $10, status = $11, unqualified_reason = $12, needs_review = $13, updated_at = now()
      where id = $1`,
    [current.id, values.firstName, values.lastName, values.companyName, values.email, values.phone, values.jobTitle, values.description,
      values.sourceDetail, values.ownerUserId, status, reason, needsReview],
  );
  await writeAuditEvent(tx, {
    eventType: "crm.lead_updated",
    entityType: "crm_lead",
    entityId: current.id,
    details: { ...values, status, unqualifiedReason: reason, ...(status !== current.status ? { statusFrom: current.status } : {}), needsReview },
  });
  return getLead(tx, current.id, scope);
}

/**
 * Converts a lead (decision 492): into `contactId`, an existing company, or
 * a new prospect named as the lead's company (its email and phone too); into
 * `personId`, someone already at that company, or a new person from the
 * lead; and, unless `opportunity` is false, a new opportunity there owned by
 * the lead's owner. The lead's tasks and activities get the company and
 * person as well. Converting again returns what it made.
 */
export async function convertLead(
  tx: OrgTx,
  idInput: unknown,
  input: {
    contactId?: unknown;
    personId?: unknown;
    opportunity?: unknown;
    opportunityName?: unknown;
    amount?: unknown;
    closeDate?: unknown;
  },
  scope?: CrmScope,
): Promise<{ created: boolean; lead: Lead }> {
  await requireCrm(tx);
  const current = await getLead(tx, idInput, scope);
  await tx.query("select id from crm_leads where id = $1 for update", [current.id]);
  const lead = await getLead(tx, current.id, scope);
  if (lead.status === "converted") return { created: false, lead };
  if (lead.status === "unqualified") throw new ConflictError("This lead is unqualified. Set it back to working before converting it.");
  const owner = ownerFor(scope, lead.ownerUserId, lead.ownerUserId);

  // The company: an existing one, or a new prospect.
  let contactId = optionalId(input.contactId === "" ? null : input.contactId, "contactId");
  if (contactId) {
    const found = await tx.query("select 1 from contacts where id = $1", [contactId]);
    if ((found.rowCount ?? 0) === 0) throw new NotFoundError("That company wasn't found.");
  } else {
    const name = lead.companyName ?? ([lead.firstName, lead.lastName].filter(Boolean).join(" ") || null);
    if (!name) throw new ValidationError("Choose a company, or give the lead a company name, before converting it.");
    contactId = (
      await createContact(tx, {
        source: "crm-lead",
        idempotencyKey: `lead-${lead.id}-company`,
        name,
        email: lead.companyName ? null : lead.email,
        phone: lead.companyName ? null : lead.phone,
        isProspect: true,
        ownerUserId: owner,
      })
    ).contact.id;
  }

  // The person: someone already there, or a new one.
  let personId = optionalId(input.personId === "" ? null : input.personId, "personId");
  if (personId) {
    const person = await getPerson(tx, personId);
    if (person.contactId !== contactId) throw new ValidationError(`${person.fullName} doesn't work at that company.`);
  } else {
    const firstName = lead.firstName ?? lead.lastName;
    if (!firstName) throw new ValidationError("Give the lead a person's name before converting it, or choose someone already at the company.");
    personId = (
      await createPerson(tx, {
        contactId,
        firstName,
        lastName: lead.firstName ? lead.lastName : null,
        jobTitle: lead.jobTitle,
        email: lead.email,
        phone: lead.phone,
      })
    ).id;
  }

  let opportunityId: string | null = null;
  if (input.opportunity !== false) {
    const name = optionalString(input.opportunityName, "opportunity name", { maxLength: 200 }) ?? `${lead.companyName ?? lead.name}`;
    opportunityId = (
      await createOpportunity(
        tx,
        { name, contactId, pointOfContactId: personId, ownerUserId: owner, amount: input.amount, closeDate: input.closeDate },
        { scope },
      )
    ).id;
  }

  // Its history goes with it.
  await tx.query("update crm_tasks set contact_id = coalesce(contact_id, $2), person_id = coalesce(person_id, $3), updated_at = now() where lead_id = $1", [
    lead.id,
    contactId,
    personId,
  ]);
  await tx.query(
    "update crm_activities set contact_id = coalesce(contact_id, $2), person_id = coalesce(person_id, $3), updated_at = now() where lead_id = $1",
    [lead.id, contactId, personId],
  );
  await tx.query(
    `update crm_leads set status = 'converted', converted_at = now(), converted_contact_id = $2, converted_person_id = $3,
            converted_opportunity_id = $4, needs_review = false, updated_at = now()
      where id = $1`,
    [lead.id, contactId, personId, opportunityId],
  );
  await writeAuditEvent(tx, {
    eventType: "crm.lead_converted",
    entityType: "crm_lead",
    entityId: lead.id,
    details: { contactId, personId, opportunityId },
  });
  return { created: true, lead: await getLead(tx, lead.id, scope) };
}

// ---------------------------------------------------------------------------
// Importing leads from a spreadsheet

const HEADINGS: Record<keyof Omit<LeadInput, "ownerUserId" | "description">, string[]> = {
  firstName: ["first name", "firstname", "given name", "first"],
  lastName: ["last name", "lastname", "surname", "family name", "last"],
  companyName: ["company", "company name", "organisation", "organization", "business", "account"],
  email: ["email", "email address", "e-mail"],
  phone: ["phone", "phone number", "mobile", "telephone", "cell"],
  jobTitle: ["job title", "title", "position", "role"],
  sourceDetail: ["source", "lead source", "campaign"],
};
const FULL_NAME = ["name", "full name", "contact", "contact name"];
const NOTES = ["notes", "note", "description", "comments", "message"];

function normal(heading: string): string {
  return heading.trim().toLowerCase().replace(/[_\s]+/g, " ");
}

function readRows(fileName: string, fileBase64: unknown): string[][] {
  if (typeof fileBase64 !== "string" || fileBase64.length === 0) throw new ValidationError("Choose a CSV or Excel file.");
  if (fileBase64.length > 7_000_000) throw new ValidationError("The file is larger than 5 MB. Split it into smaller files.");
  const bytes = Buffer.from(fileBase64, "base64");
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  let rows: string[][];
  try {
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) rows = readXlsxRows(bytes);
    else if (fileName.toLowerCase().endsWith(".xls")) throw new ValidationError("Older Excel files (.xls) aren't supported. Save it as .xlsx or CSV.");
    else rows = parseDelimited(decodeText(bytes), { keepBlankRows: false });
  } catch (error) {
    if (error instanceof RowError) throw new ValidationError(error.message);
    throw error;
  }
  return rows.map((row) => row.map((cell) => fromCsvCell(cell ?? "").trim())).filter((row) => row.some((cell) => cell !== ""));
}


/**
 * Imports leads from a CSV or Excel file (decision 492): the first row is
 * headings, matched by name (First name, Last name or Name, Company, Email,
 * Phone, Job title, Source, Notes). Each row becomes a lead with source
 * "import", owned by whoever imports it. A row whose email is already on an
 * open lead is skipped and listed. Importing the same file again with the
 * same key adds nothing.
 */
export async function importLeads(
  tx: OrgTx,
  input: { fileName?: unknown; fileBase64?: unknown; idempotencyKey?: unknown; source?: unknown },
  scope?: CrmScope,
): Promise<LeadImportResult> {
  await requireCrm(tx);
  const commandSource = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey.length > 100) throw new ValidationError("idempotencyKey must be at most 100 characters for an import.");
  const fileName = optionalString(input.fileName, "fileName", { maxLength: 255 }) ?? "leads.csv";
  const rows = readRows(fileName, input.fileBase64);
  if (rows.length < 2) throw new ValidationError("The file needs a row of headings and at least one lead.");
  if (rows.length - 1 > MAX_LEAD_IMPORT_ROWS) throw new ValidationError(`The file has more than ${MAX_LEAD_IMPORT_ROWS} leads. Split it into smaller files.`);
  const headings = rows[0].map(normal);
  const column = (names: string[]) => headings.findIndex((heading) => names.includes(heading));
  const columns = Object.fromEntries(Object.entries(HEADINGS).map(([key, names]) => [key, column(names)])) as Record<keyof typeof HEADINGS, number>;
  const fullName = column(FULL_NAME);
  const notes = column(NOTES);
  if (columns.firstName < 0 && columns.lastName < 0 && fullName < 0 && columns.companyName < 0 && columns.email < 0) {
    throw new ValidationError("The first row must be headings, with at least one of Name, First name, Last name, Company or Email.");
  }
  const hash = requestHash("crm_lead_import", { fileName, rows });
  const earlier = await tx.query<{ details: { hash: string } }>(
    "select details from audit_events where event_type = 'crm.leads_imported' and entity_type = 'crm_lead_import' and entity_id = $1",
    [`${commandSource}:${idempotencyKey}`],
  );
  if (earlier.rows[0]) assertSameRequest(earlier.rows[0].details.hash, hash, "lead import");

  const cell = (row: string[], index: number) => (index >= 0 && row[index] ? row[index] : null);
  const result: LeadImportResult = { created: 0, skipped: [], leads: [] };
  for (const [offset, row] of rows.slice(1).entries()) {
    const rowNumber = offset + 2;
    const rowKey = `${idempotencyKey}:${rowNumber}`;
    const done = await tx.query<{ id: string }>("select id::text from crm_leads where command_source = $1 and idempotency_key = $2", [commandSource, rowKey]);
    if (done.rows[0]) {
      result.skipped.push({ row: rowNumber, reason: "Already imported." });
      continue;
    }
    let firstName = cell(row, columns.firstName);
    let lastName = cell(row, columns.lastName);
    const whole = cell(row, fullName);
    if (!firstName && !lastName && whole) {
      const parts = whole.split(/\s+/);
      firstName = parts[0];
      lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
    }
    const input = {
      firstName,
      lastName,
      companyName: cell(row, columns.companyName),
      email: cell(row, columns.email),
      phone: cell(row, columns.phone),
      jobTitle: cell(row, columns.jobTitle),
      sourceDetail: cell(row, columns.sourceDetail) ?? fileName,
      description: cell(row, notes),
    };
    if (input.email) {
      const open = await tx.query("select 1 from crm_leads where lower(email) = lower($1) and status in ('new', 'working')", [input.email]);
      if ((open.rowCount ?? 0) > 0) {
        result.skipped.push({ row: rowNumber, reason: `${input.email} is already an open lead.` });
        continue;
      }
    }
    // Each row on its own: a row that's refused doesn't stop the others.
    await tx.query("savepoint lead_import_row");
    try {
      const values = await leadValues(tx, { ...input, ownerUserId: tx.actor.userId || null }, null, scope);
      const id = await insertLead(tx, values, { source: "import", commandSource, idempotencyKey: rowKey, needsReview: false });
      await tx.query("release savepoint lead_import_row");
      result.created += 1;
      if (result.leads.length < 50) result.leads.push(await getLead(tx, id, scope));
    } catch (error) {
      await tx.query("rollback to savepoint lead_import_row");
      if (error instanceof ValidationError) result.skipped.push({ row: rowNumber, reason: error.message });
      else throw error;
    }
  }
  if (!earlier.rows[0]) {
    await writeAuditEvent(tx, {
      eventType: "crm.leads_imported",
      entityType: "crm_lead_import",
      entityId: `${commandSource}:${idempotencyKey}`,
      details: { hash, fileName, created: result.created, skipped: result.skipped.length },
    });
  }
  return result;
}

import { writeAuditEvent } from "@/lib/audit";
import type { Role } from "@/lib/auth/roles";
import { isoDateAt, parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { dec, mul, parseDecimalInput, toFixedString } from "@/lib/money/decimal";
import { optionalId, optionalSource, optionalString, requireArray, requireId, requireIdempotencyKey, requireString } from "@/lib/validation";
import { listMembers } from "@/lib/organisations/members";
import { createTimeEntry, requireMember } from "./service";

/*
 * Jobs and visits inside Projects (examples JV1-JV9, decision 510; ServiceM8
 * and Tradify). A job is a project with a site. Its visits are on a
 * calendar for Tohyee users; Start and Finish fill in the hours, which the
 * staff member confirms into project time (Jess, 8 Oct 2026). Materials
 * used go onto the project invoice, where the item's stock goes out (as the
 * add-ons do, Jess 12 Oct 2026). Nothing here posts.
 */

export type JobDetails = {
  projectId: string;
  isJob: boolean;
  siteAddress: string | null;
  siteContact: string | null;
  serviceIntervalMonths: number | null;
  checklistItems: string[];
};

export type VisitStatus = "scheduled" | "started" | "finished" | "cancelled";

export type Visit = {
  id: string;
  projectId: string;
  projectName: string;
  contactName: string;
  siteAddress: string | null;
  taskId: string;
  taskName: string;
  userId: string;
  userEmail: string;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  status: VisitStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Minutes from Start to Finish, waiting to be confirmed (JV3). */
  workedMinutes: number | null;
  finishedWithOpenChecks: boolean;
  checks: Array<{ item: string; tickedByEmail: string | null; tickedAt: string | null }>;
  signedBy: string | null;
  signedAt: string | null;
  timeEntryId: string | null;
  /** Another of the same person's visits overlaps this one (JV2). */
  clash: string | null;
};

export type Material = {
  id: string;
  projectId: string;
  visitId: string | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  status: "active" | "removed";
  invoiceNumber: string | null;
};

export type ServiceReminder = { projectId: string; projectName: string; contactName: string; lastVisit: string; dueOn: string; message: string };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

// Jobs ----------------------------------------------------------------------------

export async function getJobDetails(tx: OrgTx, projectIdInput: unknown): Promise<JobDetails> {
  const projectId = requireId(projectIdInput, "projectId");
  const row = await tx.query<{ is_job: boolean; site_address: string | null; site_contact: string | null; service_interval_months: number | null; checklist_items: string[] }>(
    "select is_job, site_address, site_contact, service_interval_months, checklist_items from projects where id = $1",
    [projectId],
  );
  if (!row.rows[0]) throw new NotFoundError("Project not found.");
  const found = row.rows[0];
  return {
    projectId,
    isJob: found.is_job,
    siteAddress: found.site_address,
    siteContact: found.site_contact,
    serviceIntervalMonths: found.service_interval_months,
    checklistItems: found.checklist_items ?? [],
  };
}

/** Makes a project a job, or changes its site, contact, service interval and checklist (JV1, JV5, JV8). Posts nothing. */
export async function setJobDetails(
  tx: OrgTx,
  projectIdInput: unknown,
  input: { isJob?: unknown; siteAddress?: unknown; siteContact?: unknown; serviceIntervalMonths?: unknown; checklistItems?: unknown },
): Promise<JobDetails> {
  const current = await getJobDetails(tx, projectIdInput);
  if (input.isJob !== undefined && typeof input.isJob !== "boolean") throw new ValidationError("isJob must be true or false.");
  const isJob = input.isJob === undefined ? current.isJob : input.isJob;
  const siteAddress = input.siteAddress === undefined ? current.siteAddress : optionalString(input.siteAddress, "The site address", { maxLength: 500 });
  const siteContact = input.siteContact === undefined ? current.siteContact : optionalString(input.siteContact, "The contact on site", { maxLength: 200 });
  let serviceIntervalMonths = current.serviceIntervalMonths;
  if (input.serviceIntervalMonths !== undefined) {
    serviceIntervalMonths =
      input.serviceIntervalMonths === null || input.serviceIntervalMonths === "" ? null : Number(parseDecimalInput(input.serviceIntervalMonths, "Service every (months)", { maxScale: 0 }));
    if (serviceIntervalMonths !== null && (serviceIntervalMonths < 1 || serviceIntervalMonths > 120)) throw new ValidationError("A service interval is 1 to 120 months.");
  }
  let checklistItems = current.checklistItems;
  if (input.checklistItems !== undefined) {
    checklistItems = requireArray(input.checklistItems, "checklistItems", 50).map((item, index) => requireString(item, `Checklist item ${index + 1}`, { maxLength: 200 }));
    if (new Set(checklistItems).size !== checklistItems.length) throw new ValidationError("Each checklist item must be different.");
  }
  if (isJob && !siteAddress) throw new ValidationError("A job needs its site address.");
  await tx.query(
    "update projects set is_job = $2, site_address = $3, site_contact = $4, service_interval_months = $5, checklist_items = $6::jsonb, updated_at = now() where id = $1",
    [current.projectId, isJob, siteAddress, siteContact, serviceIntervalMonths, JSON.stringify(checklistItems)],
  );
  await writeAuditEvent(tx, {
    eventType: "project.job_updated",
    entityType: "project",
    entityId: current.projectId,
    details: { isJob, siteAddress, siteContact, serviceIntervalMonths, checklistItems },
  });
  return getJobDetails(tx, current.projectId);
}

export type JobSummary = {
  projectId: string;
  name: string;
  contactName: string;
  siteAddress: string | null;
  status: string;
  nextVisit: string | null;
  lastVisit: string | null;
};

/** The jobs list (JV1): only jobs, with their next and last visits. */
export async function listJobs(tx: OrgTx): Promise<JobSummary[]> {
  const rows = await tx.query<{ id: string; name: string; contact_name: string; site_address: string | null; status: string; next_visit: string | null; last_visit: string | null }>(
    `select p.id::text, p.name, c.name as contact_name, p.site_address, p.status,
            (select min(v.starts_at)::text from project_visits v where v.project_id = p.id and v.status in ('scheduled', 'started') ) as next_visit,
            (select max(v.finished_at)::text from project_visits v where v.project_id = p.id and v.status = 'finished') as last_visit
       from projects p join contacts c on c.id = p.contact_id
      where p.is_job order by p.status, coalesce((select min(v.starts_at) from project_visits v where v.project_id = p.id and v.status in ('scheduled', 'started')), 'infinity'), p.name`,
  );
  return rows.rows.map((row) => ({
    projectId: row.id,
    name: row.name,
    contactName: row.contact_name,
    siteAddress: row.site_address,
    status: row.status,
    nextVisit: row.next_visit,
    lastVisit: row.last_visit,
  }));
}

// Visits ----------------------------------------------------------------------------

const VISIT_COLUMNS = `v.id::text, v.project_id::text, p.name as project_name, c.name as contact_name, p.site_address, v.task_id::text, t.name as task_name,
  v.user_id::text, v.user_email, v.starts_at::text, v.ends_at::text, v.notes, v.status, v.started_at::text, v.finished_at::text,
  v.finished_with_open_checks, v.signed_by, v.signed_at::text, v.time_entry_id::text, p.checklist_items`;
const VISIT_JOINS = `from project_visits v join projects p on p.id = v.project_id join contacts c on c.id = p.contact_id join project_tasks t on t.id = v.task_id`;

type VisitRow = {
  id: string;
  project_id: string;
  project_name: string;
  contact_name: string;
  site_address: string | null;
  task_id: string;
  task_name: string;
  user_id: string;
  user_email: string;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  status: VisitStatus;
  started_at: string | null;
  finished_at: string | null;
  finished_with_open_checks: boolean;
  signed_by: string | null;
  signed_at: string | null;
  time_entry_id: string | null;
  checklist_items: string[];
};

async function toVisits(tx: OrgTx, rows: VisitRow[]): Promise<Visit[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const checks = await tx.query<{ visit_id: string; item: string; ticked_by_email: string; ticked_at: string }>(
    "select visit_id::text, item, ticked_by_email, ticked_at::text from project_visit_checks where visit_id = any($1::bigint[])",
    [ids],
  );
  const clashes = await tx.query<{ id: string; other_start: string; other_end: string }>(
    `select v.id::text, min(o.starts_at)::text as other_start, max(o.ends_at)::text as other_end
       from project_visits v join project_visits o on o.user_id = v.user_id and o.id <> v.id and o.status <> 'cancelled'
                                                  and o.starts_at < v.ends_at and o.ends_at > v.starts_at
      where v.id = any($1::bigint[]) and v.status <> 'cancelled' group by v.id`,
    [ids],
  );
  // The person's name (as on screens), or their email without one.
  const people = new Map((await listMembers(tx.organisationId)).map((member) => [member.userId, member.displayName || member.email]));
  const time = (value: string) => new Date(value).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Pacific/Auckland" });
  return rows.map((row) => {
    const clash = clashes.rows.find((entry) => entry.id === row.id);
    let clashText: string | null = null;
    if (clash) {
      // The overlap: the later of the starts to the earlier of the ends (JV2).
      const from = new Date(Math.max(Date.parse(row.starts_at), Date.parse(clash.other_start)));
      const to = new Date(Math.min(Date.parse(row.ends_at), Date.parse(clash.other_end)));
      clashText = `${people.get(row.user_id) ?? row.user_email} is booked twice ${time(from.toISOString())}-${time(to.toISOString())}`;
    }
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      contactName: row.contact_name,
      siteAddress: row.site_address,
      taskId: row.task_id,
      taskName: row.task_name,
      userId: row.user_id,
      userEmail: row.user_email,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      notes: row.notes,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      workedMinutes: row.started_at && row.finished_at ? Math.floor((Date.parse(row.finished_at) - Date.parse(row.started_at)) / 60_000) : null,
      finishedWithOpenChecks: row.finished_with_open_checks,
      checks: (row.checklist_items ?? []).map((item) => {
        const ticked = checks.rows.find((entry) => entry.visit_id === row.id && entry.item === item);
        return { item, tickedByEmail: ticked?.ticked_by_email ?? null, tickedAt: ticked?.ticked_at ?? null };
      }),
      signedBy: row.signed_by,
      signedAt: row.signed_at,
      timeEntryId: row.time_entry_id,
      clash: clashText,
    };
  });
}

export async function getVisit(tx: OrgTx, idInput: unknown): Promise<Visit> {
  const id = requireId(idInput, "visitId");
  const rows = await tx.query<VisitRow>(`select ${VISIT_COLUMNS} ${VISIT_JOINS} where v.id = $1`, [id]);
  if (!rows.rows[0]) throw new NotFoundError("Visit not found.");
  return (await toVisits(tx, rows.rows))[0];
}

/** The calendar (JV2): visits between two dates, optionally one person's ("My visits"). */
export async function listVisits(tx: OrgTx, input: { from: unknown; to: unknown; userId?: unknown; projectId?: unknown }): Promise<Visit[]> {
  const from = parseIsoDate(input.from, "from");
  const to = parseIsoDate(input.to, "to");
  const userId = typeof input.userId === "string" && input.userId ? input.userId : null;
  const projectId = optionalId(input.projectId, "projectId");
  const rows = await tx.query<VisitRow>(
    `select ${VISIT_COLUMNS} ${VISIT_JOINS}
      where v.starts_at < ($2::date + 1)::timestamp at time zone 'Pacific/Auckland' and v.ends_at > $1::timestamp at time zone 'Pacific/Auckland'
        and ($3::uuid is null or v.user_id = $3) and ($4::bigint is null or v.project_id = $4)
      order by v.starts_at, v.id limit 1000`,
    [from, to, userId, projectId],
  );
  return toVisits(tx, rows.rows);
}

function parseInstant(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || !/T\d{2}:\d{2}/.test(input)) {
    throw new ValidationError(`${fieldName} must be a date and time, like 2026-10-13T09:00:00+13:00.`);
  }
  return new Date(input).toISOString();
}

/** Books a visit on a job for a Tohyee user (JV2). Overlapping visits are allowed and flagged. Posts nothing. */
export async function scheduleVisit(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; projectId: unknown; taskId: unknown; userId: unknown; startsAt: unknown; endsAt: unknown; notes?: unknown },
): Promise<{ created: boolean; visit: Visit }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const projectId = requireId(input.projectId, "projectId");
  const taskId = requireId(input.taskId, "taskId");
  const startsAt = parseInstant(input.startsAt, "The start");
  const endsAt = parseInstant(input.endsAt, "The end");
  if (endsAt <= startsAt) throw new ValidationError("A visit has to end after it starts.");
  const notes = optionalString(input.notes, "notes", { maxLength: 1000 });
  const member = await requireMember(tx, input.userId, "The staff member");
  const hash = requestHash("project_visit", { projectId, taskId, userId: member.userId, startsAt, endsAt, notes });
  const earlier = await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from project_visits where command_source = $1 and idempotency_key = $2", [source, idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "visit");
    return { created: false, visit: await getVisit(tx, earlier.rows[0].id) };
  }
  const project = await tx.query<{ is_job: boolean; status: string; name: string }>("select is_job, status, name from projects where id = $1", [projectId]);
  if (!project.rows[0]) throw new ValidationError("That project wasn't found.");
  if (!project.rows[0].is_job) throw new ValidationError(`${project.rows[0].name} isn't a job. Tick "This is a job" and give its site first.`);
  if (project.rows[0].status !== "in_progress") throw new ConflictError(`${project.rows[0].name} is closed.`);
  const task = await tx.query<{ project_id: string; status: string }>("select project_id::text, status from project_tasks where id = $1", [taskId]);
  if (!task.rows[0] || task.rows[0].project_id !== projectId) throw new ValidationError("That task isn't on this job.");
  if (task.rows[0].status !== "active") throw new ValidationError("That task is archived.");
  try {
    const row = await tx.query<{ id: string }>(
      `insert into project_visits (command_source, idempotency_key, request_hash, project_id, task_id, user_id, user_email, starts_at, ends_at, notes, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id::text`,
      [source, idempotencyKey, hash, projectId, taskId, member.userId, member.email, startsAt, endsAt, notes, tx.actor.email],
    );
    await writeAuditEvent(tx, { eventType: "project.visit_scheduled", entityType: "project", entityId: projectId, details: { visitId: row.rows[0].id, userEmail: member.email, startsAt, endsAt } });
    return { created: true, visit: await getVisit(tx, row.rows[0].id) };
  } catch (error) {
    if (isUniqueViolation(error)) return { created: false, visit: await getVisit(tx, (await tx.query<{ id: string }>("select id::text from project_visits where command_source = $1 and idempotency_key = $2", [source, idempotencyKey])).rows[0].id) };
    throw error;
  }
}

/** The visit's own person, or an admin, works it (JV3). */
function assertCanWork(visit: Visit, tx: OrgTx, role: Role): void {
  if (visit.userId === tx.actor.userId) return;
  if (role === "admin" || role === "owner") return;
  throw new ForbiddenError(`This visit is ${visit.userEmail}'s.`);
}

export async function rescheduleVisit(tx: OrgTx, idInput: unknown, input: { startsAt?: unknown; endsAt?: unknown; userId?: unknown; notes?: unknown; cancel?: unknown }): Promise<Visit> {
  const visit = await getVisit(tx, idInput);
  if (visit.status !== "scheduled") throw new ConflictError("Only a visit that hasn't started can be moved or cancelled.");
  if (input.cancel === true) {
    await tx.query("update project_visits set status = 'cancelled' where id = $1", [visit.id]);
    await writeAuditEvent(tx, { eventType: "project.visit_cancelled", entityType: "project", entityId: visit.projectId, details: { visitId: visit.id } });
    return getVisit(tx, visit.id);
  }
  const startsAt = input.startsAt === undefined ? visit.startsAt : parseInstant(input.startsAt, "The start");
  const endsAt = input.endsAt === undefined ? visit.endsAt : parseInstant(input.endsAt, "The end");
  if (new Date(endsAt) <= new Date(startsAt)) throw new ValidationError("A visit has to end after it starts.");
  const member = input.userId === undefined ? { userId: visit.userId, email: visit.userEmail } : await requireMember(tx, input.userId, "The staff member");
  const notes = input.notes === undefined ? visit.notes : optionalString(input.notes, "notes", { maxLength: 1000 });
  await tx.query("update project_visits set starts_at = $2, ends_at = $3, user_id = $4, user_email = $5, notes = $6 where id = $1", [
    visit.id,
    new Date(startsAt).toISOString(),
    new Date(endsAt).toISOString(),
    member.userId,
    member.email,
    notes,
  ]);
  await writeAuditEvent(tx, { eventType: "project.visit_moved", entityType: "project", entityId: visit.projectId, details: { visitId: visit.id, startsAt, endsAt, userEmail: member.email } });
  return getVisit(tx, visit.id);
}

/** Start (JV3): records when work began. */
export async function startVisit(tx: OrgTx, role: Role, idInput: unknown, input: { at?: unknown } = {}): Promise<Visit> {
  const visit = await getVisit(tx, idInput);
  assertCanWork(visit, tx, role);
  if (visit.status !== "scheduled") throw new ConflictError(visit.status === "cancelled" ? "This visit was cancelled." : "This visit has already started.");
  const at = input.at === undefined || input.at === null ? new Date().toISOString() : parseInstant(input.at, "The start time");
  await tx.query("update project_visits set status = 'started', started_at = $2 where id = $1", [visit.id, at]);
  await writeAuditEvent(tx, { eventType: "project.visit_started", entityType: "project", entityId: visit.projectId, details: { visitId: visit.id, at } });
  return getVisit(tx, visit.id);
}

/** Finish (JV3, JV5): unticked checklist items need `finishAnyway`, which is recorded. */
export async function finishVisit(tx: OrgTx, role: Role, idInput: unknown, input: { at?: unknown; finishAnyway?: unknown } = {}): Promise<Visit> {
  const visit = await getVisit(tx, idInput);
  assertCanWork(visit, tx, role);
  if (visit.status !== "started") throw new ConflictError("Start the visit before finishing it.");
  const at = input.at === undefined || input.at === null ? new Date().toISOString() : parseInstant(input.at, "The finish time");
  if (at <= visit.startedAt!) throw new ValidationError("A visit finishes after it starts.");
  const open = visit.checks.filter((check) => !check.tickedAt).map((check) => check.item);
  if (open.length > 0 && input.finishAnyway !== true) {
    throw new ConflictError(`Not ticked yet: ${open.join(", ")}. Finish anyway?`);
  }
  await tx.query("update project_visits set status = 'finished', finished_at = $2, finished_with_open_checks = $3 where id = $1", [visit.id, at, open.length > 0]);
  await writeAuditEvent(tx, { eventType: "project.visit_finished", entityType: "project", entityId: visit.projectId, details: { visitId: visit.id, at, openChecks: open } });
  return getVisit(tx, visit.id);
}

/**
 * Confirms the visit's hours into project time (JV3; Jess: Start/Finish fill
 * in the hours, the staff member confirms them). The minutes default to Start
 * to Finish; a different figure can be confirmed instead. Once only.
 */
export async function confirmVisitHours(tx: OrgTx, role: Role, idInput: unknown, input: { minutes?: unknown; idempotencyKey: unknown; source?: unknown }): Promise<{ visit: Visit }> {
  const visit = await getVisit(tx, idInput);
  assertCanWork(visit, tx, role);
  if (visit.status !== "finished") throw new ConflictError("Finish the visit before confirming its hours.");
  if (visit.timeEntryId) return { visit };
  const minutes = input.minutes === undefined || input.minutes === null || input.minutes === "" ? visit.workedMinutes! : Number(parseDecimalInput(input.minutes, "Minutes", { maxScale: 0 }));
  if (minutes < 1) throw new ValidationError("There's no time to confirm.");
  const { entry } = await createTimeEntry(tx, role, visit.projectId, {
    source: input.source ?? "project_visit",
    idempotencyKey: input.idempotencyKey,
    userId: visit.userId,
    taskId: visit.taskId,
    entryDate: isoDateAt(new Date(visit.startedAt!)),
    minutes,
    description: `Visit ${isoDateAt(new Date(visit.startedAt!))}`,
  });
  await tx.query("update project_visits set time_entry_id = $2 where id = $1", [visit.id, entry.id]);
  await writeAuditEvent(tx, { eventType: "project.visit_hours_confirmed", entityType: "project", entityId: visit.projectId, details: { visitId: visit.id, minutes, timeEntryId: entry.id } });
  return { visit: await getVisit(tx, visit.id) };
}

/** Ticks or unticks a checklist item, recording who and when (JV5). */
export async function tickVisitCheck(tx: OrgTx, role: Role, idInput: unknown, input: { item: unknown; ticked: unknown }): Promise<Visit> {
  const visit = await getVisit(tx, idInput);
  assertCanWork(visit, tx, role);
  if (visit.status === "cancelled") throw new ConflictError("This visit was cancelled.");
  const item = requireString(input.item, "item", { maxLength: 200 });
  if (!visit.checks.some((check) => check.item === item)) throw new ValidationError(`"${item}" isn't on this job's checklist.`);
  if (input.ticked === false) {
    await tx.query("delete from project_visit_checks where visit_id = $1 and item = $2", [visit.id, item]);
  } else {
    await tx.query("insert into project_visit_checks (visit_id, item, ticked_by_email) values ($1, $2, $3) on conflict do nothing", [visit.id, item, tx.actor.email]);
  }
  await writeAuditEvent(tx, { eventType: "project.visit_check", entityType: "project", entityId: visit.projectId, details: { visitId: visit.id, item, ticked: input.ticked !== false } });
  return getVisit(tx, visit.id);
}

/** Records who signed on site (JV6); the signature image is attached to the visit as a file. */
export async function signVisit(tx: OrgTx, role: Role, idInput: unknown, input: { signedBy: unknown }): Promise<Visit> {
  const visit = await getVisit(tx, idInput);
  assertCanWork(visit, tx, role);
  const signedBy = requireString(input.signedBy, "Who signed", { maxLength: 200 });
  await tx.query("update project_visits set signed_by = $2, signed_at = now() where id = $1", [visit.id, signedBy]);
  await writeAuditEvent(tx, { eventType: "project.visit_signed", entityType: "project", entityId: visit.projectId, details: { visitId: visit.id, signedBy } });
  return getVisit(tx, visit.id);
}

// Materials ---------------------------------------------------------------------------

export async function listMaterials(tx: OrgTx, projectIdInput: unknown): Promise<Material[]> {
  const projectId = requireId(projectIdInput, "projectId");
  const rows = await tx.query<{
    id: string;
    project_id: string;
    visit_id: string | null;
    item_id: string;
    code: string;
    name: string;
    quantity: string;
    unit_price: string;
    status: "active" | "removed";
    invoice_number: string | null;
  }>(
    `select m.id::text, m.project_id::text, m.visit_id::text, m.item_id::text, i.code, i.name, m.quantity::text, m.unit_price::text, m.status,
            (select coalesce(s.invoice_number, 'a draft invoice') from sales_invoices s where s.id = tohyee_project_item_invoice('material', m.id)) as invoice_number
       from project_materials m join items i on i.id = m.item_id where m.project_id = $1 order by m.id`,
    [projectId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    visitId: row.visit_id,
    itemId: row.item_id,
    itemCode: row.code,
    itemName: row.name,
    quantity: toFixedString(dec(row.quantity), 2).replace(/\.00$/, ""),
    unitPrice: toFixedString(dec(row.unit_price), 2),
    amount: toFixedString(mul(dec(row.quantity), dec(row.unit_price)), 2),
    status: row.status,
    invoiceNumber: row.invoice_number,
  }));
}

/** Records materials used on a job (JV4), at the item's sale price unless another is given. Stock goes out when invoiced. */
export async function addMaterial(tx: OrgTx, projectIdInput: unknown, input: { itemId: unknown; quantity: unknown; unitPrice?: unknown; visitId?: unknown }): Promise<Material[]> {
  const projectId = requireId(projectIdInput, "projectId");
  const itemId = requireId(input.itemId, "itemId");
  const visitId = optionalId(input.visitId, "visitId");
  const quantity = parseDecimalInput(input.quantity, "Quantity", { maxScale: 4 });
  const project = await tx.query<{ status: string; name: string }>("select status, name from projects where id = $1", [projectId]);
  if (!project.rows[0]) throw new NotFoundError("Project not found.");
  if (project.rows[0].status !== "in_progress") throw new ConflictError(`${project.rows[0].name} is closed.`);
  const item = await tx.query<{ sale_price: string | null; name: string; is_archived: boolean }>(
    "select sale_price::text, name, not is_active as is_archived from items where id = $1",
    [itemId],
  );
  if (!item.rows[0]) throw new ValidationError("That item wasn't found.");
  if (item.rows[0].is_archived) throw new ValidationError(`${item.rows[0].name} is archived.`);
  const unitPrice =
    input.unitPrice === undefined || input.unitPrice === null || input.unitPrice === ""
      ? item.rows[0].sale_price
      : parseDecimalInput(input.unitPrice, "Unit price", { maxScale: 4, allowZero: true });
  if (unitPrice === null) throw new ValidationError(`${item.rows[0].name} has no sale price: give a unit price.`);
  if (visitId) {
    const visit = await tx.query<{ project_id: string }>("select project_id::text from project_visits where id = $1", [visitId]);
    if (!visit.rows[0] || visit.rows[0].project_id !== projectId) throw new ValidationError("That visit isn't on this job.");
  }
  const row = await tx.query<{ id: string }>(
    "insert into project_materials (project_id, visit_id, item_id, quantity, unit_price, created_by_email) values ($1, $2, $3, $4::numeric, $5::numeric, $6) returning id::text",
    [projectId, visitId, itemId, quantity, unitPrice, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "project.material_added", entityType: "project", entityId: projectId, details: { materialId: row.rows[0].id, itemId, quantity, unitPrice, visitId } });
  return listMaterials(tx, projectId);
}

export async function removeMaterial(tx: OrgTx, idInput: unknown): Promise<Material[]> {
  const id = requireId(idInput, "materialId");
  const row = await tx.query<{ project_id: string }>("select project_id::text from project_materials where id = $1", [id]);
  if (!row.rows[0]) throw new NotFoundError("Material not found.");
  const materials = await listMaterials(tx, row.rows[0].project_id);
  const material = materials.find((entry) => entry.id === id)!;
  if (material.invoiceNumber) throw new ConflictError(`It's on ${material.invoiceNumber}. Void or delete that invoice first.`);
  await tx.query("update project_materials set status = 'removed' where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "project.material_removed", entityType: "project", entityId: row.rows[0].project_id, details: { materialId: id } });
  return listMaterials(tx, row.rows[0].project_id);
}

// Service reminders ------------------------------------------------------------------

function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * Jobs due a service (JV8): the service interval after the last finished
 * visit, from today on, until another visit is booked. In Tohyee only, no
 * text or email (decisions of 5 and 12 Oct 2026).
 */
export async function serviceReminders(tx: OrgTx, input: { today?: unknown } = {}): Promise<ServiceReminder[]> {
  const today = input.today ? parseIsoDate(input.today, "today") : isoDateAt(new Date());
  const rows = await tx.query<{ id: string; name: string; contact_name: string; interval: number; last_visit: string }>(
    `select p.id::text, p.name, c.name as contact_name, p.service_interval_months as interval,
            (select max(v.finished_at) from project_visits v where v.project_id = p.id and v.status = 'finished')::text as last_visit
       from projects p join contacts c on c.id = p.contact_id
      where p.is_job and p.service_interval_months is not null
        and not exists (select 1 from project_visits v where v.project_id = p.id and v.status in ('scheduled', 'started')
                          and v.starts_at > (select max(w.finished_at) from project_visits w where w.project_id = p.id and w.status = 'finished'))`,
  );
  const reminders: ServiceReminder[] = [];
  for (const row of rows.rows) {
    if (!row.last_visit) continue;
    const lastVisit = isoDateAt(new Date(row.last_visit));
    const dueOn = addMonths(lastVisit, row.interval);
    if (dueOn > today) continue;
    const every = row.interval === 12 ? "annual" : `${row.interval}-monthly`;
    reminders.push({ projectId: row.id, projectName: row.name, contactName: row.contact_name, lastVisit, dueOn, message: `${row.contact_name}: ${every} service due` });
  }
  return reminders.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

// Calendar files ------------------------------------------------------------------------

function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsTime(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Visits as an iCalendar file (JV9, one way): add it to Google or Microsoft
 * calendar. Moving the event there doesn't move the visit.
 */
export function visitsToIcs(visits: Visit[], organisationId: string): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tohyee//Jobs//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const visit of visits.filter((entry) => entry.status !== "cancelled")) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:visit-${visit.id}@${organisationId}.tohyee`,
      `DTSTAMP:${icsTime(new Date().toISOString())}`,
      `DTSTART:${icsTime(visit.startsAt)}`,
      `DTEND:${icsTime(visit.endsAt)}`,
      `SUMMARY:${icsText(`${visit.contactName}: ${visit.projectName}`)}`,
      ...(visit.siteAddress ? [`LOCATION:${icsText(visit.siteAddress)}`] : []),
      ...(visit.notes ? [`DESCRIPTION:${icsText(visit.notes)}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

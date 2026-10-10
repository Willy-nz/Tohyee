import { writeAuditEvent } from "@/lib/audit";
import { type CrmScope, seesLead } from "@/lib/crm/access";
import { getLead } from "@/lib/crm/leads";
import { createTask, getOpportunity, getPerson } from "@/lib/crm/service";
import { requireCrm } from "@/lib/crm/switch";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { optionalId, optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/**
 * Sequences (decision 497, #216 stage 2; Jess 10 Oct 2026: "make tasks; rep
 * sends"). An admin sets out steps (an email from a template, a call, or
 * another task) on days counted from the start. Someone adds a lead, a
 * person or a deal; on each step's day a task is made for the record's
 * owner (or whoever added it), and nothing is ever sent by itself.
 *
 * It stops by itself when the person replies (an email from their address
 * synced after they were added, or for a lead, one from the lead mailbox),
 * when a lead is unqualified or converted, when a deal is won or lost, or
 * when a person is archived; email steps are skipped for anyone marked
 * "Don't email". Someone can also stop it. Each step of each enrolment is
 * done once (a unique run row in the same transaction as its task).
 */

export const STEP_KINDS = ["email", "call", "task"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export type SequenceStep = { position: number; dayOffset: number; kind: StepKind; title: string; templateId: string | null; templateName: string | null };
export type Sequence = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  steps: SequenceStep[];
  activeEnrolments: number;
};

export type EnrolmentStatus = "active" | "finished" | "stopped";
export type Enrolment = {
  id: string;
  sequenceId: string;
  sequenceName: string;
  leadId: string | null;
  personId: string | null;
  opportunityId: string | null;
  targetName: string;
  assigneeUserId: string | null;
  status: EnrolmentStatus;
  stopReason: string | null;
  startedOn: string;
  enrolledAt: string;
  endedAt: string | null;
  stepsDone: number;
  stepsTotal: number;
};

export async function listSequences(tx: OrgTx, options: { includeInactive?: boolean } = {}): Promise<Sequence[]> {
  const sequences = await tx.query<{ id: string; name: string; description: string | null; is_active: boolean; active: number }>(
    `select s.id::text, s.name, s.description, s.is_active,
            (select count(*)::int from crm_sequence_enrolments e where e.sequence_id = s.id and e.status = 'active') as active
       from crm_sequences s
      where $1::boolean or s.is_active
      order by lower(s.name), s.id`,
    [options.includeInactive ?? false],
  );
  const steps = await tx.query<{ sequence_id: string; position: number; day_offset: number; kind: StepKind; title: string; template_id: string | null; template_name: string | null }>(
    `select st.sequence_id::text, st.position, st.day_offset, st.kind, st.title, st.template_id::text, t.name as template_name
       from crm_sequence_steps st left join crm_email_templates t on t.id = st.template_id
      order by st.sequence_id, st.position`,
  );
  return sequences.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    activeEnrolments: row.active,
    steps: steps.rows
      .filter((step) => step.sequence_id === row.id)
      .map((step) => ({ position: step.position, dayOffset: step.day_offset, kind: step.kind, title: step.title, templateId: step.template_id, templateName: step.template_name })),
  }));
}

async function getSequence(tx: OrgTx, id: string): Promise<Sequence> {
  const found = (await listSequences(tx, { includeInactive: true })).find((sequence) => sequence.id === id);
  if (!found) throw new NotFoundError("Sequence not found.");
  return found;
}

type StepInput = { dayOffset?: unknown; kind?: unknown; title?: unknown; templateId?: unknown };

async function parseSteps(tx: OrgTx, input: unknown): Promise<Array<Omit<SequenceStep, "templateName">>> {
  if (!Array.isArray(input) || input.length === 0) throw new ValidationError("A sequence needs at least one step.");
  if (input.length > 30) throw new ValidationError("A sequence can have at most 30 steps.");
  const steps: Array<Omit<SequenceStep, "templateName">> = [];
  let last = -1;
  for (const [index, raw] of (input as StepInput[]).entries()) {
    const label = `Step ${index + 1}`;
    const dayOffset = typeof raw?.dayOffset === "number" ? raw.dayOffset : Number(raw?.dayOffset);
    if (!Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset > 365) throw new ValidationError(`${label}: the day must be a whole number from 0 to 365.`);
    if (dayOffset < last) throw new ValidationError(`${label} comes before the step above it. Put the steps in day order.`);
    last = dayOffset;
    const kind = requireOneOf(raw?.kind, "kind", STEP_KINDS);
    const title = requireString(raw?.title, `${label}'s title`, { maxLength: 150 });
    const templateId = kind === "email" ? optionalId(raw?.templateId, "templateId") : null;
    if (kind === "email" && !templateId) throw new ValidationError(`${label}: choose the email template.`);
    if (templateId) {
      const template = await tx.query<{ is_active: boolean }>("select is_active from crm_email_templates where id = $1", [templateId]);
      if (!template.rows[0]) throw new ValidationError(`${label}: that email template wasn't found.`);
    }
    steps.push({ position: index + 1, dayOffset, kind, title, templateId });
  }
  return steps;
}

async function saveSteps(tx: OrgTx, sequenceId: string, steps: Array<Omit<SequenceStep, "templateName">>): Promise<void> {
  await tx.query("delete from crm_sequence_steps where sequence_id = $1", [sequenceId]);
  for (const step of steps) {
    await tx.query("insert into crm_sequence_steps (sequence_id, position, day_offset, kind, title, template_id) values ($1, $2, $3, $4, $5, $6)", [
      sequenceId,
      step.position,
      step.dayOffset,
      step.kind,
      step.title,
      step.templateId,
    ]);
  }
}

async function assertNameFree(tx: OrgTx, name: string, id: string | null): Promise<void> {
  const taken = await tx.query("select 1 from crm_sequences where lower(name) = lower($1) and ($2::bigint is null or id <> $2)", [name, id]);
  if ((taken.rowCount ?? 0) > 0) throw new ConflictError(`There's already a sequence called ${name}.`);
}

export async function createSequence(tx: OrgTx, input: { name?: unknown; description?: unknown; steps?: unknown }): Promise<Sequence> {
  await requireCrm(tx);
  const name = requireString(input.name, "name", { maxLength: 100 });
  const description = optionalString(input.description, "description", { maxLength: 500 });
  const steps = await parseSteps(tx, input.steps);
  await assertNameFree(tx, name, null);
  const id = (
    await tx.query<{ id: string }>("insert into crm_sequences (name, description, created_by_email) values ($1, $2, $3) returning id::text", [name, description, tx.actor.email])
  ).rows[0].id;
  await saveSteps(tx, id, steps);
  await writeAuditEvent(tx, { eventType: "crm.sequence_created", entityType: "crm_sequence", entityId: id, details: { name, steps } });
  return getSequence(tx, id);
}

export async function updateSequence(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; description?: unknown; steps?: unknown; isActive?: unknown },
): Promise<Sequence> {
  await requireCrm(tx);
  const current = await getSequence(tx, requireId(idInput, "sequenceId"));
  const name = input.name === undefined ? current.name : requireString(input.name, "name", { maxLength: 100 });
  const description = input.description === undefined ? current.description : optionalString(input.description, "description", { maxLength: 500 });
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") throw new ValidationError("isActive must be true or false.");
  const isActive = (input.isActive as boolean | undefined) ?? current.isActive;
  await assertNameFree(tx, name, current.id);
  if (input.steps !== undefined) {
    // The steps people are part-way through don't change under them.
    if (current.activeEnrolments > 0) {
      throw new ConflictError(`${current.activeEnrolments} ${current.activeEnrolments === 1 ? "is" : "are"} part-way through this sequence, so its steps can't change. Make a new sequence instead.`);
    }
    await saveSteps(tx, current.id, await parseSteps(tx, input.steps));
  }
  await tx.query("update crm_sequences set name = $2, description = $3, is_active = $4, updated_at = now() where id = $1", [current.id, name, description, isActive]);
  await writeAuditEvent(tx, { eventType: "crm.sequence_updated", entityType: "crm_sequence", entityId: current.id, details: { name, isActive, stepsChanged: input.steps !== undefined } });
  return getSequence(tx, current.id);
}

// ---------------------------------------------------------------------------
// Enrolments

type EnrolmentRow = {
  id: string;
  sequence_id: string;
  sequence_name: string;
  lead_id: string | null;
  person_id: string | null;
  opportunity_id: string | null;
  target_name: string;
  assignee_user_id: string | null;
  status: EnrolmentStatus;
  stop_reason: string | null;
  started_on: string;
  enrolled_at: string;
  ended_at: string | null;
  steps_done: number;
  steps_total: number;
};

const ENROLMENT_SELECT = `select e.id::text, e.sequence_id::text, s.name as sequence_name, e.lead_id::text, e.person_id::text, e.opportunity_id::text,
    coalesce(nullif(concat_ws(' ', l.first_name, l.last_name), ''), l.company_name, l.email,
             nullif(concat_ws(' ', p.first_name, p.last_name), ''), o.name, 'Record') as target_name,
    e.assignee_user_id, e.status, e.stop_reason, e.started_on::text, e.enrolled_at::text, e.ended_at::text,
    (select count(*)::int from crm_sequence_step_runs r where r.enrolment_id = e.id) as steps_done,
    (select count(*)::int from crm_sequence_steps st where st.sequence_id = e.sequence_id) as steps_total
  from crm_sequence_enrolments e
  join crm_sequences s on s.id = e.sequence_id
  left join crm_leads l on l.id = e.lead_id
  left join crm_people p on p.id = e.person_id
  left join crm_opportunities o on o.id = e.opportunity_id`;

function toEnrolment(row: EnrolmentRow): Enrolment {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    sequenceName: row.sequence_name,
    leadId: row.lead_id,
    personId: row.person_id,
    opportunityId: row.opportunity_id,
    targetName: row.target_name,
    assigneeUserId: row.assignee_user_id,
    status: row.status,
    stopReason: row.stop_reason,
    startedOn: row.started_on,
    enrolledAt: new Date(row.enrolled_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    stepsDone: row.steps_done,
    stepsTotal: row.steps_total,
  };
}

type Target = { leadId?: unknown; personId?: unknown; opportunityId?: unknown };

/** The one record, checked against the person's scope (decision 491). */
async function resolveTarget(tx: OrgTx, input: Target, scope?: CrmScope) {
  const leadId = optionalId(input.leadId, "leadId");
  const personId = optionalId(input.personId, "personId");
  const opportunityId = optionalId(input.opportunityId, "opportunityId");
  if ([leadId, personId, opportunityId].filter(Boolean).length !== 1) throw new ValidationError("Choose one lead, person or deal.");
  if (leadId) {
    const lead = await getLead(tx, leadId, scope);
    if (!seesLead(scope, lead.ownerUserId)) throw new NotFoundError("Lead not found.");
    return { leadId, personId: null, opportunityId: null, owner: lead.ownerUserId };
  }
  if (opportunityId) {
    const deal = await getOpportunity(tx, opportunityId, scope);
    return { leadId: null, personId: null, opportunityId, owner: deal.ownerUserId };
  }
  await getPerson(tx, personId);
  return { leadId: null, personId, opportunityId: null, owner: null };
}

export async function listEnrolments(tx: OrgTx, input: Target & { sequenceId?: unknown; activeOnly?: boolean }, scope?: CrmScope): Promise<Enrolment[]> {
  const sequenceId = optionalId(input.sequenceId, "sequenceId");
  const target = sequenceId && input.leadId === undefined && input.personId === undefined && input.opportunityId === undefined ? null : await resolveTarget(tx, input, scope);
  const result = await tx.query<EnrolmentRow>(
    `${ENROLMENT_SELECT}
      where ($1::bigint is null or e.sequence_id = $1) and ($2::bigint is null or e.lead_id = $2) and ($3::bigint is null or e.person_id = $3)
        and ($4::bigint is null or e.opportunity_id = $4) and (not $5::boolean or e.status = 'active')
      order by e.status = 'active' desc, e.enrolled_at desc, e.id desc
      limit 200`,
    [sequenceId, target?.leadId ?? null, target?.personId ?? null, target?.opportunityId ?? null, input.activeOnly ?? false],
  );
  return result.rows.map(toEnrolment);
}

async function getEnrolment(tx: OrgTx, id: string): Promise<Enrolment> {
  const result = await tx.query<EnrolmentRow>(`${ENROLMENT_SELECT} where e.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Not found in that sequence.");
  return toEnrolment(result.rows[0]);
}

/** Adds a lead, person or deal to a sequence; today's steps become tasks straight away. */
export async function enrol(tx: OrgTx, input: Target & { sequenceId?: unknown }, scope?: CrmScope, today = todayIsoDate()): Promise<Enrolment> {
  await requireCrm(tx);
  const sequence = await getSequence(tx, requireId(input.sequenceId, "sequenceId"));
  if (!sequence.isActive) throw new ConflictError(`${sequence.name} is switched off.`);
  const target = await resolveTarget(tx, input, scope);
  const assignee = target.owner ?? tx.actor.userId;
  let id: string;
  try {
    await tx.query("savepoint enrol_once");
    id = (
      await tx.query<{ id: string }>(
        `insert into crm_sequence_enrolments (sequence_id, lead_id, person_id, opportunity_id, assignee_user_id, started_on, enrolled_by_email)
         values ($1, $2, $3, $4, $5, $6, $7) returning id::text`,
        [sequence.id, target.leadId, target.personId, target.opportunityId, assignee, today, tx.actor.email],
      )
    ).rows[0].id;
    await tx.query("release savepoint enrol_once");
  } catch (error) {
    await tx.query("rollback to savepoint enrol_once");
    if ((error as { code?: string }).code === "23505") throw new ConflictError(`Already part-way through ${sequence.name}.`);
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "crm.sequence_enrolled", entityType: "crm_sequence_enrolment", entityId: id, details: { sequence: sequence.name, ...target } });
  await advanceEnrolment(tx, id, today);
  return getEnrolment(tx, id);
}

export async function stopEnrolment(tx: OrgTx, idInput: unknown, scope?: CrmScope): Promise<Enrolment> {
  await requireCrm(tx);
  const current = await getEnrolment(tx, requireId(idInput, "enrolmentId"));
  await resolveTarget(tx, { leadId: current.leadId ?? undefined, personId: current.personId ?? undefined, opportunityId: current.opportunityId ?? undefined }, scope);
  if (current.status !== "active") return current;
  await finish(tx, current.id, "stopped", `Stopped by ${tx.actor.email}.`);
  return getEnrolment(tx, current.id);
}

async function finish(tx: OrgTx, id: string, status: "finished" | "stopped", reason: string | null): Promise<void> {
  await tx.query("update crm_sequence_enrolments set status = $2, stop_reason = $3, ended_at = now() where id = $1 and status = 'active'", [id, status, reason]);
  await writeAuditEvent(tx, { eventType: status === "finished" ? "crm.sequence_finished" : "crm.sequence_stopped", entityType: "crm_sequence_enrolment", entityId: id, details: { reason } });
}

/** Why an enrolment should stop by itself now, if it should. */
async function stopReason(tx: OrgTx, enrolment: { id: string; lead_id: string | null; person_id: string | null; opportunity_id: string | null; enrolled_at: string }): Promise<string | null> {
  let email: string | null = null;
  if (enrolment.lead_id) {
    const lead = (await tx.query<{ status: string; email: string | null }>("select status, email from crm_leads where id = $1", [enrolment.lead_id])).rows[0];
    if (lead.status === "unqualified") return "The lead was marked unqualified.";
    if (lead.status === "converted") return "The lead was converted.";
    email = lead.email;
    // An email from the lead into a lead mailbox becomes a note on it (decision 493).
    const replied = await tx.query(
      "select 1 from crm_activities a where a.lead_id = $1 and a.created_by_email = 'lead-mailbox@tohyee' and a.created_at > $2::timestamptz limit 1",
      [enrolment.lead_id, enrolment.enrolled_at],
    );
    if ((replied.rowCount ?? 0) > 0) return "They replied.";
  }
  if (enrolment.opportunity_id) {
    const deal = (
      await tx.query<{ stage_type: string; email: string | null }>(
        `select s.stage_type, p.email from crm_opportunities o join crm_opportunity_stages s on s.key = o.stage
           left join crm_people p on p.id = o.point_of_contact_id where o.id = $1`,
        [enrolment.opportunity_id],
      )
    ).rows[0];
    if (deal.stage_type === "won") return "The deal was won.";
    if (deal.stage_type === "lost") return "The deal was lost.";
    email = deal.email;
  }
  if (enrolment.person_id) {
    const person = (await tx.query<{ is_archived: boolean; email: string | null }>("select is_archived, email from crm_people where id = $1", [enrolment.person_id])).rows[0];
    if (person.is_archived) return "The person was archived.";
    email = person.email;
  }
  if (email) {
    const replied = await tx.query("select 1 from crm_messages m where m.direction = 'received' and lower(m.from_email) = lower($1) and m.sent_at > $2::timestamptz limit 1", [
      email,
      enrolment.enrolled_at,
    ]);
    if ((replied.rowCount ?? 0) > 0) return "They replied.";
  }
  return null;
}

async function optedOut(tx: OrgTx, enrolment: { lead_id: string | null; person_id: string | null; opportunity_id: string | null }): Promise<boolean> {
  const row = (
    await tx.query<{ opt_out: boolean | null }>(
      `select coalesce(
         (select l.email_opt_out from crm_leads l where l.id = $1),
         (select p.email_opt_out from crm_people p where p.id = $2),
         (select p.email_opt_out from crm_opportunities o join crm_people p on p.id = o.point_of_contact_id where o.id = $3)
       ) as opt_out`,
      [enrolment.lead_id, enrolment.person_id, enrolment.opportunity_id],
    )
  ).rows[0];
  return row?.opt_out === true;
}

/** Makes the tasks for an enrolment's steps that are due, stops it if it should, and finishes it after the last step. */
export async function advanceEnrolment(tx: OrgTx, id: string, today = todayIsoDate()): Promise<{ tasksCreated: number }> {
  const row = (
    await tx.query<{
      id: string;
      sequence_id: string;
      lead_id: string | null;
      person_id: string | null;
      opportunity_id: string | null;
      assignee_user_id: string | null;
      status: EnrolmentStatus;
      started_on: string;
      enrolled_at: string;
      target_name: string;
      contact_id: string | null;
    }>(
      `select e.id::text, e.sequence_id::text, e.lead_id::text, e.person_id::text, e.opportunity_id::text, e.assignee_user_id, e.status,
              e.started_on::text, e.enrolled_at::text,
              coalesce(nullif(concat_ws(' ', l.first_name, l.last_name), ''), l.company_name, l.email,
                       nullif(concat_ws(' ', p.first_name, p.last_name), ''), o.name, 'Record') as target_name,
              coalesce(p.contact_id, o.contact_id)::text as contact_id
         from crm_sequence_enrolments e
         left join crm_leads l on l.id = e.lead_id
         left join crm_people p on p.id = e.person_id
         left join crm_opportunities o on o.id = e.opportunity_id
        where e.id = $1 for update of e`,
      [id],
    )
  ).rows[0];
  if (!row || row.status !== "active") return { tasksCreated: 0 };
  const reason = await stopReason(tx, row);
  if (reason) {
    await finish(tx, row.id, "stopped", reason);
    return { tasksCreated: 0 };
  }
  const steps = await tx.query<{ position: number; day_offset: number; kind: StepKind; title: string; template_name: string | null }>(
    `select st.position, st.day_offset, st.kind, st.title, t.name as template_name
       from crm_sequence_steps st left join crm_email_templates t on t.id = st.template_id
      where st.sequence_id = $1 order by st.position`,
    [row.sequence_id],
  );
  const done = new Set((await tx.query<{ position: number }>("select position from crm_sequence_step_runs where enrolment_id = $1", [row.id])).rows.map((entry) => entry.position));
  const noEmail = await optedOut(tx, row);
  let tasksCreated = 0;
  for (const step of steps.rows) {
    if (done.has(step.position)) continue;
    const due = addDays(row.started_on, step.day_offset);
    if (due > today) break;
    if (step.kind === "email" && noEmail) {
      await tx.query("insert into crm_sequence_step_runs (enrolment_id, position, outcome, detail) values ($1, $2, 'skipped', $3) on conflict do nothing", [
        row.id,
        step.position,
        "They asked not to be emailed.",
      ]);
      done.add(step.position);
      continue;
    }
    const claimed = await tx.query("insert into crm_sequence_step_runs (enrolment_id, position, outcome) values ($1, $2, 'task_created') on conflict do nothing returning id", [
      row.id,
      step.position,
    ]);
    if ((claimed.rowCount ?? 0) === 0) continue;
    const base = `${step.title}: ${row.target_name}`;
    const task = await createTask(tx, {
      title: base.length > 200 ? `${base.slice(0, 199)}…` : base,
      body:
        step.kind === "email"
          ? `Send the "${step.template_name ?? "chosen"}" email with Send email on the record. Nothing is sent until you press Send.`
          : step.kind === "call"
            ? "Call them, then log the call."
            : null,
      dueDate: due,
      assigneeUserId: row.assignee_user_id,
      leadId: row.lead_id,
      personId: row.person_id,
      opportunityId: row.opportunity_id,
      contactId: row.lead_id ? null : row.contact_id,
    });
    await tx.query("update crm_sequence_step_runs set task_id = $3 where enrolment_id = $1 and position = $2", [row.id, step.position, task.id]);
    done.add(step.position);
    tasksCreated += 1;
  }
  if (steps.rows.every((step) => done.has(step.position))) await finish(tx, row.id, "finished", null);
  return { tasksCreated };
}

/** Moves every active enrolment on (run with the follow-up rules, every 15 minutes). */
export async function advanceSequences(tx: OrgTx, today = todayIsoDate()): Promise<{ tasksCreated: number; failed: number }> {
  await requireCrm(tx);
  // One run at a time per organisation, as for the follow-up rules.
  await tx.query("select pg_advisory_xact_lock(hashtext('crm_follow_up_rules'))");
  const active = await tx.query<{ id: string }>("select e.id::text from crm_sequence_enrolments e where e.status = 'active' order by e.id");
  let tasksCreated = 0;
  let failed = 0;
  for (const { id } of active.rows) {
    // One that can't go on (say its owner has left) doesn't hold up the rest.
    await tx.query("savepoint sequence_step");
    try {
      tasksCreated += (await advanceEnrolment(tx, id, today)).tasksCreated;
      await tx.query("release savepoint sequence_step");
    } catch (error) {
      await tx.query("rollback to savepoint sequence_step");
      failed += 1;
      console.warn(`[tohyee] Sequence enrolment ${id}:`, error instanceof Error ? error.message : error);
    }
  }
  return { tasksCreated, failed };
}

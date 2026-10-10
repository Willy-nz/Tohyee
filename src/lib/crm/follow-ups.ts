import { writeAuditEvent } from "@/lib/audit";
import { createTask } from "@/lib/crm/service";
import { advanceSequences } from "@/lib/crm/sequences";
import { listStages } from "@/lib/crm/stages";
import { crmEnabled, requireCrm } from "@/lib/crm/switch";
import { isoDateAt, todayIsoDate } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addDays as addDaysIso } from "@/lib/financial-year";
import { listMembers } from "@/lib/organisations/members";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord as Organisation } from "@/lib/organisations/registry";
import { optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/**
 * Follow-up rules (decision 495, #216 stage 2; Jess 10 Oct 2026). An admin
 * sets up rules; each makes a task for the right person:
 *
 * - **lead_arrives:** a lead added after the rule was made gets a task for
 *   its owner, due in `days`; an unassigned lead gets one for each sales
 *   team manager (or one with nobody assigned when there are no teams).
 * - **deal_stage:** an open deal that reaches `stageKey` after the rule was
 *   made gets a task for its owner, due `days` after it got there.
 * - **deal_quiet:** an open deal with nothing logged for `days` days (no
 *   call, meeting or note, no task done, no change) gets a reminder for its
 *   owner, due today; once per quiet spell.
 * - **task_overdue:** a task `days` or more days overdue gets a task for the
 *   assignee's sales team manager; once per due date. Tasks of people who
 *   aren't in a team (or who manage it) are left alone.
 *
 * Reminders stay in Tohyee (tasks and CRM home); nothing is emailed. Rules
 * are checked every 15 minutes and on "Run now". Each run is kept with a key
 * per rule and event (unique), and the task is made in the same transaction,
 * so a check that runs twice, or at the same time, never makes a second task.
 */

export const FOLLOW_UP_KINDS = ["lead_arrives", "deal_stage", "deal_quiet", "task_overdue"] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

export type FollowUpRule = {
  id: string;
  kind: FollowUpKind;
  name: string;
  stageKey: string | null;
  days: number;
  taskTitle: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FollowUpRun = {
  id: string;
  ruleId: string;
  ruleName: string;
  outcome: "task_created" | "skipped";
  detail: string | null;
  taskId: string | null;
  taskTitle: string | null;
  leadId: string | null;
  opportunityId: string | null;
  sourceTaskId: string | null;
  ranAt: string;
};

export const FOLLOW_UP_ACTOR: Actor = { userId: null, email: "follow-up-rules@tohyee" };

type RuleRow = {
  id: string;
  kind: FollowUpKind;
  name: string;
  stage_key: string | null;
  days: number;
  task_title: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

const RULE_SELECT = `select r.id::text, r.kind, r.name, r.stage_key, r.days, r.task_title, r.is_active, r.created_at::text, r.updated_at::text from crm_follow_up_rules r`;

function toRule(row: RuleRow): FollowUpRule {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    stageKey: row.stage_key,
    days: row.days,
    taskTitle: row.task_title,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listFollowUpRules(tx: OrgTx): Promise<FollowUpRule[]> {
  const result = await tx.query<RuleRow>(`${RULE_SELECT} order by r.is_active desc, r.name, r.id`);
  return result.rows.map(toRule);
}

async function getRule(tx: OrgTx, id: string): Promise<FollowUpRule> {
  const result = await tx.query<RuleRow>(`${RULE_SELECT} where r.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Follow-up rule not found.");
  return toRule(result.rows[0]);
}

type RuleInput = { kind?: unknown; name?: unknown; stageKey?: unknown; days?: unknown; taskTitle?: unknown; isActive?: unknown };

function parseDays(input: unknown, kind: FollowUpKind): number {
  const days = typeof input === "number" ? input : typeof input === "string" && input.trim() !== "" ? Number(input) : NaN;
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new ValidationError("Days must be a whole number from 0 to 365.");
  if ((kind === "deal_quiet" || kind === "task_overdue") && days < 1) throw new ValidationError("Days must be at least 1 for this rule.");
  return days;
}

async function ruleValues(tx: OrgTx, input: RuleInput, current: FollowUpRule | null) {
  // The kind is fixed once made: a rule's runs only make sense for one kind.
  const kind = current ? current.kind : requireOneOf(input.kind, "kind", FOLLOW_UP_KINDS);
  const name = input.name === undefined && current ? current.name : requireString(input.name, "name", { maxLength: 100 });
  let stageKey: string | null = null;
  if (kind === "deal_stage") {
    stageKey = input.stageKey === undefined && current ? current.stageKey : requireString(input.stageKey, "stage", { maxLength: 40 });
    const stage = (await listStages(tx)).find((entry) => entry.key === stageKey);
    if (!stage) throw new ValidationError("Choose one of the deal stages.");
    if (stage.type !== "open") throw new ValidationError("Choose an open stage: won and lost deals don't need a follow-up.");
  }
  const days = input.days === undefined && current ? current.days : parseDays(input.days, kind);
  const taskTitle = input.taskTitle === undefined ? (current?.taskTitle ?? null) : optionalString(input.taskTitle, "task title", { maxLength: 150 });
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") throw new ValidationError("isActive must be true or false.");
  const isActive = input.isActive === undefined ? (current?.isActive ?? true) : input.isActive;
  return { kind, name, stageKey, days, taskTitle, isActive };
}

export async function createFollowUpRule(tx: OrgTx, input: RuleInput): Promise<FollowUpRule> {
  await requireCrm(tx);
  const v = await ruleValues(tx, input, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into crm_follow_up_rules (kind, name, stage_key, days, task_title, is_active, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7) returning id::text`,
    [v.kind, v.name, v.stageKey, v.days, v.taskTitle, v.isActive, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.follow_up_rule_created", entityType: "crm_follow_up_rule", entityId: id, details: v });
  return getRule(tx, id);
}

export async function updateFollowUpRule(tx: OrgTx, idInput: unknown, input: RuleInput): Promise<FollowUpRule> {
  await requireCrm(tx);
  const current = await getRule(tx, requireId(idInput, "ruleId"));
  if (input.kind !== undefined && input.kind !== current.kind) throw new ValidationError("A rule's kind can't be changed. Add a new rule instead.");
  const v = await ruleValues(tx, input, current);
  await tx.query(
    `update crm_follow_up_rules set name = $2, stage_key = $3, days = $4, task_title = $5, is_active = $6, updated_at = now() where id = $1`,
    [current.id, v.name, v.stageKey, v.days, v.taskTitle, v.isActive],
  );
  await writeAuditEvent(tx, { eventType: "crm.follow_up_rule_updated", entityType: "crm_follow_up_rule", entityId: current.id, details: v });
  return getRule(tx, current.id);
}

export async function listFollowUpRuns(tx: OrgTx, options: { ruleId?: unknown; limit?: number } = {}): Promise<FollowUpRun[]> {
  const ruleId = options.ruleId === undefined || options.ruleId === null || options.ruleId === "" ? null : requireId(options.ruleId, "ruleId");
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const result = await tx.query<{
    id: string;
    rule_id: string;
    rule_name: string;
    outcome: FollowUpRun["outcome"];
    detail: string | null;
    task_id: string | null;
    task_title: string | null;
    lead_id: string | null;
    opportunity_id: string | null;
    source_task_id: string | null;
    ran_at: string;
  }>(
    `select x.id::text, x.rule_id::text, r.name as rule_name, x.outcome, x.detail, x.task_id::text, t.title as task_title,
            x.lead_id::text, x.opportunity_id::text, x.source_task_id::text, x.ran_at::text
       from crm_follow_up_runs x
       join crm_follow_up_rules r on r.id = x.rule_id
       left join crm_tasks t on t.id = x.task_id
      where ($1::bigint is null or x.rule_id = $1)
      order by x.ran_at desc, x.id desc
      limit ${limit}`,
    [ruleId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    outcome: row.outcome,
    detail: row.detail,
    taskId: row.task_id,
    taskTitle: row.task_title,
    leadId: row.lead_id,
    opportunityId: row.opportunity_id,
    sourceTaskId: row.source_task_id,
    ranAt: new Date(row.ran_at).toISOString(),
  }));
}

type Planned = {
  key: string;
  title: string;
  body: string | null;
  dueDate: string;
  assignees: Array<string | null>;
  leadId?: string | null;
  opportunityId?: string | null;
  contactId?: string | null;
  sourceTaskId?: string | null;
  /** Why no task was made, when none can be. */
  skip?: string;
};

function titled(rule: FollowUpRule, fallback: string, name: string): string {
  const base = rule.taskTitle ? `${rule.taskTitle}: ${name}` : `${fallback}: ${name}`;
  return base.length > 200 ? `${base.slice(0, 199)}…` : base;
}

async function teamManagers(tx: OrgTx): Promise<string[]> {
  const result = await tx.query<{ manager_user_id: string }>("select distinct manager_user_id from crm_teams order by manager_user_id");
  return result.rows.map((row) => row.manager_user_id);
}

async function planLeadArrives(tx: OrgTx, rule: FollowUpRule, today: string): Promise<Planned[]> {
  const leads = await tx.query<{ id: string; name: string; owner_user_id: string | null }>(
    `select l.id::text, coalesce(nullif(concat_ws(' ', l.first_name, l.last_name), ''), l.company_name, l.email, 'Lead ' || l.id) as name, l.owner_user_id
       from crm_leads l
      where l.created_at >= $1::timestamptz and l.status in ('new', 'working')
        and not exists (select 1 from crm_follow_up_runs x where x.rule_id = $2 and x.run_key = 'lead:' || l.id)
      order by l.id
      limit 500`,
    [rule.createdAt, rule.id],
  );
  const managers = leads.rows.some((lead) => lead.owner_user_id === null) ? await teamManagers(tx) : [];
  return leads.rows.map((lead) => ({
    key: `lead:${lead.id}`,
    title: titled(rule, "Contact new lead", lead.name),
    body: lead.owner_user_id ? null : "Nobody owns this lead yet: take it, or give it to someone.",
    dueDate: addDaysIso(today, rule.days),
    assignees: lead.owner_user_id ? [lead.owner_user_id] : managers.length > 0 ? managers : [null],
    leadId: lead.id,
  }));
}

/** When each open deal now in `stageKey` got there: the audit event that moved it in (stage history, CRMS6). */
async function enteredStage(tx: OrgTx, stageKey: string): Promise<Array<{ id: string; name: string; owner: string | null; contactId: string; eventId: string; at: string }>> {
  const deals = await tx.query<{ id: string; name: string; owner_user_id: string | null; contact_id: string }>(
    `select o.id::text, o.name, o.owner_user_id, o.contact_id::text
       from crm_opportunities o join crm_opportunity_stages s on s.key = o.stage
      where o.stage = $1 and s.stage_type = 'open'
      order by o.id`,
    [stageKey],
  );
  if (deals.rows.length === 0) return [];
  const events = await tx.query<{ id: string; entity_id: string; stage: string | null; created_at: string }>(
    `select a.id::text, a.entity_id, a.details->>'stage' as stage, a.created_at::text
       from audit_events a
      where a.entity_type = 'crm_opportunity' and a.event_type in ('crm.opportunity_created', 'crm.opportunity_updated')
        and a.entity_id = any($1::text[])
      order by a.entity_id, a.id`,
    [deals.rows.map((deal) => deal.id)],
  );
  const entered = new Map<string, { eventId: string; at: string }>();
  const last = new Map<string, string>();
  for (const event of events.rows) {
    const previous = last.get(event.entity_id);
    const stage = event.stage ?? previous ?? null;
    if (stage === null) continue;
    if (stage === stageKey && previous !== stageKey) entered.set(event.entity_id, { eventId: event.id, at: new Date(event.created_at).toISOString() });
    last.set(event.entity_id, stage);
  }
  return deals.rows.flatMap((deal) => {
    const into = entered.get(deal.id);
    return into ? [{ id: deal.id, name: deal.name, owner: deal.owner_user_id, contactId: deal.contact_id, eventId: into.eventId, at: into.at }] : [];
  });
}

async function planDealStage(tx: OrgTx, rule: FollowUpRule): Promise<Planned[]> {
  const ruleMade = new Date(rule.createdAt).getTime();
  const done = new Set(
    (await tx.query<{ run_key: string }>("select run_key from crm_follow_up_runs where rule_id = $1", [rule.id])).rows.map((row) => row.run_key),
  );
  return (await enteredStage(tx, rule.stageKey ?? ""))
    .filter((deal) => new Date(deal.at).getTime() >= ruleMade && !done.has(`deal:${deal.id}:${deal.eventId}`))
    .map((deal) => ({
      key: `deal:${deal.id}:${deal.eventId}`,
      title: titled(rule, "Follow up", deal.name),
      body: null,
      dueDate: addDaysIso(isoDateAt(new Date(deal.at)), rule.days),
      assignees: [deal.owner],
      opportunityId: deal.id,
      contactId: deal.contactId,
      skip: deal.owner ? undefined : "The deal has no owner.",
    }));
}

async function planDealQuiet(tx: OrgTx, rule: FollowUpRule, today: string): Promise<Planned[]> {
  // The last thing that happened on each open deal, as a date in the business time zone.
  const deals = await tx.query<{ id: string; name: string; owner_user_id: string | null; contact_id: string; last_at: string }>(
    `select o.id::text, o.name, o.owner_user_id, o.contact_id::text,
            greatest(
              o.created_at,
              (select max(a.happened_at) from crm_activities a where a.opportunity_id = o.id),
              (select max(t.completed_at) from crm_tasks t where t.opportunity_id = o.id),
              (select max(e.created_at) from audit_events e
                where e.entity_type = 'crm_opportunity' and e.entity_id = o.id::text and e.actor_email is distinct from $1)
            )::text as last_at
       from crm_opportunities o join crm_opportunity_stages s on s.key = o.stage
      where s.stage_type = 'open'
      order by o.id`,
    [FOLLOW_UP_ACTOR.email],
  );
  const planned: Planned[] = [];
  for (const deal of deals.rows) {
    const lastDay = isoDateAt(new Date(deal.last_at));
    if (addDaysIso(lastDay, rule.days) > today) continue;
    planned.push({
      key: `quiet:${deal.id}:${lastDay}`,
      title: titled(rule, "Check in on quiet deal", deal.name),
      body: `Nothing has been logged on this deal since ${lastDay}.`,
      dueDate: today,
      assignees: [deal.owner_user_id],
      opportunityId: deal.id,
      contactId: deal.contact_id,
      skip: deal.owner_user_id ? undefined : "The deal has no owner.",
    });
  }
  return planned;
}

async function planTaskOverdue(tx: OrgTx, rule: FollowUpRule, today: string): Promise<Planned[]> {
  const latest = addDaysIso(today, -rule.days);
  const tasks = await tx.query<{
    id: string;
    title: string;
    due_date: string;
    assignee_user_id: string | null;
    manager_user_id: string | null;
    contact_id: string | null;
    opportunity_id: string | null;
    lead_id: string | null;
  }>(
    `select t.id::text, t.title, t.due_date::text, t.assignee_user_id, tm.manager_user_id, t.contact_id::text, t.opportunity_id::text, t.lead_id::text
       from crm_tasks t
       left join crm_team_members m on m.user_id = t.assignee_user_id
       left join crm_teams tm on tm.id = m.team_id
      where t.status <> 'done' and t.due_date <= $1::date
        -- Only someone in a sales team has a manager to tell (decision 491).
        and tm.manager_user_id is not null and tm.manager_user_id <> t.assignee_user_id
        -- Not the reminders this rule made itself.
        and not exists (select 1 from crm_follow_up_runs own where own.rule_id = $2 and own.task_id = t.id)
      order by t.id`,
    [latest, rule.id],
  );
  if (tasks.rows.length === 0) return [];
  const names = new Map((await listMembers(tx.organisationId)).map((member) => [member.userId, member.displayName]));
  return tasks.rows.map((task) => {
    const who = (task.assignee_user_id && names.get(task.assignee_user_id)) || "someone who has left";
    return {
      key: `overdue:${task.id}:${task.due_date}`,
      title: titled(rule, "Overdue", `${task.title} (${who})`),
      body: `${who}'s task was due ${task.due_date} and isn't done.`,
      dueDate: today,
      assignees: [task.manager_user_id],
      contactId: task.contact_id,
      opportunityId: task.opportunity_id,
      leadId: task.lead_id,
      sourceTaskId: task.id,
    };
  });
}

export type FollowUpResult = { tasksCreated: number; skipped: number };

/** Runs every active rule once (or one rule). Safe to run again: each event makes its task(s) once. */
export async function runFollowUpRules(tx: OrgTx, options: { ruleId?: unknown; today?: string } = {}): Promise<FollowUpResult> {
  await requireCrm(tx);
  // One run at a time per organisation; another waits, then finds the work done.
  await tx.query("select pg_advisory_xact_lock(hashtext('crm_follow_up_rules'))");
  const today = options.today ?? todayIsoDate();
  const only = options.ruleId === undefined ? null : requireId(options.ruleId, "ruleId");
  const rules = (await listFollowUpRules(tx)).filter((rule) => rule.isActive && (only === null || rule.id === only));
  const result: FollowUpResult = { tasksCreated: 0, skipped: 0 };
  for (const rule of rules) {
    const planned =
      rule.kind === "lead_arrives"
        ? await planLeadArrives(tx, rule, today)
        : rule.kind === "deal_stage"
          ? await planDealStage(tx, rule)
          : rule.kind === "deal_quiet"
            ? await planDealQuiet(tx, rule, today)
            : await planTaskOverdue(tx, rule, today);
    for (const plan of planned) {
      const claimed = await tx.query<{ id: string }>(
        `insert into crm_follow_up_runs (rule_id, run_key, lead_id, opportunity_id, source_task_id, outcome, detail)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (rule_id, run_key) do nothing returning id::text`,
        [rule.id, plan.key, plan.leadId ?? null, plan.opportunityId ?? null, plan.sourceTaskId ?? null, plan.skip ? "skipped" : "task_created", plan.skip ?? null],
      );
      const runId = claimed.rows[0]?.id;
      if (!runId) continue;
      if (plan.skip) {
        result.skipped += 1;
        continue;
      }
      let first: string | null = null;
      for (const assignee of plan.assignees) {
        const task = await createTask(tx, {
          title: plan.title,
          body: plan.body,
          dueDate: plan.dueDate,
          assigneeUserId: assignee,
          leadId: plan.leadId ?? null,
          // A task is about a lead, or about a company and maybe its deal.
          contactId: plan.leadId ? null : (plan.contactId ?? null),
          opportunityId: plan.leadId ? null : (plan.opportunityId ?? null),
        });
        first ??= task.id;
        result.tasksCreated += 1;
        if (plan.assignees.length > 1 && task.id !== first) {
          // More than one manager: each task gets its own run row, so the history shows them all.
          await tx.query(
            `insert into crm_follow_up_runs (rule_id, run_key, task_id, lead_id, opportunity_id, source_task_id, outcome)
             values ($1, $2, $3, $4, $5, $6, 'task_created')`,
            [rule.id, `${plan.key}:${task.id}`, task.id, plan.leadId ?? null, plan.opportunityId ?? null, plan.sourceTaskId ?? null],
          );
        }
      }
      await tx.query("update crm_follow_up_runs set task_id = $2 where id = $1", [runId, first]);
    }
  }
  return result;
}

let running = false;

/** Runs the rules, and moves sequences on (decision 497), for every organisation with the CRM on. */
export async function runDueFollowUpRules(organisations?: Organisation[]): Promise<{ organisations: number; tasksCreated: number; failed: number }> {
  if (running) return { organisations: 0, tasksCreated: 0, failed: 0 };
  running = true;
  const total = { organisations: 0, tasksCreated: 0, failed: 0 };
  try {
    for (const organisation of organisations ?? (await listAllOrganisations())) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      try {
        const done = await withOrganisationTransaction(organisation, FOLLOW_UP_ACTOR, async (tx) => {
          if (!(await crmEnabled(tx))) return null;
          const any = await tx.query<{ rules: boolean; enrolments: boolean }>(
            `select exists (select 1 from crm_follow_up_rules where is_active) as rules,
                    exists (select 1 from crm_sequence_enrolments where status = 'active') as enrolments`,
          );
          const { rules, enrolments } = any.rows[0];
          if (!rules && !enrolments) return null;
          const fromRules = rules ? await runFollowUpRules(tx) : { tasksCreated: 0, skipped: 0 };
          // Sequences' steps (decision 497) are moved on in the same check.
          const fromSequences = enrolments ? await advanceSequences(tx) : { tasksCreated: 0 };
          return { tasksCreated: fromRules.tasksCreated + fromSequences.tasksCreated };
        });
        if (done) {
          total.organisations += 1;
          total.tasksCreated += done.tasksCreated;
        }
      } catch (caught) {
        total.failed += 1;
        console.warn(`[tohyee] Follow-up rules for ${organisation.id}:`, caught instanceof Error ? caught.message : caught);
      }
    }
    return total;
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Checks the follow-up rules every 15 minutes while the server runs. */
export function startFollowUpScheduler(): void {
  if (timer) return;
  const tick = () => {
    runDueFollowUpRules().catch((caught) => console.warn("[tohyee] Follow-up rules:", caught));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 2 * 60 * 1000).unref?.();
}

import { writeAuditEvent } from "@/lib/audit";
import { getContact } from "@/lib/contacts/service";
import { assertSeesOwner, type CrmScope, ownerFilter } from "@/lib/crm/access";
import { getOpportunity, listTasks, type Opportunity, type Task } from "@/lib/crm/service";
import { BUYING_ROLES, type BuyingRole, GOAL_STATUSES, type GoalStatus } from "@/lib/crm/account-plan-types";
import { requireCrm } from "@/lib/crm/switch";
import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { optionalString, requireArray, requireOneOf, requireString } from "@/lib/validation";

/**
 * Account plans (decision 653, #216 stage 4; #360 item 17), after
 * Salesforce's account plans (objectives, a relationship map and actions)
 * and HubSpot's buying roles. Xero has nothing like it.
 *
 * One plan per company: a short summary of where things stand, its goals
 * (each with a target date and open, achieved or dropped), and the part each
 * of the company's people plays. Next steps are the company's open tasks, so
 * they have an owner and a due date and show on task lists, rather than a
 * second list. Companies are a shared address book (decision 491), so
 * everyone in the CRM sees a company's plan and anyone who can change CRM
 * records can change it; the deals, renewals and tasks shown with it are
 * only those the person may see.
 */

export const MAX_GOALS = 50;
/** Renewals this many days ahead (and a month back) show on the plan. */
export const RENEWAL_WINDOW_DAYS = 365;

export type PlanGoal = { title: string; targetDate: string | null; status: GoalStatus };
export type PlanPerson = { personId: string; name: string; jobTitle: string | null; role: BuyingRole | null; note: string | null };
export type Renewal = { opportunityId: string; opportunityName: string; contactId: string; renewalDate: string; what: string[]; ownerUserId: string | null; stageType: string };

export type AccountPlan = {
  contactId: string;
  companyName: string;
  /** False until someone first saves the plan. */
  saved: boolean;
  summary: string | null;
  goals: PlanGoal[];
  /** Every active person at the company, with their part in the plan if one's set. */
  people: PlanPerson[];
  renewals: Renewal[];
  openDeals: Array<Pick<Opportunity, "id" | "name" | "stageName" | "amount" | "currencyCode" | "closeDate" | "ownerUserId">>;
  nextSteps: Task[];
  updatedAt: string | null;
  updatedByEmail: string | null;
};

/** Renewal dates on deals and their products for a company (or all companies), grouped per deal and date. */
export async function listRenewals(
  tx: OrgTx,
  options: { contactId?: string; from: string; to: string; scope?: CrmScope },
): Promise<Renewal[]> {
  const params: unknown[] = [options.contactId ?? null, options.from, options.to];
  const visible = ownerFilter(options.scope, "o.owner_user_id", params);
  const rows = await tx.query<{ id: string; name: string; contact_id: string; renewal_date: string; what: string[]; owner_user_id: string | null; stage_type: string }>(
    `select o.id::text, o.name, o.contact_id::text, d.renewal_date::text, array_remove(array_agg(d.what order by d.what), null) as what, o.owner_user_id, s.stage_type
       from (
         select x.id as opportunity_id, x.renewal_date, null::text as what from crm_opportunities x where x.renewal_date is not null
         union all
         select l.opportunity_id, l.renewal_date, l.description from crm_opportunity_lines l where l.renewal_date is not null
       ) d
       join crm_opportunities o on o.id = d.opportunity_id
       join crm_opportunity_stages s on s.key = o.stage
      where s.stage_type <> 'lost' and ($1::bigint is null or o.contact_id = $1)
        and d.renewal_date between $2::date and $3::date and ${visible}
      group by o.id, o.name, o.contact_id, d.renewal_date, o.owner_user_id, s.stage_type
      order by d.renewal_date, o.id`,
    params,
  );
  return rows.rows.map((row) => ({
    opportunityId: row.id,
    opportunityName: row.name,
    contactId: row.contact_id,
    renewalDate: row.renewal_date,
    what: row.what,
    ownerUserId: row.owner_user_id,
    stageType: row.stage_type,
  }));
}

export async function getAccountPlan(tx: OrgTx, contactIdInput: unknown, scope?: CrmScope, today = todayIsoDate()): Promise<AccountPlan> {
  await requireCrm(tx);
  const contact = await getContact(tx, contactIdInput);
  const plan = (
    await tx.query<{ summary: string | null; updated_at: string; updated_by_email: string | null }>(
      "select summary, updated_at::text, updated_by_email from crm_account_plans where contact_id = $1",
      [contact.id],
    )
  ).rows[0];
  const goals = await tx.query<{ title: string; target_date: string | null; status: GoalStatus }>(
    "select title, target_date::text, status from crm_account_plan_goals where contact_id = $1 order by position",
    [contact.id],
  );
  const people = await tx.query<{ id: string; name: string; job_title: string | null; role: BuyingRole | null; note: string | null }>(
    `select p.id::text, concat_ws(' ', p.first_name, p.last_name) as name, p.job_title, r.role, r.note
       from crm_people p left join crm_account_plan_people r on r.person_id = p.id and r.contact_id = p.contact_id
      where p.contact_id = $1 and not p.is_archived
      order by r.role is null, lower(p.first_name), p.id`,
    [contact.id],
  );
  const dealParams: unknown[] = [contact.id];
  const visible = ownerFilter(scope, "o.owner_user_id", dealParams);
  const deals = await tx.query<{ id: string }>(
    `select o.id::text from crm_opportunities o join crm_opportunity_stages s on s.key = o.stage
      where o.contact_id = $1 and s.stage_type = 'open' and ${visible} order by o.close_date nulls last, o.id`,
    dealParams,
  );
  const openDeals = [];
  for (const deal of deals.rows) {
    const o = await getOpportunity(tx, deal.id, scope);
    openDeals.push({ id: o.id, name: o.name, stageName: o.stageName, amount: o.amount, currencyCode: o.currencyCode, closeDate: o.closeDate, ownerUserId: o.ownerUserId });
  }
  return {
    contactId: contact.id,
    companyName: contact.name,
    saved: Boolean(plan),
    summary: plan?.summary ?? null,
    goals: goals.rows.map((row) => ({ title: row.title, targetDate: row.target_date, status: row.status })),
    people: people.rows.map((row) => ({ personId: row.id, name: row.name, jobTitle: row.job_title, role: row.role, note: row.note })),
    renewals: await listRenewals(tx, { contactId: contact.id, from: addDays(today, -30), to: addDays(today, RENEWAL_WINDOW_DAYS), scope }),
    openDeals,
    nextSteps: await listTasks(tx, { contactId: contact.id, open: true, scope }),
    updatedAt: plan ? new Date(plan.updated_at).toISOString() : null,
    updatedByEmail: plan?.updated_by_email ?? null,
  };
}

type PlanInput = { summary?: unknown; goals?: unknown; people?: unknown };

/**
 * Saves a company's plan: the summary, the goals in order, and the part each
 * person plays (a person left out, or with no role, has none). Anyone who can
 * change CRM records.
 */
export async function saveAccountPlan(tx: OrgTx, contactIdInput: unknown, input: PlanInput, scope?: CrmScope): Promise<AccountPlan> {
  await requireCrm(tx);
  const contact = await getContact(tx, contactIdInput);
  const summary = optionalString(input.summary, "summary", { maxLength: 4000 }) ?? null;
  const goals = requireArray(input.goals ?? [], "goals", MAX_GOALS).map((entry, index) => {
    const goal = (entry ?? {}) as Record<string, unknown>;
    return {
      title: requireString(goal.title, `Goal ${index + 1}`, { maxLength: 200 }),
      targetDate: parseOptionalIsoDate(goal.targetDate === "" ? null : goal.targetDate, `goal ${index + 1} target date`),
      status: goal.status === undefined ? ("open" as const) : requireOneOf(goal.status, `goal ${index + 1} status`, GOAL_STATUSES),
    };
  });
  const atCompany = new Set(
    (await tx.query<{ id: string }>("select id::text from crm_people where contact_id = $1", [contact.id])).rows.map((row) => row.id),
  );
  const roles = requireArray(input.people ?? [], "people", 500).flatMap((entry, index) => {
    const person = (entry ?? {}) as Record<string, unknown>;
    const personId = String(person.personId ?? "");
    if (!atCompany.has(personId)) throw new ValidationError(`Person ${index + 1} isn't at ${contact.name}.`);
    if (person.role === null || person.role === undefined || person.role === "") return [];
    return [{ personId, role: requireOneOf(person.role, "role", BUYING_ROLES), note: optionalString(person.note, "note", { maxLength: 300 }) ?? null }];
  });
  await tx.query(
    `insert into crm_account_plans (contact_id, summary, updated_by_email) values ($1, $2, $3)
     on conflict (contact_id) do update set summary = excluded.summary, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [contact.id, summary, tx.actor.email],
  );
  await tx.query("delete from crm_account_plan_goals where contact_id = $1", [contact.id]);
  for (const [index, goal] of goals.entries()) {
    await tx.query("insert into crm_account_plan_goals (contact_id, position, title, target_date, status) values ($1, $2, $3, $4, $5)", [
      contact.id,
      index + 1,
      goal.title,
      goal.targetDate,
      goal.status,
    ]);
  }
  await tx.query("delete from crm_account_plan_people where contact_id = $1", [contact.id]);
  for (const role of roles) {
    await tx.query("insert into crm_account_plan_people (person_id, contact_id, role, note) values ($1, $2, $3, $4)", [role.personId, contact.id, role.role, role.note]);
  }
  await writeAuditEvent(tx, { eventType: "crm.account_plan_saved", entityType: "contact", entityId: contact.id, details: { summary, goals, people: roles } });
  return getAccountPlan(tx, contact.id, scope);
}

/**
 * Sets a deal's renewal date, and its products' (decision 654), by line
 * number. Any deal that isn't lost, since renewals mostly follow a win; CRM
 * only, nothing changes in the books. Who can change the deal can set them.
 */
export async function setRenewals(
  tx: OrgTx,
  opportunityIdInput: unknown,
  input: { renewalDate?: unknown; lines?: unknown },
  scope?: CrmScope,
): Promise<{ renewalDate: string | null; lines: Array<{ lineOrder: number; renewalDate: string | null }> }> {
  await requireCrm(tx);
  const deal = await getOpportunity(tx, opportunityIdInput, scope);
  assertSeesOwner(scope, deal.ownerUserId, "Opportunity");
  if (deal.stageType === "lost") throw new ConflictError("This deal was lost, so it doesn't renew.");
  const renewalDate = input.renewalDate === undefined ? deal.renewalDate : parseOptionalIsoDate(input.renewalDate === "" ? null : input.renewalDate, "renewal date");
  await tx.query("update crm_opportunities set renewal_date = $2, updated_at = now() where id = $1", [deal.id, renewalDate]);
  const existing = new Set(
    (await tx.query<{ line_order: number }>("select line_order from crm_opportunity_lines where opportunity_id = $1", [deal.id])).rows.map((row) => row.line_order),
  );
  const lines = requireArray(input.lines ?? [], "lines", 100).map((entry, index) => {
    const line = (entry ?? {}) as Record<string, unknown>;
    const lineOrder = Number(line.lineOrder);
    if (!existing.has(lineOrder)) throw new ValidationError(`Line ${index + 1} isn't one of this deal's products.`);
    return { lineOrder, renewalDate: parseOptionalIsoDate(line.renewalDate === "" ? null : line.renewalDate, `line ${lineOrder} renewal date`) };
  });
  for (const line of lines) {
    await tx.query("update crm_opportunity_lines set renewal_date = $3 where opportunity_id = $1 and line_order = $2", [deal.id, line.lineOrder, line.renewalDate]);
  }
  await writeAuditEvent(tx, {
    eventType: "crm.opportunity_renewals_set",
    entityType: "crm_opportunity",
    entityId: deal.id,
    details: { renewalDate, lines },
  });
  const now = await tx.query<{ line_order: number; renewal_date: string | null }>(
    "select line_order, renewal_date::text from crm_opportunity_lines where opportunity_id = $1 order by line_order",
    [deal.id],
  );
  return { renewalDate, lines: now.rows.map((row) => ({ lineOrder: row.line_order, renewalDate: row.renewal_date })) };
}

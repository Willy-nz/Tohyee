import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { crmAllows } from "@/lib/auth/roles";
import type { CrmScope } from "@/lib/crm/access";
import { requireCrm } from "@/lib/crm/switch";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import {
  checkReassignAllowed,
  kindsFor,
  REASSIGN_KINDS,
  REASSIGN_LIMIT,
  type ReassignItem,
  type ReassignKind,
  type ReassignmentEntry,
  type ReassignPreview,
  type ReassignResult,
} from "@/lib/crm/reassign-rules";
import { listMembers } from "@/lib/organisations/members";
import { optionalBoolean, requireArray, requireString } from "@/lib/validation";

/**
 * Bulk reassignment (decision 650, #216 stage 1's last item; #360 item 17),
 * after Salesforce's Mass Transfer Records and HubSpot's bulk "Assign":
 * choose whose records to move and who gets them, see every record that will
 * move, untick any to keep, then move them in one go. Xero has no CRM, so
 * Salesforce and HubSpot are the reference.
 *
 *  - What moves: leads that aren't converted (a converted lead doesn't
 *    change, decision 492), companies they own, open deals (closed ones only
 *    when asked, since that changes who past wins count for), tasks that
 *    aren't done, and the active sequences whose step tasks go to them.
 *    People have no owner (everyone sees them, decision 491), so nothing of
 *    theirs moves except their open tasks and sequences.
 *  - From "nobody": unassigned leads, deals and tasks can be given out too.
 *  - Who: admins, owners and bookkeepers move anyone's; a sales manager moves
 *    only between people in their teams (and unassigned leads, which they
 *    see); a sales rep can't (decision 491: a rep can't give records away).
 *  - The person getting them must be able to use the CRM.
 *  - Every record moved gets its own history entry, and the move as a whole
 *    one more (who, from, to, how many), shown on the page afterwards.
 *    Moving the same list again finds nothing left to move.
 */

type Selection = { from: string | null; to: string; kinds: ReassignKind[]; includeClosedDeals: boolean };

const ENTITY: Record<ReassignKind, string> = {
  leads: "crm_lead",
  companies: "contact",
  opportunities: "crm_opportunity",
  tasks: "crm_task",
  sequences: "crm_sequence_enrolment",
};

function emptyCounts(): Record<ReassignKind, number> {
  return { leads: 0, companies: 0, opportunities: 0, tasks: 0, sequences: 0 };
}

async function selection(tx: OrgTx, input: Record<string, unknown>, scope: CrmScope): Promise<Selection> {
  const fromRaw = requireString(input.fromUserId, "fromUserId", { maxLength: 100 });
  const from = fromRaw === "none" ? null : fromRaw;
  const to = requireString(input.toUserId, "toUserId", { maxLength: 100 });
  const kindsRaw = input.kinds === undefined ? [...REASSIGN_KINDS] : requireArray(input.kinds, "kinds", REASSIGN_KINDS.length);
  const kinds = [...new Set(kindsRaw.map((kind) => {
    if (typeof kind !== "string" || !(REASSIGN_KINDS as readonly string[]).includes(kind)) throw new ValidationError(`kinds must be among ${REASSIGN_KINDS.join(", ")}.`);
    return kind as ReassignKind;
  }))];
  if (kinds.length === 0) throw new ValidationError("Choose at least one kind of record to move.");
  checkReassignAllowed(scope, from, to);
  const members = await listMembers(tx.organisationId);
  const target = members.find((member) => member.userId === to);
  if (!target) throw new ValidationError("The person to move them to must be a member of the organisation.");
  if (!target.isActive) throw new ValidationError(`${target.displayName} can't sign in, so they can't be given records.`);
  if (!crmAllows(target.role, "read")) throw new ValidationError(`${target.displayName} can't use the CRM, so they can't be given records.`);
  // `from` needn't still be a member: records of someone who has left are what most often need moving.
  return { from, to, kinds: kindsFor(from, kinds, scope), includeClosedDeals: optionalBoolean(input.includeClosedDeals, "includeClosedDeals") ?? false };
}

const LEAD_NAME = "coalesce(nullif(concat_ws(' ', l.first_name, l.last_name), ''), l.company_name, l.email, 'Lead')";
const PERSON_NAME = "nullif(concat_ws(' ', p.first_name, p.last_name), '')";

/** The records of one kind that would move, as `id, name, detail`, with ids limited to `ids` when given. */
function candidatesSql(kind: ReassignKind, sel: Selection, params: unknown[], ids: string[] | null): string {
  params.push(sel.from);
  const owner = `$${params.length}::text`;
  let only = "";
  if (ids) {
    params.push(ids);
    only = ` and x.id = any($${params.length}::bigint[])`;
  }
  const limit = ` limit ${REASSIGN_LIMIT + 1}`;
  switch (kind) {
    case "leads":
      return `select x.id::text, ${LEAD_NAME.replaceAll("l.", "x.")} as name,
                     case x.status when 'new' then 'New' when 'working' then 'Working' else 'Unqualified' end
                       || case when x.needs_review then ' · to review' else '' end as detail
                from crm_leads x where x.status <> 'converted' and x.owner_user_id is not distinct from ${owner}${only}
               order by x.id${limit}`;
    case "companies":
      return `select x.id::text, x.name, case when x.is_customer then 'Customer' when x.is_prospect then 'Prospect' else null end as detail
                from contacts x where not x.is_archived and x.owner_user_id is not distinct from ${owner}${only}
               order by lower(x.name), x.id${limit}`;
    case "opportunities":
      return `select x.id::text, x.name, concat_ws(' · ', coalesce(s.name, x.stage), c.name, x.currency_code || ' ' || to_char(x.amount, 'FM999,999,999,999,990.00')) as detail
                from crm_opportunities x
                left join crm_opportunity_stages s on s.key = x.stage
                left join contacts c on c.id = x.contact_id
               where x.owner_user_id is not distinct from ${owner}${sel.includeClosedDeals ? "" : " and coalesce(s.stage_type, 'open') = 'open'"}${only}
               order by x.id${limit}`;
    case "tasks":
      return `select x.id::text, x.title as name, concat_ws(' · ', case when x.due_date is null then null else 'due ' || x.due_date::text end,
                     case x.status when 'todo' then 'To do' else 'In progress' end) as detail
                from crm_tasks x where x.status <> 'done' and x.assignee_user_id is not distinct from ${owner}${only}
               order by x.due_date nulls last, x.id${limit}`;
    case "sequences":
      return `select x.id::text, q.name as name,
                     coalesce((select ${LEAD_NAME} from crm_leads l where l.id = x.lead_id),
                              (select ${PERSON_NAME} from crm_people p where p.id = x.person_id),
                              (select o.name from crm_opportunities o where o.id = x.opportunity_id)) as detail
                from crm_sequence_enrolments x join crm_sequences q on q.id = x.sequence_id
               where x.status = 'active' and x.assignee_user_id is not distinct from ${owner}${only}
               order by x.id${limit}`;
  }
}

/** Every record that would move (decision 650), so the person can see them before anything changes. */
export async function previewReassignment(tx: OrgTx, input: Record<string, unknown>, scope: CrmScope): Promise<ReassignPreview> {
  await requireCrm(tx);
  const sel = await selection(tx, input, scope);
  const records: Record<ReassignKind, ReassignItem[]> = { leads: [], companies: [], opportunities: [], tasks: [], sequences: [] };
  const more: ReassignKind[] = [];
  for (const kind of sel.kinds) {
    const params: unknown[] = [];
    const rows = (await tx.query<ReassignItem>(candidatesSql(kind, sel, params, null), params)).rows;
    if (rows.length > REASSIGN_LIMIT) more.push(kind);
    records[kind] = rows.slice(0, REASSIGN_LIMIT).map((row) => ({ id: row.id, name: row.name, detail: row.detail }));
  }
  return { fromUserId: sel.from, toUserId: sel.to, includeClosedDeals: sel.includeClosedDeals, records, more };
}

const UPDATE: Record<ReassignKind, { table: string; column: string; touch: string }> = {
  leads: { table: "crm_leads", column: "owner_user_id", touch: ", updated_at = now()" },
  companies: { table: "contacts", column: "owner_user_id", touch: ", updated_at = now()" },
  opportunities: { table: "crm_opportunities", column: "owner_user_id", touch: ", updated_at = now()" },
  tasks: { table: "crm_tasks", column: "assignee_user_id", touch: ", updated_at = now()" },
  sequences: { table: "crm_sequence_enrolments", column: "assignee_user_id", touch: "" },
};

function idsOf(input: unknown, kind: ReassignKind): string[] | null {
  if (input === undefined || input === null) return null;
  const record = input as Record<string, unknown>;
  if (record[kind] === undefined) return null;
  return requireArray(record[kind], `ids.${kind}`, REASSIGN_LIMIT).map((id, index) => {
    const value = String(id);
    if (!/^[1-9][0-9]{0,17}$/.test(value)) throw new ValidationError(`ids.${kind}[${index}] must be a record id.`);
    return value;
  });
}

/**
 * Moves the records ticked in the preview (`ids` per kind; a kind left out of
 * `ids` isn't moved). Each is checked again as it's moved: one that has
 * changed hands since the preview, been converted, closed or done is left
 * alone and counted as skipped.
 */
export async function applyReassignment(tx: OrgTx, input: Record<string, unknown>, scope: CrmScope): Promise<ReassignResult> {
  await requireCrm(tx);
  const sel = await selection(tx, input, scope);
  const batchId = randomUUID();
  const moved = emptyCounts();
  let skipped = 0;
  for (const kind of sel.kinds) {
    const ids = idsOf(input.ids, kind);
    if (!ids || ids.length === 0) continue;
    const params: unknown[] = [];
    const still = (await tx.query<{ id: string }>(candidatesSql(kind, sel, params, ids), params)).rows.map((row) => row.id);
    skipped += ids.length - still.length;
    if (still.length === 0) continue;
    const { table, column, touch } = UPDATE[kind];
    const updated = await tx.query<{ id: string }>(
      `update ${table} set ${column} = $2${touch}
        where id = any($1::bigint[]) and ${column} is not distinct from $3::text returning id::text`,
      [still, sel.to, sel.from],
    );
    skipped += still.length - updated.rows.length;
    moved[kind] = updated.rows.length;
    for (const row of updated.rows) {
      await writeAuditEvent(tx, {
        eventType: "crm.reassigned",
        entityType: ENTITY[kind],
        entityId: row.id,
        details: { fromUserId: sel.from, toUserId: sel.to, batchId },
      });
    }
  }
  const total = Object.values(moved).reduce((sum, n) => sum + n, 0);
  if (total > 0) {
    await writeAuditEvent(tx, {
      eventType: "crm.records_reassigned",
      entityType: "crm_reassignment",
      entityId: batchId,
      details: { fromUserId: sel.from, toUserId: sel.to, includeClosedDeals: sel.includeClosedDeals, moved, skipped },
    });
  }
  return { batchId, moved, skipped };
}

/** The last 20 moves this person can see: everyone's for admins and bookkeepers, their teams' for a sales manager. */
export async function listReassignments(tx: OrgTx, scope: CrmScope): Promise<ReassignmentEntry[]> {
  await requireCrm(tx);
  if (scope.role === "sales_rep") return [];
  const params: unknown[] = [];
  let visible = "true";
  if (scope.owners !== null) {
    params.push(scope.owners);
    visible = `(details->>'toUserId') = any($1::text[]) and ((details->>'fromUserId') is null or (details->>'fromUserId') = any($1::text[]))`;
  }
  const rows = await tx.query<{ entity_id: string; created_at: string; actor_email: string | null; actor_user_id: string | null; details: Record<string, unknown> }>(
    `select entity_id, created_at::text, actor_email, actor_user_id::text, details from audit_events
      where event_type = 'crm.records_reassigned' and entity_type = 'crm_reassignment' and ${visible}
      order by audit_events.id desc limit 20`,
    params,
  );
  return rows.rows.map((row) => {
    const counts = emptyCounts();
    const moved = (row.details.moved ?? {}) as Record<string, unknown>;
    for (const kind of REASSIGN_KINDS) counts[kind] = Number(moved[kind] ?? 0);
    return {
      batchId: row.entity_id,
      at: new Date(row.created_at).toISOString(),
      byEmail: row.actor_email,
      byUserId: row.actor_user_id,
      fromUserId: typeof row.details.fromUserId === "string" ? row.details.fromUserId : null,
      toUserId: String(row.details.toUserId ?? ""),
      moved: counts,
    };
  });
}

export type ReassignOptions = {
  /** Whether this person may move records at all (not reps, not viewers). */
  allowed: boolean;
  /** The people records can move between: everyone for admins and bookkeepers, a manager's teams for a manager. */
  people: Array<{ userId: string; displayName: string; canReceive: boolean }>;
  /** Owners and assignees who are no longer members, so their records can be moved on. Hidden from sales managers. */
  formerOwners: string[];
};

/** Who records can be moved from and to, for the page's choices (decision 650). */
export async function reassignOptions(tx: OrgTx, scope: CrmScope): Promise<ReassignOptions> {
  await requireCrm(tx);
  const allowed = scope.canWrite && scope.role !== "sales_rep";
  if (!allowed) return { allowed, people: [], formerOwners: [] };
  const members = await listMembers(tx.organisationId);
  const people = members
    .filter((member) => scope.owners === null || scope.owners.includes(member.userId))
    .map((member) => ({ userId: member.userId, displayName: member.displayName, canReceive: member.isActive && crmAllows(member.role, "read") }));
  let formerOwners: string[] = [];
  if (scope.owners === null) {
    const owners = await tx.query<{ owner: string }>(
      `select owner from (
         select owner_user_id as owner from crm_leads where status <> 'converted'
         union select owner_user_id from contacts where not is_archived
         union select owner_user_id from crm_opportunities
         union select assignee_user_id from crm_tasks where status <> 'done'
         union select assignee_user_id from crm_sequence_enrolments where status = 'active'
       ) o where owner is not null order by owner`,
    );
    const current = new Set(members.map((member) => member.userId));
    formerOwners = owners.rows.map((row) => row.owner).filter((owner) => !current.has(owner));
  }
  return { allowed, people, formerOwners };
}

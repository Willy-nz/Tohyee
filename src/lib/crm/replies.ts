import { createTask } from "@/lib/crm/service";
import { isoDateAt, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { listMembers } from "@/lib/organisations/members";
import { crmAllows } from "@/lib/auth/roles";

/**
 * Replies (decision 651, #216; #360 item 17: lead/reply handling). When a
 * lead or person emails back after a sales email went to them from Tohyee
 * (in the 30 days before) or while they're in a sequence, their owner gets
 * one follow-up task: "Reply from …", due today. Their sequences stop on
 * the same check (decision 497) and campaign memberships become "responded"
 * (decision 498), as before.
 *
 * A reply is an email received from their address, synced from a member's
 * mailbox (leads too, since decision 651), or for a lead an email into a
 * lead mailbox (decision 493). Xero has nothing like it; HubSpot and
 * Salesforce both unenrol on a reply and tell the owner, so the owner gets a
 * task here, since reminders stay in Tohyee (decision 495).
 *
 *  - Once per touch: further replies before the next sales email or
 *    sequence don't make more tasks (a thread going back and forth isn't
 *    a new reply each time).
 *  - Only replies synced since this version, and received in the last 7
 *    days, so upgrading or connecting a mailbox doesn't make a pile of old
 *    tasks.
 *  - Each reply is handled once (a unique row made with its task), so a
 *    check that runs twice never makes a second task.
 *  - The subject shows in the task only where the mailbox lets the team see
 *    subjects, or the task is for the mailbox's own member.
 */

const REPLY_DAYS = 7;
const TOUCH_DAYS = 30;

type Candidate = {
  reply_key: string;
  message_id: string | null;
  activity_id: string | null;
  lead_id: string | null;
  person_id: string | null;
  replied_at: string;
  subject: string | null;
  hidden_from: string | null;
  sender: string;
};

type Touch = { at: string; kind: "email" | "sequence"; label: string; assignee: string | null; opportunityId: string | null };

const CANDIDATES = `
  with started as (select started_at from crm_reply_handling where id)
  select * from (
    select 'm:' || m.id || ':l' || l.lead_id as reply_key, m.id::text as message_id, null::text as activity_id,
           l.lead_id::text as lead_id, null::text as person_id, m.sent_at as replied_at, m.subject,
           case when a.visibility = 'metadata' then a.user_id::text end as hidden_from,
           coalesce(nullif(concat_ws(' ', x.first_name, x.last_name), ''), x.company_name, x.email) as sender
      from crm_messages m
      join crm_connected_accounts a on a.id = m.account_id
      join crm_participant_links l on l.message_id = m.id and l.lead_id is not null
      join crm_leads x on x.id = l.lead_id and lower(x.email) = lower(m.from_email)
     where m.direction = 'received' and m.created_at >= (select started_at from started)
       and m.sent_at > now() - interval '${REPLY_DAYS} days'
    union all
    select 'm:' || m.id || ':p' || l.person_id, m.id::text, null::text,
           null::text, l.person_id::text, m.sent_at, m.subject,
           case when a.visibility = 'metadata' then a.user_id::text end,
           coalesce(nullif(concat_ws(' ', p.first_name, p.last_name), ''), p.email)
      from crm_messages m
      join crm_connected_accounts a on a.id = m.account_id
      join crm_participant_links l on l.message_id = m.id and l.person_id is not null
      join crm_people p on p.id = l.person_id and lower(p.email) = lower(m.from_email)
     where m.direction = 'received' and m.created_at >= (select started_at from started)
       and m.sent_at > now() - interval '${REPLY_DAYS} days'
    union all
    select 'a:' || n.id, null::text, n.id::text,
           n.lead_id::text, null::text, n.created_at, regexp_replace(n.subject, '^Email: ', ''), null::text,
           coalesce(nullif(concat_ws(' ', x.first_name, x.last_name), ''), x.company_name, x.email)
      from crm_activities n join crm_leads x on x.id = n.lead_id
     where n.created_by_email = 'lead-mailbox@tohyee' and n.created_at >= (select started_at from started)
       and n.created_at > now() - interval '${REPLY_DAYS} days'
  ) c
  where not exists (select 1 from crm_reply_follow_ups f where f.reply_key = c.reply_key)
  order by c.replied_at, c.reply_key`;

/** The latest sales email or sequence that the reply answers, if any. */
async function touchFor(tx: OrgTx, candidate: Candidate): Promise<Touch | null> {
  const target = candidate.lead_id ? { column: "lead_id", id: candidate.lead_id } : { column: "person_id", id: candidate.person_id! };
  const email = await tx.query<{ at: string; subject: string; sent_by_user_id: string; opportunity_id: string | null }>(
    `select e.sent_at::text as at, e.subject, e.sent_by_user_id, e.opportunity_id::text
       from crm_sent_emails e
      where e.status = 'sent' and e.${target.column} = $1
        and e.sent_at < $2::timestamptz and e.sent_at > $2::timestamptz - interval '${TOUCH_DAYS} days'
      order by e.sent_at desc limit 1`,
    [target.id, candidate.replied_at],
  );
  // Sequences they're in themselves, or (for a person) a deal they're the point of contact for.
  const sequence = await tx.query<{ at: string; name: string; assignee_user_id: string | null; opportunity_id: string | null; owner: string | null }>(
    `select e.enrolled_at::text as at, s.name, e.assignee_user_id, e.opportunity_id::text, o.owner_user_id as owner
       from crm_sequence_enrolments e
       join crm_sequences s on s.id = e.sequence_id
       left join crm_opportunities o on o.id = e.opportunity_id
      where (e.${target.column} = $1 ${candidate.person_id ? "or o.point_of_contact_id = $1" : ""})
        and e.enrolled_at < $2::timestamptz and (e.status = 'active' or e.ended_at >= $2::timestamptz)
      order by e.enrolled_at desc limit 1`,
    [target.id, candidate.replied_at],
  );
  const touches: Touch[] = [];
  const sent = email.rows[0];
  if (sent) touches.push({ at: sent.at, kind: "email", label: sent.subject, assignee: sent.sent_by_user_id, opportunityId: sent.opportunity_id });
  const enrolment = sequence.rows[0];
  if (enrolment) {
    touches.push({ at: enrolment.at, kind: "sequence", label: enrolment.name, assignee: enrolment.owner ?? enrolment.assignee_user_id, opportunityId: enrolment.opportunity_id });
  }
  touches.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return touches[0] ?? null;
}

/** The task's words (pure, for tests). */
export function replyTaskText(input: { sender: string; subject: string | null; repliedOn: string; touch: Pick<Touch, "kind" | "label"> }): { title: string; body: string } {
  const base = `Reply from ${input.sender}${input.subject ? `: ${input.subject}` : ""}`;
  const answered =
    input.touch.kind === "sequence"
      ? `while in the sequence "${input.touch.label}", which stops now`
      : `to the email "${input.touch.label}"`;
  return {
    title: base.length > 200 ? `${base.slice(0, 199)}…` : base,
    body: `They replied on ${input.repliedOn} ${answered}. Read it in your mailbox and reply from there, or log a call.`,
  };
}

/** Makes the follow-up tasks for new replies (after each mail sync, and with the follow-up rules every 15 minutes). */
export async function noticeReplies(tx: OrgTx, today = todayIsoDate()): Promise<{ tasksCreated: number }> {
  // One check at a time per organisation, with the follow-up rules and sequences.
  await tx.query("select pg_advisory_xact_lock(hashtext('crm_follow_up_rules'))");
  const candidates = (await tx.query<Candidate>(CANDIDATES)).rows;
  if (candidates.length === 0) return { tasksCreated: 0 };
  const members = new Map((await listMembers(tx.organisationId)).map((member) => [member.userId, member]));
  const usable = (id: string | null) => {
    const member = id ? members.get(id) : undefined;
    return member && member.isActive && crmAllows(member.role, "read") ? member.userId : null;
  };
  let tasksCreated = 0;
  for (const candidate of candidates) {
    const touch = await touchFor(tx, candidate);
    if (!touch) continue; // Not a reply to anything Tohyee sent; looked at again until it's too old.
    const target = candidate.lead_id ? { column: "lead_id", id: candidate.lead_id } : { column: "person_id", id: candidate.person_id! };
    const earlier = await tx.query(
      `select 1 from crm_reply_follow_ups where ${target.column} = $1 and outcome = 'task_created' and replied_at >= $2::timestamptz limit 1`,
      [target.id, touch.at],
    );
    const record = async (outcome: "task_created" | "skipped", taskId: string | null, detail: string | null) =>
      tx.query(
        `insert into crm_reply_follow_ups (reply_key, message_id, activity_id, lead_id, person_id, replied_at, task_id, outcome, detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (reply_key) do nothing returning id`,
        [candidate.reply_key, candidate.message_id, candidate.activity_id, candidate.lead_id, candidate.person_id, candidate.replied_at, taskId, outcome, detail],
      );
    if ((earlier.rowCount ?? 0) > 0) {
      await record("skipped", null, "Already followed up since the last email or sequence.");
      continue;
    }
    // Claimed first, so two checks at once can't both make the task.
    const claimed = await record("task_created", null, null);
    if ((claimed.rowCount ?? 0) === 0) continue;
    const lead = candidate.lead_id
      ? (await tx.query<{ owner_user_id: string | null }>("select owner_user_id from crm_leads where id = $1", [candidate.lead_id])).rows[0]
      : null;
    const assignee = usable(lead?.owner_user_id ?? null) ?? usable(touch.assignee);
    const showSubject = candidate.hidden_from === null || candidate.hidden_from === assignee;
    const text = replyTaskText({
      sender: candidate.sender,
      subject: showSubject ? candidate.subject : null,
      repliedOn: isoDateAt(new Date(candidate.replied_at)),
      touch,
    });
    const person = candidate.person_id
      ? (await tx.query<{ contact_id: string | null }>("select contact_id::text from crm_people where id = $1", [candidate.person_id])).rows[0]
      : null;
    const task = await createTask(tx, {
      title: text.title,
      body: text.body,
      dueDate: today,
      assigneeUserId: assignee,
      leadId: candidate.lead_id,
      personId: candidate.person_id,
      contactId: person?.contact_id ?? null,
      opportunityId: candidate.person_id ? touch.opportunityId : null,
    });
    await tx.query("update crm_reply_follow_ups set task_id = $2 where reply_key = $1", [candidate.reply_key, task.id]);
    tasksCreated += 1;
  }
  return { tasksCreated };
}

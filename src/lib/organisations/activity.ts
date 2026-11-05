import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { hasPayrollAccess } from "@/lib/payroll/access";

/*
 * "What they did" (decision 1472): one member's own actions in this
 * organisation, newest first, from its append-only audit trail and the
 * server's audit trail for this organisation (keys, AI apps, members). For
 * owners and admins, to check the work of someone they hired. Only what was
 * done and when: no details, so nothing private (amounts, pay, mail) shows
 * here that the admin couldn't see elsewhere. Private mail events (decision
 * 571) are left out, and payroll events unless the admin has payroll access.
 */

export type ActivityEntry = { at: string; what: string; via: string | null; where: "books" | "server" };

export type MemberActivity = {
  member: { userId: string; displayName: string; email: string };
  entries: ActivityEntry[];
  /** Pass as `before` for older entries; null when there are none. */
  before: string | null;
};

export const ACTIVITY_PAGE = 100;

/** "invoice.approved" -> "Invoice approved"; "organisation.member_access_set" -> "Member access set". */
export function describeEvent(eventType: string): string {
  const parts = eventType.split(".");
  const tail = parts.length > 1 && parts[0] === "organisation" ? parts.slice(1) : parts;
  const text = tail.join(" ").replace(/_/g, " ").trim();
  if (!text) return eventType;
  return (text.charAt(0).toUpperCase() + text.slice(1)).replace(/\bai\b/gi, "AI").replace(/\bgst\b/gi, "GST");
}

const PRIVATE_ENTITY_TYPES = ["private_mail_copy", "farm_mail_account", "private_mail_message", "private_mail_account"];

export async function memberActivity(tx: OrgTx, userIdInput: unknown, beforeInput: unknown): Promise<MemberActivity> {
  const userId = typeof userIdInput === "string" ? userIdInput : "";
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new NotFoundError("Member not found.");
  let before: string | null = null;
  if (beforeInput != null && beforeInput !== "") {
    if (typeof beforeInput !== "string" || Number.isNaN(Date.parse(beforeInput))) throw new ValidationError("before must be a date and time.");
    before = new Date(beforeInput).toISOString();
  }
  // Members stay listed when their access ends (decision 1472), so their history stays here too.
  const found = await coreQuery<{ display_name: string; email: string }>(
    "select u.display_name, u.email from organisation_members m join users u on u.id = m.user_id where m.organisation_id = $1 and m.user_id = $2",
    [tx.organisationId, userId],
  );
  const person = found.rows[0];
  if (!person) throw new NotFoundError("Member not found.");
  const payroll = await hasPayrollAccess(tx);
  const books = await tx.query<{ created_at: string; event_type: string; via: string | null }>(
    `select created_at, event_type, details->>'via' as via
       from audit_events
      where actor_user_id = $1
        and ($2::timestamptz is null or created_at < $2::timestamptz)
        and not (entity_type = any($3::text[]) or event_type like 'private_mail.%' or event_type like 'farming.mail%')
        and ($4 or (event_type not like 'payroll.%' and entity_type not like 'payroll%'))
      order by audit_events.created_at desc, audit_events.id desc
      limit $5`,
    [userId, before, PRIVATE_ENTITY_TYPES, payroll, ACTIVITY_PAGE],
  );
  const server = await coreQuery<{ created_at: string; event_type: string }>(
    `select created_at, event_type from admin_audit_events
      where entity_type = 'organisation' and entity_id = $1 and actor_user_id = $2
        and ($3::timestamptz is null or created_at < $3::timestamptz)
      order by admin_audit_events.created_at desc, admin_audit_events.id desc
      limit $4`,
    [tx.organisationId, userId, before, ACTIVITY_PAGE],
  );
  const entries: ActivityEntry[] = [
    ...books.rows.map((row) => ({ at: row.created_at, what: describeEvent(row.event_type), via: row.via, where: "books" as const })),
    ...server.rows.map((row) => ({ at: row.created_at, what: describeEvent(row.event_type), via: null, where: "server" as const })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, ACTIVITY_PAGE);
  const more = books.rows.length === ACTIVITY_PAGE || server.rows.length === ACTIVITY_PAGE || entries.length === ACTIVITY_PAGE;
  return {
    member: { userId, displayName: person.display_name, email: person.email },
    entries,
    before: more && entries.length > 0 ? entries[entries.length - 1].at : null,
  };
}

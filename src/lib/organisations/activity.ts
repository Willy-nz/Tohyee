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

export type ActivityEntry = {
  /** "books-12" or "server-34": unique on the list, for React keys. */
  key: string;
  at: string;
  what: string;
  via: string | null;
  where: "books" | "server";
};

export type MemberActivity = {
  member: { userId: string; displayName: string; email: string };
  entries: ActivityEntry[];
  /** Pass back as `before` for older entries (a cursor, not a date); null when there are none. */
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

/*
 * Paging (#609; decisions 1510-1511). The list is in one fixed order: time
 * (to the microsecond, as Postgres keeps it), newest first; then books
 * before server events at the same instant; then the higher event id first.
 * The cursor is the last entry's place in that order (time, stream, id), so
 * events sharing a time, in one stream or across both, are each returned
 * once. A plain time would skip the rest of a batch written at one instant.
 */

type Stream = "books" | "server";
const STREAM_RANK: Record<Stream, number> = { books: 0, server: 1 };
type Cursor = { at: string; stream: Stream; id: string };

/** Microseconds kept: JavaScript dates stop at milliseconds. */
const AT_TEXT = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeActivityCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.stream}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeActivityCursor(input: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input)) return null;
  const [at, stream, id, extra] = Buffer.from(input, "base64url").toString("utf8").split("|");
  if (extra !== undefined || !at || !CURSOR_AT.test(at) || Number.isNaN(Date.parse(at))) return null;
  if (stream !== "books" && stream !== "server") return null;
  if (!id || !/^[1-9]\d{0,18}$/.test(id)) return null;
  return { at, stream, id };
}

/** Whether `a` comes before `b` in the list's order (newer first). */
export function compareActivity(a: Cursor, b: Cursor): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.stream !== b.stream) return STREAM_RANK[a.stream] - STREAM_RANK[b.stream];
  const left = BigInt(a.id);
  const right = BigInt(b.id);
  return left === right ? 0 : left < right ? 1 : -1;
}

/**
 * SQL that's true for rows after the cursor ($at, $rank, $id) in one
 * stream: older, or at the same instant and after it (a later stream, or
 * the same stream and a lower id).
 */
function afterCursorSql(table: string, rank: number, at: number, cursorRank: number, id: number): string {
  return `($${at}::timestamptz is null
          or ${table}.created_at < $${at}::timestamptz
          or (${table}.created_at = $${at}::timestamptz and (${rank} > $${cursorRank}::int or (${rank} = $${cursorRank}::int and ${table}.id < $${id}::bigint))))`;
}

export async function memberActivity(tx: OrgTx, userIdInput: unknown, beforeInput: unknown): Promise<MemberActivity> {
  const userId = typeof userIdInput === "string" ? userIdInput : "";
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new NotFoundError("Member not found.");
  let cursor: Cursor | null = null;
  if (beforeInput != null && beforeInput !== "") {
    cursor = typeof beforeInput === "string" ? decodeActivityCursor(beforeInput) : null;
    if (!cursor) throw new ValidationError("That page of the list is out of date. Go back to Newest.");
  }
  // Members stay listed when their access ends (decision 1472), so their history stays here too.
  const found = await coreQuery<{ display_name: string; email: string }>(
    "select u.display_name, u.email from organisation_members m join users u on u.id = m.user_id where m.organisation_id = $1 and m.user_id = $2",
    [tx.organisationId, userId],
  );
  const person = found.rows[0];
  if (!person) throw new NotFoundError("Member not found.");
  const payroll = await hasPayrollAccess(tx);
  // One more than a page from each stream says whether there's another page.
  const fetch = ACTIVITY_PAGE + 1;
  const at = cursor?.at ?? null;
  const rank = cursor ? STREAM_RANK[cursor.stream] : null;
  const id = cursor?.id ?? null;
  const books = await tx.query<{ id: string; created_at: string; at_text: string; event_type: string; via: string | null }>(
    `select audit_events.id::text as id, created_at, ${AT_TEXT("audit_events.created_at")} as at_text, event_type, details->>'via' as via
       from audit_events
      where actor_user_id = $1
        and ${afterCursorSql("audit_events", STREAM_RANK.books, 2, 6, 7)}
        and not (entity_type = any($3::text[]) or event_type like 'private_mail.%' or event_type like 'farming.mail%')
        and ($4 or (event_type not like 'payroll.%' and entity_type not like 'payroll%'))
      order by audit_events.created_at desc, audit_events.id desc
      limit $5`,
    [userId, at, PRIVATE_ENTITY_TYPES, payroll, fetch, rank, id],
  );
  const server = await coreQuery<{ id: string; created_at: string; at_text: string; event_type: string }>(
    `select admin_audit_events.id::text as id, created_at, ${AT_TEXT("admin_audit_events.created_at")} as at_text, event_type
       from admin_audit_events
      where entity_type = 'organisation' and entity_id = $1 and actor_user_id = $2
        and ${afterCursorSql("admin_audit_events", STREAM_RANK.server, 3, 5, 6)}
      order by admin_audit_events.created_at desc, admin_audit_events.id desc
      limit $4`,
    [tx.organisationId, userId, at, fetch, rank, id],
  );
  const merged = [
    ...books.rows.map((row) => ({ place: { at: row.at_text, stream: "books" as const, id: row.id }, entry: { key: `books-${row.id}`, at: row.created_at, what: describeEvent(row.event_type), via: row.via, where: "books" as const } })),
    ...server.rows.map((row) => ({ place: { at: row.at_text, stream: "server" as const, id: row.id }, entry: { key: `server-${row.id}`, at: row.created_at, what: describeEvent(row.event_type), via: null, where: "server" as const } })),
  ].sort((a, b) => compareActivity(a.place, b.place));
  const page = merged.slice(0, ACTIVITY_PAGE);
  const last = page[page.length - 1];
  return {
    member: { userId, displayName: person.display_name, email: person.email },
    entries: page.map((item) => item.entry),
    before: merged.length > ACTIVITY_PAGE && last ? encodeActivityCursor(last.place) : null,
  };
}

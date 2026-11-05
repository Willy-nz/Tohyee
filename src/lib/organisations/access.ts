import { createHash } from "node:crypto";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { businessTimeZone } from "@/lib/dates";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { HttpError } from "@/lib/errors";
import {
  ACCESS_REMINDER_DAYS,
  accessRefusalMessage,
  accessState,
  formatEnd,
  formatMoment,
  startParts,
  untilParts,
} from "@/lib/organisations/access-window";
import { memberAccessCurrentSql } from "@/lib/organisations/registry";

/*
 * Time-limited access, the parts that read the core database (decisions
 * 1466-1474). The check itself is in getMembership (registry.ts): this file
 * explains a refusal, and finds whose access ends soon.
 */

type WindowRow = {
  access_starts_at: string | null;
  access_ends_at: string | null;
  display_name: string;
  ask_name: string | null;
};

/** Who a refused member should ask: the first owner who has access with no end. */
const ASK_NAME_SQL = `(select u2.display_name from organisation_members o2 join users u2 on u2.id = o2.user_id
                        where o2.organisation_id = o.id and o2.role = 'owner' and u2.is_active
                          and o2.access_ends_at is null and ${memberAccessCurrentSql("o2")}
                        order by o2.created_at, o2.user_id limit 1)`;

/**
 * Why a member can't use the organisation now, or null when that isn't the
 * reason (they aren't a member, or their access is current). Only for the
 * member themself: it names the organisation, which they already know.
 */
export async function accessRefusal(organisationId: string, userId: string, now = new Date()): Promise<HttpError | null> {
  const found = await coreQuery<WindowRow>(
    `select m.access_starts_at, m.access_ends_at, o.display_name, ${ASK_NAME_SQL} as ask_name
       from organisation_members m join organisations o on o.id = m.organisation_id
      where m.organisation_id = $1 and m.user_id = $2 and o.is_active and not ${memberAccessCurrentSql("m")}`,
    [organisationId, userId],
  );
  const row = found.rows[0];
  return row ? refusalFor(row, now) : null;
}

function refusalFor(row: WindowRow, now: Date): HttpError | null {
  const timeZone = businessTimeZone();
  const state = accessState({ startsAt: row.access_starts_at, endsAt: row.access_ends_at }, now);
  if (state === "ended" && row.access_ends_at) {
    return new HttpError(403, "access_ended", accessRefusalMessage("ended", row.display_name, untilParts(row.access_ends_at, timeZone), row.ask_name));
  }
  if (state === "not_started" && row.access_starts_at) {
    return new HttpError(403, "access_not_started", accessRefusalMessage("not_started", row.display_name, startParts(row.access_starts_at, timeZone), row.ask_name));
  }
  return null;
}

/** For the signed-in pages: each organisation the person can't use now because of its dates, and why. */
export async function accessMessagesForUser(userId: string, now = new Date()): Promise<string[]> {
  const found = await coreQuery<WindowRow>(
    `select m.access_starts_at, m.access_ends_at, o.display_name, ${ASK_NAME_SQL} as ask_name
       from organisation_members m join organisations o on o.id = m.organisation_id
      where m.user_id = $1 and o.is_active and not ${memberAccessCurrentSql("m")}
        -- Ended more than 90 days ago: no longer worth a notice on every page.
        and (m.access_ends_at is null or m.access_ends_at > now() - interval '90 days')
      order by o.display_name, o.id`,
    [userId],
  );
  return found.rows.map((row) => refusalFor(row, now)?.message).filter((message): message is string => Boolean(message));
}

export type EndingAccess = { userId: string; displayName: string; email: string; endsAt: string; until: string; endsWhen: string };

/** Members whose access ends within 3 days (decision 1471), soonest first. */
export async function membersWithAccessEnding(organisationId: string): Promise<EndingAccess[]> {
  const found = await coreQuery<{ user_id: string; display_name: string; email: string; access_ends_at: string }>(
    `select m.user_id::text, u.display_name, u.email, m.access_ends_at
       from organisation_members m join users u on u.id = m.user_id
      where m.organisation_id = $1 and u.is_active and ${memberAccessCurrentSql("m")}
        and m.access_ends_at is not null and m.access_ends_at <= now() + make_interval(days => $2)
      order by m.access_ends_at, u.display_name`,
    [organisationId, ACCESS_REMINDER_DAYS],
  );
  const timeZone = businessTimeZone();
  return found.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    endsAt: row.access_ends_at,
    until: formatMoment(untilParts(row.access_ends_at, timeZone)),
    endsWhen: formatEnd(untilParts(row.access_ends_at, timeZone)),
  }));
}

export type AccessNotice = { id: string; message: string; href: string };

/**
 * In-app notices (decision 1471): owners and admins see whose access ends
 * within 3 days; the member sees their own.
 */
export async function accessEndingNotices(tx: OrgTx, role: Role | null): Promise<AccessNotice[]> {
  const ending = await membersWithAccessEnding(tx.organisationId);
  const notices: AccessNotice[] = [];
  const own = ending.find((entry) => entry.userId === tx.actor.userId);
  if (own) notices.push({ id: "access-ending-you", message: `Your access ends at ${own.endsWhen}. Ask an owner if you need longer.`, href: "/operations" });
  if (role && roleAtLeast(role, "admin")) {
    for (const entry of ending.filter((item) => item.userId !== tx.actor.userId)) {
      notices.push({
        id: `access-ending-${entry.userId}`,
        message: `${entry.displayName}'s access ends at ${entry.endsWhen}. Extend it or let it end.`,
        href: "/operations/members?access=ending",
      });
    }
  }
  return notices;
}

/**
 * Queues the reminder emails (decision 1471) for members whose access ends
 * within 3 days: one to the member and one to each owner and admin with
 * access now. Once per person for each end time (a unique row), so an
 * Extend brings a new one before the new end. Nothing is queued when the
 * organisation's email isn't set up: the in-app notice still shows.
 * Returns how many were queued.
 */
export async function queueAccessReminders(tx: OrgTx, origin: string | null, organisationName: string): Promise<number> {
  const ending = await membersWithAccessEnding(tx.organisationId);
  if (ending.length === 0) return 0;
  const managers = await coreQuery<{ email: string; display_name: string; user_id: string }>(
    `select u.email, u.display_name, m.user_id::text from organisation_members m join users u on u.id = m.user_id
      where m.organisation_id = $1 and m.role in ('owner', 'admin') and u.is_active and ${memberAccessCurrentSql("m")}
      order by u.email`,
    [tx.organisationId],
  );
  const link = origin ? `${origin.replace(/\/+$/, "")}/operations/members?access=ending` : null;
  let queued = 0;
  for (const entry of ending) {
    const messages: Array<{ to: string; subject: string; body: string }> = [
      {
        to: entry.email,
        subject: `Your access to ${organisationName} ends soon`,
        body: [
          `Kia ora ${entry.displayName},`,
          "",
          `Your access to ${organisationName} in Tohyee ends at ${entry.endsWhen}.`,
          "If you need longer, ask an owner or admin to extend it.",
        ].join("\n"),
      },
      ...managers.rows
        .filter((manager) => manager.user_id !== entry.userId)
        .map((manager) => ({
          to: manager.email,
          subject: `${entry.displayName}'s access to ${organisationName} ends soon`,
          body: [
            `Kia ora ${manager.display_name},`,
            "",
            `${entry.displayName} (${entry.email}) has access to ${organisationName} until ${entry.endsWhen}.`,
            "To give them longer, or end it now, open People and roles in Tohyee.",
            ...(link ? ["", link] : []),
            "",
            "If you do nothing, their access ends then. Nothing they did is removed.",
          ].join("\n"),
        })),
    ];
    for (const message of messages) {
      const inserted = await tx.query(
        `insert into access_emails (member_user_id, access_ends_at, to_email, subject, body) values ($1, $2, $3, $4, $5)
         on conflict (member_user_id, access_ends_at, to_email) do nothing`,
        [entry.userId, entry.endsAt, message.to, message.subject.slice(0, 250), message.body.slice(0, 5000)],
      );
      queued += inserted.rowCount ?? 0;
    }
  }
  return queued;
}

/**
 * For the MCP endpoint (decision 1468): when a working AI key or AI app
 * token was refused only because its person's access dates have passed (or
 * not come), why. Null for anything else, which keeps its usual answer. Only
 * someone holding a real, unrevoked key gets this.
 */
export async function accessRefusalForAiToken(token: string): Promise<HttpError | null> {
  const hash = createHash("sha256").update(token).digest("hex");
  const found = await coreQuery<{ organisation_id: string; user_id: string }>(
    `select t.organisation_id, t.user_id::text
       from ai_access_tokens t join users u on u.id = t.user_id
      where t.revoked_at is null and u.is_active and t.organisation_id is not null
        and ((t.kind = 'key' and t.token_hash = $1)
             or (t.kind = 'connection' and t.id = (select connection_id from oauth_tokens where token_hash = $1 and kind = 'access' and expires_at > now())))
      limit 1`,
    [hash],
  );
  const row = found.rows[0];
  return row ? accessRefusal(row.organisation_id, row.user_id) : null;
}

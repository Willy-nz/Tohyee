import { type AdminActor, writeAdminAuditEvent } from "@/lib/audit";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Where someone is signed in (#208 item 1): each session's browser, address
 * and when it was last used, and signing one out (a lost phone) or all the
 * others. Server admins can sign anyone out everywhere. A session is shown by
 * the first 16 characters of its hash, never its token.
 */
export type SignedInSession = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  address: string | null;
  current: boolean;
};

const SHORT = 16;

export async function listSessions(userId: string, currentSessionId: string | null): Promise<SignedInSession[]> {
  const found = await coreQuery<{ id: string; created_at: string; last_seen_at: string; user_agent: string | null; ip_address: string | null }>(
    "select id, created_at, last_seen_at, user_agent, ip_address from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc",
    [userId],
  );
  return found.rows.map((row) => ({
    id: row.id.slice(0, SHORT),
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    userAgent: row.user_agent,
    address: row.ip_address,
    current: row.id === currentSessionId,
  }));
}

/** Signs out one of your own sessions, or (`id` "others") every one but this. Returns how many ended. */
export async function endOwnSessions(userId: string, currentSessionId: string, idInput: unknown): Promise<number> {
  if (idInput === "others") {
    const ended = await coreQuery("delete from sessions where user_id = $1 and id <> $2", [userId, currentSessionId]);
    return ended.rowCount ?? 0;
  }
  if (typeof idInput !== "string" || !/^[0-9a-f]{16}$/.test(idInput)) throw new ValidationError("Choose a session to sign out.");
  if (currentSessionId.startsWith(idInput)) throw new ValidationError("That's this session. Use Sign out instead.");
  const ended = await coreQuery("delete from sessions where user_id = $1 and left(id, 16) = $2", [userId, idInput]);
  if (!ended.rowCount) throw new NotFoundError("That session has already ended.");
  return ended.rowCount;
}

/** A server admin signs someone out everywhere (their phone was stolen, say). Their AI keys keep working; reset their password to stop those too. */
export async function signOutEverywhere(actor: AdminActor, userId: string): Promise<number> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new NotFoundError("User not found.");
  return withCoreTransaction(async (client) => {
    const user = await client.query("select 1 from users where id = $1", [userId]);
    if (!user.rowCount) throw new NotFoundError("User not found.");
    const ended = await client.query("delete from sessions where user_id = $1", [userId]);
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "user.signed_out_everywhere",
      entityType: "user",
      entityId: userId,
      details: { sessions: ended.rowCount ?? 0 },
    });
    return ended.rowCount ?? 0;
  });
}

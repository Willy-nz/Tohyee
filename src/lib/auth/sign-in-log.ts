import { writeAdminAuditEvent, type AdminActor } from "@/lib/audit";
import { cameThroughRemoteAccess } from "@/lib/auth/remote";
import { clientAddress } from "@/lib/auth/sessions";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { sendSecurityAlert } from "@/lib/email/mailer";
import { ForbiddenError, HttpError, TooManyRequestsError, UnauthorizedError } from "@/lib/errors";
import { readServerSetting, writeServerSetting } from "@/lib/server-settings";

/**
 * The sign-in monitor (#208 item 1, decision 487). Every sign-in attempt is
 * recorded: who, which step, how it went, the address (the one a proxy wrote,
 * clientAddress), the browser, and whether it came through remote access.
 * Suspicious ones are flagged and reported, never blocked (Jess): a new device
 * or address, several failures for one login, failures for many logins from
 * one address, a locked login, a backup code, an emailed two-step reset, and a
 * server admin signing in through remote access. Flags show in the server
 * app (Sign-ins, Home) and are emailed to the person and the server admins
 * when the server can send email. No country lookup (Jess). Kept for a year.
 */
export type SignInStep = "password" | "code" | "backup_code" | "setup_link" | "reset_link" | "first_admin";
export type SignInOutcome = "signed_in" | "password_ok" | "failed" | "locked" | "refused";

export type SignInEvent = {
  id: string;
  at: string;
  email: string;
  step: SignInStep;
  outcome: SignInOutcome;
  detail: string | null;
  address: string | null;
  userAgent: string | null;
  remote: boolean;
  flag: string | null;
};

const KEEP_DAYS = 365;
const WINDOW_MINUTES = 15;
const FAILURES_FOR_ONE_LOGIN = 3;
const LOGINS_FROM_ONE_ADDRESS = 5;

/** What a refused or failed attempt was, from the error the sign-in step threw. */
export function outcomeOf(error: unknown): { outcome: SignInOutcome; detail: string } | null {
  if (!(error instanceof HttpError)) return null;
  if (error instanceof TooManyRequestsError) {
    // The per-address brake isn't an attempt on a login.
    if (error.message.includes("from this address")) return null;
    return { outcome: "locked", detail: error.message };
  }
  if (error instanceof UnauthorizedError) return { outcome: "failed", detail: error.message };
  if (error instanceof ForbiddenError) return { outcome: "refused", detail: error.message };
  return null;
}

type Entry = { email: string | null | undefined; userId?: string | null; step: SignInStep; outcome: SignInOutcome; detail?: string | null };

/** Records an attempt and reports anything suspicious. Never throws: signing in doesn't wait on the log. */
export async function logSignIn(request: Request, entry: Entry): Promise<void> {
  try {
    await record(request, entry);
  } catch (error) {
    console.warn("[tohyee] Couldn't record a sign-in:", error instanceof Error ? error.message : error);
  }
}

async function record(request: Request, entry: Entry): Promise<void> {
  const email = (entry.email ?? "").trim().toLowerCase().slice(0, 254) || "(none)";
  const address = clientAddress(request.headers)?.slice(0, 100) ?? null;
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;
  const remote = cameThroughRemoteAccess(request.headers);
  let userId = entry.userId ?? null;
  let isServerAdmin = false;
  const user = (
    await coreQuery<{ id: string; is_server_admin: boolean }>(
      userId ? "select id::text, is_server_admin from users where id = $1" : "select id::text, is_server_admin from users where email = $1",
      [userId ?? email],
    )
  ).rows[0];
  if (user) {
    userId = user.id;
    isServerAdmin = user.is_server_admin;
  }

  const flags: string[] = [];
  let tellPerson = false;
  if (entry.outcome === "signed_in" && userId) {
    const seen = (
      await coreQuery<{ before: string; device: boolean; place: boolean }>(
        `select count(*)::text as before,
                coalesce(bool_or(user_agent is not distinct from $2), false) as device,
                coalesce(bool_or(address is not distinct from $3), false) as place
           from sign_in_events where user_id = $1 and outcome = 'signed_in'`,
        [userId, userAgent, address],
      )
    ).rows[0];
    if (Number(seen.before) > 0 && !seen.device) {
      flags.push("A new device or browser for this login");
      tellPerson = true;
    } else if (Number(seen.before) > 0 && !seen.place && remote) {
      flags.push("A new address for this login");
      tellPerson = true;
    }
    if (isServerAdmin && remote) flags.push("A server admin signed in through remote access");
  }
  if (entry.step === "backup_code" && entry.outcome === "signed_in") {
    flags.push("A backup code was used instead of the authenticator app");
    tellPerson = true;
  }
  if (entry.step === "reset_link" && entry.outcome === "password_ok") {
    flags.push("Two-step sign-in was reset with an emailed link");
    tellPerson = true;
  }
  if (entry.outcome === "locked") {
    flags.push("The login was locked after too many wrong tries");
    tellPerson = true;
  }
  if (entry.outcome === "failed") {
    const recent = (
      await coreQuery<{ failures: string; flagged: boolean }>(
        `select count(*) filter (where outcome = 'failed')::text as failures, coalesce(bool_or(flag is not null and flag like 'Several failed%'), false) as flagged
           from sign_in_events where email = $1 and at > now() - ($2::int * interval '1 minute')`,
        [email, WINDOW_MINUTES],
      )
    ).rows[0];
    const failures = Number(recent.failures) + 1;
    if (failures >= FAILURES_FOR_ONE_LOGIN && !recent.flagged) flags.push(`Several failed tries for this login (${failures} in ${WINDOW_MINUTES} minutes)`);
    if (address) {
      // Other logins that failed from this address lately, plus this one.
      const spread = (
        await coreQuery<{ others: string; flagged: boolean }>(
          `select count(distinct email) filter (where email <> $2)::text as others,
                  coalesce(bool_or(flag is not null and flag like 'Failed sign-ins for%'), false) as flagged
             from sign_in_events where address = $1 and outcome = 'failed' and at > now() - ($3::int * interval '1 minute')`,
          [address, email, WINDOW_MINUTES],
        )
      ).rows[0];
      const logins = Number(spread.others) + 1;
      if (logins >= LOGINS_FROM_ONE_ADDRESS && !spread.flagged) flags.push(`Failed sign-ins for ${logins} different logins from one address (someone guessing)`);
    }
  }
  const flag = flags.length ? flags.join("; ").slice(0, 300) : null;

  await coreQuery(
    `insert into sign_in_events (email, user_id, step, outcome, detail, address, user_agent, remote, flag)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [email, userId, entry.step, entry.outcome, entry.detail?.slice(0, 300) ?? null, address, userAgent, remote, flag],
  );
  await coreQuery("delete from sign_in_events where at < now() - ($1::int * interval '1 day')", [KEEP_DAYS]);

  if (flag) await report(email, user ? email : null, tellPerson, flag, { address, userAgent, remote });
}

async function report(email: string, person: string | null, tellPerson: boolean, flag: string, where: { address: string | null; userAgent: string | null; remote: boolean }) {
  const lines = [
    `Tohyee noticed a sign-in worth checking for ${email}: ${flag}.`,
    `From ${where.address ?? "an unknown address"}${where.remote ? " through remote access" : " on the local network"}, using ${where.userAgent ?? "an unknown browser"}.`,
    "It wasn't blocked. If it was expected, there's nothing to do.",
  ];
  if (person && tellPerson) await sendSecurityAlert(person, "a sign-in to check", lines);
  const admins = await coreQuery<{ email: string }>("select email from users where is_server_admin and is_active");
  for (const admin of admins.rows) {
    if (admin.email === person && tellPerson) continue;
    await sendSecurityAlert(admin.email, "a sign-in to check", [...lines, "", "See Sign-ins in the Tohyee server app."]);
  }
}

type Row = {
  id: string;
  at: string;
  email: string;
  step: SignInStep;
  outcome: SignInOutcome;
  detail: string | null;
  address: string | null;
  user_agent: string | null;
  remote: boolean;
  flag: string | null;
};

/** The log for server admins, newest first. */
export async function listSignIns(filter: { flaggedOnly?: boolean; remoteOnly?: boolean; email?: string | null; limit?: number } = {}): Promise<SignInEvent[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.flaggedOnly) conditions.push("flag is not null");
  if (filter.remoteOnly) conditions.push("remote");
  if (filter.email) {
    values.push(filter.email.trim().toLowerCase());
    conditions.push(`email = $${values.length}`);
  }
  values.push(Math.min(Math.max(filter.limit ?? 500, 1), 2000));
  const rows = await coreQuery<Row>(
    `select id::text, at, email, step, outcome, detail, address, user_agent, remote, flag from sign_in_events
      ${conditions.length ? `where ${conditions.join(" and ")}` : ""} order by sign_in_events.id desc limit $${values.length}`,
    values,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    at: new Date(row.at).toISOString(),
    email: row.email,
    step: row.step,
    outcome: row.outcome,
    detail: row.detail,
    address: row.address,
    userAgent: row.user_agent,
    remote: row.remote,
    flag: row.flag,
  }));
}

type Review = { reviewedAt?: string };

/** Flagged sign-ins since a server admin last looked (Home's Needs attention and the sidebar badge). */
export async function unseenFlags(): Promise<{ count: number; reviewedAt: string | null }> {
  const review = await readServerSetting<Review, Record<string, never>>("sign_in_review");
  const since = review.value.reviewedAt ?? null;
  const found = await coreQuery<{ count: string }>(
    "select count(*)::text as count from sign_in_events where flag is not null and ($1::timestamptz is null or at > $1::timestamptz)",
    [since],
  );
  return { count: Number(found.rows[0].count), reviewedAt: since };
}

/** "I've looked": flags up to now stop counting as new. */
export async function markSignInsSeen(actor: AdminActor): Promise<void> {
  await withCoreTransaction(async (client) => {
    await writeServerSetting<Review, Record<string, never>>(client, "sign_in_review", { reviewedAt: new Date().toISOString() }, {}, actor.email);
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, { eventType: "server.sign_ins_reviewed", entityType: "server_setting", entityId: "sign_in_review" });
  });
}

/**
 * Runs one sign-in step and records how it went: `success` says what a
 * successful result was; a refusal or failure is worked out from the error.
 */
export async function loggedSignIn<T>(
  request: Request,
  who: { email: string | null | undefined; userId?: string | null },
  step: SignInStep,
  work: () => Promise<T>,
  success: (result: T) => { outcome: SignInOutcome; step?: SignInStep; userId?: string | null },
): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    const failed = outcomeOf(error);
    if (failed) await logSignIn(request, { ...who, step, outcome: failed.outcome, detail: failed.detail });
    throw error;
  }
  const done = success(result);
  await logSignIn(request, { email: who.email, userId: done.userId ?? who.userId, step: done.step ?? step, outcome: done.outcome });
  return result;
}

import { writeAdminAuditEvent } from "@/lib/audit";
import { businessTimeZone } from "@/lib/dates";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { sendSecurityAlert } from "@/lib/email/mailer";
import { ValidationError } from "@/lib/errors";
import { readServerSetting, writeServerValue } from "@/lib/server-settings";

/*
 * Pausing remote access when someone is guessing (decision 542, Jess 15 Oct
 * 2026). When sign-ins through remote access fail many times in a short
 * while, from any logins and any addresses, everything that comes through
 * remote access is refused for a while; the local network carries on as
 * usual. The pause doubles if it happens again within a day, and server
 * admins are emailed. A server admin can resume it on the server computer.
 * Refusals while paused don't count, so a pause can't keep extending itself.
 */

const KEY = "remote_pause";
/** Failed (or locked) sign-ins through remote access, from anyone, that pause it. */
export const PAUSE_AFTER_FAILURES = 20;
export const PAUSE_WINDOW_MINUTES = 10;
const FIRST_PAUSE_MINUTES = 60;
const LONGEST_PAUSE_MINUTES = 24 * 60;
const CACHE_MS = 5000;

type PauseValue = { until: string | null; pausedAt: string | null; failures: number; trips: string[] };

export type RemotePause = {
  paused: boolean;
  until: string | null;
  pausedAt: string | null;
  /** Failed sign-ins through remote access that set off the latest pause. */
  failures: number;
  /** Pauses in the last 24 hours. */
  tripsToday: number;
  threshold: { failures: number; minutes: number };
};

const holder = globalThis as typeof globalThis & { __tohyeeRemotePause?: { database: string; checkedAt: number; until: string | null } };

function cacheKey(): string {
  return process.env.DATABASE_URL ?? "";
}

async function stored(): Promise<PauseValue> {
  const setting = await readServerSetting<PauseValue, Record<string, never>>(KEY);
  return { until: setting.value.until ?? null, pausedAt: setting.value.pausedAt ?? null, failures: setting.value.failures ?? 0, trips: setting.value.trips ?? [] };
}

/** When remote access is paused until, or null when it isn't. Cached for a few seconds: it's checked on every remote request. */
export async function remotePausedUntil(now = new Date()): Promise<string | null> {
  const cached = holder.__tohyeeRemotePause;
  let until: string | null;
  if (cached && cached.database === cacheKey() && now.getTime() - cached.checkedAt < CACHE_MS) {
    until = cached.until;
  } else {
    until = (await stored()).until;
    holder.__tohyeeRemotePause = { database: cacheKey(), checkedAt: now.getTime(), until };
  }
  return until && Date.parse(until) > now.getTime() ? until : null;
}

export function forgetRemotePauseCache(): void {
  delete holder.__tohyeeRemotePause;
}

export async function remotePauseStatus(now = new Date()): Promise<RemotePause> {
  const value = await stored();
  const paused = Boolean(value.until && Date.parse(value.until) > now.getTime());
  const dayAgo = now.getTime() - 24 * 3_600_000;
  return {
    paused,
    until: paused ? value.until : null,
    pausedAt: value.pausedAt,
    failures: value.failures,
    tripsToday: value.trips.filter((at) => Date.parse(at) > dayAgo).length,
    threshold: { failures: PAUSE_AFTER_FAILURES, minutes: PAUSE_WINDOW_MINUTES },
  };
}

/** "3:45 pm on 16 Oct": when a pause ends, in the business's time zone. */
export function pauseEndText(until: string): string {
  const date = new Date(until);
  const time = date.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: businessTimeZone() });
  const day = date.toLocaleDateString("en-NZ", { day: "numeric", month: "short", timeZone: businessTimeZone() });
  return `${time} on ${day}`;
}

/**
 * Called after a failed (or locked) sign-in through remote access has been
 * recorded: pauses remote access when there have been enough lately.
 */
export async function noteRemoteFailure(now = new Date()): Promise<void> {
  if (await remotePausedUntil(now)) return;
  const recent = await coreQuery<{ n: string }>(
    `select count(*)::text as n from sign_in_events
      where remote and outcome in ('failed', 'locked') and at > $1::timestamptz - ($2::int * interval '1 minute')`,
    [now.toISOString(), PAUSE_WINDOW_MINUTES],
  );
  const failures = Number(recent.rows[0].n);
  if (failures < PAUSE_AFTER_FAILURES) return;
  const value = await stored();
  // Only failures since the last pause ended count again, so one burst pauses once.
  if (value.pausedAt && value.until && Date.parse(value.until) > now.getTime() - PAUSE_WINDOW_MINUTES * 60_000) {
    const since = await coreQuery<{ n: string }>(
      "select count(*)::text as n from sign_in_events where remote and outcome in ('failed', 'locked') and at > $1::timestamptz",
      [value.until],
    );
    if (Number(since.rows[0].n) < PAUSE_AFTER_FAILURES) return;
  }
  const dayAgo = now.getTime() - 24 * 3_600_000;
  const trips = [...value.trips.filter((at) => Date.parse(at) > dayAgo), now.toISOString()];
  const minutes = Math.min(FIRST_PAUSE_MINUTES * 2 ** (trips.length - 1), LONGEST_PAUSE_MINUTES);
  const until = new Date(now.getTime() + minutes * 60_000).toISOString();
  await withCoreTransaction(async (client) => {
    await writeServerValue(client, KEY, { until, pausedAt: now.toISOString(), failures, trips } satisfies PauseValue, "tohyee");
    await writeAdminAuditEvent(client, { userId: null, email: "tohyee" }, {
      eventType: "remote_access.paused",
      entityType: "remote_access",
      entityId: "pause",
      details: { failures, minutes, until },
    });
  });
  holder.__tohyeeRemotePause = { database: cacheKey(), checkedAt: now.getTime(), until };
  const hours = minutes >= 60 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`;
  const lines = [
    `Remote access to Tohyee is paused until ${pauseEndText(until)} (${hours}), because there were ${failures} failed sign-ins through remote access in ${PAUSE_WINDOW_MINUTES} minutes. Someone may be guessing passwords.`,
    "Tohyee still works as usual on the local network. Nobody can sign in or use Tohyee through remote access until then.",
    "To resume sooner, open Remote access in the Tohyee server app on the server computer. See Sign-ins there for the attempts.",
  ];
  const admins = await coreQuery<{ email: string }>("select email from users where is_server_admin and is_active");
  for (const admin of admins.rows) await sendSecurityAlert(admin.email, "remote access paused", lines);
}

/** A server admin resumes remote access before the pause ends. */
export async function resumeRemoteAccess(actor: { userId: string | null; email: string }, now = new Date()): Promise<RemotePause> {
  const value = await stored();
  if (!value.until || Date.parse(value.until) <= now.getTime()) throw new ValidationError("Remote access isn't paused.");
  await withCoreTransaction(async (client) => {
    // The trips are kept, so pausing again today is still longer.
    await writeServerValue(client, KEY, { ...value, until: now.toISOString() } satisfies PauseValue, actor.email);
    await writeAdminAuditEvent(client, actor, { eventType: "remote_access.resumed", entityType: "remote_access", entityId: "pause", details: { wasUntil: value.until } });
  });
  forgetRemotePauseCache();
  return remotePauseStatus(now);
}

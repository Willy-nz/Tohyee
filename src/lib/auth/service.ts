import { revokeUserAiKeys } from "@/lib/ai/tokens";
import { timingSafeEqual } from "node:crypto";
import { writeAdminAuditEvent } from "@/lib/audit";
import {
  hashPassword,
  validateNewPassword,
  verifyAgainstDummy,
  verifyPassword,
} from "@/lib/auth/password";
import { createSession, type SessionMeta, type SessionStage, type SessionUser, twoStepRequired } from "@/lib/auth/sessions";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import {
  ConflictError,
  TooManyRequestsError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
} from "@/lib/errors";
import { requireString } from "@/lib/validation";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const SIGN_IN_FAILED = "Email or password is incorrect.";

export function normaliseEmail(input: unknown): string {
  const email = requireString(input, "email", { maxLength: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError("Enter a valid email address.");
  }
  return email;
}

export function parseDisplayName(input: unknown): string {
  return requireString(input, "name", { maxLength: 100 });
}

export async function needsSetup(): Promise<boolean> {
  const result = await coreQuery<{ has_users: boolean }>(
    "select exists (select 1 from users) as has_users",
  );
  return !result.rows[0]?.has_users;
}

function setupTokenMatches(presented: string): boolean {
  const expected = process.env.SETUP_TOKEN?.trim();
  if (!expected || expected.length < 16) {
    throw new UnavailableError(
      "First-time setup is locked. Set SETUP_TOKEN (16+ characters) in the server's environment, restart, then use that token here.",
    );
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `stage` says what's next: "full" means signed in; "verify" and "enrol" mean
 * the session is pending until the second step is done (or set up).
 */
type SignedIn = { user: SessionUser; token: string; expiresAt: Date; stage: SessionStage };

/** Creates the very first user (a server admin). Only works while there are no users. */
export async function completeSetup(
  input: { setupToken: unknown; email: unknown; displayName: unknown; password: unknown },
  meta: SessionMeta,
): Promise<SignedIn> {
  const setupToken = typeof input.setupToken === "string" ? input.setupToken.trim() : "";
  if (!setupTokenMatches(setupToken)) {
    throw new UnauthorizedError("That setup token isn't right.");
  }
  const email = normaliseEmail(input.email);
  const displayName = parseDisplayName(input.displayName);
  const passwordHash = await hashPassword(validateNewPassword(input.password));

  return withCoreTransaction(async (client) => {
    await client.query("lock table users in share row exclusive mode");
    const existing = await client.query<{ count: string }>("select count(*)::text as count from users");
    if (existing.rows[0]?.count !== "0") {
      throw new ConflictError("Setup has already been completed. Sign in instead.");
    }
    const inserted = await client.query<{ id: string }>(
      `insert into users (email, display_name, password_hash, is_server_admin, last_login_at)
       values ($1, $2, $3, true, now())
       returning id`,
      [email, displayName, passwordHash],
    );
    const userId = inserted.rows[0].id;
    await writeAdminAuditEvent(client, { userId, email }, {
      eventType: "server.setup_completed",
      entityType: "user",
      entityId: userId,
    });
    const required = twoStepRequired();
    const session = await createSession(client, userId, meta, { pending: required });
    return {
      user: { id: userId, email, displayName, isServerAdmin: true },
      token: session.token,
      expiresAt: session.expiresAt,
      stage: required ? "enrol" : "full",
    };
  });
}

type UserAuthRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_server_admin: boolean;
  is_active: boolean;
  failed_login_count: number;
  locked_until: string | null;
  two_step_enabled: boolean;
};

/**
 * Failed tries for emails with no account, kept in memory like the real
 * accounts' counts, so "too many attempts" can't be used to tell which emails
 * have accounts (#130). A restart forgets them.
 */
const unknownEmailFailures = new Map<string, { count: number; lockedUntil: number }>();

function unknownEmailLocked(email: string, now = Date.now()): number | null {
  const entry = unknownEmailFailures.get(email);
  return entry && entry.lockedUntil > now ? entry.lockedUntil : null;
}

function countUnknownEmailFailure(email: string, now = Date.now()): void {
  if (unknownEmailFailures.size > 10_000) {
    for (const [key, entry] of unknownEmailFailures) if (entry.lockedUntil <= now && entry.count === 0) unknownEmailFailures.delete(key);
    if (unknownEmailFailures.size > 10_000) unknownEmailFailures.clear();
  }
  const entry = unknownEmailFailures.get(email) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    entry.count = 0;
    entry.lockedUntil = now + LOCKOUT_MINUTES * 60_000;
  }
  unknownEmailFailures.set(email, entry);
}

function lockedError(until: number): TooManyRequestsError {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return new TooManyRequestsError(`Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
}

export async function signIn(
  input: { email: unknown; password: unknown },
  meta: SessionMeta,
): Promise<SignedIn> {
  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!email || !password) {
    throw new ValidationError("Enter your email and password.");
  }

  const found = await coreQuery<UserAuthRow>(
    `select id, email, display_name, password_hash, is_server_admin, is_active,
            failed_login_count, locked_until, totp_enabled_at is not null as two_step_enabled
       from users where email = $1`,
    [email],
  );
  const user = found.rows[0];
  if (!user) {
    const locked = unknownEmailLocked(email);
    if (locked) throw lockedError(locked);
    await verifyAgainstDummy(password);
    countUnknownEmailFailure(email);
    throw new UnauthorizedError(SIGN_IN_FAILED);
  }

  // Counted before the password is checked, in one statement, so passwords sent at once can't get past the limit (#130).
  const claimed = await coreQuery(
    `update users set failed_login_count = failed_login_count + 1
      where id = $1 and (locked_until is null or locked_until <= $3) and failed_login_count < $2`,
    [user.id, MAX_FAILED_ATTEMPTS, new Date()],
  );
  if (claimed.rowCount !== 1) {
    const now = await coreQuery<{ locked_until: string | null }>("select locked_until from users where id = $1", [user.id]);
    const until = now.rows[0]?.locked_until ? new Date(now.rows[0].locked_until).getTime() : 0;
    throw lockedError(until > Date.now() ? until : Date.now() + LOCKOUT_MINUTES * 60_000);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid || !user.is_active) {
    if (!valid) {
      // The limit reached: lock (the count starts again after the lock).
      await coreQuery(
        `update users set failed_login_count = 0, locked_until = $4::timestamptz + ($3::int * interval '1 minute')
          where id = $1 and failed_login_count >= $2`,
        [user.id, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES, new Date()],
      );
    }
    throw new UnauthorizedError(SIGN_IN_FAILED);
  }

  // With two-step sign-in, the password only opens a pending session; the
  // second step (or setting it up) finishes signing in.
  const required = twoStepRequired();
  const stage: SessionStage = !required ? "full" : user.two_step_enabled ? "verify" : "enrol";
  return withCoreTransaction(async (client) => {
    await client.query(
      `update users
          set failed_login_count = 0, locked_until = case when $2 then locked_until else null end,
              last_login_at = case when $2 then last_login_at else now() end
        where id = $1`,
      [user.id, required],
    );
    const session = await createSession(client, user.id, meta, { pending: required });
    return {
      stage,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        isServerAdmin: user.is_server_admin,
      },
      token: session.token,
      expiresAt: session.expiresAt,
    };
  });
}

/** Changes your own password and signs out every other session. */
export async function changeOwnPassword(
  userId: string,
  currentSessionId: string,
  input: { currentPassword: unknown; newPassword: unknown },
): Promise<void> {
  const current = typeof input.currentPassword === "string" ? input.currentPassword : "";
  const next = validateNewPassword(input.newPassword, "newPassword");
  const found = await coreQuery<{ password_hash: string; email: string }>(
    "select password_hash, email from users where id = $1 and is_active",
    [userId],
  );
  const row = found.rows[0];
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    throw new ValidationError("Your current password isn't right.");
  }
  const passwordHash = await hashPassword(next);
  await withCoreTransaction(async (client) => {
    await client.query(
      `update users set password_hash = $2, password_changed_at = now(), updated_at = now()
        where id = $1`,
      [userId, passwordHash],
    );
    await client.query("delete from sessions where user_id = $1 and id <> $2", [
      userId,
      currentSessionId,
    ]);
    const aiKeysRevoked = await revokeUserAiKeys(client, userId);
    await writeAdminAuditEvent(client, { userId, email: row.email }, {
      eventType: "user.password_changed",
      entityType: "user",
      entityId: userId,
      details: { aiKeysRevoked },
    });
  });
}

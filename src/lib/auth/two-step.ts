import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { writeAdminAuditEvent } from "@/lib/audit";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "@/lib/auth/password";
import { createSession, type SessionMeta, type SessionState, type SessionUser, twoStepRequired } from "@/lib/auth/sessions";
import {
  generateBackupCodes,
  generateTotpSecret,
  matchTotp,
  normaliseBackupCode,
  normaliseTotpInput,
  otpauthUri,
} from "@/lib/auth/totp";
import { coreQuery, type DbClient, withCoreTransaction } from "@/lib/db/transactions";
import { sendEmail, sendSecurityAlert } from "@/lib/email/mailer";
import { ConflictError, TooManyRequestsError, UnauthorizedError, UnavailableError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";

/**
 * Two-step sign-in (authenticator app plus one-use backup codes). Everyone
 * must set it up when the server has TOHYEE_SECRET_KEY. The flow:
 * password → a pending session → an authenticator or backup code → a new,
 * full session (a new token, so the pending one can't be reused).
 */
export const BACKUP_CODE_COUNT = 10;
/** Wrong codes allowed in one pending session before it's thrown away. */
const MAX_SESSION_FAILURES = 5;
/** Wrong codes in a row, across sessions, before the account is locked. */
const MAX_USER_FAILURES = 10;
const LOCKOUT_MINUTES = 15;
const RESET_LINK_MINUTES = 30;
const RESET_EMAIL_EVERY_MINUTES = 5;
const ISSUER = "Tohyee";

type Signed = { user: SessionUser; token: string; expiresAt: Date };

function requireStage(state: SessionState, stage: "verify" | "enrol"): void {
  if (state.stage !== stage) {
    throw new ConflictError(
      stage === "enrol" ? "Two-step sign-in is already set up for this account." : "This sign-in doesn't need a code.",
    );
  }
}

function requireKey(): void {
  if (!secretsAvailable()) {
    throw new UnavailableError(
      "Two-step sign-in can't be set up because the server has no TOHYEE_SECRET_KEY. A server admin needs to set it and restart Tohyee.",
    );
  }
}

export type TwoStepStatus = {
  required: boolean;
  enabled: boolean;
  enabledAt: string | null;
  backupCodesLeft: number;
};

export async function getTwoStepStatus(userId: string): Promise<TwoStepStatus> {
  const result = await coreQuery<{ enabled_at: string | null; left: string }>(
    `select u.totp_enabled_at as enabled_at,
            (select count(*) from user_backup_codes c where c.user_id = u.id and c.used_at is null)::text as left
       from users u where u.id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return {
    required: twoStepRequired(),
    enabled: Boolean(row?.enabled_at),
    enabledAt: row?.enabled_at ?? null,
    backupCodesLeft: Number(row?.left ?? 0),
  };
}

export type EnrolmentStart = { secret: string; otpauthUri: string; qrSvg: string };

/**
 * The key to add to an authenticator app, as a QR code and as text. The same
 * key is shown until it's confirmed, unless `fresh` asks for a new one.
 */
export async function startEnrolment(state: SessionState, options: { fresh?: boolean } = {}): Promise<EnrolmentStart> {
  requireStage(state, "enrol");
  requireKey();
  const found = await coreQuery<{ totp_pending_ciphertext: string | null }>(
    "select totp_pending_ciphertext from users where id = $1",
    [state.user.id],
  );
  let secret: string | null = null;
  const stored = found.rows[0]?.totp_pending_ciphertext;
  if (stored && !options.fresh) {
    try {
      secret = decryptSecret(stored);
    } catch {
      secret = null;
    }
  }
  if (!secret) {
    secret = generateTotpSecret();
    await coreQuery("update users set totp_pending_ciphertext = $2, updated_at = now() where id = $1", [
      state.user.id,
      encryptSecret(secret),
    ]);
  }
  const uri = otpauthUri(ISSUER, state.user.email, secret);
  const qrSvg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  return { secret, otpauthUri: uri, qrSvg };
}

async function insertBackupCodes(client: DbClient, userId: string): Promise<string[]> {
  const codes = generateBackupCodes(BACKUP_CODE_COUNT);
  const hashes = await Promise.all(codes.map((code) => hashPassword(code)));
  await client.query("delete from user_backup_codes where user_id = $1", [userId]);
  await client.query(
    "insert into user_backup_codes (user_id, code_hash) select $1, unnest($2::text[])",
    [userId, hashes],
  );
  return codes;
}

/** Counts a wrong code against the pending session and the user; throws the message to show. */
async function recordFailure(state: SessionState): Promise<never> {
  const result = await withCoreTransaction(async (client) => {
    const session = await client.query<{ failures: number }>(
      "update sessions set two_step_failures = two_step_failures + 1 where id = $1 returning two_step_failures as failures",
      [state.sessionId],
    );
    const user = await client.query<{ locked: boolean }>(
      `update users
          set two_step_failed_count = case when two_step_failed_count + 1 >= $2 then 0 else two_step_failed_count + 1 end,
              locked_until = case when two_step_failed_count + 1 >= $2 then now() + ($3::int * interval '1 minute') else locked_until end
        where id = $1
        returning (locked_until is not null and locked_until > now()) as locked`,
      [state.user.id, MAX_USER_FAILURES, LOCKOUT_MINUTES],
    );
    const locked = user.rows[0]?.locked ?? false;
    const sessionFailures = session.rows[0]?.failures ?? MAX_SESSION_FAILURES;
    if (locked) {
      await client.query("delete from sessions where user_id = $1 and two_step_pending", [state.user.id]);
    } else if (sessionFailures >= MAX_SESSION_FAILURES) {
      await client.query("delete from sessions where id = $1", [state.sessionId]);
    }
    return { locked, ended: locked || sessionFailures >= MAX_SESSION_FAILURES };
  });
  if (result.locked) {
    await sendSecurityAlert(state.user.email, "sign-in locked after wrong codes", [
      `Someone entered your password correctly but then ${MAX_USER_FAILURES} wrong two-step codes, so your account is locked for ${LOCKOUT_MINUTES} minutes.`,
    ]);
    throw new TooManyRequestsError(`Too many wrong codes. Your account is locked for ${LOCKOUT_MINUTES} minutes.`);
  }
  if (result.ended) throw new UnauthorizedError("Too many wrong codes. Sign in with your password again.");
  throw new ValidationError("That code isn't right. Check the time on your phone is set automatically, then try the newest code.");
}

async function fullSessionReplacing(client: DbClient, state: SessionState, meta: SessionMeta): Promise<Signed> {
  await client.query("delete from sessions where id = $1", [state.sessionId]);
  await client.query(
    "update users set failed_login_count = 0, two_step_failed_count = 0, locked_until = null, last_login_at = now() where id = $1",
    [state.user.id],
  );
  const session = await createSession(client, state.user.id, meta);
  return { user: state.user, token: session.token, expiresAt: session.expiresAt };
}

/** Confirms the authenticator app with its first code, turns two-step on and returns the backup codes (shown once). */
export async function completeEnrolment(
  state: SessionState,
  input: { code: unknown },
  meta: SessionMeta,
): Promise<Signed & { backupCodes: string[] }> {
  requireStage(state, "enrol");
  requireKey();
  const code = typeof input.code === "string" ? input.code : "";
  if (!normaliseTotpInput(code)) throw new ValidationError("Enter the 6-digit code your authenticator app shows.");
  const found = await coreQuery<{ totp_pending_ciphertext: string | null }>(
    "select totp_pending_ciphertext from users where id = $1",
    [state.user.id],
  );
  const stored = found.rows[0]?.totp_pending_ciphertext;
  if (!stored) throw new ConflictError("Start again: the QR code expired. Reload the page to get a new one.");
  const secret = decryptSecret(stored);
  const step = matchTotp(secret, code);
  if (step === null) return recordFailure(state);
  const result = await withCoreTransaction(async (client) => {
    const updated = await client.query(
      `update users
          set totp_secret_ciphertext = totp_pending_ciphertext, totp_enabled_at = now(), totp_last_step = $2,
              totp_pending_ciphertext = null, updated_at = now()
        where id = $1 and totp_enabled_at is null and totp_pending_ciphertext = $3`,
      [state.user.id, step, stored],
    );
    if (updated.rowCount !== 1) throw new ConflictError("Two-step sign-in was set up in another window. Sign in again.");
    const backupCodes = await insertBackupCodes(client, state.user.id);
    await writeAdminAuditEvent(client, { userId: state.user.id, email: state.user.email }, {
      eventType: "user.two_step_enabled",
      entityType: "user",
      entityId: state.user.id,
    });
    const signed = await fullSessionReplacing(client, state, meta);
    return { ...signed, backupCodes };
  });
  await sendSecurityAlert(state.user.email, "two-step sign-in turned on", [
    "Two-step sign-in was turned on for your Tohyee account. From now on you'll need your authenticator app (or a backup code) as well as your password.",
  ]);
  return result;
}

/** Finishes signing in with an authenticator code or a backup code. */
export async function verifySecondStep(
  state: SessionState,
  input: { code: unknown },
  meta: SessionMeta,
): Promise<Signed & { usedBackupCode: boolean; backupCodesLeft: number }> {
  requireStage(state, "verify");
  requireKey();
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!code) throw new ValidationError("Enter the code from your authenticator app, or a backup code.");
  const found = await coreQuery<{ totp_secret_ciphertext: string; totp_last_step: string | null; locked_until: string | null }>(
    "select totp_secret_ciphertext, totp_last_step::text, locked_until from users where id = $1",
    [state.user.id],
  );
  const user = found.rows[0];
  if (!user) throw new UnauthorizedError();
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw new TooManyRequestsError("Too many wrong codes. Try again later.");
  }

  let secret: string;
  try {
    secret = decryptSecret(user.totp_secret_ciphertext);
  } catch {
    // The server's TOHYEE_SECRET_KEY was changed, so the key can't be read.
    // The password was right: start setting two-step sign-in up again.
    await withCoreTransaction(async (client) => {
      await client.query(
        `update users set totp_secret_ciphertext = null, totp_enabled_at = null, totp_last_step = null, updated_at = now()
          where id = $1`,
        [state.user.id],
      );
      await client.query("delete from user_backup_codes where user_id = $1", [state.user.id]);
      await writeAdminAuditEvent(client, { userId: state.user.id, email: state.user.email }, {
        eventType: "user.two_step_key_unreadable",
        entityType: "user",
        entityId: state.user.id,
      });
    });
    throw new ConflictError(
      "Your two-step key can't be read because the server's secret key changed. Set up your authenticator app again (delete the old Tohyee entry in the app).",
    );
  }

  if (normaliseTotpInput(code)) {
    const step = matchTotp(secret, code, {
      lastUsedStep: user.totp_last_step === null ? null : Number(user.totp_last_step),
    });
    if (step === null) return recordFailure(state);
    const signed = await withCoreTransaction(async (client) => {
      const claimed = await client.query(
        "update users set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2)",
        [state.user.id, step],
      );
      if (claimed.rowCount !== 1) throw new ValidationError("That code was just used. Wait for the next one.");
      return fullSessionReplacing(client, state, meta);
    });
    return { ...signed, usedBackupCode: false, backupCodesLeft: (await getTwoStepStatus(state.user.id)).backupCodesLeft };
  }

  const backupCode = normaliseBackupCode(code);
  if (!backupCode) return recordFailure(state);
  const codes = await coreQuery<{ id: string; code_hash: string }>(
    "select id, code_hash from user_backup_codes where user_id = $1 and used_at is null",
    [state.user.id],
  );
  let matchedId: string | null = null;
  for (const row of codes.rows) {
    if (await verifyPassword(backupCode, row.code_hash)) {
      matchedId = row.id;
      break;
    }
  }
  if (!matchedId) {
    if (codes.rows.length === 0) await verifyAgainstDummy(backupCode);
    return recordFailure(state);
  }
  const signed = await withCoreTransaction(async (client) => {
    const used = await client.query("update user_backup_codes set used_at = now() where id = $1 and used_at is null", [matchedId]);
    if (used.rowCount !== 1) throw new ValidationError("That backup code has already been used.");
    await writeAdminAuditEvent(client, { userId: state.user.id, email: state.user.email }, {
      eventType: "user.backup_code_used",
      entityType: "user",
      entityId: state.user.id,
    });
    return fullSessionReplacing(client, state, meta);
  });
  const left = (await getTwoStepStatus(state.user.id)).backupCodesLeft;
  await sendSecurityAlert(state.user.email, "a backup code was used", [
    `Someone signed in to your Tohyee account with one of your backup codes. You have ${left} left.`,
    "If you've lost your phone, make new backup codes under your profile once you're signed in.",
  ]);
  return { ...signed, usedBackupCode: true, backupCodesLeft: left };
}

/** New backup codes (the old ones stop working). Needs a current authenticator code. */
export async function regenerateBackupCodes(user: SessionUser, input: { code: unknown }): Promise<string[]> {
  requireKey();
  const code = typeof input.code === "string" ? input.code : "";
  const found = await coreQuery<{ totp_secret_ciphertext: string | null; totp_last_step: string | null }>(
    "select totp_secret_ciphertext, totp_last_step::text from users where id = $1",
    [user.id],
  );
  const row = found.rows[0];
  if (!row?.totp_secret_ciphertext) throw new ConflictError("Two-step sign-in isn't set up for this account.");
  const step = matchTotp(decryptSecret(row.totp_secret_ciphertext), code, {
    lastUsedStep: row.totp_last_step === null ? null : Number(row.totp_last_step),
  });
  if (step === null) throw new ValidationError("That code isn't right. Enter the code your authenticator app shows now.");
  const codes = await withCoreTransaction(async (client) => {
    await client.query("update users set totp_last_step = $2 where id = $1", [user.id, step]);
    const fresh = await insertBackupCodes(client, user.id);
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "user.backup_codes_replaced",
      entityType: "user",
      entityId: user.id,
    });
    return fresh;
  });
  await sendSecurityAlert(user.email, "new backup codes", ["New backup codes were made for your Tohyee account. The old ones no longer work."]);
  return codes;
}

/**
 * Turns two-step sign-in off for a user and signs them out everywhere. They
 * set it up again at their next sign-in. Used by server admins, the admin
 * command line and emailed reset links.
 */
export async function resetTwoStep(
  client: DbClient,
  userId: string,
  actor: { userId: string | null; email: string },
  how: "admin" | "email_link" | "command_line",
): Promise<void> {
  await client.query(
    `update users
        set totp_secret_ciphertext = null, totp_enabled_at = null, totp_last_step = null, totp_pending_ciphertext = null,
            two_step_failed_count = 0, updated_at = now()
      where id = $1`,
    [userId],
  );
  await client.query("delete from user_backup_codes where user_id = $1", [userId]);
  await client.query("delete from sessions where user_id = $1", [userId]);
  await client.query("update two_step_reset_tokens set used_at = coalesce(used_at, now()) where user_id = $1", [userId]);
  await writeAdminAuditEvent(client, actor, {
    eventType: "user.two_step_reset",
    entityType: "user",
    entityId: userId,
    details: { how },
  });
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Emails a link to reset two-step sign-in (lost phone and backup codes).
 * Only from a pending sign-in, so the password was right. One email every
 * 5 minutes at most.
 */
export async function emailTwoStepReset(state: SessionState, publicOrigin: string): Promise<void> {
  requireStage(state, "verify");
  const token = randomBytes(32).toString("base64url");
  const created = await withCoreTransaction(async (client) => {
    await client.query("select 1 from users where id = $1 for update", [state.user.id]);
    const recent = await client.query(
      "select 1 from two_step_reset_tokens where user_id = $1 and created_at > now() - ($2::int * interval '1 minute')",
      [state.user.id, RESET_EMAIL_EVERY_MINUTES],
    );
    if ((recent.rowCount ?? 0) > 0) return false;
    await client.query(
      "insert into two_step_reset_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + ($3::int * interval '1 minute'))",
      [hashResetToken(token), state.user.id, RESET_LINK_MINUTES],
    );
    return true;
  });
  if (!created) {
    throw new TooManyRequestsError(`A reset link was emailed in the last ${RESET_EMAIL_EVERY_MINUTES} minutes. Check your email (and spam).`);
  }
  await sendEmail({
    to: state.user.email,
    subject: "Tohyee: reset two-step sign-in",
    text: [
      "Someone signed in to your Tohyee account with your password and asked to reset two-step sign-in.",
      "",
      `To reset it, open this link within ${RESET_LINK_MINUTES} minutes and enter your password again:`,
      `${publicOrigin.replace(/\/+$/, "")}/login/reset-two-step?token=${encodeURIComponent(token)}`,
      "",
      "You'll then set up your authenticator app again. If you didn't ask for this, ignore this email and change your password: someone knows it.",
    ].join("\n"),
  });
}

/** Uses an emailed reset link: with the password again, two-step is reset and a new set-up starts. */
export async function completeTwoStepReset(input: { token: unknown; password: unknown }, meta: SessionMeta): Promise<Signed> {
  const token = typeof input.token === "string" ? input.token : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!token || !password) throw new ValidationError("Enter your password.");
  const found = await coreQuery<{ user_id: string; email: string; display_name: string; is_server_admin: boolean; password_hash: string }>(
    `select t.user_id, u.email, u.display_name, u.is_server_admin, u.password_hash
       from two_step_reset_tokens t join users u on u.id = t.user_id
      where t.token_hash = $1 and t.used_at is null and t.expires_at > now() and u.is_active`,
    [hashResetToken(token)],
  );
  const row = found.rows[0];
  if (!row) {
    await verifyAgainstDummy(password);
    throw new UnauthorizedError("This reset link has expired or was already used. Sign in and ask for a new one.");
  }
  if (!(await verifyPassword(password, row.password_hash))) throw new UnauthorizedError("That password isn't right.");
  const signed = await withCoreTransaction(async (client) => {
    const claimed = await client.query("update two_step_reset_tokens set used_at = now() where token_hash = $1 and used_at is null", [
      hashResetToken(token),
    ]);
    if (claimed.rowCount !== 1) throw new UnauthorizedError("This reset link was already used.");
    await resetTwoStep(client, row.user_id, { userId: row.user_id, email: row.email }, "email_link");
    const session = await createSession(client, row.user_id, meta, { pending: true });
    return {
      user: { id: row.user_id, email: row.email, displayName: row.display_name, isServerAdmin: row.is_server_admin },
      token: session.token,
      expiresAt: session.expiresAt,
    };
  });
  await sendSecurityAlert(row.email, "two-step sign-in was reset", [
    "Two-step sign-in was reset for your Tohyee account using an emailed link, and all its sessions were signed out.",
  ]);
  return signed;
}

import { createHash, randomBytes } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { revokeUserAiKeys } from "@/lib/ai/tokens";
import { type AdminActor, writeAdminAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import { configuredOrigin, returnOrigin } from "@/lib/auth/origin";
import { challengeIn, checkCounter, cleanPasskeyName, PASSKEY_NAME_MAX, type PasskeyAddress, passkeyAddress, passkeyPlace, suggestPasskeyName } from "@/lib/auth/passkey-rules";
import { verifyPassword } from "@/lib/auth/password";
import { claimPasswordTry, lockIfTooManyFailures } from "@/lib/auth/service";
import { createSession, isSecureRequest, readCookie, type SessionUser, sessionMetaFrom } from "@/lib/auth/sessions";
import { logSignIn, type SignInOutcome } from "@/lib/auth/sign-in-log";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { endPasskeys } from "@/lib/auth/passkey-end";
import { sendSecurityAlert } from "@/lib/email/mailer";
import { ConflictError, ForbiddenError, HttpError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";

/**
 * Sign in with a passkey (#450, decisions 885-899): Face ID, a fingerprint
 * or Windows Hello, through WebAuthn with the SimpleWebAuthn library.
 *
 * - Added from Your account, after the password again (or, for someone who
 *   signs in with Google only, a sign-in in the last 5 minutes). A security
 *   email says so.
 * - Discoverable ("resident") passkeys with the person's face, finger or PIN
 *   required (userVerification "required"), so the sign-in page needs no
 *   email: the phone offers the passkeys it has for this address. A passkey
 *   sign-in counts as two-step.
 * - No attestation ("none"): Tohyee doesn't ask which make of phone or key
 *   it is, only that the passkey answers the challenge.
 * - Every challenge is random, used once, within 5 minutes, and only from the
 *   browser (sign-in) or session (adding) that asked for it.
 * - Only on Tohyee's web address or localhost (passkeyAddress).
 */

export const PASSKEY_BROWSER_COOKIE = "tohyee_passkey";
const COOKIE_PATH = "/api/auth/passkeys/sign-in";
const CHALLENGE_MINUTES = 5;
/** Someone with no password (Google only) adds a passkey within this long of signing in. */
export const FRESH_SIGN_IN_MINUTES = 5;
export const MAX_PASSKEYS = 20;
/** EdDSA, ES256 and RS256: what phones, computers and security keys make. */
const ALGORITHMS = [-8, -7, -257];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Lets tests move the challenge's clock. */
let clock: () => Date = () => new Date();
export function setPasskeyClockForTests(replacement: (() => Date) | null): void {
  clock = replacement ?? (() => new Date());
}

/** The address this browser is using, and whether passkeys work there, with a pointer to the web address when there's one. */
export async function passkeyAddressFor(request: Request): Promise<PasskeyAddress> {
  const address = passkeyAddress(await returnOrigin(request));
  if (!address.problem) return address;
  const web = await configuredOrigin();
  const usable = web ? passkeyAddress(web) : null;
  return usable && !usable.problem ? { ...address, problem: `${address.problem} Tohyee's web address here is ${usable.origin}.` } : address;
}

async function usableAddress(request: Request): Promise<{ origin: string; rpId: string }> {
  const address = await passkeyAddressFor(request);
  if (address.problem !== null) throw new ValidationError(address.problem);
  return address;
}

// ---------------------------------------------------------------------------
// Your account

export type PasskeySummary = {
  id: string;
  name: string;
  /** Where it works: Tohyee's web address, or localhost. */
  rpId: string;
  place: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Synced between devices (iCloud Keychain, Google Password Manager) rather than kept on one. */
  synced: boolean;
  backedUp: boolean;
  /** This session was signed in with it. */
  thisSession: boolean;
};

export type PasskeyStatus = {
  passkeys: PasskeySummary[];
  /** Whether passkeys work on the address in use, and why not. */
  rpId: string | null;
  problem: string | null;
  /** Adding one asks for the password again; false for someone with no password (Google only). */
  needsPassword: boolean;
  /** Google only: until when this sign-in is fresh enough to add one (null: not fresh, or not needed). */
  freshUntil: string | null;
  suggestedName: string;
  max: number;
};

type PasskeyRow = {
  id: string;
  name: string;
  rp_id: string;
  created_at: Date;
  last_used_at: Date | null;
  device_type: string;
  backed_up: boolean;
  this_session: boolean;
};

function toSummary(row: PasskeyRow): PasskeySummary {
  return {
    id: row.id,
    name: row.name,
    rpId: row.rp_id,
    place: passkeyPlace(row.rp_id),
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    synced: row.device_type === "multiDevice",
    backedUp: row.backed_up,
    thisSession: row.this_session,
  };
}

export async function listPasskeys(userId: string, sessionId: string | null = null): Promise<PasskeySummary[]> {
  const rows = await coreQuery<PasskeyRow>(
    `select p.id::text, p.name, p.rp_id, p.created_at, p.last_used_at, p.device_type, p.backed_up,
            exists (select 1 from sessions s where s.id = $2 and s.passkey_id = p.id) as this_session
       from user_passkeys p where p.user_id = $1 order by p.created_at, p.id`,
    [userId, sessionId],
  );
  return rows.rows.map(toSummary);
}

export async function getPasskeyStatus(request: Request, auth: AuthContext): Promise<PasskeyStatus> {
  const address = await passkeyAddressFor(request);
  const found = await coreQuery<{ google_only: boolean; fresh_until: Date | null }>(
    `select u.google_only,
            (select s.created_at + ($3::int * interval '1 minute') from sessions s where s.id = $2 and s.created_at > now() - ($3::int * interval '1 minute')) as fresh_until
       from users u where u.id = $1`,
    [auth.user.id, auth.sessionId, FRESH_SIGN_IN_MINUTES],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("User not found.");
  return {
    passkeys: await listPasskeys(auth.user.id, auth.sessionId),
    rpId: address.rpId,
    problem: address.problem,
    needsPassword: !row.google_only,
    freshUntil: row.google_only && row.fresh_until ? new Date(row.fresh_until).toISOString() : null,
    suggestedName: suggestPasskeyName(request.headers.get("user-agent")),
    max: MAX_PASSKEYS,
  };
}

/** The random ID passkeys carry for this login (made the first time). */
async function userHandle(userId: string): Promise<string> {
  const made = await coreQuery<{ handle: string }>(
    "update users set passkey_user_handle = coalesce(passkey_user_handle, $2) where id = $1 returning passkey_user_handle as handle",
    [userId, randomBytes(32).toString("base64url")],
  );
  if (!made.rows[0]) throw new NotFoundError("User not found.");
  return made.rows[0].handle;
}

/**
 * Step 1 of adding a passkey: checks it's really you (decision 886), then
 * the options for the browser's passkey prompt, tied to this session.
 */
export async function startAddingPasskey(request: Request, auth: AuthContext, input: { password?: unknown }): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { origin, rpId } = await usableAddress(request);
  const found = await coreQuery<{ password_hash: string; google_only: boolean; fresh: boolean; count: string }>(
    `select u.password_hash, u.google_only,
            exists (select 1 from sessions s where s.id = $2 and s.created_at > now() - ($3::int * interval '1 minute')) as fresh,
            (select count(*) from user_passkeys p where p.user_id = u.id)::text as count
       from users u where u.id = $1 and u.is_active`,
    [auth.user.id, auth.sessionId, FRESH_SIGN_IN_MINUTES],
  );
  const row = found.rows[0];
  if (!row) throw new UnauthorizedError();
  if (Number(row.count) >= MAX_PASSKEYS) throw new ConflictError(`You have ${MAX_PASSKEYS} passkeys, the most a login can have. Remove one you no longer use first.`);
  if (row.google_only) {
    // No password to ask for: a sign-in with Google in the last few minutes instead.
    if (!row.fresh) {
      throw new ForbiddenError(`To add a passkey, sign out and sign in with Google again, then add it within ${FRESH_SIGN_IN_MINUTES} minutes. This checks it's really you.`);
    }
  } else {
    // Your password again, so a session left open (or taken) can't quietly add a way in. Counted with sign-in tries.
    const password = typeof input.password === "string" ? input.password : "";
    if (!password) throw new ValidationError("Enter your password to add a passkey.");
    await claimPasswordTry(auth.user.id);
    if (!(await verifyPassword(password, row.password_hash))) {
      await lockIfTooManyFailures(auth.user.id);
      throw new ValidationError("Your password isn't right.");
    }
    await coreQuery("update users set failed_login_count = 0 where id = $1", [auth.user.id]);
  }

  const handle = await userHandle(auth.user.id);
  const existing = await coreQuery<{ credential_id: string; transports: string[] }>("select credential_id, transports from user_passkeys where user_id = $1 and rp_id = $2", [auth.user.id, rpId]);
  const options = await generateRegistrationOptions({
    rpName: "Tohyee",
    rpID: rpId,
    userName: auth.user.email,
    userDisplayName: auth.user.displayName,
    userID: new Uint8Array(Buffer.from(handle, "base64url")),
    challenge: new Uint8Array(randomBytes(32)),
    timeout: CHALLENGE_MINUTES * 60 * 1000,
    attestationType: "none",
    // The same phone or key can't be added twice.
    excludeCredentials: existing.rows.map((entry) => ({ id: entry.credential_id, transports: entry.transports })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
  });
  await coreQuery(
    "insert into passkey_challenges (challenge_hash, purpose, user_id, session_id, rp_id, origin, created_at) values ($1, 'register', $2, $3, $4, $5, $6)",
    [sha256Hex(options.challenge), auth.user.id, auth.sessionId, rpId, origin, clock()],
  );
  await coreQuery("delete from passkey_challenges where created_at < now() - interval '1 day'");
  return options;
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(message);
  return value as Record<string, unknown>;
}

/** Claims a challenge: once only, within 5 minutes, and only where it was asked for. Returns where it was for. */
async function claimChallenge(
  challenge: string,
  where: { purpose: "register"; userId: string; sessionId: string } | { purpose: "sign_in"; browser: string },
): Promise<{ rp_id: string; origin: string } | null> {
  const claimed =
    where.purpose === "register"
      ? await coreQuery<{ rp_id: string; origin: string }>(
          `update passkey_challenges set used_at = now()
            where challenge_hash = $1 and purpose = 'register' and user_id = $2 and session_id = $3 and used_at is null and created_at > $4::timestamptz - ($5::int * interval '1 minute')
            returning rp_id, origin`,
          [sha256Hex(challenge), where.userId, where.sessionId, clock(), CHALLENGE_MINUTES],
        )
      : await coreQuery<{ rp_id: string; origin: string }>(
          `update passkey_challenges set used_at = now()
            where challenge_hash = $1 and purpose = 'sign_in' and browser_hash = $2 and used_at is null and created_at > $3::timestamptz - ($4::int * interval '1 minute')
            returning rp_id, origin`,
          [sha256Hex(challenge), sha256Hex(where.browser), clock(), CHALLENGE_MINUTES],
        );
  return claimed.rows[0] ?? null;
}

/** Step 2: checks the new passkey's answer and keeps its public key. */
export async function finishAddingPasskey(request: Request, auth: AuthContext, input: { response?: unknown; name?: unknown }): Promise<PasskeySummary> {
  const name = cleanPasskeyName(input.name);
  if (!name) throw new ValidationError(`Give the passkey a name (up to ${PASSKEY_NAME_MAX} characters), such as "Jess's iPhone".`);
  const response = asObject(input.response, "The passkey's answer is missing. Try again.");
  const inner = asObject(response.response, "The passkey's answer is missing. Try again.");
  const challenge = challengeIn(inner.clientDataJSON);
  if (!challenge) throw new ValidationError("The passkey's answer isn't readable. Try again.");
  const { origin } = await usableAddress(request);
  const claimed = await claimChallenge(challenge, { purpose: "register", userId: auth.user.id, sessionId: auth.sessionId });
  if (!claimed) throw new ValidationError(`Adding the passkey took too long, or was already done. Start again (you have ${CHALLENGE_MINUTES} minutes).`);
  if (claimed.origin !== origin) throw new ValidationError("The passkey was started on a different address. Start again here.");

  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: claimed.origin,
      expectedRPID: claimed.rp_id,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
  } catch (error) {
    console.warn("[tohyee] A new passkey wasn't accepted:", error instanceof Error ? error.message : error);
    throw new ValidationError("That passkey couldn't be checked, so it wasn't added. Try again.");
  }
  if (!verified.verified) throw new ValidationError("That passkey couldn't be checked, so it wasn't added. Try again.");
  const info = verified.registrationInfo;
  const transports = (info.credential.transports ?? []).filter((entry) => /^[a-z-]{1,20}$/.test(entry)).slice(0, 8);

  const added = await withCoreTransaction(async (client) => {
    const user = await client.query("select 1 from users where id = $1 and is_active for update", [auth.user.id]);
    if (!user.rows[0]) throw new UnauthorizedError();
    const count = await client.query<{ count: string }>("select count(*)::text as count from user_passkeys where user_id = $1", [auth.user.id]);
    if (Number(count.rows[0].count) >= MAX_PASSKEYS) throw new ConflictError(`You have ${MAX_PASSKEYS} passkeys, the most a login can have.`);
    const inserted = await client.query<PasskeyRow>(
      `insert into user_passkeys (user_id, credential_id, public_key, sign_count, transports, rp_id, device_type, backed_up, aaguid, name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (credential_id) do nothing
       returning id::text, name, rp_id, created_at, last_used_at, device_type, backed_up, false as this_session`,
      [
        auth.user.id,
        info.credential.id,
        Buffer.from(info.credential.publicKey),
        info.credential.counter,
        transports,
        claimed.rp_id,
        info.credentialDeviceType,
        info.credentialBackedUp,
        info.aaguid,
        name,
      ],
    );
    if (!inserted.rows[0]) throw new ConflictError("That passkey is already added.");
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "user.passkey_added",
      entityType: "user",
      entityId: auth.user.id,
      details: { name, rpId: claimed.rp_id, synced: info.credentialDeviceType === "multiDevice" },
    });
    return toSummary(inserted.rows[0]);
  });
  await sendSecurityAlert(auth.user.email, "a passkey was added", [
    `A passkey called "${name}" was added to your Tohyee login. It can now be used to sign in ${passkeyPlace(claimed.rp_id)}, with that device's face, fingerprint or PIN.`,
    "If this wasn't you, remove it under Your account › Passkeys and change your password.",
  ]);
  return added;
}

export async function renamePasskey(auth: AuthContext, passkeyId: string, input: { name?: unknown }): Promise<PasskeySummary> {
  if (!/^[0-9a-f-]{36}$/i.test(passkeyId)) throw new NotFoundError("Passkey not found.");
  const name = cleanPasskeyName(input.name);
  if (!name) throw new ValidationError(`Give the passkey a name (up to ${PASSKEY_NAME_MAX} characters).`);
  const updated = await coreQuery<{ id: string }>("update user_passkeys set name = $3 where id = $1 and user_id = $2 returning id::text", [passkeyId, auth.user.id, name]);
  if (!updated.rows[0]) throw new NotFoundError("Passkey not found.");
  const found = (await listPasskeys(auth.user.id, auth.sessionId)).find((entry) => entry.id === passkeyId);
  if (!found) throw new NotFoundError("Passkey not found.");
  return found;
}

/**
 * Removes one of your own passkeys. Sessions signed in with it end, except
 * this one. Apps and keys you connected keep working: you're signed in and
 * choosing, as when you unlink Google (decisions 852, 891).
 */
export async function removeOwnPasskey(auth: AuthContext, passkeyId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(passkeyId)) throw new NotFoundError("Passkey not found.");
  const removed = await withCoreTransaction(async (client) => {
    const found = await client.query<{ name: string; rp_id: string }>("select name, rp_id from user_passkeys where id = $1 and user_id = $2 for update", [passkeyId, auth.user.id]);
    if (!found.rows[0]) throw new NotFoundError("Passkey not found.");
    await client.query("update sessions set passkey_id = null where id = $1 and passkey_id = $2", [auth.sessionId, passkeyId]);
    // The other sessions it signed in go with it (sessions.passkey_id cascades).
    await client.query("delete from user_passkeys where id = $1", [passkeyId]);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "user.passkey_removed",
      entityType: "user",
      entityId: auth.user.id,
      details: { name: found.rows[0].name, rpId: found.rows[0].rp_id },
    });
    return found.rows[0];
  });
  await sendSecurityAlert(auth.user.email, "a passkey was removed", [
    `The passkey "${removed.name}" was removed from your Tohyee login, and other sessions signed in with it were signed out.`,
    "AI apps, AI keys, farm app keys and PowerPoint add-in sign-ins you connected keep working. Changing your password disconnects them all if you need to.",
  ]);
}

/**
 * A server admin removes all of someone's passkeys (a lost or stolen phone).
 * Their passkey sessions end, and so does everything that could carry on
 * acting as them, as when a server admin removes Google sign-in (decision
 * 850): AI keys and connections, farm app keys, PowerPoint add-in sign-ins.
 */
export async function removeUserPasskeys(actor: AdminActor, userId: string): Promise<{ removed: number }> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new NotFoundError("User not found.");
  const result = await withCoreTransaction(async (client) => {
    const found = await client.query<{ email: string }>("select email from users where id = $1 for update", [userId]);
    if (!found.rows[0]) throw new NotFoundError("User not found.");
    const removed = await endPasskeys(client, userId);
    if (removed === 0) throw new ConflictError(`${found.rows[0].email} has no passkeys.`);
    const aiKeysRevoked = await revokeUserAiKeys(client, userId);
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "user.passkeys_removed",
      entityType: "user",
      entityId: userId,
      details: { removed, aiKeysRevoked },
    });
    return { email: found.rows[0].email, removed };
  });
  await sendSecurityAlert(result.email, "your passkeys were removed", [
    `A server admin (${actor.email}) removed ${result.removed === 1 ? "your passkey" : `your ${result.removed} passkeys`} from your Tohyee login and signed out the sessions they signed in.`,
    "Your AI apps, AI keys, farm app keys and PowerPoint add-in sign-ins were disconnected too. Connect again the ones you still use.",
    "You can still sign in with your password (or Google), and add a passkey again under Your account.",
  ]);
  return { removed: result.removed };
}

// ---------------------------------------------------------------------------
// Signing in

function browserCookie(request: Request, value: string, maxAge: number): string {
  const parts = [`${PASSKEY_BROWSER_COOKIE}=${value}`, `Path=${COOKIE_PATH}`, "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * The options for "Sign in with a passkey": no email, no list of passkeys
 * (so the page says nothing about who has a login), just a challenge tied to
 * this browser by a cookie.
 */
export async function startPasskeySignIn(request: Request): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; cookie: string }> {
  const { origin, rpId } = await usableAddress(request);
  const kept = readCookie(request, PASSKEY_BROWSER_COOKIE);
  const browser = kept && /^[A-Za-z0-9_-]{43}$/.test(kept) ? kept : randomBytes(32).toString("base64url");
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    challenge: new Uint8Array(randomBytes(32)),
    timeout: CHALLENGE_MINUTES * 60 * 1000,
    userVerification: "required",
  });
  await coreQuery(
    "insert into passkey_challenges (challenge_hash, purpose, browser_hash, rp_id, origin, created_at) values ($1, 'sign_in', $2, $3, $4, $5)",
    [sha256Hex(options.challenge), sha256Hex(browser), rpId, origin, clock()],
  );
  await coreQuery("delete from passkey_challenges where created_at < now() - interval '1 day'");
  // The cookie lasts as long as a challenge; asking again keeps the same one.
  return { options, cookie: browserCookie(request, browser, CHALLENGE_MINUTES * 60) };
}

type SignedIn = { user: SessionUser; token: string };

/** A refusal to show, recorded in the sign-in monitor first. */
async function refuse(request: Request, error: HttpError, who: { userId?: string | null; outcome?: SignInOutcome; warning?: string }): Promise<never> {
  await logSignIn(request, { email: null, userId: who.userId ?? null, step: "passkey", outcome: who.outcome ?? "failed", detail: error.message, warning: who.warning ?? null });
  throw error;
}

const DIDNT_WORK = "That passkey didn't work. Try again, or sign in with your password.";

type CredentialRow = {
  id: string;
  user_id: string;
  public_key: Buffer;
  sign_count: string;
  transports: string[];
  rp_id: string;
  name: string;
  email: string;
  display_name: string;
  is_server_admin: boolean;
  is_active: boolean;
  handle: string | null;
};

/** Checks a passkey's answer and signs in: a full session, counted as two-step (decision 887). */
export async function finishPasskeySignIn(request: Request, input: { response?: unknown }): Promise<SignedIn> {
  const { origin } = await usableAddress(request);
  const response = input.response && typeof input.response === "object" && !Array.isArray(input.response) ? (input.response as Record<string, unknown>) : null;
  const inner = response?.response && typeof response.response === "object" ? (response.response as Record<string, unknown>) : null;
  const credentialId = typeof response?.id === "string" && /^[A-Za-z0-9_-]{16,1400}$/.test(response.id) ? response.id : null;
  const challenge = inner ? challengeIn(inner.clientDataJSON) : null;
  if (!response || !inner || !credentialId || !challenge) return refuse(request, new ValidationError(DIDNT_WORK), {});

  // Used once, within 5 minutes, from the browser that asked for it: a copied or replayed answer does nothing.
  const browser = readCookie(request, PASSKEY_BROWSER_COOKIE) ?? "";
  const claimed = browser && browser.length <= 100 ? await claimChallenge(challenge, { purpose: "sign_in", browser }) : null;
  if (!claimed) return refuse(request, new UnauthorizedError("This passkey sign-in took too long, or was already used. Try again."), {});
  if (claimed.origin !== origin) return refuse(request, new UnauthorizedError(DIDNT_WORK), {});

  const found = await coreQuery<CredentialRow>(
    `select p.id::text, p.user_id::text, p.public_key, p.sign_count::text, p.transports, p.rp_id, p.name,
            u.email, u.display_name, u.is_server_admin, u.is_active, u.passkey_user_handle as handle
       from user_passkeys p join users u on u.id = p.user_id where p.credential_id = $1`,
    [credentialId],
  );
  const credential = found.rows[0];
  if (!credential) {
    // The browser can tell the phone to forget it (signalUnknownCredential).
    return refuse(
      request,
      new HttpError(401, "unknown_passkey", "That passkey isn't on any login here: it may have been removed. Sign in with your password, then add it again.", {
        unknownCredential: { rpId: claimed.rp_id, credentialId },
      }),
      {},
    );
  }
  const who = { userId: credential.user_id };
  if (credential.rp_id !== claimed.rp_id) return refuse(request, new UnauthorizedError(`That passkey was made ${passkeyPlace(credential.rp_id)}, so it only works there.`), who);
  // The passkey must say it's this login's: a passkey can't be passed off as someone else's.
  const handle = typeof inner.userHandle === "string" ? inner.userHandle : null;
  if (!handle || !credential.handle || handle !== credential.handle) return refuse(request, new UnauthorizedError(DIDNT_WORK), { ...who, outcome: "refused" });
  if (!credential.is_active) return refuse(request, new ForbiddenError("This login is turned off. Ask your server admin."), { ...who, outcome: "refused" });

  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: claimed.origin,
      expectedRPID: claimed.rp_id,
      // The use count is checked below, by Tohyee's own rule (checkCounter).
      credential: { id: credentialId, publicKey: new Uint8Array(credential.public_key), counter: 0, transports: credential.transports },
      requireUserVerification: true,
    });
  } catch (error) {
    console.warn("[tohyee] A passkey sign-in wasn't accepted:", error instanceof Error ? error.message : error);
    return refuse(request, new UnauthorizedError(DIDNT_WORK), who);
  }
  if (!verified.verified || !verified.authenticationInfo.userVerified) return refuse(request, new UnauthorizedError(DIDNT_WORK), who);
  const info = verified.authenticationInfo;

  const outcome = await withCoreTransaction(async (client) => {
    // Locked, so two sign-ins at once compare against the same count.
    const now = await client.query<{ sign_count: string }>("select sign_count::text from user_passkeys where id = $1 for update", [credential.id]);
    if (!now.rows[0]) return { kind: "gone" as const };
    const stored = Number(now.rows[0].sign_count);
    const check = checkCounter(stored, info.newCounter);
    if (check === "refuse") return { kind: "cloned" as const, stored };
    await client.query(
      "update user_passkeys set sign_count = greatest(sign_count, $2), last_used_at = now(), backed_up = $3, device_type = $4 where id = $1",
      [credential.id, info.newCounter, info.credentialBackedUp, info.credentialDeviceType],
    );
    await client.query("update users set last_login_at = now() where id = $1", [credential.user_id]);
    const session = await createSession(client, credential.user_id, sessionMetaFrom(request), { method: "passkey", passkeyId: credential.id });
    return { kind: "ok" as const, token: session.token, warn: check === "warn", stored };
  });
  if (outcome.kind === "gone") return refuse(request, new UnauthorizedError(DIDNT_WORK), who);
  if (outcome.kind === "cloned") {
    const warning = `The passkey "${credential.name}" gave a lower use count than before (${info.newCounter} after ${outcome.stored}), so it may have been copied`;
    await sendSecurityAlert(credential.email, "a passkey sign-in was refused", [
      `A sign-in with your passkey "${credential.name}" was refused because the passkey's use count went backwards, which can mean it was copied.`,
      "If you don't know why, remove that passkey under Your account › Passkeys and change your password.",
    ]);
    return refuse(request, new ForbiddenError("That passkey was refused because it may have been copied. Sign in with your password, and check your passkeys under Your account."), {
      ...who,
      outcome: "refused",
      warning,
    });
  }
  await logSignIn(request, {
    email: null,
    userId: credential.user_id,
    step: "passkey",
    outcome: "signed_in",
    detail: `Passkey "${credential.name}"`,
    warning: outcome.warn ? `The passkey "${credential.name}" didn't count up (${info.newCounter} after ${outcome.stored}); allowed, but worth checking` : null,
  });
  return {
    user: { id: credential.user_id, email: credential.email, displayName: credential.display_name, isServerAdmin: credential.is_server_admin },
    token: outcome.token,
  };
}

/** Whether to offer "Sign in with a passkey" on the sign-in page: only where passkeys work. Says nothing about who has one. */
export async function passkeySignInOffer(request: Request): Promise<{ available: boolean; problem: string | null }> {
  const address = await passkeyAddressFor(request);
  if (!address.problem) return { available: true, problem: null };
  // The note about addresses only shows once someone on this server has a passkey.
  const any = await coreQuery<{ any: boolean }>("select exists (select 1 from user_passkeys) as any");
  return { available: false, problem: any.rows[0]?.any ? address.problem : null };
}

/** For pages (the sign-in page), which have the request's headers rather than the request. */
export function requestFromHeaders(headers: Headers, path = "/"): Request {
  const host = headers.get("host")?.trim() || "localhost";
  try {
    return new Request(`http://${host}${path}`, { headers });
  } catch {
    return new Request(`http://localhost${path}`, { headers });
  }
}

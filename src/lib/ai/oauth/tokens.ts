import { writeAdminAuditEvent } from "@/lib/audit";
import type { AiAccessLevel } from "@/lib/ai/access-levels";
import { AI_ACCESS_LEVEL_LABELS } from "@/lib/ai/access-levels";
import { markClientUsed } from "@/lib/ai/oauth/clients";
import { type OAuthAddresses, oauthAddresses } from "@/lib/ai/oauth/config";
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_SECONDS,
  canonicalResource,
  looksLikeAccessToken,
  pkceMatches,
  randomToken,
  redirectHost,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_SECONDS,
  resourceIsOurs,
  sha256Hex,
} from "@/lib/ai/oauth/format";
import { type AiTokenIdentity, grantIdentity } from "@/lib/ai/tokens";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { coreQuery, type DbClient, withCoreTransaction } from "@/lib/db/transactions";
import { sendSecurityAlert } from "@/lib/email/mailer";
import { getMembership } from "@/lib/organisations/registry";

/*
 * The token endpoint and access tokens (decisions 814, 815, 817, 820).
 * Codes, access tokens and refresh tokens are 32 random bytes; only their
 * SHA-256 is kept. A code works once, within 5 minutes, with the right app,
 * redirect address and PKCE verifier; a second try with a used code ends
 * the connection it made. Each refresh token works once and comes back
 * replaced; a used one presented again ends the connection (someone has a
 * copy). Access tokens last an hour and only work at the MCP address they
 * were issued for.
 */

export class OAuthError extends Error {
  constructor(
    readonly error: "invalid_request" | "invalid_grant" | "invalid_client" | "unsupported_grant_type" | "invalid_target",
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export type TokenAnswer = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
};

type Form = { get(name: string): string | null };

function required(form: Form, name: string): string {
  const value = form.get(name);
  if (!value) throw new OAuthError("invalid_request", `${name} is missing.`);
  if (value.length > 2000) throw new OAuthError("invalid_request", `${name} is too long.`);
  return value;
}

async function needAddresses(): Promise<OAuthAddresses> {
  const addresses = await oauthAddresses();
  if (!addresses) throw new OAuthError("invalid_grant", "Remote access is off on this Tohyee server, so AI apps can't sign in.");
  return addresses;
}

/**
 * The audience check on the token endpoint (RFC 8707): an AI app's tokens
 * are for MCP, the PowerPoint add-in's for the Analytics API for Office
 * (#429, decision 833), and a `resource` asked for must be that one.
 */
function checkResource(form: Form, bound: string, addresses: OAuthAddresses, kind: "connection" | "office" = "connection"): void {
  const expected = kind === "office" ? addresses.officeResource : addresses.resource;
  const asked = form.get("resource");
  const fits = asked === null || (kind === "office" ? canonicalResource(asked) === canonicalResource(expected) : resourceIsOurs(asked, expected));
  if (!fits) throw new OAuthError("invalid_target", `Tokens for this app are only for ${expected}.`);
  if (bound !== expected) throw new OAuthError("invalid_grant", "Tohyee's address has changed since this app signed in. Connect it again.");
}

async function issueTokens(client: DbClient, connectionId: string): Promise<TokenAnswer> {
  const access = randomToken(ACCESS_TOKEN_PREFIX);
  const refresh = randomToken(REFRESH_TOKEN_PREFIX);
  await client.query("delete from oauth_tokens where connection_id = $1 and expires_at < now() - interval '1 day'", [connectionId]);
  await client.query(
    `insert into oauth_tokens (token_hash, connection_id, kind, expires_at) values
       ($1, $3, 'access', now() + make_interval(secs => $4)),
       ($2, $3, 'refresh', now() + make_interval(secs => $5))`,
    [sha256Hex(access), sha256Hex(refresh), connectionId, ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_SECONDS],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh };
}

/** Ends a connection because a code or refresh token was used twice. */
async function endForReuse(connectionId: string, what: "code" | "refresh_token"): Promise<void> {
  await withCoreTransaction(async (client) => {
    const ended = await client.query<{ user_id: string; email: string; organisation_id: string | null; name: string; kind: string }>(
      `update ai_access_tokens t set revoked_at = now() from users u
        where t.id = $1 and t.revoked_at is null and u.id = t.user_id
        returning t.user_id, u.email, t.organisation_id, t.name, t.kind`,
      [connectionId],
    );
    const row = ended.rows[0];
    if (!row) return;
    await writeAdminAuditEvent(client, { userId: row.user_id, email: row.email }, {
      eventType: row.kind === "office" ? "office_connection.ended_reused" : "ai_connection.ended_reused",
      entityType: row.organisation_id ? "organisation" : "user",
      entityId: row.organisation_id ?? row.user_id,
      details: { connectionId, app: row.name, reused: what },
    });
  });
}

type CodeRow = {
  user_id: string;
  organisation_id: string | null;
  kind: "connection" | "office";
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  access_level: AiAccessLevel;
  fresh: boolean;
};

let exchangePauseForTests: (() => Promise<void>) | null = null;
/** Lets a test hold a code exchange part-way through its transaction, to check what happens beside it. */
export function setCodeExchangePauseForTests(pause: (() => Promise<void>) | null): void {
  exchangePauseForTests = pause;
}

type Exchanged =
  | { kind: "refused"; error: OAuthError; reusedConnectionId?: string | null }
  | { kind: "connection"; answer: TokenAnswer; row: CodeRow; email: string; organisationName: string }
  | { kind: "office"; answer: TokenAnswer; row: CodeRow; email: string };

/**
 * grant_type=authorization_code: makes the connection and its first tokens.
 *
 * Claiming the code, checking the person and their membership, and making
 * the connection are one transaction that first takes a share lock on the
 * person's row (decision 853). Everything that revokes their apps (a
 * password or two-step reset, a server admin removing Google sign-in) locks
 * that row for update first, and removing a membership locks the
 * membership row, so either the exchange finishes first and the revoke ends
 * the new connection, or the revoke finishes first and the code is refused.
 * A refused code still counts as used.
 */
export async function exchangeCode(form: Form): Promise<TokenAnswer> {
  const addresses = await needAddresses();
  const code = required(form, "code");
  const clientId = required(form, "client_id");
  const redirectUri = required(form, "redirect_uri");
  const verifier = required(form, "code_verifier");
  const codeHash = sha256Hex(code);
  const outcome = await withCoreTransaction<Exchanged>(async (client) => {
    // Locks in this order, before the code: the person, then their membership (an AI app's code), then the code.
    const owner = await client.query<{ user_id: string; organisation_id: string | null }>("select user_id::text, organisation_id from oauth_authorization_codes where code_hash = $1", [codeHash]);
    const found = owner.rows[0];
    const person = found
      ? (await client.query<{ email: string; is_active: boolean }>("select email, is_active from users where id = $1 for share", [found.user_id])).rows[0]
      : undefined;
    // The membership is held until this commits, so removing them waits and then ends the connection.
    const member = found?.organisation_id
      ? Boolean((await client.query("select 1 from organisation_members where organisation_id = $1 and user_id = $2 for share", [found.organisation_id, found.user_id])).rowCount)
      : false;
    const claimed = await client.query<CodeRow>(
      `update oauth_authorization_codes set used_at = now() where code_hash = $1 and used_at is null
       returning user_id::text, organisation_id, kind, client_id, client_name, redirect_uri, code_challenge, resource, access_level, expires_at > now() as fresh`,
      [codeHash],
    );
    const row = claimed.rows[0];
    if (!row) {
      // A used code again: whatever it made is ended (OAuth 2.1 section 4.1.3), after this transaction.
      const used = await client.query<{ connection_id: string | null }>("select connection_id::text from oauth_authorization_codes where code_hash = $1", [codeHash]);
      return { kind: "refused", error: new OAuthError("invalid_grant", "That code isn't valid. Start connecting again."), reusedConnectionId: used.rows[0]?.connection_id ?? null };
    }
    if (exchangePauseForTests) await exchangePauseForTests();
    try {
      if (!row.fresh) throw new OAuthError("invalid_grant", "That code has expired. Start connecting again.");
      if (row.client_id !== clientId) throw new OAuthError("invalid_grant", "That code was given to a different app.");
      if (row.redirect_uri !== redirectUri) throw new OAuthError("invalid_grant", "redirect_uri isn't the one the code was given for.");
      if (!pkceMatches(verifier, row.code_challenge)) throw new OAuthError("invalid_grant", "The PKCE code_verifier doesn't match.");
      checkResource(form, row.resource, addresses, row.kind);
      if (!person?.is_active) throw new OAuthError("invalid_grant", "That code isn't valid. Start connecting again.");
      if (row.kind === "office") return { kind: "office", answer: await connectOffice(client, row, person.email, codeHash), row, email: person.email };
      // The person must still be able to use the organisation, as for a key (decision 341).
      const membership = member && row.organisation_id ? await getMembership(row.organisation_id, row.user_id) : null;
      if (!membership || !membership.organisation.isActive || !roleAtLeast(membership.role as Role, "viewer")) {
        throw new OAuthError("invalid_grant", "That code isn't valid. Start connecting again.");
      }
      const organisationId = membership.organisation.id;
      const inserted = await client.query<{ id: string }>(
        `insert into ai_access_tokens (user_id, organisation_id, name, created_by_email, access_level, kind, oauth_client_id, redirect_uri, resource)
         values ($1, $2, $3, $4, $5, 'connection', $6, $7, $8) returning id::text`,
        [row.user_id, row.organisation_id, row.client_name, person.email, row.access_level, row.client_id, row.redirect_uri, row.resource],
      );
      const connectionId = inserted.rows[0].id;
      await client.query("update oauth_authorization_codes set connection_id = $1 where code_hash = $2", [connectionId, codeHash]);
      await writeAdminAuditEvent(client, { userId: row.user_id, email: person.email }, {
        eventType: "ai_connection.connected",
        entityType: "organisation",
        entityId: organisationId,
        details: { connectionId, app: row.client_name, redirectHost: redirectHost(row.redirect_uri), accessLevel: row.access_level },
      });
      return { kind: "connection", answer: await issueTokens(client, connectionId), row, email: person.email, organisationName: membership.organisation.displayName };
    } catch (caught) {
      // Refused, but the code stays used: the claim above commits.
      if (caught instanceof OAuthError) return { kind: "refused", error: caught };
      throw caught;
    }
  });
  if (outcome.kind === "refused") {
    if (outcome.reusedConnectionId) await endForReuse(outcome.reusedConnectionId, "code");
    throw outcome.error;
  }
  const { row, email } = outcome;
  if (outcome.kind === "office") {
    await sendSecurityAlert(email, "you signed in to the PowerPoint add-in", [
      `"${row.client_name}" was signed in to Tohyee as you. It can read the Analytics reports you can see, in every organisation you belong to, and can't change anything.`,
      "You can see and sign it out under Your account › Connected apps in Tohyee.",
    ]);
    return outcome.answer;
  }
  await markClientUsed(row.client_id);
  await sendSecurityAlert(email, "an AI app was connected", [
    `"${row.client_name}" (sending you back to ${redirectHost(row.redirect_uri)}) was connected to ${outcome.organisationName} in Tohyee, as you, at the level "${AI_ACCESS_LEVEL_LABELS[row.access_level]}".`,
    "You can see and disconnect it on the AI page in Tohyee.",
  ]);
  return outcome.answer;
}

/**
 * The PowerPoint add-in's code swapped for its connection and first tokens
 * (#429, decisions 835-836): the person's, not one organisation's, always
 * the read level; which organisations it reaches is checked on every request.
 * Inside the exchange's transaction (decision 853).
 */
async function connectOffice(client: DbClient, row: CodeRow, email: string, codeHash: string): Promise<TokenAnswer> {
  const inserted = await client.query<{ id: string }>(
    `insert into ai_access_tokens (user_id, organisation_id, name, created_by_email, access_level, kind, oauth_client_id, redirect_uri, resource)
     values ($1, null, $2, $3, 'read', 'office', $4, $5, $6) returning id::text`,
    [row.user_id, row.client_name, email, row.client_id, row.redirect_uri, row.resource],
  );
  const connectionId = inserted.rows[0].id;
  await client.query("update oauth_authorization_codes set connection_id = $1 where code_hash = $2", [connectionId, codeHash]);
  await writeAdminAuditEvent(client, { userId: row.user_id, email }, {
    eventType: "office_connection.connected",
    entityType: "user",
    entityId: row.user_id,
    details: { connectionId, app: row.client_name },
  });
  return issueTokens(client, connectionId);
}

/** grant_type=refresh_token: a new access token and a new refresh token; the old refresh token stops. */
export async function refreshTokens(form: Form): Promise<TokenAnswer> {
  const addresses = await needAddresses();
  const refresh = required(form, "refresh_token");
  const clientId = required(form, "client_id");
  const claimed = await coreQuery<{ connection_id: string }>(
    `update oauth_tokens set used_at = now() where token_hash = $1 and kind = 'refresh' and used_at is null and expires_at > now() returning connection_id::text`,
    [sha256Hex(refresh)],
  );
  const connectionId = claimed.rows[0]?.connection_id;
  if (!connectionId) {
    const used = await coreQuery<{ connection_id: string }>("select connection_id::text from oauth_tokens where token_hash = $1 and kind = 'refresh' and used_at is not null", [sha256Hex(refresh)]);
    if (used.rows[0]) await endForReuse(used.rows[0].connection_id, "refresh_token");
    throw new OAuthError("invalid_grant", "That refresh token isn't valid. Connect the app again.");
  }
  const connection = await coreQuery<{ oauth_client_id: string; resource: string; kind: "connection" | "office" }>("select oauth_client_id, resource, kind from ai_access_tokens where id = $1", [connectionId]);
  if (connection.rows[0]?.oauth_client_id !== clientId) {
    // Someone else's refresh token: it's used up now, so the real app's next refresh ends the connection.
    throw new OAuthError("invalid_grant", "That refresh token was given to a different app.");
  }
  const kind = connection.rows[0].kind === "office" ? "office" : "connection";
  checkResource(form, connection.rows[0].resource, addresses, kind);
  const identity = kind === "office" ? await officeGrant("t.id = $1", [connectionId]) : await grantIdentity("t.id = $1 and t.kind = 'connection'", [connectionId]);
  if (!identity) throw new OAuthError("invalid_grant", "This connection has ended. Connect the app again.");
  return withCoreTransaction((client) => issueTokens(client, connectionId));
}

/** RFC 7009: a refresh token ends its connection; an access token just stops. Unknown tokens are fine. */
export async function revokeToken(form: Form): Promise<void> {
  const token = form.get("token");
  if (!token || token.length > 2000) return;
  const found = await coreQuery<{ connection_id: string; kind: "access" | "refresh"; oauth_client_id: string; connection_kind: string }>(
    `select o.connection_id::text, o.kind, t.oauth_client_id, t.kind as connection_kind from oauth_tokens o join ai_access_tokens t on t.id = o.connection_id where o.token_hash = $1`,
    [sha256Hex(token)],
  );
  const row = found.rows[0];
  if (!row) return;
  const clientId = form.get("client_id");
  if (clientId && clientId !== row.oauth_client_id) return;
  if (row.kind === "access") {
    await coreQuery("update oauth_tokens set expires_at = now() where token_hash = $1", [sha256Hex(token)]);
    return;
  }
  await withCoreTransaction(async (client) => {
    const ended = await client.query<{ user_id: string; email: string; organisation_id: string | null; name: string }>(
      `update ai_access_tokens t set revoked_at = now() from users u where t.id = $1 and t.revoked_at is null and u.id = t.user_id returning t.user_id, u.email, t.organisation_id, t.name`,
      [row.connection_id],
    );
    const done = ended.rows[0];
    if (done) {
      await writeAdminAuditEvent(client, { userId: done.user_id, email: done.email }, {
        eventType: row.connection_kind === "office" ? "office_connection.disconnected" : "ai_connection.disconnected",
        entityType: done.organisation_id ? "organisation" : "user",
        entityId: done.organisation_id ?? done.user_id,
        details: { tokenId: row.connection_id, name: done.name, by: "app" },
      });
    }
  });
}

/**
 * Who an access token acts as, or null: it must be unexpired, its
 * connection working (the same checks as a key, decision 820), and issued
 * for Tohyee's MCP address as it is now (RFC 8707 audience). With remote
 * access off no access token works. A PowerPoint add-in token (kind
 * 'office', decision 833) is never one of these.
 */
export async function authenticateAccessToken(token: string): Promise<AiTokenIdentity | null> {
  if (!looksLikeAccessToken(token)) return null;
  const addresses = await oauthAddresses();
  if (!addresses) return null;
  return grantIdentity(
    "t.kind = 'connection' and t.id = (select connection_id from oauth_tokens where token_hash = $1 and kind = 'access' and expires_at > now())",
    [sha256Hex(token)],
    (row) => row.resource === addresses.resource,
  );
}

/** Who a PowerPoint add-in connection acts as (#429): the person, while their login is on. Organisations are checked per request. */
export type OfficeIdentity = {
  connectionId: string;
  user: { id: string; email: string; displayName: string };
};

const OFFICE_LAST_USED_EVERY_MS = 60_000;

/** The working PowerPoint add-in connection `where` finds (on `ai_access_tokens t`): not ended, of kind 'office', its person's login on. */
async function officeGrant(where: string, values: unknown[], resource?: string): Promise<OfficeIdentity | null> {
  const found = await coreQuery<{ id: string; user_id: string; email: string; display_name: string; last_used_at: string | null; resource: string }>(
    `select t.id::text, t.user_id::text, u.email, u.display_name, t.last_used_at, t.resource
       from ai_access_tokens t join users u on u.id = t.user_id
      where ${where} and t.kind = 'office' and t.revoked_at is null and u.is_active`,
    values,
  );
  const row = found.rows[0];
  if (!row || (resource !== undefined && row.resource !== resource)) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > OFFICE_LAST_USED_EVERY_MS) {
    await coreQuery("update ai_access_tokens set last_used_at = now() where id = $1", [row.id]);
  }
  return { connectionId: row.id, user: { id: row.user_id, email: row.email, displayName: row.display_name } };
}

/**
 * Who a PowerPoint add-in access token acts as, or null (#429, decision
 * 833): an unexpired access token of an office connection, issued for the
 * Analytics API for Office at the remote access address as it is now. An AI
 * app's token (for MCP) and an AI key never work here.
 */
export async function authenticateOfficeToken(token: string): Promise<OfficeIdentity | null> {
  if (!looksLikeAccessToken(token)) return null;
  const addresses = await oauthAddresses();
  if (!addresses) return null;
  return officeGrant(
    "t.id = (select connection_id from oauth_tokens where token_hash = $1 and kind = 'access' and expires_at > now())",
    [sha256Hex(token)],
    addresses.officeResource,
  );
}

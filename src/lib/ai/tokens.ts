import { writeAdminAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { coreQuery, type DbClient, withCoreTransaction } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { getMembership, type Membership } from "@/lib/organisations/registry";
import { readServerSetting } from "@/lib/server-settings";
import { requireId, requireString } from "@/lib/validation";
import { type AiAccessLevel, effectiveAccessLevel, isAiAccessLevel } from "@/lib/ai/access-levels";
import { aiTokenDisplayPrefix, AI_TOKEN_PREFIX, hashAiToken, newAiToken } from "@/lib/ai/token-format";
import { ValidationError } from "@/lib/errors";
import { redirectHost } from "@/lib/ai/oauth/format";

/** At most this many keys that aren't revoked, per person per organisation (decision 341). */
export const MAX_ACTIVE_AI_TOKENS = 10;
/** last_used_at is written at most this often per key. */
const LAST_USED_EVERY_MS = 60_000;

/**
 * A key, or an AI app connected by signing in (a "connection", #427,
 * decision 811), as the AI page lists it. Never includes a key, token or
 * hash.
 */
export type AiAccessToken = {
  id: string;
  /** "key" for a key made on the AI page; "connection" for an app that signed in. */
  kind: "key" | "connection";
  /** The key's name, or the app's name as it gave it (cleaned). */
  name: string;
  /** e.g. "tohyee_ai_abcd1234" (the start of the key); null for a connection. */
  startsWith: string | null;
  /** For a connection: where it sends people back to after signing in (e.g. "claude.ai"). */
  appHost: string | null;
  /** For a connection: it hasn't been used for 60 days, so it can't get new tokens (it has to sign in again). */
  expired: boolean;
  /** What it may do (decision 346), before the owner's role caps it. */
  accessLevel: AiAccessLevel;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type TokenRow = {
  id: string;
  kind: "key" | "connection";
  name: string;
  token_prefix: string | null;
  redirect_uri: string | null;
  expired: boolean;
  access_level: AiAccessLevel;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** A connection has expired when it has no access token left and no unused refresh token that hasn't run out. */
const TOKEN_COLUMNS = `ai_access_tokens.id::text, kind, name, token_prefix, redirect_uri, access_level, created_at, last_used_at, revoked_at,
  (kind = 'connection' and not exists (
     select 1 from oauth_tokens o where o.connection_id = ai_access_tokens.id and o.expires_at > now() and (o.kind = 'access' or o.used_at is null)
   )) as expired`;

function toToken(row: TokenRow): AiAccessToken {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    startsWith: row.token_prefix ? `${AI_TOKEN_PREFIX}${row.token_prefix}` : null,
    appHost: row.redirect_uri ? redirectHost(row.redirect_uri) : null,
    expired: row.kind === "connection" && row.expired,
    accessLevel: row.access_level,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** The signed-in person's own keys and connections for one organisation, newest first. */
export async function listAiTokens(auth: AuthContext, organisationId: string): Promise<AiAccessToken[]> {
  const result = await coreQuery<TokenRow>(
    `select ${TOKEN_COLUMNS} from ai_access_tokens
      where organisation_id = $1 and user_id = $2
      order by revoked_at is not null, ai_access_tokens.id desc`,
    [organisationId, auth.user.id],
  );
  return result.rows.map(toToken);
}

/**
 * Makes a key for the signed-in person in one organisation. The key is
 * returned here once and never again; only its SHA-256 is stored.
 */
export async function createAiToken(
  auth: AuthContext,
  organisationId: string,
  input: { name: unknown; accessLevel?: unknown; role: Role; confirmFullAccess?: unknown },
): Promise<{ token: string; key: AiAccessToken }> {
  const name = requireString(input.name, "Name", { maxLength: 100 });
  const accessLevel = input.accessLevel == null || input.accessLevel === "" ? "read" : input.accessLevel;
  if (!isAiAccessLevel(accessLevel)) {
    throw new ValidationError("accessLevel must be read, draft, post or full.");
  }
  // Full access (decision 488): Owners only, after reading the warning.
  if (accessLevel === "full") {
    if (!roleAtLeast(input.role, "owner")) throw new ForbiddenError("Only an Owner can make a Full access AI key.");
    if (input.confirmFullAccess !== true) {
      throw new ValidationError("Read the warning about Full access keys and tick the box to confirm before making one.");
    }
  }
  const token = newAiToken();
  const key = await withCoreTransaction(async (client) => {
    // Serialise per person and organisation so the limit holds.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`ai-tokens:${organisationId}:${auth.user.id}`]);
    const active = await client.query<{ count: string }>(
      `select count(*)::text as count from ai_access_tokens
        where organisation_id = $1 and user_id = $2 and revoked_at is null and kind = 'key'`,
      [organisationId, auth.user.id],
    );
    if (Number(active.rows[0].count) >= MAX_ACTIVE_AI_TOKENS) {
      throw new ConflictError(
        `You already have ${MAX_ACTIVE_AI_TOKENS} AI keys for this organisation. Revoke one you no longer use first.`,
      );
    }
    const inserted = await client.query<TokenRow>(
      `insert into ai_access_tokens (user_id, organisation_id, name, token_hash, token_prefix, created_by_email, access_level)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${TOKEN_COLUMNS}`,
      [auth.user.id, organisationId, name, hashAiToken(token), aiTokenDisplayPrefix(token), auth.user.email, accessLevel],
    );
    const row = inserted.rows[0];
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "ai_access_token.created",
      entityType: "organisation",
      entityId: organisationId,
      details: { tokenId: row.id, name, accessLevel, startsWith: `${AI_TOKEN_PREFIX}${row.token_prefix}` },
    });
    return toToken(row);
  });
  return { token, key };
}

/** Revokes one of the signed-in person's own keys, or disconnects one of their connections (decision 821). Revoking twice is fine. */
export async function revokeAiToken(auth: AuthContext, organisationId: string, tokenIdInput: unknown): Promise<AiAccessToken> {
  const tokenId = requireId(tokenIdInput, "tokenId");
  return withCoreTransaction(async (client) => {
    const found = await client.query<TokenRow>(
      `select ${TOKEN_COLUMNS} from ai_access_tokens
        where ai_access_tokens.id = $1 and organisation_id = $2 and user_id = $3
        for update of ai_access_tokens`,
      [tokenId, organisationId, auth.user.id],
    );
    const row = found.rows[0];
    if (!row) throw new NotFoundError("AI key not found.");
    if (row.revoked_at) return toToken(row);
    const updated = await client.query<TokenRow>(
      `update ai_access_tokens set revoked_at = now() where id = $1 returning ${TOKEN_COLUMNS}`,
      [tokenId],
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: row.kind === "connection" ? "ai_connection.disconnected" : "ai_access_token.revoked",
      entityType: "organisation",
      entityId: organisationId,
      details: { tokenId, name: row.name },
    });
    return toToken(updated.rows[0]);
  });
}

/** Who an AI key (or connection) acts as, when it's still good. */
export type AiTokenIdentity = {
  tokenId: string;
  /** A key, or an app connected by signing in (decision 811); the history names them differently. */
  kind: "key" | "connection";
  tokenName: string;
  /** The level the key was made with. */
  accessLevel: AiAccessLevel;
  /** That level capped by the owner's role now (decision 346). */
  effectiveLevel: AiAccessLevel;
  user: { id: string; email: string; displayName: string };
  membership: Membership;
};

/**
 * How a key or connection shows in the history and on drafts: AI key
 * "Claude on my laptop", or AI app "Claude" for an app that signed in
 * (decision 822). An app's name is its own claim, so "AI app" says what it is.
 */
export function aiKeyVia(identity: Pick<AiTokenIdentity, "tokenName"> & { kind?: AiTokenIdentity["kind"] }): string {
  return identity.kind === "connection" ? `AI app "${identity.tokenName}"` : `AI key "${identity.tokenName}"`;
}

/**
 * Looks a key up (by its hash). It works only while it isn't revoked, its
 * owner's login is active, and they're still a member of the organisation
 * (viewer or higher, with their current role). Anything else is null, and
 * callers answer every refusal the same way. The organisation being ready is
 * checked when its transaction opens.
 */
export async function authenticateAiToken(token: string): Promise<AiTokenIdentity | null> {
  return grantIdentity("t.token_hash = $1 and t.kind = 'key'", [hashAiToken(token)]);
}

/** The row a key or a connection's token leads to, and the person it acts as. */
export type GrantRow = {
  id: string;
  kind: "key" | "connection";
  name: string;
  organisation_id: string;
  user_id: string;
  email: string;
  display_name: string;
  last_used_at: string | null;
  access_level: AiAccessLevel;
  resource: string | null;
};

/**
 * The identity for the key or connection `where` finds (on `ai_access_tokens
 * t`), with every check a key has (decision 341): not revoked, the person's
 * login active, still a member (viewer or higher) of a ready organisation,
 * with their role now. A connection's tokens use this too, so a connection
 * ends exactly when a key would (decision 820).
 */
export async function grantIdentity(where: string, values: unknown[], extra: (row: GrantRow) => boolean = () => true): Promise<AiTokenIdentity | null> {
  const found = await coreQuery<GrantRow>(
    `select t.id::text, t.kind, t.name, t.organisation_id, t.user_id, u.email, u.display_name, t.last_used_at, t.access_level, t.resource
       from ai_access_tokens t
       join users u on u.id = t.user_id
      where ${where} and t.revoked_at is null and u.is_active`,
    values,
  );
  const row = found.rows[0];
  if (!row || !extra(row)) return null;
  const membership = await getMembership(row.organisation_id, row.user_id);
  if (!membership || !membership.organisation.isActive || !roleAtLeast(membership.role as Role, "viewer")) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > LAST_USED_EVERY_MS) {
    await coreQuery("update ai_access_tokens set last_used_at = now() where id = $1", [row.id]);
  }
  return {
    tokenId: row.id,
    kind: row.kind,
    tokenName: row.name,
    accessLevel: row.access_level,
    effectiveLevel: effectiveAccessLevel(row.access_level, membership.role),
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
    membership,
  };
}

/**
 * The server's remote access address when remote access is on (e.g.
 * https://glimmers.tohyee.nz), or null. AI services in the cloud reach
 * Tohyee through it; the AI page builds the MCP address from it. It's the
 * address people already use from outside, not a secret.
 */
export async function remoteAccessAddress(): Promise<string | null> {
  const stored = await readServerSetting<{ enabled?: boolean; publicUrl?: string | null }, Record<string, never>>("remote_access");
  return stored.value.enabled && stored.value.publicUrl ? stored.value.publicUrl.replace(/\/+$/, "") : null;
}

/**
 * Stops every AI key and farm app key a person made, in every organisation (#132): when their
 * password is changed or reset, their two-step sign-in is reset, or a server
 * admin removes their Google sign-in (decision 850), a key made by whoever
 * had their account shouldn't keep working. AI app and PowerPoint add-in
 * connections are rows of ai_access_tokens too, so they (and their access and
 * refresh tokens) stop with the keys. Returns how many keys, connections and
 * farm app keys. Locks the person's row first (decision 853).
 */
export async function revokeUserAiKeys(client: DbClient, userId: string): Promise<number> {
  // The person's row, locked first: a code being swapped for a connection holds it shared until it
  // commits, so that connection either ends here or its code is refused (decision 853).
  await client.query("select 1 from users where id = $1 for update", [userId]);
  const revoked = await client.query("update ai_access_tokens set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]);
  // Farm app keys (FA2, decision 561) stop for the same reason; they're counted with the AI keys.
  const apps = await client.query("update farm_app_keys set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]);
  // Connections are rows above, so they end too; a code handed out but not yet swapped for tokens stops as well (decision 820).
  await client.query("update oauth_authorization_codes set used_at = now() where user_id = $1 and used_at is null", [userId]);
  return (revoked.rowCount ?? 0) + (apps.rowCount ?? 0);
}

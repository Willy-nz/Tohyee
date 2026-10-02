import { writeAdminAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { getMembership, type Membership } from "@/lib/organisations/registry";
import { readServerSetting } from "@/lib/server-settings";
import { requireId, requireString } from "@/lib/validation";
import { type AiAccessLevel, effectiveAccessLevel, isAiAccessLevel } from "@/lib/ai/access-levels";
import { aiTokenDisplayPrefix, AI_TOKEN_PREFIX, hashAiToken, newAiToken } from "@/lib/ai/token-format";
import { ValidationError } from "@/lib/errors";

/** At most this many keys that aren't revoked, per person per organisation (decision 341). */
export const MAX_ACTIVE_AI_TOKENS = 10;
/** last_used_at is written at most this often per key. */
const LAST_USED_EVERY_MS = 60_000;

/** A key as the AI page lists it. Never includes the key or its hash. */
export type AiAccessToken = {
  id: string;
  name: string;
  /** e.g. "tohyee_ai_abcd1234" (the start of the key). */
  startsWith: string;
  /** What it may do (decision 346), before the owner's role caps it. */
  accessLevel: AiAccessLevel;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type TokenRow = {
  id: string;
  name: string;
  token_prefix: string;
  access_level: AiAccessLevel;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

const TOKEN_COLUMNS = "id::text, name, token_prefix, access_level, created_at, last_used_at, revoked_at";

function toToken(row: TokenRow): AiAccessToken {
  return {
    id: row.id,
    name: row.name,
    startsWith: `${AI_TOKEN_PREFIX}${row.token_prefix}`,
    accessLevel: row.access_level,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** The signed-in person's own keys for one organisation, newest first. */
export async function listAiTokens(auth: AuthContext, organisationId: string): Promise<AiAccessToken[]> {
  const result = await coreQuery<TokenRow>(
    `select ${TOKEN_COLUMNS} from ai_access_tokens
      where organisation_id = $1 and user_id = $2
      order by revoked_at is not null, id desc`,
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
  input: { name: unknown; accessLevel?: unknown },
): Promise<{ token: string; key: AiAccessToken }> {
  const name = requireString(input.name, "Name", { maxLength: 100 });
  const accessLevel = input.accessLevel == null || input.accessLevel === "" ? "read" : input.accessLevel;
  if (!isAiAccessLevel(accessLevel)) {
    throw new ValidationError("accessLevel must be read, draft or post.");
  }
  const token = newAiToken();
  const key = await withCoreTransaction(async (client) => {
    // Serialise per person and organisation so the limit holds.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`ai-tokens:${organisationId}:${auth.user.id}`]);
    const active = await client.query<{ count: string }>(
      `select count(*)::text as count from ai_access_tokens
        where organisation_id = $1 and user_id = $2 and revoked_at is null`,
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

/** Revokes one of the signed-in person's own keys. Revoking twice is fine. */
export async function revokeAiToken(auth: AuthContext, organisationId: string, tokenIdInput: unknown): Promise<AiAccessToken> {
  const tokenId = requireId(tokenIdInput, "tokenId");
  return withCoreTransaction(async (client) => {
    const found = await client.query<TokenRow>(
      `select ${TOKEN_COLUMNS} from ai_access_tokens
        where id = $1 and organisation_id = $2 and user_id = $3
        for update`,
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
      eventType: "ai_access_token.revoked",
      entityType: "organisation",
      entityId: organisationId,
      details: { tokenId, name: row.name },
    });
    return toToken(updated.rows[0]);
  });
}

/** Who an AI key acts as, when it's still good. */
export type AiTokenIdentity = {
  tokenId: string;
  tokenName: string;
  /** The level the key was made with. */
  accessLevel: AiAccessLevel;
  /** That level capped by the owner's role now (decision 346). */
  effectiveLevel: AiAccessLevel;
  user: { id: string; email: string; displayName: string };
  membership: Membership;
};

/**
 * Looks a key up (by its hash). It works only while it isn't revoked, its
 * owner's login is active, and they're still a member of the organisation
 * (viewer or higher, with their current role). Anything else is null, and
 * callers answer every refusal the same way. The organisation being ready is
 * checked when its transaction opens.
 */
export async function authenticateAiToken(token: string): Promise<AiTokenIdentity | null> {
  const found = await coreQuery<{
    id: string;
    name: string;
    organisation_id: string;
    user_id: string;
    email: string;
    display_name: string;
    last_used_at: string | null;
    access_level: AiAccessLevel;
  }>(
    `select t.id::text, t.name, t.organisation_id, t.user_id, u.email, u.display_name, t.last_used_at, t.access_level
       from ai_access_tokens t
       join users u on u.id = t.user_id
      where t.token_hash = $1 and t.revoked_at is null and u.is_active`,
    [hashAiToken(token)],
  );
  const row = found.rows[0];
  if (!row) return null;
  const membership = await getMembership(row.organisation_id, row.user_id);
  if (!membership || !membership.organisation.isActive || !roleAtLeast(membership.role as Role, "viewer")) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > LAST_USED_EVERY_MS) {
    await coreQuery("update ai_access_tokens set last_used_at = now() where id = $1", [row.id]);
  }
  return {
    tokenId: row.id,
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

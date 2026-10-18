import { createHash, randomBytes } from "node:crypto";
import { writeAdminAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/roles";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { effectiveScopes, type FarmAppScope, FARM_APP_SCOPES, isFarmAppScope, scopesAllowed } from "@/lib/farm-apps/scopes";
import { getMembership, type Membership } from "@/lib/organisations/registry";
import { requireArray, requireId, requireString } from "@/lib/validation";

/*
 * Farm app keys (#249 stage 5; examples FA1, FA2, decision 561): one person,
 * one organisation, the scopes an app needs. `tohyee_app_` then 32 random
 * bytes as base64url; only the SHA-256 is kept, with 8 characters to tell
 * keys apart. Revoked, never deleted. They work only on /api/farm-apps.
 */

export const FARM_APP_KEY_PREFIX = "tohyee_app_";
const KEY_PATTERN = /^tohyee_app_[A-Za-z0-9_-]{43,100}$/;
export const MAX_ACTIVE_FARM_APP_KEYS = 10;
const LAST_USED_EVERY_MS = 60_000;

export const hashFarmAppKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** The key from an `Authorization: Bearer tohyee_app_…` header, or null. */
export function bearerFarmAppKey(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match && KEY_PATTERN.test(match[1]) ? match[1] : null;
}

export type FarmAppKey = { id: string; name: string; startsWith: string; scopes: FarmAppScope[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

type KeyRow = { id: string; name: string; token_prefix: string; scopes: FarmAppScope[]; created_at: string; last_used_at: string | null; revoked_at: string | null };
const COLUMNS = "id::text, name, token_prefix, scopes, created_at, last_used_at, revoked_at";

const toKey = (row: KeyRow): FarmAppKey => ({
  id: row.id,
  name: row.name,
  startsWith: `${FARM_APP_KEY_PREFIX}${row.token_prefix}`,
  scopes: row.scopes,
  createdAt: new Date(row.created_at).toISOString(),
  lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
});

export function parseScopes(input: unknown): FarmAppScope[] {
  const raw = requireArray(input, "scopes", FARM_APP_SCOPES.length);
  const scopes: FarmAppScope[] = [];
  for (const entry of raw) {
    if (!isFarmAppScope(entry)) throw new ValidationError(`scopes must be from: ${FARM_APP_SCOPES.join(", ")}.`);
    if (!scopes.includes(entry)) scopes.push(entry);
  }
  if (scopes.length === 0) throw new ValidationError("Choose at least one thing the app may do.");
  return FARM_APP_SCOPES.filter((scope) => scopes.includes(scope));
}

/** The signed-in person's own app keys for one organisation, newest first. */
export async function listFarmAppKeys(auth: AuthContext, organisationId: string): Promise<FarmAppKey[]> {
  const result = await coreQuery<KeyRow>(`select ${COLUMNS} from farm_app_keys where organisation_id = $1 and user_id = $2 order by revoked_at is not null, id desc`, [organisationId, auth.user.id]);
  return result.rows.map(toKey);
}

/** Makes a key (FA1, FA2). Returned once, never again. */
export async function createFarmAppKey(auth: AuthContext, organisationId: string, input: { name: unknown; scopes: unknown; role: Role }): Promise<{ key: string; appKey: FarmAppKey }> {
  const name = requireString(input.name, "Name", { maxLength: 100 });
  const scopes = parseScopes(input.scopes);
  const allowed = scopesAllowed(input.role);
  const refused = scopes.filter((scope) => !allowed.includes(scope));
  if (refused.length) throw new ForbiddenError("Recording needs the bookkeeper role or higher.");
  const key = `${FARM_APP_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const appKey = await withCoreTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`farm-app-keys:${organisationId}:${auth.user.id}`]);
    const active = await client.query<{ count: string }>("select count(*)::text as count from farm_app_keys where organisation_id = $1 and user_id = $2 and revoked_at is null", [organisationId, auth.user.id]);
    if (Number(active.rows[0].count) >= MAX_ACTIVE_FARM_APP_KEYS) throw new ConflictError(`You already have ${MAX_ACTIVE_FARM_APP_KEYS} app keys for this organisation. Revoke one you no longer use first.`);
    const inserted = await client.query<KeyRow>(
      `insert into farm_app_keys (user_id, organisation_id, name, token_hash, token_prefix, scopes, created_by_email) values ($1, $2, $3, $4, $5, $6::text[], $7) returning ${COLUMNS}`,
      [auth.user.id, organisationId, name, hashFarmAppKey(key), key.slice(FARM_APP_KEY_PREFIX.length, FARM_APP_KEY_PREFIX.length + 8), scopes, auth.user.email],
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, { eventType: "farm_app_key.created", entityType: "organisation", entityId: organisationId, details: { keyId: inserted.rows[0].id, name, scopes } });
    return toKey(inserted.rows[0]);
  });
  return { key, appKey };
}

/** Revokes one of the signed-in person's own keys. Revoking twice is fine. */
export async function revokeFarmAppKey(auth: AuthContext, organisationId: string, keyIdInput: unknown): Promise<FarmAppKey> {
  const keyId = requireId(keyIdInput, "keyId");
  return withCoreTransaction(async (client) => {
    const found = await client.query<KeyRow>(`select ${COLUMNS} from farm_app_keys where id = $1 and organisation_id = $2 and user_id = $3 for update`, [keyId, organisationId, auth.user.id]);
    const row = found.rows[0];
    if (!row) throw new NotFoundError("App key not found.");
    if (row.revoked_at) return toKey(row);
    const updated = await client.query<KeyRow>(`update farm_app_keys set revoked_at = now() where id = $1 returning ${COLUMNS}`, [keyId]);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, { eventType: "farm_app_key.revoked", entityType: "organisation", entityId: organisationId, details: { keyId, name: row.name } });
    return toKey(updated.rows[0]);
  });
}

export type FarmAppIdentity = { keyId: string; keyName: string; scopes: FarmAppScope[]; effectiveScopes: FarmAppScope[]; user: { id: string; email: string; displayName: string }; membership: Membership };

/** Who a key acts as while it's good (FA2): not revoked, owner active and still a member. Anything else is null. */
export async function authenticateFarmAppKey(key: string): Promise<FarmAppIdentity | null> {
  const found = await coreQuery<{ id: string; name: string; organisation_id: string; user_id: string; email: string; display_name: string; last_used_at: string | null; scopes: FarmAppScope[] }>(
    `select k.id::text, k.name, k.organisation_id, k.user_id, u.email, u.display_name, k.last_used_at, k.scopes
       from farm_app_keys k join users u on u.id = k.user_id
      where k.token_hash = $1 and k.revoked_at is null and u.is_active`,
    [hashFarmAppKey(key)],
  );
  const row = found.rows[0];
  if (!row) return null;
  const membership = await getMembership(row.organisation_id, row.user_id);
  if (!membership || !membership.organisation.isActive) return null;
  const usable = effectiveScopes(row.scopes, membership.role as Role);
  if (usable.length === 0) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > LAST_USED_EVERY_MS) {
    await coreQuery("update farm_app_keys set last_used_at = now() where id = $1", [row.id]);
  }
  return { keyId: row.id, keyName: row.name, scopes: row.scopes, effectiveScopes: usable, user: { id: row.user_id, email: row.email, displayName: row.display_name }, membership };
}

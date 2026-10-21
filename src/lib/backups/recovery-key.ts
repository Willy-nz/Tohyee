import { createHash, randomBytes } from "node:crypto";
import { coreQuery, withCoreTransaction, type DbClient } from "@/lib/db/transactions";
import { UnavailableError } from "@/lib/errors";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";

/**
 * The backup recovery key (#389, decision 734; docs/BACKUP-RECOVERY.md):
 * 32 random bytes the server makes, numbered 1, 2, 3, that encrypt backups
 * (format 2). Kept in the core database's `server_settings`
 * (`backup_recovery_keys`), the keys themselves encrypted with the live key
 * (TOHYEE_SECRET_KEY), so backups run unattended. Older versions are never
 * deleted: they open this server's older backups. A recovery kit is one
 * version of this key, so another computer can open the backups.
 */

export type RecoveryKey = { version: number; id: string; key: Buffer };

export type RecoveryKeyInfo = { version: number; id: string; createdAt: string; createdByEmail: string | null };

type StoredValue = { current: number; keys: RecoveryKeyInfo[] };
type StoredSecrets = { keys: { version: number; key: string }[] };

const SETTING = "backup_recovery_keys";
const LOCK = "tohyee:backup-recovery-keys";

/** A fingerprint of a recovery key (never the key), to match a kit with backups. */
export function recoveryKeyId(key: Buffer): string {
  return createHash("sha256").update("tohyee recovery key id\0").update(key).digest("hex").slice(0, 16);
}

/** A fingerprint of a live key (TOHYEE_SECRET_KEY), recorded in format 2 backups. */
export function liveKeyId(raw: string): string {
  return createHash("sha256").update("tohyee live key id\0").update(raw.trim(), "utf8").digest("hex").slice(0, 16);
}

type Loaded = { value: StoredValue | null; secrets: StoredSecrets | null };

async function load(client: { query: DbClient["query"] }): Promise<Loaded> {
  const result = await client.query<{ value: StoredValue; secret_ciphertext: string | null }>(
    "select value, secret_ciphertext from server_settings where key = $1",
    [SETTING],
  );
  const row = result.rows[0];
  if (!row) return { value: null, secrets: null };
  if (!row.secret_ciphertext) throw new UnavailableError("The backup recovery keys are missing from the server's settings.");
  let secrets: StoredSecrets;
  try {
    secrets = JSON.parse(decryptSecret(row.secret_ciphertext)) as StoredSecrets;
  } catch {
    // Never make a new key over keys that can't be read: that would lose them.
    throw new UnavailableError(
      "The backup recovery keys can't be read with this server's TOHYEE_SECRET_KEY (was it changed?). Put the earlier TOHYEE_SECRET_KEY back; new backups can't be made until then.",
    );
  }
  return { value: row.value, secrets };
}

function toKey(loaded: Loaded, version: number): RecoveryKey | null {
  const secret = loaded.secrets?.keys.find((k) => k.version === version);
  if (!secret) return null;
  const key = Buffer.from(secret.key, "base64");
  if (key.length !== 32) throw new UnavailableError("A backup recovery key is damaged.");
  return { version, id: recoveryKeyId(key), key };
}

async function save(client: DbClient, value: StoredValue, secrets: StoredSecrets, byEmail: string): Promise<void> {
  await client.query(
    `insert into server_settings (key, value, secret_ciphertext, updated_by_email, updated_at)
     values ($1, $2::jsonb, $3, $4, now())
     on conflict (key) do update set value = excluded.value, secret_ciphertext = excluded.secret_ciphertext,
                                     updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [SETTING, JSON.stringify(value), encryptSecret(JSON.stringify(secrets)), byEmail],
  );
}

async function addVersion(client: DbClient, loaded: Loaded, byEmail: string | null): Promise<RecoveryKey> {
  const value: StoredValue = loaded.value ?? { current: 0, keys: [] };
  const secrets: StoredSecrets = loaded.secrets ?? { keys: [] };
  const version = Math.max(0, ...value.keys.map((k) => k.version)) + 1;
  const key = randomBytes(32);
  const id = recoveryKeyId(key);
  await save(
    client,
    { current: version, keys: [...value.keys, { version, id, createdAt: new Date().toISOString(), createdByEmail: byEmail }] },
    { keys: [...secrets.keys, { version, key: key.toString("base64") }] },
    byEmail ?? "tohyee",
  );
  return { version, id, key };
}

/**
 * The key new backups are encrypted with, made (version 1) the first time
 * it's needed. Needs TOHYEE_SECRET_KEY, which protects it.
 */
export async function currentRecoveryKey(): Promise<RecoveryKey> {
  if (!secretsAvailable()) throw new UnavailableError("Backups need TOHYEE_SECRET_KEY, and it isn't set. Set it in the server's environment and restart Tohyee.");
  const existing = await load({ query: coreQuery });
  if (existing.value) {
    const key = toKey(existing, existing.value.current);
    if (key) return key;
  }
  return withCoreTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK]);
    const loaded = await load(client);
    if (loaded.value) {
      const key = toKey(loaded, loaded.value.current);
      if (key) return key;
    }
    return addVersion(client, loaded, null);
  });
}

/** One of this server's recovery keys, by version; null if it has no such version. */
export async function serverRecoveryKey(version: number): Promise<RecoveryKey | null> {
  if (!secretsAvailable()) return null;
  const loaded = await load({ query: coreQuery });
  return loaded.value ? toKey(loaded, version) : null;
}

/** What versions there are (no keys), the current one first. */
export async function recoveryKeyVersions(): Promise<{ current: RecoveryKeyInfo | null; all: RecoveryKeyInfo[] }> {
  const result = await coreQuery<{ value: StoredValue }>("select value from server_settings where key = $1", [SETTING]);
  const value = result.rows[0]?.value;
  if (!value) return { current: null, all: [] };
  return { current: value.keys.find((k) => k.version === value.current) ?? null, all: [...value.keys].sort((a, b) => b.version - a.version) };
}

/**
 * Makes the next version and uses it for new backups from now on. The older
 * versions stay (they open the older backups). Done inside the caller's
 * transaction, with the audit event.
 */
export async function addRecoveryKeyVersion(client: DbClient, byEmail: string): Promise<RecoveryKey> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK]);
  return addVersion(client, await load(client), byEmail);
}

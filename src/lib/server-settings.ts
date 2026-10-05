import { coreQuery, type DbClient } from "@/lib/db/transactions";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";

/**
 * Server-wide settings kept in the core database (email sending, remote
 * access). Each key has plain settings (`value`) and secrets, which are stored
 * encrypted with TOHYEE_SECRET_KEY and never sent to the browser.
 */
export type StoredSetting<V, S> = {
  value: Partial<V>;
  secrets: Partial<S>;
  /** False when secrets exist but can't be read (no key, or a different key). */
  secretsReadable: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

export async function readServerSetting<V, S>(key: string): Promise<StoredSetting<V, S>> {
  const result = await coreQuery<{ value: Partial<V>; secret_ciphertext: string | null; updated_at: string; updated_by_email: string | null }>(
    "select value, secret_ciphertext, updated_at, updated_by_email from server_settings where key = $1",
    [key],
  );
  const row = result.rows[0];
  if (!row) return { value: {}, secrets: {}, secretsReadable: true, updatedAt: null, updatedByEmail: null };
  let secrets: Partial<S> = {};
  let secretsReadable = true;
  if (row.secret_ciphertext) {
    if (!secretsAvailable()) {
      secretsReadable = false;
    } else {
      try {
        secrets = JSON.parse(decryptSecret(row.secret_ciphertext)) as Partial<S>;
      } catch {
        secretsReadable = false;
      }
    }
  }
  return { value: row.value ?? {}, secrets, secretsReadable, updatedAt: row.updated_at, updatedByEmail: row.updated_by_email };
}

export async function writeServerSetting<V, S>(
  client: DbClient,
  key: string,
  value: V,
  secrets: S,
  updatedByEmail: string,
): Promise<void> {
  await client.query(
    `insert into server_settings (key, value, secret_ciphertext, updated_by_email, updated_at)
     values ($1, $2::jsonb, $3, $4, now())
     on conflict (key) do update set value = excluded.value, secret_ciphertext = excluded.secret_ciphertext,
                                     updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [key, JSON.stringify(value), encryptSecret(JSON.stringify(secrets)), updatedByEmail],
  );
}

export async function deleteServerSetting(client: DbClient, key: string): Promise<void> {
  await client.query("delete from server_settings where key = $1", [key]);
}

/** A setting with no secrets: works without TOHYEE_SECRET_KEY. */
export async function writeServerValue<V>(client: DbClient, key: string, value: V, updatedByEmail: string): Promise<void> {
  await client.query(
    `insert into server_settings (key, value, secret_ciphertext, updated_by_email, updated_at)
     values ($1, $2::jsonb, null, $3, now())
     on conflict (key) do update set value = excluded.value, secret_ciphertext = null,
                                     updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [key, JSON.stringify(value), updatedByEmail],
  );
}

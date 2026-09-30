/** D1 access for addresses, counters and the registrations switch. */

export type Status = "creating" | "active" | "releasing" | "blocked";

export type AddressRow = {
  hostname: string;
  install_hash: string | null;
  release_hash: string | null;
  tunnel_id: string | null;
  dns_record_id: string | null;
  port: number;
  version: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
};

export function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function findByInstall(db: D1Database, installHash: string): Promise<AddressRow | null> {
  return db.prepare("SELECT * FROM addresses WHERE install_hash = ?").bind(installHash).first<AddressRow>();
}

export async function findByHostname(db: D1Database, hostname: string): Promise<AddressRow | null> {
  return db.prepare("SELECT * FROM addresses WHERE hostname = ?").bind(hostname).first<AddressRow>();
}

/** Reserves a hostname. Returns false if the hostname or install is already taken. */
export async function reserve(
  db: D1Database,
  row: { hostname: string; installHash: string; port: number; version: string | null },
  now: Date,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO addresses (hostname, install_hash, port, version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'creating', ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(row.hostname, row.installHash, row.port, row.version, now.toISOString(), now.toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function update(
  db: D1Database,
  hostname: string,
  fields: Partial<Omit<AddressRow, "hostname" | "created_at" | "updated_at">>,
  now: Date,
): Promise<void> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  await db
    .prepare(`UPDATE addresses SET ${sets}${sets ? ", " : ""}updated_at = ? WHERE hostname = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), now.toISOString(), hostname)
    .run();
}

export async function remove(db: D1Database, hostname: string): Promise<void> {
  await db.prepare("DELETE FROM addresses WHERE hostname = ?").bind(hostname).run();
}

/** Addresses using (or about to use) a Cloudflare tunnel. */
export async function countInUse(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM addresses WHERE tunnel_id IS NOT NULL OR status = 'creating'").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listAll(db: D1Database): Promise<AddressRow[]> {
  const { results } = await db.prepare("SELECT * FROM addresses ORDER BY created_at").all<AddressRow>();
  return results;
}

/** Adds one to today's counter and returns the new count. */
export async function bump(db: D1Database, name: string, now: Date): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO counters (name, day, count) VALUES (?, ?, 1)
       ON CONFLICT (name, day) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(name, isoDay(now))
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export async function registrationsOpen(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'registrations_open'").first<{ value: string }>();
  return row?.value !== "0";
}

export async function setRegistrationsOpen(db: D1Database, open: boolean): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('registrations_open', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(open ? "1" : "0")
    .run();
}

export async function forgetOldCounters(db: D1Database, now: Date): Promise<void> {
  const cutoff = isoDay(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
  await db.prepare("DELETE FROM counters WHERE day < ?").bind(cutoff).run();
}

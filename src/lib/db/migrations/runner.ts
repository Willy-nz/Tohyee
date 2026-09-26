import { createHash } from "node:crypto";
import type pg from "pg";
import type { Migration } from "@/lib/db/migrations/types";

export type MigrationRunResult = {
  applied: string[];
  version: string | null;
};

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Applies pending migrations to the database `client` is connected to.
 *
 * - A session advisory lock stops two servers migrating the same database at once.
 * - Each migration runs in its own transaction with its bookkeeping row, so a
 *   failure leaves the database at the last good version.
 * - Applied migrations are checksummed; editing one after release is refused.
 * - A database that is newer than this code (unknown versions) is refused too,
 *   rather than being partially "downgraded".
 */
export async function applyMigrations(
  client: pg.ClientBase,
  migrations: readonly Migration[],
  lockName: string,
): Promise<MigrationRunResult> {
  await client.query("select pg_advisory_lock(hashtext($1))", [lockName]);
  try {
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const existing = await client.query<{ version: string; checksum: string }>(
      "select version, checksum from schema_migrations order by version",
    );
    const known = new Map(migrations.map((migration) => [migration.version, migration]));
    const unknown = existing.rows.filter((row) => !known.has(row.version));
    if (unknown.length > 0) {
      throw new Error(
        `This database has migrations this version of Toeyee doesn't know about (${unknown
          .map((row) => row.version)
          .join(", ")}). Is an older version of the app running against a newer database?`,
      );
    }
    const appliedChecksums = new Map(existing.rows.map((row) => [row.version, row.checksum]));

    const applied: string[] = [];
    for (const migration of migrations) {
      const sum = checksum(migration.sql);
      const previous = appliedChecksums.get(migration.version);
      if (previous !== undefined) {
        if (previous !== sum) {
          throw new Error(
            `Migration ${migration.version} (${migration.name}) was changed after it was applied. Add a new migration instead of editing old ones.`,
          );
        }
        continue;
      }

      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          "insert into schema_migrations (version, name, checksum) values ($1, $2, $3)",
          [migration.version, migration.name, sum],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${message}`);
      }
      applied.push(migration.version);
    }

    return {
      applied,
      version: migrations.length > 0 ? migrations[migrations.length - 1].version : null,
    };
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext($1))", [lockName])
      .catch(() => undefined);
  }
}

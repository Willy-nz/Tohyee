import { coreDatabaseName } from "@/lib/db/connection";
import { grantRuntimeAccess } from "@/lib/db/grants";
import { coreMigrations } from "@/lib/db/migrations/core";
import { applyMigrations, type MigrationRunResult } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { connectAsAdmin } from "@/lib/db/pools";
import { coreQuery } from "@/lib/db/transactions";

export const LATEST_TENANT_VERSION = tenantMigrations[tenantMigrations.length - 1].version;

/** Brings the core database up to date. Throws (and stops startup) on failure. */
export async function migrateCoreDatabase(): Promise<MigrationRunResult> {
  const databaseName = coreDatabaseName();
  const client = await connectAsAdmin(databaseName);
  try {
    const result = await applyMigrations(client, coreMigrations, "tohyee:core-migrations");
    await grantRuntimeAccess(client, databaseName);
    return result;
  } finally {
    await client.end();
  }
}

/** Applies tenant migrations to one organisation database (no status bookkeeping). */
export async function applyTenantMigrations(databaseName: string): Promise<MigrationRunResult> {
  const client = await connectAsAdmin(databaseName);
  try {
    const result = await applyMigrations(client, tenantMigrations, "tohyee:tenant-migrations");
    await grantRuntimeAccess(client, databaseName);
    return result;
  } finally {
    await client.end();
  }
}

export type OrganisationMigrationResult = {
  organisationId: string;
  ok: boolean;
  applied: string[];
  error?: string;
};

/**
 * Migrates one organisation and records the outcome in the core registry. An
 * organisation whose migration fails is marked "failed" and blocked from use
 * until it succeeds; other organisations carry on.
 */
export async function migrateOrganisation(organisation: {
  id: string;
  database_name: string;
}): Promise<OrganisationMigrationResult> {
  try {
    const result = await applyTenantMigrations(organisation.database_name);
    await coreQuery(
      `update organisations
          set migration_status = 'current', migration_error = null,
              schema_version = $2, updated_at = now()
        where id = $1`,
      [organisation.id, result.version],
    );
    return { organisationId: organisation.id, ok: true, applied: result.applied };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await coreQuery(
      `update organisations
          set migration_status = 'failed', migration_error = $2, updated_at = now()
        where id = $1`,
      [organisation.id, message.slice(0, 2000)],
    ).catch(() => undefined);
    return { organisationId: organisation.id, ok: false, applied: [], error: message };
  }
}

export async function migrateAllOrganisations(): Promise<OrganisationMigrationResult[]> {
  const organisations = await coreQuery<{ id: string; database_name: string }>(
    `select id, database_name from organisations
      where provisioning_status = 'ready'
      order by id`,
  );
  const results: OrganisationMigrationResult[] = [];
  for (const organisation of organisations.rows) {
    results.push(await migrateOrganisation(organisation));
  }
  return results;
}

/** Core first (fatal on failure), then every organisation (failures isolated). */
export async function migrateEverything(): Promise<{
  core: MigrationRunResult;
  organisations: OrganisationMigrationResult[];
}> {
  const core = await migrateCoreDatabase();
  const organisations = await migrateAllOrganisations();
  return { core, organisations };
}

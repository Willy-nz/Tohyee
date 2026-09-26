import { NZ_DEFAULT_CHART } from "@/lib/accounts/default-chart";
import { classOfType } from "@/lib/accounts/types";
import { restrictDatabaseConnect } from "@/lib/db/grants";
import { applyTenantMigrations } from "@/lib/db/migrations";
import { connectAsAdmin, getAdminPool } from "@/lib/db/pools";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { coreQuery, wrapClient } from "@/lib/db/transactions";
import { NotFoundError } from "@/lib/errors";

type ProvisioningRow = {
  id: string;
  display_name: string;
  database_name: string;
  base_currency: string;
  provisioning_status: "pending" | "ready" | "failed";
};

async function databaseExists(databaseName: string): Promise<boolean> {
  const result = await getAdminPool().query<{ exists: boolean }>(
    "select exists (select 1 from pg_database where datname = $1) as exists",
    [databaseName],
  );
  return Boolean(result.rows[0]?.exists);
}

/**
 * Creates (or finishes creating) an organisation's own database:
 * CREATE DATABASE, tenant migrations, settings, default chart of accounts.
 * Safe to run again after a failure; every step is idempotent.
 */
export async function provisionOrganisation(organisationId: string): Promise<void> {
  const found = await coreQuery<ProvisioningRow>(
    `select id, display_name, database_name, base_currency, provisioning_status
       from organisations where id = $1`,
    [organisationId],
  );
  const organisation = found.rows[0];
  if (!organisation) {
    throw new NotFoundError("Organisation not found.");
  }

  try {
    if (!(await databaseExists(organisation.database_name))) {
      // CREATE DATABASE can't run inside a transaction block.
      await getAdminPool().query(
        `create database ${quoteSqlIdentifier(organisation.database_name)}`,
      );
    }

    const admin = await connectAsAdmin(organisation.database_name);
    try {
      await restrictDatabaseConnect(admin, organisation.database_name);
    } finally {
      await admin.end();
    }

    const migrated = await applyTenantMigrations(organisation.database_name);
    await seedOrganisationDatabase(organisation);

    await coreQuery(
      `update organisations
          set provisioning_status = 'ready', provisioning_error = null,
              migration_status = 'current', migration_error = null,
              schema_version = $2, updated_at = now()
        where id = $1`,
      [organisation.id, migrated.version],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await coreQuery(
      `update organisations
          set provisioning_status = 'failed', provisioning_error = $2, updated_at = now()
        where id = $1`,
      [organisation.id, message.slice(0, 2000)],
    ).catch(() => undefined);
    throw error;
  }
}

async function seedOrganisationDatabase(organisation: ProvisioningRow): Promise<void> {
  const connection = await connectAsAdmin(organisation.database_name);
  const client = wrapClient(connection);
  try {
    await client.query("begin");
    await client.query(
      `insert into organisation_settings (id, organisation_id, display_name, base_currency)
       values (true, $1, $2, $3)
       on conflict (id) do nothing`,
      [organisation.id, organisation.display_name, organisation.base_currency],
    );
    const settings = await client.query<{ organisation_id: string }>(
      "select organisation_id from organisation_settings where id = true",
    );
    if (settings.rows[0]?.organisation_id !== organisation.id) {
      throw new Error(
        `Database ${organisation.database_name} already belongs to organisation ${settings.rows[0]?.organisation_id}.`,
      );
    }

    const hasAccounts = await client.query<{ exists: boolean }>(
      "select exists (select 1 from accounts) as exists",
    );
    if (!hasAccounts.rows[0]?.exists) {
      for (const account of NZ_DEFAULT_CHART) {
        await client.query(
          `insert into accounts (code, name, account_class, account_type, system_key)
           values ($1, $2, $3, $4, $5)`,
          [account.code, account.name, classOfType(account.type), account.type, account.systemKey ?? null],
        );
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await connection.end();
  }
}

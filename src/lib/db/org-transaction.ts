import { NotFoundError, UnavailableError } from "@/lib/errors";
import { getOrganisationPool } from "@/lib/db/pools";
import { type DbClient, withTransaction } from "@/lib/db/transactions";
import type { OrganisationRecord } from "@/lib/organisations/registry";

export type Actor = {
  userId: string | null;
  email: string;
};

/**
 * Everything a service needs to work inside one organisation's database:
 * a query function bound to a single open transaction, plus who is acting.
 */
export type OrgTx = DbClient & {
  organisationId: string;
  databaseName: string;
  baseCurrency: string;
  actor: Actor;
};

export function assertOrganisationUsable(organisation: OrganisationRecord): void {
  if (!organisation.isActive) {
    throw new NotFoundError("Organisation not found.");
  }
  if (organisation.provisioningStatus !== "ready") {
    throw new UnavailableError(
      organisation.provisioningStatus === "failed"
        ? "This organisation's database couldn't be set up. A server admin can retry it from Organisations."
        : "This organisation's database is still being set up.",
    );
  }
  if (organisation.migrationStatus !== "current") {
    throw new UnavailableError(
      organisation.migrationStatus === "failed"
        ? "This organisation's database upgrade failed. A server admin needs to check the server logs."
        : "This organisation's database is being upgraded. Try again shortly.",
    );
  }
}

/**
 * The single entry point for organisation data: resolves the organisation's
 * own database from the core registry and runs `work` in one transaction there.
 * Requests carry organisation IDs; database names never come from clients.
 */
export async function withOrganisationTransaction<T>(
  organisation: OrganisationRecord,
  actor: Actor,
  work: (tx: OrgTx) => Promise<T>,
): Promise<T> {
  assertOrganisationUsable(organisation);
  const pool = getOrganisationPool(organisation.databaseName);
  return withTransaction(pool, async (client) => {
    const settings = await client.query<{ base_currency: string; organisation_id: string }>(
      "select base_currency, organisation_id from organisation_settings where id = true",
    );
    const row = settings.rows[0];
    if (!row) {
      throw new UnavailableError("This organisation's database is missing its settings row.");
    }
    if (row.organisation_id !== organisation.id) {
      // Defence in depth: the registry must never point at another organisation's database.
      throw new UnavailableError("Organisation database mismatch. A server admin needs to check the registry.");
    }
    return work({
      ...client,
      query: client.query.bind(client),
      organisationId: organisation.id,
      databaseName: organisation.databaseName,
      baseCurrency: row.base_currency,
      actor,
    });
  });
}

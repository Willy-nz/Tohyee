import { NotFoundError, UnavailableError } from "@/lib/errors";
import { getOrganisationPool } from "@/lib/db/pools";
import { type DbClient, withTransaction } from "@/lib/db/transactions";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { loadMemberNames, type PeopleNames } from "@/lib/people/names";

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
  /**
   * The organisation's members' names by email, loaded before the
   * transaction opens (see `personName` in `@/lib/people/names`), for text
   * that names someone, e.g. a new journal's description.
   */
  people: PeopleNames;
};

/**
 * Runs `work` in its own transaction on one organisation's database, as one
 * signed-in person. Bulk commands (e.g. "OK all confident matches") take one
 * so each item commits or fails on its own.
 */
export type OrgRunner = <T>(work: (tx: OrgTx) => Promise<T>) => Promise<T>;

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
 * `readOnly` makes the whole transaction read-only in PostgreSQL.
 */
export async function withOrganisationTransaction<T>(
  organisation: OrganisationRecord,
  actor: Actor,
  work: (tx: OrgTx) => Promise<T>,
  options: { people?: PeopleNames; readOnly?: boolean } = {},
): Promise<T> {
  assertOrganisationUsable(organisation);
  // A core database read, done before the organisation's transaction opens.
  const people = options.people ?? (await loadMemberNames(organisation.id));
  const pool = getOrganisationPool(organisation.databaseName);
  return withTransaction(pool, async (client) => {
    if (options.readOnly) {
      // PostgreSQL itself refuses any write (insert, update, delete, DDL,
      // nextval, select ... for update) for the rest of this transaction.
      // Used for AI tools (decision 342).
      await client.query("set transaction read only");
    }
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
      people,
    });
  });
}

import { type AdminActor, writeAdminAuditEvent } from "@/lib/audit";
import { normaliseEmail } from "@/lib/auth/service";
import { organisationDatabasePrefix } from "@/lib/db/connection";
import { getOrganisationPool } from "@/lib/db/pools";
import { coreQuery, withCoreTransaction, withTransaction } from "@/lib/db/transactions";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { DEFAULT_BASE_CURRENCY, parseCurrencyCode } from "@/lib/money/currency";
import { provisionOrganisation } from "@/lib/organisations/provisioning";
import {
  getOrganisation,
  organisationColumns,
  type OrganisationRecord,
  parseOrganisationId,
  toOrganisationRecord,
} from "@/lib/organisations/registry";
import { optionalBoolean, requireString } from "@/lib/validation";

export type OrganisationAdminView = OrganisationRecord & { memberCount: number };

export async function listAllOrganisations(): Promise<OrganisationAdminView[]> {
  const result = await coreQuery<Parameters<typeof toOrganisationRecord>[0] & { member_count: string }>(
    `select ${organisationColumns("o")},
            (select count(*) from organisation_members m where m.organisation_id = o.id)::text as member_count
       from organisations o
      order by o.display_name, o.id`,
  );
  return result.rows.map((row) => ({
    ...toOrganisationRecord(row),
    memberCount: Number(row.member_count),
  }));
}

/** Database name for a new organisation: prefix + slug with dashes as underscores. */
export function databaseNameFor(organisationId: string): string {
  return `${organisationDatabasePrefix()}${organisationId.replace(/-/g, "_")}`;
}

/**
 * Registers an organisation, creates its own database and makes the owner a
 * member. If database creation fails the organisation is kept with status
 * "failed" so a server admin can retry.
 */
export async function createOrganisation(
  actor: AdminActor,
  input: { id: unknown; displayName: unknown; baseCurrency?: unknown; ownerEmail?: unknown },
): Promise<OrganisationRecord> {
  const id = parseOrganisationId(input.id);
  const displayName = requireString(input.displayName, "displayName", { maxLength: 150 });
  const baseCurrency =
    input.baseCurrency == null || input.baseCurrency === ""
      ? DEFAULT_BASE_CURRENCY
      : parseCurrencyCode(input.baseCurrency, "baseCurrency");
  const ownerEmail =
    input.ownerEmail == null || input.ownerEmail === "" ? actor.email : normaliseEmail(input.ownerEmail);
  const databaseName = databaseNameFor(id);

  await withCoreTransaction(async (client) => {
    const owner = await client.query<{ id: string }>(
      "select id from users where email = $1 and is_active",
      [ownerEmail],
    );
    const ownerId = owner.rows[0]?.id;
    if (!ownerId) {
      throw new ValidationError(`There's no active user with the email ${ownerEmail}. Create the user first.`);
    }
    const inserted = await client.query<{ id: string }>(
      `insert into organisations (id, display_name, database_name, base_currency, created_by)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing
       returning id`,
      [id, displayName, databaseName, baseCurrency, actor.id],
    );
    if (!inserted.rows[0]) {
      throw new ConflictError(`An organisation with the ID "${id}" (or its database) already exists.`);
    }
    await client.query(
      `insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')`,
      [id, ownerId],
    );
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "organisation.created",
      entityType: "organisation",
      entityId: id,
      details: { displayName, databaseName, baseCurrency, ownerEmail },
    });
  });

  try {
    await provisionOrganisation(id);
  } catch (error) {
    console.error(`[tohyee] provisioning ${id} failed:`, error);
  }

  const organisation = await getOrganisation(id);
  if (!organisation) {
    throw new NotFoundError("Organisation not found.");
  }
  return organisation;
}

export async function retryProvisioning(actor: AdminActor, organisationIdInput: string) {
  const id = parseOrganisationId(organisationIdInput);
  const organisation = await getOrganisation(id);
  if (!organisation) {
    throw new NotFoundError("Organisation not found.");
  }
  await writeAdminAuditEvent({ query: coreQuery }, { userId: actor.id, email: actor.email }, {
    eventType: "organisation.repair_requested",
    entityType: "organisation",
    entityId: id,
    details: {
      provisioningStatus: organisation.provisioningStatus,
      migrationStatus: organisation.migrationStatus,
    },
  });
  // Idempotent: creates the database if missing, applies pending migrations,
  // re-seeds anything missing and marks the organisation ready/current.
  await provisionOrganisation(id);
  return (await getOrganisation(id))!;
}

/**
 * Renames or (de)activates an organisation. The display name is kept in both
 * the registry and the organisation's own settings.
 */
export async function updateOrganisation(
  actor: AdminActor,
  organisationIdInput: string,
  input: { displayName?: unknown; isActive?: unknown },
): Promise<OrganisationRecord> {
  const id = parseOrganisationId(organisationIdInput);
  const displayName =
    input.displayName === undefined
      ? null
      : requireString(input.displayName, "displayName", { maxLength: 150 });
  const isActive = optionalBoolean(input.isActive, "isActive");

  const existing = await getOrganisation(id);
  if (!existing) {
    throw new NotFoundError("Organisation not found.");
  }

  await withCoreTransaction(async (client) => {
    await client.query(
      `update organisations
          set display_name = coalesce($2, display_name),
              is_active = coalesce($3, is_active),
              updated_at = now()
        where id = $1`,
      [id, displayName, isActive],
    );
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "organisation.updated",
      entityType: "organisation",
      entityId: id,
      details: { displayName, isActive },
    });
  });

  if (displayName && existing.provisioningStatus === "ready") {
    await withTransaction(getOrganisationPool(existing.databaseName), (client) =>
      client.query(
        "update organisation_settings set display_name = $1, updated_at = now() where id = true",
        [displayName],
      ),
    );
  }

  return (await getOrganisation(id))!;
}

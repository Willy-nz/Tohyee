import { coreQuery } from "@/lib/db/transactions";
import { ValidationError } from "@/lib/errors";
import type { Role } from "@/lib/auth/roles";

export type OrganisationRecord = {
  id: string;
  displayName: string;
  databaseName: string;
  baseCurrency: string;
  isActive: boolean;
  provisioningStatus: "pending" | "ready" | "failed";
  provisioningError: string | null;
  migrationStatus: "pending" | "current" | "failed";
  migrationError: string | null;
  schemaVersion: string | null;
  createdAt: string;
};

type OrganisationRow = {
  id: string;
  display_name: string;
  database_name: string;
  base_currency: string;
  is_active: boolean;
  provisioning_status: OrganisationRecord["provisioningStatus"];
  provisioning_error: string | null;
  migration_status: OrganisationRecord["migrationStatus"];
  migration_error: string | null;
  schema_version: string | null;
  created_at: string;
};

const ORGANISATION_COLUMN_NAMES = [
  "id",
  "display_name",
  "database_name",
  "base_currency",
  "is_active",
  "provisioning_status",
  "provisioning_error",
  "migration_status",
  "migration_error",
  "schema_version",
  "created_at",
] as const;

/** Column list for selecting organisations, optionally prefixed with a table alias. */
export function organisationColumns(alias?: string): string {
  return ORGANISATION_COLUMN_NAMES.map((name) => (alias ? `${alias}.${name}` : name)).join(", ");
}

export function toOrganisationRecord(row: OrganisationRow): OrganisationRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    databaseName: row.database_name,
    baseCurrency: row.base_currency,
    isActive: row.is_active,
    provisioningStatus: row.provisioning_status,
    provisioningError: row.provisioning_error,
    migrationStatus: row.migration_status,
    migrationError: row.migration_error,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
  };
}

/** Organisation IDs are short slugs, e.g. "glimmers-by-jess". */
export const ORGANISATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseOrganisationId(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ValidationError("organisationId is required.");
  }
  const value = input.trim();
  if (!ORGANISATION_ID_PATTERN.test(value)) {
    throw new ValidationError(
      "organisationId must be 1-32 lower-case letters, numbers or dashes, starting with a letter or number.",
    );
  }
  return value;
}

export async function getOrganisation(id: string): Promise<OrganisationRecord | null> {
  const result = await coreQuery<OrganisationRow>(
    `select ${organisationColumns()} from organisations where id = $1`,
    [id],
  );
  return result.rows[0] ? toOrganisationRecord(result.rows[0]) : null;
}

export type Membership = {
  organisation: OrganisationRecord;
  role: Role;
};

export async function getMembership(
  organisationId: string,
  userId: string,
): Promise<Membership | null> {
  const result = await coreQuery<OrganisationRow & { role: Role }>(
    `select ${organisationColumns("o")}, m.role
       from organisations o
       join organisation_members m on m.organisation_id = o.id
      where o.id = $1 and m.user_id = $2`,
    [organisationId, userId],
  );
  const row = result.rows[0];
  return row ? { organisation: toOrganisationRecord(row), role: row.role } : null;
}

/** Active organisations the user belongs to, for the organisation switcher. */
export async function listMembershipsForUser(userId: string): Promise<Membership[]> {
  const result = await coreQuery<OrganisationRow & { role: Role }>(
    `select ${organisationColumns("o")}, m.role
       from organisations o
       join organisation_members m on m.organisation_id = o.id
      where m.user_id = $1 and o.is_active
      order by o.display_name, o.id`,
    [userId],
  );
  return result.rows.map((row) => ({ organisation: toOrganisationRecord(row), role: row.role }));
}

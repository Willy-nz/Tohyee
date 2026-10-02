import packageJson from "../../../package.json";
import { coreQuery } from "@/lib/db/transactions";
import type { OrganisationMigrationResult } from "@/lib/db/migrations";

/**
 * A record of each server start (decision 330): the version, the version
 * before it, and what the start-up database upgrades did. After an update the
 * server app reads the latest one to report whether the new version came up
 * and which organisations, if any, are blocked because their upgrade failed.
 */

export type ServerStart = {
  version: string;
  previousVersion: string | null;
  startedAt: string;
  coreApplied: string[];
  organisationsChecked: number;
  organisationsUpgraded: number;
  organisationsBlocked: { organisationId: string; error: string }[];
};

type Row = {
  version: string;
  previous_version: string | null;
  started_at: Date;
  core_applied: string[];
  organisations_checked: number;
  organisations_upgraded: number;
  organisations_blocked: { organisationId: string; error: string }[];
};

function toStart(row: Row): ServerStart {
  return {
    version: row.version,
    previousVersion: row.previous_version,
    startedAt: new Date(row.started_at).toISOString(),
    coreApplied: row.core_applied,
    organisationsChecked: row.organisations_checked,
    organisationsUpgraded: row.organisations_upgraded,
    organisationsBlocked: row.organisations_blocked,
  };
}

/** What the start-up upgrades did, as a row: counts, and each blocked organisation with its error. */
export function summariseStartup(result: { core: { applied: string[] }; organisations: OrganisationMigrationResult[] }) {
  return {
    coreApplied: result.core.applied,
    organisationsChecked: result.organisations.length,
    organisationsUpgraded: result.organisations.filter((o) => o.ok && o.applied.length > 0).length,
    organisationsBlocked: result.organisations
      .filter((o) => !o.ok)
      .map((o) => ({ organisationId: o.organisationId, error: (o.error ?? "No message").slice(0, 2000) })),
  };
}

export async function recordServerStart(
  result: { core: { applied: string[] }; organisations: OrganisationMigrationResult[] },
  version: string = packageJson.version,
): Promise<ServerStart> {
  const summary = summariseStartup(result);
  const inserted = await coreQuery<Row>(
    `insert into server_starts (version, previous_version, core_applied, organisations_checked, organisations_upgraded, organisations_blocked)
     values ($1, (select version from server_starts order by started_at desc, id desc limit 1), $2, $3, $4, $5::jsonb)
     returning version, previous_version, started_at, core_applied, organisations_checked, organisations_upgraded, organisations_blocked`,
    [version, summary.coreApplied, summary.organisationsChecked, summary.organisationsUpgraded, JSON.stringify(summary.organisationsBlocked)],
  );
  return toStart(inserted.rows[0]);
}

export async function latestServerStart(): Promise<ServerStart | null> {
  const result = await coreQuery<Row>(
    `select version, previous_version, started_at, core_applied, organisations_checked, organisations_upgraded, organisations_blocked
       from server_starts order by started_at desc, id desc limit 1`,
  );
  return result.rows[0] ? toStart(result.rows[0]) : null;
}

/** The most recent start that changed the version (the last update), if any. */
export async function lastVersionChange(): Promise<ServerStart | null> {
  const result = await coreQuery<Row>(
    `select version, previous_version, started_at, core_applied, organisations_checked, organisations_upgraded, organisations_blocked
       from server_starts where previous_version is distinct from version and previous_version is not null
      order by started_at desc, id desc limit 1`,
  );
  return result.rows[0] ? toStart(result.rows[0]) : null;
}

/** Organisations blocked right now because an upgrade failed (whenever it was). */
export async function blockedOrganisations(): Promise<{ organisationId: string; displayName: string; error: string | null }[]> {
  const result = await coreQuery<{ id: string; display_name: string; migration_error: string | null }>(
    "select id, display_name, migration_error from organisations where migration_status = 'failed' order by id",
  );
  return result.rows.map((row) => ({ organisationId: row.id, displayName: row.display_name, error: row.migration_error }));
}

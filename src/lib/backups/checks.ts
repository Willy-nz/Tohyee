import path from "node:path";
import {
  backupTargets,
  checkBackup,
  datedBackupFiles,
  fileSha256,
  folderFor,
  getBackupSettings,
  withBackupLock,
} from "@/lib/backups/service";
import { coreQuery } from "@/lib/db/transactions";
import { ConflictError } from "@/lib/errors";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { secretsAvailable } from "@/lib/secrets";

/**
 * Checks on backups after they were made (#389, decision 732). An integrity
 * check reads each database's newest backup file back from the folder,
 * decrypts all of it (so its tag is checked) into `pg_restore --list`, and
 * compares its SHA-256 with the one recorded when it was made. That catches
 * a file changed, damaged, replaced or deleted since (by sync, a disk fault
 * or ransomware). Every check is a row in `backup_checks`, written by the
 * code doing it.
 */

export type BackupCheckKind = "integrity" | "test_restore" | "restore";

export type BackupCheck = {
  id: string;
  kind: BackupCheckKind;
  organisationId: string | null;
  status: "running" | "ok" | "failed";
  startedAt: string;
  finishedAt: string | null;
  /** Relative to the backup folder. */
  fileName: string | null;
  details: Record<string, unknown>;
  error: string | null;
  requestedByEmail: string | null;
};

type CheckRow = {
  id: string;
  kind: BackupCheckKind;
  organisation_id: string | null;
  status: BackupCheck["status"];
  started_at: Date;
  finished_at: Date | null;
  file_name: string | null;
  details: Record<string, unknown> | null;
  error: string | null;
  requested_by_email: string | null;
};

const CHECK_COLUMNS = "id::text as id, kind, organisation_id, status, started_at, finished_at, file_name, details, error, requested_by_email";

function toCheck(row: CheckRow): BackupCheck {
  return {
    id: row.id,
    kind: row.kind,
    organisationId: row.organisation_id,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    fileName: row.file_name,
    details: row.details ?? {},
    error: row.error,
    requestedByEmail: row.requested_by_email,
  };
}

/** The latest check of a kind for each database (organisation id, or null for the server's own). */
export async function latestChecks(kind: BackupCheckKind): Promise<BackupCheck[]> {
  const result = await coreQuery<CheckRow>(
    `select distinct on (organisation_id) ${CHECK_COLUMNS} from backup_checks where kind = $1 and status <> 'running'
      order by organisation_id, started_at desc, backup_checks.id desc`,
    [kind],
  );
  return result.rows.map(toCheck);
}

/** Recent checks, newest first. */
export async function recentChecks(limit = 30): Promise<BackupCheck[]> {
  const result = await coreQuery<CheckRow>(`select ${CHECK_COLUMNS} from backup_checks order by started_at desc, backup_checks.id desc limit $1`, [limit]);
  return result.rows.map(toCheck);
}

async function record(
  kind: BackupCheckKind,
  organisationId: string | null,
  requestedByEmail: string | null,
  outcome: { status: "ok" | "failed"; fileName: string | null; details: Record<string, unknown>; error: string | null },
): Promise<BackupCheck> {
  const result = await coreQuery<CheckRow>(
    `insert into backup_checks (kind, organisation_id, status, finished_at, file_name, details, error, requested_by_email)
     values ($1, $2, $3, now(), $4, $5::jsonb, $6, $7) returning ${CHECK_COLUMNS}`,
    [kind, organisationId, outcome.status, outcome.fileName, JSON.stringify(outcome.details), outcome.error?.slice(0, 2000) ?? null, requestedByEmail],
  );
  return toCheck(result.rows[0]);
}

/**
 * Reads the newest backup of each database (or one organisation) back from
 * the folder and checks it fully again. A database with a good backup on
 * record but no readable file in the folder fails the check (the file was
 * deleted or damaged since); one never backed up is skipped.
 */
export async function checkStoredBackups(options: { requestedByEmail: string | null; organisationId?: string }): Promise<BackupCheck[]> {
  const organisationId = options.organisationId ? parseOrganisationId(options.organisationId) : undefined;
  return withBackupLock("A backup or a check of the backups is already running. Try again when it has finished.", async () => {
    const root = (await getBackupSettings()).folder;
    const done: BackupCheck[] = [];
    for (const target of await backupTargets(organisationId)) {
      const good = await coreQuery<{ n: string }>(
        "select count(*)::text as n from backup_runs where status = 'ok' and organisation_id is not distinct from $1",
        [target.organisationId],
      );
      const folder = folderFor(root, target);
      const files = await datedBackupFiles(folder, target);
      if (files.length === 0) {
        if (Number(good.rows[0]?.n ?? 0) === 0) continue;
        done.push(
          await record("integrity", target.organisationId, options.requestedByEmail, {
            status: "failed",
            fileName: null,
            details: {},
            error: `There's a good backup on record, but no backup file for ${target.displayName ?? "the server's own database"} in ${folder}. It may have been moved or deleted (deleting in a synced folder deletes everywhere).`,
          }),
        );
        continue;
      }
      const newest = files[0];
      const full = path.join(folder, newest.name);
      const fileName = path.join(path.basename(folder), newest.name);
      try {
        const header = await checkBackup(full);
        const sha256 = await fileSha256(full);
        const made = await coreQuery<{ sha256: string | null }>(
          "select sha256 from backup_runs where file_path = $1 and status = 'ok' order by started_at desc, id desc limit 1",
          [full],
        );
        const recorded = made.rows[0]?.sha256 ?? null;
        if (recorded && recorded !== sha256) {
          throw new Error("This file isn't the one Tohyee made: it opens, but its contents changed after it was checked (it may have been replaced).");
        }
        done.push(
          await record("integrity", target.organisationId, options.requestedByEmail, {
            status: "ok",
            fileName,
            details: { madeAt: header.createdAt, sha256Matches: recorded ? true : null, filesInFolder: files.length, damagedFiles: files.filter((f) => !f.readable).length },
            error: null,
          }),
        );
      } catch (error) {
        done.push(
          await record("integrity", target.organisationId, options.requestedByEmail, {
            status: "failed",
            fileName,
            details: { filesInFolder: files.length },
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return done;
  });
}

/** How often the newest backups are checked again by themselves. */
export const INTEGRITY_EVERY_DAYS = 7;

/**
 * The weekly integrity check, run by the backup scheduler: when backups are
 * on and the last check is a week old (or there's none yet), and no backup is
 * running.
 */
export async function runDueIntegrityChecks(now = new Date()): Promise<BackupCheck[]> {
  const settings = await getBackupSettings();
  if (!settings.enabled || !secretsAvailable()) return [];
  const last = await coreQuery<{ started_at: Date }>("select max(started_at) as started_at from backup_checks where kind = 'integrity'");
  const at = last.rows[0]?.started_at ? new Date(last.rows[0].started_at) : null;
  if (at && now.getTime() - at.getTime() < INTEGRITY_EVERY_DAYS * 24 * 60 * 60 * 1000) return [];
  try {
    return await checkStoredBackups({ requestedByEmail: null });
  } catch (error) {
    if (error instanceof ConflictError) return []; // a backup is running; next time
    throw error;
  }
}

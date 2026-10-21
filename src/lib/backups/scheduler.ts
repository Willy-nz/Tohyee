import { type BackupCheck, runDueIntegrityChecks } from "@/lib/backups/checks";
import { backUpNow, type BackupRun, cleanUpInterruptedRestores, getBackupSettings, localParts, markInterruptedBackups } from "@/lib/backups/service";
import { coreQuery } from "@/lib/db/transactions";
import { sendSecurityAlert } from "@/lib/email/mailer";

const RETRY_AFTER_MS = 60 * 60 * 1000;

type RecentRun = { organisationId: string | null; trigger: "schedule" | "manual" | "update"; status: string; startedAt: Date };

/**
 * Which databases the nightly backup still owes today: once the local time is
 * past the set time, every database without a good backup since then; one
 * whose scheduled attempt failed is tried again an hour later.
 */
export function dueToday(
  now: Date,
  settings: { enabled: boolean; time: string },
  targetIds: (string | null)[],
  runs: RecentRun[],
): (string | null)[] {
  if (!settings.enabled) return [];
  const today = localParts(now);
  if (today.time < settings.time) return [];
  const sinceSetTime = (run: RecentRun) => {
    const at = localParts(run.startedAt);
    return at.date === today.date && at.time >= settings.time;
  };
  return targetIds.filter((id) => {
    const mine = runs.filter((run) => run.organisationId === id && sinceSetTime(run));
    if (mine.some((run) => run.status === "ok" || run.status === "running")) return false;
    const lastTry = mine.filter((run) => run.trigger === "schedule").sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    return !lastTry || now.getTime() - lastTry.startedAt.getTime() >= RETRY_AFTER_MS;
  });
}

async function emailServerAdmins(failed: BackupRun[]): Promise<void> {
  const admins = await coreQuery<{ email: string }>("select email from users where is_server_admin and is_active");
  const lines = [
    `Tohyee's nightly backup failed for ${failed.length === 1 ? "one database" : `${failed.length} databases`}:`,
    ...failed.map((run) => `- ${run.organisationId ?? "the server's own database"}: ${run.error ?? "no message"}`),
    "It will try again in an hour. The server app's Backups tab (or `backups status` on the command line) shows the details.",
  ];
  for (const admin of admins.rows) {
    await sendSecurityAlert(admin.email, "a backup failed", lines);
  }
}

async function emailCheckFailures(failed: BackupCheck[]): Promise<void> {
  const admins = await coreQuery<{ email: string }>("select email from users where is_server_admin and is_active");
  const lines = [
    `Tohyee's weekly check of the backups found ${failed.length === 1 ? "a problem" : `${failed.length} problems`}:`,
    ...failed.map((check) => `- ${check.organisationId ?? "the server's own database"}: ${check.error ?? "no message"}`),
    "The older backup files are still there. The server app's Backups tab (or `backups status` on the command line) shows the details; back up now to get a good copy.",
  ];
  for (const admin of admins.rows) {
    await sendSecurityAlert(admin.email, "a backup check failed", lines);
  }
}

let running = false;
/** When this server process started: a run "running" from before then was cut off by a restart (#137). */
const PROCESS_STARTED_AT = new Date();

/** Makes whatever backups are due. Returns what it did (for tests and logs). */
export async function runDueBackups(now = new Date(), processStartedAt = PROCESS_STARTED_AT): Promise<BackupRun[]> {
  if (running) return [];
  running = true;
  try {
    // A restore cut off by a restart leaves nothing half-made behind (decision 739).
    const cleaned = await cleanUpInterruptedRestores(processStartedAt).catch(() => [] as string[]);
    for (const id of cleaned) console.warn(`[tohyee] A restore into ${id} was interrupted by a restart; what it had made was removed.`);
    const settings = await getBackupSettings();
    if (!settings.enabled || !settings.keySet) return [];
    // Otherwise a cut-off run counts as "running" all day and blocks that day's backups.
    const interrupted = await markInterruptedBackups(processStartedAt, now);
    for (const run of interrupted) console.warn(`[tohyee] Backup of ${run.organisationId ?? "the server database"} was interrupted by a restart; it's tried again.`);
    if (interrupted.length > 0) await emailServerAdmins(interrupted).catch(() => undefined);
    const organisations = await coreQuery<{ id: string }>("select id from organisations where provisioning_status = 'ready'");
    const targetIds = [null, ...organisations.rows.map((row) => row.id)];
    const recent = await coreQuery<{ organisation_id: string | null; trigger: RecentRun["trigger"]; status: string; started_at: Date }>(
      "select organisation_id, trigger, status, started_at from backup_runs where started_at > now() - interval '2 days'",
    );
    const runs = recent.rows.map((row) => ({ organisationId: row.organisation_id, trigger: row.trigger, status: row.status, startedAt: new Date(row.started_at) }));
    const due = dueToday(now, settings, targetIds, runs);
    if (due.length === 0) return [];
    const firstTryToday = due.filter((id) => !runs.some((run) => run.organisationId === id && run.trigger === "schedule" && localParts(run.startedAt).date === localParts(now).date));
    const made = await backUpNow({ trigger: "schedule", requestedByEmail: null, only: due });
    const failed = made.filter((run) => run.status === "failed");
    for (const run of failed) console.warn(`[tohyee] Backup of ${run.organisationId ?? "the server database"} failed: ${run.error}`);
    const newlyFailed = failed.filter((run) => firstTryToday.includes(run.organisationId));
    if (newlyFailed.length > 0) await emailServerAdmins(newlyFailed).catch(() => undefined);
    return made;
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Checks every 5 minutes whether the nightly backup (or the weekly check of the backups) is due, while the server runs. */
export function startBackupScheduler(): void {
  if (timer) return;
  const tick = () => {
    runDueBackups()
      .catch((error) => console.warn("[tohyee] Backup scheduler:", error instanceof Error ? error.message : error))
      // Once a week the newest backups are read back and checked again (decision 732).
      .then(() => runDueIntegrityChecks())
      .then(async (checks) => {
        const failed = checks.filter((check) => check.status === "failed");
        for (const check of failed) console.warn(`[tohyee] Backup check of ${check.organisationId ?? "the server database"} failed: ${check.error}`);
        if (failed.length > 0) await emailCheckFailures(failed).catch(() => undefined);
      })
      .catch((error) => console.warn("[tohyee] Backup check:", error instanceof Error ? error.message : error));
  };
  timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 2 * 60 * 1000).unref?.();
}

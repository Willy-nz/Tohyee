import { promises as fs } from "node:fs";
import { type BackupKeyStatus, backupKeyStatus } from "@/lib/backups/key";
import { type RecoveryKitStatus, recoveryKitStatus } from "@/lib/backups/recovery-kit";
import { type BackupCheck, latestChecks } from "@/lib/backups/checks";
import { classifyDestination, type Destination, type DiskSpace, diskSpace, describeDestination, formatBytes, offSiteNote } from "@/lib/backups/destination";
import { type BackupFile, type BackupRun, type BackupSettings, backupStatus, getBackupSettings, listBackupFiles } from "@/lib/backups/service";

/**
 * The Backups panel (#389, decision 733): what's known about the backups and
 * on what evidence. Every line comes from work the server did (a backup run,
 * a check, the files in the folder); nothing is a status someone typed in,
 * and there's no "safe" badge. What isn't proven is listed as such.
 */

export type TargetSummary = {
  organisationId: string | null;
  displayName: string | null;
  state: "ok" | "old" | "failed" | "never" | "running";
  lastGoodAt: string | null;
  lastGoodBytes: number | null;
  latestError: string | null;
  lastCheck: { at: string; ok: boolean; error: string | null } | null;
};

export type Attention = { level: "error" | "warning"; text: string };

export type BackupOverview = {
  /** When every database had last been backed up (the oldest of their newest good backups); null if any never has. */
  everythingBackedUpAt: string | null;
  newestBackupAt: string | null;
  targets: TargetSummary[];
  integrity: {
    /** The oldest of each database's latest check, so it's when everything was last checked; null if something never was. */
    allCheckedAt: string | null;
    failed: number;
    unchecked: number;
  };
  destination: Destination & { description: string };
  offSite: { verified: false; note: string };
  storage: {
    fileCount: number;
    usedBytes: number;
    damagedFiles: string[];
    freeBytes: number | null;
    /** About how big the next full backup will be: the newest good backup of each database added up. */
    nextBackupBytes: number;
  };
  /** The recovery kit (decision 736): the current key version and its last checked kit. */
  recoveryKit: {
    version: number | null;
    id: string | null;
    checkedAt: string | null;
    checkedByEmail: string | null;
    /** Backups in the folder made with an earlier recovery key version: keep that version's kit until they age out. */
    olderVersions: { version: number; id: string; files: number; newestMadeAt: string; keepKitUntilAbout: string }[];
    /** Backups in the older format (before recovery kits), which need the older backup key (TOHYEE_SECRET_KEY). */
    legacyFiles: { files: number; newestMadeAt: string; keepKeyUntilAbout: string; keyCheckedAt: string | null } | null;
  };
  attention: Attention[];
  /** Things a recovery would depend on that nothing has proven yet. */
  notProven: string[];
};

export type OverviewInput = {
  now: Date;
  settings: Pick<BackupSettings, "enabled" | "keySet" | "folder" | "time">;
  folderExists: boolean;
  space: DiskSpace | null;
  files: Pick<BackupFile, "name" | "sizeBytes" | "problem" | "header">[];
  status: { organisationId: string | null; displayName: string | null; latest: BackupRun | null; lastGood: BackupRun | null }[];
  checks: BackupCheck[];
  keyStatus: Pick<BackupKeyStatus, "keySet" | "savedCopyCheckedAt">;
  kit: Pick<RecoveryKitStatus, "keySet" | "version" | "id" | "checkedAt" | "checkedByEmail">;
};

/** Backups are kept up to 12 months (the first of each month), so a kit or key is needed until about a year after the newest backup made with it. */
function aYearAfter(iso: string): string {
  const date = new Date(iso);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

/** A good backup older than this (when nightly backups are on) needs looking at. */
const STALE_HOURS = 36;
/** And so does a check older than this. */
const CHECK_STALE_DAYS = 8;

const HOUR = 60 * 60 * 1000;

function nameOf(target: { organisationId: string | null; displayName: string | null }): string {
  return target.displayName ?? (target.organisationId ? target.organisationId : "the server's own database (users and settings)");
}

export function summariseBackups(input: OverviewInput): BackupOverview {
  const { now, settings } = input;
  const destination = classifyDestination(settings.folder);
  const attention: Attention[] = [];
  const notProven: string[] = [];

  const targets: TargetSummary[] = input.status.map((entry) => {
    const check = input.checks.find((c) => c.kind === "integrity" && c.organisationId === entry.organisationId) ?? null;
    let state: TargetSummary["state"] = "ok";
    if (entry.latest?.status === "running") state = "running";
    else if (entry.latest?.status === "failed") state = "failed";
    else if (!entry.lastGood) state = "never";
    else if (settings.enabled && now.getTime() - new Date(entry.lastGood.finishedAt ?? entry.lastGood.startedAt).getTime() > STALE_HOURS * HOUR) state = "old";
    return {
      organisationId: entry.organisationId,
      displayName: entry.displayName,
      state,
      lastGoodAt: entry.lastGood ? (entry.lastGood.finishedAt ?? entry.lastGood.startedAt) : null,
      lastGoodBytes: entry.lastGood?.sizeBytes ?? null,
      latestError: entry.latest?.status === "failed" ? entry.latest.error : null,
      lastCheck: check ? { at: check.finishedAt ?? check.startedAt, ok: check.status === "ok", error: check.error } : null,
    };
  });

  if (!settings.keySet) {
    attention.push({ level: "error", text: "This server has no TOHYEE_SECRET_KEY, so it can't make backups (they're encrypted with it)." });
  }
  if (!settings.enabled) {
    attention.push({ level: "warning", text: "Nightly backups are off. Nothing is backed up unless someone presses Back up now." });
  }
  if (!input.folderExists) {
    attention.push({ level: "error", text: `The backup folder ${settings.folder} isn't there. Plug in its drive, sign in to its sync app, or choose the folder again.` });
  }
  for (const target of targets) {
    if (target.state === "failed") {
      attention.push({ level: "error", text: `The last backup of ${nameOf(target)} failed: ${target.latestError ?? "no message"}` });
    } else if (target.state === "never") {
      attention.push({ level: "warning", text: `${nameOf(target)} hasn't been backed up yet.` });
    } else if (target.state === "old") {
      attention.push({ level: "warning", text: `The newest good backup of ${nameOf(target)} is more than a day and a half old.` });
    }
    if (target.lastCheck && !target.lastCheck.ok) {
      attention.push({ level: "error", text: `The last check of ${nameOf(target)}'s newest backup file failed: ${target.lastCheck.error ?? "no message"}` });
    }
  }

  const damagedFiles = input.files.filter((file) => file.problem).map((file) => file.name);
  if (damagedFiles.length > 0) {
    attention.push({
      level: "warning",
      text: `${damagedFiles.length === 1 ? "A file" : `${damagedFiles.length} files`} in the backup folder can't be read as a Tohyee backup (${damagedFiles.slice(0, 3).join(", ")}${damagedFiles.length > 3 ? ", …" : ""}). Tohyee doesn't count or delete ${damagedFiles.length === 1 ? "it" : "them"}.`,
    });
  }

  const nextBackupBytes = targets.reduce((sum, target) => sum + (target.lastGoodBytes ?? 0), 0);
  const freeBytes = input.space?.freeBytes ?? null;
  if (freeBytes !== null && nextBackupBytes > 0) {
    if (freeBytes < nextBackupBytes) {
      attention.push({ level: "error", text: `There's only ${formatBytes(freeBytes)} free where the backups go, and the next backup needs about ${formatBytes(nextBackupBytes)}.` });
    } else if (freeBytes < nextBackupBytes * 3) {
      attention.push({ level: "warning", text: `Space is running low where the backups go: ${formatBytes(freeBytes)} free, about ${formatBytes(nextBackupBytes)} per backup.` });
    }
  }

  if (!destination.synced && destination.kind !== "network") {
    attention.push({ level: "warning", text: "The backups are only on this computer, so they'd be lost with it. Choose a OneDrive folder, or copy them to a USB drive kept elsewhere." });
  }
  notProven.push(`Off-site copy: ${destination.synced ? `Tohyee can't see whether ${destination.provider} uploaded the files` : "no off-site copy that Tohyee knows of"}.`);

  const kit = input.kit;
  if (settings.keySet && kit.keySet && !kit.checkedAt) {
    attention.push({
      level: "warning",
      text: `Nobody has checked a saved recovery kit${kit.version ? ` for recovery key version ${kit.version}` : ""}. Without one, the backups can't be opened on another computer if this one is lost.`,
    });
    notProven.push(`A saved recovery kit${kit.version ? ` for recovery key version ${kit.version}` : ""}.`);
  }
  const older = new Map<string, { version: number; id: string; files: number; newestMadeAt: string }>();
  const legacyCount = { files: 0, newestMadeAt: "" };
  for (const file of input.files) {
    const header = file.header;
    if (!header) continue;
    if (header.format === 1) {
      legacyCount.files += 1;
      if (header.createdAt > legacyCount.newestMadeAt) legacyCount.newestMadeAt = header.createdAt;
    } else if (header.recoveryKey.id !== kit.id) {
      const name = `${header.recoveryKey.version}:${header.recoveryKey.id}`;
      const entry = older.get(name) ?? { version: header.recoveryKey.version, id: header.recoveryKey.id, files: 0, newestMadeAt: header.createdAt };
      entry.files += 1;
      if (header.createdAt > entry.newestMadeAt) entry.newestMadeAt = header.createdAt;
      older.set(name, entry);
    }
  }
  const legacy = legacyCount.files > 0 ? legacyCount : null;
  if (legacy && !input.keyStatus.savedCopyCheckedAt) {
    attention.push({
      level: "warning",
      text: `${legacy.files} older ${legacy.files === 1 ? "backup was" : "backups were"} made before recovery kits and can only be opened on another computer with the older backup key (this server's TOHYEE_SECRET_KEY). Nobody has checked a saved copy of it: save one, or rely on the newer backups.`,
    });
  }

  const goodTimes = targets.map((t) => t.lastGoodAt);
  const everythingBackedUpAt = goodTimes.length > 0 && goodTimes.every(Boolean) ? (goodTimes as string[]).sort()[0] : null;
  const newestBackupAt = goodTimes.filter((t): t is string => Boolean(t)).sort().at(-1) ?? null;

  const backedUp = targets.filter((t) => t.lastGoodAt);
  const checkTimes = backedUp.map((t) => t.lastCheck?.at ?? null);
  const allCheckedAt = backedUp.length > 0 && checkTimes.every(Boolean) ? (checkTimes as string[]).sort()[0] : null;
  const failedChecks = backedUp.filter((t) => t.lastCheck && !t.lastCheck.ok).length;
  const unchecked = backedUp.filter((t) => !t.lastCheck).length;
  if (backedUp.length > 0 && (!allCheckedAt || now.getTime() - new Date(allCheckedAt).getTime() > CHECK_STALE_DAYS * 24 * HOUR)) {
    notProven.push("That the backup files are still whole: they haven't all been checked again in the last week.");
  }

  return {
    everythingBackedUpAt,
    newestBackupAt,
    targets,
    integrity: { allCheckedAt, failed: failedChecks, unchecked },
    destination: { ...destination, description: describeDestination(destination) },
    offSite: { verified: false, note: offSiteNote(destination) },
    storage: {
      fileCount: input.files.length,
      usedBytes: input.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      damagedFiles,
      freeBytes,
      nextBackupBytes,
    },
    recoveryKit: {
      version: kit.version,
      id: kit.id,
      checkedAt: kit.checkedAt,
      checkedByEmail: kit.checkedByEmail,
      olderVersions: [...older.values()].sort((a, b) => b.version - a.version).map((entry) => ({ ...entry, keepKitUntilAbout: aYearAfter(entry.newestMadeAt) })),
      legacyFiles: legacy ? { ...legacy, keepKeyUntilAbout: aYearAfter(legacy.newestMadeAt), keyCheckedAt: input.keyStatus.savedCopyCheckedAt } : null,
    },
    attention,
    notProven,
  };
}

/** The overview, from the database, the folder and the disk. */
export async function backupOverview(now = new Date()): Promise<{ overview: BackupOverview; files: BackupFile[] }> {
  const settings = await getBackupSettings();
  const files = await listBackupFiles();
  const exists = await fs
    .stat(/* turbopackIgnore: true */ settings.folder)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  // The default folder is Tohyee's own and is made by the first backup.
  const folderExists = exists || settings.folder === settings.defaultFolder;
  const overview = summariseBackups({
    now,
    settings,
    folderExists,
    space: await diskSpace(settings.folder),
    files,
    status: await backupStatus(),
    checks: await latestChecks("integrity"),
    keyStatus: await backupKeyStatus(),
    kit: await recoveryKitStatus(),
  });
  return { overview, files };
}

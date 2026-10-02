import packageJson from "../../../package.json";
import type { AuthContext } from "@/lib/auth/guard";
import { backUpNow, type BackupRun } from "@/lib/backups/service";
import { ConflictError, UnavailableError, ValidationError } from "@/lib/errors";
import { blockedOrganisations, latestServerStart, lastVersionChange, type ServerStart } from "@/lib/updates/server-starts";
import { checkForUpdatesNow, updateCheckState, type UpdateCheckState, windowsSetupFor, type WindowsSetup } from "@/lib/updates/update-checker";

/**
 * Updates as the server app and the server settings pages see them
 * (decisions 328 to 331).
 */

export type UpdateSummary = {
  currentVersion: string;
  checkedAt: string | null;
  nextCheckAt: string | null;
  checkError: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseName: string | null;
  publishedAt: string | null;
  releaseNotesUrl: string | null;
  /** The latest server start: after an update, whether the new version came up and how the upgrades went. */
  lastStart: {
    version: string;
    previousVersion: string | null;
    startedAt: string;
    organisationsChecked: number;
    organisationsUpgraded: number;
    organisationsBlocked: number;
  } | null;
};

function startSummary(start: ServerStart | null): UpdateSummary["lastStart"] {
  if (!start) return null;
  return {
    version: start.version,
    previousVersion: start.previousVersion,
    startedAt: start.startedAt,
    organisationsChecked: start.organisationsChecked,
    organisationsUpgraded: start.organisationsUpgraded,
    organisationsBlocked: start.organisationsBlocked.length,
  };
}

export function summariseCheck(check: UpdateCheckState, currentVersion: string = packageJson.version): Omit<UpdateSummary, "lastStart"> {
  const result = check.result;
  return {
    currentVersion,
    checkedAt: check.checkedAt,
    nextCheckAt: check.nextCheckAt,
    checkError: check.error,
    latestVersion: result?.latestVersion ?? null,
    // Compared when GitHub answered; still right because this server's version can't change without a restart.
    updateAvailable: result?.updateAvailable ?? false,
    releaseName: result ? (result.release.name ?? result.release.tagName) : null,
    publishedAt: result?.release.publishedAt ?? null,
    releaseNotesUrl: result?.release.htmlUrl ?? null,
  };
}

/**
 * What the tray icon shows without signing in (it's on the server computer
 * itself): versions, whether an update is out, and counts from the last
 * start. No organisation names or errors.
 */
export async function updateSummary(): Promise<UpdateSummary> {
  let lastStart: ServerStart | null = null;
  try {
    lastStart = await latestServerStart();
  } catch {
    // The core database isn't answering; the versions still help.
  }
  return { ...summariseCheck(updateCheckState()), lastStart: startSummary(lastStart) };
}

/** The Updates page, for a signed-in server admin: the summary, the last update, and which organisations are blocked. */
export async function updateDetails() {
  return {
    ...(await updateSummary()),
    lastUpdate: await lastVersionChange(),
    blockedOrganisations: await blockedOrganisations(),
    platform: process.platform,
  };
}

export type PreparedUpdate = {
  currentVersion: string;
  version: string;
  setup: WindowsSetup;
  backups: BackupRun[];
};

/**
 * The first half of "Install" in the server app (decision 329): checks GitHub
 * again, finds the Windows installer and its SHA-256, then backs up every
 * organisation and the server's own database. Only when every backup worked
 * does it hand back the installer to download; the server app checks the
 * download against the SHA-256 and runs it. `version` is the version the
 * person agreed to install; if a newer one has come out since, it stops so
 * they can look again.
 */
export async function prepareUpdate(auth: AuthContext, body: Record<string, unknown>): Promise<PreparedUpdate> {
  const wanted = typeof body.version === "string" ? body.version.trim().replace(/^v/i, "") : "";
  if (!wanted) throw new ValidationError("Say which version to install (version).");
  const check = await checkForUpdatesNow();
  if (!check.result) {
    throw new UnavailableError(check.error ?? "Couldn't check GitHub for the latest release.");
  }
  if (check.error) {
    throw new UnavailableError(`Couldn't check GitHub again just now: ${check.error}`);
  }
  const latest = check.result;
  if (!latest.updateAvailable) {
    throw new ConflictError(`This server already runs v${latest.currentVersion}, the latest release.`);
  }
  if (latest.latestVersion !== wanted) {
    throw new ConflictError(`The latest release is now v${latest.latestVersion}, not v${wanted}. Check again before installing.`);
  }
  const found = await windowsSetupFor(latest);
  if ("problem" in found) throw new UnavailableError(found.problem);
  const backups = await backUpNow({ trigger: "update", requestedByEmail: auth.user.email });
  const failed = backups.filter((run) => run.status !== "ok");
  if (failed.length > 0) {
    throw new ConflictError(
      `The update wasn't started because ${failed.length === 1 ? "a backup" : `${failed.length} backups`} failed: ${failed
        .map((run) => `${run.organisationId ?? "the server's own database"} (${run.error ?? "no message"})`)
        .join("; ")}. Fix that on the Backups page, then try again.`,
    );
  }
  return { currentVersion: latest.currentVersion, version: latest.latestVersion, setup: found.setup, backups };
}

import { getLatestReleaseCheck, UPDATE_FETCH_TIME_LIMIT_MS, type LatestReleaseCheck, type ReleaseAsset } from "@/lib/updates/server-updates";

/**
 * Checks GitHub for a new Tohyee release by itself (decision 328): a minute
 * after the server starts, then once a day. The last answer is kept in
 * memory (it's only a copy of what GitHub says, so nothing is stored) and
 * shown by the server app and the server settings pages. A check can also be
 * asked for at any time. Off with TOHYEE_UPDATE_CHECK=off.
 */

export const FIRST_CHECK_AFTER_MS = 60 * 1000;
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

export type UpdateCheckState = {
  /** When the last check finished (null before the first). */
  checkedAt: string | null;
  /** The last successful answer (kept when a later check fails). */
  result: LatestReleaseCheck | null;
  /** Why the last check failed (null when it worked). */
  error: string | null;
  /** When the next automatic check is due (null when automatic checks are off). */
  nextCheckAt: string | null;
};

type Holder = typeof globalThis & {
  __tohyeeUpdateCheck?: UpdateCheckState;
  __tohyeeUpdateTimer?: ReturnType<typeof setTimeout>;
  __tohyeeUpdateRunning?: Promise<UpdateCheckState>;
};
const holder = globalThis as Holder;

function state(): UpdateCheckState {
  holder.__tohyeeUpdateCheck ??= { checkedAt: null, result: null, error: null, nextCheckAt: null };
  return holder.__tohyeeUpdateCheck;
}

export function updateCheckState(): UpdateCheckState {
  return { ...state() };
}

/** Asks GitHub now. Two at once share one request. */
export function checkForUpdatesNow(now: () => Date = () => new Date()): Promise<UpdateCheckState> {
  holder.__tohyeeUpdateRunning ??= (async () => {
    const current = state();
    try {
      current.result = await getLatestReleaseCheck();
      current.error = null;
    } catch (error) {
      current.error = error instanceof Error ? error.message : "Couldn't check GitHub for the latest release.";
    } finally {
      current.checkedAt = now().toISOString();
    }
    return { ...current };
  })().finally(() => {
    holder.__tohyeeUpdateRunning = undefined;
  });
  return holder.__tohyeeUpdateRunning;
}

function schedule(delay: number): void {
  const timer = setTimeout(() => {
    void checkForUpdatesNow().finally(() => schedule(CHECK_EVERY_MS));
  }, delay);
  timer.unref?.();
  holder.__tohyeeUpdateTimer = timer;
  state().nextCheckAt = new Date(Date.now() + delay).toISOString();
}

export function startUpdateChecker(): void {
  if (holder.__tohyeeUpdateTimer) return;
  schedule(FIRST_CHECK_AFTER_MS);
}

export function stopUpdateChecker(): void {
  if (holder.__tohyeeUpdateTimer) clearTimeout(holder.__tohyeeUpdateTimer);
  holder.__tohyeeUpdateTimer = undefined;
  state().nextCheckAt = null;
}

/** For tests: forget the last check. */
export function resetUpdateCheckState(): void {
  stopUpdateChecker();
  holder.__tohyeeUpdateCheck = undefined;
  holder.__tohyeeUpdateRunning = undefined;
}

// ------------------------------------------------------------------ the Windows installer

export type WindowsSetup = {
  name: string;
  downloadUrl: string;
  size: number;
  /** Lower-case hex SHA-256 of the installer, from GitHub; the server app checks the download against it. */
  sha256: string;
  /** Where the fingerprint came from. */
  sha256From: "github-digest" | "sha256-file";
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** "sha256:abc…" (GitHub's asset digest) as hex; null for anything else. */
export function sha256FromDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const match = /^sha256:([0-9a-fA-F]{64})$/.exec(digest.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * The first word of a .sha256 file (build.ps1 writes "<hex>  <file name>"),
 * when it names this file. Null if it isn't a SHA-256 for that file.
 */
export function sha256FromFile(text: string, fileName: string): string | null {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  const [hash, name] = line.trim().split(/\s+\*?/, 2);
  if (!hash || !SHA256_HEX.test(hash.toLowerCase())) return null;
  if (name !== undefined && name.length > 0 && name !== fileName) return null;
  return hash.toLowerCase();
}

/** The release's TohyeeSetup-<version>.exe, if it has one. */
export function findWindowsSetupAsset(check: LatestReleaseCheck): ReleaseAsset | null {
  const wanted = `tohyeesetup-${check.latestVersion}.exe`.toLowerCase();
  return check.release.assets.find((asset) => asset.name.toLowerCase() === wanted) ?? null;
}

/**
 * The Windows installer for the latest release with its SHA-256: from
 * GitHub's own digest of the file if it gives one, otherwise from the
 * TohyeeSetup-<version>.exe.sha256 file the release build uploads beside it.
 * Refuses (returns a reason) when there's no installer or no fingerprint,
 * because then the download can't be checked.
 */
export async function windowsSetupFor(
  check: LatestReleaseCheck,
  fetcher: typeof fetch = fetch,
): Promise<{ setup: WindowsSetup } | { problem: string }> {
  const asset = findWindowsSetupAsset(check);
  if (!asset) {
    return { problem: `Release v${check.latestVersion} has no TohyeeSetup-${check.latestVersion}.exe, so it can't be installed from here.` };
  }
  const fromDigest = sha256FromDigest(asset.digest);
  if (fromDigest) {
    return { setup: { name: asset.name, downloadUrl: asset.downloadUrl, size: asset.size, sha256: fromDigest, sha256From: "github-digest" } };
  }
  const sidecar = check.release.assets.find((other) => other.name.toLowerCase() === `${asset.name.toLowerCase()}.sha256`);
  if (sidecar) {
    try {
      const response = await fetcher(sidecar.downloadUrl, {
        headers: { "user-agent": "tohyee-update-check" },
        cache: "no-store",
        signal: AbortSignal.timeout(UPDATE_FETCH_TIME_LIMIT_MS),
      });
      if (response.ok) {
        const hash = sha256FromFile(await response.text(), asset.name);
        if (hash) {
          return { setup: { name: asset.name, downloadUrl: asset.downloadUrl, size: asset.size, sha256: hash, sha256From: "sha256-file" } };
        }
      }
    } catch {
      // Falls through to the refusal below.
    }
  }
  return {
    problem: `Couldn't get a SHA-256 fingerprint for ${asset.name} from GitHub, so the download can't be checked. Download it from the release page and run it yourself instead.`,
  };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { folderAccessHint } from "@/lib/server-admin/folder-access";

/**
 * Where backups go, and what can honestly be said about it (#389, decision
 * 731). Tohyee writes files into a folder; it can't see whether OneDrive or
 * Google Drive then uploaded them, so a synced folder is never reported as
 * "off-site confirmed".
 */

export type DestinationKind = "onedrive" | "google-drive" | "dropbox" | "icloud" | "network" | "local";

export type Destination = {
  kind: DestinationKind;
  /** The sync provider's name, for synced folders. */
  provider: string | null;
  /** Whether a sync app (not Tohyee) is meant to copy the files elsewhere. */
  synced: boolean;
};

const PROVIDERS: { kind: DestinationKind; provider: string; segment: RegExp }[] = [
  // OneDrive personal is "OneDrive"; work or school accounts are "OneDrive - Company".
  { kind: "onedrive", provider: "OneDrive", segment: /^onedrive( - .+)?$/i },
  { kind: "google-drive", provider: "Google Drive", segment: /^(my drive|google drive|googledrive)$/i },
  { kind: "dropbox", provider: "Dropbox", segment: /^dropbox( \(.+\))?$/i },
  { kind: "icloud", provider: "iCloud Drive", segment: /^(icloud ?drive|icloud~.+)$/i },
];

/** What kind of place a backup folder is, from its path alone. */
export function classifyDestination(folder: string): Destination {
  const trimmed = folder.trim();
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  for (const candidate of PROVIDERS) {
    if (segments.some((segment) => candidate.segment.test(segment))) {
      return { kind: candidate.kind, provider: candidate.provider, synced: true };
    }
  }
  if (/^(\\\\|\/\/)[^\\/]/.test(trimmed)) return { kind: "network", provider: null, synced: false };
  return { kind: "local", provider: null, synced: false };
}

/** Plain words for where the backups are. */
export function describeDestination(destination: Destination): string {
  switch (destination.kind) {
    case "network":
      return "a network folder";
    case "local":
      return "a folder on this computer";
    default:
      return `a ${destination.provider} folder`;
  }
}

/**
 * What off-site means for this folder. Always "not verified": nothing Tohyee
 * can see proves a sync app uploaded a file (it may be paused, signed out,
 * out of storage, or only run while someone is signed in to Windows).
 */
export function offSiteNote(destination: Destination): string {
  if (destination.synced) {
    return `Not verified. Tohyee saves backups into your ${destination.provider} folder, but it can't see whether ${destination.provider} has uploaded them: sync can be paused, signed out or out of storage, and it usually only runs while someone is signed in to Windows. Check the ${destination.provider} icon by the clock, and that the newest file is on the ${destination.provider} website.`;
  }
  if (destination.kind === "network") {
    return "Not verified. The backups are on a network folder; Tohyee can't tell whether that's in another building or backed up itself.";
  }
  return "No off-site copy: the backups are only on this computer, so they'd be lost with it. Choose a OneDrive folder, or copy the backup folder to a USB drive you keep elsewhere.";
}

export type DiskSpace = { freeBytes: number; totalBytes: number };

/** Free space on the disk holding the folder (its nearest existing parent); null if it can't be read. */
export async function diskSpace(folder: string): Promise<DiskSpace | null> {
  let current = path.resolve(/* turbopackIgnore: true */ folder);
  for (let i = 0; i < 64; i += 1) {
    try {
      const stats = await fs.statfs(current);
      return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

/** Room left on top of the expected size before a backup is refused: 64 MB. */
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * Whether a backup of about `expectedBytes` fits. Refused only when it
 * clearly can't (less free than expected plus a margin): an estimate is from
 * the last backup, so a backup is never refused on a guess that's close.
 */
export function notEnoughSpace(space: DiskSpace | null, expectedBytes: number): boolean {
  if (!space || expectedBytes <= 0) return false;
  return space.freeBytes < expectedBytes + SPACE_MARGIN_BYTES;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/**
 * A backup failure in words that say what to do (decision 731). The older
 * backups are always kept when one fails, and the message says so.
 */
export function explainBackupError(error: unknown, folder: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const raw = error instanceof Error ? error.message : String(error);
  const kept = " The older backups were kept.";
  const destination = classifyDestination(folder);
  switch (code) {
    case "ENOENT":
      return `The backup folder ${folder} isn't there.${
        destination.synced
          ? ` Check ${destination.provider} is installed and signed in on this computer, or choose the folder again.`
          : destination.kind === "network"
            ? " Check the network folder is reachable from this computer."
            : " If it's on a USB or external drive, plug it in; otherwise choose the folder again."
      }${kept}`;
    case "EACCES":
    case "EPERM":
      return `Tohyee isn't allowed to write to ${folder}.${folderAccessHint(folder, "write") || " Give the account Tohyee runs as permission to change that folder."}${kept}`;
    case "ENOSPC":
      return `The disk holding ${folder} is full. Free up space or choose a folder on a bigger disk.${kept}`;
    case "EDQUOT":
      return `The storage quota for ${folder} is used up. Free up space or choose another folder.${kept}`;
    case "EROFS":
      return `${folder} is on a read-only drive. Choose a folder Tohyee can write to.${kept}`;
    default:
      return raw.endsWith(".") ? `${raw}${kept}` : `${raw}.${kept}`;
  }
}

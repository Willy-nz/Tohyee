import { spawnSync } from "node:child_process";
import fs from "node:fs";

/**
 * On Windows the Tohyee service runs as its own limited account (decision
 * 486), not as SYSTEM, so it can only use folders it has been given: its own
 * data folders (the installer gives those), and each folder a server admin
 * chooses for backups, analytics or bank files (the server app, the command
 * line and the installer give those).
 */
export const WINDOWS_SERVICE_ACCOUNT = "NT SERVICE\\Tohyee";

type Access = "read" | "write";

/**
 * Whether the folder can really be listed. fs.accessSync(R_OK) doesn't look
 * at Windows permissions (only the read-only flag), so it said yes to folders
 * the service can't open.
 */
export function canListFolder(folder: string): boolean {
  try {
    if (!fs.statSync(/* turbopackIgnore: true */ folder).isDirectory()) return false;
    fs.readdirSync(/* turbopackIgnore: true */ folder);
    return true;
  } catch {
    return false;
  }
}

/** What to do when the service can't use a folder (Windows only; empty elsewhere). */
export function folderAccessHint(folder: string, access: Access): string {
  if (process.platform !== "win32") return "";
  const rights = access === "read" ? "RX" : "M";
  return ` Tohyee's Windows service runs as its own limited account (${WINDOWS_SERVICE_ACCOUNT}), which needs permission to ${access} this folder. Choose the folder in the Tohyee server app (it gives that permission), or run this as an administrator: icacls "${folder}" /grant "${WINDOWS_SERVICE_ACCOUNT}:(OI)(CI)${rights}"`;
}

/**
 * Gives the service account access to a folder (the command-line tool, run
 * as an administrator on the server). Windows only; returns why it couldn't,
 * or null. Elsewhere there's nothing to do.
 */
export function grantServiceAccess(folder: string, access: Access): string | null {
  if (process.platform !== "win32") return null;
  try {
    fs.mkdirSync(/* turbopackIgnore: true */ folder, { recursive: true });
  } catch {
    // icacls says why below.
  }
  const rights = access === "read" ? "RX" : "M";
  const result = spawnSync("icacls.exe", [folder, "/grant", `${WINDOWS_SERVICE_ACCOUNT}:(OI)(CI)${rights}`, "/Q"], { encoding: "utf8", windowsHide: true });
  if (result.status === 0) return null;
  return (result.stderr || result.stdout || result.error?.message || `icacls exited with ${result.status}`).trim();
}

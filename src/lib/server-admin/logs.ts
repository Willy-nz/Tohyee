import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Server › Logs (Will, 13 Nov 2026; decision 1607): the server's own log
 * files (the Windows service's out and err logs and the installer's
 * setup.log), read-only, for server admins on the server computer, so an
 * error the app only reports as "Something went wrong" can be looked up
 * without opening the folder. Only *.log files directly in the log folder
 * are listed or read; the newest part of a file is shown.
 */

export type LogFile = { name: string; size: number; modifiedAt: string };
export type LogTail = { name: string; size: number; modifiedAt: string; from: number; truncated: boolean; lines: string[] };

/** The most of one file read at once: its last 512 KB. */
export const LOG_TAIL_BYTES = 512 * 1024;

/**
 * Where the logs are: TOHYEE_LOG_DIR, else the "logs" folder beside the
 * backups folder (the Windows install keeps both in %ProgramData%\Tohyee),
 * else none (a server run another way writes to its console).
 */
export function logDirectory(): string | null {
  const configured = process.env.TOHYEE_LOG_DIR?.trim();
  if (configured) return configured;
  const backups = process.env.TOHYEE_BACKUP_DIR?.trim();
  if (backups) return path.join(path.dirname(backups), "logs");
  return null;
}

export async function listLogFiles(dir = logDirectory()): Promise<LogFile[]> {
  if (!dir) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: LogFile[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".log")) continue;
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    files.push({ name, size: info.size, modifiedAt: info.mtime.toISOString() });
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
}

/**
 * The newest part of one log file, newest line last, optionally only lines
 * containing `search` (any case). The name must be one listLogFiles gives,
 * so nothing outside the log folder can be read.
 */
export async function readLogTail(name: unknown, options: { search?: string | null; bytes?: number } = {}, dir = logDirectory()): Promise<LogTail> {
  if (typeof name !== "string" || name === "") throw new ValidationError("Choose a log file.");
  const file = (await listLogFiles(dir)).find((entry) => entry.name === name);
  if (!dir || !file) throw new NotFoundError("That log file isn't in the log folder.");
  const bytes = Math.max(1, Math.min(options.bytes ?? LOG_TAIL_BYTES, LOG_TAIL_BYTES));
  const from = Math.max(0, file.size - bytes);
  const handle = await open(path.join(dir, file.name), "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(file.size - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  let lines = text.split(/\r?\n/);
  if (from > 0) lines = lines.slice(1); // the first line was cut part-way
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const search = options.search?.trim().toLowerCase();
  if (search) lines = lines.filter((line) => line.toLowerCase().includes(search));
  return { name: file.name, size: file.size, modifiedAt: file.modifiedAt, from, truncated: from > 0, lines };
}

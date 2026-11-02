import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { FILE_ID, isQueuedFile, type QueuedFile, SEALED_OVERHEAD, sealFile } from "@/lib/camera-postbox/protocol";

/*
 * The post box's queue: each photo or clip a camera sent, sealed to
 * Tohyee's public key (`<id>.sealed`), and beside it what Tohyee needs to
 * know (`<id>.json`: the camera's login, the file's name, when it came and
 * its SHA-256). The metadata is written last, so a listed file is always
 * whole. A file is deleted only when Tohyee says it has it, or when it's
 * older than the post box's limit (30 days unless set).
 */

export type Queue = {
  add: (input: { tempPath: string; username: string; cameraId: string; fileName: string; receivedAt: Date; sizeBytes: number; sha256: string }, publicKey: string) => Promise<"saved" | "duplicate">;
  list: (limit: number) => QueuedFile[];
  get: (id: string) => QueuedFile | null;
  sealedPath: (id: string) => string;
  remove: (id: string) => Promise<boolean>;
  totals: () => { files: number; bytes: number; oldest: string | null; lastReceivedAt: string | null };
  expire: (now: Date, maxAgeDays: number) => Promise<number>;
  disk: () => Promise<{ freeBytes: number; totalBytes: number }>;
};

export async function openQueue(folder: string): Promise<Queue> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const files = new Map<string, QueuedFile>();
  let lastReceivedAt: string | null = null;
  for (const name of await readdir(folder)) {
    const full = path.join(folder, name);
    if (name.endsWith(".part") || name.endsWith(".tmp")) {
      // Left by a stop part way through: never listed, so never collected.
      await rm(full, { force: true });
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const file = JSON.parse(await readFile(full, "utf8"));
      if (isQueuedFile(file) && (await stat(path.join(folder, `${file.id}.sealed`))).size === file.storedBytes) files.set(file.id, file);
    } catch {
      // Unreadable metadata, or its sealed file is missing: skipped (and cleaned up by age).
    }
  }
  for (const name of await readdir(folder)) {
    const id = name.replace(/\.(sealed|json)$/, "");
    if (!files.has(id) && /\.(sealed|json)$/.test(name)) {
      const age = Date.now() - (await stat(path.join(folder, name))).mtimeMs;
      if (age > 60 * 60_000) await rm(path.join(folder, name), { force: true });
    }
  }
  const sealedPath = (id: string) => {
    if (!FILE_ID.test(id)) throw new Error("Not a file in the queue.");
    return path.join(folder, `${id}.sealed`);
  };
  const remove = async (id: string) => {
    if (!files.has(id)) return false;
    files.delete(id);
    await rm(path.join(folder, `${id}.json`), { force: true });
    await rm(sealedPath(id), { force: true });
    return true;
  };
  const ordered = () => [...files.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    async add(input, publicKey) {
      for (const file of files.values()) if (file.username === input.username && file.sha256 === input.sha256) return "duplicate";
      const id = `${String(input.receivedAt.getTime()).padStart(13, "0")}-${randomBytes(8).toString("hex")}`;
      const sealed = sealedPath(id);
      await sealFile(input.tempPath, `${sealed}.part`, publicKey);
      await rename(`${sealed}.part`, sealed);
      const file: QueuedFile = { id, username: input.username, cameraId: input.cameraId, fileName: input.fileName.slice(0, 255), receivedAt: input.receivedAt.toISOString(), sizeBytes: input.sizeBytes, sha256: input.sha256, storedBytes: input.sizeBytes + SEALED_OVERHEAD };
      await writeFile(path.join(folder, `${id}.json.tmp`), JSON.stringify(file), { mode: 0o600 });
      await rename(path.join(folder, `${id}.json.tmp`), path.join(folder, `${id}.json`));
      files.set(id, file);
      lastReceivedAt = file.receivedAt;
      return "saved";
    },
    list: (limit) => ordered().slice(0, limit),
    get: (id) => files.get(id) ?? null,
    sealedPath,
    remove,
    totals() {
      const all = ordered();
      return { files: all.length, bytes: all.reduce((sum, file) => sum + file.storedBytes, 0), oldest: all[0]?.receivedAt ?? null, lastReceivedAt };
    },
    async expire(now, maxAgeDays) {
      const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60_000;
      let removed = 0;
      for (const file of ordered()) {
        if (Date.parse(file.receivedAt) >= cutoff) break;
        if (await remove(file.id)) removed += 1;
      }
      return removed;
    },
    async disk() {
      const stats = await statfs(folder);
      return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
    },
  };
}

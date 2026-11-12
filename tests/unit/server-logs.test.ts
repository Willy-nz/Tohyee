import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listLogFiles, logDirectory, readLogTail } from "@/lib/server-admin/logs";

/** Server › Logs (decision 1599): only *.log files in the log folder, newest part, searchable. */
describe("server logs", () => {
  async function folder() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tohyee-logs-"));
    await writeFile(path.join(dir, "Tohyee.out.log"), "started\nready on 3000\n");
    await writeFile(path.join(dir, "Tohyee.err.log"), "MCP tool failed void_own_journal error: permission denied for table ledger_journals\nanother line\n");
    await writeFile(path.join(dir, "tohyee.env"), "SECRET=1\n");
    await mkdir(path.join(dir, "sub.log"));
    return dir;
  }

  it("lists only .log files, and reads the newest part, searchable", async () => {
    const dir = await folder();
    expect((await listLogFiles(dir)).map((file) => file.name).sort()).toEqual(["Tohyee.err.log", "Tohyee.out.log"]);
    const all = await readLogTail("Tohyee.out.log", {}, dir);
    expect(all).toMatchObject({ truncated: false, lines: ["started", "ready on 3000"] });
    const found = await readLogTail("Tohyee.err.log", { search: "PERMISSION denied" }, dir);
    expect(found.lines).toEqual(["MCP tool failed void_own_journal error: permission denied for table ledger_journals"]);
    // The last 16 bytes start part-way through "started"; that cut line is left out.
    expect(await readLogTail("Tohyee.out.log", { bytes: 16 }, dir)).toMatchObject({ truncated: true, from: 6, lines: ["ready on 3000"] });
  });

  it("refuses anything that isn't a listed log file", async () => {
    const dir = await folder();
    await expect(readLogTail("tohyee.env", {}, dir)).rejects.toThrow("isn't in the log folder");
    await expect(readLogTail("../etc/passwd.log", {}, dir)).rejects.toThrow("isn't in the log folder");
    await expect(readLogTail("sub.log", {}, dir)).rejects.toThrow("isn't in the log folder");
    await expect(readLogTail("", {}, dir)).rejects.toThrow("Choose a log file");
    expect(await listLogFiles(path.join(dir, "missing"))).toEqual([]);
  });

  it("finds the folder from TOHYEE_LOG_DIR, else beside the backups", () => {
    const saved = { log: process.env.TOHYEE_LOG_DIR, backup: process.env.TOHYEE_BACKUP_DIR };
    try {
      process.env.TOHYEE_LOG_DIR = "/data/logs";
      expect(logDirectory()).toBe("/data/logs");
      delete process.env.TOHYEE_LOG_DIR;
      process.env.TOHYEE_BACKUP_DIR = path.join("/data", "backups");
      expect(logDirectory()).toBe(path.join("/data", "logs"));
      delete process.env.TOHYEE_BACKUP_DIR;
      expect(logDirectory()).toBeNull();
    } finally {
      if (saved.log === undefined) delete process.env.TOHYEE_LOG_DIR;
      else process.env.TOHYEE_LOG_DIR = saved.log;
      if (saved.backup === undefined) delete process.env.TOHYEE_BACKUP_DIR;
      else process.env.TOHYEE_BACKUP_DIR = saved.backup;
    }
  });
});

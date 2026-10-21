import { describe, expect, it } from "vitest";
import type { BackupCheck } from "@/lib/backups/checks";
import { type OverviewInput, summariseBackups } from "@/lib/backups/overview";
import type { BackupRun } from "@/lib/backups/service";

const NOW = new Date("2026-10-21T09:00:00Z");
const MB = 1024 * 1024;

function run(organisationId: string | null, status: BackupRun["status"], finishedAt: string, error: string | null = null, sizeBytes = 5 * MB): BackupRun {
  return { id: "1", organisationId, trigger: "schedule", status, startedAt: finishedAt, finishedAt, filePath: null, sizeBytes, sha256: null, error };
}

function check(organisationId: string | null, status: "ok" | "failed", at: string, error: string | null = null): BackupCheck {
  return { id: "1", kind: "integrity", organisationId, status, startedAt: at, finishedAt: at, fileName: null, details: {}, error, requestedByEmail: null };
}

function input(overrides: Partial<OverviewInput> = {}): OverviewInput {
  const good = run("kowhai", "ok", "2026-10-21T02:01:00Z");
  const server = run(null, "ok", "2026-10-21T02:00:30Z");
  return {
    now: NOW,
    settings: { enabled: true, keySet: true, folder: "C:\\Users\\jess\\OneDrive\\Tohyee backups", time: "02:00" },
    folderExists: true,
    space: { freeBytes: 10_000 * MB, totalBytes: 50_000 * MB },
    files: [
      { name: "kowhai/kowhai_2026-10-21_020100.tohyee-backup", sizeBytes: 5 * MB, problem: null },
      { name: "_server/server_2026-10-21_020030.tohyee-backup", sizeBytes: 5 * MB, problem: null },
    ],
    status: [
      { organisationId: null, displayName: null, latest: server, lastGood: server },
      { organisationId: "kowhai", displayName: "Kōwhai Dairies", latest: good, lastGood: good },
    ],
    checks: [check(null, "ok", "2026-10-19T03:00:00Z"), check("kowhai", "ok", "2026-10-19T03:00:00Z")],
    keyStatus: { keySet: true, savedCopyCheckedAt: "2026-10-01T00:00:00Z" },
    ...overrides,
  };
}

describe("the Backups panel's overview (decision 733)", () => {
  it("everything backed up and checked: no problems, but off-site is still not proven", () => {
    const overview = summariseBackups(input());
    expect(overview.everythingBackedUpAt).toBe("2026-10-21T02:00:30Z");
    expect(overview.newestBackupAt).toBe("2026-10-21T02:01:00Z");
    expect(overview.integrity).toEqual({ allCheckedAt: "2026-10-19T03:00:00Z", failed: 0, unchecked: 0 });
    expect(overview.attention).toEqual([]);
    expect(overview.offSite.verified).toBe(false);
    expect(overview.offSite.note).toMatch(/^Not verified/);
    expect(overview.notProven).toEqual(["Off-site copy: Tohyee can't see whether OneDrive uploaded the files."]);
    expect(overview.storage).toMatchObject({ fileCount: 2, usedBytes: 10 * MB, nextBackupBytes: 10 * MB, damagedFiles: [] });
    // There's no "safe" verdict to show.
    expect(JSON.stringify(overview)).not.toMatch(/"safe"|fully recoverable/i);
  });

  it("a failed backup, one never made and an old one each need attention", () => {
    const failed = run("kowhai", "failed", "2026-10-21T02:05:00Z", "The disk holding X is full.");
    const overview = summariseBackups(
      input({
        status: [
          { organisationId: null, displayName: null, latest: run(null, "ok", "2026-10-18T02:00:00Z"), lastGood: run(null, "ok", "2026-10-18T02:00:00Z") },
          { organisationId: "kowhai", displayName: "Kōwhai Dairies", latest: failed, lastGood: run("kowhai", "ok", "2026-10-20T02:00:00Z") },
          { organisationId: "kereru", displayName: "Kererū Joinery", latest: null, lastGood: null },
        ],
      }),
    );
    expect(overview.targets.map((t) => t.state)).toEqual(["old", "failed", "never"]);
    expect(overview.everythingBackedUpAt).toBeNull();
    expect(overview.attention.map((a) => a.level)).toEqual(["warning", "error", "warning"]);
    expect(overview.attention[1].text).toBe("The last backup of Kōwhai Dairies failed: The disk holding X is full.");
  });

  it("a failed or missing check of the files is shown, and an old check is listed as not proven", () => {
    const overview = summariseBackups(input({ checks: [check("kowhai", "failed", "2026-10-20T03:00:00Z", "This backup is damaged or was changed after it was made, so it can't be trusted.")] }));
    expect(overview.integrity).toEqual({ allCheckedAt: null, failed: 1, unchecked: 1 });
    expect(overview.attention).toEqual([
      { level: "error", text: "The last check of Kōwhai Dairies's newest backup file failed: This backup is damaged or was changed after it was made, so it can't be trusted." },
    ]);
    expect(overview.notProven).toContain("That the backup files are still whole: they haven't all been checked again in the last week.");
  });

  it("a missing folder, low space, damaged files, an unsaved key and a folder only on this computer", () => {
    const overview = summariseBackups(
      input({
        settings: { enabled: true, keySet: true, folder: "D:\\Tohyee backups", time: "02:00" },
        folderExists: false,
        space: { freeBytes: 25 * MB, totalBytes: 1000 * MB },
        files: [{ name: "kowhai/kowhai_2026-10-20_020000.tohyee-backup", sizeBytes: 3, problem: "damaged" }],
        keyStatus: { keySet: true, savedCopyCheckedAt: null },
      }),
    );
    const texts = overview.attention.map((a) => a.text);
    expect(texts[0]).toMatch(/^The backup folder D:\\Tohyee backups isn't there/);
    expect(texts).toContainEqual(expect.stringMatching(/can't be read as a Tohyee backup \(kowhai\/kowhai_2026-10-20_020000\.tohyee-backup\)\. Tohyee doesn't count or delete it\./));
    expect(texts).toContainEqual("Space is running low where the backups go: 25.0 MB free, about 10.0 MB per backup.");
    expect(texts).toContainEqual(expect.stringMatching(/^The backups are only on this computer/));
    expect(texts).toContainEqual(expect.stringMatching(/^Nobody has checked a saved copy of the backup key/));
    expect(overview.offSite.note).toMatch(/^No off-site copy/);
  });
});

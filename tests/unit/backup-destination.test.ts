import { describe, expect, it } from "vitest";
import { classifyDestination, explainBackupError, notEnoughSpace, offSiteNote } from "@/lib/backups/destination";

describe("where backups go (decision 731)", () => {
  it("recognises synced folders from the path, on Windows and elsewhere", () => {
    expect(classifyDestination("C:\\Users\\jess\\OneDrive\\Tohyee backups")).toEqual({ kind: "onedrive", provider: "OneDrive", synced: true });
    expect(classifyDestination("C:\\Users\\jess\\OneDrive - Kowhai Farms Ltd\\Backups").kind).toBe("onedrive");
    expect(classifyDestination("G:\\My Drive\\Tohyee backups").kind).toBe("google-drive");
    expect(classifyDestination("/Users/jess/Library/CloudStorage/Dropbox/tohyee").kind).toBe("dropbox");
    expect(classifyDestination("C:\\Users\\jess\\iCloudDrive\\tohyee").kind).toBe("icloud");
    expect(classifyDestination("\\\\nas\\backups\\tohyee")).toEqual({ kind: "network", provider: null, synced: false });
    expect(classifyDestination("C:\\ProgramData\\Tohyee\\backups")).toEqual({ kind: "local", provider: null, synced: false });
    // A folder merely named like a provider part-way through a word isn't one.
    expect(classifyDestination("/srv/onedrivebackups").kind).toBe("local");
  });

  it("never says a synced folder is confirmed off-site", () => {
    const note = offSiteNote(classifyDestination("C:\\Users\\jess\\OneDrive\\Tohyee backups"));
    expect(note).toMatch(/^Not verified\./);
    expect(note).toContain("can't see whether OneDrive has uploaded them");
    expect(offSiteNote(classifyDestination("/var/backups"))).toMatch(/^No off-site copy/);
  });

  it("refuses a backup only when it clearly won't fit", () => {
    const mb = 1024 * 1024;
    expect(notEnoughSpace({ freeBytes: 50 * mb, totalBytes: 1000 * mb }, 10 * mb)).toBe(true); // 10 MB + 64 MB margin
    expect(notEnoughSpace({ freeBytes: 80 * mb, totalBytes: 1000 * mb }, 10 * mb)).toBe(false);
    expect(notEnoughSpace(null, 10 * mb)).toBe(false); // unknown space: try
    expect(notEnoughSpace({ freeBytes: 1, totalBytes: 2 }, 0)).toBe(false); // first backup: nothing to go on
  });

  it("explains failures with what to do, and that the older backups were kept", () => {
    const missing = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    expect(explainBackupError(missing, "C:\\Users\\jess\\OneDrive\\Tohyee backups")).toBe(
      "The backup folder C:\\Users\\jess\\OneDrive\\Tohyee backups isn't there. Check OneDrive is installed and signed in on this computer, or choose the folder again. The older backups were kept.",
    );
    expect(explainBackupError(missing, "E:\\Tohyee")).toContain("If it's on a USB or external drive, plug it in");
    const full = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    expect(explainBackupError(full, "/backups")).toBe("The disk holding /backups is full. Free up space or choose a folder on a bigger disk. The older backups were kept.");
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    expect(explainBackupError(denied, "/backups")).toMatch(/^Tohyee isn't allowed to write to \/backups\./);
    expect(explainBackupError(new Error("pg_dump failed (exit code 1): boom"), "/backups")).toBe("pg_dump failed (exit code 1): boom. The older backups were kept.");
  });
});

describe("how long ago", () => {
  it("says it in plain words", async () => {
    const { ageText } = await import("@/lib/backups/age");
    const now = new Date("2026-10-21T12:00:00Z");
    expect(ageText(null, now)).toBe("");
    expect(ageText("2026-10-21T11:59:30Z", now)).toBe("just now");
    expect(ageText("2026-10-21T11:15:00Z", now)).toBe("45 minutes ago");
    expect(ageText("2026-10-21T11:00:00Z", now)).toBe("an hour ago");
    expect(ageText("2026-10-20T02:00:00Z", now)).toBe("34 hours ago");
    expect(ageText("2026-10-17T12:00:00Z", now)).toBe("4 days ago");
  });
});

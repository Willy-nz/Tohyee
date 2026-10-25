import { describe, expect, it } from "vitest";
import type { BackupHeader } from "@/lib/backups/format";
import { cutoverChecklist, describeBackup } from "@/lib/backups/wizard";

const common = { kind: "organisation" as const, organisationId: "kowhai", displayName: "Kōwhai Dairies", databaseName: "x", schemaVersion: "0180", createdAt: "2026-10-20T02:00:00Z", tohyeeVersion: "1.0.0", cipher: "aes-256-gcm" as const };

describe("the restore wizard's words (#389 part 3)", () => {
  it("says which recovery kit a backup needs", () => {
    const v2: BackupHeader = { ...common, format: 2, kdf: "hkdf-sha256", recoveryKey: { version: 3, id: "abcd" }, salt: "", liveKey: { id: "", iv: "", tag: "", data: "" } };
    expect(describeBackup({ name: "a", header: v2, problem: null, compatible: true })).toMatchObject({ what: "Kōwhai Dairies", key: "Recovery kit v3", note: null });
    expect(describeBackup({ name: "a", header: v2, problem: null, compatible: true }).needs).toContain("recovery key version 3 (fingerprint abcd)");
    const server: BackupHeader = { ...v2, kind: "server", organisationId: null, displayName: null };
    expect(describeBackup({ name: "a", header: server, problem: null, compatible: false })).toMatchObject({ what: "People and settings (the server's own database)", key: "Recovery kit v3", note: "Made by a newer Tohyee (1.0.0): update this server first." });
    expect(describeBackup({ name: "broken.tohyee-backup", header: null, problem: "damaged", compatible: false })).toEqual({ what: "broken.tohyee-backup", key: "", needs: "", note: "damaged" });
  });

  it("the cutover checklist puts switching the original off before turning jobs on, and lists what to reconnect", () => {
    const list = cutoverChecklist({ reconnect: ["bank and payment feeds"], queuedEmails: 2, privateMail: { ownersNotHere: 1 } });
    const off = list.findIndex((item) => item.includes("original installation is switched off"));
    const on = list.findIndex((item) => item.startsWith("Turn on automatic jobs"));
    expect(off).toBeGreaterThan(-1);
    expect(on).toBeGreaterThan(off);
    expect(list[on]).toBe("Turn on automatic jobs. 2 queued emails are then sent.");
    expect(list).toContain("Connect again what couldn't be carried over: bank and payment feeds.");
    expect(list).toContain("Recover the people from the server backup, so private mail copies get their owners back.");
    expect(cutoverChecklist({ reconnect: [], queuedEmails: 0, privateMail: { ownersNotHere: 0 } }).some((item) => item.startsWith("Connect again"))).toBe(false);
  });
});

import { execFile } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as kitRoute from "@/app/api/admin/backups/recovery-kit/route";
import * as kitCheckRoute from "@/app/api/admin/backups/recovery-kit/check/route";
import * as kitRotateRoute from "@/app/api/admin/backups/recovery-kit/rotate/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { readBackupHeader, writeLegacyEncryptedForTests } from "@/lib/backups/format";
import { backupOverview } from "@/lib/backups/overview";
import { startPgTool } from "@/lib/backups/pg-tools";
import { checkRecoveryKit, exportRecoveryKit, recoveryKitNeedsSaving, recoveryKitStatus } from "@/lib/backups/recovery-kit";
import { backUpNow, checkBackup, restoreBackupAsCopy, updateBackupSettings } from "@/lib/backups/service";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation } from "@/lib/organisations/registry";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  sessionCookieFor,
  startTestServer,
  TEST_PASSWORD,
  type TestServer,
} from "../helpers/test-server";

const ORG = "kit-co";
const LIVE = "recovery-kit-test-live-key-0123456789abcdefgh";
const noContext = undefined as unknown;
const run = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve("tsx/cli");

describeWithDatabase("the recovery kit (#389 part 2)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let folder: string;
  let cookie: string;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const said: string[] = [];

  beforeAll(async () => {
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = LIVE;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-kit-"));
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await updateBackupSettings({ user: owner }, { folder });
    cookie = await sessionCookieFor(owner);
    // Everything the code logs, to prove no secret is logged.
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
  });

  let code = "";
  let firstFile = "";

  it("backups are format 2, with recovery key version 1 made by the first backup, and no secret in the file", async () => {
    expect((await recoveryKitStatus()).version).toBeNull();
    const runs = await backUpNow({ trigger: "manual", requestedByEmail: owner.email });
    expect(runs.map((r) => r.status)).toEqual(["ok", "ok"]);
    firstFile = runs[1].filePath!;
    const { header } = await readBackupHeader(firstFile);
    const status = await recoveryKitStatus();
    expect(status).toMatchObject({ keySet: true, version: 1, needsSaving: true, checkedAt: null });
    expect(header).toMatchObject({ format: 2, recoveryKey: { version: 1, id: status.id } });
    expect((await fs.readFile(firstFile)).includes(Buffer.from(LIVE))).toBe(false);
    expect(await recoveryKitNeedsSaving()).toBe(true);
  });

  it("the kit needs the password again and the server settings address, and its export is audited without the key", async () => {
    const post = (body: unknown, local = true) => kitRoute.POST(apiRequest("/api/admin/backups/recovery-kit", { method: "POST", cookie, body, local }), noContext);
    expect((await post({ password: "wrong", form: "code" })).status).toBe(403);
    expect((await post({ password: TEST_PASSWORD, form: "code" }, false)).status).toBe(403);
    const someone = await createTestUser("kim@example.com");
    expect((await kitRoute.POST(apiRequest("/api/admin/backups/recovery-kit", { method: "POST", cookie: await sessionCookieFor(someone), body: { password: TEST_PASSWORD } }), noContext)).status).toBe(403);

    const ok = await post({ password: TEST_PASSWORD, form: "code" });
    expect(ok.status).toBe(200);
    const kit = ((await ok.json()) as { kit: { form: string; code: string; version: number } }).kit;
    expect(kit).toMatchObject({ form: "code", version: 1 });
    code = kit.code;
    expect(code).toMatch(/^RK1-/);
    // Only the recovery key leaves: not the live key, nor anything from the environment.
    expect(JSON.stringify(kit)).not.toContain(LIVE);
    expect(JSON.stringify(kit)).not.toContain(process.env.DATABASE_URL!);

    const audit = await coreQuery<{ event_type: string; details: unknown }>("select event_type, details from admin_audit_events where entity_id = 'backup_recovery_keys' order by id");
    expect(audit.rows.map((r) => r.event_type)).toEqual(["server.recovery_kit_export_refused", "server.recovery_kit_exported"]);
    expect(JSON.stringify(audit.rows)).not.toContain(code.slice(4, 20));
  });

  it("checking a saved kit exercises it: only a code that matches is recorded, for that key version", async () => {
    const check = (body: unknown) => kitCheckRoute.POST(apiRequest("/api/admin/backups/recovery-kit/check", { method: "POST", cookie, body }), noContext);
    const typo = code.slice(0, 8) + (code[8] === "A" ? "B" : "A") + code.slice(9);
    expect((await check({ code: typo })).status).toBe(400);
    expect((await recoveryKitStatus()).checkedAt).toBeNull();
    const good = await check({ code: code.toLowerCase() });
    expect(good.status).toBe(200);
    const status = ((await good.json()) as { recoveryKit: { checkedAt: string | null; checkedByEmail: string; checkedMethod: string; needsSaving: boolean } }).recoveryKit;
    expect(status).toMatchObject({ checkedByEmail: owner.email, checkedMethod: "code", needsSaving: false });
    expect(await recoveryKitNeedsSaving()).toBe(false);
  });

  it("a recovery file opens only with its passphrase, and can be checked", async () => {
    const kit = await exportRecoveryKit({ user: owner }, { password: TEST_PASSWORD, form: "file", passphrase: "the passphrase lives elsewhere", randomName: true });
    expect(kit.form).toBe("file");
    if (kit.form !== "file") return;
    expect(kit.fileName).toMatch(/^[0-9a-z]{16}\.tohyee-recovery$/);
    expect(kit.content).not.toContain(code.slice(4, 20));
    await expect(exportRecoveryKit({ user: owner }, { password: TEST_PASSWORD, form: "file", passphrase: "short" })).rejects.toThrow(/at least 14 characters/);
    await expect(checkRecoveryKit({ user: owner }, { file: kit.content, passphrase: "not the passphrase at all" })).rejects.toThrow(/doesn't open this recovery file/);
    expect((await checkRecoveryKit({ user: owner }, { file: kit.content, passphrase: "the passphrase lives elsewhere" })).checkedMethod).toBe("file");
  }, 60_000);

  it("a new recovery key: new backups use it, it needs its own check, and older backups still open here", async () => {
    const rotated = await kitRotateRoute.POST(apiRequest("/api/admin/backups/recovery-kit/rotate", { method: "POST", cookie, body: { password: TEST_PASSWORD } }), noContext);
    expect(rotated.status).toBe(200);
    const status = await recoveryKitStatus();
    expect(status).toMatchObject({ version: 2, needsSaving: true, checkedAt: null });
    expect(status.versions.map((v) => [v.version, Boolean(v.checkedAt)])).toEqual([
      [2, false],
      [1, true],
    ]);
    const [made] = await backUpNow({ trigger: "manual", requestedByEmail: owner.email, organisationId: ORG });
    expect((await readBackupHeader(made.filePath!)).header).toMatchObject({ format: 2, recoveryKey: { version: 2 } });
    await checkBackup(firstFile); // version 1, still held here
    // The old code still checks out (for version 1), but doesn't count for version 2.
    await checkRecoveryKit({ user: owner }, { code });
    expect((await recoveryKitStatus()).needsSaving).toBe(true);

    const { overview } = await backupOverview();
    expect(overview.recoveryKit.version).toBe(2);
    expect(overview.recoveryKit.olderVersions.map((v) => [v.version, v.files])).toEqual([[1, 2]]);
    expect(overview.attention.map((a) => a.text)).toContainEqual(expect.stringMatching(/^Nobody has checked a saved recovery kit for recovery key version 2/));
  });

  it("on another server, a backup opens only with its kit, and restores with it", async () => {
    // A replacement computer: its own live key and none of this server's recovery keys.
    const keys = await coreQuery<{ value: unknown; secret_ciphertext: string }>("select value, secret_ciphertext from server_settings where key = 'backup_recovery_keys'");
    await coreQuery("delete from server_settings where key = 'backup_recovery_keys'");
    process.env.TOHYEE_SECRET_KEY = "the-replacement-computers-own-key-0123456789";
    try {
      await expect(checkBackup(firstFile)).rejects.toThrow(/recovery key version 1 \(fingerprint [0-9a-f]{16}\) of another Tohyee server/);
      await expect(restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: firstFile, id: "kit-co-nokit" })).rejects.toThrow(/Give that server's recovery kit/);
      await expect(restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: firstFile, id: "kit-co-old", key: LIVE })).rejects.toThrow(/needs a recovery kit/);
      expect(await getOrganisation("kit-co-nokit")).toBeNull();
      const copy = await restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: firstFile, id: "kit-co-restored", key: code });
      expect(copy).toMatchObject({ id: "kit-co-restored", provisioningStatus: "ready" });
    } finally {
      process.env.TOHYEE_SECRET_KEY = LIVE;
      await coreQuery("insert into server_settings (key, value, secret_ciphertext) values ('backup_recovery_keys', $1::jsonb, $2)", [JSON.stringify(keys.rows[0].value), keys.rows[0].secret_ciphertext]);
    }
  }, 600_000);

  it("a backup from before recovery kits (format 1) still checks, restores and is listed with the key it needs", async () => {
    const legacyFile = path.join(folder, ORG, `${ORG}_2026-01-01_020000.tohyee-backup`);
    const organisation = (await getOrganisation(ORG))!;
    const dump = startPgTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges"], organisation.databaseName);
    dump.child.stdin?.end();
    await Promise.all([
      writeLegacyEncryptedForTests(dump.child.stdout!, createWriteStream(legacyFile), {
        kind: "organisation",
        organisationId: ORG,
        displayName: organisation.displayName,
        databaseName: organisation.databaseName,
        schemaVersion: organisation.schemaVersion,
        createdAt: "2026-01-01T02:00:00.000Z",
        tohyeeVersion: "0.9.0",
      }),
      dump.done,
    ]);
    expect((await checkBackup(legacyFile)).createdAt).toBe("2026-01-01T02:00:00.000Z");
    const copy = await restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: legacyFile, id: "kit-co-legacy" });
    expect(copy.provisioningStatus).toBe("ready");
    const { overview } = await backupOverview();
    expect(overview.recoveryKit.legacyFiles).toMatchObject({ files: 1, keepKeyUntilAbout: "2027-01-01" });
  }, 600_000);

  it("the command-line tool shows and checks the kit", async () => {
    const env = { ...process.env, TOHYEE_SECRET_KEY: LIVE };
    const shown = await run(process.execPath, [tsx, "scripts/admin.ts", "backups", "kit", "show"], { env, timeout: 60_000 });
    const printed = /^(RK2-[0-9A-Z-]+)$/m.exec(shown.stdout)?.[1];
    expect(printed).toBeTruthy();
    const checked = await run(process.execPath, [tsx, "scripts/admin.ts", "backups", "kit", "check"], { env: { ...env, TOHYEE_RECOVERY_CODE: printed! }, timeout: 60_000 });
    expect(checked.stdout).toContain("That's the right kit for recovery key version 2");
    expect((await recoveryKitStatus()).needsSaving).toBe(false);
  }, 120_000);

  it("nothing logged along the way holds a key", async () => {
    const everything = said.join("\n");
    expect(everything).not.toContain(LIVE);
    expect(everything).not.toContain(code.slice(4, 24));
  });
});

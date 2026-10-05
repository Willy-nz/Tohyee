import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as backupsRoute from "@/app/api/admin/backups/route";
import * as restoreRoute from "@/app/api/admin/backups/restore/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { runDueBackups } from "@/lib/backups/scheduler";
import * as keyRoute from "@/app/api/admin/backups/key/route";
import * as keyCheckRoute from "@/app/api/admin/backups/key/check/route";
import { backupKeyNeedsSaving, backupKeyStatus, checkSavedBackupKey, revealBackupKey } from "@/lib/backups/key";
import { backUpNow, checkBackup, listBackupFiles, restoreBackupAsCopy, updateBackupSettings } from "@/lib/backups/service";
import type { Actor } from "@/lib/db/org-transaction";
import { databaseNameFor } from "@/lib/organisations/admin";
import { getAdminPool } from "@/lib/db/pools";
import { coreQuery } from "@/lib/db/transactions";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { postJournal } from "@/lib/ledger/journals";
import { trialBalance } from "@/lib/reports/financial";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  TEST_PASSWORD,
  type TestServer,
} from "../helpers/test-server";

const ORG = "backup-co";
const KEY = "backup-test-key-0123456789abcdefghijklmnop";
const noContext = undefined as unknown;
const run = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve("tsx/cli");

function journal(date: string, amount: string, reference: string) {
  return {
    idempotencyKey: key("j"),
    postingDate: date,
    reference,
    lines: [
      { accountCode: "1000", debitAmount: amount },
      { accountCode: "4000", creditAmount: amount },
    ],
  };
}

describeWithDatabase("backups and restores", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let actor: Actor;
  let folder: string;
  let cookie: string;
  const originalKey = process.env.TOHYEE_SECRET_KEY;

  const sales = async (organisationId: string) => {
    const rows = await inOrganisation(organisationId, actor, (tx) => trialBalance(tx, { asAt: "2026-12-31" }));
    return JSON.parse(JSON.stringify(rows)) as unknown;
  };

  beforeAll(async () => {
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = KEY;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-backups-"));
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("kim@example.com");
    actor = { userId: owner.id, email: owner.email };
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, bookkeeper.id]);
    await inOrganisation(ORG, actor, (tx) => postJournal(tx, journal("2026-06-15", "115.00", "SECRET-REF-1")));
    await inOrganisation(ORG, actor, (tx) => postJournal(tx, journal("2026-07-01", "115.00", "SECRET-REF-2")));
    await updateBackupSettings({ user: owner }, { folder });
    cookie = await sessionCookieFor(owner);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("backs up each organisation and the server's own database into encrypted files, checked after writing", async () => {
    const runs = await backUpNow({ trigger: "manual", requestedByEmail: owner.email });
    expect(runs.map((r) => [r.organisationId, r.status, r.error])).toEqual([
      [null, "ok", null],
      [ORG, "ok", null],
    ]);
    const orgRun = runs[1];
    expect(path.dirname(orgRun.filePath!)).toBe(path.join(folder, ORG));
    expect(path.basename(orgRun.filePath!)).toMatch(/^backup-co_\d{4}-\d{2}-\d{2}_\d{6}\.tohyee-backup$/);
    expect(orgRun.sizeBytes).toBeGreaterThan(1000);

    const bytes = await fs.readFile(orgRun.filePath!);
    expect(bytes.subarray(0, 16).toString()).toBe("TOHYEE-BACKUP 1\n");
    expect(bytes.includes(Buffer.from("SECRET-REF-1"))).toBe(false);
    expect(bytes.includes(Buffer.from("ledger_journals"))).toBe(false);

    const header = await checkBackup(orgRun.filePath!);
    expect(header).toMatchObject({ kind: "organisation", organisationId: ORG, displayName: `Test ${ORG}` });

    const files = await listBackupFiles();
    expect(files.map((f) => f.header?.organisationId ?? "server").sort()).toEqual([ORG, "server"]);
  });

  it("restores a backup as a copy with the same books, members and history, leaving the original alone", async () => {
    const [file] = await listBackupFiles(ORG);
    const before = await sales(ORG);
    await inOrganisation(ORG, actor, (tx) => postJournal(tx, journal("2026-08-01", "100.00", "AFTER-BACKUP")));

    const copy = await restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: file.path, id: "backup-co-copy" });
    expect(copy).toMatchObject({ id: "backup-co-copy", provisioningStatus: "ready", migrationStatus: "current" });
    expect(copy.displayName).toMatch(/^Test backup-co \(restored from \d{4}-\d{2}-\d{2}\)$/);

    expect(await sales("backup-co-copy")).toEqual(before);
    expect(await sales(ORG)).not.toEqual(before);

    const members = await coreQuery<{ email: string; role: string }>(
      `select u.email, m.role from organisation_members m join users u on u.id = m.user_id where m.organisation_id = 'backup-co-copy' order by u.email`,
    );
    expect(members.rows).toEqual([
      { email: "kim@example.com", role: "bookkeeper" },
      { email: "owner@example.com", role: "owner" },
    ]);
    const history = await inOrganisation("backup-co-copy", actor, (tx) =>
      tx.query<{ n: string }>("select count(*)::text as n from audit_events where event_type = 'ledger.journal_posted'"),
    );
    expect(Number(history.rows[0].n)).toBe(2); // the two journals from before the backup
    const settings = await inOrganisation("backup-co-copy", actor, (tx) =>
      tx.query<{ organisation_id: string; display_name: string }>("select organisation_id, display_name from organisation_settings"),
    );
    expect(settings.rows[0]).toEqual({ organisation_id: "backup-co-copy", display_name: copy.displayName });

    await expect(restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: file.path, id: "backup-co-copy" })).rejects.toThrow(
      /already an organisation with the ID backup-co-copy/,
    );
  });

  it("refuses a changed file, the wrong key and a server-database backup, and leaves nothing half-restored", async () => {
    const [file] = await listBackupFiles(ORG);
    const changed = path.join(folder, ORG, "changed.tohyee-backup");
    const bytes = await fs.readFile(file.path);
    bytes[bytes.length - 100] ^= 0xff;
    await fs.writeFile(changed, bytes);
    await expect(checkBackup(changed)).rejects.toThrow(/damaged or was changed/);
    await expect(restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: changed, id: "tampered" })).rejects.toThrow(/damaged or was changed/);
    expect((await coreQuery("select 1 from organisations where id = 'tampered'")).rowCount).toBe(0);
    await fs.rm(changed);

    process.env.TOHYEE_SECRET_KEY = "a-different-key-0123456789abcdefghijklmnop";
    await expect(checkBackup(file.path)).rejects.toThrow(/made with a different key/);
    process.env.TOHYEE_SECRET_KEY = KEY;

    const [serverFile] = await listBackupFiles().then((all) => all.filter((f) => f.header?.kind === "server"));
    await expect(restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: serverFile.path })).rejects.toThrow(
      /server's own database/,
    );
    // A database by the copy's name that isn't an organisation here (another install on the same server) is
    // refused before anything is made, and never dropped (#135).
    const stray = databaseNameFor("stray-co");
    await getAdminPool().query(`create database ${quoteSqlIdentifier(stray)}`);
    try {
      await expect(restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: file.path, id: "stray-co" })).rejects.toThrow(
        `There's already a database called ${stray}`,
      );
      expect((await getAdminPool().query("select 1 from pg_database where datname = $1", [stray])).rowCount).toBe(1);
      expect((await coreQuery("select 1 from organisations where id = 'stray-co'")).rowCount).toBe(0);
    } finally {
      await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(stray)} with (force)`);
    }
  });

  it("server admins see backups through the server settings address, with no paths outside the folder", async () => {
    const got = await backupsRoute.GET(apiRequest("/api/admin/backups", { cookie }), noContext);
    expect(got.status).toBe(200);
    const body = (await got.json()) as { settings: { folder: string; enabled: boolean; time: string }; files: { name: string }[]; status: unknown[] };
    expect(body.settings).toMatchObject({ folder, enabled: true, time: "02:00" });
    expect(body.files.every((f) => !path.isAbsolute(f.name))).toBe(true);
    expect(body.status).toHaveLength(3); // server, backup-co, backup-co-copy

    const outside = await restoreRoute.POST(
      apiRequest("/api/admin/backups/restore", { method: "POST", cookie, body: { file: "../../etc/passwd.tohyee-backup" } }),
      noContext,
    );
    expect(outside.status).toBe(400);

    const bookkeeperCookie = await sessionCookieFor(bookkeeper);
    expect((await backupsRoute.GET(apiRequest("/api/admin/backups", { cookie: bookkeeperCookie }), noContext)).status).toBe(403);
    expect((await backupsRoute.GET(apiRequest("/api/admin/backups", { cookie, local: false }), noContext)).status).toBe(403);
  });

  it("the nightly schedule backs up whatever hasn't been backed up since the set time, once", async () => {
    await updateBackupSettings({ user: owner }, { time: "00:00" });
    await coreQuery("delete from backup_runs");
    const first = await runDueBackups();
    expect(first.map((r) => [r.organisationId, r.trigger, r.status]).sort()).toEqual(
      [
        [null, "schedule", "ok"],
        [ORG, "schedule", "ok"],
        ["backup-co-copy", "schedule", "ok"],
      ].sort(),
    );
    expect(await runDueBackups()).toEqual([]);

    // #137: a run cut off by a restart (still "running", from before this process started, over an hour ago) is
    // marked failed and its half-written file removed, so it doesn't block the day; a run that just started is left.
    await coreQuery("delete from backup_runs");
    await coreQuery(
      "insert into backup_runs (organisation_id, trigger, status, started_at) values ($1, 'schedule', 'running', now() - interval '90 minutes'), (null, 'manual', 'running', now() - interval '5 minutes')",
      [ORG],
    );
    const partial = path.join(folder, ORG, `${ORG}_2000-01-01_000000.tohyee-backup.partial`);
    await fs.writeFile(partial, "half");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(partial, old, old);
    await runDueBackups(new Date(), new Date());
    const after = await coreQuery<{ organisation_id: string | null; status: string; error: string | null }>(
      "select organisation_id, status, error from backup_runs where started_at < now() - interval '1 minute' order by started_at",
    );
    expect(after.rows).toEqual([
      { organisation_id: ORG, status: "failed", error: "Interrupted: the server stopped while this backup ran." },
      { organisation_id: null, status: "running", error: null },
    ]);
    await expect(fs.stat(partial)).rejects.toThrow();
    await coreQuery("delete from backup_runs where status = 'running'");
    await updateBackupSettings({ user: owner }, { enabled: false });
    await coreQuery("delete from backup_runs");
    expect(await runDueBackups()).toEqual([]);
    await updateBackupSettings({ user: owner }, { enabled: true, time: "02:00" });
  });

  it("refuses a backup folder it can't write to", async () => {
    const blocked = path.join(folder, "not-a-folder");
    await fs.writeFile(blocked, "a file, not a folder");
    await expect(updateBackupSettings({ user: owner }, { folder: blocked })).rejects.toThrow(/can't write to/);
    await expect(updateBackupSettings({ user: owner }, { folder: "relative/path" })).rejects.toThrow(/must be a full path/);
    await expect(updateBackupSettings({ user: owner }, { time: "2am" })).rejects.toThrow(/24-hour HH:MM/);
  });

  it("the backup key: shown only with the password again, and a saved copy is checked by pasting it back", async () => {
    expect(await backupKeyStatus()).toMatchObject({ keySet: true, savedCopyCheckedAt: null });
    expect(await backupKeyNeedsSaving()).toBe(true);

    await expect(revealBackupKey({ user: owner }, "not my password")).rejects.toThrow(/password isn't right/);
    const shown = await revealBackupKey({ user: owner }, TEST_PASSWORD);
    expect(shown.key).toBe(KEY);

    await expect(checkSavedBackupKey({ user: owner }, KEY.slice(0, -1))).rejects.toThrow(/isn't the same key/);
    expect((await backupKeyStatus()).savedCopyCheckedAt).toBeNull();
    const checked = await checkSavedBackupKey({ user: owner }, `  ${KEY}\n`);
    expect(checked).toMatchObject({ keySet: true, savedCopyCheckedByEmail: owner.email });
    expect(checked.savedCopyCheckedAt).not.toBeNull();
    expect(await backupKeyNeedsSaving()).toBe(false);

    // A different key (e.g. the server was set up again) needs its own saved copy.
    process.env.TOHYEE_SECRET_KEY = "a-new-key-for-this-server-0123456789abcdef";
    expect((await backupKeyStatus()).savedCopyCheckedAt).toBeNull();
    process.env.TOHYEE_SECRET_KEY = KEY;
    expect((await backupKeyStatus()).savedCopyCheckedAt).not.toBeNull();

    // The key is never written to the audit trail.
    const audit = await coreQuery<{ event_type: string; details: unknown }>(
      "select event_type, details from admin_audit_events where entity_id = 'backup_key' order by id",
    );
    expect(audit.rows.map((r) => r.event_type)).toEqual([
      "server.backup_key_show_refused",
      "server.backup_key_shown",
      "server.backup_key_check_failed",
      "server.backup_key_checked",
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(KEY);
  });

  it("the backup key through the server settings address: server admins only, with their password, and not too many guesses", async () => {
    const show = (cookieValue: string, password: string, local = true) =>
      keyRoute.POST(apiRequest("/api/admin/backups/key", { method: "POST", cookie: cookieValue, body: { password }, local }), noContext);
    const ok = await show(cookie, TEST_PASSWORD);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { key: string }).key).toBe(KEY);
    expect((await show(cookie, TEST_PASSWORD, false)).status).toBe(403);
    expect((await show(await sessionCookieFor(bookkeeper), TEST_PASSWORD)).status).toBe(403);

    const checked = await keyCheckRoute.POST(
      apiRequest("/api/admin/backups/key/check", { method: "POST", cookie, body: { key: KEY } }),
      noContext,
    );
    expect(((await checked.json()) as { keyStatus: { savedCopyCheckedAt: string | null } }).keyStatus.savedCopyCheckedAt).not.toBeNull();
    const listed = (await (await backupsRoute.GET(apiRequest("/api/admin/backups", { cookie }), noContext)).json()) as { keyStatus: { keySet: boolean } };
    expect(listed.keyStatus.keySet).toBe(true);

    const guesser = await createTestUser("guesser@example.com", { serverAdmin: true });
    const guesserCookie = await sessionCookieFor(guesser);
    for (let i = 0; i < 5; i += 1) expect((await show(guesserCookie, `wrong ${i}`)).status).toBe(403);
    const blocked = await show(guesserCookie, TEST_PASSWORD);
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/Too many wrong passwords/);
  });

  it("restores a backup made on another server, given that server's key", async () => {
    const [file] = await listBackupFiles(ORG);
    process.env.TOHYEE_SECRET_KEY = "the-new-servers-own-key-0123456789abcdefgh";
    try {
      await expect(restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: file.path, id: "from-old-server" })).rejects.toThrow(
        /made with a different key/,
      );
      await expect(
        restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: file.path, id: "from-old-server", key: "not-the-key-0123456789abcdefghijklmn" }),
      ).rejects.toThrow(/isn't the key this backup was made with/);
      const copy = await restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: file.path, id: "from-old-server", key: KEY });
      expect(copy).toMatchObject({ id: "from-old-server", provisioningStatus: "ready" });
    } finally {
      process.env.TOHYEE_SECRET_KEY = KEY;
    }
  });

  it("the command-line tool shows the status and checks a file", async () => {
    const env = { ...process.env, TOHYEE_SECRET_KEY: KEY };
    const made = await run(process.execPath, [tsx, "scripts/admin.ts", "backups", "run", "--id", ORG], { env, timeout: 60_000 });
    expect(made.stdout).toMatch(new RegExp(`^backup-co: backed up to ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const status = await run(process.execPath, [tsx, "scripts/admin.ts", "backups", "status"], { env, timeout: 30_000 });
    expect(status.stdout).toContain(`Folder: ${folder}`);
    expect(status.stdout).toMatch(/backup-co\s+\d{4}-\d{2}-\d{2}/);
    const [file] = await listBackupFiles(ORG);
    const checked = await run(process.execPath, [tsx, "scripts/admin.ts", "backups", "check", "--file", file.path], { env, timeout: 30_000 });
    expect(checked.stdout).toContain("OK: backup-co");
    const key = await run(process.execPath, [tsx, "scripts/admin.ts", "backups", "key", "show"], { env, timeout: 30_000 });
    expect(key.stdout).toContain(`\n${KEY}\n`);
    const keyChecked = await run(process.execPath, [tsx, "scripts/admin.ts", "backups", "key", "check"], {
      env: { ...env, TOHYEE_BACKUP_KEY: KEY },
      timeout: 30_000,
    });
    expect(keyChecked.stdout).toContain("That's the right key");
  });
});

describeWithDatabase("restoring with a separate runtime login (DATABASE_ADMIN_URL)", () => {
  let server: TestServer;
  let folder: string;
  const originalKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer({ separateRuntimeLogin: true });
    process.env.TOHYEE_SECRET_KEY = KEY;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-backups-rt-"));
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("the restored copy works for the runtime login, with posted history still append-only", async () => {
    const owner = await createTestUser("owner@example.com", { serverAdmin: true });
    const actor = { userId: owner.id, email: owner.email };
    await createTestOrganisation(owner, "rt-co");
    await inOrganisation("rt-co", actor, (tx) => postJournal(tx, journal("2026-06-15", "50.00", "RT-1")));
    await updateBackupSettings({ user: owner }, { folder });
    const runs = await backUpNow({ trigger: "manual", requestedByEmail: owner.email, organisationId: "rt-co" });
    expect(runs[0].status).toBe("ok");

    await restoreBackupAsCopy({ id: owner.id, email: owner.email }, { file: runs[0].filePath!, id: "rt-co-copy" });
    await inOrganisation("rt-co-copy", actor, (tx) => postJournal(tx, journal("2026-06-16", "5.00", "RT-2")));
    await expect(
      inOrganisation("rt-co-copy", actor, (tx) => tx.query("update ledger_journals set reference = 'changed'")),
    ).rejects.toThrow();
  });
});

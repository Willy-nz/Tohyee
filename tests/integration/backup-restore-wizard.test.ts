import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as findRoute from "@/app/api/admin/backups/restore/find/route";
import * as restoreRoute from "@/app/api/admin/backups/restore/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { verifyPassword } from "@/lib/auth/password";
import { backupOverview } from "@/lib/backups/overview";
import { backupFileIn, findBackups, inspectBackup, recoverPeople, recoveryMaterial, testRestore } from "@/lib/backups/recovery";
import { exportRecoveryKit } from "@/lib/backups/recovery-kit";
import { backUpNow, cleanUpInterruptedRestores, listBackupFiles, restoreBackup, resumeOrganisationJobs, updateBackupSettings } from "@/lib/backups/service";
import { getAdminPool } from "@/lib/db/pools";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { coreQuery } from "@/lib/db/transactions";
import { databaseNameFor, listOrganisationsForJobs } from "@/lib/organisations/admin";
import { getOrganisation } from "@/lib/organisations/registry";
import { MailOwner } from "@/lib/private-mail/access";
import { copyKeys, newWrappedDataKey } from "@/lib/private-mail/crypto";
import { myMail } from "@/lib/private-mail/store";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  sessionCookieFor,
  startTestServer,
  TEST_PASSWORD,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;
const LIVE_A = "wizard-test-first-servers-live-key-0123456789";
const LIVE_B = "wizard-test-replacement-servers-key-0123456789";
const TOTP = "JBSWY3DPEHPK3PXP";
const originalKey = process.env.TOHYEE_SECRET_KEY;

let folder: string;
let codeA = "";

async function addPrivateMailCopy(organisationId: string, owner: SessionUser): Promise<void> {
  await inOrganisation(organisationId, { userId: owner.id, email: owner.email }, (tx) =>
    tx.query("insert into private_mail_copies (owner_user_id, provider, mailbox_email, data_key_ciphertext) values ($1, 'google', $2, $3)", [owner.id, owner.email, newWrappedDataKey()]),
  );
}

/** What the person sees of private mail in an organisation, through the one access layer; "not found" counts as nothing. */
async function privateCopiesSeenBy(organisationId: string, user: { id: string; email: string }): Promise<number> {
  return inOrganisation(organisationId, { userId: user.id, email: user.email }, async (tx) => {
    try {
      const owner = await MailOwner.of(tx);
      const mail = await myMail(tx, owner);
      return mail.detached.length + mail.mailboxes.filter((m) => m.copy).length;
    } catch {
      return 0;
    }
  });
}

async function copyKeyOpens(organisationId: string, actor: { id: string; email: string }): Promise<boolean> {
  return inOrganisation(organisationId, { userId: actor.id, email: actor.email }, async (tx) => {
    const row = (await tx.query<{ id: string; data_key_ciphertext: string }>("select id::text, data_key_ciphertext from private_mail_copies")).rows[0];
    try {
      copyKeys(row.id, row.data_key_ciphertext);
      return true;
    } catch {
      return false;
    }
  });
}

describeWithDatabase("restoring: checks, re-encrypted secrets, paused jobs and private mail (#389 part 3)", () => {
  let server: TestServer;
  let admin: SessionUser;
  let mailOwner: SessionUser;
  let orgFile = "";

  beforeAll(async () => {
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = LIVE_A;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-wizard-"));
    admin = await createTestUser("admin@example.com", { serverAdmin: true });
    mailOwner = await createTestUser("mail.owner@example.com");
    await createTestOrganisation(admin, "wiz-co");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ('wiz-co', $1, 'owner')", [mailOwner.id]);
    await addPrivateMailCopy("wiz-co", mailOwner);
    await updateBackupSettings({ user: admin }, { folder });
    const runs = await backUpNow({ trigger: "manual", requestedByEmail: admin.email });
    expect(runs.map((r) => r.status)).toEqual(["ok", "ok"]);
    orgFile = runs[1].filePath!;
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  it("finds backups in a folder by their headers, and refuses paths outside it", async () => {
    const found = await findBackups(folder);
    expect(found.backups.map((b) => [b.header?.kind, b.compatible]).sort()).toEqual([
      ["organisation", true],
      ["server", true],
    ]);
    expect(found.backups.every((b) => !path.isAbsolute(b.name))).toBe(true);
    expect(() => backupFileIn(folder, "../../etc/passwd.tohyee-backup")).toThrow(/isn't a backup file in that folder/);
    expect(() => backupFileIn("relative/folder", "x.tohyee-backup")).toThrow(/full path/);
    const cookie = await sessionCookieFor(admin);
    const viaApi = await findRoute.POST(apiRequest("/api/admin/backups/restore/find", { method: "POST", cookie, body: { folder } }), noContext);
    expect(viaApi.status).toBe(200);
    expect((await findRoute.POST(apiRequest("/api/admin/backups/restore/find", { method: "POST", cookie, body: { folder }, local: false }), noContext)).status).toBe(403);
  });

  it("restoring on the same server: a copy with jobs paused, secrets readable, private mail still only its owner's", async () => {
    const inspection = await inspectBackup(orgFile);
    expect(inspection.originalIdFree).toBe(false);
    expect(inspection.suggestedId).toMatch(/^wiz-co-\d{8}$/);
    const { organisation, report } = await restoreBackup({ id: admin.id, email: admin.email }, { file: orgFile, id: "wiz-copy" });
    expect(organisation.provisioningStatus).toBe("ready");
    expect(report).toMatchObject({ jobsPaused: true, privateMail: { copies: 1, ownersHere: 1, ownersNotHere: 0 }, secrets: { reEncrypted: 0, unreadable: 0 } });
    expect(report.secrets.current).toBeGreaterThanOrEqual(1);

    // Jobs: the scheduled jobs don't see the copy until a server admin turns them on.
    expect((await listOrganisationsForJobs()).map((o) => o.id)).not.toContain("wiz-copy");
    expect((await listOrganisationsForJobs()).map((o) => o.id)).toContain("wiz-co");
    const { overview } = await backupOverview();
    expect(overview.pausedCopies.map((c) => c.id)).toEqual(["wiz-copy"]);
    await resumeOrganisationJobs({ user: admin }, "wiz-copy");
    expect((await listOrganisationsForJobs()).map((o) => o.id)).toContain("wiz-copy");
    await expect(resumeOrganisationJobs({ user: admin }, "wiz-copy")).rejects.toThrow(/no paused jobs/);

    // Private mail: the admin is an Owner of the copy too, and still sees none of it; its owner does.
    expect((await coreQuery("select role from organisation_members where organisation_id = 'wiz-copy' and user_id = $1", [admin.id])).rows[0]).toEqual({ role: "owner" });
    expect(await privateCopiesSeenBy("wiz-copy", admin)).toBe(0);
    expect(await privateCopiesSeenBy("wiz-copy", mailOwner)).toBe(1);
    expect(await copyKeyOpens("wiz-copy", mailOwner)).toBe(true);
  });

  it("a damaged, cut-short or newer backup is refused before anything is made", async () => {
    const before = (await coreQuery("select id from organisations order by id")).rows;
    const bytes = await fs.readFile(orgFile);
    const damaged = path.join(folder, "wiz-co", "wiz-co_2026-01-01_000000.tohyee-backup");
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 300] ^= 0x10;
    await fs.writeFile(damaged, flipped);
    await expect(inspectBackup(damaged)).rejects.toThrow(/damaged or was changed/);
    await expect(restoreBackup({ id: admin.id, email: admin.email }, { file: damaged, id: "wiz-bad" })).rejects.toThrow(/damaged or was changed/);
    await fs.writeFile(damaged, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(restoreBackup({ id: admin.id, email: admin.email }, { file: damaged, id: "wiz-bad" })).rejects.toThrow(/damaged or was changed/);
    const text = bytes.toString("latin1");
    const schema = /"schemaVersion":"(\d+)"/.exec(text)![1];
    await fs.writeFile(damaged, Buffer.from(text.replace(`"schemaVersion":"${schema}"`, `"schemaVersion":"${"9".repeat(schema.length)}"`), "latin1"));
    await expect(inspectBackup(damaged)).rejects.toThrow(/made by a newer version of Tohyee/);
    await expect(restoreBackup({ id: admin.id, email: admin.email }, { file: damaged, id: "wiz-bad" })).rejects.toThrow(/newer version of Tohyee/);
    await fs.rm(damaged);
    expect((await coreQuery("select id from organisations order by id")).rows).toEqual(before);
    expect((await getAdminPool().query("select 1 from pg_database where datname = $1", [databaseNameFor("wiz-bad")])).rowCount).toBe(0);
  });

  it("a restore cut off by a restart is cleaned up, and nothing else is touched", async () => {
    const databaseName = databaseNameFor("half-co");
    await coreQuery("insert into organisations (id, display_name, database_name, base_currency, jobs_paused_at) values ('half-co', 'Half', $1, 'NZD', now())", [databaseName]);
    await getAdminPool().query(`create database ${quoteSqlIdentifier(databaseName)}`);
    await coreQuery(
      "insert into backup_checks (kind, organisation_id, started_at, details) values ('restore', 'half-co', now() - interval '1 hour', $1::jsonb), ('restore', 'wiz-co', now() - interval '1 hour', $2::jsonb)",
      [JSON.stringify({ databaseName }), JSON.stringify({ databaseName: databaseNameFor("wiz-co") })],
    );
    expect(await cleanUpInterruptedRestores(new Date())).toEqual(["half-co"]);
    expect(await getOrganisation("half-co")).toBeNull();
    expect((await getAdminPool().query("select 1 from pg_database where datname = $1", [databaseName])).rowCount).toBe(0);
    expect((await getOrganisation("wiz-co"))?.provisioningStatus).toBe("ready"); // a ready organisation is never removed
    expect((await coreQuery("select count(*)::int as n from backup_checks where kind = 'restore' and status = 'running'")).rows[0]).toEqual({ n: 0 });
  });

  it("a test restore goes into a scratch database that's removed, and is shown", async () => {
    const checks = await testRestore({ requestedByEmail: admin.email });
    expect(checks.map((c) => [c.organisationId, c.status])).toEqual([
      [null, "ok"],
      ["wiz-co", "ok"],
    ]); // the copy has no backup of its own yet, so there's nothing of it to test
    expect(checks[1].details).toMatchObject({ privateMailCopies: 1, secretsUnreadable: 0 });
    const scratch = await getAdminPool().query("select datname from pg_database where datname like '%_scratch_%'");
    expect(scratch.rowCount).toBe(0);
    const { overview } = await backupOverview();
    expect(overview.testRestore.failed).toBe(0);
    expect(overview.testRestore.allAt).not.toBeNull();
  });

  it("on a replacement computer: wrong or missing kits are refused; with the kit, stored secrets are re-encrypted for it", async () => {
    const kit = await exportRecoveryKit({ user: admin }, { password: TEST_PASSWORD, form: "code" });
    if (kit.form !== "code") throw new Error("expected a code");
    codeA = kit.code;
    const keys = await coreQuery<{ value: unknown; secret_ciphertext: string }>("select value, secret_ciphertext from server_settings where key = 'backup_recovery_keys'");
    await coreQuery("delete from server_settings where key = 'backup_recovery_keys'");
    process.env.TOHYEE_SECRET_KEY = LIVE_B;
    try {
      const before = (await coreQuery("select count(*)::int as n from organisations")).rows[0];
      await expect(inspectBackup(orgFile)).rejects.toThrow(/Give that server's recovery kit/);
      const wrong = codeA.slice(0, 6) + (codeA[6] === "A" ? "B" : "A") + codeA.slice(7);
      await expect(recoveryMaterial({ key: wrong })).rejects.toThrow(/mistake/);
      await expect(restoreBackup({ id: admin.id, email: admin.email }, { file: orgFile, id: "wiz-moved", key: "not a code but long enough to be a key 0123456789" })).rejects.toThrow(/isn't a recovery code/);
      expect((await coreQuery("select count(*)::int as n from organisations")).rows[0]).toEqual(before);

      // Through the route, with the code.
      const cookie = await sessionCookieFor(admin);
      const response = await restoreRoute.POST(
        apiRequest("/api/admin/backups/restore", { method: "POST", cookie, body: { folder, file: path.relative(folder, orgFile), id: "wiz-moved", key: codeA } }),
        noContext,
      );
      expect(response.status).toBe(201);
      const { report } = (await response.json()) as { report: { secrets: { reEncrypted: number; unreadable: number }; reconnect: string[] } };
      expect(report.secrets.reEncrypted).toBeGreaterThanOrEqual(1);
      expect(report.secrets.unreadable).toBe(0);
      expect(report.reconnect).toEqual([]);
      // Readable with this computer's own key: the restored owner's private mail works here.
      expect(await copyKeyOpens("wiz-moved", mailOwner)).toBe(true);
    } finally {
      process.env.TOHYEE_SECRET_KEY = LIVE_A;
      await coreQuery("insert into server_settings (key, value, secret_ciphertext) values ('backup_recovery_keys', $1::jsonb, $2)", [JSON.stringify(keys.rows[0].value), keys.rows[0].secret_ciphertext]);
    }
  }, 600_000);
});

describeWithDatabase("recovering the whole server on a replacement computer (#389 part 3)", () => {
  let serverA: TestServer | null = null;
  let serverB: TestServer;
  let farmFile = "";
  let serverFile = "";
  let jessA = "";
  let kimA = "";

  beforeAll(async () => {
    // The original server: Jess (server admin, two-step on), Kim (an Owner with private mail), one organisation.
    serverA = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = LIVE_A;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-wizard-full-"));
    const jess = await createTestUser("jess@example.com", { serverAdmin: true });
    const kim = await createTestUser("kim@example.com");
    jessA = jess.id;
    kimA = kim.id;
    await coreQuery("update users set totp_secret_ciphertext = $2, totp_enabled_at = now() where id = $1", [jess.id, encryptSecret(TOTP)]);
    await createTestOrganisation(jess, "farm-co");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ('farm-co', $1, 'owner')", [kim.id]);
    await addPrivateMailCopy("farm-co", kim);
    await updateBackupSettings({ user: jess }, { folder });
    await backUpNow({ trigger: "manual", requestedByEmail: jess.email });
    const files = await listBackupFiles();
    farmFile = files.find((f) => f.header?.organisationId === "farm-co")!.path;
    serverFile = files.find((f) => f.header?.kind === "server")!.path;
    const kit = await exportRecoveryKit({ user: jess }, { password: TEST_PASSWORD, form: "code" });
    codeA = kit.form === "code" ? kit.code : "";
    // The computer is lost: its databases go, only the backup folder and the kit are left.
    await serverA.teardown();
    serverA = null;

    // The replacement: a fresh install with its own key, and its first server admin under the same email.
    serverB = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = LIVE_B;
  }, 900_000);

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await serverA?.teardown();
    await serverB?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("restores the organisation and the people with only the backups and the recovery kit", async () => {
    const jessB = await createTestUser("jess@example.com", { serverAdmin: true });
    const material = await recoveryMaterial({ key: codeA });

    // What it would do, before anything is restored.
    const preview = await recoverPeople({ user: jessB }, { file: serverFile, material });
    expect(preview.applied).toBe(false);
    expect(preview.add.map((p) => p.email)).toEqual(["kim@example.com"]);
    expect(preview.conflicts).toEqual([{ email: "jess@example.com", organisationsHere: 0, replacing: false }]);
    expect(preview.organisationsNotHere.map((o) => o.id)).toEqual(["farm-co"]);
    expect((await coreQuery("select count(*)::int as n from users")).rows[0]).toEqual({ n: 1 });

    // The organisation, keeping its ID (it isn't on this computer).
    expect((await inspectBackup(farmFile, material)).suggestedId).toBe("farm-co");
    const { organisation, report } = await restoreBackup({ id: jessB.id, email: jessB.email }, { file: farmFile, material });
    expect(organisation.id).toBe("farm-co");
    expect(report.privateMail).toEqual({ copies: 1, ownersHere: 0, ownersNotHere: 1 });
    expect(report.secrets.reEncrypted).toBeGreaterThanOrEqual(1);
    // Nobody can read Kim's private mail yet, Jess included (she's the restoring Owner).
    expect(await privateCopiesSeenBy("farm-co", jessB)).toBe(0);

    // The people, with Jess's account here replaced by her original (same ID as her history and memberships).
    const plan = await recoverPeople({ user: jessB }, { file: serverFile, material, apply: true, replace: ["jess@example.com"] });
    expect(plan.applied).toBe(true);
    expect(plan.add.map((p) => [p.email, p.twoStep])).toEqual([
      ["jess@example.com", "kept"],
      ["kim@example.com", "set up again"], // the test helper's placeholder two-step secret never opened anywhere
    ]);
    const users = await coreQuery<{ id: string; email: string; password_hash: string; is_server_admin: boolean; totp_secret_ciphertext: string | null }>(
      "select id::text, email, password_hash, is_server_admin, totp_secret_ciphertext from users order by email",
    );
    expect(users.rows.map((u) => [u.email, u.id])).toEqual([
      ["jess@example.com", jessA],
      ["kim@example.com", kimA],
    ]);
    expect(await verifyPassword(TEST_PASSWORD, users.rows[1].password_hash)).toBe(true);
    expect(users.rows[0].is_server_admin).toBe(true);
    expect(decryptSecret(users.rows[0].totp_secret_ciphertext!)).toBe(TOTP); // re-encrypted with this computer's key
    const members = await coreQuery<{ email: string; role: string }>(
      "select u.email, m.role from organisation_members m join users u on u.id = m.user_id where m.organisation_id = 'farm-co' order by u.email",
    );
    expect(members.rows).toEqual([
      { email: "jess@example.com", role: "owner" },
      { email: "kim@example.com", role: "owner" },
    ]);

    // Private mail is Kim's again, and only Kim's.
    expect(await privateCopiesSeenBy("farm-co", { id: kimA, email: "kim@example.com" })).toBe(1);
    expect(await privateCopiesSeenBy("farm-co", { id: jessA, email: "jess@example.com" })).toBe(0);
    expect(await copyKeyOpens("farm-co", { id: kimA, email: "kim@example.com" })).toBe(true);

    // Running it again changes nothing more.
    const again = await recoverPeople({ user: { ...jessB, id: jessA } }, { file: serverFile, material, apply: true });
    expect(again.add).toEqual([]);
    expect(again.memberships).toEqual([]);
    expect(again.alreadyHere.sort()).toEqual(["jess@example.com", "kim@example.com"]);
  }, 900_000);
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as backupsRoute from "@/app/api/admin/backups/route";
import * as checkRoute from "@/app/api/admin/backups/check/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { checkStoredBackups, latestChecks, runDueIntegrityChecks } from "@/lib/backups/checks";
import type { BackupOverview } from "@/lib/backups/overview";
import { backUpNow, fileSha256, listBackupFiles, updateBackupSettings } from "@/lib/backups/service";
import { coreQuery } from "@/lib/db/transactions";
import { postJournal } from "@/lib/ledger/journals";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "evidence-co";
const KEY = "backup-evidence-key-0123456789abcdefghijkl";
const noContext = undefined as unknown;

describeWithDatabase("backups: evidence, checks and keeping good copies (#389 part 1)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let folder: string;
  let cookie: string;
  const originalKey = process.env.TOHYEE_SECRET_KEY;

  const orgFolder = () => path.join(folder, ORG);
  const newestOrgFile = async () => (await fs.readdir(orgFolder())).filter((n) => n.endsWith(".tohyee-backup")).sort().at(-1)!;

  beforeAll(async () => {
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = KEY;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-evidence-"));
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("j"),
        postingDate: "2026-06-15",
        reference: "EVIDENCE-1",
        lines: [
          { accountCode: "1000", debitAmount: "42.00" },
          { accountCode: "4000", creditAmount: "42.00" },
        ],
      }),
    );
    await updateBackupSettings({ user: owner }, { folder });
    cookie = await sessionCookieFor(owner);
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("records each file's SHA-256 and checks the newest files again from the folder", async () => {
    const runs = await backUpNow({ trigger: "manual", requestedByEmail: owner.email });
    expect(runs.map((r) => r.status)).toEqual(["ok", "ok"]);
    for (const made of runs) expect(made.sha256).toBe(await fileSha256(made.filePath!));

    const checks = await checkStoredBackups({ requestedByEmail: owner.email });
    expect(checks.map((c) => [c.organisationId, c.status, c.details.sha256Matches])).toEqual([
      [null, "ok", true],
      [ORG, "ok", true],
    ]);
    expect(checks[1].fileName).toBe(path.join(ORG, path.basename(runs[1].filePath!)));
    expect((await latestChecks("integrity")).length).toBe(2);
  });

  it("a file changed after it was made fails the check, and so does a different good file in its place", async () => {
    const name = await newestOrgFile();
    const file = path.join(orgFolder(), name);
    const original = await fs.readFile(file);
    const changed = Buffer.from(original);
    changed[changed.length - 200] ^= 0xff;
    await fs.writeFile(file, changed);
    let [check] = await checkStoredBackups({ requestedByEmail: owner.email, organisationId: ORG });
    expect(check).toMatchObject({ status: "failed", organisationId: ORG });
    expect(check.error).toMatch(/damaged or was changed/);

    // A second, perfectly good backup of the same organisation copied over the first: it opens, but isn't the file
    // that was made and checked under that name.
    await fs.writeFile(file, original);
    const [second] = await backUpNow({ trigger: "manual", requestedByEmail: owner.email, organisationId: ORG });
    expect(second.filePath).not.toBe(file); // even in the same second, a new backup never takes an existing file's name
    await fs.copyFile(second.filePath!, file);
    await fs.rm(second.filePath!);
    [check] = await checkStoredBackups({ requestedByEmail: owner.email, organisationId: ORG });
    expect(check.status).toBe("failed");
    expect(check.error).toMatch(/isn't the one Tohyee made/);
    await fs.writeFile(file, original);
    [check] = await checkStoredBackups({ requestedByEmail: owner.email, organisationId: ORG });
    expect(check.status).toBe("ok");
  });

  it("a backup on record with no file left in the folder fails the check", async () => {
    const moved = path.join(folder, "moved-away");
    await fs.rename(orgFolder(), moved);
    try {
      const [check] = await checkStoredBackups({ requestedByEmail: owner.email, organisationId: ORG });
      expect(check.status).toBe("failed");
      expect(check.error).toMatch(/no backup file for Test evidence-co/);
    } finally {
      await fs.rm(orgFolder(), { recursive: true, force: true });
      await fs.rename(moved, orgFolder());
    }
  });

  it("pruning never counts or deletes a damaged file, so it can't push out a good one", async () => {
    const good = path.join(orgFolder(), await newestOrgFile());
    // 20 good older backups, one a day from 1 September, and a damaged "newer" file.
    for (let day = 1; day <= 20; day += 1) {
      await fs.copyFile(good, path.join(orgFolder(), `${ORG}_2026-09-${String(day).padStart(2, "0")}_020000.tohyee-backup`));
    }
    const damaged = path.join(orgFolder(), `${ORG}_2026-12-31_020000.tohyee-backup`);
    await fs.writeFile(damaged, "TOHYEE-BACKUP 1\nnot json");
    const notOurs = path.join(orgFolder(), "notes.txt");
    await fs.writeFile(notOurs, "kept");

    const [made] = await backUpNow({ trigger: "manual", requestedByEmail: owner.email, organisationId: ORG });
    expect(made.status).toBe("ok");
    const left = (await fs.readdir(orgFolder())).sort();
    expect(left).toContain(path.basename(damaged));
    expect(left).toContain("notes.txt");
    const kept = left.filter((n) => n.endsWith(".tohyee-backup") && n !== path.basename(damaged));
    // 14 days with a backup (today's newest and 8-20 September), plus the first backup of each month: today's
    // first and 1 September.
    expect(kept).toHaveLength(16);
    expect(kept).toContain(`${ORG}_2026-09-01_020000.tohyee-backup`);
    expect(kept).toContain(`${ORG}_2026-09-08_020000.tohyee-backup`);
    expect(kept).toContain(`${ORG}_2026-09-20_020000.tohyee-backup`);
    expect(kept).not.toContain(`${ORG}_2026-09-07_020000.tohyee-backup`);
    expect(kept).not.toContain(`${ORG}_2026-09-02_020000.tohyee-backup`);

    const files = await listBackupFiles(ORG);
    expect(files.filter((f) => f.problem).map((f) => path.basename(f.name))).toEqual([path.basename(damaged)]);
    await fs.rm(damaged);
    await fs.rm(notOurs);
  });

  it("a missing backup folder or a disk that's clearly too full fails at once, keeping the older backups", async () => {
    const before = (await fs.readdir(orgFolder())).sort();
    const gone = path.join(folder, "unplugged-drive", "Tohyee backups");
    await fs.mkdir(gone, { recursive: true });
    await updateBackupSettings({ user: owner }, { folder: gone });
    await fs.rm(path.join(folder, "unplugged-drive"), { recursive: true });
    const [missing] = await backUpNow({ trigger: "manual", requestedByEmail: owner.email, organisationId: ORG });
    expect(missing.status).toBe("failed");
    expect(missing.error).toBe(`The backup folder ${gone} isn't there. If it's on a USB or external drive, plug it in; otherwise choose the folder again. The older backups were kept.`);
    // It wasn't quietly made again (a OneDrive folder made again wouldn't be synced).
    await expect(fs.stat(gone)).rejects.toThrow();

    await updateBackupSettings({ user: owner }, { folder });
    await coreQuery(`update backup_runs set size_bytes = 1000000000000000 where id = (select max(id) from backup_runs where organisation_id = $1 and status = 'ok')`, [ORG]);
    const [full] = await backUpNow({ trigger: "manual", requestedByEmail: owner.email, organisationId: ORG });
    expect(full.status).toBe("failed");
    expect(full.error).toMatch(/^There isn't room for this backup in .+: about .+ is needed and .+ is free\. Free up space or choose a folder on a bigger disk\. The older backups were kept\.$/);
    expect((await fs.readdir(orgFolder())).sort()).toEqual(before);
    await coreQuery("delete from backup_runs where status = 'failed'");
    await coreQuery("update backup_runs set size_bytes = 1000 where size_bytes = 1000000000000000");
    const [again] = await backUpNow({ trigger: "manual", requestedByEmail: owner.email, organisationId: ORG });
    expect(again.status).toBe("ok");
  });

  it("the weekly check runs by itself when due, and not again within the week", async () => {
    await coreQuery("delete from backup_checks");
    const first = await runDueIntegrityChecks();
    expect(first.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(first.every((c) => c.requestedByEmail === null)).toBe(true);
    expect(await runDueIntegrityChecks()).toEqual([]);
    expect((await runDueIntegrityChecks(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))).length).toBe(2);
  });

  it("the overview through the server settings address: evidence only, off-site never confirmed", async () => {
    const got = await backupsRoute.GET(apiRequest("/api/admin/backups", { cookie }), noContext);
    expect(got.status).toBe(200);
    const body = (await got.json()) as { overview: BackupOverview; runs: { fileName: string | null; filePath?: string }[] };
    expect(body.overview.offSite.verified).toBe(false);
    expect(body.overview.destination.kind).toBe("local");
    expect(body.overview.targets.map((t) => t.state)).toEqual(["ok", "ok"]);
    expect(body.overview.integrity.failed).toBe(0);
    expect(body.overview.storage.fileCount).toBeGreaterThan(2);
    expect(body.runs.every((r) => r.filePath === undefined && (r.fileName === null || !path.isAbsolute(r.fileName)))).toBe(true);

    const checked = await checkRoute.POST(apiRequest("/api/admin/backups/check", { method: "POST", cookie, body: {} }), noContext);
    expect(checked.status).toBe(200);
    expect(((await checked.json()) as { checks: unknown[] }).checks).toHaveLength(2);
    expect((await checkRoute.POST(apiRequest("/api/admin/backups/check", { method: "POST", cookie, body: {}, local: false }), noContext)).status).toBe(403);
    const someone = await createTestUser("kim@example.com");
    expect((await checkRoute.POST(apiRequest("/api/admin/backups/check", { method: "POST", cookie: await sessionCookieFor(someone), body: {} }), noContext)).status).toBe(403);
  });
});

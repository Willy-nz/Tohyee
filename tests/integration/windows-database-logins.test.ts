import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { backUpNow, restoreBackupAsCopy, updateBackupSettings } from "@/lib/backups/service";
import { migrateEverything } from "@/lib/db/migrations";
import type { Actor } from "@/lib/db/org-transaction";
import { closeAllPools } from "@/lib/db/pools";
import { postJournal } from "@/lib/ledger/journals";
import { databaseNameFor } from "@/lib/organisations/admin";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  startTestServer,
  testDatabaseUrl,
  type TestServer,
  withDb,
  withLogin,
} from "../helpers/test-server";

/**
 * Issue #152: the Windows installer moves an existing install from one
 * superuser login to an admin login (NOSUPERUSER CREATEDB) and a plain
 * runtime login, using installer/windows/database-logins.sql and
 * database-owner.sql. This runs those same files against an install made the
 * old way and checks Tohyee keeps working.
 */

const ORG = "win-upgrade";
const KEY = "windows-logins-test-key-0123456789abcdefgh";
const installerDir = path.resolve(__dirname, "../../installer/windows");

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

async function asSuperuser<T>(database: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function runInstallerSql(database: string, file: string, settings: Record<string, string>): Promise<void> {
  const sql = await fs.readFile(path.join(installerDir, file), "utf8");
  await asSuperuser(database, async (client) => {
    for (const [name, value] of Object.entries(settings)) {
      await client.query("select set_config($1, $2, false)", [name, value]);
    }
    await client.query(sql);
  });
}

describeWithDatabase("Windows installer: moving to separate database logins (#152)", () => {
  let server: TestServer;
  let actor: Actor;
  let folder: string;
  const suffix = randomBytes(4).toString("hex");
  const adminRole = `tohyee_ad_${suffix}`;
  const appRole = `tohyee_rt_${suffix}`;
  const adminPassword = randomBytes(18).toString("hex");
  const appPassword = randomBytes(18).toString("hex");
  const originalUrl = process.env.DATABASE_URL;
  const originalAdminUrl = process.env.DATABASE_ADMIN_URL;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  let superuser = "";
  let orgDatabase = "";

  beforeAll(async () => {
    // An install made the old way: one superuser login owns everything.
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = KEY;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-win-logins-"));
    const owner = await createTestUser("owner@example.com", { serverAdmin: true });
    actor = { userId: owner.id, email: owner.email };
    await createTestOrganisation(owner, ORG);
    await inOrganisation(ORG, actor, (tx) => postJournal(tx, journal("2026-06-15", "50.00", "OLD-1")));
    await updateBackupSettings({ user: owner }, { folder });
    orgDatabase = databaseNameFor(ORG);
    superuser = decodeURIComponent(new URL(testDatabaseUrl!).username);
    await closeAllPools();

    // What configure-tohyee.ps1 does on the update.
    const settings = {
      "tohyee.admin_role": adminRole,
      "tohyee.admin_password": adminPassword,
      "tohyee.app_role": appRole,
      "tohyee.app_password": appPassword,
    };
    await runInstallerSql("postgres", "database-logins.sql", settings);
    for (const database of [server.coreDatabase, orgDatabase]) {
      await runInstallerSql(database, "database-owner.sql", { "tohyee.admin_role": adminRole });
    }

    const core = withDb(testDatabaseUrl!, server.coreDatabase);
    process.env.DATABASE_ADMIN_URL = withLogin(core, adminRole, adminPassword);
    process.env.DATABASE_URL = withLogin(core, appRole, appPassword);
    // Tohyee runs its migrations (and grants) when it starts.
    const migrated = await migrateEverything();
    expect(migrated.organisations.every((organisation) => organisation.ok)).toBe(true);
  });

  afterAll(async () => {
    await closeAllPools();
    // Drop the databases as the superuser, then the two logins.
    process.env.DATABASE_URL = originalUrl;
    process.env.DATABASE_ADMIN_URL = originalAdminUrl;
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await asSuperuser("postgres", async (client) => {
      const databases = await client.query<{ datname: string }>(
        "select datname from pg_database where datname = $1 or datname like $2",
        [server.coreDatabase, `${server.coreDatabase}_org_%`],
      );
      for (const row of databases.rows) {
        await client.query(`drop database if exists "${row.datname}" with (force)`);
      }
      await client.query(`drop role if exists "${adminRole}"`);
      await client.query(`drop role if exists "${appRole}"`);
    });
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("neither login is a superuser; only the admin login can create databases", async () => {
    const roles = await asSuperuser("postgres", (client) =>
      client.query<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
        "select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = any($1::text[]) order by rolname",
        [[adminRole, appRole]],
      ),
    );
    expect(roles.rows).toEqual([
      { rolname: adminRole, rolsuper: false, rolcreatedb: true, rolcreaterole: false },
      { rolname: appRole, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
    ]);
  });

  it("the superuser no longer owns the databases or anything in them", async () => {
    for (const database of [server.coreDatabase, orgDatabase]) {
      const owned = await asSuperuser(database, (client) =>
        client.query<{ dbowner: string; objects: string }>(
          `select (select pg_get_userbyid(datdba) from pg_database where datname = current_database()) as dbowner,
                  ((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relowner = (select oid from pg_roles where rolname = $1))
                 + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proowner = (select oid from pg_roles where rolname = $1)))::text as objects`,
          [superuser],
        ),
      );
      expect(owned.rows[0]).toEqual({ dbowner: adminRole, objects: "0" });
    }
  });

  it("the books still work as the runtime login, and posted history stays append-only", async () => {
    await inOrganisation(ORG, actor, (tx) => postJournal(tx, journal("2026-06-16", "5.00", "NEW-1")));
    const count = await inOrganisation(ORG, actor, (tx) =>
      tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"),
    );
    expect(count.rows[0].count).toBe("2");
    await expect(
      inOrganisation(ORG, actor, (tx) => tx.query("update ledger_journals set reference = 'changed'")),
    ).rejects.toThrow();
    await expect(inOrganisation(ORG, actor, (tx) => tx.query("create table sneaky (id int)"))).rejects.toThrow();
  });

  it("the runtime login can't run programs on the server", async () => {
    await expect(
      inOrganisation(ORG, actor, (tx) => tx.query("copy (select 1) to program 'echo hello'")),
    ).rejects.toThrow();
  });

  it("backups and restoring as a copy work with the admin login", async () => {
    const runs = await backUpNow({ trigger: "manual", requestedByEmail: actor.email, organisationId: ORG });
    expect(runs[0].status).toBe("ok");
    await restoreBackupAsCopy({ id: actor.userId, email: actor.email }, { file: runs[0].filePath!, id: `${ORG}-copy` });
    await inOrganisation(`${ORG}-copy`, actor, (tx) => postJournal(tx, journal("2026-06-17", "1.00", "COPY-1")));
  });

  it("running the scripts again changes nothing", async () => {
    await closeAllPools();
    await runInstallerSql(
      "postgres",
      "database-logins.sql",
      {
        "tohyee.admin_role": adminRole,
        "tohyee.admin_password": adminPassword,
        "tohyee.app_role": appRole,
        "tohyee.app_password": appPassword,
      },
    );
    for (const database of [server.coreDatabase, orgDatabase]) {
      await runInstallerSql(database, "database-owner.sql", { "tohyee.admin_role": adminRole });
    }
    await inOrganisation(ORG, actor, (tx) => postJournal(tx, journal("2026-06-18", "2.00", "AGAIN-1")));
  });
});

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseNameOf, getDatabaseUrl, withDatabaseName } from "@/lib/db/connection";
import { migrateAllOrganisations, migrateCoreDatabase } from "@/lib/db/migrations";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { getAdminPool } from "@/lib/db/pools";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { createOrganisation, databaseNameFor } from "@/lib/organisations/admin";
import { provisionOrganisation } from "@/lib/organisations/provisioning";
import { getOrganisation } from "@/lib/organisations/registry";
import { NZ_DEFAULT_TAX_CODES } from "@/lib/tax/default-codes";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  startTestServer,
  testDatabaseUrl,
  type TestServer,
  withDb,
} from "../helpers/test-server";

const STANDARD_CODES = [
  { code: "EXEMPT", label: "Exempt", category: "exempt", rate: "0", effective_from: "2010-10-01" },
  { code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effective_from: "2010-10-01" },
  { code: "NONE", label: "No GST", category: "out_of_scope", rate: "0", effective_from: "2010-10-01" },
  { code: "ZERO", label: "Zero rated", category: "zero_rated", rate: "0", effective_from: "2010-10-01" },
];
const TAX_CODES_SQL = "select code, label, category, rate::text as rate, effective_from::text as effective_from from tax_codes order by code";

describeWithDatabase("one database per organisation", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("gives each organisation its own database with a starting chart of accounts", async () => {
    const owner = await createTestUser("owner@example.com", { serverAdmin: true });
    const a = await createTestOrganisation(owner, "alpha");
    const b = await createTestOrganisation(owner, "beta");

    expect(a.databaseName).not.toBe(b.databaseName);
    expect(a.databaseName).toContain(databaseNameOf(getDatabaseUrl()));
    expect(a.migrationStatus).toBe("current");
    expect(a.schemaVersion).toBe(tenantMigrations[tenantMigrations.length - 1].version);

    const actor = { userId: owner.id, email: owner.email };
    const accounts = await inOrganisation("alpha", actor, (tx) =>
      tx.query<{ code: string }>("select code from accounts order by code"),
    );
    expect(accounts.rows.map((row) => row.code)).toContain("1400");

    // And the standard NZ GST codes, so GST invoices and bills work straight away.
    const taxCodes = await inOrganisation("alpha", actor, (tx) => tx.query(TAX_CODES_SQL));
    expect(taxCodes.rows).toEqual(STANDARD_CODES);
    expect(NZ_DEFAULT_TAX_CODES.map((c) => c.code).sort()).toEqual(STANDARD_CODES.map((c) => c.code));

    // The databases really are separate: rows written to alpha don't exist in beta.
    await inOrganisation("alpha", actor, (tx) =>
      tx.query("insert into tax_codes (command_source, idempotency_key, request_hash, code, label, category, rate, effective_from) values ('t', 'only-in-alpha', 'h', 'ALPHA', 'GST', 'standard', 0.15, '2026-01-01')"),
    );
    const inBeta = await inOrganisation("beta", actor, (tx) =>
      tx.query("select 1 from tax_codes where idempotency_key = 'only-in-alpha'"),
    );
    expect(inBeta.rowCount).toBe(0);

    // Each database records which organisation it belongs to.
    const settings = await inOrganisation("beta", actor, (tx) =>
      tx.query<{ organisation_id: string }>("select organisation_id from organisation_settings"),
    );
    expect(settings.rows[0].organisation_id).toBe("beta");
  });

  it("won't take over a database it doesn't know, and provisions one organisation at a time (#136)", async () => {
    const owner = await createTestUser("stray-owner@example.com", { serverAdmin: true });
    const stray = databaseNameFor("stray");
    await getAdminPool().query(`create database ${quoteSqlIdentifier(stray)}`);
    try {
      await expect(createOrganisation({ id: owner.id, email: owner.email }, { id: "stray", displayName: "Stray" })).rejects.toThrow(
        `There's already a database called ${stray}`,
      );
      expect(await getOrganisation("stray")).toBeNull();
      expect((await getAdminPool().query("select 1 from pg_database where datname = $1", [stray])).rowCount).toBe(1);
    } finally {
      await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(stray)} with (force)`);
    }
    // Provisioning the same organisation twice at once: both finish, one after the other, with one database.
    const made = await createTestOrganisation(owner, "twice");
    await Promise.all([provisionOrganisation("twice"), provisionOrganisation("twice")]);
    expect((await getOrganisation("twice"))?.provisioningStatus).toBe("ready");
    expect(made.databaseName).toBe(databaseNameFor("twice"));
  });

  it("migration 0031 gives existing organisations with no tax codes the standard ones, and leaves the rest alone", async () => {
    const before = tenantMigrations.filter((migration) => migration.version < "0031");
    const upgrade = async (name: string, setup: (client: pg.Client) => Promise<void>) => {
      const databaseName = `${server.coreDatabase}_org_${name}`;
      const admin = new pg.Client({ connectionString: testDatabaseUrl! });
      await admin.connect();
      await admin.query(`create database "${databaseName}"`);
      await admin.end();
      const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
      await client.connect();
      try {
        await applyMigrations(client, before, "test:0031");
        await setup(client);
        expect((await applyMigrations(client, tenantMigrations, "test:0031")).applied).toContain("0031");
        return (await client.query(TAX_CODES_SQL)).rows;
      } finally {
        await client.end();
      }
    };
    const settings = (client: pg.Client, id: string) =>
      client.query("insert into organisation_settings (id, organisation_id, display_name, base_currency) values (true, $1, $1, 'NZD')", [id]);

    // An existing organisation with no tax codes gets the four.
    expect(await upgrade("none", (client) => settings(client, "none").then(() => undefined))).toEqual(STANDARD_CODES);

    // One that already has any code (even a single one of its own) is left alone.
    expect(
      await upgrade("own", async (client) => {
        await settings(client, "own");
        await client.query(
          `insert into tax_codes (command_source, idempotency_key, request_hash, code, label, category, rate, effective_from)
           values ('api', 'mine', 'h', 'GST15', 'My GST', 'standard', 0.15, '2024-04-01')`,
        );
      }),
    ).toEqual([{ code: "GST15", label: "My GST", category: "standard", rate: "0.15", effective_from: "2024-04-01" }]);

    // A brand-new database (not yet provisioned) gets its codes from provisioning, not the migration.
    expect(await upgrade("fresh", async () => undefined)).toEqual([]);
  });

  it("re-running migrations is a no-op", async () => {
    const core = await migrateCoreDatabase();
    expect(core.applied).toEqual([]);
    const organisations = await migrateAllOrganisations();
    expect(organisations.every((result) => result.ok && result.applied.length === 0)).toBe(true);
  });

  it("refuses to run if an applied migration was edited", async () => {
    const organisation = (await getOrganisation("alpha"))!;
    const client = new pg.Client({ connectionString: withDatabaseName(getDatabaseUrl(), organisation.databaseName) });
    await client.connect();
    await client.query("update schema_migrations set checksum = 'tampered' where version = '0001'");
    await client.end();

    const results = await migrateAllOrganisations();
    const alpha = results.find((result) => result.organisationId === "alpha")!;
    expect(alpha.ok).toBe(false);
    expect(alpha.error).toMatch(/changed after it was applied/);
    expect((await getOrganisation("alpha"))!.migrationStatus).toBe("failed");

    // A failed organisation is blocked, others carry on.
    await expect(
      inOrganisation("alpha", { userId: null, email: "t" }, (tx) => tx.query("select 1")),
    ).rejects.toThrow(/upgrade failed/);
    expect(results.find((result) => result.organisationId === "beta")!.ok).toBe(true);
  });

  it("refuses to run an older app against a newer organisation database", async () => {
    const organisation = (await getOrganisation("beta"))!;
    const client = new pg.Client({ connectionString: withDatabaseName(getDatabaseUrl(), organisation.databaseName) });
    await client.connect();
    await client.query(
      "insert into schema_migrations (version, name, checksum) values ('9999', 'from_a_newer_version', 'x')",
    );
    await client.end();

    const results = await migrateAllOrganisations();
    const beta = results.find((result) => result.organisationId === "beta")!;
    expect(beta.ok).toBe(false);
    expect(beta.error).toMatch(/doesn't know about \(9999\)/);
    expect((await getOrganisation("beta"))!.migrationStatus).toBe("failed");
  });
});

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseNameOf, getDatabaseUrl, withDatabaseName } from "@/lib/db/connection";
import { migrateAllOrganisations, migrateCoreDatabase } from "@/lib/db/migrations";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { getOrganisation } from "@/lib/organisations/registry";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

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

    // The databases really are separate: rows written to alpha don't exist in beta.
    await inOrganisation("alpha", actor, (tx) =>
      tx.query("insert into tax_codes (command_source, idempotency_key, request_hash, code, label, category, rate, effective_from) values ('t', 'only-in-alpha', 'h', 'GST', 'GST', 'standard', 0.15, '2026-01-01')"),
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

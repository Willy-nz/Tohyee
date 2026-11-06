import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { closeAllPools, closeOrganisationPool, getAdminPool, getCorePool, getOrganisationPool } from "@/lib/db/pools";
import { getOrganisation } from "@/lib/organisations/registry";
import { quoteSqlIdentifier } from "@/lib/db/sql";
import { createTestOrganisation, createTestUser, describeWithDatabase, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Closing a pool before dropping its database doesn't wait forever for a
 * connection someone still holds (a job, or a query stuck behind a lock):
 * it waits a little, says so, and the drop's FORCE ends the rest. This was
 * behind the CI tests that hung in their clean-up (demo farm delete,
 * teardown). Made-up organisations only.
 */
describeWithDatabase("closing database pools", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("an organisation pool with a connection still out closes after the wait, and its database can be dropped", async () => {
    const owner = await createTestUser("pool-close@example.com");
    await createTestOrganisation(owner, "pool-close-co");
    const { databaseName } = (await getOrganisation("pool-close-co"))!;
    const held = await getOrganisationPool(databaseName).connect();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = Date.now();
    await closeOrganisationPool(databaseName, { waitMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("1 connection"))).toBe(true);
    warn.mockRestore();
    await getAdminPool().query(`drop database if exists ${quoteSqlIdentifier(databaseName)} with (force)`);
    expect((await getAdminPool().query("select 1 from pg_database where datname = $1", [databaseName])).rowCount).toBe(0);
    held.release(true);
  });

  it("closing every pool doesn't wait forever either", async () => {
    const held = await getCorePool().connect();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = Date.now();
    await closeAllPools({ waitMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    warn.mockRestore();
    held.release(true);
  });

  it("a pool with nothing out closes straight away, with no warning", async () => {
    const owner = await createTestUser("pool-close-2@example.com");
    await createTestOrganisation(owner, "pool-close-two");
    const { databaseName } = (await getOrganisation("pool-close-two"))!;
    await getOrganisationPool(databaseName).query("select 1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await closeOrganisationPool(databaseName, { waitMs: 300 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

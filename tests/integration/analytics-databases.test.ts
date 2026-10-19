import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as analyticsRoute from "@/app/api/analytics/route";
import * as connectionsRoute from "@/app/api/analytics/connections/route";
import * as connectionRoute from "@/app/api/analytics/connections/[connectionId]/route";
import * as objectsRoute from "@/app/api/analytics/connections/[connectionId]/objects/route";
import * as previewRoute from "@/app/api/analytics/connections/[connectionId]/preview/route";
import * as testRoute from "@/app/api/analytics/connections/test/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as sourceRoute from "@/app/api/analytics/sources/[sourceId]/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics, queryAnalytics } from "@/lib/analytics/engine";
import { runDueLoads } from "@/lib/analytics/scheduler";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
  withDb,
} from "../helpers/test-server";

const ORG = "analytics-db-co";
const noContext = undefined as unknown;
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "";

/**
 * External databases as Analytics sources (decisions 602-605), against a
 * real PostgreSQL: a small made-up database with a read-only user, created
 * here and dropped afterwards. MySQL and SQL Server aren't available here;
 * their code paths are covered with fakes in
 * tests/unit/analytics-database-drivers.test.ts.
 */
describeWithDatabase("analytics database sources (PostgreSQL)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let root: string;
  const suffix = randomBytes(4).toString("hex");
  const shopDatabase = `tohyee_extshop_${suffix}`;
  const reader = `tohyee_extreader_${suffix}`;
  const readerPassword = `Reader-${suffix}-pw`;
  let connectionId: string;
  let tableSourceId: string;

  const body = async (response: Response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are checked field by field
    data: (await response.json()) as Record<string, any>,
  });
  const port = Number(new URL(testDatabaseUrl || "postgresql://x@localhost:5432/x").port || 5432);
  const details = { engine: "postgres", host: "localhost", port, database: shopDatabase, username: reader, encryption: "require" };

  async function asSuperuser(database: string, sql: string) {
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl, database) });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-analytics-db-it-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    process.env.TOHYEE_SECRET_KEY = "analytics-database-test-secret-key-0123456789";
    // A made-up shop database, and a user that can only read it.
    await asSuperuser("postgres", `create database "${shopDatabase}"`);
    await asSuperuser("postgres", `create role "${reader}" login password '${readerPassword}'`);
    await asSuperuser(
      shopDatabase,
      `create table orders (
         id integer primary key,
         "CustomerName" text not null,
         amount numeric(12,2) not null,
         qty numeric(10,3),
         ordered_on date not null,
         created_at timestamptz not null,
         paid boolean not null,
         fee money,
         photo bytea
       );
       insert into orders values
         (1, 'Kōwhai Cafe', 1234567890.12, 1.5, '2026-01-05', '2026-01-05 09:30:00+13', true, 2.50, '\\x0102'),
         (2, 'Tūī Books', 0.10, 2, '2026-01-06', '2026-01-06 14:00:00+13', false, 0.20, null),
         (3, 'Rata Farm', 0.20, null, '2026-02-01', '2026-02-01 08:15:00+13', true, null, null);
       create view paid_orders as select id, amount from orders where paid;
       create table writes (n integer);
       create function record_write() returns integer language sql volatile as 'insert into writes values (1) returning n';
       grant connect on database "${shopDatabase}" to "${reader}";
       grant usage on schema public to "${reader}";
       grant select on orders, paid_orders to "${reader}";
       -- So only the read-only transaction can stop the function's write.
       grant insert on writes to "${reader}";`,
    );

    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    viewer = await createTestUser("viewer@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await settingsRoute.PATCH(
      apiRequest(`/api/organisations/${ORG}/settings`, { method: "PATCH", cookie: ownerCookie, body: { analyticsEnabled: true } }),
      params({ organisationId: ORG }),
    );
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    await asSuperuser("postgres", `drop database if exists "${shopDatabase}" with (force)`).catch(() => undefined);
    await asSuperuser("postgres", `drop role if exists "${reader}"`).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("only lets admins and owners see or add connections (decision 602)", async () => {
    const list = await connectionsRoute.GET(apiRequest(`/api/analytics/connections?organisationId=${ORG}`, { cookie: viewerCookie }), noContext);
    expect(list.status).toBe(403);
    const add = await connectionsRoute.POST(
      apiRequest("/api/analytics/connections", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG, name: "Shop", ...details, password: readerPassword } }),
      noContext,
    );
    expect(add.status).toBe(403);
    const tested = await testRoute.POST(
      apiRequest("/api/analytics/connections/test", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG, ...details, password: readerPassword } }),
      noContext,
    );
    expect(tested.status).toBe(403);
  });

  it("tests a connection before saving it, with plain messages when it fails", async () => {
    const wrong = await body(
      await connectionsRoute.POST(
        apiRequest("/api/analytics/connections", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Shop", ...details, password: "not-it" } }),
        noContext,
      ),
    );
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toBe(`The user name or password wasn't accepted for ${reader}.`);
    const missing = await body(
      await testRoute.POST(
        apiRequest("/api/analytics/connections/test", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, ...details, database: `${shopDatabase}_none`, password: readerPassword } }),
        noContext,
      ),
    );
    expect(missing.status).toBe(400);
    // PostgreSQL checks the password before the database, so either answer is a plain one.
    expect(missing.data.error).toMatch(/no database called|wasn't accepted/);
    // The local server's certificate is its own, so checking it fails with advice.
    const verify = await body(
      await testRoute.POST(
        apiRequest("/api/analytics/connections/test", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, ...details, encryption: "verify", password: readerPassword } }),
        noContext,
      ),
    );
    expect(verify.status).toBe(400);
    expect(verify.data.error).toMatch(/certificate couldn't be checked/);
    const nothing = await body(
      await testRoute.POST(
        apiRequest("/api/analytics/connections/test", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, ...details, port: 1, password: readerPassword } }),
        noContext,
      ),
    );
    expect(nothing.data.error).toMatch(/Nothing answered at localhost \(port 1\)/);
    const listed = await body(await connectionsRoute.GET(apiRequest(`/api/analytics/connections?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(listed.data.connections).toEqual([]);
  });

  it("refuses Tohyee's own databases", async () => {
    const own = await body(
      await testRoute.POST(
        apiRequest("/api/analytics/connections/test", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, ...details, database: server.coreDatabase, password: readerPassword } }),
        noContext,
      ),
    );
    expect(own.status).toBe(400);
    expect(own.data.error).toMatch(/Tohyee's own databases/);
  });

  it("saves a working connection with its password encrypted, never sent back or audited (decision 604)", async () => {
    const tested = await body(
      await testRoute.POST(
        apiRequest("/api/analytics/connections/test", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, ...details, password: readerPassword } }),
        noContext,
      ),
    );
    expect(tested.data).toEqual({ ok: true, tables: 2, views: 1 });

    const saved = await body(
      await connectionsRoute.POST(
        apiRequest("/api/analytics/connections", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Shop database", ...details, password: readerPassword } }),
        noContext,
      ),
    );
    expect(saved.status).toBe(201);
    connectionId = saved.data.connection.id;
    expect(saved.data.connection).toMatchObject({ name: "Shop database", engine: "postgres", host: "localhost", database: shopDatabase, username: reader, hasPassword: true });
    expect(JSON.stringify(saved.data)).not.toContain(readerPassword);
    const listed = await body(await connectionsRoute.GET(apiRequest(`/api/analytics/connections?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(JSON.stringify(listed.data)).not.toContain(readerPassword);

    const stored = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, async (tx) => ({
      row: (await tx.query<{ password_ciphertext: string }>("select password_ciphertext from analytics_db_connections")).rows[0],
      audit: (await tx.query<{ details: unknown }>("select details from audit_events where event_type like 'analytics.database_connection%'")).rows,
    }));
    expect(stored.row.password_ciphertext.startsWith("v2:")).toBe(true);
    expect(stored.row.password_ciphertext).not.toContain(readerPassword);
    expect(stored.audit).toHaveLength(1);
    expect(JSON.stringify(stored.audit)).not.toContain(readerPassword);
  });

  it("reuses a saved password only for the same server, database and user", async () => {
    const same = await body(
      await testRoute.POST(apiRequest("/api/analytics/connections/test", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, ...details, connectionId } }), noContext),
    );
    expect(same.data.ok).toBe(true);
    const elsewhere = await body(
      await testRoute.POST(
        apiRequest("/api/analytics/connections/test", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, ...details, host: "127.0.0.2", connectionId } }),
        noContext,
      ),
    );
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.data.error).toMatch(/Enter the password again/);
    const renamed = await body(
      await connectionRoute.PATCH(
        apiRequest(`/api/analytics/connections/${connectionId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, name: "Shop" } }),
        params({ connectionId }),
      ),
    );
    expect(renamed.status).toBe(200);
    expect(renamed.data.connection.name).toBe("Shop");
    const moved = await body(
      await connectionRoute.PATCH(
        apiRequest(`/api/analytics/connections/${connectionId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, username: "postgres" } }),
        params({ connectionId }),
      ),
    );
    expect(moved.status).toBe(400);
    expect(moved.data.error).toMatch(/Enter the password again/);
  });

  it("lists the tables and views the user can read, and previews one with its types", async () => {
    const objects = await body(await objectsRoute.GET(apiRequest(`/api/analytics/connections/${connectionId}/objects?organisationId=${ORG}`, { cookie: ownerCookie }), params({ connectionId })));
    expect(objects.data.objects).toEqual([
      { schema: "public", name: "orders", kind: "table" },
      { schema: "public", name: "paid_orders", kind: "view" },
      { schema: "public", name: "writes", kind: "table" },
    ]);
    const viewerObjects = await objectsRoute.GET(apiRequest(`/api/analytics/connections/${connectionId}/objects?organisationId=${ORG}`, { cookie: viewerCookie }), params({ connectionId }));
    expect(viewerObjects.status).toBe(403);

    const preview = await body(
      await previewRoute.POST(
        apiRequest(`/api/analytics/connections/${connectionId}/preview`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, schema: "public", table: "orders" } }),
        params({ connectionId }),
      ),
    );
    expect(preview.status).toBe(200);
    expect(preview.data.columns.map((column: Record<string, unknown>) => [column.source, column.name, column.kind, column.loadable, column.detected])).toEqual([
      ["id", "id", "integer", true, "int4"],
      ["CustomerName", "customer_name", "text", true, "text"],
      ["amount", "amount", "money", true, "numeric(12,2)"],
      ["qty", "qty", "quantity", true, "numeric(10,3)"],
      ["ordered_on", "ordered_on", "date", true, "date"],
      ["created_at", "created_at", "timestamp", true, "timestamptz"],
      ["paid", "paid", "boolean", true, "bool"],
      ["fee", "fee", "money", true, "money"],
      ["photo", "photo", "text", false, "bytea"],
    ]);
    expect(preview.data.rows[0]).toEqual(["1", "Kōwhai Cafe", "1234567890.12", "1.500", "2026-01-05", "2026-01-05 09:30:00", "t", "2.50", ""]);
  });

  it("refuses typed queries that would change data, and the read-only transaction stops what the check can't see", async () => {
    const preview = (query: string) =>
      previewRoute.POST(
        apiRequest(`/api/analytics/connections/${connectionId}/preview`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, query } }),
        params({ connectionId }),
      );
    const deleting = await body(await preview("delete from orders"));
    expect(deleting.status).toBe(400);
    expect(deleting.data.error).toMatch(/Only SELECT/);
    const twice = await body(await preview("select 1; drop table orders"));
    expect(twice.data.error).toMatch(/one query/);
    // A function that writes looks like any other to the check; PostgreSQL's read-only transaction refuses it.
    const sneaky = await body(await preview("select record_write() as n"));
    expect(sneaky.status).toBe(400);
    expect(sneaky.data.error).toBe("Tohyee only reads from the database, so it can't run something that changes data.");
    const ok = await body(await preview("select \"CustomerName\" as customer, amount * 2 as doubled from orders where paid -- paid ones\n"));
    expect(ok.status).toBe(200);
    expect(ok.data.rows).toEqual([
      ["Kōwhai Cafe", "2469135780.24"],
      ["Rata Farm", "0.40"],
    ]);
    const broken = await body(await preview("select nope from orders"));
    expect(broken.data.error).toMatch(/^The query didn't work\. The database said: column "nope" does not exist/);
    // Nothing was written.
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl, shopDatabase) });
    await client.connect();
    expect((await client.query("select count(*)::int as n from writes")).rows[0].n).toBe(0);
    await client.end();
  });

  it("loads a table into DuckDB with exact money, dates, times and yes/no (decision 605)", async () => {
    const created = await body(
      await sourcesRoute.POST(
        apiRequest("/api/analytics/sources", {
          method: "POST",
          cookie: ownerCookie,
          body: {
            organisationId: ORG,
            name: "Shop orders",
            tableName: "shop_orders",
            connectionId,
            schema: "public",
            table: "orders",
            rowLimit: 100,
            columns: [
              { source: "CustomerName", name: "customer_name", kind: "text" },
              { source: "amount", name: "amount", kind: "money" },
              { source: "qty", name: "qty", kind: "quantity" },
              { source: "ordered_on", name: "ordered_on", kind: "date" },
              { source: "created_at", name: "created_at", kind: "timestamp" },
              { source: "paid", name: "paid", kind: "boolean" },
              { source: "fee", name: "fee", kind: "money" },
            ],
          },
        }),
        noContext,
      ),
    );
    expect(created.status).toBe(201);
    tableSourceId = created.data.source.id;
    expect(created.data.source.fileName).toBe("Shop › public.orders");
    expect(created.data.source.database).toMatchObject({ connectionId, engine: "postgres", schema: "public", table: "orders", query: null, rowLimit: 100 });

    const run = await body(await loadRoute.POST(apiRequest(`/api/analytics/sources/${tableSourceId}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId: tableSourceId })));
    expect(run.data.run).toMatchObject({ status: "ok", rowsLoaded: "3", fileName: "Shop › public.orders", trigger: "manual" });

    const types = await queryAnalytics(ORG, "select column_name, data_type from information_schema.columns where table_name = 'shop_orders' order by ordinal_position");
    expect(types).toEqual([
      { column_name: "customer_name", data_type: "VARCHAR" },
      { column_name: "amount", data_type: "DECIMAL(18,2)" },
      { column_name: "qty", data_type: "DECIMAL(18,4)" },
      { column_name: "ordered_on", data_type: "DATE" },
      { column_name: "created_at", data_type: "TIMESTAMP" },
      { column_name: "paid", data_type: "BOOLEAN" },
      { column_name: "fee", data_type: "DECIMAL(18,2)" },
    ]);
    expect(
      await queryAnalytics(ORG, "select sum(amount)::varchar as total, count(*) filter (where paid)::int as paid, min(created_at)::varchar as first, max(ordered_on)::varchar as last, sum(fee)::varchar as fees from shop_orders"),
    ).toEqual([{ total: "1234567890.42", paid: 2, first: "2026-01-05 09:30:00", last: "2026-02-01", fees: "2.70" }]);
  });

  it("loads a typed query, and keeps the last copy when a load goes past its row limit", async () => {
    const created = await body(
      await sourcesRoute.POST(
        apiRequest("/api/analytics/sources", {
          method: "POST",
          cookie: ownerCookie,
          body: {
            organisationId: ORG,
            name: "Paid by month",
            tableName: "paid_by_month",
            connectionId,
            query: "select date_trunc('month', ordered_on)::date as month, sum(amount) as total from orders where paid group by 1",
            rowLimit: 5,
            columns: [
              { source: "month", name: "month", kind: "date" },
              { source: "total", name: "total", kind: "money" },
            ],
          },
        }),
        noContext,
      ),
    );
    expect(created.status).toBe(201);
    const id = created.data.source.id;
    const first = await body(await loadRoute.POST(apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId: id })));
    expect(first.data.run.status).toBe("ok");
    expect(await queryAnalytics(ORG, "select month::varchar as month, total::varchar as total from paid_by_month order by month")).toEqual([
      { month: "2026-01-01", total: "1234567890.12" },
      { month: "2026-02-01", total: "0.20" },
    ]);

    const limited = await body(
      await sourceRoute.PATCH(
        apiRequest(`/api/analytics/sources/${id}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, rowLimit: 1 } }),
        params({ sourceId: id }),
      ),
    );
    expect(limited.data.source.database.rowLimit).toBe(1);
    const over = await body(await loadRoute.POST(apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId: id })));
    expect(over.data.run.status).toBe("failed");
    expect(over.data.run.error).toMatch(/more than 1 rows|more than 1 row/);
    expect(await queryAnalytics(ORG, "select count(*)::int as n from paid_by_month")).toEqual([{ n: 2 }]);

    const refused = await body(
      await sourceRoute.PATCH(
        apiRequest(`/api/analytics/sources/${id}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, query: "update orders set paid = true" } }),
        params({ sourceId: id }),
      ),
    );
    expect(refused.status).toBe(400);
  });

  it("shows viewers the sources but not the typed queries or connections", async () => {
    const overview = await body(await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    const query = overview.data.sources.find((source: { name: string }) => source.name === "Paid by month");
    expect(query.database.query).toBeNull();
    expect(JSON.stringify(overview.data)).not.toContain(readerPassword);
    const owners = await body(await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(owners.data.sources.find((source: { name: string }) => source.name === "Paid by month").database.query).toMatch(/^select date_trunc/);
  });

  it("reloads database sources nightly without an analytics folder", async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(18, 0, 0, 0); // after 04:00 in New Zealand
    const made = await runDueLoads(tomorrow);
    const shop = made.find((run) => run.sourceName === "Shop orders");
    expect(shop).toMatchObject({ status: "ok", trigger: "schedule", rowsLoaded: "3" });
  });

  it("won't remove a connection a source uses, and removes it after", async () => {
    const used = await connectionRoute.DELETE(apiRequest(`/api/analytics/connections/${connectionId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ connectionId }));
    expect(used.status).toBe(409);
    const sources = await body(await sourcesRoute.GET(apiRequest(`/api/analytics/sources?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    for (const source of sources.data.sources) {
      const removed = await sourceRoute.DELETE(apiRequest(`/api/analytics/sources/${source.id}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ sourceId: source.id }));
      expect(removed.status).toBe(200);
    }
    const viewerDelete = await connectionRoute.DELETE(apiRequest(`/api/analytics/connections/${connectionId}?organisationId=${ORG}`, { method: "DELETE", cookie: viewerCookie }), params({ connectionId }));
    expect(viewerDelete.status).toBe(403);
    const removed = await connectionRoute.DELETE(apiRequest(`/api/analytics/connections/${connectionId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ connectionId }));
    expect(removed.status).toBe(200);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as analyticsRoute from "@/app/api/analytics/route";
import * as filesRoute from "@/app/api/analytics/files/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as sourceRoute from "@/app/api/analytics/sources/[sourceId]/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics, queryAnalytics } from "@/lib/analytics/engine";
import { loadDue, runDueLoads } from "@/lib/analytics/scheduler";
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
} from "../helpers/test-server";

const ORG = "analytics-co";
const OTHER = "analytics-other";
const noContext = undefined as unknown;

const columns = [
  { source: "Order date", name: "order_date", kind: "date" },
  { source: "Region", name: "region", kind: "text" },
  { source: "Qty", name: "quantity", kind: "quantity" },
  { source: "Unit price", name: "unit_price", kind: "money" },
];

/** Analytics step 1 (decisions 353-358): folders, sources, loads. */
describeWithDatabase("analytics sources and loads", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let root: string;
  let folder: string;

  const body = async (response: Response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are checked field by field
    data: (await response.json()) as Record<string, any>,
  });
  const writeSales = (text: string) => fs.writeFileSync(path.join(folder, "exports", "sales.csv"), text);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-analytics-it-"));
    folder = path.join(root, "reports");
    fs.mkdirSync(path.join(folder, "exports"), { recursive: true });
    fs.writeFileSync(path.join(root, "secret.csv"), "Order date,Region,Qty,Unit price\n2026-01-01,Hidden,1,1.00\n");
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    writeSales("Order date,Region,Qty,Unit price,Notes\n2026-01-05,Otago,1,0.10,a\n2026-01-06,Otago,1,0.20,b\n2026-02-01,Canterbury,2.5,19.99,c\n");

    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(owner, OTHER);
    viewer = await createTestUser("viewer@example.com");
    outsider = await createTestUser("outsider@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is off until an admin turns it on (decision 353)", async () => {
    const before = await body(await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(before.data.enabled).toBe(false);
    const refused = await body(
      await sourcesRoute.POST(
        apiRequest("/api/analytics/sources", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Sales", tableName: "sales", fileName: "exports/sales.csv", columns } }),
        noContext,
      ),
    );
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/Analytics is off/);

    const on = await body(
      await settingsRoute.PATCH(
        apiRequest(`/api/organisations/${ORG}/settings`, { method: "PATCH", cookie: ownerCookie, body: { analyticsEnabled: true } }),
        params({ organisationId: ORG }),
      ),
    );
    expect(on.data.settings.analyticsEnabled).toBe(true);
  });

  it("needs a server admin to choose the folder, on the server computer (decision 358)", async () => {
    const before = await body(await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(before.data.folder).toEqual({ chosen: false, readable: false });
    expect(before.data.files).toEqual([]);

    const remote = await foldersRoute.PUT(
      apiRequest("/api/admin/analytics-folders", { method: "PUT", cookie: ownerCookie, local: false, body: { organisationId: ORG, folder } }),
      noContext,
    );
    expect(remote.status).toBe(403);
    const relative = await body(
      await foldersRoute.PUT(apiRequest("/api/admin/analytics-folders", { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, folder: "reports" } }), noContext),
    );
    expect(relative.status).toBe(400);
    const own = await foldersRoute.PUT(
      apiRequest("/api/admin/analytics-folders", { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, folder: process.env.TOHYEE_ANALYTICS_DIR } }),
      noContext,
    );
    expect(own.status).toBe(400);

    const set = await body(
      await foldersRoute.PUT(apiRequest("/api/admin/analytics-folders", { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, folder } }), noContext),
    );
    expect(set.status).toBe(200);
    const listed = await body(await foldersRoute.GET(apiRequest("/api/admin/analytics-folders", { cookie: ownerCookie }), noContext));
    expect(listed.data.folders).toContainEqual({ organisationId: ORG, displayName: expect.any(String), folder, readable: true });

    const after = await body(await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(after.data.folder).toEqual({ chosen: true, readable: true });
    expect(after.data.files.map((file: { name: string }) => file.name)).toEqual(["exports/sales.csv"]);
    // The path itself stays on the server.
    expect(JSON.stringify(after.data)).not.toContain(root);
  });

  it("previews a file with suggested types, and only inside the folder", async () => {
    const preview = await body(
      await filesRoute.GET(apiRequest(`/api/analytics/files?organisationId=${ORG}&file=exports/sales.csv`, { cookie: ownerCookie }), noContext),
    );
    expect(preview.status).toBe(200);
    expect(preview.data.columns.map((column: { name: string; kind: string }) => [column.name, column.kind])).toEqual([
      ["order_date", "date"],
      ["region", "text"],
      ["qty", "quantity"],
      ["unit_price", "money"],
      ["notes", "text"],
    ]);
    expect(preview.data.rows[0]).toEqual(["2026-01-05", "Otago", "1", "0.10", "a"]);

    for (const file of ["../secret.csv", "/etc/passwd", "exports/missing.csv"]) {
      const refused = await filesRoute.GET(
        apiRequest(`/api/analytics/files?organisationId=${ORG}&file=${encodeURIComponent(file)}`, { cookie: ownerCookie }),
        noContext,
      );
      expect(refused.status).toBe(400);
    }
    const asViewer = await filesRoute.GET(apiRequest(`/api/analytics/files?organisationId=${ORG}&file=exports/sales.csv`, { cookie: viewerCookie }), noContext);
    expect(asViewer.status).toBe(403);
    const outsiderCookie = await sessionCookieFor(outsider);
    const asOutsider = await filesRoute.GET(apiRequest(`/api/analytics/files?organisationId=${ORG}&file=exports/sales.csv`, { cookie: outsiderCookie }), noContext);
    expect(asOutsider.status).toBe(404);
  });

  let sourceId = "";

  it("sets up a source and loads it with money as exact decimals (decisions 356, 357)", async () => {
    const created = await body(
      await sourcesRoute.POST(
        apiRequest("/api/analytics/sources", {
          method: "POST",
          cookie: ownerCookie,
          body: { organisationId: ORG, name: "Sales export", tableName: "sales", fileName: "exports/sales.csv", columns },
        }),
        noContext,
      ),
    );
    expect(created.status).toBe(201);
    sourceId = created.data.source.id;
    expect(created.data.source).toMatchObject({ name: "Sales export", tableName: "sales", reloadDaily: true, lastLoad: null });

    const viewerTry = await loadRoute.POST(
      apiRequest(`/api/analytics/sources/${sourceId}/load`, { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }),
      params({ sourceId }),
    );
    expect(viewerTry.status).toBe(403);

    const loaded = await body(
      await loadRoute.POST(
        apiRequest(`/api/analytics/sources/${sourceId}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
        params({ sourceId }),
      ),
    );
    expect(loaded.data.run).toMatchObject({ status: "ok", rowsLoaded: "3", trigger: "manual", requestedByEmail: "owner@example.com", error: null });
    expect(await queryAnalytics(ORG, "select region, sum(quantity * unit_price)::varchar as total from sales group by 1 order by 1")).toEqual([
      { region: "Canterbury", total: "49.975000" },
      { region: "Otago", total: "0.300000" },
    ]);
  });

  it("keeps yesterday's data and records the error when a load fails", async () => {
    writeSales("Order date,Region,Qty,Unit price\n2026-03-01,Otago,1,abc\n");
    const failed = await body(
      await loadRoute.POST(
        apiRequest(`/api/analytics/sources/${sourceId}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
        params({ sourceId }),
      ),
    );
    expect(failed.data.run.status).toBe("failed");
    expect(failed.data.run.error).toMatch(/abc/);
    expect(await queryAnalytics(ORG, "select count(*)::int as n from sales")).toEqual([{ n: 3 }]);

    const overview = await body(await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    expect(overview.data.canManage).toBe(false);
    expect(overview.data.files).toEqual([]);
    expect(overview.data.sources[0].lastLoad.status).toBe("failed");
    expect(overview.data.loads.map((run: { status: string }) => run.status)).toEqual(["failed", "ok"]);
  });

  it("reloads daily sources after 04:00, once a day, retrying a failure an hour later", async () => {
    const at = (time: string) => new Date(`2026-10-05T${time}:00+13:00`);
    expect(loadDue(at("03:59"), [])).toBe(false);
    expect(loadDue(at("04:00"), [])).toBe(true);
    expect(loadDue(at("09:00"), [{ status: "ok", trigger: "manual", startedAt: at("08:00") }])).toBe(false);
    expect(loadDue(at("09:00"), [{ status: "ok", trigger: "manual", startedAt: at("03:00") }])).toBe(true);
    expect(loadDue(at("04:30"), [{ status: "failed", trigger: "schedule", startedAt: at("04:05") }])).toBe(false);
    expect(loadDue(at("05:06"), [{ status: "failed", trigger: "schedule", startedAt: at("04:05") }])).toBe(true);

    writeSales("Order date,Region,Qty,Unit price\n2026-04-01,Waikato,3,10.00\n");
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(18, 0, 0, 0); // 07:00 or 06:00 in New Zealand, after 04:00
    const made = await runDueLoads(tomorrow);
    // The books are copied every night too (step 2, AB8).
    expect(made.map((run) => [run.sourceName, run.status, run.trigger])).toEqual([
      ["Books and CRM", "ok", "schedule"],
      ["Sales export", "ok", "schedule"],
    ]);
    expect(await queryAnalytics(ORG, "select region, (quantity * unit_price)::varchar as total from sales")).toEqual([{ region: "Waikato", total: "30.000000" }]);
    // The load is stamped with the real time; move it to "tomorrow" like the run it stands for.
    await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) =>
      tx.query("update analytics_load_runs set started_at = $1 where id = any($2::bigint[])", [tomorrow, made.map((run) => run.id)]),
    );
    expect(await runDueLoads(tomorrow)).toEqual([]);
  });

  it("removes a source and its table, keeping the load history", async () => {
    const removed = await sourceRoute.DELETE(
      apiRequest(`/api/analytics/sources/${sourceId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }),
      params({ sourceId }),
    );
    expect(removed.status).toBe(200);
    expect(await queryAnalytics(ORG, "select count(*)::int as n from information_schema.tables where table_name = 'sales'")).toEqual([{ n: 0 }]);
    const overview = await body(await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(overview.data.sources).toEqual([]);
    expect(overview.data.loads).toHaveLength(4);
  });

  it("gives another organisation nothing from this one's folder or data", async () => {
    const other = await body(await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${OTHER}`, { cookie: ownerCookie }), noContext));
    expect(other.data.folder).toEqual({ chosen: false, readable: false });
    expect(other.data.files).toEqual([]);
  });

  it("lets DuckDB read only this organisation's own folder, and that can't be switched off (decision 377)", async () => {
    // Inside the source folder is fine; root's secret.csv sits outside it.
    expect(await queryAnalytics(ORG, `select count(*)::int as n from read_csv('${path.join(folder, "exports", "sales.csv").replaceAll("'", "''")}')`)).toEqual([{ n: expect.any(Number) }]);
    await expect(queryAnalytics(ORG, `select * from read_csv('${path.join(root, "secret.csv").replaceAll("'", "''")}')`)).rejects.toThrow(/Permission Error|Cannot access/);
    await expect(queryAnalytics(ORG, "select * from read_text('/etc/hostname')")).rejects.toThrow(/Permission Error|Cannot access/);
    await expect(queryAnalytics(ORG, "set enable_external_access = true")).rejects.toThrow(/Cannot change configuration/);
    await expect(queryAnalytics(ORG, "install httpfs")).rejects.toThrow();
    // Another organisation has no folder, so it can read none.
    await expect(queryAnalytics(OTHER, `select * from read_csv('${path.join(folder, "exports", "sales.csv").replaceAll("'", "''")}')`)).rejects.toThrow(/Permission Error|Cannot access/);
    await closeAnalytics(OTHER);
  });
});

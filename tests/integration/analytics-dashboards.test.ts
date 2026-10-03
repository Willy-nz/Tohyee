import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as tablesRoute from "@/app/api/analytics/tables/route";
import * as valuesRoute from "@/app/api/analytics/values/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "dash-co";
const noContext = undefined as unknown;

/** Analytics step 3: dashboards over loaded tables. */
describeWithDatabase("analytics dashboards", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let root: string;

  const body = async (response: Response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field
    data: (await response.json()) as Record<string, any>,
  });

  const tile = {
    id: "monthly",
    title: "Sales by month",
    visual: "column",
    width: "full",
    query: {
      table: "sales",
      groupBy: { field: "order_date", grain: "month" },
      measures: [{ label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price", compare: "previous_year" }],
      filters: [],
      sort: { by: "category", direction: "asc" },
    },
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-dash-it-"));
    const folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, "sales.csv"),
      "Date,Region,Qty,Price\n2025-03-02,Otago,1,10.00\n2026-03-05,Otago,2,10.00\n2026-03-09,Canterbury,1,0.10\n2026-04-01,Otago,1,0.20\n",
    );
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
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
    await foldersRoute.PUT(apiRequest("/api/admin/analytics-folders", { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, folder } }), noContext);
    const source = await body(
      await sourcesRoute.POST(
        apiRequest("/api/analytics/sources", {
          method: "POST",
          cookie: ownerCookie,
          body: {
            organisationId: ORG,
            name: "Sales",
            tableName: "sales",
            fileName: "sales.csv",
            columns: [
              { source: "Date", name: "order_date", kind: "date" },
              { source: "Region", name: "region", kind: "text" },
              { source: "Qty", name: "quantity", kind: "quantity" },
              { source: "Price", name: "unit_price", kind: "money" },
            ],
          },
        }),
        noContext,
      ),
    );
    const id = source.data.source.id;
    await loadRoute.POST(apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId: id }));
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  let dashboardId = "";

  it("lists the loaded tables and their columns", async () => {
    const tables = await body(await tablesRoute.GET(apiRequest(`/api/analytics/tables?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    expect(tables.data.tables).toEqual([
      {
        name: "sales",
        columns: [
          { name: "order_date", type: "DATE" },
          { name: "region", type: "VARCHAR" },
          { name: "quantity", type: "DECIMAL(18,4)" },
          { name: "unit_price", type: "DECIMAL(18,2)" },
        ],
      },
    ]);
  });

  it("makes and saves a dashboard (bookkeepers and up), checked against the table", async () => {
    const refused = await dashboardsRoute.POST(
      apiRequest("/api/analytics/dashboards", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG, name: "Mine" } }),
      noContext,
    );
    expect(refused.status).toBe(403);
    const bad = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", {
          method: "POST",
          cookie: ownerCookie,
          body: { organisationId: ORG, name: "Bad", tiles: [{ ...tile, query: { ...tile.query, table: "nope" } }] },
        }),
        noContext,
      ),
    );
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/Sales by month: There's no loaded table called nope/);

    const made = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", {
          method: "POST",
          cookie: ownerCookie,
          body: {
            organisationId: ORG,
            name: "Sales",
            settings: { from: "2026-01-01", to: "2026-12-31", slicers: [{ table: "sales", field: "region", label: "Region" }] },
            tiles: [tile],
          },
        }),
        noContext,
      ),
    );
    expect(made.status).toBe(201);
    dashboardId = made.data.dashboard.id;
    expect(made.data.dashboard.settings).toEqual({ from: "2026-01-01", to: "2026-12-31", slicers: [{ table: "sales", field: "region", label: "Region" }] });
    expect(made.data.dashboard.tiles[0]).toMatchObject({ id: "monthly", visual: "column", width: "full" });

    const renamed = await body(
      await dashboardRoute.PATCH(
        apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, name: "Monthly sales" } }),
        params({ dashboardId }),
      ),
    );
    expect(renamed.data.dashboard.name).toBe("Monthly sales");
    expect(renamed.data.dashboard.tiles).toHaveLength(1);
    const listed = await body(await dashboardsRoute.GET(apiRequest(`/api/analytics/dashboards?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    expect(listed.data.dashboards.map((entry: { name: string }) => entry.name)).toEqual(["Monthly sales"]);
  });

  it("answers a tile for anyone who can see the organisation, with the dashboard's dates and slicers", async () => {
    const answer = await body(
      await queryRoute.POST(
        apiRequest("/api/analytics/query", {
          method: "POST",
          cookie: viewerCookie,
          body: { organisationId: ORG, query: tile.query, filters: { from: "2026-01-01", to: "2026-12-31" } },
        }),
        noContext,
      ),
    );
    expect(answer.data.rows).toEqual([
      { category: "2026-03-01", m0: "20.100000", m0_py: "10.000000" },
      { category: "2026-04-01", m0: "0.200000", m0_py: null },
    ]);
    const sliced = await body(
      await queryRoute.POST(
        apiRequest("/api/analytics/query", {
          method: "POST",
          cookie: viewerCookie,
          body: { organisationId: ORG, query: tile.query, filters: { from: "2026-01-01", to: "2026-12-31", values: { region: ["Canterbury"] } } },
        }),
        noContext,
      ),
    );
    expect(sliced.data.rows).toEqual([{ category: "2026-03-01", m0: "0.100000", m0_py: null }]);
    const values = await body(
      await valuesRoute.GET(apiRequest(`/api/analytics/values?organisationId=${ORG}&table=sales&field=region`, { cookie: viewerCookie }), noContext),
    );
    expect(values.data.values).toEqual(["Canterbury", "Otago"]);
  });

  it("deletes a dashboard without touching the data", async () => {
    const deleted = await dashboardRoute.DELETE(
      apiRequest(`/api/analytics/dashboards/${dashboardId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }),
      params({ dashboardId }),
    );
    expect(deleted.status).toBe(200);
    const tables = await body(await tablesRoute.GET(apiRequest(`/api/analytics/tables?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(tables.data.tables).toHaveLength(1);
  });
});

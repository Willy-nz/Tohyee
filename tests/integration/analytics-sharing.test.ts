import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as analyticsRoute from "@/app/api/analytics/route";
import * as booksRoute from "@/app/api/analytics/books/route";
import * as dashboardPreferencesRoute from "@/app/api/dashboard-preferences/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as sharesRoute from "@/app/api/analytics/dashboards/[dashboardId]/shares/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as tablesRoute from "@/app/api/analytics/tables/route";
import * as valuesRoute from "@/app/api/analytics/values/route";
import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
import * as reportExportRoute from "@/app/api/reports/export/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics } from "@/lib/analytics/engine";
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

const ORG = "share-co";
const noContext = undefined as unknown;

/** Analytics client sharing (decision 368): report viewers see only what's shared with them. */
describeWithDatabase("analytics dashboard sharing", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let client: SessionUser;
  let ownerCookie: string;
  let clientCookie: string;
  let root: string;
  let sharedId = "";
  let privateId = "";

  const body = async (response: Response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field
    data: (await response.json()) as Record<string, any>,
  });

  const tile = (id: string) => ({
    id,
    title: "Sales by region",
    visual: "bar",
    width: "full",
    query: {
      table: "sales",
      groupBy: { field: "region" },
      measures: [{ label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price" }],
      filters: [],
      sort: { by: "category", direction: "asc" },
    },
  });
  const pivotTile = {
    id: "pivot",
    title: "Sales by region and channel",
    visual: "pivot",
    width: "full",
    query: {
      table: "sales",
      pivot: { rows: [{ field: "region" }], column: { field: "channel" } },
      measures: [{ label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price" }],
      filters: [],
      dateField: "order_date",
      sort: { by: "category", direction: "asc" },
      limit: null,
    },
  };

  const makeDashboard = async (name: string, slicers: unknown[]) => {
    const made = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", {
          method: "POST",
          cookie: ownerCookie,
          body: { organisationId: ORG, name, settings: { slicers }, tiles: [tile("regions"), pivotTile] },
        }),
        noContext,
      ),
    );
    expect(made.status).toBe(201);
    return String(made.data.dashboard.id);
  };

  const share = (dashboardId: string, userIds: string[], cookie = ownerCookie) =>
    sharesRoute.PUT(
      apiRequest(`/api/analytics/dashboards/${dashboardId}/shares`, { method: "PUT", cookie, body: { organisationId: ORG, userIds } }),
      params({ dashboardId }),
    );

  const runTile = (cookie: string, payload: Record<string, unknown>) =>
    queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie, body: { organisationId: ORG, ...payload } }), noContext);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-share-it-"));
    const folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, "sales.csv"),
      "Date,Region,Channel,Qty,Price,Private note\n2026-03-05,Otago,Web,2,10.00,private web\n2026-03-09,Canterbury,Shop,1,0.10,private shop\n2026-04-01,Otago,Shop,1,0.20,private retail\n",
    );
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    viewer = await createTestUser("viewer@example.com");
    client = await createTestUser("client@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    clientCookie = await sessionCookieFor(client);

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
              { source: "Channel", name: "channel", kind: "text" },
              { source: "Qty", name: "quantity", kind: "quantity" },
              { source: "Price", name: "unit_price", kind: "money" },
              { source: "Private note", name: "private_note", kind: "text" },
            ],
          },
        }),
        noContext,
      ),
    );
    const id = source.data.source.id;
    await loadRoute.POST(apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId: id }));

    sharedId = await makeDashboard("For the client", [{ table: "sales", field: "region", label: "Region" }]);
    privateId = await makeDashboard("Internal", [{ table: "sales", field: "channel", label: "Channel" }]);
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("adds a client as a report viewer from the members page", async () => {
    const added = await body(
      await membersRoute.POST(
        apiRequest(`/api/organisations/${ORG}/members`, { method: "POST", cookie: ownerCookie, body: { email: "client@example.com", role: "report_viewer" } }),
        params({ organisationId: ORG }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.data.member.role).toBe("report_viewer");
  });

  it("shares a dashboard only with report viewers, bookkeepers and up", async () => {
    const viewerCookie = await sessionCookieFor(viewer);
    expect((await share(sharedId, [client.id], viewerCookie)).status).toBe(403);
    const stranger = await body(await share(sharedId, [viewer.id]));
    expect(stranger.status).toBe(400);
    expect(stranger.data.error).toMatch(/only be shared with this organisation's report viewers/);

    const shared = await body(await share(sharedId, [client.id]));
    expect(shared.status).toBe(200);
    expect(shared.data.shares).toEqual([client.id]);
    expect(shared.data.reportViewers.map((person: { email: string }) => person.email)).toEqual(["client@example.com"]);

    const listed = await body(
      await sharesRoute.GET(apiRequest(`/api/analytics/dashboards/${sharedId}/shares?organisationId=${ORG}`, { cookie: ownerCookie }), params({ dashboardId: sharedId })),
    );
    expect(listed.data.shares).toEqual([client.id]);
    const audit = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) =>
      tx.query<{ details: { sharedWith: number } }>("select details from audit_events where event_type = 'analytics.dashboard_shared'"),
    );
    expect(audit.rows.map((row) => row.details.sharedWith)).toEqual([1]);
  });

  it("lists and opens only the dashboards shared with the report viewer", async () => {
    const listed = await body(await dashboardsRoute.GET(apiRequest(`/api/analytics/dashboards?organisationId=${ORG}`, { cookie: clientCookie }), noContext));
    expect(listed.status).toBe(200);
    expect(listed.data.dashboards.map((entry: { name: string }) => entry.name)).toEqual(["For the client"]);

    const opened = await dashboardRoute.GET(apiRequest(`/api/analytics/dashboards/${sharedId}?organisationId=${ORG}`, { cookie: clientCookie }), params({ dashboardId: sharedId }));
    expect(opened.status).toBe(200);
    const hidden = await dashboardRoute.GET(
      apiRequest(`/api/analytics/dashboards/${privateId}?organisationId=${ORG}`, { cookie: clientCookie }),
      params({ dashboardId: privateId }),
    );
    expect(hidden.status).toBe(404);

    const ownerList = await body(await dashboardsRoute.GET(apiRequest(`/api/analytics/dashboards?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(ownerList.data.dashboards).toHaveLength(2);
  });

  it("runs only saved tiles, sliced only by the dashboard's own slicers", async () => {
    const answer = await body(await runTile(clientCookie, { dashboardId: sharedId, tileId: "regions" }));
    expect(answer.status).toBe(200);
    expect(answer.data.rows).toEqual([
      { category: "Canterbury", m0: "0.100000" },
      { category: "Otago", m0: "20.200000" },
    ]);

    const sliced = await body(await runTile(clientCookie, { dashboardId: sharedId, tileId: "regions", filters: { values: { region: ["Otago"] } } }));
    expect(sliced.data.rows).toEqual([{ category: "Otago", m0: "20.200000" }]);
    // channel isn't a slicer on this dashboard, so it's dropped rather than used to probe the data
    const probing = await body(await runTile(clientCookie, { dashboardId: sharedId, tileId: "regions", filters: { values: { channel: ["Web"] } } }));
    expect(probing.data.rows).toEqual(answer.data.rows);

    const pivot = await body(await runTile(clientCookie, { dashboardId: sharedId, tileId: "pivot" }));
    expect(pivot.status).toBe(200);
    expect(pivot.data.pivot.columns.map((column: { key: string }) => column.key)).toEqual(["c0_m0", "c1_m0", "total_m0"]);
    const otago = pivot.data.pivot.rows.find((row: { kind: string; dimensions: string[] }) => row.kind === "detail" && row.dimensions[0] === "Otago");
    expect(otago.cells).toEqual({ c0_m0: "0.200000", c1_m0: "20.000000", total_m0: "20.200000" });
    const drilled = await body(
      await runTile(clientCookie, {
        dashboardId: sharedId,
        tileId: "pivot",
        drill: { depth: 1, dimensions: ["Otago"], pivotValue: "Web", total: false },
      }),
    );
    expect(drilled.data.rows).toEqual([{ d0: "Otago", d1: "Web", d2: "2.0000", d3: "10.00", d4: "2026-03-05" }]);
    expect(drilled.data.columns.map((column: { label: string }) => column.label)).not.toContain("private_note");
    expect(drilled.data.rows[0]).not.toHaveProperty("d5");

    // The dashboard's own slicer narrows the pivot and its drill-down; any other field is dropped.
    const slicedPivot = await body(await runTile(clientCookie, { dashboardId: sharedId, tileId: "pivot", filters: { values: { region: ["Canterbury"] } } }));
    expect(slicedPivot.data.pivot.rows.map((row: { kind: string; dimensions: string[] }) => [row.kind, row.dimensions[0]])).toEqual([
      ["detail", "Canterbury"],
      ["grand_total", null],
    ]);
    const probingPivot = await body(
      await runTile(clientCookie, { dashboardId: sharedId, tileId: "pivot", filters: { values: { channel: ["Web"] } }, drill: { depth: 0, dimensions: [null], pivotValue: null, total: true } }),
    );
    expect(probingPivot.data.rows).toHaveLength(3);
    const slicedDrill = await body(
      await runTile(clientCookie, { dashboardId: sharedId, tileId: "pivot", filters: { values: { region: ["Canterbury"] } }, drill: { depth: 0, dimensions: [null], pivotValue: null, total: true } }),
    );
    expect(slicedDrill.data.rows.map((row: Record<string, string>) => row.d0)).toEqual(["Canterbury"]);
    // A drill-down is only for a saved, shared pivot tile.
    const drillAll = { depth: 0, dimensions: [null], pivotValue: null, total: true };
    expect((await runTile(clientCookie, { query: pivotTile.query, drill: drillAll })).status).toBe(403);
    expect((await runTile(clientCookie, { dashboardId: privateId, tileId: "pivot", drill: drillAll })).status).toBe(404);
    expect((await runTile(clientCookie, { dashboardId: sharedId, tileId: "regions", drill: drillAll })).status).toBe(400);
    expect((await runTile(clientCookie, { dashboardId: sharedId, tileId: "pivot", drill: { ...drillAll, dimensions: [] } })).status).toBe(400);

    const raw = await runTile(clientCookie, { query: tile("regions").query });
    expect(raw.status).toBe(403);
    expect((await runTile(clientCookie, { dashboardId: privateId, tileId: "regions" })).status).toBe(404);
    expect((await runTile(clientCookie, { dashboardId: sharedId, tileId: "nope" })).status).toBe(404);
  });

  it("lets a report viewer export a pivot as CSV or Excel, but nothing else", async () => {
    const pivotData = (report: string) => ({
      report,
      organisationName: "Share Co",
      title: "Sales by region and channel",
      period: "All dates",
      basis: null,
      filters: [],
      producedAt: "2026-10-04T00:00:00.000Z",
      tables: [
        {
          columns: ["Region", "Grand total · Sales"],
          rows: [
            { cells: [{ text: "Otago" }, { text: "$0.30", value: "0.30", numeric: true }] },
            { kind: "total", cells: [{ text: "Grand total" }, { text: "$1,000,000,000,000,000.90", value: "1000000000000000.90", numeric: true }] },
          ],
        },
      ],
    });
    const exportAs = (format: string, report = "analytics-pivot", organisationId = ORG) =>
      reportExportRoute.POST(
        apiRequest("/api/reports/export", { method: "POST", cookie: clientCookie, body: { organisationId, format, data: pivotData(report) } }),
        noContext,
      );
    const csv = await exportAs("csv");
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain("Otago,0.30");
    expect(text).toContain("Grand total,1000000000000000.90");
    expect((await exportAs("xlsx")).status).toBe(200);
    expect((await exportAs("pdf")).status).toBe(400);
    expect((await exportAs("csv", "profit-and-loss")).status).toBe(403);
    expect((await exportAs("csv", "analytics-pivot", "share-other")).status).toBeGreaterThanOrEqual(403);
  });

  it("keeps a report viewer to their own organisation's dashboards", async () => {
    await createTestOrganisation(owner, "share-other");
    const other = await queryRoute.POST(
      apiRequest("/api/analytics/query", { method: "POST", cookie: clientCookie, body: { organisationId: "share-other", dashboardId: sharedId, tileId: "pivot" } }),
      noContext,
    );
    expect([403, 404]).toContain(other.status);
  });

  it("lets a report viewer pin only a shared dashboard tile", async () => {
    const sharedReference = `analytics:${sharedId}:regions`;
    const preference = await body(
      await dashboardPreferencesRoute.GET(
        apiRequest(`/api/dashboard-preferences?organisationId=${ORG}&page=home`, { cookie: clientCookie }),
        noContext,
      ),
    );
    expect(preference.status).toBe(200);
    expect(preference.data.tiles).toEqual(["cash_in_bank", "owed_to_you", "bills_to_pay", "next_gst_return"]);

    const saved = await body(
      await dashboardPreferencesRoute.PUT(
        apiRequest("/api/dashboard-preferences", {
          method: "PUT",
          cookie: clientCookie,
          body: { organisationId: ORG, page: "home", hidden: false, tiles: ["cash_in_bank", "owed_to_you", "bills_to_pay", sharedReference] },
        }),
        noContext,
      ),
    );
    expect(saved.status).toBe(200);
    expect(saved.data.tiles).toContain(sharedReference);

    const privatePin = await body(
      await dashboardPreferencesRoute.PUT(
        apiRequest("/api/dashboard-preferences", {
          method: "PUT",
          cookie: clientCookie,
          body: { organisationId: ORG, page: "home", hidden: false, tiles: [sharedReference, `analytics:${privateId}:regions`] },
        }),
        noContext,
      ),
    );
    expect(privatePin.status).toBe(404);
  });

  it("offers slicer values only for a shared dashboard's slicers", async () => {
    const values = (query: string) => valuesRoute.GET(apiRequest(`/api/analytics/values?organisationId=${ORG}&${query}`, { cookie: clientCookie }), noContext);
    const regions = await body(await values(`table=sales&field=region&dashboardId=${sharedId}`));
    expect(regions.data.values).toEqual(["Canterbury", "Otago"]);
    expect((await values(`table=sales&field=channel&dashboardId=${sharedId}`)).status).toBe(403);
    expect((await values("table=sales&field=region")).status).toBe(404);
    expect((await values(`table=sales&field=channel&dashboardId=${privateId}`)).status).toBe(404);
  });

  it("keeps report viewers out of the tables, the sources and the books", async () => {
    const tables = await tablesRoute.GET(apiRequest(`/api/analytics/tables?organisationId=${ORG}`, { cookie: clientCookie }), noContext);
    expect(tables.status).toBe(403);
    const summary = await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: clientCookie }), noContext);
    expect(summary.status).toBe(403);
    const sources = await sourcesRoute.GET(apiRequest(`/api/analytics/sources?organisationId=${ORG}`, { cookie: clientCookie }), noContext);
    expect(sources.status).toBe(403);
    const books = await booksRoute.POST(apiRequest("/api/analytics/books", { method: "POST", cookie: clientCookie, body: { organisationId: ORG } }), noContext);
    expect(books.status).toBe(403);
    expect((await share(sharedId, [client.id], clientCookie)).status).toBe(403);
  });

  it("stops showing a dashboard once it's unshared", async () => {
    expect((await body(await share(sharedId, []))).data.shares).toEqual([]);
    const listed = await body(await dashboardsRoute.GET(apiRequest(`/api/analytics/dashboards?organisationId=${ORG}`, { cookie: clientCookie }), noContext));
    expect(listed.data.dashboards).toEqual([]);
    expect((await runTile(clientCookie, { dashboardId: sharedId, tileId: "regions" })).status).toBe(404);
    expect((await runTile(clientCookie, { dashboardId: sharedId, tileId: "pivot", drill: { depth: 0, dimensions: [null], pivotValue: null, total: true } })).status).toBe(404);
  });
});

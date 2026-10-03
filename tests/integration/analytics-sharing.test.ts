import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as analyticsRoute from "@/app/api/analytics/route";
import * as booksRoute from "@/app/api/analytics/books/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as sharesRoute from "@/app/api/analytics/dashboards/[dashboardId]/shares/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as tablesRoute from "@/app/api/analytics/tables/route";
import * as valuesRoute from "@/app/api/analytics/values/route";
import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
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

  const makeDashboard = async (name: string, slicers: unknown[]) => {
    const made = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", {
          method: "POST",
          cookie: ownerCookie,
          body: { organisationId: ORG, name, settings: { slicers }, tiles: [tile("regions")] },
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
      "Date,Region,Channel,Qty,Price\n2026-03-05,Otago,Web,2,10.00\n2026-03-09,Canterbury,Shop,1,0.10\n2026-04-01,Otago,Shop,1,0.20\n",
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

    const raw = await runTile(clientCookie, { query: tile("regions").query });
    expect(raw.status).toBe(403);
    expect((await runTile(clientCookie, { dashboardId: privateId, tileId: "regions" })).status).toBe(404);
    expect((await runTile(clientCookie, { dashboardId: sharedId, tileId: "nope" })).status).toBe(404);
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
  });
});

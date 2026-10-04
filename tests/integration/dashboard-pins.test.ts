import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as sharesRoute from "@/app/api/analytics/dashboards/[dashboardId]/shares/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as preferencesRoute from "@/app/api/dashboard-preferences/route";
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

const ORG = "pin-co";
const OTHER_ORG = "pin-other-co";
const DEFAULTS = ["cash_in_bank", "owed_to_you", "bills_to_pay", "next_gst_return"];
const noContext = undefined as unknown;

/** Pinned Analytics tiles on dashboard pages (decision 374). */
describeWithDatabase("pinned Analytics tiles", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let client: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let clientCookie: string;
  let root: string;
  let sharedId = "";
  let privateId = "";
  let otherOrgDashboardId = "";

  const body = async (response: Response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field
    data: (await response.json()) as Record<string, any>,
  });

  const salesQuery = {
    table: "sales",
    groupBy: null,
    measures: [{ label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price" }],
    filters: [],
    dateField: "order_date",
    sort: { by: "category", direction: "asc" },
  };
  const tiles = [
    { id: "total", title: "Sales", visual: "kpi", width: "half", query: salesQuery },
    { id: "regions", title: "Sales by region", visual: "bar", width: "half", query: { ...salesQuery, groupBy: { field: "region" } } },
  ];

  const makeDashboard = async (organisationId: string, name: string, settings: Record<string, unknown> = {}) => {
    const made = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId, name, settings, tiles } }),
        noContext,
      ),
    );
    expect(made.status).toBe(201);
    return String(made.data.dashboard.id);
  };

  const share = async (dashboardId: string, userIds: string[]) => {
    const response = await sharesRoute.PUT(
      apiRequest(`/api/analytics/dashboards/${dashboardId}/shares`, { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, userIds } }),
      params({ dashboardId }),
    );
    expect(response.status).toBe(200);
  };

  const setAnalytics = async (organisationId: string, analyticsEnabled: boolean) => {
    const response = await settingsRoute.PATCH(
      apiRequest(`/api/organisations/${organisationId}/settings`, { method: "PATCH", cookie: ownerCookie, body: { analyticsEnabled } }),
      params({ organisationId }),
    );
    expect(response.status).toBe(200);
  };

  const getHome = async (cookie: string, organisationId = ORG) =>
    body(await preferencesRoute.GET(apiRequest(`/api/dashboard-preferences?organisationId=${organisationId}&page=home`, { cookie }), noContext));

  const putHome = async (cookie: string, tileIds: unknown, organisationId = ORG) =>
    body(
      await preferencesRoute.PUT(
        apiRequest("/api/dashboard-preferences", { method: "PUT", cookie, body: { organisationId, page: "home", hidden: false, tiles: tileIds } }),
        noContext,
      ),
    );

  const storedTiles = async (user: SessionUser) => {
    const result = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) =>
      tx.query<{ tiles: string[] }>("select tiles from dashboard_preferences where user_id = $1 and page = 'home'", [user.id]),
    );
    return result.rows[0]?.tiles ?? null;
  };

  const ref = (dashboardId: string, tileId: string) => `analytics:${dashboardId}:${tileId}`;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-pins-it-"));
    const folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, "sales.csv"),
      "Date,Region,Qty,Price\n2026-03-05,Otago,2,10.00\n2026-03-09,Canterbury,1,0.10\n2026-04-01,Otago,1,0.20\n",
    );
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("pin-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(owner, OTHER_ORG);
    viewer = await createTestUser("pin-viewer@example.com");
    client = await createTestUser("pin-client@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'report_viewer')", [ORG, client.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    clientCookie = await sessionCookieFor(client);

    for (const organisationId of [ORG, OTHER_ORG]) {
      await setAnalytics(organisationId, true);
      const saved = await foldersRoute.PUT(
        apiRequest("/api/admin/analytics-folders", { method: "PUT", cookie: ownerCookie, body: { organisationId, folder } }),
        noContext,
      );
      expect(saved.status).toBe(200);
      const source = await body(
        await sourcesRoute.POST(
          apiRequest("/api/analytics/sources", {
            method: "POST",
            cookie: ownerCookie,
            body: {
              organisationId,
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
      expect(source.status).toBe(201);
      const id = source.data.source.id;
      const loaded = await loadRoute.POST(
        apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId } }),
        params({ sourceId: id }),
      );
      expect(loaded.status).toBe(200);
    }

    sharedId = await makeDashboard(ORG, "April", { from: "2026-04-01", to: "2026-04-30" });
    privateId = await makeDashboard(ORG, "Internal");
    await share(sharedId, [client.id]);
    // Another organisation's dashboard, made after ORG's two, so its id isn't one of theirs.
    await makeDashboard(OTHER_ORG, "Theirs 1");
    await makeDashboard(OTHER_ORG, "Theirs 2");
    otherOrgDashboardId = await makeDashboard(OTHER_ORG, "Theirs 3");
    expect([sharedId, privateId]).not.toContain(otherOrgDashboardId);
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await closeAnalytics(OTHER_ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("pins a tile from any dashboard for a viewer, next to the defaults", async () => {
    expect((await getHome(viewerCookie)).data.tiles).toEqual(DEFAULTS);
    const pinned = [DEFAULTS[0], ref(privateId, "regions"), ref(sharedId, "total")];
    const saved = await putHome(viewerCookie, pinned);
    expect(saved.status).toBe(200);
    expect(saved.data.tiles).toEqual(pinned);
    expect((await getHome(viewerCookie)).data.tiles).toEqual(pinned);
    expect(await storedTiles(viewer)).toEqual(pinned);
  });

  it("shows a pinned tile through the dashboard query path with the dashboard's own dates", async () => {
    const opened = await body(
      await dashboardRoute.GET(apiRequest(`/api/analytics/dashboards/${sharedId}?organisationId=${ORG}`, { cookie: clientCookie }), params({ dashboardId: sharedId })),
    );
    expect(opened.status).toBe(200);
    expect(opened.data.dashboard.settings).toMatchObject({ from: "2026-04-01", to: "2026-04-30" });
    const { from, to } = opened.data.dashboard.settings;
    const answer = await body(
      await queryRoute.POST(
        apiRequest("/api/analytics/query", {
          method: "POST",
          cookie: clientCookie,
          body: { organisationId: ORG, dashboardId: sharedId, tileId: "total", filters: { from, to, values: {} } },
        }),
        noContext,
      ),
    );
    expect(answer.status).toBe(200);
    // Only April's sale (1 x 0.20), exactly.
    expect(answer.data.rows).toEqual([{ m0: "0.200000" }]);
  });

  it("lets a report viewer pin only from dashboards shared with them", async () => {
    const saved = await putHome(clientCookie, [ref(sharedId, "total"), ref(sharedId, "regions")]);
    expect(saved.status).toBe(200);
    expect(saved.data.tiles).toEqual([ref(sharedId, "total"), ref(sharedId, "regions")]);

    const refused = await putHome(clientCookie, [ref(sharedId, "total"), ref(privateId, "total")]);
    expect(refused.status).toBe(404);
    // A refused save changes nothing.
    expect(await storedTiles(client)).toEqual([ref(sharedId, "total"), ref(sharedId, "regions")]);
  });

  it("never shows another dashboard when the saved reference is changed behind the page's back", async () => {
    await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) =>
      tx.query("update dashboard_preferences set tiles = $2::jsonb where user_id = $1 and page = 'home'", [
        client.id,
        JSON.stringify([ref(privateId, "total"), ref(sharedId, "total")]),
      ]),
    );
    expect((await getHome(clientCookie)).data.tiles).toEqual([ref(sharedId, "total")]);
    // And the dashboard itself stays hidden from them.
    const hidden = await dashboardRoute.GET(
      apiRequest(`/api/analytics/dashboards/${privateId}?organisationId=${ORG}`, { cookie: clientCookie }),
      params({ dashboardId: privateId }),
    );
    expect(hidden.status).toBe(404);
  });

  it("checks sharing again on every load, so an unshared dashboard's pins drop off", async () => {
    await share(sharedId, []);
    expect((await getHome(clientCookie)).data.tiles).toEqual(DEFAULTS);
    // The saved row is left alone; sharing it again brings the pin back.
    expect(await storedTiles(client)).toContain(ref(sharedId, "total"));
    await share(sharedId, [client.id]);
    expect((await getHome(clientCookie)).data.tiles).toEqual([ref(sharedId, "total")]);
  });

  it("refuses tiles that don't exist, malformed references and other organisations' dashboards", async () => {
    expect((await putHome(viewerCookie, [ref(sharedId, "no-such-tile")])).status).toBe(404);
    expect((await putHome(viewerCookie, [ref("999999", "total")])).status).toBe(404);
    expect((await putHome(viewerCookie, ["analytics:abc:total"])).status).toBe(400);
    expect((await putHome(viewerCookie, ["analytics:1:Bad_Tile"])).status).toBe(400);
    // A dashboard of another organisation means nothing here: not found.
    expect((await putHome(viewerCookie, [ref(otherOrgDashboardId, "total")])).status).toBe(404);
    // And someone who isn't a member there can't save or read anything there at all (it reads as not found).
    expect((await putHome(viewerCookie, [ref(otherOrgDashboardId, "total")], OTHER_ORG)).status).toBe(404);
    expect((await getHome(viewerCookie, OTHER_ORG)).status).toBe(404);
    // A reference is only ever read in the organisation it's saved in: there it names that organisation's own dashboard.
    expect((await putHome(ownerCookie, [ref(otherOrgDashboardId, "total")], OTHER_ORG)).status).toBe(200);
    expect((await getHome(ownerCookie, OTHER_ORG)).data.tiles).toEqual([ref(otherOrgDashboardId, "total")]);
    expect((await getHome(viewerCookie)).data.tiles).toEqual([DEFAULTS[0], ref(privateId, "regions"), ref(sharedId, "total")]);
  });

  it("keeps a page to four tiles", async () => {
    const five = [...DEFAULTS, ref(sharedId, "total")];
    const refused = await putHome(viewerCookie, five);
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/up to 4 tiles/);
    const four = [DEFAULTS[0], DEFAULTS[1], ref(sharedId, "total"), ref(sharedId, "regions")];
    expect((await putHome(viewerCookie, four)).data.tiles).toEqual(four);
  });

  it("quietly drops a pinned tile when its tile or dashboard is deleted", async () => {
    const removedTile = await dashboardRoute.PATCH(
      apiRequest(`/api/analytics/dashboards/${sharedId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, tiles: [tiles[0]] } }),
      params({ dashboardId: sharedId }),
    );
    expect(removedTile.status).toBe(200);
    expect((await getHome(viewerCookie)).data.tiles).toEqual([DEFAULTS[0], DEFAULTS[1], ref(sharedId, "total")]);

    const deleted = await dashboardRoute.DELETE(
      apiRequest(`/api/analytics/dashboards/${sharedId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }),
      params({ dashboardId: sharedId }),
    );
    expect(deleted.status).toBe(200);
    expect((await getHome(viewerCookie)).data.tiles).toEqual([DEFAULTS[0], DEFAULTS[1]]);
    // The report viewer had only pins from it, so they get the defaults back.
    expect((await getHome(clientCookie)).data.tiles).toEqual(DEFAULTS);
  });

  it("hides pinned tiles while Analytics is off, and refuses new pins", async () => {
    const pinned = [ref(privateId, "total"), ref(privateId, "regions")];
    expect((await putHome(viewerCookie, pinned)).status).toBe(200);

    await setAnalytics(ORG, false);
    try {
      expect((await getHome(viewerCookie)).data.tiles).toEqual(DEFAULTS);
      const refused = await putHome(viewerCookie, [DEFAULTS[0], ref(privateId, "total")]);
      expect(refused.status).toBe(409);
      expect(await storedTiles(viewer)).toEqual(pinned);
    } finally {
      await setAnalytics(ORG, true);
    }
    expect((await getHome(viewerCookie)).data.tiles).toEqual(pinned);
  });

  it("keeps hidden pins, in place, when the page is saved while they're hidden", async () => {
    const pinned = [DEFAULTS[0], ref(privateId, "total"), DEFAULTS[1]];
    expect((await putHome(viewerCookie, pinned)).status).toBe(200);

    await setAnalytics(ORG, false);
    try {
      expect((await getHome(viewerCookie)).data.tiles).toEqual([DEFAULTS[0], DEFAULTS[1]]);
      // Customise saved while Analytics is off: only the tiles they can see are sent.
      const saved = await putHome(viewerCookie, [DEFAULTS[0], DEFAULTS[1], DEFAULTS[2]]);
      expect(saved.status).toBe(200);
      expect(saved.data.tiles).toEqual([DEFAULTS[0], DEFAULTS[1], DEFAULTS[2]]);
      expect((await getHome(viewerCookie)).data.tiles).toEqual([DEFAULTS[0], DEFAULTS[1], DEFAULTS[2]]);
    } finally {
      await setAnalytics(ORG, true);
    }
    // Back where it was.
    expect((await getHome(viewerCookie)).data.tiles).toEqual([DEFAULTS[0], ref(privateId, "total"), DEFAULTS[1], DEFAULTS[2]]);

    // A pin they removed themselves while it showed stays removed.
    expect((await putHome(viewerCookie, [DEFAULTS[0], DEFAULTS[1]])).status).toBe(200);
    expect(await storedTiles(viewer)).toEqual([DEFAULTS[0], DEFAULTS[1]]);
  });
});

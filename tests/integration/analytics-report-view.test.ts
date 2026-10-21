import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as sharesRoute from "@/app/api/analytics/dashboards/[dashboardId]/shares/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "view-co";
const noContext = undefined as unknown;

/** Report pages, interactions, slicers and bookmarks (#376 phase 3, decisions 753-760), with what a report viewer may do. */
describeWithDatabase("analytics report pages and interactions", () => {
  let server: TestServer;
  let owner: SessionUser;
  let client: SessionUser;
  let ownerCookie: string;
  let clientCookie: string;
  let root: string;

  const body = async (response: Response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field
    data: (await response.json()) as Record<string, any>,
  });

  const query = (groupBy: unknown, extra: Record<string, unknown> = {}) => ({
    table: "sales",
    groupBy,
    measures: [{ label: "Sales", aggregate: "sum", field: "amount" }],
    filters: [],
    dateField: "sold_on",
    sort: { by: "category", direction: "asc" },
    limit: null,
    ...extra,
  });

  const create = async (payload: Record<string, unknown>) =>
    body(await dashboardsRoute.POST(apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Sales", ...payload } }), noContext));

  const read = async (id: string, cookie = ownerCookie) =>
    body(await dashboardRoute.GET(apiRequest(`/api/analytics/dashboards/${id}?organisationId=${ORG}`, { cookie }), params({ dashboardId: id })));


  const run = async (cookie: string, payload: Record<string, unknown>) =>
    body(await queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie, body: { organisationId: ORG, ...payload } }), noContext));

  const share = (id: string) =>
    sharesRoute.PUT(apiRequest(`/api/analytics/dashboards/${id}/shares`, { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, userIds: [client.id] } }), params({ dashboardId: id }));

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-view-it-"));
    const folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, "sales.csv"),
      "Sold,Region,Town,Product,Amount,Note\n2026-05-31,Otago,Dunedin,Milk,10.00,shared\n2026-06-01,Otago,Queenstown,Milk,20.00,shared\n2026-08-31,Canterbury,Timaru,Cream,5.50,private canterbury\n2026-12-01,Otago,Dunedin,Cream,1.25,shared\n",
    );
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    client = await createTestUser("client@example.com");
    ownerCookie = await sessionCookieFor(owner);
    clientCookie = await sessionCookieFor(client);
    await settingsRoute.PATCH(apiRequest(`/api/organisations/${ORG}/settings`, { method: "PATCH", cookie: ownerCookie, body: { analyticsEnabled: true, financialYearEndMonth: 5 } }), params({ organisationId: ORG }));
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
              { source: "Sold", name: "sold_on", kind: "date" },
              { source: "Region", name: "region", kind: "text" },
              { source: "Town", name: "town", kind: "text" },
              { source: "Product", name: "product", kind: "text" },
              { source: "Amount", name: "amount", kind: "money" },
              { source: "Note", name: "note", kind: "text" },
            ],
          },
        }),
        noContext,
      ),
    );
    const id = source.data.source.id;
    await loadRoute.POST(apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId: id }));
    await membersRoute.POST(apiRequest(`/api/organisations/${ORG}/members`, { method: "POST", cookie: ownerCookie, body: { email: "client@example.com", role: "report_viewer" } }), params({ organisationId: ORG }));
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("saves pages, keeps each tile on its page and leaves reports without pages as they were (decision 753)", async () => {
    const plain = await create({ tiles: [{ id: "t1", title: "Total", visual: "kpi", width: "quarter", query: query(null) }] });
    expect(plain.status).toBe(201);
    expect(plain.data.dashboard.settings.pages).toBeUndefined();
    expect(plain.data.dashboard.tiles[0].page).toBeUndefined();

    const paged = await create({
      settings: { slicers: [], pages: [{ id: "summary", name: "Summary" }, { id: "detail", name: "Detail", width: "narrow", background: "tinted", hidden: true }] },
      tiles: [
        { id: "t1", title: "Total", visual: "kpi", width: "quarter", query: query(null), page: "summary" },
        { id: "t2", title: "By region", visual: "bar", width: "half", query: query({ field: "region" }), page: "detail" },
        { id: "t3", title: "Lost", visual: "bar", width: "half", query: query({ field: "region" }), page: "nowhere" },
      ],
    });
    expect(paged.status).toBe(201);
    const saved = (await read(paged.data.dashboard.id)).data.dashboard;
    expect(saved.settings.pages).toEqual([{ id: "summary", name: "Summary" }, { id: "detail", name: "Detail", width: "narrow", background: "tinted", hidden: true }]);
    // The first page's tiles, and tiles naming a page the report hasn't got, are saved without one.
    expect(saved.tiles.map((tile: { id: string; page?: string }) => [tile.id, tile.page ?? null])).toEqual([["t1", null], ["t2", "detail"], ["t3", null]]);

    // A report viewer it's shared with gets the same pages and tiles.
    await share(paged.data.dashboard.id);
    const seen = (await read(paged.data.dashboard.id, clientCookie)).data.dashboard;
    expect(seen.settings.pages).toEqual(saved.settings.pages);
    expect(seen.tiles.map((tile: { page?: string }) => tile.page ?? null)).toEqual([null, "detail", null]);

    const bad = await create({ settings: { slicers: [], pages: [{ id: "a", name: "" }] }, tiles: [] });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/give it a name/);
  });

  it("drills, filters by clicks and drills through without widening what a report viewer sees (decisions 754-756)", async () => {
    const shared = { field: "note", op: "eq", value: "shared" };
    const made = await create({
      settings: { slicers: [], pages: [{ id: "summary", name: "Summary" }, { id: "detail", name: "Detail", hidden: true, drillThrough: true }] },
      tiles: [
        // Only the shared rows: Canterbury's private row is never in this tile.
        { id: "regions", title: "By region", visual: "bar", width: "half", query: query({ field: "region" }, { filters: [shared] }), drill: { levels: [{ field: "region" }, { field: "town" }] }, interactions: { total: "none", ghost: "highlight" } },
        { id: "years", title: "By year", visual: "column", width: "half", query: query({ field: "sold_on", grain: "fyear" }), drill: { levels: [{ field: "sold_on", grain: "fyear" }, { field: "sold_on", grain: "fquarter" }, { field: "sold_on", grain: "month" }, { field: "sold_on", grain: "day" }] } },
        { id: "total", title: "Total", visual: "kpi", width: "quarter", query: query(null) },
        { id: "products", title: "Products", visual: "table", width: "half", query: query({ field: "product" }, { filters: [shared] }), page: "detail" },
      ],
    });
    expect(made.status).toBe(201);
    const id = made.data.dashboard.id;
    const saved = (await read(id)).data.dashboard;
    // Interactions naming a tile that isn't on the report are dropped; the default (filter) isn't stored.
    expect(saved.tiles[0].interactions).toEqual({ total: "none" });
    expect(saved.tiles[1].drill.levels).toHaveLength(4);
    expect((await share(id)).status).toBe(200);

    // Financial years by the 31 May balance date: FY2026 (to 31 May 2026) and FY2027.
    const years = await run(clientCookie, { dashboardId: id, tileId: "years" });
    expect(years.data.rows.map((row: Record<string, string>) => [row.category, row.m0])).toEqual([
      ["2025-06-01", "10.00"],
      ["2026-06-01", "26.75"],
    ]);
    expect(years.data.columns[0].grain).toBe("fyear");
    // Drilled into FY2027: its quarters.
    const quarters = await run(clientCookie, { dashboardId: id, tileId: "years", view: { drill: { level: 1, path: ["2026-06-01"] } } });
    expect(quarters.data.rows.map((row: Record<string, string>) => [row.category, row.m0])).toEqual([
      ["2026-06-01", "25.50"],
      ["2026-12-01", "1.25"],
    ]);

    // A click on Otago (By region) filters By year.
    const otagoYears = await run(clientCookie, { dashboardId: id, tileId: "years", view: { selections: [{ tileId: "regions", value: "Otago" }] } });
    expect(otagoYears.data.rows.map((row: Record<string, string>) => row.m0)).toEqual(["10.00", "21.25"]);
    // The field comes from the saved tile, never the request: asking to filter by the private note instead is ignored.
    const sneaky = await run(clientCookie, { dashboardId: id, tileId: "years", view: { selections: [{ tileId: "regions", value: "Otago", field: "note" }] } });
    expect(sneaky.data.rows).toEqual(otagoYears.data.rows);
    // Filters can't be sent as the view's own (they're the server's), and a made-up tile or drill level is refused.
    const injected = await run(clientCookie, { dashboardId: id, tileId: "years", filters: { view: [{ field: "note", op: "eq", value: "private canterbury" }] }, view: { where: [{ field: "note", op: "eq", value: "x" }] } });
    expect(injected.data.rows).toEqual(years.data.rows);
    expect((await run(clientCookie, { dashboardId: id, tileId: "years", view: { selections: [{ tileId: "elsewhere", value: "x" }] } })).status).toBe(400);
    expect((await run(clientCookie, { dashboardId: id, tileId: "total", view: { drill: { level: 1, path: ["x"] } } })).status).toBe(400);
    expect((await run(clientCookie, { dashboardId: id, tileId: "regions", view: { drill: { level: 2, path: ["a", "b"] } } })).status).toBe(400);

    // Drilling into Canterbury on By region can't bring back the private row the tile leaves out.
    const canterbury = await run(clientCookie, { dashboardId: id, tileId: "regions", view: { drill: { level: 1, path: ["Canterbury"] } } });
    expect(canterbury.status).toBe(200);
    expect(canterbury.data.rows).toEqual([]);
    const otagoTowns = await run(clientCookie, { dashboardId: id, tileId: "regions", view: { drill: { level: 1, path: ["Otago"] } } });
    expect(otagoTowns.data.rows.map((row: Record<string, string>) => [row.category, row.m0])).toEqual([
      ["Dunedin", "11.25"],
      ["Queenstown", "20.00"],
    ]);

    // Drill-through to Detail with FY2027 from By year: Products shows only FY2027's shared rows.
    const through = await run(clientCookie, { dashboardId: id, tileId: "products", view: { through: [{ tileId: "years", value: "2026-06-01" }] } });
    expect(through.data.rows.map((row: Record<string, string>) => [row.category, row.m0])).toEqual([
      ["Cream", "1.25"],
      ["Milk", "20.00"],
    ]);
    // A report that isn't shared can't be used as a way in.
    const other = await create({ tiles: [{ id: "x", title: "X", visual: "bar", width: "half", query: query({ field: "note" }) }] });
    expect((await run(clientCookie, { dashboardId: other.data.dashboard.id, tileId: "x", view: { selections: [{ tileId: "x", value: "a" }] } })).status).toBe(404);
  });
});

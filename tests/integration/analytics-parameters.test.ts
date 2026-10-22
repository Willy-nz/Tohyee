import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as sharesRoute from "@/app/api/analytics/dashboards/[dashboardId]/shares/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "params-co";
const noContext = undefined as unknown;

/** What-if parameters and tile switches (decision 773): saved per report, checked on the server, never broadening a reader's view. */
describeWithDatabase("analytics parameters and switches", () => {
  let server: TestServer;
  let owner: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let clientCookie: string;
  let root: string;
  const body = async (response: Response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field
    data: (await response.json()) as Record<string, any>,
  });
  let clientId = "";
  const ask = (cookie: string, payload: Record<string, unknown>) =>
    queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie, body: { organisationId: ORG, filters: {}, ...payload } }), noContext);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-params-it-"));
    const folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "sales.csv"), "Date,Region,Amount\n2026-03-31,Otago,25.00\n2026-04-01,Otago,1500.00\n2026-04-02,Canterbury,999.99\n");
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    const viewer = await createTestUser("viewer@example.com");
    const client = await createTestUser("client@example.com");
    clientId = client.id;
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'report_viewer')", [ORG, viewer.id, client.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    clientCookie = await sessionCookieFor(client);
    await settingsRoute.PATCH(apiRequest(`/api/organisations/${ORG}/settings`, { method: "PATCH", cookie: ownerCookie, body: { analyticsEnabled: true } }), params({ organisationId: ORG }));
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
              { source: "Date", name: "sale_date", kind: "date" },
              { source: "Region", name: "region", kind: "text" },
              { source: "Amount", name: "amount", kind: "money" },
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
  const sales = { label: "Sales", aggregate: "sum", field: "amount" };
  const tile = {
    id: "forecast",
    title: "Sales and next year",
    visual: "table",
    width: "full",
    query: {
      table: "sales",
      groupBy: { field: "region" },
      measures: [sales, { label: "Next year", aggregate: "formula", formula: "[Sales] * (1 + @growth)" }],
      filters: [{ field: "region", op: "eq", value: "Otago" }],
      dateField: "sale_date",
      sort: { by: "category", direction: "asc" },
    },
    switches: { values: true, groupings: [{ field: "sale_date", grain: "month" }] },
  };
  const growth = { name: "growth", label: "Growth", min: "0", max: "0.5", step: "0.1", value: "0.1" };
  const save = (settings: Record<string, unknown>) =>
    dashboardsRoute.POST(apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "What if", settings: { from: null, to: null, slicers: [], ...settings }, tiles: [tile] } }), noContext);

  it("saves parameters and switches with the report, checking formulas name its parameters", async () => {
    const missing = await body(await save({}));
    expect(missing.status).toBe(400);
    expect(missing.data.error).toMatch(/uses @growth; add a parameter called growth/);
    const made = await body(await save({ parameters: [growth] }));
    expect(made.status).toBe(201);
    dashboardId = made.data.dashboard.id;
    expect(made.data.dashboard.settings.parameters).toEqual([{ id: "p-growth", ...growth }]);
    expect(made.data.dashboard.tiles[0].switches).toEqual(tile.switches);
    await sharesRoute.PUT(apiRequest(`/api/analytics/dashboards/${dashboardId}/shares`, { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, userIds: [clientId] } }), params({ dashboardId }));
  });

  it("works a shared report's tile out with the reader's slider value and switches", async () => {
    const start = await body(await ask(clientCookie, { dashboardId, tileId: "forecast" }));
    // One value at a time: the first until the reader chooses.
    expect(start.data.rows).toEqual([{ category: "Otago", m0: "1525.00" }]);
    const moved = await body(await ask(clientCookie, { dashboardId, tileId: "forecast", choice: { value: 1 }, filters: { parameters: { growth: "0.3" } } }));
    expect(moved.data.rows[0].m0).toBe("1982.500000");
    const one = await body(await ask(clientCookie, { dashboardId, tileId: "forecast", choice: { value: 1 }, filters: { parameters: { growth: "0.5" } } }));
    expect(one.data.columns.map((column: { label: string }) => column.label)).toEqual(["region", "Next year"]);
    expect(one.data.rows).toEqual([{ category: "Otago", m0: "2287.500000" }]);
    const byMonth = await body(await ask(clientCookie, { dashboardId, tileId: "forecast", choice: { grouping: 1 } }));
    // The tile's own filter (Otago) still applies under another grouping.
    expect(byMonth.data.rows.map((row: { category: string; m0: string }) => [row.category, row.m0])).toEqual([
      ["2026-03-01", "25.00"],
      ["2026-04-01", "1500.00"],
    ]);
  });

  it("can't be used to ask more: off-step values, other choices and typed questions are refused", async () => {
    expect((await body(await ask(clientCookie, { dashboardId, tileId: "forecast", choice: { value: 1 }, filters: { parameters: { growth: "0.25" } } }))).data.error).toMatch(/steps of 0.1/);
    expect((await ask(clientCookie, { dashboardId, tileId: "forecast", choice: { grouping: 2 } })).status).toBe(400);
    expect((await ask(clientCookie, { dashboardId, tileId: "forecast", choice: { value: 5 } })).status).toBe(400);
    // A grouping can't be sent as a field: only positions count.
    const named = await body(await ask(clientCookie, { dashboardId, tileId: "forecast", choice: { field: "amount" } }));
    expect(named.data.rows).toEqual([{ category: "Otago", m0: "1525.00" }]);
    expect((await ask(clientCookie, { query: tile.query, filters: { parameters: { growth: "0.1" } } })).status).toBe(403);
    // Viewers and up can ask any question anyway (a chart being built), so any number works there.
    const draft = await body(await ask(viewerCookie, { query: tile.query, filters: { parameters: { growth: "0.25" } } }));
    expect(draft.data.rows[0].m1).toBe("1906.250000");
  });
});

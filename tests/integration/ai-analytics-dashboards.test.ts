import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as historyRoute from "@/app/api/analytics/dashboards/[dashboardId]/history/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ai-analytics";
const OTHER = "ai-analytics-other";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown) {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: rpcParams }),
    }),
    noContext,
  );
  return (await response.json()) as Json;
}

/** A tool's JSON answer, or throws with its error text. */
async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

const SALES_BY_REGION = {
  id: "sales-by-region",
  title: "Sales by region",
  visual: "bar",
  width: "half",
  query: { table: "sales", groupBy: { field: "region" }, measures: [{ label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price" }], sort: { by: "value", direction: "desc" } },
};
const SALES_BY_MONTH = {
  id: "sales-by-month",
  title: "Sales by month",
  visual: "column",
  width: "full",
  query: { table: "sales", groupBy: { field: "order_date", grain: "month" }, measures: [{ label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price" }] },
};
const ORDERS = { title: "Orders", visual: "kpi", width: "quarter", query: { table: "sales", measures: [{ label: "Orders", aggregate: "count" }] } };

/** The AI builds Analytics reports (#591, examples AIA1-AIA8, decisions 1411-1420; not yet reviewed). */
describeWithDatabase("the AI's Analytics reports", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let farmHand: SessionUser;
  let ownerCookie: string;
  let root: string;
  const tokens: Record<string, string> = {};
  let dashboardId = "";

  async function makeKey(user: SessionUser, organisationId: string, name: string, accessLevel: string) {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId, name, accessLevel } }),
      noContext,
    );
    tokens[name] = ((await response.json()) as { token: string }).token;
  }

  async function loadSales(organisationId: string, folder: string, csv: string) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "sales.csv"), csv);
    await settingsRoute.PATCH(
      apiRequest(`/api/organisations/${organisationId}/settings`, { method: "PATCH", cookie: ownerCookie, body: { analyticsEnabled: true } }),
      params({ organisationId }),
    );
    await foldersRoute.PUT(apiRequest("/api/admin/analytics-folders", { method: "PUT", cookie: ownerCookie, body: { organisationId, folder } }), noContext);
    const made = await sourcesRoute.POST(
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
    );
    const id = ((await made.json()) as { source: { id: string } }).source.id;
    const loaded = await loadRoute.POST(apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId } }), params({ sourceId: id }));
    expect(loaded.status).toBe(200);
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-ai-analytics-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("ai-analytics-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("ai-analytics-books@example.com");
    viewer = await createTestUser("ai-analytics-viewer@example.com");
    farmHand = await createTestUser("ai-analytics-farm@example.com");
    ownerCookie = await sessionCookieFor(owner);
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(owner, OTHER);
    for (const [user, role] of [[bookkeeper, "bookkeeper"], [viewer, "viewer"], [farmHand, "bookkeeper"]] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    // Made-up sales: Otago 2 x 10.00 + 1 x 0.20, Canterbury 1 x 0.10.
    await loadSales(ORG, path.join(root, "here"), "Date,Region,Qty,Price\n2026-03-05,Otago,2,10.00\n2026-03-09,Canterbury,1,0.10\n2026-04-01,Otago,1,0.20\n");
    // Another organisation's own sales and report, which nothing here may see.
    await loadSales(OTHER, path.join(root, "other"), "Date,Region,Qty,Price\n2026-03-05,Waikato,5,99.00\n");
    await inOrganisation(OTHER, { userId: owner.id, email: owner.email }, async (tx) => {
      const { createDashboard } = await import("@/lib/analytics/dashboards");
      await createDashboard(tx, { name: "Other organisation's secret report", tiles: [] });
    });
    // A member who works on one farm only (decision 744).
    await inOrganisation(ORG, { userId: owner.id, email: owner.email }, async (tx) => {
      await setFarmingEnabled(tx, { enabled: true });
      const farm = (await saveFarm(tx, { name: "Home farm" }))[0].id;
      await saveFarm(tx, { name: "Runoff" });
      await setMemberFarmAccess(tx, { userId: farmHand.id, role: "bookkeeper", access: "farms", farmIds: [farm] });
    });
    await makeKey(owner, ORG, "owner-drafts", "draft");
    await makeKey(bookkeeper, ORG, "books-drafts", "draft");
    await makeKey(viewer, ORG, "viewer-read", "read");
    await makeKey(farmHand, ORG, "farm-drafts", "draft");
    await makeKey(owner, OTHER, "other-read", "read");
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await closeAnalytics(OTHER);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("AIA1: a look-only key lists the tables with their fields, where they come from and a guide; the instructions say it can build reports", async () => {
    const listed = await call(tokens["viewer-read"], "list_analytics_tables");
    const tables = listed.tables as Json[];
    expect(tables.map((table) => table.name)).toEqual(["sales"]);
    expect(tables[0]).toMatchObject({ label: "Sales", source: "File: Sales" });
    expect(tables[0].fields).toEqual(expect.arrayContaining([expect.objectContaining({ name: "order_date", kind: "date" }), expect.objectContaining({ name: "unit_price", kind: "number" })]));
    expect(listed).toMatchObject({ more: false, nextCursor: null, guide: expect.objectContaining({ charts: expect.objectContaining({ pie: expect.any(String) }) }) });
    const drafts = ((await rpc(tokens["owner-drafts"], "initialize", {})).result as Json).instructions as string;
    expect(drafts).toContain("You can build Analytics reports yourself");
    const look = ((await rpc(tokens["viewer-read"], "initialize", {})).result as Json).instructions as string;
    expect(look).toContain("list_analytics_tables");
    expect(look).not.toContain("create_analytics_dashboard");
  });

  it("AIA2: run_analytics_query works a question out exactly, saving nothing", async () => {
    const answer = await call(tokens["viewer-read"], "run_analytics_query", { query: SALES_BY_REGION.query });
    expect(answer.rows).toEqual([
      { category: "Otago", m0: "20.200000" },
      { category: "Canterbury", m0: "0.100000" },
    ]);
    const march = await call(tokens["viewer-read"], "run_analytics_query", { query: { ...SALES_BY_REGION.query, dateField: "order_date" }, dates: { from: "2026-03-01", to: "2026-03-31" } });
    expect(march.rows).toEqual([
      { category: "Otago", m0: "20.000000" },
      { category: "Canterbury", m0: "0.100000" },
    ]);
    await expect(call(tokens["viewer-read"], "run_analytics_query", { query: { table: "sales", measures: [{ aggregate: "sum", field: "region" }] } })).rejects.toThrow(/isn't a number/);
  });

  it("AIA3, AIA4: a Make drafts key makes a report; a broken tile is refused with the reason and nothing is saved", async () => {
    await expect(
      call(tokens["owner-drafts"], "create_analytics_dashboard", { name: "Broken", tiles: [SALES_BY_REGION, { ...SALES_BY_MONTH, query: { ...SALES_BY_MONTH.query, groupBy: { field: "colour" } } }] }),
    ).rejects.toThrow(/Sales by month: Group by: there's no column called colour\. Nothing was saved\./);
    await expect(
      call(tokens["owner-drafts"], "create_analytics_dashboard", { name: "Broken pie", tiles: [{ ...SALES_BY_REGION, visual: "pie", query: { ...SALES_BY_REGION.query, measures: [...SALES_BY_REGION.query.measures, { aggregate: "count" }] } }] }),
    ).rejects.toThrow(/a pie shows one value/);
    expect(((await call(tokens["viewer-read"], "list_analytics_dashboards")).dashboards as Json[]).length).toBe(0);

    const made = await call(tokens["owner-drafts"], "create_analytics_dashboard", { name: "Sales", description: "Made by the AI", dates: { preset: "all_time" }, tiles: [SALES_BY_REGION, ORDERS] });
    dashboardId = String((made.dashboard as Json).id);
    expect(made.dashboard).toMatchObject({ name: "Sales", version: 1, tiles: 2, link: `/analytics/dashboards/${dashboardId}` });
    expect((made.checkedTiles as Json[])[0]).toMatchObject({ id: "sales-by-region", preview: expect.objectContaining({ rows: [{ category: "Otago", m0: "20.200000" }, { category: "Canterbury", m0: "0.100000" }] }) });

    // In the app, as anyone would see it.
    const opened = (await (await dashboardRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}?organisationId=${ORG}`, { cookie: ownerCookie }), params({ dashboardId }))).json()) as { dashboard: { tiles: Json[]; updatedByEmail: string } };
    expect(opened.dashboard.tiles.map((tile) => tile.title)).toEqual(["Sales by region", "Orders"]);
    expect(opened.dashboard.updatedByEmail).toBe("ai-analytics-owner@example.com");

    const read = await call(tokens["viewer-read"], "get_analytics_dashboard", { dashboardId });
    const tiles = read.tiles as Json[];
    expect(tiles[1]).toMatchObject({ title: "Orders", visual: "kpi", figures: expect.objectContaining({ rows: [{ m0: "3" }] }) });
  });

  it("AIA5, AIA6: the AI adds, changes and reorders tiles; a stale version is refused; each save is in the history, marked as through the AI", async () => {
    await expect(call(tokens["owner-drafts"], "update_analytics_dashboard", { dashboardId, expectedVersion: 7, name: "x" })).rejects.toThrow(/after the version you read/);
    await expect(call(tokens["owner-drafts"], "update_analytics_dashboard", { dashboardId, changeTiles: [{ tileId: "nope", title: "x" }] })).rejects.toThrow(/there's no tile nope/);
    await expect(
      call(tokens["owner-drafts"], "update_analytics_dashboard", { dashboardId, addTiles: [{ ...SALES_BY_MONTH, query: { ...SALES_BY_MONTH.query, measures: [{ aggregate: "sum", field: "price" }] } }] }),
    ).rejects.toThrow(/Sales by month/);

    const changed = await call(tokens["owner-drafts"], "update_analytics_dashboard", {
      dashboardId,
      expectedVersion: 1,
      addTiles: [{ ...SALES_BY_MONTH, position: 1 }],
      changeTiles: [{ tileId: "sales-by-region", title: "Sales by region (all time)", width: "full" }],
      order: ["sales-by-month", "sales-by-region"],
    });
    expect(changed.dashboard).toMatchObject({ version: 2, tiles: 3 });
    const read = await call(tokens["viewer-read"], "get_analytics_dashboard", { dashboardId });
    expect((read.tiles as Json[]).map((tile) => tile.title)).toEqual(["Sales by month", "Sales by region (all time)", "Orders"]);

    const history = (await (await historyRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}/history?organisationId=${ORG}`, { cookie: ownerCookie }), params({ dashboardId }))).json()) as {
      versions: Array<{ version: number; change: string; savedVia: string | null; byAi: boolean; current: boolean }>;
    };
    expect(history.versions).toEqual([
      expect.objectContaining({ version: 2, change: 'Added "Sales by month"; Changed "Sales by region (all time)"', savedVia: 'AI key "owner-drafts"', byAi: true, current: true }),
      expect.objectContaining({ version: 1, change: "Made the report with 2 tiles", savedVia: 'AI key "owner-drafts"', byAi: true, current: false }),
    ]);
  });

  it("AIA7: a person puts the version before the AI's change back from the history, as a new version", async () => {
    const restored = await historyRoute.POST(
      apiRequest(`/api/analytics/dashboards/${dashboardId}/history`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, version: 1, expectedVersion: 2 } }),
      params({ dashboardId }),
    );
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { dashboard: { version: number; tiles: Json[] } };
    expect(body.dashboard.version).toBe(3);
    expect(body.dashboard.tiles.map((tile) => tile.title)).toEqual(["Sales by region", "Orders"]);
    const history = (await (await historyRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}/history?organisationId=${ORG}`, { cookie: ownerCookie }), params({ dashboardId }))).json()) as {
      versions: Array<{ version: number; change: string; savedVia: string | null; byAi: boolean }>;
    };
    expect(history.versions[0]).toMatchObject({ version: 3, change: "Put back version 1", savedVia: null, byAi: false });
    // A person's own save is in the history too, described by what changed.
    await dashboardRoute.PATCH(
      apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, expectedVersion: 3, name: "Sales report" } }),
      params({ dashboardId }),
    );
    const after = (await (await historyRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}/history?organisationId=${ORG}`, { cookie: ownerCookie }), params({ dashboardId }))).json()) as { versions: Array<{ change: string }> };
    expect(after.versions[0].change).toBe('Renamed to "Sales report"');
  });

  it("AIA8: permissions: a look-only key can't make reports, farm tables need every farm, and nothing of another organisation shows", async () => {
    const refused = await rpc(tokens["viewer-read"], "tools/call", { name: "create_analytics_dashboard", arguments: { name: "x", tiles: [ORDERS] } });
    expect(JSON.stringify(refused)).toMatch(/create_analytics_dashboard needs an AI key with \\"Make drafts\\" access/);
    const tools = ((await rpc(tokens["viewer-read"], "tools/list")).result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["list_analytics_tables", "run_analytics_query", "list_analytics_dashboards", "get_analytics_dashboard"]));
    expect(tools).not.toContain("update_analytics_dashboard");

    const farmTile = { title: "Paddocks", visual: "kpi", query: { table: "tohyee_farm_paddocks", measures: [{ aggregate: "count" }] } };
    await expect(call(tokens["farm-drafts"], "run_analytics_query", { query: farmTile.query })).rejects.toThrow(/Farm tables in Analytics hold every farm's records/);
    await expect(call(tokens["farm-drafts"], "update_analytics_dashboard", { dashboardId, addTiles: [farmTile] })).rejects.toThrow(/Paddocks: Farm tables in Analytics/);
    // A bookkeeper on the books can change reports too; the history names them.
    await call(tokens["books-drafts"], "update_analytics_dashboard", { dashboardId, changeTiles: [{ tileId: "sales-by-region", height: "large" }] });

    const other = await call(tokens["other-read"], "list_analytics_dashboards");
    expect((other.dashboards as Json[]).map((dashboard) => dashboard.name)).toEqual(["Other organisation's secret report"]);
    const here = await call(tokens["viewer-read"], "list_analytics_dashboards");
    expect(JSON.stringify(here)).not.toContain("secret");
    const otherSales = await call(tokens["other-read"], "run_analytics_query", { query: SALES_BY_REGION.query });
    expect(otherSales.rows).toEqual([{ category: "Waikato", m0: "495.000000" }]);
    expect(JSON.stringify(await call(tokens["viewer-read"], "run_analytics_query", { query: SALES_BY_REGION.query }))).not.toContain("Waikato");

    // With Analytics off the tools aren't offered, and say why.
    await settingsRoute.PATCH(apiRequest(`/api/organisations/${OTHER}/settings`, { method: "PATCH", cookie: ownerCookie, body: { analyticsEnabled: false } }), params({ organisationId: OTHER }));
    const off = await rpc(tokens["other-read"], "tools/call", { name: "list_analytics_dashboards", arguments: {} });
    expect(JSON.stringify(off)).toContain("Analytics is turned off for this organisation");
  });
});

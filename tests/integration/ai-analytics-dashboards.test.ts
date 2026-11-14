import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as commentaryRoute from "@/app/api/analytics/dashboards/[dashboardId]/commentary/[tileId]/route";
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

/** The AI builds Analytics reports (#591, examples AIA1-AIA9, decisions 1411-1420; not yet reviewed). */
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

  it("AIA9: an owner's AI refreshes a report's sources the way Load now does; a bookkeeper's can't, and a source already loading is left alone", async () => {
    const refused = await rpc(tokens["books-drafts"], "tools/call", { name: "refresh_analytics_sources", arguments: { tables: ["sales"] } });
    expect(JSON.stringify(refused)).toMatch(/only for owners and admins/);
    const sourceBefore = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query<{ updated_at: Date; columns: unknown }>("select updated_at, columns from analytics_sources"));

    // A new sale in the file: the refresh loads it.
    fs.appendFileSync(path.join(root, "here", "sales.csv"), "2026-04-02,Canterbury,3,1.00\n");
    const refreshed = await call(tokens["owner-drafts"], "refresh_analytics_sources", { dashboardId, tables: ["nope"] });
    expect(refreshed.refreshed).toEqual([
      expect.objectContaining({ source: "Sales", tables: ["sales"], status: "ok", rowsLoaded: "4", startedAt: expect.stringMatching(/Z$/), finishedAt: expect.stringMatching(/Z$/) }),
    ]);
    const answer = await call(tokens["viewer-read"], "run_analytics_query", { query: SALES_BY_REGION.query });
    expect(answer.rows).toEqual([
      { category: "Otago", m0: "20.200000" },
      { category: "Canterbury", m0: "3.100000" },
    ]);
    const read = await call(tokens["viewer-read"], "get_analytics_dashboard", { dashboardId });
    expect(read.freshness).toEqual([expect.objectContaining({ name: "Sales", tables: ["sales"], refreshedAt: (refreshed.refreshed as Json[])[0].finishedAt, failedAt: null, running: false })]);

    // Tables named instead of a report; one nothing loads is skipped with the reason.
    const named = await call(tokens["owner-drafts"], "refresh_analytics_sources", { tables: ["sales", "made_up"] });
    expect(named.skipped).toEqual([{ table: "made_up", reason: "There's no source that loads this table." }]);

    // Already loading: refused the same way as in Tohyee, nothing started.
    await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) =>
      tx.query("insert into analytics_load_runs (source_id, source_name, table_name, file_name, trigger) select id, name, table_name, file_name, 'schedule' from analytics_sources"),
    );
    const busy = await call(tokens["owner-drafts"], "refresh_analytics_sources", { tables: ["sales"] });
    expect(busy.refreshed).toEqual([expect.objectContaining({ source: "Sales", status: "not started", error: "That source is already loading." })]);
    await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query("delete from analytics_load_runs where status = 'running'"));

    // Only the data: the source's definition is as it was.
    const sourceAfter = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query<{ updated_at: Date; columns: unknown }>("select updated_at, columns from analytics_sources"));
    expect(sourceAfter.rows).toEqual(sourceBefore.rows);
  });
  it("#689: the format guide lists layout advice, examples and templates; formats the AI sends are kept; a template needs its data", async () => {
    const guide = await call(tokens["viewer-read"], "analytics_format_guide");
    expect((guide.layout as string[]).length).toBeGreaterThan(5);
    expect(guide.format).toMatchObject({ series: expect.any(Object), card: expect.any(Object), kpi: expect.any(Object) });
    expect(guide.examples).toMatchObject({ percentKeyFigure: { format: { series: [{ number: { style: "percent", decimals: 1 } }] } } });
    // The books aren't loaded into Analytics here, so the books templates say what they need.
    expect((guide.templates as Json[]).find((template) => template.id === "profit")).toMatchObject({ available: false, needs: ["tohyee_ledger_lines"] });
    await expect(call(tokens["owner-drafts"], "create_analytics_dashboard_from_template", { template: "profit" })).rejects.toThrow(/needs data this organisation hasn't loaded: tohyee_ledger_lines\. Nothing was saved\./);
    await expect(call(tokens["viewer-read"], "create_analytics_dashboard_from_template", { template: "profit" })).rejects.toThrow();

    const share = {
      id: "otago-share",
      title: "Otago's share of orders",
      visual: "kpi",
      width: "quarter",
      query: {
        table: "sales",
        measures: [{ label: "Otago share", aggregate: "formula", formula: "[Otago] / [All]", inputs: [{ name: "Otago", aggregate: "count", where: [{ field: "region", op: "eq", value: "Otago" }] }, { name: "All", aggregate: "count" }] }],
      },
      format: { series: [{ number: { style: "percent", decimals: 1 } }], card: { subtitle: "Orders from Otago as a share of all orders" } },
    };
    const made = await call(tokens["owner-drafts"], "create_analytics_dashboard", { name: "Formatted", tiles: [share] });
    const read = await call(tokens["viewer-read"], "get_analytics_dashboard", { dashboardId: String((made.dashboard as Json).id) });
    expect((read.tiles as Json[])[0]).toMatchObject({ format: { series: [{ number: { style: "percent", decimals: 1 } }], card: { subtitle: "Orders from Otago as a share of all orders" } } });
  });

  it("#706: the AI suggests commentary; a person accepts or removes it; a save can't forge it; an AI rewording needs checking again", async () => {
    const made = await call(tokens["owner-drafts"], "create_analytics_dashboard", { name: "With commentary", dates: { from: "2026-01-01", to: "2026-12-31" }, tiles: [SALES_BY_REGION, ORDERS] });
    const id = String((made.dashboard as Json).id);
    // A look-only key can't; and it has to be about a tile of this report.
    await expect(call(tokens["viewer-read"], "suggest_analytics_commentary", { dashboardId: id, text: "Otago leads." })).rejects.toThrow();
    await expect(call(tokens["owner-drafts"], "suggest_analytics_commentary", { dashboardId: id, text: "Otago leads.", aboutTileId: "nope" })).rejects.toThrow(/isn't a tile of this report/);

    const suggested = await call(tokens["owner-drafts"], "suggest_analytics_commentary", { dashboardId: id, text: "**Otago** makes nearly all the sales.", aboutTileId: "sales-by-region" });
    const tileId = String(suggested.tileId);
    const read = async (token: string) => (await call(token, "get_analytics_dashboard", { dashboardId: id })).tiles as Json[];
    const tiles = await read(tokens["owner-drafts"]);
    // Straight after the tile it's about, marked as suggested, with the report's dates.
    expect(tiles.map((tile) => tile.id)).toEqual(["sales-by-region", tileId, expect.any(String)]);
    const fromRoute = async () => {
      const response = await dashboardRoute.GET(apiRequest(`/api/analytics/dashboards/${id}?organisationId=${ORG}`, { cookie: ownerCookie }), params({ dashboardId: id }));
      return ((await response.json()) as { dashboard: { version: number; tiles: Json[] } }).dashboard;
    };
    let dashboard = await fromRoute();
    expect(dashboard.tiles.find((tile) => tile.id === tileId)).toMatchObject({
      title: "Commentary: Sales by region",
      visual: "text",
      text: "**Otago** makes nearly all the sales.",
      commentary: { status: "suggested", byEmail: owner.email, about: { from: "2026-01-01", to: "2026-12-31" }, via: expect.stringContaining("AI key") },
    });

    // An ordinary save can't mark it accepted, or make commentary out of another text tile.
    const forged = dashboard.tiles.map((tile) => (tile.id === tileId ? { ...tile, commentary: { ...(tile.commentary as Json), status: "accepted", acceptedByEmail: "x@example.com", acceptedAt: "2026-01-01T00:00:00Z" } } : tile));
    forged.push({ id: "note", title: "Note", visual: "text", width: "half", text: "Mine", commentary: { status: "accepted", via: "AI", byEmail: "x@example.com", writtenAt: "2026-01-01T00:00:00Z", about: {} } });
    const patched = await dashboardRoute.PATCH(apiRequest(`/api/analytics/dashboards/${id}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, tiles: forged, expectedVersion: dashboard.version } }), params({ dashboardId: id }));
    expect(patched.status).toBe(200);
    dashboard = await fromRoute();
    expect((dashboard.tiles.find((tile) => tile.id === tileId)!.commentary as Json).status).toBe("suggested");
    expect(dashboard.tiles.find((tile) => tile.id === "note")).not.toHaveProperty("commentary");

    // A person accepts it; it says who and when.
    const decide = (action: string, cookie = ownerCookie) =>
      commentaryRoute.POST(apiRequest(`/api/analytics/dashboards/${id}/commentary/${tileId}`, { method: "POST", cookie, body: { organisationId: ORG, action, expectedVersion: dashboard.version } }), params({ dashboardId: id, tileId }));
    const accepted = await decide("accept");
    expect(accepted.status).toBe(200);
    dashboard = await fromRoute();
    expect(dashboard.tiles.find((tile) => tile.id === tileId)!.commentary).toMatchObject({ status: "accepted", acceptedByEmail: owner.email, acceptedAt: expect.any(String) });

    // The AI rewording accepted commentary puts it back to suggested.
    await call(tokens["owner-drafts"], "update_analytics_dashboard", { dashboardId: id, changeTiles: [{ tileId, text: "Otago makes all of it." }] });
    dashboard = await fromRoute();
    const reworded = dashboard.tiles.find((tile) => tile.id === tileId)!;
    expect(reworded.commentary).toMatchObject({ status: "suggested" });
    expect(reworded.commentary).not.toHaveProperty("acceptedByEmail");

    // Remove takes the box off; doing it again says it's gone.
    expect((await decide("remove")).status).toBe(200);
    dashboard = await fromRoute();
    expect(dashboard.tiles.some((tile) => tile.id === tileId)).toBe(false);
    expect((await decide("remove")).status).toBe(404);
  });
  it("#690: the AI sets a report's theme, pages and slicers, and takes a tile off; History can put it back", async () => {
    const guide = await call(tokens["viewer-read"], "analytics_format_guide");
    expect((guide.themes as Json[]).map((theme) => theme.id)).toEqual(expect.arrayContaining(["tohyee", "harbour", "contrast"]));

    const made = await call(tokens["owner-drafts"], "create_analytics_dashboard", {
      name: "Two pages",
      theme: "harbour",
      pages: [{ id: "overview", name: "Overview" }, { id: "detail", name: "Detail", background: "tinted" }],
      slicers: [{ table: "sales", field: "region", label: "Region", style: "dropdown" }],
      tiles: [SALES_BY_REGION, { ...ORDERS, id: "orders" }, { ...SALES_BY_MONTH, page: "detail" }],
    });
    const id = String((made.dashboard as Json).id);
    let read = await call(tokens["viewer-read"], "get_analytics_dashboard", { dashboardId: id });
    expect(read).toMatchObject({ theme: "harbour", slicers: [{ table: "sales", field: "region", label: "Region", style: "dropdown" }] });
    expect((read.dashboard as Json).pages).toEqual([{ id: "overview", name: "Overview" }, { id: "detail", name: "Detail" }]);
    expect((read.tiles as Json[]).find((tile) => tile.id === "sales-by-month")).toMatchObject({ page: "detail" });

    // Wrong ones are refused, and nothing is saved.
    await expect(call(tokens["owner-drafts"], "update_analytics_dashboard", { dashboardId: id, theme: "neon" })).rejects.toThrow(/Nothing was saved/);
    await expect(call(tokens["owner-drafts"], "update_analytics_dashboard", { dashboardId: id, slicers: [{ table: "sales", field: "colour" }] })).rejects.toThrow(/no column colour/);
    await expect(call(tokens["owner-drafts"], "update_analytics_dashboard", { dashboardId: id, removeTiles: ["nope"] })).rejects.toThrow(/no tile nope/);
    await expect(call(tokens["owner-drafts"], "update_analytics_dashboard", { dashboardId: id, removeTiles: ["sales-by-region", "orders", "sales-by-month"] })).rejects.toThrow(/leave the report empty/);
    expect(((await call(tokens["viewer-read"], "get_analytics_dashboard", { dashboardId: id })).dashboard as Json).version).toBe(1);

    // One change: back to Tohyee's look, one page, no slicers, and a tile off.
    await call(tokens["owner-drafts"], "update_analytics_dashboard", { dashboardId: id, theme: "tohyee", pages: [{ id: "overview", name: "Overview" }], slicers: [], removeTiles: ["orders"] });
    read = await call(tokens["viewer-read"], "get_analytics_dashboard", { dashboardId: id });
    expect(read).toMatchObject({ theme: "tohyee", slicers: [] });
    expect((read.tiles as Json[]).map((tile) => tile.id)).toEqual(["sales-by-region", "sales-by-month"]);
    // The tile that was on the removed page is on the first page now.
    expect((read.tiles as Json[]).find((tile) => tile.id === "sales-by-month")).not.toHaveProperty("page");

    // A person puts the version before back: the tile, pages, slicer and theme return.
    const restored = await historyRoute.POST(apiRequest(`/api/analytics/dashboards/${id}/history`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, version: 1 } }), params({ dashboardId: id }));
    expect(restored.status).toBe(200);
    read = await call(tokens["viewer-read"], "get_analytics_dashboard", { dashboardId: id });
    expect(read).toMatchObject({ theme: "harbour" });
    expect((read.tiles as Json[]).map((tile) => tile.id)).toEqual(["sales-by-region", "orders", "sales-by-month"]);
  });
});

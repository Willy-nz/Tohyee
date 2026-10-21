import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as freshnessRoute from "@/app/api/analytics/dashboards/[dashboardId]/freshness/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as measureRoute from "@/app/api/analytics/measures/[measureId]/route";
import * as measuresRoute from "@/app/api/analytics/measures/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as tablesRoute from "@/app/api/analytics/tables/route";
import * as valuesRoute from "@/app/api/analytics/values/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { presetRange } from "@/lib/analytics/date-ranges";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { todayIsoDate } from "@/lib/dates";
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
    expect(made.data.dashboard.settings).toEqual({ from: "2026-01-01", to: "2026-12-31", preset: null, slicers: [{ table: "sales", field: "region", label: "Region" }] });
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

  it("keeps a date preset and works its dates out from today and the balance date (decision 577)", async () => {
    const today = todayIsoDate();
    const settings = (preset: unknown) => ({ organisationId: ORG, settings: { from: "2020-01-01", to: "2020-01-31", preset, slicers: [] } });
    const refused = await dashboardRoute.PATCH(
      apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: settings("next_decade") }),
      params({ dashboardId }),
    );
    expect(refused.status).toBe(400);
    const saved = await body(
      await dashboardRoute.PATCH(
        apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: settings("this_financial_year") }),
        params({ dashboardId }),
      ),
    );
    // The organisation keeps New Zealand's usual 31 March balance date.
    expect(saved.data.dashboard.settings).toMatchObject({ preset: "this_financial_year", ...presetRange("this_financial_year", today, 3) });
    const read = await body(await dashboardRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}?organisationId=${ORG}`, { cookie: viewerCookie }), params({ dashboardId })));
    expect(read.data).toMatchObject({ today, financialYearEndMonth: 3, dashboard: { settings: { preset: "this_financial_year", ...presetRange("this_financial_year", today, 3) } } });
    const fixed = await body(
      await dashboardRoute.PATCH(
        apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: settings(null) }),
        params({ dashboardId }),
      ),
    );
    expect(fixed.data.dashboard.settings).toMatchObject({ preset: null, from: "2020-01-01", to: "2020-01-31" });
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
    expect(values.data).toEqual({ values: ["Canterbury", "Otago"], type: "VARCHAR" });
  });

  it("saves how a chart looks with its tile, keeping only known settings (#331, #333)", async () => {
    const patch = (tiles: unknown[]) =>
      dashboardRoute.PATCH(
        apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, tiles } }),
        params({ dashboardId }),
      );
    const format = {
      palette: "blues",
      series: [{ as: "bar" }, { as: "line", axis: "right", color: "orange", number: { style: "plain", decimals: 0 } }],
      legend: { position: "bottom" },
      rightAxis: { title: "Last year", zero: false },
      card: { subtitle: "Excludes GST", background: "tinted" },
      madeUp: "dropped",
    };
    const saved = await body(await patch([{ ...tile, visual: "combo", format }]));
    expect(saved.status).toBe(200);
    const kept: Record<string, unknown> = { ...format };
    delete kept.madeUp;
    expect(saved.data.dashboard.tiles[0].format).toEqual(kept);

    const refused = await body(await patch([{ ...tile, format: { series: [{ color: "#123456" }] } }]));
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/^Sales by month: Value 1 colour/);

    // Reset to default: a tile without a format has none saved.
    const reset = await body(await patch([tile]));
    expect(reset.data.dashboard.tiles[0].format).toBeUndefined();
  });

  it("saves waterfall, funnel, gauge and bullet tiles, and refuses ones that can't be drawn (#376 phase 2)", async () => {
    const patch = (tiles: unknown[]) =>
      dashboardRoute.PATCH(
        apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, tiles } }),
        params({ dashboardId }),
      );
    const byRegion = { ...tile.query, groupBy: { field: "region" }, measures: [{ label: "Qty", aggregate: "sum", field: "quantity" }] };
    const oneTotal = { ...byRegion, groupBy: null, measures: [{ label: "Qty", aggregate: "sum", field: "quantity" }, { label: "Budget", aggregate: "count" }] };
    const saved = await body(
      await patch([
        { ...tile, id: "w", visual: "waterfall", query: byRegion, format: { waterfall: { totalLabel: "All regions", madeUp: 1 } } },
        { ...tile, id: "f", visual: "funnel", query: byRegion, format: { funnel: { percent: "previous" } } },
        { ...tile, id: "g", visual: "gauge", query: oneTotal, format: { gauge: { max: "10" } } },
        { ...tile, id: "b", visual: "bullet", query: { ...byRegion, measures: oneTotal.measures }, format: { bullet: { bands: [50, 90] } } },
      ]),
    );
    expect(saved.status).toBe(200);
    expect(saved.data.dashboard.tiles.map((entry: { visual: string }) => entry.visual)).toEqual(["waterfall", "funnel", "gauge", "bullet"]);
    expect(saved.data.dashboard.tiles[0].format).toEqual({ waterfall: { totalLabel: "All regions" } });

    // The gauge's one total and its target come back from the saved tile.
    const answer = await body(
      await queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, dashboardId, tileId: "g", filters: {} } }), noContext),
    );
    expect(answer.status).toBe(200);
    expect(answer.data.rows).toHaveLength(1);
    expect(Object.keys(answer.data.rows[0]).sort()).toEqual(["m0", "m1"]);

    const refusals: Array<[unknown, RegExp]> = [
      [{ ...tile, visual: "gauge", query: { ...byRegion } }, /a gauge shows one total/],
      [{ ...tile, visual: "waterfall", query: { ...byRegion, measures: oneTotal.measures } }, /a waterfall shows one value/],
      [{ ...tile, visual: "bullet", query: { ...byRegion, measures: [...oneTotal.measures, { label: "More", aggregate: "count" }] } }, /up to two values/],
      [{ ...tile, visual: "funnel", query: { ...byRegion, groupBy: null } }, /needs something to group by/],
      [{ ...tile, visual: "bullet", query: byRegion, format: { bullet: { bands: [90, 50] } } }, /should go up/],
    ];
    for (const [entry, message] of refusals) {
      const refused = await body(await patch([entry]));
      expect(refused.status).toBe(400);
      expect(refused.data.error).toMatch(message);
    }
    await patch([tile]);
  });

  it("compares one total with the previous period or last year, with a trend by month (#334)", async () => {
    const ask = async (query: unknown, filters: unknown) =>
      body(await queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG, query, filters } }), noContext));
    const total = (compare: string) => ({
      table: "sales",
      groupBy: null,
      measures: [{ label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price", compare }],
      filters: [],
      dateField: "order_date",
      sparkline: true,
    });
    const april = await ask(total("previous_period"), { from: "2026-04-01", to: "2026-04-30" });
    expect(april.status).toBe(200);
    expect(april.data.columns.map((column: { key: string; label: string }) => [column.key, column.label])).toEqual([
      ["m0", "Sales"],
      ["m0_pp", "Sales previous period"],
    ]);
    expect(april.data.rows).toEqual([{ m0: "0.200000", m0_pp: "20.100000" }]);
    expect(april.data.trend).toEqual([{ month: "2026-04-01", value: "0.200000" }]);

    const march = await ask(total("previous_year"), { from: "2026-03-01", to: "2026-03-31" });
    expect(march.data.rows).toEqual([{ m0: "20.100000", m0_py: "10.000000" }]);

    const year = await ask(total("previous_period"), { from: "2026-01-01", to: "2026-12-31" });
    expect(year.data.trend).toEqual([
      { month: "2026-03-01", value: "20.100000" },
      { month: "2026-04-01", value: "0.200000" },
    ]);

    // Without the dashboard's dates there's no period to compare with.
    const allTime = await ask(total("previous_period"), {});
    expect(allTime.data.rows).toEqual([{ m0: "30.300000", m0_pp: null }]);

    const grouped = await ask({ ...total("previous_period"), groupBy: { field: "region" }, sparkline: false }, {});
    expect(grouped.status).toBe(400);
    expect(grouped.data.error).toMatch(/previous period is for one total/);
  });

  it("lays tiles out in widths and heights, with text cards and copies (#335)", async () => {
    const patch = async (tiles: unknown[]) =>
      body(
        await dashboardRoute.PATCH(
          apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, tiles } }),
          params({ dashboardId }),
        ),
      );
    const saved = await patch([
      { id: "heading", title: "Sales", visual: "text", width: "full", text: "  Made-up figures.\r\n\r\nSecond paragraph. ", query: { table: "nope" } },
      { ...tile, width: "quarter", height: "large" },
      { ...tile, width: "two-thirds", height: "medium" },
      { ...tile, width: "enormous", height: "huge" },
    ]);
    expect(saved.status).toBe(200);
    const tiles = saved.data.dashboard.tiles;
    expect(tiles[0]).toEqual({ id: "heading", title: "Sales", visual: "text", width: "full", query: null, text: "Made-up figures.\n\nSecond paragraph." });
    expect(tiles.slice(1).map((entry: { width: string; height?: string }) => [entry.width, entry.height])).toEqual([
      ["quarter", "large"],
      ["two-thirds", undefined],
      ["half", undefined],
    ]);
    // A copy that kept the same id gets its own, so pins and edits find the right one.
    expect(tiles[1].id).toBe("monthly");
    expect(new Set(tiles.map((entry: { id: string }) => entry.id)).size).toBe(4);

    // A text card has no question to run.
    const asked = await queryRoute.POST(
      apiRequest("/api/analytics/query", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG, dashboardId, tileId: "heading", filters: {} } }),
      noContext,
    );
    expect(asked.status).toBe(400);

    const tooMany = await patch(Array.from({ length: 41 }, (_, index) => ({ id: `n${index}`, title: "Note", visual: "text", width: "quarter" })));
    expect(tooMany.status).toBe(400);
    const tooLong = await patch([{ id: "long", title: "Note", visual: "text", width: "full", text: "x".repeat(2001) }]);
    expect(tooLong.data.error).toMatch(/2,000/);
    await patch([tile]);
  });

  it("works out calculated values and keeps saved values on the data source (#337)", async () => {
    const quantity = { label: "Units", aggregate: "sum", field: "quantity" };
    const sales = { label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price" };
    const average = { label: "Price per unit", aggregate: "formula", formula: "[Sales] / [Units]" };
    const answer = await body(
      await queryRoute.POST(
        apiRequest("/api/analytics/query", {
          method: "POST",
          cookie: viewerCookie,
          body: { organisationId: ORG, query: { table: "sales", groupBy: { field: "region" }, measures: [quantity, sales, average], filters: [] }, filters: {} },
        }),
        noContext,
      ),
    );
    expect(answer.status).toBe(200);
    // Canterbury: 0.10 / 1; Otago: (10 + 20 + 0.20) / 4 = 7.55, exactly.
    expect(answer.data.rows).toEqual([
      { category: "Canterbury", m0: "1.0000", m1: "0.100000", m2: "0.100000" },
      { category: "Otago", m0: "4.0000", m1: "30.200000", m2: "7.550000" },
    ]);

    const save = (payload: Record<string, unknown>, user = ownerCookie) =>
      measuresRoute.POST(apiRequest("/api/analytics/measures", { method: "POST", cookie: user, body: { organisationId: ORG, table: "sales", ...payload } }), noContext);
    const definition = { kind: "formula", formula: "[Sales] / [Units]", inputs: [{ name: "Sales", aggregate: "sum", field: "quantity", times: "unit_price" }, { name: "Units", aggregate: "sum", field: "quantity" }] };
    expect((await save({ name: "Price per unit", definition }, viewerCookie)).status).toBe(403);
    const saved = await body(await save({ name: "Price per unit", definition, number: { decimals: 2 } }));
    expect(saved.status).toBe(201);
    expect(saved.data.measure).toMatchObject({ table: "sales", name: "Price per unit", number: { decimals: 2 }, definition: { kind: "formula", formula: "[Sales] / [Units]" } });
    expect((await body(await save({ name: "price PER unit", definition }))).data.error).toMatch(/already a value called/);
    expect((await body(await save({ name: "Broken", definition: { kind: "formula", formula: "[Sales] / [Nope]", inputs: definition.inputs } }))).data.error).toMatch(/\[Nope\] isn't one of this chart's values/);
    expect((await body(await save({ name: "Wrong column", definition: { kind: "base", aggregate: "sum", field: "nope" } }))).status).toBe(400);

    const listed = await body(await measuresRoute.GET(apiRequest(`/api/analytics/measures?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    expect(listed.data.measures.map((measure: { name: string }) => measure.name)).toEqual(["Price per unit"]);
    const id = saved.data.measure.id;
    const removed = await measureRoute.DELETE(
      apiRequest(`/api/analytics/measures/${id}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }),
      params({ measureId: id }),
    );
    expect(removed.status).toBe(200);
  });

  it("says how fresh the report's data is, and shows a failed refresh as stale (#387, decision 698)", async () => {
    const freshness = async () =>
      body(await freshnessRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}/freshness?organisationId=${ORG}`, { cookie: viewerCookie }), params({ dashboardId })));
    const first = await freshness();
    expect(first.status).toBe(200);
    expect(first.data.mixed).toBe(false);
    expect(first.data.sources).toHaveLength(1);
    const [source] = first.data.sources;
    expect(source).toMatchObject({ name: "Sales", tables: ["sales"], failedAt: null, running: false, dataThrough: "2026-04-01" });
    expect(Date.parse(source.refreshedAt)).not.toBeNaN();

    // A refresh that fails keeps the last good data, and says so: it isn't "refreshed".
    const file = path.join(root, "reports", "sales.csv");
    const good = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "Date,Region,Qty,Price\nnot a date,Otago,1,10.00\n");
    const sources = await body(await sourcesRoute.GET(apiRequest(`/api/analytics/sources?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    const id = sources.data.sources[0].id;
    await loadRoute.POST(apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId: id }));
    const stale = (await freshness()).data.sources[0];
    expect(stale.refreshedAt).toBe(source.refreshedAt);
    expect(Date.parse(stale.failedAt)).toBeGreaterThanOrEqual(Date.parse(source.refreshedAt));
    expect(stale.dataThrough).toBe("2026-04-01");
    fs.writeFileSync(file, good);
    await loadRoute.POST(apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId: id }));
    expect((await freshness()).data.sources[0].failedAt).toBeNull();
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

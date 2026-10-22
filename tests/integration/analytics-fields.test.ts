import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as fieldRoute from "@/app/api/analytics/fields/[fieldId]/route";
import * as fieldsRoute from "@/app/api/analytics/fields/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as tablesRoute from "@/app/api/analytics/tables/route";
import * as valuesRoute from "@/app/api/analytics/values/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "fields-co";
const noContext = undefined as unknown;

/** Calculated fields on a data source (decision 772): saved, shared by tiles, checked before a change. */
describeWithDatabase("analytics calculated fields", () => {
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
  const post = (cookie: string, payload: Record<string, unknown>) =>
    fieldsRoute.POST(apiRequest("/api/analytics/fields", { method: "POST", cookie, body: { organisationId: ORG, table: "sales", ...payload } }), noContext);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-fields-it-"));
    const folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "sales.csv"), "Date,Region,Amount\n2026-03-31,Otago,25.00\n2026-04-01,Otago,1500.00\n2026-04-02,Canterbury,999.99\n");
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    const viewer = await createTestUser("viewer@example.com");
    const client = await createTestUser("client@example.com");
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

  let fieldId = "";
  let dashboardId = "";
  const tile = {
    id: "bands",
    title: "Sales by size",
    visual: "table",
    width: "full",
    query: { table: "sales", groupBy: { field: "size_band" }, measures: [{ label: "Sales", aggregate: "sum", field: "amount" }], filters: [], dateField: "sale_date", sort: { by: "category", direction: "asc" } },
  };

  it("saves a field (bookkeepers and up), checking its formula and name", async () => {
    expect((await post(viewerCookie, { name: "size_band", formula: '"x"' })).status).toBe(403);
    const bad = await body(await post(ownerCookie, { name: "size_band", formula: '[amount] + "x"' }));
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/CONCAT/);
    expect((await body(await post(ownerCookie, { name: "Amount", formula: "1" }))).data.error).toMatch(/small letters/);
    expect((await body(await post(ownerCookie, { name: "amount", formula: "1" }))).data.error).toMatch(/already has a column called amount/);
    const made = await body(await post(ownerCookie, { name: "size_band", formula: 'IF([amount] >= 1000, "Large", "Small")', description: "Sales of 1,000 or more are large." }));
    expect(made.status).toBe(201);
    expect(made.data.field).toMatchObject({ table: "sales", name: "size_band", type: "VARCHAR", description: "Sales of 1,000 or more are large." });
    expect(made.data.field.sql).toBeUndefined();
    fieldId = made.data.field.id;
    expect((await body(await post(ownerCookie, { name: "size_band", formula: '"x"' }))).data.error).toMatch(/already a calculated field/);
  });

  it("lists it for viewers and up, as one of the table's columns, never to report viewers", async () => {
    const listed = await body(await fieldsRoute.GET(apiRequest(`/api/analytics/fields?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    expect(listed.data.fields.map((field: { name: string }) => field.name)).toEqual(["size_band"]);
    expect(listed.data.functions.length).toBeGreaterThan(3);
    const tables = await body(await tablesRoute.GET(apiRequest(`/api/analytics/tables?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    expect(tables.data.tables[0].columns.at(-1)).toEqual({ name: "size_band", type: "VARCHAR", calculated: true });
    expect((await fieldsRoute.GET(apiRequest(`/api/analytics/fields?organisationId=${ORG}`, { cookie: clientCookie }), noContext)).status).toBe(403);
  });

  it("is used by a report's tiles and slicers, through the saved tile", async () => {
    const made = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Sizes", settings: { from: null, to: null, slicers: [] }, tiles: [tile] } }),
        noContext,
      ),
    );
    expect(made.status).toBe(201);
    dashboardId = made.data.dashboard.id;
    const answer = await body(await queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, dashboardId, tileId: "bands", filters: {} } }), noContext));
    expect(answer.data.rows).toEqual([
      { category: "Large", m0: "1500.00" },
      { category: "Small", m0: "1024.99" },
    ]);
    const values = await body(await valuesRoute.GET(apiRequest(`/api/analytics/values?organisationId=${ORG}&table=sales&field=size_band`, { cookie: viewerCookie }), noContext));
    expect(values.data.values).toEqual(["Large", "Small"]);
  });

  it("can't be removed, renamed or change kind while a report uses it; a formula change shows everywhere", async () => {
    const removed = await body(await fieldRoute.DELETE(apiRequest(`/api/analytics/fields/${fieldId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ fieldId })));
    expect(removed.status).toBe(409);
    expect(removed.data.error).toMatch(/used by Sizes/);
    const patch = (payload: Record<string, unknown>) => fieldRoute.PATCH(apiRequest(`/api/analytics/fields/${fieldId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, ...payload } }), params({ fieldId }));
    expect((await body(await patch({ formula: "[amount] >= 1000" }))).data.error).toMatch(/from text to yes or no, which would break Sizes/);
    expect((await body(await patch({ name: "band" }))).data.error).toMatch(/can't be renamed while it's used by Sizes/);
    const changed = await body(await patch({ formula: 'IF([amount] >= 900, "Large", "Small")' }));
    expect(changed.status).toBe(200);
    expect(changed.data.field.usedBy).toEqual(["Sizes"]);
    const answer = await body(await queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, dashboardId, tileId: "bands", filters: {} } }), noContext));
    expect(answer.data.rows).toEqual([
      { category: "Large", m0: "2499.99" },
      { category: "Small", m0: "25.00" },
    ]);
    await dashboardRoute.DELETE(apiRequest(`/api/analytics/dashboards/${dashboardId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ dashboardId }));
    expect((await fieldRoute.DELETE(apiRequest(`/api/analytics/fields/${fieldId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ fieldId }))).status).toBe(200);
  });
});

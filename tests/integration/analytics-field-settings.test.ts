import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as settingsFieldRoute from "@/app/api/analytics/field-settings/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as tablesRoute from "@/app/api/analytics/tables/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "fieldset-co";
const noContext = undefined as unknown;

/** Field settings (decision 775): sort by another column, default format, folders and descriptions, saved on the table. */
describeWithDatabase("analytics field settings", () => {
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
  const put = (cookie: string, payload: Record<string, unknown>) =>
    settingsFieldRoute.PUT(apiRequest("/api/analytics/field-settings", { method: "PUT", cookie, body: { organisationId: ORG, table: "sales", ...payload } }), noContext);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-fieldset-it-"));
    const folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "sales.csv"), "Date,Region,Amount\n2026-03-31,Otago,25.00\n2026-04-01,Otago,1500.00\n2026-04-02,Canterbury,999.99\n2026-04-03,Auckland,10.00\n");
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

  it("saves a field's settings (bookkeepers and up), checking them, and lists them with the columns", async () => {
    expect((await put(viewerCookie, { field: "amount", settings: { folder: "Money" } })).status).toBe(403);
    const bad = await body(await put(ownerCookie, { field: "region", settings: { sortBy: "amount" } }));
    // Otago has two different amounts, so amounts can't order the regions.
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/"Otago" has 2 different amount values/);
    const saved = await body(await put(ownerCookie, { field: "amount", settings: { number: { style: "currency", decimals: 0 }, folder: "Money", description: "Sale amount, GST exclusive.", summarise: "sum", ignored: true } }));
    expect(saved.status).toBe(200);
    expect(saved.data.fieldSettings.settings).toEqual({ summarise: "sum", number: { style: "currency", decimals: 0 }, folder: "Money", description: "Sale amount, GST exclusive." });
    const tables = await body(await tablesRoute.GET(apiRequest(`/api/analytics/tables?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    expect(tables.data.tables[0].columns.find((column: { name: string }) => column.name === "amount").settings.folder).toBe("Money");
  });

  it("orders a report viewer's tile by the sort column and shows the field's format", async () => {
    // A date can't order the regions either: Otago has two.
    expect((await put(ownerCookie, { field: "region", settings: { sortBy: "sale_date" } })).status).toBe(400);
    const made = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", {
          method: "POST",
          cookie: ownerCookie,
          body: { organisationId: ORG, name: "Regions", tiles: [{ id: "r", title: "By region", visual: "table", width: "full", query: { table: "sales", groupBy: { field: "region" }, measures: [{ label: "Sales", aggregate: "sum", field: "amount" }], filters: [], dateField: null, sort: { by: "category", direction: "asc" } } }] },
        }),
        noContext,
      ),
    );
    const answer = await body(await queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, dashboardId: made.data.dashboard.id, tileId: "r", filters: {} } }), noContext));
    expect(answer.data.rows.map((row: { category: string }) => row.category)).toEqual(["Auckland", "Canterbury", "Otago"]);
    expect(answer.data.columns[1].number).toEqual({ style: "currency", decimals: 0 });
    // Clearing every setting removes them.
    expect((await body(await put(ownerCookie, { field: "amount", settings: {} }))).data.fieldSettings.settings).toEqual({});
    void clientCookie;
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as relationshipRoute from "@/app/api/analytics/relationships/[relationshipId]/route";
import * as relationshipsRoute from "@/app/api/analytics/relationships/route";
import * as queryRoute from "@/app/api/analytics/query/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as tablesRoute from "@/app/api/analytics/tables/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "relations-co";
const noContext = undefined as unknown;

/** Relationships between tables (decision 774): checked on the data, used by tiles, never repeating amounts. */
describeWithDatabase("analytics relationships", () => {
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
    relationshipsRoute.POST(apiRequest("/api/analytics/relationships", { method: "POST", cookie, body: { organisationId: ORG, ...payload } }), noContext);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-rel-it-"));
    const folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "invoices.csv"), "Id,Number,Customer,Total\n1,INV-1,Kererū Café,100.00\n2,INV-2,Tūī Books,50.00\n");
    fs.writeFileSync(path.join(folder, "lines.csv"), "Invoice,Amount\n1,30.00\n1,30.00\n1,40.00\n2,50.00\n");
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
    const load = async (name: string, columns: Array<{ source: string; name: string; kind: string }>) => {
      const source = await body(
        await sourcesRoute.POST(
          apiRequest("/api/analytics/sources", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name, tableName: name, fileName: `${name}.csv`, columns } }),
          noContext,
        ),
      );
      const id = source.data.source.id;
      await loadRoute.POST(apiRequest(`/api/analytics/sources/${id}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }), params({ sourceId: id }));
    };
    await load("invoices", [
      { source: "Id", name: "id", kind: "integer" },
      { source: "Number", name: "number", kind: "text" },
      { source: "Customer", name: "customer", kind: "text" },
      { source: "Total", name: "total", kind: "money" },
    ]);
    await load("lines", [
      { source: "Invoice", name: "invoice_id", kind: "integer" },
      { source: "Amount", name: "amount", kind: "money" },
    ]);
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  let relationshipId = "";
  let dashboardId = "";
  const tile = {
    id: "customers",
    title: "Sales by customer",
    visual: "table",
    width: "full",
    query: { table: "lines", groupBy: { field: "invoice.customer" }, measures: [{ label: "Sales", aggregate: "sum", field: "amount" }], filters: [], dateField: null, sort: { by: "category", direction: "asc" } },
  };

  it("saves a many-to-one relationship (bookkeepers and up) and refuses one-to-many", async () => {
    expect((await post(viewerCookie, { table: "lines", field: "invoice_id", dimension: "invoices", dimensionField: "id", name: "invoice" })).status).toBe(403);
    const backwards = await body(await post(ownerCookie, { table: "invoices", field: "id", dimension: "lines", dimensionField: "invoice_id", name: "line" }));
    expect(backwards.status).toBe(400);
    expect(backwards.data.error).toMatch(/would become 300.00/);
    const made = await body(await post(ownerCookie, { table: "lines", field: "invoice_id", dimension: "invoices", dimensionField: "id", name: "invoice" }));
    expect(made.status).toBe(201);
    expect(made.data.relationship).toMatchObject({ table: "lines", dimension: "invoices", name: "invoice" });
    expect(made.data.note).toBeNull();
    relationshipId = made.data.relationship.id;
    const listed = await body(await relationshipsRoute.GET(apiRequest(`/api/analytics/relationships?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    expect(listed.data.relationships).toHaveLength(1);
    expect((await relationshipsRoute.GET(apiRequest(`/api/analytics/relationships?organisationId=${ORG}`, { cookie: clientCookie }), noContext)).status).toBe(403);
    const tables = await body(await tablesRoute.GET(apiRequest(`/api/analytics/tables?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    const lines = tables.data.tables.find((table: { name: string }) => table.name === "lines");
    expect(lines.columns.filter((column: { related?: string }) => column.related).map((column: { name: string }) => column.name)).toEqual(["invoice.number", "invoice.customer", "invoice.total"]);
  });

  it("answers a report's tile from both tables without repeating amounts, and keeps reports using it", async () => {
    const refused = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Bad", tiles: [{ ...tile, query: { ...tile.query, measures: [{ label: "Total", aggregate: "sum", field: "invoice.total" }] } }] } }),
        noContext,
      ),
    );
    expect(refused.data.error).toMatch(/comes from a related table/);
    const made = await body(await dashboardsRoute.POST(apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Customers", tiles: [tile] } }), noContext));
    expect(made.status).toBe(201);
    dashboardId = made.data.dashboard.id;
    const answer = await body(await queryRoute.POST(apiRequest("/api/analytics/query", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, dashboardId, tileId: "customers", filters: {} } }), noContext));
    expect(answer.data.rows).toEqual([
      { category: "Kererū Café", m0: "100.00" },
      { category: "Tūī Books", m0: "50.00" },
    ]);
    const removed = await body(await relationshipRoute.DELETE(apiRequest(`/api/analytics/relationships/${relationshipId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ relationshipId })));
    expect(removed.status).toBe(409);
    expect(removed.data.error).toMatch(/used by Customers/);
    await dashboardRoute.DELETE(apiRequest(`/api/analytics/dashboards/${dashboardId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ dashboardId }));
    expect((await relationshipRoute.DELETE(apiRequest(`/api/analytics/relationships/${relationshipId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ relationshipId }))).status).toBe(200);
  });
});

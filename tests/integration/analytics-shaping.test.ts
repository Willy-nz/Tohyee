import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as foldersRoute from "@/app/api/admin/analytics-folders/route";
import * as booksRoute from "@/app/api/analytics/books/route";
import * as loadRoute from "@/app/api/analytics/sources/[sourceId]/load/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import * as shapingRoute from "@/app/api/analytics/shaping/route";
import * as previewRoute from "@/app/api/analytics/shaping/preview/route";
import * as shapeRoute from "@/app/api/analytics/shaping/[shapeId]/route";
import * as shapeLoadRoute from "@/app/api/analytics/shaping/[shapeId]/load/route";
import { closeAnalytics, queryAnalytics } from "@/lib/analytics/engine";
import { runDueLoads } from "@/lib/analytics/scheduler";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "analytics-shaping-co";
const noContext = undefined as unknown;

describeWithDatabase("analytics shaped tables", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let root: string;
  let folder: string;
  let sourceId: string;
  let shapeId: string;

  const body = async (response: Response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- route response assertions check selected fields
    data: (await response.json()) as Record<string, any>,
  });
  const exportFile = () => path.join(folder, "contacts.csv");
  const writeExport = (amount: string) => fs.writeFileSync(exportFile(), `Email,Amount\nperson@example.test,${amount}\nmissing@example.test,4.00\n`);
  const actor = () => ({ userId: owner.id, email: owner.email });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-analytics-shaping-it-"));
    folder = path.join(root, "reports");
    fs.mkdirSync(folder);
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    writeExport("10.10");
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await inOrganisation(ORG, actor(), (tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));

    const folderSet = await foldersRoute.PUT(
      apiRequest("/api/admin/analytics-folders", { method: "PUT", cookie: ownerCookie, body: { organisationId: ORG, folder } }),
      noContext,
    );
    expect(folderSet.status).toBe(200);
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("merges CSV with tohyee_contacts, previews, rebuilds on reload and preserves output on failure", async () => {
    await inOrganisation(ORG, actor(), (tx) =>
      createContact(tx, { idempotencyKey: key("contact"), name: "Person Ltd", email: "person@example.test", isCustomer: true }),
    );
    const copied = await booksRoute.POST(
      apiRequest("/api/analytics/books", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
      noContext,
    );
    expect((await body(copied)).data.run.status).toBe("ok");

    const createdSource = await body(
      await sourcesRoute.POST(
        apiRequest("/api/analytics/sources", {
          method: "POST",
          cookie: ownerCookie,
          body: {
            organisationId: ORG,
            name: "Contact export",
            tableName: "contacts_export",
            fileName: "contacts.csv",
            columns: [
              { source: "Email", name: "email", kind: "text" },
              { source: "Amount", name: "amount", kind: "text" },
            ],
          },
        }),
        noContext,
      ),
    );
    expect(createdSource.status).toBe(201);
    sourceId = createdSource.data.source.id;
    const loaded = await body(
      await loadRoute.POST(
        apiRequest(`/api/analytics/sources/${sourceId}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
        params({ sourceId }),
      ),
    );
    expect(loaded.data.run.status).toBe("ok");

    for (const tableName of ["tohyee_fake", "_tohyee_fake", 'bad"; drop table contacts_export; --']) {
      const reserved = await shapingRoute.POST(
        apiRequest("/api/analytics/shaping", {
          method: "POST",
          cookie: ownerCookie,
          body: { organisationId: ORG, name: "Reserved output", tableName, baseTable: "contacts_export", steps: [] },
        }),
        noContext,
      );
      expect(reserved.status).toBe(400);
    }

    const denied = await shapingRoute.POST(
      apiRequest("/api/analytics/shaping", {
        method: "POST",
        cookie: viewerCookie,
        body: { organisationId: ORG, name: "Denied", tableName: "denied_shape", baseTable: "contacts_export", steps: [] },
      }),
      noContext,
    );
    expect(denied.status).toBe(403);

    const steps = [
      { type: "type", column: "amount", kind: "money" },
      {
        type: "merge",
        table: "tohyee_contacts",
        join: "left",
        matches: [{ column: "email", withColumn: "email" }],
        columns: [{ column: "name", name: "contact_name" }],
      },
    ];
    const createdShape = await body(
      await shapingRoute.POST(
        apiRequest("/api/analytics/shaping", {
          method: "POST",
          cookie: ownerCookie,
          body: { organisationId: ORG, name: "Matched contacts", tableName: "matched_contacts", baseTable: "contacts_export", steps },
        }),
        noContext,
      ),
    );
    expect(createdShape.status).toBe(201);
    shapeId = createdShape.data.shape.id;
    expect(createdShape.data.run).toMatchObject({ status: "ok", rowsLoaded: "2", shapeId });
    expect(
      await queryAnalytics(ORG, "select email, amount::varchar as amount, contact_name from matched_contacts order by email"),
    ).toEqual([
      { email: "missing@example.test", amount: "4.00", contact_name: null },
      { email: "person@example.test", amount: "10.10", contact_name: "Person Ltd" },
    ]);

    const refreshedBooks = await body(
      await booksRoute.POST(
        apiRequest("/api/analytics/books", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
        noContext,
      ),
    );
    expect(refreshedBooks.data.run.status).toBe("ok");
    const booksTriggeredShape = await inOrganisation(ORG, actor(), (tx) =>
      tx.query<{ status: string; trigger: string }>(
        "select status, trigger from analytics_load_runs where shaped_table_id = $1 order by started_at desc, id desc limit 1",
        [shapeId],
      ),
    );
    expect(booksTriggeredShape.rows[0]).toEqual({ status: "ok", trigger: "manual" });

    const preview = await body(
      await previewRoute.POST(
        apiRequest("/api/analytics/shaping/preview", {
          method: "POST",
          cookie: viewerCookie,
          body: { organisationId: ORG, baseTable: "contacts_export", steps, throughStep: 1 },
        }),
        noContext,
      ),
    );
    expect(preview.status).toBe(200);
    expect(preview.data.rows).toHaveLength(2);

    const injection = await body(
      await previewRoute.POST(
        apiRequest("/api/analytics/shaping/preview", {
          method: "POST",
          cookie: viewerCookie,
          body: {
            organisationId: ORG,
            baseTable: "contacts_export",
            steps: [{ type: "filter", column: 'email"; drop table contacts_export; --', test: "is", value: "person@example.test" }],
          },
        }),
        noContext,
      ),
    );
    expect(injection.status).toBe(400);
    expect(await queryAnalytics(ORG, "select count(*)::int as n from contacts_export")).toEqual([{ n: 2 }]);

    const onDemand = await body(
      await shapeLoadRoute.POST(
        apiRequest(`/api/analytics/shaping/${shapeId}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
        params({ shapeId }),
      ),
    );
    expect(onDemand.data.run.status).toBe("ok");

    writeExport("not money");
    const rawReload = await body(
      await loadRoute.POST(
        apiRequest(`/api/analytics/sources/${sourceId}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
        params({ sourceId }),
      ),
    );
    expect(rawReload.data.run.status).toBe("ok");
    expect(await queryAnalytics(ORG, "select amount::varchar as amount from matched_contacts where email = 'person@example.test'")).toEqual([{ amount: "10.10" }]);
    const latestShapeRun = await inOrganisation(ORG, actor(), (tx) =>
      tx.query<{ status: string; error: string }>(
        "select status, error from analytics_load_runs where shaped_table_id = $1 order by started_at desc, id desc limit 1",
        [shapeId],
      ),
    );
    expect(latestShapeRun.rows[0].status).toBe("failed");
    expect(latestShapeRun.rows[0].error).toMatch(/not money/i);

    writeExport("20.25");
    const retry = await loadRoute.POST(
      apiRequest(`/api/analytics/sources/${sourceId}/load`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
      params({ sourceId }),
    );
    expect(retry.status).toBe(200);
    expect(await queryAnalytics(ORG, "select amount::varchar as amount from matched_contacts where email = 'person@example.test'")).toEqual([{ amount: "20.25" }]);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(18, 0, 0, 0);
    const scheduled = await runDueLoads(tomorrow);
    expect(scheduled.map((run) => [run.sourceName, run.status, run.trigger])).toEqual([
      ["Books and CRM", "ok", "schedule"],
      ["Contact export", "ok", "schedule"],
    ]);
    await inOrganisation(ORG, actor(), (tx) =>
      tx.query("update analytics_load_runs set started_at = $1 where id = any($2::bigint[])", [tomorrow, scheduled.map((run) => run.id)]),
    );
    const listed = await body(
      await shapingRoute.GET(apiRequest(`/api/analytics/shaping?organisationId=${ORG}`, { cookie: viewerCookie }), noContext),
    );
    expect(listed.data.shapes[0].lastLoad).toMatchObject({ status: "ok", trigger: "schedule", shapeId });
    expect(await queryAnalytics(ORG, "select amount::varchar as amount from matched_contacts where email = 'person@example.test'")).toEqual([{ amount: "20.25" }]);

    const sourceClash = await sourcesRoute.POST(
      apiRequest("/api/analytics/sources", {
        method: "POST",
        cookie: ownerCookie,
        body: {
          organisationId: ORG,
          name: "Clashing source",
          tableName: "matched_contacts",
          fileName: "contacts.csv",
          columns: [{ source: "Email", name: "email", kind: "text" }],
        },
      }),
      noContext,
    );
    expect(sourceClash.status).toBe(409);

    const removed = await shapeRoute.DELETE(
      apiRequest(`/api/analytics/shaping/${shapeId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }),
      params({ shapeId }),
    );
    expect(removed.status).toBe(200);
    expect(await queryAnalytics(ORG, "select count(*)::int as n from information_schema.tables where table_name = 'matched_contacts'")).toEqual([{ n: 0 }]);
  });
});

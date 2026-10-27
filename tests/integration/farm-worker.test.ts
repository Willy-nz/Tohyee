import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as aiTokensRoute from "@/app/api/ai/tokens/route";
import * as keysRoute from "@/app/api/farming/app-keys/route";
import * as farmAppReadingsRoute from "@/app/api/farm-apps/v1/pasture/readings/route";
import * as benchmarksRoute from "@/app/api/farming/benchmarks/route";
import * as calendarRoute from "@/app/api/farming/calendar/route";
import * as farmsRoute from "@/app/api/farming/farms/route";
import * as grazingsRoute from "@/app/api/farming/farms/[farmId]/grazings/route";
import * as readingsRoute from "@/app/api/farming/farms/[farmId]/pasture/readings/route";
import * as pastureRoute from "@/app/api/farming/farms/[farmId]/pasture/route";
import * as plansRoute from "@/app/api/farming/farms/[farmId]/plans/route";
import * as samplesRoute from "@/app/api/farming/farms/[farmId]/soil-samples/route";
import * as supplementsRoute from "@/app/api/farming/farms/[farmId]/supplements/route";
import * as grazingRoute from "@/app/api/farming/grazings/[grazingId]/route";
import * as homeRoute from "@/app/api/farming/home/route";
import * as readingRoute from "@/app/api/farming/pasture-readings/[readingId]/route";
import * as notebookRoute from "@/app/api/farm-notebook/route";
import * as contactsRoute from "@/app/api/contacts/route";
import * as journalsRoute from "@/app/api/ledger/journals/route";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import * as balanceSheetRoute from "@/app/api/reports/balance-sheet/route";
import * as exportRoute from "@/app/api/reports/export/route";
import * as importExportRoute from "@/app/api/import/export/route";
import * as searchRoute from "@/app/api/search/route";
import { farmWorkAllows, roleAtLeast } from "@/lib/auth/roles";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addGrazing, addReading } from "@/lib/farming/pasture";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-worker";
type Handler = (request: Request, context: never) => Promise<Response>;

describe("the farm staff role", () => {
  it("does field work and nothing of the books", () => {
    expect(farmWorkAllows("farm_worker", "read")).toBe(true);
    expect(farmWorkAllows("farm_worker", "record")).toBe(true);
    expect(farmWorkAllows("viewer", "record")).toBe(false);
    expect(farmWorkAllows("bookkeeper", "record")).toBe(true);
    expect(farmWorkAllows("sales_rep", "read")).toBe(false);
    expect(farmWorkAllows("report_viewer", "read")).toBe(false);
    // Ranked below every other role, so every books route (and those that admit sales roles) refuses it.
    for (const minimum of ["viewer", "report_viewer", "sales_rep"] as const) expect(roleAtLeast("farm_worker", minimum)).toBe(false);
  });
});

/**
 * Farm staff (#447, decision 904; William's acceptance check): an assigned
 * farm worker can log field activity but can't read or post the books or
 * reach another farm's records. Enforced on the server, not by menus.
 */
describeWithDatabase("farm staff record field work on their farms only", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let newcomer: SessionUser;
  let viewer: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("worker-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("worker-staff@example.com", { displayName: "Hemi" });
    newcomer = await createTestUser("worker-new@example.com", { displayName: "Kiri" });
    viewer = await createTestUser("worker-viewer@example.com", { displayName: "Wiremu" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'farm_worker'), ($1, $4, 'viewer')", [ORG, worker.id, newcomer.id, viewer.id]);
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.homePaddock = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "10" }))).id;
    w.runoffPaddock = (await run((tx) => addPaddock(tx, { farmId: w.runoff, name: "R1", effectiveHa: "20" }))).id;
    w.runoffReading = (await run((tx) => addReading(tx, { paddockId: w.runoffPaddock, measuredOn: "2026-10-01", cover: 2100, method: "plate_meter" }))).id;
    w.runoffGrazing = (await run((tx) => addGrazing(tx, { paddockId: w.runoffPaddock, mob: "Heifers", inOn: "2026-10-02" }))).id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, path: string, context: Record<string, string> = {}, method = "GET", body?: Record<string, unknown>) => {
    const response = await handler(
      apiRequest(method === "GET" || method === "DELETE" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }),
      params(context) as never,
    );
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };

  it("an owner makes someone farm staff from People and roles", async () => {
    const changed = await call(owner, memberRoute.PATCH as Handler, `/api/organisations/${ORG}/members/${worker.id}`, { organisationId: ORG, userId: worker.id }, "PATCH", { role: "farm_worker" });
    expect(changed.status).toBe(200);
    expect((await coreQuery<{ role: string }>("select role from organisation_members where organisation_id = $1 and user_id = $2", [ORG, worker.id])).rows[0].role).toBe("farm_worker");
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
  });

  it("logs field activity on their farm", async () => {
    const farms = await call(worker, farmsRoute.GET as Handler, "/api/farming/farms");
    expect(farms.status).toBe(200);
    expect((farms.body.farms as Array<{ name: string }>).map((farm) => farm.name)).toEqual(["Home farm"]);
    const reading = await call(worker, readingsRoute.POST as Handler, `/api/farming/farms/${w.home}/pasture/readings`, { farmId: w.home }, "POST", { paddockId: w.homePaddock, measuredOn: "2026-10-20", cover: 2450, method: "plate_meter" });
    expect(reading.status).toBe(201);
    expect(reading.body.reading).toMatchObject({ createdByEmail: "worker-staff@example.com", createdByName: "Hemi" });
    const grazing = await call(worker, grazingsRoute.POST as Handler, `/api/farming/farms/${w.home}/grazings`, { farmId: w.home }, "POST", { paddockId: w.homePaddock, mob: "Milkers", head: 300, inOn: "2026-10-20" });
    expect(grazing.status).toBe(201);
    const out = await call(worker, grazingRoute.PATCH as Handler, `/api/farming/grazings/${(grazing.body.grazing as { id: string }).id}`, { grazingId: (grazing.body.grazing as { id: string }).id }, "PATCH", { outOn: "2026-10-21", postCover: 1600 });
    expect(out.status).toBe(200);
    expect((await call(worker, supplementsRoute.POST as Handler, `/api/farming/farms/${w.home}/supplements`, { farmId: w.home }, "POST", { fedOn: "2026-10-20", feed: "Silage", quantity: "800", unit: "kg_dm" })).status).toBe(201);
    expect((await call(worker, samplesRoute.POST as Handler, `/api/farming/farms/${w.home}/soil-samples`, { farmId: w.home }, "POST", { paddockId: w.homePaddock, takenOn: "2026-10-20" })).status).toBe(201);
    expect((await call(worker, pastureRoute.GET as Handler, `/api/farming/farms/${w.home}/pasture?onDate=2026-10-21`, { farmId: w.home })).status).toBe(200);
    expect((await call(worker, calendarRoute.GET as Handler, "/api/farming/calendar?from=2026-10-01&to=2026-10-31")).status).toBe(200);
  });

  it("can't reach another farm's records", async () => {
    expect((await call(worker, readingsRoute.GET as Handler, `/api/farming/farms/${w.runoff}/pasture/readings`, { farmId: w.runoff })).status).toBe(404);
    expect((await call(worker, readingsRoute.POST as Handler, `/api/farming/farms/${w.runoff}/pasture/readings`, { farmId: w.runoff }, "POST", { paddockId: w.runoffPaddock, measuredOn: "2026-10-20", cover: 2000, method: "visual" })).status).toBe(404);
    // Another farm's paddock sent through their own farm: not found, nothing saved.
    expect((await call(worker, readingsRoute.POST as Handler, `/api/farming/farms/${w.home}/pasture/readings`, { farmId: w.home }, "POST", { paddockId: w.runoffPaddock, measuredOn: "2026-10-20", cover: 2000, method: "visual" })).status).toBe(404);
    expect((await call(worker, grazingRoute.PATCH as Handler, `/api/farming/grazings/${w.runoffGrazing}`, { grazingId: w.runoffGrazing }, "PATCH", { outOn: "2026-10-21" })).status).toBe(404);
    expect((await call(worker, samplesRoute.POST as Handler, `/api/farming/farms/${w.runoff}/soil-samples`, { farmId: w.runoff }, "POST", { paddockId: w.runoffPaddock, takenOn: "2026-10-20" })).status).toBe(404);
    // Unassigned farm staff see no farms.
    expect(((await call(newcomer, farmsRoute.GET as Handler, "/api/farming/farms")).body.farms as unknown[]).length).toBe(0);
  });

  it("can't read or post the books, or anything beyond field work", async () => {
    const refused: Array<[string, Handler, string, Record<string, string>?, string?, Record<string, unknown>?]> = [
      ["journals", journalsRoute.GET as Handler, "/api/ledger/journals"],
      ["posting a journal", journalsRoute.POST as Handler, "/api/ledger/journals", {}, "POST", { date: "2026-10-20", lines: [] }],
      ["contacts", contactsRoute.GET as Handler, "/api/contacts"],
      ["the balance sheet", balanceSheetRoute.GET as Handler, "/api/reports/balance-sheet?asAt=2026-10-20"],
      ["a report export", exportRoute.POST as Handler, "/api/reports/export", {}, "POST", { format: "csv", data: { report: "aged-payables", title: "Aged payables", organisationName: "Farm", period: "October", filters: [], producedAt: "2026-10-20T00:00:00Z", tables: [{ columns: ["Account"], rows: [] }] } }],
      ["a contacts export", importExportRoute.GET as Handler, "/api/import/export?kind=contacts"],
      ["search", searchRoute.GET as Handler, "/api/search?q=milk"],
      ["the organisation's settings", settingsRoute.GET as Handler, `/api/organisations/${ORG}/settings`, { organisationId: ORG }],
      ["farm Home (money)", homeRoute.GET as Handler, "/api/farming/home"],
      ["benchmarks", benchmarksRoute.GET as Handler, "/api/farming/benchmarks"],
      ["fertiliser plans (costs)", plansRoute.GET as Handler, `/api/farming/farms/${w.home}/plans`, { farmId: w.home }],
      ["the farm notebook", notebookRoute.GET as Handler, "/api/farm-notebook"],
      ["an AI key", aiTokensRoute.POST as Handler, "/api/ai/tokens", {}, "POST", { name: "Mine", accessLevel: "read" }],
    ];
    for (const [what, handler, path, context, method, body] of refused) {
      const answer = await call(worker, handler, path, context ?? {}, method ?? "GET", body);
      expect([what, answer.status]).toEqual([what, 403]);
    }
    // Removing a record is a correction for a bookkeeper.
    const own = (await call(worker, readingsRoute.GET as Handler, `/api/farming/farms/${w.home}/pasture/readings`, { farmId: w.home })).body.readings as Array<{ id: string }>;
    expect((await call(worker, readingRoute.DELETE as Handler, `/api/farming/pasture-readings/${own[0].id}`, { readingId: own[0].id }, "DELETE")).status).toBe(403);
  });

  it("a farm app key works for their farm only, and never reaches the books", async () => {
    const made = await keysRoute.POST(apiRequest("/api/farming/app-keys", { method: "POST", cookie: await sessionCookieFor(worker), body: { organisationId: ORG, name: "Plate meter", scopes: ["read_pasture", "record_pasture"] } }), undefined as unknown);
    expect(made.status).toBe(201);
    const key = ((await made.json()) as { key: string }).key;
    const appCall = async (farmId: string) =>
      (await farmAppReadingsRoute.GET(new Request(`http://tohyee.test/api/farm-apps/v1/pasture/readings?farmId=${farmId}`, { headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve({}) } as never)).status;
    expect(await appCall(w.home)).toBe(200);
    expect(await appCall(w.runoff)).toBe(404);
  });

  it("other roles are as before: a viewer reads but can't record", async () => {
    expect((await call(viewer, readingsRoute.GET as Handler, `/api/farming/farms/${w.home}/pasture/readings`, { farmId: w.home })).status).not.toBe(403);
    expect((await call(viewer, readingsRoute.POST as Handler, `/api/farming/farms/${w.home}/pasture/readings`, { farmId: w.home }, "POST", { paddockId: w.homePaddock, measuredOn: "2026-10-22", cover: 2000, method: "visual" })).status).toBe(403);
  });
});

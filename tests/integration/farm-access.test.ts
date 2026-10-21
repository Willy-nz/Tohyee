import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as notebookRoute from "@/app/api/farm-notebook/route";
import * as memberFarmsRoute from "@/app/api/farming/member-farms/route";
import * as farmsRoute from "@/app/api/farming/farms/route";
import * as grazingsRoute from "@/app/api/farming/farms/[farmId]/grazings/route";
import * as importRoute from "@/app/api/farming/farms/[farmId]/import/route";
import * as paddocksRoute from "@/app/api/farming/farms/[farmId]/paddocks/route";
import * as readingsImportRoute from "@/app/api/farming/farms/[farmId]/pasture/readings/import/route";
import * as readingsRoute from "@/app/api/farming/farms/[farmId]/pasture/readings/route";
import * as pastureRoute from "@/app/api/farming/farms/[farmId]/pasture/route";
import * as plansRoute from "@/app/api/farming/farms/[farmId]/plans/route";
import * as samplesRoute from "@/app/api/farming/farms/[farmId]/soil-samples/route";
import * as soilSummaryRoute from "@/app/api/farming/farms/[farmId]/soil-summary/route";
import * as soilImportRoute from "@/app/api/farming/farms/[farmId]/soil-tests/import/route";
import * as soilTestsRoute from "@/app/api/farming/farms/[farmId]/soil-tests/route";
import * as supplementsRoute from "@/app/api/farming/farms/[farmId]/supplements/route";
import * as grazingRoute from "@/app/api/farming/grazings/[grazingId]/route";
import * as homeRoute from "@/app/api/farming/home/route";
import * as boundaryRoute from "@/app/api/farming/paddocks/[paddockId]/boundary/route";
import * as historyRoute from "@/app/api/farming/paddocks/[paddockId]/history/route";
import * as paddockPastureRoute from "@/app/api/farming/paddocks/[paddockId]/pasture/route";
import * as paddockRoute from "@/app/api/farming/paddocks/[paddockId]/route";
import * as readingRoute from "@/app/api/farming/pasture-readings/[readingId]/route";
import * as applicationsRoute from "@/app/api/farming/plans/[planId]/applications/route";
import * as planRoute from "@/app/api/farming/plans/[planId]/route";
import * as soilSampleRoute from "@/app/api/farming/soil-samples/[sampleId]/route";
import * as soilTestRoute from "@/app/api/farming/soil-tests/[soilTestId]/route";
import * as supplementRoute from "@/app/api/farming/supplements/[supplementId]/route";
import { FARM_READ_TOOLS } from "@/lib/ai/farm-tools";
import { hiddenFarmTables } from "@/lib/analytics/farm-access";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { farmScope, setMemberFarmAccess } from "@/lib/farming/access";
import { addCalendarItem, farmCalendar, shareCalendarItem } from "@/lib/farming/calendar";
import { createPlan } from "@/lib/farming/fertiliser";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addGrazing, addReading, addSupplement } from "@/lib/farming/pasture";
import { addSoilTest } from "@/lib/farming/soil";
import { addSoilSample } from "@/lib/farming/soil-samples";
import { farmsWithPaddocks } from "@/lib/farm-apps/api";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import { resolveRecord } from "@/lib/records/extras";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-access";

type Handler = (request: Request, context: never) => Promise<Response>;

/**
 * Farm staff see and record only for their farms (#390, FMA1-FMA8, decision
 * 744; Jess, 21 October 2026). Every farm-scoped route is asked for another
 * farm's records by a member assigned only to Home farm.
 */
describeWithDatabase("farms each member works on", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let newcomer: SessionUser;
  let accountant: SessionUser;
  let admin: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("access-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("access-staff@example.com", { displayName: "Mere" });
    newcomer = await createTestUser("access-new@example.com", { displayName: "Tama" });
    accountant = await createTestUser("access-accountant@example.com", { displayName: "Aroha" });
    admin = await createTestUser("access-admin@example.com", { displayName: "Rangi" });
    await createTestOrganisation(owner, ORG);
    for (const [user, role] of [[staff, "bookkeeper"], [newcomer, "viewer"], [accountant, "bookkeeper"], [admin, "admin"]] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.homePaddock = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "10" }))).id;
    w.paddock = (await run((tx) => addPaddock(tx, { farmId: w.runoff, name: "1", effectiveHa: "20" }))).id;
    await run((tx) => addReading(tx, { paddockId: w.homePaddock, measuredOn: "2026-10-01", cover: 2400, method: "plate_meter" }));
    w.reading = (await run((tx) => addReading(tx, { paddockId: w.paddock, measuredOn: "2026-10-01", cover: 2100, method: "plate_meter" }))).id;
    w.grazing = (await run((tx) => addGrazing(tx, { paddockId: w.paddock, mob: "Heifers", inOn: "2026-10-02" }))).id;
    w.supplement = (await run((tx) => addSupplement(tx, { farmId: w.runoff, fedOn: "2026-10-03", feed: "Hay", quantity: "10", unit: "kg_dm" }))).id;
    w.soilTest = (await run((tx) => addSoilTest(tx, { paddockId: w.paddock, sampledOn: "2026-08-15", results: [{ measure: "Olsen P", value: "28", unit: "mg/L" }] }))).id;
    w.sample = (await run((tx) => addSoilSample(tx, { paddockId: w.paddock, takenOn: "2026-08-15" }))).id;
    w.plan = (await run((tx) => createPlan(tx, { farmId: w.runoff, name: "Runoff 2026-27" }))).id;
    // Mere works on Home farm; Aroha (the accountant, a bookkeeper) on all farms; Tama isn't assigned yet.
    await run((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "bookkeeper", access: "farms", farmIds: [w.home] }));
    await run((tx) => setMemberFarmAccess(tx, { userId: accountant.id, role: "bookkeeper", access: "all" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, path: string, context: Record<string, string> = {}, method = "GET", body?: Record<string, unknown>) =>
    handler(
      apiRequest(method === "GET" || method === "DELETE" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path, {
        method,
        cookie: await sessionCookieFor(user),
        body: body ? { organisationId: ORG, ...body } : undefined,
      }),
      params(context) as never,
    );

  describe("FMA3 another farm's records are not found, through every farm-scoped route", () => {
    const cases: Array<[string, () => [Handler, string, Record<string, string>, string?, Record<string, unknown>?]]> = [
      ["paddocks", () => [paddocksRoute.GET as Handler, `/api/farming/farms/${w.runoff}/paddocks`, { farmId: w.runoff }]],
      ["adding a paddock", () => [paddocksRoute.POST as Handler, `/api/farming/farms/${w.runoff}/paddocks`, { farmId: w.runoff }, "POST", { name: "2" }]],
      ["pasture cover", () => [pastureRoute.GET as Handler, `/api/farming/farms/${w.runoff}/pasture?onDate=2026-10-21`, { farmId: w.runoff }]],
      ["pasture readings", () => [readingsRoute.GET as Handler, `/api/farming/farms/${w.runoff}/pasture/readings`, { farmId: w.runoff }]],
      ["adding a reading", () => [readingsRoute.POST as Handler, `/api/farming/farms/${w.runoff}/pasture/readings`, { farmId: w.runoff }, "POST", { paddockId: w.paddock, measuredOn: "2026-10-20", cover: 2000, method: "visual" }]],
      ["importing readings", () => [readingsImportRoute.POST as Handler, `/api/farming/farms/${w.runoff}/pasture/readings/import`, { farmId: w.runoff }, "POST", { fileName: "r.csv", content: "Paddock,Date,Cover\n1,2026-10-20,2000\n", preview: true }]],
      ["grazings", () => [grazingsRoute.GET as Handler, `/api/farming/farms/${w.runoff}/grazings`, { farmId: w.runoff }]],
      ["supplements", () => [supplementsRoute.GET as Handler, `/api/farming/farms/${w.runoff}/supplements`, { farmId: w.runoff }]],
      ["soil tests", () => [soilTestsRoute.GET as Handler, `/api/farming/farms/${w.runoff}/soil-tests`, { farmId: w.runoff }]],
      ["adding a soil test", () => [soilTestsRoute.POST as Handler, `/api/farming/farms/${w.runoff}/soil-tests`, { farmId: w.runoff }, "POST", { paddockId: w.paddock, sampledOn: "2026-10-01", results: [{ measure: "pH", value: "6" }] }]],
      ["importing soil tests", () => [soilImportRoute.POST as Handler, `/api/farming/farms/${w.runoff}/soil-tests/import`, { farmId: w.runoff }, "POST", { fileName: "s.csv", content: "Paddock,Date,pH\n1,2026-10-01,6\n", preview: true }]],
      ["the soil summary", () => [soilSummaryRoute.GET as Handler, `/api/farming/farms/${w.runoff}/soil-summary`, { farmId: w.runoff }]],
      ["soil samples", () => [samplesRoute.GET as Handler, `/api/farming/farms/${w.runoff}/soil-samples`, { farmId: w.runoff }]],
      ["fertiliser plans", () => [plansRoute.GET as Handler, `/api/farming/farms/${w.runoff}/plans`, { farmId: w.runoff }]],
      ["a plan", () => [planRoute.GET as Handler, `/api/farming/plans/${w.plan}`, { planId: w.plan }]],
      ["recording an application", () => [applicationsRoute.POST as Handler, `/api/farming/plans/${w.plan}/applications`, { planId: w.plan }, "POST", { paddockId: w.paddock, productId: "1", appliedOn: "2026-10-01", tonnes: "1" }]],
      ["a boundary import", () => [importRoute.POST as Handler, `/api/farming/farms/${w.runoff}/import`, { farmId: w.runoff }, "POST", { fileName: "p.geojson", content: '{"type":"FeatureCollection","features":[]}', preview: true }]],
      ["a paddock", () => [paddockRoute.GET as Handler, `/api/farming/paddocks/${w.paddock}`, { paddockId: w.paddock }]],
      ["renaming a paddock", () => [paddockRoute.PATCH as Handler, `/api/farming/paddocks/${w.paddock}`, { paddockId: w.paddock }, "PATCH", { name: "Renamed" }]],
      ["a new boundary", () => [boundaryRoute.POST as Handler, `/api/farming/paddocks/${w.paddock}/boundary`, { paddockId: w.paddock }, "POST", { geometry: null }]],
      ["a paddock's soil and fertiliser history", () => [historyRoute.GET as Handler, `/api/farming/paddocks/${w.paddock}/history`, { paddockId: w.paddock }]],
      ["a paddock's pasture", () => [paddockPastureRoute.GET as Handler, `/api/farming/paddocks/${w.paddock}/pasture`, { paddockId: w.paddock }]],
      ["removing a reading", () => [readingRoute.DELETE as Handler, `/api/farming/pasture-readings/${w.reading}`, { readingId: w.reading }, "DELETE"]],
      ["closing a grazing", () => [grazingRoute.PATCH as Handler, `/api/farming/grazings/${w.grazing}`, { grazingId: w.grazing }, "PATCH", { outOn: "2026-10-05" }]],
      ["removing a supplement", () => [supplementRoute.DELETE as Handler, `/api/farming/supplements/${w.supplement}`, { supplementId: w.supplement }, "DELETE"]],
      ["removing a soil test", () => [soilTestRoute.DELETE as Handler, `/api/farming/soil-tests/${w.soilTest}`, { soilTestId: w.soilTest }, "DELETE"]],
      ["removing a soil sample", () => [soilSampleRoute.DELETE as Handler, `/api/farming/soil-samples/${w.sample}`, { sampleId: w.sample }, "DELETE"]],
    ];
    it.each(cases)("%s", async (_, made) => {
      const [handler, path, context, method, body] = made();
      const response = await call(staff, handler, path, context, method ?? "GET", body);
      expect(response.status).toBe(404);
      // Reads work for someone who sees every farm, so the 404 is the farm rule, not the request.
      if (!method) expect((await call(accountant, handler, path, context)).status).toBe(200);
    });
  });

  it("FMA3 the same routes work for Mere's own farm, and for everyone who sees all farms", async () => {
    expect((await call(staff, paddocksRoute.GET as Handler, `/api/farming/farms/${w.home}/paddocks`, { farmId: w.home })).status).toBe(200);
    expect((await call(staff, pastureRoute.GET as Handler, `/api/farming/farms/${w.home}/pasture?onDate=2026-10-21`, { farmId: w.home })).status).toBe(200);
    for (const user of [owner, admin, accountant]) {
      expect((await call(user, paddocksRoute.GET as Handler, `/api/farming/farms/${w.runoff}/paddocks`, { farmId: w.runoff })).status).toBe(200);
    }
  });

  it("FMA1 the farm list: Mere sees Home farm, Tama (not assigned) none, owners, admins and all-farms members both", async () => {
    const names = async (user: SessionUser) => ((await (await call(user, farmsRoute.GET as Handler, "/api/farming/farms")).json()) as { farms: Array<{ name: string }> }).farms.map((farm) => farm.name);
    expect(await names(staff)).toEqual(["Home farm"]);
    expect(await names(newcomer)).toEqual([]);
    for (const user of [owner, admin, accountant]) expect(await names(user)).toEqual(["Home farm", "Runoff"]);
    // A member who sees only some farms can't add one (they couldn't see it).
    expect((await call(staff, farmsRoute.POST as Handler, "/api/farming/farms", {}, "POST", { name: "Hill" })).status).toBe(403);
  });

  it("FMA4 Home's farm cards, farm apps and AI tools follow the same farms", async () => {
    const home = (await (await call(staff, homeRoute.GET as Handler, "/api/farming/home")).json()) as { pasture: Array<{ farmName: string }> | null; notebook: unknown };
    expect(home.pasture?.map((card) => card.farmName)).toEqual(["Home farm"]);
    expect(home.notebook).toBeNull();
    const apps = await as(staff)((tx) => farmsWithPaddocks(tx));
    expect(apps.farms.map((farm) => farm.name)).toEqual(["Home farm"]);
    const tool = FARM_READ_TOOLS.find((entry) => entry.name === "list_farms_and_paddocks")!;
    const listed = (await as(staff)((tx) => tool.run(tx, {}, { role: "bookkeeper", organisationId: ORG, source: "test" }))) as { farms: Array<{ name: string }> };
    expect(listed.farms.map((farm) => farm.name)).toEqual(["Home farm"]);
  });

  it("FMA5 the farm notebook and Analytics' farm tables need all farms; a soil test's files go with its farm", async () => {
    expect((await call(staff, notebookRoute.GET as Handler, "/api/farm-notebook")).status).toBe(403);
    expect((await call(accountant, notebookRoute.GET as Handler, "/api/farm-notebook")).status).toBe(200);
    const hidden = await as(staff)((tx) => hiddenFarmTables(tx));
    expect(hidden?.has("tohyee_farm_paddocks")).toBe(true);
    expect(hidden?.has("tohyee_journal_lines")).toBe(false);
    expect(await as(accountant)((tx) => hiddenFarmTables(tx))).toBeNull();
    await expect(as(staff)((tx) => resolveRecord(tx, "soil-test", w.soilTest))).rejects.toThrow("Soil test not found.");
    await expect(as(accountant)((tx) => resolveRecord(tx, "soil-test", w.soilTest))).resolves.toMatchObject({ recordType: "soil_test" });
  });

  it("FMA6 the farm calendar: items others share show only for farms you work on; your own always show", async () => {
    const run = as(owner);
    const forRunoff = await run((tx) => addCalendarItem(tx, { date: "2026-11-03", title: "Runoff fencing", kind: "contractor", farmId: w.runoff }));
    const noFarm = await run((tx) => addCalendarItem(tx, { date: "2026-11-04", title: "Discussion group", kind: "meeting" }));
    const forHome = await run((tx) => addCalendarItem(tx, { date: "2026-11-05", title: "Home TB test", kind: "animal_health", farmId: w.home }));
    for (const item of [forRunoff, noFarm, forHome]) await run((tx) => shareCalendarItem(tx, item.id, true));
    const seen = await as(staff)((tx) => farmCalendar(tx, { from: "2026-11-01", to: "2026-11-30" }));
    expect(seen.items.map((item) => item.title)).toEqual(["Discussion group", "Home TB test"]);
    await expect(as(staff)((tx) => addCalendarItem(tx, { date: "2026-11-06", title: "Mine", farmId: w.runoff }))).rejects.toThrow("Farm not found.");
    const own = await as(staff)((tx) => addCalendarItem(tx, { date: "2026-11-06", title: "Mine", farmId: w.home }));
    expect(own.farmName).toBe("Home farm");
    // The owner still sees everything, including the private calendar rules (FC1) unchanged.
    expect((await run((tx) => farmCalendar(tx, { from: "2026-11-01", to: "2026-11-30" }))).items.map((item) => item.title)).toEqual(["Runoff fencing", "Discussion group", "Home TB test"]);
  });

  it("FMA2 only owners and admins choose; owners and admins can't be limited; with one farm everyone sees it", async () => {
    expect((await call(staff, memberFarmsRoute.PUT as Handler, "/api/farming/member-farms", {}, "PUT", { userId: newcomer.id, access: "all" })).status).toBe(403);
    expect((await call(admin, memberFarmsRoute.PUT as Handler, "/api/farming/member-farms", {}, "PUT", { userId: owner.id, access: "farms", farmIds: [w.home] })).status).toBe(400);
    const set = await call(admin, memberFarmsRoute.PUT as Handler, "/api/farming/member-farms", {}, "PUT", { userId: newcomer.id, access: "farms", farmIds: [w.runoff] });
    expect(set.status).toBe(200);
    expect(await as(newcomer)((tx) => farmScope(tx))).toEqual({ all: false, farmIds: new Set([w.runoff]) });
    const listed = (await (await call(admin, memberFarmsRoute.GET as Handler, "/api/farming/member-farms")).json()) as { keptApart: boolean; access: Array<{ userId: string; access: string }> };
    expect(listed.keptApart).toBe(true);
    expect(listed.access.find((entry) => entry.userId === staff.id)?.access).toBe("farms");
    // A second organisation with one farm: nothing to keep apart.
    await createTestOrganisation(owner, "farm-access-one");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", ["farm-access-one", newcomer.id]);
    const one = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation("farm-access-one", { userId: user.id, email: user.email }, work);
    await one(owner, (tx) => setFarmingEnabled(tx, { enabled: true }));
    await one(owner, (tx) => saveFarm(tx, { name: "Only farm" }));
    expect(await one(newcomer, (tx) => farmScope(tx))).toEqual({ all: true });
  });

  it("FMA7 someone who leaves takes their farm choices with them", async () => {
    const response = await memberRoute.DELETE(
      apiRequest(`/api/organisations/${ORG}/members/${staff.id}`, { method: "DELETE", cookie: await sessionCookieFor(owner) }),
      params({ organisationId: ORG, userId: staff.id }),
    );
    expect(response.status).toBe(200);
    const left = await as(owner)((tx) => tx.query("select 1 from farm_member_scopes where user_id = $1", [staff.id]));
    expect(left.rowCount).toBe(0);
  });
});

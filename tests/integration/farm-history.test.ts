import { afterAll, beforeAll, expect, it } from "vitest";
import * as lastFarmRoute from "@/app/api/farming/last-farm/route";
import * as grazingsRoute from "@/app/api/farming/farms/[farmId]/grazings/route";
import * as readingsRoute from "@/app/api/farming/farms/[farmId]/pasture/readings/route";
import * as supplementsRoute from "@/app/api/farming/farms/[farmId]/supplements/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { lastFarm, rememberFarm } from "@/lib/farming/last-farm";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addGrazing, addReading, addSupplement, listGrazings, listReadings, listSupplements, pastureSummary } from "@/lib/farming/pasture";
import { farmCover, growthBetween, type Reading } from "@/lib/farming/pasture-rules";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-history";

type Handler = (request: Request, context: never) => Promise<Response>;

/**
 * Farm histories a page at a time, summaries that don't depend on the page,
 * the farm each person last used, and records that can't land on the wrong
 * farm (#447, decisions 900-902; acceptance checks from William's review).
 */
describeWithDatabase("farm histories and choosing a farm", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;
  const paddockIds: string[] = [];
  const DAYS = 60;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("history-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("history-staff@example.com", { displayName: "Mere" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, staff.id]);
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    for (const name of ["1", "2", "3", "4"]) paddockIds.push((await run((tx) => addPaddock(tx, { farmId: w.home, name, effectiveHa: "10" }))).id);
    w.runoffPaddock = (await run((tx) => addPaddock(tx, { farmId: w.runoff, name: "R1", effectiveHa: "20" }))).id;
    // A long history: a farm walk every day for 60 days (240 readings), a grazing every 5 days, feed every day.
    await run(async (tx) => {
      for (let day = 0; day < DAYS; day++) {
        const date = new Date(Date.UTC(2026, 7, 1 + day)).toISOString().slice(0, 10);
        for (const [index, paddockId] of paddockIds.entries()) await addReading(tx, { paddockId, measuredOn: date, cover: 1800 + day * 10 + index * 50, method: "plate_meter" });
        if (day % 5 === 0) {
          const out = new Date(Date.UTC(2026, 7, 2 + day)).toISOString().slice(0, 10);
          await addGrazing(tx, { paddockId: paddockIds[(day / 5) % 4], mob: "Milkers", head: 300, inOn: date, outOn: day === 55 ? null : out, preCover: 2600, postCover: 1600 });
        }
        await addSupplement(tx, { farmId: w.home, fedOn: date, feed: "Silage", quantity: "1000", unit: "kg_dm" });
      }
    });
    await run((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "bookkeeper", access: "farms", farmIds: [w.home] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, path: string, context: Record<string, string> = {}, method = "GET", body?: Record<string, unknown>) => {
    const response = await handler(
      apiRequest(method === "GET" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }),
      params(context) as never,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("large histories load in bounded pages, newest first, with no repeats or gaps", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { status: number; body: Record<string, unknown> } = await call(owner, readingsRoute.GET as Handler, `/api/farming/farms/${w.home}/pasture/readings?limit=50${cursor ? `&cursor=${cursor}` : ""}`, { farmId: w.home });
      expect(page.status).toBe(200);
      const rows = page.body.readings as Array<{ id: string; measuredOn: string }>;
      expect(rows.length).toBeLessThanOrEqual(50);
      seen.push(...rows.map((row) => row.id));
      cursor = page.body.next as string | null;
      pages += 1;
    } while (cursor && pages < 20);
    expect(pages).toBe(5);
    expect(seen).toHaveLength(DAYS * 4);
    expect(new Set(seen).size).toBe(seen.length);
    // The default page is small.
    const first = await call(owner, readingsRoute.GET as Handler, `/api/farming/farms/${w.home}/pasture/readings`, { farmId: w.home });
    expect((first.body.readings as unknown[]).length).toBe(25);
    expect(first.body.next).toMatch(/^2026-09-23_\d+$/);
    // Too many at once is refused.
    expect((await call(owner, readingsRoute.GET as Handler, `/api/farming/farms/${w.home}/pasture/readings?limit=5000`, { farmId: w.home })).status).toBe(400);
    expect((await call(owner, readingsRoute.GET as Handler, `/api/farming/farms/${w.home}/pasture/readings?cursor=nonsense`, { farmId: w.home })).status).toBe(400);
  });

  it("filters by date and paddock on the server", async () => {
    const page = await as(owner)((tx) => listReadings(tx, { farmId: w.home, paddockId: paddockIds[1], from: "2026-08-10", to: "2026-08-19", limit: 100 }));
    expect(page.rows).toHaveLength(10);
    expect(page.next).toBeNull();
    expect(page.rows.every((row) => row.paddockId === paddockIds[1] && row.measuredOn >= "2026-08-10" && row.measuredOn <= "2026-08-19")).toBe(true);
    expect(page.rows[0].measuredOn).toBe("2026-08-19");
    // A paddock from another farm isn't a filter on this one.
    await expect(as(owner)((tx) => listReadings(tx, { farmId: w.home, paddockId: w.runoffPaddock }))).rejects.toThrow("Paddock not found.");
    await expect(as(owner)((tx) => listReadings(tx, { farmId: w.home, from: "2026-09-10", to: "2026-09-01" }))).rejects.toThrow("can't be before");
    const grazings = await as(owner)((tx) => listGrazings(tx, { farmId: w.home, from: "2026-09-01" }));
    expect(grazings.rows.map((row) => row.inOn)).toEqual(["2026-09-25", "2026-09-20", "2026-09-15", "2026-09-10", "2026-09-05"]);
    const feed = await as(owner)((tx) => listSupplements(tx, { farmId: w.home, limit: 7 }));
    expect(feed.rows).toHaveLength(7);
    expect(feed.next).not.toBeNull();
    const grazingRoute = await call(owner, grazingsRoute.GET as Handler, `/api/farming/farms/${w.home}/grazings?open=1`, { farmId: w.home });
    expect((grazingRoute.body.grazings as Array<{ inOn: string; outOn: string | null }>).map((row) => [row.inOn, row.outOn])).toEqual([["2026-09-25", null]]);
    const supplementRoute = await call(owner, supplementsRoute.GET as Handler, `/api/farming/farms/${w.home}/supplements?limit=3`, { farmId: w.home });
    expect((supplementRoute.body.supplements as unknown[]).length).toBe(3);
  });

  it("summaries and the feed wedge are worked out from every record, whatever page is showing", async () => {
    const onDate = "2026-09-20";
    const summary = await as(owner)((tx) => pastureSummary(tx, { farmId: w.home, onDate }));
    // Worked out here from every reading and grazing, the way the summary used to be.
    const all = (await as(owner)((tx) => listReadings(tx, { farmId: w.home, limit: 1000 }))).rows.filter((reading) => reading.measuredOn <= onDate);
    const grazings = (await as(owner)((tx) => listGrazings(tx, { farmId: w.home, limit: 1000 }))).rows;
    const spans = grazings.map((grazing) => ({ paddockId: grazing.paddockId, inOn: grazing.inOn, outOn: grazing.outOn }));
    const expected = farmCover(
      onDate,
      ["1", "2", "3", "4"].map((name, index) => ({ paddockId: paddockIds[index], name, hectares: "10", latest: all.find((reading) => reading.paddockId === paddockIds[index]) ?? null })),
    );
    expect(summary.cover).toEqual(expected);
    for (const [index, paddockId] of paddockIds.entries()) {
      const own: Reading[] = all.filter((reading) => reading.paddockId === paddockId);
      expect(summary.paddocks[index].growth).toEqual(growthBetween(own[1], own[0], spans));
    }
    // 1,800 + 50 × 10 + 0..150 for the four paddocks on 20 September, averaged.
    expect(summary.cover.averageKgDmPerHa).toBe(2375);
    expect(summary.supplementMonths.map((month) => [month.month, month.kgDm])).toEqual([["2026-09", "20000.00"], ["2026-08", "31000.00"]]);
  });

  it("a farm page opens on the farm you last used, on any device, until it's taken off you", async () => {
    expect(await as(staff)((tx) => lastFarm(tx))).toBeNull();
    const chose = await call(staff, lastFarmRoute.PUT as Handler, "/api/farming/last-farm", {}, "PUT", { farmId: w.home });
    expect(chose.status).toBe(200);
    expect((await call(staff, lastFarmRoute.GET as Handler, "/api/farming/last-farm")).body).toEqual({ farmId: w.home });
    // A farm they can't see can't be remembered, and isn't given away.
    expect((await call(staff, lastFarmRoute.PUT as Handler, "/api/farming/last-farm", {}, "PUT", { farmId: w.runoff })).status).toBe(404);
    // The owner's choice is their own.
    await as(owner)((tx) => rememberFarm(tx, w.runoff));
    expect(await as(owner)((tx) => lastFarm(tx))).toBe(w.runoff);
    expect(await as(staff)((tx) => lastFarm(tx))).toBe(w.home);
    // Taken off Home farm: nothing is offered, and the remembered row is gone.
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "bookkeeper", access: "farms", farmIds: [w.runoff] }));
    expect(await as(staff)((tx) => lastFarm(tx))).toBeNull();
    expect((await as(owner)((tx) => tx.query("select 1 from farm_last_used where user_id = $1", [staff.id]))).rowCount).toBe(0);
    // An archived farm isn't offered either.
    await as(staff)((tx) => rememberFarm(tx, w.runoff));
    await as(owner)((tx) => saveFarm(tx, { id: w.runoff, name: "Runoff", isActive: false }));
    expect(await as(staff)((tx) => lastFarm(tx))).toBeNull();
    await expect(as(staff)((tx) => rememberFarm(tx, w.runoff))).rejects.toThrow("archived");
    await as(owner)((tx) => saveFarm(tx, { id: w.runoff, name: "Runoff", isActive: true }));
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "bookkeeper", access: "farms", farmIds: [w.home] }));
  });

  it("switching farms never saves a record into the newly selected farm", async () => {
    // A form opened on Runoff (paddock R1) is sent after the page switched to Home farm: refused, nothing saved.
    const before = (await as(owner)((tx) => listReadings(tx, { farmId: w.home, limit: 1000 }))).rows.length;
    const wrong = await call(owner, readingsRoute.POST as Handler, `/api/farming/farms/${w.home}/pasture/readings`, { farmId: w.home }, "POST", { paddockId: w.runoffPaddock, measuredOn: "2026-10-01", cover: 2000, method: "visual" });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toContain("isn't on the farm this was recorded for");
    const grazing = await call(owner, grazingsRoute.POST as Handler, `/api/farming/farms/${w.home}/grazings`, { farmId: w.home }, "POST", { paddockId: w.runoffPaddock, mob: "Heifers", inOn: "2026-10-01" });
    expect(grazing.status).toBe(409);
    const feed = await call(owner, supplementsRoute.POST as Handler, `/api/farming/farms/${w.home}/supplements`, { farmId: w.home }, "POST", { paddockId: w.runoffPaddock, fedOn: "2026-10-01", feed: "Hay", quantity: "5", unit: "bales" });
    expect(feed.status).toBe(409);
    expect((await as(owner)((tx) => listReadings(tx, { farmId: w.home, limit: 1000 }))).rows.length).toBe(before);
    expect((await as(owner)((tx) => listReadings(tx, { farmId: w.runoff }))).rows).toHaveLength(0);
    // Sent to its own farm, it's saved there.
    const right = await call(owner, readingsRoute.POST as Handler, `/api/farming/farms/${w.runoff}/pasture/readings`, { farmId: w.runoff }, "POST", { paddockId: w.runoffPaddock, measuredOn: "2026-10-01", cover: 2000, method: "visual" });
    expect(right.status).toBe(201);
    expect((right.body.reading as { farmId: string }).farmId).toBe(w.runoff);
  });
});

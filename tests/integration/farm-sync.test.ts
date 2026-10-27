import { afterAll, beforeAll, expect, it } from "vitest";
import * as grazingRoute from "@/app/api/farming/grazings/[grazingId]/route";
import * as grazingsRoute from "@/app/api/farming/farms/[farmId]/grazings/route";
import * as readingsRoute from "@/app/api/farming/farms/[farmId]/pasture/readings/route";
import * as supplementsRoute from "@/app/api/farming/farms/[farmId]/supplements/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { listReadings } from "@/lib/farming/pasture";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-sync";
type Handler = (request: Request, context: never) => Promise<Response>;
const OP = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Records sent from a phone with their own operation ids (#447, decision 912;
 * William's check: "replaying a sync creates no duplicate reading"), and
 * never overwriting another person's record.
 */
describeWithDatabase("syncing records from a phone", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("sync-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("sync-staff@example.com", { displayName: "Hemi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, staff.id]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.p1 = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "10" }))).id;
    w.p2 = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "2", effectiveHa: "10" }))).id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const send = async (user: SessionUser, handler: Handler, path: string, context: Record<string, string>, body: Record<string, unknown>, method = "POST") => {
    const response = await handler(apiRequest(path, { method, cookie: await sessionCookieFor(user), body: { organisationId: ORG, ...body } }), params(context) as never);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const reading = (user: SessionUser, body: Record<string, unknown>) => send(user, readingsRoute.POST as Handler, `/api/farming/farms/${w.home}/pasture/readings`, { farmId: w.home }, body);

  it("a farm walk synced twice makes each reading once", async () => {
    const walk = [
      { paddockId: w.p1, measuredOn: "2026-10-27", cover: 2450, method: "plate_meter", operationId: OP(1) },
      { paddockId: w.p2, measuredOn: "2026-10-27", cover: 2600, method: "plate_meter", operationId: OP(2) },
    ];
    const first = [];
    for (const entry of walk) first.push(await reading(staff, entry));
    expect(first.map((answer) => answer.status)).toEqual([201, 201]);
    // The phone didn't hear back and sends the whole walk again.
    const again = [];
    for (const entry of walk) again.push(await reading(staff, entry));
    expect(again.map((answer) => (answer.body.reading as { id: string }).id)).toEqual(first.map((answer) => (answer.body.reading as { id: string }).id));
    const readings = (await as(owner)((tx) => listReadings(tx, { farmId: w.home }))).rows;
    expect(readings).toHaveLength(2);
  });

  it("refuses the same operation id with different details, or from someone else, and changes nothing", async () => {
    const changed = await reading(staff, { paddockId: w.p1, measuredOn: "2026-10-27", cover: 9999, method: "plate_meter", operationId: OP(1) });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toContain("already sent with different details");
    const someoneElse = await reading(owner, { paddockId: w.p1, measuredOn: "2026-10-27", cover: 2450, method: "plate_meter", operationId: OP(1) });
    expect(someoneElse.status).toBe(409);
    const readings = (await as(owner)((tx) => listReadings(tx, { farmId: w.home }))).rows;
    expect(readings.map((entry) => entry.cover).sort()).toEqual([2450, 2600]);
    expect((await reading(staff, { paddockId: w.p1, measuredOn: "2026-10-27", cover: 2450, method: "plate_meter", operationId: "not-a-uuid" })).status).toBe(400);
  });

  it("a mob in, its day out and feed sent twice are each recorded once", async () => {
    const mobIn = { paddockId: w.p1, mob: "Milkers", head: 300, inOn: "2026-10-27", operationId: OP(3) };
    const inFirst = await send(staff, grazingsRoute.POST as Handler, `/api/farming/farms/${w.home}/grazings`, { farmId: w.home }, mobIn);
    const inAgain = await send(staff, grazingsRoute.POST as Handler, `/api/farming/farms/${w.home}/grazings`, { farmId: w.home }, mobIn);
    expect([inFirst.status, inAgain.status]).toEqual([201, 201]);
    const grazingId = (inFirst.body.grazing as { id: string }).id;
    expect((inAgain.body.grazing as { id: string }).id).toBe(grazingId);
    const out = { outOn: "2026-10-28", postCover: 1600, farmId: w.home };
    const outFirst = await send(staff, grazingRoute.PATCH as Handler, `/api/farming/grazings/${grazingId}`, { grazingId }, out, "PATCH");
    const outAgain = await send(staff, grazingRoute.PATCH as Handler, `/api/farming/grazings/${grazingId}`, { grazingId }, out, "PATCH");
    expect([outFirst.status, outAgain.status]).toEqual([200, 200]);
    // A different day out isn't written over the one recorded.
    const other = await send(owner, grazingRoute.PATCH as Handler, `/api/farming/grazings/${grazingId}`, { grazingId }, { outOn: "2026-10-29" }, "PATCH");
    expect(other.status).toBe(409);
    const feed = { fedOn: "2026-10-27", feed: "Silage", quantity: "800", unit: "kg_dm", operationId: OP(4) };
    const feedFirst = await send(staff, supplementsRoute.POST as Handler, `/api/farming/farms/${w.home}/supplements`, { farmId: w.home }, feed);
    const feedAgain = await send(staff, supplementsRoute.POST as Handler, `/api/farming/farms/${w.home}/supplements`, { farmId: w.home }, feed);
    expect((feedAgain.body.supplement as { id: string }).id).toBe((feedFirst.body.supplement as { id: string }).id);
    const counts = await as(owner)((tx) => tx.query<{ grazings: number; feed: number }>("select (select count(*)::int from grazings) as grazings, (select count(*)::int from supplements_fed) as feed"));
    expect(counts.rows[0]).toEqual({ grazings: 1, feed: 1 });
  });
});

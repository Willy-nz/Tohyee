import { afterAll, beforeAll, expect, it } from "vitest";
import * as comparisonRoute from "@/app/api/farming/comparison/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { farmComparison } from "@/lib/farming/comparison";
import { createPlan } from "@/lib/farming/fertiliser";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addReading } from "@/lib/farming/pasture";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/** All farms compared (#390, PF9, not yet reviewed), from the database. */
describeWithDatabase("all farms compared", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("compare-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("compare-viewer@example.com");
    outsider = await createTestUser("compare-outsider@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("PF9 compares farms from their paddocks, keeps same names apart and leaves archived farms out", async () => {
    const org = "compare-1-co";
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const home = (await as((tx) => saveFarm(tx, { name: "Home farm" })))[0];
    const runoff = (await as((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!;
    const old = (await as((tx) => saveFarm(tx, { name: "Old block" }))).find((farm) => farm.name === "Old block")!;
    const paddock = (farmId: string, name: string, effectiveHa: string) => as((tx) => addPaddock(tx, { farmId, name, effectiveHa, onDate: "2026-07-01" }));
    const a = await paddock(home.id, "A", "10.00");
    const b = await paddock(home.id, "B", "5.00");
    await paddock(home.id, "C", "8.00");
    const ra = await paddock(runoff.id, "A", "40.00");
    await paddock(runoff.id, "B", "2.00");
    const oldA = await paddock(old.id, "A", "100.00");
    await as((tx) => addReading(tx, { paddockId: a.id, measuredOn: "2026-10-15", cover: 2500, method: "plate_meter" }));
    await as((tx) => addReading(tx, { paddockId: b.id, measuredOn: "2026-10-20", cover: 1900, method: "plate_meter" }));
    await as((tx) => addReading(tx, { paddockId: ra.id, measuredOn: "2026-09-01", cover: 2000, method: "plate_meter" }));
    await as((tx) => addReading(tx, { paddockId: oldA.id, measuredOn: "2026-10-01", cover: 3000, method: "plate_meter" }));
    // A reading after the date isn't used.
    await as((tx) => addReading(tx, { paddockId: ra.id, measuredOn: "2026-10-23", cover: 2600, method: "plate_meter" }));
    const plan = await as((tx) => createPlan(tx, { farmId: home.id, name: "Home 2026-27" }));
    await as((tx) => saveFarm(tx, { id: old.id, name: "Old block", isActive: false }));

    const result = await as((tx) => farmComparison(tx, { onDate: "2026-10-22" }));
    expect(result.farms.map((farm) => [farm.farmName, farm.paddocks, farm.effectiveHa, farm.pasture.averageKgDmPerHa, farm.pasture.newestReading, farm.pasture.fresh, farm.pasture.noReading, farm.plan?.planId ?? null])).toEqual([
      ["Home farm", 3, "23.00", 2300, "2026-10-20", true, 1, plan.id],
      ["Runoff", 2, "42.00", 2000, "2026-09-01", false, 1, null],
    ]);
    expect(result.farms[0].plan).toMatchObject({ plannedTonnes: null, appliedTonnes: "0.000", applications: 0 });
    expect(result.allFarms).toMatchObject({ farms: 2, paddocks: 5, effectiveHa: "65.00", farmsWithoutPlan: 1 });
    expect(result.allFarms.pasture).toMatchObject({ averageKgDmPerHa: 2082, totalKgDm: 114500, measuredHa: "55.00", farmsNotFresh: 1 });

    // A member sees the farms they're assigned to (#407, decision 744); someone outside the organisation may not look.
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const ask = async (user: SessionUser) => comparisonRoute.GET(apiRequest(`/api/farming/comparison?organisationId=${org}&onDate=2026-10-22`, { cookie: await sessionCookieFor(user) }), undefined as never);
    const unassigned = await ask(viewer);
    expect(unassigned.status).toBe(200);
    expect((await unassigned.json()).comparison.allFarms.farms).toBe(0);
    await as((tx) => setMemberFarmAccess(tx, { userId: viewer.id, role: "viewer", access: "all" }));
    const seen = await ask(viewer);
    expect(seen.status).toBe(200);
    expect((await seen.json()).comparison.allFarms.pasture.averageKgDmPerHa).toBe(2082);
    expect((await ask(outsider)).status).toBeGreaterThanOrEqual(403);
  });
});

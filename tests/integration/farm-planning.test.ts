import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createMob, mobAction } from "@/lib/farming/mobs";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { listBreeding, planMobRound, recordBreeding, removeBreeding, rotationPlan, setRoundLength } from "@/lib/farming/planning";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

/** Breeding records and rotation planning (BR1-BR6, common NZ practice, not yet reviewed; decisions 1439-1444). */
describeWithDatabase("farm breeding and rotation planning", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("planning-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `plan-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asStaff = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email, role: "farm_worker" }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await as((tx) => saveFarm(tx, { name: "Home block" })))[0];
    const paddock = (name: string, effectiveHa: string) => as((tx) => addPaddock(tx, { farmId: farm.id, name, effectiveHa, onDate: "2026-01-01" }));
    return { as, asStaff, farm, a: await paddock("A", "10.00"), b: await paddock("B", "5.00"), c: await paddock("C", "15.00") };
  }

  it("BR1-BR4 mating, AI, scanning and pregnancy tests", async () => {
    const w = await setup();
    const ewes = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Ewes", kind: "sheep", classCode: "ma_ewes", head: 520, onDate: "2026-03-01" }))).mob;
    const rams = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Rams", kind: "sheep", classCode: "breeding_rams", head: 6, onDate: "2026-03-01" }))).mob;
    const joining = await w.asStaff((tx) => recordBreeding(tx, ewes.id, { recordType: "joining", onDate: "2026-04-01", untilOn: "2026-05-15", sireMobId: rams.id, sire: "Romney rams" }));
    expect(joining).toMatchObject({ head: 520, birthsFrom: "2026-08-26", untilOn: "2026-05-15" });
    await expect(w.as((tx) => recordBreeding(tx, ewes.id, { recordType: "scanning", onDate: "2026-06-20", head: 500, empty: 30, singles: 250, twins: 210, triplets: 9 }))).rejects.toThrow("add up to 499, not the 500 scanned");
    const scan = await w.asStaff((tx) => recordBreeding(tx, ewes.id, { recordType: "scanning", onDate: "2026-06-20", head: 500, empty: 30, singles: 250, twins: 210, triplets: 10, technician: "Scan Co" }));
    expect([scan.scanningPercent, scan.scanningPercentJoined]).toEqual(["140", "135"]);
    await expect(w.as((tx) => recordBreeding(tx, ewes.id, { recordType: "pregnancy_test", inCalf: 3 }))).rejects.toThrow("Record scanning");

    const cows = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Herd", kind: "dairy_cattle", classCode: "ma_cows", head: 200, onDate: "2026-03-01" }))).mob;
    const ai = await w.as((tx) => recordBreeding(tx, cows.id, { recordType: "ai", onDate: "2026-10-20", head: 180, sire: "Bull code 114HO", technician: "AB tech" }));
    expect(ai).toMatchObject({ recordType: "ai", head: 180, technician: "AB tech" });
    const test = await w.as((tx) => recordBreeding(tx, cows.id, { recordType: "pregnancy_test", onDate: "2027-01-15", head: 200, inCalf: 188 }));
    expect(test.inCalfPercent).toBe("94.0");
    await expect(w.as((tx) => recordBreeding(tx, cows.id, { recordType: "scanning", head: 200, empty: 0, singles: 200, twins: 0 }))).rejects.toThrow("pregnancy tested");
    await w.as((tx) => removeBreeding(tx, ai.id));
    expect((await w.as((tx) => listBreeding(tx, { mobId: cows.id }))).map((record) => record.recordType)).toEqual(["pregnancy_test"]);
    expect((await w.as((tx) => listBreeding(tx, { farmId: w.farm.id }))).length).toBe(3);
  });

  it("BR5-BR6 plans a round by area; a move done as planned ticks it off", async () => {
    const w = await setup();
    const cows = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 200, onDate: "2026-10-01" }))).mob;
    await expect(w.as((tx) => planMobRound(tx, { farmId: w.farm.id, mobId: cows.id, paddockIds: [w.a.id], startOn: "2026-11-01" }))).rejects.toThrow("round length first");
    await w.as((tx) => setRoundLength(tx, { farmId: w.farm.id, roundDays: 30 }));
    const preview = await w.as((tx) => planMobRound(tx, { farmId: w.farm.id, mobId: cows.id, paddockIds: [w.a.id, w.b.id, w.c.id], startOn: "2026-11-01", preview: true }));
    expect(preview.saved).toBe(false);
    expect((await w.as((tx) => rotationPlan(tx, { farmId: w.farm.id }))).planned).toEqual([]);
    await w.asStaff((tx) => planMobRound(tx, { farmId: w.farm.id, mobId: cows.id, paddockIds: [w.a.id, w.b.id, w.c.id], startOn: "2026-11-01" }));
    let plan = await w.as((tx) => rotationPlan(tx, { farmId: w.farm.id }));
    expect(plan.roundDays).toBe(30);
    expect(plan.planned.map((move) => [move.paddockName, move.plannedOn, move.days])).toEqual([
      ["A", "2026-11-01", 10],
      ["B", "2026-11-11", 5],
      ["C", "2026-11-16", 15],
    ]);
    expect(plan.nextByMob[cows.id]).toEqual({ paddockName: "A", plannedOn: "2026-11-01" });
    expect(plan.nextByPaddock[w.b.id]).toEqual({ mobName: "Milkers", plannedOn: "2026-11-11" });
    await w.as((tx) => mobAction(tx, cows.id, { action: "move", toPaddockId: w.a.id, onDate: "2026-11-01" }));
    plan = await w.as((tx) => rotationPlan(tx, { farmId: w.farm.id }));
    expect(plan.nextByMob[cows.id]).toEqual({ paddockName: "B", plannedOn: "2026-11-11" });
    // Planning again replaces the mob's planned moves.
    await w.as((tx) => planMobRound(tx, { farmId: w.farm.id, mobId: cows.id, paddockIds: [w.c.id, w.b.id], startOn: "2026-11-05", roundDays: 20 }));
    plan = await w.as((tx) => rotationPlan(tx, { farmId: w.farm.id }));
    expect(plan.planned.map((move) => [move.paddockName, move.plannedOn, move.days])).toEqual([
      ["C", "2026-11-05", 15],
      ["B", "2026-11-20", 5],
    ]);
  });
});

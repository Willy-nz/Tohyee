import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createMob, farmStocking, getMob, importMobs, listMobs, mobAction, mobFromGrazings, previewMobImport, setStockUnitFactors, untypedMobs } from "@/lib/farming/mobs";
import { paddockStatuses } from "@/lib/farming/paddock-status";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addGrazing, listGrazings } from "@/lib/farming/pasture";
import { headCount, listMovements, recordMovement, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Mobs (MOB1-MOB10, common NZ practice, not yet reviewed; decisions 1421-1430). Each test gets its own organisation. */
describeWithDatabase("farm mobs", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("mobs-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { livestock: boolean }) {
    organisations += 1;
    const org = `mobs-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asStaff = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email, role: "farm_worker" }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    if (options.livestock) {
      await as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
      await as((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2026-06-01" }));
      await as((tx) =>
        setOpenings(tx, {
          lines: [
            { kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" },
            { kind: "dairy_cattle", classCode: "r1_heifers", head: 60, value: "80000.00" },
          ],
        }),
      );
    }
    const farm = (await as((tx) => saveFarm(tx, { name: "Home block" })))[0];
    const paddock = (name: string, effectiveHa: string) => as((tx) => addPaddock(tx, { farmId: farm.id, name, effectiveHa, onDate: "2026-06-01" }));
    return { org, as, asStaff, farm, a: await paddock("A", "10.00"), b: await paddock("B", "5.00"), c: await paddock("C", "8.00") };
  }

  const yearEnd = "2027-05-31";
  const classRow = async (as: <T>(work: (tx: OrgTx) => Promise<T>) => Promise<T>, classCode: string) =>
    (await as((tx) => headCount(tx, { yearEnd }))).rows.find((row) => row.kind === "dairy_cattle" && row.classCode === classCode)!;

  it("MOB1-MOB2 adds a mob already on the farm (no head count change) and moves it as a grazing out and in", async () => {
    const w = await setup({ livestock: true });
    const added = await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 200, paddockId: w.a.id, onDate: "2026-07-01" }));
    expect(added.mob).toMatchObject({ name: "Milkers", head: 200, className: "Mixed-age cows", paddock: { name: "A", inOn: "2026-07-01" } });
    expect(added.livestock).toBe("none");
    expect(await w.as((tx) => listMovements(tx))).toEqual([]);
    await expect(w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 5 }))).rejects.toThrow("already a mob called milkers");
    await expect(w.as((tx) => createMob(tx, { farmId: w.farm.id, kind: "dairy_cattle", classCode: "ewe_hoggets", head: 5 }))).rejects.toThrow("Choose a class of dairy cattle");

    const moved = await w.asStaff((tx) => mobAction(tx, added.mob.id, { action: "move", toPaddockId: w.b.id, onDate: "2026-07-04" }));
    expect(moved.mob.paddock).toMatchObject({ name: "B", inOn: "2026-07-04" });
    const grazings = (await w.as((tx) => listGrazings(tx, { farmId: w.farm.id }))).rows;
    expect(grazings.map((g) => [g.paddockName, g.mob, g.mobId, g.head, g.inOn, g.outOn])).toEqual([
      ["B", "Milkers", added.mob.id, 200, "2026-07-04", null],
      ["A", "Milkers", added.mob.id, 200, "2026-07-01", "2026-07-04"],
    ]);
    await expect(w.as((tx) => mobAction(tx, added.mob.id, { action: "move", toPaddockId: w.c.id, onDate: "2026-07-03" }))).rejects.toThrow("can't be before that");
    // A grazing typed with only a mob name keeps the paddock to itself.
    await w.as((tx) => addGrazing(tx, { paddockId: w.c.id, mob: "Heifers", head: 40, inOn: "2026-07-02" }));
    await expect(w.as((tx) => mobAction(tx, added.mob.id, { action: "move", toPaddockId: w.c.id, onDate: "2026-07-05" }))).rejects.toThrow('has "Heifers" in it');
    await expect(w.as((tx) => addGrazing(tx, { paddockId: w.b.id, mob: "Calves", inOn: "2026-07-05" }))).rejects.toThrow("already has a mob in it");
    // Two mob records can share a paddock; the map shows both.
    await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Bulls", kind: "dairy_cattle", classCode: "breeding_bulls", head: 4, paddockId: w.b.id, onDate: "2026-07-06" }));
    const status = (await w.as((tx) => paddockStatuses(tx, { farmId: w.farm.id, onDate: "2026-07-10" }))).find((entry) => entry.name === "B")!;
    expect(status.inNow).toMatchObject({ mob: "Milkers + Bulls", head: 204, inOn: "2026-07-04" });
    expect(status.inNow!.mobs.map((entry) => entry.mob)).toEqual(["Milkers", "Bulls"]);
  });

  it("MOB3-MOB6 sales, deaths, births and class changes make the livestock movements; a resend makes none", async () => {
    const w = await setup({ livestock: true });
    const milkers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 300, paddockId: w.a.id, onDate: "2026-07-01" }))).mob;
    const operationId = randomUUID();
    const sale = await w.as((tx) => mobAction(tx, milkers.id, { action: "sell", head: 20, amount: "36000.00", onDate: "2026-08-10", operationId }));
    expect(sale.livestock).toBe("recorded");
    expect(sale.mob.head).toBe(280);
    expect(sale.message).toContain("head count was updated");
    const again = await w.as((tx) => mobAction(tx, milkers.id, { action: "sell", head: 20, amount: "36000.00", onDate: "2026-08-10", operationId }));
    expect(again.mob.head).toBe(280);
    await expect(w.as((tx) => mobAction(tx, milkers.id, { action: "sell", head: 21, onDate: "2026-08-10", operationId }))).rejects.toThrow("different details");
    // Farm staff record deaths, but not sales (decision 1423).
    await expect(w.asStaff((tx) => mobAction(tx, milkers.id, { action: "sell", head: 1, onDate: "2026-08-11" }))).rejects.toThrow("bookkeeper");
    await w.asStaff((tx) => mobAction(tx, milkers.id, { action: "deaths", head: 2, onDate: "2026-08-12" }));
    // Births only into the youngest classes.
    await expect(w.as((tx) => mobAction(tx, milkers.id, { action: "births", head: 5, onDate: "2026-08-20" }))).rejects.toThrow("youngest classes");
    const calves = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Calves", kind: "dairy_cattle", classCode: "r1_heifers", head: 30, how: "born", onDate: "2026-08-15" }))).mob;
    await w.asStaff((tx) => mobAction(tx, calves.id, { action: "births", head: 12, onDate: "2026-08-25" }));
    const heifers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "In-calf heifers", kind: "dairy_cattle", classCode: "r2_heifers", head: 60, onDate: "2026-07-01" }))).mob;
    const reclass = await w.as((tx) => mobAction(tx, heifers.id, { action: "reclass", toClassCode: "ma_cows", onDate: "2026-09-01" }));
    expect(reclass.mob.classCode).toBe("ma_cows");

    const movements = await w.as((tx) => listMovements(tx));
    expect(movements.map((m) => [m.movementType, m.classCode, m.toClassCode, m.head, m.amount]).sort()).toEqual(
      [
        ["birth", "r1_heifers", null, 12, null],
        ["birth", "r1_heifers", null, 30, null],
        ["death", "ma_cows", null, 2, null],
        ["reclass", "r2_heifers", "ma_cows", 60, null],
        ["sale", "ma_cows", null, 20, "36000.00"],
      ].sort(),
    );
    const cows = await classRow(w.as, "ma_cows");
    expect([cows.opening, cows.sold, cows.died, cows.reclassIn, cows.closing]).toEqual([300, 20, 2, 60, 338]);
    expect((await classRow(w.as, "r1_heifers")).births).toBe(42);
    // The mob's history keeps each event and its movement.
    const detail = await w.as((tx) => getMob(tx, milkers.id));
    expect(detail.events.map((event) => [event.eventType, event.headChange, event.headAfter, Boolean(event.livestockMovementId)])).toEqual([
      ["died", -2, 278, true],
      ["sold", -20, 280, true],
      ["created", 300, 300, false],
    ]);
    // Selling more than the books hold is refused by the books' own rule.
    const extra = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Extra", kind: "dairy_cattle", classCode: "breeding_bulls", head: 3, onDate: "2026-09-01" }))).mob;
    await expect(w.as((tx) => mobAction(tx, extra.id, { action: "sell", head: 3, onDate: "2026-09-05" }))).rejects.toThrow(/below zero/);
  });

  it("MOB7 links a movement already recorded (from an invoice) instead of making a second", async () => {
    const w = await setup({ livestock: true });
    const milkers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 300, onDate: "2026-07-01" }))).mob;
    const { movement } = await w.as((tx) => recordMovement(tx, { idempotencyKey: key("lv"), movementType: "sale", movementDate: "2026-08-10", kind: "dairy_cattle", classCode: "ma_cows", head: 15, amount: "27000.00" }));
    await expect(w.as((tx) => mobAction(tx, milkers.id, { action: "sell", head: 14, onDate: "2026-08-10", movementId: movement.id }))).rejects.toThrow("for 15 head, not 14");
    const linked = await w.as((tx) => mobAction(tx, milkers.id, { action: "sell", head: 15, onDate: "2026-08-10", movementId: movement.id }));
    expect(linked.livestock).toBe("linked");
    expect(linked.mob.head).toBe(285);
    expect((await w.as((tx) => listMovements(tx))).length).toBe(1);
    await expect(w.as((tx) => mobAction(tx, milkers.id, { action: "sell", head: 15, onDate: "2026-08-10", movementId: movement.id }))).rejects.toThrow("already linked to a mob");
    expect((await classRow(w.as, "ma_cows")).sold).toBe(15);
  });

  it("with Livestock off, a sale changes the mob only and says the books weren't changed", async () => {
    const w = await setup({ livestock: false });
    const ewes = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Ewes", kind: "sheep", classCode: "ma_ewes", head: 500 }))).mob;
    const sold = await w.as((tx) => mobAction(tx, ewes.id, { action: "sell", head: 500 }));
    expect(sold.livestock).toBe("off");
    expect(sold.message).toContain("Livestock is off");
    expect(sold.mob).toMatchObject({ head: 0, status: "closed" });
    expect((await w.as((tx) => listMobs(tx, { farmId: w.farm.id }))).length).toBe(0);
    expect((await w.as((tx) => listMobs(tx, { farmId: w.farm.id, includeClosed: true }))).length).toBe(1);
  });

  it("MOB8 weights and gain", async () => {
    const w = await setup({ livestock: false });
    const steers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Steers", kind: "beef_cattle", classCode: "r2_steers_bulls", head: 80, paddockId: w.a.id, onDate: "2026-08-01" }))).mob;
    await w.asStaff((tx) => mobAction(tx, steers.id, { action: "weigh", averageKg: "412", weighedHead: 80, onDate: "2026-09-01" }));
    const weighed = await w.asStaff((tx) => mobAction(tx, steers.id, { action: "weigh", averageKg: "436.0", onDate: "2026-10-01" }));
    expect(weighed.mob.lastWeight).toMatchObject({ averageKg: "436.0", gain: { kg: "24.0", days: 30, kgPerDay: "0.80" } });
    await expect(w.as((tx) => mobAction(tx, steers.id, { action: "weigh", averageKg: "0", onDate: "2026-10-02" }))).rejects.toThrow("Average weight");
  });

  it("MOB8 split and merge keep the head and the class", async () => {
    const w = await setup({ livestock: false });
    const steers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Steers", kind: "beef_cattle", classCode: "r2_steers_bulls", head: 80, paddockId: w.a.id, onDate: "2026-08-01" }))).mob;
    const split = await w.asStaff((tx) => mobAction(tx, steers.id, { action: "split", head: 30, name: "Steers 2", toPaddockId: w.b.id, onDate: "2026-10-05" }));
    expect(split.mob.head).toBe(50);
    const mobs = await w.as((tx) => listMobs(tx, { farmId: w.farm.id }));
    const second = mobs.find((mob) => mob.name === "Steers 2")!;
    expect(second).toMatchObject({ head: 30, classCode: "r2_steers_bulls", paddock: { name: "B" } });
    await expect(w.as((tx) => mobAction(tx, steers.id, { action: "split", head: 50, onDate: "2026-10-05" }))).rejects.toThrow("not all of them");
    const other = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Heifers", kind: "beef_cattle", classCode: "r2_heifers", head: 10 }))).mob;
    await expect(w.as((tx) => mobAction(tx, second.id, { action: "merge", intoMobId: other.id, onDate: "2026-10-06" }))).rejects.toThrow("a mob is one class");
    const merged = await w.asStaff((tx) => mobAction(tx, second.id, { action: "merge", intoMobId: steers.id, onDate: "2026-10-06" }));
    expect(merged.mob.status).toBe("closed");
    const back = await w.as((tx) => getMob(tx, steers.id));
    expect(back.mob.head).toBe(80);
    expect(back.events.slice(0, 2).map((event) => [event.eventType, event.otherMobName, event.headAfter])).toEqual([
      ["merged_in", "Steers 2", 80],
      ["split_out", "Steers 2", 50],
    ]);
    // Steers 2's grazing in B is closed.
    expect((await w.as((tx) => paddockStatuses(tx, { farmId: w.farm.id, onDate: "2026-10-07" }))).find((entry) => entry.name === "B")!.inNow).toBeNull();
  });

  it("MOB9 makes a mob record from a mob name typed on grazings", async () => {
    const w = await setup({ livestock: false });
    await w.as((tx) => addGrazing(tx, { paddockId: w.a.id, mob: "Hoggets", head: 400, inOn: "2026-07-01", outOn: "2026-07-05" }));
    await w.as((tx) => addGrazing(tx, { paddockId: w.b.id, mob: "hoggets", head: 390, inOn: "2026-07-05" }));
    expect(await w.as((tx) => untypedMobs(tx, { farmId: w.farm.id }))).toEqual([{ mob: "Hoggets", openIn: ["B"], head: 390, grazings: 2 }]);
    const made = await w.as((tx) => mobFromGrazings(tx, { farmId: w.farm.id, mob: "Hoggets", kind: "sheep", classCode: "ewe_hoggets" }));
    expect(made.mob).toMatchObject({ name: "Hoggets", head: 390, paddock: { name: "B", inOn: "2026-07-05" } });
    expect((await w.as((tx) => listGrazings(tx, { farmId: w.farm.id }))).rows.every((g) => g.mobId === made.mob.id)).toBe(true);
    expect(await w.as((tx) => untypedMobs(tx, { farmId: w.farm.id }))).toEqual([]);
    // It moves on as a mob from here.
    const moved = await w.as((tx) => mobAction(tx, made.mob.id, { action: "move", toPaddockId: w.c.id, onDate: "2026-07-09" }));
    expect(moved.mob.paddock?.name).toBe("C");
  });

  it("MOB10 stocking rate per paddock and farm, with factors an admin can change", async () => {
    const w = await setup({ livestock: false });
    await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 30, paddockId: w.b.id }));
    await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Ewes", kind: "sheep", classCode: "ma_ewes", head: 120, paddockId: w.a.id }));
    await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Rams", kind: "sheep", classCode: "breeding_rams", head: 5 }));
    await w.as((tx) => addGrazing(tx, { paddockId: w.c.id, mob: "Someone's heifers", head: 20, inOn: "2026-10-01" }));
    const result = await w.as((tx) => farmStocking(tx, { farmId: w.farm.id }));
    // 30 × 8.0 = 240 SU on 5 ha; 120 × 1.0 on 10 ha; farm: 240 + 120 + 5 × 0.8 = 364 SU on 23 ha.
    expect(result.paddocks.map((p) => [p.name, p.stockUnits, p.suPerHa, p.headPerHa])).toEqual([
      ["A", "120.0", "12.0", "12.0"],
      ["B", "240.0", "48.0", "6.0"],
    ]);
    expect(result.farm).toMatchObject({ head: 155, stockUnits: "364.0", hectares: "23.00", suPerHa: "15.8", headPerHa: "6.7" });
    expect(result.untypedHead).toBe(20);
    await w.as((tx) => setStockUnitFactors(tx, { lines: [{ kind: "dairy_cattle", classCode: "ma_cows", factor: "7.3" }] }));
    expect((await w.as((tx) => farmStocking(tx, { farmId: w.farm.id }))).farm.stockUnits).toBe("343.0");
    await w.as((tx) => setStockUnitFactors(tx, { lines: [{ kind: "dairy_cattle", classCode: "ma_cows", factor: "" }] }));
    expect((await w.as((tx) => farmStocking(tx, { farmId: w.farm.id }))).farm.stockUnits).toBe("364.0");
  });

  it("imports mobs from a CSV, once, into their paddocks", async () => {
    const w = await setup({ livestock: false });
    const content = ["Mob,Species,Class,Head,Paddock,Tag", "Ewes,Sheep,Mixed-age ewes (rising three and four),450,A,Blue", "Hoggets,sheep,ewe_hoggets,300,,", "Cows,Dairy,Cows,200,A,", "Wrong,Sheep,Two-tooth ewes,lots,,", "Bulls,beef,breeding_bulls,4,Z,"].join("\n");
    const preview = await w.as((tx) => previewMobImport(tx, w.farm.id, { fileName: "mobs.csv", content }));
    expect(preview.counts).toEqual({ mobs: 2, errors: 3 });
    expect(preview.rows.map((row) => row.error)).toEqual([null, null, '"Cows" isn\'t a class of dairy cattle. Use the IRD class name.', '"lots" isn\'t a whole number of head.', 'No paddock called "Z" on this farm.']);
    expect(await w.as((tx) => importMobs(tx, w.farm.id, { fileName: "mobs.csv", content }))).toEqual({ imported: 2, skipped: 3 });
    await expect(w.as((tx) => importMobs(tx, w.farm.id, { fileName: "mobs.csv", content }))).rejects.toThrow("already imported");
    const mobs = await w.as((tx) => listMobs(tx, { farmId: w.farm.id }));
    expect(mobs.map((mob) => [mob.name, mob.head, mob.paddock?.name ?? null, mob.tagColour])).toEqual([
      ["Ewes", 450, "A", "Blue"],
      ["Hoggets", 300, null, null],
    ]);
  });
});

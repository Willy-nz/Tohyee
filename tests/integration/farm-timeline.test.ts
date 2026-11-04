import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createMob, getMob, mobAction } from "@/lib/farming/mobs";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addGrazing } from "@/lib/farming/pasture";
import { recordBreeding } from "@/lib/farming/planning";
import { farmTimeline, getFarmTerms, importGrazings, previewGrazingImport, setFarmTerms } from "@/lib/farming/timeline";
import { recordTreatment, setSprayWithholding } from "@/lib/farming/treatments";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

/** The farm timeline, grazing history import and farm words (TL1-TL5, common NZ practice, not yet reviewed; decisions 1445-1450). */
describeWithDatabase("farm timeline, grazing import and farm words", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("timeline-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `timeline-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await as((tx) => saveFarm(tx, { name: "Home block" })))[0];
    const paddock = (name: string) => as((tx) => addPaddock(tx, { farmId: farm.id, name, effectiveHa: "5.00", onDate: "2026-01-01" }));
    return { org, as, farm, a: await paddock("A"), b: await paddock("B"), c: await paddock("C") };
  }

  it("TL1-TL2 puts moves, sales, weights, treatments, scanning and sprays in one list, by mob and paddock", async () => {
    const w = await setup();
    const ewes = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Ewes", kind: "sheep", classCode: "ma_ewes", head: 400, paddockId: w.a.id, onDate: "2026-06-01" }))).mob;
    await w.as((tx) => mobAction(tx, ewes.id, { action: "move", toPaddockId: w.b.id, onDate: "2026-06-10" }));
    await w.as((tx) => mobAction(tx, ewes.id, { action: "weigh", averageKg: "68.5", onDate: "2026-06-11" }));
    await w.as((tx) => recordTreatment(tx, { farmId: w.farm.id, mobId: ewes.id, treatedOn: "2026-06-12", product: "Drench", dose: "10 mL", givenBy: "Sam", meatWithholdingDays: 14 }));
    await w.as((tx) => recordBreeding(tx, ewes.id, { recordType: "scanning", onDate: "2026-06-20", head: 400, empty: 20, singles: 200, twins: 180, triplets: 0 }));
    await w.as((tx) => mobAction(tx, ewes.id, { action: "sell", head: 10, onDate: "2026-06-25" }));
    await w.as((tx) => addGrazing(tx, { paddockId: w.c.id, mob: "Cattle", head: 20, inOn: "2026-06-05", outOn: "2026-06-15" }));
    const jobId = randomUUID();
    await w.as((tx) =>
      tx.query(
        `insert into tractor_jobs (id, farm_id, paddock_ids, operation, operator_user_id, operator_email, started_at, finished_at, point_count, track, track_sha256, summary, coverage, worked_ha, product)
         values ($1, $2, array[$3::bigint], 'spraying', $4, $5, '2026-06-22T01:00:00Z', '2026-06-22T02:00:00Z', 0, '{}', repeat('d', 64), '{}', '{}', 0, 'Thistle spray')`,
        [jobId, w.farm.id, w.a.id, owner.id, owner.email],
      ),
    );
    await w.as((tx) => setSprayWithholding(tx, jobId, { days: 7 }));
    const all = await w.as((tx) => farmTimeline(tx, { farmId: w.farm.id }));
    expect(all.items.map((item) => [item.date, item.title])).toEqual([
      ["2026-06-25", "Ewes: 10 sold"],
      ["2026-06-22", "Sprayed A with Thistle spray"],
      ["2026-06-20", "Ewes: scanning"],
      ["2026-06-15", "Cattle out of C"],
      ["2026-06-12", "Ewes: treated with Drench"],
      ["2026-06-11", "Ewes weighed: 68.5 kg average"],
      ["2026-06-10", "Ewes moved to B"],
      ["2026-06-05", "Cattle into C"],
      ["2026-06-01", "Ewes added: 400 head in A"],
    ]);
    expect(all.items.find((item) => item.what === "scanning")?.detail).toBe("140% scanned");
    expect(all.items.find((item) => item.what === "spray")?.detail).toBe("not safe to graze for 7 days");
    // Livestock is off here, so the sale isn't in the books' head count.
    expect(all.items[0].inHeadCount).toBe(false);
    const forMob = await w.as((tx) => farmTimeline(tx, { farmId: w.farm.id, mobId: ewes.id }));
    expect(forMob.items.every((item) => item.mobId === ewes.id)).toBe(true);
    expect(forMob.items.length).toBe(6);
    const paddockA = await w.as((tx) => farmTimeline(tx, { farmId: w.farm.id, paddockId: w.a.id }));
    expect(paddockA.items.map((item) => item.title)).toEqual(["Sprayed A with Thistle spray", "Ewes moved to B", "Ewes added: 400 head in A"]);
    const paddockB = await w.as((tx) => farmTimeline(tx, { farmId: w.farm.id, paddockId: w.b.id, kinds: "treatment" }));
    expect(paddockB.items.map((item) => item.title)).toEqual(["Ewes: treated with Drench"]);
    const limited = await w.as((tx) => farmTimeline(tx, { farmId: w.farm.id, limit: 3 }));
    expect([limited.items.length, limited.more]).toEqual([3, true]);
  });

  it("TL3-TL4 imports grazing history: mob records' rows become their moves, with no head count change", async () => {
    const w = await setup();
    const steers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Steers", kind: "beef_cattle", classCode: "r2_steers_bulls", head: 50, onDate: "2026-01-01" }))).mob;
    const content = [
      "Mob,Paddock,Day in,Day out,Head",
      "Steers,A,01/03/2026,10/03/2026,50",
      "Steers,B,10/03/2026,20/03/2026,",
      "Steers,C,15/03/2026,25/03/2026,",
      "Heifers,C,01/03/2026,05/03/2026,30",
      "Heifers,C,04/03/2026,08/03/2026,30",
      "Bulls,Z,01/03/2026,02/03/2026,",
      "Calves,A,01/04/2026,,",
    ].join("\n");
    const preview = await w.as((tx) => previewGrazingImport(tx, w.farm.id, { fileName: "history.csv", content }));
    expect(preview.counts).toEqual({ grazings: 3, mobRecords: 2, errors: 4 });
    expect(preview.rows.map((row) => row.error)).toEqual([
      null,
      null,
      "Steers is somewhere else between those days.",
      null,
      "C already has a grazing between those days.",
      'No paddock called "Z" on this farm.',
      "No day out: an import is history, so each grazing needs its day out.",
    ]);
    expect(await w.as((tx) => importGrazings(tx, w.farm.id, { fileName: "history.csv", content }))).toEqual({ imported: 3, skipped: 4 });
    await expect(w.as((tx) => importGrazings(tx, w.farm.id, { fileName: "history.csv", content }))).rejects.toThrow("already imported");
    const mob = await w.as((tx) => getMob(tx, steers.id));
    expect(mob.mob).toMatchObject({ head: 50, paddock: null });
    expect(mob.events.map((event) => [event.eventType, event.eventDate, event.toPaddockName, event.headChange])).toEqual([
      ["moved", "2026-03-10", "B", 0],
      ["moved", "2026-03-01", "A", 0],
      ["created", "2026-01-01", null, 50],
    ]);
    const timeline = await w.as((tx) => farmTimeline(tx, { farmId: w.farm.id, paddockId: w.c.id }));
    expect(timeline.items.map((item) => item.title)).toEqual(["Heifers out of C", "Heifers into C"]);
  });

  it("TL5 farm words are display only, and only real words can be renamed", async () => {
    const w = await setup();
    await w.as((tx) => setFarmTerms(tx, { terms: [{ key: "mob", label: "Herd" }, { key: "class:dairy_cattle.ma_cows", label: "Milkers" }, { key: "action:move", label: "Shift" }] }));
    expect(await w.as((tx) => getFarmTerms(tx))).toEqual({ "action:move": "Shift", "class:dairy_cattle.ma_cows": "Milkers", mob: "Herd" });
    await expect(w.as((tx) => setFarmTerms(tx, { terms: [{ key: "class:dairy_cattle.unicorns", label: "x" }] }))).rejects.toThrow("isn't a word that can be renamed");
    await expect(inOrganisation(w.org, { userId: owner.id, email: owner.email, role: "bookkeeper" }, (tx) => setFarmTerms(tx, { terms: [{ key: "mob", label: "Flock" }] }))).rejects.toThrow("admin");
    await w.as((tx) => setFarmTerms(tx, { terms: [{ key: "mob", label: "" }] }));
    expect(Object.keys(await w.as((tx) => getFarmTerms(tx)))).toEqual(["action:move", "class:dairy_cattle.ma_cows"]);
    // The class underneath doesn't change.
    const cows = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, kind: "dairy_cattle", classCode: "ma_cows", head: 10 }))).mob;
    expect([cows.classCode, cows.className]).toEqual(["ma_cows", "Mixed-age cows"]);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createMob, getMob, listMobs, mobAction } from "@/lib/farming/mobs";
import { paddockStatuses } from "@/lib/farming/paddock-status";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { getSprayWithholding, listTreatments, productStock, recordProductStock, recordTreatment, removeTreatment, setSprayWithholding, stockMovementFile, treatmentRegisterFile } from "@/lib/farming/treatments";
import { addChemical } from "@/lib/safety/register";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

/** Treatments, withholding and product stock (TRT1-TRT8, common NZ practice, not yet reviewed; decisions 1431-1438). */
describeWithDatabase("farm treatments and withholding", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("treatments-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `treat-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asStaff = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email, role: "farm_worker" }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await as((tx) => saveFarm(tx, { name: "Home block" })))[0];
    const a = await as((tx) => addPaddock(tx, { farmId: farm.id, name: "A", effectiveHa: "10.00", onDate: "2026-06-01" }));
    const b = await as((tx) => addPaddock(tx, { farmId: farm.id, name: "B", effectiveHa: "5.00", onDate: "2026-06-01" }));
    const cows = (await as((tx) => createMob(tx, { farmId: farm.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 200, paddockId: a.id, onDate: "2026-09-01" }))).mob;
    return { org, as, asStaff, farm, a, b, cows };
  }

  const treat = (fields: Record<string, unknown>) => ({ dose: "20 mL per head", givenBy: "Sam the vet", product: "Pour-on", ...fields });

  it("TRT1-TRT2 works out safe for slaughter and milk safe from, from the label's figures", async () => {
    const w = await setup();
    const result = await w.asStaff((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, treatedOn: "2026-10-01", meatWithholdingDays: 14, milkWithholdingHours: 96 })));
    expect(result.treatment).toMatchObject({ head: 200, meatSafeOn: "2026-10-15", milkSafeFrom: "2026-10-06" });
    expect(result.message).toBe("Treatment recorded: safe for slaughter from 2026-10-15, milk safe from 2026-10-06 (from end of day, no time given).");
    expect(result.treatment).toMatchObject({ givenTime: null, milkBasis: "end_of_day" });
    // Nil is 0 (the day itself); blank is "not entered", never nil.
    const nil = await w.as((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, treatedOn: "2026-10-02", milkWithholdingHours: 0 })));
    expect(nil.treatment).toMatchObject({ meatSafeOn: null, milkSafeFrom: "2026-10-02", meatWithholdingDays: null });
    const mob = (await w.as((tx) => listMobs(tx, { farmId: w.farm.id })))[0];
    expect(mob.withholding).toEqual({ meatSafeOn: "2026-10-15", milkSafeFrom: "2026-10-06" });
    await expect(w.as((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, head: 201 })))).rejects.toThrow("The mob has 200 head");
    await expect(w.as((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, meatWithholdingDays: "a fortnight" })))).rejects.toThrow("whole number");
    // Sent twice from a phone: one treatment.
    const operationId = randomUUID();
    await w.asStaff((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, treatedOn: "2026-10-03", operationId })));
    await w.asStaff((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, treatedOn: "2026-10-03", operationId })));
    expect((await w.as((tx) => listTreatments(tx, { farmId: w.farm.id }))).length).toBe(3);
    // Removed by mistake: kept, not counted. Farm staff can't remove.
    await expect(w.asStaff((tx) => removeTreatment(tx, result.treatment.id, { reason: "wrong mob" }))).rejects.toThrow("bookkeeper");
    await w.as((tx) => removeTreatment(tx, result.treatment.id, { reason: "wrong mob" }));
    expect((await w.as((tx) => getMob(tx, w.cows.id))).mob.withholding).toEqual({ meatSafeOn: null, milkSafeFrom: "2026-10-02" });
    expect((await w.as((tx) => listTreatments(tx, { farmId: w.farm.id, includeRemoved: true }))).length).toBe(3);
  });

  it("TRT2a a time given counts milk withholding from it exactly, also when sent again from a phone", async () => {
    const w = await setup();
    const operationId = randomUUID();
    const timed = await w.asStaff((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, treatedOn: "2026-10-01", givenTime: "7:30", milkWithholdingHours: 96, operationId })));
    expect(timed.treatment).toMatchObject({ givenTime: "07:30", milkSafeFrom: "2026-10-05T07:30", milkBasis: "time_given" });
    expect(timed.message).toBe("Treatment recorded: milk safe from 2026-10-05 7:30 am (from 7:30 am).");
    await w.asStaff((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, treatedOn: "2026-10-01", givenTime: "7:30", milkWithholdingHours: 96, operationId })));
    await expect(w.asStaff((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, treatedOn: "2026-10-01", givenTime: "8:30", milkWithholdingHours: 96, operationId })))).rejects.toThrow("different details");
    await expect(w.as((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, givenTime: "half seven" })))).rejects.toThrow("Time given");
    expect((await w.as((tx) => getMob(tx, w.cows.id))).mob.withholding?.milkSafeFrom).toBe("2026-10-05T07:30");
    const csv = await w.as((tx) => treatmentRegisterFile(tx, { farmId: w.farm.id, format: "csv" }));
    expect(String(csv.content).trim().split("\r\n")[1]).toBe("2026-10-01,07:30,Milkers,200,Pour-on,,20 mL per head,,,Sam the vet,not entered,,96,2026-10-05 7:30 am,from 7:30 am,treatments-owner@example.com");
  });

  it("TRT3-TRT4 withholding follows split and merged stock; a sale in it warns but isn't stopped", async () => {
    const w = await setup();
    await w.as((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, treatedOn: "2026-10-01", meatWithholdingDays: 28 })));
    await w.as((tx) => mobAction(tx, w.cows.id, { action: "split", head: 20, name: "Culls", onDate: "2026-10-05" }));
    const culls = (await w.as((tx) => listMobs(tx, { farmId: w.farm.id }))).find((mob) => mob.name === "Culls")!;
    expect(culls.withholding).toEqual({ meatSafeOn: "2026-10-29", milkSafeFrom: null });
    // Stock merged into an untreated mob brings its withholding.
    const heifers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Old cows", kind: "dairy_cattle", classCode: "ma_cows", head: 15, onDate: "2026-10-01" }))).mob;
    await w.as((tx) => mobAction(tx, culls.id, { action: "merge", intoMobId: heifers.id, onDate: "2026-10-06" }));
    expect((await w.as((tx) => getMob(tx, heifers.id))).mob.withholding?.meatSafeOn).toBe("2026-10-29");
    // A mob split off before the treatment doesn't carry it.
    const early = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Bulls", kind: "dairy_cattle", classCode: "breeding_bulls", head: 4, onDate: "2026-09-01" }))).mob;
    expect((await w.as((tx) => getMob(tx, early.id))).mob.withholding).toBeNull();
    const sale = await w.as((tx) => mobAction(tx, heifers.id, { action: "sell", head: 5, onDate: "2026-10-10" }));
    expect(sale.mob.head).toBe(30);
    expect(sale.message).toContain("Warning: Old cows is within a withholding period (safe for slaughter from 2026-10-29)");
  });

  it("TRT5 a spray job's grazing withholding flags its paddocks, and a move into one warns", async () => {
    const w = await setup();
    const jobId = randomUUID();
    await w.as((tx) =>
      tx.query(
        `insert into tractor_jobs (id, farm_id, paddock_ids, operation, operator_user_id, operator_email, started_at, finished_at, point_count, track, track_sha256, summary, coverage, worked_ha, product)
         values ($1, $2, array[$3::bigint], 'spraying', $4, $5, '2026-10-01T22:00:00Z', '2026-10-01T23:30:00Z', 0, '{}', repeat('a', 64), '{}', '{}', 0, 'Brush killer')`,
        [jobId, w.farm.id, w.b.id, owner.id, owner.email],
      ),
    );
    // Finished 23:30 UTC on 1 Oct is 2 Oct in New Zealand: 14 days from then.
    const set = await w.asStaff((tx) => setSprayWithholding(tx, jobId, { days: 14 }));
    expect(set).toMatchObject({ fromOn: "2026-10-02", days: 14, safeOn: "2026-10-16" });
    const status = (await w.as((tx) => paddockStatuses(tx, { farmId: w.farm.id, onDate: "2026-10-10" }))).find((entry) => entry.name === "B")!;
    expect(status.notSafeUntil).toEqual({ until: "2026-10-16", product: "Brush killer", jobId });
    expect((await w.as((tx) => paddockStatuses(tx, { farmId: w.farm.id, onDate: "2026-10-16" }))).find((entry) => entry.name === "B")!.notSafeUntil).toBeNull();
    const moved = await w.as((tx) => mobAction(tx, w.cows.id, { action: "move", toPaddockId: w.b.id, onDate: "2026-10-10" }));
    expect(moved.mob.paddock?.name).toBe("B");
    expect(moved.message).toContain("Warning: B isn't safe to graze until 2026-10-16 (sprayed with Brush killer).");
    // A new figure replaces the old; blank removes it.
    await w.as((tx) => setSprayWithholding(tx, jobId, { days: 7 }));
    expect((await w.as((tx) => getSprayWithholding(tx, jobId)))?.safeOn).toBe("2026-10-09");
    await w.as((tx) => setSprayWithholding(tx, jobId, { days: "" }));
    expect(await w.as((tx) => getSprayWithholding(tx, jobId))).toBeNull();
  });

  it("TRT6 exports the treatment register and stock movement history as CSV and PDF", async () => {
    const w = await setup();
    await w.as((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, treatedOn: "2026-10-01", meatWithholdingDays: 14, batch: "B123" })));
    await w.as((tx) => mobAction(tx, w.cows.id, { action: "move", toPaddockId: w.b.id, onDate: "2026-10-04" }));
    const csv = await w.as((tx) => treatmentRegisterFile(tx, { farmId: w.farm.id, from: "2026-10-01", to: "2026-10-31", format: "csv" }));
    const lines = String(csv.content).trim().split("\r\n");
    expect(lines[0]).toContain("Safe for slaughter from");
    expect(lines[1]).toBe("2026-10-01,,Milkers,200,Pour-on,B123,20 mL per head,,,Sam the vet,14,2026-10-15,not entered,,,treatments-owner@example.com");
    const pdf = await w.as((tx) => treatmentRegisterFile(tx, { farmId: w.farm.id, format: "pdf" }));
    expect(Buffer.from(pdf.content as Uint8Array).subarray(0, 5).toString()).toBe("%PDF-");
    const moves = await w.as((tx) => stockMovementFile(tx, { farmId: w.farm.id, format: "csv" }));
    expect(String(moves.content).trim().split("\r\n").slice(1)).toEqual([
      "2026-09-01,Milkers,Added to A,200,200,,,,treatments-owner@example.com",
      "2026-10-04,Milkers,Moved from A to B,,200,,,,treatments-owner@example.com",
    ]);
    expect(moves.fileName).toBe("stock-movements-home-block.csv");
  });

  it("TRT7-TRT8 product stock from the chemical register, less treatments and spray jobs", async () => {
    const w = await setup();
    const chemical = await w.as((tx) => addChemical(tx, { farmId: w.farm.id, name: "Drench X", unit: "L" }));
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: chemical.recordId, movementType: "received", movedOn: "2026-09-20", quantity: "5", unit: "L", batch: "D9" }));
    await w.as((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, chemicalRecordId: chemical.recordId, product: null, treatedOn: "2026-10-01", quantity: "250", quantityUnit: "mL" })));
    await w.as((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, chemicalRecordId: chemical.recordId, product: null, treatedOn: "2026-10-02", quantity: "3", quantityUnit: "doses" })));
    await w.as((tx) =>
      tx.query(
        `insert into tractor_jobs (id, farm_id, paddock_ids, operation, operator_user_id, operator_email, started_at, finished_at, point_count, track, track_sha256, summary, coverage, worked_ha, chemical_record_id, declared_quantity, declared_quantity_unit)
         values ($1, $2, array[$3::bigint], 'spraying', $4, $5, '2026-10-03T01:00:00Z', '2026-10-03T02:00:00Z', 0, '{}', repeat('b', 64), '{}', '{}', 0, $6, 2, 'L')`,
        [randomUUID(), w.farm.id, w.a.id, owner.id, owner.email, chemical.recordId],
      ),
    );
    let stock = (await w.as((tx) => productStock(tx, { farmId: w.farm.id })))[0];
    // 5 L in, 250 mL (0.25 L) on the mob, 2 L sprayed: 2.75 L. The doses can't come off litres, so they're listed.
    expect(stock).toMatchObject({ name: "Drench X", onHand: "2.75", unit: "L", lastCountedOn: null });
    expect(stock.notCounted.map((entry) => [entry.quantity, entry.unit])).toEqual([["3", "doses"]]);
    expect((await w.as((tx) => listTreatments(tx, { farmId: w.farm.id })))[0].product).toBe("Drench X");
    // A count resets it; use after the count comes off.
    await w.asStaff((tx) => recordProductStock(tx, { chemicalRecordId: chemical.recordId, movementType: "counted", movedOn: "2026-10-04", quantity: "3", unit: "L" }));
    await w.as((tx) => recordTreatment(tx, treat({ farmId: w.farm.id, mobId: w.cows.id, chemicalRecordId: chemical.recordId, product: null, treatedOn: "2026-10-05", quantity: "500", quantityUnit: "mL" })));
    stock = (await w.as((tx) => productStock(tx, { farmId: w.farm.id })))[0];
    expect(stock).toMatchObject({ onHand: "2.5", lastCountedOn: "2026-10-04" });
  });
});

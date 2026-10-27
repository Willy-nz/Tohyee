import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addChecklist, addEquipment, changeChecklist, changeEquipment, equipmentChecks, listEquipment, recordCheck, releaseEquipment } from "@/lib/safety/equipment";
import { uploadSafetyFile } from "@/lib/safety/files";
import { checkSafetyHistory } from "@/lib/safety/records";
import { addChemical, addTraining, changeChemical, changeTraining, listChemicals, listTraining } from "@/lib/safety/register";
import { openActions } from "@/lib/safety/reports";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-safety-equipment";

const ok = (keys: string[], overrides: Record<string, { result: string; note?: string }> = {}) => keys.map((key) => ({ key, ...(overrides[key] ?? { result: "ok" }) }));

/**
 * Equipment and pre-start checks, the training register and the chemicals
 * inventory (#446; FS28-FS34 in docs/FARM-SAFETY.md, decisions 953-957).
 */
describeWithDatabase("farm safety equipment, training and chemicals", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let mechanic: SessionUser;
  let viewer: SessionUser;
  const as = (user: SessionUser, via?: string) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email, via }, work);
  const w = {} as Record<string, string>;
  let members: Map<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("eq-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("eq-staff@example.com", { displayName: "Mere" });
    mechanic = await createTestUser("eq-mechanic@example.com", { displayName: "Rangi" });
    viewer = await createTestUser("eq-viewer@example.com", { displayName: "Tama" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'bookkeeper'), ($1, $4, 'viewer')", [ORG, staff.id, mechanic.id, viewer.id]);
    members = new Map([[owner.id, "Jess"], [staff.id, "Mere"], [mechanic.id, "Rangi"], [viewer.id, "Tama"]]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    for (const user of [staff, mechanic, viewer]) await as(owner)((tx) => setMemberFarmAccess(tx, { userId: user.id, role: user === viewer ? "viewer" : "bookkeeper", access: "farms", farmIds: [w.home] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FS28 equipment needn't be a fixed asset: hired and contractors' machines count", async () => {
    const checklist = await as(owner)((tx) => addChecklist(tx, { title: "Quad bike pre-start", items: [{ text: "Brakes work", critical: true }, { text: "Tyres look right", critical: true }, { text: "Helmet on the bike" }, { text: "Fuel" }] }));
    w.checklist = checklist.recordId;
    expect(checklist.data.items.map((item) => item.key)).toEqual(["brakes-work", "tyres-look-right", "helmet-on-the-bike", "fuel"]);
    const quad = await as(owner)((tx) => addEquipment(tx, { farmId: w.home, name: "Honda quad", type: "Quad bike", owner: "owned", checklistId: w.checklist, responsibleUserId: mechanic.id, releaserUserIds: [mechanic.id] }, members));
    w.quad = quad.recordId;
    const hired = await as(owner)((tx) => addEquipment(tx, { farmId: w.home, name: "Hired digger", owner: "hired", ownerName: "Digger Hire Ltd" }, members));
    expect(hired.data).toMatchObject({ owner: "hired", ownerName: "Digger Hire Ltd", fixedAssetId: null });
    await expect(as(owner)((tx) => addEquipment(tx, { farmId: w.home, name: "x", fixedAssetId: "999999" }, members))).rejects.toThrow(/fixed asset wasn't found/);
    await expect(as(owner)((tx) => addEquipment(tx, { farmId: w.home, name: "x", owner: "stolen" }, members))).rejects.toThrow(/whose it is/);
    await expect(as(viewer)((tx) => addEquipment(tx, { farmId: w.home, name: "x" }, members))).rejects.toThrow(/bookkeeper/);
  });

  it("FS31 every item is answered; a critical one can't be skipped; a fault says what's wrong; an old checklist is refused", async () => {
    const keys = ["brakes-work", "tyres-look-right", "helmet-on-the-bike", "fuel"];
    await expect(as(staff)((tx) => recordCheck(tx, { equipmentId: w.quad, checklistVersion: 1, answers: ok(keys.slice(1)) }, members))).rejects.toThrow(/Answer "Brakes work"/);
    await expect(as(staff)((tx) => recordCheck(tx, { equipmentId: w.quad, checklistVersion: 1, answers: ok(keys, { "brakes-work": { result: "na" } }) }, members))).rejects.toThrow(/can't be not applicable/);
    await expect(as(staff)((tx) => recordCheck(tx, { equipmentId: w.quad, checklistVersion: 1, answers: ok(keys, { fuel: { result: "fault" } }) }, members))).rejects.toThrow(/what's wrong with "Fuel"/);
    await expect(as(staff)((tx) => recordCheck(tx, { equipmentId: w.quad, checklistVersion: 2, answers: ok(keys) }, members))).rejects.toThrow(/changed since it was opened/);
    const passed = await as(staff)((tx) => recordCheck(tx, { equipmentId: w.quad, checklistVersion: 1, hoursOrKm: "1520", answers: ok(keys, { fuel: { result: "fault", note: "Low" } }) }, members));
    expect(passed).toMatchObject({ outOfUse: false, action: null, check: { enteredByEmail: "eq-staff@example.com", data: { passed: false, criticalFault: false, hoursOrKm: "1520" } } });
  });

  it("FS29 a changed checklist doesn't rewrite answers already given", async () => {
    await as(owner)((tx) => changeChecklist(tx, w.checklist, { expectedVersion: 1, items: [{ key: "brakes-work", text: "Brakes: front and back work", critical: true }, { key: "tyres-look-right", text: "Tyres look right", critical: true }, { text: "Lights work" }] }));
    const [old] = await as(owner)((tx) => equipmentChecks(tx, w.quad));
    expect(old.data.checklistVersion).toBe(1);
    expect(old.data.answers.map((answer) => answer.text)).toEqual(["Brakes work", "Tyres look right", "Helmet on the bike", "Fuel"]);
  });

  it("FS30 a failed critical check puts it out of use with an action; only someone allowed releases it", async () => {
    const failed = await as(staff)((tx) => recordCheck(tx, { equipmentId: w.quad, checklistVersion: 2, answers: ok(["brakes-work", "tyres-look-right", "lights-work"], { "brakes-work": { result: "fault", note: "Back brake doesn't hold" } }) }, members));
    expect(failed.outOfUse).toBe(true);
    expect(failed.action?.data).toMatchObject({ assignedToUserId: mechanic.id, title: "Fix Honda quad: Brakes: front and back work", checkId: failed.check.recordId });
    expect((await as(mechanic)((tx) => openActions(tx, { mine: true }))).map((action) => action.data.checkId)).toEqual([failed.check.recordId]);
    const [quad] = (await as(staff)((tx) => listEquipment(tx, w.home))).equipment;
    expect(quad).toMatchObject({ available: false, canRelease: false, failedCheck: { recordId: failed.check.recordId } });
    // Mere (a bookkeeper not named on it), an AI key, or a farm app can't release it.
    await expect(as(staff)((tx) => releaseEquipment(tx, { equipmentId: w.quad, whatWasDone: "Looks fine" }))).rejects.toThrow(/Only an owner, an admin or someone named/);
    await expect(as(mechanic, 'AI key "Phone"')((tx) => releaseEquipment(tx, { equipmentId: w.quad, whatWasDone: "Fixed" }))).rejects.toThrow(/not an AI or app/);
    await expect(as(mechanic)((tx) => releaseEquipment(tx, { equipmentId: w.quad }))).rejects.toThrow(/What was done/);
    const released = await as(mechanic)((tx) => releaseEquipment(tx, { equipmentId: w.quad, whatWasDone: "New back brake pads, tested on the hill" }));
    expect(released).toMatchObject({ enteredByEmail: "eq-mechanic@example.com", data: { checkId: failed.check.recordId } });
    expect((await as(staff)((tx) => listEquipment(tx, w.home))).equipment[0].available).toBe(true);
    await expect(as(owner)((tx) => releaseEquipment(tx, { equipmentId: w.quad, whatWasDone: "again" }))).rejects.toThrow(/isn't out of use/);
  });

  it("FS30a only an owner or admin, in person, chooses who can release equipment (#464)", async () => {
    const tractor = await as(owner)((tx) => addEquipment(tx, { farmId: w.home, name: "Tractor", checklistId: w.checklist, releaserUserIds: [mechanic.id] }, members));
    const deny = /Only an owner or an admin can choose who can release/;
    // A bookkeeper can't name themselves or anyone else, on adding, updating or correcting.
    await expect(as(staff)((tx) => addEquipment(tx, { farmId: w.home, name: "Ute", releaserUserIds: [staff.id] }, members))).rejects.toThrow(deny);
    await expect(as(staff)((tx) => addEquipment(tx, { farmId: w.home, name: "Ute", releaserUserIds: [mechanic.id] }, members))).rejects.toThrow(deny);
    await expect(as(staff)((tx) => changeEquipment(tx, tractor.recordId, { expectedVersion: 1, releaserUserIds: [mechanic.id, staff.id] }, members))).rejects.toThrow(deny);
    await expect(as(staff)((tx) => changeEquipment(tx, tractor.recordId, { expectedVersion: 1, change: "corrected", why: "typo", releaserUserIds: [staff.id] }, members))).rejects.toThrow(deny);
    // ...or take someone off.
    await expect(as(staff)((tx) => changeEquipment(tx, tractor.recordId, { expectedVersion: 1, releaserUserIds: [] }, members))).rejects.toThrow(deny);
    // An owner's AI key or a farm app can't either.
    await expect(as(owner, 'AI key "Phone"')((tx) => changeEquipment(tx, tractor.recordId, { expectedVersion: 1, releaserUserIds: [staff.id] }, members))).rejects.toThrow(/not an AI or app/);
    await expect(as(owner, "farm app")((tx) => addEquipment(tx, { farmId: w.home, name: "Ute", releaserUserIds: [staff.id] }, members))).rejects.toThrow(/not an AI or app/);
    // Other details are still the bookkeeper's to keep up; the list stays as it was.
    const renamed = await as(staff)((tx) => changeEquipment(tx, tractor.recordId, { expectedVersion: 1, name: "John Deere tractor" }, members));
    expect(renamed.data).toMatchObject({ name: "John Deere tractor", releaserUserIds: [mechanic.id] });
    const hired = await as(staff)((tx) => addEquipment(tx, { farmId: w.home, name: "Hired ute", owner: "hired" }, members));
    expect(hired.data.releaserUserIds).toEqual([]);
    // The owner can add and take off releasers.
    const added = await as(owner)((tx) => changeEquipment(tx, tractor.recordId, { expectedVersion: 2, releaserUserIds: [mechanic.id, staff.id] }, members));
    expect(added.data.releaserUserIds).toEqual([mechanic.id, staff.id].sort());
    const removed = await as(owner)((tx) => changeEquipment(tx, tractor.recordId, { expectedVersion: 3, change: "corrected", why: "Mere isn't trained on it", releaserUserIds: [mechanic.id] }, members));
    expect(removed.data.releaserUserIds).toEqual([mechanic.id]);
    expect((await as(owner)((tx) => listEquipment(tx, w.home))).equipment.find((item) => item.recordId === tractor.recordId)?.canRelease).toBe(true);
    expect((await as(staff)((tx) => listEquipment(tx, w.home))).equipment.find((item) => item.recordId === tractor.recordId)?.canRelease).toBe(false);
    expect((await as(mechanic)((tx) => listEquipment(tx, w.home))).equipment.find((item) => item.recordId === tractor.recordId)?.canRelease).toBe(true);
  });

  it("FS32 the training register: expiry, and the person confirms their own record", async () => {
    const today = new Date();
    const inDays = (days: number) => new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10);
    const quad = await as(owner)((tx) => addTraining(tx, { person: { userId: staff.id }, what: "Quad bike training", provider: "Agricultural training provider", completedOn: "2025-03-01", expiresOn: inDays(30), canDo: "Quad on the flat; not on the hill block" }, members));
    await as(owner)((tx) => addTraining(tx, { person: { name: "Hemi", company: "Hemi Fencing" }, what: "Chemical handling", completedOn: "2020-01-01", expiresOn: "2025-01-01" }, members));
    await as(owner)((tx) => addTraining(tx, { person: { userId: mechanic.id }, what: "First aid", completedOn: "2026-01-01", expiresOn: inDays(400) }, members));
    expect((await as(viewer)((tx) => listTraining(tx))).map((record) => [record.data.person.name, record.state])).toEqual([
      ["Hemi", "expired"],
      ["Mere", "expiring"],
      ["Rangi", "current"],
    ]);
    expect((await as(staff)((tx) => listTraining(tx, { mine: true }))).map((record) => record.data.what)).toEqual(["Quad bike training"]);
    await expect(as(owner)((tx) => addTraining(tx, { person: { name: "X" }, what: "x", completedOn: "2099-01-01" }, members))).rejects.toThrow(/after today/);
    await expect(as(owner)((tx) => addTraining(tx, { person: { name: "X" }, what: "x", completedOn: "2026-01-01", expiresOn: "2025-01-01" }, members))).rejects.toThrow(/expires before/);
    await expect(as(owner)((tx) => changeTraining(tx, quad.recordId, { step: "confirm", expectedVersion: 1 }, members))).rejects.toThrow(/Only the person/);
    await expect(as(staff, "farm app")((tx) => changeTraining(tx, quad.recordId, { step: "confirm", expectedVersion: 1 }, members))).rejects.toThrow(/Only the person/);
    const confirmed = await as(staff)((tx) => changeTraining(tx, quad.recordId, { step: "confirm", expectedVersion: 1 }, members));
    expect(confirmed).toMatchObject({ enteredByEmail: "eq-staff@example.com", data: { confirmedByPerson: true } });
    const changed = await as(owner)((tx) => changeTraining(tx, quad.recordId, { step: "update", expectedVersion: 2, expiresOn: inDays(200) }, members));
    expect(changed.data.confirmedByPerson).toBe(false);
  });

  it("FS33 the chemicals inventory: quantities as decimals, UN numbers, and safety data sheets to replace", async () => {
    const sheet = await as(staff)((tx) => uploadSafetyFile(tx, { farmId: w.home, fileName: "diesel-sds.pdf", contentType: "application/pdf", contentBase64: Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64") }));
    await expect(as(staff)((tx) => addChemical(tx, { farmId: w.home, name: "Diesel", maxQuantity: "lots", unit: "L" }))).rejects.toThrow(/as a number/);
    await expect(as(staff)((tx) => addChemical(tx, { farmId: w.home, name: "Diesel", maxQuantity: "-5", unit: "L" }))).rejects.toThrow(/more than zero/);
    await expect(as(staff)((tx) => addChemical(tx, { farmId: w.home, name: "Diesel", maxQuantity: "500" }))).rejects.toThrow(/unit/);
    await expect(as(staff)((tx) => addChemical(tx, { farmId: w.home, name: "Diesel", unNumber: "12" }))).rejects.toThrow(/four digits/);
    const diesel = await as(staff)((tx) => addChemical(tx, { farmId: w.home, name: "Diesel", unNumber: "UN 1202", maxQuantity: "1000.50", unit: "L", location: "Tank by the workshop", sds: { id: sheet.id }, sdsDate: "2024-05-01" }));
    expect(diesel.data).toMatchObject({ unNumber: "1202", maxQuantity: "1000.5", sds: { id: sheet.id, sha256: sheet.sha256 } });
    await as(staff)((tx) => addChemical(tx, { farmId: w.home, name: "Glyphosate", maxQuantity: "40", unit: "L", sdsDate: "2018-01-01" }));
    // A sheet over five years old isn't "needed": WorkSafe wants a new one when it's next supplied, or if it's changed (FS48, decision 967).
    await as(staff)((tx) => addChemical(tx, { farmId: w.home, name: "Petrol", unNumber: "1203", maxQuantity: "200", unit: "L", sds: { id: sheet.id }, sdsDate: "2018-01-01" }));
    const list = await as(viewer)((tx) => listChemicals(tx, w.home));
    expect(list.map((chemical) => [chemical.data.name, chemical.sdsNeeded, chemical.sdsStatus])).toEqual([
      ["Diesel", false, "ok"],
      ["Glyphosate", true, "missing"],
      ["Petrol", false, "check"],
    ]);
    await expect(as(staff)((tx) => changeChemical(tx, diesel.recordId, { expectedVersion: 1, removed: true }))).rejects.toThrow(/Say why/);
    await as(staff)((tx) => changeChemical(tx, diesel.recordId, { expectedVersion: 1, removed: true, why: "Tank taken away" }));
    expect((await as(viewer)((tx) => listChemicals(tx, w.home))).map((chemical) => chemical.data.name)).toEqual(["Glyphosate", "Petrol", "Diesel"]);
  });

  it("FS34 another farm's equipment and chemicals aren't found, and the history checks out", async () => {
    const runoffBike = await as(owner)((tx) => addEquipment(tx, { farmId: w.runoff, name: "Runoff bike", checklistId: w.checklist }, members));
    await expect(as(staff)((tx) => listEquipment(tx, w.runoff))).rejects.toThrow(/Farm not found/);
    await expect(as(staff)((tx) => recordCheck(tx, { equipmentId: runoffBike.recordId, checklistVersion: 2, answers: [] }, members))).rejects.toThrow(/wasn't found/);
    await expect(as(staff)((tx) => listChemicals(tx, w.runoff))).rejects.toThrow(/Farm not found/);
    await expect(as(staff)((tx) => addChemical(tx, { farmId: w.runoff, name: "x" }))).rejects.toThrow(/Farm not found/);
    expect((await as(owner)((tx) => checkSafetyHistory(tx))).problems).toEqual([]);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getAnimal } from "@/lib/farming/animal-detail";
import { importAnimals, importRecords, previewAnimalImport, previewRecordImport } from "@/lib/farming/animal-import";
import { createAnimal, listAnimals, moveAnimals, placeAnimal, setAnimalStatus } from "@/lib/farming/animals";
import { acceptSuggestion, declineSuggestion, listScales, listSuggestions, mobBcs, photosToScore, recordBcs, recordReadings, referencePhotos, setReference, setScale, suggestBcs, addPhotosToScore } from "@/lib/farming/bcs";
import { createMob, getMob, listMobs, mobAction } from "@/lib/farming/mobs";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { recordTreatment } from "@/lib/farming/treatments";
import { headCount, listMovements, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { uploadSafetyFile } from "@/lib/safety/files";
import { findAiTool } from "@/lib/ai/catalogue";
import { ToolFileAnswer } from "@/lib/ai/tools";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

/** Animals, weights and BCS (AN1-AN9, BCS1-BCS8; common NZ practice, not yet reviewed; decisions 1481-1495). Made-up data only. */
describeWithDatabase("farm animals and body condition", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("animals-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { livestock: boolean } = { livestock: false }) {
    organisations += 1;
    const org = `animals-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asStaff = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email, role: "farm_worker" }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    if (options.livestock) {
      await as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
      await as((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2026-06-01" }));
      await as((tx) => setOpenings(tx, { lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" }] }));
    }
    const farm = (await as((tx) => saveFarm(tx, { name: "Home block" })))[0];
    const a = await as((tx) => addPaddock(tx, { farmId: farm.id, name: "A", effectiveHa: "10.00", onDate: "2026-06-01" }));
    return { org, as, asStaff, farm, a };
  }

  const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]).toString("base64");

  it("AN1-AN3 adds animals and tags them into a mob without changing its head or the books", async () => {
    const w = await setup({ livestock: true });
    const milkers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 3, paddockId: w.a.id, onDate: "2026-07-01" }))).mob;
    const cow = await w.asStaff((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "214", eid: "982000123456789", sex: "female", breed: "Friesian", birthOn: "2021-08-01", mobId: milkers.id, onDate: "2026-07-02" }));
    expect(cow).toMatchObject({ tag: "214", status: "on_farm", mob: { id: milkers.id, name: "Milkers", since: "2026-07-02" } });
    await expect(w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "214" }))).rejects.toThrow("already an animal tagged 214");
    await expect(w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "215", eid: "982000123456789" }))).rejects.toThrow("already on 214");
    await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "301", mobId: milkers.id, damText: "214" }));
    await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "302", mobId: milkers.id }));
    // Three head, three tagged: a fourth can't be tagged in; the mob's head isn't changed by tagging.
    await expect(w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "303", mobId: milkers.id }))).rejects.toThrow("has 3 head and 3 tagged already");
    const mob = (await w.as((tx) => listMobs(tx, { farmId: w.farm.id })))[0];
    expect([mob.head, mob.tagged]).toEqual([3, 3]);
    expect(await w.as((tx) => listMovements(tx))).toEqual([]);
    // The dam typed as a tag on the farm is linked.
    const calf = (await w.as((tx) => listAnimals(tx, { farmId: w.farm.id, q: "301" })))[0];
    expect(calf.dam).toMatchObject({ id: cow.id, tag: "214" });
    // Sheep can't go in a dairy mob.
    await expect(w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "sheep", tag: "E1", mobId: milkers.id }))).rejects.toThrow("is dairy cattle");
  });

  it("AN4 a sale or death of tagged animals goes through the mob, once, naming the tags", async () => {
    const w = await setup({ livestock: true });
    const milkers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 10, onDate: "2026-07-01" }))).mob;
    const tags = [];
    for (const tag of ["11", "12", "13"]) tags.push(await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag, mobId: milkers.id, onDate: "2026-07-01" })));
    // A sale of 8 leaves 2 head but 3 tagged: refused until at least one tag is chosen.
    await expect(w.as((tx) => mobAction(tx, milkers.id, { action: "sell", head: 8, onDate: "2026-08-10" }))).rejects.toThrow("Choose at least 1 more");
    const sold = await w.as((tx) => mobAction(tx, milkers.id, { action: "sell", head: 8, amount: "14400.00", onDate: "2026-08-10", animalIds: [tags[0].id] }));
    expect(sold.mob).toMatchObject({ head: 2, tagged: 2 });
    expect((await w.as((tx) => listMovements(tx))).map((m) => [m.movementType, m.head])).toEqual([["sale", 8]]);
    const gone = (await w.as((tx) => listAnimals(tx, { farmId: w.farm.id, includeGone: true }))).find((animal) => animal.tag === "11")!;
    expect(gone).toMatchObject({ status: "sold", statusOn: "2026-08-10", mob: null });
    // The animal's status can't be set to sold or dead directly.
    await expect(w.as((tx) => setAnimalStatus(tx, tags[1].id, { status: "dead" }))).rejects.toThrow("Record the death on Milkers");
    // A count below the tagged animals is refused: 2 head, 2 tagged.
    await expect(w.as((tx) => mobAction(tx, milkers.id, { action: "count", head: 1, onDate: "2026-08-11" }))).rejects.toThrow("would have 1 head but 2 tagged");
    // Farm staff record a death, naming the tag.
    await w.asStaff((tx) => mobAction(tx, milkers.id, { action: "deaths", head: 1, onDate: "2026-08-12", animalIds: [tags[1].id] }));
    expect((await w.as((tx) => listAnimals(tx, { farmId: w.farm.id, includeGone: true }))).find((animal) => animal.tag === "12")!.status).toBe("dead");
    // More tags than head: refused. The last head can't go while a tagged animal is still in the mob.
    await expect(w.as((tx) => mobAction(tx, milkers.id, { action: "deaths", head: 1, onDate: "2026-08-13", animalIds: [tags[2].id, tags[0].id] }))).rejects.toThrow("Choose no more than 1");
    await expect(w.as((tx) => mobAction(tx, milkers.id, { action: "deaths", head: 1, onDate: "2026-08-15" }))).rejects.toThrow("still in it");
    const cows = (await w.as((tx) => headCount(tx, { yearEnd: "2027-05-31" }))).rows.find((row) => row.classCode === "ma_cows")!;
    expect([cows.sold, cows.died]).toEqual([8, 1]);
  });

  it("AN5 moving tagged animals between mobs of a class takes the head; split takes chosen tags; merge takes them all", async () => {
    const w = await setup({ livestock: true });
    const one = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Herd 1", kind: "dairy_cattle", classCode: "ma_cows", head: 5, onDate: "2026-07-01" }))).mob;
    const two = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Herd 2", kind: "dairy_cattle", classCode: "ma_cows", head: 4, onDate: "2026-07-01" }))).mob;
    const heifers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Heifers", kind: "dairy_cattle", classCode: "r2_heifers", head: 4, onDate: "2026-07-01" }))).mob;
    const cow = await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "21", mobId: one.id, onDate: "2026-07-01" }));
    const cow2 = await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "22", mobId: one.id, onDate: "2026-07-01" }));
    const moved = await w.asStaff((tx) => moveAnimals(tx, { animalIds: [cow.id], toMobId: two.id, onDate: "2026-07-05", operationId: randomUUID() }));
    expect(moved.message).toContain("Herd 2, which now has 5 head");
    const mobs = await w.as((tx) => listMobs(tx, { farmId: w.farm.id }));
    expect(mobs.map((mob) => [mob.name, mob.head, mob.tagged])).toEqual([
      ["Heifers", 4, 0],
      ["Herd 1", 4, 1],
      ["Herd 2", 5, 1],
    ]);
    expect(await w.as((tx) => listMovements(tx))).toEqual([]);
    await expect(w.as((tx) => moveAnimals(tx, { animalIds: [cow2.id], toMobId: heifers.id, onDate: "2026-07-05" }))).rejects.toThrow("A mob is one class");
    // A correction says which mob it's in: no head changes, and the mob needs room (Herd 2 has 5 head, 1 tagged).
    const corrected = await w.as((tx) => placeAnimal(tx, cow2.id, { mobId: two.id, onDate: "2026-07-05" }));
    expect(corrected.mob?.id).toBe(two.id);
    await w.as((tx) => placeAnimal(tx, cow2.id, { mobId: one.id, onDate: "2026-07-05" }));
    expect((await w.as((tx) => listMobs(tx, { farmId: w.farm.id }))).map((mob) => mob.head)).toEqual([4, 4, 5]);
    // Split: the tag chosen goes with the new mob.
    const split = await w.as((tx) => mobAction(tx, two.id, { action: "split", head: 2, name: "Herd 3", onDate: "2026-07-06", animalIds: [cow.id] }));
    expect(split.mob).toMatchObject({ head: 3, tagged: 0 });
    const three = (await w.as((tx) => listMobs(tx, { farmId: w.farm.id }))).find((mob) => mob.name === "Herd 3")!;
    expect([three.head, three.tagged]).toEqual([2, 1]);
    // Merge: every tag goes along.
    await w.as((tx) => mobAction(tx, three.id, { action: "merge", intoMobId: one.id, onDate: "2026-07-07" }));
    expect((await w.as((tx) => getMob(tx, one.id))).mob).toMatchObject({ head: 6, tagged: 2 });
    expect(await w.as((tx) => listMovements(tx))).toEqual([]);
    const detail = await w.as((tx) => getAnimal(tx, cow.id));
    expect(detail.mobs.map((spell) => [spell.mobName, spell.howIn, spell.howOut])).toEqual([
      ["Herd 1", "merged", null],
      ["Herd 3", "split", "merged"],
      ["Herd 2", "moved", "split"],
      ["Herd 1", "tagged", "moved"],
    ]);
  });

  it("AN6 missing stays in its mob; AN7 a weigh session's average is worked out from each tag; AN8 gain per day", async () => {
    const w = await setup();
    const steers = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Steers", kind: "beef_cattle", classCode: "r2_steers_bulls", head: 5, onDate: "2026-08-01" }))).mob;
    const ids: string[] = [];
    for (const tag of ["S1", "S2", "S3"]) ids.push((await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "beef_cattle", tag, mobId: steers.id, onDate: "2026-08-01" }))).id);
    const missing = await w.as((tx) => setAnimalStatus(tx, ids[2], { status: "missing", onDate: "2026-08-20" }));
    expect(missing).toMatchObject({ status: "missing", mob: { id: steers.id } });
    expect((await w.as((tx) => setAnimalStatus(tx, ids[2], { status: "on_farm" }))).status).toBe("on_farm");
    // Session from weights typed for each tag: 412.0 + 430.5 + 401.0 = 1243.5 / 3 = 414.5.
    const session = await w.asStaff((tx) => mobAction(tx, steers.id, { action: "weigh", onDate: "2026-09-01", animalWeights: [{ animalId: ids[0], kg: "412" }, { animalId: ids[1], kg: "430.5" }, { animalId: ids[2], kg: "401" }] }));
    expect(session.mob.lastWeight).toMatchObject({ averageKg: "414.5", weighedHead: 3 });
    // Quick entry weights one by one, then "Finish" works out the mob's average.
    const op = randomUUID();
    await w.asStaff((tx) => recordReadings(tx, ids[0], { kg: "436", onDate: "2026-10-01", operationId: op }));
    expect((await w.asStaff((tx) => recordReadings(tx, ids[0], { kg: "436", onDate: "2026-10-01", operationId: op }))).message).toContain("weight already recorded");
    await w.asStaff((tx) => recordReadings(tx, ids[1], { kg: "451.0", onDate: "2026-10-01" }));
    const finish = await w.asStaff((tx) => mobAction(tx, steers.id, { action: "weigh", onDate: "2026-10-01", fromTagWeights: true }));
    expect(finish.mob.lastWeight).toMatchObject({ averageKg: "443.5", weighedHead: 2, gain: { kg: "29.0", days: 30 } });
    await expect(w.asStaff((tx) => mobAction(tx, steers.id, { action: "weigh", onDate: "2026-10-01", fromTagWeights: true }))).rejects.toThrow("No tag weights");
    // S1: 412.0 on 1 Sep, 436.0 on 1 Oct: +24.0 kg over 30 days, 0.80 kg a day.
    const s1 = await w.as((tx) => getAnimal(tx, ids[0]));
    expect(s1.weights.map((weight) => [weight.date, weight.kg, weight.gain?.kgPerDay ?? null])).toEqual([
      ["2026-10-01", "436.0", "0.80"],
      ["2026-09-01", "412.0", null],
    ]);
  });

  it("BCS1-BCS4 scores per animal and per mob, the scale per kind, and the mob's trend with targets", async () => {
    const w = await setup();
    const cows = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Cows", kind: "dairy_cattle", classCode: "ma_cows", head: 50, onDate: "2026-06-01" }))).mob;
    const ewes = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Ewes", kind: "sheep", classCode: "ma_ewes", head: 200, onDate: "2026-06-01" }))).mob;
    const cow = await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "7", mobId: cows.id, onDate: "2026-06-01" }));
    const scales = await w.as((tx) => listScales(tx, { farmId: w.farm.id }));
    expect(scales.find((entry) => entry.kind === "dairy_cattle")).toMatchObject({ scale: "1_10", targets: { targets: [{ when: "At calving", score: "5.0" }, { score: "5.5" }, { score: "4.0" }, { score: "4.5" }] } });
    expect(scales.find((entry) => entry.kind === "sheep")).toMatchObject({ scale: "1_5", targets: { floor: { score: "3.0" } } });
    expect(scales.find((entry) => entry.kind === "goats_dairy")).toMatchObject({ scale: "1_5", targets: null });
    // BCS1: half points, on the kind's scale.
    expect((await w.asStaff((tx) => recordBcs(tx, { animalId: cow.id, score: "4.5", onDate: "2026-07-01" }))).record.score).toBe("4.5");
    await expect(w.as((tx) => recordBcs(tx, { animalId: cow.id, score: "4.3" }))).rejects.toThrow("half points");
    await expect(w.as((tx) => recordBcs(tx, { mobId: ewes.id, average: "6" }))).rejects.toThrow("from 1 to 5");
    // BCS2: a tally of 50 cows: 12 at 4.0, 30 at 4.5, 8 at 5.0 is 4.46, so 4.5.
    const tally = await w.as((tx) => recordBcs(tx, { mobId: cows.id, tally: { "4.0": 12, "4.5": 30, "5": 8 }, onDate: "2026-07-15" }));
    expect(tally.record).toMatchObject({ score: "4.5", headScored: 50, tally: { "4.0": 12, "4.5": 30, "5.0": 8 } });
    await expect(w.as((tx) => recordBcs(tx, { mobId: cows.id, tally: { "4.0": 51 } }))).rejects.toThrow("has 50");
    // BCS3: an average and how many.
    await w.as((tx) => recordBcs(tx, { mobId: ewes.id, average: "2.85", headScored: 120, onDate: "2026-07-15" }));
    // BCS4: the trend has the tagged cow's day and the mob's own records; targets on the default scale.
    const trend = await w.as((tx) => mobBcs(tx, cows.id));
    expect(trend.trend.map((point) => [point.date, point.score, point.from])).toEqual([
      ["2026-07-01", "4.5", "tags"],
      ["2026-07-15", "4.5", "mob"],
    ]);
    expect((await w.as((tx) => mobBcs(tx, ewes.id))).records[0]).toMatchObject({ score: "2.9", headScored: 120 });
    // A farm can change a kind's scale (admins): then no targets, and old scores keep theirs.
    await expect(w.asStaff((tx) => setScale(tx, { farmId: w.farm.id, kind: "dairy_cattle", scale: "1_5" }))).rejects.toThrow("admin");
    await w.as((tx) => setScale(tx, { farmId: w.farm.id, kind: "dairy_cattle", scale: "1_5" }));
    const after = await w.as((tx) => mobBcs(tx, cows.id));
    expect([after.scale, after.targets, after.trend.length, after.records[0].scale]).toEqual(["1_5", null, 0, "1_10"]);
  });

  it("AN9 and BCS6 import animals and scores; unmatched tags are listed, never made", async () => {
    const w = await setup();
    const ewes = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Ewes", kind: "sheep", classCode: "ma_ewes", head: 3, onDate: "2026-06-01" }))).mob;
    const content = ["Tag,EID,Sex,Breed,DOB,Dam,Mob", "E1,,F,Romney,01/09/2023,,Ewes", "E2,,ewe,Romney,2023-09-02,E1,Ewes", "E3,,F,,2023-09-02,X9,Ewes", "E4,,F,,,,Ewes", "E5,,Q,,,,"].join("\n");
    const preview = await w.as((tx) => previewAnimalImport(tx, w.farm.id, { fileName: "flock.csv", content, kind: "sheep" }));
    expect(preview.rows.map((row) => row.error)).toEqual([null, null, null, expect.stringContaining("no untagged head left"), '"Q" isn\'t a sex Tohyee knows (F, M or castrated).']);
    expect(preview.counts).toEqual({ animals: 3, errors: 2, damsTyped: 1 });
    expect(await w.as((tx) => importAnimals(tx, w.farm.id, { fileName: "flock.csv", content, kind: "sheep" }))).toEqual({ imported: 3, skipped: 2 });
    await expect(w.as((tx) => importAnimals(tx, w.farm.id, { fileName: "flock.csv", content, kind: "sheep" }))).rejects.toThrow("already imported");
    const animals = await w.as((tx) => listAnimals(tx, { farmId: w.farm.id }));
    expect(animals.map((animal) => [animal.tag, animal.birthOn, animal.dam?.tag ?? animal.damText, animal.mob?.id])).toEqual([
      ["E1", "2023-09-01", null, ewes.id],
      ["E2", "2023-09-02", "E1", ewes.id],
      ["E3", "2023-09-02", "X9", ewes.id],
    ]);
    expect((await w.as((tx) => getMob(tx, ewes.id))).mob).toMatchObject({ head: 3, tagged: 3 });
    const scores = ["Visual tag,Date,BCS,Weight (kg)", "E1,15/10/2026,3.5,68.2", "e2,2026-10-15,2.5,", "E9,2026-10-15,3,60", "E3,2026-10-15,6,", "E3,2026-10-15,,61"].join("\n");
    const records = await w.as((tx) => previewRecordImport(tx, w.farm.id, { fileName: "scale.csv", content: scores }));
    expect(records.unmatched).toEqual(["E9"]);
    expect(records.counts).toEqual({ scores: 2, weights: 2, errors: 2 });
    expect(await w.as((tx) => importRecords(tx, w.farm.id, { fileName: "scale.csv", content: scores }))).toEqual({ scores: 2, weights: 2, skipped: 2 });
    expect((await w.as((tx) => listAnimals(tx, { farmId: w.farm.id }))).length).toBe(3);
    const e1 = await w.as((tx) => getAnimal(tx, animals[0].id));
    expect([e1.bcs[0].score, e1.bcs[0].source, e1.weights[0].kg]).toEqual(["3.5", "import", "68.2"]);
  });

  it("an animal's page links treatments by its tag and by its mob while it was in it", async () => {
    const w = await setup();
    const mob = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Cows", kind: "dairy_cattle", classCode: "ma_cows", head: 10, onDate: "2026-06-01" }))).mob;
    const cow = await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "YB 214", mobId: mob.id, onDate: "2026-07-01" }));
    await w.as((tx) => recordTreatment(tx, { farmId: w.farm.id, animals: "yb214, 233 lame", head: 2, treatedOn: "2026-07-10", product: "Made-up drench", dose: "10 mL", givenBy: "Vet" }));
    await w.as((tx) => recordTreatment(tx, { farmId: w.farm.id, mobId: mob.id, head: 10, treatedOn: "2026-06-20", product: "Before it came", dose: "5 mL", givenBy: "Me" }));
    await w.as((tx) => recordTreatment(tx, { farmId: w.farm.id, mobId: mob.id, head: 10, treatedOn: "2026-07-20", product: "Whole mob", dose: "5 mL", givenBy: "Me" }));
    const detail = await w.as((tx) => getAnimal(tx, cow.id));
    expect(detail.treatments.map((treatment) => [treatment.product, treatment.how])).toEqual([
      ["Whole mob", "mob"],
      ["Made-up drench", "tag"],
    ]);
  });

  it("BCS7 AI suggestions are kept apart until a person accepts; declining records nothing", async () => {
    const w = await setup();
    const mob = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Cows", kind: "dairy_cattle", classCode: "ma_cows", head: 10, onDate: "2026-06-01" }))).mob;
    const cow = await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "9", mobId: mob.id, onDate: "2026-06-01" }));
    const upload = async () => (await w.as((tx) => uploadSafetyFile(tx, { farmId: w.farm.id, fileName: "cow.png", contentType: "image/png", contentBase64: png() }))).id;
    const files = [await upload(), await upload()];
    await w.asStaff((tx) => addPhotosToScore(tx, { animalId: cow.id, files: files.map((id) => ({ id })), onDate: "2026-10-01" }));
    const waiting = await w.as((tx) => photosToScore(tx, { animalId: cow.id }));
    expect(waiting.length).toBe(2);
    const first = await w.as((tx) => suggestBcs(tx, { idempotencyKey: "bcs-key-1", photoId: waiting[0].photoId, score: 4.5, estimatedKg: 520, reasoning: "Ribs just seen, hips rounded." }));
    expect(first.created).toBe(true);
    expect((await w.as((tx) => suggestBcs(tx, { idempotencyKey: "bcs-key-1", photoId: waiting[0].photoId, score: 4.5, estimatedKg: 520, reasoning: "Ribs just seen, hips rounded." }))).created).toBe(false);
    await expect(w.as((tx) => suggestBcs(tx, { idempotencyKey: "bcs-key-2", photoId: waiting[0].photoId, score: 5, reasoning: "Again." }))).rejects.toThrow("has a suggestion already");
    await expect(w.as((tx) => suggestBcs(tx, { idempotencyKey: "bcs-key-3", photoId: waiting[1].photoId, score: 4.3, reasoning: "Odd." }))).rejects.toThrow("half points");
    const second = await w.as((tx) => suggestBcs(tx, { idempotencyKey: "bcs-key-4", photoId: waiting[1].photoId, score: 3, reasoning: "Thin, poor light." }));
    // Not counted until accepted.
    let page = await w.as((tx) => getAnimal(tx, cow.id));
    expect([page.bcs.length, page.weights.length, page.animal.lastBcs]).toEqual([0, 0, null]);
    expect((await w.as((tx) => mobBcs(tx, mob.id))).trend).toEqual([]);
    // Accepted, changed to 5.0, with the weight: a normal record noting the suggestion and who accepted it.
    const accepted = await w.asStaff((tx) => acceptSuggestion(tx, first.suggestion.id, { score: "5", acceptWeight: true }));
    expect(accepted).toMatchObject({ status: "accepted", decidedScore: "5.0", decidedKg: "520.0" });
    const declined = await w.asStaff((tx) => declineSuggestion(tx, second.suggestion.id, { reason: "Wrong cow" }));
    expect(declined.status).toBe("declined");
    page = await w.as((tx) => getAnimal(tx, cow.id));
    expect(page.bcs.map((record) => [record.score, record.source, record.note])).toEqual([["5.0", "ai_suggestion", `From an AI suggestion (4.5), changed; accepted by ${owner.email}`]]);
    expect(page.weights.map((weight) => [weight.kg, weight.source])).toEqual([["520.0", "ai_suggestion"]]);
    await expect(w.as((tx) => acceptSuggestion(tx, second.suggestion.id))).rejects.toThrow("already declined");
    expect((await w.as((tx) => listSuggestions(tx, { animalId: cow.id }))).map((entry) => entry.status).sort()).toEqual(["accepted", "declined"]);
    // A score from a suggestion can't be a reference.
    await expect(w.as((tx) => setReference(tx, waiting[0].photoId, {}))).rejects.toThrow("given by eye");
  });

  it("BCS8 reference photos are the organisation's own, scored by eye; another organisation sees nothing", async () => {
    const w = await setup();
    const other = await setup();
    const mob = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Cows", kind: "dairy_cattle", classCode: "ma_cows", head: 10, onDate: "2026-06-01" }))).mob;
    const cow = await w.as((tx) => createAnimal(tx, { farmId: w.farm.id, kind: "dairy_cattle", tag: "5", mobId: mob.id, onDate: "2026-06-01" }));
    const file = (await w.as((tx) => uploadSafetyFile(tx, { farmId: w.farm.id, fileName: "five.png", contentType: "image/png", contentBase64: png() }))).id;
    const scored = await w.as((tx) => recordBcs(tx, { animalId: cow.id, score: "5", files: [{ id: file }], onDate: "2026-09-01" }));
    const photoId = scored.record.photos[0].id;
    expect((await w.as((tx) => setReference(tx, photoId, {}))).reference).toEqual({ kind: "dairy_cattle", scale: "1_10", score: "5.0" });
    const mobFile = (await w.as((tx) => uploadSafetyFile(tx, { farmId: w.farm.id, fileName: "mob.png", contentType: "image/png", contentBase64: png() }))).id;
    const mobScore = await w.as((tx) => recordBcs(tx, { mobId: mob.id, average: "4.5", files: [{ id: mobFile }], onDate: "2026-09-02" }));
    await expect(w.as((tx) => setReference(tx, mobScore.record.photos[0].id, {}))).rejects.toThrow("Enter the score you gave by eye");
    await w.as((tx) => setReference(tx, mobScore.record.photos[0].id, { score: "4" }));
    expect((await w.as((tx) => referencePhotos(tx, { kind: "dairy_cattle", scale: "1_10" }))).map((ref) => ref.score)).toEqual(["4.0", "5.0"]);
    expect((await w.as((tx) => listScales(tx, { farmId: w.farm.id }))).find((entry) => entry.kind === "dairy_cattle")!.references).toEqual(["4.0", "5.0"]);
    // A reference isn't a photo to score.
    expect(await w.as((tx) => photosToScore(tx, {}))).toEqual([]);
    // The AI looks at a photo to score beside the farm's references, and says which it used.
    const toScore = (await w.as((tx) => uploadSafetyFile(tx, { farmId: w.farm.id, fileName: "new.png", contentType: "image/png", contentBase64: png() }))).id;
    await w.as((tx) => addPhotosToScore(tx, { animalId: cow.id, files: [{ id: toScore }] }));
    const [photo] = await w.as((tx) => photosToScore(tx, {}));
    expect([findAiTool("get_bcs_photos_to_score")!.level, findAiTool("suggest_bcs")!.level]).toEqual(["read", "draft"]);
    const looked = await w.as((tx) => findAiTool("get_bcs_photos_to_score")!.run(tx, { photoIds: [photo.photoId] }, {} as never));
    expect(looked).toBeInstanceOf(ToolFileAnswer);
    const answer = (looked as ToolFileAnswer).answer as { images: Array<{ photoId: string; reference?: boolean; score?: string; toScore?: boolean }>; scale: { scale: string } };
    expect(answer.scale.scale).toBe("1_10");
    expect(answer.images.map((image) => [image.toScore ?? false, image.score ?? null])).toEqual([
      [true, null],
      [false, "4.0"],
      [false, "5.0"],
    ]);
    expect((looked as ToolFileAnswer).more.length).toBe(2);
    const refs = answer.images.filter((image) => image.reference).map((image) => image.photoId);
    const suggested = await w.as((tx) => findAiTool("suggest_bcs")!.run(tx, { photoId: photo.photoId, score: 4.5, reasoning: "Between the 4.0 and 5.0 references.", referencePhotoIds: refs, idempotencyKey: "ai-suggest-1" }, {} as never));
    expect((suggested as { suggestion: { referencePhotoIds: string[]; status: string } }).suggestion).toMatchObject({ referencePhotoIds: refs, status: "waiting" });
    // The other organisation has its own database: none of this is there.
    expect(await other.as((tx) => referencePhotos(tx, { kind: "dairy_cattle", scale: "1_10" }))).toEqual([]);
    expect(await other.as((tx) => photosToScore(tx, {}))).toEqual([]);
    expect((await other.as((tx) => listScales(tx, { farmId: other.farm.id }))).find((entry) => entry.kind === "dairy_cattle")!.references).toEqual([]);
    await expect(other.as((tx) => suggestBcs(tx, { idempotencyKey: "other-key-1", photoId, score: 5, reasoning: "From the other organisation." }))).rejects.toThrow("wasn't found");
  });
});

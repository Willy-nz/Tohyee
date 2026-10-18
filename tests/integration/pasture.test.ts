import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readBooks } from "@/lib/analytics/books";
import { closeAnalytics, queryAnalytics, replaceTohyeeTables } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import {
  addGrazing,
  addReading,
  addSupplement,
  closeGrazing,
  importReadings,
  listReadings,
  paddockPasture,
  pastureSummary,
  previewReadingImport,
  removeReading,
} from "@/lib/farming/pasture";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

/** Pasture and feed records (#249 stage 4; PF1-PF8, not yet reviewed). Each test gets its own organisation. */
describeWithDatabase("pasture and feed records", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;
  let root: string;
  const analysed: string[] = [];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-pasture-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("pasture-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    for (const org of analysed) await closeAnalytics(org);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function setup() {
    organisations += 1;
    const org = `pasture-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await as((tx) => saveFarm(tx, { name: "Home block" })))[0];
    const paddock = (name: string, effectiveHa: string) => as((tx) => addPaddock(tx, { farmId: farm.id, name, effectiveHa, onDate: "2026-07-01" }));
    return { org, as, farm, a: await paddock("A", "10.00"), b: await paddock("B", "5.00"), c: await paddock("C", "8.00") };
  }

  it("PF1-PF4 readings, growth and the farm's cover and feed wedge on a date", async () => {
    const w = await setup();
    await w.as((tx) => addReading(tx, { paddockId: w.a.id, measuredOn: "2026-09-01", cover: "2,100", method: "plate_meter" }));
    await w.as((tx) => addReading(tx, { paddockId: w.a.id, measuredOn: "2026-09-15", cover: 2500, method: "plate_meter" }));
    await w.as((tx) => addReading(tx, { paddockId: w.b.id, measuredOn: "2026-09-10", cover: 1900, method: "satellite" }));
    await expect(w.as((tx) => addReading(tx, { paddockId: w.b.id, measuredOn: "2026-09-10", cover: "20001", method: "visual" }))).rejects.toThrow("from 0 to 20,000");
    await expect(w.as((tx) => addReading(tx, { paddockId: w.b.id, measuredOn: "2026-09-10", cover: "1900", method: "clicks" }))).rejects.toThrow("Method must be one of");
    const summary = await w.as((tx) => pastureSummary(tx, { farmId: w.farm.id, onDate: "2026-09-20" }));
    expect(summary.cover).toMatchObject({ averageKgDmPerHa: 2300, totalKgDm: 34500, hectares: "15.00", estimates: 1, readings: 2, noReading: ["C"], oldestReading: "2026-09-10" });
    expect(summary.cover.wedge.map((entry) => [entry.name, entry.cover])).toEqual([["A", 2500], ["B", 1900]]);
    // A's growth: (2,500 - 2,100) ÷ 14 = 28.6.
    expect(summary.paddocks.find((entry) => entry.name === "A")!.growth).toMatchObject({ kind: "rate", kgDmPerHaPerDay: "28.6" });
    // On an earlier date only the readings up to then count.
    const earlier = await w.as((tx) => pastureSummary(tx, { farmId: w.farm.id, onDate: "2026-09-05" }));
    expect([earlier.cover.averageKgDmPerHa, earlier.cover.noReading]).toEqual([2100, ["B", "C"]]);
  });

  it("PF5 grazings: one mob in at a time, the day out, and what was eaten; growth isn't shown across a grazing", async () => {
    const w = await setup();
    await w.as((tx) => addReading(tx, { paddockId: w.a.id, measuredOn: "2026-09-01", cover: 2800, method: "plate_meter" }));
    const grazing = await w.as((tx) => addGrazing(tx, { paddockId: w.a.id, mob: "Milkers", head: "220", inOn: "2026-09-03", preCover: 2800 }));
    expect(grazing.eaten).toBeNull();
    await expect(w.as((tx) => addGrazing(tx, { paddockId: w.a.id, mob: "Heifers", inOn: "2026-09-03" }))).rejects.toThrow("already has a mob in it");
    await expect(w.as((tx) => closeGrazing(tx, grazing.id, { outOn: "2026-09-02" }))).rejects.toThrow("can't be before the day in");
    const closed = await w.as((tx) => closeGrazing(tx, grazing.id, { outOn: "2026-09-04", postCover: 1600 }));
    expect(closed.eaten).toEqual({ perHa: 1200, totalKgDm: 12000, perHead: "54.5" });
    await expect(w.as((tx) => closeGrazing(tx, grazing.id, { outOn: "2026-09-05" }))).rejects.toThrow("already recorded");
    await w.as((tx) => addReading(tx, { paddockId: w.a.id, measuredOn: "2026-09-10", cover: 1800, method: "plate_meter" }));
    await w.as((tx) => addReading(tx, { paddockId: w.a.id, measuredOn: "2026-09-24", cover: 2220, method: "plate_meter" }));
    const history = await w.as((tx) => paddockPasture(tx, w.a.id));
    expect(history.readings.map((entry) => [entry.measuredOn, entry.growth?.kind === "rate" ? entry.growth.kgDmPerHaPerDay : entry.growth?.reason ?? null])).toEqual([
      ["2026-09-24", "30.0"],
      ["2026-09-10", "grazed"],
      ["2026-09-01", null],
    ]);
  });

  it("PF6 supplements by month in kg DM, with uncounted feed named", async () => {
    const w = await setup();
    await w.as((tx) => addSupplement(tx, { farmId: w.farm.id, fedOn: "2026-08-01", feed: "Baleage", quantity: "20", unit: "bales", kgDm: "4000", mob: "Milkers" }));
    await w.as((tx) => addSupplement(tx, { farmId: w.farm.id, paddockId: w.b.id, fedOn: "2026-08-02", feed: "PKE", quantity: "2000", unit: "kg_dm" }));
    await w.as((tx) => addSupplement(tx, { farmId: w.farm.id, fedOn: "2026-08-03", feed: "Hay", quantity: "10", unit: "bales" }));
    await expect(w.as((tx) => addSupplement(tx, { farmId: w.farm.id, fedOn: "2026-08-03", feed: "PKE", quantity: "100", unit: "kg_dm", kgDm: "100" }))).rejects.toThrow("its own kg DM");
    const summary = await w.as((tx) => pastureSummary(tx, { farmId: w.farm.id, onDate: "2026-08-31" }));
    expect(summary.supplementMonths).toEqual([{ month: "2026-08", kgDm: "6000.00", notCounted: [{ fedOn: "2026-08-03", feed: "Hay", quantity: "10.00", unit: "bales" }] }]);
  });

  it("PF7, PF8 importing readings with a preview, the same file once; removing; the analytics tables", async () => {
    const w = await setup();
    const csv = ["Paddock,Date,Cover (kg DM/ha)", "A,15/09/2026,2450", "b,15/09/2026,\"2,100\"", "Z,15/09/2026,1800", "C,15/9/26,lots"].join("\n");
    const preview = await w.as((tx) => previewReadingImport(tx, w.farm.id, { fileName: "walk.csv", content: csv, method: "plate_meter" }));
    expect(preview.columns).toEqual({ paddock: 0, date: 1, cover: 2, method: null });
    expect(preview.rows.map((row) => [row.paddockText, row.cover, row.error])).toEqual([
      ["A", 2450, null],
      ["b", 2100, null],
      ["Z", 1800, 'No paddock called "Z" on this farm.'],
      ["C", null, '"lots" isn\'t a whole number of kg DM/ha from 0 to 20,000.'],
    ]);
    const noMethod = await w.as((tx) => previewReadingImport(tx, w.farm.id, { fileName: "walk.csv", content: csv }));
    expect(noMethod.rows[0].error).toBe("No method: choose one for the file.");
    expect(await w.as((tx) => importReadings(tx, w.farm.id, { fileName: "walk.csv", content: csv, method: "plate_meter" }))).toEqual({ imported: 2, skipped: 2 });
    await expect(w.as((tx) => importReadings(tx, w.farm.id, { fileName: "walk again.csv", content: csv, method: "plate_meter" }))).rejects.toThrow("already imported");
    const readings = await w.as((tx) => listReadings(tx, { farmId: w.farm.id }));
    expect(readings.map((entry) => [entry.paddockName, entry.cover, entry.source])).toEqual([
      ["B", 2100, "Imported from walk.csv"],
      ["A", 2450, "Imported from walk.csv"],
    ]);
    await w.as((tx) => removeReading(tx, readings[0].id));
    await expect(w.as((tx) => removeReading(tx, readings[0].id))).rejects.toThrow("already removed");
    await w.as((tx) => addGrazing(tx, { paddockId: w.a.id, mob: "Milkers", inOn: "2026-09-16", outOn: "2026-09-17", preCover: 2450, postCover: 1550 }));
    await w.as((tx) => addSupplement(tx, { farmId: w.farm.id, fedOn: "2026-09-16", feed: "PKE", quantity: "500", unit: "kg_dm" }));

    analysed.push(w.org);
    await w.as(async (tx) => replaceTohyeeTables(w.org, await readBooks(tx)));
    const q = (sql: string) => queryAnalytics(w.org, sql);
    expect(await q("select paddock, cover_kg_dm_ha, method, estimate from tohyee_farm_pasture_readings")).toEqual([{ paddock: "A", cover_kg_dm_ha: 2450, method: "plate_meter", estimate: false }]);
    expect(await q("select paddock, mob, pre_cover_kg_dm_ha - post_cover_kg_dm_ha as eaten from tohyee_farm_grazings")).toEqual([{ paddock: "A", mob: "Milkers", eaten: 900 }]);
    expect(await q("select feed, kg_dm::varchar as kg_dm from tohyee_farm_supplements")).toEqual([{ feed: "PKE", kg_dm: "500.00" }]);
  });
});

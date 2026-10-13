import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { areaHectares, hectaresText, parseGeometry } from "@/lib/farming/geometry";
import {
  addPaddock,
  getFarmingSettings,
  getPaddock,
  importBoundaries,
  listFarms,
  listPaddocks,
  mergePaddocks,
  previewBoundaryImport,
  saveFarm,
  setBoundary,
  setFarmingEnabled,
  setImageryKey,
  splitPaddock,
  updatePaddock,
} from "@/lib/farming/paddocks";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

const box = (west: number, south = -46.2, width = 0.0065, height = 0.004) => ({
  type: "Polygon",
  coordinates: [
    [
      [west, south],
      [west + width, south],
      [west + width, south + height],
      [west, south + height],
      [west, south],
    ],
  ],
});

const feature = (name: string | number, geometry: unknown, extra: Record<string, unknown> = {}) => ({ type: "Feature", properties: { Paddock: name, ...extra }, geometry });

/** Farming stage 1 (#249, decision 514; FB1 and FB7's areas and splits). Each test gets its own organisation. */
describeWithDatabase("farms and paddocks", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("farm-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `farm-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await as((tx) => saveFarm(tx, { name: "Kōwhai Dairies home block" })))[0];
    return { org, as, farm };
  }

  it("Farming needs Accounting, and is off until turned on", async () => {
    organisations += 1;
    const org = `farm-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await expect(as((tx) => listFarms(tx))).rejects.toThrow("Farming is off");
    await as((tx) => updateOrganisationSettings(tx, { accountingEnabled: false, crmEnabled: true }));
    await expect(as((tx) => setFarmingEnabled(tx, { enabled: true }))).rejects.toThrow("Turn Accounting on first.");
  });

  it("FB1: a paddock keeps the farmer's effective area beside the mapped one", async () => {
    const w = await setup();
    const geometry = box(169.9);
    const paddock = await w.as((tx) => addPaddock(tx, { farmId: w.farm.id, name: "12", effectiveHa: "20.0", geometry, onDate: "2026-07-01" }));
    expect(paddock).toMatchObject({ name: "12", effectiveHa: "20.00", mappedHa: hectaresText(areaHectares(parseGeometry(geometry))), status: "active", createdOn: "2026-07-01" });
    expect(Number(paddock.mappedHa)).toBeGreaterThan(21);
    // Renaming keeps its identity; a new boundary is a new version.
    const renamed = await w.as((tx) => updatePaddock(tx, paddock.id, { name: "12 Back" }));
    expect(renamed.id).toBe(paddock.id);
    await w.as((tx) => setBoundary(tx, paddock.id, { geometry: box(169.9, -46.2, 0.006) }));
    const history = await w.as((tx) => getPaddock(tx, paddock.id));
    expect(history.boundaries).toHaveLength(2);
    expect(history.mappedHa).toBe(history.boundaries[0].mappedHa);
    // Two paddocks with one name on a farm are refused; farms list their totals.
    await expect(w.as((tx) => addPaddock(tx, { farmId: w.farm.id, name: "12 back" }))).rejects.toThrow("already has a paddock called 12 back");
    expect((await w.as((tx) => listFarms(tx)))[0]).toMatchObject({ activePaddocks: 1, effectiveHa: "20.00" });
  });

  it("two organisations can both have a paddock 12 without anything crossing over", async () => {
    const a = await setup();
    const b = await setup();
    await a.as((tx) => addPaddock(tx, { farmId: a.farm.id, name: "12", effectiveHa: "20" }));
    await b.as((tx) => addPaddock(tx, { farmId: b.farm.id, name: "12", effectiveHa: "8" }));
    expect((await a.as((tx) => listPaddocks(tx, { farmId: a.farm.id }))).map((p) => p.effectiveHa)).toEqual(["20.00"]);
    expect((await b.as((tx) => listPaddocks(tx, { farmId: b.farm.id }))).map((p) => p.effectiveHa)).toEqual(["8.00"]);
  });

  it("FB7: splitting 14 into 14A and 14B keeps 14's history, and merging links back", async () => {
    const w = await setup();
    const fourteen = await w.as((tx) => addPaddock(tx, { farmId: w.farm.id, name: "14", effectiveHa: "15.0", geometry: box(169.95), onDate: "2026-07-01" }));
    await expect(w.as((tx) => splitPaddock(tx, fourteen.id, { onDate: "2026-11-01", parts: [{ name: "14A", effectiveHa: "9" }] }))).rejects.toThrow("at least 2");
    const after = await w.as((tx) =>
      splitPaddock(tx, fourteen.id, {
        onDate: "2026-11-01",
        parts: [
          { name: "14A", effectiveHa: "9.0", geometry: box(169.95, -46.2, 0.0039) },
          { name: "14B", effectiveHa: "6.0", geometry: box(169.9539, -46.2, 0.0026) },
        ],
      }),
    );
    const old = after.find((paddock) => paddock.id === fourteen.id)!;
    expect(old).toMatchObject({ status: "retired", retiredOn: "2026-11-01", effectiveHa: "15.00", mappedHa: fourteen.mappedHa });
    expect(old.became.map((entry) => [entry.name, entry.kind])).toEqual([
      ["14A", "split"],
      ["14B", "split"],
    ]);
    const a = after.find((paddock) => paddock.name === "14A")!;
    expect(a).toMatchObject({ createdOn: "2026-11-01", effectiveHa: "9.00", boundarySource: "Split from 14" });
    expect(a.cameFrom).toEqual([{ id: fourteen.id, name: "14", kind: "split", onDate: "2026-11-01" }]);
    // A retired paddock can't change, and its name can be used again.
    await expect(w.as((tx) => updatePaddock(tx, fourteen.id, { effectiveHa: "16" }))).rejects.toThrow("was retired on 2026-11-01");
    await w.as((tx) => addPaddock(tx, { farmId: w.farm.id, name: "14", effectiveHa: "1" }));
    // Merging 14A and 14B back.
    const merged = await w.as((tx) => mergePaddocks(tx, { paddockIds: [a.id, after.find((p) => p.name === "14B")!.id], onDate: "2027-03-01", name: "14AB", effectiveHa: "15" }));
    const whole = merged.find((paddock) => paddock.name === "14AB")!;
    expect(whole.cameFrom.map((entry) => [entry.name, entry.kind])).toEqual(
      expect.arrayContaining([
        ["14A", "merge"],
        ["14B", "merge"],
      ]),
    );
    expect((await w.as((tx) => listPaddocks(tx, { farmId: w.farm.id }))).map((p) => p.name)).toEqual(["14", "14AB"]);
  });

  it("imports a GeoJSON file with a preview; the same file twice adds nothing", async () => {
    const w = await setup();
    await w.as((tx) => addPaddock(tx, { farmId: w.farm.id, name: "12", effectiveHa: "20", geometry: box(169.9), onDate: "2026-07-01" }));
    const file = JSON.stringify({
      type: "FeatureCollection",
      features: [
        feature(12, box(169.9)), // the same shape: unchanged
        feature("13", box(169.91), { Eff_Ha: 18.5 }),
        feature("14", box(169.92)),
        feature("Bad", { type: "Polygon", coordinates: [[[169.93, -46.2], [169.94, -46.19], [169.94, -46.2], [169.93, -46.19], [169.93, -46.2]]] }),
      ],
    });
    const preview = await w.as((tx) => previewBoundaryImport(tx, w.farm.id, { fileName: "paddocks.geojson", content: file }));
    expect(preview).toMatchObject({ nameProperty: "Paddock", effectiveProperty: "Eff_Ha", alreadyImportedOn: null, counts: { new: 2, newBoundary: 0, unchanged: 1, errors: 1 } });
    expect(preview.rows.map((row) => [row.name, row.action, row.effectiveHa])).toEqual([
      ["12", "unchanged", null],
      ["13", "new", "18.5"],
      ["14", "new", null],
      ["Bad", "error", null],
    ]);
    expect(preview.rows[3].error).toBe("The shape's outline crosses itself.");
    // Nothing is saved by a preview.
    expect(await w.as((tx) => listPaddocks(tx, { farmId: w.farm.id }))).toHaveLength(1);
    const { paddocks } = await w.as((tx) => importBoundaries(tx, w.farm.id, { fileName: "paddocks.geojson", content: file, onDate: "2026-10-13" }));
    expect(paddocks.map((paddock) => [paddock.name, paddock.effectiveHa, paddock.boundarySource])).toEqual([
      ["12", "20.00", "Drawn or entered in Tohyee"],
      ["13", "18.50", "Imported from paddocks.geojson"],
      ["14", null, "Imported from paddocks.geojson"],
    ]);
    await expect(w.as((tx) => importBoundaries(tx, w.farm.id, { fileName: "again.geojson", content: file }))).rejects.toThrow("already imported");
    // A new survey of 12: a new boundary version, matched by name.
    const survey = JSON.stringify({ type: "FeatureCollection", features: [feature("12", box(169.9, -46.2, 0.007), { Eff_Ha: 21 })] });
    const second = await w.as((tx) => importBoundaries(tx, w.farm.id, { fileName: "survey.geojson", content: survey }));
    expect(second.preview.counts).toEqual({ new: 0, newBoundary: 1, unchanged: 0, errors: 0 });
    const twelve = await w.as((tx) => getPaddock(tx, paddocks[0].id));
    expect(twelve.boundaries.map((version) => version.source)).toEqual(["Imported from survey.geojson", "Drawn or entered in Tohyee"]);
    expect(twelve.effectiveHa).toBe("21.00");
    // Files that aren't GeoJSON polygons are refused plainly.
    await expect(w.as((tx) => previewBoundaryImport(tx, w.farm.id, { fileName: "x.kml", content: "<kml></kml>" }))).rejects.toThrow("The file has no paddock shapes in it.");
    await expect(w.as((tx) => previewBoundaryImport(tx, w.farm.id, { fileName: "x.dwg", contentBase64: "AAAA" }))).rejects.toThrow("Choose a GeoJSON, KML, KMZ or zipped shapefile.");

    // A Google Earth KML of paddock 13's new survey: matched by name, a new boundary version.
    const kml = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>13</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
      169.91,-46.2 169.918,-46.2 169.918,-46.196 169.91,-46.196 169.91,-46.2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
    const fromKml = await w.as((tx) => previewBoundaryImport(tx, w.farm.id, { fileName: "survey.kml", content: kml }));
    expect(fromKml).toMatchObject({ format: "KML", note: null, nameProperty: "name", counts: { new: 0, newBoundary: 1, unchanged: 0, errors: 0 } });
  });

  it("keeps the organisation's own LINZ Basemaps key for aerial imagery, checked and removable", async () => {
    const w = await setup();
    expect(await w.as((tx) => getFarmingSettings(tx))).toEqual({ enabled: true, imageryKey: null });
    await expect(w.as((tx) => setImageryKey(tx, { imageryKey: "has spaces in it" }))).rejects.toThrow("doesn't look like a LINZ Basemaps API key");
    await expect(w.as((tx) => setImageryKey(tx, { imageryKey: "short" }))).rejects.toThrow("doesn't look like");
    expect(await w.as((tx) => setImageryKey(tx, { imageryKey: "  c01abcdEFG_123-xyz  " }))).toEqual({ enabled: true, imageryKey: "c01abcdEFG_123-xyz" });
    expect(await w.as((tx) => setImageryKey(tx, { imageryKey: "" }))).toEqual({ enabled: true, imageryKey: null });
    await w.as((tx) => setFarmingEnabled(tx, { enabled: false }));
    await expect(w.as((tx) => setImageryKey(tx, { imageryKey: "c01abcdEFG_123-xyz" }))).rejects.toThrow("Farming is off");
  });
});

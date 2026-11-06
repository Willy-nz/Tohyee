import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { addPaddock, saveFarm, setBoundary, setFarmingEnabled } from "@/lib/farming/paddocks";
import { createDemoProvider } from "@/lib/farming/vegetation/fake-provider";
import { type ProviderFactory, runVegetationJobs } from "@/lib/farming/vegetation/jobs";
import type { Grid } from "@/lib/farming/vegetation/raster";
import { farmGrid, gridLonLatBox } from "@/lib/farming/vegetation/raster";
import { enqueueJob, saveConnection, setFarmVegetation, updateVegetationSettings } from "@/lib/farming/vegetation/service";
import { getOrganisation } from "@/lib/organisations/registry";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "veg-guards-co";

/** A rectangle of `east` × `north` metres near Balclutha (made-up farms). */
function box(lon: number, lat: number, east: number, north: number): PaddockGeometry {
  const dLon = east / 77_030;
  const dLat = north / 111_320;
  return { type: "Polygon", coordinates: [[[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]]] };
}

/** The demo provider, noting every search box and fetch grid. */
function watching(): { factory: ProviderFactory; searches: Array<[number, number, number, number]>; fetches: Grid[] } {
  const searches: Array<[number, number, number, number]> = [];
  const fetches: Grid[] = [];
  const factory: ProviderFactory = () => {
    const demo = createDemoProvider();
    return {
      ...demo,
      async search(input) {
        searches.push(input.box);
        return demo.search(input);
      },
      async fetch(input) {
        fetches.push(input.grid);
        return demo.fetch(input);
      },
    };
  };
  return { factory, searches, fetches };
}

/**
 * Issue #619 findings 1 and 4: a farm switched off (or no longer active)
 * gets no more requests, and the area sent is the boundaries confirmed,
 * not boundaries edited since. Made-up farms and people; nothing calls
 * Copernicus.
 */
describeWithDatabase("satellite vegetation guards (#619)", () => {
  let server: TestServer;
  let owner: SessionUser;
  const w = {} as Record<string, string>;
  const folder = `/tmp/tohyee-vegetation-guards-${randomBytes(4).toString("hex")}`;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const org = async () => (await getOrganisation(ORG))!;
  const jobs = (farmId: string) => run((tx) => tx.query<{ kind: string; status: string }>("select kind, status from vegetation_jobs where farm_id = $1 order by id", [farmId])).then((result) => result.rows);

  beforeAll(async () => {
    process.env.TOHYEE_VEGETATION_DIR = folder;
    process.env.TOHYEE_SECRET_KEY ??= "vegetation-test-secret-key-at-least-32-characters";
    server = await startTestServer();
    owner = await createTestUser("veg-guards-owner@example.com");
    await createTestOrganisation(owner, ORG);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.hill = (await run((tx) => saveFarm(tx, { name: "Hill block" }))).find((farm) => farm.name === "Hill block")!.id;
    w.one = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "1", geometry: box(169.73, -46.24, 300, 300) }))).id;
    w.back = (await run((tx) => addPaddock(tx, { farmId: w.runoff, name: "Back", geometry: box(169.6, -46.3, 300, 300) }))).id;
    w.top = (await run((tx) => addPaddock(tx, { farmId: w.hill, name: "Top", geometry: box(169.5, -46.35, 300, 300) }))).id;
    await run((tx) => saveConnection(tx, { provider: "demo", clientId: "", clientSecret: "" }));
    await run((tx) => updateVegetationSettings(tx, { enabled: true, minValidPixels: 20, minCoveragePct: 80 }));
  });

  afterAll(async () => {
    await server?.teardown();
    await rm(folder, { recursive: true, force: true });
  });

  it("turning a farm off cancels its waiting downloads; nothing more is asked for it", async () => {
    await run((tx) => setFarmVegetation(tx, w.runoff, { enabled: true }));
    await run((tx) => enqueueJob(tx, { farmId: w.runoff, kind: "discover", key: "discover:runoff:guards" }));
    // The discovery runs and queues the farm's downloads.
    const first = watching();
    await runVegetationJobs(await org(), { providerFactory: first.factory, maxJobs: 1, budgetMs: 60_000 });
    expect(first.searches).toHaveLength(1);
    expect((await jobs(w.runoff)).filter((job) => job.kind === "fetch" && job.status === "queued").length).toBeGreaterThan(0);
    await run((tx) => setFarmVegetation(tx, w.runoff, { enabled: false }));
    expect((await jobs(w.runoff)).filter((job) => job.status === "queued")).toEqual([]);
    const after = watching();
    await runVegetationJobs(await org(), { providerFactory: after.factory, maxJobs: 100, budgetMs: 60_000 });
    expect(after.fetches).toEqual([]);
  });

  it("a download already waiting for a farm that's now off or not active isn't asked for", async () => {
    // As if the job was queued just as the farm was turned off.
    await run((tx) => setFarmVegetation(tx, w.hill, { enabled: true }));
    await run((tx) => tx.query("update vegetation_farms set enabled = false where farm_id = $1", [w.hill]));
    await run((tx) => enqueueJob(tx, { farmId: w.hill, kind: "discover", key: "discover:hill:off" }));
    const off = watching();
    await runVegetationJobs(await org(), { providerFactory: off.factory, maxJobs: 100, budgetMs: 60_000 });
    expect(off.searches).toEqual([]);
    expect(off.fetches).toEqual([]);
    // A farm made not active is the same.
    await run((tx) => tx.query("update vegetation_farms set enabled = true where farm_id = $1", [w.hill]));
    await run((tx) => tx.query("update farms set is_active = false where id = $1", [w.hill]));
    await run((tx) => enqueueJob(tx, { farmId: w.hill, kind: "discover", key: "discover:hill:inactive" }));
    const inactive = watching();
    await runVegetationJobs(await org(), { providerFactory: inactive.factory, maxJobs: 100, budgetMs: 60_000 });
    expect(inactive.searches).toEqual([]);
    await run((tx) => tx.query("update farms set is_active = true where id = $1", [w.hill]));
  });

  it("the area sent is the boundaries confirmed; an edit or a new paddock waits until they're confirmed again", async () => {
    await run((tx) => setFarmVegetation(tx, w.home, { enabled: true }));
    const confirmed = farmGrid([box(169.73, -46.24, 300, 300)]);
    const confirmedBoundary = (await run((tx) => tx.query<{ id: string }>("select max(id)::text as id from paddock_boundaries where paddock_id = $1", [w.one]))).rows[0].id;
    // Edited and added without confirming again.
    await run((tx) => setBoundary(tx, w.one, { geometry: box(169.73, -46.24, 600, 600) }));
    const added = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "New block", geometry: box(169.745, -46.24, 300, 300) }))).id;
    await run((tx) => enqueueJob(tx, { farmId: w.home, kind: "discover", key: "discover:home:edited" }));
    const before = watching();
    await runVegetationJobs(await org(), { providerFactory: before.factory, maxJobs: 100, budgetMs: 120_000 });
    expect(before.searches.length).toBe(1);
    expect(before.searches[0]).toEqual(gridLonLatBox(confirmed));
    expect(before.fetches.length).toBeGreaterThan(0);
    for (const grid of before.fetches) expect(grid).toEqual(confirmed);
    // The numbers are for the confirmed boundary only; the new paddock has none yet.
    const observed = await run((tx) => tx.query<{ paddock_id: string; boundary_id: string }>("select distinct paddock_id::text, boundary_id::text from vegetation_observations o join paddocks p on p.id = o.paddock_id where p.farm_id = $1", [w.home]));
    expect(observed.rows).toEqual([{ paddock_id: w.one, boundary_id: confirmedBoundary }]);
    expect(observed.rows.some((row) => row.paddock_id === added)).toBe(false);
    // Confirming again sends the new area.
    await run((tx) => setFarmVegetation(tx, w.home, { enabled: true }));
    await run((tx) => enqueueJob(tx, { farmId: w.home, kind: "discover", key: "discover:home:reconfirmed" }));
    const after = watching();
    await runVegetationJobs(await org(), { providerFactory: after.factory, maxJobs: 1, budgetMs: 60_000 });
    expect(after.searches[0]).toEqual(gridLonLatBox(farmGrid([box(169.73, -46.24, 600, 600), box(169.745, -46.24, 300, 300)])));
  });
});

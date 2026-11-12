import { afterAll, beforeAll, expect, it } from "vitest";
import * as coverRoute from "@/app/api/farming/farms/[farmId]/vegetation/cover/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { coverCheck, coverPairs, turnOffCoverEstimates, turnOnCoverEstimates } from "@/lib/farming/vegetation/cover-model";
import { currentBoundaries, getFarmVegetation, getPaddockTrend } from "@/lib/farming/vegetation/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "veg-cover-co";
const box = (lon: number, lat: number): PaddockGeometry => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + 0.004, lat], [lon + 0.004, lat + 0.003], [lon, lat + 0.003], [lon, lat]]],
});

/** MCV1-MCV8 (#612 phase 3, decision 1596, not yet reviewed). Made-up farms, greenness and readings. */
describeWithDatabase("modelled pasture cover", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  const w = {} as Record<string, string>;
  const paddocks: string[] = [];
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  /** A clear satellite date with each paddock's greenness. */
  async function scene(farmId: string, on: string, ndvis: Record<string, string>): Promise<string> {
    return run(async (tx) => {
      const id = (
        await tx.query<{ id: string }>(
          `insert into vegetation_scenes (farm_id, provider, acquired_at, retrieved_at, product_ids, processor_version, licence, grid, usable, farm_valid_pct)
           values ($1, 'demo', ($2::date + time '11:00') at time zone 'Pacific/Auckland', now(), '{demo}', 'tohyee-ndvi-1', 'Made-up', '{}'::jsonb, true, 100) returning id::text`,
          [farmId, on],
        )
      ).rows[0].id;
      const boundaries = await currentBoundaries(tx, farmId);
      for (const [paddockId, ndvi] of Object.entries(ndvis)) {
        const boundary = boundaries.find((entry) => entry.paddockId === paddockId)!;
        await tx.query(
          `insert into vegetation_observations (scene_id, farm_id, paddock_id, boundary_id, processor_version, acquired_at, total_pixels, valid_pixels, edge_pixels, coverage_pct, mean_ndvi, median_ndvi, quality)
           values ($1, $2, $3, $4, 'tohyee-ndvi-1', ($5::date + time '11:00') at time zone 'Pacific/Auckland', 100, 100, 10, 100, $6::numeric, $6::numeric, 'good')`,
          [id, farmId, paddockId, boundary.boundaryId, on, ndvi],
        );
      }
      return id;
    });
  }
  const reading = (farmId: string, paddockId: string, on: string, cover: number, method = "plate_meter") =>
    run((tx) =>
      tx.query("insert into pasture_readings (farm_id, paddock_id, measured_on, cover, method, source, created_by_email) values ($1, $2, $3, $4, $5, 'test', 'owner@example.com')", [
        farmId,
        paddockId,
        on,
        cover,
        method,
      ]),
    );

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("cover-owner@example.com", { displayName: "Aroha" });
    worker = await createTestUser("cover-staff@example.com", { displayName: "Tama" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    for (let i = 0; i < 4; i += 1) paddocks.push((await run((tx) => addPaddock(tx, { farmId: w.home, name: String(i + 1), geometry: box(169.73 + i * 0.005, -46.24) }))).id);
    await run((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));

    // MCV2-MCV3: four clear dates, one a season; readings on the day or within 3 days; cover = 500 + 3000 × NDVI, give or take.
    const ndvis = ["0.40", "0.55", "0.70", "0.85"];
    const noise = [40, -40, 20, -20];
    const dates = ["2026-01-10", "2026-04-12", "2026-07-15", "2026-10-20"];
    for (const [d, on] of dates.entries()) {
      await scene(w.home, on, Object.fromEntries(paddocks.map((paddock, i) => [paddock, ndvis[i]])));
      for (const [i, paddock] of paddocks.entries()) {
        const measured = i === 0 ? `${on.slice(0, 8)}${String(Number(on.slice(8)) + 2).padStart(2, "0")}` : on;
        await reading(w.home, paddock, measured, 500 + 3000 * Number(ndvis[i]) + noise[(i + d) % 4]);
      }
    }
    // Not used: an eye estimate, a reading 5 days from any picture, and one with a grazing between it and the picture.
    await reading(w.home, paddocks[1], "2026-01-10", 9000, "visual");
    await reading(w.home, paddocks[2], "2026-01-15", 9000);
    await run((tx) =>
      tx.query("insert into grazings (farm_id, paddock_id, mob, in_on, out_on, created_by_email) values ($1, $2, 'Milkers', '2026-04-13', '2026-04-14', 'owner@example.com')", [
        w.home,
        paddocks[3],
      ]),
    );
    await reading(w.home, paddocks[3], "2026-04-15", 9000);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("MCV2: pairs measured readings with the closest clear view within 3 days, not eye estimates or grazed-between ones", async () => {
    const pairs = await run((tx) => coverPairs(tx, w.home));
    expect(pairs).toHaveLength(16);
    expect(pairs.some((pair) => pair.cover === 9000)).toBe(false);
    expect(pairs.find((pair) => pair.paddockId === paddocks[0] && pair.imageOn === "2026-01-10")).toMatchObject({ measuredOn: "2026-01-12", ndvi: "0.4000" });
  });

  it("MCV3-MCV5: the check, read by farm staff; MCV7: turned on by an admin within the error they chose", async () => {
    const url = `/api/farming/farms/${w.home}/vegetation/cover`;
    const seen = await coverRoute.GET(apiRequest(`${url}?organisationId=${ORG}`, { cookie: await sessionCookieFor(worker) }), params({ farmId: w.home }));
    expect(seen.status).toBe(200);
    const { check } = (await seen.json()) as { check: Awaited<ReturnType<typeof coverCheck>> };
    expect(check.validation).toMatchObject({ pairs: 16, dates: 4, line: { intercept: "500.0000", slope: "3000.0000" }, notReady: null });
    expect(check.validation.withheldDates).toEqual({ pairs: 16, meanError: 34, bias: 0, likelyWithin: 50 });
    expect(check.model).toBeNull();
    const staff = await coverRoute.POST(apiRequest(url, { method: "POST", cookie: await sessionCookieFor(worker), body: { organisationId: ORG, action: "on", acceptableError: 100 } }), params({ farmId: w.home }));
    expect(staff.status).toBe(403);

    await expect(run((tx) => turnOnCoverEstimates(tx, w.home, { acceptableError: 30 }))).rejects.toThrow("off by 34 kg DM/ha on average, more than the 30 you chose");
    await expect(run((tx) => turnOnCoverEstimates(tx, w.home, { acceptableError: 5 }))).rejects.toThrow("from 10 to 3000");
    const readings = Number((await run((tx) => tx.query<{ n: string }>("select count(*)::text as n from pasture_readings"))).rows[0].n);
    const model = await run((tx) => turnOnCoverEstimates(tx, w.home, { acceptableError: 300 }));
    expect(model).toMatchObject({ meanError: 34, likelyWithin: 50, acceptableError: 300, pairs: 16, dates: 4, ndviMin: "0.4000", ndviMax: "0.8500" });

    // MCV6: estimates on the map's paddocks and the trend, never saved as readings.
    const vegetation = await run((tx) => getFarmVegetation(tx, w.home));
    expect(vegetation.coverEstimates).toMatchObject({ meanError: 34, likelyWithin: 50, acceptableError: 300 });
    expect(vegetation.observations.find((observation) => observation.paddockId === paddocks[2])!.modelledCover).toEqual({ cover: 2600, low: 2550, high: 2650, outsideRange: false });
    const trend = await run((tx) => getPaddockTrend(tx, paddocks[0]));
    expect(trend.observations.map((observation) => observation.modelledCover?.cover)).toEqual([1700, 1700, 1700, 1700]);
    expect(Number((await run((tx) => tx.query<{ n: string }>("select count(*)::text as n from pasture_readings"))).rows[0].n)).toBe(readings);

    // MCV8: off again; the line's kept with who turned it on and off.
    await run((tx) => turnOffCoverEstimates(tx, w.home));
    expect((await run((tx) => getFarmVegetation(tx, w.home))).observations.every((observation) => observation.modelledCover === null)).toBe(true);
    const kept = await run((tx) => tx.query<{ on_by: string; off_by: string }>("select turned_on_by_email as on_by, turned_off_by_email as off_by from vegetation_cover_models"));
    expect(kept.rows).toEqual([{ on_by: owner.email, off_by: owner.email }]);
  });
});

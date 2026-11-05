import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as farmVegetationRoute from "@/app/api/farming/farms/[farmId]/vegetation/route";
import * as exportRoute from "@/app/api/farming/farms/[farmId]/vegetation/export/route";
import * as trendRoute from "@/app/api/farming/paddocks/[paddockId]/vegetation/route";
import * as pictureRoute from "@/app/api/farming/vegetation/scenes/[sceneId]/picture/route";
import * as settingsRoute from "@/app/api/farming/vegetation/route";
import * as overviewRoute from "@/app/api/farming/vegetation/overview/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { addPaddock, saveFarm, setBoundary, setFarmingEnabled } from "@/lib/farming/paddocks";
import { createDemoProvider, demoPicture } from "@/lib/farming/vegetation/fake-provider";
import { type ProviderFactory, removeOldPictures, runVegetationJobs, testOneFarm } from "@/lib/farming/vegetation/jobs";
import { ProviderError } from "@/lib/farming/vegetation/provider";
import { farmGrid } from "@/lib/farming/vegetation/raster";
import { currentBoundaries, enqueueFetch, enqueueJob, getFarmVegetation, getPaddockTrend, requestReprocess, saveConnection, setFarmVegetation, updateVegetationSettings, vegetationOverview } from "@/lib/farming/vegetation/service";
import { picturePath, pictureSize, writePicture } from "@/lib/farming/vegetation/storage";
import { getOrganisation } from "@/lib/organisations/registry";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

type Handler = (request: Request, context: never) => Promise<Response>;
const ORG = "veg-co";
const OTHER = "veg-other-co";
const QUOTA = "veg-quota-co";

/** A rectangle of `east` × `north` metres at a place near Balclutha (made-up farms). */
function box(lon: number, lat: number, east: number, north: number): PaddockGeometry {
  const dLon = east / 77_030;
  const dLat = north / 111_320;
  return { type: "Polygon", coordinates: [[[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]]] };
}

/** The demo provider, counting fetches, optionally failing them or charging units. */
function counting(options: { units?: number; fail?: ProviderError } = {}): { factory: ProviderFactory; fetches: () => number } {
  let fetches = 0;
  const factory: ProviderFactory = () => {
    const demo = createDemoProvider();
    return {
      ...demo,
      async fetch(input) {
        fetches += 1;
        if (options.fail) throw options.fail;
        const picture = await demo.fetch(input);
        return { ...picture, unitsSpent: options.units ?? null };
      },
    };
  };
  return { factory, fetches: () => fetches };
}

/** Satellite vegetation (#612, decisions 1520-1540): the pipeline with made-up pictures. Nothing here calls Copernicus. */
describeWithDatabase("satellite vegetation", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let outsider: SessionUser;
  const w = {} as Record<string, string>;
  const folder = `/tmp/tohyee-vegetation-test-${randomBytes(4).toString("hex")}`;
  const as = (user: SessionUser, org = ORG) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
  const org = async (id = ORG) => (await getOrganisation(id))!;

  beforeAll(async () => {
    process.env.TOHYEE_VEGETATION_DIR = folder;
    process.env.TOHYEE_SECRET_KEY ??= "vegetation-test-secret-key-at-least-32-characters";
    server = await startTestServer();
    owner = await createTestUser("veg-owner@example.com", { displayName: "Aroha" });
    worker = await createTestUser("veg-staff@example.com", { displayName: "Tama" });
    outsider = await createTestUser("veg-outsider@example.com", { displayName: "Hemi" });
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(outsider, OTHER);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.one = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "1", geometry: box(169.73, -46.24, 300, 300) }))).id;
    w.two = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "2", geometry: box(169.7341, -46.24, 300, 300) }))).id;
    w.tiny = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "Calf pen", geometry: box(169.7384, -46.24, 15, 15) }))).id;
    w.lane = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "Lane", geometry: box(169.7384, -46.2395, 12, 250) }))).id;
    w.back = (await run((tx) => addPaddock(tx, { farmId: w.runoff, name: "Back", geometry: box(169.6, -46.3, 400, 400) }))).id;
    await run((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
  });

  afterAll(async () => {
    await server?.teardown();
    await rm(folder, { recursive: true, force: true });
  });

  const call = async (user: SessionUser, handler: Handler, url: string, context: Record<string, string>, method = "GET", body?: Record<string, unknown>, organisationId = ORG) => {
    const response = await handler(
      apiRequest(method === "GET" ? `${url}${url.includes("?") ? "&" : "?"}organisationId=${organisationId}` : url, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId, ...body } : undefined }),
      params(context) as never,
    );
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("json")) return { status: response.status, body: {} as Record<string, unknown>, text: type.includes("text") ? await response.text() : "", bytes: (await response.arrayBuffer?.().catch(() => null)) ?? null };
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown>, text: "", bytes: null };
  };

  it("keeps the provider's secret encrypted and never sends it back; only owners and admins see settings", async () => {
    const run = as(owner);
    await run((tx) => saveConnection(tx, { provider: "copernicus", clientId: "sh-made-up-client-1234", clientSecret: "made-up-secret-value-xyz" }));
    const stored = await run((tx) => tx.query<{ client_secret_ciphertext: string }>("select client_secret_ciphertext from vegetation_settings"));
    expect(stored.rows[0].client_secret_ciphertext).toMatch(/^v2:/);
    expect(stored.rows[0].client_secret_ciphertext).not.toContain("made-up-secret");
    const settings = await call(owner, settingsRoute.GET as Handler, "/api/farming/vegetation", {});
    expect(settings.status).toBe(200);
    expect(JSON.stringify(settings.body)).not.toContain("made-up-secret");
    expect((settings.body.settings as { clientIdHint: string }).clientIdHint).toBe("…1234");
    expect((await call(worker, settingsRoute.GET as Handler, "/api/farming/vegetation", {})).status).toBe(403);
    // Now the made-up pictures for the rest of the test.
    await run((tx) => saveConnection(tx, { provider: "demo", clientId: "", clientSecret: "" }));
    expect((await run((tx) => tx.query<{ c: string | null }>("select client_secret_ciphertext as c from vegetation_settings"))).rows[0].c).toBeNull();
  });

  it("turns on a farm, confirming its boundaries, and fetches and works out its dates", async () => {
    const run = as(owner);
    expect((await run((tx) => getFarmVegetation(tx, w.home))).state).toBe("not_set_up");
    await run((tx) => updateVegetationSettings(tx, { enabled: true, minValidPixels: 20, minCoveragePct: 80 }));
    const setup = await run((tx) => setFarmVegetation(tx, w.home, { enabled: true }));
    expect(setup.confirmedBoundaryIds.length).toBe(4);
    expect((await run((tx) => getFarmVegetation(tx, w.home))).state).toBe("checking");
    await run((tx) => tx.query("update vegetation_farms set next_check_at = now() - interval '1 minute'"));
    const { scheduleChecks } = await import("@/lib/farming/vegetation/jobs");
    expect(await run((tx) => scheduleChecks(tx, new Date()))).toBe(1);
    const provider = counting();
    await runVegetationJobs(await org(), { providerFactory: provider.factory, maxJobs: 100, budgetMs: 120_000 });
    const scenes = await run((tx) => tx.query<{ n: number; usable: number }>("select count(*)::int as n, count(*) filter (where usable)::int as usable from vegetation_scenes"));
    // About 60 days of passes every 5 days, some of them cloudy.
    expect(scenes.rows[0].n).toBeGreaterThanOrEqual(11);
    expect(scenes.rows[0].usable).toBeLessThan(scenes.rows[0].n);
    expect(provider.fetches()).toBe(scenes.rows[0].n);
    const vegetation = await run((tx) => getFarmVegetation(tx, w.home));
    expect(vegetation.state).toBe("ready");
    expect(vegetation.attribution).toBe("Made-up demo pictures, not satellite data.");
    const byName = Object.fromEntries(vegetation.observations.map((o) => [o.paddockName, o]));
    // The date shown is mostly clear: the big paddocks are good enough to compare.
    expect(byName["2"]).toMatchObject({ quality: "good" });
    expect(Number(byName["2"].meanNdvi)).toBeGreaterThan(0.05);
    expect(Number(vegetation.scene!.farmValidPct)).toBeGreaterThanOrEqual(50);
    // The tiny pen and the narrow lane are shown honestly.
    expect(byName["Calf pen"].quality).toBe("too_small");
    expect(byName.Lane.flags).toContain("narrow_or_edge");
    // A cloudy date: missing, never zero.
    const cloudy = await run((tx) => tx.query<{ quality: string; mean_ndvi: string | null; valid_pixels: number }>("select o.quality, o.mean_ndvi::text, o.valid_pixels from vegetation_observations o join vegetation_scenes s on s.id = o.scene_id where not s.usable and o.paddock_id = $1 limit 1", [w.one]));
    expect(cloudy.rows[0]).toMatchObject({ quality: "no_data", mean_ndvi: null, valid_pixels: 0 });
    // Pictures are files on disk, not database rows.
    const files = await run((tx) => tx.query<{ raw_path: string; overlay_path: string }>("select raw_path, overlay_path from vegetation_scenes order by acquired_at desc limit 1"));
    expect(await pictureSize(ORG, files.rows[0].overlay_path)).toBeGreaterThan(100);
    w.scene = vegetation.scene!.id;
    w.firstRun = String(scenes.rows[0].n);
  });

  it("asking twice is one job, and running again adds nothing", async () => {
    const run = as(owner);
    const key = { farmId: w.home, kind: "discover" as const, key: `discover:${w.home}:test-twice` };
    expect(await run((tx) => enqueueJob(tx, key))).toBe(true);
    expect(await run((tx) => enqueueJob(tx, key))).toBe(false);
    const before = await run((tx) => tx.query<{ n: number }>("select count(*)::int as n from vegetation_observations"));
    const provider = counting();
    await runVegetationJobs(await org(), { providerFactory: provider.factory, maxJobs: 100, budgetMs: 120_000 });
    expect(provider.fetches()).toBe(0);
    const after = await run((tx) => tx.query<{ n: number; s: number }>("select count(*)::int as n, (select count(*)::int from vegetation_scenes) as s from vegetation_observations"));
    expect(after.rows[0]).toEqual({ n: before.rows[0].n, s: Number(w.firstRun) });
  });

  it("a restart carries on from the checkpoint without fetching again", async () => {
    const run = as(owner);
    const candidate = { acquiredAt: "2026-07-25T22:35:00Z", productIds: ["DEMO_RESTART"], sceneCloudPct: 4, processingBaseline: "05.11", platform: "sentinel-2c" };
    await run((tx) => enqueueFetch(tx, w.home, candidate));
    // As if the server stopped after saving the picture and checkpoint, mid-way through working it out.
    const grid = farmGrid((await run((tx) => currentBoundaries(tx, w.home))).map((b) => b.geometry));
    const rawPath = picturePath(ORG, w.home, candidate.acquiredAt, "raw");
    const sha256 = await writePicture(ORG, rawPath, demoPicture(grid, Date.parse(candidate.acquiredAt)));
    await run((tx) =>
      tx.query("update vegetation_jobs set status = 'running', attempts = 1, claimed_at = now() - interval '30 minutes', checkpoint = $2::jsonb where job_key = $1", [`fetch:${w.home}:${candidate.acquiredAt}:tohyee-ndvi-1`, JSON.stringify({ grid, rawPath, sha256, bytes: 10, units: null, unitsEstimated: 0.02, dnOffset: 0, retrievedAt: "2026-11-05T01:00:00Z" })]),
    );
    const provider = counting({ fail: new ProviderError("unavailable", "Should not be asked") });
    await runVegetationJobs(await org(), { providerFactory: provider.factory, maxJobs: 10, budgetMs: 60_000 });
    expect(provider.fetches()).toBe(0);
    const scene = await run((tx) => tx.query<{ retrieved_at: string; acquired_at: string }>("select retrieved_at::text, to_char(acquired_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as acquired_at from vegetation_scenes where product_ids = '{DEMO_RESTART}'"));
    // Acquisition time is the satellite's; retrieval time is kept apart.
    expect(scene.rows[0].acquired_at).toBe("2026-07-25T22:35:00Z");
    expect(scene.rows[0].retrieved_at).toContain("2026-11-05 01:00:00");
  });

  it("a boundary edit keeps the old numbers; working a date out again adds numbers for the new boundary", async () => {
    const run = as(owner);
    const oldBoundary = (await run((tx) => tx.query<{ id: string }>("select max(id)::text as id from paddock_boundaries where paddock_id = $1", [w.one]))).rows[0].id;
    await run((tx) => setBoundary(tx, w.one, { geometry: box(169.73, -46.24, 250, 300) }));
    let trend = await run((tx) => getPaddockTrend(tx, w.one));
    expect(trend.observations.every((o) => o.boundaryId === oldBoundary && !o.currentBoundary)).toBe(true);
    expect((await run((tx) => getFarmVegetation(tx, w.home))).setup.boundariesChanged).toBe(true);
    expect(await run((tx) => requestReprocess(tx, w.scene))).toEqual({ queued: true });
    expect(await run((tx) => requestReprocess(tx, w.scene))).toEqual({ queued: false });
    await runVegetationJobs(await org(), { providerFactory: counting().factory, maxJobs: 10, budgetMs: 60_000 });
    trend = await run((tx) => getPaddockTrend(tx, w.one));
    const onScene = trend.observations.filter((o) => o.sceneId === w.scene);
    expect(onScene.map((o) => o.currentBoundary)).toEqual([false, true]);
    expect(onScene[1].totalPixels).toBeLessThan(onScene[0].totalPixels);
    // The map shows the newest boundary's numbers for that date.
    const shown = (await run((tx) => getFarmVegetation(tx, w.home, { sceneId: w.scene }))).observations.find((o) => o.paddockId === w.one)!;
    expect(shown.currentBoundary).toBe(true);
    await expect(run((tx) => tx.query("delete from vegetation_observations where paddock_id = $1", [w.one]))).rejects.toThrow();
  });

  it("refuses other farms and other organisations for the map, pictures, exports and trends", async () => {
    // Farm staff on Home farm only.
    expect((await call(worker, farmVegetationRoute.GET as Handler, `/api/farming/farms/${w.home}/vegetation`, { farmId: w.home })).status).toBe(200);
    expect((await call(worker, farmVegetationRoute.GET as Handler, `/api/farming/farms/${w.runoff}/vegetation`, { farmId: w.runoff })).status).toBe(404);
    expect((await call(worker, exportRoute.GET as Handler, `/api/farming/farms/${w.runoff}/vegetation/export`, { farmId: w.runoff })).status).toBe(404);
    expect((await call(worker, trendRoute.GET as Handler, `/api/farming/paddocks/${w.back}/vegetation`, { paddockId: w.back })).status).toBe(404);
    expect((await call(worker, farmVegetationRoute.POST as Handler, `/api/farming/farms/${w.home}/vegetation`, { farmId: w.home }, "POST", { action: "setup", enabled: false })).status).toBe(403);
    const picture = await call(worker, pictureRoute.GET as Handler, `/api/farming/vegetation/scenes/${w.scene}/picture`, { sceneId: w.scene });
    expect(picture.status).toBe(200);
    // Runoff's dates: the same answer as a date that doesn't exist.
    const runoffScene = await as(owner)(async (tx) => {
      await setFarmVegetation(tx, w.runoff, { enabled: true });
      return (await tx.query<{ id: string }>("insert into vegetation_scenes (farm_id, provider, acquired_at, retrieved_at, product_ids, processor_version, licence, grid, usable, overlay_path) values ($1, 'demo', '2026-10-01T22:35:00Z', now(), '{x}', 'tohyee-ndvi-1', 'x', '{}', false, 'veg-co/farm-2/x.png') returning id::text", [w.runoff])).rows[0].id;
    });
    expect((await call(worker, pictureRoute.GET as Handler, `/api/farming/vegetation/scenes/${runoffScene}/picture`, { sceneId: runoffScene })).status).toBe(404);
    expect((await call(worker, farmVegetationRoute.GET as Handler, `/api/farming/farms/${w.home}/vegetation?sceneId=${runoffScene}`, { farmId: w.home })).status).toBe(404);
    const overview = (await call(worker, overviewRoute.GET as Handler, "/api/farming/vegetation/overview", {})).body.farms as Array<{ farmName: string }>;
    expect(overview.map((farm) => farm.farmName)).toEqual(["Home farm"]);
    // Someone from another organisation.
    for (const [handler, url, context] of [
      [farmVegetationRoute.GET, `/api/farming/farms/${w.home}/vegetation`, { farmId: w.home }],
      [pictureRoute.GET, `/api/farming/vegetation/scenes/${w.scene}/picture`, { sceneId: w.scene }],
      [exportRoute.GET, `/api/farming/farms/${w.home}/vegetation/export`, { farmId: w.home }],
      [trendRoute.GET, `/api/farming/paddocks/${w.one}/vegetation`, { paddockId: w.one }],
    ] as const) {
      // Not a member: refused before anything is read (an organisation they're not in isn't found).
      const refused = await call(outsider, handler as Handler, url, context);
      expect([403, 404]).toContain(refused.status);
      expect(JSON.stringify(refused.body)).not.toMatch(/Home farm|meanNdvi|data:image/);
    }
  });

  it("the map answer carries the picture, legend facts and greenness note; the export says what the numbers are", async () => {
    const answer = await call(owner, farmVegetationRoute.GET as Handler, `/api/farming/farms/${w.home}/vegetation`, { farmId: w.home });
    expect((answer.body.pictures as { overlay: string }).overlay).toMatch(/^data:image\/png;base64,/);
    const csv = await call(owner, exportRoute.GET as Handler, `/api/farming/farms/${w.home}/vegetation/export`, { farmId: w.home });
    expect(csv.text.split("\n")[0]).toContain("Greenness (NDVI), not feed available. Blank means no clear view, not zero.");
    expect(csv.text).toContain("acquired_at_utc,paddock");
    expect(csv.text).not.toMatch(/kg ?DM/i);
  });

  it("old pictures go after the retention; the numbers and the newest clear picture stay", async () => {
    const run = as(owner);
    const before = await run((tx) => tx.query<{ n: number }>("select count(*)::int as n from vegetation_observations"));
    const removed = await removeOldPictures(await org(), new Date(Date.now() + 400 * 86_400_000));
    expect(removed).toBeGreaterThan(5);
    const kept = await run((tx) => tx.query<{ n: number }>("select count(*)::int as n from vegetation_scenes where files_removed_at is null and farm_id = $1", [w.home]));
    expect(kept.rows[0].n).toBe(1);
    expect((await run((tx) => tx.query<{ n: number }>("select count(*)::int as n from vegetation_observations"))).rows[0].n).toBe(before.rows[0].n);
    const old = await run((tx) => tx.query<{ id: string }>("select id::text from vegetation_scenes where files_removed_at is not null and farm_id = $1 limit 1", [w.home]));
    expect((await call(owner, pictureRoute.GET as Handler, `/api/farming/vegetation/scenes/${old.rows[0].id}/picture`, { sceneId: old.rows[0].id })).status).toBe(404);
  });

  it("pauses at the budget with a clear state, asks to reconnect when refused, and tests one farm", async () => {
    const quotaOwner = await createTestUser("veg-quota@example.com");
    await createTestOrganisation(quotaOwner, QUOTA);
    const run = as(quotaOwner, QUOTA);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await run((tx) => saveFarm(tx, { name: "Hill block" })))[0].id;
    await run((tx) => addPaddock(tx, { farmId: farm, name: "Top", geometry: box(169.73, -46.24, 300, 300) }));
    await run((tx) => saveConnection(tx, { provider: "demo", clientId: "", clientSecret: "" }));
    await run((tx) => updateVegetationSettings(tx, { enabled: true, monthlyUnitBudget: 1 }));
    await run((tx) => setFarmVegetation(tx, farm, { enabled: true }));
    await run((tx) => enqueueJob(tx, { farmId: farm, kind: "discover", key: "discover:quota" }));
    const charged = counting({ units: 0.45 });
    await runVegetationJobs((await getOrganisation(QUOTA))!, { providerFactory: charged.factory, maxJobs: 100, budgetMs: 60_000 });
    // 0.45 + 0.45 = 0.9; the third would go over 1 at the farm's last real charge, so it pauses rather than spend.
    expect(charged.fetches()).toBe(2);
    let vegetation = await run((tx) => getFarmVegetation(tx, farm));
    expect(vegetation).toMatchObject({ state: "quota_paused", pausedReason: "quota" });
    const waiting = await run((tx) => tx.query<{ n: number }>("select count(*)::int as n from vegetation_jobs where status = 'queued' and kind = 'fetch'"));
    expect(waiting.rows[0].n).toBeGreaterThan(0);
    // Raising the budget and carrying on.
    await run((tx) => updateVegetationSettings(tx, { monthlyUnitBudget: 1000, resume: true }));
    await run((tx) => tx.query("update vegetation_jobs set next_attempt_at = now() where status = 'queued'"));
    // The provider now refuses the account: reconnect, nothing lost.
    const refused = counting({ fail: new ProviderError("auth", "Copernicus refused the account (401). Connect it again.") });
    await runVegetationJobs((await getOrganisation(QUOTA))!, { providerFactory: refused.factory, maxJobs: 5, budgetMs: 60_000 });
    vegetation = await run((tx) => getFarmVegetation(tx, farm));
    expect(vegetation.state).toBe("reconnect");
    expect(vegetation.connectionError).toContain("Connect it again");
    // Test one farm: one bounded fetch, measured, with a preview; counted in the month's use.
    await run((tx) => saveConnection(tx, { provider: "demo", clientId: "", clientSecret: "" }));
    const tested = await testOneFarm((await getOrganisation(QUOTA))!, { userId: quotaOwner.id, email: quotaOwner.email, role: "owner" }, farm);
    expect(tested.result).toMatchObject({ farmName: "Hill block", provider: "demo", error: null });
    expect(tested.result.bytes).toBeGreaterThan(0);
    expect(tested.result.datesFound).toBeGreaterThan(0);
    expect(tested.preview).toMatch(/^data:image\/png;base64,/);
    await expect(testOneFarm((await getOrganisation(QUOTA))!, { userId: quotaOwner.id, email: quotaOwner.email, role: "owner" }, farm)).rejects.toThrow("less than a minute ago");
    expect((await run((tx) => vegetationOverview(tx)))[0]).toMatchObject({ farmName: "Hill block", enabled: true });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as equipmentRoute from "@/app/api/farming/tractor/equipment/route";
import * as equipmentItemRoute from "@/app/api/farming/tractor/equipment/[equipmentId]/route";
import * as jobsRoute from "@/app/api/farming/tractor/jobs/route";
import * as jobRoute from "@/app/api/farming/tractor/jobs/[jobId]/route";
import * as exportRoute from "@/app/api/farming/tractor/jobs/[jobId]/export/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { coreQuery } from "@/lib/db/transactions";
import { EARLIER_EDITS_NOT_RECORDED } from "@/lib/farming/tractor-shared";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { localProjection } from "@/lib/farming/coverage";
import { createPlan } from "@/lib/farming/fertiliser";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import type { JobTrack, PackedPoint, TractorEquipment, TractorJob, TractorJobListItem } from "@/lib/farming/tractor-shared";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/*
 * Tractor mode's jobs on the server (#472 stage 5, decisions 1020-1027):
 * saving, sending twice, who sees what, re-clipping and exports. Made-up
 * farm and people.
 */

const ORG = "farm-tractor";
type Handler = (request: Request, context: never) => Promise<Response>;

const grid = localProjection([170.2, -45.9]);
const at = (x: number, y: number) => grid.toLonLat([x, y]);
const START = Date.UTC(2026, 9, 28, 9, 0, 0);

/** 100 m east at 2 m/s with Working ON, 10 m wide. */
function straightTrack(width = 10): JobTrack {
  const points: PackedPoint[] = [];
  for (let i = 0; i <= 50; i += 1) {
    const [lon, lat] = at(i * 2, 0);
    points.push([START + i * 1000, lon, lat, 4, 1, 0, null, 0]);
  }
  return { version: 1, settings: [{ widthM: width, lateralM: 0, backM: 0, settingsId: null }], points, events: [{ t: START, kind: "start" }, { t: START + 50_000, kind: "finish" }] };
}

const square = (x0: number, y0: number, x1: number, y1: number) => ({ type: "Polygon", coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] });

describeWithDatabase("tractor mode jobs", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let other: SessionUser;
  let viewer: SessionUser;
  let bookkeeper: SessionUser;
  const w = {} as Record<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("tractor-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("tractor-staff@example.com", { displayName: "Hemi" });
    other = await createTestUser("tractor-staff2@example.com", { displayName: "Aroha" });
    viewer = await createTestUser("tractor-viewer@example.com", { displayName: "Wiremu" });
    bookkeeper = await createTestUser("tractor-books@example.com", { displayName: "Mere" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker'), ($1, $3, 'farm_worker'), ($1, $4, 'viewer'), ($1, $5, 'bookkeeper')", [ORG, worker.id, other.id, viewer.id, bookkeeper.id]);
    const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    // Paddock 1: 50 m square the run crosses, from x 25 to 75.
    w.p1 = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "1", geometry: square(25, -25, 75, 25) }))).id;
    w.p2 = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "2", geometry: square(-100, -25, 25, 25) }))).id;
    w.runoffPaddock = (await run((tx) => addPaddock(tx, { farmId: w.runoff, name: "R1", effectiveHa: "5" }))).id;
    w.plan = (await run((tx) => createPlan(tx, { farmId: w.home, name: "Spring 2026" }))).id;
    for (const user of [worker, other, viewer, bookkeeper]) {
      const role = user === viewer ? "viewer" : user === bookkeeper ? "bookkeeper" : "farm_worker";
      await run((tx) => setMemberFarmAccess(tx, { userId: user.id, role, access: "farms", farmIds: [w.home] }));
    }
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, path: string, context: Record<string, string> = {}, method = "GET", body?: Record<string, unknown>) => {
    const response = await handler(
      apiRequest(method === "GET" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }),
      params(context) as never,
    );
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { text };
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };

  it("farm staff add a spreader; a width change is a new timestamped version", async () => {
    const added = await call(worker, equipmentRoute.POST as Handler, "/api/farming/tractor/equipment", {}, "POST", { name: "Twin-disc spreader", kind: "spreader", widthM: "12", lateralM: "0", backM: "3.5" });
    expect(added.status).toBe(201);
    const equipment = added.body.equipment as TractorEquipment;
    w.spreader = equipment.id;
    expect(equipment.current).toMatchObject({ widthM: "12", backM: "3.5", createdByEmail: "tractor-staff@example.com" });
    const changed = await call(worker, equipmentItemRoute.PATCH as Handler, `/api/farming/tractor/equipment/${equipment.id}`, { equipmentId: equipment.id }, "PATCH", { widthM: "14", note: "New vanes" });
    const after = changed.body.equipment as TractorEquipment;
    expect(after.current?.widthM).toBe("14");
    expect(after.current?.backM).toBe("3.5");
    expect(after.history.map((entry) => entry.widthM)).toEqual(["14", "12"]);
    w.settings12 = after.history[1].id;
    // A viewer can look but not add.
    expect((await call(viewer, equipmentRoute.GET as Handler, "/api/farming/tractor/equipment")).status).toBe(200);
    expect((await call(viewer, equipmentRoute.POST as Handler, "/api/farming/tractor/equipment", {}, "POST", { name: "Sprayer", kind: "sprayer", widthM: "18" })).status).toBe(403);
    // Farm staff can't link a fixed asset in the books.
    expect((await call(worker, equipmentRoute.POST as Handler, "/api/farming/tractor/equipment", {}, "POST", { name: "Mower", kind: "mower", widthM: "3", fixedAssetId: "1" })).status).toBe(403);
    // Width limits.
    expect((await call(worker, equipmentRoute.POST as Handler, "/api/farming/tractor/equipment", {}, "POST", { name: "Huge", kind: "other", widthM: "99" })).status).toBe(400);
  });

  it("saves a job, works the coverage out on the server and clips it to the paddock", async () => {
    const track = straightTrack(10);
    track.settings[0].settingsId = w.settings12;
    const id = "0a8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a";
    // The phone's own numbers are ignored: the server works them out.
    const saved = await call(worker, jobsRoute.POST as Handler, "/api/farming/tractor/jobs", {}, "POST", { id, farmId: w.home, paddockIds: [w.p1], operation: "spreading", equipmentId: w.spreader, track, product: "Urea", declaredRate: "100", declaredRateUnit: "kg/ha", summary: { workedHa: 99 } });
    expect(saved.status).toBe(201);
    const job = (saved.body as { job: TractorJob }).job;
    w.job = job.id;
    expect(job.operatorEmail).toBe("tractor-staff@example.com");
    expect(job.summary.workedHa).toBeCloseTo(0.05, 3);
    expect(job.summary.outsideHa).toBeCloseTo(0.05, 3);
    expect(job.summary.paddockHa).toBeCloseTo(0.25, 3);
    expect(job.workedHa).toBe("0.05");
    expect(job.paddockNames).toEqual(["1"]);
    expect(job.declaredRate).toBe("100");
    expect(job.track.settings[0]).toEqual({ widthM: 10, lateralM: 0, backM: 0, settingsId: w.settings12 });
    expect(job.boundaries).toHaveLength(1);
  });

  it("sending the same job again returns it, once; a different job under the same id is refused", async () => {
    const replay = await call(worker, jobsRoute.POST as Handler, "/api/farming/tractor/jobs", {}, "POST", { id: w.job, farmId: w.home, paddockIds: [w.p1], operation: "spreading", equipmentId: w.spreader, track: { ...straightTrack(10), settings: [{ widthM: 10, lateralM: 0, backM: 0, settingsId: w.settings12 }] } });
    expect(replay.status).toBe(200);
    expect(replay.body.created).toBe(false);
    // The device's queue sends the track as a file (base64 of its JSON) with the operation id: the same job (decision 1028).
    const sameTrack = { ...straightTrack(10), settings: [{ widthM: 10, lateralM: 0, backM: 0, settingsId: w.settings12 }] };
    const queued = await call(worker, jobsRoute.POST as Handler, "/api/farming/tractor/jobs", {}, "POST", { id: w.job, operationId: w.job, farmId: w.home, paddockIds: [w.p1], operation: "spreading", equipmentId: w.spreader, trackBase64: Buffer.from(JSON.stringify(sameTrack)).toString("base64") });
    expect(queued.status).toBe(200);
    expect(queued.body.created).toBe(false);
    const broken = await call(worker, jobsRoute.POST as Handler, "/api/farming/tractor/jobs", {}, "POST", { id: w.job, farmId: w.home, paddockIds: [w.p1], operation: "spreading", trackBase64: "not base64!" });
    expect(broken.status).toBe(400);
    const different = await call(worker, jobsRoute.POST as Handler, "/api/farming/tractor/jobs", {}, "POST", { id: w.job, farmId: w.home, paddockIds: [w.p1], operation: "spreading", track: straightTrack(20) });
    expect(different.status).toBe(409);
    const count = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query<{ n: number }>("select count(*)::int as n from tractor_jobs"));
    expect(count.rows[0].n).toBe(1);
  });

  it("an unassigned job is allowed, has no paddock share, and can be clipped later without changing its track", async () => {
    const id = "1b8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a";
    const saved = await call(worker, jobsRoute.POST as Handler, "/api/farming/tractor/jobs", {}, "POST", { id, farmId: w.home, paddockIds: [], operation: "mowing", track: straightTrack(10) });
    expect(saved.status).toBe(201);
    const job = (saved.body as { job: TractorJob }).job;
    expect(job.summary.workedHa).toBeCloseTo(0.1, 3);
    expect(job.summary.coveredPct).toBeNull();
    expect(job.paddockNames).toEqual([]);
    const clipped = await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${id}`, { jobId: id }, "PATCH", { paddockIds: [w.p1, w.p2] });
    expect(clipped.status).toBe(200);
    const after = (clipped.body as { job: TractorJob }).job;
    // Paddocks 1 and 2 run from x -100 to 75: 75 m of the 100 m run is inside them.
    expect(after.summary.workedHa).toBeCloseTo(0.075, 3);
    expect(after.summary.outsideHa).toBeCloseTo(0.025, 3);
    expect(after.paddockNames).toEqual(["1", "2"]);
    expect(after.track).toEqual(job.track);
    // The track itself can't be changed, even directly.
    await expect(inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query("update tractor_jobs set track = '{}'::jsonb where id = $1", [id]))).rejects.toThrow(/can't be changed/);
    await expect(inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query("delete from tractor_jobs where id = $1", [id]))).rejects.toThrow(/can't be deleted/);
  });

  it("changing the equipment's width later never changes an old job", async () => {
    await call(worker, equipmentItemRoute.PATCH as Handler, `/api/farming/tractor/equipment/${w.spreader}`, { equipmentId: w.spreader }, "PATCH", { widthM: "24" });
    const job = await call(worker, jobRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job });
    expect((job.body.job as TractorJob).summary.workedHa).toBeCloseTo(0.05, 3);
    expect((job.body.job as TractorJob).track.settings[0].widthM).toBe(10);
  });

  it("farm staff see their own jobs; viewers see every job on their farms", async () => {
    const mine = await call(worker, jobsRoute.GET as Handler, `/api/farming/tractor/jobs?farmId=${w.home}`);
    expect((mine.body.jobs as TractorJobListItem[]).length).toBe(2);
    const theirs = await call(other, jobsRoute.GET as Handler, `/api/farming/tractor/jobs?farmId=${w.home}`);
    expect((theirs.body.jobs as TractorJobListItem[]).length).toBe(0);
    expect((await call(other, jobRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job })).status).toBe(404);
    expect((await call(other, exportRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}/export?format=gpx`, { jobId: w.job })).status).toBe(404);
    const all = await call(viewer, jobsRoute.GET as Handler, `/api/farming/tractor/jobs?farmId=${w.home}`);
    expect((all.body.jobs as TractorJobListItem[]).length).toBe(2);
    // A viewer can read but not change or save.
    expect((await call(viewer, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notes: "x" })).status).toBe(403);
    expect((await call(viewer, jobsRoute.POST as Handler, "/api/farming/tractor/jobs", {}, "POST", { id: "2c8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a", farmId: w.home, operation: "other", track: straightTrack() })).status).toBe(403);
    // Another farm staff member can't change someone else's job.
    expect((await call(other, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notes: "x" })).status).toBe(404);
  });

  it("farm staff can't run jobs on a farm they aren't assigned, or use another farm's paddocks", async () => {
    expect((await call(worker, jobsRoute.POST as Handler, "/api/farming/tractor/jobs", {}, "POST", { id: "3d8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a", farmId: w.runoff, operation: "spreading", track: straightTrack() })).status).toBe(404);
    expect((await call(worker, jobsRoute.GET as Handler, `/api/farming/tractor/jobs?farmId=${w.runoff}`)).status).toBe(404);
    expect((await call(worker, jobsRoute.POST as Handler, "/api/farming/tractor/jobs", {}, "POST", { id: "4e8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a", farmId: w.home, paddockIds: [w.runoffPaddock], operation: "spreading", track: straightTrack() })).status).toBe(400);
  });

  it("only bookkeepers and above link a job to a fertiliser plan; nothing posts", async () => {
    expect((await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { fertiliserPlanId: w.plan })).status).toBe(403);
    const before = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query<{ n: number }>("select count(*)::int as n from ledger_journals"));
    const linked = await call(bookkeeper, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { fertiliserPlanId: w.plan, declaredQuantity: "5", declaredQuantityUnit: "t" });
    expect(linked.status).toBe(200);
    expect(linked.body.job).toMatchObject({ fertiliserPlanId: w.plan, fertiliserPlanName: "Spring 2026", declaredQuantity: "5", declaredQuantityUnit: "t", declaredRate: "100" });
    const after = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query<{ n: number }>("select count(*)::int as n from ledger_journals"));
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // Farm staff don't see the plan link.
    expect(((await call(worker, jobRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job })).body.job as TractorJob).fertiliserPlanId).toBeNull();
  });

  it("exports GeoJSON and GPX that say they're phone GPS estimates", async () => {
    const geo = await call(viewer, exportRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}/export?format=geojson`, { jobId: w.job });
    expect(geo.status).toBe(200);
    expect(geo.headers.get("content-type")).toContain("application/geo+json");
    const collection = geo.body as { type: string; tohyee: { notice: string; paddocks: string[] }; features: Array<{ properties: { layer: string } }> };
    expect(collection.type).toBe("FeatureCollection");
    expect(collection.tohyee.notice).toMatch(/phone GPS/);
    expect(collection.tohyee.paddocks).toEqual(["1"]);
    expect(collection.features.map((feature) => feature.properties.layer)).toEqual(expect.arrayContaining(["track", "worked", "overlap", "not_covered"]));
    const gpx = await call(viewer, exportRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}/export?format=gpx`, { jobId: w.job });
    expect(gpx.status).toBe(200);
    const text = String(gpx.body.text);
    expect(text).toContain('<gpx version="1.1"');
    expect(text).toContain("Estimated from phone GPS");
    expect(text.match(/<trkpt /g)).toHaveLength(51);
    expect(gpx.headers.get("content-disposition")).toContain("tractor-2026-10-28-spreading.gpx");
  });

  it("a wrong quantity corrected keeps the original, the reason, who and Tohyee's time, in the history and every export (#491)", async () => {
    // Bookkeeper entered 5 t above; it was really 0.5 t, in the wrong units: 500 kg.
    const noReason = await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { declaredQuantity: "500", declaredQuantityUnit: "kg" });
    expect(noReason.status).toBe(400);
    expect(String(noReason.body.error ?? JSON.stringify(noReason.body))).toMatch(/why it's being corrected/i);
    const before = Date.now();
    const fixed = await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { declaredQuantity: "500", declaredQuantityUnit: "kg", reason: "Typed tonnes instead of kilograms" });
    expect(fixed.status).toBe(200);
    const job = fixed.body.job as TractorJob;
    expect(job.declaredQuantity).toBe("500");
    expect(job.historyComplete).toBe(true);
    const last = job.history.at(-1)!;
    expect(last).toMatchObject({ change: "corrected", reason: "Typed tonnes instead of kilograms", enteredByEmail: "tractor-staff@example.com" });
    expect(last.changes).toEqual([{ field: "quantity", label: "Quantity (entered)", from: "5 t", to: "500 kg" }]);
    // Tohyee's time, not the phone's.
    expect(Date.parse(last.enteredAt)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 - 1000);
    // The first version is the job as the phone sent it.
    expect(job.history[0]).toMatchObject({ version: 1, change: "saved", enteredByEmail: "tractor-staff@example.com" });
    expect(job.history[0].details.declaredQuantity).toBeNull();
    // Farm staff don't see the plan link in the history either.
    expect(job.history.some((version) => version.details.fertiliserPlanId !== null)).toBe(false);
    expect(job.history.flatMap((version) => version.changes).some((change) => change.field === "plan")).toBe(false);
    const forBooks = (await call(bookkeeper, jobRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job })).body.job as TractorJob;
    expect(forBooks.history.flatMap((version) => version.changes).some((change) => change.field === "plan")).toBe(true);
    // A change that changes nothing adds no version.
    const same = await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { declaredQuantity: "500", declaredQuantityUnit: "kg" });
    expect((same.body.job as TractorJob).history).toHaveLength(job.history.length);
    // Exports carry it.
    const geo = (await call(viewer, exportRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}/export?format=geojson`, { jobId: w.job })).body as { tohyee: { history: Array<{ reason: string | null; changes: Array<{ what: string; from: string; to: string }> }>; scope: string[]; historyComplete: boolean } };
    expect(geo.tohyee.history.at(-1)).toMatchObject({ reason: "Typed tonnes instead of kilograms", changes: [{ what: "Quantity (entered)", from: "5 t", to: "500 kg" }] });
    expect(geo.tohyee.scope.join(" ")).toMatch(/Corrected after it was saved/);
    const gpx = String((await call(viewer, exportRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}/export?format=gpx`, { jobId: w.job })).body.text);
    expect(gpx).toContain("Typed tonnes instead of kilograms");
    expect(gpx).toContain("5 t → 500 kg");
    const summary = await call(viewer, exportRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}/export?format=summary`, { jobId: w.job });
    expect(summary.headers.get("content-type")).toContain("text/plain");
    expect(String(summary.body.text)).toContain("Quantity (entered): 5 t → 500 kg");
    expect(String(summary.body.text)).toContain("Entered by a person (not measured)");
    // Versions can't be changed or deleted, even directly.
    await expect(inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query("update tractor_job_versions set reason = 'x' where job_id = $1", [w.job]))).rejects.toThrow();
    await expect(inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => tx.query("delete from tractor_job_versions where job_id = $1", [w.job]))).rejects.toThrow();
  });

  it("a corrected note keeps what it said before; adding a first note needs no reason", async () => {
    const first = await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notes: "Spread along the creek paddock" });
    expect(first.status).toBe(200);
    expect((first.body.job as TractorJob).history.at(-1)!.change).toBe("changed");
    expect((await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notes: "Kept 20 m back from the creek" })).status).toBe(400);
    const corrected = (await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notes: "Kept 20 m back from the creek", reason: "First note was unclear" })).body.job as TractorJob;
    expect(corrected.history.at(-1)!.changes).toEqual([{ field: "notes", label: "Notes", from: "Spread along the creek paddock", to: "Kept 20 m back from the creek" }]);
  });

  it("forgot Working OFF: a time marked not working comes out of the estimate; the track and the first estimate stay", async () => {
    const before = (await call(worker, jobRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job })).body.job as TractorJob;
    // The last 25 seconds of the run (x 50 to 100) were the drive back: half of it inside paddock 1 (x 25 to 75).
    const marked = await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notWorking: [{ from: START + 25_000, to: START + 50_000, why: "Driving back to the gate, spinner off" }] });
    expect(marked.status).toBe(200);
    const job = marked.body.job as TractorJob;
    expect(job.track).toEqual(before.track);
    expect(job.track.points.every((point) => point[4] === 1)).toBe(true);
    expect(job.summary.workedHa).toBeLessThan(before.summary.workedHa);
    expect(job.firstSummary?.workedHa).toBeCloseTo(0.05, 3);
    expect(job.boundaries.map((entry) => entry.boundaryId)).toEqual(before.boundaries.map((entry) => entry.boundaryId));
    expect(job.history.at(-1)!.change).toBe("changed");
    expect(job.history.at(-1)!.changes.map((change) => change.field)).toEqual(expect.arrayContaining(["notWorking", "estimate"]));
    // Outside the job's times, or without why, is refused.
    expect((await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notWorking: [{ from: START - 600_000, to: START, why: "x" }] })).status).toBe(400);
    expect((await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notWorking: [{ from: START, to: START + 1000, why: "" }] })).status).toBe(400);
    // Removing it is a correction: it needs why.
    expect((await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notWorking: [] })).status).toBe(400);
    const geo = (await call(viewer, exportRoute.GET as Handler, `/api/farming/tractor/jobs/${w.job}/export?format=geojson`, { jobId: w.job })).body as { tohyee: { markedNotWorking: unknown[]; estimatedAsFirstSaved: { workedHa: number }; recordNote: string }; features: Array<{ properties: { layer: string; working?: boolean; workingFrom?: string } }> };
    expect(geo.tohyee.markedNotWorking).toHaveLength(1);
    expect(geo.tohyee.estimatedAsFirstSaved.workedHa).toBeCloseTo(0.05, 3);
    expect(geo.tohyee.recordNote).toMatch(/not a finding/);
    // The track in the export is Working as switched: all ON.
    expect(geo.features.filter((feature) => feature.properties.layer === "track").every((feature) => feature.properties.working === true && feature.properties.workingFrom === "operator switch")).toBe(true);
  });

  it("jobs from before version history: an unchanged one is as saved; a changed one says earlier edits weren't recorded, and nothing is made up", async () => {
    const migration = tenantMigrations.find((entry) => entry.version === "0205")!.sql;
    const backfill = migration.slice(migration.indexOf("insert into tractor_job_versions"), migration.indexOf("-- From here the time"));
    const unchanged = "5f8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a";
    const changed = "6a8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a";
    await inOrganisation(ORG, { userId: owner.id, email: owner.email }, async (tx) => {
      // Copies of a job as they'd have been before this version: no versions kept.
      await tx.query("create temp table old_jobs on commit drop as select * from tractor_jobs where id = $1", [w.job]);
      await tx.query("update old_jobs set id = $1, status = 'active', withdrawn_reason = null, updated_at = null, updated_by_email = null, notes = null", [unchanged]);
      await tx.query("insert into tractor_jobs select * from old_jobs");
      await tx.query("update old_jobs set id = $1, updated_at = now(), updated_by_email = 'tractor-staff@example.com', notes = 'Changed once'", [changed]);
      await tx.query("insert into tractor_jobs select * from old_jobs");
      await tx.query(backfill);
    });
    const a = (await call(worker, jobRoute.GET as Handler, `/api/farming/tractor/jobs/${unchanged}`, { jobId: unchanged })).body.job as TractorJob;
    expect(a.historyComplete).toBe(true);
    expect(a.history).toHaveLength(1);
    expect(a.history[0]).toMatchObject({ change: "saved", enteredByEmail: "tractor-staff@example.com" });
    const b = (await call(worker, jobRoute.GET as Handler, `/api/farming/tractor/jobs/${changed}`, { jobId: changed })).body.job as TractorJob;
    expect(b.historyComplete).toBe(false);
    expect(b.firstSummary).toBeNull();
    expect(b.history).toHaveLength(1);
    expect(b.history[0]).toMatchObject({ change: "before_history", enteredByEmail: "Tohyee (when version history started)" });
    expect(b.history[0].details.notes).toBe("Changed once");
    const text = String((await call(viewer, exportRoute.GET as Handler, `/api/farming/tractor/jobs/${changed}/export?format=summary`, { jobId: changed })).body.text);
    expect(text).toContain(EARLIER_EDITS_NOT_RECORDED);
  });

  it("withdrawing keeps the job, with why", async () => {
    const withdrawn = await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { withdraw: "Test run, not a real job" });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.job).toMatchObject({ status: "withdrawn", withdrawnReason: "Test run, not a real job" });
    expect((withdrawn.body.job as TractorJob).history.at(-1)).toMatchObject({ change: "withdrawn", reason: "Test run, not a real job" });
    expect((await call(worker, jobRoute.PATCH as Handler, `/api/farming/tractor/jobs/${w.job}`, { jobId: w.job }, "PATCH", { notes: "again" })).status).toBe(400);
  });
});

describe("tractor track checks", () => {
  it("refuses points that aren't times and positions", async () => {
    const { parseTrack } = await import("@/lib/farming/tractor");
    expect(() => parseTrack({ version: 1, settings: [{ widthM: 10, lateralM: 0, backM: 0 }], points: [[1, 2]], events: [] })).toThrow(/isn't valid/);
    expect(() => parseTrack({ version: 2, settings: [], points: [] })).toThrow(/newer version/);
    expect(() => parseTrack({ version: 1, settings: [{ widthM: 10, lateralM: 0, backM: 0 }], points: [[START, 170, -45, 4, 1, 3, null, 0]], events: [] })).toThrow(/isn't valid/);
  });
});

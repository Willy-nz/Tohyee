import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as applicationsRoute from "@/app/api/farming/effluent/applications/route";
import * as changesRoute from "@/app/api/farming/effluent/applications/changes/route";
import * as readingsRoute from "@/app/api/farming/effluent/pond-readings/route";
import * as filesRoute from "@/app/api/farming/safety/files/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { addApplication, addDeferral, addPondReading, changeApplication, changeLogRecord, effluentLog } from "@/lib/effluent/log";
import { addSetup, addSystem, changeSetup } from "@/lib/effluent/setup";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { openQueue, type QueueItem, type Sender, sendOutcome } from "@/lib/offline/queue";
import { listEquipment, recordCheck } from "@/lib/safety/equipment";
import { checkSafetyHistory } from "@/lib/safety/records";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-effluent-log";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
type Handler = (request: Request, context: never) => Promise<Response>;

/** Hours ago, as an ISO time (so nothing is in the future). */
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/**
 * The daily effluent log (#487, EF9-EF18 in docs/FARM-EFFLUENT.md,
 * decisions 1080-1089): runs with positions and depth as entered and as
 * worked out, the ponding check, pond levels and storage, days not
 * applied, the comparison with the consent in neutral counts, who may
 * correct what, and the phone's queue sending each once.
 */
describeWithDatabase("farm effluent log", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let other: SessionUser;
  let viewer: SessionUser;
  let cookie: string;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;
  const members = new Map<string, string>();

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("efl-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("efl-worker@example.com", { displayName: "Hemi" });
    other = await createTestUser("efl-other@example.com", { displayName: "Mere" });
    viewer = await createTestUser("efl-viewer@example.com", { displayName: "Tama" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker'), ($1, $3, 'farm_worker'), ($1, $4, 'viewer')", [ORG, worker.id, other.id, viewer.id]);
    members.set(owner.id, "Jess").set(worker.id, "Hemi");
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.p1 = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "4" }))).id;
    w.p2 = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "2", effectiveHa: "4" }))).id;
    for (const user of [worker, other]) await as(owner)((tx) => setMemberFarmAccess(tx, { userId: user.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    const consent = await as(owner)((tx) => addSetup(tx, "consents", { farmId: w.home, council: "orc", template: "orc" }));
    await as(owner)((tx) => changeSetup(tx, "consents", consent.recordId, { expectedVersion: 1, maxDepthMm: "25", maxRateMmPerHour: "10", returnPeriodDays: 14 }));
    w.pond = (await as(owner)((tx) => addSetup(tx, "ponds", { farmId: w.home, name: "Pond", capacityM3: "2000", fullAtMm: "2500", highAtMm: "2200", lowAtMm: "300", dailyInflowM3: "20" }))).recordId;
    w.block = (await as(owner)((tx) => addSetup(tx, "blocks", { farmId: w.home, name: "Shed block", paddockIds: [w.p1, w.p2] }))).recordId;
    w.bore = (await as(owner)((tx) => addSetup(tx, "zones", { farmId: w.home, name: "Bore", feature: "bore", point: [170.5, -45.9] }))).recordId;
    w.irrigator = (await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Irrigator", type: "travelling_irrigator", pondId: w.pond, settings: { flowM3PerHour: "18", wettedWidthM: "30", speedMPerHour: "40" } }, members))).recordId;
    w.pods = (await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Pods", type: "pods", settings: { rateMmPerHour: "4", pulsePercent: "50" }, shiftEveryHours: "8" }, members))).recordId;
    w.tanker = (await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Tanker", type: "slurry_tanker", settings: { tankM3: "10" } }, members))).recordId;
    cookie = await sessionCookieFor(worker);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("EF9 a travelling irrigator run: depth worked out from the settings and kept beside the depth entered", async () => {
    const run = await as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, blockId: w.block, paddockIds: [w.p1], startedAt: ago(30), stoppedAt: ago(26), depthEnteredMm: "14", ponding: { result: "none" }, weather: "Fine, light wind", soil: "Boot print dry" }));
    expect(run.data).toMatchObject({ depthEnteredMm: "14", depthWorkedOut: { mm: "15", how: "18 m³ an hour ÷ (30 m wide × 40 m an hour)" }, usedWhileOutOfUse: false, ponding: { result: "none" } });
    w.run1 = run.recordId;
    // A later change to the settings doesn't rewrite what was worked out then.
    await as(owner)((tx) => changeSetup(tx, "systems", w.irrigator, { expectedVersion: 1, settings: { flowM3PerHour: "36", wettedWidthM: "30", speedMPerHour: "40" } }));
    const corrected = await as(worker)((tx) => changeApplication(tx, w.run1, { step: "correct", expectedVersion: 1, depthEnteredMm: "15", why: "Misread the bucket" }));
    expect(corrected.data.depthWorkedOut?.mm).toBe("15");
  });

  it("EF10 stopping needs the ponding and runoff check; ponding needs what was seen", async () => {
    await expect(as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, paddockIds: [w.p2], startedAt: ago(5), stoppedAt: ago(4) }))).rejects.toThrow(/ponding and runoff check/);
    await expect(as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, paddockIds: [w.p2], startedAt: ago(5), stoppedAt: ago(4), ponding: { result: "ponding" } }))).rejects.toThrow(/what was seen/);
    await expect(as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, paddockIds: [w.p2], startedAt: ago(3), stoppedAt: ago(4), ponding: { result: "none" } }))).rejects.toThrow(/stopped before it started/);
    await expect(as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, paddockIds: [w.p2], startedAt: new Date(Date.now() + 3_600_000).toISOString() }))).rejects.toThrow(/in the future/);
    await expect(as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, startedAt: ago(1) }))).rejects.toThrow(/Say where/);
  });

  it("EF11 pods: shifts are positions with their times; depth is the rate × the longest time × the share running", async () => {
    const start = await as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.pods, startedAt: ago(20), positions: [{ label: "Line A", paddockId: w.p2, point: [170.6, -45.9], movedAt: ago(20) }] }));
    expect(start.data.depthWorkedOut).toBeNull();
    const shifted = await as(worker)((tx) => changeApplication(tx, start.recordId, { step: "shift", expectedVersion: 1, position: { label: "Line B", paddockId: w.p2, point: [170.6005, -45.9], movedAt: ago(12) } }));
    expect(shifted.data.positions.map((position) => position.label)).toEqual(["Line A", "Line B"]);
    let log = await as(worker)((tx) => effluentLog(tx, w.home));
    expect(log.lastMoved.find((each) => each.systemId === w.pods)).toMatchObject({ label: "Line B", running: true });
    expect(Date.parse(log.lastMoved.find((each) => each.systemId === w.pods)!.shiftDue!)).toBeCloseTo(Date.parse(ago(4)), -5);
    const stopped = await as(worker)((tx) => changeApplication(tx, start.recordId, { step: "stop", expectedVersion: 2, stoppedAt: ago(6), ponding: { result: "ponding", note: "Small puddle by the trough; stopped the line" } }));
    // Line A 8 h, line B 6 h: 4 mm/h × 8 h × 50%.
    expect(stopped.data.depthWorkedOut).toEqual({ mm: "16", how: "4 mm an hour × 8 hours × 50% running (the longest position)" });
    await expect(as(worker)((tx) => changeApplication(tx, start.recordId, { step: "shift", expectedVersion: 3, position: { movedAt: ago(5) } }))).rejects.toThrow(/already stopped/);
    log = await as(worker)((tx) => effluentLog(tx, w.home));
    expect(log.applications.find((each) => each.recordId === start.recordId)!.flags.ponding).toBe("ponding");
  });

  it("EF12 a tanker run's depth is loads × tank ÷ area", async () => {
    const run = await as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.tanker, paddockIds: [w.p1], startedAt: ago(50), stoppedAt: ago(47), loads: 6, areaHa: "4", ponding: { result: "none" } }));
    expect(run.data.depthWorkedOut).toEqual({ mm: "1.5", how: "6 loads × 10 m³ ÷ 4 ha (10 m³ a hectare is 1 mm)" });
  });

  it("EF13 the comparison counts runs over the depth, too soon, in a buffer and while out of use, in neutral words", async () => {
    // Paddock 1 again 2 days after the tanker, 30 mm entered, a position 20 m from the bore (50 m buffer from ORC's template).
    await as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, paddockIds: [w.p1], startedAt: ago(2), stoppedAt: ago(1), depthEnteredMm: "30", ponding: { result: "none" }, positions: [{ point: [170.5, -45.89982], movedAt: ago(2) }] }));
    // The pods fail a critical check, then a run is recorded anyway: it's kept, marked.
    const machine = (await as(worker)((tx) => listEquipment(tx, w.home))).equipment.find((item) => item.data.name === "Pods")!;
    await as(worker)((tx) => recordCheck(tx, { equipmentId: machine.recordId, checklistVersion: machine.checklist!.version, answers: machine.checklist!.data.items.map((item, index) => ({ key: item.key, result: index === 0 ? "fault" : "ok", note: index === 0 ? "Line on the stream bank" : null })) }, members));
    const marked = await as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.pods, paddockIds: [w.p2], startedAt: ago(1) }));
    expect(marked.data.usedWhileOutOfUse).toBe(true);
    const log = await as(owner)((tx) => effluentLog(tx, w.home));
    expect(log.summary).toMatchObject({ applications: 5, overDepth: 1, tooSoon: 3, ponding: 1, runoff: 0, inBuffer: 1, whileOutOfUse: 1 });
    const deep = log.applications.find((each) => each.data.depthEnteredMm === "30")!;
    expect(deep.flags).toMatchObject({ overDepth: true, tooSoon: [{ paddockId: w.p1, days: expect.any(Number) }], inBuffer: [{ name: "Bore", bufferM: 50, metres: 20 }] });
  });

  it("EF14 pond readings: percent full, storage and days left, and high and low warnings", async () => {
    const high = await as(worker)((tx) => addPondReading(tx, { farmId: w.home, pondId: w.pond, levelMm: "2250", readAt: ago(3), note: "Before milking" }));
    expect(high.data.levelMm).toBe("2250");
    await as(worker)((tx) => addDeferral(tx, { farmId: w.home, reason: "too_wet", note: "Boot prints filling" }));
    await expect(as(worker)((tx) => addDeferral(tx, { farmId: w.home, reason: "other" }))).rejects.toThrow(/Say why/);
    await expect(as(worker)((tx) => addPondReading(tx, { farmId: w.home, pondId: w.pond }))).rejects.toThrow(/level on the gauge/);
    const log = await as(worker)((tx) => effluentLog(tx, w.home));
    const pond = log.ponds.find((each) => each.recordId === w.pond)!;
    // 2250 of 2500 mm: 90% full, 10% of 2000 m³ left = 200 m³, 10 days at 20 m³ a day.
    expect(pond.latest?.state).toEqual({ percentFull: "90", storageLeftM3: "200", daysLeft: "10", warning: "high", mark: null });
    expect(log.deferrals.map((deferral) => deferral.data.reason)).toEqual(["too_wet"]);
  });

  it("EF15 farm staff record on their farm only; viewers can't record; only the person or a bookkeeper corrects", async () => {
    await expect(as(worker)((tx) => addPondReading(tx, { farmId: w.runoff, pondId: w.pond, levelMm: "1" }))).rejects.toThrow(/Farm not found/);
    await expect(as(viewer)((tx) => addPondReading(tx, { farmId: w.home, pondId: w.pond, levelMm: "1" }))).rejects.toThrow(/farm staff or bookkeeper/);
    const reading = await as(worker)((tx) => addPondReading(tx, { farmId: w.home, pondId: w.pond, levelMm: "1000" }));
    await expect(as(other)((tx) => changeLogRecord(tx, "effluent_pond_reading", reading.recordId, { step: "correct", expectedVersion: 1, levelMm: "900", why: "x" }))).rejects.toThrow(/Only the person who entered it/);
    const fixed = await as(worker)((tx) => changeLogRecord(tx, "effluent_pond_reading", reading.recordId, { step: "correct", expectedVersion: 1, levelMm: "900", why: "Read the wrong mark" }));
    expect(fixed).toMatchObject({ change: "corrected", data: { levelMm: "900", why: "Read the wrong mark" } });
    await as(owner)((tx) => changeLogRecord(tx, "effluent_pond_reading", reading.recordId, { step: "withdraw", expectedVersion: 2, why: "Wrong pond" }));
    expect((await as(owner)((tx) => checkSafetyHistory(tx))).problems).toEqual([]);
  });

  it("EF16 the phone's queue sends a photo, a run and its shift and stop once each, though answers were lost", async () => {
    function handlerFor(path: string): Handler {
      if (path === "/api/farming/safety/files") return filesRoute.POST as Handler;
      if (path === "/api/farming/effluent/applications") return applicationsRoute.POST as Handler;
      if (path === "/api/farming/effluent/applications/changes") return changesRoute.POST as Handler;
      if (path === "/api/farming/effluent/pond-readings") return readingsRoute.POST as Handler;
      throw new Error(path);
    }
    let lose = 3;
    const sender: Sender = async (item: QueueItem, body) => {
      const response = await handlerFor(item.request.path)(apiRequest(item.request.path, { method: item.request.method, cookie, body }), params({}) as never);
      const payload = (await response.json()) as Record<string, unknown>;
      if (lose > 0) {
        lose -= 1;
        return { outcome: "unreachable" };
      }
      return response.ok ? { outcome: "done", result: payload } : sendOutcome(response.status, String(payload.error));
    };
    const queue = await openQueue({ server: "http://tohyee.test", userId: worker.id, organisationId: ORG }, { factory: new IDBFactory(), locks: null, channel: false });
    const farm = { farmId: w.home, farmName: "Home farm" };
    const { item: photo } = await queue.add({ ...farm, kind: "safety.file", label: "Photo", request: { method: "POST", path: "/api/farming/safety/files", body: { farmId: w.home, fileName: "pod.jpg", contentType: "image/jpeg", place: { latitude: -45.9, longitude: 170.61, accuracyM: 6, at: ago(10) } }, files: [{ blob: "file", field: "contentBase64" }] }, blobs: { file: new Blob([JPEG], { type: "image/jpeg" }) } });
    const { item: run } = await queue.add({ ...farm, kind: "effluent.application", label: "Pods", request: { method: "POST", path: "/api/farming/effluent/applications", body: { farmId: w.home, systemId: w.irrigator, startedAt: ago(10), positions: [{ paddockId: w.p2, movedAt: ago(10) }], files: [{ id: photo.operationId }] }, refs: [{ path: ["files", "0", "id"], from: photo.operationId, field: ["file", "id"] }] } });
    const ref = [{ path: ["recordId"], from: run.operationId, field: ["record", "recordId"] }];
    await queue.add({ ...farm, kind: "effluent.application.change", label: "Shifted", request: { method: "POST", path: "/api/farming/effluent/applications/changes", body: { step: "shift", expectedVersion: 1, position: { paddockId: w.p2, movedAt: ago(8) } }, refs: ref } });
    await queue.add({ ...farm, kind: "effluent.application.change", label: "Stopped", request: { method: "POST", path: "/api/farming/effluent/applications/changes", body: { step: "stop", expectedVersion: 2, stoppedAt: ago(7), ponding: { result: "none" } }, refs: ref } });
    for (let tries = 0; tries < 6 && queue.items().some((item) => item.status !== "synced"); tries += 1) await queue.sync(sender);
    expect(queue.items().map((item) => item.status)).toEqual(["synced", "synced", "synced", "synced"]);
    const rows = await as(owner)((tx) => tx.query<{ version: number; change: string }>("select e.version, e.change from safety_entries e where e.record_id = (select record_id from safety_entries where operation_id = $1) order by e.version", [run.operationId]));
    expect(rows.rows).toEqual([{ version: 1, change: "created" }, { version: 2, change: "updated" }, { version: 3, change: "updated" }]);
    expect(await as(owner)((tx) => tx.query("select 1 from safety_files where id = $1", [photo.operationId]))).toMatchObject({ rowCount: 1 });
  });
});

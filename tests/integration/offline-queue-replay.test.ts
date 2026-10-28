import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as actionRoute from "@/app/api/farming/safety/actions/[recordId]/route";
import * as checksRoute from "@/app/api/farming/safety/checks/route";
import * as filesRoute from "@/app/api/farming/safety/files/route";
import * as reportsRoute from "@/app/api/farming/safety/reports/route";
import * as signoffsRoute from "@/app/api/farming/safety/signoffs/route";
import * as visitRoute from "@/app/api/farming/safety/visits/[recordId]/route";
import * as visitsRoute from "@/app/api/farming/safety/visits/route";
import * as readingsRoute from "@/app/api/farming/farms/[farmId]/pasture/readings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { openQueue, type QueueItem, type Sender, sendOutcome } from "@/lib/offline/queue";
import { addChecklist, addEquipment, changeChecklist } from "@/lib/safety/equipment";
import { addInduction, changeInduction } from "@/lib/safety/inductions";
import { addAction, changeAction } from "@/lib/safety/reports";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "offline-replay";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);

type Handler = (request: Request, context: never) => Promise<Response>;

/**
 * The device's queue against Tohyee's real routes (#472 stage 4,
 * decisions 1008-1016): work recorded with no connection is sent once,
 * even when a send arrived but its answer was lost; photos go before the
 * record that names them; a record changed on the server since it was
 * opened, an outdated checklist or induction, needs attention instead of
 * being written over. Made-up data only.
 */
describeWithDatabase("offline work replayed to Tohyee", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let cookie: string;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;
  const members = new Map<string, string>();

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("replay-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("replay-worker@example.com", { displayName: "Hemi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    members.set(owner.id, "Jess").set(worker.id, "Hemi");
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.farm = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.paddock = (await as(owner)((tx) => addPaddock(tx, { farmId: w.farm, name: "7", effectiveHa: "4" }))).id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.farm] }));
    cookie = await sessionCookieFor(worker);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  /** The routes the queue calls, by path. */
  function handlerFor(path: string): { handler: Handler; params: Record<string, string> } {
    let match: RegExpExecArray | null;
    if (path === "/api/farming/safety/files") return { handler: filesRoute.POST as Handler, params: {} };
    if (path === "/api/farming/safety/reports") return { handler: reportsRoute.POST as Handler, params: {} };
    if (path === "/api/farming/safety/checks") return { handler: checksRoute.POST as Handler, params: {} };
    if (path === "/api/farming/safety/signoffs") return { handler: signoffsRoute.POST as Handler, params: {} };
    if (path === "/api/farming/safety/visits") return { handler: visitsRoute.POST as Handler, params: {} };
    if ((match = /^\/api\/farming\/safety\/visits\/([^/]+)$/.exec(path))) return { handler: visitRoute.POST as Handler, params: { recordId: match[1] } };
    if ((match = /^\/api\/farming\/safety\/actions\/([^/]+)$/.exec(path))) return { handler: actionRoute.POST as Handler, params: { recordId: match[1] } };
    if ((match = /^\/api\/farming\/farms\/([^/]+)\/pasture\/readings$/.exec(path))) return { handler: readingsRoute.POST as Handler, params: { farmId: match[1] } };
    throw new Error(`No route for ${path} in this test.`);
  }

  /** Sends to the real route as the worker; `loseAnswers` makes the first N sends arrive but their answers get lost. */
  function tohyee(options: { loseAnswers?: number } = {}) {
    let lose = options.loseAnswers ?? 0;
    const sent: string[] = [];
    const sender: Sender = async (item: QueueItem, body) => {
      const { handler, params: routeParams } = handlerFor(item.request.path);
      const response = await handler(apiRequest(item.request.path, { method: item.request.method, cookie, body }), params(routeParams) as never);
      const payload = (await response.json()) as Record<string, unknown>;
      sent.push(`${item.kind} ${response.status}`);
      if (lose > 0) {
        lose -= 1;
        return { outcome: "unreachable" };
      }
      return response.ok ? { outcome: "done", result: payload } : sendOutcome(response.status, String(payload.error));
    };
    return { sender, sent };
  }

  const fresh = () => openQueue({ server: "http://tohyee.test", userId: worker.id, organisationId: ORG }, { factory: new IDBFactory(), locks: null, channel: false });
  const count = async (sql: string, values: unknown[] = []) => Number((await as(owner)((tx) => tx.query<{ n: string }>(sql, values))).rows[0].n);

  it("sends a photo and the report naming it once each, though the answers were lost twice", async () => {
    const queue = await fresh();
    const { item: photo } = await queue.add({
      kind: "safety.file",
      label: "Photo",
      farmId: w.farm,
      farmName: "Home farm",
      request: { method: "POST", path: "/api/farming/safety/files", body: { farmId: w.farm, fileName: "race.jpg", contentType: "image/jpeg", phoneFileTime: "2026-10-28T08:00:00.000Z", place: { latitude: -45.87, longitude: 170.5, accuracyM: 9, at: "2026-10-28T08:00:00.000Z" } }, files: [{ blob: "file", field: "contentBase64" }] },
      blobs: { file: new Blob([JPEG], { type: "image/jpeg" }) },
    });
    await queue.add({
      kind: "safety.report",
      label: "Near miss: quad on the race",
      farmId: w.farm,
      farmName: "Home farm",
      request: { method: "POST", path: "/api/farming/safety/reports", body: { farmId: w.farm, type: "near_miss", title: "Quad nearly rolled on the race", files: [{ id: photo.operationId }] }, refs: [{ path: ["files", "0", "id"], from: photo.operationId, field: ["file", "id"] }] },
    });
    const before = { files: await count("select count(*) as n from safety_files"), reports: await count("select count(*) as n from safety_entries where kind = 'report'") };

    const lossy = tohyee({ loseAnswers: 2 });
    expect((await queue.sync(lossy.sender)).stoppedBecause).toBe("unreachable");
    expect((await queue.sync(lossy.sender)).stoppedBecause).toBe("unreachable");
    const report = await queue.sync(lossy.sender);
    expect(report).toEqual({ sent: 2, refused: 0, stoppedBecause: "done" });
    expect(lossy.sent).toEqual(["safety.file 201", "safety.file 201", "safety.file 201", "safety.report 201"]);
    expect(queue.items().map((item) => item.status)).toEqual(["synced", "synced"]);

    expect(await count("select count(*) as n from safety_files")).toBe(before.files + 1);
    expect(await count("select count(*) as n from safety_entries where kind = 'report'")).toBe(before.reports + 1);
    const kept = await as(owner)((tx) => tx.query<{ id: string; place: unknown; phone_file_time: string }>("select id::text, place, to_char(phone_file_time at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') as phone_file_time from safety_files where id = $1", [photo.operationId]));
    expect(kept.rows[0].place).toEqual({ latitude: -45.87, longitude: 170.5, accuracyM: 9, at: "2026-10-28T08:00:00.000Z" });
    expect(kept.rows[0].phone_file_time).toBe("2026-10-28T08:00:00");
    const named = await as(owner)((tx) => tx.query<{ body: string }>("select body from safety_entries where kind = 'report' and operation_id = $1", [queue.items()[1].operationId]));
    expect(named.rows[0].body).toContain(photo.operationId);
  });

  it("marks a change to a record someone else changed since as Needs attention, never written over", async () => {
    const action = await as(owner)((tx) => addAction(tx, { farmId: w.farm, title: "Fix the yard gate", assignedToUserId: worker.id }, members));
    const queue = await fresh();
    await queue.add({ kind: "safety.action.done", label: "Done: gate", farmId: w.farm, farmName: "Home farm", request: { method: "POST", path: `/api/farming/safety/actions/${action.recordId}`, body: { step: "done", expectedVersion: action.version, note: "New hinge" } } });
    // Meanwhile, online, the owner changes the action.
    await as(owner)((tx) => changeAction(tx, action.recordId, { step: "done", expectedVersion: action.version, note: "Owner fixed it" }, members));
    const { sender } = tohyee();
    expect(await queue.sync(sender)).toEqual({ sent: 0, refused: 1, stoppedBecause: "done" });
    const [item] = queue.items();
    expect(item.status).toBe("attention");
    expect(item.error).toMatch(/already marked done|changed this record/);
    expect(await count("select count(*) as n from safety_entries where record_id = $1 and body like '%New hinge%'", [action.recordId])).toBe(0);
    // And it's never sent again by itself.
    await queue.sync(sender);
    expect(queue.items()[0].attempts).toBe(1);
  });

  it("refuses a pre-start check against a checklist that changed while offline, and records one against the current version once", async () => {
    const checklist = await as(owner)((tx) => addChecklist(tx, { title: "Quad", items: [{ text: "Brakes", critical: true }] }));
    const quad = await as(owner)((tx) => addEquipment(tx, { farmId: w.farm, name: "Quad", checklistId: checklist.recordId }, members));
    const queue = await fresh();
    const answers = [{ key: "brakes", result: "ok" }];
    await queue.add({ kind: "safety.check", label: "Check: Quad", farmId: w.farm, farmName: "Home farm", request: { method: "POST", path: "/api/farming/safety/checks", body: { equipmentId: quad.recordId, checklistId: checklist.recordId, checklistVersion: 1, answers } } });
    await as(owner)((tx) => changeChecklist(tx, checklist.recordId, { expectedVersion: 1, items: [{ text: "Brakes", critical: true }, { text: "Tyres" }] }));
    const { sender } = tohyee();
    await queue.sync(sender);
    expect(queue.items()[0]).toMatchObject({ status: "attention", error: "The checklist has changed since it was opened. Open it again." });

    const again = await fresh();
    await again.add({ kind: "safety.check", label: "Check: Quad", farmId: w.farm, farmName: "Home farm", request: { method: "POST", path: "/api/farming/safety/checks", body: { equipmentId: quad.recordId, checklistId: checklist.recordId, checklistVersion: 2, answers: [...answers, { key: "tyres", result: "ok" }] } } });
    const lossy = tohyee({ loseAnswers: 1 });
    await again.sync(lossy.sender);
    await again.sync(lossy.sender);
    expect(again.items()[0].status).toBe("synced");
    expect(await count("select count(*) as n from safety_entries where kind = 'check' and body like $1", [`%${quad.recordId}%`])).toBe(1);
  });

  it("asks for renewed sign-off when the induction changed before the queued one arrived", async () => {
    const induction = await as(owner)((tx) => addInduction(tx, { title: "Farm induction", audiences: ["worker"], sections: [{ heading: "Rules", text: "Helmets on." }] }));
    const queue = await fresh();
    await queue.add({ kind: "safety.signoff", label: "Signed", farmId: w.farm, farmName: "Home farm", request: { method: "POST", path: "/api/farming/safety/signoffs", body: { farmId: w.farm, inductionId: induction.recordId, inductionVersion: 1, acknowledged: true } } });
    await as(owner)((tx) => changeInduction(tx, induction.recordId, { expectedVersion: 1, title: "Farm induction", audiences: ["worker"], sections: [{ heading: "Rules", text: "Helmets on. Gates shut." }], needsResign: true, why: "Gates" }));
    await queue.sync(tohyee().sender);
    expect(queue.items()[0]).toMatchObject({ status: "attention", error: "The induction has changed since it was opened. Read it again, then sign." });
  });

  it("keeps the phone's time for a sign-in and sign-out sent later, and a sign-out sent twice signs out once", async () => {
    const queue = await fresh();
    const arrived = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const left = new Date(Date.now() - 3_600_000).toISOString();
    const { item: signIn } = await queue.add({ kind: "safety.visit.in", label: "Signed in", farmId: w.farm, farmName: "Home farm", request: { method: "POST", path: "/api/farming/safety/visits", body: { farmId: w.farm, purpose: "Fencing", phoneTime: arrived } } });
    await queue.sync(tohyee().sender);
    const visit = (queue.items()[0].result as { visit: { recordId: string; data: { phoneTime: string } } }).visit;
    expect(visit.data.phoneTime).toBe(arrived);
    expect(signIn.status).toBe("waiting");

    const out = await fresh();
    await out.add({ kind: "safety.visit.out", label: "Signed out", farmId: w.farm, farmName: "Home farm", request: { method: "POST", path: `/api/farming/safety/visits/${visit.recordId}`, body: { phoneTime: left } } });
    const lossy = tohyee({ loseAnswers: 1 });
    await out.sync(lossy.sender);
    await out.sync(lossy.sender);
    expect(lossy.sent).toEqual(["safety.visit.out 200", "safety.visit.out 200"]);
    expect(out.items()[0].status).toBe("synced");
    const versions = await as(owner)((tx) => tx.query<{ body: string }>("select body from safety_entries where record_id = $1 order by seq", [visit.recordId]));
    expect(versions.rows).toHaveLength(2);
    expect(JSON.parse(versions.rows[1].body)).toMatchObject({ signedOut: true, leftAt: left, phoneTime: left });
  });

  it("sends a Log reading once though its answer was lost", async () => {
    const queue = await fresh();
    await queue.add({ kind: "farm.reading", label: "Paddock 7: 2,450", farmId: w.farm, farmName: "Home farm", request: { method: "POST", path: `/api/farming/farms/${w.farm}/pasture/readings`, body: { paddockId: w.paddock, measuredOn: "2026-10-27", cover: 2450, method: "visual" } } });
    const lossy = tohyee({ loseAnswers: 1 });
    await queue.sync(lossy.sender);
    await queue.sync(lossy.sender);
    expect(queue.items()[0].status).toBe("synced");
    expect(await count("select count(*) as n from pasture_readings where paddock_id = $1", [w.paddock])).toBe(1);
  });
});

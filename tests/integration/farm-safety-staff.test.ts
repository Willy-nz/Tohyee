import { afterAll, beforeAll, expect, it } from "vitest";
import * as hazardsRoute from "@/app/api/farming/safety/hazards/route";
import * as packRoute from "@/app/api/farming/safety/pack/route";
import * as reportsRoute from "@/app/api/farming/safety/reports/route";
import * as overviewRoute from "@/app/api/farming/safety/route";
import * as todayRoute from "@/app/api/farming/safety/today/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addChecklist, addEquipment, recordCheck } from "@/lib/safety/equipment";
import { readSafetyFile, uploadSafetyFile } from "@/lib/safety/files";
import { addHazard, saveEmergency } from "@/lib/safety/hazards";
import { addInduction, signInduction } from "@/lib/safety/inductions";
import { canSeeRestricted, setRestrictedMember } from "@/lib/safety/records";
import { addTraining, listTraining } from "@/lib/safety/register";
import { addAction, addReport, changeAction, listReports } from "@/lib/safety/reports";
import { safetyDue, safetyToday } from "@/lib/safety/today";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-safety-staff";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]).toString("base64");

type Handler = (request: Request, context: never) => Promise<Response>;

/**
 * Farm staff and safety (#446 with #447; FS39-FS44 in docs/FARM-SAFETY.md,
 * decisions 960-962): staff report hazards, near misses and incidents, do
 * pre-start checks and sign inductions on their assigned farms only, and
 * never see injury or medical details or another farm.
 */
describeWithDatabase("farm staff and safety", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;
  let members: Map<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("staff-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("staff-worker@example.com", { displayName: "Hemi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    members = new Map([[owner.id, "Jess"], [worker.id, "Hemi"]]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.paddock = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "5" }))).id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    await as(owner)((tx) => addHazard(tx, { farmId: w.home, title: "Effluent pond", level: "high", noGo: true, paddockIds: [w.paddock] }));
    await as(owner)((tx) => addHazard(tx, { farmId: w.runoff, title: "Runoff quarry", level: "high" }));
    await as(owner)((tx) => saveEmergency(tx, { farmId: w.home, address: "1 Example Road" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, path: string, method = "GET", body?: Record<string, unknown>) =>
    handler(apiRequest(method === "GET" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }), params({}) as never);

  it("FS39 staff read Safety on their farm, not another, and not the pack", async () => {
    const home = await call(worker, overviewRoute.GET as Handler, `/api/farming/safety?farmId=${w.home}`);
    expect(home.status).toBe(200);
    const body = (await home.json()) as { hazards: Array<{ data: { title: string } }>; access: { canRecord: boolean; canReport: boolean; farmStaff: boolean; canSeeRestricted: boolean } };
    expect(body.hazards.map((hazard) => hazard.data.title)).toEqual(["Effluent pond"]);
    expect(body.access).toEqual({ canRecord: false, canReport: true, farmStaff: true, canSeeRestricted: false, isOwner: false });
    expect((await call(worker, overviewRoute.GET as Handler, `/api/farming/safety?farmId=${w.runoff}`)).status).toBe(404);
    expect((await call(worker, packRoute.GET as Handler, `/api/farming/safety/pack?farmId=${w.home}&from=2026-01-01&to=2026-12-31`)).status).toBe(403);
    expect((await call(worker, todayRoute.GET as Handler, `/api/farming/safety/today?farmId=${w.runoff}`)).status).toBe(404);
  });

  it("FS40 staff report hazards, near misses and incidents on their farm, but don't keep the hazard register", async () => {
    const response = await call(worker, reportsRoute.POST as Handler, "/api/farming/safety/reports", "POST", { farmId: w.home, type: "hazard", title: "Broken rail on the yard fence" });
    expect(response.status).toBe(201);
    expect((await call(worker, reportsRoute.POST as Handler, "/api/farming/safety/reports", "POST", { farmId: w.runoff, type: "near_miss", title: "x" })).status).toBe(404);
    expect((await call(worker, hazardsRoute.POST as Handler, "/api/farming/safety/hazards", "POST", { farmId: w.home, title: "x" })).status).toBe(403);
  });

  it("FS41 staff never see injury or medical details, even their own or when named", async () => {
    const photo = await as(worker)((tx) => uploadSafetyFile(tx, { farmId: w.home, fileName: "cut.jpg", contentType: "image/jpeg", contentBase64: JPEG, restricted: true }));
    const result = await as(worker)((tx) => addReport(tx, { farmId: w.home, type: "incident", title: "Cut hand on the gate", injured: true, details: { injuredPerson: "Hemi", injury: "Cut hand", files: [{ id: photo.id }] } }));
    expect(result.details).not.toBeNull();
    const seen = (await as(worker)((tx) => listReports(tx, w.home))).find((report) => report.recordId === result.report.recordId)!;
    expect(seen).toMatchObject({ details: null, detailsHidden: true });
    await expect(as(worker)((tx) => readSafetyFile(tx, photo.id))).rejects.toThrow(/wasn't found/);
    await as(owner)((tx) => setRestrictedMember(tx, { userId: worker.id, allowed: true }));
    expect(await as(worker)((tx) => canSeeRestricted(tx))).toBe(false);
    expect((await as(owner)((tx) => listReports(tx, w.home))).find((report) => report.recordId === result.report.recordId)?.details?.data.injury).toBe("Cut hand");
  });

  it("FS42 staff do pre-start checks; a failed one still makes its action; they mark their own actions done but don't check them", async () => {
    const checklist = await as(owner)((tx) => addChecklist(tx, { title: "Quad", items: [{ text: "Brakes", critical: true }] }));
    const quad = await as(owner)((tx) => addEquipment(tx, { farmId: w.home, name: "Quad", checklistId: checklist.recordId }, members));
    const failed = await as(worker)((tx) => recordCheck(tx, { equipmentId: quad.recordId, checklistVersion: 1, answers: [{ key: "brakes", result: "fault", note: "Spongy" }] }, members));
    expect(failed.outOfUse).toBe(true);
    expect(failed.action?.data.assignedToUserId).toBe(worker.id);
    await expect(as(worker)((tx) => addAction(tx, { farmId: w.home, title: "x", assignedToName: "x" }, members))).rejects.toThrow(/bookkeeper/);
    const done = await as(worker)((tx) => changeAction(tx, failed.action!.recordId, { step: "done", expectedVersion: 1, note: "Bled the brakes" }, members));
    await expect(as(worker)((tx) => changeAction(tx, failed.action!.recordId, { step: "verify", expectedVersion: done.version }, members))).rejects.toThrow(/bookkeeper/);
    const own = await as(owner)((tx) => addAction(tx, { farmId: w.home, title: "Owner's job", assignedToUserId: owner.id }, members));
    await expect(as(worker)((tx) => changeAction(tx, own.recordId, { step: "done", expectedVersion: 1, note: "x" }, members))).rejects.toThrow(/bookkeeper/);
  });

  it("FS43 staff sign inductions for themselves only, and see only their own training", async () => {
    const induction = await as(owner)((tx) => addInduction(tx, { title: "Farm induction", audiences: ["worker"], sections: [{ heading: "Rules", text: "Helmets on." }] }));
    expect((await as(worker)((tx) => safetyToday(tx, w.home))).toSign.map((entry) => entry.reason)).toEqual(["Not signed yet."]);
    const signed = await as(worker)((tx) => signInduction(tx, { inductionId: induction.recordId, inductionVersion: 1, farmId: w.home, acknowledged: true }));
    expect(signed.data).toMatchObject({ signedHow: "self", person: { userId: worker.id } });
    await expect(as(worker)((tx) => signInduction(tx, { inductionId: induction.recordId, inductionVersion: 1, farmId: w.home, acknowledged: true, person: { name: "Someone" } }))).rejects.toThrow(/bookkeeper/);
    await as(owner)((tx) => addTraining(tx, { person: { userId: worker.id }, what: "Quad training", completedOn: "2026-01-01" }, members));
    await as(owner)((tx) => addTraining(tx, { person: { userId: owner.id }, what: "First aid", completedOn: "2026-01-01" }, members));
    expect((await as(worker)((tx) => listTraining(tx))).map((record) => record.data.what)).toEqual(["Quad training"]);
    await expect(as(worker)((tx) => addTraining(tx, { person: { userId: worker.id }, what: "x", completedOn: "2026-01-01" }, members))).rejects.toThrow(/bookkeeper/);
  });

  it("FS44 Today and the calendar show the person's safety jobs", async () => {
    const today = await as(worker)((tx) => safetyToday(tx, w.home));
    expect(today.importantHazards.map((hazard) => hazard.title)).toEqual(["Effluent pond"]);
    expect(today.outOfUse.map((item) => item.name)).toEqual(["Quad"]);
    expect(today.toSign).toEqual([]);
    expect(today.overdueActions).toEqual([]);
    const job = await as(owner)((tx) => addAction(tx, { farmId: w.home, title: "Fix the yard rail", assignedToUserId: worker.id, due: "2099-01-05" }, members));
    expect((await as(worker)((tx) => safetyToday(tx, w.home))).myActions.map((action) => action.id)).toContain(job.recordId);
    const due = await as(worker)((tx) => safetyDue(tx, { from: "2099-01-01", to: "2099-01-31" }));
    expect(due).toEqual([{ date: "2099-01-05", title: "Fix the yard rail", kind: "action", farmId: w.home }]);
    expect(await as(worker)((tx) => safetyDue(tx, { from: "2099-01-01", to: "2099-01-31", farmId: w.home }))).toHaveLength(1);
    await expect(as(worker)((tx) => safetyDue(tx, { from: "2099-01-01", to: "2099-01-31", farmId: w.runoff }))).rejects.toThrow(/Farm not found/);
  });
});

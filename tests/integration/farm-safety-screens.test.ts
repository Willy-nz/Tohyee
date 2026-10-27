import { afterAll, beforeAll, expect, it } from "vitest";
import * as reportsRoute from "@/app/api/farming/safety/reports/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addChecklist, addEquipment, recordCheck } from "@/lib/safety/equipment";
import { addHazard } from "@/lib/safety/hazards";
import { addAction, addReport, changeAction } from "@/lib/safety/reports";
import { safetyToday } from "@/lib/safety/today";
import { needsDoing } from "@/lib/safety/screens";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-safety-screens";

/**
 * Safety on a farm phone (#446 layout follow-up, decision 979): every
 * "needs doing" item opens its exact record, including actions that aren't
 * on a report (on a hazard, from a failed pre-start check, or on their own),
 * which the Reports and actions screen now lists.
 */
describeWithDatabase("safety screens: needs doing opens the record", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;
  let members: Map<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("screens-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("screens-worker@example.com", { displayName: "Hemi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    members = new Map([[owner.id, "Jess"], [worker.id, "Hemi"]]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, path: string) => reportsRoute.GET(apiRequest(`${path}&organisationId=${ORG}`, { method: "GET", cookie: await sessionCookieFor(user) }), params({}) as never);

  it("gives each action its report or hazard, and lists actions that aren't on a report", async () => {
    const pond = await as(owner)((tx) => addHazard(tx, { farmId: w.home, title: "Effluent pond", level: "high", noGo: true }));
    const report = await as(owner)((tx) => addReport(tx, { farmId: w.home, type: "hazard", title: "Broken rail" }));
    const onReport = await as(owner)((tx) => addAction(tx, { reportId: report.report.recordId, title: "Fix the rail", assignedToUserId: worker.id, due: "2099-01-05" }, members));
    const onHazard = await as(owner)((tx) => addAction(tx, { hazardId: pond.recordId, title: "Fence the pond", assignedToUserId: worker.id, due: "2099-01-06" }, members));
    const onItsOwn = await as(owner)((tx) => addAction(tx, { farmId: w.home, title: "Buy a first aid kit", assignedToName: "Mere" }, members));
    const elsewhere = await as(owner)((tx) => addAction(tx, { farmId: w.runoff, title: "Runoff job", assignedToName: "Mere" }, members));
    const checklist = await as(owner)((tx) => addChecklist(tx, { title: "Quad", items: [{ text: "Brakes", critical: true }] }));
    const quad = await as(owner)((tx) => addEquipment(tx, { farmId: w.home, name: "Quad", checklistId: checklist.recordId }, members));
    const failed = await as(worker)((tx) => recordCheck(tx, { equipmentId: quad.recordId, checklistVersion: 1, answers: [{ key: "brakes", result: "fault", note: "Spongy" }] }, members));

    const today = await as(worker)((tx) => safetyToday(tx, w.home));
    expect(today.myActions.find((action) => action.id === onReport.recordId)).toMatchObject({ reportId: report.report.recordId, hazardId: null });
    expect(today.myActions.find((action) => action.id === onHazard.recordId)).toMatchObject({ reportId: null, hazardId: pond.recordId });
    const hrefs = needsDoing(today, w.home).map((item) => item.href);
    expect(hrefs).toContain(`/operations/farm/safety?farm=${w.home}&view=equipment&equipment=${quad.recordId}`);
    expect(hrefs).toContain(`/operations/farm/safety?farm=${w.home}&view=reports&report=${report.report.recordId}&action=${onReport.recordId}`);
    expect(hrefs).toContain(`/operations/farm/safety?farm=${w.home}&view=reports&action=${onHazard.recordId}`);

    const response = await call(worker, `/api/farming/safety/reports?farmId=${w.home}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { otherActions: Array<{ recordId: string; state: string }> };
    const listed = body.otherActions.map((action) => action.recordId);
    expect(listed).toEqual(expect.arrayContaining([onHazard.recordId, onItsOwn.recordId, failed.action!.recordId]));
    expect(listed).not.toContain(onReport.recordId);
    expect(listed).not.toContain(elsewhere.recordId);

    // Checked and closed: no longer listed.
    const done = await as(owner)((tx) => changeAction(tx, onItsOwn.recordId, { step: "done", expectedVersion: 1, note: "Bought" }, members));
    await as(owner)((tx) => changeAction(tx, onItsOwn.recordId, { step: "verify", expectedVersion: done.version }, members));
    const after = (await (await call(owner, `/api/farming/safety/reports?farmId=${w.home}`)).json()) as { otherActions: Array<{ recordId: string }> };
    expect(after.otherActions.map((action) => action.recordId)).not.toContain(onItsOwn.recordId);

    // Staff can't open another farm's list.
    expect((await call(worker, `/api/farming/safety/reports?farmId=${w.runoff}`)).status).toBe(404);
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import * as setupRoute from "@/app/api/farming/effluent/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { CONSENT_TEMPLATES, STARTING_CHECKLISTS } from "@/lib/effluent/shared";
import { addSetup, addSystem, changeSetup, effluentSetup } from "@/lib/effluent/setup";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { listEquipment, recordCheck, releaseEquipment } from "@/lib/safety/equipment";
import { loadPackData } from "@/lib/safety/pack";
import { checkSafetyHistory, recordHistory } from "@/lib/safety/records";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-effluent-setup";
const ZONE = { type: "Polygon", coordinates: [[[170.1, -45.9], [170.101, -45.9], [170.101, -45.901], [170.1, -45.901], [170.1, -45.9]]] };

/**
 * Effluent setup (#487, EF1-EF8 in docs/FARM-EFFLUENT.md, decisions
 * 1070-1079): systems linked to Safety's equipment, ponds, blocks, no-apply
 * zones and consent conditions, kept in the safety history; owners and
 * admins set it up, farm staff read it on their farms only.
 */
describeWithDatabase("farm effluent setup", () => {
  let server: TestServer;
  let owner: SessionUser;
  let admin: SessionUser;
  let bookkeeper: SessionUser;
  let worker: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;
  let members: Map<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("ef-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    admin = await createTestUser("ef-admin@example.com", { displayName: "Will" });
    bookkeeper = await createTestUser("ef-books@example.com", { displayName: "Ana" });
    worker = await createTestUser("ef-worker@example.com", { displayName: "Hemi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'bookkeeper'), ($1, $4, 'farm_worker')", [ORG, admin.id, bookkeeper.id, worker.id]);
    members = new Map([[owner.id, "Jess"], [admin.id, "Will"], [bookkeeper.id, "Ana"], [worker.id, "Hemi"]]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.p1 = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "4.5" }))).id;
    w.p2 = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "2", effectiveHa: "5" }))).id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("EF1 a system is a machine in Safety's register, with a starting checklist for its type", async () => {
    const pond = await as(owner)((tx) => addSetup(tx, "ponds", { farmId: w.home, name: "Main pond", capacityM3: "1800", fullAtMm: "2400", highAtMm: "2100", lowAtMm: "300", dailyInflowM3: "22.5", markers: [{ label: "Full", mm: "2400" }, { label: "Low", mm: "300" }] }));
    w.pond = pond.recordId;
    expect((pond.data as { markers: Array<{ label: string }> }).markers.map((marker) => marker.label)).toEqual(["Low", "Full"]);
    const block = await as(owner)((tx) => addSetup(tx, "blocks", { farmId: w.home, name: "Shed block", paddockIds: [w.p2, w.p1], risk: "low" }));
    w.block = block.recordId;
    expect(block.data).toMatchObject({ paddockIds: [w.p1, w.p2], areaHa: null });
    const system = await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Travelling irrigator", type: "travelling_irrigator", pondId: w.pond, blockIds: [w.block], settings: { flowM3PerHour: "18", wettedWidthM: "30", speedMPerHour: "60" }, shiftEveryHours: "12", serviceEveryMonths: 6, wofDue: "2027-03-01", responsibleUserId: admin.id }, members));
    w.system = system.recordId;
    expect(system.data).toMatchObject({ type: "travelling_irrigator", pondId: w.pond, blockIds: [w.block], checkEvery: "day", settings: { flowM3PerHour: "18", rateMmPerHour: null, tankM3: null } });
    const { equipment } = await as(owner)((tx) => listEquipment(tx, w.home));
    const machine = equipment.find((item) => item.recordId === system.data.equipmentId)!;
    expect(machine.data).toMatchObject({ name: "Travelling irrigator", type: "Effluent: travelling irrigator", responsibleUserId: admin.id });
    expect(machine.checklist?.data.items.map((item) => item.text)).toEqual(STARTING_CHECKLISTS.travelling_irrigator.map((item) => item.text));
    // Settings a type doesn't use aren't kept; a tanker's are its own.
    const tanker = await as(admin)((tx) => addSystem(tx, { farmId: w.home, name: "Slurry tanker", type: "slurry_tanker", settings: { tankM3: "11.5", flowM3PerHour: "99" }, shiftEveryHours: "8" }, members));
    expect(tanker.data).toMatchObject({ settings: { tankM3: "11.5", flowM3PerHour: null }, shiftEveryHours: null });
    await expect(as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "x", type: "bucket" }, members))).rejects.toThrow(/kind of system/);
    await expect(as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "x", type: "pods", settings: { pulsePercent: "140" } }, members))).rejects.toThrow(/at most 100%/);
  });

  it("EF2 sending a new system twice makes one system and one machine", async () => {
    const before = (await as(owner)((tx) => listEquipment(tx, w.home))).equipment.length;
    const input = { farmId: w.home, name: "Pods", type: "pods", settings: { rateMmPerHour: "4" }, operationId: "0f9a0b7e-6f9c-4c34-8f0c-3d5b1f4a2e11" };
    const first = await as(owner)((tx) => addSystem(tx, input, members));
    const again = await as(owner)((tx) => addSystem(tx, input, members));
    expect(again.recordId).toBe(first.recordId);
    expect((await as(owner)((tx) => listEquipment(tx, w.home))).equipment.length).toBe(before + 1);
  });

  it("EF3 owners and admins keep the setup; bookkeepers and farm staff can't", async () => {
    const refused = /Only an owner or an admin/;
    await expect(as(bookkeeper)((tx) => addSetup(tx, "zones", { farmId: w.home, name: "Creek", feature: "waterway", zone: ZONE }))).rejects.toThrow(refused);
    await expect(as(worker)((tx) => addSetup(tx, "consents", { farmId: w.home, council: "orc", template: "orc" }))).rejects.toThrow(refused);
    await expect(as(worker)((tx) => addSystem(tx, { farmId: w.home, name: "x", type: "pods" }, members))).rejects.toThrow(refused);
    await expect(as(worker)((tx) => changeSetup(tx, "ponds", w.pond, { expectedVersion: 1, capacityM3: "1" }))).rejects.toThrow(refused);
    const zone = await as(admin)((tx) => addSetup(tx, "zones", { farmId: w.home, name: "Creek", feature: "waterway", zone: ZONE, bufferM: "50" }));
    w.zone = zone.recordId;
    await expect(as(admin)((tx) => addSetup(tx, "zones", { farmId: w.home, name: "Bore", feature: "bore" }))).rejects.toThrow(/Put it on the map/);
    // Farm staff read the setup on their own farm, not another.
    const seen = await as(worker)((tx) => effluentSetup(tx, w.home));
    expect(seen.access).toEqual({ canManage: false, canLog: true, farmStaff: true });
    expect(seen.zones.map((each) => each.data.name)).toEqual(["Creek"]);
    await expect(as(worker)((tx) => effluentSetup(tx, w.runoff))).rejects.toThrow(/Farm not found/);
    await expect(as(owner)((tx) => addSetup(tx, "blocks", { farmId: w.runoff, name: "x", paddockIds: [w.p1] }))).rejects.toThrow(/isn't on this farm/);
  });

  it("EF4 a council template fills in its pages' conditions, marked, and leaves the limits to the consent", async () => {
    const consent = await as(owner)((tx) => addSetup(tx, "consents", { farmId: w.home, council: "orc", template: "orc", consentNumber: "RM00.000.01", expiresOn: "2040-06-30" }));
    w.consent = consent.recordId;
    const data = consent.data as Record<string, unknown>;
    expect(data).toMatchObject({ council: "orc", template: "orc", maxDepthMm: null, returnPeriodDays: null, buffers: CONSENT_TEMPLATES.orc.buffers, notifyCouncil: { phone: "0800 800 033" }, sources: CONSENT_TEMPLATES.orc.sources });
    expect(data.fromTemplate).toEqual(["buffers", "deferWhen", "recordsRequired", "notifyCouncil", "otherConditions"]);
    // Entering the consent's own figures, and changing a buffer, takes that field off "from the template".
    const changed = await as(owner)((tx) => changeSetup(tx, "consents", w.consent, { expectedVersion: 1, maxDepthMm: "25", maxRateMmPerHour: "10", returnPeriodDays: 21, buffers: [...CONSENT_TEMPLATES.orc.buffers.slice(1), { feature: "waterway", metres: "60" }] }));
    expect(changed.data).toMatchObject({ maxDepthMm: "25", maxRateMmPerHour: "10", returnPeriodDays: 21, fromTemplate: ["deferWhen", "recordsRequired", "notifyCouncil", "otherConditions"] });
    await expect(as(owner)((tx) => changeSetup(tx, "consents", w.consent, { expectedVersion: 2, maxDepthMm: "-1" }))).rejects.toThrow(/can't be negative/);
    await expect(as(owner)((tx) => addSetup(tx, "consents", { farmId: w.home, council: "other", template: "ecan" }))).rejects.toThrow(/Otago Regional Council and Environment Southland only/);
  });

  it("EF5 nothing is overwritten: changes are versions, a correction says why, the history checks out", async () => {
    await expect(as(owner)((tx) => changeSetup(tx, "ponds", w.pond, { expectedVersion: 1, step: "correct", capacityM3: "1850" }))).rejects.toThrow(/what was wrong/);
    await as(owner)((tx) => changeSetup(tx, "ponds", w.pond, { expectedVersion: 1, step: "correct", capacityM3: "1850", why: "Designer's figure was 1850" }));
    await expect(as(owner)((tx) => changeSetup(tx, "ponds", w.pond, { expectedVersion: 1, capacityM3: "1900" }))).rejects.toThrow(/Someone changed this record/);
    const history = await as(worker)((tx) => recordHistory(tx, w.pond));
    expect(history.map((version) => [version.version, version.change, (version.data as { capacityM3: string }).capacityM3])).toEqual([
      [1, "created", "1800"],
      [2, "corrected", "1850"],
    ]);
    await expect(as(owner)((tx) => tx.query("update safety_entries set body = body where kind = 'effluent_pond'"))).rejects.toThrow();
    await expect(as(owner)((tx) => tx.query("delete from safety_entries where kind = 'effluent_zone'"))).rejects.toThrow();
    const check = await as(owner)((tx) => checkSafetyHistory(tx));
    expect(check.problems).toEqual([]);
    expect(check.checked).toBe(check.total);
    await as(owner)((tx) => changeSetup(tx, "zones", w.zone, { expectedVersion: 1, step: "withdraw", why: "Drawn on the wrong farm" }));
    expect((await as(owner)((tx) => effluentSetup(tx, w.home))).zones).toEqual([]);
    expect((await as(owner)((tx) => effluentSetup(tx, w.home, { includeWithdrawn: true }))).zones.map((zone) => zone.change)).toEqual(["withdrawn"]);
  });

  it("EF6 a failed critical check puts the system out of use until someone allowed releases it (Safety's rules)", async () => {
    const setup = await as(worker)((tx) => effluentSetup(tx, w.home));
    const system = setup.systems.find((each) => each.recordId === w.system)!;
    expect(system).toMatchObject({ available: true, canRelease: false });
    const answers = STARTING_CHECKLISTS.travelling_irrigator.map((item, index) => ({ key: "", text: item.text, index }));
    const { equipment } = await as(worker)((tx) => listEquipment(tx, w.home));
    const keys = equipment.find((item) => item.recordId === system.data.equipmentId)!.checklist!.data.items.map((item) => item.key);
    expect(keys.length).toBe(answers.length);
    await as(worker)((tx) => recordCheck(tx, { equipmentId: system.data.equipmentId, checklistVersion: system.checklistVersion, answers: keys.map((key, index) => ({ key, result: index === 1 ? "fault" : "ok", note: index === 1 ? "Wire rope frayed near the drum" : null })) }, members));
    const after = (await as(worker)((tx) => effluentSetup(tx, w.home))).systems.find((each) => each.recordId === w.system)!;
    expect(after).toMatchObject({ available: false, outOfUseBecause: "Wire rope not frayed; winch and cut-off work: Wire rope frayed near the drum" });
    await expect(as(worker)((tx) => releaseEquipment(tx, { equipmentId: system.data.equipmentId, whatWasDone: "x" }))).rejects.toThrow();
    await as(admin)((tx) => releaseEquipment(tx, { equipmentId: system.data.equipmentId, whatWasDone: "New wire rope fitted and tested" }));
    expect((await as(owner)((tx) => effluentSetup(tx, w.home))).systems.find((each) => each.recordId === w.system)!.available).toBe(true);
  });

  it("EF7 effluent records stay out of the WorkSafe pack and the weekly copy, but in the history", async () => {
    const today = "2099-12-31";
    const safety = await as(owner)((tx) => loadPackData(tx, { from: "2020-01-01", to: today }));
    expect(safety.entries.some((entry) => entry.kind.startsWith("effluent_"))).toBe(false);
    expect(safety.entries.some((entry) => entry.kind === "check")).toBe(true);
    const weekly = await as(owner)((tx) => loadPackData(tx, { from: today, to: today, afterSeq: "0", withholdRestricted: true }));
    expect(weekly.entries.some((entry) => entry.kind.startsWith("effluent_"))).toBe(false);
    const effluent = await as(owner)((tx) => loadPackData(tx, { from: "2020-01-01", to: today, kinds: "effluent" }));
    expect(new Set(effluent.entries.map((entry) => entry.kind))).toEqual(new Set(["effluent_pond", "effluent_block", "effluent_system", "effluent_zone", "effluent_consent"]));
    expect(effluent.chain.length).toBe(safety.chain.length);
  });

  it("EF8 the setup route answers farm staff on their farm", async () => {
    const cookie = await sessionCookieFor(worker);
    const response = await (setupRoute.GET as (request: Request, context: never) => Promise<Response>)(apiRequest(`/api/farming/effluent?organisationId=${ORG}&farmId=${w.home}`, { cookie }), {} as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { systems: unknown[]; consents: Array<{ data: { consentNumber: string } }> };
    expect(body.systems.length).toBe(3);
    expect(body.consents[0].data.consentNumber).toBe("RM00.000.01");
  });
});

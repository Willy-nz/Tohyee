import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { todayIsoDate } from "@/lib/dates";
import { addIncident, addIncidentAction, addService, changeIncident, effluentCare, effluentDue, effluentToday, reportFault } from "@/lib/effluent/care";
import { addApplication, addPondReading } from "@/lib/effluent/log";
import { addMonths } from "@/lib/effluent/reminders";
import { addSetup, addSystem, changeSetup } from "@/lib/effluent/setup";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { releaseEquipment } from "@/lib/safety/equipment";
import { changeAction, openActions } from "@/lib/safety/reports";
import { safetyDue, safetyToday } from "@/lib/safety/today";
import { checkSafetyHistory } from "@/lib/safety/records";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-effluent-care";
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const inDays = (days: number) => new Date(Date.parse(`${todayIsoDate()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Effluent maintenance, faults, servicing, incidents and reminders (#487,
 * EF17-EF24 in docs/FARM-EFFLUENT.md, decisions 1090-1097).
 */
describeWithDatabase("farm effluent care", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let books: SessionUser;
  const as = (user: SessionUser, via?: string) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email, via }, work);
  const w = {} as Record<string, string>;
  let members: Map<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("efc-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("efc-worker@example.com", { displayName: "Hemi" });
    books = await createTestUser("efc-books@example.com", { displayName: "Ana" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker'), ($1, $3, 'bookkeeper')", [ORG, worker.id, books.id]);
    members = new Map([[owner.id, "Jess"], [worker.id, "Hemi"], [books.id, "Ana"]]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.p1 = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "4" }))).id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: books.id, role: "bookkeeper", access: "farms", farmIds: [w.home] }));
    const consent = await as(owner)((tx) => addSetup(tx, "consents", { farmId: w.home, council: "es", template: "es" }));
    await as(owner)((tx) => changeSetup(tx, "consents", consent.recordId, { expectedVersion: 1, expiresOn: inDays(60), consentNumber: "AUTH-000 (made up)" }));
    w.pond = (await as(owner)((tx) => addSetup(tx, "ponds", { farmId: w.home, name: "Pond", capacityM3: "1000" }))).recordId;
    const irrigator = await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Irrigator", type: "travelling_irrigator", serviceEveryMonths: 6, wofDue: inDays(20), responsibleUserId: books.id, shiftEveryHours: "2" }, members));
    w.irrigator = irrigator.recordId;
    w.machine = irrigator.data.equipmentId;
    w.pods = (await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Pods", type: "pods", checkEvery: "week" }, members))).recordId;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("EF17 a fault puts the system out of use with an action, released only under Safety's rules", async () => {
    const fault = await as(worker)((tx) => reportFault(tx, { farmId: w.home, systemId: w.irrigator, what: "Hose coupling split at hydrant 3", operationId: "fault-0001-aaaa" }, members));
    expect(fault).toMatchObject({ outOfUse: true, check: { kind: "check", data: { faultReport: true, criticalFault: true, passed: false } }, action: { data: { assignedToUserId: books.id, title: "Fix Irrigator: Hose coupling split at hydrant 3" } } });
    // Sent again from the phone: kept once, no second action.
    const again = await as(worker)((tx) => reportFault(tx, { farmId: w.home, systemId: w.irrigator, what: "Hose coupling split at hydrant 3", operationId: "fault-0001-aaaa" }, members));
    expect(again.check.recordId).toBe(fault.check.recordId);
    expect((await as(books)((tx) => openActions(tx, { mine: true }))).length).toBe(1);
    let care = await as(worker)((tx) => effluentCare(tx, w.home));
    expect(care.systems.find((system) => system.recordId === w.irrigator)).toMatchObject({ available: false, outOfUseBecause: "Fault reported: Hose coupling split at hydrant 3" });
    // A note that isn't serious doesn't take it out of use.
    const minor = await as(worker)((tx) => reportFault(tx, { farmId: w.home, systemId: w.pods, what: "Nozzle a bit worn", outOfUse: false }, members));
    expect(minor.outOfUse).toBe(false);
    await expect(as(worker)((tx) => releaseEquipment(tx, { equipmentId: w.machine, whatWasDone: "Taped" }))).rejects.toThrow();
    await expect(as(owner, 'AI key "Phone"')((tx) => releaseEquipment(tx, { equipmentId: w.machine, whatWasDone: "Fixed" }))).rejects.toThrow(/not an AI or app/);
    await as(owner)((tx) => releaseEquipment(tx, { equipmentId: w.machine, whatWasDone: "New coupling fitted, tested under pressure" }));
    care = await as(worker)((tx) => effluentCare(tx, w.home));
    expect(care.systems.find((system) => system.recordId === w.irrigator)!.available).toBe(true);
  });

  it("EF18 servicing and the Effluent WoF: the next ones are worked out from the last", async () => {
    await expect(as(worker)((tx) => addService(tx, { farmId: w.home, systemId: w.irrigator, kind: "service" }))).rejects.toThrow(/who did it or what was done/);
    await expect(as(worker)((tx) => addService(tx, { farmId: w.home, systemId: w.irrigator, kind: "service", by: "x", doneOn: inDays(1) }))).rejects.toThrow(/after today/);
    const doneOn = inDays(-170);
    await as(worker)((tx) => addService(tx, { farmId: w.home, systemId: w.irrigator, kind: "service", doneOn, by: "Pump and Pipe Ltd (made up)", notes: "Pump serviced, nozzles replaced" }));
    let care = await as(worker)((tx) => effluentCare(tx, w.home));
    const irrigator = care.systems.find((system) => system.recordId === w.irrigator)!;
    expect(irrigator).toMatchObject({ lastService: doneOn, nextService: addMonths(doneOn, 6), nextWof: inDays(20) });
    expect(care.reminders.map((reminder) => [reminder.kind, reminder.when])).toEqual(expect.arrayContaining([["service", "soon"], ["wof", "soon"], ["consent", "soon"]]));
    await as(worker)((tx) => addService(tx, { farmId: w.home, systemId: w.irrigator, kind: "wof", doneOn: inDays(0), by: "Certified assessor (made up)", nextDue: inDays(365) }));
    care = await as(worker)((tx) => effluentCare(tx, w.home));
    expect(care.systems.find((system) => system.recordId === w.irrigator)!.nextWof).toBe(inDays(365));
    expect(care.reminders.some((reminder) => reminder.kind === "wof")).toBe(false);
  });

  it("EF19 reminders: shift the irrigator, read the pond, the weekly check, and the checks of a system used today", async () => {
    await as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, startedAt: ago(3), positions: [{ paddockId: w.p1, movedAt: ago(3) }] }));
    const today = await as(worker)((tx) => effluentToday(tx, w.home));
    expect(today.hasEffluent).toBe(true);
    const kinds = today.reminders.map((reminder) => `${reminder.kind}:${reminder.text}`);
    expect(kinds).toEqual(expect.arrayContaining(["shift:Shift Irrigator", "pond:Read Pond", "check:Weekly check: Pods", "check:Pre-start check: Irrigator"]));
    // The shift and the checks come before servicing and the consent.
    expect(today.reminders[0].kind).toBe("shift");
    await as(worker)((tx) => addPondReading(tx, { farmId: w.home, pondId: w.pond, levelMm: "900" }));
    expect((await as(worker)((tx) => effluentToday(tx, w.home))).reminders.some((reminder) => reminder.kind === "pond")).toBe(false);
    // A weekly system isn't listed as "not checked today" in Safety.
    const safety = await as(owner)((tx) => safetyToday(tx, w.home));
    expect(safety.notCheckedToday.map((item) => item.name)).toEqual(["Irrigator"]);
  });

  it("EF20 an incident with actions and their people; the council prompt comes from the consent and nothing is sent", async () => {
    const { incident, actions } = await as(worker)((tx) => addIncident(tx, { farmId: w.home, type: "spill", title: "Sump overflowed", whatHappened: "Pump float stuck", systemId: w.irrigator, occurredAt: ago(2), immediateAction: "Pump off, bales in the drain", reachedWater: true, actions: [{ title: "Replace the float switch", assignedToUserId: books.id, due: inDays(2) }, { title: "Call the suction tanker", assignedToName: "Contractor (made up)" }] }, members));
    w.incident = incident.recordId;
    expect(actions.map((action) => [action.data.title, action.data.effluentIncidentId])).toEqual([["Replace the float switch", incident.recordId], ["Call the suction tanker", incident.recordId]]);
    let care = await as(worker)((tx) => effluentCare(tx, w.home));
    const view = care.incidents.find((each) => each.recordId === incident.recordId)!;
    expect(view).toMatchObject({ state: "actions", tellCouncil: { who: "Environment Southland", phone: "0800 76 88 45" } });
    // Telling the council is recorded by a person, never an AI or app; then the prompt goes.
    await expect(as(worker, "farm app")((tx) => changeIncident(tx, incident.recordId, { step: "council_told", expectedVersion: 1, councilTold: { on: inDays(0), how: "phone" } }))).rejects.toThrow(/not an AI or app/);
    await as(worker)((tx) => changeIncident(tx, incident.recordId, { step: "council_told", expectedVersion: 1, councilTold: { on: inDays(0), how: "phone", who: "Duty officer", reference: "REF-1 (made up)" } }));
    care = await as(worker)((tx) => effluentCare(tx, w.home));
    expect(care.incidents.find((each) => each.recordId === incident.recordId)!.tellCouncil).toBeNull();
    const extra = await as(worker)((tx) => addIncidentAction(tx, incident.recordId, { title: "Check the drain next morning", assignedToUserId: worker.id }, members));
    expect(extra.data.effluentIncidentId).toBe(incident.recordId);
    // Nothing goes to the council or anyone else: no email was queued.
    expect((await as(owner)((tx) => tx.query("select 1 from document_emails"))).rowCount).toBe(0);
  });

  it("EF21 an incident closes only once its actions are checked and closed, by a bookkeeper or above in person", async () => {
    await expect(as(worker)((tx) => changeIncident(tx, w.incident, { step: "close", expectedVersion: 2, why: "Done" }))).rejects.toThrow(/bookkeeper/);
    await expect(as(books)((tx) => changeIncident(tx, w.incident, { step: "close", expectedVersion: 2, why: "Done" }))).rejects.toThrow(/Check and close its actions first/);
    const actions = (await as(books)((tx) => effluentCare(tx, w.home))).incidents.find((each) => each.recordId === w.incident)!.actions;
    for (const action of actions) {
      await as(books)((tx) => changeAction(tx, action.recordId, { step: "done", expectedVersion: action.version, note: "Done" }, members));
      await as(owner)((tx) => changeAction(tx, action.recordId, { step: "verify", expectedVersion: action.version + 1, note: "Looked at it" }, members));
    }
    await expect(as(books, 'AI key "x"')((tx) => changeIncident(tx, w.incident, { step: "close", expectedVersion: 2, why: "Done" }))).rejects.toThrow(/not an AI or app/);
    const closed = await as(books)((tx) => changeIncident(tx, w.incident, { step: "close", expectedVersion: 2, why: "Float switch replaced; drain clean next morning" }));
    expect(closed.data.closed).toEqual({ why: "Float switch replaced; drain clean next morning" });
    expect((await as(owner)((tx) => checkSafetyHistory(tx))).problems).toEqual([]);
  });

  it("EF22 farm staff report on their farm only; corrections are the reporter's or a bookkeeper's", async () => {
    await expect(as(worker)((tx) => addIncident(tx, { farmId: w.runoff, type: "runoff", title: "x" }, members))).rejects.toThrow(/Farm not found/);
    await expect(as(worker)((tx) => addIncident(tx, { farmId: w.home, type: "flood", title: "x" }, members))).rejects.toThrow(/Say what happened/);
    const mine = await as(owner)((tx) => addIncident(tx, { farmId: w.home, type: "ponding", title: "Ponding by trough" }, members));
    await expect(as(worker)((tx) => changeIncident(tx, mine.incident.recordId, { step: "withdraw", expectedVersion: 1, why: "x" }))).rejects.toThrow(/Only the person who reported it/);
    await as(books)((tx) => changeIncident(tx, mine.incident.recordId, { step: "correct", expectedVersion: 1, type: "runoff", why: "It reached the race" }));
  });

  it("EF23 the calendar's dates: servicing, the Effluent WoF and the consent's expiry; incident actions are Safety's", async () => {
    const { incident } = await as(worker)((tx) => addIncident(tx, { farmId: w.home, type: "pump_failure", title: "Pump tripped" }, members));
    await as(worker)((tx) => addIncidentAction(tx, incident.recordId, { title: "Electrician to check the pump", assignedToName: "Electrician (made up)", due: inDays(3) }, members));
    const items = await as(worker)((tx) => effluentDue(tx, { from: inDays(-1), to: inDays(400) }));
    expect(new Set(items.map((item) => item.kind))).toEqual(new Set(["service", "wof", "consent"]));
    const safety = await as(owner)((tx) => safetyDue(tx, { from: inDays(-1), to: inDays(10) }));
    expect(safety.map((item) => item.title)).toContain("Electrician to check the pump");
    expect(items.find((item) => item.kind === "consent")).toMatchObject({ date: inDays(60), title: "Effluent consent AUTH-000 (made up) expires" });
    await expect(as(worker)((tx) => effluentDue(tx, { from: inDays(0), to: inDays(10), farmId: w.runoff }))).rejects.toThrow(/Farm not found/);
  });
});

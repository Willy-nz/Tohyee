import { afterAll, beforeAll, expect, it } from "vitest";
import * as previewRoute from "@/app/api/crm/reassign/preview/route";
import * as reassignRoute from "@/app/api/crm/reassign/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact, getContact } from "@/lib/contacts/service";
import { convertLead, createLead, getLead } from "@/lib/crm/leads";
import { applyReassignment, previewReassignment } from "@/lib/crm/reassign";
import { createSequence, enrol, listEnrolments } from "@/lib/crm/sequences";
import { createOpportunity, createTask, getOpportunity, listTasks, updateOpportunity, updateTask } from "@/lib/crm/service";
import { fullCrmScope } from "@/lib/crm/access";
import { createSalesTeam } from "@/lib/crm/teams";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "crm-reassign";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

/** Decision 650 (#216, #360 item 17): moving records from one person to another, after a preview. */
describeWithDatabase("CRM bulk reassignment (decision 650)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let otherRep: SessionUser;
  let outsideRep: SessionUser;
  let manager: SessionUser;
  let reportViewer: SessionUser;
  const ids: Record<string, string> = {};

  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const send = async (user: SessionUser, path: string, body: Json) =>
    apiRequest(path, { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, ...body } });
  const get = async (user: SessionUser) => apiRequest(`/api/crm/reassign?organisationId=${ORG}`, { cookie: await sessionCookieFor(user) });
  const bodyOf = async (response: Response) => (await response.json()) as Json;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    otherRep = await createTestUser("other@example.com", { displayName: "Otto Rep" });
    outsideRep = await createTestUser("outside@example.com", { displayName: "Ollie Outside" });
    manager = await createTestUser("manager@example.com", { displayName: "Mere Manager" });
    reportViewer = await createTestUser("reports@example.com", { displayName: "Rana Reports" });
    await coreQuery(
      `insert into organisation_members (organisation_id, user_id, role)
       values ($1, $2, 'sales_rep'), ($1, $3, 'sales_rep'), ($1, $4, 'sales_rep'), ($1, $5, 'sales_manager'), ($1, $6, 'report_viewer')`,
      [ORG, rep.id, otherRep.id, outsideRep.id, manager.id, reportViewer.id],
    );
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    await as((tx) => createSalesTeam(tx, { name: "South", managerUserId: manager.id, memberUserIds: [rep.id, otherRep.id] }));

    const company = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true, ownerUserId: rep.id }))).contact;
    ids.company = company.id;
    ids.otherCompany = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Hill Vets", isProspect: true, ownerUserId: otherRep.id }))).contact.id;
    ids.lead = (await as((tx) => createLead(tx, { firstName: "Aroha", lastName: "Lead", email: "aroha@example.com", ownerUserId: rep.id, idempotencyKey: key("l") }))).lead.id;
    ids.unassignedLead = (await as((tx) => createLead(tx, { firstName: "Nobody", lastName: "Owns", ownerUserId: null, idempotencyKey: key("l") }))).lead.id;
    const deal = (name: string) => as((tx) => createOpportunity(tx, { name, contactId: company.id, ownerUserId: rep.id, amount: "1000.00" }));
    ids.openDeal = (await deal("Open deal")).id;
    ids.wonDeal = (await deal("Won deal")).id;
    await as((tx) => updateOpportunity(tx, ids.wonDeal, { stage: "won" }));
    ids.openTask = (await as((tx) => createTask(tx, { title: "Call Harbour", assigneeUserId: rep.id, contactId: company.id }))).id;
    ids.doneTask = (await as((tx) => createTask(tx, { title: "Called already", assigneeUserId: rep.id, contactId: company.id }))).id;
    await as((tx) => updateTask(tx, ids.doneTask, { status: "done" }));
    const sequence = await as((tx) => createSequence(tx, { name: "Nurture", steps: [{ dayOffset: 30, kind: "call", title: "Check in" }] }));
    ids.enrolment = (await as((tx) => enrol(tx, { sequenceId: sequence.id, leadId: ids.lead }))).id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("previews what will move: open records only, closed deals when asked, nothing changed yet", async () => {
    const preview = await as((tx) => previewReassignment(tx, { fromUserId: rep.id, toUserId: otherRep.id }, fullCrmScope(owner.id)));
    expect(preview.records.leads.map((item) => item.name)).toEqual(["Aroha Lead"]);
    expect(preview.records.companies.map((item) => item.name)).toEqual(["Harbour Vets"]);
    expect(preview.records.opportunities.map((item) => item.name)).toEqual(["Open deal"]);
    expect(preview.records.tasks.map((item) => item.name)).toEqual(["Call Harbour"]);
    expect(preview.records.sequences.map((item) => [item.name, item.detail])).toEqual([["Nurture", "Aroha Lead"]]);
    const withClosed = await as((tx) => previewReassignment(tx, { fromUserId: rep.id, toUserId: otherRep.id, includeClosedDeals: true }, fullCrmScope(owner.id)));
    expect(withClosed.records.opportunities.map((item) => item.name).sort()).toEqual(["Open deal", "Won deal"]);
    expect((await as((tx) => getOpportunity(tx, ids.openDeal))).ownerUserId).toBe(rep.id);
  });

  it("a sales rep can't move records; a report viewer can't reach it; a manager only within their teams", async () => {
    const asRep = await previewRoute.POST(await send(rep, "/api/crm/reassign/preview", { fromUserId: rep.id, toUserId: otherRep.id }), noContext);
    expect(asRep.status).toBe(403);
    expect(((await bodyOf(await reassignRoute.GET(await get(rep), noContext))).options as Json).allowed).toBe(false);
    expect((await reassignRoute.GET(await get(reportViewer), noContext)).status).toBe(403);
    const outside = await previewRoute.POST(await send(manager, "/api/crm/reassign/preview", { fromUserId: rep.id, toUserId: outsideRep.id }), noContext);
    expect(outside.status).toBe(403);
    expect(((await bodyOf(outside)).error as Json | string | undefined) ?? "").toBeTruthy();
    const options = (await bodyOf(await reassignRoute.GET(await get(manager), noContext))).options as { people: Array<{ userId: string }> };
    expect(options.people.map((person) => person.userId).sort()).toEqual([manager.id, otherRep.id, rep.id].sort());
    // Nobody who can't use the CRM can be given records.
    await expect(as((tx) => previewReassignment(tx, { fromUserId: rep.id, toUserId: reportViewer.id }, fullCrmScope(owner.id)))).rejects.toThrow(/can't use the CRM/);
  });

  it("a manager moves the ticked records within the team, each with its history; unticked ones stay", async () => {
    const preview = (await bodyOf(await previewRoute.POST(await send(manager, "/api/crm/reassign/preview", { fromUserId: rep.id, toUserId: otherRep.id }), noContext)))
      .preview as { records: Record<string, Array<{ id: string }>> };
    const ticked = { ...Object.fromEntries(Object.entries(preview.records).map(([kind, items]) => [kind, items.map((item) => item.id)])), companies: [] };
    const response = await reassignRoute.POST(await send(manager, "/api/crm/reassign", { fromUserId: rep.id, toUserId: otherRep.id, ids: ticked }), noContext);
    expect(response.status).toBe(200);
    const result = (await bodyOf(response)).result as Json;
    expect(result).toMatchObject({ moved: { leads: 1, companies: 0, opportunities: 1, tasks: 1, sequences: 1 }, skipped: 0 });

    expect((await as((tx) => getLead(tx, ids.lead))).ownerUserId).toBe(otherRep.id);
    expect((await as((tx) => getOpportunity(tx, ids.openDeal))).ownerUserId).toBe(otherRep.id);
    expect((await as((tx) => getOpportunity(tx, ids.wonDeal))).ownerUserId).toBe(rep.id);
    expect((await as((tx) => getContact(tx, ids.company))).ownerUserId).toBe(rep.id);
    const tasks = await as((tx) => listTasks(tx, {}));
    expect(tasks.find((task) => task.id === ids.openTask)?.assigneeUserId).toBe(otherRep.id);
    expect(tasks.find((task) => task.id === ids.doneTask)?.assigneeUserId).toBe(rep.id);
    const enrolments = await as((tx) => listEnrolments(tx, { leadId: ids.lead }));
    expect(enrolments[0].assigneeUserId).toBe(otherRep.id);

    const history = await as((tx) =>
      tx.query<{ entity_type: string; actor_email: string }>(
        "select entity_type, actor_email from audit_events where event_type = 'crm.reassigned' order by audit_events.id",
      ),
    );
    expect(history.rows.map((row) => row.entity_type).sort()).toEqual(["crm_lead", "crm_opportunity", "crm_sequence_enrolment", "crm_task"]);
    expect(history.rows.every((row) => row.actor_email === "manager@example.com")).toBe(true);
    const moves = (await bodyOf(await reassignRoute.GET(await get(owner), noContext))).reassignments as Json[];
    expect(moves[0]).toMatchObject({ fromUserId: rep.id, toUserId: otherRep.id, byEmail: "manager@example.com", moved: { leads: 1, opportunities: 1 } });

    // The same move again finds nothing left: what's already moved is skipped.
    const again = await as((tx) => applyReassignment(tx, { fromUserId: rep.id, toUserId: otherRep.id, ids: ticked }, fullCrmScope(owner.id)));
    expect(again.moved).toEqual({ leads: 0, companies: 0, opportunities: 0, tasks: 0, sequences: 0 });
    expect(again.skipped).toBe(4);
  });

  it("unassigned leads can be given out; companies without an owner can't be moved from nobody", async () => {
    const preview = await as((tx) => previewReassignment(tx, { fromUserId: "none", toUserId: rep.id }, fullCrmScope(owner.id)));
    expect(preview.records.leads.map((item) => item.id)).toEqual([ids.unassignedLead]);
    expect(preview.records.companies).toEqual([]);
    const result = await as((tx) =>
      applyReassignment(tx, { fromUserId: "none", toUserId: rep.id, ids: { leads: [ids.unassignedLead], companies: [ids.otherCompany] } }, fullCrmScope(owner.id)),
    );
    expect(result.moved.leads).toBe(1);
    expect(result.moved.companies).toBe(0);
    expect((await as((tx) => getContact(tx, ids.otherCompany))).ownerUserId).toBe(otherRep.id);
  });

  it("a converted lead is never moved", async () => {
    const preview = await as((tx) => previewReassignment(tx, { fromUserId: otherRep.id, toUserId: rep.id, kinds: ["leads"] }, fullCrmScope(owner.id)));
    expect(preview.records.leads.map((item) => item.id)).toEqual([ids.lead]);
    await as((tx) => convertLead(tx, ids.lead, { contactId: ids.company, opportunity: false }));
    const after = await as((tx) => previewReassignment(tx, { fromUserId: otherRep.id, toUserId: rep.id, kinds: ["leads"] }, fullCrmScope(owner.id)));
    expect(after.records.leads).toEqual([]);
    const moved = await as((tx) => applyReassignment(tx, { fromUserId: otherRep.id, toUserId: rep.id, ids: { leads: [ids.lead] } }, fullCrmScope(owner.id)));
    expect(moved).toMatchObject({ moved: { leads: 0 }, skipped: 1 });
  });
});

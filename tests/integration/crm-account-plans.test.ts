import { afterAll, beforeAll, expect, it } from "vitest";
import * as planRoute from "@/app/api/crm/companies/[contactId]/plan/route";
import * as renewalsRoute from "@/app/api/crm/opportunities/[opportunityId]/renewals/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { crmScope } from "@/lib/crm/access";
import { getAccountPlan, saveAccountPlan, setRenewals } from "@/lib/crm/account-plans";
import { setDealLines, listDealLines } from "@/lib/crm/deal-lines";
import { createFollowUpRule, FOLLOW_UP_ACTOR, runFollowUpRules } from "@/lib/crm/follow-ups";
import { createOpportunity, createPerson, createTask, getOpportunity, listTasks, updateOpportunity } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { addDays } from "@/lib/financial-year";
import { todayIsoDate } from "@/lib/dates";
import { createItem } from "@/lib/items/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "account-plans";
type Json = Record<string, unknown>;

/** Decisions 653-654 (#216 stage 4, #360 item 17): account plans, renewal dates and renewal reminders. */
describeWithDatabase("CRM account plans and renewals (decisions 653-654)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let otherRep: SessionUser;
  const ids: Record<string, string> = {};
  const today = todayIsoDate();

  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const asRep = <T>(user: SessionUser, work: (tx: OrgTx, scope: Awaited<ReturnType<typeof crmScope>>) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, async (tx) => work(tx, await crmScope(tx, "sales_rep", user.id)));
  const runRules = (day = today) => inOrganisation(ORG, FOLLOW_UP_ACTOR, (tx) => runFollowUpRules(tx, { today: day }));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    otherRep = await createTestUser("other@example.com", { displayName: "Otto Rep" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep'), ($1, $3, 'sales_rep')", [ORG, rep.id, otherRep.id]);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const vets = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isCustomer: true }))).contact;
    ids.vets = vets.id;
    ids.other = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Hill Vets", isProspect: true }))).contact.id;
    ids.tama = (await as((tx) => createPerson(tx, { contactId: vets.id, firstName: "Tama", lastName: "Rewi", jobTitle: "Practice manager" }))).id;
    ids.mere = (await as((tx) => createPerson(tx, { contactId: vets.id, firstName: "Mere" }))).id;
    ids.stranger = (await as((tx) => createPerson(tx, { contactId: ids.other, firstName: "Stranger" }))).id;
    ids.rubyDeal = (await as((tx) => createOpportunity(tx, { name: "Clinic keyrings", contactId: vets.id, ownerUserId: rep.id, amount: "0" }))).id;
    ids.ottoDeal = (await as((tx) => createOpportunity(tx, { name: "Memorial range", contactId: vets.id, ownerUserId: otherRep.id, amount: "900.00" }))).id;
    await as((tx) => createTask(tx, { title: "Send renewal terms", assigneeUserId: rep.id, contactId: vets.id, dueDate: addDays(today, 3) }));
    await as((tx) => createTask(tx, { title: "Otto's visit", assigneeUserId: otherRep.id, contactId: vets.id }));
    const keyring = (
      await as((tx) => createItem(tx, { idempotencyKey: key("i"), code: "KEYRING", name: "Paw print keyring", itemType: "service", salePrice: "25.00", incomeAccountCode: "4000", salesTaxCode: "GST" }))
    ).item;
    await as((tx) => setDealLines(tx, ids.rubyDeal, { lines: [{ itemId: keyring.id, quantity: "20" }, { description: "Engraving plan", quantity: "1", unitPrice: "120.00" }] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("a company starts with no plan; anyone who changes CRM records can save one with goals and the part each person plays", async () => {
    const empty = await as((tx) => getAccountPlan(tx, ids.vets));
    expect([empty.saved, empty.summary, empty.goals, empty.people.map((p) => p.name)]).toEqual([false, null, [], ["Mere", "Tama Rewi"]]);
    const response = await planRoute.PUT(
      apiRequest(`/api/crm/companies/${ids.vets}/plan`, {
        method: "PUT",
        cookie: await sessionCookieFor(rep),
        body: {
          organisationId: ORG,
          summary: "Buys keyrings each spring. Wants a memorial range.",
          goals: [
            { title: "Renew the keyring order", targetDate: "2027-03-01" },
            { title: "Add the memorial range", status: "achieved" },
            { title: "Second clinic", status: "dropped" },
          ],
          people: [
            { personId: ids.tama, role: "decision_maker", note: "Signs off orders" },
            { personId: ids.mere, role: "" },
          ],
        },
      }),
      params({ contactId: ids.vets }),
    );
    expect(response.status).toBe(200);
    const plan = ((await response.json()) as { plan: Json }).plan as unknown as Awaited<ReturnType<typeof getAccountPlan>>;
    expect(plan.saved).toBe(true);
    expect(plan.goals.map((goal) => [goal.title, goal.targetDate, goal.status])).toEqual([
      ["Renew the keyring order", "2027-03-01", "open"],
      ["Add the memorial range", null, "achieved"],
      ["Second clinic", null, "dropped"],
    ]);
    expect(plan.people.map((person) => [person.name, person.role, person.note])).toEqual([
      ["Tama Rewi", "decision_maker", "Signs off orders"],
      ["Mere", null, null],
    ]);
    expect(plan.updatedByEmail).toBe("rep@example.com");
    const history = await as((tx) => tx.query("select 1 from audit_events where event_type = 'crm.account_plan_saved' and entity_id = $1", [ids.vets]));
    expect(history.rowCount).toBe(1);
  });

  it("refuses someone from another company, and shows each rep only their own deals and tasks", async () => {
    await expect(as((tx) => saveAccountPlan(tx, ids.vets, { people: [{ personId: ids.stranger, role: "champion" }] }))).rejects.toThrow(/isn't at Harbour Vets/);
    const ruby = await asRep(rep, (tx, scope) => getAccountPlan(tx, ids.vets, scope));
    expect(ruby.summary).toBe("Buys keyrings each spring. Wants a memorial range.");
    expect(ruby.openDeals.map((deal) => deal.name)).toEqual(["Clinic keyrings"]);
    expect(ruby.nextSteps.map((task) => task.title)).toEqual(["Send renewal terms"]);
    const jess = await as((tx) => getAccountPlan(tx, ids.vets));
    expect(jess.openDeals.map((deal) => deal.name).sort()).toEqual(["Clinic keyrings", "Memorial range"]);
  });

  it("renewal dates on a deal and its products; kept when the products are saved again; not on a lost deal; not on someone else's", async () => {
    const renewOn = addDays(today, 20);
    const lineDate = addDays(today, 40);
    const set = await asRep(rep, (tx, scope) => setRenewals(tx, ids.rubyDeal, { renewalDate: renewOn, lines: [{ lineOrder: 2, renewalDate: lineDate }] }, scope));
    expect(set).toEqual({ renewalDate: renewOn, lines: [{ lineOrder: 1, renewalDate: null }, { lineOrder: 2, renewalDate: lineDate }] });
    expect((await as((tx) => getOpportunity(tx, ids.rubyDeal))).renewalDate).toBe(renewOn);
    // Saving the products again keeps the engraving plan's date.
    await as((tx) => setDealLines(tx, ids.rubyDeal, { lines: [{ description: "Engraving plan", quantity: "1", unitPrice: "120.00" }] }));
    expect((await as((tx) => listDealLines(tx, ids.rubyDeal))).map((line) => [line.description, line.renewalDate])).toEqual([["Engraving plan", lineDate]]);
    await expect(asRep(rep, (tx, scope) => setRenewals(tx, ids.ottoDeal, { renewalDate: renewOn }, scope))).rejects.toThrow(/not found/);
    const viaRoute = await renewalsRoute.PUT(
      apiRequest(`/api/crm/opportunities/${ids.rubyDeal}/renewals`, { method: "PUT", cookie: await sessionCookieFor(rep), body: { organisationId: ORG, lines: [{ lineOrder: 9, renewalDate: renewOn }] } }),
      params({ opportunityId: ids.rubyDeal }),
    );
    expect(viaRoute.status).toBe(400);
    const lost = (await as((tx) => createOpportunity(tx, { name: "Lost one", contactId: ids.vets, ownerUserId: rep.id, amount: "10.00" }))).id;
    await as((tx) => updateOpportunity(tx, lost, { stage: "lost" }));
    await expect(as((tx) => setRenewals(tx, lost, { renewalDate: renewOn }))).rejects.toThrow(/lost/);

    const plan = await asRep(rep, (tx, scope) => getAccountPlan(tx, ids.vets, scope));
    expect(plan.renewals.map((renewal) => [renewal.opportunityName, renewal.renewalDate, renewal.what])).toEqual([
      ["Clinic keyrings", renewOn, []],
      ["Clinic keyrings", lineDate, ["Engraving plan"]],
    ]);
  });

  it("a renewal rule reminds the owner N days before, once per deal and date; earlier dates and lost deals are left alone", async () => {
    const won = (await as((tx) => createOpportunity(tx, { name: "Annual supply", contactId: ids.vets, ownerUserId: otherRep.id, amount: "500.00" }))).id;
    await as((tx) => updateOpportunity(tx, won, { stage: "won" }));
    await as((tx) => setRenewals(tx, won, { renewalDate: addDays(today, 30) }));
    // A renewal date already past when the rule is made isn't reminded.
    const past = (await as((tx) => createOpportunity(tx, { name: "Old renewal", contactId: ids.vets, ownerUserId: rep.id, amount: "5.00" }))).id;
    await as((tx) => setRenewals(tx, past, { renewalDate: addDays(today, -2) }));

    await as((tx) => createFollowUpRule(tx, { kind: "renewal_due", name: "Renewals", days: 30 }));
    const first = await runRules();
    // Ruby's deal renews in 20 and 40 days (40 is too far); Otto's won deal in 30.
    expect(first.tasksCreated).toBe(2);
    const reminders = (await as((tx) => listTasks(tx, {}))).filter((task) => task.title.startsWith("Renewal:"));
    expect(reminders.map((task) => [task.title, task.assigneeUserId, task.dueDate]).sort()).toEqual(
      [
        [`Renewal: Annual supply on ${addDays(today, 30)}`, otherRep.id, today],
        [`Renewal: Clinic keyrings on ${addDays(today, 20)}`, rep.id, today],
      ].sort(),
    );
    expect((await runRules()).tasksCreated).toBe(0);
    // Ten days on, the engraving plan's date (40 days from the start) is within 30 days.
    const later = await runRules(addDays(today, 10));
    expect(later.tasksCreated).toBe(1);
    const engraving = (await as((tx) => listTasks(tx, {}))).find((task) => task.title.includes(addDays(today, 40)));
    expect(engraving?.body).toContain("Engraving plan");
    // Moving the renewal to next year makes a new reminder when that comes near.
    await as((tx) => setRenewals(tx, won, { renewalDate: addDays(today, 395) }));
    expect((await runRules(addDays(today, 370))).tasksCreated).toBe(1);
  });
});

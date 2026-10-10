import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { crmScope } from "@/lib/crm/access";
import { createCampaign, setSourceCampaign } from "@/lib/crm/campaigns";
import { salesDashboard } from "@/lib/crm/dashboard";
import { setQuota } from "@/lib/crm/forecast";
import { convertLead, createLead } from "@/lib/crm/leads";
import { createActivity, createOpportunity, createTask, updateOpportunity, updateTask } from "@/lib/crm/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "crm-dashboard";

/** Decision 500 (#216 stage 3; Jess 10 Oct 2026): the standard sales dashboard and its definitions. */
describeWithDatabase("CRM sales dashboard (decision 500)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let otherRep: SessionUser;
  const today = todayIsoDate();
  const month = `${today.slice(0, 7)}-01`;

  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const asRep = <T>(work: (tx: OrgTx, scope: Awaited<ReturnType<typeof crmScope>>) => Promise<T>) =>
    inOrganisation(ORG, { userId: rep.id, email: rep.email }, async (tx) => work(tx, await crmScope(tx, "sales_rep", rep.id)));
  const thisMonth = { period: "month", from: today, periods: 1 };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    otherRep = await createTestUser("other@example.com", { displayName: "Otto Rep" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep'), ($1, $3, 'sales_rep')", [ORG, rep.id, otherRep.id]);
    await asOwner((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const campaign = await asOwner((tx) => createCampaign(tx, { name: "Expo", actualCost: "200" }));
    const contactId = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact.id;

    // Leads: Ruby adds two (one converted, one from the expo), Otto one.
    const aroha = (await asRep((tx, scope) => createLead(tx, { idempotencyKey: key("l"), firstName: "Aroha", companyName: "Mānuka Vets" }, scope))).lead;
    const expo = (await asRep((tx, scope) => createLead(tx, { idempotencyKey: key("l"), lastName: "Expo visitor" }, scope))).lead;
    await asRep((tx, scope) => setSourceCampaign(tx, { leadId: expo.id, campaignId: campaign.id }, scope));
    await asOwner((tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Otto's", ownerUserId: otherRep.id }));
    await asRep((tx, scope) => convertLead(tx, aroha.id, { opportunity: false }, scope));

    // Deals: Ruby wins two and loses one; one more is open; Otto wins one.
    const deal = (name: string, ownerUserId: string, amount: string, stage = "proposal") =>
      asOwner((tx) => createOpportunity(tx, { name, contactId, ownerUserId, amount, closeDate: today, stage }));
    const won1 = await deal("Keyrings", rep.id, "600.00");
    const won2 = await deal("Collars", rep.id, "400.00");
    const lost = await deal("Tags", rep.id, "100.00");
    await deal("Bowls", rep.id, "250.00", "meeting");
    const ottos = await deal("Leads", otherRep.id, "900.00");
    await asOwner((tx) => setSourceCampaign(tx, { opportunityId: won1.id, campaignId: campaign.id }));
    // Collars was added 10 days ago.
    await asOwner(async (tx) => tx.query("update crm_opportunities set created_at = now() - interval '10 days' where id = $1", [won2.id]));
    for (const id of [won1.id, won2.id, ottos.id]) await asOwner((tx) => updateOpportunity(tx, id, { stage: "won" }));
    await asOwner((tx) => updateOpportunity(tx, lost.id, { stage: "lost" }));
    await asOwner((tx) => setQuota(tx, { ownerUserId: rep.id, month, amount: "2000" }));

    // Activity: Ruby logs a call and finishes a task; Jess logs a note.
    await asRep((tx, scope) => createActivity(tx, { kind: "call", happenedAt: new Date().toISOString(), subject: "Called", opportunityId: won1.id }, scope));
    const task = await asRep((tx, scope) => createTask(tx, { title: "Send samples", contactId, assigneeUserId: rep.id }, scope));
    await asRep((tx, scope) => updateTask(tx, task.id, { status: "done" }, scope));
    await asOwner((tx) => createActivity(tx, { kind: "note", happenedAt: new Date().toISOString(), subject: "Note", contactId }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("works out conversion, win rate, cycle, ageing, activity, quota and campaigns from the records", async () => {
    const d = await asOwner((tx) => salesDashboard(tx, thisMonth));
    expect(d.periods.map((period) => period.start)).toEqual([month]);
    expect(d.leads).toEqual([{ periodStart: month, added: 3, converted: 1, rate: "33.3" }]);
    expect(d.leadSources).toEqual([{ source: "manual", added: 3, converted: 1, rate: "33.3" }]);
    expect(d.winLoss).toEqual([{ periodStart: month, won: 3, lost: 1, winRate: "75.0", wonAmounts: [{ currencyCode: "NZD", amount: "1900.00" }] }]);
    // Won: Keyrings 0 days, Collars 10, Otto's 0 → average 3.3, median 0.
    expect(d.cycle).toEqual([{ periodStart: month, won: 3, averageDays: "3.3", medianDays: "0.0" }]);
    expect(d.ageing).toEqual([{ stage: "meeting", stageName: "Meeting", count: 1, amounts: [{ currencyCode: "NZD", amount: "250.00" }], averageDays: "0.0", oldestDays: 0 }]);
    expect(d.activity.map((row) => [row.name, row.calls, row.notes, row.tasksDone])).toEqual([
      ["Jess", 0, 1, 0],
      ["Ruby Rep", 1, 0, 1],
    ]);
    expect(d.quotas).toEqual([{ periodStart: month, ownerUserId: rep.id, name: "Ruby Rep", closed: "1000.00", quota: "2000.00", attainment: "50.00" }]);
    expect(d.campaigns).toEqual([{ campaignId: expect.any(String), name: "Expo", leads: 1, won: 1, wonAmounts: [{ currencyCode: "NZD", amount: "600.00" }], actualCost: "200.00" }]);
    expect(d.deals.find((deal) => deal.name === "Collars")).toMatchObject({ stageType: "won", closedOn: today, days: 10 });
  });

  it("a sales rep sees only their own figures", async () => {
    const d = await asRep((tx, scope) => salesDashboard(tx, thisMonth, scope));
    expect(d.scoped).toBe(true);
    expect(d.leads[0]).toMatchObject({ added: 2, converted: 1, rate: "50.0" });
    expect(d.winLoss[0]).toMatchObject({ won: 2, lost: 1, winRate: "66.7", wonAmounts: [{ currencyCode: "NZD", amount: "1000.00" }] });
    expect(d.activity.map((row) => row.name)).toEqual(["Ruby Rep"]);
    expect(d.deals.every((deal) => deal.ownerUserId === rep.id)).toBe(true);
  });

  it("checks the periods asked for", async () => {
    await expect(asOwner((tx) => salesDashboard(tx, { periods: 13 }))).rejects.toThrow(/1 to 12/);
    await expect(asOwner((tx) => salesDashboard(tx, { period: "week" }))).rejects.toThrow();
    const d = await asOwner((tx) => salesDashboard(tx, { period: "month", periods: 3 }));
    expect(d.periods).toHaveLength(3);
    expect(d.periods.at(-1)!.start).toBe(month);
  });
});

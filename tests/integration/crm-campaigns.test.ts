import { afterAll, beforeAll, expect, it } from "vitest";
import * as campaignsRoute from "@/app/api/crm/campaigns/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { crmScope } from "@/lib/crm/access";
import { addMembers, campaignReport, createCampaign, listMembers, refreshCampaignMembers, setMemberStatus, setSourceCampaign, updateCampaign } from "@/lib/crm/campaigns";
import { mergePeople } from "@/lib/crm/duplicates";
import { createLeadForm } from "@/lib/crm/lead-intake";
import { convertLead, createIntakeLead, createLead, getLead, importLeads } from "@/lib/crm/leads";
import { createOpportunity, createPerson, getOpportunity, updateOpportunity } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { encryptSecret } from "@/lib/secrets";
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

const ORG = "crm-campaigns";
const noContext = undefined as unknown;
const b64 = (text: string) => Buffer.from(text).toString("base64");

/** Decision 498 (#216 stage 2; Jess 10 Oct 2026): one source campaign each, costs for reports, added / sent / responded. */
describeWithDatabase("CRM campaigns (decision 498)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let otherRep: SessionUser;
  let campaignId = "";
  let contactId = "";
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const asRep = <T>(work: (tx: OrgTx, scope: Awaited<ReturnType<typeof crmScope>>) => Promise<T>) => as(rep, async (tx) => work(tx, await crmScope(tx, "sales_rep", rep.id)));

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    otherRep = await createTestUser("other@example.com", { displayName: "Otto Rep" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep'), ($1, $3, 'sales_rep')", [ORG, rep.id, otherRep.id]);
    await as(owner, (tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    contactId = (await as(owner, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact.id;
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  it("admins make campaigns; dates and money are checked", async () => {
    const response = await campaignsRoute.POST(
      apiRequest("/api/crm/campaigns", { method: "POST", cookie: await sessionCookieFor(rep), body: { organisationId: ORG, name: "Nope" } }),
      noContext,
    );
    expect(response.status).toBe(403);
    await expect(as(owner, (tx) => createCampaign(tx, { name: "Bad", startDate: "2026-11-02", endDate: "2026-11-01" }))).rejects.toThrow(/end date/);
    await expect(as(owner, (tx) => createCampaign(tx, { name: "Bad", budget: "12.345" }))).rejects.toThrow(/2 decimal places/);
    const campaign = await as(owner, (tx) =>
      createCampaign(tx, { name: "Dunedin pet expo", kind: "event", status: "active", startDate: "2026-10-17", endDate: "2026-10-18", budget: "400", actualCost: "$300.00" }),
    );
    expect(campaign).toMatchObject({ kind: "event", budget: "400.00", actualCost: "300.00", overBudget: false, members: 0 });
    expect((await as(owner, (tx) => updateCampaign(tx, campaign.id, { actualCost: "450.50" }))).overBudget).toBe(true);
    await as(owner, (tx) => updateCampaign(tx, campaign.id, { actualCost: "300" }));
    campaignId = campaign.id;
  });

  it("leads get their source from an import or a form; a converted lead's deal keeps it; the report counts it once", async () => {
    const imported = await asRep((tx, scope) =>
      importLeads(
        tx,
        { idempotencyKey: key("i"), fileName: "expo.csv", fileBase64: b64("Name,Email\nAroha Ngata,aroha@example.nz\nHemi Walker,hemi@example.nz\n"), campaignId },
        scope,
      ),
    );
    expect(imported.created).toBe(2);
    expect(imported.leads.map((lead) => lead.sourceCampaignName)).toEqual(["Dunedin pet expo", "Dunedin pet expo"]);
    const form = await as(owner, (tx) => createLeadForm(tx, { name: "Expo sign-up", campaignId }));
    expect(form.campaignId).toBe(campaignId);
    const fromForm = await as(owner, (tx) =>
      createIntakeLead(tx, { lastName: "Form person", email: "form@example.nz" }, { source: "web_form", commandSource: "web-form", idempotencyKey: key("f"), campaignId }),
    );
    expect(fromForm?.sourceCampaignId).toBe(campaignId);
    const members = await as(owner, (tx) => listMembers(tx, { campaignId }));
    expect(members.map((member) => [member.name, member.status]).sort()).toEqual([
      ["Aroha Ngata", "added"],
      ["Form person", "responded"],
      ["Hemi Walker", "added"],
    ]);

    const aroha = imported.leads[0];
    const converted = await asRep((tx, scope) => convertLead(tx, aroha.id, { opportunityName: "Expo order", amount: "240.00", closeDate: "2026-11-30" }, scope));
    const deal = await as(owner, (tx) => getOpportunity(tx, converted.lead.convertedOpportunityId));
    expect(deal).toMatchObject({ sourceCampaignId: campaignId, sourceCampaignName: "Dunedin pet expo" });
    await as(owner, (tx) => updateOpportunity(tx, deal.id, { stage: "won" }));

    const report = await as(owner, (tx) => campaignReport(tx, campaignId));
    expect(report).toMatchObject({
      members: { added: 2, sent: 0, responded: 1 },
      leads: { sourced: 3, converted: 1, open: 2, unqualified: 0 },
      deals: { sourced: 1, won: 1, lost: 0, open: 0, wonAmounts: [{ currencyCode: "NZD", amount: "240.00" }], openAmounts: [] },
      costPerLead: "100.00",
      costPerWonDeal: "300.00",
      costIsBudget: false,
      scoped: false,
    });
  });

  it("one source campaign per deal, changed by hand; a rep's report and members are their own", async () => {
    const other = await as(owner, (tx) => createCampaign(tx, { name: "Facebook ads", kind: "advert" }));
    const deal = await as(owner, (tx) => createOpportunity(tx, { name: "Collars", contactId, ownerUserId: otherRep.id, amount: "100.00", closeDate: "2026-12-31" }));
    await as(owner, (tx) => setSourceCampaign(tx, { opportunityId: deal.id, campaignId: other.id }));
    await as(owner, (tx) => setSourceCampaign(tx, { opportunityId: deal.id, campaignId }));
    expect((await as(owner, (tx) => getOpportunity(tx, deal.id))).sourceCampaignId).toBe(campaignId);
    expect((await as(owner, (tx) => campaignReport(tx, other.id))).deals.sourced).toBe(0);
    expect((await as(owner, (tx) => campaignReport(tx, campaignId))).deals.openAmounts).toEqual([{ currencyCode: "NZD", amount: "100.00" }]);

    const asRuby = await asRep((tx, scope) => campaignReport(tx, campaignId, scope));
    // Ruby's: her imported leads and the deal from Aroha; not Otto's deal, not the unassigned form lead.
    expect(asRuby).toMatchObject({ scoped: true, leads: { sourced: 2 }, deals: { sourced: 1, open: 0 } });
    const ottos = (await as(otherRep, async (tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Otto's" }, await crmScope(tx, "sales_rep", otherRep.id)))).lead;
    await expect(asRep((tx, scope) => addMembers(tx, { campaignId, leadIds: [ottos.id] }, scope))).rejects.toThrow(/not found/i);
  });

  it("members are added in bulk, marked sent when emailed and responded when they reply", async () => {
    const mere = await as(owner, (tx) => createPerson(tx, { contactId, firstName: "Mere", email: "mere@harbourvets.nz" }));
    const tama = await as(owner, (tx) => createPerson(tx, { contactId, firstName: "Tama", email: "tama@harbourvets.nz" }));
    const lead = (await asRep((tx, scope) => createLead(tx, { idempotencyKey: key("l"), lastName: "Walk-in", email: "walkin@example.nz" }, scope))).lead;
    expect(await asRep((tx, scope) => addMembers(tx, { campaignId, personIds: [mere.id, tama.id], leadIds: [lead.id] }, scope))).toEqual({ added: 3, alreadyIn: 0 });
    expect(await asRep((tx, scope) => addMembers(tx, { campaignId, personIds: [mere.id] }, scope))).toEqual({ added: 0, alreadyIn: 1 });

    await as(owner, async (tx) => {
      const account = await tx.query<{ id: string }>(
        `insert into crm_connected_accounts (user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at)
         values ($1, 'google', 'jess@example.com', $2, $2, now()) returning id::text`,
        [owner.id, encryptSecret("x")],
      );
      // An email Tohyee sent Mere, then a reply from Tama.
      await tx.query(
        `insert into crm_sent_emails (command_source, idempotency_key, request_hash, account_id, sent_by_user_id, to_email, subject, body, person_id, status, sent_at)
         values ('ui', 'e1', 'h', $1, $2, 'mere@harbourvets.nz', 'Expo', 'Hi', $3, 'sent', now() + interval '1 minute')`,
        [account.rows[0].id, owner.id, mere.id],
      );
      await tx.query(
        `insert into crm_messages (account_id, external_id, direction, sent_at, from_email, subject) values ($1, 'm1', 'received', now() + interval '1 minute', 'Tama@HarbourVets.nz', 'Re: expo')`,
        [account.rows[0].id],
      );
    });
    expect(await as(owner, (tx) => refreshCampaignMembers(tx))).toEqual({ sent: 1, responded: 1 });
    const byPerson = async (personId: string) => (await as(owner, (tx) => listMembers(tx, { personId })))[0];
    expect((await byPerson(mere.id)).status).toBe("sent");
    expect((await byPerson(tama.id)).status).toBe("responded");
    expect(await as(owner, (tx) => refreshCampaignMembers(tx))).toEqual({ sent: 0, responded: 0 });
    const walkIn = (await asRep((tx, scope) => listMembers(tx, { leadId: lead.id }, scope)))[0];
    expect((await asRep((tx, scope) => setMemberStatus(tx, walkIn.id, "responded", scope))).respondedAt).not.toBeNull();

    // Merging two people in the same campaign leaves one membership.
    await as(owner, (tx) => mergePeople(tx, { keepId: mere.id, mergeId: tama.id }));
    expect((await as(owner, (tx) => listMembers(tx, { campaignId }))).filter((member) => member.personId === tama.id)).toEqual([]);
    expect((await as(owner, (tx) => getLead(tx, lead.id))).sourceCampaignId).toBeNull();
  });
});

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as formsRoute from "@/app/api/crm/lead-forms/route";
import * as publicFormRoute from "@/app/api/lead-forms/[organisationId]/[formKey]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { crmScope } from "@/lib/crm/access";
import { checkLeadMailbox, createLeadForm, createLeadMailbox, FORM_PER_ADDRESS, FORM_TRAP_FIELD, parseSender, updateLeadForm } from "@/lib/crm/lead-intake";
import { listLeads } from "@/lib/crm/leads";
import { listActivities } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { encryptSecret } from "@/lib/secrets";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const mocks = vi.hoisted(() => ({
  messages: [] as Array<{ id: string; receivedAt: string | null; from?: string | null; subject?: string | null; preview?: string | null; attachments: [] }>,
}));
vi.mock("@/lib/crm/mail/service", async (original) => ({
  ...(await original<object>()),
  reportMailboxToken: vi.fn(async () => ({ provider: "google", token: "test-token" })),
}));
vi.mock("@/lib/analytics/report-email-providers", () => ({
  listReportFolders: vi.fn(async () => [{ id: "Label_5", name: "Leads" }]),
  listImapFolders: vi.fn(async () => [{ id: "INBOX", name: "Inbox" }]),
  reportMessages: async function* () {
    yield* mocks.messages;
  },
  imapReportMessages: async function* () {
    yield* mocks.messages;
  },
}));

const ORG = "lead-intake";
const noContext = undefined as unknown;

/** Decision 493 (#216): leads from a website form and from a mailbox folder. */
describeWithDatabase("CRM leads from a web form and from email (decision 493)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let formKey = "";
  let formId = "";

  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const post = (body: string, options: { address?: string; key?: string; type?: string; accept?: string } = {}) =>
    publicFormRoute.POST(
      new Request(`http://tohyee.test/api/lead-forms/${ORG}/${options.key ?? formKey}`, {
        method: "POST",
        headers: {
          "content-type": options.type ?? "application/x-www-form-urlencoded",
          origin: "https://www.keapets.nz",
          "x-forwarded-for": options.address ?? "203.0.113.5",
          ...(options.accept ? { accept: options.accept } : {}),
        },
        body,
      }),
      params({ organisationId: ORG, formKey: options.key ?? formKey }),
    );

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep')", [ORG, rep.id]);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const form = await as((tx) => createLeadForm(tx, { name: "Contact page" }));
    formKey = form.formKey;
    formId = form.id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("only admins see and make forms", async () => {
    const asRep = await formsRoute.GET(apiRequest(`/api/crm/lead-forms?organisationId=${ORG}`, { cookie: await sessionCookieFor(rep) }), noContext);
    expect(asRep.status).toBe(403);
    const asOwner = await formsRoute.GET(apiRequest(`/api/crm/lead-forms?organisationId=${ORG}`, { cookie: await sessionCookieFor(owner) }), noContext);
    // No remote access address on this test server: no snippet yet.
    expect(await asOwner.json()).toMatchObject({ publicAddress: null, forms: [{ name: "Contact page", snippet: null }] });
    await expect(as((tx) => createLeadForm(tx, { name: "Bad", thankYouUrl: "javascript:alert(1)" }))).rejects.toThrow(/https/);
  });

  it("a form post makes an unassigned lead to review, with the other fields in its notes", async () => {
    const response = await post(
      new URLSearchParams({ name: "Hemi Walker", company: "Tūī Kennels", email: "hemi@tui.nz", phone: "021 111 222", message: "Price for 3 tags?", dog_name: "Rua", [FORM_TRAP_FIELD]: "" }).toString(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Thank you");
    const lead = (await as((tx) => listLeads(tx, { needsReview: true }))).find((entry) => entry.email === "hemi@tui.nz");
    expect(lead).toMatchObject({
      firstName: "Hemi",
      lastName: "Walker",
      companyName: "Tūī Kennels",
      phone: "021 111 222",
      source: "web_form",
      sourceDetail: "Contact page",
      status: "new",
      needsReview: true,
      ownerUserId: null,
      description: "Price for 3 tags?\ndog_name: Rua",
    });
  });

  it("a robot that fills in the trap field is thanked and nothing is kept; wrong keys and switched-off forms are refused", async () => {
    const before = (await as((tx) => listLeads(tx))).length;
    const robot = await post(new URLSearchParams({ name: "Spam Bot", email: "spam@bots.example", [FORM_TRAP_FIELD]: "http://spam.example" }).toString(), { address: "198.51.100.1" });
    expect(robot.status).toBe(200);
    expect((await as((tx) => listLeads(tx))).length).toBe(before);
    expect((await post("name=X", { key: "0".repeat(40) })).status).toBe(404);
    expect((await post("name=X", { key: "not-a-key" })).status).toBe(404);
    await as((tx) => updateLeadForm(tx, formId, { isActive: false }));
    expect((await post(new URLSearchParams({ name: "Off", email: "off@example.nz" }).toString(), { address: "198.51.100.2" })).status).toBe(404);
    await as((tx) => updateLeadForm(tx, formId, { isActive: true, thankYouUrl: "https://www.keapets.nz/thanks" }));
  });

  it("answers JSON for scripts, redirects to the thank-you page, refuses a bad email, and limits one address", async () => {
    const json = await post(JSON.stringify({ name: "Kiri", email: "kiri@example.nz" }), { type: "application/json", accept: "application/json", address: "198.51.100.3" });
    expect([json.status, await json.json()]).toEqual([200, { ok: true }]);
    const redirected = await post(new URLSearchParams({ name: "Tama", email: "tama@example.nz" }).toString(), { address: "198.51.100.4" });
    expect([redirected.status, redirected.headers.get("location")]).toEqual([303, "https://www.keapets.nz/thanks"]);
    const bad = await post(new URLSearchParams({ name: "Bad", email: "not-an-email" }).toString(), { address: "198.51.100.5" });
    expect(bad.status).toBe(400);
    const statuses: number[] = [];
    for (let index = 0; index <= FORM_PER_ADDRESS; index += 1) {
      statuses.push((await post(new URLSearchParams({ name: `Flood ${index}`, email: `flood${index}@example.nz` }).toString(), { address: "198.51.100.9" })).status);
    }
    expect(statuses.slice(0, FORM_PER_ADDRESS).every((status) => status === 303)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("a mailbox folder makes each email a lead once; an email from an open lead adds a note to it", async () => {
    expect(parseSender('"Aroha Ngata" <aroha@manukavets.nz>')).toEqual({ name: "Aroha Ngata", email: "aroha@manukavets.nz" });
    expect(parseSender("news@example.com")).toEqual({ name: null, email: "news@example.com" });
    const mailAccountId = await as(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `insert into crm_connected_accounts (user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at)
         values ($1, 'google', $2, $3, $3, now() + interval '1 hour') returning id::text`,
        [owner.id, owner.email, encryptSecret("refresh-token")],
      );
      return inserted.rows[0].id;
    });
    const mailbox = await as((tx) => createLeadMailbox(tx, { mailKind: "crm", mailAccountId, mailFolderId: "Label_5", mailFolderName: "Leads" }));
    mocks.messages = [
      { id: "e1", receivedAt: "2026-10-09T21:00:00Z", from: "Aroha Ngata <aroha@manukavets.nz>", subject: "Paw prints for the clinic", preview: "Could you do 20 keyrings?", attachments: [] },
      { id: "e2", receivedAt: "2026-10-09T22:00:00Z", from: "Hemi Walker <hemi@tui.nz>", subject: "Following up", preview: "Any news on the price?", attachments: [] },
    ];
    const organisation = (await getOrganisation(ORG))!;
    const check = await checkLeadMailbox(organisation, { userId: owner.id, email: owner.email }, mailbox.id);
    expect(check).toMatchObject({ status: "ok", leadsAdded: 1, notesAdded: 1, error: null });
    const leads = await as((tx) => listLeads(tx, { search: "aroha" }));
    expect(leads[0]).toMatchObject({
      firstName: "Aroha",
      lastName: "Ngata",
      email: "aroha@manukavets.nz",
      source: "email",
      sourceDetail: "Leads",
      needsReview: true,
      description: "Paw prints for the clinic\n\nCould you do 20 keyrings?",
    });
    // Hemi was already an open lead from the form: the email is a note on it.
    const hemi = (await as((tx) => listLeads(tx, { search: "hemi@tui.nz" })))[0];
    const notes = await as((tx) => listActivities(tx, { leadId: hemi.id }));
    expect(notes.map((note) => [note.subject, note.body])).toEqual([["Email: Following up", "Any news on the price?"]]);
    // Checked again: nothing new.
    const again = await checkLeadMailbox(organisation, { userId: owner.id, email: owner.email }, mailbox.id);
    expect(again).toMatchObject({ leadsAdded: 0, notesAdded: 0 });
    // A rep doesn't see unassigned leads; through the route they're still the admins' to set up.
    const repLeads = await inOrganisation(ORG, { userId: rep.id, email: rep.email }, async (tx) => listLeads(tx, { scope: await crmScope(tx, "sales_rep", rep.id) }));
    expect(repLeads).toEqual([]);
  });
});

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as emailsRoute from "@/app/api/crm/emails/route";
import * as templatesRoute from "@/app/api/crm/email-templates/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { crmScope } from "@/lib/crm/access";
import { createLead } from "@/lib/crm/leads";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { claimConnectState, fetchConnection, listAccounts, saveConnection, saveMailSettings, startConnect } from "@/lib/crm/mail/service";
import { createEmailTemplate, draftSalesEmail, fillMergeFields, setEmailOptOut } from "@/lib/crm/sales-email";
import { createOpportunity, createPerson, listActivities } from "@/lib/crm/service";
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

const ORG = "crm-sales-email";
const ORIGIN = "https://tohyee.example.nz";
const noContext = undefined as unknown;

type Sent = { url: string; body: string; headers: Record<string, string> };

/** A pretend Google and Microsoft that record what was sent. */
const fake = {
  mailbox: "",
  grantedScope: "" as string | null,
  sendStatus: 200,
  throwOnSend: null as Error | null,
  sent: [] as Sent[],
  tokenBodies: [] as string[],
};

function provider(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const reply = (body: unknown, status = 200) => Promise.resolve(new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  if (url.pathname.endsWith("/token")) {
    fake.tokenBodies.push(String(init?.body ?? ""));
    return reply({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, ...(fake.grantedScope ? { scope: fake.grantedScope } : {}) });
  }
  if (url.host === "gmail.googleapis.com" && url.pathname.endsWith("/profile")) return reply({ emailAddress: fake.mailbox });
  if (url.host === "graph.microsoft.com" && url.pathname === "/v1.0/me") return reply({ mail: fake.mailbox });
  const isSend = (url.host === "gmail.googleapis.com" && url.pathname.endsWith("/messages/send")) || (url.host === "graph.microsoft.com" && url.pathname.endsWith("/sendMail"));
  if (isSend) {
    if (fake.throwOnSend) return Promise.reject(fake.throwOnSend);
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : String(init?.body ?? "");
    fake.sent.push({ url: input, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (fake.sendStatus >= 400) return reply({ error: { status: "UNAVAILABLE", message: "Backend error" } }, fake.sendStatus);
    return url.host === "graph.microsoft.com" ? reply(null, 202) : reply({ id: `g${fake.sent.length}` });
  }
  return reply({ error: `unexpected ${input}` }, 404);
}

/** Decision 496 (#216 stage 2): sales emails from the rep's own mailbox, never sent twice. */
describeWithDatabase("CRM sales emails (decision 496)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let otherRep: SessionUser;
  let googleAccountId = "";
  let microsoftAccountId = "";
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const repScope = (tx: OrgTx) => crmScope(tx, "sales_rep", rep.id);
  const send = async (user: SessionUser, body: Record<string, unknown>) => {
    const response = await emailsRoute.POST(
      apiRequest("/api/crm/emails", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, source: "ui", ...body } }),
      noContext,
    );
    return { status: response.status, json: (await response.json()) as { email?: { id: string; status: string; error: string | null }; error?: string } };
  };

  async function connect(user: SessionUser, which: "google" | "microsoft", mailbox: string, scope: string | null) {
    fake.mailbox = mailbox;
    fake.grantedScope = scope;
    const { url } = await as(user, (tx) => startConnect(tx, which, ORIGIN, { send: true }));
    const claimed = await as(user, (tx) => claimConnectState(tx, new URL(url).searchParams.get("state")!));
    const connection = await fetchConnection(claimed.provider, { clientId: "client", clientSecret: "secret", tenant: "common" }, "code", ORIGIN, claimed.withSend);
    return { url, account: await as(user, (tx) => saveConnection(tx, claimed.provider, connection)) };
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
    server = await startTestServer();
    owner = await createTestUser("jess@glimmers.nz", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("ruby@glimmers.nz", { displayName: "Ruby Rep" });
    otherRep = await createTestUser("otto@glimmers.nz", { displayName: "Otto Rep" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep'), ($1, $3, 'sales_rep')", [ORG, rep.id, otherRep.id]);
    await as(owner, (tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    await as(owner, (tx) =>
      saveMailSettings(tx, { googleClientId: "google-client", googleClientSecret: "google-secret", microsoftClientId: "ms-client", microsoftClientSecret: "ms-secret" }),
    );
    setMailFetchForTests(provider);
  });

  afterEach(() => {
    fake.sent = [];
    fake.tokenBodies = [];
    fake.sendStatus = 200;
    fake.throwOnSend = null;
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  it("allowing sending asks for gmail.send or Mail.Send as well as reading; a sign-in that leaves it unticked is refused", async () => {
    await expect(connect(rep, "google", "ruby@glimmers.nz", "openid email https://www.googleapis.com/auth/gmail.readonly")).rejects.toThrow(/didn't allow sending/);
    const google = await connect(rep, "google", "ruby@glimmers.nz", "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send");
    const scopes = new URL(google.url).searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual(expect.arrayContaining(["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"]));
    expect(new URL(google.url).searchParams.get("include_granted_scopes")).toBe("true");
    expect(google.account).toMatchObject({ email: "ruby@glimmers.nz", canSend: true });
    googleAccountId = google.account.id;

    const microsoft = await connect(owner, "microsoft", "jess@glimmers.nz", null);
    expect(new URL(microsoft.url).searchParams.get("scope")).toContain("Mail.Send");
    expect(microsoft.account.canSend).toBe(true);
    microsoftAccountId = microsoft.account.id;
    const accounts = await as(rep, (tx) => listAccounts(tx));
    expect(accounts.find((account) => account.id === googleAccountId)?.canSend).toBe(true);
  });

  it("templates: admins write them; merge fields are checked and filled in", async () => {
    const asRep = await templatesRoute.POST(
      apiRequest("/api/crm/email-templates", { method: "POST", cookie: await sessionCookieFor(rep), body: { organisationId: ORG, name: "X", subject: "X", body: "X" } }),
      noContext,
    );
    expect(asRep.status).toBe(403);
    await expect(as(owner, (tx) => createEmailTemplate(tx, { name: "Typo", subject: "Hi {{frist_name}}", body: "x" }))).rejects.toThrow(/isn't a merge field/);
    await as(owner, (tx) =>
      createEmailTemplate(tx, { name: "First contact", subject: "Paw prints for {{company}}", body: "Kia ora {{first_name}},\n\nThanks for your enquiry.\n\n{{my_name}}" }),
    );
    expect(fillMergeFields("Hi {{ first_name }} at {{company}}", { first_name: "Aroha" })).toBe("Hi Aroha at ");
  });

  it("a rep emails their own lead from their own mailbox: sent once, logged on the lead", async () => {
    const lead = (await as(rep, async (tx) => createLead(tx, { idempotencyKey: key("l"), firstName: "Aroha", companyName: "Mānuka Vets", email: "aroha@manukavets.nz" }, await repScope(tx)))).lead;
    const template = (await as(owner, (tx) => tx.query<{ id: string }>("select id::text from crm_email_templates where name = 'First contact'"))).rows[0];
    const draft = await as(rep, async (tx) => draftSalesEmail(tx, { leadId: lead.id, templateId: template.id }, await repScope(tx)));
    expect(draft).toMatchObject({
      to: "aroha@manukavets.nz",
      optOut: false,
      subject: "Paw prints for Mānuka Vets",
      body: "Kia ora Aroha,\n\nThanks for your enquiry.\n\nRuby Rep",
      accounts: [{ id: googleAccountId, email: "ruby@glimmers.nz" }],
    });

    const idempotencyKey = key("e");
    const body = { idempotencyKey, accountId: googleAccountId, leadId: lead.id, templateId: template.id, subject: draft.subject, body: draft.body };
    const first = await send(rep, body);
    expect(first.status).toBe(201);
    expect(first.json.email).toMatchObject({ status: "sent", error: null });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].url).toContain("gmail.googleapis.com/upload/gmail/v1/users/me/messages/send");
    expect(fake.sent[0].body).toContain("To: aroha@manukavets.nz");
    expect(fake.sent[0].body).toMatch(/From: "?Ruby Rep"? <ruby@glimmers.nz>/);
    // A retry with the same key: the same email, nothing sent again.
    const again = await send(rep, body);
    expect(again.json.email?.id).toBe(first.json.email?.id);
    expect(fake.sent).toHaveLength(1);
    // The same key for a different email is refused.
    expect((await send(rep, { ...body, subject: "Something else" })).status).toBe(409);

    const notes = await as(rep, async (tx) => listActivities(tx, { leadId: lead.id, scope: await repScope(tx) }));
    expect(notes).toEqual([expect.objectContaining({ kind: "note", subject: "Email: Paw prints for Mānuka Vets", body: expect.stringContaining("To aroha@manukavets.nz from ruby@glimmers.nz") })]);
    // A merge field left in is refused before anything is sent.
    expect((await send(rep, { ...body, idempotencyKey: key("e"), body: "Hi {{first_name}}" })).status).toBe(400);
    expect(fake.sent).toHaveLength(1);
  });

  it("never: to someone who opted out, without an address, to another rep's lead, or from someone else's mailbox", async () => {
    const lead = (await as(rep, async (tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Stop", email: "stop@example.nz" }, await repScope(tx)))).lead;
    await as(rep, async (tx) => setEmailOptOut(tx, { leadId: lead.id, optOut: true }, await repScope(tx)));
    const optedOut = await send(rep, { idempotencyKey: key("e"), accountId: googleAccountId, leadId: lead.id, subject: "Hi", body: "Hi" });
    expect([optedOut.status, optedOut.json.error]).toEqual([409, "Stop asked not to be emailed."]);

    const noEmail = (await as(rep, async (tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Phone only", phone: "021 1" }, await repScope(tx)))).lead;
    expect((await send(rep, { idempotencyKey: key("e"), accountId: googleAccountId, leadId: noEmail.id, subject: "Hi", body: "Hi" })).json.error).toBe(
      "Phone only has no email address.",
    );
    const ottos = (await as(otherRep, async (tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Otto's", email: "o@example.nz" }, await crmScope(tx, "sales_rep", otherRep.id)))).lead;
    expect((await send(rep, { idempotencyKey: key("e"), accountId: googleAccountId, leadId: ottos.id, subject: "Hi", body: "Hi" })).status).toBe(404);
    expect((await send(otherRep, { idempotencyKey: key("e"), accountId: googleAccountId, leadId: ottos.id, subject: "Hi", body: "Hi" })).json.error).toBe(
      "Choose your own connected mailbox.",
    );
    expect(fake.sent).toHaveLength(0);
  });

  it("a failure can be tried again with the same key; one that may have gone is never sent twice", async () => {
    const lead = (await as(rep, async (tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Retry", email: "retry@example.nz" }, await repScope(tx)))).lead;
    const body = { idempotencyKey: key("e"), accountId: googleAccountId, leadId: lead.id, subject: "Hello", body: "Hello" };
    fake.sendStatus = 500;
    const failed = await send(rep, body);
    expect(failed.json.email).toMatchObject({ status: "failed", error: expect.stringContaining("Google didn't send it") });
    fake.sendStatus = 200;
    expect((await send(rep, body)).json.email?.status).toBe("sent");
    expect(fake.sent).toHaveLength(2);

    fake.sent = [];
    const unclear = { ...body, idempotencyKey: key("e") };
    fake.throwOnSend = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const maybe = await send(rep, unclear);
    expect(maybe.json.email).toMatchObject({ status: "maybe_sent", error: expect.stringContaining("Check the Sent folder") });
    fake.throwOnSend = null;
    expect((await send(rep, unclear)).json.email?.status).toBe("maybe_sent");
    expect(fake.sent).toHaveLength(0);
  });

  it("a deal's point of contact, from a Microsoft 365 mailbox", async () => {
    const vets = (await as(owner, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact;
    const mere = await as(owner, (tx) => createPerson(tx, { contactId: vets.id, firstName: "Mere", email: "mere@harbourvets.nz" }));
    const deal = await as(owner, (tx) =>
      createOpportunity(tx, { name: "Collars", contactId: vets.id, pointOfContactId: mere.id, ownerUserId: owner.id, amount: "100.00", closeDate: "2026-12-31" }),
    );
    const result = await send(owner, { idempotencyKey: key("e"), accountId: microsoftAccountId, opportunityId: deal.id, subject: "Collars", body: "Kia ora Mere" });
    expect(result.json.email?.status).toBe("sent");
    expect(fake.sent[0].url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(JSON.parse(fake.sent[0].body).message).toMatchObject({ subject: "Collars", toRecipients: [{ emailAddress: { address: "mere@harbourvets.nz" } }] });
    expect(fake.tokenBodies.at(-1)).toContain("Mail.Send");
    const notes = await as(owner, (tx) => listActivities(tx, { opportunityId: deal.id }));
    expect(notes.map((note) => note.subject)).toEqual(["Email: Collars"]);
    // Marked "Don't email": refused.
    await as(owner, (tx) => setEmailOptOut(tx, { personId: mere.id, optOut: true }));
    expect((await send(owner, { idempotencyKey: key("e"), accountId: microsoftAccountId, opportunityId: deal.id, subject: "Again", body: "Again" })).status).toBe(409);
  });
});

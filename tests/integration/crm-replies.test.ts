import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as leadRoute from "@/app/api/crm/leads/[leadId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { convertLead, createLead } from "@/lib/crm/leads";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { claimState, fetchConnection, saveConnection, saveMailSettings, setVisibility, startConnect, syncAccount, syncedFor } from "@/lib/crm/mail/service";
import { noticeReplies, replyTaskText } from "@/lib/crm/replies";
import { advanceSequences, createSequence, enrol, listEnrolments } from "@/lib/crm/sequences";
import { createPerson, listTasks } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation } from "@/lib/organisations/registry";
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

const ORIGIN = "https://tohyee.example.nz";
type Mail = { id: string; from: string; to: string; subject: string; snippet: string; at: string };

/** A pretend Gmail: token, profile and messages (no meetings). */
function fakeGmail(state: { mail: Mail[]; mailbox: string }) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/token")) return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    if (url.host === "gmail.googleapis.com" && url.pathname.endsWith("/profile")) return json({ emailAddress: state.mailbox });
    if (url.host === "gmail.googleapis.com" && url.pathname.endsWith("/messages")) return json({ messages: state.mail.map((m) => ({ id: m.id })) });
    if (url.host === "gmail.googleapis.com") {
      const mail = state.mail.find((m) => url.pathname.endsWith(`/${m.id}`))!;
      return json({
        id: mail.id,
        threadId: `t-${mail.id}`,
        internalDate: String(Date.parse(mail.at)),
        snippet: mail.snippet,
        payload: { headers: [{ name: "From", value: mail.from }, { name: "To", value: mail.to }, { name: "Subject", value: mail.subject }] },
      });
    }
    if (url.host === "www.googleapis.com") return json({ items: [] });
    return json({ error: `unexpected ${input}` }, 404);
  };
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Decision 651 (#216, #360 item 17): leads' emails are kept, and a reply becomes a follow-up task once. */
describeWithDatabase("CRM replies from leads and people (decision 651)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@glimmers.nz", { serverAdmin: true, displayName: "Jess" });
    rep = await createTestUser("ruby@glimmers.nz", { displayName: "Ruby Rep" });
    process.env.TOHYEE_SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
  });

  afterEach(() => setMailFetchForTests(null));

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  /** An organisation with the CRM on, Jess's Gmail connected and Ruby as a sales rep. */
  async function world() {
    organisations += 1;
    const org = `replies-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep')", [org, rep.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>, who: SessionUser = owner) => inOrganisation(org, { userId: who.id, email: who.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    await as((tx) => saveMailSettings(tx, { googleClientId: "google-client", googleClientSecret: "google-secret" }));
    const state = { mail: [] as Mail[], mailbox: "jess@glimmers.nz" };
    setMailFetchForTests(fakeGmail(state));
    const { url } = await as((tx) => startConnect(tx, "google", ORIGIN));
    const claimed = await as((tx) => claimState(tx, new URL(url).searchParams.get("state")!));
    const connection = await fetchConnection(claimed, { clientId: "google-client", clientSecret: "secret" }, "code-1", ORIGIN);
    const account = await as((tx) => saveConnection(tx, claimed, connection));
    const record = (await getOrganisation(org))!;
    const lead = (await as((tx) => createLead(tx, { idempotencyKey: key("l"), firstName: "Aroha", lastName: "Ngata", email: "Aroha@Example.nz", ownerUserId: rep.id }))).lead;
    const sent = (subject: string, minutesAgo: number, target: { leadId?: string; personId?: string }) =>
      as((tx) =>
        tx.query(
          `insert into crm_sent_emails (command_source, idempotency_key, request_hash, account_id, sent_by_user_id, to_email, subject, body, lead_id, person_id, status, sent_at)
           values ('ui', $1, 'h', $2, $3, 'x@example.nz', $4, 'Hi', $5, $6, 'sent', $7)`,
          [key("e"), account.id, rep.id, subject, target.leadId ?? null, target.personId ?? null, ago(minutesAgo)],
        ),
      );
    const sync = () => syncAccount(record, account.id, new Date());
    const tasks = (target: { leadId?: string; personId?: string }) => as((tx) => listTasks(tx, target));
    return { org, as, state, account, record, lead, sent, sync, tasks };
  }

  it("MAIL10: emails with a lead are kept and shown on the lead; converting links them to the new person", async () => {
    const w = await world();
    w.state.mail = [
      { id: "m1", from: "Aroha Ngata <aroha@example.nz>", to: "jess@glimmers.nz", subject: "Paw prints?", snippet: "Do you do cats?", at: ago(60) },
      { id: "m2", from: "news@shop.example", to: "jess@glimmers.nz", subject: "Sale!", snippet: "50% off", at: ago(50) },
    ];
    expect((await w.sync()).messages).toBe(1);
    const page = await leadRoute.GET(
      apiRequest(`/api/crm/leads/${w.lead.id}?organisationId=${w.org}`, { cookie: await sessionCookieFor(rep) }),
      params({ leadId: w.lead.id }),
    );
    const body = (await page.json()) as { emails: Array<{ subject: string; direction: string }> };
    expect(body.emails.map((email) => [email.subject, email.direction])).toEqual([["Paw prints?", "received"]]);
    // Not a reply to anything Tohyee sent, so no task.
    expect(await w.tasks({ leadId: w.lead.id })).toEqual([]);

    const converted = await w.as((tx) => convertLead(tx, w.lead.id, { opportunity: false }));
    const personId = converted.lead.convertedPersonId!;
    expect((await w.as((tx) => syncedFor(tx, { personId }))).emails.map((email) => email.subject)).toEqual(["Paw prints?"]);
    // A converted lead isn't matched again: the next email goes to the person.
    w.state.mail.push({ id: "m3", from: "aroha@example.nz", to: "jess@glimmers.nz", subject: "Also dogs", snippet: "And dogs", at: ago(40) });
    await w.sync();
    const links = await w.as((tx) => tx.query<{ lead_id: string | null }>("select l.lead_id::text from crm_participant_links l join crm_messages m on m.id = l.message_id where m.external_id = 'm3'"));
    expect(links.rows).toEqual([{ lead_id: null }]);
  });

  it("RPL1-RPL2: a lead's reply to a sales email makes one task for its owner; more replies in the thread don't", async () => {
    const w = await world();
    await w.sent("Your quote", 120, { leadId: w.lead.id });
    w.state.mail = [{ id: "r1", from: "aroha@example.nz", to: "jess@glimmers.nz", subject: "Re: Your quote", snippet: "Looks good", at: ago(30) }];
    await w.sync();
    const tasks = await w.tasks({ leadId: w.lead.id });
    expect(tasks.map((task) => [task.title, task.assigneeUserId, task.status])).toEqual([["Reply from Aroha Ngata: Re: Your quote", rep.id, "todo"]]);
    expect(tasks[0].body).toContain('to the email "Your quote"');
    // The check running again (or at once with the sync) makes nothing more; nor does a second reply in the thread.
    expect((await w.as((tx) => noticeReplies(tx))).tasksCreated).toBe(0);
    w.state.mail.push({ id: "r2", from: "aroha@example.nz", to: "jess@glimmers.nz", subject: "Re: Your quote", snippet: "Also…", at: ago(20) });
    await w.sync();
    expect((await w.tasks({ leadId: w.lead.id })).length).toBe(1);
    // A new email, then a new reply: a new task.
    await w.sent("Samples", 15, { leadId: w.lead.id });
    w.state.mail.push({ id: "r3", from: "aroha@example.nz", to: "jess@glimmers.nz", subject: "Re: Samples", snippet: "Thanks", at: ago(5) });
    await w.sync();
    expect((await w.tasks({ leadId: w.lead.id })).map((task) => task.title).sort()).toEqual([
      "Reply from Aroha Ngata: Re: Samples",
      "Reply from Aroha Ngata: Re: Your quote",
    ]);
  });

  it("RPL3: a reply while in a sequence stops it and makes a task; the subject stays private when the mailbox says so", async () => {
    const w = await world();
    const company = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact;
    const tama = await w.as((tx) => createPerson(tx, { contactId: company.id, firstName: "Tama", email: "tama@harbourvets.nz" }));
    const sequence = await w.as((tx) => createSequence(tx, { name: "Clinic intro", steps: [{ dayOffset: 7, kind: "call", title: "Call" }] }));
    await w.as((tx) => enrol(tx, { sequenceId: sequence.id, personId: tama.id }), rep);
    await w.as((tx) => tx.query("update crm_sequence_enrolments set enrolled_at = now() - interval '2 hours'"));
    await w.as((tx) => setVisibility(tx, w.account.id, "metadata"));
    w.state.mail = [{ id: "r1", from: "Tama <tama@harbourvets.nz>", to: "jess@glimmers.nz", subject: "Re: hello", snippet: "Keen", at: ago(10) }];
    await w.sync();
    const tasks = await w.tasks({ personId: tama.id });
    // The task is Ruby's (she added them), and Jess's mailbox only shows that something happened.
    expect(tasks.map((task) => [task.title, task.assigneeUserId])).toEqual([["Reply from Tama", rep.id]]);
    expect(tasks[0].body).toContain('while in the sequence "Clinic intro"');
    await w.as((tx) => advanceSequences(tx));
    const [enrolment] = await w.as((tx) => listEnrolments(tx, { personId: tama.id }));
    expect([enrolment.status, enrolment.stopReason]).toEqual(["stopped", "They replied."]);
  });

  it("RPL4: an email into a lead mailbox from a lead who was emailed counts as a reply", async () => {
    const w = await world();
    await w.sent("Hello", 60, { leadId: w.lead.id });
    await w.as((tx) =>
      tx.query("insert into crm_activities (kind, happened_at, subject, lead_id, created_by_email) values ('note', now(), 'Email: Re: Hello', $1, 'lead-mailbox@tohyee')", [w.lead.id]),
    );
    expect((await w.as((tx) => noticeReplies(tx))).tasksCreated).toBe(1);
    expect((await w.tasks({ leadId: w.lead.id })).map((task) => task.title)).toEqual(["Reply from Aroha Ngata: Re: Hello"]);
  });

  it("RPL5: replies to an email over 30 days old, received over 7 days ago, or synced before this version are left alone", async () => {
    const old = await world();
    await old.sent("Old news", 60 * 24 * 40, { leadId: old.lead.id });
    old.state.mail = [{ id: "r1", from: "aroha@example.nz", to: "jess@glimmers.nz", subject: "Re: Old news", snippet: "Late", at: ago(10) }];
    await old.sync();
    expect(await old.tasks({ leadId: old.lead.id })).toEqual([]);

    const late = await world();
    await late.sent("Fresh", 60 * 24 * 9, { leadId: late.lead.id });
    late.state.mail = [{ id: "r2", from: "aroha@example.nz", to: "jess@glimmers.nz", subject: "Re: Fresh", snippet: "Old reply", at: ago(60 * 24 * 8) }];
    await late.sync();
    expect(await late.tasks({ leadId: late.lead.id })).toEqual([]);

    const before = await world();
    await before.sent("Before", 30, { leadId: before.lead.id });
    await before.as((tx) => tx.query("update crm_reply_handling set started_at = now() + interval '1 hour'"));
    before.state.mail = [{ id: "r3", from: "aroha@example.nz", to: "jess@glimmers.nz", subject: "Re: Before", snippet: "Hi", at: ago(5) }];
    await before.sync();
    expect(await before.tasks({ leadId: before.lead.id })).toEqual([]);
  });

  it("the task's words", () => {
    expect(replyTaskText({ sender: "Aroha", subject: null, repliedOn: "2026-10-20", touch: { kind: "email", label: "Quote" } })).toEqual({
      title: "Reply from Aroha",
      body: 'They replied on 2026-10-20 to the email "Quote". Read it in your mailbox and reply from there, or log a call.',
    });
    expect(replyTaskText({ sender: "A", subject: "x".repeat(300), repliedOn: "2026-10-20", touch: { kind: "sequence", label: "S" } }).title).toHaveLength(200);
  });
});

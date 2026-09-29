import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as settingsRoute from "@/app/api/crm/mail/settings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import {
  claimState,
  disconnect,
  fetchConnection,
  getMailSettings,
  listAccounts,
  saveConnection,
  saveMailSettings,
  setVisibility,
  startConnect,
  syncAccount,
  syncedFor,
} from "@/lib/crm/mail/service";
import { companyTimeline, createPerson } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getOrganisation } from "@/lib/organisations/registry";
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

const noContext = undefined as unknown;
const ORIGIN = "https://tohyee.example.nz";

type Mail = { id: string; from: string; to: string; subject: string; snippet: string; at: string };
type Meeting = { id: string; title: string; start: string; end: string; attendees: string[] };

/** A pretend Google and Microsoft: token, profile, messages and calendar endpoints. */
function fakeProviders(state: { mail: Mail[]; meetings: Meeting[]; fail?: boolean; mailbox: string }) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return async (input: string) => {
    const url = new URL(input);
    if (state.fail) return json({ error: "server_error", error_description: "Try later" }, 500);
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
    if (url.host === "www.googleapis.com") {
      return json({
        items: state.meetings.map((m) => ({
          id: m.id,
          summary: m.title,
          start: { dateTime: m.start },
          end: { dateTime: m.end },
          attendees: m.attendees.map((email) => ({ email })),
        })),
      });
    }
    if (url.host === "graph.microsoft.com" && url.pathname === "/v1.0/me") return json({ mail: state.mailbox });
    if (url.host === "graph.microsoft.com" && url.pathname.endsWith("/messages")) {
      const address = (value: string) => ({ emailAddress: { address: value.replace(/.*<|>.*/g, ""), name: null } });
      return json({
        value: state.mail.map((m) => ({
          id: m.id,
          conversationId: `c-${m.id}`,
          subject: m.subject,
          bodyPreview: m.snippet,
          from: address(m.from),
          toRecipients: [address(m.to)],
          sentDateTime: m.at,
        })),
      });
    }
    if (url.host === "graph.microsoft.com" && url.pathname.endsWith("/calendarView")) {
      return json({
        value: state.meetings.map((m) => ({
          id: m.id,
          subject: m.title,
          start: { dateTime: m.start.replace("Z", "") },
          end: { dateTime: m.end.replace("Z", "") },
          attendees: m.attendees.map((address) => ({ emailAddress: { address } })),
        })),
      });
    }
    return json({ error: `unexpected ${input}` }, 404);
  };
}

/** Examples MAIL1-MAIL9 in docs/ACCOUNTING-EXAMPLES.md ("CRM email and calendar sync"). */
describeWithDatabase("CRM email and calendar sync", () => {
  let server: TestServer;
  let owner: SessionUser;
  let colleague: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@glimmers.nz", { serverAdmin: true, displayName: "Jess" });
    colleague = await createTestUser("ben@glimmers.nz", { displayName: "Ben" });
    viewer = await createTestUser("viewer@glimmers.nz");
    process.env.TOHYEE_SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
  });

  afterEach(() => setMailFetchForTests(null));

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `mail-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [
      org,
      colleague.id,
      viewer.id,
    ]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>, who: SessionUser = owner) => inOrganisation(org, { userId: who.id, email: who.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const vets = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Mānuka Vets", email: "hello@manukavets.nz", isProspect: true }))).contact;
    const aroha = await as((tx) => createPerson(tx, { contactId: vets.id, firstName: "Aroha", lastName: "Ngata", email: "Aroha@ManukaVets.nz" }));
    const record = (await getOrganisation(org))!;
    return { org, as, vets, aroha, record };
  }

  async function connected(provider: "google" | "microsoft" = "google") {
    const w = await setup();
    await w.as((tx) =>
      saveMailSettings(tx, {
        googleClientId: "google-client",
        googleClientSecret: "google-secret",
        microsoftClientId: "ms-client",
        microsoftClientSecret: "ms-secret",
      }),
    );
    const state = { mail: [] as Mail[], meetings: [] as Meeting[], mailbox: "jess@glimmers.nz", fail: false };
    setMailFetchForTests(fakeProviders(state));
    const { url } = await w.as((tx) => startConnect(tx, provider, ORIGIN));
    const stateParam = new URL(url).searchParams.get("state")!;
    const claimed = await w.as((tx) => claimState(tx, stateParam));
    const app = { clientId: provider === "google" ? "google-client" : "ms-client", clientSecret: "secret", tenant: "common" };
    const connection = await fetchConnection(claimed, app, "code-1", ORIGIN);
    const account = await w.as((tx) => saveConnection(tx, claimed, connection));
    return { ...w, state, account };
  }

  const now = new Date("2026-09-29T00:00:00Z");
  const threeEmails: Mail[] = [
    { id: "m1", from: "Aroha Ngata <aroha@manukavets.nz>", to: "jess@glimmers.nz", subject: "Paw print order", snippet: "Hi Jess, we'd like 40 keyrings", at: "2026-09-20T01:00:00Z" },
    { id: "m2", from: "jess@glimmers.nz", to: "hello@manukavets.nz", subject: "Quote", snippet: "Here's the quote", at: "2026-09-21T01:00:00Z" },
    { id: "m3", from: "newsletter@shop.example", to: "jess@glimmers.nz", subject: "Sale!", snippet: "50% off", at: "2026-09-22T01:00:00Z" },
  ];

  it("MAIL1: the organisation's app settings", async () => {
    const w = await setup();
    delete process.env.TOHYEE_SECRET_KEY;
    await expect(w.as((tx) => saveMailSettings(tx, { googleClientId: "id", googleClientSecret: "secret" }))).rejects.toThrow("TOHYEE_SECRET_KEY");
    process.env.TOHYEE_SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
    const settings = await w.as((tx) => saveMailSettings(tx, { googleClientId: "google-client", googleClientSecret: "google-secret" }));
    expect(settings.google).toEqual({ clientId: "google-client", secretSaved: true });
    expect(settings.redirectPath).toBe("/api/crm/mail/callback");
    expect(JSON.stringify(settings)).not.toContain("google-secret");
    const stored = await w.as((tx) => tx.query<{ s: string }>("select google_client_secret_ciphertext as s from crm_mail_settings"));
    expect(stored.rows[0].s.startsWith("v1:")).toBe(true);
    // A blank secret keeps the saved one.
    expect((await w.as((tx) => saveMailSettings(tx, { googleClientId: "google-client-2", googleClientSecret: "" }))).google.secretSaved).toBe(true);
    const viewerRead = await settingsRoute.GET(apiRequest(`/api/crm/mail/settings?organisationId=${w.org}`, { cookie: await sessionCookieFor(viewer) }), noContext);
    expect(viewerRead.status).toBe(403);
    expect((await w.as((tx) => getMailSettings(tx))).google.clientId).toBe("google-client-2");
  });

  it("MAIL2: connecting checks the one-time state", async () => {
    const w = await setup();
    await w.as((tx) => saveMailSettings(tx, { googleClientId: "google-client", googleClientSecret: "google-secret" }));
    const { url } = await w.as((tx) => startConnect(tx, "google", ORIGIN));
    const params = new URL(url).searchParams;
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(params.get("client_id")).toBe("google-client");
    expect(params.get("redirect_uri")).toBe(`${ORIGIN}/api/crm/mail/callback`);
    expect(params.get("scope")).toContain("gmail.readonly");
    expect(params.get("scope")).toContain("calendar.readonly");
    expect(params.get("access_type")).toBe("offline");
    const state = params.get("state")!;
    expect(state.startsWith(`${w.org}.`)).toBe(true);
    await expect(w.as((tx) => claimState(tx, state), colleague)).rejects.toThrow("expired or was already used");
    expect(await w.as((tx) => claimState(tx, state))).toBe("google");
    await expect(w.as((tx) => claimState(tx, state))).rejects.toThrow("expired or was already used");
    const second = new URL((await w.as((tx) => startConnect(tx, "google", ORIGIN))).url).searchParams.get("state")!;
    await w.as((tx) => tx.query("update crm_oauth_states set created_at = now() - interval '16 minutes' where state = $1", [second]));
    await expect(w.as((tx) => claimState(tx, second))).rejects.toThrow("expired or was already used");
    const state3 = { mail: [], meetings: [], mailbox: "Jess@Glimmers.nz" };
    setMailFetchForTests(fakeProviders(state3));
    const connection = await fetchConnection("google", { clientId: "google-client", clientSecret: "google-secret" }, "code", ORIGIN);
    const account = await w.as((tx) => saveConnection(tx, "google", connection));
    expect([account.email, account.provider, account.isMine, account.status]).toEqual(["jess@glimmers.nz", "google", true, "active"]);
    const tokens = await w.as((tx) => tx.query<{ r: string }>("select refresh_token_ciphertext as r from crm_connected_accounts"));
    expect(tokens.rows[0].r.startsWith("v1:")).toBe(true);
  });

  it("MAIL3 and MAIL4: only emails with known people are kept, once", async () => {
    const w = await connected();
    w.state.mail = [...threeEmails];
    const first = await syncAccount(w.record, w.account.id, now);
    expect(first.messages).toBe(2);
    const kept = await w.as((tx) =>
      tx.query<{ external_id: string; direction: string }>("select external_id, direction from crm_messages order by external_id"),
    );
    expect(kept.rows.map((r) => [r.external_id, r.direction])).toEqual([
      ["m1", "received"],
      ["m2", "sent"],
    ]);
    const links = await w.as((tx) =>
      tx.query<{ external_id: string; person_id: string | null; contact_id: string | null }>(
        "select m.external_id, l.person_id, l.contact_id from crm_participant_links l join crm_messages m on m.id = l.message_id order by m.external_id",
      ),
    );
    expect(links.rows).toEqual([
      { external_id: "m1", person_id: w.aroha.id, contact_id: w.vets.id },
      { external_id: "m2", person_id: null, contact_id: w.vets.id },
    ]);
    const newsletter = await w.as((tx) => tx.query("select 1 from crm_messages where subject = 'Sale!'"));
    expect(newsletter.rowCount).toBe(0);
    expect((await syncAccount(w.record, w.account.id, now)).messages).toBe(0);
    w.state.mail.push({ id: "m4", from: "jess@glimmers.nz", to: "aroha@manukavets.nz", subject: "Samples sent", snippet: "On their way", at: "2026-09-23T01:00:00Z" });
    expect((await syncAccount(w.record, w.account.id, now)).messages).toBe(1);
  });

  it("MAIL5 and MAIL6: meetings, updates, and the company timeline", async () => {
    const w = await connected();
    w.state.mail = threeEmails.slice(0, 2);
    w.state.meetings = [
      { id: "e1", title: "Clinic visit", start: "2026-10-02T21:00:00Z", end: "2026-10-02T22:00:00Z", attendees: ["jess@glimmers.nz", "aroha@manukavets.nz"] },
      { id: "e2", title: "Focus time", start: "2026-10-03T21:00:00Z", end: "2026-10-03T22:00:00Z", attendees: ["jess@glimmers.nz"] },
    ];
    expect((await syncAccount(w.record, w.account.id, now)).meetings).toBe(1);
    w.state.meetings[0] = { ...w.state.meetings[0], start: "2026-10-02T22:00:00Z", end: "2026-10-02T23:00:00Z" };
    expect((await syncAccount(w.record, w.account.id, now)).meetings).toBe(0);
    const stored = await w.as((tx) => tx.query<{ starts_at: Date }>("select starts_at from crm_calendar_events"));
    expect(stored.rows.map((r) => new Date(r.starts_at).toISOString())).toEqual(["2026-10-02T22:00:00.000Z"]);
    const timeline = await w.as((tx) => companyTimeline(tx, w.vets.id));
    const synced = timeline.filter((e) => e.kind === "email" || e.kind === "meeting").map((e) => e.title);
    expect(synced).toEqual(["Meeting: Clinic visit", "Email sent: Quote", "Email received: Paw print order"]);
    expect(timeline.find((e) => e.title === "Email received: Paw print order")?.detail).toContain("we'd like 40 keyrings");
  });

  it("MAIL7: only that it happened, for everyone but the owner", async () => {
    const w = await connected();
    w.state.mail = threeEmails.slice(0, 1);
    await syncAccount(w.record, w.account.id, now);
    await expect(w.as((tx) => setVisibility(tx, w.account.id, "metadata"), colleague)).rejects.toThrow("Only the person who connected");
    await w.as((tx) => setVisibility(tx, w.account.id, "metadata"));
    const theirs = await w.as((tx) => syncedFor(tx, { contactId: w.vets.id }), colleague);
    expect([theirs.emails[0].subject, theirs.emails[0].preview, theirs.emails[0].private]).toEqual(["(private)", null, true]);
    const mine = await w.as((tx) => syncedFor(tx, { contactId: w.vets.id }));
    expect(mine.emails[0].subject).toBe("Paw print order");
  });

  it("MAIL8: Microsoft 365 works the same way", async () => {
    const w = await connected("microsoft");
    expect(w.account.provider).toBe("microsoft");
    w.state.mail = [...threeEmails];
    w.state.meetings = [{ id: "e1", title: "Clinic visit", start: "2026-10-02T21:00:00Z", end: "2026-10-02T22:00:00Z", attendees: ["aroha@manukavets.nz"] }];
    const result = await syncAccount(w.record, w.account.id, now);
    expect(result).toEqual({ messages: 2, meetings: 1 });
    const synced = await w.as((tx) => syncedFor(tx, { personId: w.aroha.id }));
    expect(synced.emails.map((e) => e.subject)).toEqual(["Paw print order"]);
    expect(synced.meetings.map((m) => [m.title, m.startsAt])).toEqual([["Clinic visit", "2026-10-02T21:00:00.000Z"]]);
  });

  it("MAIL9: disconnecting deletes what was synced; three failures pause", async () => {
    const w = await connected();
    w.state.mail = [...threeEmails];
    await syncAccount(w.record, w.account.id, now);
    w.state.fail = true;
    for (let i = 0; i < 3; i += 1) await expect(syncAccount(w.record, w.account.id, new Date(now.getTime() + 7200_000))).rejects.toThrow();
    const [paused] = await w.as((tx) => listAccounts(tx));
    expect([paused.status, paused.failures]).toEqual(["paused", 3]);
    expect(paused.lastError).toContain("500");
    await expect(w.as((tx) => disconnect(tx, w.account.id, false), colleague)).rejects.toThrow("Only the person who connected");
    await w.as((tx) => disconnect(tx, w.account.id, false));
    const left = await w.as((tx) => tx.query("select 1 from crm_messages union all select 1 from crm_participant_links"));
    expect(left.rowCount).toBe(0);
    expect((await w.as((tx) => companyTimeline(tx, w.vets.id))).some((e) => e.kind === "email")).toBe(false);
  });
});

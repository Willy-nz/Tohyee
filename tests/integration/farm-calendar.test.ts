import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import {
  checkCalendarItem,
  checkFarmMailbox,
  claimFarmMailState,
  disconnectFarmMailbox,
  dismissCalendarItem,
  farmCalendar,
  fetchFarmMailConnection,
  itemsToCheck,
  listFarmMailboxes,
  mailboxForCheck,
  replaceCalendarItem,
  saveFarmMailbox,
  setMailboxFarm,
  startFarmMailConnect,
} from "@/lib/farming/calendar";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { getOrganisation } from "@/lib/organisations/registry";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * The farm calendar from email (#319; FC1, FC7-FC9, FC11, FC13-FC15, not yet
 * reviewed). Gmail and Google's sign-in are canned responses; each test gets
 * its own organisation with two farms, Home farm and Runoff.
 */
type Mail = { id: string; threadId: string; at: string; from: string; subject: string; text: string };

describeWithDatabase("farm calendar from email", () => {
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let organisations = 0;
  let inbox: Mail[] = [];
  let fetched: string[] = [];
  const previousSecret = process.env.TOHYEE_SECRET_KEY;

  const encode = (text: string) => Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "farm-calendar-test-secret-key-0123456789abcdef";
    server = await startTestServer();
    jess = await createTestUser("fc-jess@example.com", { serverAdmin: true, displayName: "Jess" });
    mere = await createTestUser("fc-mere@example.com", { displayName: "Mere" });
    setMailFetchForTests(fake);
  });

  const fake = async (input: string): Promise<Response> => {
      const url = new URL(input);
      if (url.host === "oauth2.googleapis.com") return reply({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/gmail.readonly" });
      if (url.pathname.endsWith("/users/me/profile")) return reply({ emailAddress: "Jess@KowhaiDairies.example" });
      if (url.pathname.endsWith("/users/me/messages")) {
        const q = url.searchParams.get("q") ?? "";
        const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
        const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Number.MAX_SAFE_INTEGER / 1000) * 1000;
        const ids = inbox
          .filter((mail) => Date.parse(mail.at) >= after && Date.parse(mail.at) < before)
          .sort((a, b) => b.at.localeCompare(a.at))
          .map((mail) => ({ id: mail.id }));
        return reply({ messages: ids });
      }
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const mail = inbox.find((entry) => entry.id === id);
      if (!mail) return new Response("not found", { status: 404 });
      fetched.push(id);
      return reply({
        id: mail.id,
        threadId: mail.threadId,
        internalDate: String(Date.parse(mail.at)),
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            { name: "From", value: mail.from },
            { name: "Subject", value: mail.subject },
          ],
          parts: [
            { mimeType: "text/plain", body: { data: encode(mail.text) } },
            { mimeType: "text/html", body: { data: encode(`<p>${mail.text}</p>`) } },
          ],
        },
      });
  };

  afterAll(async () => {
    setMailFetchForTests(null);
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  async function setup() {
    organisations += 1;
    const org = `farm-calendar-${organisations}`;
    await createTestOrganisation(jess, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin')", [org, mere.id]);
    const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    await as(jess, (tx) => setFarmingEnabled(tx, { enabled: true }));
    const home = (await as(jess, (tx) => saveFarm(tx, { name: "Home farm" })))[0];
    const runoff = (await as(jess, (tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!;
    await as(jess, (tx) => saveMailSettings(tx, { googleClientId: "g-client.apps.googleusercontent.com", googleClientSecret: "g-secret" }));
    const organisation = (await getOrganisation(org))!;
    inbox = [];
    fetched = [];
    return { org, as, home, runoff, organisation };
  }

  /** Connects Jess's Gmail at `now` (the history before it is read on the first checks). */
  async function connect(w: Awaited<ReturnType<typeof setup>>, now: string, options: { historyDays?: number; defaultFarmId?: string } = {}) {
    const { url } = await w.as(jess, (tx) => startFarmMailConnect(tx, { provider: "google", ...options }, "https://tohyee.test"));
    const state = new URL(url).searchParams.get("state")!;
    const claimed = await w.as(jess, (tx) => claimFarmMailState(tx, state));
    const connection = await fetchFarmMailConnection(claimed, "code-1", "https://tohyee.test");
    return w.as(jess, (tx) => saveFarmMailbox(tx, claimed, connection, new Date(now)));
  }

  const vet = "Manuka Vets <office@manukavets.example>";

  it("FC1 connecting reads only, and the mailbox and its calendar are only Jess's", async () => {
    const w = await setup();
    const { url } = await w.as(jess, (tx) => startFarmMailConnect(tx, { provider: "google", historyDays: 30 }, "https://tohyee.test"));
    const query = new URL(url).searchParams;
    expect([query.get("scope"), query.get("redirect_uri"), query.get("include_granted_scopes")]).toEqual([
      "openid email https://www.googleapis.com/auth/gmail.readonly",
      "https://tohyee.test/api/farming/mail/callback",
      null,
    ]);
    await expect(w.as(jess, (tx) => startFarmMailConnect(tx, { provider: "google", historyDays: 400 }, "https://tohyee.test"))).rejects.toThrow("between 30 and 365 days");
    // A state is Jess's alone, and used once.
    const state = query.get("state")!;
    await expect(w.as(mere, (tx) => claimFarmMailState(tx, state))).rejects.toThrow("expired or was already used");
    const claimed = await w.as(jess, (tx) => claimFarmMailState(tx, state));
    await expect(w.as(jess, (tx) => claimFarmMailState(tx, state))).rejects.toThrow("expired or was already used");
    const mailbox = await w.as(jess, async (tx) => saveFarmMailbox(tx, claimed, await fetchFarmMailConnection(claimed, "code", "https://tohyee.test"), new Date("2026-10-19T09:00:00Z")));
    expect(mailbox).toMatchObject({ provider: "google", email: "jess@kowhaidairies.example", historyDays: 30, status: "active", readingHistory: true });
    inbox.push({ id: "m1", threadId: "t1", at: "2026-10-18T21:02:00Z", from: vet, subject: "TB testing", text: "Hi Jess, we've booked TB testing at the Home farm for Thursday 22 October at 9am." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T09:15:00Z"));
    expect((await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items).toHaveLength(1);
    // Mere (an admin) sees neither the mailbox nor its items, and can't check, change or disconnect it.
    expect(await w.as(mere, (tx) => listFarmMailboxes(tx))).toEqual([]);
    expect((await w.as(mere, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items).toEqual([]);
    expect(await w.as(mere, (tx) => itemsToCheck(tx))).toEqual([]);
    const item = (await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items[0];
    await expect(w.as(mere, (tx) => mailboxForCheck(tx, mailbox.id))).rejects.toThrow("Mailbox not found.");
    await expect(w.as(mere, (tx) => disconnectFarmMailbox(tx, mailbox.id))).rejects.toThrow("Mailbox not found.");
    await expect(w.as(mere, (tx) => checkCalendarItem(tx, item.id, { title: "x" }))).rejects.toThrow("Calendar item not found.");
    // Audited without the address; nothing of the email but the sentence, subject and sender is kept.
    const audit = await w.as(jess, (tx) => tx.query<{ details: unknown }>("select details from audit_events where event_type = 'farming.mailbox_connected'"));
    expect(JSON.stringify(audit.rows)).not.toContain("kowhaidairies");
    const columns = await w.as(jess, (tx) => tx.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'farm_mail_seen' order by ordinal_position"));
    expect(columns.rows.map((row) => row.column_name)).toEqual(["account_id", "external_id", "sent_at"]);
  });

  it("FC2, FC7-FC9 reading, a move, a cancellation, each email once, history before connecting", async () => {
    const w = await setup();
    // Sent the day before Jess connects: read from the history.
    inbox.push({ id: "m1", threadId: "t1", at: "2026-10-18T21:02:00Z", from: vet, subject: "TB testing", text: "Hi Jess, we've booked TB testing at the Home farm for Thursday 22 October at 9am." });
    inbox.push({ id: "m2", threadId: "t2", at: "2026-10-18T22:00:00Z", from: "Otago Cartage <bookings@otagocartage.example>", subject: "Truck", text: "Stock truck for the Runoff heifers on Wednesday 21 October, 7am." });
    inbox.push({ id: "n1", threadId: "t9", at: "2026-10-18T23:00:00Z", from: "Farm Shop <news@farmshop.example>", subject: "Sale", text: "Our sale ends 31 October." });
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    const first = await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T09:15:00Z"));
    expect(first).toEqual({ read: 3, items: 2 });
    let week = await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }));
    expect(week.items.map((item) => [item.date, item.startTime, item.kind, item.title, item.farmName, item.state, item.needsChecking])).toEqual([
      ["2026-10-21", "07:00", "stock_movement", "Stock truck", "Runoff", "open", false],
      ["2026-10-22", "09:00", "animal_health", "TB testing", "Home farm", "open", false],
    ]);
    expect(week.items[1]).toMatchObject({ senderEmail: "office@manukavets.example", senderName: "Manuka Vets", subject: "TB testing", webLink: "https://mail.google.com/mail/?authuser=jess%40kowhaidairies.example#all/m1" });
    expect((await w.as(jess, (tx) => listFarmMailboxes(tx)))[0].readingHistory).toBe(false);

    // FC7: a reply in the same conversation moves it; FC8: the truck is cancelled; FC9: the vet's reminder adds nothing.
    inbox.push({
      id: "m3",
      threadId: "t1",
      at: "2026-10-19T20:00:00Z",
      from: vet,
      subject: "Re: TB testing",
      text: "Sorry, we've had to move the TB testing to Friday 23 October at 9am.\n\nOn Mon, 19 Oct 2026 at 10:02, Manuka Vets wrote:\n> Hi Jess, we've booked TB testing at the Home farm for Thursday 22 October at 9am.",
    });
    inbox.push({ id: "m4", threadId: "t2", at: "2026-10-19T20:30:00Z", from: "Otago Cartage <bookings@otagocartage.example>", subject: "Re: Truck", text: "Sorry, the stock truck is cancelled." });
    inbox.push({ id: "m5", threadId: "t5", at: "2026-10-19T21:00:00Z", from: vet, subject: "Reminder", text: "Reminder: TB testing on Friday 23 October." });
    fetched = [];
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T21:30:00Z"));
    expect(fetched.sort()).toEqual(["m3", "m4", "m5"]);
    week = await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }));
    expect(week.items.map((item) => [item.date, item.title, item.state, item.stateNote, item.alsoSeen])).toEqual([
      ["2026-10-21", "Stock truck", "cancelled", "Cancelled by an email on Tue, 20 Oct", 0],
      ["2026-10-22", "TB testing", "moved", "Moved to Fri, 23 Oct", 0],
      ["2026-10-23", "TB testing", "open", null, 1],
    ]);
    // Checking again reads nothing new.
    fetched = [];
    expect(await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T22:00:00Z"))).toEqual({ read: 0, items: 0 });
    expect(fetched).toEqual([]);
    // FC13: filters.
    expect((await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25", farmId: w.runoff.id }))).items.map((item) => item.title)).toEqual(["Stock truck"]);
    const fromVet = await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25", sender: "office@manukavets.example" }));
    expect(fromVet.items).toHaveLength(2);
    expect(fromVet.senders.map((sender) => sender.email)).toEqual(["bookings@otagocartage.example", "office@manukavets.example"]);
  });

  it("FC4, FC10, FC11, FC13, FC14 needs checking, the mailbox's farm, correcting, replacing and hiding", async () => {
    const w = await setup();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z", { defaultFarmId: undefined });
    inbox.push({ id: "a1", threadId: "a1", at: "2026-10-19T10:00:00Z", from: "Spread Co <jobs@spreadco.example>", subject: "Spreading", text: "The spreader will come early next week." });
    inbox.push({ id: "a2", threadId: "a2", at: "2026-10-19T10:05:00Z", from: "Spray Co <jobs@sprayco.example>", subject: "Spraying", text: "Spraying the Runoff and the Home farm on Wednesday 21 October." });
    inbox.push({ id: "a3", threadId: "a3", at: "2026-10-19T10:10:00Z", from: "Fert Co <orders@fertco.example>", subject: "Order", text: "The fert truck should be there Tuesday, weather permitting." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T10:30:00Z"));
    let toCheck = await w.as(jess, (tx) => itemsToCheck(tx));
    expect(toCheck.map((item) => [item.title, item.date, item.checkReasons, item.farmName])).toEqual([
      ["Spreader", null, ["No exact date: 'early next week'"], null],
      ["Spraying", "2026-10-21", ["Mentions more than one farm: Home farm, Runoff"], null],
    ]);
    // FC11: no farm named and two farms: "No farm" (the tentative fert truck).
    const fert = (await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25", farmId: "none" }))).items;
    expect(fert.map((item) => [item.title, item.tentative, item.needsChecking])).toEqual([
      ["Fert truck", true, false],
      ["Spraying", false, true],
    ]);
    // With the mailbox's farm chosen, the next items naming none go there.
    await w.as(jess, (tx) => setMailboxFarm(tx, mailbox.id, w.home.id));
    inbox.push({ id: "a4", threadId: "a4", at: "2026-10-19T11:00:00Z", from: "Shearing Gang <crew@shearing.example>", subject: "Shearing", text: "Shearers arriving 7.30am on 3/11." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T11:30:00Z"));
    const november = await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-11-01", to: "2026-11-30" }));
    expect(november.items.map((item) => [item.date, item.startTime, item.farmName])).toEqual([["2026-11-03", "07:30", "Home farm"]]);

    // FC14: Jess gives the spreader a date and farm; it's checked and out of Needs checking.
    const spreader = toCheck[0];
    await expect(w.as(jess, (tx) => checkCalendarItem(tx, spreader.id, {}))).rejects.toThrow("Give it a date");
    await expect(w.as(jess, (tx) => checkCalendarItem(tx, spreader.id, { date: "2026-10-27", startTime: "10:00", endTime: "09:00" }))).rejects.toThrow("after the start");
    const fixed = await w.as(jess, (tx) => checkCalendarItem(tx, spreader.id, { date: "2026-10-27", startTime: "08:00", farmId: w.runoff.id, title: "Spreading lime" }));
    expect([fixed.date, fixed.startTime, fixed.farmName, fixed.title, fixed.checked, fixed.needsChecking]).toEqual(["2026-10-27", "08:00", "Runoff", "Spreading lime", true, false]);
    // A later email moving it doesn't change what Jess checked.
    inbox.push({ id: "a5", threadId: "a1", at: "2026-10-20T10:00:00Z", from: "Spread Co <jobs@spreadco.example>", subject: "Re: Spreading", text: "We've had to move the spreading to Thursday 29 October." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-20T10:30:00Z"));
    toCheck = await w.as(jess, (tx) => itemsToCheck(tx));
    expect(toCheck.map((item) => [item.title, item.date, item.checkReasons])).toEqual([
      ["Spraying", "2026-10-21", ["Mentions more than one farm: Home farm, Runoff"]],
      ["Spreading", "2026-10-29", ['Would move "Spreading lime" on Tue, 27 Oct, which you\'ve checked']],
    ]);
    // Jess says the new one replaces it; and hides the spraying.
    await w.as(jess, (tx) => replaceCalendarItem(tx, toCheck[1].id, spreader.id));
    await w.as(jess, (tx) => dismissCalendarItem(tx, toCheck[0].id));
    expect(await w.as(jess, (tx) => itemsToCheck(tx))).toEqual([]);
    const october = await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-31" }));
    expect(october.items.map((item) => [item.date, item.title, item.state])).toEqual([
      ["2026-10-20", "Fert truck", "open"],
      ["2026-10-27", "Spreading lime", "moved"],
      ["2026-10-29", "Spreading", "open"],
    ]);
  });

  it("FC15 disconnecting deletes what was read; a member who leaves is disconnected too", async () => {
    const w = await setup();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    inbox.push({ id: "m1", threadId: "t1", at: "2026-10-19T10:00:00Z", from: vet, subject: "TB testing", text: "TB testing at the Home farm on Thursday 22 October." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T10:30:00Z"));
    expect(await w.as(jess, (tx) => disconnectFarmMailbox(tx, mailbox.id))).toEqual([]);
    const left = await w.as(jess, (tx) => tx.query<{ n: number }>("select (select count(*) from farm_calendar_items)::int + (select count(*) from farm_mail_seen)::int as n"));
    expect(left.rows[0].n).toBe(0);
    // Mere connects her own, then leaves.
    const { url } = await w.as(mere, (tx) => startFarmMailConnect(tx, { provider: "google" }, "https://tohyee.test"));
    const claimed = await w.as(mere, (tx) => claimFarmMailState(tx, new URL(url).searchParams.get("state")!));
    await w.as(mere, async (tx) => saveFarmMailbox(tx, claimed, await fetchFarmMailConnection(claimed, "code", "https://tohyee.test")));
    expect(await w.as(mere, (tx) => listFarmMailboxes(tx))).toHaveLength(1);
    const response = await memberRoute.DELETE(
      apiRequest(`/api/organisations/${w.org}/members/${mere.id}`, { method: "DELETE", cookie: await sessionCookieFor(jess) }),
      params({ organisationId: w.org, userId: mere.id }),
    );
    expect(response.status).toBe(200);
    const accounts = await w.as(jess, (tx) => tx.query<{ n: number }>("select count(*)::int as n from farm_mail_accounts"));
    expect(accounts.rows[0].n).toBe(0);
  });

  it("FC15 a mailbox that can't be read three times running is paused", async () => {
    const w = await setup();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    // An expired access token and a refresh Google refuses.
    await w.as(jess, (tx) => tx.query("update farm_mail_accounts set access_token_expires_at = now() - interval '1 day'"));
    setMailFetchForTests(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) await expect(checkFarmMailbox(w.organisation, mailbox.id)).rejects.toThrow();
    } finally {
      setMailFetchForTests(fake);
    }
    const [paused] = await w.as(jess, (tx) => listFarmMailboxes(tx));
    expect([paused.status, paused.lastError]).toEqual(["paused", expect.stringContaining("invalid_grant")]);
    await expect(w.as(jess, (tx) => mailboxForCheck(tx, mailbox.id))).rejects.toThrow("paused");
  });
});

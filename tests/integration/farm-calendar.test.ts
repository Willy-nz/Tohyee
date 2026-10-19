import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import {
  addCalendarItem,
  calendarLinkFeed,
  calendarLinkStatus,
  checkCalendarItem,
  deleteCalendarItem,
  makeCalendarLink,
  shareCalendarItem,
  skipCalendarDate,
  turnOffCalendarLink,
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
import * as linkRoute from "@/app/api/farming/calendar-link/[organisationId]/[file]/route";
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
  it("FC17 Jess's own item: hers, checked, notes only for her, deleted rather than hidden", async () => {
    const w = await setup();
    await expect(w.as(jess, (tx) => addCalendarItem(tx, { title: "Dry off the herd" }))).rejects.toThrow("Give it a date.");
    const added = await w.as(jess, (tx) =>
      addCalendarItem(tx, { date: "2027-01-05", title: "Dry off the herd", kind: "other", farmId: w.home.id, notes: "Check the vet's dry cow list first" }),
    );
    expect(added).toMatchObject({ source: "own", mine: true, kind: "other", date: "2027-01-05", farmName: "Home farm", checked: true, needsChecking: false, senderEmail: null, notes: "Check the vet's dry cow list first" });
    expect(await w.as(jess, (tx) => itemsToCheck(tx))).toEqual([]);
    expect((await w.as(mere, (tx) => farmCalendar(tx, { from: "2027-01-01", to: "2027-01-31" }))).items).toEqual([]);
    await expect(w.as(mere, (tx) => deleteCalendarItem(tx, added.id))).rejects.toThrow("Calendar item not found.");
    const changed = await w.as(jess, (tx) => checkCalendarItem(tx, added.id, { date: "2027-01-06", startTime: "06:00" }));
    expect([changed.date, changed.startTime, changed.notes]).toEqual(["2027-01-06", "06:00", "Check the vet's dry cow list first"]);
    await w.as(jess, (tx) => deleteCalendarItem(tx, added.id));
    expect((await w.as(jess, (tx) => farmCalendar(tx, { from: "2027-01-01", to: "2027-01-31" }))).items).toEqual([]);
    // An item from email is hidden, not deleted.
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    inbox.push({ id: "m1", threadId: "t1", at: "2026-10-19T10:00:00Z", from: vet, subject: "TB testing", text: "TB testing at the Home farm on Thursday 22 October at 9am." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T10:30:00Z"));
    const fromEmail = (await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items[0];
    await expect(w.as(jess, (tx) => deleteCalendarItem(tx, fromEmail.id))).rejects.toThrow("Not a farm arrangement");
  });

  it("FC18, FC19 repeats: every 2 weeks until an end date, monthly on the last day, skipping one date, an email item checked", async () => {
    const w = await setup();
    const herd = await w.as(jess, (tx) => addCalendarItem(tx, { date: "2026-11-03", title: "Herd test", kind: "animal_health", startTime: "07:00", repeat: "fortnightly", repeatUntil: "2026-12-15" }));
    expect([herd.key, herd.repeat, herd.repeatFrom]).toEqual([`${herd.id}@2026-11-03`, "fortnightly", "2026-11-03"]);
    const dates = async () => (await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-01", to: "2027-01-31" }))).items.filter((item) => item.id === herd.id).map((item) => item.date);
    expect(await dates()).toEqual(["2026-11-03", "2026-11-17", "2026-12-01", "2026-12-15"]);
    // A week in the middle shows only its own date.
    expect((await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-11-16", to: "2026-11-22" }))).items.map((item) => [item.title, item.date])).toEqual([["Herd test", "2026-11-17"]]);
    await expect(w.as(jess, (tx) => skipCalendarDate(tx, herd.id, "2026-11-10"))).rejects.toThrow("isn't one of its dates");
    await w.as(jess, (tx) => skipCalendarDate(tx, herd.id, "2026-11-17"));
    expect(await dates()).toEqual(["2026-11-03", "2026-12-01", "2026-12-15"]);
    // Changing the series changes every date; a skip that's no longer a date goes.
    await w.as(jess, (tx) => checkCalendarItem(tx, herd.id, { date: "2026-11-04" }));
    expect(await dates()).toEqual(["2026-11-04", "2026-11-18", "2026-12-02"]);
    await expect(w.as(jess, (tx) => checkCalendarItem(tx, herd.id, { repeatUntil: "2026-10-01" }))).rejects.toThrow("can't end before it starts");
    const rates = await w.as(jess, (tx) => addCalendarItem(tx, { date: "2027-01-31", title: "Rates", repeat: "monthly" }));
    const months = (await w.as(jess, (tx) => farmCalendar(tx, { from: "2027-01-01", to: "2027-04-30" }))).items.filter((item) => item.id === rates.id).map((item) => item.date);
    expect(months).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    // A repeat set on an item from email checks it.
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    inbox.push({ id: "m1", threadId: "t1", at: "2026-10-19T10:00:00Z", from: "Otago Cartage <bookings@otagocartage.example>", subject: "Truck", text: "Stock truck for the Runoff on Wednesday 21 October, 7am." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T10:30:00Z"));
    const truck = (await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items[0];
    expect(truck.checked).toBe(false);
    const repeating = await w.as(jess, (tx) => checkCalendarItem(tx, truck.id, { repeat: "weekly" }));
    expect([repeating.checked, repeating.repeat]).toEqual([true, "weekly"]);
  });

  it("FC20, FC21 sharing: a preview's worth only, read-only for the team, stopped, and gone when hidden", async () => {
    const w = await setup();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    inbox.push({ id: "m1", threadId: "t1", at: "2026-10-19T10:00:00Z", from: vet, subject: "TB testing", text: "We've booked TB testing at the Home farm for Thursday 22 October at 9am." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T10:30:00Z"));
    const tb = (await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items[0];
    await w.as(jess, (tx) => checkCalendarItem(tx, tb.id, { notes: "Yard at 8.30" }));
    const shared = await w.as(jess, (tx) => shareCalendarItem(tx, tb.id, true));
    expect([shared.shared, shared.sharedByName, shared.checked]).toEqual([true, "Jess", true]);
    expect((await w.as(jess, (tx) => listFarmMailboxes(tx)))[0].shared).toBe(1);
    // Mere sees the arrangement and who shared it, nothing from the email, and can't change it.
    const seen = await w.as(mere, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }));
    expect(seen.items).toHaveLength(1);
    expect(seen.items[0]).toMatchObject({ title: "TB testing", date: "2026-10-22", startTime: "09:00", farmName: "Home farm", mine: false, shared: true, sharedByName: "Jess" });
    expect([seen.items[0].senderEmail, seen.items[0].subject, seen.items[0].excerpt, seen.items[0].webLink, seen.items[0].notes, seen.items[0].mailboxId]).toEqual([null, null, null, null, null, null]);
    expect(JSON.stringify(seen)).not.toMatch(/manukavets|booked|Yard/);
    expect(seen.senders).toEqual([]);
    // Filtering by the sender doesn't reveal which shared items came from them.
    expect((await w.as(mere, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25", sender: "office@manukavets.example" }))).items).toEqual([]);
    await expect(w.as(mere, (tx) => checkCalendarItem(tx, tb.id, { title: "x" }))).rejects.toThrow("Calendar item not found.");
    await expect(w.as(mere, (tx) => shareCalendarItem(tx, tb.id, false))).rejects.toThrow("Calendar item not found.");
    // Jess's changes show to the team; stopping sharing and hiding take it away.
    await w.as(jess, (tx) => checkCalendarItem(tx, tb.id, { startTime: "10:00" }));
    expect((await w.as(mere, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items[0].startTime).toBe("10:00");
    await w.as(jess, (tx) => shareCalendarItem(tx, tb.id, false));
    expect((await w.as(mere, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items).toEqual([]);
    await w.as(jess, (tx) => shareCalendarItem(tx, tb.id, true));
    await w.as(jess, (tx) => dismissCalendarItem(tx, tb.id));
    expect((await w.as(mere, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items).toEqual([]);
    // Mere's own added item, shared, is in Jess's calendar as Mere's.
    const hers = await w.as(mere, (tx) => addCalendarItem(tx, { date: "2026-10-23", title: "Pick up drench", kind: "delivery", notes: "Ring first" }));
    await w.as(mere, (tx) => shareCalendarItem(tx, hers.id, true));
    const jessSees = (await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items;
    expect(jessSees.map((item) => [item.title, item.sharedByName, item.mine, item.notes])).toEqual([["Pick up drench", "Mere", false, null]]);
  });

  it("FC22, FC23 the calendar link: what the calendar shows, no email content, and when it stops", async () => {
    const w = await setup();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    inbox.push({ id: "m1", threadId: "t1", at: "2026-10-19T10:00:00Z", from: vet, subject: "TB testing", text: "We've booked TB testing at the Home farm for Thursday 22 October at 9am." });
    inbox.push({ id: "m2", threadId: "t2", at: "2026-10-19T10:05:00Z", from: "Otago Cartage <bookings@otagocartage.example>", subject: "Truck", text: "Stock truck for the Runoff on Wednesday 21 October, 7am." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T10:30:00Z"));
    inbox.push({ id: "m3", threadId: "t2", at: "2026-10-19T11:00:00Z", from: "Otago Cartage <bookings@otagocartage.example>", subject: "Re: Truck", text: "Sorry, the stock truck is cancelled." });
    await checkFarmMailbox(w.organisation, mailbox.id, new Date("2026-10-19T11:30:00Z"));
    await w.as(jess, (tx) => addCalendarItem(tx, { date: "2026-11-03", title: "Herd test", startTime: "07:00", repeat: "fortnightly", notes: "Secret note" }));
    const hers = await w.as(mere, (tx) => addCalendarItem(tx, { date: "2026-10-23", title: "Pick up drench" }));
    await w.as(mere, (tx) => shareCalendarItem(tx, hers.id, true));
    expect(await w.as(jess, (tx) => calendarLinkStatus(tx))).toMatchObject({ on: false });
    const link = await w.as(jess, (tx) => makeCalendarLink(tx, "https://tohyee.test/"));
    expect(link.on).toBe(true);
    const match = new RegExp(`^https://tohyee\\.test/api/farming/calendar-link/${w.org}/([A-Za-z0-9_-]{43}\\.ics)$`).exec(link.url);
    expect(match).not.toBeNull();
    const file = match![1];
    // Only a hash is kept.
    const stored = await w.as(jess, (tx) => tx.query<{ token_hash: string }>("select token_hash from farm_calendar_links"));
    expect(link.url).not.toContain(stored.rows[0].token_hash);
    const response = await linkRoute.GET(new Request(link.url), { params: Promise.resolve({ organisationId: w.org, file }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    const feed = (await response.text()).replace(/\r\n /g, "");
    expect(feed).toContain("X-WR-CALNAME:Jess's farm calendar");
    expect(feed).toContain("SUMMARY:TB testing");
    expect(feed).toContain("DTSTART;TZID=Pacific/Auckland:20261022T090000");
    expect(feed).toMatch(/SUMMARY:Stock truck[\s\S]*?STATUS:CANCELLED/);
    expect(feed).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2");
    expect(feed).toContain("SUMMARY:Pick up drench");
    expect(feed).toContain("Shared by Mere");
    expect(feed).not.toMatch(/manukavets|booked|otagocartage|Secret note|mail\.google/);
    expect((await w.as(jess, (tx) => calendarLinkStatus(tx))).lastUsedAt).not.toBeNull();
    // Wrong, replaced, turned off, Farming off, or left: all "not found".
    expect(await calendarLinkFeed(w.org, `${"A".repeat(43)}.ics`)).toBeNull();
    expect(await calendarLinkFeed("no-such-org", file)).toBeNull();
    const second = await w.as(jess, (tx) => makeCalendarLink(tx, "https://tohyee.test"));
    expect(await calendarLinkFeed(w.org, file)).toBeNull();
    const secondFile = second.url.split("/").pop()!;
    expect(await calendarLinkFeed(w.org, secondFile)).toContain("BEGIN:VCALENDAR");
    await w.as(jess, (tx) => setFarmingEnabled(tx, { enabled: false }));
    expect(await calendarLinkFeed(w.org, secondFile)).toBeNull();
    await w.as(jess, (tx) => setFarmingEnabled(tx, { enabled: true }));
    await w.as(jess, (tx) => turnOffCalendarLink(tx));
    expect(await calendarLinkFeed(w.org, secondFile)).toBeNull();
    const mereLink = await w.as(mere, (tx) => makeCalendarLink(tx, "https://tohyee.test"));
    const mereFile = mereLink.url.split("/").pop()!;
    expect(await calendarLinkFeed(w.org, mereFile)).toContain("Pick up drench");
    const removed = await memberRoute.DELETE(
      apiRequest(`/api/organisations/${w.org}/members/${mere.id}`, { method: "DELETE", cookie: await sessionCookieFor(jess) }),
      params({ organisationId: w.org, userId: mere.id }),
    );
    expect(removed.status).toBe(200);
    expect(await calendarLinkFeed(w.org, mereFile)).toBeNull();
    // Mere's items, shared ones included, went with her.
    expect((await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-25" }))).items.map((item) => item.title)).toEqual(["Stock truck", "TB testing"]);
  });
});

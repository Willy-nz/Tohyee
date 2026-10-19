import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import {
  checkFarmMailbox,
  chooseMailboxFolders,
  claimFarmMailState,
  fetchFarmMailConnection,
  listFarmMailboxes,
  mailboxFolderChoices,
  saveFarmMailbox,
  startFarmMailConnect,
  farmCalendar,
} from "@/lib/farming/calendar";
import { setFarmingEnabled } from "@/lib/farming/paddocks";
import { getOrganisation } from "@/lib/organisations/registry";
import { MailOwner } from "@/lib/private-mail/access";
import {
  chooseMyFolders,
  deleteMyCopy,
  disconnectMyMailbox,
  myFolderChoices,
  myMail,
  readMyThread,
  savePrivateMailbox,
  searchMyMail,
  setCopying,
  startMyMailConnect,
} from "@/lib/private-mail/store";
import { syncPrivateCopy } from "@/lib/private-mail/sync";
import * as myMailRoute from "@/app/api/my-mail/route";
import * as mailboxRoute from "@/app/api/my-mail/mailboxes/[mailboxId]/route";
import * as foldersRoute from "@/app/api/my-mail/mailboxes/[mailboxId]/folders/route";
import * as copyRoute from "@/app/api/my-mail/copies/[copyId]/route";
import * as syncRoute from "@/app/api/my-mail/copies/[copyId]/sync/route";
import * as searchRoute from "@/app/api/my-mail/search/route";
import * as messageRoute from "@/app/api/my-mail/messages/[messageId]/route";
import * as attachmentRoute from "@/app/api/my-mail/attachments/[attachmentId]/route";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * My mail: an Owner's private copy of their own mail (#250; PM1-PM14,
 * Claude's rules, not yet reviewed). Gmail, Microsoft Graph and their
 * sign-ins are canned fakes with made-up mail; nothing here has been tried
 * against a real mailbox. The privacy tests come first.
 */

type Attachment = { id: string; name: string; type: string; content?: string; size?: number; linked?: boolean };
type Mail = { id: string; threadId: string; at: string; from: string; to?: string; cc?: string; subject: string; text: string; labels: string[]; attachments?: Attachment[] };
const LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "SPAM", name: "SPAM", type: "system" },
  { id: "TRASH", name: "TRASH", type: "system" },
  { id: "Label_1", name: "Farm", type: "user" },
  { id: "Label_2", name: "Farm/LIC", type: "user" },
  { id: "Label_3", name: "Directorships", type: "user" },
];

// Made-up mail. The "secret" words let the tests look for leaks.
const lab = "Soil Lab <results@soillab.example>";
const board = "Board Secretary <secretary@finchboard.example>";

describeWithDatabase("private mail copy", () => {
  let server: TestServer;
  let jess: SessionUser;
  let ana: SessionUser;
  let mere: SessionUser;
  let sam: SessionUser;
  let rob: SessionUser;
  let sid: SessionUser;
  let outsider: SessionUser;
  let organisations = 0;
  let gmail: Mail[] = [];
  let outlook: { folders: Array<{ id: string; displayName: string; parentFolderId: string | null }>; mail: Array<Mail & { folder: string }> } = { folders: [], mail: [] };
  let fetched: string[] = [];
  let failOnce = new Set<string>();
  let writes: string[] = [];
  const previousSecret = process.env.TOHYEE_SECRET_KEY;

  const encode = (text: string | Buffer) => (typeof text === "string" ? Buffer.from(text, "utf8") : text).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const missing = () => new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "private-mail-test-secret-key-0123456789abcdef";
    server = await startTestServer();
    jess = await createTestUser("pm-jess@example.com", { displayName: "Jess" });
    ana = await createTestUser("pm-ana@example.com", { displayName: "Ana" });
    mere = await createTestUser("pm-mere@example.com", { displayName: "Mere" });
    sam = await createTestUser("pm-sam@example.com", { displayName: "Sam" });
    rob = await createTestUser("pm-rob@example.com", { displayName: "Rob" });
    sid = await createTestUser("pm-sid@example.com", { serverAdmin: true, displayName: "Sid" });
    outsider = await createTestUser("pm-out@example.com", { displayName: "Olly" });
    setMailFetchForTests(fake);
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  const fake = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.host === "oauth2.googleapis.com") return reply({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/gmail.readonly" });
    if (url.host === "login.microsoftonline.com") return reply({ access_token: "ms-access", refresh_token: "ms-refresh", expires_in: 3600 });
    // Read-only: anything but a GET to the mailbox is recorded, and must never happen.
    if ((init?.method ?? "GET").toUpperCase() !== "GET") writes.push(`${init?.method} ${url.pathname}`);
    if (url.host === "graph.microsoft.com") return graph(url);
    if (url.pathname.endsWith("/users/me/profile")) return reply({ emailAddress: "Jess@KowhaiDairies.example" });
    if (url.pathname.endsWith("/users/me/labels")) return reply({ labels: LABELS });
    if (url.pathname.endsWith("/users/me/messages")) {
      const after = Number(/after:(\d+)/.exec(url.searchParams.get("q") ?? "")?.[1] ?? 0) * 1000;
      const label = url.searchParams.get("labelIds");
      const spamTrash = url.searchParams.get("includeSpamTrash") === "true";
      const ids = gmail
        .filter((mail) => Date.parse(mail.at) >= after && (!label || mail.labels.includes(label)))
        .filter((mail) => spamTrash || !mail.labels.some((entry) => entry === "SPAM" || entry === "TRASH"))
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((mail) => ({ id: mail.id }));
      return reply({ messages: ids });
    }
    const attachment = /\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
    if (attachment) {
      const file = gmail.find((mail) => mail.id === attachment[1])?.attachments?.find((entry) => entry.id === attachment[2]);
      return file ? reply({ data: encode(file.content ?? ""), size: (file.content ?? "").length }) : missing();
    }
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const mail = gmail.find((entry) => entry.id === id);
    if (!mail) return missing();
    if (failOnce.delete(id)) return new Response("busy", { status: 503 });
    fetched.push(id);
    return reply({
      id: mail.id,
      threadId: mail.threadId,
      internalDate: String(Date.parse(mail.at)),
      sizeEstimate: mail.text.length,
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: mail.from },
          { name: "To", value: mail.to ?? "Jess <jess@kowhaidairies.example>" },
          ...(mail.cc ? [{ name: "Cc", value: mail.cc }] : []),
          { name: "Subject", value: mail.subject },
        ],
        parts: [
          { partId: "0", mimeType: "multipart/alternative", parts: [{ partId: "0.0", mimeType: "text/plain", body: { data: encode(mail.text) } }, { partId: "0.1", mimeType: "text/html", body: { data: encode(`<p>${mail.text}</p>`) } }] },
          ...(mail.attachments ?? []).map((file, index) => ({
            partId: String(index + 1),
            mimeType: file.type,
            filename: file.name,
            headers: [{ name: "Content-Disposition", value: `attachment; filename="${file.name}"` }],
            body: { attachmentId: file.id, size: file.size ?? (file.content ?? "").length },
          })),
        ],
      },
    });
  };

  const graph = (url: URL): Response => {
    const path = decodeURIComponent(url.pathname.replace("/v1.0", ""));
    if (path === "/me") return reply({ mail: "Jess@KowhaiDairies.example", userPrincipalName: "jess@kowhaidairies.example" });
    const shape = (folder: { id: string; displayName: string }) => ({ ...folder, childFolderCount: outlook.folders.filter((child) => child.parentFolderId === folder.id).length });
    if (path === "/me/mailFolders") return reply({ value: outlook.folders.filter((folder) => folder.parentFolderId === null).map(shape) });
    const children = /^\/me\/mailFolders\/([^/]+)\/childFolders$/.exec(path);
    if (children) return outlook.folders.some((folder) => folder.id === children[1]) ? reply({ value: outlook.folders.filter((folder) => folder.parentFolderId === children[1]).map(shape) }) : missing();
    const messages = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(path);
    if (messages) {
      if (!outlook.folders.some((folder) => folder.id === messages[1])) return missing();
      const after = Date.parse(/receivedDateTime ge (\S+)/.exec(url.searchParams.get("$filter") ?? "")?.[1] ?? "1970-01-01T00:00:00Z");
      return reply({ value: outlook.mail.filter((mail) => mail.folder === messages[1] && Date.parse(mail.at) >= after).sort((a, b) => b.at.localeCompare(a.at)).map((mail) => ({ id: mail.id })) });
    }
    const files = /^\/me\/messages\/([^/]+)\/attachments$/.exec(path);
    if (files) {
      const mail = outlook.mail.find((entry) => entry.id === files[1]);
      return reply({
        value: (mail?.attachments ?? []).map((file) => ({
          id: file.id,
          name: file.name,
          contentType: file.type,
          size: file.size ?? (file.content ?? "").length,
          isInline: false,
          "@odata.type": file.linked ? "#microsoft.graph.itemAttachment" : "#microsoft.graph.fileAttachment",
        })),
      });
    }
    const file = /^\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (file) {
      const found = outlook.mail.find((entry) => entry.id === file[1])?.attachments?.find((entry) => entry.id === file[2]);
      return found ? reply({ contentBytes: Buffer.from(found.content ?? "").toString("base64") }) : missing();
    }
    const one = /^\/me\/messages\/([^/]+)$/.exec(path);
    const mail = one ? outlook.mail.find((entry) => entry.id === one[1]) : undefined;
    if (!mail) return missing();
    fetched.push(mail.id);
    const [, name, address] = /^(.*) <(.*)>$/.exec(mail.from) ?? [null, null, mail.from];
    return reply({
      id: mail.id,
      conversationId: mail.threadId,
      subject: mail.subject,
      from: { emailAddress: { address, name } },
      toRecipients: [{ emailAddress: { address: "jess@kowhaidairies.example", name: "Jess" } }],
      sentDateTime: mail.at,
      receivedDateTime: mail.at,
      webLink: `https://outlook.example/${mail.id}`,
      hasAttachments: Boolean(mail.attachments?.length),
      body: { contentType: "text", content: mail.text },
    });
  };

  async function setup(options: { farming?: boolean } = {}) {
    organisations += 1;
    const org = `private-mail-${organisations}`;
    await createTestOrganisation(jess, org);
    for (const [user, role] of [
      [ana, "owner"],
      [mere, "admin"],
      [sam, "bookkeeper"],
      [rob, "report_viewer"],
      [sid, "admin"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    if (options.farming) await as(jess, (tx) => setFarmingEnabled(tx, { enabled: true }));
    await as(jess, (tx) => saveMailSettings(tx, { googleClientId: "g-client.apps.googleusercontent.com", googleClientSecret: "g-secret", microsoftClientId: "ms-client", microsoftClientSecret: "ms-secret" }));
    const organisation = (await getOrganisation(org))!;
    gmail = [];
    outlook = { folders: [], mail: [] };
    fetched = [];
    failOnce = new Set();
    writes = [];
    return { org, as, organisation };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  const owner = (tx: OrgTx) => MailOwner.of(tx);

  /** Connects Jess's mailbox from My mail at `now` and ticks `folders` (none with []). */
  async function connect(w: World, now: string, options: { provider?: "google" | "microsoft"; historyDays?: number; folders?: Array<{ id: string; includeSubfolders?: boolean }> } = {}) {
    const { provider = "google", historyDays = 90, folders = [{ id: "Label_1" }] } = options;
    const { url } = await w.as(jess, async (tx) => startMyMailConnect(tx, await owner(tx), { provider, historyDays }, "https://tohyee.test"));
    const state = new URL(url).searchParams.get("state")!;
    const claimed = await w.as(jess, (tx) => claimFarmMailState(tx, state));
    expect(claimed.purpose).toBe("private");
    const connection = await fetchFarmMailConnection(claimed, "code-1", "https://tohyee.test");
    const saved = await w.as(jess, (tx) => savePrivateMailbox(tx, claimed, connection, new Date(now)));
    if (folders.length) await choose(w, saved.id, folders);
    const mail = await w.as(jess, async (tx) => myMail(tx, await owner(tx)));
    return mail.mailboxes.find((mailbox) => mailbox.id === saved.id)!;
  }

  async function choose(w: World, mailboxId: string, folders: Array<{ id: string; includeSubfolders?: boolean }>) {
    const available = await myFolderChoices(w.organisation, mailboxId);
    const mail = await w.as(jess, async (tx) => chooseMyFolders(tx, await owner(tx), mailboxId, folders, available));
    return mail.mailboxes.find((mailbox) => mailbox.id === mailboxId)!;
  }

  const copyOf = async (w: World, mailboxId: string) => (await w.as(jess, async (tx) => myMail(tx, await owner(tx)))).mailboxes.find((mailbox) => mailbox.id === mailboxId)!.copy!;

  function seedGmail() {
    gmail.push({
      id: "g1",
      threadId: "t1",
      at: "2026-10-10T21:00:00Z",
      from: lab,
      subject: "Soil test results paddock twelve",
      text: "Kia ora Jess, the Olsen P for paddock twelve is 32. Results attached. Kōwhai Dairies account.",
      labels: ["INBOX", "Label_1"],
      attachments: [
        { id: "att-1", name: "Soil results P12.pdf", type: "application/pdf", content: "%PDF-1.4 made-up soil results" },
        { id: "att-big", name: "Drone survey.zip", type: "application/zip", size: 25 * 1024 * 1024 },
      ],
    });
    gmail.push({ id: "g2", threadId: "t1", at: "2026-10-11T02:00:00Z", from: "Jess <jess@kowhaidairies.example>", to: lab, subject: "Re: Soil test results paddock twelve", text: "Thanks, can you add the lime recommendation?", labels: ["SENT", "Label_1"] });
    gmail.push({ id: "g3", threadId: "t3", at: "2026-10-12T03:00:00Z", from: board, subject: "Directorship board papers confidential", text: "Board papers for George Finch Farmers Limited are attached.", labels: ["INBOX", "Label_3"] });
    gmail.push({ id: "g4", threadId: "t4", at: "2026-10-13T03:00:00Z", from: "Spammer <win@prizes.example>", subject: "You won", text: "Claim your prize", labels: ["SPAM"] });
    gmail.push({ id: "g5", threadId: "t5", at: "2026-10-14T03:00:00Z", from: "Jess <jess@kowhaidairies.example>", subject: "Draft fertiliser order", text: "Draft: two tonnes of urea", labels: ["DRAFT", "Label_1"] });
  }

  // Privacy first ---------------------------------------------------------------------------------

  it("PM7 nobody but Jess can list, search, read, download, change or delete her copy, through any route", async () => {
    const w = await setup();
    seedGmail();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:15:00Z"));
    const hit = (await w.as(jess, async (tx) => searchMyMail(tx, await owner(tx), { query: "olsen" }))).hits[0];
    expect(hit.subject).toBe("Soil test results paddock twelve");
    const thread = await w.as(jess, async (tx) => readMyThread(tx, await owner(tx), hit.id));
    const attachmentId = thread.messages[0].attachments.find((file) => file.kept)!.id;
    const copyId = mailbox.copy!.id;
    const org = w.org;
    const calls: Array<[string, (cookie: string) => Promise<Response>]> = [
      ["list", (cookie) => myMailRoute.GET(apiRequest(`/api/my-mail?organisationId=${org}`, { cookie }), params({}))],
      ["connect", (cookie) => myMailRoute.POST(apiRequest("/api/my-mail", { method: "POST", cookie, body: { organisationId: org, provider: "google" } }), params({}))],
      ["switch", (cookie) => mailboxRoute.PATCH(apiRequest(`/api/my-mail/mailboxes/${mailbox.id}`, { method: "PATCH", cookie, body: { organisationId: org, copying: false } }), params({ mailboxId: mailbox.id }))],
      ["disconnect", (cookie) => mailboxRoute.DELETE(apiRequest(`/api/my-mail/mailboxes/${mailbox.id}?organisationId=${org}`, { method: "DELETE", cookie }), params({ mailboxId: mailbox.id }))],
      ["folders", (cookie) => foldersRoute.GET(apiRequest(`/api/my-mail/mailboxes/${mailbox.id}/folders?organisationId=${org}`, { cookie }), params({ mailboxId: mailbox.id }))],
      ["choose", (cookie) => foldersRoute.PUT(apiRequest(`/api/my-mail/mailboxes/${mailbox.id}/folders`, { method: "PUT", cookie, body: { organisationId: org, folders: [{ id: "INBOX" }] } }), params({ mailboxId: mailbox.id }))],
      ["sync", (cookie) => syncRoute.POST(apiRequest(`/api/my-mail/copies/${copyId}/sync`, { method: "POST", cookie, body: { organisationId: org } }), params({ copyId }))],
      ["delete", (cookie) => copyRoute.DELETE(apiRequest(`/api/my-mail/copies/${copyId}?organisationId=${org}`, { method: "DELETE", cookie }), params({ copyId }))],
      ["search", (cookie) => searchRoute.POST(apiRequest("/api/my-mail/search", { method: "POST", cookie, body: { organisationId: org, query: "olsen" } }), params({}))],
      ["browse", (cookie) => searchRoute.POST(apiRequest("/api/my-mail/search", { method: "POST", cookie, body: { organisationId: org } }), params({}))],
      ["thread", (cookie) => messageRoute.GET(apiRequest(`/api/my-mail/messages/${hit.id}?organisationId=${org}`, { cookie }), params({ messageId: hit.id }))],
      ["attachment", (cookie) => attachmentRoute.GET(apiRequest(`/api/my-mail/attachments/${attachmentId}?organisationId=${org}`, { cookie }), params({ attachmentId }))],
    ];
    // Another Owner, an admin, an accountant, a report viewer, a server admin who's a member, and someone outside.
    for (const user of [ana, mere, sam, rob, sid, outsider]) {
      const cookie = await sessionCookieFor(user);
      for (const [name, call] of calls) {
        const response = await call(cookie);
        const body = await response.text();
        // Ana, an Owner herself, has her own (empty) My mail; everything of Jess's is "not found".
        const own = user === ana && ["list", "connect", "search", "browse"].includes(name);
        expect([name, user.email, response.status]).toEqual([name, user.email, own ? 200 : 404]);
        // (Ana's own sign-in address names the shared /api/farming/mail/callback.)
        if (name !== "connect") expect(body).not.toMatch(/soil|olsen|soillab|kowhaidairies|Label_|Farm|attach/i);
        if (own && name === "list") expect(JSON.parse(body)).toEqual({ mailboxes: [], detached: [] });
        if (own && name !== "list" && name !== "connect") expect(JSON.parse(body)).toEqual({ hits: [], more: null });
      }
    }
    // Signed out: not even "not found".
    expect((await myMailRoute.GET(apiRequest(`/api/my-mail?organisationId=${org}`), params({}))).status).toBe(401);
    // An AI key or a farm app key acting as Jess isn't let in (a key needs the private-mail scope, #250 part 2).
    for (const via of ['AI key "Claude"', 'Farm app "Herd app"']) {
      await expect(inOrganisation(org, { userId: jess.id, email: jess.email, via }, (tx) => MailOwner.of(tx))).rejects.toThrow("Not found.");
    }
    // The scheduler's own actor isn't an owner either.
    await expect(inOrganisation(org, { userId: null, email: "private-mail@tohyee" }, (tx) => MailOwner.of(tx))).rejects.toThrow("Not found.");
    // Nothing was changed by any of it: the copy is still there and copying.
    expect(await copyOf(w, mailbox.id)).toMatchObject({ copying: true, copied: 3 });
    // And Jess herself gets it all.
    const cookie = await sessionCookieFor(jess);
    const download = await attachmentRoute.GET(apiRequest(`/api/my-mail/attachments/${attachmentId}?organisationId=${org}`, { cookie }), params({ attachmentId }));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await download.arrayBuffer()).toString("utf8")).toBe("%PDF-1.4 made-up soil results");
    expect(writes).toEqual([]);
  }, 120_000);

  it("PM7 metadata stays private: the database holds no readable subject, address, word or file name; the audit trail and log say nothing", async () => {
    const w = await setup();
    seedGmail();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:15:00Z"));
    const leaks = await w.as(jess, (tx) =>
      tx.query<{ count: number }>(
        `select count(*)::int as count from private_mail_messages m
          where position(convert_to('Olsen', 'UTF8') in m.envelope) > 0 or position(convert_to('Olsen', 'UTF8') in m.body) > 0
             or position(convert_to('soillab', 'UTF8') in m.envelope) > 0 or position(convert_to('Soil test', 'UTF8') in m.envelope) > 0
             or exists (select 1 from unnest(m.search_tokens) t where t in ('olsen', 'soil', 'paddock', 'twelve') or t like '%soillab%')`,
      ),
    );
    expect(leaks.rows[0].count).toBe(0);
    const files = await w.as(jess, (tx) => tx.query<{ count: number }>("select count(*)::int as count from private_mail_attachments where position(convert_to('Soil results', 'UTF8') in meta) > 0 or position(convert_to('made-up soil', 'UTF8') in coalesce(content, ''::bytea)) > 0"));
    expect(files.rows[0].count).toBe(0);
    // The plain columns: ids, dates, sizes, counts and tokens, nothing readable.
    const columns = await w.as(jess, (tx) => tx.query<{ column_name: string; data_type: string }>("select column_name, data_type from information_schema.columns where table_name = 'private_mail_messages' order by ordinal_position"));
    expect(columns.rows.filter((row) => row.data_type === "text").map((row) => row.column_name)).toEqual(["external_id", "thread_key"]);
    // Audit events: what happened, never the mailbox, a folder, a subject or a count.
    const audit = await w.as(jess, (tx) => tx.query<{ event_type: string; details: unknown }>("select event_type, details from audit_events where event_type like 'private_mail.%' or event_type like 'farming.mailbox%' order by audit_events.id"));
    expect(audit.rows.map((row) => row.event_type)).toEqual(["farming.mailbox_connected", "private_mail.copy_started", "farming.mailbox_folders_chosen"]);
    expect(JSON.stringify(audit.rows.map((row) => row.details))).not.toMatch(/soil|kowhai|Farm|Label_|olsen/i);
    // A failed sync's log line names neither the mailbox nor the provider's words.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failOnce.add("g6");
    gmail.push({ id: "g6", threadId: "t6", at: "2026-10-18T03:00:00Z", from: lab, subject: "More results", text: "More", labels: ["Label_1"] });
    const { syncAllPrivateMail } = await import("@/lib/private-mail/sync");
    await syncAllPrivateMail();
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    warn.mockRestore();
    expect(logged).not.toMatch(/kowhai|soil|busy|503|Label_|g6/i);
  }, 120_000);

  it("PM8 ownership never moves: a role change, a new owner or leaving suspends the copy; the database refuses a new owner", async () => {
    const w = await setup();
    seedGmail();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:15:00Z"));
    // Ana (an owner) makes Jess an admin: Jess can't read it now, and it isn't synced.
    const changed = await memberRoute.PATCH(apiRequest(`/api/organisations/${w.org}/members/${jess.id}`, { method: "PATCH", cookie: await sessionCookieFor(ana), body: { role: "admin" } }), params({ organisationId: w.org, userId: jess.id }));
    expect(changed.status).toBe(200);
    await expect(w.as(jess, (tx) => MailOwner.of(tx))).rejects.toThrow("Not found.");
    gmail.push({ id: "g7", threadId: "t7", at: "2026-10-19T10:00:00Z", from: lab, subject: "Later results", text: "Later", labels: ["Label_1"] });
    fetched = [];
    expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T10:15:00Z"))).toEqual({ copied: 0, removed: 0, skipped: "suspended" });
    expect(fetched).toEqual([]);
    // Ana, an owner (as anyone handed the organisation would be), still gets nothing.
    await expect(w.as(ana, async (tx) => searchMyMail(tx, await owner(tx), { query: "olsen" }))).resolves.toEqual({ hits: [], more: null });
    expect((await w.as(ana, async (tx) => myMail(tx, await owner(tx)))).mailboxes).toEqual([]);
    const hitId = (await w.as(jess, (tx) => tx.query<{ id: string }>("select id::text from private_mail_messages limit 1"))).rows[0].id;
    await expect(w.as(ana, async (tx) => readMyThread(tx, await owner(tx), hitId))).rejects.toThrow("Not found.");
    // The database itself refuses a new owner for the copy or its rows.
    await expect(w.as(ana, (tx) => tx.query("update private_mail_copies set owner_user_id = $1", [ana.id]))).rejects.toThrow("owner can't change");
    await expect(w.as(ana, (tx) => tx.query("update private_mail_messages set owner_user_id = $1", [ana.id]))).rejects.toThrow("owner can't change");
    // Jess an Owner again: hers again, and syncing again.
    await memberRoute.PATCH(apiRequest(`/api/organisations/${w.org}/members/${jess.id}`, { method: "PATCH", cookie: await sessionCookieFor(ana), body: { role: "owner" } }), params({ organisationId: w.org, userId: jess.id }));
    expect((await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T10:30:00Z"))).copied).toBe(1);
    // Jess leaves: the connection goes (as the farm calendar's does), the copy stays, readable by nobody.
    const removed = await memberRoute.DELETE(apiRequest(`/api/organisations/${w.org}/members/${jess.id}`, { method: "DELETE", cookie: await sessionCookieFor(ana) }), params({ organisationId: w.org, userId: jess.id }));
    expect(removed.status).toBe(200);
    const left = await w.as(ana, (tx) => tx.query<{ account_id: string | null; copying: boolean; messages: number }>("select account_id::text, copying, (select count(*)::int from private_mail_messages) as messages from private_mail_copies"));
    expect(left.rows).toEqual([{ account_id: null, copying: true, messages: 4 }]);
    await expect(w.as(jess, (tx) => MailOwner.of(tx))).rejects.toThrow("Not found.");
    // Added back as an Owner, Jess finds her copy, not copying, to delete or carry on.
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')", [w.org, jess.id]);
    const back = await w.as(jess, async (tx) => myMail(tx, await owner(tx)));
    expect(back.mailboxes).toEqual([]);
    expect(back.detached).toMatchObject([{ email: "jess@kowhaidairies.example", copied: 4 }]);
  }, 120_000);

  // What it copies ------------------------------------------------------------------------------------

  it("PM1, PM2 only an Owner turns it on; nothing is read until folders are ticked; only the ticked folders are copied", async () => {
    const w = await setup();
    seedGmail();
    // Mere (an admin) can't start one.
    await expect(w.as(mere, async (tx) => startMyMailConnect(tx, await owner(tx), { provider: "google" }, "https://tohyee.test"))).rejects.toThrow("Not found.");
    const { url } = await w.as(jess, async (tx) => startMyMailConnect(tx, await owner(tx), { provider: "google", historyDays: 90 }, "https://tohyee.test"));
    // The farm calendar's read-only sign-in, at the same sign-in address, in an organisation without Farming.
    const query = new URL(url).searchParams;
    expect([query.get("scope"), query.get("redirect_uri")]).toEqual(["openid email https://www.googleapis.com/auth/gmail.readonly", "https://tohyee.test/api/farming/mail/callback"]);
    const mailbox = await connect(w, "2026-10-19T09:00:00Z", { folders: [] });
    expect(mailbox).toMatchObject({ farmCalendar: false, folders: [], copy: { copying: true, copied: 0, lastSuccessAt: null } });
    expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:15:00Z"))).toMatchObject({ copied: 0, skipped: "no_folders" });
    expect(fetched).toEqual([]);
    // The labels offered: the farm calendar's, then Sent, Drafts, Spam and Trash for the private copy only.
    const available = await myFolderChoices(w.organisation, mailbox.id);
    expect(available.map((folder) => [folder.id, folder.path, folder.privateOnly === true])).toEqual([
      ["INBOX", "Inbox", false],
      ["Label_3", "Directorships", false],
      ["Label_1", "Farm", false],
      ["Label_2", "Farm/LIC", false],
      ["SENT", "Sent", true],
      ["DRAFT", "Drafts", true],
      ["SPAM", "Spam", true],
      ["TRASH", "Trash", true],
    ]);
    // Farm only: the directorship email, the spam and the draft are never fetched.
    await choose(w, mailbox.id, [{ id: "Label_1" }]);
    expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:30:00Z"))).toEqual({ copied: 3, removed: 0 });
    // g5 is a draft but also labelled Farm, so it's in a ticked label; g3 (Directorships) and g4 (Spam) aren't.
    expect(fetched.sort()).toEqual(["g1", "g2", "g5"]);
    // Ticking Spam copies spam too.
    await choose(w, mailbox.id, [{ id: "Label_1" }, { id: "SPAM" }]);
    await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:45:00Z"));
    expect(fetched.sort()).toEqual(["g1", "g2", "g4", "g5"]);
    expect(writes).toEqual([]);
  }, 120_000);

  it("PM3 the first copy resumes where it stopped, never twice, and shows progress and coverage", async () => {
    const w = await setup();
    for (let day = 1; day <= 9; day += 1) {
      gmail.push({ id: `b${day}`, threadId: `b${day}`, at: `2026-10-0${day}T03:00:00Z`, from: lab, subject: `Results ${day}`, text: `Batch ${day}`, labels: ["Label_1"] });
    }
    // Older than the read-back window (30 days before connecting): never copied.
    gmail.push({ id: "old", threadId: "old", at: "2026-08-01T03:00:00Z", from: lab, subject: "Old", text: "Old", labels: ["Label_1"] });
    const mailbox = await connect(w, "2026-10-19T09:00:00Z", { historyDays: 30 });
    // The mailbox is busy partway: what was copied stays; the error is shown to Jess.
    failOnce.add("b5");
    await expect(syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:15:00Z"))).rejects.toThrow("503");
    const partway = await copyOf(w, mailbox.id);
    expect(partway).toMatchObject({ copied: 4, lastSuccessAt: null });
    expect(partway.lastError).toContain("503");
    expect(fetched).toEqual(["b9", "b8", "b7", "b6"]);
    // The next sync carries on: only the rest are fetched, nothing twice.
    expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:30:00Z"))).toEqual({ copied: 5, removed: 0 });
    expect(fetched).toEqual(["b9", "b8", "b7", "b6", "b5", "b4", "b3", "b2", "b1"]);
    expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:45:00Z"))).toEqual({ copied: 0, removed: 0 });
    const done = await copyOf(w, mailbox.id);
    expect(done).toMatchObject({ copied: 9, listed: 9, lastError: null, listingCapped: false, oldest: expect.stringContaining("2026-10-01"), newest: expect.stringContaining("2026-10-09") });
    const count = await w.as(jess, (tx) => tx.query<{ count: number }>("select count(*)::int as count from private_mail_messages"));
    expect(count.rows[0].count).toBe(9);
    // "Sync now" through the route answers how many were copied.
    const response = await syncRoute.POST(apiRequest(`/api/my-mail/copies/${done.id}/sync`, { method: "POST", cookie: await sessionCookieFor(jess), body: { organisationId: w.org } }), params({ copyId: done.id }));
    expect(await response.json()).toEqual({ copied: 0, removed: 0 });
  }, 120_000);

  it("PM5 attachments: kept files download; big ones and linked Outlook items keep only their name and size", async () => {
    const w = await setup();
    outlook.folders = [
      { id: "inbox", displayName: "Inbox", parentFolderId: null },
      { id: "farm", displayName: "Farm", parentFolderId: "inbox" },
    ];
    outlook.mail = [
      {
        id: "o1",
        threadId: "c1",
        at: "2026-10-15T01:00:00Z",
        from: "Fert Co <orders@fertco.example>",
        subject: "Fertiliser quote",
        text: "Quote attached for 20 tonnes.",
        labels: [],
        folder: "farm",
        attachments: [
          { id: "a1", name: "Quote 4471.pdf", type: "application/pdf", content: "made-up quote" },
          { id: "a2", name: "Meeting invite", type: "message/rfc822", linked: true },
          { id: "a3", name: "Plans.zip", type: "application/zip", size: 30 * 1024 * 1024 },
        ],
      },
    ];
    const mailbox = await connect(w, "2026-10-19T09:00:00Z", { provider: "microsoft", folders: [{ id: "farm" }] });
    expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:15:00Z"))).toEqual({ copied: 1, removed: 0 });
    const hit = (await w.as(jess, async (tx) => searchMyMail(tx, await owner(tx), { query: "quote" }))).hits[0];
    expect(hit).toMatchObject({ subject: "Fertiliser quote", attachmentCount: 3, from: { email: "orders@fertco.example" } });
    const thread = await w.as(jess, async (tx) => readMyThread(tx, await owner(tx), hit.id));
    expect(thread.messages[0].attachments.map((file) => [file.name, file.kept, file.notKept])).toEqual([
      ["Quote 4471.pdf", true, null],
      ["Meeting invite", false, "linked"],
      ["Plans.zip", false, "too_big"],
    ]);
    const cookie = await sessionCookieFor(jess);
    const [kept, linked] = thread.messages[0].attachments;
    const download = await attachmentRoute.GET(apiRequest(`/api/my-mail/attachments/${kept.id}?organisationId=${w.org}`, { cookie }), params({ attachmentId: kept.id }));
    expect(Buffer.from(await download.arrayBuffer()).toString("utf8")).toBe("made-up quote");
    const refused = await attachmentRoute.GET(apiRequest(`/api/my-mail/attachments/${linked.id}?organisationId=${w.org}`, { cookie }), params({ attachmentId: linked.id }));
    expect(refused.status).toBe(400);
    expect((await w.as(jess, async (tx) => myMail(tx, await owner(tx)))).mailboxes[0].copy).toMatchObject({ attachments: 3, attachmentsNotKept: 2 });
    expect(writes).toEqual([]);
  }, 120_000);

  it("PM6 unticking a folder, moving email out and in, and a deleted folder, as the farm calendar does", async () => {
    const w = await setup();
    seedGmail();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z", { folders: [{ id: "Label_1" }, { id: "Label_3" }] });
    await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:15:00Z"));
    const subjects = async () => (await w.as(jess, async (tx) => searchMyMail(tx, await owner(tx), {}))).hits.map((hit) => hit.subject).sort();
    expect(await subjects()).toEqual(["Directorship board papers confidential", "Draft fertiliser order", "Re: Soil test results paddock twelve", "Soil test results paddock twelve"]);
    // Unticking Directorships deletes what was copied only from it, at once.
    await choose(w, mailbox.id, [{ id: "Label_1" }]);
    expect(await subjects()).toEqual(["Draft fertiliser order", "Re: Soil test results paddock twelve", "Soil test results paddock twelve"]);
    // Moving the draft out of Farm drops it at the next sync; moving the board papers in copies them.
    gmail.find((mail) => mail.id === "g5")!.labels = ["DRAFT"];
    gmail.find((mail) => mail.id === "g3")!.labels = ["INBOX", "Label_3", "Label_1"];
    expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:30:00Z"))).toEqual({ copied: 1, removed: 1 });
    expect(await subjects()).toEqual(["Directorship board papers confidential", "Re: Soil test results paddock twelve", "Soil test results paddock twelve"]);
    // The Farm label deleted in Gmail: everything from it is dropped, and it's shown as not found.
    const labels = LABELS.filter((label) => label.id !== "Label_1");
    setMailFetchForTests(async (input, init) => (new URL(input).pathname.endsWith("/users/me/labels") ? reply({ labels }) : fake(input, init)));
    try {
      expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:45:00Z"))).toEqual({ copied: 0, removed: 3 });
    } finally {
      setMailFetchForTests(fake);
    }
    const after = (await w.as(jess, async (tx) => myMail(tx, await owner(tx)))).mailboxes[0];
    expect(after.folders).toMatchObject([{ externalId: "Label_1", missing: true }]);
    expect(after.copy).toMatchObject({ copied: 0 });
  }, 120_000);

  it("PM9, PM10 searching whole words, accents, from: and to:, newest first, by page; reading a conversation", async () => {
    const w = await setup();
    seedGmail();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z", { folders: [{ id: "Label_1" }, { id: "SENT" }] });
    await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:15:00Z"));
    const search = async (query: string) => (await w.as(jess, async (tx) => searchMyMail(tx, await owner(tx), { query }))).hits.map((hit) => hit.subject);
    expect(await search("paddock twelve")).toEqual(["Re: Soil test results paddock twelve", "Soil test results paddock twelve"]);
    expect(await search("kowhai")).toEqual(["Soil test results paddock twelve"]);
    expect(await search("KŌWHAI dairies")).toEqual(["Soil test results paddock twelve"]);
    expect(await search("from:results@soillab.example")).toEqual(["Soil test results paddock twelve"]);
    expect(await search("to:results@soillab.example")).toEqual(["Re: Soil test results paddock twelve"]);
    expect(await search("results.pdf")).toEqual(["Soil test results paddock twelve"]);
    expect(await search("p12")).toEqual(["Soil test results paddock twelve"]);
    expect(await search("olse")).toEqual([]);
    expect(await search("lime nitrogen")).toEqual([]);
    // Pages of one.
    const first = await w.as(jess, async (tx) => searchMyMail(tx, await owner(tx), { limit: 1 }));
    expect(first.hits.map((hit) => hit.subject)).toEqual(["Draft fertiliser order"]);
    const second = await w.as(jess, async (tx) => searchMyMail(tx, await owner(tx), { limit: 1, before: first.more }));
    expect(second.hits.map((hit) => hit.subject)).toEqual(["Re: Soil test results paddock twelve"]);
    // A conversation, oldest first, with who it was to and its attachments.
    const thread = await w.as(jess, async (tx) => readMyThread(tx, await owner(tx), second.hits[0].id));
    expect(thread.messages.map((message) => [message.subject, message.from?.email, message.to.map((person) => person.email)])).toEqual([
      ["Soil test results paddock twelve", "results@soillab.example", ["jess@kowhaidairies.example"]],
      ["Re: Soil test results paddock twelve", "jess@kowhaidairies.example", ["results@soillab.example"]],
    ]);
    expect(thread.messages[0].text).toContain("Olsen P for paddock twelve is 32");
    expect(thread.messages[0].webLink).toContain("mail.google.com");
  }, 120_000);

  it("PM12, PM13 switching off, disconnecting and reconnecting, and deleting the copy", async () => {
    const w = await setup();
    seedGmail();
    const mailbox = await connect(w, "2026-10-19T09:00:00Z");
    await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T09:15:00Z"));
    // Off: nothing more is copied; what was copied stays.
    await w.as(jess, async (tx) => setCopying(tx, await owner(tx), mailbox.id, false));
    gmail.push({ id: "g8", threadId: "t8", at: "2026-10-19T10:00:00Z", from: lab, subject: "New results", text: "New", labels: ["Label_1"] });
    fetched = [];
    expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id)).toMatchObject({ skipped: "not_copying" });
    expect(fetched).toEqual([]);
    expect(await copyOf(w, mailbox.id)).toMatchObject({ copying: false, copied: 3 });
    // Disconnect: the tokens go; the copy stays, detached.
    await w.as(jess, async (tx) => disconnectMyMailbox(tx, await owner(tx), mailbox.id));
    const detached = await w.as(jess, async (tx) => myMail(tx, await owner(tx)));
    expect(detached.mailboxes).toEqual([]);
    expect(detached.detached).toMatchObject([{ id: mailbox.copy!.id, copying: false, copied: 3 }]);
    expect((await w.as(jess, (tx) => tx.query("select 1 from farm_mail_accounts"))).rowCount).toBe(0);
    // Connecting the same mailbox again carries on the same copy: nothing is copied twice.
    const again = await connect(w, "2026-10-19T11:00:00Z");
    expect(again.copy?.id).toBe(mailbox.copy!.id);
    fetched = [];
    expect(await syncPrivateCopy(w.organisation, mailbox.copy!.id, new Date("2026-10-19T11:15:00Z"))).toEqual({ copied: 1, removed: 0 });
    expect(fetched).toEqual(["g8"]);
    // Delete my copy: every email, attachment and token goes; the connection carries on without a copy.
    await w.as(jess, async (tx) => deleteMyCopy(tx, await owner(tx), mailbox.copy!.id));
    const counts = await w.as(jess, (tx) =>
      tx.query<{ copies: number; messages: number; attachments: number }>(
        "select (select count(*)::int from private_mail_copies) as copies, (select count(*)::int from private_mail_messages) as messages, (select count(*)::int from private_mail_attachments) as attachments",
      ),
    );
    expect(counts.rows[0]).toEqual({ copies: 0, messages: 0, attachments: 0 });
    const after = await w.as(jess, async (tx) => myMail(tx, await owner(tx)));
    expect(after.mailboxes).toMatchObject([{ id: again.id, copy: null }]);
    expect(writes).toEqual([]);
  }, 120_000);

  it("PM14 one connection and one folder choice with the farm calendar, which reads exactly as before", async () => {
    const w = await setup({ farming: true });
    seedGmail();
    gmail.push({ id: "v1", threadId: "v1", at: "2026-10-18T21:00:00Z", from: "Manuka Vets <office@manukavets.example>", subject: "TB testing", text: "We've booked TB testing for Thursday 22 October at 9am.", labels: ["Label_1"] });
    gmail.push({ id: "v2", threadId: "v2", at: "2026-10-18T22:00:00Z", from: "Jess <jess@kowhaidairies.example>", subject: "Herd test", text: "The herd test is booked for Tuesday 27 October.", labels: ["SENT"] });
    // Connected on the farm calendar first, reading Farm.
    const { url } = await w.as(jess, (tx) => startFarmMailConnect(tx, { provider: "google" }, "https://tohyee.test"));
    const claimed = await w.as(jess, (tx) => claimFarmMailState(tx, new URL(url).searchParams.get("state")!));
    const farm = await w.as(jess, async (tx) => saveFarmMailbox(tx, claimed, await fetchFarmMailConnection(claimed, "code", "https://tohyee.test"), new Date("2026-10-19T09:00:00Z")));
    const offered = await mailboxFolderChoices(w.organisation, farm.id);
    await w.as(jess, (tx) => chooseMailboxFolders(tx, farm.id, [{ id: "Label_1" }], offered));
    // The farm calendar's list is as it was: no Sent, Drafts, Spam or Trash.
    expect(offered.map((folder) => folder.id)).toEqual(["INBOX", "Label_3", "Label_1", "Label_2"]);
    // My mail shows the same mailbox and choice; Jess turns the copy on and ticks Sent too.
    const mine = (await w.as(jess, async (tx) => myMail(tx, await owner(tx)))).mailboxes;
    expect(mine).toMatchObject([{ id: farm.id, farmCalendar: true, copy: null, folders: [{ externalId: "Label_1", privateOnly: false }] }]);
    await w.as(jess, async (tx) => setCopying(tx, await owner(tx), farm.id, true));
    const both = await choose(w, farm.id, [{ id: "Label_1" }, { id: "SENT" }]);
    expect(both.folders.map((folder) => [folder.externalId, folder.privateOnly])).toEqual([
      ["Label_1", false],
      ["SENT", true],
    ]);
    // The farm calendar shows and reads only Farm: the herd test in Sent makes no calendar item.
    const listed = await w.as(jess, (tx) => listFarmMailboxes(tx));
    expect(listed).toMatchObject([{ id: farm.id, privateCopy: true, folders: [{ externalId: "Label_1" }] }]);
    expect(listed[0].folders).toHaveLength(1);
    fetched = [];
    await checkFarmMailbox(w.organisation, farm.id, new Date("2026-10-19T09:15:00Z"));
    expect(fetched.sort()).toEqual(["g1", "g2", "g5", "v1"]);
    const calendar = await w.as(jess, (tx) => farmCalendar(tx, { from: "2026-10-19", to: "2026-10-31" }));
    expect(calendar.items.map((item) => item.title)).toContain("TB testing");
    expect(calendar.items.map((item) => item.title)).not.toContain("Herd test");
    // The copy has Farm and Sent.
    fetched = [];
    await syncPrivateCopy(w.organisation, (await copyOf(w, farm.id)).id, new Date("2026-10-19T09:20:00Z"));
    expect(fetched.sort()).toEqual(["g1", "g2", "g5", "v1", "v2"]);
    // Saving folders on the farm calendar leaves Sent ticked for the copy.
    const again = await mailboxFolderChoices(w.organisation, farm.id);
    await w.as(jess, (tx) => chooseMailboxFolders(tx, farm.id, [{ id: "Label_1" }, { id: "INBOX" }], again));
    expect((await w.as(jess, async (tx) => myMail(tx, await owner(tx)))).mailboxes[0].folders.map((folder) => folder.externalId).sort()).toEqual(["INBOX", "Label_1", "SENT"]);
    // A mailbox connected only from My mail isn't read for the farm calendar, and isn't on it.
    const other = await connectOther(w);
    expect((await w.as(jess, (tx) => listFarmMailboxes(tx))).map((mailbox) => mailbox.id)).not.toContain(other);
    expect(await checkFarmMailbox(w.organisation, other, new Date("2026-10-19T09:30:00Z"))).toEqual({ read: 0, items: 0 });
  }, 120_000);

  /** A second mailbox, Outlook, connected from My mail. */
  async function connectOther(w: World): Promise<string> {
    outlook.folders = [{ id: "inbox", displayName: "Inbox", parentFolderId: null }];
    const mailbox = await connect(w, "2026-10-19T09:00:00Z", { provider: "microsoft", folders: [{ id: "inbox" }] });
    return mailbox.id;
  }
});

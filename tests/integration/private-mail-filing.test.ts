import { afterAll, beforeAll, expect, it } from "vitest";
import * as filingRoute from "@/app/api/my-mail/filing/route";
import * as recordsRoute from "@/app/api/my-mail/filing/records/route";
import * as rulesRoute from "@/app/api/my-mail/rules/route";
import * as ruleRoute from "@/app/api/my-mail/rules/[ruleId]/route";
import * as toFileRoute from "@/app/api/my-mail/to-file/[entryId]/route";
import * as inboxRoute from "@/app/api/bills/inbox/route";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listInbox } from "@/lib/bills/inbox";
import { createContact } from "@/lib/contacts/service";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { claimFarmMailState, fetchFarmMailConnection } from "@/lib/farming/calendar";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { listSoilTests } from "@/lib/farming/soil";
import { getOrganisation } from "@/lib/organisations/registry";
import { MailOwner } from "@/lib/private-mail/access";
import { createRule, fileAttachment, filingOverview, previewFiling } from "@/lib/private-mail/filing";
import type { FilingPreview } from "@/lib/private-mail/filing-types";
import { chooseMyFolders, deleteMyCopy, myFolderChoices, readMyThread, savePrivateMailbox, searchMyMail, startMyMailConnect } from "@/lib/private-mail/store";
import { syncPrivateCopy } from "@/lib/private-mail/sync";
import { getRecordExtras } from "@/lib/records/extras";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Filing an attachment from My mail into shared data (#250; PM20-PM29,
 * Claude's rules, not yet reviewed). Gmail is a canned fake with made-up
 * mail. The words in the email's subject, sender and text are looked for
 * in everything another member can see, to show none of it is shared.
 */
const noContext = undefined as unknown;
type Json = Record<string, unknown>;
type Attachment = { id: string; name: string; type: string; content: string };
type Mail = { id: string; threadId: string; at: string; from: string; subject: string; text: string; labels: string[]; attachments: Attachment[] };

const SOIL_CSV = ["Sample Name,Date Sampled,pH,Olsen P (mg/L)", "12,15/08/2026,5.9,28", "14,15/08/2026,6.1,31", "99,15/08/2026,5.5,12"].join("\n");
const PRIVATE_WORDS = ["Confidential results", "soillab", "Rangi", "mortgage", "Board minutes"];

describeWithDatabase("filing from My mail", () => {
  let server: TestServer;
  let jess: SessionUser;
  let ana: SessionUser;
  let mere: SessionUser;
  let sam: SessionUser;
  let organisations = 0;
  let gmail: Mail[] = [];
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const enc = (text: string) => Buffer.from(text).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  const fake = async (input: string): Promise<Response> => {
    const url = new URL(input);
    if (url.host === "oauth2.googleapis.com") return reply({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    if (url.pathname.endsWith("/users/me/profile")) return reply({ emailAddress: "jess@kowhaidairies.example" });
    if (url.pathname.endsWith("/users/me/labels")) return reply({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Farm", type: "user" }] });
    if (url.pathname.endsWith("/users/me/messages")) {
      const label = url.searchParams.get("labelIds");
      return reply({ messages: gmail.filter((mail) => !label || mail.labels.includes(label)).map((mail) => ({ id: mail.id })) });
    }
    const attachment = /\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
    if (attachment) {
      const file = gmail.find((mail) => mail.id === attachment[1])!.attachments.find((entry) => entry.id === attachment[2])!;
      return reply({ data: enc(file.content), size: file.content.length });
    }
    const mail = gmail.find((entry) => entry.id === url.pathname.split("/").pop());
    if (!mail) return new Response("{}", { status: 404 });
    if (url.searchParams.get("format") === "minimal") return reply({ id: mail.id, labelIds: mail.labels });
    return reply({
      id: mail.id,
      threadId: mail.threadId,
      labelIds: mail.labels,
      internalDate: String(Date.parse(mail.at)),
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: mail.from },
          { name: "To", value: "Jess <jess@kowhaidairies.example>" },
          { name: "Subject", value: mail.subject },
        ],
        parts: [
          { partId: "0", mimeType: "text/plain", body: { data: enc(mail.text) } },
          ...mail.attachments.map((file, index) => ({
            partId: String(index + 1),
            mimeType: file.type,
            filename: file.name,
            headers: [{ name: "Content-Disposition", value: `attachment; filename="${file.name}"` }],
            body: { attachmentId: file.id, size: file.content.length },
          })),
        ],
      },
    });
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "private-mail-filing-test-secret-key-0123456789";
    server = await startTestServer();
    jess = await createTestUser("pmf-jess@example.com", { displayName: "Jess" });
    ana = await createTestUser("pmf-ana@example.com", { displayName: "Ana" });
    mere = await createTestUser("pmf-mere@example.com", { displayName: "Mere" });
    sam = await createTestUser("pmf-sam@example.com", { displayName: "Sam" });
    setMailFetchForTests(fake);
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  /** An organisation with Farming on, a farm with paddocks 12 and 14, and Jess's copy of her Farm label. */
  async function setup() {
    organisations += 1;
    const org = `pm-filing-${organisations}`;
    await createTestOrganisation(jess, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'bookkeeper')", [org, ana.id, mere.id, sam.id]);
    const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    await as(jess, (tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await as(jess, (tx) => saveFarm(tx, { name: "Home farm" })))[0];
    for (const name of ["12", "14"]) await as(jess, (tx) => addPaddock(tx, { farmId: farm.id, name, effectiveHa: "4.5" }));
    await as(jess, (tx) => saveMailSettings(tx, { googleClientId: "g.apps.googleusercontent.com", googleClientSecret: "s", microsoftClientId: "m", microsoftClientSecret: "s" }));
    gmail = [
      {
        id: "g1",
        threadId: "t1",
        at: "2026-10-10T21:00:00Z",
        from: "Rangi at the lab <rangi@soillab.example>",
        subject: "Confidential results and your mortgage question",
        text: "Kia ora Jess, results attached. About your mortgage: call me.",
        labels: ["INBOX", "Label_1"],
        attachments: [
          { id: "a-csv", name: "Soil results P12.csv", type: "text/csv", content: SOIL_CSV },
          { id: "a-pdf", name: "Invoice 4471 Rangi.pdf", type: "application/pdf", content: "%PDF-1.4 made-up invoice 4471" },
          { id: "a-board", name: "Board minutes.pdf", type: "application/pdf", content: "%PDF-1.4 made-up minutes" },
        ],
      },
    ];
    const { url } = await as(jess, async (tx) => startMyMailConnect(tx, await MailOwner.of(tx), { provider: "google", historyDays: 90 }, "https://tohyee.test"));
    const claimed = await as(jess, (tx) => claimFarmMailState(tx, new URL(url).searchParams.get("state")!));
    const saved = await as(jess, async (tx) => savePrivateMailbox(tx, claimed, await fetchFarmMailConnection(claimed, "c", "https://tohyee.test"), new Date("2026-10-19T09:00:00Z")));
    const organisation = (await getOrganisation(org))!;
    const available = await myFolderChoices(organisation, saved.id);
    await as(jess, async (tx) => chooseMyFolders(tx, await MailOwner.of(tx), saved.id, [{ id: "Label_1" }], available));
    const copyId = (await as(jess, (tx) => tx.query<{ id: string }>("select id::text from private_mail_copies"))).rows[0].id;
    await syncPrivateCopy(organisation, copyId, new Date("2026-10-19T09:15:00Z"));
    const files = new Map<string, string>();
    const hit = (await as(jess, async (tx) => searchMyMail(tx, await MailOwner.of(tx), {}))).hits[0];
    for (const file of (await as(jess, async (tx) => readMyThread(tx, await MailOwner.of(tx), hit.id))).messages[0].attachments) files.set(file.name, file.id);
    return { org, as, organisation, farm, copyId, files };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  const preview = (w: World, input: Json) => w.as(jess, async (tx) => previewFiling(tx, await MailOwner.of(tx), input as Parameters<typeof previewFiling>[2]));
  const file = (w: World, input: Json, shown: FilingPreview) => w.as(jess, async (tx) => fileAttachment(tx, await MailOwner.of(tx), { ...(input as Parameters<typeof previewFiling>[2]), confirmation: shown.confirmation }));
  const leaks = (value: unknown) => PRIVATE_WORDS.filter((word) => JSON.stringify(value).toLowerCase().includes(word.toLowerCase()));

  it("PM20 filing into the bills inbox: the preview shows exactly what's shared, and nothing of the email is", async () => {
    const w = await setup();
    const input = { attachmentId: w.files.get("Invoice 4471 Rangi.pdf"), destination: { kind: "bills_inbox" }, fileName: "Invoice 4471.pdf", note: "Lab invoice for the September tests" };
    const shown = await preview(w, input);
    expect(shown.problem).toBeNull();
    expect(shown.sharesFile).toBe(true);
    expect(shown.shared).toEqual([
      { label: "File", value: "Invoice 4471.pdf (29 bytes)" },
      { label: "Where", value: "The bills inbox, waiting for a bill to be made from it" },
      { label: "Added by", value: "pmf-jess@example.com" },
      { label: "How it arrived", value: "Filed from a private email by you (nothing of the email is shared)" },
      { label: "Note, by you", value: "Lab invoice for the September tests" },
    ]);
    expect(shown.notShared).toEqual([
      "The email's subject, sender, recipients, date and text",
      "The email's other 2 attachments",
      "Which mailbox and folder it came from",
      "The attachment's own name (Invoice 4471 Rangi.pdf)",
    ]);
    // Nothing is saved by a preview.
    expect(await w.as(sam, (tx) => listInbox(tx))).toEqual([]);
    const filed = await file(w, input, shown);
    expect(filed).toMatchObject({ destinationLabel: "The bills inbox", link: "/operations/bills/inbox", summary: expect.stringMatching(/^In the bills inbox as item \d+$/) });

    // Sam, the bookkeeper, sees the copy: who filed it and the note, nothing of the email.
    const cookie = await sessionCookieFor(sam);
    const listed = (await (await inboxRoute.GET(apiRequest(`/api/bills/inbox?organisationId=${w.org}`, { cookie }), noContext)).json()) as { items: Json[] };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ source: "my_mail", fileName: "Invoice 4471.pdf", emailFrom: null, emailSubject: null, emailDate: null, note: "Lab invoice for the September tests", createdByEmail: "pmf-jess@example.com" });
    expect(leaks(listed)).toEqual([]);
    // The audit trail says a file was filed and where to, no more.
    const audit = await w.as(sam, (tx) => tx.query<{ event_type: string; details: unknown }>("select event_type, details from audit_events order by id"));
    expect(audit.rows.find((row) => row.event_type === "private_mail.attachment_filed")?.details).toEqual({ destination: "bills_inbox" });
    expect(leaks(audit.rows)).toEqual([]);
  });

  it("PM21 soil test results: the soil import's own preview and checks, rows only, marked as filed from a private email", async () => {
    const w = await setup();
    const input = { attachmentId: w.files.get("Soil results P12.csv"), destination: { kind: "soil_tests", farmId: w.farm.id, lab: "Made-up Labs" }, fileName: "Soil results.csv" };
    const shown = await preview(w, input);
    expect(shown.problem).toBeNull();
    expect(shown.sharesFile).toBe(false);
    expect(shown.noteAllowed).toBe(false);
    expect(shown.table!.rows).toEqual([
      { cells: ["2", "12", "2026-08-15", "12", "2"], error: null },
      { cells: ["3", "14", "2026-08-15", "14", "2"], error: null },
      { cells: ["4", "99", "2026-08-15", "99", "2"], error: "There's no current paddock 99 on this farm." },
    ]);
    expect(shown.shared).toContainEqual({ label: "Soil tests added", value: "2 (1 row with problems left out)" });
    expect(shown.shared).toContainEqual({ label: "Results read from", value: "pH, Olsen P (mg/L)" });
    expect(shown.shared).toContainEqual({ label: "Source on each test", value: "Imported from Soil results.csv, filed from a private email" });
    expect(shown.notShared).toContain("The file itself: only the rows below are added");
    // A note can't go with an import.
    expect((await preview(w, { ...input, note: "hi" })).problem).toBe("A note can't go with an import. Add one on the records afterwards.");
    expect(await file(w, input, shown)).toMatchObject({ summary: "2 soil tests added", link: "/operations/farming/soil" });
    const tests = await w.as(sam, (tx) => listSoilTests(tx, { farmId: w.farm.id }));
    expect(tests.map((test) => [test.paddockName, test.lab, test.source]).sort()).toEqual([
      ["12", "Made-up Labs", "Imported from Soil results.csv, filed from a private email"],
      ["14", "Made-up Labs", "Imported from Soil results.csv, filed from a private email"],
    ]);
    expect(leaks(tests)).toEqual([]);
    // The same checks as the import page: the same file again is refused, in the preview.
    expect((await preview(w, input)).problem).toMatch(/^This file was already imported into this farm's soil tests on \d{4}-\d\d-\d\d\.$/);
    // A PDF can't be imported; it's said in the preview, not as an error.
    expect((await preview(w, { ...input, attachmentId: w.files.get("Board minutes.pdf"), fileName: undefined })).problem).toBe(
      "Only CSV or Excel (.xlsx) files can be imported. To keep a PDF or picture, attach it to a record instead.",
    );
  });

  it("PM22 the file name: the attachment's own, or the owner's choice with the same ending", async () => {
    const w = await setup();
    const base = { attachmentId: w.files.get("Invoice 4471 Rangi.pdf"), destination: { kind: "bills_inbox" } };
    expect((await preview(w, base)).fileName).toBe("Invoice 4471 Rangi.pdf");
    expect((await preview(w, base)).notShared).not.toContain("The attachment's own name (Invoice 4471 Rangi.pdf)");
    expect((await preview(w, { ...base, fileName: "Invoice.txt" })).problem).toBe("Keep the file's ending (.pdf), so it's still the same kind of file.");
    expect((await preview(w, { ...base, fileName: "a/b.pdf" })).problem).toBe("The file name can't have slashes or control characters.");
  });

  it("PM23 attaching to an existing record, with a note the owner chose", async () => {
    const w = await setup();
    const contact = (await w.as(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Made-up Soil Labs Ltd", isSupplier: true }))).contact;
    const found = await w.as(jess, async (tx) => (await import("@/lib/private-mail/filing")).searchFilingRecords(tx, await MailOwner.of(tx), { type: "contact", query: "soil labs" }));
    expect(found).toEqual([{ id: contact.id, label: "Made-up Soil Labs Ltd" }]);
    const input = { attachmentId: w.files.get("Invoice 4471 Rangi.pdf"), destination: { kind: "record", recordType: "contact", recordId: contact.id }, fileName: "Invoice 4471.pdf", note: "Their September invoice" };
    const shown = await preview(w, input);
    expect(shown.shared).toEqual([
      { label: "File", value: "Invoice 4471.pdf (29 bytes)" },
      { label: "On", value: "Made-up Soil Labs Ltd" },
      { label: "Added by", value: "pmf-jess@example.com" },
      { label: "How it arrived", value: "Filed from a private email (shown on the file and in the record's history)" },
      { label: "Note on the record, by you", value: "Their September invoice" },
    ]);
    await file(w, input, shown);
    const extras = await w.as(sam, (tx) => getRecordExtras(tx, "bookkeeper", "contact", contact.id));
    expect(extras.attachments.map((entry) => [entry.fileName, entry.filedFromPrivateMail, entry.createdByEmail])).toEqual([["Invoice 4471.pdf", true, "pmf-jess@example.com"]]);
    expect(extras.notes.map((note) => note.body)).toEqual(["Their September invoice"]);
    expect(extras.history.map((entry) => entry.summary)).toContain("File added: Invoice 4471.pdf (29 bytes), filed from a private email");
    expect(leaks(extras)).toEqual([]);
  });

  it("PM24 what's filed is what was previewed: a change since is refused", async () => {
    const w = await setup();
    const input = { attachmentId: w.files.get("Invoice 4471 Rangi.pdf"), destination: { kind: "bills_inbox" }, note: "One" };
    const shown = await preview(w, input);
    await expect(file(w, { ...input, note: "Two" }, shown)).rejects.toThrow("What would be filed has changed since the preview.");
    await expect(file(w, { ...input, fileName: "Other.pdf" }, shown)).rejects.toThrow("What would be filed has changed since the preview.");
    await expect(w.as(jess, async (tx) => fileAttachment(tx, await MailOwner.of(tx), { ...input, confirmation: "x" }))).rejects.toThrow("changed since the preview");
    expect(await w.as(sam, (tx) => listInbox(tx))).toEqual([]);
  });

  it("PM25 nobody but the copy's owner can preview, file, see what's filed, make rules or dismiss: other Owners, admins and bookkeepers get 'not found'", async () => {
    const w = await setup();
    const attachmentId = w.files.get("Invoice 4471 Rangi.pdf");
    const input = { attachmentId, destination: { kind: "bills_inbox" } };
    const shown = await preview(w, input);
    await file(w, input, shown);
    const rules = await w.as(jess, async (tx) => createRule(tx, await MailOwner.of(tx), { copyId: w.copyId, sender: "@soillab.example", destination: { kind: "bills_inbox" }, includeExisting: true }));
    const overview = await w.as(jess, async (tx) => filingOverview(tx, await MailOwner.of(tx)));
    const entry = overview.toFile[0];
    for (const user of [ana, mere, sam]) {
      const cookie = await sessionCookieFor(user);
      const calls: Array<[string, Promise<Response>]> = [
        ["overview", filingRoute.GET(apiRequest(`/api/my-mail/filing?organisationId=${w.org}`, { cookie }), noContext)],
        ["preview", filingRoute.POST(apiRequest("/api/my-mail/filing", { method: "POST", cookie, body: { organisationId: w.org, ...input, preview: true } }), noContext)],
        ["file", filingRoute.POST(apiRequest("/api/my-mail/filing", { method: "POST", cookie, body: { organisationId: w.org, ...input, confirmation: shown.confirmation } }), noContext)],
        ["records", recordsRoute.POST(apiRequest("/api/my-mail/filing/records", { method: "POST", cookie, body: { organisationId: w.org, type: "contact" } }), noContext)],
        ["rule", rulesRoute.POST(apiRequest("/api/my-mail/rules", { method: "POST", cookie, body: { organisationId: w.org, copyId: w.copyId, sender: "@x.example", destination: { kind: "bills_inbox" } } }), noContext)],
        ["delete rule", ruleRoute.DELETE(apiRequest(`/api/my-mail/rules/${rules[0].id}?organisationId=${w.org}`, { method: "DELETE", cookie }), params({ ruleId: rules[0].id }))],
        ["dismiss", toFileRoute.DELETE(apiRequest(`/api/my-mail/to-file/${entry.id}?organisationId=${w.org}`, { method: "DELETE", cookie }), params({ entryId: entry.id }))],
      ];
      for (const [name, call] of calls) {
        const response = await call;
        const body = (await response.json()) as Json;
        // Ana is an Owner too: she gets her own Filing card (empty) and can search records, never Jess's.
        const own = user === ana && (name === "overview" || name === "records");
        expect([user.email, name, response.status]).toEqual([user.email, name, own ? 200 : 404]);
        if (own && name === "overview") expect([body.filed, body.rules, body.toFile]).toEqual([[], [], []]);
        expect(leaks(body)).toEqual([]);
      }
    }
    // Still Jess's, untouched.
    const after = await w.as(jess, async (tx) => filingOverview(tx, await MailOwner.of(tx)));
    expect([after.rules.length, after.toFile.length, after.filed.length]).toEqual([1, 3, 1]);
    // An AI key acting as Jess can't file either.
    await expect(inOrganisation(w.org, { userId: jess.id, email: jess.email, via: 'AI key "Claude"' }, async (tx) => previewFiling(tx, await MailOwner.of(tx), input))).rejects.toThrow("Not found.");
  });

  it("PM26 a rule approved once puts matches in To file; nothing is shared until the owner files each one", async () => {
    const w = await setup();
    const cookie = await sessionCookieFor(jess);
    const made = await rulesRoute.POST(
      apiRequest("/api/my-mail/rules", { method: "POST", cookie, body: { organisationId: w.org, copyId: w.copyId, sender: "@SoilLab.example", fileName: "*.csv", destination: { kind: "soil_tests", farmId: w.farm.id, lab: "Made-up Labs" }, includeExisting: true } }),
      noContext,
    );
    expect(made.status).toBe(201);
    const overview = ((await (await filingRoute.GET(apiRequest(`/api/my-mail/filing?organisationId=${w.org}`, { cookie }), noContext)).json()) as { rules: Json[]; toFile: Json[] });
    expect(overview.rules).toEqual([expect.objectContaining({ sender: "@soillab.example", fileName: "*.csv", destinationLabel: "Soil tests on Home farm", waiting: 1 })]);
    expect(overview.toFile).toEqual([
      expect.objectContaining({ fileName: "Soil results P12.csv", ruleText: "Attachments from anyone at soillab.example named *.csv", destinationLabel: "Soil tests on Home farm", subject: "Confidential results and your mortgage question" }),
    ]);
    // Nothing was filed by the rule.
    expect(await w.as(sam, (tx) => listSoilTests(tx, { farmId: w.farm.id }))).toEqual([]);
    // The rule's sender and pattern are encrypted, like the mail.
    const stored = await w.as(jess, (tx) => tx.query<{ count: number }>("select count(*)::int as count from private_mail_rules where position(convert_to('soillab', 'UTF8') in criteria) > 0 or position(convert_to('*.csv', 'UTF8') in criteria) > 0"));
    expect(stored.rows[0].count).toBe(0);
    // Jess previews and files it from To file.
    const entry = overview.toFile[0] as { id: string; attachmentId: string; destination: Json };
    const input = { attachmentId: entry.attachmentId, destination: entry.destination };
    const shown = await preview(w, input);
    await w.as(jess, async (tx) => fileAttachment(tx, await MailOwner.of(tx), { ...input, confirmation: shown.confirmation, toFileId: entry.id }));
    const after = await w.as(jess, async (tx) => filingOverview(tx, await MailOwner.of(tx)));
    expect(after.toFile).toEqual([]);
    expect(after.filed).toEqual([expect.objectContaining({ fileName: "Soil results P12.csv", summary: "2 soil tests added", byRule: true })]);
    expect((await w.as(sam, (tx) => listSoilTests(tx, { farmId: w.farm.id }))).length).toBe(2);
    // Without "also look at emails already copied", a new rule waits for new mail.
    await w.as(jess, async (tx) => createRule(tx, await MailOwner.of(tx), { copyId: w.copyId, fileName: "*.pdf", destination: { kind: "bills_inbox" } }));
    expect((await w.as(jess, async (tx) => filingOverview(tx, await MailOwner.of(tx)))).toFile).toEqual([]);
    // Refused: no sender or pattern, a sender that isn't one.
    await expect(w.as(jess, async (tx) => createRule(tx, await MailOwner.of(tx), { copyId: w.copyId, destination: { kind: "bills_inbox" } }))).rejects.toThrow("A rule needs a sender, a file name pattern, or both.");
    await expect(w.as(jess, async (tx) => createRule(tx, await MailOwner.of(tx), { copyId: w.copyId, sender: "not an address", destination: { kind: "bills_inbox" } }))).rejects.toThrow("The sender must be an email address");
  });

  it("PM27 rules run after each sync; 'Not this one' takes a match off without filing it", async () => {
    const w = await setup();
    await w.as(jess, async (tx) => createRule(tx, await MailOwner.of(tx), { copyId: w.copyId, fileName: "*.pdf", destination: { kind: "bills_inbox" } }));
    gmail.push({ id: "g2", threadId: "t2", at: "2026-10-19T08:00:00Z", from: "Supplier <accounts@supplier.example>", subject: "October statement", text: "Attached.", labels: ["Label_1"], attachments: [{ id: "s1", name: "Statement.pdf", type: "application/pdf", content: "%PDF-1.4 made-up statement" }] });
    await syncPrivateCopy(w.organisation, w.copyId, new Date("2026-10-19T09:30:00Z"));
    const overview = await w.as(jess, async (tx) => filingOverview(tx, await MailOwner.of(tx)));
    expect(overview.toFile.map((entry) => entry.fileName)).toEqual(["Statement.pdf"]);
    expect(await w.as(sam, (tx) => listInbox(tx))).toEqual([]);
    const cookie = await sessionCookieFor(jess);
    const response = await toFileRoute.DELETE(apiRequest(`/api/my-mail/to-file/${overview.toFile[0].id}?organisationId=${w.org}`, { method: "DELETE", cookie }), params({ entryId: overview.toFile[0].id }));
    expect(response.status).toBe(200);
    expect((await w.as(jess, async (tx) => filingOverview(tx, await MailOwner.of(tx)))).toFile).toEqual([]);
    // A later sync doesn't bring it back.
    await syncPrivateCopy(w.organisation, w.copyId, new Date("2026-10-19T09:45:00Z"));
    expect((await w.as(jess, async (tx) => filingOverview(tx, await MailOwner.of(tx)))).toFile).toEqual([]);
    expect(await w.as(sam, (tx) => listInbox(tx))).toEqual([]);
  });

  it("PM28 filed items are copies: deleting the private copy leaves them; the owner's record of filing goes with it", async () => {
    const w = await setup();
    const inbox = { attachmentId: w.files.get("Invoice 4471 Rangi.pdf"), destination: { kind: "bills_inbox" } };
    await file(w, inbox, await preview(w, inbox));
    const soil = { attachmentId: w.files.get("Soil results P12.csv"), destination: { kind: "soil_tests", farmId: w.farm.id } };
    await file(w, soil, await preview(w, soil));
    await w.as(jess, async (tx) => createRule(tx, await MailOwner.of(tx), { copyId: w.copyId, fileName: "*", destination: { kind: "bills_inbox" }, includeExisting: true }));
    await w.as(jess, async (tx) => deleteMyCopy(tx, await MailOwner.of(tx), w.copyId));
    const items = await w.as(sam, (tx) => listInbox(tx));
    expect(items.map((item) => [item.fileName, item.source])).toEqual([["Invoice 4471 Rangi.pdf", "my_mail"]]);
    const content = await w.as(sam, (tx) => tx.query<{ ok: boolean }>("select content is not null as ok from bill_inbox_items"));
    expect(content.rows[0].ok).toBe(true);
    expect((await w.as(sam, (tx) => listSoilTests(tx, { farmId: w.farm.id }))).length).toBe(2);
    const left = await w.as(jess, (tx) => tx.query<{ filings: number; rules: number; waiting: number }>("select (select count(*)::int from private_mail_filings) as filings, (select count(*)::int from private_mail_rules) as rules, (select count(*)::int from private_mail_to_file) as waiting"));
    expect(left.rows[0]).toEqual({ filings: 0, rules: 0, waiting: 0 });
  });

  it("PM29 an owner who stops being an Owner can't file; made an Owner again, they can", async () => {
    const w = await setup();
    const input = { attachmentId: w.files.get("Invoice 4471 Rangi.pdf"), destination: { kind: "bills_inbox" } };
    const shown = await preview(w, input);
    const anaCookie = await sessionCookieFor(ana);
    const demote = await memberRoute.PATCH(apiRequest(`/api/organisations/${w.org}/members/${jess.id}`, { method: "PATCH", cookie: anaCookie, body: { role: "admin" } }), params({ organisationId: w.org, userId: jess.id }));
    expect(demote.status).toBe(200);
    await expect(file(w, input, shown)).rejects.toThrow("Not found.");
    await coreQuery("update organisation_members set role = 'owner' where organisation_id = $1 and user_id = $2", [w.org, jess.id]);
    await file(w, input, shown);
    expect((await w.as(sam, (tx) => listInbox(tx))).length).toBe(1);
  });
});

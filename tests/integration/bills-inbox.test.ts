import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as approveRoute from "@/app/api/bills/[billId]/approve/route";
import * as billRoute from "@/app/api/bills/[billId]/route";
import * as inboxRoute from "@/app/api/bills/inbox/route";
import * as fileRoute from "@/app/api/bills/inbox/[itemId]/file/route";
import * as removeRoute from "@/app/api/bills/inbox/[itemId]/remove/route";
import * as mailboxCheckRoute from "@/app/api/bills/inbox/mailboxes/[mailboxId]/check/route";
import * as billsRoute from "@/app/api/bills/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { setMailHostResolverForTests } from "@/lib/analytics/mail-host";
import type { SessionUser } from "@/lib/auth/sessions";
import type { DuplicateWarning } from "@/lib/bills/duplicates";
import { getInboxItemContent, type InboxItem, listInbox, removeInboxItem } from "@/lib/bills/inbox";
import { checkInboxMailbox, createInboxMailbox, listInboxMailboxes } from "@/lib/bills/inbox-mailbox";
import { approveBill, type Bill, createBill, deleteBill, getBill } from "@/lib/bills/service";
import { createContact, type Contact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation } from "@/lib/organisations/registry";
import { getRecordExtras } from "@/lib/records/extras";
import { createRepeatingBill, runRepeatingBills } from "@/lib/repeating/bills";
import { encryptSecret } from "@/lib/secrets";
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

const mocks = vi.hoisted(() => ({
  messages: [] as Array<{
    id: string;
    receivedAt: string | null;
    from?: string | null;
    subject?: string | null;
    attachments: Array<{ name: string; size: number; read: () => Promise<Buffer> }>;
  }>,
}));
vi.mock("@/lib/crm/mail/service", async (original) => ({
  ...(await original<object>()),
  reportMailboxToken: vi.fn(async () => ({ provider: "google", token: "test-token" })),
}));
vi.mock("@/lib/analytics/report-email-providers", () => ({
  listReportFolders: vi.fn(async () => [{ id: "Label_9", name: "Bills" }]),
  listImapFolders: vi.fn(async () => [{ id: "INBOX", name: "Inbox" }]),
  reportMessages: async function* () {
    yield* mocks.messages;
  },
  imapReportMessages: async function* () {
    yield* mocks.messages;
  },
}));

const noContext = undefined as unknown;
type Json = Record<string, unknown>;

/** Small files whose contents match their names (NF8). */
function fileBytes(kind: "pdf" | "jpg" | "png", seed: string): Uint8Array {
  const head = { pdf: Buffer.from("%PDF-1.7\n", "latin1"), jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }[kind];
  return new Uint8Array(Buffer.concat([head, Buffer.from(`${seed}`.padEnd(200, "."))]));
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const K200 = fileBytes("pdf", "Kauri Supplies tax invoice K-200");
const CAFE = fileBytes("jpg", "Cafe receipt");
const K201 = fileBytes("pdf", "Kauri Supplies tax invoice K-201");
const LOGO = fileBytes("png", "Kauri logo");

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown): Promise<Json> {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: rpcParams }),
    }),
    noContext,
  );
  return (await response.json()) as Json;
}
type Content = { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri: string; mimeType: string; blob: string } };
async function callTool(token: string, name: string, args: Json = {}) {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: Content[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return { data: JSON.parse(result.content[0].text!) as Json, content: result.content };
}

/**
 * Examples BI1-BI7 and DU1-DU5 in docs/ACCOUNTING-EXAMPLES.md ("Bills inbox,
 * reading documents, duplicate bills and mileage"). Kauri Supplies is a
 * supplier; Jess is the owner with a connected AI key "Claude" at the draft
 * level; Mere is a bookkeeper. The examples build on each other.
 */
describeWithDatabase("bills inbox and duplicate bills (BI1-BI7, DU1-DU5)", () => {
  const org = "bills-inbox-co";
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let viewer: SessionUser;
  const cookies = new Map<string, string>();
  let kauri: Contact;
  let kauriLimited: Contact;
  let claude = "";
  let lookOnly = "";
  const items: Record<string, InboxItem> = {};
  let k200: Bill;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
  const journals = async () => Number((await asUser(jess, (tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
  const waiting = async () => (await asUser(viewer, (tx) => listInbox(tx))).map((item) => item.fileName);

  async function upload(user: SessionUser, fileName: string, content: Uint8Array, idempotencyKey = key("inbox")) {
    const form = new FormData();
    form.set("organisationId", org);
    form.set("source", "ui");
    form.set("idempotencyKey", idempotencyKey);
    form.set("file", new File([new Uint8Array(content)], fileName));
    const encoded = new Response(form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const response = await inboxRoute.POST(
      new Request("http://tohyee.test/api/bills/inbox", {
        method: "POST",
        headers: {
          cookie: cookies.get(user.email)!,
          origin: "http://tohyee.test",
          "content-type": encoded.headers.get("content-type")!,
          "content-length": String(bytes.length),
        },
        body: bytes,
      }),
      noContext,
    );
    return { status: response.status, body: (await response.json()) as Json };
  }

  async function billDetails(user: SessionUser, billId: string) {
    const response = await billRoute.GET(apiRequest(`/api/bills/${billId}?organisationId=${org}`, { cookie: cookies.get(user.email) }), params({ billId }));
    return (await response.json()) as { bill: Bill; fromInbox: { id: string; fileName: string } | null; duplicateWarnings: DuplicateWarning[] };
  }

  const kauriBill = (fields: Record<string, unknown> = {}) => ({
    contactId: kauri.id,
    billDate: "2026-10-01",
    dueDate: "2026-10-20",
    supplierInvoiceNumber: "K-200",
    amountsMode: "exclusive",
    lines: [{ description: "Supplies", quantity: "1", unitPrice: "200.00", accountCode: "6010", taxCode: "GST" }],
    ...fields,
  });

  async function makeKey(name: string, accessLevel: string) {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: cookies.get(jess.email), body: { organisationId: org, name, accessLevel } }),
      noContext,
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setMailHostResolverForTests(async () => ["203.0.113.10"]);
    server = await startTestServer();
    jess = await createTestUser("bi-jess@example.com", { serverAdmin: true, displayName: "Jess" });
    mere = await createTestUser("bi-mere@example.com", { displayName: "Mere" });
    viewer = await createTestUser("bi-viewer@example.com");
    await createTestOrganisation(jess, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [org, mere.id, viewer.id]);
    for (const user of [jess, mere, viewer]) cookies.set(user.email, await sessionCookieFor(user));
    kauri = (await asUser(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kauri Supplies", isSupplier: true }))).contact;
    kauriLimited = (await asUser(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kauri Supplies Limited", isSupplier: true }))).contact;
    claude = await makeKey("Claude", "draft");
    lookOnly = await makeKey("Look only", "read");
  });

  afterAll(async () => {
    setMailHostResolverForTests(null);
    await server?.teardown();
  });

  it("BI1: uploaded files wait in the inbox with who uploaded them; nothing is posted", async () => {
    const before = await journals();
    const first = await upload(jess, "kauri-K-200.pdf", K200);
    expect(first.status).toBe(201);
    items.k200 = (first.body as { item: InboxItem }).item;
    const retryKey = key("inbox");
    items.cafe = ((await upload(jess, "cafe.jpg", CAFE, retryKey)).body as { item: InboxItem }).item;
    // A retry with the same key is the same item.
    const retried = await upload(jess, "cafe.jpg", CAFE, retryKey);
    expect([retried.status, (retried.body as { item: InboxItem }).item.id]).toEqual([200, items.cafe.id]);
    const listed = await asUser(viewer, (tx) => listInbox(tx));
    expect(listed.map((item) => [item.fileName, item.status, item.source, item.createdByEmail, item.contentType, item.sha256])).toEqual([
      ["kauri-K-200.pdf", "waiting", "upload", jess.email, "application/pdf", sha(K200)],
      ["cafe.jpg", "waiting", "upload", jess.email, "image/jpeg", sha(CAFE)],
    ]);
    // Only the kinds of file a bill has, whose contents match their names.
    expect((await upload(jess, "terms.docx", K200)).body.error).toMatch(/only PDF, JPG, PNG and HEIC|doesn't look like/);
    expect((await upload(jess, "fake.pdf", fileBytes("png", "not a pdf"))).body.error).toMatch(/doesn't look like a PDF/);
    expect((await upload(viewer, "viewer.pdf", K200)).status).toBe(403);
    expect(await journals()).toBe(before);
    // The file itself can be opened.
    const file = await fileRoute.GET(apiRequest(`/api/bills/inbox/${items.k200.id}/file?organisationId=${org}`, { cookie: cookies.get(viewer.email) }), params({ itemId: items.k200.id }));
    expect([file.status, sha(new Uint8Array(await file.arrayBuffer()))]).toEqual([200, sha(K200)]);
  });

  it("BI2: a mailbox label adds each email's PDF and picture attachments once, with the sender and subject; other files are ignored", async () => {
    const mailAccountId = await asUser(jess, async (tx) => {
      await tx.query("update organisation_settings set crm_enabled = true");
      const inserted = await tx.query<{ id: string }>(
        `insert into crm_connected_accounts (user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at)
         values ($1, 'google', $2, $3, $3, now() + interval '1 hour') returning id::text`,
        [jess.id, jess.email, encryptSecret("refresh-token")],
      );
      return inserted.rows[0].id;
    });
    const mailbox = await asUser(jess, (tx) => createInboxMailbox(tx, { mailKind: "crm", mailAccountId, mailFolderId: "Label_9", mailFolderName: "Bills" }));
    expect(mailbox).toMatchObject({ mailKind: "crm", mailAccountEmail: jess.email, mailFolderName: "Bills", syncEveryHours: 1, yours: true });
    await expect(asUser(jess, (tx) => createInboxMailbox(tx, { mailKind: "crm", mailAccountId, mailFolderId: "Label_9", mailFolderName: "Bills" }))).rejects.toThrow(
      "already reads that folder",
    );
    const attachment = (name: string, bytes: Uint8Array) => ({ name, size: bytes.length, read: vi.fn(async () => Buffer.from(bytes)) });
    const docx = attachment("terms.docx", K201);
    mocks.messages = [
      {
        id: "m1",
        receivedAt: "2026-10-03T21:00:00Z",
        from: "Kauri Accounts <accounts@kauri.co.nz>",
        subject: "Invoice K-201",
        attachments: [attachment("K-201.pdf", K201), attachment("logo.png", LOGO), docx, attachment("broken.pdf", fileBytes("jpg", "not a pdf"))],
      },
      { id: "m2", receivedAt: "2026-10-03T22:00:00Z", from: "news@example.com", subject: "Newsletter", attachments: [] },
    ];
    const organisation = (await getOrganisation(org))!;
    const check = await checkInboxMailbox(organisation, { userId: mere.id, email: mere.email }, mailbox.id);
    expect(check).toMatchObject({ status: "ok", filesAdded: 2, filesSkipped: 1, error: null });
    expect(docx.read).not.toHaveBeenCalled();
    const fromMail = (await asUser(viewer, (tx) => listInbox(tx))).filter((item) => item.source === "mailbox");
    expect(fromMail.map((item) => [item.fileName, item.emailFrom, item.emailSubject, item.emailDate, item.createdByEmail])).toEqual([
      ["K-201.pdf", "Kauri Accounts <accounts@kauri.co.nz>", "Invoice K-201", "2026-10-03T21:00:00.000Z", jess.email],
      ["logo.png", "Kauri Accounts <accounts@kauri.co.nz>", "Invoice K-201", "2026-10-03T21:00:00.000Z", jess.email],
    ]);
    [items.k201, items.logo] = fromMail;
    // Each message is read once.
    const again = await mailboxCheckRoute.POST(
      apiRequest(`/api/bills/inbox/mailboxes/${mailbox.id}/check`, { method: "POST", cookie: cookies.get(mere.email), body: { organisationId: org } }),
      params({ mailboxId: mailbox.id }),
    );
    expect(((await again.json()) as { check: Json }).check).toMatchObject({ status: "ok", filesAdded: 0, filesSkipped: 0 });
    expect((await asUser(viewer, (tx) => listInboxMailboxes(tx)))[0]).toMatchObject({ lastStatus: "ok", lastFilesAdded: 0 });
    // A viewer can't check it.
    const denied = await mailboxCheckRoute.POST(
      apiRequest(`/api/bills/inbox/mailboxes/${mailbox.id}/check`, { method: "POST", cookie: cookies.get(viewer.email), body: { organisationId: org } }),
      params({ mailboxId: mailbox.id }),
    );
    expect(denied.status).toBe(403);
    // IMAP: the app password is stored encrypted, never shown.
    const imap = await asUser(jess, (tx) =>
      createInboxMailbox(tx, { mailKind: "imap", imapHost: "imap.gmail.com", imapUsername: "bills@kobe.co.nz", imapPassword: "app-password-7", mailFolderId: "INBOX", mailFolderName: "Inbox" }),
    );
    expect(JSON.stringify(imap)).not.toContain("app-password-7");
    const stored = await asUser(jess, (tx) => tx.query<{ imap_password_ciphertext: string }>("select imap_password_ciphertext from bill_inbox_mailboxes where id = $1", [imap.id]));
    expect(stored.rows[0].imap_password_ciphertext).not.toContain("app-password-7");
  });

  it("BI3, BI5: a bookkeeper makes a bill from an item by hand: the file is attached and the item leaves the waiting list", async () => {
    const idempotencyKey = key("bill");
    const post = (itemId: string, keyToUse: string, fields: Record<string, unknown> = {}) =>
      billsRoute.POST(
        apiRequest("/api/bills", { method: "POST", cookie: cookies.get(mere.email), body: { organisationId: org, source: "ui", idempotencyKey: keyToUse, inboxItemId: itemId, ...kauriBill(fields) } }),
        noContext,
      );
    const made = await post(items.k200.id, idempotencyKey);
    expect(made.status).toBe(201);
    const result = (await made.json()) as { bill: Bill; item: InboxItem };
    k200 = result.bill;
    expect([k200.status, k200.total, k200.taxTotal, k200.supplierInvoiceNumber]).toEqual(["draft", "230.00", "30.00", "K-200"]);
    expect([result.item.status, result.item.billId, result.item.billNumber, result.item.madeByEmail]).toEqual(["made", k200.id, "K-200", mere.email]);
    // A retry is the same bill, with one copy of the file.
    const retried = await post(items.k200.id, idempotencyKey);
    expect([retried.status, ((await retried.json()) as { bill: Bill }).bill.id]).toEqual([200, k200.id]);
    const extras = await asUser(mere, (tx) => getRecordExtras(tx, "bookkeeper", "bill", k200.id));
    expect(extras.attachments.map((file) => [file.fileName, file.sha256])).toEqual([["kauri-K-200.pdf", sha(K200)]]);
    expect(extras.history.map((entry) => entry.summary)).toContain(`Made from bills inbox item ${items.k200.id} (kauri-K-200.pdf)`);
    expect((await billDetails(viewer, k200.id)).fromInbox).toEqual({ id: items.k200.id, fileName: "kauri-K-200.pdf" });
    // An item makes one bill.
    const twice = await post(items.k200.id, key("bill"), { supplierInvoiceNumber: "K-200B" });
    expect([twice.status, ((await twice.json()) as Json).error]).toEqual([409, "This item was already made into draft bill K-200."]);
    // Approving posts as for any bill (B1-B3).
    const approved = (await asUser(mere, (tx) => approveBill(tx, k200.id, { idempotencyKey: key("approve") }))).bill;
    expect(approved.status).toBe("approved");
    expect(await waiting()).toEqual(["cafe.jpg", "K-201.pdf", "logo.png"]);

    // Deleting a draft made from an item puts the item back on the waiting list.
    const cafeBill = (await (await post(items.cafe.id, key("bill"), { supplierInvoiceNumber: "CAFE-1", lines: [{ description: "Coffee", quantity: "1", unitPrice: "10.00", accountCode: "6010", taxCode: "GST" }] })).json()) as { bill: Bill };
    expect(await waiting()).toEqual(["K-201.pdf", "logo.png"]);
    await asUser(mere, (tx) => deleteBill(tx, cafeBill.bill.id));
    expect(await waiting()).toEqual(["cafe.jpg", "K-201.pdf", "logo.png"]);
    expect((await asUser(viewer, (tx) => listInbox(tx))).find((item) => item.id === items.cafe.id)).toMatchObject({ status: "waiting", madeByEmail: null, billId: null });
  });

  it("BI4: Jess's AI lists the inbox, reads K-201.pdf and makes the draft with the file attached; nothing is posted", async () => {
    const before = await journals();
    const listed = await callTool(claude, "list_bill_inbox");
    expect((listed.data.items as Json[]).map((item) => [item.fileName, item.emailFrom])).toEqual([
      ["cafe.jpg", null],
      ["K-201.pdf", "Kauri Accounts <accounts@kauri.co.nz>"],
      ["logo.png", "Kauri Accounts <accounts@kauri.co.nz>"],
    ]);
    const read = await callTool(claude, "read_bill_inbox_item", { itemId: items.k201.id });
    expect((read.data.item as Json).fileName).toBe("K-201.pdf");
    expect(read.content[1]).toEqual({
      type: "resource",
      resource: { uri: `tohyee://bills-inbox/${items.k201.id}/K-201.pdf`, mimeType: "application/pdf", blob: Buffer.from(K201).toString("base64") },
    });
    // A picture comes as an image.
    const picture = await callTool(claude, "read_bill_inbox_item", { itemId: items.logo.id });
    expect(picture.content[1]).toEqual({ type: "image", data: Buffer.from(LOGO).toString("base64"), mimeType: "image/png" });

    const drafted = await callTool(claude, "create_draft_bill_from_inbox_item", {
      itemId: items.k201.id,
      contactId: kauri.id,
      billDate: "2026-10-03",
      dueDate: "2026-10-20",
      supplierInvoiceNumber: "K-201",
      amountsMode: "exclusive",
      lines: [{ description: "Timber", quantity: "1", unitPrice: "400.00", accountCode: "6010", taxCode: "GST" }],
      idempotencyKey: "claude-k201-draft",
    });
    const bill = drafted.data.bill as Json;
    expect([bill.status, bill.total, bill.supplierInvoiceNumber]).toEqual(["draft", "460.00", "K-201"]);
    expect(drafted.data.possibleDuplicates).toEqual([]);
    expect(drafted.data.item).toMatchObject({ status: "made", billNumber: "K-201" });
    const item = (await asUser(viewer, (tx) => listInbox(tx, { status: "made" }))).find((entry) => entry.id === items.k201.id)!;
    expect([item.madeByEmail, item.madeVia]).toEqual([jess.email, 'AI key "Claude"']);
    const extras = await asUser(jess, (tx) => getRecordExtras(tx, "owner", "bill", bill.id as string));
    expect(extras.attachments.map((file) => file.sha256)).toEqual([sha(K201)]);
    expect(extras.history.find((entry) => entry.eventType === "bill.created")?.via).toBe('AI key "Claude"');
    expect(await journals()).toBe(before);
    // A draft-level key can't approve it (decision 346).
    await expect(callTool(claude, "approve_bill", { billId: bill.id })).rejects.toThrow(/approve_bill/);
    // The AI can add a file too.
    const added = await callTool(claude, "add_bill_inbox_item", { fileName: "kauri-statement.pdf", contentBase64: Buffer.from(fileBytes("pdf", "statement")).toString("base64") });
    expect(added.data.item).toMatchObject({ fileName: "kauri-statement.pdf", status: "waiting", source: "ai" });
    expect((await asUser(viewer, (tx) => listInbox(tx))).find((entry) => entry.fileName === "kauri-statement.pdf")?.createdVia).toBe('AI key "Claude"');
  });

  it("BI6: a file that isn't a bill is removed with a reason; the history keeps who, when and why", async () => {
    await expect(asUser(mere, (tx) => removeInboxItem(tx, items.logo.id, { reason: "" }))).rejects.toThrow("reason is required");
    const response = await removeRoute.POST(
      apiRequest(`/api/bills/inbox/${items.logo.id}/remove`, { method: "POST", cookie: cookies.get(mere.email), body: { organisationId: org, reason: "Email signature" } }),
      params({ itemId: items.logo.id }),
    );
    const removed = ((await response.json()) as { item: InboxItem }).item;
    expect([removed.status, removed.removedByEmail, removed.removedReason, removed.removedAt !== null]).toEqual(["removed", mere.email, "Email signature", true]);
    expect(await waiting()).not.toContain("logo.png");
    await expect(asUser(mere, (tx) => getInboxItemContent(tx, items.logo.id))).rejects.toThrow("removed");
    await expect(asUser(mere, (tx) => removeInboxItem(tx, items.logo.id, { reason: "Again" }))).rejects.toThrow("already been removed");
    await expect(asUser(mere, (tx) => removeInboxItem(tx, items.k200.id, { reason: "Oops" }))).rejects.toThrow("A bill was made from this item");
    const history = await asUser(jess, (tx) =>
      tx.query<{ actor_email: string; details: Json }>("select actor_email, details from audit_events where event_type = 'bill_inbox_item.removed' and entity_id = $1", [items.logo.id]),
    );
    expect(history.rows.map((row) => [row.actor_email, row.details.reason])).toEqual([[mere.email, "Email signature"]]);
  });

  it("BI7: a read-level AI key lists and reads the inbox but can't make drafts; a viewer sees the inbox but can't change it", async () => {
    const tools = ((await rpc(lookOnly, "tools/list")).result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["list_bill_inbox", "read_bill_inbox_item"]));
    expect(tools).not.toContain("create_draft_bill_from_inbox_item");
    expect(tools).not.toContain("add_bill_inbox_item");
    expect(((await callTool(lookOnly, "list_bill_inbox")).data.items as Json[]).length).toBe(2);
    expect((await callTool(lookOnly, "read_bill_inbox_item", { itemId: items.cafe.id })).content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    await expect(callTool(lookOnly, "create_draft_bill_from_inbox_item", { itemId: items.cafe.id })).rejects.toThrow(/create_draft_bill_from_inbox_item/);
    const listed = await inboxRoute.GET(apiRequest(`/api/bills/inbox?organisationId=${org}`, { cookie: cookies.get(viewer.email) }), noContext);
    expect(listed.status).toBe(200);
    const removal = await removeRoute.POST(
      apiRequest(`/api/bills/inbox/${items.cafe.id}/remove`, { method: "POST", cookie: cookies.get(viewer.email), body: { organisationId: org, reason: "No" } }),
      params({ itemId: items.cafe.id }),
    );
    expect(removal.status).toBe(403);
  });

  it("DU1: the same file arriving again says where it went before", async () => {
    const again = ((await upload(mere, "K-200 copy.pdf", K200)).body as { item: InboxItem }).item;
    expect(again.sameFile.map((entry) => entry.text)).toEqual([`Same file as item ${items.k200.id}, made into bill K-200`]);
    const listed = await callTool(lookOnly, "list_bill_inbox");
    expect((listed.data.items as Json[]).find((item) => item.id === again.id)?.sameFile).toEqual([`Same file as item ${items.k200.id}, made into bill K-200`]);
    await asUser(mere, (tx) => removeInboxItem(tx, again.id, { reason: "Already entered as K-200" }));
  });

  it("DU2: the same supplier and total within 7 days warns, and approving asks first; the history says who approved it anyway", async () => {
    const draft = (await asUser(mere, (tx) => createBill(tx, { idempotencyKey: key("b"), ...kauriBill({ billDate: "2026-10-02", supplierInvoiceNumber: "K200A" }) }))).bill;
    const details = await billDetails(viewer, draft.id);
    expect(details.duplicateWarnings.map((warning) => [warning.kind, warning.billId, warning.message])).toEqual([
      ["same_supplier_amount", k200.id, "Possibly the same as K-200 (230.00, 1 Oct 2026)"],
    ]);
    const approve = (approveDespiteWarnings?: boolean) =>
      approveRoute.POST(
        apiRequest(`/api/bills/${draft.id}/approve`, {
          method: "POST",
          cookie: cookies.get(mere.email),
          body: { organisationId: org, source: "ui", idempotencyKey: key("approve"), approveDespiteWarnings },
        }),
        params({ billId: draft.id }),
      );
    const refused = await approve();
    expect([refused.status, ((await refused.json()) as Json).error]).toEqual([
      409,
      "Possibly the same as K-200 (230.00, 1 Oct 2026). Check it isn't the same bill. A person can approve it anyway on the bill's page.",
    ]);
    expect((await asUser(viewer, (tx) => getBill(tx, draft.id))).status).toBe("draft");
    const approved = await approve(true);
    expect([approved.status, ((await approved.json()) as { bill: Bill }).bill.status]).toEqual([201, "approved"]);
    const extras = await asUser(mere, (tx) => getRecordExtras(tx, "bookkeeper", "bill", draft.id));
    const entry = extras.history.find((item) => item.eventType === "bill.approved")!;
    expect([entry.actorEmail, entry.summary]).toEqual([mere.email, "Bill approved despite a possible duplicate: Possibly the same as K-200 (230.00, 1 Oct 2026)"]);
    // K-200 now warns about K200A too.
    expect((await billDetails(viewer, k200.id)).duplicateWarnings.map((warning) => warning.supplierInvoiceNumber)).toEqual(["K200A"]);
  });

  it("DU3: another supplier with the same invoice number and total is warned about", async () => {
    const other = (await asUser(mere, (tx) => createBill(tx, { idempotencyKey: key("b"), ...kauriBill({ contactId: kauriLimited.id, billDate: "2026-09-01", supplierInvoiceNumber: "k -200" }) }))).bill;
    expect((await billDetails(viewer, other.id)).duplicateWarnings.map((warning) => [warning.kind, warning.message])).toEqual([
      ["other_supplier_number", "Another supplier, Kauri Supplies, has a bill K-200 for the same amount (230.00, 1 Oct 2026)"],
    ]);
    // A different total isn't warned about.
    const different = (await asUser(mere, (tx) => createBill(tx, { idempotencyKey: key("b"), ...kauriBill({ contactId: kauriLimited.id, billDate: "2026-09-01", supplierInvoiceNumber: "K-201", lines: [{ description: "x", quantity: "1", unitPrice: "1.00", accountCode: "6010", taxCode: "GST" }] }) }))).bill;
    expect((await billDetails(viewer, different.id)).duplicateWarnings).toEqual([]);
  });

  it("DU4: the same supplier and total more than 7 days apart (a monthly charge) isn't warned about, nor bills made by the same repeating bill", async () => {
    const make = async (billDate: string, number: string) =>
      (await asUser(mere, (tx) => createBill(tx, { idempotencyKey: key("b"), ...kauriBill({ billDate, dueDate: "2026-12-20", supplierInvoiceNumber: number }) }))).bill;
    expect((await billDetails(viewer, (await make("2026-11-10", "K-300")).id)).duplicateWarnings).toEqual([]);
    // 9 October is 7 days after K200A (2 October): warned. 10 October is 8 days after: not.
    expect((await billDetails(viewer, (await make("2026-10-09", "K-209")).id)).duplicateWarnings.map((warning) => warning.supplierInvoiceNumber)).toEqual(["K200A"]);
    const tenth = await make("2026-10-10", "K-210");
    expect((await billDetails(viewer, tenth.id)).duplicateWarnings.map((warning) => warning.supplierInvoiceNumber)).toEqual(["K-209"]);
    await asUser(mere, (tx) => deleteBill(tx, tenth.id));
    // Bills made by the same repeating bill aren't each other's duplicates (a weekly charge).
    const weekly = (
      await asUser(jess, (tx) =>
        createRepeatingBill(tx, {
          idempotencyKey: key("rb"),
          contactId: kauriLimited.id,
          supplierInvoiceNumber: "WEEK-{date}",
          amountsMode: "exclusive",
          lines: [{ description: "Hire", quantity: "1", unitPrice: "50.00", accountCode: "6010", taxCode: "GST" }],
          period: "week",
          every: 1,
          startDate: "2026-11-02",
          dueRule: "days_after",
          dueDays: 7,
          saveAs: "approve",
        }),
      )
    ).repeatingBill;
    const run = await inOrganisation(org, { userId: null, email: "repeating-bills@tohyee" }, (tx) => runRepeatingBills(tx, { today: "2026-11-16", repeatingBillId: weekly.id }));
    expect([run.made, run.approved, run.refused]).toEqual([3, 3, 0]);
  });

  it("DU5: the AI is told about a warning when it drafts, and can't approve past it", async () => {
    const poster = await makeKey("Claude posts", "post");
    const added = await callTool(poster, "add_bill_inbox_item", { fileName: "K200-again.pdf", contentBase64: Buffer.from(fileBytes("pdf", "K-200 resent")).toString("base64") });
    const drafted = await callTool(poster, "create_draft_bill_from_inbox_item", {
      itemId: (added.data.item as Json).id,
      contactId: kauri.id,
      billDate: "2026-10-01",
      dueDate: "2026-10-20",
      supplierInvoiceNumber: "K-200-2",
      amountsMode: "exclusive",
      lines: [{ description: "Supplies", quantity: "1", unitPrice: "200.00", accountCode: "6010", taxCode: "GST" }],
    });
    expect(drafted.data.possibleDuplicates).toEqual(["Possibly the same as K-200 (230.00, 1 Oct 2026)", "Possibly the same as K200A (230.00, 2 Oct 2026)"]);
    expect(drafted.data.note).toMatch(/only a person can approve it anyway/);
    const billId = (drafted.data.bill as Json).id as string;
    await expect(callTool(poster, "approve_bill", { billId })).rejects.toThrow("A person can approve it anyway on the bill's page.");
    expect((await asUser(viewer, (tx) => getBill(tx, billId))).status).toBe("draft");
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact, type Contact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getRecordExtras } from "@/lib/records/extras";
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

const ORG = "ai-writes";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

const READ = AI_TOOLS.filter((tool) => tool.level === "read").map((tool) => tool.name).sort();
const DRAFT = AI_TOOLS.filter((tool) => tool.level !== "post").map((tool) => tool.name).sort();
const ALL = AI_TOOLS.map((tool) => tool.name).sort();

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown) {
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

async function toolNames(token: string): Promise<string[]> {
  return ((await rpc(token, "tools/list")).result as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort();
}

/** Calls a tool; returns its JSON answer, or throws with the error text. */
async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

/** Decisions 346-348 and examples MJD9: access levels, never delete, write tools. */
describeWithDatabase("AI keys that make drafts and post (decisions 346-348)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let customer: Contact;
  let supplier: Contact;
  const tokens: Record<string, string> = {};

  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const count = async (table: string) =>
    Number((await asOwner((tx) => tx.query<{ count: string }>(`select count(*)::text as count from ${table}`))).rows[0].count);

  async function makeKey(user: SessionUser, name: string, accessLevel?: string) {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, name, accessLevel } }),
      noContext,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { token: string; key: Json };
    expect(body.key.accessLevel).toBe(accessLevel ?? "read");
    return body.token;
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    bookkeeper = await createTestUser("jess@example.com", { displayName: "Jess" });
    viewer = await createTestUser("viewer@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [
      ORG,
      bookkeeper.id,
      viewer.id,
    ]);
    customer = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Aroha Café Ltd", isCustomer: true }))).contact;
    supplier = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("s"), name: "Kauri Supplies", isSupplier: true }))).contact;
    tokens.read = await makeKey(bookkeeper, "Look only");
    tokens.draft = await makeKey(bookkeeper, "Drafts", "draft");
    tokens.post = await makeKey(bookkeeper, "Claude on my laptop", "post");
    tokens.viewerPost = await makeKey(viewer, "Viewer wants to post", "post");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("refuses an unknown access level", async () => {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(bookkeeper), body: { organisationId: ORG, name: "x", accessLevel: "delete" } }),
      noContext,
    );
    expect(response.status).toBe(400);
  });

  it("tools/list shows only what the key's level and the person's role allow", async () => {
    expect(await toolNames(tokens.read)).toEqual(READ);
    expect(await toolNames(tokens.draft)).toEqual(DRAFT);
    expect(await toolNames(tokens.post)).toEqual(ALL);
    // A viewer's key can never write, whatever level it was made with.
    expect(await toolNames(tokens.viewerPost)).toEqual(READ);
    expect(((await rpc(tokens.viewerPost, "initialize", {})).result as Json).instructions).toContain("Look only");
    expect(READ.length).toBeGreaterThan(10);
    expect(DRAFT).toContain("create_draft_journal");
    expect(DRAFT).not.toContain("approve_invoice");
  });

  it("no tool deletes, voids, archives, rolls back, refunds or removes anything", () => {
    for (const tool of AI_TOOLS) {
      const words = tool.name.split("_");
      for (const word of ["delete", "void", "archive", "unarchive", "rollback", "roll", "refund", "remove", "revoke", "undo", "unreconcile", "reopen"]) {
        expect(words, tool.name).not.toContain(word);
      }
      // Write tools can't archive by passing a flag either.
      if (tool.level !== "read") expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/archiv|void|delete/i);
    }
  });

  it("tools/call refuses tools above the key's level, and a viewer's key writes nothing", async () => {
    const before = await count("contacts");
    const refused = await rpc(tokens.read, "tools/call", { name: "create_contact", arguments: { name: "Nope Ltd" } });
    expect(refused.error).toMatchObject({ code: -32602, message: expect.stringContaining('"Make drafts"') });
    const viewerRefused = await rpc(tokens.viewerPost, "tools/call", { name: "create_draft_journal", arguments: { postingDate: "2026-06-30", reference: "X", lines: [] } });
    expect(viewerRefused.error).toMatchObject({ code: -32602 });
    const draftRefused = await rpc(tokens.draft, "tools/call", { name: "approve_invoice", arguments: { invoiceId: "1" } });
    expect(draftRefused.error).toMatchObject({ code: -32602, message: expect.stringContaining('"Make and post"') });
    expect(await count("contacts")).toBe(before);
  });

  it("draft level: contacts and drafts, which post nothing; a retried call with the same key doesn't double up", async () => {
    const journals = await count("ledger_journals");
    const idempotencyKey = "ai-test-contact-1";
    const made = await call(tokens.draft, "create_contact", { name: "Tui Bakery", isCustomer: true, email: "orders@tui.example", idempotencyKey });
    expect(made).toMatchObject({ created: true, contact: { name: "Tui Bakery", isCustomer: true } });
    const again = await call(tokens.draft, "create_contact", { name: "Tui Bakery", isCustomer: true, email: "orders@tui.example", idempotencyKey });
    expect(again).toMatchObject({ created: false, contact: { id: (made.contact as Json).id } });
    const updated = await call(tokens.draft, "update_contact", { contactId: (made.contact as Json).id, phone: "03 477 0000" });
    expect(updated.contact).toMatchObject({ phone: "03 477 0000", isArchived: false });

    const invoice = await call(tokens.draft, "create_draft_invoice", {
      contactId: customer.id,
      invoiceDate: "2026-06-10",
      dueDate: "2026-07-20",
      amountsMode: "exclusive",
      lines: [{ description: "Paw print pendant", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
      idempotencyKey: "ai-test-invoice-1",
    });
    expect(invoice.invoice).toMatchObject({ status: "draft", number: null, total: "115.00" });
    const edited = await call(tokens.draft, "update_draft_invoice", {
      invoiceId: (invoice.invoice as Json).id,
      lines: [{ description: "Paw print pendant", quantity: "3", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
    });
    expect(edited.invoice).toMatchObject({ status: "draft", total: "172.50" });

    const draft = await call(tokens.draft, "create_draft_journal", {
      postingDate: "2026-06-30",
      reference: "PREPAY-JUN",
      lines: [
        { accountCode: "1200", debitAmount: "600.00" },
        { accountCode: "6040", creditAmount: "600.00" },
      ],
    });
    expect(draft.draft).toMatchObject({ status: "draft", total: "600.00", createdByEmail: bookkeeper.email, createdVia: 'AI key "Drafts"' });
    const draftEdited = await call(tokens.draft, "update_draft_journal", {
      draftId: (draft.draft as Json).id,
      postingDate: "2026-06-30",
      reference: "PREPAY-JUN",
      lines: [
        { accountCode: "1200", debitAmount: "650.00" },
        { accountCode: "6040", creditAmount: "650.00" },
      ],
    });
    expect(draftEdited.draft).toMatchObject({ total: "650.00", updatedVia: 'AI key "Drafts"' });

    const bill = await call(tokens.draft, "create_draft_bill", {
      contactId: supplier.id,
      billDate: "2026-06-12",
      dueDate: "2026-07-20",
      supplierInvoiceNumber: "KS-90",
      amountsMode: "exclusive",
      lines: [{ description: "Silver clay", quantity: "1", unitPrice: "80.00", accountCode: "5000", taxCode: "GST" }],
    });
    expect(bill.bill).toMatchObject({ status: "draft", total: "92.00" });
    const billEdited = await call(tokens.draft, "update_draft_bill", { billId: (bill.bill as Json).id, supplierInvoiceNumber: "KS-91" });
    expect(billEdited.bill).toMatchObject({ supplierInvoiceNumber: "KS-91" });

    // Drafts post nothing.
    expect(await count("ledger_journals")).toBe(journals);

    // The history shows the person via the key.
    const history = await asOwner((tx) => getRecordExtras(tx, "owner", "invoice", (invoice.invoice as Json).id));
    expect(history.history.map((entry) => [entry.eventType, entry.actorEmail, entry.via])).toEqual([
      ["invoice.created", bookkeeper.email, 'AI key "Drafts"'],
      ["invoice.updated", bookkeeper.email, 'AI key "Drafts"'],
    ]);
    const contactAudit = await asOwner((tx) =>
      tx.query<{ event_type: string; actor_email: string; via: string }>(
        "select event_type, actor_email, details->>'via' as via from audit_events where entity_type = 'contact' and entity_id = $1 order by id",
        [(made.contact as Json).id],
      ),
    );
    expect(contactAudit.rows).toEqual([
      { event_type: "contact.created", actor_email: bookkeeper.email, via: 'AI key "Drafts"' },
      { event_type: "contact.updated", actor_email: bookkeeper.email, via: 'AI key "Drafts"' },
    ]);
  });

  it("post level: approves, posts a draft journal exactly once, records payments into bank accounts only", async () => {
    const invoice = await call(tokens.post, "create_draft_invoice", {
      contactId: customer.id,
      invoiceDate: "2026-06-15",
      dueDate: "2026-07-20",
      amountsMode: "exclusive",
      lines: [{ description: "Nose print ring", quantity: "1", unitPrice: "200.00", accountCode: "4000", taxCode: "GST" }],
    });
    const invoiceId = (invoice.invoice as Json).id as string;
    const journals = await count("ledger_journals");
    const approved = await call(tokens.post, "approve_invoice", { invoiceId, idempotencyKey: "ai-test-approve-1" });
    expect(approved.invoice).toMatchObject({ status: "approved", number: expect.stringMatching(/^INV-/), total: "230.00", amountDue: "230.00" });
    expect(await count("ledger_journals")).toBe(journals + 1);
    const approvedAgain = await call(tokens.post, "approve_invoice", { invoiceId, idempotencyKey: "ai-test-approve-1" });
    expect(approvedAgain.created).toBe(false);
    expect(await count("ledger_journals")).toBe(journals + 1);

    // Payments go only into bank accounts.
    await expect(
      call(tokens.post, "record_invoice_payment", { invoiceId, paymentDate: "2026-06-20", amount: "230.00", bankAccountCode: "4000" }),
    ).rejects.toThrow(/isn't a bank account/);
    const paid = await call(tokens.post, "record_invoice_payment", {
      invoiceId,
      paymentDate: "2026-06-20",
      amount: "230.00",
      bankAccountCode: "1000",
      idempotencyKey: "ai-test-pay-1",
    });
    expect(paid.invoice).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });

    const bill = await call(tokens.post, "create_draft_bill", {
      contactId: supplier.id,
      billDate: "2026-06-16",
      dueDate: "2026-07-20",
      supplierInvoiceNumber: "KS-100",
      amountsMode: "exclusive",
      lines: [{ description: "Chain", quantity: "1", unitPrice: "20.00", accountCode: "5000", taxCode: "GST" }],
    });
    const billId = (bill.bill as Json).id as string;
    expect((await call(tokens.post, "approve_bill", { billId })).bill).toMatchObject({ status: "approved", amountDue: "23.00" });
    const billPaid = await call(tokens.post, "record_bill_payment", { billId, paymentDate: "2026-06-21", amount: "23.00", bankAccountCode: "1000" });
    expect(billPaid.bill).toMatchObject({ amountDue: "0.00" });

    // A draft journal posts exactly once and links its journal.
    const draft = await call(tokens.post, "create_draft_journal", {
      postingDate: "2026-06-30",
      reference: "ACCRUAL-JUN",
      lines: [
        { accountCode: "6010", debitAmount: "300.00" },
        { accountCode: "2300", creditAmount: "300.00" },
      ],
    });
    const draftId = (draft.draft as Json).id as string;
    const beforePost = await count("ledger_journals");
    const posted = await call(tokens.post, "post_draft_journal", { draftId });
    expect(posted).toMatchObject({ created: true, draft: { status: "posted", postedJournalId: posted.journalId, postedVia: 'AI key "Claude on my laptop"' } });
    const postedAgain = await call(tokens.post, "post_draft_journal", { draftId });
    expect(postedAgain).toMatchObject({ created: false, journalId: posted.journalId });
    expect(await count("ledger_journals")).toBe(beforePost + 1);
    await expect(
      call(tokens.post, "update_draft_journal", {
        draftId,
        postingDate: "2026-06-30",
        reference: "ACCRUAL-JUN",
        lines: [
          { accountCode: "6010", debitAmount: "1.00" },
          { accountCode: "2300", creditAmount: "1.00" },
        ],
      }),
    ).rejects.toThrow(/has been posted/);

    const journalAudit = await asOwner((tx) =>
      tx.query<{ actor_email: string; via: string }>(
        "select actor_email, details->>'via' as via from audit_events where event_type = 'ledger.journal_posted' and entity_id = $1",
        [posted.journalId],
      ),
    );
    expect(journalAudit.rows).toEqual([{ actor_email: bookkeeper.email, via: 'AI key "Claude on my laptop"' }]);
  });

  it("a write tool's failure changes nothing and says why", async () => {
    const before = await count("ledger_journal_drafts");
    await expect(
      call(tokens.post, "create_draft_journal", {
        postingDate: "2026-06-30",
        reference: "BAD",
        lines: [
          { accountCode: "1200", debitAmount: "600.00" },
          { accountCode: "6040", creditAmount: "550.00" },
        ],
      }),
    ).rejects.toThrow(/doesn't balance/);
    expect(await count("ledger_journal_drafts")).toBe(before);
  });

  it("the level follows the person's role at call time", async () => {
    await coreQuery("update organisation_members set role = 'viewer' where organisation_id = $1 and user_id = $2", [ORG, bookkeeper.id]);
    try {
      expect(await toolNames(tokens.post)).toEqual(READ);
      const refused = await rpc(tokens.post, "tools/call", { name: "create_contact", arguments: { name: "Nope" } });
      expect(refused.error).toMatchObject({ code: -32602 });
    } finally {
      await coreQuery("update organisation_members set role = 'bookkeeper' where organisation_id = $1 and user_id = $2", [ORG, bookkeeper.id]);
    }
    expect(await toolNames(tokens.post)).toEqual(ALL);
  });
});

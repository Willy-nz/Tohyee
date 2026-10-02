import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as revokeRoute from "@/app/api/ai/tokens/[tokenId]/revoke/route";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import { hashAiToken } from "@/lib/ai/token-format";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBill, approveBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { createJournalDraft } from "@/lib/ledger/journal-drafts";
import { getOrganisation } from "@/lib/organisations/registry";
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

const ORG = "ai-books";
const OTHER_ORG = "ai-other";
const noContext = undefined as unknown;

type Json = Record<string, unknown>;

/** A request from an AI client: no cookie, no Origin, a bearer key. */
function mcpRequest(body: unknown, options: { token?: string | null; cookie?: string; method?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = options.cookie;
  return new Request("http://tohyee.test/api/mcp", {
    method: options.method ?? "POST",
    headers,
    body: options.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown) {
  rpcId += 1;
  const response = await mcpRoute.POST(mcpRequest({ jsonrpc: "2.0", id: rpcId, method, params: rpcParams }, { token }), noContext);
  return { status: response.status, body: (await response.json()) as Json };
}

/** Calls a tool and returns its parsed JSON answer (or the error text). */
async function callTool(token: string, name: string, args: Json = {}) {
  const { status, body } = await rpc(token, "tools/call", { name, arguments: args });
  expect(status).toBe(200);
  const result = body.result as { content: { type: string; text: string }[]; isError?: boolean };
  expect(result.content[0].type).toBe("text");
  return { isError: result.isError === true, text: result.content[0].text, data: result.isError ? null : (JSON.parse(result.content[0].text) as Json) };
}

describeWithDatabase("connect your own AI (MCP, decisions 339-345)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let leaver: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let viewerToken: string;
  let draftId: string;

  const asOwner = <T>(work: Parameters<typeof inOrganisation<T>>[2]) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  async function makeKey(cookie: string, name: string, organisationId = ORG) {
    const response = await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie, body: { organisationId, name } }), noContext);
    return { status: response.status, body: (await response.json()) as Json };
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(owner, OTHER_ORG);
    viewer = await createTestUser("viewer@example.com");
    leaver = await createTestUser("leaver@example.com");
    for (const user of [viewer, leaver]) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, user.id]);
    }
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);

    // Example I1's invoice (2 x $50.00 + 15% GST), approved as INV-0001, and one bill.
    const customer = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Aroha Café Ltd", isCustomer: true }))).contact;
    const supplier = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("s"), name: "Kauri Supplies", isSupplier: true }))).contact;
    const invoice = (
      await asOwner((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("inv"),
          contactId: customer.id,
          invoiceDate: "2026-05-10",
          dueDate: "2026-06-20",
          amountsMode: "exclusive",
          lines: [{ description: "Consulting", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
        }),
      )
    ).invoice;
    await asOwner((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    const bill = (
      await asOwner((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: supplier.id,
          billDate: "2026-05-12",
          dueDate: "2026-06-20",
          supplierInvoiceNumber: "KS-77",
          amountsMode: "exclusive",
          lines: [{ description: "Paper", quantity: "1", unitPrice: "40.00", accountCode: "6000", taxCode: "GST" }],
        }),
      )
    ).bill;
    await asOwner((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve-bill") }));
    draftId = (
      await asOwner((tx) =>
        createJournalDraft(tx, {
          idempotencyKey: key("draft"),
          postingDate: "2026-06-30",
          reference: "DRAFT-1",
          lines: [
            { accountCode: "1200", debitAmount: "10.00" },
            { accountCode: "6040", creditAmount: "10.00" },
          ],
        }),
      )
    ).draft.id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("makes a key (Look only unless asked), shows it once, stores only its SHA-256 and lists it without the key", async () => {
    const made = await makeKey(viewerCookie, "Claude on my laptop");
    expect(made.status).toBe(201);
    const token = made.body.token as string;
    expect(token).toMatch(/^tohyee_ai_[A-Za-z0-9_-]{43}$/);
    viewerToken = token;
    const keyInfo = made.body.key as Json;
    expect(keyInfo).toMatchObject({ name: "Claude on my laptop", startsWith: token.slice(0, 18), accessLevel: "read", lastUsedAt: null, revokedAt: null });

    const stored = await coreQuery<Json>("select * from ai_access_tokens where id = $1", [keyInfo.id]);
    expect(stored.rows[0]).toMatchObject({ user_id: viewer.id, organisation_id: ORG, token_hash: hashAiToken(token), created_by_email: viewer.email });
    expect(JSON.stringify(stored.rows[0])).not.toContain(token);
    expect(JSON.stringify(stored.rows[0])).not.toContain(token.slice(10));

    const listed = await tokensRoute.GET(apiRequest(`/api/ai/tokens?organisationId=${ORG}`, { cookie: viewerCookie }), noContext);
    const list = (await listed.json()) as { keys: Json[]; maxActiveKeys: number; remoteAddress: string | null };
    expect(list.keys).toHaveLength(1);
    expect(list.maxActiveKeys).toBe(10);
    expect(list.remoteAddress).toBeNull();
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain("token_hash");
    expect(JSON.stringify(list)).not.toContain(hashAiToken(token));

    // Someone else's list doesn't show it.
    const ownerList = (await (await tokensRoute.GET(apiRequest(`/api/ai/tokens?organisationId=${ORG}`, { cookie: ownerCookie }), noContext)).json()) as { keys: Json[] };
    expect(ownerList.keys).toHaveLength(0);

    const audit = await coreQuery<{ event_type: string; details: Json }>("select event_type, details from admin_audit_events where event_type like 'ai_access_token.%'");
    expect(audit.rows).toEqual([{ event_type: "ai_access_token.created", details: expect.objectContaining({ name: "Claude on my laptop" }) }]);
  });

  it("refuses keys for an organisation you're not in, cross-site requests, and more than 10 active keys", async () => {
    expect((await makeKey(viewerCookie, "Nope", OTHER_ORG)).status).toBe(404);
    const crossSite = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: viewerCookie, origin: "https://evil.example", body: { organisationId: ORG, name: "x" } }),
      noContext,
    );
    expect(crossSite.status).toBe(403);
    expect((await makeKey(viewerCookie, "   ")).status).toBe(400);

    for (let index = 0; index < 9; index += 1) expect((await makeKey(ownerCookie, `Key ${index}`)).status).toBe(201);
    const tenth = await makeKey(ownerCookie, "Key 9");
    expect(tenth.status).toBe(201);
    const eleventh = await makeKey(ownerCookie, "Key 10");
    expect(eleventh.status).toBe(409);
    // Revoking one makes room.
    await revokeRoute.POST(
      apiRequest(`/api/ai/tokens/${(tenth.body.key as Json).id}/revoke`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
      params({ tokenId: (tenth.body.key as Json).id as string }),
    );
    expect((await makeKey(ownerCookie, "Key 10")).status).toBe(201);
  });

  it("initialize, notifications/initialized, ping and tools/list", async () => {
    const init = await rpc(viewerToken, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tohyee", version: expect.stringMatching(/^\d+\.\d+\.\d+/) },
      },
    });
    expect((init.body.result as Json).instructions).toContain("Look only");
    // An unknown version gets the one Tohyee was written against.
    expect(((await rpc(viewerToken, "initialize", { protocolVersion: "1999-01-01" })).body.result as Json).protocolVersion).toBe("2025-06-18");

    const initialized = await mcpRoute.POST(mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, { token: viewerToken }), noContext);
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe("");

    expect((await rpc(viewerToken, "ping")).body).toEqual({ jsonrpc: "2.0", id: rpcId, result: {} });

    const listed = await rpc(viewerToken, "tools/list");
    const tools = (listed.body.result as { tools: { name: string; inputSchema: Json; annotations: Json; description: string }[] }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "account_transactions",
        "aged_payables",
        "aged_receivables",
        "balance_sheet",
        "get_bill",
        "get_invoice",
        "get_organisation",
        "gst_return",
        "list_accounts",
        "list_bills",
        "list_contacts",
        "list_invoices",
        "profit_and_loss",
        "trial_balance",
        "list_draft_journals",
        "get_draft_journal",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      // No tool's name suggests it changes anything, and nothing about payroll.
      const words = tool.name.split("_");
      for (const word of ["create", "update", "delete", "post", "approve", "void", "file", "pay", "write", "set", "archive", "payroll", "revoke"]) {
        expect(words, tool.name).not.toContain(word);
      }
    }

    const unknown = await rpc(viewerToken, "resources/read", { uri: "x" });
    expect((unknown.body.error as Json).code).toBe(-32601);
    const badTool = await rpc(viewerToken, "tools/call", { name: "approve_invoice", arguments: {} });
    expect((badTool.body.error as Json).code).toBe(-32602);
  });

  it("tools/call answers from the organisation's books (example I1's invoice)", async () => {
    const organisation = await callTool(viewerToken, "get_organisation");
    expect(organisation.data).toMatchObject({ organisationId: ORG, name: `Test ${ORG}`, baseCurrency: "NZD", financialYearEnd: "31 March", yourRole: "viewer", access: "read-only" });

    const accounts = await callTool(viewerToken, "list_accounts");
    expect((accounts.data!.rows as Json[]).find((account) => account.code === "4000")).toMatchObject({ class: "revenue", archived: false });

    const pnl = await callTool(viewerToken, "profit_and_loss", { from: "2026-04-01", to: "2026-06-30" });
    expect(pnl.data).toMatchObject({ from: "2026-04-01", to: "2026-06-30", currencyCode: "NZD", netProfit: "60.00" });
    expect((pnl.data!.revenue as Json).total).toBe("100.00");

    const invoices = await callTool(viewerToken, "list_invoices", { status: "approved" });
    expect(invoices.data!.invoices).toEqual([
      expect.objectContaining({ number: "INV-0001", contactName: "Aroha Café Ltd", subtotal: "100.00", gst: "15.00", total: "115.00", amountDue: "115.00" }),
    ]);
    const invoice = await callTool(viewerToken, "get_invoice", { number: "inv-0001" });
    expect(invoice.data).toMatchObject({ number: "INV-0001", total: "115.00" });
    expect(invoice.data!.lines).toEqual([expect.objectContaining({ description: "Consulting", quantity: "2", net: "100.00", gst: "15.00" })]);

    const bill = await callTool(viewerToken, "get_bill", { supplierInvoiceNumber: "ks-77" });
    expect(bill.data).toMatchObject({ supplierInvoiceNumber: "KS-77", total: "46.00", contactName: "Kauri Supplies" });

    const contacts = await callTool(viewerToken, "list_contacts", { type: "supplier" });
    expect((contacts.data!.rows as Json[]).map((contact) => contact.name)).toEqual(["Kauri Supplies"]);

    const ledger = await callTool(viewerToken, "account_transactions", { accountCode: "4000", from: "2026-04-01", to: "2026-06-30" });
    expect(ledger.data).toMatchObject({ account: { code: "4000" }, opening: "0.00", closing: "-100.00" });

    const missing = await callTool(viewerToken, "get_invoice", { number: "INV-9999" });
    expect(missing).toMatchObject({ isError: true, text: "There's no invoice numbered INV-9999." });
    const badDate = await callTool(viewerToken, "profit_and_loss", { from: "next tuesday" });
    expect(badDate.isError).toBe(true);
  });

  it("every tool runs inside a read-only transaction without error", async () => {
    const args: Record<string, Json> = {
      account_transactions: { accountCode: "1100" },
      gst_return: { periodStart: "2026-05-01", periodEnd: "2026-06-30" },
      get_invoice: { number: "INV-0001" },
      get_bill: { supplierInvoiceNumber: "KS-77" },
      get_draft_journal: { draftId },
      aged_receivables: { asAt: "2026-06-30" },
      aged_payables: { asAt: "2026-06-30" },
      balance_sheet: { asAt: "2026-06-30" },
      trial_balance: { asAt: "2026-06-30" },
    };
    for (const tool of AI_TOOLS.filter((entry) => entry.level === "read")) {
      const result = await callTool(viewerToken, tool.name, args[tool.name] ?? {});
      expect(result.isError, `${tool.name}: ${result.text}`).toBe(false);
    }
    const gst = await callTool(viewerToken, "gst_return", args.gst_return);
    expect(gst.data).toMatchObject({ periodStart: "2026-05-01", periodEnd: "2026-06-30", boxes: expect.objectContaining({ box5: "115.00", box11: "46.00", box15: "9.00" }), transactionLineCount: 2 });
  });

  it("the read-only transaction refuses writes, so no tool can change the books", async () => {
    const organisation = (await getOrganisation(ORG))!;
    const before = await asOwner((tx) => tx.query<{ count: string }>("select count(*)::text as count from audit_events"));
    await expect(
      withOrganisationTransaction(
        organisation,
        { userId: viewer.id, email: viewer.email },
        (tx) => tx.query("insert into audit_events (event_type, entity_type, entity_id, details) values ('x', 'x', 'x', '{}')"),
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: "25006" });
    await expect(
      withOrganisationTransaction(organisation, { userId: viewer.id, email: viewer.email }, (tx) => tx.query("select id from contacts for update"), { readOnly: true }),
    ).rejects.toMatchObject({ code: "25006" });
    const after = await asOwner((tx) => tx.query<{ count: string }>("select count(*)::text as count from audit_events"));
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("refuses missing, malformed, unknown and revoked keys with 401, and cookie sessions alone", async () => {
    for (const token of [null, "nonsense", `tohyee_ai_${"A".repeat(43)}`]) {
      const response = await mcpRoute.POST(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }), noContext);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
      expect(((await response.json()) as Json).error).toMatchObject({ code: -32001 });
    }
    // A signed-in browser session, even same-origin, can't use it.
    const withCookie = await mcpRoute.POST(
      new Request("http://tohyee.test/api/mcp", {
        method: "POST",
        headers: { cookie: ownerCookie, origin: "http://tohyee.test", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      noContext,
    );
    expect(withCookie.status).toBe(401);
    // Session tokens aren't AI keys either.
    const sessionToken = ownerCookie.split("=")[1];
    expect((await mcpRoute.POST(mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: sessionToken }), noContext)).status).toBe(401);

    const made = await makeKey(viewerCookie, "Short-lived");
    const token = made.body.token as string;
    expect((await rpc(token, "ping")).status).toBe(200);
    const revoked = await revokeRoute.POST(
      apiRequest(`/api/ai/tokens/${(made.body.key as Json).id}/revoke`, { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }),
      params({ tokenId: (made.body.key as Json).id as string }),
    );
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { key: Json }).key.revokedAt).not.toBeNull();
    expect((await rpc(token, "ping")).status).toBe(401);

    // Someone else can't revoke your key.
    const notYours = await revokeRoute.POST(
      apiRequest(`/api/ai/tokens/${(made.body.key as Json).id}/revoke`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG } }),
      params({ tokenId: (made.body.key as Json).id as string }),
    );
    expect(notYours.status).toBe(404);
  });

  it("a key stops working when its owner leaves the organisation or their login is disabled, and stays stopped", async () => {
    const leaverCookie = await sessionCookieFor(leaver);
    const token = (await makeKey(leaverCookie, "Leaver's ChatGPT")).body.token as string;
    expect((await rpc(token, "ping")).status).toBe(200);

    // Membership gone (even without the removal revoking it): refused.
    await coreQuery("delete from organisation_members where organisation_id = $1 and user_id = $2", [ORG, leaver.id]);
    expect((await rpc(token, "ping")).status).toBe(401);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, leaver.id]);
    expect((await rpc(token, "ping")).status).toBe(200);

    // Removed properly: the key is revoked, so adding them back doesn't revive it.
    const removed = await memberRoute.DELETE(
      apiRequest(`/api/organisations/${ORG}/members/${leaver.id}`, { method: "DELETE", cookie: ownerCookie }),
      params({ organisationId: ORG, userId: leaver.id }),
    );
    expect(removed.status).toBe(200);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, leaver.id]);
    expect((await rpc(token, "ping")).status).toBe(401);

    // A disabled login.
    const token2 = (await makeKey(leaverCookie, "Again")).body.token as string;
    expect((await rpc(token2, "ping")).status).toBe(200);
    await coreQuery("update users set is_active = false where id = $1", [leaver.id]);
    expect((await rpc(token2, "ping")).status).toBe(401);
  });

  it("records when a key was last used, answers GET with 405, rejects bad JSON and unknown protocol versions", async () => {
    const row = await coreQuery<{ last_used_at: string | null }>("select last_used_at from ai_access_tokens where token_hash = $1", [hashAiToken(viewerToken)]);
    expect(row.rows[0].last_used_at).not.toBeNull();

    const get = await mcpRoute.GET(mcpRequest(null, { token: viewerToken, method: "GET" }), noContext);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    const parse = await mcpRoute.POST(mcpRequest("{not json", { token: viewerToken }), noContext);
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as Json).error).toMatchObject({ code: -32700 });

    const version = await mcpRoute.POST(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: viewerToken, headers: { "mcp-protocol-version": "1999-01-01" } }),
      noContext,
    );
    expect(version.status).toBe(400);
    const okVersion = await mcpRoute.POST(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: viewerToken, headers: { "mcp-protocol-version": "2025-06-18" } }),
      noContext,
    );
    expect(okVersion.status).toBe(200);
  });
});

describe("AI tools list", () => {
  it("has a JSON Schema object for every tool", () => {
    for (const tool of AI_TOOLS) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});

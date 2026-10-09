import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { FULL_READ_TOOLS, FULL_WRITE_TOOLS } from "@/lib/ai/full-tools";
import { createApprovalRule } from "@/lib/approvals/rules";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createFixedAssetType } from "@/lib/fixed-assets/service";
import { approveInvoice, createInvoice, getInvoice, type InvoiceSummary } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
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

const ORG = "ai-full";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

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

/** Calls a tool; returns its JSON answer, or throws with the error text. */
async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

/** Decision 489 and examples AIF1-AIF6: Full access outside banking (#205 section 4). */
describeWithDatabase("Full access AI keys outside banking (decision 489, AIF1-AIF6)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let kobe: Contact;
  let kauri: Contact;
  let invoice: InvoiceSummary;
  const tokens: Record<string, string> = {};

  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const journalCount = async () => Number((await asOwner((tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count);
  const postedLines = async (journalId: string) =>
    (await asOwner((tx) => getJournal(tx, journalId))).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);
  const line = (amount: string, accountCode = "4000") => ({ description: "Line", quantity: "1", unitPrice: amount, accountCode, taxCode: "GST" });

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    kobe = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true }))).contact;
    kauri = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kauri Supplies", isSupplier: true }))).contact;
    invoice = await asOwner(async (tx) => {
      const drafted = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: kobe.id,
        invoiceDate: "2026-05-10",
        dueDate: "2026-06-20",
        amountsMode: "exclusive",
        lines: [{ description: "Consulting", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
      });
      return (await approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("approve") })).invoice;
    });
    for (const [name, level] of [
      ["full", "full"],
      ["post", "post"],
    ] as const) {
      const response = await tokensRoute.POST(
        apiRequest("/api/ai/tokens", {
          method: "POST",
          cookie: await sessionCookieFor(owner),
          body: { organisationId: ORG, name, accessLevel: level, ...(level === "full" ? { confirmFullAccess: true } : {}) },
        }),
        noContext,
      );
      expect(response.status).toBe(201);
      tokens[name] = ((await response.json()) as { token: string }).token;
    }
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("AIF1: make, approve and apply a credit note, as CN1-CN3; retries do nothing more", async () => {
    const args = { contactId: kobe.id, creditNoteDate: "2026-05-15", amountsMode: "exclusive", lines: [line("20.00")], idempotencyKey: "aif1-credit-note" };
    const made = (await call(tokens.full, "create_credit_note", args)) as { creditNote: { id: string; status: string } };
    expect(made.creditNote.status).toBe("draft");
    expect(await call(tokens.full, "create_credit_note", args)).toMatchObject({ created: false });
    const approved = (await call(tokens.full, "approve_credit_note", { creditNoteId: made.creditNote.id, idempotencyKey: "aif1-approve" })) as {
      creditNote: { approvalJournalId: string; total: string };
    };
    expect(approved.creditNote.total).toBe("23.00");
    expect(await postedLines(approved.creditNote.approvalJournalId)).toEqual([
      ["4000", "20.00", "0.00"],
      ["2100", "3.00", "0.00"],
      ["1100", "0.00", "23.00"],
    ]);
    const before = await journalCount();
    expect(await call(tokens.full, "approve_credit_note", { creditNoteId: made.creditNote.id, idempotencyKey: "aif1-approve" })).toMatchObject({ created: false });
    const apply = { creditNoteId: made.creditNote.id, applicationDate: "2026-05-16", applications: [{ invoiceId: invoice.id, amount: "23.00" }], idempotencyKey: "aif1-apply" };
    await call(tokens.full, "apply_credit_note", apply);
    await call(tokens.full, "apply_credit_note", apply);
    expect(await journalCount()).toBe(before);
    expect(await asOwner((tx) => getInvoice(tx, invoice.id))).toMatchObject({ amountDue: "92.00" });
    expect(((await call(tokens.post, "list_credit_notes")).creditNotes as Json[]).map((note) => note.id)).toContain(made.creditNote.id);
  });

  it("AIF2: a purchase order no rule covers is approved; one an approval rule covers is for people (AW13)", async () => {
    const order = async (unitPrice: string) =>
      ((await call(tokens.full, "create_purchase_order", { contactId: kauri.id, orderDate: "2026-05-20", amountsMode: "exclusive", lines: [line(unitPrice, "6010")] })) as {
        purchaseOrder: { id: string };
      }).purchaseOrder.id;
    const small = await order("500.00");
    expect(await call(tokens.full, "approve_purchase_order", { purchaseOrderId: small })).toMatchObject({ purchaseOrder: { status: "approved" } });
    await asOwner((tx) =>
      createApprovalRule(tx, "owner", { documentType: "purchase_order", name: "Over $1,000", minTotal: "1000.00", steps: [{ mode: "any", approverUserIds: [owner.id] }] }),
    );
    const big = await order("1000.00");
    await expect(call(tokens.full, "approve_purchase_order", { purchaseOrderId: big })).rejects.toThrow("This purchase order needs a person's approval (rule: Over $1,000).");
    expect(await call(tokens.full, "get_purchase_order", { purchaseOrderId: big })).toMatchObject({ status: "draft" });
  });

  it("AIF3: items, accounts and tracking can be added and edited but never switched off", async () => {
    const item = ((await call(tokens.full, "create_item", {
      code: "CONSULT",
      name: "Consulting",
      itemType: "service",
      salePrice: "150.00",
      incomeAccountCode: "4000",
      salesTaxCode: "GST",
    })) as { item: { id: string } }).item;
    expect(await call(tokens.full, "update_item", { itemId: item.id, name: "Consulting (hourly)", isActive: false })).toMatchObject({ name: "Consulting (hourly)", isActive: true });
    const account = (await call(tokens.full, "create_account", { code: "6125", name: "Fuel cards", accountType: "expense" })) as { id: string };
    expect(await call(tokens.full, "update_account", { accountId: account.id, name: "Fuel card costs", isActive: false })).toMatchObject({ name: "Fuel card costs", isActive: true });
    // Tracking needs the Advanced reporting module, as on the screen; the service's answer comes back as it is.
    await expect(call(tokens.full, "create_tracking_category", { name: "Region" })).rejects.toThrow("Advanced reporting is off");
    for (const tool of FULL_WRITE_TOOLS) expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/isActive|archiv|"status"/);
  });

  it("AIF4: registers an asset and runs depreciation, as FA3; the preview posts nothing", async () => {
    const type = (
      await asOwner((tx) =>
        createFixedAssetType(tx, {
          idempotencyKey: key("type"),
          name: "Computer equipment",
          assetAccountCode: "1620",
          accumulatedDepreciationAccountCode: "1630",
          depreciationExpenseAccountCode: "6300",
          method: "dv",
          rate: "50",
        }),
      )
    ).type;
    const registered = (await call(tokens.full, "register_fixed_asset", { name: "Laptop", typeId: type.id, purchaseDate: "2026-05-10", cost: "2000.00" })) as {
      asset: { assetNumber: string };
    };
    expect(registered.asset.assetNumber).toBe("FA-0001");
    const before = await journalCount();
    const preview = await call(tokens.post, "preview_depreciation", { periodEnd: "2026-05-31" });
    expect(JSON.stringify(preview)).toContain("83.33");
    expect(await journalCount()).toBe(before);
    const run = (await call(tokens.full, "run_depreciation", { periodEnd: "2026-05-31", idempotencyKey: "aif4-run" })) as { run: { journalId: string } };
    expect(await postedLines(run.run.journalId)).toEqual([
      ["6300", "83.33", "0.00"],
      ["1630", "0.00", "83.33"],
    ]);
  });

  it("AIF5: a Make and post key reads these but can't change anything or read expense claims", async () => {
    const listed = ((await rpc(tokens.post, "tools/list")).result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    for (const tool of FULL_READ_TOOLS) expect(listed.includes(tool.name), tool.name).toBe(tool.level === "read");
    for (const tool of FULL_WRITE_TOOLS) expect(listed, tool.name).not.toContain(tool.name);
    await expect(call(tokens.post, "create_quote", { contactId: kobe.id })).rejects.toThrow(/Full access/);
    await expect(call(tokens.post, "list_expense_claims")).rejects.toThrow(/Full access/);
    expect(await call(tokens.full, "list_expense_claims")).toEqual({ claims: [], more: false });
  });

  it("AIF6: a refund paid for a credit note posts Dr 1100 / Cr 1000 (as CN8)", async () => {
    const made = ((await call(tokens.full, "create_credit_note", { contactId: kobe.id, creditNoteDate: "2026-05-15", amountsMode: "exclusive", lines: [line("20.00")] })) as {
      creditNote: { id: string };
    }).creditNote;
    await call(tokens.full, "approve_credit_note", { creditNoteId: made.id });
    const refunded = (await call(tokens.full, "refund_credit_note", { creditNoteId: made.id, refundDate: "2026-05-25", amount: "23.00", bankAccountCode: "1000" })) as {
      refund: { journalId: string };
    };
    expect(await postedLines(refunded.refund.journalId)).toEqual([
      ["1100", "23.00", "0.00"],
      ["1000", "0.00", "23.00"],
    ]);
  });

  it("quotes, sales orders, repeating invoices and budgets work through the same services", async () => {
    const quote = ((await call(tokens.full, "create_quote", { contactId: kobe.id, quoteDate: "2026-05-20", amountsMode: "exclusive", lines: [line("100.00")] })) as {
      quote: { id: string };
    }).quote;
    expect(await call(tokens.full, "finalise_quote", { quoteId: quote.id })).toMatchObject({ quote: { status: "finalised" } });
    const order = ((await call(tokens.full, "create_sales_order", { contactId: kobe.id, orderDate: "2026-05-20", amountsMode: "exclusive", lines: [line("100.00")] })) as {
      salesOrder: { id: string };
    }).salesOrder;
    expect(await call(tokens.full, "approve_sales_order", { salesOrderId: order.id })).toMatchObject({ salesOrder: { status: "pending_billing" } });
    const repeating = await call(tokens.full, "create_repeating_invoice", {
      contactId: kobe.id,
      amountsMode: "exclusive",
      lines: [line("100.00")],
      period: "month",
      every: 1,
      startDate: "2026-06-01",
      dueRule: "days_after",
      dueDays: 20,
      saveAs: "draft",
    });
    expect(repeating).toMatchObject({ created: true, repeatingInvoice: { status: "active" } });
    const budget = ((await call(tokens.full, "create_budget", { name: "FY27" })) as { budget: { id: string } }).budget;
    const grid = (await call(tokens.full, "get_budget", { budgetId: budget.id, from: "2026-04", months: 12 })) as { budget: { version: number } };
    const set = await call(tokens.full, "set_budget_amounts", { budgetId: budget.id, version: grid.budget.version, amounts: [{ accountCode: "4000", month: "2026-04", amount: "1000.00" }] });
    expect(set).toMatchObject({ changed: 1 });
  });
});

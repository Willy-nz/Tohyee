import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill, getBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { createCustomField } from "@/lib/custom-fields/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createInvoice, getInvoice } from "@/lib/invoices/service";
import { addItemUnit, createItem, type Item } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
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

const ORG = "ai-lossless";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

let rpcId = 0;
async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
    noContext,
  );
  const body = (await response.json()) as Json;
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

/** The parts of a saved line an AI edit must never lose (#537). */
const kept = (line: Json) => ({
  itemId: line.itemId,
  unitId: line.unitId,
  baseQuantity: line.baseQuantity,
  tracking: line.tracking,
  customFields: line.customFields,
  accountCode: line.accountCode,
  taxCode: line.taxCode,
  quantity: line.quantity,
  unitPrice: line.unitPrice,
});

/** #537, decision 1263: AI line edits keep items, units, tracking and custom fields, or are refused with no change. */
describeWithDatabase("lossless AI line edits (#537, decision 1263)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let customer: Contact;
  let supplier: Contact;
  let widget: Item;
  let box: string;
  let department: string;
  let retail: string;
  let wholesale: string;
  let engraving: string;
  const tokens: Record<string, string> = {};
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  async function makeKey(name: string, accessLevel: string) {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", {
        method: "POST",
        cookie: await sessionCookieFor(owner),
        body: { organisationId: ORG, name, accessLevel, ...(accessLevel === "full" ? { confirmFullAccess: true } : {}) },
      }),
      noContext,
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  }

  /** A line with an item in boxes of 10, a tracking option and a line custom field. */
  const richLine = (extra: Json = {}) => ({
    itemId: widget.id,
    unitId: box,
    quantity: "1",
    description: "Widgets",
    unitPrice: "120.00",
    accountCode: "4000",
    taxCode: "GST",
    tracking: { [department]: retail },
    ...extra,
  });
  const plainLine = { description: "Engraving", quantity: "1", unitPrice: "25.00", accountCode: "4000", taxCode: "GST" };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("lossless-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    customer = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kowhai Pets", isCustomer: true }))).contact;
    supplier = (await as((tx) => createContact(tx, { idempotencyKey: key("s"), name: "Paw Supplies", isSupplier: true }))).contact;
    widget = (
      await as((tx) =>
        createItem(tx, {
          idempotencyKey: key("item"),
          code: "WIDGET",
          name: "Widget",
          itemType: "stock",
          salePrice: "12.00",
          purchasePrice: "5.00",
          incomeAccountCode: "4000",
          purchaseAccountCode: "1400",
          salesTaxCode: "GST",
          purchaseTaxCode: "GST",
        }),
      )
    ).item;
    box = (await as((tx) => addItemUnit(tx, widget.id, { name: "Box of 10", factor: "10" }))).units.find((unit) => unit.name === "Box of 10")!.id;
    department = (await as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
    for (const name of ["Retail", "Wholesale"]) await as((tx) => createTrackingValue(tx, { categoryId: department, name }));
    const values = (await as((tx) => getTrackingSetup(tx))).categories.find((category) => category.id === department)!.values;
    retail = values.find((value) => value.name === "Retail")!.id;
    wholesale = values.find((value) => value.name === "Wholesale")!.id;
    const fields = await as((tx) =>
      createCustomField(tx, { record: "line", label: "Engraving text", type: "text", usedOn: ["invoice", "bill", "credit_note", "supplier_credit_note"] }),
    );
    engraving = fields.fields.find((field) => field.label === "Engraving text")!.id;
    // 20 widgets in stock at 5.00, so selling a box of 10 costs 50.00 (ST1, ST2).
    const received = await as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: supplier.id,
        billDate: "2026-06-01",
        dueDate: "2026-07-01",
        supplierInvoiceNumber: "PS-1",
        amountsMode: "exclusive",
        lines: [{ itemId: widget.id, quantity: "20" }],
      }),
    );
    await as((tx) => approveBill(tx, received.bill.id, { idempotencyKey: key("a") }));
    tokens.draft = await makeKey("Drafts", "draft");
    tokens.post = await makeKey("Post", "post");
    tokens.full = await makeKey("Full", "full");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function richDraftInvoice() {
    return (
      await as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("inv"),
          contactId: customer.id,
          invoiceDate: "2026-06-15",
          dueDate: "2026-07-15",
          amountsMode: "exclusive",
          lines: [richLine({ customFields: { [engraving]: "Kobe" } }), plainLine],
        }),
      )
    ).invoice;
  }

  it("get_invoice shows each line's lineId, item, unit, tracking and custom fields", async () => {
    const invoice = await richDraftInvoice();
    const read = await call(tokens.draft, "get_invoice", { id: invoice.id });
    const lines = read.lines as Json[];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      lineId: expect.stringMatching(/^\d+$/),
      line: 1,
      itemId: widget.id,
      itemCode: "WIDGET",
      unitId: box,
      unitName: "Box of 10",
      tracking: { [department]: retail },
      customFields: { [engraving]: "Kobe" },
    });
    expect(lines[1]).toMatchObject({ itemId: null, unitId: null, tracking: {}, customFields: {} });
  });

  it("changing only a description through update_draft_invoice keeps every other field, and approval still moves stock", async () => {
    const invoice = await richDraftInvoice();
    const before = await as((tx) => getInvoice(tx, invoice.id));
    const read = await call(tokens.draft, "get_invoice", { id: invoice.id });
    const [first, second] = read.lines as Json[];

    const edited = await call(tokens.draft, "update_draft_invoice", {
      invoiceId: invoice.id,
      lines: [{ lineId: first.lineId, description: "Widgets, boxed" }, { lineId: second.lineId }],
    });
    const after = await as((tx) => getInvoice(tx, invoice.id));
    expect(after.lines.map((line) => line.description)).toEqual(["Widgets, boxed", "Engraving"]);
    expect(after.lines.map(kept)).toEqual(before.lines.map(kept));
    expect(after.lines[0]).toMatchObject({ itemId: widget.id, unitId: box, baseQuantity: "10", customFields: { [engraving]: "Kobe" } });
    expect(after.total).toBe(before.total);
    // The answer has the new lineIds (the service saves the lines again).
    expect((edited.invoice as Json).lines).toEqual([
      expect.objectContaining({ description: "Widgets, boxed", itemId: widget.id, unitId: box }),
      expect.objectContaining({ description: "Engraving" }),
    ]);

    // A header-only edit keeps the lines as they are.
    await call(tokens.draft, "update_draft_invoice", { invoiceId: invoice.id, reference: "PO-77" });
    const headerOnly = await as((tx) => getInvoice(tx, invoice.id));
    expect(headerOnly.reference).toBe("PO-77");
    expect(headerOnly.lines.map(kept)).toEqual(before.lines.map(kept));

    // Approving it still takes a box of 10 out of stock at cost (ST2): 10 x 5.00.
    const approved = (await call(tokens.post, "approve_invoice", { invoiceId: invoice.id, idempotencyKey: key("approve") })).invoice as Json;
    expect(approved.status).toBe("approved");
    const posted = await as(async (tx) => (await getJournal(tx, (await getInvoice(tx, invoice.id)).approvalJournalId!)).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]));
    expect(posted).toEqual(expect.arrayContaining([["5000", "50.00", "0.00"], ["1400", "0.00", "50.00"]]));
  });

  it("a replacement in the old shape (no lineIds) is refused with a clear reason, and nothing changes", async () => {
    const invoice = await richDraftInvoice();
    const before = await as((tx) => getInvoice(tx, invoice.id));
    const read = await call(tokens.draft, "get_invoice", { id: invoice.id });
    // What an AI would send from the read: the advertised fields only.
    const resent = (read.lines as Json[]).map((line, index) => ({
      description: index === 0 ? "Widgets, boxed" : line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountCode: String(line.account).split(" ")[0],
      taxCode: line.taxCode,
    }));
    const refusal = call(tokens.draft, "update_draft_invoice", { invoiceId: invoice.id, lines: resent });
    await expect(refusal).rejects.toThrow(/Nothing was changed/);
    await expect(call(tokens.draft, "update_draft_invoice", { invoiceId: invoice.id, lines: resent })).rejects.toThrow(
      /line 1 "Widgets" \(lineId \d+\), which has an item and unit, tracking, custom fields/,
    );
    const after = await as((tx) => getInvoice(tx, invoice.id));
    expect(after.lines).toEqual(before.lines);
    expect(after.updatedAt).toBe(before.updatedAt);

    // Even with a lineId, an id from before an edit is refused: read again first.
    const [first, second] = read.lines as Json[];
    await call(tokens.draft, "update_draft_invoice", { invoiceId: invoice.id, lines: [{ lineId: first.lineId }, { lineId: second.lineId }, plainLine] });
    await expect(
      call(tokens.draft, "update_draft_invoice", { invoiceId: invoice.id, lines: [{ lineId: first.lineId, description: "Stale" }] }),
    ).rejects.toThrow(/isn't one of this invoice's lines now/);
  });

  it("clearing is explicit: null clears a field, a tracking category or an item; removeLineIds takes a line off", async () => {
    const invoice = await richDraftInvoice();
    let read = await call(tokens.draft, "get_invoice", { id: invoice.id });
    let [first, second] = read.lines as Json[];

    // Only the tracking category sent changes; the custom field and item stay.
    await call(tokens.draft, "update_draft_invoice", {
      invoiceId: invoice.id,
      lines: [{ lineId: first.lineId, tracking: { [department]: wholesale } }, { lineId: second.lineId }],
    });
    let saved = await as((tx) => getInvoice(tx, invoice.id));
    expect(saved.lines[0]).toMatchObject({ itemId: widget.id, unitId: box, tracking: { [department]: wholesale }, customFields: { [engraving]: "Kobe" } });

    read = await call(tokens.draft, "get_invoice", { id: invoice.id });
    [first, second] = read.lines as Json[];
    await call(tokens.draft, "update_draft_invoice", {
      invoiceId: invoice.id,
      lines: [{ lineId: first.lineId, tracking: { [department]: null }, customFields: { [engraving]: null } }, { lineId: second.lineId }],
    });
    saved = await as((tx) => getInvoice(tx, invoice.id));
    expect(saved.lines[0]).toMatchObject({ itemId: widget.id, unitId: box, tracking: {}, customFields: {} });

    // itemId null takes off the item and its unit, keeping the line's own description, price and account.
    read = await call(tokens.draft, "get_invoice", { id: invoice.id });
    [first, second] = read.lines as Json[];
    await call(tokens.draft, "update_draft_invoice", { invoiceId: invoice.id, lines: [{ lineId: first.lineId, itemId: null }, { lineId: second.lineId }] });
    saved = await as((tx) => getInvoice(tx, invoice.id));
    expect(saved.lines[0]).toMatchObject({ itemId: null, unitId: null, baseQuantity: null, description: "Widgets", unitPrice: "120", accountCode: "4000" });

    // removeLineIds alone takes a line off and keeps the rest.
    read = await call(tokens.draft, "get_invoice", { id: invoice.id });
    [first, second] = read.lines as Json[];
    await call(tokens.draft, "update_draft_invoice", { invoiceId: invoice.id, removeLineIds: [second.lineId] });
    saved = await as((tx) => getInvoice(tx, invoice.id));
    expect(saved.lines.map((line) => line.description)).toEqual(["Widgets"]);

    // A line both kept and removed, or sent twice, is refused.
    read = await call(tokens.draft, "get_invoice", { id: invoice.id });
    [first] = read.lines as Json[];
    await expect(call(tokens.draft, "update_draft_invoice", { invoiceId: invoice.id, lines: [{ lineId: first.lineId }], removeLineIds: [first.lineId] })).rejects.toThrow(
      /in both lines and removeLineIds/,
    );
    await expect(call(tokens.draft, "update_draft_invoice", { invoiceId: invoice.id, lines: [{ lineId: first.lineId }, { lineId: first.lineId }] })).rejects.toThrow(/twice/);
  });

  it("update_draft_bill keeps items, tracking, custom fields and purchase details the same way", async () => {
    const bill = (
      await as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: supplier.id,
          billDate: "2026-06-10",
          dueDate: "2026-07-10",
          supplierInvoiceNumber: "PS-2",
          amountsMode: "exclusive",
          lines: [
            { itemId: widget.id, unitId: box, quantity: "1", description: "Widgets", unitPrice: "50.00", accountCode: "1400", taxCode: "GST", tracking: { [department]: retail }, customFields: { [engraving]: "Bulk" } },
            { description: "Freight", quantity: "1", unitPrice: "10.00", accountCode: "6010", taxCode: "GST" },
          ],
        }),
      )
    ).bill;
    const before = await as((tx) => getBill(tx, bill.id));
    const read = await call(tokens.draft, "get_bill", { id: bill.id });
    const [first, second] = read.lines as Json[];
    expect(first).toMatchObject({ itemId: widget.id, unitId: box, tracking: { [department]: retail }, customFields: { [engraving]: "Bulk" } });
    await expect(
      call(tokens.draft, "update_draft_bill", { billId: bill.id, lines: [{ description: "Widgets", quantity: "1", unitPrice: "50.00", accountCode: "1400", taxCode: "GST" }, { lineId: second.lineId }] }),
    ).rejects.toThrow(/which has an item and unit, tracking, custom fields/);
    await call(tokens.draft, "update_draft_bill", { billId: bill.id, lines: [{ lineId: first.lineId, description: "Widgets (boxed)" }, { lineId: second.lineId }] });
    const after = await as((tx) => getBill(tx, bill.id));
    expect(after.lines[0].description).toBe("Widgets (boxed)");
    expect(after.lines.map(kept)).toEqual(before.lines.map(kept));
    await call(tokens.draft, "update_draft_bill", { billId: bill.id, supplierInvoiceNumber: "PS-2A" });
    expect((await as((tx) => getBill(tx, bill.id))).lines.map(kept)).toEqual(before.lines.map(kept));
  });

  const sales = (extra: Json = {}) => ({ amountsMode: "exclusive", contactId: customer.id, lines: [richLine(), plainLine], ...extra });
  const purchase = (extra: Json = {}) => ({
    amountsMode: "exclusive",
    contactId: supplier.id,
    lines: [
      { itemId: widget.id, unitId: box, quantity: "1", description: "Widgets", unitPrice: "50.00", accountCode: "1400", taxCode: "GST", tracking: { [department]: retail } },
      { description: "Freight", quantity: "1", unitPrice: "10.00", accountCode: "6010", taxCode: "GST" },
    ],
    ...extra,
  });
  const schedule = { period: "month", every: 1, startDate: "2026-08-01", saveAs: "draft" };
  // Every other AI edit tool that shares the line schemas (#537's audit).
  const documents = [
    { noun: "quote", create: "create_quote", get: "get_quote", update: "update_quote", id: "quoteId", made: "quote", args: () => sales({ quoteDate: "2026-06-15" }) },
    { noun: "sales order", create: "create_sales_order", get: "get_sales_order", update: "update_sales_order", id: "salesOrderId", made: "salesOrder", args: () => sales({ orderDate: "2026-06-15" }) },
    { noun: "credit note", create: "create_credit_note", get: "get_credit_note", update: "update_credit_note", id: "creditNoteId", made: "creditNote", args: () => sales({ creditNoteDate: "2026-06-15" }) },
    { noun: "purchase order", create: "create_purchase_order", get: "get_purchase_order", update: "update_purchase_order", id: "purchaseOrderId", made: "purchaseOrder", args: () => purchase({ orderDate: "2026-06-15" }) },
    { noun: "supplier credit note", create: "create_supplier_credit_note", get: "get_supplier_credit_note", update: "update_supplier_credit_note", id: "creditNoteId", made: "creditNote", args: () => purchase({ creditNoteDate: "2026-06-15", supplierCreditNoteNumber: "PSC-1" }) },
    { noun: "repeating invoice", create: "create_repeating_invoice", get: "get_repeating_invoice", update: "update_repeating_invoice", id: "repeatingInvoiceId", made: "repeatingInvoice", args: () => sales({ ...schedule, dueRule: "days_after", dueDays: 20 }) },
    { noun: "repeating bill", create: "create_repeating_bill", get: "get_repeating_bill", update: "update_repeating_bill", id: "repeatingBillId", made: "repeatingBill", args: () => purchase({ ...schedule, dueRule: "days_after", dueDays: 20 }) },
  ];

  it.each(documents)("$update keeps a line's item, unit and tracking, and refuses a lossy replacement", async (doc) => {
    const made = (await call(tokens.full, doc.create, { ...doc.args(), idempotencyKey: key("make") })) as Json;
    const id = String(((made[doc.made] ?? made) as Json).id);
    const read = await call(tokens.full, doc.get, { [doc.id]: id });
    const [first, second] = read.lines as Json[];
    expect(first).toMatchObject({ lineId: expect.stringMatching(/^\d+$/), itemId: widget.id, unitId: box, tracking: { [department]: retail } });

    await expect(
      call(tokens.full, doc.update, { [doc.id]: id, lines: [{ description: "Widgets", quantity: "1", unitPrice: "50.00", accountCode: String(first.accountCode), taxCode: "GST" }] }),
    ).rejects.toThrow(/Nothing was changed.*which has an item and unit, tracking/);
    const unchanged = await call(tokens.full, doc.get, { [doc.id]: id });
    expect(unchanged.lines).toEqual(read.lines);

    const updated = await call(tokens.full, doc.update, { [doc.id]: id, lines: [{ lineId: first.lineId, description: "Widgets, boxed" }, { lineId: second.lineId }] });
    expect((updated.lines as Json[])[0]).toMatchObject({ lineId: expect.any(String), description: "Widgets, boxed", itemId: widget.id, unitId: box, tracking: { [department]: retail } });
    const after = await call(tokens.full, doc.get, { [doc.id]: id });
    // Everything but the ids (saved again) and the description that was changed.
    const strip = (line: Json) => Object.fromEntries(Object.entries(line).filter(([name]) => !["lineId", "id", "description"].includes(name)));
    expect((after.lines as Json[]).map(strip)).toEqual((read.lines as Json[]).map(strip));
  });
});

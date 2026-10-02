import { afterAll, beforeAll, expect, it } from "vitest";
import * as purchaseOrdersRoute from "@/app/api/purchase-orders/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill, deleteBill, getBill, updateBill, voidBill } from "@/lib/bills/service";
import { archiveContact, type Contact, createContact, updateContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { printedDocument } from "@/lib/documents/print";
import { createItem, updateItem } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  copyPurchaseOrderToBill,
  createPurchaseOrder,
  deletePurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  type PurchaseOrder,
  updatePurchaseOrder,
} from "@/lib/purchase-orders/service";
import { inventoryValuation } from "@/lib/reports/financial";
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

/** Examples PO1-PO9 in docs/ACCOUNTING-EXAMPLES.md ("Purchase orders"). Each test gets its own organisation. */
describeWithDatabase("purchase orders", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("po-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("po-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { advanced?: boolean } = {}) {
    organisations += 1;
    const org = `po-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { displayName: "Glimmers", postalAddress: "PO Box 5, Dunedin", ...(options.advanced ? { advancedFeatures: true } : {}) }));
    const contact = async (name: string, extra: Record<string, unknown> = {}): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, isSupplier: true, ...extra }))).contact;
    const paw = await contact("Paw Supplies", { postalAddress: "4 Wharf St, Port Chalmers" });
    const item = async (fields: Record<string, unknown>) =>
      (await as((tx) => createItem(tx, { idempotencyKey: key("item"), purchaseTaxCode: "GST", salesTaxCode: "GST", incomeAccountCode: "4000", ...fields }))).item;
    const widget = await item({ code: "WIDGET", name: "Widget", itemType: "stock", salePrice: "12.00", purchasePrice: "5.00", purchaseAccountCode: "1400" });
    const giftBox = await item({ code: "GIFTBOX", name: "Gift box", itemType: "non_stock", salePrice: "4.00", purchasePrice: "2.00", purchaseAccountCode: "5100" });
    const lines = [
      { itemId: widget.id, quantity: "10" },
      { itemId: giftBox.id, quantity: "100" },
    ];
    const draft = async (extra: Record<string, unknown> = {}) =>
      (
        await as((tx) =>
          createPurchaseOrder(tx, {
            idempotencyKey: key("po"),
            contactId: paw.id,
            orderDate: "2026-07-01",
            deliveryDate: "2026-07-10",
            deliveryAddress: "12 Stuart St, Dunedin 9016",
            amountsMode: "exclusive",
            lines,
            ...extra,
          }),
        )
      ).purchaseOrder;
    const approve = async (id: string) => (await as((tx) => approvePurchaseOrder(tx, id, { idempotencyKey: key("appr") }))).purchaseOrder;
    const copy = async (id: string, supplierInvoiceNumber: string, idempotencyKey = key("copy")) =>
      as((tx) => copyPurchaseOrderToBill(tx, id, { idempotencyKey, billDate: "2026-07-12", dueDate: "2026-08-20", supplierInvoiceNumber }));
    const approveTheBill = async (id: string) => (await as((tx) => approveBill(tx, id, { idempotencyKey: key("ab") }))).bill;
    const journal = async (journalId: string) =>
      (await as((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    const billing = (order: PurchaseOrder) => order.lines.map((line) => [line.billedQuantity, line.onDraftBillsQuantity, line.remainingQuantity]);
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    return { org, as, paw, contact, widget, giftBox, lines, draft, approve, copy, approveTheBill, journal, billing, journals };
  }

  it("PO1: a draft works out like a bill, fills items at the supplier's price and posts nothing", async () => {
    const w = await setup();
    const order = await w.draft();
    expect([order.status, order.poNumber, order.subtotal, order.taxTotal, order.total]).toEqual(["draft", null, "250.00", "37.50", "287.50"]);
    expect(order.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.accountCode, l.lineAmount, l.taxAmount])).toEqual([
      ["Widget", "10", "5", "1400", "50.00", "7.50"],
      ["Gift box", "100", "2", "5100", "200.00", "30.00"],
    ]);
    expect([order.deliveryDate, order.deliveryAddress]).toEqual(["2026-07-10", "12 Stuart St, Dunedin 9016"]);
    expect(await w.journals()).toBe(0);
    await expect(w.draft({ deliveryDate: "2026-06-30" })).rejects.toThrow("delivery date can't be before the order date");
    const edited = await w.as((tx) => updatePurchaseOrder(tx, order.id, { reference: "Winter stock" }));
    expect([edited.reference, edited.total]).toEqual(["Winter stock", "287.50"]);

    // With Advanced reporting on, Paw's own price fills WIDGET (IT6).
    const a = await setup({ advanced: true });
    await a.as((tx) => updateItem(tx, a.widget.id, { suppliers: [{ contactId: a.paw.id, price: "4.80", isPreferred: true }] }));
    const priced = await a.draft({ lines: [{ itemId: a.widget.id, quantity: "10" }] });
    expect([priced.lines[0].unitPrice, priced.total]).toEqual(["4.8", "55.20"]);
  });

  it("PO2: approving numbers PO-0001 with no gaps, locks it and posts nothing", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    expect([order.status, order.poNumber]).toEqual(["approved", "PO-0001"]);
    await expect(w.as((tx) => updatePurchaseOrder(tx, order.id, { reference: "x" }))).rejects.toThrow("approved, so it can't be edited");
    await expect(w.as((tx) => deletePurchaseOrder(tx, order.id))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update purchase_orders set total = 1 where id = $1", [order.id]))).rejects.toThrow("can't be changed");
    await expect(w.as((tx) => tx.query("update purchase_order_lines set description = 'x' where purchase_order_id = $1", [order.id]))).rejects.toThrow(
      "Lines of an approved purchase order can't be changed",
    );
    await expect(w.as((tx) => tx.query("delete from purchase_orders where id = $1", [order.id]))).rejects.toThrow("can't be deleted");
    expect(await w.journals()).toBe(0);

    const otago = await w.contact("Otago Wholesale");
    const second = await w.draft({ contactId: otago.id });
    await w.as((tx) => archiveContact(tx, otago.id));
    await expect(w.approve(second.id)).rejects.toThrow("Otago Wholesale is archived");
    expect((await w.as((tx) => getPurchaseOrder(tx, second.id))).status).toBe("draft");
    expect((await w.approve((await w.draft()).id)).poNumber).toBe("PO-0002");
  });

  it("PO3: copy to bill makes a linked draft bill; approving it bills the purchase order", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const copyKey = key("copy");
    const { bill, purchaseOrder } = await w.copy(order.id, "PS-101", copyKey);
    expect([bill.status, bill.contactId, bill.billDate, bill.dueDate, bill.supplierInvoiceNumber, bill.total]).toEqual([
      "draft",
      w.paw.id,
      "2026-07-12",
      "2026-08-20",
      "PS-101",
      "287.50",
    ]);
    expect([bill.purchaseOrderId, bill.purchaseOrderNumber]).toEqual([order.id, "PO-0001"]);
    expect(bill.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.accountCode, l.purchaseOrderLineId])).toEqual([
      ["Widget", "10", "5", "1400", order.lines[0].id],
      ["Gift box", "100", "2", "5100", order.lines[1].id],
    ]);
    expect(purchaseOrder.status).toBe("approved");
    expect(w.billing(purchaseOrder)).toEqual([
      ["0", "10", "0"],
      ["0", "100", "0"],
    ]);
    await expect(w.copy(order.id, "PS-102")).rejects.toThrow("already on bills (some of them drafts)");
    // The same copy retried returns the same bill.
    expect((await w.copy(order.id, "PS-101", copyKey)).bill.id).toBe(bill.id);
    await expect(w.copy(order.id, "PS-999", copyKey)).rejects.toThrow("already used for a different copy");

    const approved = await w.approveTheBill(bill.id);
    expect(await w.journal(approved.approvalJournalId!)).toEqual([
      ["1400", "50.00", "0.00"],
      ["5100", "200.00", "0.00"],
      ["2100", "37.50", "0.00"],
      ["2000", "0.00", "287.50"],
    ]);
    const stock = await w.as((tx) => inventoryValuation(tx));
    expect(stock.items.map((row) => [row.itemCode, row.quantity, row.value])).toEqual([["WIDGET", "10", "50.00"]]);
    const billed = await w.as((tx) => getPurchaseOrder(tx, order.id));
    expect(billed.status).toBe("billed");
    expect(w.billing(billed)).toEqual([
      ["10", "0", "0"],
      ["100", "0", "0"],
    ]);
    expect(billed.bills.map((b) => [b.supplierInvoiceNumber, b.status])).toEqual([["PS-101", "approved"]]);
    expect((await w.as((tx) => listPurchaseOrders(tx, { status: "billed" }))).purchaseOrders.map((p) => p.poNumber)).toEqual(["PO-0001"]);
    expect((await w.as((tx) => listPurchaseOrders(tx, { status: "approved" }))).purchaseOrders).toEqual([]);
  });

  it("PO4, PO5: billing in parts; voiding or deleting a bill puts its quantities back", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const first = (await w.copy(order.id, "PS-201")).bill;
    const part = await w.as((tx) =>
      updateBill(tx, first.id, {
        lines: first.lines.map((line, index) => ({ ...line, quantity: index === 0 ? "6" : "40" })),
      }),
    );
    const firstApproved = await w.approveTheBill(part.id);
    expect(await w.journal(firstApproved.approvalJournalId!)).toEqual([
      ["1400", "30.00", "0.00"],
      ["5100", "80.00", "0.00"],
      ["2100", "16.50", "0.00"],
      ["2000", "0.00", "126.50"],
    ]);
    let current = await w.as((tx) => getPurchaseOrder(tx, order.id));
    expect(current.status).toBe("approved");
    expect(w.billing(current)).toEqual([
      ["6", "0", "4"],
      ["40", "0", "60"],
    ]);

    const second = (await w.copy(order.id, "PS-202")).bill;
    expect(second.lines.map((l) => [l.quantity, l.lineAmount])).toEqual([
      ["4", "20.00"],
      ["60", "120.00"],
    ]);
    expect([second.subtotal, second.taxTotal, second.total]).toEqual(["140.00", "21.00", "161.00"]);
    const secondApproved = await w.approveTheBill(second.id);
    expect((await w.as((tx) => getPurchaseOrder(tx, order.id))).status).toBe("billed");

    // PO5: voiding PS-202 puts its 4 and 60 back.
    await w.as((tx) => voidBill(tx, secondApproved.id, { idempotencyKey: key("v"), voidDate: "2026-07-13" }));
    current = await w.as((tx) => getPurchaseOrder(tx, order.id));
    expect(current.status).toBe("approved");
    expect(w.billing(current)).toEqual([
      ["6", "0", "4"],
      ["40", "0", "60"],
    ]);
    const third = (await w.copy(order.id, "PS-203")).bill;
    expect(third.lines.map((l) => l.quantity)).toEqual(["4", "60"]);
    await w.as((tx) => deleteBill(tx, third.id));
    expect(w.billing(await w.as((tx) => getPurchaseOrder(tx, order.id)))).toEqual([
      ["6", "0", "4"],
      ["40", "0", "60"],
    ]);
  });

  it("PO6: linked bill lines can't go over what was ordered, change item, or move supplier", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const bill = (await w.copy(order.id, "PS-201")).bill;
    const withQuantity = (quantity: string) => bill.lines.map((line, index) => ({ ...line, quantity: index === 0 ? quantity : line.quantity }));
    await expect(w.as((tx) => updateBill(tx, bill.id, { lines: withQuantity("11") }))).rejects.toThrow("at most 10 can be billed here");
    await expect(
      w.as((tx) => updateBill(tx, bill.id, { lines: bill.lines.map((line, index) => (index === 0 ? { ...line, itemId: w.giftBox.id, accountCode: "5100" } : line)) })),
    ).rejects.toThrow("keeps that line's item and unit");
    const otago = await w.contact("Otago Wholesale");
    await expect(w.as((tx) => updateBill(tx, bill.id, { contactId: otago.id }))).rejects.toThrow("its supplier can't change");
    // A bill that wasn't copied from the purchase order can't name its lines.
    await expect(
      w.as((tx) =>
        createBill(tx, {
          idempotencyKey: key("b"),
          contactId: w.paw.id,
          billDate: "2026-07-12",
          dueDate: "2026-08-20",
          supplierInvoiceNumber: "PS-300",
          amountsMode: "exclusive",
          lines: [{ ...bill.lines[0], quantity: "1" }],
        }),
      ),
    ).rejects.toThrow("wasn't made from a purchase order");
    // The database refuses going over too.
    await expect(w.as((tx) => tx.query("update bill_lines set quantity = 11, base_quantity = 11 where bill_id = $1 and line_order = 1", [bill.id]))).rejects.toThrow(
      "more than the purchase order line ordered",
    );
    await expect(w.as((tx) => tx.query("update bills set contact_id = $2 where id = $1", [bill.id, otago.id]))).rejects.toThrow(
      "from the purchase order's supplier",
    );

    // A line of its own and a different price are fine.
    const edited = await w.as((tx) =>
      updateBill(tx, bill.id, {
        lines: [
          { ...bill.lines[0], quantity: "6", unitPrice: "5.20" },
          { ...bill.lines[1], quantity: "40" },
          { description: "Freight", quantity: "1", unitPrice: "15.00", accountCode: "6010", taxCode: "GST" },
        ],
      }),
    );
    expect(edited.lines.map((l) => [l.lineAmount, l.purchaseOrderLineId])).toEqual([
      ["31.20", order.lines[0].id],
      ["80.00", order.lines[1].id],
      ["15.00", null],
    ]);
    await w.approveTheBill(edited.id);
    const current = await w.as((tx) => getPurchaseOrder(tx, order.id));
    expect(current.lines[0].unitPrice).toBe("5");
    expect(w.billing(current)).toEqual([
      ["6", "0", "4"],
      ["40", "0", "60"],
    ]);
    const second = (await w.copy(order.id, "PS-202")).bill;
    await expect(
      w.as((tx) => updateBill(tx, second.id, { lines: second.lines.map((line, index) => ({ ...line, quantity: index === 0 ? "5" : line.quantity })) })),
    ).rejects.toThrow("6 of it is on other bills, so at most 4 can be billed here");
  });

  it("PO10: closing the rest of a part-billed purchase order", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const close = (id: string, idempotencyKey = key("close")) => w.as((tx) => closePurchaseOrder(tx, id, { idempotencyKey }));
    const first = (await w.copy(order.id, "PS-201")).bill;
    const part = await w.as((tx) => updateBill(tx, first.id, { lines: first.lines.map((line, index) => ({ ...line, quantity: index === 0 ? "6" : "40" })) }));
    // A draft bill from it: refused.
    await expect(close(order.id)).rejects.toThrow(`${order.poNumber} has a draft bill, so it can't be closed. Approve or delete the draft bill first.`);
    await expect(w.as((tx) => tx.query("update purchase_orders set status = 'closed', closed_at = now() where id = $1", [order.id]))).rejects.toThrow("has a draft bill, so it can't be closed");
    const approved = await w.approveTheBill(part.id);
    const journalsBefore = await w.journals();
    const keyed = key("close");
    const closed = (await close(order.id, keyed)).purchaseOrder;
    expect(closed.status).toBe("closed");
    expect(w.billing(closed)).toEqual([
      ["6", "0", "0"],
      ["40", "0", "0"],
    ]);
    expect(await w.journals()).toBe(journalsBefore);
    const again = await close(order.id, keyed);
    expect([again.created, again.purchaseOrder.id]).toEqual([false, order.id]);
    await expect(w.copy(order.id, "PS-202")).rejects.toThrow(`${order.poNumber} is closed, so it can't be billed.`);
    await expect(close(order.id)).rejects.toThrow(`${order.poNumber} is already closed.`);
    // Voiding its bill is still allowed, and it stays closed.
    await w.as((tx) => voidBill(tx, approved.id, { idempotencyKey: key("v"), voidDate: "2026-07-13" }));
    expect((await w.as((tx) => getPurchaseOrder(tx, order.id))).status).toBe("closed");
    // A draft and a fully billed purchase order can't be closed (another organisation, so stock dates don't clash).
    const v = await setup();
    const draft = await v.draft();
    await expect(v.as((tx) => closePurchaseOrder(tx, draft.id, { idempotencyKey: key("close") }))).rejects.toThrow("This purchase order is still a draft. Delete it instead.");
    const full = await v.approve((await v.draft()).id);
    await v.approveTheBill((await v.copy(full.id, "PS-301")).bill.id);
    await expect(v.as((tx) => closePurchaseOrder(tx, full.id, { idempotencyKey: key("close") }))).rejects.toThrow(
      `${full.poNumber} is fully billed, so there's nothing left to close.`,
    );
  });

  it("PO7: cancelling an approved purchase order with no bills", async () => {
    const w = await setup();
    const draft = await w.draft();
    await expect(w.as((tx) => cancelPurchaseOrder(tx, draft.id, { idempotencyKey: key("x") }))).rejects.toThrow("still a draft");
    const order = await w.approve(draft.id);
    const bill = (await w.copy(order.id, "PS-101")).bill;
    await expect(w.as((tx) => cancelPurchaseOrder(tx, order.id, { idempotencyKey: key("x") }))).rejects.toThrow("has a bill (PS-101)");
    await expect(w.as((tx) => tx.query("update purchase_orders set status = 'cancelled', cancelled_at = now() where id = $1", [order.id]))).rejects.toThrow(
      "has bills, so it can't be cancelled",
    );
    await w.as((tx) => deleteBill(tx, bill.id));
    const cancelKey = key("x");
    const cancelled = (await w.as((tx) => cancelPurchaseOrder(tx, order.id, { idempotencyKey: cancelKey }))).purchaseOrder;
    expect(cancelled.status).toBe("cancelled");
    expect((await w.as((tx) => cancelPurchaseOrder(tx, order.id, { idempotencyKey: cancelKey }))).created).toBe(false);
    await expect(w.copy(order.id, "PS-102")).rejects.toThrow("is cancelled, so it can't be billed");
    await expect(w.as((tx) => cancelPurchaseOrder(tx, order.id, { idempotencyKey: key("x") }))).rejects.toThrow("already cancelled");
  });

  it("PO8: printing a purchase order", async () => {
    const w = await setup();
    const draft = await w.draft();
    const draftDoc = await w.as((tx) => printedDocument(tx, "purchase_order", draft.id));
    expect([draftDoc.labels.title, draftDoc.number]).toEqual(["Draft purchase order", null]);
    const order = await w.approve(draft.id);
    const doc = await w.as((tx) => printedDocument(tx, "purchase_order", order.id));
    expect([doc.labels.title, doc.number, doc.date, doc.deliveryDate, doc.deliveryAddress]).toEqual([
      "Purchase order",
      "PO-0001",
      "2026-07-01",
      "2026-07-10",
      "12 Stuart St, Dunedin 9016",
    ]);
    expect([doc.customer, doc.organisation]).toEqual([
      { name: "Paw Supplies", billingAddress: "4 Wharf St, Port Chalmers", contactIdentifier: null },
      { name: "Glimmers", postalAddress: "PO Box 5, Dunedin", gstNumber: null },
    ]);
    expect([doc.subtotal, doc.taxTotal, doc.total, doc.labels.isTaxDocument, doc.labels.gstLine, doc.paymentDetails, doc.labels.warnings]).toEqual([
      "250.00",
      "37.50",
      "287.50",
      false,
      true,
      null,
      [],
    ]);
    await w.as((tx) => cancelPurchaseOrder(tx, order.id, { idempotencyKey: key("x") }));
    const viewerDoc = await inOrganisation(w.org, { userId: viewer.id, email: viewer.email }, (tx) => printedDocument(tx, "purchase_order", order.id));
    expect(viewerDoc.labels.title).toBe("Cancelled purchase order");
    expect(await w.journals()).toBe(0);
  });

  it("PO9: retries, refusals and roles", async () => {
    const w = await setup();
    const createKey = key("po");
    const input = { contactId: w.paw.id, orderDate: "2026-07-01", amountsMode: "exclusive", lines: w.lines };
    const created = await w.as((tx) => createPurchaseOrder(tx, { idempotencyKey: createKey, ...input }));
    const again = await w.as((tx) => createPurchaseOrder(tx, { idempotencyKey: createKey, ...input }));
    expect([created.created, again.created, again.purchaseOrder.id]).toEqual([true, false, created.purchaseOrder.id]);
    await expect(w.as((tx) => createPurchaseOrder(tx, { idempotencyKey: createKey, ...input, orderDate: "2026-07-02" }))).rejects.toThrow("idempotency key");
    const approveKey = key("appr");
    await w.as((tx) => approvePurchaseOrder(tx, created.purchaseOrder.id, { idempotencyKey: approveKey }));
    const reapproved = await w.as((tx) => approvePurchaseOrder(tx, created.purchaseOrder.id, { idempotencyKey: approveKey }));
    expect([reapproved.created, reapproved.purchaseOrder.poNumber]).toEqual([false, "PO-0001"]);
    await expect(w.approve(created.purchaseOrder.id)).rejects.toThrow("already approved");
    await expect(w.draft({ lines: [] })).rejects.toThrow("A purchase order needs at least one line.");
    const draft = await w.draft();
    await expect(w.copy(draft.id, "PS-1")).rejects.toThrow("Approve this purchase order before");
    const { bill } = await w.copy(created.purchaseOrder.id, "PS-1");
    expect((await w.as((tx) => getBill(tx, bill.id))).purchaseOrderNumber).toBe("PO-0001");

    const cookie = await sessionCookieFor(viewer);
    const list = await purchaseOrdersRoute.GET(apiRequest(`/api/purchase-orders?organisationId=${w.org}`, { cookie }), noContext);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { purchaseOrders: unknown[] }).purchaseOrders).toHaveLength(2);
    const post = await purchaseOrdersRoute.POST(
      apiRequest("/api/purchase-orders", { method: "POST", cookie, body: { organisationId: w.org, idempotencyKey: key("po"), ...input } }),
      noContext,
    );
    expect(post.status).toBe(403);
    expect(await w.journals()).toBe(0);
  });

  it("SPT4: copy to bill without a due date uses the supplier's payment terms", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const copyWithout = (idempotencyKey = key("copy")) =>
      w.as((tx) => copyPurchaseOrderToBill(tx, order.id, { idempotencyKey, billDate: "2026-07-12", supplierInvoiceNumber: "PS-301" }));
    // Paw Supplies has no terms yet, so the due date is needed and nothing is made.
    await expect(copyWithout()).rejects.toThrow("this supplier has no payment terms");
    expect((await w.as((tx) => getPurchaseOrder(tx, order.id))).bills).toEqual([]);
    const thirty = (await w.as((tx) => tx.query<{ id: string }>("select id::text from payment_terms where name = '30 days'"))).rows[0].id;
    await w.as((tx) => updateContact(tx, w.paw.id, { supplierPaymentTermId: thirty }));
    const copyKey = key("copy");
    const { bill } = await copyWithout(copyKey);
    expect([bill.billDate, bill.dueDate, bill.supplierInvoiceNumber, bill.total]).toEqual(["2026-07-12", "2026-08-11", "PS-301", "287.50"]);
    expect((await copyWithout(copyKey)).bill.id).toBe(bill.id);
  });
});

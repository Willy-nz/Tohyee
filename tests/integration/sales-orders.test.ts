import { afterAll, beforeAll, expect, it } from "vitest";
import * as salesOrderInvoiceRoute from "@/app/api/sales-orders/[salesOrderId]/invoice/route";
import * as salesOrderRoute from "@/app/api/sales-orders/[salesOrderId]/route";
import * as salesOrdersRoute from "@/app/api/sales-orders/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { archiveContact, type Contact, createContact, updateContact } from "@/lib/contacts/service";
import { getCustomerSetup } from "@/lib/customers/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice, deleteInvoice, getInvoice, updateInvoice, voidInvoice } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { acceptQuote, acceptQuoteAsSalesOrder, createQuote, finaliseQuote, getQuote } from "@/lib/quotes/service";
import { inventoryValuation } from "@/lib/reports/financial";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import {
  approveSalesOrder,
  cancelSalesOrder,
  closeSalesOrder,
  createSalesOrder,
  deleteSalesOrder,
  getSalesOrder,
  invoiceSalesOrder,
  listSalesOrders,
  type SalesOrder,
  updateSalesOrder,
} from "@/lib/sales-orders/service";
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
  waitForLockWaiters,
} from "../helpers/test-server";

const noContext = undefined as unknown;
const params = (salesOrderId: string) => ({ params: Promise.resolve({ salesOrderId }) });

/** Examples SO1-SO12 in docs/ACCOUNTING-EXAMPLES.md ("Sales orders"). Each test gets its own organisation. */
describeWithDatabase("sales orders", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("so-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("so-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `so-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { displayName: "Glimmers", advancedFeatures: true }));
    const terms = (await as((tx) => getCustomerSetup(tx))).paymentTerms;
    const twentieth = terms.find((t) => t.name === "20th of the following month")!.id;
    const contact = async (name: string, extra: Record<string, unknown> = {}): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, ...extra }))).contact;
    const kobe = await contact("Kobe Cafe", { isCustomer: true, paymentTermId: twentieth });
    const paw = await contact("Paw Supplies", { isSupplier: true });
    const item = async (fields: Record<string, unknown>) =>
      (await as((tx) => createItem(tx, { idempotencyKey: key("item"), purchaseTaxCode: "GST", salesTaxCode: "GST", incomeAccountCode: "4000", ...fields }))).item;
    const widget = await item({ code: "WIDGET", name: "Widget", itemType: "stock", salePrice: "12.00", purchasePrice: "5.00", purchaseAccountCode: "1400" });
    const giftBox = await item({ code: "GIFTBOX", name: "Gift box", itemType: "non_stock", salePrice: "4.00", purchasePrice: "2.00", purchaseAccountCode: "5100" });
    const bought = await as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: paw.id,
        billDate: "2026-07-01",
        dueDate: "2026-07-20",
        supplierInvoiceNumber: "PS-1",
        amountsMode: "exclusive",
        lines: [{ itemId: widget.id, quantity: "20", unitPrice: "5.00" }],
      }),
    );
    await as((tx) => approveBill(tx, bought.bill.id, { idempotencyKey: key("ab") }));
    const lines = [
      { itemId: widget.id, quantity: "10" },
      { itemId: giftBox.id, quantity: "50" },
    ];
    const draft = async (extra: Record<string, unknown> = {}) =>
      (
        await as((tx) =>
          createSalesOrder(tx, {
            idempotencyKey: key("so"),
            contactId: kobe.id,
            orderDate: "2026-08-01",
            expectedDate: "2026-08-15",
            reference: "KC-PO-77",
            memo: "Deliver to the Octagon shop",
            amountsMode: "exclusive",
            lines,
            ...extra,
          }),
        )
      ).salesOrder;
    const approve = async (id: string) => (await as((tx) => approveSalesOrder(tx, id, { idempotencyKey: key("appr") }))).salesOrder;
    const invoice = async (id: string, invoiceDate: string, extra: Record<string, unknown> = {}) =>
      as((tx) => invoiceSalesOrder(tx, id, { idempotencyKey: key("inv"), invoiceDate, ...extra }));
    const approveInv = async (id: string) => (await as((tx) => approveInvoice(tx, id, { idempotencyKey: key("ai") }))).invoice;
    const reload = (id: string) => as((tx) => getSalesOrder(tx, id));
    const journal = async (journalId: string) =>
      (await as((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    const billing = (order: SalesOrder) => order.lines.map((line) => [line.invoicedQuantity, line.onDraftInvoicesQuantity, line.remainingQuantity]);
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    const stock = async () => (await as((tx) => inventoryValuation(tx))).items.map((row) => [row.itemCode, row.quantity, row.value]);
    return { org, as, kobe, paw, contact, widget, giftBox, lines, draft, approve, invoice, approveInv, reload, journal, billing, journals, stock };
  }

  it("SO1: a draft works out like an invoice, fills items at their sale price and posts nothing", async () => {
    const w = await setup();
    const before = await w.journals();
    const order = await w.draft();
    expect([order.status, order.soNumber, order.subtotal, order.taxTotal, order.total]).toEqual(["draft", null, "320.00", "48.00", "368.00"]);
    expect(order.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.accountCode, l.lineAmount])).toEqual([
      ["Widget", "10", "12", "4000", "120.00"],
      ["Gift box", "50", "4", "4000", "200.00"],
    ]);
    expect([order.orderDate, order.expectedDate, order.reference, order.memo]).toEqual(["2026-08-01", "2026-08-15", "KC-PO-77", "Deliver to the Octagon shop"]);
    expect(await w.journals()).toBe(before);
    expect(await w.stock()).toEqual([["WIDGET", "20", "100.00"]]);
    await expect(w.draft({ expectedDate: "2026-07-31" })).rejects.toThrow("The expected date can't be before the order date.");
    const edited = await w.as((tx) => updateSalesOrder(tx, order.id, { memo: "Leave at the back door" }));
    expect([edited.memo, edited.total]).toEqual(["Leave at the back door", "368.00"]);
    const spare = await w.draft();
    await w.as((tx) => deleteSalesOrder(tx, spare.id));
    await expect(w.reload(spare.id)).rejects.toThrow("Sales order not found.");
  });

  it("SO2: approving numbers SO-0001 with no gaps, locks it and posts nothing", async () => {
    const w = await setup();
    const before = await w.journals();
    const gstBefore = await w.as((tx) => calculateGstReturn(tx, { periodStart: "2026-08-01", periodEnd: "2026-08-31" }));
    const order = await w.approve((await w.draft()).id);
    expect([order.status, order.soNumber]).toEqual(["pending_billing", "SO-0001"]);
    expect(w.billing(order)).toEqual([["0", "0", "10"], ["0", "0", "50"]]);
    await expect(w.as((tx) => updateSalesOrder(tx, order.id, { reference: "x" }))).rejects.toThrow("so it can't be edited");
    await expect(w.as((tx) => deleteSalesOrder(tx, order.id))).rejects.toThrow("so it can't be deleted");
    await expect(w.as((tx) => tx.query("update sales_orders set total = 1 where id = $1", [order.id]))).rejects.toThrow("can't be changed");
    await expect(w.as((tx) => tx.query("update sales_order_lines set description = 'x' where sales_order_id = $1", [order.id]))).rejects.toThrow(
      "Lines of an approved sales order can't be changed",
    );
    await expect(w.as((tx) => tx.query("delete from sales_orders where id = $1", [order.id]))).rejects.toThrow("can't be deleted");
    expect(await w.journals()).toBe(before);
    expect(await w.stock()).toEqual([["WIDGET", "20", "100.00"]]);
    const gstAfter = await w.as((tx) => calculateGstReturn(tx, { periodStart: "2026-08-01", periodEnd: "2026-08-31" }));
    expect(gstAfter.boxes).toEqual(gstBefore.boxes);

    const rata = await w.contact("Rata Ltd", { isCustomer: true });
    const second = await w.draft({ contactId: rata.id });
    await w.as((tx) => archiveContact(tx, rata.id));
    await expect(w.approve(second.id)).rejects.toThrow("Rata Ltd is archived");
    expect((await w.reload(second.id)).status).toBe("draft");
    expect((await w.approve((await w.draft()).id)).soNumber).toBe("SO-0002");
  });

  it("SO3: invoicing makes a linked draft for what's left; approving it posts sales and cost of sales", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const invoiceKey = key("inv");
    const made = await w.as((tx) => invoiceSalesOrder(tx, order.id, { idempotencyKey: invoiceKey, invoiceDate: "2026-08-05" }));
    expect(made.created).toBe(true);
    const inv = made.invoice;
    expect([inv.status, inv.contactId, inv.invoiceDate, inv.dueDate, inv.reference, inv.total]).toEqual([
      "draft",
      w.kobe.id,
      "2026-08-05",
      "2026-09-20",
      "KC-PO-77",
      "368.00",
    ]);
    expect([inv.salesOrderId, inv.salesOrderNumber]).toEqual([order.id, "SO-0001"]);
    expect(inv.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.salesOrderLineId])).toEqual([
      ["Widget", "10", "12", order.lines[0].id],
      ["Gift box", "50", "4", order.lines[1].id],
    ]);
    const pending = made.salesOrder;
    expect([pending.status, w.billing(pending)]).toEqual(["pending_billing", [["0", "10", "0"], ["0", "50", "0"]]]);
    expect(pending.invoices.map((i) => [i.id, i.status])).toEqual([[inv.id, "draft"]]);
    await expect(w.invoice(order.id, "2026-08-06")).rejects.toThrow("There's nothing left to invoice on SO-0001");
    const again = await w.as((tx) => invoiceSalesOrder(tx, order.id, { idempotencyKey: invoiceKey, invoiceDate: "2026-08-05" }));
    expect([again.created, again.invoice.id]).toEqual([false, inv.id]);

    const approved = await w.approveInv(inv.id);
    expect(approved.invoiceNumber).toBe("INV-0001");
    expect(await w.journal(approved.approvalJournalId!)).toEqual([
      ["1100", "368.00", "0.00"],
      ["4000", "0.00", "320.00"],
      ["2100", "0.00", "48.00"],
      ["5000", "50.00", "0.00"],
      ["1400", "0.00", "50.00"],
    ]);
    expect(await w.stock()).toEqual([["WIDGET", "10", "50.00"]]);
    const billed = await w.reload(order.id);
    expect([billed.status, w.billing(billed)]).toEqual(["billed", [["10", "0", "0"], ["50", "0", "0"]]]);
  });

  it("SO4: a part invoice, then the rest", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const part = await w.invoice(order.id, "2026-08-05", {
      lines: [
        { salesOrderLineId: order.lines[0].id, quantity: "6" },
        { salesOrderLineId: order.lines[1].id, quantity: "20" },
      ],
    });
    expect(part.invoice.lines.map((l) => [l.quantity, l.lineAmount])).toEqual([["6", "72.00"], ["20", "80.00"]]);
    expect([part.invoice.subtotal, part.invoice.taxTotal, part.invoice.total]).toEqual(["152.00", "22.80", "174.80"]);
    const first = await w.approveInv(part.invoice.id);
    expect(await w.journal(first.approvalJournalId!)).toEqual([
      ["1100", "174.80", "0.00"],
      ["4000", "0.00", "152.00"],
      ["2100", "0.00", "22.80"],
      ["5000", "30.00", "0.00"],
      ["1400", "0.00", "30.00"],
    ]);
    const partly = await w.reload(order.id);
    expect([partly.status, w.billing(partly)]).toEqual(["partly_billed", [["6", "0", "4"], ["20", "0", "30"]]]);

    const rest = await w.invoice(order.id, "2026-08-20");
    expect(rest.invoice.lines.map((l) => [l.quantity, l.lineAmount])).toEqual([["4", "48.00"], ["30", "120.00"]]);
    expect([rest.invoice.subtotal, rest.invoice.taxTotal, rest.invoice.total, rest.invoice.dueDate]).toEqual(["168.00", "25.20", "193.20", "2026-09-20"]);
    await w.approveInv(rest.invoice.id);
    const billed = await w.reload(order.id);
    expect([billed.status, billed.invoices.map((i) => i.total)]).toEqual(["billed", ["174.80", "193.20"]]);

    // Leaving a line out, or giving it zero, leaves it off; no quantity at all is refused.
    const other = await w.approve((await w.draft()).id);
    const widgetsOnly = await w.invoice(other.id, "2026-08-05", { lines: [{ salesOrderLineId: other.lines[0].id, quantity: "3" }] });
    expect(widgetsOnly.invoice.lines.map((l) => l.quantity)).toEqual(["3"]);
    await expect(
      w.invoice(other.id, "2026-08-05", { lines: [{ salesOrderLineId: other.lines[0].id, quantity: "0" }] }),
    ).rejects.toThrow("Give a quantity to invoice on at least one line.");
    await expect(
      w.invoice(other.id, "2026-08-05", {
        lines: [
          { salesOrderLineId: other.lines[0].id, quantity: "1" },
          { salesOrderLineId: other.lines[0].id, quantity: "1" },
        ],
      }),
    ).rejects.toThrow("is listed twice");
    await expect(w.invoice(other.id, "2026-07-31")).rejects.toThrow("The invoice date can't be before the order date");
  });

  it("SO5: voiding an invoice, or deleting a draft, gives its quantities back", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const part = await w.invoice(order.id, "2026-08-05", {
      lines: [
        { salesOrderLineId: order.lines[0].id, quantity: "6" },
        { salesOrderLineId: order.lines[1].id, quantity: "20" },
      ],
    });
    await w.approveInv(part.invoice.id);
    const rest = await w.invoice(order.id, "2026-08-20");
    await w.approveInv(rest.invoice.id);
    expect((await w.reload(order.id)).status).toBe("billed");
    await w.as((tx) => voidInvoice(tx, rest.invoice.id, { idempotencyKey: key("void"), voidDate: "2026-08-21" }));
    const back = await w.reload(order.id);
    expect([back.status, w.billing(back)]).toEqual(["partly_billed", [["6", "0", "4"], ["20", "0", "30"]]]);
    const again = await w.invoice(order.id, "2026-08-22");
    expect(again.invoice.lines.map((l) => l.quantity)).toEqual(["4", "30"]);
    await w.as((tx) => deleteInvoice(tx, again.invoice.id));
    expect(w.billing(await w.reload(order.id))).toEqual([["6", "0", "4"], ["20", "0", "30"]]);
  });

  it("SO6: over-invoicing is refused, by the service and by the database", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const [widgetLine, giftLine] = order.lines;
    const whole = await w.invoice(order.id, "2026-08-05");
    const lineInput = (inv: typeof whole.invoice, overrides: Record<number, Record<string, unknown>> = {}) =>
      inv.lines.map((l, index) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        accountCode: l.accountCode,
        taxCode: l.taxCode,
        itemId: l.itemId,
        salesOrderLineId: l.salesOrderLineId,
        ...overrides[index],
      }));
    await expect(w.as((tx) => updateInvoice(tx, whole.invoice.id, { lines: lineInput(whole.invoice, { 0: { quantity: "11" } }) }))).rejects.toThrow(
      "SO-0001 line 1 ordered 10",
    );
    await expect(
      w.as((tx) => tx.query("update sales_invoice_lines set quantity = 11, base_quantity = 11 where sales_order_line_id = $1", [widgetLine.id])),
    ).rejects.toThrow("Invoices can't add up to more than the sales order line ordered");
    await w.as((tx) => deleteInvoice(tx, whole.invoice.id));

    const part = await w.invoice(order.id, "2026-08-05", {
      lines: [
        { salesOrderLineId: widgetLine.id, quantity: "6" },
        { salesOrderLineId: giftLine.id, quantity: "20" },
      ],
    });
    await w.approveInv(part.invoice.id);
    await expect(w.invoice(order.id, "2026-08-20", { lines: [{ salesOrderLineId: widgetLine.id, quantity: "5" }] })).rejects.toThrow(
      "only 4 left to invoice, so 5 can't be invoiced",
    );
    const second = (await w.invoice(order.id, "2026-08-20")).invoice;
    await expect(w.as((tx) => updateInvoice(tx, second.id, { lines: lineInput(second, { 0: { quantity: "5" } }) }))).rejects.toThrow(
      "6 of it is on other invoices, so at most 4 can be invoiced here",
    );
    await expect(w.as((tx) => updateInvoice(tx, second.id, { lines: lineInput(second, { 0: { itemId: w.giftBox.id } }) }))).rejects.toThrow(
      "keeps that line's item and unit",
    );
    await expect(
      w.as((tx) => tx.query("update sales_invoice_lines set item_id = $2 where invoice_id = $1 and sales_order_line_id = $3", [second.id, w.giftBox.id, widgetLine.id])),
    ).rejects.toThrow("keeps its item and unit");
    const rata = await w.contact("Rata Ltd", { isCustomer: true });
    await expect(w.as((tx) => updateInvoice(tx, second.id, { contactId: rata.id }))).rejects.toThrow("its customer can't change");
    await expect(w.as((tx) => tx.query("update sales_invoices set contact_id = $2 where id = $1", [second.id, rata.id]))).rejects.toThrow();
    // An invoice line can't name an order line unless the invoice was made from that order.
    await expect(
      w.as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("inv"),
          contactId: w.kobe.id,
          invoiceDate: "2026-08-20",
          amountsMode: "exclusive",
          lines: [{ itemId: w.widget.id, quantity: "1", salesOrderLineId: widgetLine.id }],
        }),
      ),
    ).rejects.toThrow("wasn't made from a sales order");

    // A line of its own and a new price are fine; the order counts quantities only.
    const edited = await w.as((tx) =>
      updateInvoice(tx, second.id, {
        lines: [
          ...lineInput(second, { 0: { unitPrice: "11.50" } }),
          { description: "Freight", quantity: "1", unitPrice: "15.00", accountCode: "4000", taxCode: "GST" },
        ],
      }),
    );
    expect(edited.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.salesOrderLineId ?? null])).toEqual([
      ["Widget", "4", "11.5", widgetLine.id],
      ["Gift box", "30", "4", giftLine.id],
      ["Freight", "1", "15", null],
    ]);
    const approved = await w.approveInv(second.id);
    expect(approved.subtotal).toBe("181.00");
    const billed = await w.reload(order.id);
    expect([billed.status, billed.lines[0].unitPrice]).toEqual(["billed", "12"]);
  });

  it("SO6: two transactions can't both take what's left, even straight in the database", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const widgetLine = order.lines[0];
    const four = [{ salesOrderLineId: widgetLine.id, quantity: "4" }];
    const first = (await w.invoice(order.id, "2026-08-05", { lines: four })).invoice;
    const second = (await w.invoice(order.id, "2026-08-05", { lines: four })).invoice;
    const raise = (invoiceId: string) => (tx: OrgTx) =>
      tx.query("update sales_invoice_lines set quantity = 6, base_quantity = 6 where invoice_id = $1 and sales_order_line_id = $2", [
        invoiceId,
        widgetLine.id,
      ]);
    // 6 + 4 fits the 10 ordered; while that's uncommitted, the other transaction waits, then sees 6 + 6.
    const { rival } = await w.as(async (tx) => {
      await raise(first.id)(tx);
      const queued = w.as(raise(second.id));
      const settled = Promise.allSettled([queued]);
      await waitForLockWaiters(tx, 1);
      return { rival: settled };
    });
    const [outcome] = await rival;
    expect(outcome.status).toBe("rejected");
    expect(String((outcome as PromiseRejectedResult).reason)).toContain("Invoices can't add up to more than the sales order line ordered");
    expect(w.billing(await w.reload(order.id))[0]).toEqual(["0", "10", "0"]);
  });

  it("SO7: closing an order stops invoicing it", async () => {
    const w = await setup();
    const order = await w.approve((await w.draft()).id);
    const part = await w.invoice(order.id, "2026-08-05", {
      lines: [
        { salesOrderLineId: order.lines[0].id, quantity: "6" },
        { salesOrderLineId: order.lines[1].id, quantity: "20" },
      ],
    });
    await w.approveInv(part.invoice.id);
    const draftInvoice = (await w.invoice(order.id, "2026-08-20")).invoice;
    await expect(w.as((tx) => closeSalesOrder(tx, order.id, { idempotencyKey: key("close") }))).rejects.toThrow("has a draft invoice");
    await expect(w.as((tx) => tx.query("update sales_orders set status = 'closed' where id = $1", [order.id]))).rejects.toThrow(
      "has draft invoices, so it can't be closed",
    );
    await w.as((tx) => deleteInvoice(tx, draftInvoice.id));
    const closed = (await w.as((tx) => closeSalesOrder(tx, order.id, { idempotencyKey: key("close") }))).salesOrder;
    expect([closed.status, w.billing(closed)]).toEqual(["closed", [["6", "0", "4"], ["20", "0", "30"]]]);
    expect(closed.closedByEmail).toBe(owner.email);
    await expect(w.invoice(order.id, "2026-08-21")).rejects.toThrow("is closed, so it can't be invoiced");
    await expect(w.as((tx) => cancelSalesOrder(tx, order.id, { idempotencyKey: key("cancel") }))).rejects.toThrow("is closed, so it can't be cancelled");
    await w.as((tx) => voidInvoice(tx, part.invoice.id, { idempotencyKey: key("void"), voidDate: "2026-08-21" }));
    const stillClosed = await w.reload(order.id);
    expect([stillClosed.status, w.billing(stillClosed)]).toEqual(["closed", [["0", "0", "10"], ["0", "0", "50"]]]);

    const draft = await w.draft();
    await expect(w.as((tx) => closeSalesOrder(tx, draft.id, { idempotencyKey: key("close") }))).rejects.toThrow("still a draft");
    const full = await w.approve((await w.draft()).id);
    await w.approveInv((await w.invoice(full.id, "2026-08-21")).invoice.id);
    await expect(w.as((tx) => closeSalesOrder(tx, full.id, { idempotencyKey: key("close") }))).rejects.toThrow("nothing left to invoice");
  });

  it("SO8: cancelling an order with no invoices that aren't voided", async () => {
    const w = await setup();
    const plain = await w.approve((await w.draft()).id);
    const cancelled = (await w.as((tx) => cancelSalesOrder(tx, plain.id, { idempotencyKey: key("cancel") }))).salesOrder;
    expect(cancelled.status).toBe("cancelled");
    await expect(w.invoice(plain.id, "2026-08-05")).rejects.toThrow("is cancelled, so it can't be invoiced");
    await expect(w.as((tx) => closeSalesOrder(tx, plain.id, { idempotencyKey: key("close") }))).rejects.toThrow("already cancelled");
    const draft = await w.draft();
    await expect(w.as((tx) => cancelSalesOrder(tx, draft.id, { idempotencyKey: key("cancel") }))).rejects.toThrow("Delete it instead");

    const order = await w.approve((await w.draft()).id);
    const inv = (await w.invoice(order.id, "2026-08-05")).invoice;
    await expect(w.as((tx) => cancelSalesOrder(tx, order.id, { idempotencyKey: key("cancel") }))).rejects.toThrow("has an invoice");
    await expect(w.as((tx) => tx.query("update sales_orders set status = 'cancelled' where id = $1", [order.id]))).rejects.toThrow(
      "has invoices, so it can't be cancelled",
    );
    await w.as((tx) => deleteInvoice(tx, inv.id));
    const approvedInv = (await w.invoice(order.id, "2026-08-05")).invoice;
    await w.approveInv(approvedInv.id);
    await expect(w.as((tx) => cancelSalesOrder(tx, order.id, { idempotencyKey: key("cancel") }))).rejects.toThrow("has an invoice (INV-0001)");
    await w.as((tx) => voidInvoice(tx, approvedInv.id, { idempotencyKey: key("void"), voidDate: "2026-08-06" }));
    expect((await w.as((tx) => cancelSalesOrder(tx, order.id, { idempotencyKey: key("cancel") }))).salesOrder.status).toBe("cancelled");
  });

  it("SO9: accepting a quote as a sales order", async () => {
    const w = await setup();
    const quoteDraft = await w.as((tx) =>
      createQuote(tx, {
        idempotencyKey: key("quote"),
        contactId: w.kobe.id,
        quoteDate: "2026-07-15",
        amountsMode: "exclusive",
        lines: [
          { description: "Paw print pendant", quantity: "2", unitPrice: "120.00", accountCode: "4000", taxCode: "GST" },
          { description: "Engraving", quantity: "1", unitPrice: "35.00", accountCode: "4000", taxCode: "GST" },
        ],
      }),
    );
    await expect(
      w.as((tx) => acceptQuoteAsSalesOrder(tx, quoteDraft.quote.id, { idempotencyKey: key("acc"), orderDate: "2026-07-16" })),
    ).rejects.toThrow("Finalise this quote before it's accepted.");
    const quote = (await w.as((tx) => finaliseQuote(tx, quoteDraft.quote.id, { idempotencyKey: key("fin") }))).quote;
    const acceptKey = key("acc");
    const accepted = await w.as((tx) => acceptQuoteAsSalesOrder(tx, quote.id, { idempotencyKey: acceptKey, orderDate: "2026-07-16" }));
    const order = accepted.salesOrder;
    expect([order.status, order.contactId, order.orderDate, order.reference, order.total]).toEqual(["draft", w.kobe.id, "2026-07-16", "QU-0001", "316.25"]);
    expect(order.lines.map((l) => [l.description, l.quantity, l.unitPrice])).toEqual([
      ["Paw print pendant", "2", "120"],
      ["Engraving", "1", "35"],
    ]);
    expect(order.fromQuote).toEqual({ id: quote.id, quoteNumber: "QU-0001" });
    expect([accepted.quote.status, accepted.quote.salesOrderId]).toEqual(["accepted", order.id]);
    const retried = await w.as((tx) => acceptQuoteAsSalesOrder(tx, quote.id, { idempotencyKey: acceptKey, orderDate: "2026-07-16" }));
    expect([retried.created, retried.salesOrder.id]).toEqual([false, order.id]);
    await expect(w.as((tx) => acceptQuoteAsSalesOrder(tx, quote.id, { idempotencyKey: key("acc"), orderDate: "2026-07-16" }))).rejects.toThrow(
      "already accepted",
    );
    await expect(w.as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: key("acc"), invoiceDate: "2026-07-16" }))).rejects.toThrow("already accepted");
    await expect(w.as((tx) => deleteSalesOrder(tx, order.id))).rejects.toThrow("made by accepting quote QU-0001, so it can't be deleted");
    expect((await w.as((tx) => getQuote(tx, quote.id))).salesOrderNumber).toBeNull();

    const approved = await w.approve(order.id);
    expect((await w.as((tx) => getQuote(tx, quote.id))).salesOrderNumber).toBe("SO-0001");
    const inv = (await w.invoice(approved.id, "2026-07-20")).invoice;
    expect([inv.reference, inv.total]).toEqual(["QU-0001", "316.25"]);
  });

  it("SO10: a foreign-currency order; each invoice takes its own rate", async () => {
    const w = await setup();
    const acme = await w.contact("Acme Inc", { isCustomer: true, currencyCode: "USD", paymentTermId: null });
    const order = await w.approve(
      (
        await w.draft({
          contactId: acme.id,
          expectedDate: null,
          reference: null,
          lines: [{ description: "Consulting day", quantity: "3", unitPrice: "100.00", accountCode: "4000", taxCode: "ZERO" }],
        })
      ).id,
    );
    expect([order.currencyCode, order.total, order.soNumber]).toEqual(["USD", "300.00", "SO-0001"]);
    const journalsBefore = await w.journals();
    const first = await w.invoice(order.id, "2026-08-10", {
      dueDate: "2026-09-10",
      exchangeRate: "1.65",
      lines: [{ salesOrderLineId: order.lines[0].id, quantity: "2" }],
    });
    expect([first.invoice.currencyCode, first.invoice.total, first.invoice.baseTotal]).toEqual(["USD", "200.00", "330.00"]);
    expect(await w.journals()).toBe(journalsBefore);
    const approved = await w.approveInv(first.invoice.id);
    expect(await w.journal(approved.approvalJournalId!)).toEqual([
      ["1100", "330.00", "0.00"],
      ["4000", "0.00", "330.00"],
    ]);
    const partly = await w.reload(order.id);
    expect([partly.status, w.billing(partly)]).toEqual(["partly_billed", [["2", "0", "1"]]]);
    const rest = await w.invoice(order.id, "2026-08-20", { dueDate: "2026-09-20", exchangeRate: "1.60" });
    expect([rest.invoice.total, rest.invoice.baseTotal]).toEqual(["100.00", "160.00"]);
    await w.approveInv(rest.invoice.id);
    expect((await w.reload(order.id)).status).toBe("billed");

    // A customer with only a sales order can't change currency either.
    const beta = await w.contact("Beta LLC", { isCustomer: true, currencyCode: "USD" });
    await w.draft({ contactId: beta.id, lines: [{ description: "Consulting day", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "ZERO" }] });
    await expect(w.as((tx) => updateContact(tx, beta.id, { currencyCode: "EUR" }))).rejects.toThrow("sales orders count too");
  });

  it("SO11: period locks apply to the invoices, not the order", async () => {
    const w = await setup();
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-07-31" }));
    const order = await w.approve((await w.draft({ orderDate: "2026-07-20", expectedDate: null })).id);
    expect(order.status).toBe("pending_billing");
    const locked = (await w.invoice(order.id, "2026-07-25")).invoice;
    await expect(w.approveInv(locked.id)).rejects.toThrow("locked");
    await w.as((tx) => deleteInvoice(tx, locked.id));
    const open = (await w.invoice(order.id, "2026-08-03")).invoice;
    await w.approveInv(open.id);
    expect((await w.reload(order.id)).status).toBe("billed");
  });

  it("SO12: retries, refusals, the status filter and roles", async () => {
    const w = await setup();
    const input = { contactId: w.kobe.id, orderDate: "2026-08-01", amountsMode: "exclusive", lines: w.lines };
    const createKey = key("so");
    const created = await w.as((tx) => createSalesOrder(tx, { idempotencyKey: createKey, ...input }));
    const retried = await w.as((tx) => createSalesOrder(tx, { idempotencyKey: createKey, ...input }));
    expect([retried.created, retried.salesOrder.id]).toEqual([false, created.salesOrder.id]);
    await expect(w.as((tx) => createSalesOrder(tx, { idempotencyKey: createKey, ...input, reference: "other" }))).rejects.toThrow(/idempotency key/i);
    await expect(w.draft({ lines: [] })).rejects.toThrow("A sales order needs at least one line.");

    const id = created.salesOrder.id;
    const approveKey = key("appr");
    await w.as((tx) => approveSalesOrder(tx, id, { idempotencyKey: approveKey }));
    const reapproved = await w.as((tx) => approveSalesOrder(tx, id, { idempotencyKey: approveKey }));
    expect([reapproved.created, reapproved.salesOrder.soNumber]).toEqual([false, "SO-0001"]);
    await expect(w.approve(id)).rejects.toThrow("already approved");
    const invoiceKey = key("inv");
    const made = await w.as((tx) => invoiceSalesOrder(tx, id, { idempotencyKey: invoiceKey, invoiceDate: "2026-08-05", lines: [{ salesOrderLineId: created.salesOrder.lines[0].id, quantity: "1" }] }));
    await expect(w.as((tx) => invoiceSalesOrder(tx, id, { idempotencyKey: invoiceKey, invoiceDate: "2026-08-06" }))).rejects.toThrow(/idempotency key/);
    // The same date with other quantities, a due date or a rate is a different request too.
    const sameDate = { idempotencyKey: invoiceKey, invoiceDate: "2026-08-05" };
    await expect(
      w.as((tx) => invoiceSalesOrder(tx, id, { ...sameDate, lines: [{ salesOrderLineId: created.salesOrder.lines[0].id, quantity: "2" }] })),
    ).rejects.toThrow(/idempotency key/);
    await expect(w.as((tx) => invoiceSalesOrder(tx, id, { ...sameDate, dueDate: "2026-08-31", lines: [{ salesOrderLineId: created.salesOrder.lines[0].id, quantity: "1" }] }))).rejects.toThrow(
      /idempotency key/,
    );
    const replayed = await w.as((tx) =>
      invoiceSalesOrder(tx, id, { ...sameDate, lines: [{ salesOrderLineId: created.salesOrder.lines[0].id, quantity: "1.000" }] }),
    );
    expect([replayed.created, replayed.invoice.id]).toEqual([false, made.invoice.id]);
    await w.approveInv(made.invoice.id);
    const closeKey = key("close");
    await w.as((tx) => closeSalesOrder(tx, id, { idempotencyKey: closeKey }));
    expect((await w.as((tx) => closeSalesOrder(tx, id, { idempotencyKey: closeKey }))).created).toBe(false);

    const toCancel = await w.approve((await w.draft()).id);
    const cancelKey = key("cancel");
    await w.as((tx) => cancelSalesOrder(tx, toCancel.id, { idempotencyKey: cancelKey }));
    expect((await w.as((tx) => cancelSalesOrder(tx, toCancel.id, { idempotencyKey: cancelKey }))).created).toBe(false);

    const pending = await w.approve((await w.draft()).id);
    await expect(w.as((tx) => cancelSalesOrder(tx, pending.id, { idempotencyKey: cancelKey }))).rejects.toThrow(/idempotency key/i);
    const partly = await w.approve((await w.draft()).id);
    await w.approveInv((await w.invoice(partly.id, "2026-08-05", { lines: [{ salesOrderLineId: partly.lines[0].id, quantity: "1" }] })).invoice.id);
    const billed = await w.approve((await w.draft()).id);
    await w.approveInv((await w.invoice(billed.id, "2026-08-05")).invoice.id);
    const draft = await w.draft();
    const byStatus = async (status: string) => (await w.as((tx) => listSalesOrders(tx, { status }))).salesOrders.map((o) => o.id);
    expect(await byStatus("draft")).toEqual([draft.id]);
    expect(await byStatus("pending_billing")).toEqual([pending.id]);
    expect(await byStatus("partly_billed")).toEqual([partly.id]);
    expect(await byStatus("billed")).toEqual([billed.id]);
    expect(await byStatus("closed")).toEqual([id]);
    expect(await byStatus("cancelled")).toEqual([toCancel.id]);
    expect((await w.as((tx) => listSalesOrders(tx))).salesOrders).toHaveLength(6);
    await expect(byStatus("open")).rejects.toThrow("status must be one of");

    const cookie = await sessionCookieFor(viewer);
    const list = await salesOrdersRoute.GET(apiRequest(`/api/sales-orders?organisationId=${w.org}&status=billed`, { cookie }), noContext);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { salesOrders: Array<{ id: string }> }).salesOrders.map((o) => o.id)).toEqual([billed.id]);
    const one = await salesOrderRoute.GET(apiRequest(`/api/sales-orders/${billed.id}?organisationId=${w.org}`, { cookie }), params(billed.id));
    expect(one.status).toBe(200);
    expect(((await one.json()) as { salesOrder: SalesOrder }).salesOrder.invoices).toHaveLength(1);
    const post = await salesOrdersRoute.POST(
      apiRequest("/api/sales-orders", { method: "POST", cookie, body: { organisationId: w.org, idempotencyKey: key("so"), ...input } }),
      noContext,
    );
    expect(post.status).toBe(403);
    const invoiceAsViewer = await salesOrderInvoiceRoute.POST(
      apiRequest(`/api/sales-orders/${pending.id}/invoice`, { method: "POST", cookie, body: { organisationId: w.org, idempotencyKey: key("inv"), invoiceDate: "2026-08-05" } }),
      params(pending.id),
    );
    expect(invoiceAsViewer.status).toBe(403);
    const ownerCookie = await sessionCookieFor(owner);
    const invoiceAsOwner = await salesOrderInvoiceRoute.POST(
      apiRequest(`/api/sales-orders/${pending.id}/invoice`, { method: "POST", cookie: ownerCookie, body: { organisationId: w.org, idempotencyKey: key("inv"), invoiceDate: "2026-08-05" } }),
      params(pending.id),
    );
    expect(invoiceAsOwner.status).toBe(201);
    const body = (await invoiceAsOwner.json()) as { invoice: { id: string } };
    expect((await w.as((tx) => getInvoice(tx, body.invoice.id))).salesOrderNumber).toBe(pending.soNumber);
  });
});

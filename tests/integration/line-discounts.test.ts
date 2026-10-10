import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount } from "@/lib/bank/accounts";
import { type Contact, createContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { calculateInvoice } from "@/lib/invoices/amounts";
import { approveInvoice, createInvoice, getInvoice, updateInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { acceptQuote, createQuote, finaliseQuote } from "@/lib/quotes/service";
import { approveSalesOrder, createSalesOrder, invoiceSalesOrder } from "@/lib/sales-orders/service";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "line-discounts";

/** Examples DS1-DS6 in docs/ACCOUNTING-EXAMPLES.md ("Line discounts"), approved by Jess 10 Oct 2026. */
describeWithDatabase("line discounts on sales documents (DS1-DS6)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let customer: Contact;
  let acme: Contact;

  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const line = (quantity: string, unitPrice: string, discountPercent?: string, taxCode: string | null = "GST") => ({
    description: "Keyrings",
    quantity,
    unitPrice,
    accountCode: "4000",
    taxCode,
    ...(discountPercent === undefined ? {} : { discountPercent }),
  });
  const invoice = (lines: unknown[], fields: Record<string, unknown> = {}) =>
    run((tx) =>
      createInvoice(tx, { idempotencyKey: key("inv"), contactId: customer.id, invoiceDate: "2026-10-12", dueDate: "2026-10-31", amountsMode: "exclusive", lines, ...fields }),
    );
  const posted = async (journalId: string) => (await run((tx) => getJournal(tx, journalId))).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    customer = (await run((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isCustomer: true }))).contact;
    await run((tx) => createBankAccount(tx, { code: "1030", name: "USD account", accountType: "bank", currencyCode: "USD" }));
    acme = (await run((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Acme Inc", isCustomer: true, currencyCode: "USD" }))).contact;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("DS1: 2 x 50.00 less 10% at 15% exclusive: 90.00 + 13.50 = 103.50, posted at the discounted net", async () => {
    const draft = await invoice([line("2", "50.00", "10")]);
    expect(draft.invoice).toMatchObject({ subtotal: "90.00", taxTotal: "13.50", total: "103.50" });
    expect(draft.invoice.lines[0]).toMatchObject({ discountPercent: "10.00", lineAmount: "90.00", netAmount: "90.00", taxAmount: "13.50" });
    const approved = (await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("ap") }))).invoice;
    expect(await posted(approved.approvalJournalId!)).toEqual([
      ["1100", "103.50", "0.00"],
      ["4000", "0.00", "90.00"],
      ["2100", "0.00", "13.50"],
    ]);
  });

  it("DS2: inclusive 1 x 115.00 less 10%: line 103.50, GST 13.50, net 90.00", async () => {
    const draft = await invoice([line("1", "115.00", "10")], { amountsMode: "inclusive" });
    expect(draft.invoice.lines[0]).toMatchObject({ lineAmount: "103.50", taxAmount: "13.50", netAmount: "90.00" });
    expect(draft.invoice.total).toBe("103.50");
  });

  it("DS3: 3 x 3.33 less 12.5% is rounded once (8.74, not 8.73): GST 1.31, total 10.05", async () => {
    expect(calculateInvoice("exclusive", [{ quantity: "3", unitPrice: "3.33", taxRate: "0.15", discountPercent: "12.5" }], 2)).toMatchObject({
      lines: [{ lineAmount: "8.74", taxAmount: "1.31" }],
      total: "10.05",
    });
    const draft = await invoice([line("3", "3.33", "12.5")]);
    expect(draft.invoice).toMatchObject({ subtotal: "8.74", taxTotal: "1.31", total: "10.05" });
  });

  it("DS4: a line 100% off is 0.00 and still shows; an undiscounted 0.00 line or a 0.00 document is refused", async () => {
    const draft = await invoice([line("1", "40.00", "100"), line("1", "10.00")]);
    expect(draft.invoice.lines.map((entry) => [entry.lineAmount, entry.taxAmount])).toEqual([
      ["0.00", "0.00"],
      ["10.00", "1.50"],
    ]);
    expect(draft.invoice.total).toBe("11.50");
    await expect(invoice([line("1", "0.001")])).rejects.toThrow(/comes to 0.00/);
    await expect(invoice([line("1", "40.00", "100")])).rejects.toThrow(/0.00 NZD in all/);
    await expect(invoice([line("1", "40.00", "101")])).rejects.toThrow(/from 0 to 100/);
    await expect(invoice([line("1", "40.00", "-5")])).rejects.toThrow(/from 0 to 100/);
    await expect(invoice([line("1", "40.00", "10.555")])).rejects.toThrow(/2 decimal places/);
  });

  it("no discount (blank or 0) hashes and saves as before; editing a discount changes the amounts", async () => {
    const plain = await invoice([line("2", "50.00", "0")]);
    expect(plain.invoice.lines[0].discountPercent).toBe("0.00");
    expect(plain.invoice.total).toBe("115.00");
    const edited = await run((tx) =>
      updateInvoice(tx, plain.invoice.id, { contactId: customer.id, invoiceDate: "2026-10-12", dueDate: "2026-10-31", amountsMode: "exclusive", lines: [line("2", "50.00", "20")] }),
    );
    expect(edited.total).toBe("92.00");
  });

  it("DS5: USD 2 x 50.00 less 10%, zero-rated, at 1.60: USD 90.00 = NZD 144.00", async () => {
    const draft = await run((tx) =>
      createInvoice(tx, {
        idempotencyKey: key("inv"),
        contactId: acme.id,
        invoiceDate: "2026-10-12",
        dueDate: "2026-10-31",
        amountsMode: "exclusive",
        exchangeRate: "1.60",
        lines: [line("2", "50.00", "10", "ZERO")],
      }, { foreignCurrency: true }),
    );
    expect(draft.invoice).toMatchObject({ currencyCode: "USD", total: "90.00", baseTotal: "144.00" });
    const approved = (await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("ap") }))).invoice;
    expect((await posted(approved.approvalJournalId!)).map((entry) => entry.slice(0, 3))).toEqual([
      ["1100", "144.00", "0.00"],
      ["4000", "0.00", "144.00"],
    ]);
  });

  it("DS6: a credit note keeps the discount; quotes and sales orders carry it to their invoices", async () => {
    const credit = await run((tx) =>
      createCreditNote(tx, { idempotencyKey: key("cn"), contactId: customer.id, creditNoteDate: "2026-10-13", amountsMode: "exclusive", lines: [line("2", "50.00", "10")] }),
    );
    expect(credit.creditNote).toMatchObject({ subtotal: "90.00", taxTotal: "13.50", total: "103.50" });
    expect(credit.creditNote.lines[0].discountPercent).toBe("10.00");
    const approvedCredit = (await run((tx) => approveCreditNote(tx, credit.creditNote.id, { idempotencyKey: key("ap") }))).creditNote;
    expect(await posted(approvedCredit.approvalJournalId!)).toEqual([
      ["4000", "90.00", "0.00"],
      ["2100", "13.50", "0.00"],
      ["1100", "0.00", "103.50"],
    ]);

    const quote = await run((tx) =>
      createQuote(tx, { idempotencyKey: key("q"), contactId: customer.id, quoteDate: "2026-10-12", expiryDate: "2026-11-12", amountsMode: "exclusive", lines: [line("20", "25.00", "10"), line("1", "50.00")] }),
    );
    expect(quote.quote.total).toBe("575.00");
    await run((tx) => finaliseQuote(tx, quote.quote.id, { idempotencyKey: key("f") }));
    const fromQuote = await run((tx) => acceptQuote(tx, quote.quote.id, { idempotencyKey: key("a"), invoiceDate: "2026-10-20", dueDate: "2026-11-20" }));
    const quoted = await run((tx) => getInvoice(tx, fromQuote.invoice.id));
    expect(quoted.lines.map((entry) => [entry.discountPercent, entry.lineAmount])).toEqual([
      ["10.00", "450.00"],
      ["0.00", "50.00"],
    ]);
    expect(quoted.total).toBe("575.00");

    const order = await run((tx) =>
      createSalesOrder(tx, { idempotencyKey: key("so"), contactId: customer.id, orderDate: "2026-10-12", amountsMode: "exclusive", lines: [line("4", "25.00", "25")] }),
    );
    expect(order.salesOrder.total).toBe("86.25");
    await run((tx) => approveSalesOrder(tx, order.salesOrder.id, { idempotencyKey: key("ap") }));
    const fromOrder = await run((tx) =>
      invoiceSalesOrder(tx, order.salesOrder.id, { idempotencyKey: key("inv"), invoiceDate: "2026-10-14", dueDate: "2026-11-14", lines: [{ salesOrderLineId: order.salesOrder.lines[0].id, quantity: "2" }] }),
    );
    expect(fromOrder.invoice.lines[0]).toMatchObject({ discountPercent: "25.00", lineAmount: "37.50" });
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts/service";
import { approveBill, createBill } from "@/lib/bills/service";
import { createItem } from "@/lib/items/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { acceptQuote, createQuote, finaliseQuote } from "@/lib/quotes/service";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Examples ZN1-ZN8 in docs/ACCOUNTING-EXAMPLES.md ("Free and negative lines"). */
describeWithDatabase("free and negative sales lines", () => {
  let server: TestServer;
  let owner: SessionUser;
  const org = "zero-negative-co";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  let kobeId = "";
  let cluthaId = "";

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("zn-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, org);
    kobeId = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", isCustomer: true }))).contact.id;
    await as((tx) => createAccount(tx, { code: "4050", name: "Discounts given", accountType: "revenue" }));
    await as((tx) => createAccount(tx, { code: "6165", name: "Rebates received", accountType: "expense" }));
    cluthaId = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Clutha Rural", isSupplier: true }))).contact.id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const line = (description: string, unitPrice: string, accountCode = "4000", taxCode = "GST") => ({ description, quantity: "1", unitPrice, accountCode, taxCode });
  const draft = (lines: ReturnType<typeof line>[]) =>
    as((tx) => createInvoice(tx, { idempotencyKey: key("i"), contactId: kobeId, invoiceDate: "2026-10-15", dueDate: "2026-10-15", amountsMode: "exclusive", lines }));
  const approved = async (lines: ReturnType<typeof line>[]) => {
    const { invoice } = await draft(lines);
    return (await as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("a") }))).invoice;
  };
  const billDraft = (lines: Array<Record<string, string>>, supplier?: string) =>
    as((tx) =>
      createBill(tx, {
        idempotencyKey: key("b"),
        contactId: supplier ?? cluthaId,
        billDate: "2026-10-15",
        dueDate: "2026-10-20",
        supplierInvoiceNumber: key("n"),
        amountsMode: "exclusive",
        lines,
      }),
    );
  const approvedBill = async (lines: Array<Record<string, string>>, supplier?: string) => {
    const { bill } = await billDraft(lines, supplier);
    return (await as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("a") }))).bill;
  };
  const journal = (journalId: string) =>
    as(async (tx) =>
      (
        await tx.query<{ code: string; debit: string; credit: string }>(
          `select a.code, l.debit_amount::numeric(18,2)::text as debit, l.credit_amount::numeric(18,2)::text as credit
             from ledger_journal_lines l join accounts a on a.id = l.account_id where l.journal_id = $1 order by l.line_order`,
          [journalId],
        )
      ).rows.map((row) => [row.code, row.debit, row.credit]),
    );

  it("ZN1: a free line shows at 0.00 and adds nothing to the journal", async () => {
    const invoice = await approved([line("Grooming", "100.00"), line("Dog bowl", "0.00")]);
    expect(invoice.total).toBe("115.00");
    expect(invoice.lines.map((l) => [l.description, l.lineAmount])).toEqual([
      ["Grooming", "100.00"],
      ["Dog bowl", "0.00"],
    ]);
    expect(await journal(invoice.approvalJournalId!)).toEqual([
      ["1100", "115.00", "0.00"],
      ["4000", "0.00", "100.00"],
      ["2100", "0.00", "15.00"],
    ]);
  });

  it("ZN2: a negative line reduces the invoice; on its own account it's a debit", async () => {
    const same = await approved([line("Grooming", "100.00"), line("Loyalty discount", "-10.00")]);
    expect([same.subtotal, same.taxTotal, same.total]).toEqual(["90.00", "13.50", "103.50"]);
    expect(await journal(same.approvalJournalId!)).toEqual([
      ["1100", "103.50", "0.00"],
      ["4000", "0.00", "90.00"],
      ["2100", "0.00", "13.50"],
    ]);
    const own = await approved([line("Grooming", "100.00"), line("Loyalty discount", "-10.00", "4050")]);
    expect(await journal(own.approvalJournalId!)).toEqual([
      ["1100", "103.50", "0.00"],
      ["4000", "0.00", "100.00"],
      ["4050", "10.00", "0.00"],
      ["2100", "0.00", "13.50"],
    ]);
  });

  it("ZN3: a negative or zero total is refused", async () => {
    await expect(draft([line("Refund", "-50.00")])).rejects.toThrow("The total can't be negative: for a refund or credit, use a credit note");
    await expect(draft([line("Grooming", "100.00"), line("Back off", "-100.00")])).rejects.toThrow("A document needs something to charge");
  });

  it("ZN4: a quote with a free line turns into an invoice with it", async () => {
    const { quote } = await as((tx) =>
      createQuote(tx, {
        idempotencyKey: key("q"),
        contactId: kobeId,
        quoteDate: "2026-10-15",
        expiryDate: "2026-11-14",
        amountsMode: "exclusive",
        lines: [line("Grooming", "100.00"), line("Dog bowl", "0.00")],
      }),
    );
    await as((tx) => finaliseQuote(tx, quote.id, { idempotencyKey: key("f") }));
    const { invoice } = await as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: key("acc"), invoiceDate: "2026-10-20", dueDate: "2026-11-20" }));
    expect(invoice.lines.map((l) => [l.description, l.unitPrice])).toEqual([
      ["Grooming", "100"],
      ["Dog bowl", "0"],
    ]);
    expect(invoice.total).toBe("115.00");
  });

  it("ZN5: a free line on a bill shows at 0.00 and adds nothing to the journal", async () => {
    const bill = await approvedBill([line("Fencing wire", "500.00", "6160"), line("Delivery", "0.00", "6160")]);
    expect(bill.total).toBe("575.00");
    expect(bill.lines.map((l) => [l.description, l.lineAmount])).toEqual([
      ["Fencing wire", "500.00"],
      ["Delivery", "0.00"],
    ]);
    expect(await journal(bill.approvalJournalId!)).toEqual([
      ["6160", "500.00", "0.00"],
      ["2100", "75.00", "0.00"],
      ["2000", "0.00", "575.00"],
    ]);
  });

  it("ZN6: a negative bill line reduces the bill; on its own account it's a credit", async () => {
    const same = await approvedBill([line("Fencing wire", "500.00", "6160"), line("Trade-in of old wire", "-50.00", "6160")]);
    expect([same.subtotal, same.taxTotal, same.total]).toEqual(["450.00", "67.50", "517.50"]);
    expect(await journal(same.approvalJournalId!)).toEqual([
      ["6160", "450.00", "0.00"],
      ["2100", "67.50", "0.00"],
      ["2000", "0.00", "517.50"],
    ]);
    // Another supplier, so it isn't taken for a duplicate of the first.
    const otherSupplier = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Balclutha Wire", isSupplier: true }))).contact.id;
    const own = await approvedBill([line("Fencing wire", "500.00", "6160"), line("Trade-in of old wire", "-50.00", "6165")], otherSupplier);
    expect(await journal(own.approvalJournalId!)).toEqual([
      ["6160", "500.00", "0.00"],
      ["6165", "0.00", "50.00"],
      ["2100", "67.50", "0.00"],
      ["2000", "0.00", "517.50"],
    ]);
  });

  it("ZN7: a bill below zero or at zero is refused, and so is a free or negative stock line", async () => {
    await expect(billDraft([line("Refund", "-50.00", "6160")])).rejects.toThrow("The total can't be negative: for a refund or credit, use a supplier credit note");
    await expect(billDraft([line("Wire", "100.00", "6160"), line("Back", "-100.00", "6160")])).rejects.toThrow("A document needs something to charge");
    const { item } = await as((tx) =>
      createItem(tx, { idempotencyKey: key("item"), code: "WIRE", name: "Wire", itemType: "stock", purchasePrice: "5.00", purchaseAccountCode: "1400", purchaseTaxCode: "GST" }),
    );
    const stock = (unitPrice: string) => ({ itemId: item.id, description: "Wire", quantity: "1", unitPrice, accountCode: "1400", taxCode: "GST" });
    await expect(billDraft([line("Fencing wire", "500.00", "6160"), stock("0.00")])).rejects.toThrow("Line 2: WIRE is a stock item, so its price can't be free or negative");
    await expect(billDraft([line("Fencing wire", "500.00", "6160"), stock("-5.00")])).rejects.toThrow("Line 2: WIRE is a stock item, so its price can't be free or negative");
  });

  it("ZN8: GST below zero is a debit on an invoice and a credit on a bill", async () => {
    const invoice = await approved([line("Grooming", "100.00", "4000", "EXEMPT"), line("Discount", "-10.00")]);
    expect([invoice.subtotal, invoice.taxTotal, invoice.total]).toEqual(["90.00", "-1.50", "88.50"]);
    expect(await journal(invoice.approvalJournalId!)).toEqual([
      ["1100", "88.50", "0.00"],
      ["4000", "0.00", "90.00"],
      ["2100", "1.50", "0.00"],
    ]);
    const bill = await approvedBill([line("Grooming", "100.00", "6160", "EXEMPT"), line("Discount", "-10.00", "6160")]);
    expect(await journal(bill.approvalJournalId!)).toEqual([
      ["6160", "90.00", "0.00"],
      ["2100", "0.00", "1.50"],
      ["2000", "0.00", "88.50"],
    ]);
  });
});

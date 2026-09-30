import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount } from "@/lib/bank/accounts";
import { createBankTransaction } from "@/lib/bank/transactions";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill, getBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { applyCreditNote } from "@/lib/credit-notes/applications";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { postFxRevaluation } from "@/lib/ledger/fx-revaluation";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { approvePurchaseOrder, copyPurchaseOrderToBill, createPurchaseOrder } from "@/lib/purchase-orders/service";
import { acceptQuote, createQuote, finaliseQuote } from "@/lib/quotes/service";
import { createRepeatingInvoice } from "@/lib/repeating/service";
import { trialBalance } from "@/lib/reports/financial";
import { gstAuditReport } from "@/lib/reports/gst-audit";
import { calculateGstReturn, fileGstReturn } from "@/lib/reports/gst-return";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples MC71-MC83 in docs/ACCOUNTING-EXAMPLES.md (standard-rated GST on
 * foreign-currency documents, not yet approved by Jess), following NetSuite:
 * GST is worked out in the document's currency and converted at the
 * document's own rate, line by line, like its net amounts. Organisation A is
 * on the invoice basis (MC71-MC79), B on the hybrid basis (MC80, MC81) and C
 * on the payments basis (MC82, MC83). 2100 is GST, 1100 accounts
 * receivable, 2000 accounts payable, 4000 Sales, 6040 Software and
 * subscriptions, 7000 unrealised, 7020 realised and 7050 rounding gains and
 * losses.
 */
describeWithDatabase("standard-rated GST on foreign-currency documents", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const ORG = "mcg-co";
  let acme: Contact;
  let aws: Contact;
  let kobe: Contact;
  const invoices: Record<string, string> = {};

  const inOrg = <T>(org: string, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: bookkeeper.id, email: bookkeeper.email }, work);
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrg(ORG, work);
  const postedIn = async (org: string, journalId: string) =>
    (await inOrg(org, (tx) => getJournal(tx, journalId))).lines.map((line) => [
      line.accountCode,
      line.debitAmount,
      line.creditAmount,
      ...(line.foreign ? [`${line.foreign.currencyCode} ${line.foreign.amount} ${line.foreign.kind}`] : []),
    ]);
  const posted = (journalId: string) => postedIn(ORG, journalId);
  const gstLine = (description: string, unitPrice: string, accountCode = "4000") => ({ description, quantity: "1", unitPrice, accountCode, taxCode: "GST" });
  const invoiceIn = async (
    org: string,
    contactId: string,
    invoiceDate: string,
    lines: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) => {
    const draft = await inOrg(org, (tx) =>
      createInvoice(tx, { idempotencyKey: key("inv"), contactId, invoiceDate, dueDate: "2026-09-20", amountsMode: "exclusive", lines, ...extra }, { foreignCurrency: true }),
    );
    return (await inOrg(org, (tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") }))).invoice;
  };
  const billIn = async (org: string, contactId: string, billDate: string, number: string, lines: Array<Record<string, unknown>>, exchangeRate: string) => {
    const draft = await inOrg(org, (tx) =>
      createBill(
        tx,
        { idempotencyKey: key("bill"), contactId, billDate, dueDate: "2026-09-30", supplierInvoiceNumber: number, amountsMode: "exclusive", lines, exchangeRate },
        null,
        { foreignCurrency: true },
      ),
    );
    return (await inOrg(org, (tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("approve") }))).bill;
  };
  const contactIn = async (org: string, name: string, fields: Record<string, unknown>) =>
    (await inOrg(org, (tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...fields }))).contact;
  const newOrganisation = async (org: string) => {
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    return inOrganisation(org, { userId: owner.id, email: owner.email }, (tx) =>
      createBankAccount(tx, { code: "1030", name: "USD account", accountType: "bank", currencyCode: "USD" }),
    );
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("mcg-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("mcg-bookkeeper@example.com");
    await newOrganisation(ORG);
    acme = await contactIn(ORG, "Acme Inc", { isCustomer: true, currencyCode: "USD" });
    aws = await contactIn(ORG, "Amazon Web Services", { isSupplier: true, currencyCode: "USD" });
    kobe = await contactIn(ORG, "Kobe Ltd", { isCustomer: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("MC71: a USD invoice at 15% (exclusive): GST in USD, converted at the invoice's rate; 2100 gets the NZD GST only", async () => {
    const approved = await invoiceIn(ORG, acme.id, "2026-07-01", [gstLine("Consulting", "1000.00")], { exchangeRate: "1.60" });
    invoices["INV-0001"] = approved.id;
    expect(approved).toMatchObject({
      invoiceNumber: "INV-0001",
      currencyCode: "USD",
      subtotal: "1000.00",
      taxTotal: "150.00",
      total: "1150.00",
      exchangeRate: "1.6",
      baseSubtotal: "1600.00",
      baseTaxTotal: "240.00",
      baseTotal: "1840.00",
    });
    expect(approved.lines[0]).toMatchObject({ netAmount: "1000.00", taxAmount: "150.00", baseNetAmount: "1600.00", baseTaxAmount: "240.00" });
    expect(await posted(approved.approvalJournalId!)).toEqual([
      ["1100", "1840.00", "0.00", "USD 1150.00 document"],
      ["4000", "0.00", "1600.00"],
      ["2100", "0.00", "240.00"],
    ]);
  });

  it("MC72: tax inclusive: the GST is worked out in USD first, then converted", async () => {
    const approved = await invoiceIn(ORG, acme.id, "2026-07-02", [gstLine("Design", "230.00")], { exchangeRate: "1.65", amountsMode: "inclusive" });
    invoices["INV-0002"] = approved.id;
    expect(approved).toMatchObject({ subtotal: "200.00", taxTotal: "30.00", total: "230.00", baseSubtotal: "330.00", baseTaxTotal: "49.50", baseTotal: "379.50" });
    expect(await posted(approved.approvalJournalId!)).toEqual([
      ["1100", "379.50", "0.00", "USD 230.00 document"],
      ["4000", "0.00", "330.00"],
      ["2100", "0.00", "49.50"],
    ]);
  });

  it("MC73: each line's net and GST converted on its own; the cents left against total x rate are rounding when it's paid, never GST", async () => {
    const approved = await invoiceIn(ORG, acme.id, "2026-07-03", [gstLine("A", "10.07"), gstLine("B", "10.07"), gstLine("C", "10.07")], { exchangeRate: "1.5" });
    invoices["INV-0003"] = approved.id;
    // Each line: GST 10.07 x 15% = 1.5105 -> 1.51; NZD net 15.105 -> 15.11, GST 2.265 -> 2.27.
    expect(approved).toMatchObject({ subtotal: "30.21", taxTotal: "4.53", total: "34.74", baseSubtotal: "45.33", baseTaxTotal: "6.81", baseTotal: "52.14" });
    expect(approved.lines.map((entry) => [entry.baseNetAmount, entry.baseTaxAmount])).toEqual([
      ["15.11", "2.27"],
      ["15.11", "2.27"],
      ["15.11", "2.27"],
    ]);
    expect(await posted(approved.approvalJournalId!)).toEqual([
      ["1100", "52.14", "0.00", "USD 34.74 document"],
      ["4000", "0.00", "45.33"],
      ["2100", "0.00", "6.81"],
    ]);
    // Paid in full the same day at the same rate: 34.74 x 1.5 = 52.11, so 0.03 of rounding (MC4, MC31); no GST line.
    const { payment } = await run((tx) =>
      recordPayment(tx, approved.id, { idempotencyKey: key("pay"), paymentDate: "2026-07-03", amount: "34.74", bankAccountCode: "1000", exchangeRate: "1.5" }),
    );
    expect(payment).toMatchObject({ baseAmount: "52.11", baseCleared: "52.14", realisedGain: "0.00", roundingGain: "-0.03" });
    expect(await posted(payment.journalId)).toEqual([
      ["1000", "52.11", "0.00"],
      ["1100", "0.00", "52.14", "USD 34.74 carrying_value"],
      ["7050", "0.03", "0.00"],
    ]);
  });

  it("MC74: a USD credit note with GST, applied to an invoice at another rate: the gain has no GST", async () => {
    const draft = await run((tx) =>
      createCreditNote(tx, { idempotencyKey: key("cn"), contactId: acme.id, creditNoteDate: "2026-07-10", amountsMode: "exclusive", lines: [gstLine("Discount", "100.00")], exchangeRate: "1.62" }),
    );
    const credit = (await run((tx) => approveCreditNote(tx, draft.creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    expect(credit).toMatchObject({ creditNoteNumber: "CN-0001", total: "115.00", baseSubtotal: "162.00", baseTaxTotal: "24.30", baseTotal: "186.30" });
    expect(await posted(credit.approvalJournalId!)).toEqual([
      ["4000", "162.00", "0.00"],
      ["2100", "24.30", "0.00"],
      ["1100", "0.00", "186.30", "USD 115.00 document"],
    ]);
    const applied = await run((tx) =>
      applyCreditNote(tx, credit.id, { idempotencyKey: key("apply"), applicationDate: "2026-07-12", applications: [{ invoiceId: invoices["INV-0001"], amount: "115.00" }] }),
    );
    // The invoice's side 1,840.00 x 115 / 1,150 = 184.00; (1.62 - 1.60) x 115.00 = 2.30.
    expect(applied.applications[0]).toMatchObject({ invoiceBase: "184.00", creditNoteBase: "186.30", realisedGain: "2.30" });
    expect(await posted(applied.applications[0].journalId!)).toEqual([
      ["1100", "186.30", "0.00", "USD 115.00 carrying_value"],
      ["1100", "0.00", "184.00", "USD 115.00 carrying_value"],
      ["7020", "0.00", "2.30"],
    ]);
    expect(await run((tx) => getInvoice(tx, invoices["INV-0001"]))).toMatchObject({ amountDue: "1035.00", amountDueBase: "1656.00" });
  });

  it("MC75 and MC76: a USD bill with GST paid later at another rate (the loss has no GST); a USD supplier credit note with GST", async () => {
    const bill = await billIn(ORG, aws.id, "2026-07-05", "AWS-1", [gstLine("Hosting", "200.00", "6040")], "1.60");
    expect(bill).toMatchObject({ total: "230.00", taxTotal: "30.00", baseSubtotal: "320.00", baseTaxTotal: "48.00", baseTotal: "368.00" });
    expect(await posted(bill.approvalJournalId!)).toEqual([
      ["6040", "320.00", "0.00"],
      ["2100", "48.00", "0.00"],
      ["2000", "0.00", "368.00", "USD 230.00 document"],
    ]);
    const { payment } = await run((tx) =>
      recordSupplierPayment(tx, bill.id, { idempotencyKey: key("pay"), paymentDate: "2026-07-20", amount: "230.00", bankAccountCode: "1000", exchangeRate: "1.70" }),
    );
    expect(payment).toMatchObject({ baseAmount: "391.00", baseCleared: "368.00", realisedGain: "-23.00" });
    expect((await posted(payment.journalId)).filter((entry) => entry[0] === "2100")).toEqual([]);
    expect(await posted(payment.journalId)).toEqual(
      expect.arrayContaining([
        ["2000", "368.00", "0.00", "USD 230.00 carrying_value"],
        ["1000", "0.00", "391.00"],
        ["7020", "23.00", "0.00"],
      ]),
    );
    expect(await run((tx) => getBill(tx, bill.id))).toMatchObject({ paidStatus: "paid", baseTaxTotal: "48.00" });

    const draft = await run((tx) =>
      createSupplierCreditNote(tx, {
        idempotencyKey: key("scn"),
        contactId: aws.id,
        creditNoteDate: "2026-07-08",
        supplierCreditNoteNumber: "AWS-CR1",
        amountsMode: "exclusive",
        lines: [gstLine("Credit", "20.00", "6040")],
        exchangeRate: "1.60",
      }),
    );
    const credit = (await run((tx) => approveSupplierCreditNote(tx, draft.creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    expect(credit).toMatchObject({ total: "23.00", baseTaxTotal: "4.80", baseTotal: "36.80" });
    expect(await posted(credit.approvalJournalId!)).toEqual([
      ["2000", "36.80", "0.00", "USD 23.00 document"],
      ["6040", "0.00", "32.00"],
      ["2100", "0.00", "4.80"],
    ]);
  });

  it("MC77: the July GST return (invoice basis) and GST audit report count them at their NZD values", async () => {
    const kobeInvoice = await invoiceIn(ORG, kobe.id, "2026-07-04", [gstLine("Walks", "100.00")]);
    invoices["INV-0004"] = kobeInvoice.id;
    const july = { periodStart: "2026-07-01", periodEnd: "2026-07-31" };
    const gst = await run((tx) => calculateGstReturn(tx, july));
    // Box 5: 1,840.00 + 379.50 + 52.14 + 115.00 - 186.30; Box 11: 368.00 - 36.80.
    expect(gst.boxes).toMatchObject({ box5: "2200.34", box6: "0.00", box8: "287.00", box11: "331.20", box12: "43.20" });
    // The documents' own GST: 240.00 + 49.50 + 6.81 + 15.00 - 24.30, and 48.00 - 4.80.
    expect(gst.gstOnTransactions).toMatchObject({ sales: "287.01", purchases: "43.20" });
    const audit = await run((tx) => gstAuditReport(tx, july));
    expect(audit.box5.entries.map((entry) => [entry.documentNumber, entry.amount, entry.gst])).toEqual([
      ["INV-0001", "1840.00", "240.00"],
      ["INV-0002", "379.50", "49.50"],
      ["INV-0003", "52.14", "6.81"],
      ["INV-0004", "115.00", "15.00"],
      ["CN-0001", "-186.30", "-24.30"],
    ]);
    expect(audit.box11.entries.map((entry) => [entry.documentNumber, entry.amount, entry.gst])).toEqual([
      ["AWS-1", "368.00", "48.00"],
      ["AWS-CR1", "-36.80", "-4.80"],
    ]);
    const tb = await run((tx) => trialBalance(tx, { asAt: "2026-07-31" }));
    expect(tb.balanced).toBe(true);
    // 287.01 - 43.20: the GST account holds exactly the documents' NZD GST.
    expect(tb.rows.find((entry) => entry.code === "2100")).toMatchObject({ debit: "0.00", credit: "243.81" });
  });

  it("MC78: revaluing a GST-inclusive USD invoice revalues its whole open amount; 2100 isn't revalued", async () => {
    const { run: fx } = await run((tx) =>
      postFxRevaluation(tx, {
        idempotencyKey: key("fx"),
        reference: "FX-JUL",
        revaluationDate: "2026-07-31",
        reversalPostingDate: "2026-08-01",
        rateDate: "2026-07-31",
        rateSource: "RBNZ",
        unrealisedGainAccountCode: "7000",
        unrealisedLossAccountCode: "7010",
        balances: [{ accountCode: "1100", currencyCode: "USD", closingRate: "1.70" }],
      }),
    );
    // INV-0001: USD 1,035.00 open (1,150.00 less CN-0001's 115.00), NZD 1,656.00; INV-0002: USD 230.00, NZD 379.50.
    expect(fx.items.map((item) => [item.accountCode, item.currencyCode, item.foreignAmount, item.carryingAmount, item.revaluedAmount, item.deltaAmount])).toEqual([
      ["1100", "USD", "1265.00", "2035.50", "2150.50", "115.00"],
    ]);
    expect(fx.items[0].documents.map((doc) => [doc.documentNumber, doc.foreignAmount, doc.documentRate, doc.deltaAmount])).toEqual([
      ["INV-0001", "1035.00", "1.6", "103.50"],
      ["INV-0002", "230.00", "1.65", "11.50"],
    ]);
    const lines = await posted(fx.revaluationJournalId);
    expect(lines.filter((entry) => entry[0] === "2100")).toEqual([]);
    const tb = await run((tx) => trialBalance(tx, { asAt: "2026-07-31" }));
    expect(tb.rows.find((entry) => entry.code === "2100")).toMatchObject({ credit: "243.81" });
    expect(tb.rows.find((entry) => entry.code === "7000")).toMatchObject({ credit: "115.00" });
    expect((await run((tx) => calculateGstReturn(tx, { periodStart: "2026-07-01", periodEnd: "2026-07-31" }))).boxes).toMatchObject({ box5: "2200.34", box11: "331.20" });
  });

  it("MC79: a USD quote, purchase order and repeating invoice with GST; the documents made from them are converted as MC71", async () => {
    const quote = await run((tx) =>
      createQuote(tx, { idempotencyKey: key("quote"), contactId: acme.id, quoteDate: "2026-08-03", expiryDate: "2026-09-03", amountsMode: "exclusive", lines: [gstLine("Design", "100.00")] }),
    );
    expect(quote.quote).toMatchObject({ currencyCode: "USD", taxTotal: "15.00", total: "115.00" });
    await run((tx) => finaliseQuote(tx, quote.quote.id, { idempotencyKey: key("fin") }));
    const accepted = await run((tx) => acceptQuote(tx, quote.quote.id, { idempotencyKey: key("accept"), invoiceDate: "2026-08-05", dueDate: "2026-09-05", exchangeRate: "1.70" }));
    expect(accepted.invoice).toMatchObject({ status: "draft", total: "115.00", baseTaxTotal: "25.50", baseTotal: "195.50" });
    const approved = (await run((tx) => approveInvoice(tx, accepted.invoice.id, { idempotencyKey: key("approve") }))).invoice;
    expect(await posted(approved.approvalJournalId!)).toEqual([
      ["1100", "195.50", "0.00", "USD 115.00 document"],
      ["4000", "0.00", "170.00"],
      ["2100", "0.00", "25.50"],
    ]);

    const order = await run((tx) =>
      createPurchaseOrder(tx, {
        idempotencyKey: key("po"),
        contactId: aws.id,
        orderDate: "2026-08-03",
        deliveryDate: "2026-08-06",
        amountsMode: "exclusive",
        lines: [{ description: "Reserved instances", quantity: "2", unitPrice: "20.00", accountCode: "6040", taxCode: "GST" }],
      }),
    );
    expect(order.purchaseOrder).toMatchObject({ currencyCode: "USD", taxTotal: "6.00", total: "46.00" });
    await run((tx) => approvePurchaseOrder(tx, order.purchaseOrder.id, { idempotencyKey: key("appr") }));
    const copied = await run((tx) =>
      copyPurchaseOrderToBill(tx, order.purchaseOrder.id, { idempotencyKey: key("copy"), billDate: "2026-08-06", dueDate: "2026-09-06", supplierInvoiceNumber: "AWS-PO1", exchangeRate: "1.70" }),
    );
    expect(copied.bill).toMatchObject({ status: "draft", total: "46.00", baseTaxTotal: "10.20", baseTotal: "78.20" });
    const bill = (await run((tx) => approveBill(tx, copied.bill.id, { idempotencyKey: key("approve") }))).bill;
    expect(await posted(bill.approvalJournalId!)).toEqual([
      ["6040", "68.00", "0.00"],
      ["2100", "10.20", "0.00"],
      ["2000", "0.00", "78.20", "USD 46.00 document"],
    ]);

    const repeating = await run((tx) =>
      createRepeatingInvoice(tx, {
        idempotencyKey: key("ri"),
        contactId: acme.id,
        amountsMode: "exclusive",
        lines: [gstLine("Retainer", "100.00")],
        period: "month",
        every: 1,
        startDate: "2026-08-31",
        dueRule: "days_after",
        dueDays: 20,
        saveAs: "draft",
      }),
    );
    expect(repeating.repeatingInvoice).toMatchObject({ currencyCode: "USD", taxTotal: "15.00", total: "115.00" });
  });

  it("MC80 and MC81: hybrid basis: a USD bill counts its NZD share, GST included, when paid; changing to the invoice basis adjusts by NZD GST", async () => {
    const HYB = "mcg-hybrid";
    await newOrganisation(HYB);
    await inOrganisation(HYB, { userId: owner.id, email: owner.email }, (tx) => updateOrganisationSettings(tx, { gstBasis: "hybrid" }));
    const customer = await contactIn(HYB, "Acme Inc", { isCustomer: true, currencyCode: "USD" });
    const supplier = await contactIn(HYB, "Amazon Web Services", { isSupplier: true, currencyCode: "USD" });
    const sale = await invoiceIn(HYB, customer.id, "2026-08-02", [gstLine("Consulting", "100.00")], { exchangeRate: "1.60" });
    expect(sale).toMatchObject({ total: "115.00", baseTaxTotal: "24.00", baseTotal: "184.00" });
    const bill = await billIn(HYB, supplier.id, "2026-08-01", "AWS-2", [gstLine("Hosting", "200.00", "6040")], "1.60");
    expect(bill).toMatchObject({ total: "230.00", baseTaxTotal: "48.00", baseTotal: "368.00" });
    const { payment } = await inOrg(HYB, (tx) =>
      recordSupplierPayment(tx, bill.id, { idempotencyKey: key("pay"), paymentDate: "2026-08-10", amount: "115.00", bankAccountCode: "1030", exchangeRate: "1.70" }),
    );
    // Half the bill: cleared 368.00 x 115 / 230 = 184.00, bank 115.00 x 1.70 = 195.50, realised loss 11.50.
    expect(payment).toMatchObject({ baseAmount: "195.50", baseCleared: "184.00", realisedGain: "-11.50" });
    expect(await postedIn(HYB, payment.journalId)).toEqual(
      expect.arrayContaining([
        ["2000", "184.00", "0.00", "USD 115.00 carrying_value"],
        ["1030", "0.00", "195.50", "USD 115.00 rate"],
        ["7020", "11.50", "0.00"],
      ]),
    );
    const august = { periodStart: "2026-08-01", periodEnd: "2026-08-31" };
    const gst = await inOrg(HYB, (tx) => calculateGstReturn(tx, august));
    // Sales when approved: 184.00 (GST 24.00). Purchases when paid: the bill's share at its own rate, 184.00, GST 48.00 x 184 / 368 = 24.00.
    expect(gst.boxes).toMatchObject({ box5: "184.00", box8: "24.00", box11: "184.00", box12: "24.00", box15: "0.00" });
    expect(gst.gstOnTransactions).toMatchObject({ sales: "24.00", purchases: "24.00" });
    const paidLine = gst.lines.find((entry) => entry.documentNumber === "AWS-2")!;
    expect(paidLine).toMatchObject({ eventType: "supplier_payment", amount: "184.00", gst: "24.00", settledAmount: "184.00", documentTotal: "368.00" });

    // MC81: August is filed on the hybrid basis, then the basis changes to invoice. AWS-2 still owes USD 115.00:
    // its GST is 115.00 x 48.00 (NZD) / 230.00 = 24.00, a Box 13 adjustment (IR546, hybrid -> invoice).
    await inOrg(HYB, (tx) => fileGstReturn(tx, { idempotencyKey: key("file"), ...august }));
    await inOrganisation(HYB, { userId: owner.id, email: owner.email }, (tx) => updateOrganisationSettings(tx, { gstBasis: "invoice" }));
    const september = await inOrg(HYB, (tx) => calculateGstReturn(tx, { periodStart: "2026-09-01", periodEnd: "2026-09-30" }));
    expect(september.basisChange).toMatchObject({ from: "hybrid", to: "invoice", debtorsGst: "24.00", creditorsGst: "24.00" });
    expect(september.basisChange?.suggestion).toMatchObject({ box: "13", amount: "24.00" });
  });

  it("MC82 and MC83: payments basis: USD sales stay refused; a USD bill with GST is fine; USD spend money with GST stays refused", async () => {
    const PAY = "mcg-payments";
    const usd = await newOrganisation(PAY);
    await inOrganisation(PAY, { userId: owner.id, email: owner.email }, (tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    const customer = await contactIn(PAY, "Acme Inc", { isCustomer: true, currencyCode: "USD" });
    const supplier = await contactIn(PAY, "Amazon Web Services", { isSupplier: true, currencyCode: "USD" });
    await expect(invoiceIn(PAY, customer.id, "2026-09-01", [gstLine("Consulting", "100.00")], { exchangeRate: "1.60" })).rejects.toThrow(
      /Foreign-currency invoices aren't supported yet while sales count for GST when they're paid \(the payments basis\)/,
    );
    await expect(
      inOrg(PAY, (tx) =>
        createCreditNote(tx, { idempotencyKey: key("cn"), contactId: customer.id, creditNoteDate: "2026-09-01", amountsMode: "exclusive", lines: [gstLine("Discount", "10.00")], exchangeRate: "1.60" }),
      ),
    ).rejects.toThrow(/Foreign-currency credit notes aren't supported yet while sales count for GST when they're paid/);
    const bill = await billIn(PAY, supplier.id, "2026-09-01", "AWS-3", [gstLine("Hosting", "200.00", "6040")], "1.60");
    await inOrg(PAY, (tx) =>
      recordSupplierPayment(tx, bill.id, { idempotencyKey: key("pay"), paymentDate: "2026-09-10", amount: "46.00", bankAccountCode: "1030", exchangeRate: "1.50" }),
    );
    // 46.00 of 230.00 at the bill's rate: 368.00 x 46 / 230 = 73.60, GST 9.60.
    expect((await inOrg(PAY, (tx) => calculateGstReturn(tx, { periodStart: "2026-09-01", periodEnd: "2026-09-30" }))).boxes).toMatchObject({
      box5: "0.00",
      box11: "73.60",
      box12: "9.60",
    });
    // MC83: GST on USD spend money is still refused (FXB4).
    await expect(
      inOrg(PAY, (tx) =>
        createBankTransaction(tx, {
          idempotencyKey: key("spend"),
          kind: "spend",
          accountId: usd.id,
          contactId: supplier.id,
          date: "2026-09-05",
          amountsMode: "inclusive",
          exchangeRate: "1.60",
          lines: [{ description: "Hosting", accountCode: "6040", taxCode: "GST", amount: "50.00" }],
        }),
      ),
    ).rejects.toThrow(/GST on foreign-currency spend and receive money isn't supported yet/);
  });
});

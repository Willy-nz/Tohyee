import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listStatementLines, type StatementLine } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill } from "@/lib/bills/service";
import { type Contact, createContact, updateContact } from "@/lib/contacts/service";
import { applyCreditNote, removeApplication } from "@/lib/credit-notes/applications";
import { refundCreditNote } from "@/lib/credit-notes/refunds";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { periodChecklist } from "@/lib/ledger/period-close";
import { postFxRevaluation } from "@/lib/ledger/fx-revaluation";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { recordPaymentBatch } from "@/lib/payments/batches";
import { createPurchaseOrder } from "@/lib/purchase-orders/service";
import { createQuote } from "@/lib/quotes/service";
import { createRepeatingInvoice } from "@/lib/repeating/service";
import { agedPayables } from "@/lib/reports/aged-payables";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { activityStatement, outstandingStatement } from "@/lib/reports/customer-statements";
import { trialBalance } from "@/lib/reports/financial";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { applySupplierCreditNote } from "@/lib/supplier-credit-notes/applications";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { coreQuery } from "@/lib/db/transactions";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const b64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * Examples MC1-MC13 in docs/ACCOUNTING-EXAMPLES.md (multi-currency invoices
 * and bills, not yet approved by Jess), one organisation worked through in
 * order: 1000 Business bank account (NZD), 1030 USD account and 1040 EUR
 * account (both with no postings before), 1100 accounts receivable, 2000
 * accounts payable, 4000 Sales, 6040 Software and subscriptions, 7000/7010
 * unrealised and 7020 realised currency gains and losses.
 */
describeWithDatabase("multi-currency invoices and bills", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const ORG = "mc-co";
  let acme: Contact;
  let aws: Contact;
  let kobe: Contact;
  let usd: { id: string };
  const invoices: Record<string, string> = {};
  const bills: Record<string, string> = {};
  let creditNoteId: string;

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => as(bookkeeper, work);
  const posted = async (journalId: string) =>
    (await run((tx) => getJournal(tx, journalId))).lines.map((line) => [
      line.accountCode,
      line.debitAmount,
      line.creditAmount,
      ...(line.foreign ? [`${line.foreign.currencyCode} ${line.foreign.amount} ${line.foreign.kind}`] : []),
    ]);
  const line = (description: string, unitPrice: string, extra: Record<string, unknown> = {}) => ({
    description,
    quantity: "1",
    unitPrice,
    accountCode: "4000",
    taxCode: "ZERO",
    ...extra,
  });
  const invoice = async (
    name: string,
    contactId: string,
    invoiceDate: string,
    lines: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) => {
    const draft = await run((tx) =>
      createInvoice(tx, { idempotencyKey: key("inv"), contactId, invoiceDate, dueDate: "2026-08-20", amountsMode: "exclusive", lines, ...extra }, { foreignCurrency: true }),
    );
    const approved = await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") }));
    invoices[name] = approved.invoice.id;
    return approved.invoice;
  };
  const bill = async (name: string, billDate: string, amount: string, exchangeRate: string) => {
    const draft = await run((tx) =>
      createBill(
        tx,
        {
          idempotencyKey: key("bill"),
          contactId: aws.id,
          billDate,
          dueDate: "2026-08-31",
          supplierInvoiceNumber: name,
          amountsMode: "no_tax",
          lines: [{ description: "Hosting", quantity: "1", unitPrice: amount, accountCode: "6040" }],
          exchangeRate,
        },
        null,
        { foreignCurrency: true },
      ),
    );
    const approved = await run((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("approve") }));
    bills[name] = approved.bill.id;
    return approved.bill;
  };
  const pay = (invoiceId: string, paymentDate: string, amount: string, bankAccountCode: string, exchangeRate?: string) =>
    run((tx) => recordPayment(tx, invoiceId, { idempotencyKey: key("pay"), paymentDate, amount, bankAccountCode, exchangeRate }));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("mc-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("mc-bookkeeper@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, bookkeeper.id]);
    usd = await as(owner, (tx) => createBankAccount(tx, { code: "1030", name: "USD account", accountType: "bank", currencyCode: "USD" }));
    await as(owner, (tx) => createBankAccount(tx, { code: "1040", name: "EUR account", accountType: "bank", currencyCode: "EUR" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("MC1: a contact has a currency (NZD when none); it can't change once it has documents", async () => {
    const contact = async (name: string, fields: Record<string, unknown>) =>
      (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...fields }))).contact;
    acme = await contact("Acme Inc", { isCustomer: true, currencyCode: "usd" });
    aws = await contact("Amazon Web Services", { isSupplier: true, currencyCode: "USD" });
    kobe = await contact("Kobe Ltd", { isCustomer: true });
    expect([acme.currencyCode, aws.currencyCode, kobe.currencyCode]).toEqual(["USD", "USD", null]);
    expect((await contact("Kiwi Co", { isCustomer: true, currencyCode: "NZD" })).currencyCode).toBeNull();
    await expect(contact("Nowhere Ltd", { isCustomer: true, currencyCode: "XYZ" })).rejects.toThrow(/currencyCode must be one of/);
    // No documents yet: it can still change (and back).
    expect((await run((tx) => updateContact(tx, kobe.id, { currencyCode: "EUR" }))).currencyCode).toBe("EUR");
    expect((await run((tx) => updateContact(tx, kobe.id, { currencyCode: "" }))).currencyCode).toBeNull();
  });

  it("MC2: a USD invoice needs a rate; it posts its NZD value with the USD amount on 1100", async () => {
    const lines = [line("Consulting", "1000.00")];
    await expect(
      run((tx) =>
        createInvoice(tx, { idempotencyKey: key("inv"), contactId: acme.id, invoiceDate: "2026-07-03", dueDate: "2026-08-20", amountsMode: "exclusive", lines }, { foreignCurrency: true }),
      ),
    ).rejects.toThrow(/Type the exchange rate for this invoice \(NZD per 1 USD\): no USD rate has been used on or before 2026-07-03 yet/);
    await expect(
      run((tx) =>
        createInvoice(
          tx,
          { idempotencyKey: key("inv"), contactId: acme.id, invoiceDate: "2026-07-03", dueDate: "2026-08-20", amountsMode: "exclusive", lines: [line("Consulting", "1000.00", { taxCode: "GST" })], exchangeRate: "1.6543" },
          { foreignCurrency: true },
        ),
      ),
    ).rejects.toThrow(/GST on foreign-currency invoices, bills and credit notes isn't supported yet \(refused rather than guessed\)/);
    const approved = await invoice("INV-0001", acme.id, "2026-07-03", lines, { exchangeRate: "1.6543" });
    expect(approved).toMatchObject({ invoiceNumber: "INV-0001", currencyCode: "USD", total: "1000.00", exchangeRate: "1.6543", baseTotal: "1654.30", amountDueBase: "1654.30" });
    expect(approved.lines[0]).toMatchObject({ netAmount: "1000.00", baseNetAmount: "1654.30", baseTaxAmount: "0.00" });
    expect(await posted(approved.approvalJournalId!)).toEqual([
      ["1100", "1654.30", "0.00", "USD 1000.00 document"],
      ["4000", "0.00", "1654.30"],
    ]);
    // Acme has an invoice now, so its currency is fixed (MC1).
    await expect(run((tx) => updateContact(tx, acme.id, { currencyCode: "EUR" }))).rejects.toThrow(/Acme Inc has invoices, bills or credit notes in USD, so its currency can't change/);
    await expect(
      as(owner, (tx) => tx.query("update contacts set currency_code = 'EUR' where id = $1", [acme.id])),
    ).rejects.toThrow(/currency can't change/);
  });

  it("MC3: with no rate typed, a USD invoice takes the last USD rate used on or before its date", async () => {
    const approved = await invoice("INV-0002", acme.id, "2026-07-04", [line("Design", "500.00")]);
    expect(approved).toMatchObject({ invoiceNumber: "INV-0002", exchangeRate: "1.6543", baseTotal: "827.15" });
  });

  it("MC4: each line is converted on its own (as NetSuite does); paying at the same rate leaves a cent of realised loss", async () => {
    const approved = await invoice("INV-0003", acme.id, "2026-07-12", [line("A", "10.01"), line("B", "10.01"), line("C", "10.01")], { exchangeRate: "1.5" });
    expect(approved).toMatchObject({ total: "30.03", baseTotal: "45.06" });
    expect(approved.lines.map((entry) => entry.baseNetAmount)).toEqual(["15.02", "15.02", "15.02"]);
    expect(await posted(approved.approvalJournalId!)).toEqual([
      ["1100", "45.06", "0.00", "USD 30.03 document"],
      ["4000", "0.00", "45.06"],
    ]);
    const { payment, invoice: paid } = await pay(approved.id, "2026-07-12", "30.03", "1000", "1.5");
    expect(payment).toMatchObject({ exchangeRate: "1.5", baseAmount: "45.05", baseCleared: "45.06", realisedGain: "-0.01" });
    expect(await posted(payment.journalId)).toEqual([
      ["1000", "45.05", "0.00"],
      ["1100", "0.00", "45.06", "USD 30.03 carrying_value"],
      ["7020", "0.01", "0.00"],
    ]);
    expect(paid).toMatchObject({ paidStatus: "paid", amountDue: "0.00", amountDueBase: "0.00" });
  });

  it("MC5: a USD invoice paid from a USD statement line into 1030 at 1.64: realised loss 14.30 (D6 lifted)", async () => {
    const kobeInvoice = await invoice("INV-0004", kobe.id, "2026-07-02", [{ description: "Walks", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }]);
    await run((tx) =>
      importStatementFile(tx, usd.id, { idempotencyKey: key("import"), fileName: "usd.csv", fileBase64: b64("Date,Amount,Payee\n20/07/2026,1000.00,ACME INC\n21/07/2026,115.00,KOBE LTD\n") }),
    );
    const lines = (await run((tx) => listStatementLines(tx, usd.id, { status: "all" }))).lines;
    const lineOn = (date: string): StatementLine => lines.find((entry) => entry.date === date)!;
    await expect(
      run((tx) => reconcileStatementLine(tx, lineOn("2026-07-21").id, { idempotencyKey: key("rec"), kind: "payments", allocations: [{ invoiceId: kobeInvoice.id, amount: "115.00" }] })),
    ).rejects.toThrow(/Invoice INV-0004 is in NZD, so it can't be paid from a USD statement line yet/);
    const done = await run((tx) =>
      reconcileStatementLine(tx, lineOn("2026-07-20").id, {
        idempotencyKey: key("rec"),
        kind: "payments",
        allocations: [{ invoiceId: invoices["INV-0001"], amount: "1000.00" }],
        exchangeRate: "1.64",
      }),
    );
    expect(done.line.status).toBe("reconciled");
    const paid = await run((tx) => getInvoice(tx, invoices["INV-0001"]));
    expect(paid).toMatchObject({ paidStatus: "paid", amountDue: "0.00", amountDueBase: "0.00" });
    expect(await posted(done.line.reconciliation!.items[0].journalId)).toEqual([
      ["1030", "1640.00", "0.00", "USD 1000.00 rate"],
      ["1100", "0.00", "1654.30", "USD 1000.00 carrying_value"],
      ["7020", "14.30", "0.00"],
    ]);
    // A USD invoice from an NZD account's statement line is refused too: pay it on the invoice, then match.
    const nzdId = (await run((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
    await run((tx) => importStatementFile(tx, nzdId, { idempotencyKey: key("import"), fileName: "nzd.csv", fileBase64: b64("Date,Amount,Payee\n22/07/2026,827.15,ACME INC\n") }));
    const nzdLine = (await run((tx) => listStatementLines(tx, nzdId, { status: "all" }))).lines.find((entry) => entry.date === "2026-07-22")!;
    await expect(
      run((tx) => reconcileStatementLine(tx, nzdLine.id, { idempotencyKey: key("rec"), kind: "payments", allocations: [{ invoiceId: invoices["INV-0002"], amount: "500.00" }] })),
    ).rejects.toThrow(/Invoice INV-0002 is in USD, so it can't be paid from a NZD statement line here/);
  });

  it("MC6: part payments into the NZD account clear the invoice at its carrying value; the last takes all that's left", async () => {
    const first = await pay(invoices["INV-0002"], "2026-07-15", "200.00", "1000", "1.70");
    expect(first.payment).toMatchObject({ baseAmount: "340.00", baseCleared: "330.86", realisedGain: "9.14" });
    expect(await posted(first.payment.journalId)).toEqual([
      ["1000", "340.00", "0.00"],
      ["1100", "0.00", "330.86", "USD 200.00 carrying_value"],
      ["7020", "0.00", "9.14"],
    ]);
    expect(first.invoice).toMatchObject({ paidStatus: "part_paid", amountDue: "300.00", amountDueBase: "496.29" });
    await expect(pay(invoices["INV-0002"], "2026-07-28", "300.01", "1000", "1.60")).rejects.toThrow(
      /Overpaying a foreign-currency invoice isn't supported yet \(refused rather than guessed\)/,
    );
    await expect(pay(invoices["INV-0002"], "2026-07-28", "300.00", "1040", "1.60")).rejects.toThrow(/Account 1040 \(EUR account\) is in EUR/);
    const second = await pay(invoices["INV-0002"], "2026-07-28", "300.00", "1000", "1.60");
    expect(second.payment).toMatchObject({ baseAmount: "480.00", baseCleared: "496.29", realisedGain: "-16.29" });
    expect(await posted(second.payment.journalId)).toEqual([
      ["1000", "480.00", "0.00"],
      ["1100", "0.00", "496.29", "USD 300.00 carrying_value"],
      ["7020", "16.29", "0.00"],
    ]);
    expect(second.invoice).toMatchObject({ paidStatus: "paid", amountDueBase: "0.00" });
    // Voiding posts the exact reversal, foreign amounts included; it's due again at its carrying value.
    const voided = await run((tx) => voidPayment(tx, invoices["INV-0002"], second.payment.id, { idempotencyKey: key("void"), voidDate: "2026-07-29" }));
    expect(await posted(voided.payment.voidJournalId!)).toEqual([
      ["1000", "0.00", "480.00"],
      ["1100", "496.29", "0.00", "USD 300.00 carrying_value"],
      ["7020", "0.00", "16.29"],
    ]);
    expect(voided.invoice).toMatchObject({ amountDue: "300.00", amountDueBase: "496.29" });
    const again = await pay(invoices["INV-0002"], "2026-07-29", "300.00", "1000", "1.60");
    expect(again.payment).toMatchObject({ baseCleared: "496.29", realisedGain: "-16.29" });
  });

  it("MC7: a USD credit note, applied to a USD invoice at another rate, realises the difference", async () => {
    const draft = await run((tx) =>
      createCreditNote(tx, { idempotencyKey: key("cn"), contactId: acme.id, creditNoteDate: "2026-07-22", amountsMode: "exclusive", lines: [line("Discount", "100.00")], exchangeRate: "1.63" }),
    );
    const approved = (await run((tx) => approveCreditNote(tx, draft.creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    creditNoteId = approved.id;
    expect(approved).toMatchObject({ creditNoteNumber: "CN-0001", currencyCode: "USD", baseTotal: "163.00", remainingCreditBase: "163.00" });
    expect(await posted(approved.approvalJournalId!)).toEqual([
      ["4000", "163.00", "0.00"],
      ["1100", "0.00", "163.00", "USD 100.00 document"],
    ]);
    const target = await invoice("INV-0005", acme.id, "2026-07-25", [line("Retainer", "2000.00")], { exchangeRate: "1.60" });
    expect(target.baseTotal).toBe("3200.00");
    const apply = () =>
      run((tx) => applyCreditNote(tx, creditNoteId, { idempotencyKey: key("apply"), applicationDate: "2026-07-28", applications: [{ invoiceId: target.id, amount: "100.00" }] }));
    const applied = await apply();
    expect(applied.applications[0]).toMatchObject({ invoiceBase: "160.00", creditNoteBase: "163.00", realisedGain: "3.00" });
    expect(await posted(applied.applications[0].journalId!)).toEqual([
      ["1100", "163.00", "0.00", "USD 100.00 carrying_value"],
      ["1100", "0.00", "160.00", "USD 100.00 carrying_value"],
      ["7020", "0.00", "3.00"],
    ]);
    expect(await run((tx) => getInvoice(tx, target.id))).toMatchObject({ amountDue: "1900.00", amountDueBase: "3040.00" });
    const removed = await run((tx) =>
      removeApplication(tx, creditNoteId, applied.applications[0].id, { idempotencyKey: key("remove"), removalDate: "2026-07-28" }),
    );
    expect(removed.creditNote).toMatchObject({ remainingCredit: "100.00", remainingCreditBase: "163.00" });
    const reversal = (await run((tx) => tx.query<{ id: string }>("select id::text from ledger_journals where related_journal_id = $1", [applied.applications[0].journalId]))).rows[0].id;
    expect(await posted(reversal)).toEqual([
      ["1100", "0.00", "163.00", "USD 100.00 carrying_value"],
      ["1100", "160.00", "0.00", "USD 100.00 carrying_value"],
      ["7020", "3.00", "0.00"],
    ]);
    expect((await apply()).applications[0].realisedGain).toBe("3.00");
    await expect(
      run((tx) => refundCreditNote(tx, creditNoteId, { idempotencyKey: key("refund"), refundDate: "2026-07-30", amount: "1.00", bankAccountCode: "1000" })),
    ).rejects.toThrow(/Refunding a foreign-currency credit note isn't supported yet/);
  });

  it("MC10: a USD bill and a supplier credit note applied at another rate; a payment at the bill's rate has no gain", async () => {
    await expect(
      run((tx) =>
        createBill(
          tx,
          {
            idempotencyKey: key("bill"),
            contactId: aws.id,
            billDate: "2026-07-05",
            dueDate: "2026-08-31",
            supplierInvoiceNumber: "AWS-GST",
            amountsMode: "exclusive",
            lines: [{ description: "Hosting", quantity: "1", unitPrice: "50.00", accountCode: "6040", taxCode: "GST" }],
            exchangeRate: "1.66",
          },
          null,
          { foreignCurrency: true },
        ),
      ),
    ).rejects.toThrow(/GST on foreign-currency invoices, bills and credit notes isn't supported yet/);
    const first = await bill("AWS-7", "2026-07-05", "50.00", "1.66");
    expect(first).toMatchObject({ currencyCode: "USD", baseTotal: "83.00", amountDueBase: "83.00" });
    expect(await posted(first.approvalJournalId!)).toEqual([
      ["6040", "83.00", "0.00"],
      ["2000", "0.00", "83.00", "USD 50.00 document"],
    ]);
    const second = await bill("AWS-8", "2026-07-06", "50.00", "1.66");
    const draft = await run((tx) =>
      createSupplierCreditNote(tx, {
        idempotencyKey: key("scn"),
        contactId: aws.id,
        creditNoteDate: "2026-07-07",
        supplierCreditNoteNumber: "AWS-CR1",
        amountsMode: "no_tax",
        lines: [{ description: "Credit", quantity: "1", unitPrice: "20.00", accountCode: "6040" }],
        exchangeRate: "1.70",
      }),
    );
    const credit = (await run((tx) => approveSupplierCreditNote(tx, draft.creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    expect(await posted(credit.approvalJournalId!)).toEqual([
      ["2000", "34.00", "0.00", "USD 20.00 document"],
      ["6040", "0.00", "34.00"],
    ]);
    const applied = await run((tx) =>
      applySupplierCreditNote(tx, credit.id, { idempotencyKey: key("apply"), applicationDate: "2026-07-08", applications: [{ billId: second.id, amount: "20.00" }] }),
    );
    expect(applied.applications[0]).toMatchObject({ billBase: "33.20", creditNoteBase: "34.00", realisedGain: "-0.80" });
    expect(await posted(applied.applications[0].journalId!)).toEqual([
      ["2000", "33.20", "0.00", "USD 20.00 carrying_value"],
      ["2000", "0.00", "34.00", "USD 20.00 carrying_value"],
      ["7020", "0.80", "0.00"],
    ]);
    const paid = await run((tx) =>
      recordSupplierPayment(tx, second.id, { idempotencyKey: key("pay"), paymentDate: "2026-07-09", amount: "30.00", bankAccountCode: "1000", exchangeRate: "1.66" }),
    );
    expect(paid.payment).toMatchObject({ baseAmount: "49.80", baseCleared: "49.80", realisedGain: "0.00" });
    expect(await posted(paid.payment.journalId)).toEqual([
      ["2000", "49.80", "0.00", "USD 30.00 carrying_value"],
      ["1000", "0.00", "49.80"],
    ]);
    expect(paid.bill).toMatchObject({ paidStatus: "paid", amountDueBase: "0.00" });
  });

  it("MC11: what's refused rather than guessed", async () => {
    const refusedFor = /for customers in a currency other than NZD isn't supported yet \(refused rather than guessed\)/;
    await expect(
      run((tx) =>
        createQuote(tx, { idempotencyKey: key("quote"), contactId: acme.id, quoteDate: "2026-07-15", expiryDate: "2026-08-14", amountsMode: "exclusive", lines: [line("Quote", "10.00")] }),
      ),
    ).rejects.toThrow(refusedFor);
    await expect(
      run((tx) =>
        createRepeatingInvoice(tx, {
          idempotencyKey: key("ri"),
          contactId: acme.id,
          amountsMode: "exclusive",
          lines: [line("Monthly", "10.00")],
          period: "month",
          every: 1,
          startDate: "2026-07-31",
          dueRule: "days_after",
          dueDays: 20,
          saveAs: "draft",
        }),
      ),
    ).rejects.toThrow(refusedFor);
    await expect(
      run((tx) =>
        createPurchaseOrder(tx, {
          idempotencyKey: key("po"),
          contactId: aws.id,
          orderDate: "2026-07-01",
          deliveryDate: "2026-07-10",
          amountsMode: "no_tax",
          lines: [{ description: "Hosting", quantity: "1", unitPrice: "50.00", accountCode: "6040" }],
        }),
      ),
    ).rejects.toThrow(/for suppliers in a currency other than NZD isn't supported yet \(refused rather than guessed\)/);
    // An invoice for a USD customer made by anything but entering it directly (e.g. accepting a quote) is refused the same way.
    await expect(
      run((tx) =>
        createInvoice(tx, { idempotencyKey: key("inv"), contactId: acme.id, invoiceDate: "2026-07-30", dueDate: "2026-08-20", amountsMode: "exclusive", lines: [line("X", "1.00")], exchangeRate: "1.6" }),
      ),
    ).rejects.toThrow(refusedFor);
    await expect(
      run((tx) =>
        recordPaymentBatch(tx, "customer", {
          idempotencyKey: key("batch"),
          paymentDate: "2026-07-30",
          amount: "1.00",
          bankAccountCode: "1000",
          documents: [{ id: invoices["INV-0005"], amount: "1.00" }],
        }),
      ),
    ).rejects.toThrow(/Invoice INV-0005 is in USD. One payment for several invoices is in NZD only/);
    await expect(
      run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("manual"),
          postingDate: "2026-07-30",
          reference: "FX",
          lines: [
            { accountCode: "1100", debitAmount: "16.50", foreignAmount: "10.00", exchangeRate: "1.65" },
            { accountCode: "4000", creditAmount: "16.50" },
          ],
        }),
      ),
    ).rejects.toThrow(/account 1100 \(Accounts receivable\) is in NZD, so it takes no foreign amount or exchange rate/);
    // The database refuses a foreign amount on accounts receivable other than from documents, their payments and revaluations.
    await expect(
      as(owner, async (tx) => {
        const journal = (
          await tx.query<{ id: string }>(
            `insert into ledger_journals (command_source, idempotency_key, request_hash, origin, posting_date, reference, currency_code, total_debit, total_credit)
             values ('test', 'mc11-db', 'x', 'manual', '2026-07-30', 'X', 'NZD', 16.50, 16.50) returning id`,
          )
        ).rows[0].id;
        await tx.query(
          `insert into ledger_journal_lines (journal_id, line_order, account_id, debit_amount, credit_amount, foreign_currency_code, foreign_amount, exchange_rate, fx_kind)
           values ($1, 1, (select id from accounts where code = '1100'), 16.50, 0, 'USD', 10, 1.65, 'rate')`,
          [journal],
        );
      }),
    ).rejects.toThrow(/only takes foreign amounts from invoices, bills, credit notes, their payments and revaluations/);
    // Sales that count for GST when paid (the payments basis).
    await as(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    await expect(
      run((tx) =>
        createInvoice(tx, { idempotencyKey: key("inv"), contactId: acme.id, invoiceDate: "2026-07-30", dueDate: "2026-08-20", amountsMode: "exclusive", lines: [line("X", "1.00")], exchangeRate: "1.6" }, { foreignCurrency: true }),
      ),
    ).rejects.toThrow(/Foreign-currency invoices aren't supported yet while sales count for GST when they're paid/);
    await as(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "invoice" }));
  });

  it("MC8: month-end revaluation of open USD invoices and bills (and 1030), reversed the next day", async () => {
    const checks = async () => (await run((tx) => periodChecklist(tx, { periodEnd: "2026-07-31" }))).checks.find((entry) => entry.key === "fx_revaluation")!;
    const before = await checks();
    expect(before.status).toBe("warning");
    expect(before.items.map((item) => item.label)).toEqual(["1030 USD account", "1100 Accounts receivable", "2000 Accounts payable"]);
    const revalue = (balances: Array<Record<string, unknown>>, idempotencyKey = key("fx")) =>
      run((tx) =>
        postFxRevaluation(tx, {
          idempotencyKey,
          reference: "FX-JUL",
          revaluationDate: "2026-07-31",
          reversalPostingDate: "2026-08-01",
          rateDate: "2026-07-31",
          rateSource: "RBNZ",
          unrealisedGainAccountCode: "7000",
          unrealisedLossAccountCode: "7010",
          balances,
        }),
      );
    await expect(revalue([{ accountCode: "1100", closingRate: "1.62" }])).rejects.toThrow(/holds documents in several currencies. Say which currency to revalue/);
    await expect(revalue([{ accountCode: "1100", currencyCode: "USD", foreignAmount: "2000.00", closingRate: "1.62" }])).rejects.toThrow(
      /the ledger has USD 1900.00 open on 2026-07-31, not 2000.00/,
    );
    await expect(revalue([{ accountCode: "1100", currencyCode: "EUR", closingRate: "1.8" }])).rejects.toThrow(/has nothing open in EUR on 2026-07-31/);
    const { run: fx } = await revalue([
      { accountCode: "1030", closingRate: "1.62" },
      { accountCode: "1100", currencyCode: "USD", closingRate: "1.62" },
      { accountCode: "2000", currencyCode: "USD", closingRate: "1.62" },
    ]);
    expect(fx.items.map((item) => [item.accountCode, item.currencyCode, item.foreignAmount, item.carryingAmount, item.revaluedAmount, item.deltaAmount])).toEqual([
      ["1030", "USD", "1000.00", "1640.00", "1620.00", "-20.00"],
      ["1100", "USD", "1900.00", "3040.00", "3078.00", "38.00"],
      ["2000", "USD", "50.00", "83.00", "81.00", "-2.00"],
    ]);
    expect(await posted(fx.revaluationJournalId)).toEqual([
      ["1030", "0.00", "20.00", "USD 0.00 revaluation"],
      ["7010", "20.00", "0.00"],
      ["1100", "38.00", "0.00", "USD 0.00 revaluation"],
      ["7000", "0.00", "38.00"],
      ["2000", "2.00", "0.00", "USD 0.00 revaluation"],
      ["7000", "0.00", "2.00"],
    ]);
    expect((await run((tx) => getJournal(tx, fx.reversalJournalId))).postingDate).toBe("2026-08-01");
    expect((await checks()).status).toBe("pass");
    await expect(revalue([{ accountCode: "1100", currencyCode: "USD", closingRate: "1.63" }])).rejects.toThrow(/1100 \(USD\) already revalued on 2026-07-31/);
  });

  it("MC9: aged receivables and payables show the document currency and NZD; they tie to the ledger with the revaluation", async () => {
    const receivables = await run((tx) => agedReceivables(tx, { asAt: "2026-07-31" }));
    const acmeRow = receivables.rows.find((row) => row.contactId === acme.id)!;
    expect(acmeRow.foreign).toEqual({ currencyCode: "USD", total: "1900.00" });
    expect(acmeRow.invoices.map((entry) => [entry.invoiceNumber, entry.currencyCode, entry.amountDue, entry.amountDueBase])).toEqual([["INV-0005", "USD", "1900.00", "3040.00"]]);
    expect(acmeRow.amounts.total).toBe("3040.00");
    // Kobe's NZD invoice (INV-0004, 115.00) is still owed.
    expect(receivables.total.total).toBe("3155.00");
    expect(receivables.revaluation).toBe("38.00");
    const payables = await run((tx) => agedPayables(tx, { asAt: "2026-07-31" }));
    expect(payables.rows[0].bills.map((entry) => [entry.supplierInvoiceNumber, entry.amountDue, entry.amountDueBase])).toEqual([["AWS-7", "50.00", "83.00"]]);
    expect(payables.revaluation).toBe("-2.00");
    expect(payables.payablesAccount).toMatchObject({ balance: "81.00", difference: "0.00" });
    const checklist = await run((tx) => periodChecklist(tx, { periodEnd: "2026-07-31" }));
    expect(checklist.checks.filter((entry) => entry.key === "receivables" || entry.key === "payables").map((entry) => entry.status)).toEqual(["pass", "pass"]);
    // The customer statement is in USD, with the NZD balance beside it.
    const statement = await run((tx) => activityStatement(tx, { contactId: acme.id, from: "2026-07-01", to: "2026-07-31" }));
    expect(statement).toMatchObject({ currencyCode: "USD", baseCurrency: "NZD", opening: "0.00", closing: "1900.00", closingBase: "3040.00" });
    const outstanding = await run((tx) => outstandingStatement(tx, { contactId: acme.id, asAt: "2026-07-31" }));
    expect(outstanding.lines.map((entry) => [entry.number, entry.outstanding, entry.outstandingBase])).toEqual([["INV-0005", "1900.00", "3040.00"]]);
    expect(outstanding).toMatchObject({ balance: "1900.00", balanceBase: "3040.00" });
  });

  it("MC12: paying the USD bill from the USD account at 1.65 after the reversal: realised gain 0.50", async () => {
    const paid = await run((tx) =>
      recordSupplierPayment(tx, bills["AWS-7"], { idempotencyKey: key("pay"), paymentDate: "2026-08-05", amount: "50.00", bankAccountCode: "1030", exchangeRate: "1.65" }),
    );
    expect(await posted(paid.payment.journalId)).toEqual([
      ["2000", "83.00", "0.00", "USD 50.00 carrying_value"],
      ["1030", "0.00", "82.50", "USD 50.00 rate"],
      ["7020", "0.00", "0.50"],
    ]);
  });

  it("MC13: the July GST return counts USD sales at NZD; the trial balance stays in NZD", async () => {
    const gst = await run((tx) => calculateGstReturn(tx, { periodStart: "2026-07-01", periodEnd: "2026-07-31" }));
    // Zero-rated: 1,654.30 + 827.15 + 45.06 + 3,200.00 - 163.00 = 5,563.51; Kobe's 115.00 (100.00 + GST) is standard-rated.
    expect(gst.boxes).toMatchObject({ box5: "5678.51", box6: "5563.51" });
    const tb = await run((tx) => trialBalance(tx, { asAt: "2026-08-31" }));
    expect(tb.balanced).toBe(true);
    const row = (code: string) => tb.rows.find((entry) => entry.code === code);
    // -14.30 - 0.01 + 9.14 - 16.29 + 3.00 - 0.80 + 0.50
    expect(row("7020")).toMatchObject({ debit: "18.76", credit: "0.00" });
    expect(row("7000")).toBeUndefined();
    expect(row("7010")).toBeUndefined();
    expect(row("1100")).toMatchObject({ debit: "3155.00" });
    expect(row("2000")).toBeUndefined();
    expect(row("1030")).toMatchObject({ debit: "1557.50" });
  });
});

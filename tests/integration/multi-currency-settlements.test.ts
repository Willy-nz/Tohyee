import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { type Contact, createContact, updateContact } from "@/lib/contacts/service";
import { refundCreditNote, voidRefund } from "@/lib/credit-notes/refunds";
import { approveCreditNote, createCreditNote, getCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { applyOverpayment, refundOverpayment, removeOverpaymentApplication, voidOverpaymentRefund } from "@/lib/invoices/overpayments";
import { getPayment, recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { approveBill, createBill, getBill } from "@/lib/bills/service";
import { recordPaymentBatch, voidPaymentBatch } from "@/lib/payments/batches";
import { createItem } from "@/lib/items/service";
import { dec, sub, toFixedString } from "@/lib/money/decimal";
import { inventoryValuation } from "@/lib/reports/financial";
import { approvePurchaseOrder, copyPurchaseOrderToBill, createPurchaseOrder } from "@/lib/purchase-orders/service";
import { acceptQuote, createQuote, finaliseQuote } from "@/lib/quotes/service";
import { createRepeatingBill, runRepeatingBills } from "@/lib/repeating/bills";
import { createRepeatingInvoice, getRepeatingInvoice, runRepeatingInvoices } from "@/lib/repeating/service";
import { postFxRevaluation } from "@/lib/ledger/fx-revaluation";
import { getJournal } from "@/lib/ledger/journals";
import { periodChecklist } from "@/lib/ledger/period-close";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { trialBalance } from "@/lib/reports/financial";
import { refundSupplierCreditNote, voidSupplierCreditNoteRefund } from "@/lib/supplier-credit-notes/refunds";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { coreQuery } from "@/lib/db/transactions";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples MC14-MC19 in docs/ACCOUNTING-EXAMPLES.md (foreign-currency
 * overpayments and refunds, not yet approved by Jess), one organisation
 * worked through in order: 1000 Business bank account (NZD), 1030 USD
 * account, 1040 EUR account, 1100, 2000, 4000, 6040 and 7020 realised
 * currency gains and losses; customer Acme Inc (USD) and supplier Amazon Web
 * Services (USD).
 */
describeWithDatabase("multi-currency overpayments and refunds", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const ORG = "mcs-co";
  let acme: Contact;
  let aws: Contact;
  const invoices: Record<string, string> = {};
  let overpaymentId: string;
  let creditNoteId: string;
  const batches: Record<string, string> = {};


  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => as(bookkeeper, work);
  const posted = async (journalId: string) =>
    (await run((tx) => getJournal(tx, journalId))).lines.map((line) => [
      line.accountCode,
      line.debitAmount,
      line.creditAmount,
      ...(line.foreign ? [`${line.foreign.currencyCode} ${line.foreign.amount} ${line.foreign.kind}`] : []),
    ]);
  const reversalOf = async (journalId: string) =>
    (await run((tx) => tx.query<{ id: string }>("select id::text from ledger_journals where related_journal_id = $1", [journalId]))).rows[0].id;
  const invoice = async (name: string, invoiceDate: string, amount: string, exchangeRate: string) => {
    const draft = await run((tx) =>
      createInvoice(
        tx,
        {
          idempotencyKey: key("inv"),
          contactId: acme.id,
          invoiceDate,
          dueDate: "2026-08-20",
          amountsMode: "exclusive",
          lines: [{ description: "Consulting", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "ZERO" }],
          exchangeRate,
        },
        { foreignCurrency: true },
      ),
    );
    const approved = await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") }));
    invoices[name] = approved.invoice.id;
    return approved.invoice;
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("mcs-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("mcs-bookkeeper@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, bookkeeper.id]);
    await as(owner, (tx) => createBankAccount(tx, { code: "1030", name: "USD account", accountType: "bank", currencyCode: "USD" }));
    await as(owner, (tx) => createBankAccount(tx, { code: "1040", name: "EUR account", accountType: "bank", currencyCode: "EUR" }));
    acme = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Acme Inc", isCustomer: true, currencyCode: "USD" }))).contact;
    aws = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Amazon Web Services", isSupplier: true, currencyCode: "USD" })))
      .contact;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("MC14: overpaying a USD invoice leaves USD credit at the payment's rate; the gain is on the invoice part only", async () => {
    const first = await invoice("INV-0001", "2026-07-01", "1000.00", "1.60");
    expect(first.baseTotal).toBe("1600.00");
    expect((await invoice("INV-0002", "2026-07-02", "500.00", "1.70")).baseTotal).toBe("850.00");
    const { payment, invoice: paid } = await run((tx) =>
      recordPayment(tx, first.id, { idempotencyKey: key("pay"), paymentDate: "2026-07-03", amount: "1100.00", bankAccountCode: "1030", exchangeRate: "1.65" }),
    );
    overpaymentId = payment.id;
    expect(payment).toMatchObject({
      invoiceAmount: "1000.00",
      overpaymentAmount: "100.00",
      overpaymentRemaining: "100.00",
      overpaymentStatus: "open",
      exchangeRate: "1.65",
      baseAmount: "1815.00",
      baseCleared: "1600.00",
      baseOverpayment: "165.00",
      overpaymentRemainingBase: "165.00",
      realisedGain: "50.00",
    });
    expect(await posted(payment.journalId)).toEqual([
      ["1030", "1815.00", "0.00", "USD 1100.00 rate"],
      ["1100", "0.00", "1600.00", "USD 1000.00 carrying_value"],
      ["1100", "0.00", "165.00", "USD 100.00 document"],
      ["7020", "0.00", "50.00"],
    ]);
    expect(paid).toMatchObject({ paidStatus: "paid", amountDue: "0.00", amountDueBase: "0.00" });
    // Paying the paid invoice again is all overpayment (as OP4): nothing clears, so no gain; voiding reverses it.
    const again = await run((tx) =>
      recordPayment(tx, first.id, { idempotencyKey: key("pay"), paymentDate: "2026-07-03", amount: "10.00", bankAccountCode: "1000", exchangeRate: "1.65" }),
    );
    expect(again.payment).toMatchObject({ overpaymentAmount: "10.00", baseAmount: "16.50", baseCleared: "0.00", baseOverpayment: "16.50", realisedGain: "0.00" });
    expect(await posted(again.payment.journalId)).toEqual([
      ["1000", "16.50", "0.00"],
      ["1100", "0.00", "16.50", "USD 10.00 document"],
    ]);
    const voided = await run((tx) => voidPayment(tx, first.id, again.payment.id, { idempotencyKey: key("void"), voidDate: "2026-07-03" }));
    expect(await posted(voided.payment.voidJournalId!)).toEqual([
      ["1000", "0.00", "16.50"],
      ["1100", "16.50", "0.00", "USD 10.00 document"],
    ]);
    expect(voided.payment).toMatchObject({ overpaymentRemaining: "0.00", overpaymentRemainingBase: "0.00" });
  });

  it("MC15: applying USD overpayment to another USD invoice clears each at its own rate; the difference is realised", async () => {
    const apply = () =>
      run((tx) =>
        applyOverpayment(tx, overpaymentId, { idempotencyKey: key("apply"), applicationDate: "2026-07-10", applications: [{ invoiceId: invoices["INV-0002"], amount: "60.00" }] }),
      );
    const applied = await apply();
    expect(applied.applications[0]).toMatchObject({ amount: "60.00", overpaymentBase: "99.00", invoiceBase: "102.00", realisedGain: "-3.00" });
    expect(await posted(applied.applications[0].journalId!)).toEqual([
      ["1100", "99.00", "0.00", "USD 60.00 carrying_value"],
      ["1100", "0.00", "102.00", "USD 60.00 carrying_value"],
      ["7020", "3.00", "0.00"],
    ]);
    expect(applied.payment).toMatchObject({ overpaymentRemaining: "40.00", overpaymentRemainingBase: "66.00", overpaymentStatus: "part_used" });
    expect(await run((tx) => getInvoice(tx, invoices["INV-0002"]))).toMatchObject({ amountDue: "440.00", amountDueBase: "748.00" });
    // Removing it posts the exact reversal; applied again, the same.
    const removed = await run((tx) =>
      removeOverpaymentApplication(tx, overpaymentId, applied.applications[0].id, { idempotencyKey: key("remove"), removalDate: "2026-07-10" }),
    );
    expect(removed.payment).toMatchObject({ overpaymentRemaining: "100.00", overpaymentRemainingBase: "165.00" });
    expect(await posted(await reversalOf(applied.applications[0].journalId!))).toEqual([
      ["1100", "0.00", "99.00", "USD 60.00 carrying_value"],
      ["1100", "102.00", "0.00", "USD 60.00 carrying_value"],
      ["7020", "0.00", "3.00"],
    ]);
    expect((await apply()).applications[0].realisedGain).toBe("-3.00");
  });

  it("MC16: refunding the USD overpayment at the refund's own rate realises the difference from its carrying value", async () => {
    const refund = (amount: string, bankAccountCode: string, refundDate = "2026-07-20") =>
      run((tx) => refundOverpayment(tx, overpaymentId, { idempotencyKey: key("refund"), refundDate, amount, bankAccountCode, exchangeRate: "1.62" }));
    await expect(refund("40.01", "1000")).rejects.toThrow(/more than the overpayment left \(40.00\)/);
    await expect(refund("40.00", "1040")).rejects.toThrow(/Account 1040 \(EUR account\) is in EUR, but this overpayment is in USD/);
    const first = await refund("40.00", "1000");
    expect(first.refund).toMatchObject({ amount: "40.00", exchangeRate: "1.62", baseAmount: "64.80", baseCleared: "66.00", realisedGain: "1.20" });
    expect(await posted(first.refund.journalId)).toEqual([
      ["1100", "66.00", "0.00", "USD 40.00 carrying_value"],
      ["1000", "0.00", "64.80"],
      ["7020", "0.00", "1.20"],
    ]);
    expect(first.payment).toMatchObject({ overpaymentRemaining: "0.00", overpaymentRemainingBase: "0.00", overpaymentStatus: "used" });
    // Voiding posts the exact reversal; refunded again from the USD account, the bank line carries the USD.
    const voided = await run((tx) => voidOverpaymentRefund(tx, overpaymentId, first.refund.id, { idempotencyKey: key("void"), voidDate: "2026-07-21" }));
    expect(await posted(voided.refund.voidJournalId!)).toEqual([
      ["1100", "0.00", "66.00", "USD 40.00 carrying_value"],
      ["1000", "64.80", "0.00"],
      ["7020", "1.20", "0.00"],
    ]);
    expect(voided.payment).toMatchObject({ overpaymentRemaining: "40.00", overpaymentRemainingBase: "66.00" });
    const second = await refund("40.00", "1030", "2026-07-21");
    expect(await posted(second.refund.journalId)).toEqual([
      ["1100", "66.00", "0.00", "USD 40.00 carrying_value"],
      ["1030", "0.00", "64.80", "USD 40.00 rate"],
      ["7020", "0.00", "1.20"],
    ]);
    // The payment can't be voided while its overpayment is used (OP8).
    await expect(run((tx) => voidPayment(tx, invoices["INV-0001"], overpaymentId, { idempotencyKey: key("void"), voidDate: "2026-07-22" }))).rejects.toThrow(
      /overpayment has been applied or refunded/,
    );
    expect((await run((tx) => getPayment(tx, overpaymentId))).overpaymentRemaining).toBe("0.00");
  });

  it("MC17: refunding a USD credit note: the bank moves at the refund's rate, the credit clears at its own", async () => {
    const draft = await run((tx) =>
      createCreditNote(tx, {
        idempotencyKey: key("cn"),
        contactId: acme.id,
        creditNoteDate: "2026-07-05",
        amountsMode: "exclusive",
        lines: [{ description: "Discount", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "ZERO" }],
        exchangeRate: "1.63",
      }),
    );
    creditNoteId = (await run((tx) => approveCreditNote(tx, draft.creditNote.id, { idempotencyKey: key("approve") }))).creditNote.id;
    const refund = (refundDate: string) =>
      run((tx) => refundCreditNote(tx, creditNoteId, { idempotencyKey: key("refund"), refundDate, amount: "30.00", bankAccountCode: "1030", exchangeRate: "1.60" }));
    const first = await refund("2026-07-15");
    expect(first.refund).toMatchObject({ exchangeRate: "1.6", baseAmount: "48.00", baseCleared: "48.90", realisedGain: "0.90" });
    expect(await posted(first.refund.journalId)).toEqual([
      ["1100", "48.90", "0.00", "USD 30.00 carrying_value"],
      ["1030", "0.00", "48.00", "USD 30.00 rate"],
      ["7020", "0.00", "0.90"],
    ]);
    expect(first.creditNote).toMatchObject({ remainingCredit: "70.00", remainingCreditBase: "114.10", creditStatus: "part_used" });
    const voided = await run((tx) => voidRefund(tx, creditNoteId, first.refund.id, { idempotencyKey: key("void"), voidDate: "2026-07-16" }));
    expect(await posted(voided.refund.voidJournalId!)).toEqual([
      ["1100", "0.00", "48.90", "USD 30.00 carrying_value"],
      ["1030", "48.00", "0.00", "USD 30.00 rate"],
      ["7020", "0.90", "0.00"],
    ]);
    expect(voided.creditNote).toMatchObject({ remainingCredit: "100.00", remainingCreditBase: "163.00" });
    expect((await refund("2026-07-16")).refund.realisedGain).toBe("0.90");
    expect(await run((tx) => getCreditNote(tx, creditNoteId))).toMatchObject({ remainingCredit: "70.00", remainingCreditBase: "114.10" });
  });

  it("MC18: a USD refund received for a supplier credit note: a loss when it comes back at a lower rate", async () => {
    const draft = await run((tx) =>
      createSupplierCreditNote(tx, {
        idempotencyKey: key("scn"),
        contactId: aws.id,
        creditNoteDate: "2026-07-05",
        supplierCreditNoteNumber: "AWS-CR1",
        amountsMode: "no_tax",
        lines: [{ description: "Credit", quantity: "1", unitPrice: "20.00", accountCode: "6040" }],
        exchangeRate: "1.70",
      }),
    );
    const credit = (await run((tx) => approveSupplierCreditNote(tx, draft.creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    const refund = () =>
      run((tx) =>
        refundSupplierCreditNote(tx, credit.id, { idempotencyKey: key("refund"), refundDate: "2026-07-12", amount: "20.00", bankAccountCode: "1030", exchangeRate: "1.66" }),
      );
    const first = await refund();
    expect(first.refund).toMatchObject({ baseAmount: "33.20", baseCleared: "34.00", realisedGain: "-0.80" });
    expect(await posted(first.refund.journalId)).toEqual([
      ["1030", "33.20", "0.00", "USD 20.00 rate"],
      ["2000", "0.00", "34.00", "USD 20.00 carrying_value"],
      ["7020", "0.80", "0.00"],
    ]);
    expect(first.creditNote).toMatchObject({ remainingCredit: "0.00", remainingCreditBase: "0.00" });
    const voided = await run((tx) => voidSupplierCreditNoteRefund(tx, credit.id, first.refund.id, { idempotencyKey: key("void"), voidDate: "2026-07-12" }));
    expect(await posted(voided.refund.voidJournalId!)).toEqual([
      ["1030", "0.00", "33.20", "USD 20.00 rate"],
      ["2000", "34.00", "0.00", "USD 20.00 carrying_value"],
      ["7020", "0.00", "0.80"],
    ]);
    expect(voided.creditNote).toMatchObject({ remainingCredit: "20.00", remainingCreditBase: "34.00" });
    expect((await refund()).refund.realisedGain).toBe("-0.80");
  });

  it("MC19: open USD credit ties to the ledger: aged receivables, revaluation and the trial balance", async () => {
    const receivables = await run((tx) => agedReceivables(tx, { asAt: "2026-07-31" }));
    const acmeRow = receivables.rows.find((row) => row.contactId === acme.id)!;
    expect(acmeRow.invoices.map((entry) => [entry.invoiceNumber, entry.amountDue, entry.amountDueBase])).toEqual([["INV-0002", "440.00", "748.00"]]);
    // INV-0002 748.00 less CN-0001's unused USD 70.00 = NZD 114.10.
    expect(acmeRow.foreign).toEqual({ currencyCode: "USD", total: "370.00" });
    expect(receivables.total.total).toBe("633.90");
    const tb = async () => {
      const rows = (await run((tx) => trialBalance(tx, { asAt: "2026-07-31" }))).rows;
      return (code: string) => rows.find((entry) => entry.code === code);
    };
    const before = await tb();
    expect(before("1100")).toMatchObject({ debit: "633.90" });
    expect(before("2000")).toBeUndefined();
    // 50.00 - 3.00 + 1.20 + 0.90 - 0.80
    expect(before("7020")).toMatchObject({ credit: "48.30" });
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
        balances: [{ accountCode: "1100", currencyCode: "USD", closingRate: "1.60" }],
      }),
    );
    expect(fx.items.map((item) => [item.accountCode, item.foreignAmount, item.carryingAmount, item.revaluedAmount, item.deltaAmount])).toEqual([
      ["1100", "370.00", "633.90", "592.00", "-41.90"],
    ]);
    // One by one (MC39): INV-0002 (1.60 - 1.70) x 440.00 = -44.00; CN-0001 (1.60 - 1.63) x -70.00 = +2.10.
    expect(fx.items[0].documents.map((doc) => [doc.kind, doc.documentNumber, doc.foreignAmount, doc.carryingAmount, doc.deltaAmount])).toEqual([
      ["invoice", "INV-0002", "440.00", "748.00", "-44.00"],
      ["credit_note", "CN-0001", "-70.00", "-114.10", "2.10"],
    ]);
    expect(await posted(fx.revaluationJournalId)).toEqual([
      ["1100", "0.00", "44.00", "USD 0.00 revaluation"],
      ["7010", "44.00", "0.00"],
      ["1100", "2.10", "0.00", "USD 0.00 revaluation"],
      ["7000", "0.00", "2.10"],
    ]);
    expect((await run((tx) => agedReceivables(tx, { asAt: "2026-07-31" }))).revaluation).toBe("-41.90");
    const checks = (await run((tx) => periodChecklist(tx, { periodEnd: "2026-07-31" }))).checks;
    expect(checks.filter((entry) => entry.key === "receivables" || entry.key === "payables").map((entry) => entry.status)).toEqual(["pass", "pass"]);
  });

  const batch = (kind: "customer" | "supplier", paymentDate: string, amount: string, bankAccountCode: string, documents: Array<{ id: string; amount: string }>, exchangeRate?: string) =>
    run((tx) => recordPaymentBatch(tx, kind, { idempotencyKey: key("batch"), paymentDate, amount, bankAccountCode, documents, exchangeRate }));

  it("MC20: one USD payment for two USD invoices: one bank line, each invoice's own gain; the rounding cent goes to 7050", async () => {
    const third = await invoice("INV-0003", "2026-08-03", "100.01", "1.60");
    const fourth = await invoice("INV-0004", "2026-08-04", "100.01", "1.62");
    expect([third.baseTotal, fourth.baseTotal]).toEqual(["160.02", "162.02"]);
    const { batch: paid } = await batch("customer", "2026-08-10", "200.02", "1000", [
      { id: third.id, amount: "100.01" },
      { id: fourth.id, amount: "100.01" },
    ], "1.65");
    // 200.02 x 1.65 = 330.033 -> 330.03 in the bank; 100.01 x 1.65 = 165.0165 -> 165.02 for the first, the other 165.01 for the last.
    expect(paid).toMatchObject({ currencyCode: "USD", amount: "200.02", exchangeRate: "1.65", baseAmount: "330.03" });
    // Each gain is (1.65 - its rate) x 100.01, rounded: 5.00 and 3.00; the last part's cent short is rounding (MC31).
    expect(paid.parts.map((part) => [part.documentNumber, part.amount, part.baseAmount, part.baseCleared, part.realisedGain, part.roundingGain])).toEqual([
      ["INV-0003", "100.01", "165.02", "160.02", "5.00", "0.00"],
      ["INV-0004", "100.01", "165.01", "162.02", "3.00", "-0.01"],
    ]);
    expect(await posted(paid.journalId)).toEqual([
      ["1000", "330.03", "0.00"],
      ["1100", "0.00", "160.02", "USD 100.01 carrying_value"],
      ["7020", "0.00", "5.00"],
      ["1100", "0.00", "162.02", "USD 100.01 carrying_value"],
      ["7020", "0.00", "3.00"],
      ["7050", "0.01", "0.00"],
    ]);
    for (const id of [third.id, fourth.id]) {
      expect(await run((tx) => getInvoice(tx, id))).toMatchObject({ paidStatus: "paid", amountDue: "0.00", amountDueBase: "0.00" });
    }
  });

  it("MC21: a USD payment for several invoices can overpay them when all are paid in full; the extra is USD credit on the last", async () => {
    const fifth = await invoice("INV-0005", "2026-08-05", "50.00", "1.60");
    const sixth = await invoice("INV-0006", "2026-08-05", "50.00", "1.60");
    const documents = [
      { id: fifth.id, amount: "50.00" },
      { id: sixth.id, amount: "50.00" },
    ];
    await expect(batch("customer", "2026-08-12", "110.00", "1030", [{ id: fifth.id, amount: "40.00" }, documents[1]], "1.70")).rejects.toThrow(
      /Pay every invoice in full before keeping the extra as an overpayment/,
    );
    const { batch: paid } = await batch("customer", "2026-08-12", "110.00", "1030", documents, "1.70");
    expect(paid).toMatchObject({ baseAmount: "187.00", overpaymentAmount: "10.00" });
    expect(paid.parts.map((part) => [part.documentNumber, part.amount, part.overpaymentAmount, part.baseAmount, part.baseCleared, part.realisedGain])).toEqual([
      ["INV-0005", "50.00", "0.00", "85.00", "80.00", "5.00"],
      ["INV-0006", "60.00", "10.00", "102.00", "80.00", "5.00"],
    ]);
    expect(await posted(paid.journalId)).toEqual([
      ["1030", "187.00", "0.00", "USD 110.00 rate"],
      ["1100", "0.00", "80.00", "USD 50.00 carrying_value"],
      ["7020", "0.00", "5.00"],
      ["1100", "0.00", "80.00", "USD 50.00 carrying_value"],
      ["1100", "0.00", "17.00", "USD 10.00 document"],
      ["7020", "0.00", "5.00"],
    ]);
    const overpayment = await run((tx) => getPayment(tx, paid.parts[1].paymentId));
    expect(overpayment).toMatchObject({ overpaymentRemaining: "10.00", baseOverpayment: "17.00", overpaymentRemainingBase: "17.00" });
    batches.mc21 = paid.id;
  });

  it("MC22: one USD payment to AWS for two USD bills from the USD account: each bill's own gain", async () => {
    const bill = async (number: string, billDate: string, amount: string, exchangeRate: string) => {
      const draft = await run((tx) =>
        createBill(
          tx,
          {
            idempotencyKey: key("bill"),
            contactId: aws.id,
            billDate,
            dueDate: "2026-08-31",
            supplierInvoiceNumber: number,
            amountsMode: "no_tax",
            lines: [{ description: "Hosting", quantity: "1", unitPrice: amount, accountCode: "6040" }],
            exchangeRate,
          },
          null,
          { foreignCurrency: true },
        ),
      );
      return (await run((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("approve") }))).bill;
    };
    const first = await bill("AWS-1", "2026-08-01", "50.00", "1.66");
    const second = await bill("AWS-2", "2026-08-02", "30.00", "1.70");
    expect([first.baseTotal, second.baseTotal]).toEqual(["83.00", "51.00"]);
    const documents = [
      { id: first.id, amount: "50.00" },
      { id: second.id, amount: "30.00" },
    ];
    await expect(batch("supplier", "2026-08-15", "80.01", "1030", documents, "1.60")).rejects.toThrow(/Payments to suppliers can't be more than their bills' amounts due/);
    await expect(batch("supplier", "2026-08-15", "80.00", "1040", documents, "1.60")).rejects.toThrow(/Account 1040 \(EUR account\) is in EUR, but this bill is in USD/);
    const { batch: paid } = await batch("supplier", "2026-08-15", "80.00", "1030", documents, "1.60");
    expect(paid.parts.map((part) => [part.documentNumber, part.baseAmount, part.baseCleared, part.realisedGain])).toEqual([
      ["AWS-1", "80.00", "83.00", "3.00"],
      ["AWS-2", "48.00", "51.00", "3.00"],
    ]);
    expect(await posted(paid.journalId)).toEqual([
      ["2000", "83.00", "0.00", "USD 50.00 carrying_value"],
      ["7020", "0.00", "3.00"],
      ["2000", "51.00", "0.00", "USD 30.00 carrying_value"],
      ["7020", "0.00", "3.00"],
      ["1030", "0.00", "128.00", "USD 80.00 rate"],
    ]);
    expect(await run((tx) => getBill(tx, second.id))).toMatchObject({ paidStatus: "paid", amountDueBase: "0.00" });
  });

  it("MC23: one payment is in one currency, and a base-currency one has no rate", async () => {
    const kobe = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Kobe Ltd", isCustomer: true }))).contact;
    const draft = await run((tx) =>
      createInvoice(tx, {
        idempotencyKey: key("inv"),
        contactId: kobe.id,
        invoiceDate: "2026-08-05",
        dueDate: "2026-08-20",
        amountsMode: "no_tax",
        lines: [{ description: "Walks", quantity: "1", unitPrice: "80.00", accountCode: "4000" }],
      }),
    );
    const nzd = (await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") }))).invoice;
    await expect(batch("customer", "2026-08-12", "80.00", "1000", [{ id: nzd.id, amount: "80.00" }], "1.65")).rejects.toThrow(
      /These invoices are in NZD, so the payment has no exchange rate/,
    );
    await expect(batch("customer", "2026-08-12", "80.00", "1030", [{ id: nzd.id, amount: "80.00" }])).rejects.toThrow(/Account 1030 \(USD account\) is in USD/);
    // A USD invoice with an NZD one: they're different customers (a contact has one currency), refused as MP4.
    const fresh = await invoice("INV-0007", "2026-08-06", "10.00", "1.60");
    await expect(
      batch("customer", "2026-08-12", "90.00", "1000", [
        { id: fresh.id, amount: "10.00" },
        { id: nzd.id, amount: "80.00" },
      ]),
    ).rejects.toThrow(/One payment can only pay invoices of one customer/);
  });

  it("MC24: voiding a USD payment for several invoices posts its exact reversal, foreign amounts included", async () => {
    const voided = await run((tx) => voidPaymentBatch(tx, "customer", batches.mc21, { idempotencyKey: key("void"), voidDate: "2026-08-13" }));
    expect(await posted(voided.batch.voidJournalId!)).toEqual([
      ["1030", "0.00", "187.00", "USD 110.00 rate"],
      ["1100", "80.00", "0.00", "USD 50.00 carrying_value"],
      ["7020", "5.00", "0.00"],
      ["1100", "80.00", "0.00", "USD 50.00 carrying_value"],
      ["1100", "17.00", "0.00", "USD 10.00 document"],
      ["7020", "5.00", "0.00"],
    ]);
    expect(await run((tx) => getInvoice(tx, invoices["INV-0006"]))).toMatchObject({ amountDue: "50.00", amountDueBase: "80.00" });
  });

  const journalCount = async () => Number((await run((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
  const zeroLine = (description: string, unitPrice: string) => ({ description, quantity: "1", unitPrice, accountCode: "4000", taxCode: "ZERO" });

  it("MC25: a USD quote is in USD with no rate and posts nothing; accepting it makes a USD invoice at a rate for its date", async () => {
    // A USD quote with GST (revised 1 Oct 2026) is MC79; this one is zero-rated.
    const before = await journalCount();
    const draft = await run((tx) =>
      createQuote(tx, { idempotencyKey: key("quote"), contactId: acme.id, quoteDate: "2026-08-20", expiryDate: "2026-09-20", amountsMode: "exclusive", lines: [zeroLine("Design", "400.00")] }),
    );
    expect(draft.quote).toMatchObject({ currencyCode: "USD", total: "400.00" });
    const finalised = await run((tx) => finaliseQuote(tx, draft.quote.id, { idempotencyKey: key("fin") }));
    expect(finalised.quote.quoteNumber).toBe("QU-0001");
    expect(await journalCount()).toBe(before);
    // No rate typed: the invoice takes the last USD rate used on or before 25 Aug (MC22's payment, 1.60).
    const accepted = await run((tx) => acceptQuote(tx, draft.quote.id, { idempotencyKey: key("accept"), invoiceDate: "2026-08-25", dueDate: "2026-09-25" }));
    expect(accepted.invoice).toMatchObject({ status: "draft", currencyCode: "USD", total: "400.00", exchangeRate: "1.6", baseTotal: "640.00" });
    expect(await journalCount()).toBe(before);
    const approved = (await run((tx) => approveInvoice(tx, accepted.invoice.id, { idempotencyKey: key("approve") }))).invoice;
    expect(await posted(approved.approvalJournalId!)).toEqual([
      ["1100", "640.00", "0.00", "USD 400.00 document"],
      ["4000", "0.00", "640.00"],
    ]);
    // A rate typed when accepting is used instead.
    const second = await run((tx) =>
      createQuote(tx, { idempotencyKey: key("quote"), contactId: acme.id, quoteDate: "2026-08-20", amountsMode: "exclusive", lines: [zeroLine("Extra", "10.00")] }),
    );
    await run((tx) => finaliseQuote(tx, second.quote.id, { idempotencyKey: key("fin") }));
    const typed = await run((tx) => acceptQuote(tx, second.quote.id, { idempotencyKey: key("accept"), invoiceDate: "2026-08-26", dueDate: "2026-09-25", exchangeRate: "1.58" }));
    expect(typed.invoice).toMatchObject({ exchangeRate: "1.58", baseTotal: "15.80" });
  });

  it("MC26: a USD repeating invoice makes USD invoices at a rate for their date; with no rate in the exchange rates list, left as drafts", async () => {
    const template = (saveAs: string) =>
      run((tx) =>
        createRepeatingInvoice(tx, {
          idempotencyKey: key("ri"),
          contactId: acme.id,
          amountsMode: "exclusive",
          lines: [zeroLine("Retainer", "100.00")],
          period: "month",
          every: 1,
          startDate: "2026-08-31",
          dueRule: "days_after",
          dueDays: 20,
          saveAs,
        }),
      );
    // Saved as "approve" (MC52); the list has no USD rate, so the invoice is left as a draft, saying why.
    const { repeatingInvoice } = await template("approve");
    expect(repeatingInvoice).toMatchObject({ currencyCode: "USD", total: "100.00", saveAs: "approve" });
    const before = await journalCount();
    const result = await inOrganisation(ORG, { userId: null, email: "repeating-invoices@tohyee" }, (tx) =>
      runRepeatingInvoices(tx, { today: "2026-08-31", repeatingInvoiceId: repeatingInvoice.id }),
    );
    expect(result).toEqual({ made: 1, approved: 0, refused: 1, failed: 0 });
    expect((await run((tx) => getRepeatingInvoice(tx, repeatingInvoice.id))).runs[0].message).toMatch(
      /^Left as a draft: The exchange rates list has no USD rate effective on or before 2026-08-31, so this invoice took the last USD rate used \(1\.6\)/,
    );
    const made = (await run((tx) => tx.query<{ id: string }>("select invoice_id::text as id from repeating_invoice_runs where repeating_invoice_id = $1", [repeatingInvoice.id])))
      .rows[0].id;
    // The last USD rate used on or before 31 Aug is 1.60 (MC25's approved invoice; the 1.58 one is still a draft, which posts nothing).
    expect(await run((tx) => getInvoice(tx, made))).toMatchObject({ status: "draft", invoiceDate: "2026-08-31", currencyCode: "USD", exchangeRate: "1.6", baseTotal: "160.00" });
    expect(await journalCount()).toBe(before);
  });

  it("MC27: a USD repeating bill makes USD bills at a rate for their date; with no rate in the list, left as drafts", async () => {
    const template = (saveAs: string) =>
      run((tx) =>
        createRepeatingBill(tx, {
          idempotencyKey: key("rb"),
          contactId: aws.id,
          supplierInvoiceNumber: "AWS-{month}",
          amountsMode: "no_tax",
          lines: [{ description: "Hosting", quantity: "1", unitPrice: "40.00", accountCode: "6040" }],
          period: "month",
          every: 1,
          startDate: "2026-08-31",
          dueRule: "days_after",
          dueDays: 14,
          saveAs,
        }),
      );
    const { repeatingBill } = await template("approve");
    expect(repeatingBill.currencyCode).toBe("USD");
    const result = await inOrganisation(ORG, { userId: null, email: "repeating-bills@tohyee" }, (tx) =>
      runRepeatingBills(tx, { today: "2026-08-31", repeatingBillId: repeatingBill.id }),
    );
    expect(result).toEqual({ made: 1, approved: 0, refused: 1, failed: 0 });
    const made = (await run((tx) => tx.query<{ id: string }>("select bill_id::text as id from repeating_bill_runs where repeating_bill_id = $1", [repeatingBill.id]))).rows[0].id;
    expect(await run((tx) => getBill(tx, made))).toMatchObject({ status: "draft", billDate: "2026-08-31", currencyCode: "USD", exchangeRate: "1.6", baseTotal: "64.00" });
  });

  it("MC28: a USD purchase order is in USD with no rate; the bill copied from it takes the bill date's rate", async () => {
    const before = await journalCount();
    const draft = await run((tx) =>
      createPurchaseOrder(tx, {
        idempotencyKey: key("po"),
        contactId: aws.id,
        orderDate: "2026-08-20",
        deliveryDate: "2026-08-25",
        amountsMode: "no_tax",
        lines: [{ description: "Reserved instances", quantity: "3", unitPrice: "20.00", accountCode: "6040" }],
      }),
    );
    expect(draft.purchaseOrder).toMatchObject({ currencyCode: "USD", total: "60.00" });
    const approved = (await run((tx) => approvePurchaseOrder(tx, draft.purchaseOrder.id, { idempotencyKey: key("appr") }))).purchaseOrder;
    expect(await journalCount()).toBe(before);
    const copied = await run((tx) =>
      copyPurchaseOrderToBill(tx, approved.id, { idempotencyKey: key("copy"), billDate: "2026-08-28", dueDate: "2026-09-28", supplierInvoiceNumber: "AWS-PO1", exchangeRate: "1.55" }),
    );
    expect(copied.bill).toMatchObject({ status: "draft", currencyCode: "USD", total: "60.00", exchangeRate: "1.55", baseTotal: "93.00" });
    const bill = (await run((tx) => approveBill(tx, copied.bill.id, { idempotencyKey: key("approve") }))).bill;
    expect(await posted(bill.approvalJournalId!)).toEqual([
      ["6040", "93.00", "0.00"],
      ["2000", "0.00", "93.00", "USD 60.00 document"],
    ]);
    // Its currency is fixed now it has documents (MC1): the database refuses a change too.
    await expect(run((tx) => updateContact(tx, aws.id, { currencyCode: "EUR" }))).rejects.toThrow(/currency can't change/);
  });

  it("MC29: stock on USD documents is valued in NZD at the document's rate; stock still equals 1400", async () => {
    const widget = (
      await run((tx) =>
        createItem(tx, {
          idempotencyKey: key("item"),
          code: "WIDGET",
          name: "Widget",
          itemType: "stock",
          salePrice: "12.00",
          purchasePrice: "5.00",
          incomeAccountCode: "4000",
          salesTaxCode: "GST",
          purchaseAccountCode: "1400",
          purchaseTaxCode: "GST",
        }),
      )
    ).item;
    const paw = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Paw Supplies", isSupplier: true }))).contact;
    const stockBill = async (contactId: string, number: string, quantity: string, unitPrice: string, exchangeRate?: string) => {
      const draft = await run((tx) =>
        createBill(
          tx,
          {
            idempotencyKey: key("bill"),
            contactId,
            billDate: "2026-09-01",
            dueDate: "2026-09-30",
            supplierInvoiceNumber: number,
            amountsMode: "no_tax",
            lines: [{ itemId: widget.id, quantity, unitPrice }],
            ...(exchangeRate ? { exchangeRate } : {}),
          },
          null,
          { foreignCurrency: true },
        ),
      );
      return (await run((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("approve") }))).bill;
    };
    const stock = async () => {
      const report = await run((tx) => inventoryValuation(tx));
      const tb = (await run((tx) => trialBalance(tx, { asAt: "2026-12-31" }))).rows.find((row) => row.code === "1400");
      expect(report.inventoryAccountBalance).toBe(report.totalValue);
      expect(tb ? toFixedString(sub(dec(tb.debit), dec(tb.credit)), 2) : "0.00").toBe(report.totalValue);
      const row = report.items.find((entry) => entry.itemCode === "WIDGET")!;
      return [row.quantity, row.value];
    };
    // A USD bill: 10 @ USD 5.00 at 1.60 = NZD 80.00 into stock.
    const usdBill = await stockBill(aws.id, "AWS-STK", "10", "5.00", "1.60");
    expect(await posted(usdBill.approvalJournalId!)).toEqual([
      ["1400", "80.00", "0.00"],
      ["2000", "0.00", "80.00", "USD 50.00 document"],
    ]);
    expect(await stock()).toEqual(["10", "80.00"]);
    // An NZD bill: 10 @ 10.00. The average is (80.00 + 100.00) / 20 = 9.00 NZD.
    await stockBill(paw.id, "PAW-1", "10", "10.00");
    expect(await stock()).toEqual(["20", "180.00"]);
    // A USD invoice for 4: cost of sales is the NZD weighted average, 4 x 9.00 = 36.00.
    const draft = await run((tx) =>
      createInvoice(
        tx,
        {
          idempotencyKey: key("inv"),
          contactId: acme.id,
          invoiceDate: "2026-09-05",
          dueDate: "2026-09-30",
          amountsMode: "no_tax",
          lines: [{ itemId: widget.id, quantity: "4", unitPrice: "20.00" }],
          exchangeRate: "1.60",
        },
        { foreignCurrency: true },
      ),
    );
    const sold = (await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") }))).invoice;
    expect(await posted(sold.approvalJournalId!)).toEqual([
      ["1100", "128.00", "0.00", "USD 80.00 document"],
      ["4000", "0.00", "128.00"],
      ["5000", "36.00", "0.00"],
      ["1400", "0.00", "36.00"],
    ]);
    expect(await stock()).toEqual(["16", "144.00"]);
    // A USD credit note returning 1 of them: back at the sale's cost, 9.00.
    const credit = await run((tx) =>
      createCreditNote(tx, {
        idempotencyKey: key("cn"),
        contactId: acme.id,
        creditNoteDate: "2026-09-06",
        amountsMode: "no_tax",
        lines: [{ itemId: widget.id, quantity: "1", unitPrice: "20.00" }],
        exchangeRate: "1.60",
        returnInvoiceId: sold.id,
      }),
    );
    const returned = (await run((tx) => approveCreditNote(tx, credit.creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    expect(await posted(returned.approvalJournalId!)).toEqual([
      ["4000", "32.00", "0.00"],
      ["1100", "0.00", "32.00", "USD 20.00 document"],
      ["1400", "9.00", "0.00"],
      ["5000", "0.00", "9.00"],
    ]);
    expect(await stock()).toEqual(["17", "153.00"]);
    // A USD supplier credit note returning 2 to AWS at 1.62: 1400 is credited NZD 16.20, the stock leaves at
    // its average 18.00, and the difference goes to cost of sales.
    const scn = await run((tx) =>
      createSupplierCreditNote(tx, {
        idempotencyKey: key("scn"),
        contactId: aws.id,
        creditNoteDate: "2026-09-07",
        supplierCreditNoteNumber: "AWS-RET1",
        amountsMode: "no_tax",
        lines: [{ itemId: widget.id, quantity: "2", unitPrice: "5.00" }],
        exchangeRate: "1.62",
      }),
    );
    const back = (await run((tx) => approveSupplierCreditNote(tx, scn.creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    expect(await posted(back.approvalJournalId!)).toEqual([
      ["2000", "16.20", "0.00", "USD 10.00 document"],
      ["1400", "0.00", "16.20"],
      ["5000", "1.80", "0.00"],
      ["1400", "0.00", "1.80"],
    ]);
    expect(await stock()).toEqual(["15", "135.00"]);
    // A typed price is still needed: item prices are NZD (MC11).
    await expect(
      run((tx) =>
        createInvoice(
          tx,
          { idempotencyKey: key("inv"), contactId: acme.id, invoiceDate: "2026-09-08", dueDate: "2026-09-30", amountsMode: "no_tax", lines: [{ itemId: widget.id, quantity: "1" }], exchangeRate: "1.60" },
          { foreignCurrency: true },
        ),
      ),
    ).rejects.toThrow(/item prices are in NZD, so type the unit price in USD/);
  });

  it("MC30: a bank account in a third currency (EUR) can't pay or refund USD documents, as in NetSuite", async () => {
    const before = await journalCount();
    const bill = (await run((tx) => tx.query<{ id: string }>("select id::text from bills where supplier_invoice_number = 'AWS-STK'"))).rows[0].id;
    const third = /Account 1040 \(EUR account\) is in EUR, but this (bill|invoice|credit note) is in USD\. Like NetSuite, money for a USD \1 moves in USD, through a USD or NZD bank account/;
    await expect(
      run((tx) => recordSupplierPayment(tx, bill, { idempotencyKey: key("pay"), paymentDate: "2026-09-10", amount: "50.00", bankAccountCode: "1040", exchangeRate: "1.60" })),
    ).rejects.toThrow(third);
    await expect(
      run((tx) => recordPayment(tx, invoices["INV-0006"], { idempotencyKey: key("pay"), paymentDate: "2026-09-10", amount: "50.00", bankAccountCode: "1040", exchangeRate: "1.60" })),
    ).rejects.toThrow(third);
    await expect(
      run((tx) => refundCreditNote(tx, creditNoteId, { idempotencyKey: key("refund"), refundDate: "2026-09-10", amount: "10.00", bankAccountCode: "1040", exchangeRate: "1.60" })),
    ).rejects.toThrow(third);
    // A EUR statement line can't pay a USD bill either.
    const eur = (await run((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1040'"))).rows[0].id;
    await run((tx) =>
      importStatementFile(tx, eur, { idempotencyKey: key("import"), fileName: "eur.csv", fileBase64: Buffer.from("Date,Amount,Payee\n10/09/2026,-45.00,AMAZON WEB SERVICES\n").toString("base64") }),
    );
    const line = (await run((tx) => listStatementLines(tx, eur, { status: "all" }))).lines[0];
    await expect(
      run((tx) => reconcileStatementLine(tx, line.id, { idempotencyKey: key("rec"), kind: "payments", allocations: [{ billId: bill, amount: "45.00" }], exchangeRate: "1.80" })),
    ).rejects.toThrow(/Account 1040 is in EUR, but this bill is in USD\. Like NetSuite/);
    expect(await journalCount()).toBe(before);
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount } from "@/lib/bank/accounts";
import { type Contact, createContact } from "@/lib/contacts/service";
import { refundCreditNote, voidRefund } from "@/lib/credit-notes/refunds";
import { approveCreditNote, createCreditNote, getCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { applyOverpayment, refundOverpayment, removeOverpaymentApplication, voidOverpaymentRefund } from "@/lib/invoices/overpayments";
import { getPayment, recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
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
    expect((await run((tx) => agedReceivables(tx, { asAt: "2026-07-31" }))).revaluation).toBe("-41.90");
    const checks = (await run((tx) => periodChecklist(tx, { periodEnd: "2026-07-31" }))).checks;
    expect(checks.filter((entry) => entry.key === "receivables" || entry.key === "payables").map((entry) => entry.status)).toEqual(["pass", "pass"]);
  });
});

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount } from "@/lib/bank/accounts";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { applyCreditNote, removeApplication } from "@/lib/credit-notes/applications";
import { refundCreditNote } from "@/lib/credit-notes/refunds";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { applyOverpayment } from "@/lib/invoices/overpayments";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { listFxRevaluations, openCurrencyBalances, postFxRevaluation } from "@/lib/ledger/fx-revaluation";
import { getJournal } from "@/lib/ledger/journals";
import { periodChecklist } from "@/lib/ledger/period-close";
import { recordPaymentBatch } from "@/lib/payments/batches";
import { agedPayables } from "@/lib/reports/aged-payables";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { trialBalance } from "@/lib/reports/financial";
import { applySupplierCreditNote } from "@/lib/supplier-credit-notes/applications";
import { refundSupplierCreditNote } from "@/lib/supplier-credit-notes/refunds";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  startTestServer,
  testDatabaseUrl,
  type TestServer,
  withDb,
} from "../helpers/test-server";

/**
 * Examples MC31-MC43 in docs/ACCOUNTING-EXAMPLES.md (rounding and revaluing
 * each document, following NetSuite; not yet approved by Jess). Two
 * organisations: one for the rounding gains and losses (MC31-MC38), one for
 * revaluing open documents one by one (MC39-MC43).
 */
describeWithDatabase("multi-currency rounding and revaluing each document", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;

  const tools = (org: string) => {
    const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
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
    const contact = async (name: string, fields: Record<string, unknown>) =>
      (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name, currencyCode: "USD", ...fields }))).contact;
    const invoice = async (contactId: string, invoiceDate: string, amounts: string[], exchangeRate: string) => {
      const draft = await run((tx) =>
        createInvoice(
          tx,
          {
            idempotencyKey: key("inv"),
            contactId,
            invoiceDate,
            dueDate: "2026-08-20",
            amountsMode: "exclusive",
            lines: amounts.map((amount) => ({ description: "Consulting", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "ZERO" })),
            exchangeRate,
          },
          { foreignCurrency: true },
        ),
      );
      return (await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") }))).invoice;
    };
    const creditNote = async (contactId: string, creditNoteDate: string, amount: string, exchangeRate: string) => {
      const draft = await run((tx) =>
        createCreditNote(tx, {
          idempotencyKey: key("cn"),
          contactId,
          creditNoteDate,
          amountsMode: "exclusive",
          lines: [{ description: "Discount", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "ZERO" }],
          exchangeRate,
        }),
      );
      return (await run((tx) => approveCreditNote(tx, draft.creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    };
    const bill = async (contactId: string, number: string, billDate: string, amount: string, exchangeRate: string) => {
      const draft = await run((tx) =>
        createBill(
          tx,
          {
            idempotencyKey: key("bill"),
            contactId,
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
    const supplierCredit = async (contactId: string, number: string, creditNoteDate: string, amount: string, exchangeRate: string) => {
      const draft = await run((tx) =>
        createSupplierCreditNote(tx, {
          idempotencyKey: key("scn"),
          contactId,
          creditNoteDate,
          supplierCreditNoteNumber: number,
          amountsMode: "no_tax",
          lines: [{ description: "Credit", quantity: "1", unitPrice: amount, accountCode: "6040" }],
          exchangeRate,
        }),
      );
      return (await run((tx) => approveSupplierCreditNote(tx, draft.creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    };
    return { as, run, posted, reversalOf, contact, invoice, creditNote, bill, supplierCredit };
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("mcr-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("mcr-bookkeeper@example.com");
    for (const org of ["mcr-co", "mcv-co"]) {
      await createTestOrganisation(owner, org);
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
      await inOrganisation(org, { userId: owner.id, email: owner.email }, (tx) =>
        createBankAccount(tx, { code: "1030", name: "USD account", accountType: "bank", currencyCode: "USD" }),
      );
    }
  });

  afterAll(async () => {
    await server?.teardown();
  });

  describe("rounding gains and losses (MC31-MC38)", () => {
    const t = tools("mcr-co");
    let acme: Contact;
    let aws: Contact;

    it("MC31: 7050 Rounding gains and losses is in the starting chart; migration 0045 adds it to existing organisations", async () => {
      acme = await t.contact("Acme Inc", { isCustomer: true });
      aws = await t.contact("Amazon Web Services", { isSupplier: true });
      const accounts = await t.run((tx) => tx.query("select code, name, account_type, system_key from accounts where system_key = 'fx_rounding'"));
      expect(accounts.rows).toEqual([{ code: "7050", name: "Rounding gains and losses", account_type: "other_income", system_key: "fx_rounding" }]);

      const databaseName = `${server.coreDatabase}_org_upgrade_rounding`;
      const admin = new pg.Client({ connectionString: testDatabaseUrl! });
      await admin.connect();
      await admin.query(`create database "${databaseName}"`);
      await admin.end();
      const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
      await client.connect();
      try {
        await applyMigrations(client, tenantMigrations.filter((migration) => migration.version < "0045"), "test:upgrade");
        await client.query("insert into organisation_settings (organisation_id, display_name, base_currency) values ('rounding-co', 'Rounding Co', 'NZD')");
        await client.query("insert into accounts (code, name, account_class, account_type) values ('7050', 'Donations', 'revenue', 'other_income')");
        expect((await applyMigrations(client, tenantMigrations, "test:upgrade")).applied).toContain("0045");
        expect((await client.query("select code, name, system_key from accounts where code like '705%' order by code")).rows).toEqual([
          { code: "7050", name: "Donations", system_key: null },
          { code: "7051", name: "Rounding gains and losses", system_key: "fx_rounding" },
        ]);
      } finally {
        await client.end();
      }
    });

    it("MC32: a payment at another rate: the realised gain is (1.60 - 1.50) x 10.05 = 1.01; the cent left is rounding", async () => {
      const inv = await t.invoice(acme.id, "2026-07-01", ["10.05"], "1.5");
      expect(inv.baseTotal).toBe("15.08");
      const pay = (paymentDate: string) =>
        t.run((tx) => recordPayment(tx, inv.id, { idempotencyKey: key("pay"), paymentDate, amount: "10.05", bankAccountCode: "1000", exchangeRate: "1.60" }));
      const { payment } = await pay("2026-07-10");
      expect(payment).toMatchObject({ baseAmount: "16.08", baseCleared: "15.08", realisedGain: "1.01", roundingGain: "-0.01" });
      expect(await t.posted(payment.journalId)).toEqual([
        ["1000", "16.08", "0.00"],
        ["1100", "0.00", "15.08", "USD 10.05 carrying_value"],
        ["7020", "0.00", "1.01"],
        ["7050", "0.01", "0.00"],
      ]);
      const voided = await t.run((tx) => voidPayment(tx, inv.id, payment.id, { idempotencyKey: key("void"), voidDate: "2026-07-11" }));
      expect(await t.posted(voided.payment.voidJournalId!)).toEqual([
        ["1000", "0.00", "16.08"],
        ["1100", "15.08", "0.00", "USD 10.05 carrying_value"],
        ["7020", "1.01", "0.00"],
        ["7050", "0.00", "0.01"],
      ]);
      expect((await pay("2026-07-11")).payment).toMatchObject({ realisedGain: "1.01", roundingGain: "-0.01" });
    });

    it("MC33: a USD bill paid at another rate: realised loss 1.01, rounding gain 0.01", async () => {
      const aws1 = await t.bill(aws.id, "AWS-1", "2026-07-01", "10.05", "1.5");
      expect(aws1.baseTotal).toBe("15.08");
      const { payment } = await t.run((tx) =>
        recordSupplierPayment(tx, aws1.id, { idempotencyKey: key("pay"), paymentDate: "2026-07-10", amount: "10.05", bankAccountCode: "1000", exchangeRate: "1.60" }),
      );
      expect(payment).toMatchObject({ baseAmount: "16.08", baseCleared: "15.08", realisedGain: "-1.01", roundingGain: "0.01" });
      expect(await t.posted(payment.journalId)).toEqual([
        ["2000", "15.08", "0.00", "USD 10.05 carrying_value"],
        ["1000", "0.00", "16.08"],
        ["7020", "1.01", "0.00"],
        ["7050", "0.00", "0.01"],
      ]);
    });

    it("MC34: a USD credit note applied to an invoice at another rate: realised loss 1.01, rounding gain 0.01; removing reverses it", async () => {
      const cn = await t.creditNote(acme.id, "2026-07-03", "10.05", "1.5");
      const inv = await t.invoice(acme.id, "2026-07-04", ["20.00"], "1.60");
      expect([cn.baseTotal, inv.baseTotal]).toEqual(["15.08", "32.00"]);
      const apply = () =>
        t.run((tx) => applyCreditNote(tx, cn.id, { idempotencyKey: key("apply"), applicationDate: "2026-07-15", applications: [{ invoiceId: inv.id, amount: "10.05" }] }));
      const applied = await apply();
      expect(applied.applications[0]).toMatchObject({ creditNoteBase: "15.08", invoiceBase: "16.08", realisedGain: "-1.01", roundingGain: "0.01" });
      expect(await t.posted(applied.applications[0].journalId!)).toEqual([
        ["1100", "15.08", "0.00", "USD 10.05 carrying_value"],
        ["1100", "0.00", "16.08", "USD 10.05 carrying_value"],
        ["7020", "1.01", "0.00"],
        ["7050", "0.00", "0.01"],
      ]);
      expect(await t.run((tx) => getInvoice(tx, inv.id))).toMatchObject({ amountDue: "9.95", amountDueBase: "15.92" });
      await t.run((tx) => removeApplication(tx, cn.id, applied.applications[0].id, { idempotencyKey: key("remove"), removalDate: "2026-07-16" }));
      expect(await t.posted(await t.reversalOf(applied.applications[0].journalId!))).toEqual([
        ["1100", "0.00", "15.08", "USD 10.05 carrying_value"],
        ["1100", "16.08", "0.00", "USD 10.05 carrying_value"],
        ["7020", "0.00", "1.01"],
        ["7050", "0.01", "0.00"],
      ]);
      expect((await apply()).applications[0]).toMatchObject({ realisedGain: "-1.01", roundingGain: "0.01" });
    });

    it("MC35: a USD overpayment applied to another invoice: realised loss 1.01, rounding gain 0.01", async () => {
      const inv4 = await t.invoice(acme.id, "2026-07-05", ["10.00"], "1.60");
      const { payment } = await t.run((tx) =>
        recordPayment(tx, inv4.id, { idempotencyKey: key("pay"), paymentDate: "2026-07-06", amount: "20.05", bankAccountCode: "1000", exchangeRate: "1.5" }),
      );
      // Bank 20.05 x 1.5 = 30.075 -> 30.08; the overpayment USD 10.05 x 1.5 = 15.08; the invoice part 15.00 clears 16.00:
      // realised (1.5 - 1.6) x 10.00 = -1.00, no rounding.
      expect(payment).toMatchObject({ baseAmount: "30.08", baseOverpayment: "15.08", baseCleared: "16.00", realisedGain: "-1.00", roundingGain: "0.00" });
      expect(await t.posted(payment.journalId)).toEqual([
        ["1000", "30.08", "0.00"],
        ["1100", "0.00", "16.00", "USD 10.00 carrying_value"],
        ["1100", "0.00", "15.08", "USD 10.05 document"],
        ["7020", "1.00", "0.00"],
      ]);
      const inv5 = await t.invoice(acme.id, "2026-07-07", ["10.05"], "1.60");
      expect(inv5.baseTotal).toBe("16.08");
      const applied = await t.run((tx) =>
        applyOverpayment(tx, payment.id, { idempotencyKey: key("apply"), applicationDate: "2026-07-20", applications: [{ invoiceId: inv5.id, amount: "10.05" }] }),
      );
      expect(applied.applications[0]).toMatchObject({ overpaymentBase: "15.08", invoiceBase: "16.08", realisedGain: "-1.01", roundingGain: "0.01" });
      expect(await t.posted(applied.applications[0].journalId!)).toEqual([
        ["1100", "15.08", "0.00", "USD 10.05 carrying_value"],
        ["1100", "0.00", "16.08", "USD 10.05 carrying_value"],
        ["7020", "1.01", "0.00"],
        ["7050", "0.00", "0.01"],
      ]);
    });

    it("MC36: refunds of USD credit at another rate: realised 1.01, rounding -0.01, on both sides", async () => {
      const cn = await t.creditNote(acme.id, "2026-07-08", "10.05", "1.60");
      const refunded = await t.run((tx) =>
        refundCreditNote(tx, cn.id, { idempotencyKey: key("refund"), refundDate: "2026-07-21", amount: "10.05", bankAccountCode: "1000", exchangeRate: "1.5" }),
      );
      expect(refunded.refund).toMatchObject({ baseAmount: "15.08", baseCleared: "16.08", realisedGain: "1.01", roundingGain: "-0.01" });
      expect(await t.posted(refunded.refund.journalId)).toEqual([
        ["1100", "16.08", "0.00", "USD 10.05 carrying_value"],
        ["1000", "0.00", "15.08"],
        ["7020", "0.00", "1.01"],
        ["7050", "0.01", "0.00"],
      ]);
      const credit = await t.supplierCredit(aws.id, "AWS-CR1", "2026-07-09", "10.05", "1.5");
      const received = await t.run((tx) =>
        refundSupplierCreditNote(tx, credit.id, { idempotencyKey: key("refund"), refundDate: "2026-07-22", amount: "10.05", bankAccountCode: "1000", exchangeRate: "1.60" }),
      );
      expect(received.refund).toMatchObject({ baseAmount: "16.08", baseCleared: "15.08", realisedGain: "1.01", roundingGain: "-0.01" });
      expect(await t.posted(received.refund.journalId)).toEqual([
        ["1000", "16.08", "0.00"],
        ["2000", "0.00", "15.08", "USD 10.05 carrying_value"],
        ["7020", "0.00", "1.01"],
        ["7050", "0.01", "0.00"],
      ]);
    });

    it("MC37: a USD supplier credit note applied to a bill at another rate: realised loss 1.01, rounding gain 0.01", async () => {
      const credit = await t.supplierCredit(aws.id, "AWS-CR2", "2026-07-10", "10.05", "1.60");
      const aws2 = await t.bill(aws.id, "AWS-2", "2026-07-10", "20.00", "1.5");
      const applied = await t.run((tx) =>
        applySupplierCreditNote(tx, credit.id, { idempotencyKey: key("apply"), applicationDate: "2026-07-23", applications: [{ billId: aws2.id, amount: "10.05" }] }),
      );
      // The bill's side 30.00 x 10.05 / 20.00 = 15.075 -> 15.08; the credit's 16.08.
      expect(applied.applications[0]).toMatchObject({ billBase: "15.08", creditNoteBase: "16.08", realisedGain: "-1.01", roundingGain: "0.01" });
      expect(await t.posted(applied.applications[0].journalId!)).toEqual([
        ["2000", "15.08", "0.00", "USD 10.05 carrying_value"],
        ["2000", "0.00", "16.08", "USD 10.05 carrying_value"],
        ["7020", "1.01", "0.00"],
        ["7050", "0.00", "0.01"],
      ]);
    });

    it("MC38: two USD bills paid together: each has its own realised loss and rounding gain", async () => {
      const aws3 = await t.bill(aws.id, "AWS-3", "2026-07-11", "10.05", "1.5");
      const aws4 = await t.bill(aws.id, "AWS-4", "2026-07-11", "10.05", "1.5");
      const { batch } = await t.run((tx) =>
        recordPaymentBatch(tx, "supplier", {
          idempotencyKey: key("batch"),
          paymentDate: "2026-07-25",
          amount: "20.10",
          bankAccountCode: "1000",
          exchangeRate: "1.60",
          documents: [
            { id: aws3.id, amount: "10.05" },
            { id: aws4.id, amount: "10.05" },
          ],
        }),
      );
      expect(batch.baseAmount).toBe("32.16");
      expect(batch.parts.map((part) => [part.documentNumber, part.baseAmount, part.baseCleared, part.realisedGain, part.roundingGain])).toEqual([
        ["AWS-3", "16.08", "15.08", "-1.01", "0.01"],
        ["AWS-4", "16.08", "15.08", "-1.01", "0.01"],
      ]);
      expect(await t.posted(batch.journalId)).toEqual([
        ["2000", "15.08", "0.00", "USD 10.05 carrying_value"],
        ["7020", "1.01", "0.00"],
        ["7050", "0.00", "0.01"],
        ["2000", "15.08", "0.00", "USD 10.05 carrying_value"],
        ["7020", "1.01", "0.00"],
        ["7050", "0.00", "0.01"],
        ["1000", "0.00", "32.16"],
      ]);
      // The trial balance: 7020 = 1.01 (MC32) - 1.01 (MC33) - 1.01 (MC34) - 1.00 - 1.01 (MC35) + 1.01 + 1.01 (MC36) - 1.01 (MC37) - 2.02 (MC38).
      const rows = (await t.run((tx) => trialBalance(tx, { asAt: "2026-07-31" }))).rows;
      const row = (code: string) => rows.find((entry) => entry.code === code);
      expect(row("7020")).toMatchObject({ debit: "4.03", credit: "0.00" });
      // 7050: -0.01 + 0.01 + 0.01 + 0.01 - 0.01 - 0.01 + 0.01 + 0.02 = 0.03 credit.
      expect(row("7050")).toMatchObject({ debit: "0.00", credit: "0.03" });
    });
  });

  describe("revaluing open documents one by one (MC39-MC43)", () => {
    const t = tools("mcv-co");
    let acme: Contact;
    let aws: Contact;
    const docs: Record<string, string> = {};
    const revalue = (revaluationDate: string, reversalPostingDate: string, balances: Array<Record<string, unknown>>, reference = "FX-JUL") =>
      t.run((tx) =>
        postFxRevaluation(tx, {
          idempotencyKey: key("fx"),
          reference,
          revaluationDate,
          reversalPostingDate,
          rateDate: revaluationDate,
          rateSource: "RBNZ",
          unrealisedGainAccountCode: "7000",
          unrealisedLossAccountCode: "7010",
          balances,
        }),
      );

    beforeAll(async () => {
      acme = await t.contact("Acme Inc", { isCustomer: true });
      aws = await t.contact("Amazon Web Services", { isSupplier: true });
      docs["INV-0001"] = (await t.invoice(acme.id, "2026-07-01", ["10.01"], "1.5")).id;
      docs["INV-0002"] = (await t.invoice(acme.id, "2026-07-02", ["10.01"], "1.5")).id;
      docs["INV-0003"] = (await t.invoice(acme.id, "2026-07-03", ["100.00"], "1.62")).id;
      docs["CN-0001"] = (await t.creditNote(acme.id, "2026-07-04", "20.00", "1.60")).id;
      docs["INV-0004"] = (await t.invoice(acme.id, "2026-07-05", ["50.00"], "1.60")).id;
      await t.run((tx) =>
        recordPayment(tx, docs["INV-0004"], { idempotencyKey: key("pay"), paymentDate: "2026-07-06", amount: "60.00", bankAccountCode: "1030", exchangeRate: "1.64" }),
      );
      docs["AWS-1"] = (await t.bill(aws.id, "AWS-1", "2026-07-01", "10.01", "1.5")).id;
      docs["AWS-2"] = (await t.bill(aws.id, "AWS-2", "2026-07-02", "10.01", "1.5")).id;
      docs["AWS-CR1"] = (await t.supplierCredit(aws.id, "AWS-CR1", "2026-07-03", "5.00", "1.70")).id;
    });

    it("MC39: each open invoice, credit note, overpayment and bill is revalued on its own; 1030 stays one balance", async () => {
      const { run: fx } = await revalue("2026-07-31", "2026-08-01", [
        { accountCode: "1030", closingRate: "1.55" },
        { accountCode: "1100", currencyCode: "USD", closingRate: "1.55" },
        { accountCode: "2000", currencyCode: "USD", closingRate: "1.55" },
      ]);
      expect(fx.items.map((item) => [item.accountCode, item.foreignAmount, item.carryingAmount, item.revaluedAmount, item.deltaAmount])).toEqual([
        ["1030", "60.00", "98.40", "93.00", "-5.40"],
        // Per document: 0.50 + 0.50 - 7.00 + 1.00 + 0.90 = -4.10 (the currency's total, 90.02 x 1.55 = 139.53, would give -4.11).
        ["1100", "90.02", "143.64", "139.54", "-4.10"],
        // 0.50 + 0.50 + 0.75 = 1.75 more owed (15.02 x 1.55 = 23.28 would give 1.74).
        ["2000", "15.02", "21.54", "23.29", "1.75"],
      ]);
      expect(fx.items[0].documents).toEqual([]);
      const listed = (index: number) =>
        fx.items[index].documents.map((doc) => [doc.kind, doc.documentNumber, doc.foreignAmount, doc.carryingAmount, doc.documentRate, doc.deltaAmount]);
      expect(listed(1)).toEqual([
        ["invoice", "INV-0001", "10.01", "15.02", "1.5", "0.50"],
        ["invoice", "INV-0002", "10.01", "15.02", "1.5", "0.50"],
        ["invoice", "INV-0003", "100.00", "162.00", "1.62", "-7.00"],
        ["credit_note", "CN-0001", "-20.00", "-32.00", "1.6", "1.00"],
        ["overpayment", "Overpayment on INV-0004", "-10.00", "-16.40", "1.64", "0.90"],
      ]);
      expect(listed(2)).toEqual([
        ["bill", "AWS-1", "10.01", "15.02", "1.5", "0.50"],
        ["bill", "AWS-2", "10.01", "15.02", "1.5", "0.50"],
        ["supplier_credit_note", "AWS-CR1", "-5.00", "-8.50", "1.7", "0.75"],
      ]);
      expect(await t.posted(fx.revaluationJournalId)).toEqual([
        ["1030", "0.00", "5.40", "USD 0.00 revaluation"],
        ["7010", "5.40", "0.00"],
        ["1100", "0.50", "0.00", "USD 0.00 revaluation"],
        ["7000", "0.00", "0.50"],
        ["1100", "0.50", "0.00", "USD 0.00 revaluation"],
        ["7000", "0.00", "0.50"],
        ["1100", "0.00", "7.00", "USD 0.00 revaluation"],
        ["7010", "7.00", "0.00"],
        ["1100", "1.00", "0.00", "USD 0.00 revaluation"],
        ["7000", "0.00", "1.00"],
        ["1100", "0.90", "0.00", "USD 0.00 revaluation"],
        ["7000", "0.00", "0.90"],
        ["2000", "0.00", "0.50", "USD 0.00 revaluation"],
        ["7010", "0.50", "0.00"],
        ["2000", "0.00", "0.50", "USD 0.00 revaluation"],
        ["7010", "0.50", "0.00"],
        ["2000", "0.00", "0.75", "USD 0.00 revaluation"],
        ["7010", "0.75", "0.00"],
      ]);
      const reversal = await t.run((tx) => getJournal(tx, fx.reversalJournalId));
      expect(reversal.postingDate).toBe("2026-08-01");
      // Listed later with the same documents.
      const [again] = await t.run((tx) => listFxRevaluations(tx, {}));
      expect(again.items[1].documents.map((doc) => doc.deltaAmount)).toEqual(["0.50", "0.50", "-7.00", "1.00", "0.90"]);
    });

    it("MC40: the revaluation screen lists the open documents under each account and currency", async () => {
      const balances = await t.run((tx) => openCurrencyBalances(tx, "2026-07-30"));
      expect(balances.map((balance) => [balance.accountCode, balance.currencyCode, balance.foreign, balance.base])).toEqual([
        ["1100", "USD", "90.02", "143.64"],
        ["2000", "USD", "15.02", "21.54"],
      ]);
      expect(balances[0].documents.map((doc) => [doc.documentNumber, doc.documentDate, doc.foreign, doc.base, doc.rate])).toEqual([
        ["INV-0001", "2026-07-01", "10.01", "15.02", "1.5"],
        ["INV-0002", "2026-07-02", "10.01", "15.02", "1.5"],
        ["INV-0003", "2026-07-03", "100.00", "162.00", "1.62"],
        ["CN-0001", "2026-07-04", "-20.00", "-32.00", "1.6"],
        ["Overpayment on INV-0004", "2026-07-06", "-10.00", "-16.40", "1.64"],
      ]);
      expect(balances[1].documents.map((doc) => doc.documentNumber)).toEqual(["AWS-1", "AWS-2", "AWS-CR1"]);
    });

    it("MC41: documents plus the revaluation equal the ledger on the date; after the reversal nothing is left", async () => {
      const receivables = await t.run((tx) => agedReceivables(tx, { asAt: "2026-07-31" }));
      expect([receivables.total.total, receivables.revaluation]).toEqual(["143.64", "-4.10"]);
      const payables = await t.run((tx) => agedPayables(tx, { asAt: "2026-07-31" }));
      expect(payables.revaluation).toBe("1.75");
      expect(payables.payablesAccount).toMatchObject({ balance: "23.29", difference: "0.00" });
      const checks = (await t.run((tx) => periodChecklist(tx, { periodEnd: "2026-07-31" }))).checks;
      const status = Object.fromEntries(checks.map((entry) => [entry.key, entry.status]));
      expect([status.fx_revaluation, status.receivables, status.payables]).toEqual(["pass", "pass", "pass"]);
      const rows = async (asAt: string) => {
        const found = (await t.run((tx) => trialBalance(tx, { asAt }))).rows;
        return (code: string) => found.find((entry) => entry.code === code);
      };
      const july = await rows("2026-07-31");
      // Gains 0.50 + 0.50 + 1.00 + 0.90 = 2.90; losses 5.40 + 7.00 + 0.50 + 0.50 + 0.75 = 14.15.
      expect(july("7000")).toMatchObject({ credit: "2.90" });
      expect(july("7010")).toMatchObject({ debit: "14.15" });
      expect(july("1100")).toMatchObject({ debit: "139.54" });
      const august = await rows("2026-08-01");
      expect(august("7000")).toBeUndefined();
      expect(august("7010")).toBeUndefined();
      expect(august("1100")).toMatchObject({ debit: "143.64" });
    });

    it("MC42: refused rather than guessed", async () => {
      await expect(revalue("2026-07-31", "2026-08-01", [{ accountCode: "1100", currencyCode: "USD", closingRate: "1.56" }], "FX-AGAIN")).rejects.toThrow(
        /1100 \(USD\) already revalued on 2026-07-31/,
      );
      await expect(revalue("2026-08-15", "2026-08-16", [{ accountCode: "1100", currencyCode: "USD", foreignAmount: "90.00", closingRate: "1.56" }], "FX-MID")).rejects.toThrow(
        /the ledger has USD 90.02 open on 2026-08-15, not 90.00/,
      );
      await expect(revalue("2026-08-15", "2026-08-16", [{ accountCode: "1100", currencyCode: "EUR", closingRate: "1.8" }], "FX-MID")).rejects.toThrow(
        /has nothing open in EUR on 2026-08-15/,
      );
      // An earlier revaluation not reversed yet: NetSuite would revalue from its rate; not supported.
      await revalue("2026-08-15", "2026-09-01", [{ accountCode: "2000", currencyCode: "USD", closingRate: "1.56" }], "FX-MID");
      await expect(revalue("2026-08-31", "2026-09-01", [{ accountCode: "2000", currencyCode: "USD", closingRate: "1.57" }], "FX-AUG")).rejects.toThrow(
        "Account 2000 USD was revalued on 2026-08-15 (FX-MID), and that isn't reversed until 2026-09-01. Revaluing it again before then isn't supported yet.",
      );
    });

    it("MC43: a payment after the revaluation still settles at the invoice's own rate", async () => {
      const { payment } = await t.run((tx) =>
        recordPayment(tx, docs["INV-0003"], { idempotencyKey: key("pay"), paymentDate: "2026-08-03", amount: "100.00", bankAccountCode: "1000", exchangeRate: "1.55" }),
      );
      expect(payment).toMatchObject({ baseAmount: "155.00", baseCleared: "162.00", realisedGain: "-7.00", roundingGain: "0.00" });
      expect(await t.posted(payment.journalId)).toEqual([
        ["1000", "155.00", "0.00"],
        ["1100", "0.00", "162.00", "USD 100.00 carrying_value"],
        ["7020", "7.00", "0.00"],
      ]);
    });
  });
});

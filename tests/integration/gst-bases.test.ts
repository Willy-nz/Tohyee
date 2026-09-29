import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankTransaction } from "@/lib/bank/transactions";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, type Bill, createBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { applyCreditNote, removeApplication } from "@/lib/credit-notes/applications";
import { refundCreditNote } from "@/lib/credit-notes/refunds";
import { approveCreditNote, createCreditNote, type CreditNote } from "@/lib/credit-notes/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { applyOverpayment, refundOverpayment } from "@/lib/invoices/overpayments";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, type Invoice, voidInvoice } from "@/lib/invoices/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { calculateGstReturn, fileGstReturn, getGstReturn } from "@/lib/reports/gst-return";
import { applySupplierCreditNote } from "@/lib/supplier-credit-notes/applications";
import {
  approveSupplierCreditNote,
  createSupplierCreditNote,
  type SupplierCreditNote,
} from "@/lib/supplier-credit-notes/service";
import type { GstBasis } from "@/lib/tax/categories";
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

type Period = { periodStart: string; periodEnd: string };
const FEB_MAR: Period = { periodStart: "2026-02-01", periodEnd: "2026-03-31" };
const APR_MAY: Period = { periodStart: "2026-04-01", periodEnd: "2026-05-31" };
const JUN_JUL: Period = { periodStart: "2026-06-01", periodEnd: "2026-07-31" };

/**
 * Examples G10-G22 in docs/ACCOUNTING-EXAMPLES.md ("Payments and hybrid
 * bases"). Each example gets its own organisation with customer Kobe Ltd,
 * supplier Paw Supplies and tax codes GST (15%) and ZERO (zero rated).
 */
describeWithDatabase("GST return on the payments and hybrid bases", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("gst-bases-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(basis: GstBasis) {
    organisations += 1;
    const org = `gst-basis-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const setBasis = (gstBasis: GstBasis) => as((tx) => updateOrganisationSettings(tx, { gstBasis }));
    await setBasis(basis);
    const contact = async (name: string, fields: Record<string, unknown>): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...fields }))).contact;
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const paw = await contact("Paw Supplies", { isSupplier: true });

    const line = (description: string, unitPrice: string, taxCode = "GST", accountCode = "4000") => ({
      description,
      quantity: "1",
      unitPrice,
      accountCode,
      taxCode,
    });
    /** An approved invoice for Kobe Ltd: I1 (1 x 100.00 at 15% exclusive, 115.00) on 10 Apr unless told otherwise. */
    const invoice = async (fields: Record<string, unknown> = {}): Promise<Invoice> => {
      const { invoice: drafted } = await as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("invoice"),
          contactId: kobe.id,
          invoiceDate: "2026-04-10",
          dueDate: "2026-07-31",
          amountsMode: "exclusive",
          lines: [line("Consulting", "100.00")],
          ...fields,
        }),
      );
      return (await as((tx) => approveInvoice(tx, drafted.id, { idempotencyKey: key("approve") }))).invoice;
    };
    /** I5: 100.00 at 15% + 50.00 zero rated, exclusive, total 165.00. */
    const i5 = (fields: Record<string, unknown> = {}) =>
      invoice({ lines: [line("Consulting", "100.00"), line("Export freight", "50.00", "ZERO")], ...fields });
    let bills = 0;
    /** An approved bill from Paw Supplies: B1 (1 x 200.00 at 15% exclusive, 230.00) on 12 Apr unless told otherwise. */
    const bill = async (fields: Record<string, unknown> = {}): Promise<Bill> => {
      bills += 1;
      const { bill: drafted } = await as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: paw.id,
          billDate: "2026-04-12",
          dueDate: "2026-07-31",
          supplierInvoiceNumber: `S-${bills}`,
          amountsMode: "exclusive",
          lines: [line("Stationery", "200.00", "GST", "6010")],
          ...fields,
        }),
      );
      return (await as((tx) => approveBill(tx, drafted.id, { idempotencyKey: key("approve") }))).bill;
    };
    /** CN-0001 for Kobe Ltd: 1 x 20.00 at 15% exclusive, 23.00, on 5 Apr unless told otherwise. */
    const creditNote = async (fields: Record<string, unknown> = {}): Promise<CreditNote> => {
      const { creditNote: drafted } = await as((tx) =>
        createCreditNote(tx, {
          idempotencyKey: key("credit-note"),
          contactId: kobe.id,
          creditNoteDate: "2026-04-05",
          amountsMode: "exclusive",
          lines: [line("Discount", "20.00")],
          ...fields,
        }),
      );
      return (await as((tx) => approveCreditNote(tx, drafted.id, { idempotencyKey: key("approve") }))).creditNote;
    };
    /** CR-7 from Paw Supplies: 1 x 40.00 at 15% exclusive, 46.00, on 16 Apr. */
    const supplierCreditNote = async (): Promise<SupplierCreditNote> => {
      const { creditNote: drafted } = await as((tx) =>
        createSupplierCreditNote(tx, {
          idempotencyKey: key("supplier-credit-note"),
          contactId: paw.id,
          creditNoteDate: "2026-04-16",
          supplierCreditNoteNumber: "CR-7",
          amountsMode: "exclusive",
          lines: [line("Returned stock", "40.00", "GST", "6010")],
        }),
      );
      return (await as((tx) => approveSupplierCreditNote(tx, drafted.id, { idempotencyKey: key("approve") }))).creditNote;
    };
    const lastId = async (table: string) =>
      (await as((tx) => tx.query<{ id: string }>(`select max(id)::text as id from ${table}`))).rows[0].id;
    const pay = async (invoiceId: string, paymentDate: string, amount: string) => {
      await as((tx) => recordPayment(tx, invoiceId, { idempotencyKey: key("pay"), paymentDate, amount, bankAccountCode: "1000" }));
      return lastId("customer_payments");
    };
    const payBill = (billId: string, paymentDate: string, amount: string) =>
      as((tx) => recordSupplierPayment(tx, billId, { idempotencyKey: key("pay"), paymentDate, amount, bankAccountCode: "1000" }));
    const apply = async (creditNoteId: string, invoiceId: string, applicationDate: string, amount: string) => {
      await as((tx) =>
        applyCreditNote(tx, creditNoteId, { idempotencyKey: key("apply"), applicationDate, applications: [{ invoiceId, amount }] }),
      );
      return lastId("sales_credit_note_applications");
    };
    const calculate = (period: Period = APR_MAY, adjustments?: unknown) =>
      as((tx) => calculateGstReturn(tx, { ...period, adjustments }));
    const file = (period: Period, adjustments?: unknown) =>
      as((tx) => fileGstReturn(tx, { idempotencyKey: key("file"), ...period, adjustments }));
    return {
      as,
      setBasis,
      kobe,
      paw,
      invoice,
      i5,
      bill,
      creditNote,
      supplierCreditNote,
      pay,
      payBill,
      apply,
      calculate,
      file,
    };
  }

  const summary = (lines: { eventType: string; eventDate: string; documentNumber: string; amount: string }[]) =>
    lines.map((line) => [line.eventType, line.eventDate, line.documentNumber, line.amount]);

  it("G10: on the payments basis an invoice dated in March and paid in April counts in April", async () => {
    const world = await setup("payments");
    const i1 = await world.invoice({ invoiceDate: "2026-03-25" });
    await world.pay(i1.id, "2026-04-20", "115.00");
    const febMar = await world.calculate(FEB_MAR);
    expect(febMar.basis).toBe("payments");
    expect(febMar.boxes.box5).toBe("0.00");
    expect(febMar.lines).toEqual([]);
    const aprMay = await world.calculate();
    expect(aprMay.boxes).toMatchObject({ box5: "115.00", box6: "0.00", box8: "15.00", box15: "15.00" });
    expect(aprMay.lines).toEqual([
      expect.objectContaining({
        side: "sales",
        eventType: "customer_payment",
        eventDate: "2026-04-20",
        documentType: "sales_invoice",
        documentId: i1.id,
        documentNumber: "INV-0001",
        amount: "115.00",
        gst: "15.00",
        boxes: ["5"],
        settledAmount: "115.00",
        documentTotal: "115.00",
      }),
    ]);
  });

  it("G11: a part payment of I5 counts each line in proportion", async () => {
    const world = await setup("payments");
    const i5 = await world.i5({ invoiceDate: "2026-04-01" });
    await world.pay(i5.id, "2026-04-15", "82.50");
    await world.pay(i5.id, "2026-06-10", "82.50");
    const aprMay = await world.calculate();
    expect(aprMay.boxes).toMatchObject({ box5: "82.50", box6: "25.00", box7: "57.50", box8: "7.50" });
    expect(aprMay.lines.map((line) => [line.description, line.amount, line.gst, line.boxes])).toEqual([
      ["Consulting", "57.50", "7.50", ["5"]],
      ["Export freight", "25.00", "0.00", ["5", "6"]],
    ]);
    expect((await world.calculate(JUN_JUL)).boxes).toMatchObject({ box5: "82.50", box6: "25.00", box8: "7.50" });
  });

  it("G12: the leftover cent of a share goes to the largest (first) line", async () => {
    const world = await setup("payments");
    const invoice = await world.invoice({
      invoiceDate: "2026-04-01",
      amountsMode: "inclusive",
      lines: [
        { description: "A", quantity: "1", unitPrice: "10.00", accountCode: "4000", taxCode: "GST" },
        { description: "B", quantity: "1", unitPrice: "10.00", accountCode: "4000", taxCode: "GST" },
        { description: "C", quantity: "1", unitPrice: "10.00", accountCode: "4000", taxCode: "ZERO" },
      ],
    });
    await world.pay(invoice.id, "2026-04-20", "10.00");
    await world.pay(invoice.id, "2026-06-20", "20.00");
    const aprMay = await world.calculate();
    expect(aprMay.lines.map((line) => [line.description, line.amount, line.gst])).toEqual([
      ["A", "3.34", "0.44"],
      ["B", "3.33", "0.43"],
      ["C", "3.33", "0.00"],
    ]);
    expect(aprMay.boxes).toMatchObject({ box5: "10.00", box6: "3.33", box7: "6.67", box8: "0.87" });
    expect(aprMay.gstOnTransactions.sales).toBe("0.87");
    const junJul = await world.calculate(JUN_JUL);
    expect(junJul.lines.map((line) => [line.description, line.amount, line.gst])).toEqual([
      ["A", "6.66", "0.86"],
      ["B", "6.67", "0.87"],
      ["C", "6.67", "0.00"],
    ]);
  });

  it("G13: credit applied settles both the invoice and the credit note; a refund counts the credit note", async () => {
    const world = await setup("payments");
    const i1 = await world.invoice({ invoiceDate: "2026-04-01" });
    const cn = await world.creditNote();
    await world.apply(cn.id, i1.id, "2026-04-05", "23.00");
    await world.pay(i1.id, "2026-04-20", "92.00");
    const report = await world.calculate();
    expect(report.boxes).toMatchObject({ box5: "92.00", box8: "12.00" });
    expect(summary(report.lines)).toEqual([
      ["credit_note_applied", "2026-04-05", "CN-0001", "-23.00"],
      ["credit_note_applied", "2026-04-05", "INV-0001", "23.00"],
      ["customer_payment", "2026-04-20", "INV-0001", "92.00"],
    ]);

    const refunded = await setup("payments");
    const invoice = await refunded.invoice({ invoiceDate: "2026-04-01" });
    const credit = await refunded.creditNote();
    await refunded.pay(invoice.id, "2026-04-20", "115.00");
    // Approved but not applied or refunded: counts nothing.
    expect((await refunded.calculate()).boxes).toMatchObject({ box5: "115.00", box8: "15.00" });
    await refunded.as((tx) =>
      refundCreditNote(tx, credit.id, { idempotencyKey: key("refund"), refundDate: "2026-06-12", amount: "23.00", bankAccountCode: "1000" }),
    );
    const junJul = await refunded.calculate(JUN_JUL);
    expect(junJul.boxes).toMatchObject({ box5: "-23.00", box8: "-3.00" });
    expect(summary(junJul.lines)).toEqual([["credit_note_refunded", "2026-06-12", "CN-0001", "-23.00"]]);
  });

  it("G14: purchases count when paid or credited", async () => {
    const world = await setup("payments");
    const b1 = await world.bill({ billDate: "2026-04-02" });
    const cr7 = await world.supplierCreditNote();
    await world.payBill(b1.id, "2026-04-30", "115.00");
    expect((await world.calculate({ periodStart: "2026-04-01", periodEnd: "2026-04-30" })).boxes).toMatchObject({
      box11: "115.00",
      box12: "15.00",
    });
    await world.as((tx) =>
      applySupplierCreditNote(tx, cr7.id, {
        idempotencyKey: key("apply"),
        applicationDate: "2026-05-10",
        applications: [{ billId: b1.id, amount: "46.00" }],
      }),
    );
    await world.payBill(b1.id, "2026-05-20", "69.00");
    const report = await world.calculate();
    expect(report.boxes).toMatchObject({ box11: "184.00", box12: "24.00" });
    expect(summary(report.lines)).toEqual([
      ["supplier_payment", "2026-04-30", "S-1", "115.00"],
      ["supplier_credit_note_applied", "2026-05-10", "S-1", "46.00"],
      ["supplier_credit_note_applied", "2026-05-10", "CR-7", "-46.00"],
      ["supplier_payment", "2026-05-20", "S-1", "69.00"],
    ]);
  });

  it("G15: only the invoice part of a payment counts; applied overpayment counts, refunded overpayment doesn't", async () => {
    const world = await setup("payments");
    const i1 = await world.invoice();
    const paymentId = await world.pay(i1.id, "2026-04-20", "150.00");
    const second = await world.invoice({ invoiceDate: "2026-05-01" });
    await world.as((tx) =>
      applyOverpayment(tx, paymentId, {
        idempotencyKey: key("apply"),
        applicationDate: "2026-05-10",
        applications: [{ invoiceId: second.id, amount: "35.00" }],
      }),
    );
    const report = await world.calculate();
    expect(report.boxes).toMatchObject({ box5: "150.00", box8: "19.57" });
    expect(summary(report.lines)).toEqual([
      ["customer_payment", "2026-04-20", "INV-0001", "115.00"],
      ["overpayment_applied", "2026-05-10", "INV-0002", "35.00"],
    ]);

    const refunded = await setup("payments");
    const invoice = await refunded.invoice();
    const overpaid = await refunded.pay(invoice.id, "2026-04-20", "150.00");
    await refunded.as((tx) =>
      refundOverpayment(tx, overpaid, { idempotencyKey: key("refund"), refundDate: "2026-05-10", amount: "35.00", bankAccountCode: "1000" }),
    );
    expect((await refunded.calculate()).boxes.box5).toBe("115.00");
  });

  it("G16: voids and removals count the other way on their date; voiding an unsettled document counts nothing", async () => {
    const world = await setup("payments");
    const i1 = await world.invoice();
    const paymentId = await world.pay(i1.id, "2026-04-20", "115.00");
    await world.as((tx) => voidPayment(tx, i1.id, paymentId, { idempotencyKey: key("void"), voidDate: "2026-06-03" }));
    await world.as((tx) => voidInvoice(tx, i1.id, { idempotencyKey: key("void"), voidDate: "2026-06-04" }));
    await world.bill();
    expect((await world.calculate()).boxes).toMatchObject({ box5: "115.00", box11: "0.00" });
    const junJul = await world.calculate(JUN_JUL);
    expect(junJul.boxes).toMatchObject({ box5: "-115.00", box8: "-15.00" });
    expect(summary(junJul.lines)).toEqual([["customer_payment_voided", "2026-06-03", "INV-0001", "-115.00"]]);

    const credited = await setup("payments");
    const invoice = await credited.invoice({ invoiceDate: "2026-04-01" });
    const cn = await credited.creditNote();
    const applicationId = await credited.apply(cn.id, invoice.id, "2026-04-05", "23.00");
    await credited.as((tx) => removeApplication(tx, cn.id, applicationId, { idempotencyKey: key("remove"), removalDate: "2026-06-08" }));
    const removed = await credited.calculate(JUN_JUL);
    expect(summary(removed.lines)).toEqual([
      ["credit_note_application_removed", "2026-06-08", "CN-0001", "23.00"],
      ["credit_note_application_removed", "2026-06-08", "INV-0001", "-23.00"],
    ]);
    expect(removed.boxes.box5).toBe("0.00");
  });

  it("G17: spend money counts on its date on every basis", async () => {
    const world = await setup("invoice");
    const bank = (await world.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0];
    await world.as((tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("spend"),
        kind: "spend",
        accountId: bank.id,
        contactId: world.paw.id,
        date: "2026-04-03",
        amountsMode: "inclusive",
        lines: [{ description: "Petrol", accountCode: "6010", taxCode: "GST", amount: "57.50" }],
      }),
    );
    for (const basis of ["invoice", "payments", "hybrid"] as const) {
      await world.setBasis(basis);
      const report = await world.calculate();
      expect(report.boxes).toMatchObject({ box11: "57.50", box12: "7.50" });
      expect(summary(report.lines)).toEqual([["bank_transaction_posted", "2026-04-03", "BT-" + report.lines[0].documentId, "57.50"]]);
    }
  });

  it("G18: the hybrid basis counts sales when approved and purchases when paid", async () => {
    const world = await setup("hybrid");
    const i1 = await world.invoice();
    const b1 = await world.bill();
    await world.bill({ billDate: "2026-04-20" });
    await world.payBill(b1.id, "2026-05-25", "115.00");
    await world.pay(i1.id, "2026-05-20", "115.00");
    const report = await world.calculate();
    expect(report.basis).toBe("hybrid");
    expect(report.boxes).toMatchObject({ box5: "115.00", box8: "15.00", box11: "115.00", box12: "15.00", box15: "0.00" });
    expect(summary(report.lines)).toEqual([
      ["invoice_approved", "2026-04-10", "INV-0001", "115.00"],
      ["supplier_payment", "2026-05-25", "S-1", "115.00"],
    ]);
  });

  it("G19: a filed return keeps its basis and settled lines, and is worked out again on that basis", async () => {
    const world = await setup("payments");
    const i1 = await world.invoice({ invoiceDate: "2026-03-25" });
    await world.pay(i1.id, "2026-04-20", "115.00");
    const i5 = await world.i5({ invoiceDate: "2026-04-01" });
    const { gstReturn } = await world.file(APR_MAY);
    expect(gstReturn).toMatchObject({ basis: "payments", changedSinceFiled: false });
    expect(gstReturn.boxes.box5).toBe("115.00");
    expect(gstReturn.lines).toEqual([
      expect.objectContaining({ eventType: "customer_payment", amount: "115.00", settledAmount: "115.00", documentTotal: "115.00" }),
    ]);

    await world.pay(i5.id, "2026-05-15", "82.50");
    const changed = await world.as((tx) => getGstReturn(tx, gstReturn.id));
    expect(changed.changedSinceFiled).toBe(true);
    expect(changed.changes).toEqual(expect.arrayContaining([{ box: "box5", filed: "115.00", current: "197.50" }]));

    // On the invoice basis April-May would have I5's 165.00, but the filed return stays on the payments basis.
    await world.setBasis("invoice");
    expect((await world.as((tx) => getGstReturn(tx, gstReturn.id))).current?.boxes.box5).toBe("197.50");
  });

  /** G20: the documents outstanding at 31 Mar 2026, with G22's paid-then-voided payment and voided invoice. */
  async function g20(filedOn: GstBasis) {
    const world = await setup(filedOn);
    await world.invoice({ invoiceDate: "2026-03-25" });
    const i5 = await world.i5({ invoiceDate: "2026-03-20" });
    await world.pay(i5.id, "2026-03-30", "82.50");
    await world.creditNote({ creditNoteDate: "2026-03-28" });
    await world.bill({ billDate: "2026-03-15" });
    // G22: paid on 20 Mar and the payment voided on 5 Apr: still paid at 31 Mar.
    const paidThenVoided = await world.invoice({ invoiceDate: "2026-03-10" });
    const paymentId = await world.pay(paidThenVoided.id, "2026-03-20", "115.00");
    // G22: voided on 25 Mar: not outstanding.
    const voided = await world.invoice({ invoiceDate: "2026-03-05" });
    await world.as((tx) => voidInvoice(tx, voided.id, { idempotencyKey: key("void"), voidDate: "2026-03-25" }));
    await world.file(FEB_MAR);
    await world.as((tx) =>
      voidPayment(tx, paidThenVoided.id, paymentId, { idempotencyKey: key("void"), voidDate: "2026-04-05" }),
    );
    return world;
  }

  it("G20, G22: after a change from invoice to payments the next return suggests Box 9 10.50, added in one click", async () => {
    const world = await g20("invoice");
    // Same basis as the last filed return: nothing to adjust.
    expect((await world.calculate()).basisChange).toBeNull();

    await world.setBasis("payments");
    const report = await world.calculate();
    const suggestion = {
      box: "9",
      description: "Change of GST basis from invoice to payments at 31 Mar 2026: GST on debtors 19.50, GST on creditors 30.00",
      amount: "10.50",
    };
    expect(report.basisChange).toEqual({
      from: "invoice",
      to: "payments",
      asAt: "2026-03-31",
      lastReturnId: expect.any(String),
      debtorsGst: "19.50",
      creditorsGst: "30.00",
      suggestion,
    });
    // Nothing is added until it's clicked; adding it is an ordinary adjustment.
    expect(report.boxes.box9).toBe("0.00");
    const { gstReturn } = await world.file(APR_MAY, [suggestion]);
    expect(gstReturn.boxes.box9).toBe("10.50");
    expect(gstReturn.adjustments).toEqual([suggestion]);
    // Once a return on the new basis is filed there's nothing more to suggest.
    expect((await world.calculate(JUN_JUL)).basisChange).toBeNull();
  });

  it("G21: the other changes of basis", async () => {
    const fromInvoice = await g20("invoice");
    await fromInvoice.setBasis("hybrid");
    expect((await fromInvoice.calculate()).basisChange?.suggestion).toMatchObject({ box: "9", amount: "30.00" });

    const fromPayments = await g20("payments");
    await fromPayments.setBasis("invoice");
    expect((await fromPayments.calculate()).basisChange?.suggestion).toMatchObject({ box: "13", amount: "10.50" });
    await fromPayments.setBasis("hybrid");
    expect((await fromPayments.calculate()).basisChange?.suggestion).toMatchObject({ box: "9", amount: "19.50" });

    const fromHybrid = await g20("hybrid");
    await fromHybrid.setBasis("payments");
    expect((await fromHybrid.calculate()).basisChange?.suggestion).toMatchObject({ box: "13", amount: "19.50" });
    await fromHybrid.setBasis("invoice");
    expect((await fromHybrid.calculate()).basisChange?.suggestion).toMatchObject({ box: "13", amount: "30.00" });

    // No filed return before the period: nothing to suggest.
    const fresh = await setup("invoice");
    await fresh.setBasis("payments");
    expect((await fresh.calculate()).basisChange).toBeNull();

    // Only CN-0001 outstanding, payments -> hybrid: GST on debtors -3.00 suggests Box 13 3.00.
    const creditOnly = await setup("payments");
    await creditOnly.creditNote({ creditNoteDate: "2026-03-28" });
    await creditOnly.file(FEB_MAR);
    await creditOnly.setBasis("hybrid");
    expect((await creditOnly.calculate()).basisChange).toMatchObject({
      debtorsGst: "-3.00",
      creditorsGst: "0.00",
      suggestion: { box: "13", amount: "3.00" },
    });
  });

  it("migration 0012 upgrades an organisation database on 0011: settlement events and columns for filed lines", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_gst_bases`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      await applyMigrations(client, tenantMigrations.filter((migration) => migration.version <= "0011"), "test:upgrade");
      expect((await applyMigrations(client, tenantMigrations.filter((migration) => migration.version <= "0012"), "test:upgrade")).applied).toEqual(["0012"]);
      const check = await client.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'gst_return_lines_event_type_check'",
      );
      expect(check.rows[0].definition).toContain("'customer_payment'");
      expect(check.rows[0].definition).toContain("'supplier_credit_note_refund_voided'");
      const columns = await client.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_name = 'gst_return_lines' and column_name in ('settled_amount', 'document_total') order by column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: "document_total", is_nullable: "YES" },
        { column_name: "settled_amount", is_nullable: "YES" },
      ]);
    } finally {
      await client.end();
    }
  });
});

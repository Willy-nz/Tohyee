import { afterAll, beforeAll, expect, it } from "vitest";
import * as batchVoidRoute from "@/app/api/customer-payment-batches/[batchId]/void/route";
import * as batchesRoute from "@/app/api/customer-payment-batches/route";
import * as supplierBatchesRoute from "@/app/api/supplier-payment-batches/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, suggestionsForLine } from "@/lib/bank/reconcile";
import { voidSupplierPayment } from "@/lib/bills/payments";
import { approveBill, type Bill, createBill, getBill, voidBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { applyOverpayment, getOverpayment, removeOverpaymentApplication } from "@/lib/invoices/overpayments";
import { listPayments, recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice, type Invoice, voidInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { recordPaymentBatch, voidPaymentBatch } from "@/lib/payments/batches";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { createTaxCode } from "@/lib/tax/codes";
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
const b64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * Examples MP1-MP10 and SMP1-SMP6 in docs/ACCOUNTING-EXAMPLES.md ("Payments
 * for several invoices" and "Payments for several bills"). Each example gets
 * its own organisation with the setup: Kobe Ltd with INV-0001 = I1 (115.00)
 * and INV-0002 = I6 (no tax, 80.00), Rex Ltd with INV-0003 (no tax, 50.00);
 * Kiwi Supplies with B1 (230.00) and B4 (135.00), Rata Ltd with a no-tax bill
 * of 60.00; all dated 10 May 2026.
 */
describeWithDatabase("payments for several invoices and bills", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `multi-pay-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXEMPT", label: "Exempt", category: "exempt", rate: "0", effectiveFrom: "2026-01-01" }),
    );
    const contact = async (name: string, flags: Record<string, unknown>): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...flags }))).contact;
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const rex = await contact("Rex Ltd", { isCustomer: true });
    const kiwi = await contact("Kiwi Supplies", { isSupplier: true });
    const rata = await contact("Rata Ltd", { isSupplier: true });

    const invoice = async (contactId: string, fields: Record<string, unknown>, approve = true): Promise<Invoice> => {
      const drafted = (
        await as((tx) =>
          createInvoice(tx, { idempotencyKey: key("invoice"), contactId, invoiceDate: "2026-05-10", dueDate: "2026-06-20", ...fields }),
        )
      ).invoice;
      return approve ? (await as((tx) => approveInvoice(tx, drafted.id, { idempotencyKey: key("approve") }))).invoice : drafted;
    };
    const noTax = (amount: string) => ({
      amountsMode: "no_tax",
      lines: [{ description: "Workshop", quantity: "1", unitPrice: amount, accountCode: "4000" }],
    });
    const i1 = await invoice(kobe.id, {
      amountsMode: "exclusive",
      lines: [{ description: "Consulting", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
    });
    const i2 = await invoice(kobe.id, noTax("80.00"));
    const i3 = await invoice(rex.id, noTax("50.00"));

    let bills = 0;
    const bill = async (contactId: string, fields: Record<string, unknown>, approve = true): Promise<Bill> => {
      bills += 1;
      const drafted = (
        await as((tx) =>
          createBill(tx, {
            idempotencyKey: key("bill"),
            contactId,
            billDate: "2026-05-10",
            dueDate: "2026-06-20",
            supplierInvoiceNumber: `S-${bills}`,
            ...fields,
          }),
        )
      ).bill;
      return approve ? (await as((tx) => approveBill(tx, drafted.id, { idempotencyKey: key("approve") }))).bill : drafted;
    };
    const b1 = await bill(kiwi.id, {
      amountsMode: "exclusive",
      lines: [{ description: "Year-end accounts", quantity: "1", unitPrice: "200.00", accountCode: "6010", taxCode: "GST" }],
    });
    const b4 = await bill(kiwi.id, {
      amountsMode: "exclusive",
      lines: [
        { description: "Standard", quantity: "1", unitPrice: "100.00", accountCode: "6010", taxCode: "GST" },
        { description: "Exempt", quantity: "1", unitPrice: "20.00", accountCode: "6010", taxCode: "EXEMPT" },
      ],
    });
    const rataBill = await bill(rata.id, { amountsMode: "no_tax", lines: [{ description: "Cartage", quantity: "1", unitPrice: "60.00", accountCode: "6010" }] });

    /** Receives a payment for several invoices on 15 May 2026 into 1000 unless told otherwise. */
    const receive = (amount: string, documents: Array<{ id: string; amount: string }>, fields: Record<string, unknown> = {}) =>
      as((tx) =>
        recordPaymentBatch(tx, "customer", {
          idempotencyKey: key("receive"),
          paymentDate: "2026-05-15",
          amount,
          bankAccountCode: "1000",
          documents,
          ...fields,
        }),
      );
    const payBills = (amount: string, documents: Array<{ id: string; amount: string }>, fields: Record<string, unknown> = {}) =>
      as((tx) =>
        recordPaymentBatch(tx, "supplier", {
          idempotencyKey: key("pay-bills"),
          paymentDate: "2026-05-15",
          amount,
          bankAccountCode: "1000",
          documents,
          ...fields,
        }),
      );
    const voidBatch = (kind: "customer" | "supplier", batchId: string, voidDate = "2026-05-20", idempotencyKey = key("void")) =>
      as((tx) => voidPaymentBatch(tx, kind, batchId, { idempotencyKey, voidDate }));
    const lines = async (journalId: string) =>
      (await as((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount, line.description]);
    const due = async (invoiceId: string) => {
      const found = await as((tx) => getInvoice(tx, invoiceId));
      return [found.amountDue, found.paidStatus];
    };
    const billDue = async (billId: string) => {
      const found = await as((tx) => getBill(tx, billId));
      return [found.amountDue, found.paidStatus];
    };
    const journalCount = async () =>
      Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    return { org, as, kobe, rex, kiwi, rata, i1, i2, i3, b1, b4, rataBill, invoice, noTax, bill, receive, payBills, voidBatch, lines, due, billDue, journalCount };
  }

  it("MP1: one journal, one bank line for 195.00, one receivable line per invoice; both invoices paid", async () => {
    const w = await setup();
    const { created, batch } = await w.receive("195.00", [
      { id: w.i1.id, amount: "115.00" },
      { id: w.i2.id, amount: "80.00" },
    ]);
    expect(created).toBe(true);
    expect(batch).toMatchObject({ status: "active", contactName: "Kobe Ltd", paymentDate: "2026-05-15", amount: "195.00", overpaymentAmount: "0.00" });
    expect(batch.parts.map((part) => [part.documentNumber, part.amount])).toEqual([
      ["INV-0001", "115.00"],
      ["INV-0002", "80.00"],
    ]);
    expect(await w.lines(batch.journalId)).toEqual([
      ["1000", "195.00", "0.00", "Kobe Ltd"],
      ["1100", "0.00", "115.00", "Kobe Ltd · INV-0001"],
      ["1100", "0.00", "80.00", "Kobe Ltd · INV-0002"],
    ]);
    expect(await w.due(w.i1.id)).toEqual(["0.00", "paid"]);
    expect(await w.due(w.i2.id)).toEqual(["0.00", "paid"]);
    const payments = await w.as((tx) => listPayments(tx, w.i2.id));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount: "80.00", paymentDate: "2026-05-15", journalId: batch.journalId, batchId: batch.id });
  });

  it("MP2: a part payment of INV-0002 leaves 40.00 due", async () => {
    const w = await setup();
    const { batch } = await w.receive("155.00", [
      { id: w.i1.id, amount: "115.00" },
      { id: w.i2.id, amount: "40.00" },
    ]);
    expect(await w.lines(batch.journalId)).toEqual([
      ["1000", "155.00", "0.00", "Kobe Ltd"],
      ["1100", "0.00", "115.00", "Kobe Ltd · INV-0001"],
      ["1100", "0.00", "40.00", "Kobe Ltd · INV-0002"],
    ]);
    expect(await w.due(w.i1.id)).toEqual(["0.00", "paid"]);
    expect(await w.due(w.i2.id)).toEqual(["40.00", "part_paid"]);
  });

  it("MP3: more received with every invoice paid in full keeps the extra as an overpayment on the last one", async () => {
    const w = await setup();
    const { batch } = await w.receive("210.00", [
      { id: w.i1.id, amount: "115.00" },
      { id: w.i2.id, amount: "80.00" },
    ]);
    expect(batch.overpaymentAmount).toBe("15.00");
    expect(batch.parts.map((part) => [part.documentNumber, part.amount, part.overpaymentAmount])).toEqual([
      ["INV-0001", "115.00", "0.00"],
      ["INV-0002", "95.00", "15.00"],
    ]);
    expect(await w.lines(batch.journalId)).toEqual([
      ["1000", "210.00", "0.00", "Kobe Ltd"],
      ["1100", "0.00", "115.00", "Kobe Ltd · INV-0001"],
      ["1100", "0.00", "95.00", "Kobe Ltd · INV-0002"],
    ]);
    const overpayment = await w.as((tx) => getOverpayment(tx, batch.parts[1].paymentId));
    expect(overpayment).toMatchObject({ invoiceAmount: "80.00", overpaymentAmount: "15.00", overpaymentRemaining: "15.00", overpaymentStatus: "open" });
    // It can be applied to another Kobe invoice, but not the one it overpaid.
    const i4 = await w.invoice(w.kobe.id, w.noTax("30.00"));
    await expect(
      w.as((tx) => applyOverpayment(tx, batch.parts[1].paymentId, { idempotencyKey: key("apply"), applicationDate: "2026-05-20", applications: [{ invoiceId: w.i2.id, amount: "5.00" }] })),
    ).rejects.toThrow();
    await w.as((tx) =>
      applyOverpayment(tx, batch.parts[1].paymentId, { idempotencyKey: key("apply"), applicationDate: "2026-05-20", applications: [{ invoiceId: i4.id, amount: "5.00" }] }),
    );
    expect(await w.due(i4.id)).toEqual(["25.00", "part_paid"]);
  });

  it("MP4: refused, and nothing is posted", async () => {
    const w = await setup();
    const batchJournals = async () =>
      Number((await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals where origin = 'customer_payment_batch'"))).rows[0].n);
    const both = (a: string, b: string) => [
      { id: w.i1.id, amount: a },
      { id: w.i2.id, amount: b },
    ];
    await expect(w.receive("150.00", both("115.00", "40.00"))).rejects.toThrow("The amounts for the invoices add up to 155.00, more than the 150.00 received.");
    await expect(w.receive("160.00", both("115.00", "40.00"))).rejects.toThrow(
      "The amounts for the invoices add up to 155.00, less than the 160.00 received. Pay every invoice in full before keeping the extra as an overpayment, or change the amounts.",
    );
    await expect(w.receive("195.01", both("115.00", "80.01"))).rejects.toThrow("The amount for invoice INV-0002 (80.01) is more than its amount due (80.00).");
    await expect(
      w.receive("165.00", [
        { id: w.i1.id, amount: "115.00" },
        { id: w.i3.id, amount: "50.00" },
      ]),
    ).rejects.toThrow("One payment can only pay invoices of one customer: INV-0003 is Rex Ltd's.");
    await expect(
      w.receive("230.00", [
        { id: w.i1.id, amount: "115.00" },
        { id: w.i1.id, amount: "115.00" },
      ]),
    ).rejects.toThrow("Each invoice can only be listed once.");
    const draft = await w.invoice(w.kobe.id, w.noTax("10.00"), false);
    await expect(w.receive("125.00", [{ id: w.i1.id, amount: "115.00" }, { id: draft.id, amount: "10.00" }])).rejects.toThrow(
      "A draft invoice can't be paid. Approve it first.",
    );
    const voided = await w.invoice(w.kobe.id, w.noTax("10.00"));
    await w.as((tx) => voidInvoice(tx, voided.id, { idempotencyKey: key("void"), voidDate: "2026-05-12" }));
    await expect(w.receive("125.00", [{ id: w.i1.id, amount: "115.00" }, { id: voided.id, amount: "10.00" }])).rejects.toThrow(/has been voided/);
    await expect(w.receive("115.00", [])).rejects.toThrow("Choose at least one invoice to pay.");
    await expect(w.receive("195.00", both("115.00", "80.00"), { paymentDate: "2026-05-09" })).rejects.toThrow(
      "The payment date can't be before the date of invoice INV-0001 (2026-05-10).",
    );
    await expect(w.receive("115.00", both("115.00", "0.00"))).rejects.toThrow("The amount for invoice INV-0002 must be more than zero.");
    await expect(w.receive("114.00", both("115.00", "-1.00"))).rejects.toThrow();
    await expect(w.receive("116.001", both("115.00", "1.001"))).rejects.toThrow();
    expect(await batchJournals()).toBe(0);
    expect(await w.due(w.i1.id)).toEqual(["115.00", "unpaid"]);
  });

  it("MP5: voided as a whole with one reversal; one invoice's part can't be voided on its own", async () => {
    const w = await setup();
    const { batch } = await w.receive("195.00", [
      { id: w.i1.id, amount: "115.00" },
      { id: w.i2.id, amount: "80.00" },
    ]);
    await expect(
      w.as((tx) => voidPayment(tx, w.i1.id, batch.parts[0].paymentId, { idempotencyKey: key("void"), voidDate: "2026-05-20" })),
    ).rejects.toThrow("This is part of a payment for several invoices, so it can't be voided on its own: void the whole payment.");
    // The database refuses it too.
    await expect(
      w.as((tx) =>
        tx.query(
          `update customer_payments set status = 'voided', void_date = '2026-05-20', void_journal_id = journal_id,
                  void_command_source = 'x', void_idempotency_key = 'x', void_request_hash = 'x', voided_at = now()
            where id = $1`,
          [batch.parts[0].paymentId],
        ),
      ),
    ).rejects.toThrow(/void the whole payment/);
    await expect(w.voidBatch("customer", batch.id, "2026-05-14")).rejects.toThrow("The void date can't be before the payment date (2026-05-15).");
    const { batch: voided } = await w.voidBatch("customer", batch.id);
    expect(voided).toMatchObject({ status: "voided", voidDate: "2026-05-20" });
    expect(await w.lines(voided.voidJournalId!)).toEqual([
      ["1000", "0.00", "195.00", "Kobe Ltd"],
      ["1100", "115.00", "0.00", "Kobe Ltd · INV-0001"],
      ["1100", "80.00", "0.00", "Kobe Ltd · INV-0002"],
    ]);
    const reversal = await w.as((tx) => getJournal(tx, voided.voidJournalId!));
    expect(reversal.postingDate).toBe("2026-05-20");
    expect(await w.due(w.i1.id)).toEqual(["115.00", "unpaid"]);
    expect(await w.due(w.i2.id)).toEqual(["80.00", "unpaid"]);
    expect((await w.as((tx) => listPayments(tx, w.i1.id)))[0]).toMatchObject({ status: "voided", voidJournalId: voided.voidJournalId });
    await expect(w.voidBatch("customer", batch.id)).rejects.toThrow("This payment has already been voided.");
  });

  it("MP6: not voided while its overpayment is applied; after the application is removed it is", async () => {
    const w = await setup();
    const { batch } = await w.receive("210.00", [
      { id: w.i1.id, amount: "115.00" },
      { id: w.i2.id, amount: "80.00" },
    ]);
    const i4 = await w.invoice(w.kobe.id, w.noTax("30.00"));
    const applied = await w.as((tx) =>
      applyOverpayment(tx, batch.parts[1].paymentId, { idempotencyKey: key("apply"), applicationDate: "2026-05-20", applications: [{ invoiceId: i4.id, amount: "5.00" }] }),
    );
    await expect(w.voidBatch("customer", batch.id, "2026-05-21")).rejects.toThrow(/overpayment has been applied or refunded/);
    await w.as((tx) =>
      removeOverpaymentApplication(tx, batch.parts[1].paymentId, applied.applications[0].id, { idempotencyKey: key("remove"), removalDate: "2026-05-21" }),
    );
    const { batch: voided } = await w.voidBatch("customer", batch.id, "2026-05-22");
    expect(voided.status).toBe("voided");
    expect(await w.due(w.i2.id)).toEqual(["80.00", "unpaid"]);
  });

  it("MP7: an invoice with an active part can't be voided", async () => {
    const w = await setup();
    const { batch } = await w.receive("195.00", [
      { id: w.i1.id, amount: "115.00" },
      { id: w.i2.id, amount: "80.00" },
    ]);
    await expect(w.as((tx) => voidInvoice(tx, w.i2.id, { idempotencyKey: key("void"), voidDate: "2026-05-20" }))).rejects.toThrow(/void its payments first/i);
    await w.voidBatch("customer", batch.id);
    await w.as((tx) => voidInvoice(tx, w.i2.id, { idempotencyKey: key("void"), voidDate: "2026-05-21" }));
  });

  it("MP8 and SMP5: the GST return counts a payment for several documents like separate payments", async () => {
    const batched = await setup();
    const separate = await setup();
    for (const w of [batched, separate]) {
      await w.as((tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    }
    await batched.receive("195.00", [
      { id: batched.i1.id, amount: "115.00" },
      { id: batched.i2.id, amount: "80.00" },
    ]);
    await batched.payBills("365.00", [
      { id: batched.b1.id, amount: "230.00" },
      { id: batched.b4.id, amount: "135.00" },
    ]);
    const pay = (invoiceId: string, amount: string) =>
      separate.as((tx) => recordPayment(tx, invoiceId, { idempotencyKey: key("pay"), paymentDate: "2026-05-15", amount, bankAccountCode: "1000" }));
    await pay(separate.i1.id, "115.00");
    await pay(separate.i2.id, "80.00");
    const { recordSupplierPayment } = await import("@/lib/bills/payments");
    for (const [b, amount] of [
      [separate.b1, "230.00"],
      [separate.b4, "135.00"],
    ] as const) {
      await separate.as((tx) => recordSupplierPayment(tx, b.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-15", amount, bankAccountCode: "1000" }));
    }
    const may = { periodStart: "2026-05-01", periodEnd: "2026-05-31" };
    const one = await batched.as((tx) => calculateGstReturn(tx, may));
    const two = await separate.as((tx) => calculateGstReturn(tx, may));
    expect(one.boxes).toEqual(two.boxes);
    // INV-0002 (no tax) isn't in the return; INV-0001's 115.00 is, with 15.00 GST.
    expect(one.boxes).toMatchObject({ box5: "115.00", box8: "15.00" });
    // On the invoice basis nothing changes.
    for (const w of [batched, separate]) await w.as((tx) => updateOrganisationSettings(tx, { gstBasis: "invoice" }));
    expect((await batched.as((tx) => calculateGstReturn(tx, may))).boxes).toEqual((await separate.as((tx) => calculateGstReturn(tx, may))).boxes);
  });

  it("MP9 and SMP5: a statement line for the whole amount matches the one bank journal line", async () => {
    const w = await setup();
    const { batch } = await w.receive("195.00", [
      { id: w.i1.id, amount: "115.00" },
      { id: w.i2.id, amount: "80.00" },
    ]);
    const { batch: paid } = await w.payBills("365.00", [
      { id: w.b1.id, amount: "230.00" },
      { id: w.b4.id, amount: "135.00" },
    ]);
    const bank = (await w.as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    await w.as((tx) =>
      importStatementFile(tx, bank.id, {
        idempotencyKey: key("import"),
        fileName: "may.csv",
        fileBase64: b64("Date,Amount,Payee\n15/05/2026,195.00,KOBE LTD\n15/05/2026,-365.00,KIWI SUPPLIES\n"),
      }),
    );
    const statement = (await w.as((tx) => listStatementLines(tx, bank.id, { status: "all" }))).lines;
    for (const [amount, journalId, origin] of [
      ["195.00", batch.journalId, "customer_payment_batch"],
      ["-365.00", paid.journalId, "supplier_payment_batch"],
    ] as const) {
      const line = statement.find((entry) => entry.amount === amount)!;
      const suggestions = await w.as((tx) => suggestionsForLine(tx, line.id));
      const match = suggestions.matches.find((entry) => entry.journalId === journalId)!;
      expect(match).toMatchObject({ exact: true, origin });
      const { line: reconciled } = await w.as((tx) =>
        reconcileStatementLine(tx, line.id, { idempotencyKey: key("reconcile"), kind: "match", journalLineIds: [match.journalLineId] }),
      );
      expect(reconciled.status).toBe("reconciled");
    }
  });

  it("MP10: locked periods, retries and bank accounts", async () => {
    const w = await setup();
    const documents = [
      { id: w.i1.id, amount: "115.00" },
      { id: w.i2.id, amount: "80.00" },
    ];
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-05-15" }));
    await expect(w.receive("195.00", documents)).rejects.toThrow(/locked/i);
    await w.as((tx) => updatePeriodControls(tx, { lockDate: null }));
    await expect(w.receive("195.00", documents, { bankAccountCode: "1100" })).rejects.toThrow(/isn't a bank account/);

    const idempotencyKey = key("retry");
    const first = await w.receive("195.00", documents, { idempotencyKey });
    const again = await w.receive("195.00", documents, { idempotencyKey });
    expect(again.created).toBe(false);
    expect(again.batch.id).toBe(first.batch.id);
    await expect(w.receive("195.00", [documents[1], documents[0]], { idempotencyKey })).rejects.toThrow(/idempotency key/i);

    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    await expect(w.voidBatch("customer", first.batch.id, "2026-05-20")).rejects.toThrow(/locked/i);
    await w.as((tx) => updatePeriodControls(tx, { lockDate: null }));
    const voidKey = key("void-retry");
    await w.voidBatch("customer", first.batch.id, "2026-06-01", voidKey);
    expect((await w.voidBatch("customer", first.batch.id, "2026-06-01", voidKey)).created).toBe(false);
    await expect(w.voidBatch("customer", first.batch.id, "2026-06-02", voidKey)).rejects.toThrow(/idempotency key/i);
  });

  it("MP1 over HTTP: bookkeepers record and void; viewers can list but not record", async () => {
    const w = await setup();
    const cookie = await sessionCookieFor(owner);
    const body = {
      organisationId: w.org,
      idempotencyKey: key("http"),
      paymentDate: "2026-05-15",
      amount: "195.00",
      bankAccountCode: "1000",
      documents: [
        { id: w.i1.id, amount: "115.00" },
        { id: w.i2.id, amount: "80.00" },
      ],
    };
    const created = await batchesRoute.POST(apiRequest("/api/customer-payment-batches", { method: "POST", cookie, body }), noContext);
    expect(created.status).toBe(201);
    const { batch } = (await created.json()) as { batch: { id: string } };
    const viewerCookie = await sessionCookieFor(viewer);
    expect((await batchesRoute.POST(apiRequest("/api/customer-payment-batches", { method: "POST", cookie: viewerCookie, body: { ...body, idempotencyKey: key("v") } }), noContext)).status).toBe(403);
    const listed = await batchesRoute.GET(apiRequest(`/api/customer-payment-batches?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(((await listed.json()) as { batches: unknown[] }).batches).toHaveLength(1);
    const voided = await batchVoidRoute.POST(
      apiRequest(`/api/customer-payment-batches/${batch.id}/void`, { method: "POST", cookie, body: { organisationId: w.org, idempotencyKey: key("v"), voidDate: "2026-05-20" } }),
      { params: Promise.resolve({ batchId: batch.id }) },
    );
    expect(voided.status).toBe(201);
    const suppliers = await supplierBatchesRoute.GET(apiRequest(`/api/supplier-payment-batches?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(suppliers.status).toBe(200);
  });

  it("SMP1: 365.00 to Kiwi Supplies for B1 and B4: one journal with one bank line", async () => {
    const w = await setup();
    const { batch } = await w.payBills("365.00", [
      { id: w.b1.id, amount: "230.00" },
      { id: w.b4.id, amount: "135.00" },
    ]);
    expect(batch).toMatchObject({ kind: "supplier", contactName: "Kiwi Supplies", amount: "365.00" });
    expect(await w.lines(batch.journalId)).toEqual([
      ["2000", "230.00", "0.00", "Kiwi Supplies · S-1"],
      ["2000", "135.00", "0.00", "Kiwi Supplies · S-2"],
      ["1000", "0.00", "365.00", "Kiwi Supplies"],
    ]);
    expect(await w.billDue(w.b1.id)).toEqual(["0.00", "paid"]);
    expect(await w.billDue(w.b4.id)).toEqual(["0.00", "paid"]);
  });

  it("SMP2: a part payment of B4 leaves 35.00 due", async () => {
    const w = await setup();
    await w.payBills("330.00", [
      { id: w.b1.id, amount: "230.00" },
      { id: w.b4.id, amount: "100.00" },
    ]);
    expect(await w.billDue(w.b4.id)).toEqual(["35.00", "part_paid"]);
  });

  it("SMP3: refused, and nothing is posted (no supplier overpayments)", async () => {
    const w = await setup();
    const before = await w.journalCount();
    const both = (a: string, b: string) => [
      { id: w.b1.id, amount: a },
      { id: w.b4.id, amount: b },
    ];
    await expect(w.payBills("370.00", both("230.00", "135.00"))).rejects.toThrow(
      "The amounts for the bills add up to 365.00, not the 370.00 paid. Payments to suppliers can't be more than their bills' amounts due.",
    );
    await expect(w.payBills("360.00", both("230.00", "135.00"))).rejects.toThrow("The amounts for the bills add up to 365.00, more than the 360.00 paid.");
    await expect(w.payBills("365.01", both("230.00", "135.01"))).rejects.toThrow("The amount for bill S-2 (135.01) is more than its amount due (135.00).");
    await expect(w.payBills("290.00", [{ id: w.b1.id, amount: "230.00" }, { id: w.rataBill.id, amount: "60.00" }])).rejects.toThrow(
      "One payment can only pay bills of one supplier: S-3 is Rata Ltd's.",
    );
    await expect(w.payBills("460.00", [{ id: w.b1.id, amount: "230.00" }, { id: w.b1.id, amount: "230.00" }])).rejects.toThrow("Each bill can only be listed once.");
    const draft = await w.bill(w.kiwi.id, { amountsMode: "no_tax", lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountCode: "6010" }] }, false);
    await expect(w.payBills("240.00", [{ id: w.b1.id, amount: "230.00" }, { id: draft.id, amount: "10.00" }])).rejects.toThrow("A draft bill can't be paid. Approve it first.");
    await expect(w.payBills("1.00", [])).rejects.toThrow("Choose at least one bill to pay.");
    await expect(w.payBills("365.00", both("230.00", "135.00"), { paymentDate: "2026-05-09" })).rejects.toThrow(/before the date of bill S-1/);
    await expect(w.payBills("230.00", both("230.00", "0.00"))).rejects.toThrow("The amount for bill S-2 must be more than zero.");
    expect(await w.journalCount()).toBe(before);
  });

  it("SMP4: voided as a whole; one bill's part can't be voided on its own; a paid bill can't be voided", async () => {
    const w = await setup();
    const { batch } = await w.payBills("365.00", [
      { id: w.b1.id, amount: "230.00" },
      { id: w.b4.id, amount: "135.00" },
    ]);
    await expect(
      w.as((tx) => voidSupplierPayment(tx, w.b1.id, batch.parts[0].paymentId, { idempotencyKey: key("void"), voidDate: "2026-05-20" })),
    ).rejects.toThrow("This is part of a payment for several bills, so it can't be voided on its own: void the whole payment.");
    await expect(w.as((tx) => voidBill(tx, w.b1.id, { idempotencyKey: key("void"), voidDate: "2026-05-20" }))).rejects.toThrow(/void its payments first/i);
    await expect(w.voidBatch("supplier", batch.id, "2026-05-14")).rejects.toThrow(/before the payment date/);
    const { batch: voided } = await w.voidBatch("supplier", batch.id);
    expect(await w.lines(voided.voidJournalId!)).toEqual([
      ["2000", "0.00", "230.00", "Kiwi Supplies · S-1"],
      ["2000", "0.00", "135.00", "Kiwi Supplies · S-2"],
      ["1000", "365.00", "0.00", "Kiwi Supplies"],
    ]);
    expect(await w.billDue(w.b1.id)).toEqual(["230.00", "unpaid"]);
    expect(await w.billDue(w.b4.id)).toEqual(["135.00", "unpaid"]);
    await expect(w.voidBatch("supplier", batch.id)).rejects.toThrow("This payment has already been voided.");
  });

  it("SMP6: locked periods, retries and bank accounts", async () => {
    const w = await setup();
    const documents = [
      { id: w.b1.id, amount: "230.00" },
      { id: w.b4.id, amount: "135.00" },
    ];
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-05-15" }));
    await expect(w.payBills("365.00", documents)).rejects.toThrow(/locked/i);
    await w.as((tx) => updatePeriodControls(tx, { lockDate: null }));
    await expect(w.payBills("365.00", documents, { bankAccountCode: "2000" })).rejects.toThrow(/isn't a bank account/);
    const idempotencyKey = key("retry");
    const first = await w.payBills("365.00", documents, { idempotencyKey });
    expect((await w.payBills("365.00", documents, { idempotencyKey })).batch.id).toBe(first.batch.id);
    await expect(w.payBills("365.00", [documents[1], documents[0]], { idempotencyKey })).rejects.toThrow(/idempotency key/i);
  });

  it("the database keeps a batch's parts in step with it", async () => {
    const w = await setup();
    const { batch } = await w.receive("195.00", [
      { id: w.i1.id, amount: "115.00" },
      { id: w.i2.id, amount: "80.00" },
    ]);
    // Voiding the batch without its parts is refused at commit.
    await expect(
      w.as((tx) =>
        tx.query(
          `update customer_payment_batches set status = 'voided', void_date = '2026-05-20', void_journal_id = journal_id,
                  void_command_source = 'x', void_idempotency_key = 'x', void_request_hash = 'x', voided_at = now() where id = $1`,
          [batch.id],
        ),
      ),
    ).rejects.toThrow(/one part for each/);
    await expect(w.as((tx) => tx.query("delete from customer_payment_batches where id = $1", [batch.id]))).rejects.toThrow(/can't be deleted/);
  });
});

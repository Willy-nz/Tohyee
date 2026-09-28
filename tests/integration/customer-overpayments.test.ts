import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as invoiceRoute from "@/app/api/invoices/[invoiceId]/route";
import * as applicationRemoveRoute from "@/app/api/overpayments/[paymentId]/applications/[applicationId]/remove/route";
import * as applicationsRoute from "@/app/api/overpayments/[paymentId]/applications/route";
import * as refundVoidRoute from "@/app/api/overpayments/[paymentId]/refunds/[refundId]/void/route";
import * as refundsRoute from "@/app/api/overpayments/[paymentId]/refunds/route";
import * as overpaymentRoute from "@/app/api/overpayments/[paymentId]/route";
import * as overpaymentsRoute from "@/app/api/overpayments/route";
import { createAccount, updateAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact } from "@/lib/contacts/service";
import { applyCreditNote } from "@/lib/credit-notes/applications";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import {
  applyOverpayment,
  getOverpayment,
  listInvoiceOverpaymentCredit,
  listOverpaymentApplications,
  listOverpaymentRefunds,
  listOverpayments,
  type OverpaymentApplication,
  type OverpaymentRefund,
  refundOverpayment,
  removeOverpaymentApplication,
  voidOverpaymentRefund,
} from "@/lib/invoices/overpayments";
import { type CustomerPayment, getPayment, recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice, type Invoice, voidInvoice } from "@/lib/invoices/service";
import { correctJournal, getJournal, getJournalDetails, listJournals } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { createTaxCode } from "@/lib/tax/codes";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  testDatabaseUrl,
  type TestServer,
  withDb,
} from "../helpers/test-server";

const noContext = undefined as unknown;
const APR_MAY = { periodStart: "2026-04-01", periodEnd: "2026-05-31" };

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Examples OP1-OP11 in docs/ACCOUNTING-EXAMPLES.md ("Customer overpayments").
 * Each example gets its own organisation with the setup: customer Kobe Ltd
 * with INV-0001 = I1 (total 115.00) and INV-0002 = I6 (no tax, 80.00), and
 * customer Rex Ltd with INV-0003 (no tax, 50.00), all dated 10 May 2026.
 * Payments are dated 15 May 2026 into 1000 unless told otherwise.
 */
describeWithDatabase("customer overpayments", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
    outsider = await createTestUser("outsider@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  /** A new organisation with the setup, and helpers that work in it. */
  async function setup() {
    organisations += 1;
    const org = `overpay-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [
        org,
        user.id,
        role,
      ]);
    }
    const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
      inOrganisation(org, { userId: user.id, email: user.email }, work);
    await asUser(owner, (tx) =>
      createTaxCode(tx, {
        idempotencyKey: key("tax"),
        code: "GST",
        label: "GST on income (15%)",
        category: "standard",
        rate: "0.15",
        effectiveFrom: "2026-01-01",
      }),
    );
    const newCustomer = async (name: string): Promise<Contact> =>
      (await asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), name, isCustomer: true })))
        .contact;
    const kobe = await newCustomer("Kobe Ltd");
    const rex = await newCustomer("Rex Ltd");

    /** A draft invoice: I1 (2 x 50.00 at 15%) for Kobe Ltd unless told otherwise. */
    const draftInvoice = async (fields: Record<string, unknown> = {}): Promise<Invoice> =>
      (
        await asUser(bookkeeper, (tx) =>
          createInvoice(tx, {
            idempotencyKey: key("invoice"),
            contactId: kobe.id,
            invoiceDate: "2026-05-10",
            dueDate: "2026-06-20",
            amountsMode: "exclusive",
            lines: [{ description: "Consulting", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
            ...fields,
          }),
        )
      ).invoice;
    const approvedInvoice = async (fields: Record<string, unknown> = {}): Promise<Invoice> => {
      const drafted = await draftInvoice(fields);
      return (await asUser(bookkeeper, (tx) => approveInvoice(tx, drafted.id, { idempotencyKey: key("approve") }))).invoice;
    };
    const noTax = (amount: string) => ({
      amountsMode: "no_tax",
      lines: [{ description: "Workshop", quantity: "1", unitPrice: amount, accountCode: "4000" }],
    });

    const i1 = await approvedInvoice();
    const i6 = await approvedInvoice(noTax("80.00"));
    const i3 = await approvedInvoice({ contactId: rex.id, ...noTax("50.00") });

    /** Records a payment into 1000 on 15 May 2026 unless told otherwise. */
    const pay = (invoiceId: string, amount: string, fields: Record<string, unknown> = {}) =>
      asUser(bookkeeper, (tx) =>
        recordPayment(tx, invoiceId, {
          idempotencyKey: key("pay"),
          paymentDate: "2026-05-15",
          amount,
          bankAccountCode: "1000",
          ...fields,
        }),
      );
    const voidThePayment = (invoiceId: string, paymentId: string, voidDate: string, idempotencyKey = key("void-pay")) =>
      asUser(bookkeeper, (tx) => voidPayment(tx, invoiceId, paymentId, { idempotencyKey, voidDate }));
    /** Applies overpayment credit on 20 May 2026 unless told otherwise. */
    const apply = (
      paymentId: string,
      applications: Array<{ invoiceId: string; amount: unknown }>,
      fields: Record<string, unknown> = {},
    ) =>
      asUser(bookkeeper, (tx) =>
        applyOverpayment(tx, paymentId, {
          idempotencyKey: key("apply"),
          applicationDate: "2026-05-20",
          applications,
          ...fields,
        }),
      );
    const remove = (paymentId: string, applicationId: string, removalDate: string, idempotencyKey = key("remove")) =>
      asUser(bookkeeper, (tx) => removeOverpaymentApplication(tx, paymentId, applicationId, { idempotencyKey, removalDate }));
    /** Refunds from 1000 on 28 May 2026 unless told otherwise. */
    const refund = (paymentId: string, fields: Record<string, unknown>) =>
      asUser(bookkeeper, (tx) =>
        refundOverpayment(tx, paymentId, {
          idempotencyKey: key("refund"),
          refundDate: "2026-05-28",
          bankAccountCode: "1000",
          amount: "0",
          ...fields,
        }),
      );
    const voidTheRefund = (paymentId: string, refundId: string, voidDate: string, idempotencyKey = key("void-refund")) =>
      asUser(bookkeeper, (tx) => voidOverpaymentRefund(tx, paymentId, refundId, { idempotencyKey, voidDate }));
    const voidTheInvoice = (invoiceId: string, voidDate: string) =>
      asUser(bookkeeper, (tx) => voidInvoice(tx, invoiceId, { idempotencyKey: key("void-invoice"), voidDate }));
    const invoiceNow = (invoiceId: string) => asUser(viewer, (tx) => getInvoice(tx, invoiceId));
    const paymentNow = (paymentId: string) => asUser(viewer, (tx) => getPayment(tx, paymentId));
    const applicationsOf = (paymentId: string) => asUser(viewer, (tx) => listOverpaymentApplications(tx, paymentId));
    const refundsOf = (paymentId: string) => asUser(viewer, (tx) => listOverpaymentRefunds(tx, paymentId));
    const journal = (journalId: string) => asUser(owner, (tx) => getJournal(tx, journalId));
    /** A journal's lines as [account, debit, credit]. */
    const postedLines = async (journalId: string) =>
      (await journal(journalId)).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);
    const count = async (table: string) =>
      Number(
        (await asUser(owner, (tx) => tx.query<{ count: string }>(`select count(*)::text as count from ${table}`))).rows[0]
          .count,
      );
    const journalCount = () => count("ledger_journals");
    /** An account's balance (debits less credits) across every posted journal. */
    const balanceOf = async (accountCode: string) =>
      (
        await asUser(owner, (tx) =>
          tx.query<{ balance: string }>(
            `select to_char(coalesce(sum(l.debit_amount - l.credit_amount), 0), 'FM999999990.00') as balance
               from ledger_journal_lines l join accounts a on a.id = l.account_id
              where a.code = $1`,
            [accountCode],
          ),
        )
      ).rows[0].balance;
    const lock = (lockDate: string | null) => asUser(owner, (tx) => updatePeriodControls(tx, { lockDate }));
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));

    return {
      org,
      asUser,
      kobe,
      rex,
      i1,
      i6,
      i3,
      draftInvoice,
      approvedInvoice,
      noTax,
      pay,
      voidThePayment,
      apply,
      remove,
      refund,
      voidTheRefund,
      voidTheInvoice,
      invoiceNow,
      paymentNow,
      applicationsOf,
      refundsOf,
      journal,
      postedLines,
      count,
      journalCount,
      balanceOf,
      lock,
      sql,
    };
  }

  /** The setup plus example OP1: 130.00 paid against INV-0001 on 15 May 2026. */
  async function afterOp1() {
    const world = await setup();
    const { payment } = await world.pay(world.i1.id, "130.00");
    return { ...world, op1: payment };
  }

  /** The setup plus OP1 and OP2: the 15.00 overpayment applied to INV-0002 on 20 May 2026. */
  async function afterOp2() {
    const world = await afterOp1();
    const { applications } = await world.apply(world.op1.id, [{ invoiceId: world.i6.id, amount: "15.00" }]);
    return { ...world, application: applications[0] };
  }

  it("OP1: paying 130.00 against INV-0001 posts one journal Dr 1000 130.00 / Cr 1100 130.00; INV-0001 paid; 15.00 overpayment, open; Kobe's 1100 balance 65.00", async () => {
    const world = await setup();
    const journalsBefore = await world.journalCount();
    const { created, payment, invoice } = await world.pay(world.i1.id, "130.00", { reference: "Kobe transfer" });
    expect(created).toBe(true);
    expect(payment).toMatchObject({
      invoiceId: world.i1.id,
      invoiceNumber: "INV-0001",
      contactId: world.kobe.id,
      contactName: "Kobe Ltd",
      status: "active",
      paymentDate: "2026-05-15",
      amount: "130.00",
      invoiceAmount: "115.00",
      overpaymentAmount: "15.00",
      overpaymentApplied: "0.00",
      overpaymentRefunded: "0.00",
      overpaymentRemaining: "15.00",
      overpaymentStatus: "open",
    });
    expect(await world.journalCount()).toBe(journalsBefore + 1);
    expect(await world.journal(payment.journalId)).toMatchObject({ origin: "customer_payment", postingDate: "2026-05-15" });
    expect(await world.postedLines(payment.journalId)).toEqual([
      ["1000", "130.00", "0.00"],
      ["1100", "0.00", "130.00"],
    ]);
    expect(invoice).toMatchObject({ amountPaid: "115.00", amountCredited: "0.00", amountDue: "0.00", paidStatus: "paid" });
    // 1100 holds INV-0001 115.00 + INV-0002 80.00 + Rex's INV-0003 50.00 - 130.00 received = 115.00;
    // Kobe's part is 80.00 - 15.00 = 65.00.
    expect(await world.balanceOf("1100")).toBe("115.00");
    expect(await world.balanceOf("2100")).toBe("-15.00");
    const kobe = await world.sql(
      `select to_char(sum(l.debit_amount - l.credit_amount), 'FM999999990.00') as balance
         from ledger_journal_lines l
         join accounts a on a.id = l.account_id and a.code = '1100'
         join ledger_journals j on j.id = l.journal_id
        where j.id in (select approval_journal_id from sales_invoices i where i.contact_id = $1)
           or j.id in (select p.journal_id from customer_payments p join sales_invoices i on i.id = p.invoice_id
                        where i.contact_id = $1)`,
      [world.kobe.id],
    );
    expect(kobe.rows).toEqual([{ balance: "65.00" }]);
    // No overpayment when the payment is no more than the amount due.
    const exact = await world.pay(world.i6.id, "80.00");
    expect(exact.payment).toMatchObject({ amount: "80.00", invoiceAmount: "80.00", overpaymentAmount: "0.00", overpaymentStatus: null });
  });

  it("OP2: applying the 15.00 overpayment to INV-0002 posts no journal; INV-0002 65.00 due, part paid; overpayment 0.00 left, used", async () => {
    const world = await afterOp1();
    const journalsBefore = await world.journalCount();
    const { created, applications, payment } = await world.apply(world.op1.id, [{ invoiceId: world.i6.id, amount: "15.00" }]);
    expect(created).toBe(true);
    expect(applications).toEqual([
      expect.objectContaining({
        paymentId: world.op1.id,
        sourceInvoiceId: world.i1.id,
        sourceInvoiceNumber: "INV-0001",
        invoiceId: world.i6.id,
        invoiceNumber: "INV-0002",
        status: "active",
        applicationDate: "2026-05-20",
        amount: "15.00",
        currencyCode: "NZD",
        createdByEmail: bookkeeper.email,
        removalDate: null,
      }),
    ]);
    expect(await world.journalCount()).toBe(journalsBefore);
    expect(payment).toMatchObject({ overpaymentApplied: "15.00", overpaymentRemaining: "0.00", overpaymentStatus: "used" });
    expect(await world.invoiceNow(world.i6.id)).toMatchObject({
      amountPaid: "0.00",
      amountCredited: "15.00",
      amountDue: "65.00",
      paidStatus: "part_paid",
    });
    expect(await world.invoiceNow(world.i1.id)).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });
    expect(await world.applicationsOf(world.op1.id)).toEqual(applications);
    expect(await world.asUser(viewer, (tx) => listInvoiceOverpaymentCredit(tx, world.i6.id))).toEqual(applications);
    expect(await world.balanceOf("1100")).toBe("115.00");
  });

  it("OP3: paying INV-0001 50.00 then 100.00: the second pays 65.00 and overpays 35.00; INV-0001 paid", async () => {
    const world = await setup();
    const first = await world.pay(world.i1.id, "50.00");
    expect(first.payment).toMatchObject({ invoiceAmount: "50.00", overpaymentAmount: "0.00" });
    expect(first.invoice).toMatchObject({ amountDue: "65.00", paidStatus: "part_paid" });
    const second = await world.pay(world.i1.id, "100.00", { paymentDate: "2026-05-16" });
    expect(second.payment).toMatchObject({
      amount: "100.00",
      invoiceAmount: "65.00",
      overpaymentAmount: "35.00",
      overpaymentRemaining: "35.00",
      overpaymentStatus: "open",
    });
    expect(second.invoice).toMatchObject({ amountPaid: "115.00", amountDue: "0.00", paidStatus: "paid" });
    // A credit note applied first lowers what's due, so more of a payment is overpayment.
    const other = await setup();
    const creditNote = await other.asUser(bookkeeper, async (tx) => {
      const drafted = await createCreditNote(tx, {
        idempotencyKey: key("credit-note"),
        contactId: other.kobe.id,
        creditNoteDate: "2026-05-11",
        amountsMode: "no_tax",
        lines: [{ description: "Discount", quantity: "1", unitPrice: "15.00", accountCode: "4000" }],
      });
      return (await approveCreditNote(tx, drafted.creditNote.id, { idempotencyKey: key("approve-cn") })).creditNote;
    });
    await other.asUser(bookkeeper, (tx) =>
      applyCreditNote(tx, creditNote.id, {
        idempotencyKey: key("apply-cn"),
        applicationDate: "2026-05-12",
        applications: [{ invoiceId: other.i1.id, amount: "15.00" }],
      }),
    );
    const paid = await other.pay(other.i1.id, "115.00");
    expect(paid.payment).toMatchObject({ invoiceAmount: "100.00", overpaymentAmount: "15.00" });
    expect(paid.invoice).toMatchObject({ amountPaid: "100.00", amountCredited: "15.00", amountDue: "0.00", paidStatus: "paid" });
  });

  it("OP4: paying INV-0001 115.00 again after OP1 is all overpayment: credit for Kobe Ltd that can be refunded", async () => {
    const world = await afterOp1();
    const journalsBefore = await world.journalCount();
    const { payment, invoice } = await world.pay(world.i1.id, "115.00", { paymentDate: "2026-05-16" });
    expect(payment).toMatchObject({
      amount: "115.00",
      invoiceAmount: "0.00",
      overpaymentAmount: "115.00",
      overpaymentRemaining: "115.00",
      overpaymentStatus: "open",
    });
    expect(await world.postedLines(payment.journalId)).toEqual([
      ["1000", "115.00", "0.00"],
      ["1100", "0.00", "115.00"],
    ]);
    expect(invoice).toMatchObject({ amountPaid: "115.00", amountDue: "0.00", paidStatus: "paid" });
    expect(await world.journalCount()).toBe(journalsBefore + 1);
    // Refunded in full, the customer's account is back where it was.
    const { refund } = await world.refund(payment.id, { amount: "115.00" });
    expect(await world.postedLines(refund.journalId)).toEqual([
      ["1100", "115.00", "0.00"],
      ["1000", "0.00", "115.00"],
    ]);
    expect(await world.paymentNow(payment.id)).toMatchObject({ overpaymentRemaining: "0.00", overpaymentStatus: "used" });
    // INV-0001 can't be voided while it has active payments, even one that paid nothing on it.
    await expect(world.voidTheInvoice(world.i1.id, "2026-06-01")).rejects.toThrow("has payments against it");
  });

  it("OP5: over-applying, other customers, unapproved invoices, voided payments, early dates and bad amounts are refused, and nothing changes", async () => {
    const world = await afterOp1();
    const journalsBefore = await world.journalCount();
    const draftInvoice = await world.draftInvoice();
    const voided = await world.approvedInvoice(world.noTax("10.00"));
    await world.voidTheInvoice(voided.id, "2026-05-12");
    const small = await world.approvedInvoice(world.noTax("5.00"));
    const refused = async (applications: Array<{ invoiceId: string; amount: unknown }>, fields = {}) =>
      world.apply(world.op1.id, applications, fields);

    await expect(refused([{ invoiceId: world.i6.id, amount: "15.01" }])).rejects.toThrow(
      "The credit applied (15.01) is more than the overpayment left (15.00).",
    );
    await expect(
      refused([
        { invoiceId: world.i6.id, amount: "10.00" },
        { invoiceId: small.id, amount: "5.01" },
      ]),
    ).rejects.toThrow(`Application 2: 5.01 is more than the amount due on invoice ${small.invoiceNumber} (5.00).`);
    await expect(refused([{ invoiceId: world.i3.id, amount: "1.00" }])).rejects.toThrow(
      "Application 1: invoice INV-0003 is for Rex Ltd, not Kobe Ltd. An overpayment can only be applied to the same customer's invoices.",
    );
    await expect(refused([{ invoiceId: draftInvoice.id, amount: "1.00" }])).rejects.toThrow(
      `Application 1: draft invoice #${draftInvoice.id} is still a draft, so credit can't be applied to it.`,
    );
    await expect(refused([{ invoiceId: voided.id, amount: "1.00" }])).rejects.toThrow(
      `Application 1: invoice ${voided.invoiceNumber} has been voided, so credit can't be applied to it.`,
    );
    await expect(refused([{ invoiceId: world.i1.id, amount: "1.00" }])).rejects.toThrow(
      "Application 1: an overpayment can't be applied to INV-0001, the invoice it overpaid.",
    );
    await expect(refused([{ invoiceId: world.i6.id, amount: "1.00" }], { applicationDate: "2026-05-14" })).rejects.toThrow(
      "The application date can't be before the payment date (2026-05-15).",
    );
    const later = await world.approvedInvoice({ invoiceDate: "2026-05-25", ...world.noTax("10.00") });
    await expect(refused([{ invoiceId: later.id, amount: "1.00" }])).rejects.toThrow(
      `Application 1: the application date can't be before the invoice date of invoice ${later.invoiceNumber} (2026-05-25).`,
    );
    for (const [amount, message] of [
      ["0.00", "Application 1 amount must not be zero."],
      ["-1.00", "Application 1 amount can't be negative."],
      ["1.001", "Application 1 amount can have at most 2 decimal places."],
    ] as const) {
      await expect(refused([{ invoiceId: world.i6.id, amount }])).rejects.toThrow(message);
    }
    await expect(refused([])).rejects.toThrow("Apply the overpayment to at least one invoice.");
    await expect(
      refused([
        { invoiceId: world.i6.id, amount: "1.00" },
        { invoiceId: world.i6.id, amount: "1.00" },
      ]),
    ).rejects.toThrow(`Application 2 is for invoice #${world.i6.id} again.`);
    expect(await world.count("customer_overpayment_applications")).toBe(0);
    // Only the four invoice journals set up above (the voided invoice's approval and void, and two approvals).
    expect(await world.journalCount()).toBe(journalsBefore + 4);
    expect(await world.paymentNow(world.op1.id)).toMatchObject({ overpaymentRemaining: "15.00", overpaymentStatus: "open" });
    expect(await world.invoiceNow(world.i6.id)).toMatchObject({ amountDue: "80.00" });

    // A payment with no overpayment has nothing to apply or refund.
    const { payment: plain } = await world.pay(small.id, "5.00");
    await expect(world.apply(plain.id, [{ invoiceId: world.i6.id, amount: "1.00" }])).rejects.toThrow(
      `The payment of 5.00 on ${small.invoiceNumber} has no overpayment, so nothing can be applied.`,
    );
    await expect(world.refund(plain.id, { amount: "1.00" })).rejects.toThrow(
      `The payment of 5.00 on ${small.invoiceNumber} has no overpayment, so nothing can be refunded.`,
    );
    await expect(world.asUser(viewer, (tx) => getOverpayment(tx, plain.id))).rejects.toThrow("This payment has no overpayment.");

    // A voided payment's overpayment can't be applied.
    await world.voidThePayment(world.i1.id, world.op1.id, "2026-05-18");
    await expect(world.apply(world.op1.id, [{ invoiceId: world.i6.id, amount: "1.00" }])).rejects.toThrow(
      "The overpayment on INV-0001 (payment of 130.00 on 2026-05-15) was voided, so it can't be applied.",
    );
  });

  it("OP6: removing the OP2 application later posts nothing; INV-0002 80.00 due, overpayment 15.00 left; a second or early removal is refused", async () => {
    const world = await afterOp2();
    const journalsBefore = await world.journalCount();
    await expect(world.remove(world.op1.id, world.application.id, "2026-05-19")).rejects.toThrow(
      "The removal date can't be before the application date (2026-05-20).",
    );
    const { created, application, payment } = await world.remove(world.op1.id, world.application.id, "2026-05-22");
    expect(created).toBe(true);
    expect(application).toMatchObject({
      status: "removed",
      removalDate: "2026-05-22",
      removedByEmail: bookkeeper.email,
      amount: "15.00",
    });
    expect(payment).toMatchObject({ overpaymentApplied: "0.00", overpaymentRemaining: "15.00", overpaymentStatus: "open" });
    expect(await world.invoiceNow(world.i6.id)).toMatchObject({ amountCredited: "0.00", amountDue: "80.00", paidStatus: "unpaid" });
    expect(await world.journalCount()).toBe(journalsBefore);
    await expect(world.remove(world.op1.id, world.application.id, "2026-05-23")).rejects.toThrow(
      "This application has already been removed.",
    );
    await expect(world.remove(world.op1.id, "999999", "2026-05-23")).rejects.toThrow("Application not found.");
  });

  it("OP7: refunding the 15.00 from 1000 posts Dr 1100 / Cr 1000; over-refunds and wrong accounts are refused; voiding it reverses it", async () => {
    const world = await afterOp1();
    const journalsBefore = await world.journalCount();
    await expect(world.refund(world.op1.id, { amount: "15.01" })).rejects.toThrow(
      "The refund of 15.01 is more than the overpayment left (15.00).",
    );
    await expect(world.refund(world.op1.id, { amount: "15.00", bankAccountCode: "1100" })).rejects.toThrow(
      "Account 1100 (Accounts receivable) isn't a bank account, so refunds can't be paid from it.",
    );
    const oldBank = await world.asUser(owner, (tx) => createAccount(tx, { code: "1010", name: "Old bank", accountType: "bank" }));
    await world.asUser(owner, (tx) => updateAccount(tx, oldBank.id, { isActive: false }));
    await expect(world.refund(world.op1.id, { amount: "15.00", bankAccountCode: "1010" })).rejects.toThrow(
      "Account 1010 (Old bank) is archived, so refunds can't be paid from it.",
    );
    await expect(world.refund(world.op1.id, { amount: "15.00", refundDate: "2026-05-14" })).rejects.toThrow(
      "The refund date can't be before the payment date (2026-05-15).",
    );
    expect(await world.journalCount()).toBe(journalsBefore);

    const { created, refund, payment } = await world.refund(world.op1.id, { amount: "15.00", reference: "Refund Kobe" });
    expect(created).toBe(true);
    expect(refund).toMatchObject({
      paymentId: world.op1.id,
      status: "active",
      refundDate: "2026-05-28",
      amount: "15.00",
      bankAccountCode: "1000",
      reference: "Refund Kobe",
    });
    expect(await world.journal(refund.journalId)).toMatchObject({
      origin: "customer_overpayment_refund",
      postingDate: "2026-05-28",
      reference: "Refund Kobe",
    });
    expect(await world.postedLines(refund.journalId)).toEqual([
      ["1100", "15.00", "0.00"],
      ["1000", "0.00", "15.00"],
    ]);
    expect(payment).toMatchObject({ overpaymentRefunded: "15.00", overpaymentRemaining: "0.00", overpaymentStatus: "used" });
    await expect(world.refund(world.op1.id, { amount: "0.01" })).rejects.toThrow(
      "The overpayment on INV-0001 (payment of 130.00 on 2026-05-15) has no credit left.",
    );

    await expect(world.voidTheRefund(world.op1.id, refund.id, "2026-05-27")).rejects.toThrow(
      "The void date can't be before the refund date (2026-05-28).",
    );
    const voided = await world.voidTheRefund(world.op1.id, refund.id, "2026-06-02");
    expect(voided.refund).toMatchObject({ status: "voided", voidDate: "2026-06-02" });
    expect(await world.postedLines(voided.refund.voidJournalId!)).toEqual([
      ["1100", "0.00", "15.00"],
      ["1000", "15.00", "0.00"],
    ]);
    expect(await world.journal(voided.refund.voidJournalId!)).toMatchObject({
      relatedJournalId: refund.journalId,
      correctionKind: "reversal",
    });
    expect(voided.payment).toMatchObject({ overpaymentRefunded: "0.00", overpaymentRemaining: "15.00", overpaymentStatus: "open" });
    await expect(world.voidTheRefund(world.op1.id, refund.id, "2026-06-03")).rejects.toThrow(
      "This refund has already been voided.",
    );
    expect(await world.refundsOf(world.op1.id)).toEqual([voided.refund]);
  });

  it("OP8: voiding the OP1 payment while its overpayment is applied or refunded is refused; afterwards it reverses 130.00 and INV-0001 is 115.00 due; INV-0002 can't be voided while credit is applied", async () => {
    const world = await afterOp2();
    await expect(world.voidTheInvoice(world.i6.id, "2026-05-25")).rejects.toThrow(
      "Invoice INV-0002 has credit applied to it, so it can't be voided. Remove its credit first.",
    );
    await expect(world.voidThePayment(world.i1.id, world.op1.id, "2026-05-25")).rejects.toThrow(
      "This payment's overpayment has been applied or refunded, so it can't be voided. Remove its applications and void its refunds first.",
    );
    await world.remove(world.op1.id, world.application.id, "2026-05-22");
    const { refund } = await world.refund(world.op1.id, { amount: "5.00" });
    await expect(world.voidThePayment(world.i1.id, world.op1.id, "2026-05-29")).rejects.toThrow(
      "This payment's overpayment has been applied or refunded",
    );
    await world.voidTheRefund(world.op1.id, refund.id, "2026-05-29");

    const { payment, invoice } = await world.voidThePayment(world.i1.id, world.op1.id, "2026-05-30");
    expect(await world.postedLines(payment.voidJournalId!)).toEqual([
      ["1000", "0.00", "130.00"],
      ["1100", "130.00", "0.00"],
    ]);
    expect(invoice).toMatchObject({ amountPaid: "0.00", amountDue: "115.00", paidStatus: "unpaid" });
    expect(payment).toMatchObject({ status: "voided", overpaymentAmount: "15.00", overpaymentRemaining: "0.00", overpaymentStatus: null });
    await expect(world.refund(world.op1.id, { amount: "1.00", refundDate: "2026-05-31" })).rejects.toThrow(
      "was voided, so it can't be refunded.",
    );
    // Now INV-0002 has no credit and can be voided.
    expect((await world.voidTheInvoice(world.i6.id, "2026-05-31")).invoice.status).toBe("voided");
  });

  it("OP9: the GST return is the same with or without the overpayment, its application and its refund", async () => {
    const world = await setup();
    const calculate = () => world.asUser(viewer, (tx) => calculateGstReturn(tx, APR_MAY));
    const before = await calculate();
    expect(before.boxes).toMatchObject({ box10: "15.00" });
    const { payment } = await world.pay(world.i1.id, "130.00");
    await world.apply(payment.id, [{ invoiceId: world.i6.id, amount: "10.00" }]);
    await world.refund(payment.id, { amount: "5.00" });
    const after = await calculate();
    expect(after.boxes).toEqual(before.boxes);
    expect(after.lines).toEqual(before.lines);
    expect(await world.balanceOf("2100")).toBe("-15.00");
  });

  it("OP10: recording, applying, removing, refunding or voiding in a locked period is refused and nothing is posted", async () => {
    const world = await afterOp2();
    const other = await world.approvedInvoice(world.noTax("20.00"));
    const { payment } = await world.pay(other.id, "30.00", { paymentDate: "2026-05-16" });
    const { refund: small } = await world.refund(payment.id, { amount: "4.00", refundDate: "2026-05-21" });
    await world.lock("2026-05-31");
    try {
      const journalsBefore = await world.journalCount();
      const invoice = await world.approvedInvoice({ invoiceDate: "2026-06-01", ...world.noTax("10.00") });
      await expect(world.pay(world.i6.id, "70.00", { paymentDate: "2026-05-31" })).rejects.toThrow(
        /2026-05-31 is in a locked period/,
      );
      await expect(world.apply(payment.id, [{ invoiceId: world.i6.id, amount: "1.00" }], { applicationDate: "2026-05-30" })).rejects.toThrow(
        /2026-05-30 is in a locked period/,
      );
      await expect(world.remove(world.op1.id, world.application.id, "2026-05-25")).rejects.toThrow(
        /2026-05-25 is in a locked period/,
      );
      await expect(world.refund(payment.id, { amount: "1.00", refundDate: "2026-05-30" })).rejects.toThrow(
        /2026-05-30 is in a locked period/,
      );
      await expect(world.voidTheRefund(payment.id, small.id, "2026-05-30")).rejects.toThrow(
        /2026-05-30 is in a locked period/,
      );
      expect(await world.journalCount()).toBe(journalsBefore + 1);
      expect(await world.count("customer_overpayment_applications")).toBe(1);
      expect(await world.refundsOf(payment.id)).toEqual([small]);

      // After the lock date, it all works again.
      await world.apply(payment.id, [{ invoiceId: invoice.id, amount: "1.00" }], { applicationDate: "2026-06-01" });
      await world.remove(world.op1.id, world.application.id, "2026-06-01");
      await world.voidTheRefund(payment.id, small.id, "2026-06-01");
    } finally {
      await world.lock(null);
    }
  });

  it("OP11: retrying record, apply, remove, refund or void with the same key and content returns the same result; the same key with different content is refused", async () => {
    const world = await setup();
    const payKey = key("pay");
    const first = await world.pay(world.i1.id, "130.00", { idempotencyKey: payKey });
    expect(await world.pay(world.i1.id, "130.00", { idempotencyKey: payKey })).toEqual({ ...first, created: false });
    await expect(world.pay(world.i1.id, "131.00", { idempotencyKey: payKey })).rejects.toThrow(
      "That idempotency key was already used for a different payment.",
    );
    const paymentId = first.payment.id;

    const applyKey = key("apply");
    const applied = await world.apply(paymentId, [{ invoiceId: world.i6.id, amount: "10.00" }], { idempotencyKey: applyKey });
    expect(await world.apply(paymentId, [{ invoiceId: world.i6.id, amount: "10.00" }], { idempotencyKey: applyKey })).toEqual({
      ...applied,
      created: false,
      payment: await world.paymentNow(paymentId),
    });
    await expect(
      world.apply(paymentId, [{ invoiceId: world.i6.id, amount: "9.00" }], { idempotencyKey: applyKey }),
    ).rejects.toThrow("That idempotency key was already used for a different overpayment application.");

    const removeKey = key("remove");
    const removed = await world.remove(paymentId, applied.applications[0].id, "2026-05-21", removeKey);
    expect(await world.remove(paymentId, applied.applications[0].id, "2026-05-21", removeKey)).toEqual({
      ...removed,
      created: false,
    });
    await expect(world.remove(paymentId, applied.applications[0].id, "2026-05-22", removeKey)).rejects.toThrow(
      "That idempotency key was already used for a different application removal.",
    );

    const refundKey = key("refund");
    const refunded = await world.refund(paymentId, { amount: "3.00", idempotencyKey: refundKey });
    const journalsAfterRefund = await world.journalCount();
    expect(await world.refund(paymentId, { amount: "3.00", idempotencyKey: refundKey })).toEqual({ ...refunded, created: false });
    await expect(world.refund(paymentId, { amount: "4.00", idempotencyKey: refundKey })).rejects.toThrow(
      "That idempotency key was already used for a different refund.",
    );
    const voidKey = key("void-refund");
    const voided = await world.voidTheRefund(paymentId, refunded.refund.id, "2026-05-29", voidKey);
    expect(await world.voidTheRefund(paymentId, refunded.refund.id, "2026-05-29", voidKey)).toEqual({ ...voided, created: false });
    await expect(world.voidTheRefund(paymentId, refunded.refund.id, "2026-05-30", voidKey)).rejects.toThrow(
      "That idempotency key was already used for a different refund void.",
    );
    expect(await world.journalCount()).toBe(journalsAfterRefund + 1);
  });

  it("OP2, OP7: two commands at once can't both use the same overpayment", async () => {
    const world = await afterOp1();
    const other = await world.approvedInvoice(world.noTax("40.00"));
    const results = await Promise.allSettled([
      world.apply(world.op1.id, [{ invoiceId: world.i6.id, amount: "12.00" }]),
      world.apply(world.op1.id, [{ invoiceId: other.id, amount: "12.00" }]),
      world.refund(world.op1.id, { amount: "12.00" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      expect(String((result as PromiseRejectedResult).reason)).toMatch(/more than the overpayment left \(3\.00\)/);
    }
    expect(await world.paymentNow(world.op1.id)).toMatchObject({ overpaymentRemaining: "3.00", overpaymentStatus: "part_used" });
  });

  it("overpayments are listed by customer, and refund journals are their own kind and can't be corrected in the ledger", async () => {
    const world = await afterOp1();
    const { payment: rexPayment } = await world.pay(world.i3.id, "60.00");
    const list = (filters: Record<string, unknown>) =>
      world.asUser(viewer, async (tx) => (await listOverpayments(tx, filters)).map((entry) => entry.id));
    expect(await list({})).toEqual([rexPayment.id, world.op1.id].sort((a, b) => Number(b) - Number(a)));
    expect(await list({ contactId: world.kobe.id })).toEqual([world.op1.id]);
    expect(await list({ contactId: world.rex.id, hasRemainingCredit: "true" })).toEqual([rexPayment.id]);
    await world.refund(rexPayment.id, { amount: "10.00" });
    expect(await list({ contactId: world.rex.id, hasRemainingCredit: "true" })).toEqual([]);
    expect(await list({ contactId: world.rex.id })).toEqual([rexPayment.id]);

    const { refund } = await world.refund(world.op1.id, { amount: "2.00" });
    const kinds = await world.asUser(viewer, async (tx) =>
      (await listJournals(tx, { kind: "customer_overpayment_refund" })).journals.map((entry) => entry.id),
    );
    expect(kinds.sort()).toEqual(
      [refund.journalId, (await world.refundsOf(rexPayment.id))[0].journalId].sort(),
    );
    expect((await world.asUser(viewer, (tx) => getJournalDetails(tx, refund.journalId))).canCorrect).toBe(false);
    await expect(
      world.asUser(bookkeeper, (tx) =>
        correctJournal(tx, {
          idempotencyKey: key("fix"),
          originalJournalId: refund.journalId,
          postingDate: "2026-06-01",
          reference: "FIX",
          lines: [
            { accountCode: "1000", debitAmount: "2" },
            { accountCode: "1100", creditAmount: "2" },
          ],
        }),
      ),
    ).rejects.toThrow(/was posted by a refund of a customer overpayment \(INV-0001\), so it can't be corrected in the ledger/);
  });

  it("the database refuses wrong overpayment splits, over-applying or over-refunding, applications across customers or to the overpaid invoice, and edits to applications and refunds", async () => {
    const world = await afterOp2();
    const insertPayment = (invoiceId: string, amount: string, overpayment: string) =>
      world.sql(
        `insert into customer_payments (command_source, idempotency_key, request_hash, invoice_id, payment_date, amount,
                                        overpayment_amount, currency_code, bank_account_id, journal_id)
         select 'sql', $1, 'h', $2, '2026-05-22', $3::numeric, $4::numeric, 'NZD', bank_account_id, journal_id
           from customer_payments limit 1`,
        [key("sql"), invoiceId, amount, overpayment],
      );
    // INV-0002 has 65.00 due: paying 70.00 must record 5.00 overpaid.
    await expect(insertPayment(world.i6.id, "70.00", "0")).rejects.toThrow(
      "The overpayment on a payment against invoice INV-0002 must be what it pays beyond the amount due (65.00)",
    );
    await expect(insertPayment(world.i6.id, "70.00", "4.00")).rejects.toThrow("must be what it pays beyond");
    await expect(insertPayment(world.i6.id, "10.00", "11.00")).rejects.toThrow("must be what it pays beyond");
    await expect(insertPayment(world.i1.id, "1.00", "0.50")).rejects.toThrow("must be what it pays beyond the amount due (0.00)");

    const insertApplication = (paymentId: string, invoiceId: string, amount: string, date = "2026-05-22", status = "active") =>
      world.sql(
        `insert into customer_overpayment_applications (command_source, idempotency_key, request_hash, status, payment_id,
                                                        invoice_id, application_date, amount, currency_code)
         values ('sql', $1, 'h', $2, $3, $4, $5, $6::numeric, 'NZD')`,
        [key("sql"), status, paymentId, invoiceId, date, amount],
      );
    const { payment: second } = await world.pay(world.i6.id, "70.00", { paymentDate: "2026-05-21" });
    expect(second).toMatchObject({ invoiceAmount: "65.00", overpaymentAmount: "5.00" });
    const fresh = await world.approvedInvoice(world.noTax("30.00"));
    await expect(insertApplication(world.op1.id, fresh.id, "0.01")).rejects.toThrow(
      "Overpayment applied and refunded can't add up to more than the overpayment",
    );
    await expect(insertApplication(second.id, world.i3.id, "1.00")).rejects.toThrow(
      "Credit can only be applied to invoices of the same customer",
    );
    await expect(insertApplication(second.id, world.i6.id, "1.00")).rejects.toThrow(
      "An overpayment can't be applied to the invoice it overpaid",
    );
    await expect(insertApplication(second.id, fresh.id, "1.00", "2026-05-20")).rejects.toThrow(
      "An application can't be dated before its payment or invoice",
    );
    await expect(insertApplication(second.id, fresh.id, "1.00", "2026-05-22", "removed")).rejects.toThrow(
      "An application is recorded as active and removed afterwards",
    );
    const small = await world.approvedInvoice(world.noTax("2.00"));
    await expect(insertApplication(second.id, small.id, "2.01")).rejects.toThrow(
      `Payments and credit applied to invoice ${small.invoiceNumber} can't add up to more than its total`,
    );

    await expect(world.sql("update customer_overpayment_applications set amount = 1 where id = $1", [world.application.id])).rejects.toThrow(
      "Overpayment applications can't be changed, only removed once",
    );
    await expect(world.sql("delete from customer_overpayment_applications where id = $1", [world.application.id])).rejects.toThrow(
      "Overpayment applications can't be deleted; remove them instead",
    );
    await expect(world.sql("truncate customer_overpayment_applications")).rejects.toThrow(
      "customer_overpayment_applications can't be truncated",
    );

    const { refund } = await world.refund(second.id, { amount: "5.00" });
    const insertRefund = (paymentId: string, amount: string) =>
      world.sql(
        `insert into customer_overpayment_refunds (command_source, idempotency_key, request_hash, payment_id, refund_date,
                                                   amount, currency_code, bank_account_id, journal_id)
         select 'sql', $1, 'h', $2, '2026-05-29', $3::numeric, 'NZD', bank_account_id, void_journal_id
           from customer_payments where void_journal_id is not null limit 1`,
        [key("sql"), paymentId, amount],
      );
    await world.voidThePayment(fresh.id, (await world.pay(fresh.id, "1.00")).payment.id, "2026-05-23");
    await expect(insertRefund(second.id, "0.01")).rejects.toThrow(
      "Overpayment applied and refunded can't add up to more than the overpayment",
    );
    await expect(world.sql("update customer_overpayment_refunds set amount = 1 where id = $1", [refund.id])).rejects.toThrow(
      "Overpayment refunds can't be changed, only voided once",
    );
    await expect(world.sql("delete from customer_overpayment_refunds where id = $1", [refund.id])).rejects.toThrow(
      "Overpayment refunds can't be deleted; void them instead",
    );

    // A payment whose overpayment is used can't be voided, and its split can't be edited.
    await expect(
      world.sql(
        `update customer_payments set status = 'voided', void_date = '2026-05-30', void_journal_id = journal_id,
                void_command_source = 'sql', void_idempotency_key = 'k', void_request_hash = 'h', voided_at = now()
          where id = $1`,
        [second.id],
      ),
    ).rejects.toThrow("This payment's overpayment has been applied or refunded, so it can't be voided");
    await expect(world.sql("update customer_payments set overpayment_amount = 0 where id = $1", [world.op1.id])).rejects.toThrow(
      "Customer payments can't be changed, only voided once",
    );
    // An invoice with overpayment credit applied can't be voided.
    await expect(
      world.sql("update sales_invoices set status = 'voided' where id = $1", [world.i6.id]),
    ).rejects.toThrow("has credit applied to it, so it can't be voided");
  });

  it("migration 0010 upgrades an organisation database on 0009, keeping its payments with no overpayment", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_overpayments`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();

    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      const before = tenantMigrations.filter((migration) => migration.version < "0010");
      expect((await applyMigrations(client, before, "test:upgrade")).applied).toContain("0009");
      await client.query(
        `insert into organisation_settings (organisation_id, display_name, base_currency) values ('upgrade-co', 'Upgrade Co', 'NZD')`,
      );
      const upgraded = await applyMigrations(client, tenantMigrations, "test:upgrade");
      expect(upgraded.applied).toEqual(["0010"]);
      expect((await client.query("select display_name from organisation_settings")).rows).toEqual([
        { display_name: "Upgrade Co" },
      ]);
      const column = await client.query(
        `select column_default, is_nullable from information_schema.columns
          where table_name = 'customer_payments' and column_name = 'overpayment_amount'`,
      );
      expect(column.rows).toEqual([{ column_default: "0", is_nullable: "NO" }]);
      for (const table of ["customer_overpayment_applications", "customer_overpayment_refunds"]) {
        expect((await client.query(`select count(*)::int as count from ${table}`)).rows).toEqual([{ count: 0 }]);
      }
      const origin = await client.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'ledger_journals_origin_check'",
      );
      expect(origin.rows[0].definition).toContain("'customer_overpayment_refund'");
      expect(origin.rows[0].definition).toContain("'supplier_credit_note_refund'");
    } finally {
      await client.end();
    }
  });

  it("OP11: over HTTP viewers read, bookkeepers apply, remove, refund and void; retries are 200 and a reused key is 409; outsiders get 404", async () => {
    const world = await afterOp1();
    const org = world.org;
    const paymentId = world.op1.id;
    const [bookkeeperCookie, viewerCookie, outsiderCookie] = await Promise.all(
      [bookkeeper, viewer, outsider].map((user) => sessionCookieFor(user)),
    );
    const post = (cookie: string, path: string, fields: Record<string, unknown>) =>
      apiRequest(path, { method: "POST", cookie, body: { organisationId: org, ...fields } });
    const context = params({ paymentId });

    const listed = await overpaymentsRoute.GET(
      apiRequest(`/api/overpayments?organisationId=${org}&contactId=${world.kobe.id}&hasRemainingCredit=true`, {
        cookie: viewerCookie,
      }),
      noContext,
    );
    expect(listed.status).toBe(200);
    expect(((await body(listed)).overpayments as CustomerPayment[]).map((entry) => entry.id)).toEqual([paymentId]);
    expect(
      (await overpaymentsRoute.GET(apiRequest(`/api/overpayments?organisationId=${org}`, { cookie: outsiderCookie }), noContext))
        .status,
    ).toBe(404);
    const read = await overpaymentRoute.GET(
      apiRequest(`/api/overpayments/${paymentId}?organisationId=${org}`, { cookie: viewerCookie }),
      context,
    );
    expect(read.status).toBe(200);
    expect((await body(read)).payment).toMatchObject({ id: paymentId, overpaymentAmount: "15.00", overpaymentRemaining: "15.00" });

    const applyBody = {
      idempotencyKey: key("http-apply"),
      applicationDate: "2026-05-20",
      applications: [{ invoiceId: world.i6.id, amount: "10.00" }],
    };
    const applyOver = (cookie: string, fields = applyBody) =>
      applicationsRoute.POST(post(cookie, `/api/overpayments/${paymentId}/applications`, fields), context);
    expect((await applyOver(viewerCookie)).status).toBe(403);
    expect((await applyOver(outsiderCookie)).status).toBe(404);
    const applied = await applyOver(bookkeeperCookie);
    expect(applied.status).toBe(201);
    const application = ((await body(applied)).applications as OverpaymentApplication[])[0];
    expect((await applyOver(bookkeeperCookie)).status).toBe(200);
    expect(
      (await applyOver(bookkeeperCookie, { ...applyBody, applications: [{ invoiceId: world.i6.id, amount: "9.00" }] })).status,
    ).toBe(409);
    const tooMuch = await applyOver(bookkeeperCookie, {
      ...applyBody,
      idempotencyKey: key("http-apply"),
      applications: [{ invoiceId: world.i6.id, amount: "5.01" }],
    });
    expect(tooMuch.status).toBe(400);
    expect((await body(tooMuch)).error).toMatch(/overpayment left \(5\.00\)/);
    const listedApplications = await applicationsRoute.GET(
      apiRequest(`/api/overpayments/${paymentId}/applications?organisationId=${org}`, { cookie: viewerCookie }),
      context,
    );
    expect(await body(listedApplications)).toEqual({ applications: [application] });

    // The invoice shows the overpayment credit applied to it.
    const invoiceOver = await invoiceRoute.GET(
      apiRequest(`/api/invoices/${world.i6.id}?organisationId=${org}`, { cookie: viewerCookie }),
      params({ invoiceId: world.i6.id }),
    );
    expect(await body(invoiceOver)).toMatchObject({
      invoice: { id: world.i6.id, amountCredited: "10.00", amountDue: "70.00" },
      creditApplied: [],
      overpaymentCreditApplied: [{ sourceInvoiceNumber: "INV-0001", amount: "10.00", status: "active" }],
    });

    const removeOver = (cookie: string, idempotencyKey: string) =>
      applicationRemoveRoute.POST(
        post(cookie, `/api/overpayments/${paymentId}/applications/${application.id}/remove`, {
          idempotencyKey,
          removalDate: "2026-05-22",
        }),
        params({ paymentId, applicationId: application.id }),
      );
    const removeKey = key("http-remove");
    expect((await removeOver(viewerCookie, removeKey)).status).toBe(403);
    expect((await removeOver(bookkeeperCookie, removeKey)).status).toBe(201);
    expect((await removeOver(bookkeeperCookie, removeKey)).status).toBe(200);
    expect((await removeOver(bookkeeperCookie, key("http-remove"))).status).toBe(409);

    const refundBody = { idempotencyKey: key("http-refund"), refundDate: "2026-05-28", amount: "15.00", bankAccountCode: "1000" };
    const refundOver = (cookie: string) =>
      refundsRoute.POST(post(cookie, `/api/overpayments/${paymentId}/refunds`, refundBody), context);
    expect((await refundOver(viewerCookie)).status).toBe(403);
    const refunded = await refundOver(bookkeeperCookie);
    expect(refunded.status).toBe(201);
    const refund = (await body(refunded)).refund as OverpaymentRefund;
    expect((await refundOver(bookkeeperCookie)).status).toBe(200);
    const listedRefunds = await refundsRoute.GET(
      apiRequest(`/api/overpayments/${paymentId}/refunds?organisationId=${org}`, { cookie: viewerCookie }),
      context,
    );
    expect(await body(listedRefunds)).toEqual({ refunds: [refund] });

    const voidOver = (cookie: string, idempotencyKey: string) =>
      refundVoidRoute.POST(
        post(cookie, `/api/overpayments/${paymentId}/refunds/${refund.id}/void`, { idempotencyKey, voidDate: "2026-06-01" }),
        params({ paymentId, refundId: refund.id }),
      );
    const voidKey = key("http-void");
    expect((await voidOver(viewerCookie, voidKey)).status).toBe(403);
    expect((await voidOver(bookkeeperCookie, voidKey)).status).toBe(201);
    expect((await voidOver(bookkeeperCookie, voidKey)).status).toBe(200);
    expect((await voidOver(bookkeeperCookie, key("http-void"))).status).toBe(409);
  });
});

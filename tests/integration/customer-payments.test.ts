import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as paymentVoidRoute from "@/app/api/invoices/[invoiceId]/payments/[paymentId]/void/route";
import * as paymentsRoute from "@/app/api/invoices/[invoiceId]/payments/route";
import * as invoicesRoute from "@/app/api/invoices/route";
import { createAccount, updateAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact } from "@/lib/contacts/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { type CustomerPayment, listPayments, recordPayment, voidPayment } from "@/lib/invoices/payments";
import {
  approveInvoice,
  createInvoice,
  getInvoice,
  type Invoice,
  type InvoiceSummary,
  listInvoices,
  voidInvoice,
} from "@/lib/invoices/service";
import { correctJournal, getJournal, getJournalDetails, listJournals } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
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
  waitForLockWaiters,
  withDb,
} from "../helpers/test-server";

const ORG = "payments-co";
const noContext = undefined as unknown;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/** Examples CP1-CP8 in docs/ACCOUNTING-EXAMPLES.md ("Customer payments"). */
describeWithDatabase("customer payments", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let customer: Contact;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  /** Saves a draft of example I1: 2 x $50.00 at 15% exclusive, total 115.00, dated 10 May 2026. */
  const draft = async (): Promise<Invoice> =>
    (
      await asUser(bookkeeper, (tx) =>
        createInvoice(tx, {
          idempotencyKey: key("invoice"),
          contactId: customer.id,
          invoiceDate: "2026-05-10",
          dueDate: "2026-06-20",
          amountsMode: "exclusive",
          lines: [{ description: "Consulting", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
        }),
      )
    ).invoice;
  /** An approved copy of example I1, with 115.00 due. */
  const approved = async (): Promise<Invoice> => {
    const saved = await draft();
    return (await asUser(bookkeeper, (tx) => approveInvoice(tx, saved.id, { idempotencyKey: key("approve") }))).invoice;
  };
  /** Pays 115.00 into 1000 on 20 May 2026 unless told otherwise. */
  const pay = (invoiceId: string, fields: Record<string, unknown> = {}) =>
    asUser(bookkeeper, (tx) =>
      recordPayment(tx, invoiceId, {
        idempotencyKey: key("pay"),
        paymentDate: "2026-05-20",
        amount: "115.00",
        bankAccountCode: "1000",
        ...fields,
      }),
    );
  const voidPay = (invoiceId: string, paymentId: string, voidDate: string, idempotencyKey = key("void-pay")) =>
    asUser(bookkeeper, (tx) => voidPayment(tx, invoiceId, paymentId, { idempotencyKey, voidDate }));
  const voidTheInvoice = (invoiceId: string, voidDate: string, idempotencyKey = key("void")) =>
    asUser(bookkeeper, (tx) => voidInvoice(tx, invoiceId, { idempotencyKey, voidDate }));
  const paymentsOf = (invoiceId: string) => asUser(viewer, (tx) => listPayments(tx, invoiceId));
  const invoiceNow = (invoiceId: string) => asUser(viewer, (tx) => getInvoice(tx, invoiceId));
  const listed = async (invoiceId: string): Promise<InvoiceSummary | undefined> =>
    (await asUser(viewer, (tx) => listInvoices(tx))).invoices.find((entry) => entry.id === invoiceId);
  const journal = (journalId: string) => asUser(owner, (tx) => getJournal(tx, journalId));
  /** A journal's lines as [account, debit, credit]. */
  const postedLines = async (journalId: string) =>
    (await journal(journalId)).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);
  const journalCount = async () =>
    Number(
      (await asUser(owner, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals")))
        .rows[0].count,
    );

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
    outsider = await createTestUser("outsider@example.com");
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [
        ORG,
        user.id,
        role,
      ]);
    }
    customer = (
      await asUser(bookkeeper, (tx) =>
        createContact(tx, { idempotencyKey: key("contact"), name: "Aroha Café Ltd", isCustomer: true }),
      )
    ).contact;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("CP1: paying INV-0001 (115.00) into 1000 posts Dr 1000 115.00 / Cr 1100 115.00 on the payment date; 0.00 due, paid", async () => {
    const invoice = await approved();
    expect(invoice).toMatchObject({
      invoiceNumber: "INV-0001",
      total: "115.00",
      amountPaid: "0.00",
      amountDue: "115.00",
      paidStatus: "unpaid",
    });

    const { created, payment, invoice: paid } = await pay(invoice.id, { reference: "Aroha 4471" });
    expect(created).toBe(true);
    expect(payment).toMatchObject({
      invoiceId: invoice.id,
      invoiceNumber: "INV-0001",
      status: "active",
      paymentDate: "2026-05-20",
      amount: "115.00",
      currencyCode: "NZD",
      bankAccountCode: "1000",
      bankAccountName: "Business bank account",
      reference: "Aroha 4471",
      createdByEmail: bookkeeper.email,
      voidDate: null,
      voidJournalId: null,
      voidedByEmail: null,
    });
    expect(paid).toMatchObject({ id: invoice.id, status: "approved", amountPaid: "115.00", amountDue: "0.00", paidStatus: "paid" });
    expect(await invoiceNow(invoice.id)).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });

    expect(await journal(payment.journalId)).toMatchObject({
      origin: "customer_payment",
      postingDate: "2026-05-20",
      reference: "Aroha 4471",
      description: "Payment from Aroha Café Ltd for INV-0001",
      currencyCode: "NZD",
      relatedJournalId: null,
      correctionKind: null,
      totalDebit: "115.00",
      createdByEmail: bookkeeper.email,
    });
    expect(await postedLines(payment.journalId)).toEqual([
      ["1000", "115.00", "0.00"],
      ["1100", "0.00", "115.00"],
    ]);
    expect(await paymentsOf(invoice.id)).toEqual([payment]);

    const audit = await asUser(owner, (tx) =>
      tx.query<{ entity_id: string; actor_email: string; details: Record<string, unknown> }>(
        "select entity_id, actor_email, details from audit_events where event_type = 'customer_payment.recorded'",
      ),
    );
    expect(audit.rows).toEqual([
      {
        entity_id: payment.id,
        actor_email: bookkeeper.email,
        details: expect.objectContaining({ invoiceNumber: "INV-0001", amount: "115.00", journalId: payment.journalId }),
      },
    ]);
  });

  it("CP2: paid 50.00 then 65.00, it's 65.00 due and part paid after the first, and 0.00 due and paid after the second", async () => {
    const invoice = await approved();
    const first = await pay(invoice.id, { amount: "50.00" });
    expect(first.invoice).toMatchObject({ amountPaid: "50.00", amountDue: "65.00", paidStatus: "part_paid" });
    expect(await listed(invoice.id)).toMatchObject({ amountDue: "65.00", paidStatus: "part_paid" });

    const second = await pay(invoice.id, { amount: "65.00", paymentDate: "2026-05-25" });
    expect(second.invoice).toMatchObject({ amountPaid: "115.00", amountDue: "0.00", paidStatus: "paid" });
    expect(await listed(invoice.id)).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });
    expect(await postedLines(second.payment.journalId)).toEqual([
      ["1000", "65.00", "0.00"],
      ["1100", "0.00", "65.00"],
    ]);
    expect((await journal(second.payment.journalId)).postingDate).toBe("2026-05-25");
    expect((await paymentsOf(invoice.id)).map((entry) => [entry.paymentDate, entry.amount, entry.status])).toEqual([
      ["2026-05-20", "50.00", "active"],
      ["2026-05-25", "65.00", "active"],
    ]);
  });

  it("CP3: payments against drafts, voided or paid invoices, and amounts that aren't positive with at most 2 decimal places are refused", async () => {
    const invoice = await approved();
    const journalsBefore = await journalCount();
    await expect(pay(invoice.id, { amount: "0" })).rejects.toThrow("amount must not be zero.");
    await expect(pay(invoice.id, { amount: "0.00" })).rejects.toThrow("amount must not be zero.");
    await expect(pay(invoice.id, { amount: "-5.00" })).rejects.toThrow("amount can't be negative.");
    await expect(pay(invoice.id, { amount: "10.001" })).rejects.toThrow("amount can have at most 2 decimal places.");
    await expect(pay(invoice.id, { amount: "ten" })).rejects.toThrow("amount must be a plain number like 12.34.");
    await expect(pay(invoice.id, { amount: null })).rejects.toThrow("amount must be a number.");
    expect(await journalCount()).toBe(journalsBefore);
    expect(await paymentsOf(invoice.id)).toEqual([]);

    // Paying exactly what's due is fine, to the cent; after that nothing more can be paid (OP4).
    // Paying more than what's due is an overpayment: see customer-overpayments.test.ts.
    await pay(invoice.id, { amount: "100.00" });
    expect((await pay(invoice.id, { amount: "15" })).invoice).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });
    // Another payment after that is all overpayment (OP4).
    expect((await pay(invoice.id, { amount: "0.01" })).payment).toMatchObject({ invoiceAmount: "0.00", overpaymentAmount: "0.01" });

    const drafted = await draft();
    const voided = await approved();
    await voidTheInvoice(voided.id, "2026-05-15");
    const journalsNow = await journalCount();
    await expect(pay(drafted.id)).rejects.toThrow("This invoice is still a draft, so it can't be paid. Approve it first.");
    await expect(pay(voided.id)).rejects.toThrow(`Invoice ${voided.invoiceNumber} has been voided, so it can't be paid.`);
    await expect(pay("999999")).rejects.toThrow("Invoice not found.");
    expect(await journalCount()).toBe(journalsNow);
    expect(await invoiceNow(drafted.id)).toMatchObject({ status: "draft", amountPaid: "0.00", amountDue: null, paidStatus: null });
    expect(await invoiceNow(voided.id)).toMatchObject({ status: "voided", amountPaid: "0.00", amountDue: null, paidStatus: null });
  });

  it("CP4: voiding the 65.00 payment posts the exact reversal on the void date; 65.00 is due again, part paid; a second void is refused", async () => {
    const invoice = await approved();
    await pay(invoice.id, { amount: "50.00" });
    const { payment } = await pay(invoice.id, { amount: "65.00", paymentDate: "2026-05-25", reference: "Second instalment" });
    const journalsBefore = await journalCount();

    const voidKey = key("void-pay");
    const { created, payment: voided, invoice: after } = await voidPay(invoice.id, payment.id, "2026-06-15", voidKey);
    expect(created).toBe(true);
    expect(voided).toMatchObject({
      id: payment.id,
      status: "voided",
      amount: "65.00",
      journalId: payment.journalId,
      voidDate: "2026-06-15",
      voidedByEmail: bookkeeper.email,
    });
    expect(after).toMatchObject({ amountPaid: "50.00", amountDue: "65.00", paidStatus: "part_paid" });

    const original = await journal(payment.journalId);
    const reversal = await journal(voided.voidJournalId!);
    expect(reversal).toMatchObject({
      origin: "customer_payment",
      postingDate: "2026-06-15",
      reference: "VOID-Second instalment",
      description: `Void of payment from Aroha Café Ltd for ${invoice.invoiceNumber}`,
      relatedJournalId: original.id,
      correctionKind: "reversal",
      totalDebit: "65.00",
    });
    expect(reversal.lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount, entry.description])).toEqual(
      original.lines.map((entry) => [entry.accountCode, entry.creditAmount, entry.debitAmount, entry.description]),
    );
    expect(await postedLines(reversal.id)).toEqual([
      ["1000", "0.00", "65.00"],
      ["1100", "65.00", "0.00"],
    ]);

    // A retry of the same void returns it; another void is refused.
    const retried = await voidPay(invoice.id, payment.id, "2026-06-15", voidKey);
    expect(retried).toMatchObject({ created: false, payment: { id: payment.id, voidJournalId: reversal.id } });
    await expect(voidPay(invoice.id, payment.id, "2026-06-16")).rejects.toThrow("This payment has already been voided.");
    await expect(voidPay(invoice.id, payment.id, "2026-06-16", voidKey)).rejects.toThrow(
      /already used for a different payment void/,
    );
    expect(await journalCount()).toBe(journalsBefore + 1);
    expect((await paymentsOf(invoice.id)).map((entry) => [entry.amount, entry.status])).toEqual([
      ["50.00", "active"],
      ["65.00", "voided"],
    ]);
    expect(await listed(invoice.id)).toMatchObject({ amountDue: "65.00", paidStatus: "part_paid" });

    // The ledger shows the pair, and neither can be corrected there.
    const details = await asUser(owner, (tx) => getJournalDetails(tx, original.id));
    expect(details.canCorrect).toBe(false);
    expect(details.correctionJournals.map((entry) => entry.id)).toEqual([reversal.id]);
    expect((await asUser(owner, (tx) => getJournalDetails(tx, reversal.id))).canCorrect).toBe(false);
  });

  it("CP4: a void must be dated on or after the payment, in an open period, and name a payment on that invoice", async () => {
    const invoice = await approved();
    const other = await approved();
    const { payment } = await pay(invoice.id, { amount: "40.00" });
    await expect(voidPay(invoice.id, payment.id, "2026-05-19")).rejects.toThrow(
      "The void date can't be before the payment date (2026-05-20).",
    );
    await expect(voidPay(invoice.id, payment.id, "20/05/2026")).rejects.toThrow(/voidDate/);
    await expect(voidPay(other.id, payment.id, "2026-06-01")).rejects.toThrow("Payment not found.");
    await expect(voidPay(invoice.id, "999999", "2026-06-01")).rejects.toThrow("Payment not found.");

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    try {
      await expect(voidPay(invoice.id, payment.id, "2026-05-25")).rejects.toThrow(/2026-05-25 is in a locked period/);
      expect((await paymentsOf(invoice.id)).map((entry) => entry.status)).toEqual(["active"]);
      // The payment's own period is locked, but a void dated in an open period is fine.
      const { payment: voided, invoice: after } = await voidPay(invoice.id, payment.id, "2026-06-01");
      expect(voided).toMatchObject({ status: "voided", voidDate: "2026-06-01" });
      expect((await journal(voided.voidJournalId!)).postingDate).toBe("2026-06-01");
      expect(after).toMatchObject({ amountPaid: "0.00", amountDue: "115.00", paidStatus: "unpaid" });
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
    }
  });

  it("CP5: voiding an invoice with an active payment is refused; after its payments are voided, the invoice can be voided", async () => {
    const invoice = await approved();
    const { payment } = await pay(invoice.id);
    const journalsBefore = await journalCount();

    await expect(voidTheInvoice(invoice.id, "2026-06-01")).rejects.toThrow(
      `Invoice ${invoice.invoiceNumber} has payments against it, so it can't be voided. Void its payments first.`,
    );
    expect(await invoiceNow(invoice.id)).toMatchObject({ status: "approved", voidJournalId: null, paidStatus: "paid" });
    expect(await journalCount()).toBe(journalsBefore);

    await voidPay(invoice.id, payment.id, "2026-06-01");
    const { invoice: voided } = await voidTheInvoice(invoice.id, "2026-06-01");
    expect(voided).toMatchObject({ status: "voided", voidDate: "2026-06-01", amountPaid: "0.00", amountDue: null, paidStatus: null });
    expect(await journalCount()).toBe(journalsBefore + 2);
  });

  it("CP6: a payment dated in a locked period is refused and nothing is posted", async () => {
    const invoice = await approved();
    const earlierKey = key("pay");
    const earlier = await pay(invoice.id, { amount: "15.00", idempotencyKey: earlierKey });
    const journalsBefore = await journalCount();

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    try {
      await expect(pay(invoice.id, { amount: "50.00", paymentDate: "2026-05-31" })).rejects.toThrow(
        "2026-05-31 is in a locked period (locked up to 2026-05-31)",
      );
      expect(await journalCount()).toBe(journalsBefore);
      expect(await paymentsOf(invoice.id)).toHaveLength(1);
      expect(await invoiceNow(invoice.id)).toMatchObject({ amountPaid: "15.00", amountDue: "100.00", paidStatus: "part_paid" });

      // L4: a retry of a payment recorded before the lock still returns it.
      const retried = await pay(invoice.id, { amount: "15.00", idempotencyKey: earlierKey });
      expect(retried).toMatchObject({ created: false, payment: { id: earlier.payment.id } });

      // The invoice's own period is locked, but a payment dated in an open period is fine.
      const { payment } = await pay(invoice.id, { amount: "50.00", paymentDate: "2026-06-01" });
      expect((await journal(payment.journalId)).postingDate).toBe("2026-06-01");
      expect(await journalCount()).toBe(journalsBefore + 1);
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
    }
  });

  it("L4, CP4, CP7: retrying a payment void after its period is locked returns the original, not a lock error", async () => {
    const invoice = await approved();
    const { payment } = await pay(invoice.id, { amount: "40.00" });
    const voidKey = key("void-pay");
    const { payment: voided } = await voidPay(invoice.id, payment.id, "2026-05-25", voidKey);
    const journalsBefore = await journalCount();

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    try {
      expect(await voidPay(invoice.id, payment.id, "2026-05-25", voidKey)).toMatchObject({
        created: false,
        payment: { id: payment.id, status: "voided", voidDate: "2026-05-25", voidJournalId: voided.voidJournalId },
        invoice: { id: invoice.id, amountPaid: "0.00", amountDue: "115.00", paidStatus: "unpaid" },
      });
      expect(await journalCount()).toBe(journalsBefore);
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
    }
  });

  it("CP3, CP4, CP7: payments and voids at the same moment take turns: a retry queued behind the first returns it; they can't overpay", async () => {
    const invoice = await approved();
    const payKey = key("pay");
    const journalsBefore = await journalCount();

    // Hold the invoice's lock so both copies of the request pass the first key check and queue behind it.
    const copies = await asUser(owner, async (tx) => {
      await tx.query("select id from sales_invoices where id = $1 for update", [invoice.id]);
      const queued = [
        pay(invoice.id, { amount: "60.00", idempotencyKey: payKey }),
        pay(invoice.id, { amount: "60.00", idempotencyKey: payKey }),
      ];
      await waitForLockWaiters(tx, 2);
      return queued;
    });
    const results = await Promise.all(copies);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[1].payment.id).toBe(results[0].payment.id);
    expect(await journalCount()).toBe(journalsBefore + 1);

    // With 55.00 due, two payments of 55.00 queue up: the first pays the invoice and the second is all overpayment (OP4).
    const rivals = await asUser(owner, async (tx) => {
      await tx.query("select id from sales_invoices where id = $1 for update", [invoice.id]);
      const queued = [pay(invoice.id, { amount: "55.00" }), pay(invoice.id, { amount: "55.00" })];
      await waitForLockWaiters(tx, 2);
      return queued;
    });
    const outcomes = await Promise.allSettled(rivals);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(
      (await paymentsOf(invoice.id)).map((entry) => [entry.amount, entry.invoiceAmount, entry.overpaymentAmount, entry.status]),
    ).toEqual([
      ["60.00", "60.00", "0.00", "active"],
      ["55.00", "55.00", "0.00", "active"],
      ["55.00", "0.00", "55.00", "active"],
    ]);
    expect(await invoiceNow(invoice.id)).toMatchObject({ amountPaid: "115.00", amountDue: "0.00", paidStatus: "paid" });
    expect(await journalCount()).toBe(journalsBefore + 3);

    // Two copies of a payment void queued behind the invoice's lock void it once.
    const voidKey = key("void-pay");
    const voids = await asUser(owner, async (tx) => {
      await tx.query("select id from sales_invoices where id = $1 for update", [invoice.id]);
      const paymentId = results[0].payment.id;
      const queued = [voidPay(invoice.id, paymentId, "2026-06-01", voidKey), voidPay(invoice.id, paymentId, "2026-06-01", voidKey)];
      await waitForLockWaiters(tx, 2);
      return queued;
    });
    const voided = await Promise.all(voids);
    expect(voided.map((result) => result.created).sort()).toEqual([false, true]);
    expect(voided[0].payment.voidJournalId).toEqual(expect.any(String));
    expect(voided[1].payment).toMatchObject({ status: "voided", voidJournalId: voided[0].payment.voidJournalId });
    // The second 55.00 stays an overpayment: its split was fixed when it was recorded.
    expect(await invoiceNow(invoice.id)).toMatchObject({ amountPaid: "55.00", amountDue: "60.00", paidStatus: "part_paid" });
    expect(await journalCount()).toBe(journalsBefore + 4);
  });

  it("CP7: over HTTP a retry with the same key and content returns the payment (201 then 200); a different amount is a 409", async () => {
    const invoice = await approved();
    const [bookkeeperCookie, viewerCookie, outsiderCookie] = await Promise.all(
      [bookkeeper, viewer, outsider].map((user) => sessionCookieFor(user)),
    );
    const record = (cookie: string, fields: Record<string, unknown>, invoiceId = invoice.id) =>
      paymentsRoute.POST(
        apiRequest(`/api/invoices/${invoiceId}/payments`, { method: "POST", cookie, body: { organisationId: ORG, ...fields } }),
        params({ invoiceId }),
      );
    const list = (cookie: string, invoiceId = invoice.id) =>
      paymentsRoute.GET(apiRequest(`/api/invoices/${invoiceId}/payments?organisationId=${ORG}`, { cookie }), params({ invoiceId }));
    const voidOver = (cookie: string, paymentId: string, idempotencyKey: string, voidDate: string, invoiceId = invoice.id) =>
      paymentVoidRoute.POST(
        apiRequest(`/api/invoices/${invoiceId}/payments/${paymentId}/void`, {
          method: "POST",
          cookie,
          body: { organisationId: ORG, source: "ui", idempotencyKey, voidDate },
        }),
        params({ invoiceId, paymentId }),
      );
    const command = {
      source: "ui",
      idempotencyKey: key("http-pay"),
      paymentDate: "2026-05-20",
      amount: "50.00",
      bankAccountCode: "1000",
      reference: "Web payment",
    };
    const journalsBefore = await journalCount();

    expect((await record(viewerCookie, command)).status).toBe(403);
    const created = await record(bookkeeperCookie, command);
    expect(created.status).toBe(201);
    const first = await body(created);
    expect(first).toMatchObject({
      created: true,
      payment: { amount: "50.00", reference: "Web payment", createdByEmail: bookkeeper.email },
      invoice: { id: invoice.id, amountPaid: "50.00", amountDue: "65.00", paidStatus: "part_paid" },
    });
    const payment = first.payment as CustomerPayment;

    const retried = await record(bookkeeperCookie, command);
    expect(retried.status).toBe(200);
    expect(await body(retried)).toMatchObject({ created: false, payment: { id: payment.id }, invoice: { amountDue: "65.00" } });
    // "50" is the same amount as "50.00", so this is the same payment too.
    expect((await record(bookkeeperCookie, { ...command, amount: "50" })).status).toBe(200);
    const different = await record(bookkeeperCookie, { ...command, amount: "60.00" });
    expect(different.status).toBe(409);
    expect((await body(different)).error).toMatch(/already used for a different payment/);
    // The key belongs to that payment, so it can't be used for another invoice either.
    expect((await record(bookkeeperCookie, command, (await approved()).id)).status).toBe(409);
    const refused = await record(bookkeeperCookie, { ...command, idempotencyKey: key("http-pay"), amount: "10.001" });
    expect(refused.status).toBe(400);
    expect((await body(refused)).error).toMatch(/at most 2 decimal places/);
    expect(await journalCount()).toBe(journalsBefore + 2); // the payment, and the other invoice's approval

    const listedOver = await list(viewerCookie);
    expect(listedOver.status).toBe(200);
    expect(await body(listedOver)).toEqual({ payments: [payment] });
    expect((await list(viewerCookie, "999999")).status).toBe(404);
    const awaiting = await invoicesRoute.GET(
      apiRequest(`/api/invoices?organisationId=${ORG}&awaitingPayment=true`, { cookie: viewerCookie }),
      noContext,
    );
    expect(awaiting.status).toBe(200);
    expect(((await body(awaiting)).invoices as InvoiceSummary[]).find((entry) => entry.id === invoice.id)).toMatchObject({
      amountDue: "65.00",
      paidStatus: "part_paid",
    });

    const voidKey = key("http-void-pay");
    expect((await voidOver(viewerCookie, payment.id, voidKey, "2026-06-01")).status).toBe(403);
    expect((await voidOver(bookkeeperCookie, payment.id, voidKey, "2026-06-01", (await approved()).id)).status).toBe(404);
    const voided = await voidOver(bookkeeperCookie, payment.id, voidKey, "2026-06-01");
    expect(voided.status).toBe(201);
    expect(await body(voided)).toMatchObject({
      created: true,
      payment: { id: payment.id, status: "voided", voidDate: "2026-06-01", voidedByEmail: bookkeeper.email },
      invoice: { amountPaid: "0.00", amountDue: "115.00", paidStatus: "unpaid" },
    });
    expect((await voidOver(bookkeeperCookie, payment.id, voidKey, "2026-06-01")).status).toBe(200);
    expect((await voidOver(bookkeeperCookie, payment.id, voidKey, "2026-06-02")).status).toBe(409);
    expect((await voidOver(bookkeeperCookie, payment.id, key("http-void-pay"), "2026-06-02")).status).toBe(409);

    // Non-members can't tell the organisation exists; nobody signed in gets nothing.
    expect((await list(outsiderCookie)).status).toBe(404);
    expect((await record(outsiderCookie, { ...command, idempotencyKey: key("http-pay") })).status).toBe(404);
    expect((await voidOver(outsiderCookie, payment.id, key("x"), "2026-06-01")).status).toBe(404);
    expect(
      (
        await paymentsRoute.GET(apiRequest(`/api/invoices/${invoice.id}/payments?organisationId=${ORG}`), params({ invoiceId: invoice.id }))
      ).status,
    ).toBe(401);
  });

  it("CP8: the bank account must be an active account of type bank, in the base currency", async () => {
    const invoice = await approved();
    const savings = await asUser(owner, (tx) =>
      createAccount(tx, { code: "1010", name: "Savings account", accountType: "bank" }),
    );
    await asUser(owner, (tx) =>
      createAccount(tx, { code: "1020", name: "USD account", accountType: "bank", currencyCode: "USD" }),
    );
    await asUser(owner, (tx) => updateAccount(tx, savings.id, { isActive: false }));
    const journalsBefore = await journalCount();

    await expect(pay(invoice.id, { bankAccountCode: "1100" })).rejects.toThrow(
      "Account 1100 (Accounts receivable) isn't a bank account, so payments can't go into it.",
    );
    await expect(pay(invoice.id, { bankAccountCode: "4000" })).rejects.toThrow(/Account 4000 .* isn't a bank account/);
    await expect(pay(invoice.id, { bankAccountCode: "1010" })).rejects.toThrow(
      "Account 1010 (Savings account) is archived, so payments can't go into it.",
    );
    await expect(pay(invoice.id, { bankAccountCode: "1020" })).rejects.toThrow(
      "Account 1020 (USD account) is in USD. Payments go into bank accounts in the base currency (NZD) only.",
    );
    await expect(pay(invoice.id, { bankAccountCode: "9999" })).rejects.toThrow("There's no account with the code 9999.");
    await expect(pay(invoice.id, { bankAccountCode: "" })).rejects.toThrow("bankAccountCode is required.");
    expect(await journalCount()).toBe(journalsBefore);
    expect(await paymentsOf(invoice.id)).toEqual([]);

    // Any active base-currency bank account will do.
    await asUser(owner, (tx) => updateAccount(tx, savings.id, { isActive: true }));
    const { payment } = await pay(invoice.id, { bankAccountCode: "1010", amount: "20.00" });
    expect(payment).toMatchObject({ bankAccountId: savings.id, bankAccountCode: "1010", bankAccountName: "Savings account" });
    expect(await postedLines(payment.journalId)).toEqual([
      ["1010", "20.00", "0.00"],
      ["1100", "0.00", "20.00"],
    ]);
  });

  it("payments are dated on or after the invoice date; without a reference the journals use the invoice number", async () => {
    const invoice = await approved();
    await expect(pay(invoice.id, { paymentDate: "2026-05-09" })).rejects.toThrow(
      "The payment date can't be before the invoice date (2026-05-10). Prepayments aren't supported yet: raise the invoice first.",
    );
    await expect(pay(invoice.id, { paymentDate: "20/05/2026" })).rejects.toThrow(/paymentDate/);
    await expect(pay(invoice.id, { reference: "x".repeat(101) })).rejects.toThrow("reference can be at most 100 characters.");

    const { payment } = await pay(invoice.id, { paymentDate: "2026-05-10", amount: "5.00", reference: "  " });
    expect(payment.reference).toBeNull();
    expect(await journal(payment.journalId)).toMatchObject({ reference: invoice.invoiceNumber, postingDate: "2026-05-10" });
    const { payment: voided } = await voidPay(invoice.id, payment.id, "2026-05-10");
    expect(await journal(voided.voidJournalId!)).toMatchObject({
      reference: `VOID-${invoice.invoiceNumber}`,
      postingDate: "2026-05-10",
    });
  });

  it("payment journals are listed as their own kind and can't be corrected in the ledger", async () => {
    const invoice = await approved();
    const { payment } = await pay(invoice.id, { amount: "10.00" });
    const { payment: voided } = await voidPay(invoice.id, payment.id, "2026-05-21");

    const journals = (await asUser(viewer, (tx) => listJournals(tx, { kind: "customer_payment" }))).journals;
    expect(journals.every((entry) => entry.origin === "customer_payment")).toBe(true);
    expect(journals.map((entry) => entry.id)).toEqual(expect.arrayContaining([payment.journalId, voided.voidJournalId]));

    for (const journalId of [payment.journalId, voided.voidJournalId!]) {
      await expect(
        asUser(bookkeeper, (tx) =>
          correctJournal(tx, {
            idempotencyKey: key("fix"),
            originalJournalId: journalId,
            postingDate: "2026-06-01",
            reference: "FIX",
            lines: [
              { accountCode: "1000", debitAmount: "10" },
              { accountCode: "1100", creditAmount: "10" },
            ],
          }),
        ),
      ).rejects.toThrow(/was posted by a customer payment .*, so it can't be corrected in the ledger/);
    }
  });

  it("the invoice list shows amount due and paid status; 'awaiting payment' lists approved invoices with something due", async () => {
    const unpaid = await approved();
    const partPaid = await approved();
    await pay(partPaid.id, { amount: "15.00" });
    const paid = await approved();
    await pay(paid.id);
    const drafted = await draft();

    const all = new Map((await asUser(viewer, (tx) => listInvoices(tx))).invoices.map((entry) => [entry.id, entry]));
    expect(all.get(unpaid.id)).toMatchObject({ amountPaid: "0.00", amountDue: "115.00", paidStatus: "unpaid" });
    expect(all.get(partPaid.id)).toMatchObject({ amountPaid: "15.00", amountDue: "100.00", paidStatus: "part_paid" });
    expect(all.get(paid.id)).toMatchObject({ amountPaid: "115.00", amountDue: "0.00", paidStatus: "paid" });
    expect(all.get(drafted.id)).toMatchObject({ status: "draft", amountPaid: "0.00", amountDue: null, paidStatus: null });

    const awaiting = (await asUser(viewer, (tx) => listInvoices(tx, { awaitingPayment: "true" }))).invoices;
    const awaitingIds = awaiting.map((entry) => entry.id);
    expect(awaitingIds).toEqual(expect.arrayContaining([unpaid.id, partPaid.id]));
    expect(awaitingIds).not.toContain(paid.id);
    expect(awaitingIds).not.toContain(drafted.id);
    expect(awaiting.every((entry) => entry.status === "approved" && entry.paidStatus !== "paid")).toBe(true);
    expect(awaitingIds).toEqual([...awaitingIds].sort((a, b) => Number(b) - Number(a)));

    // Paged like the full list.
    const page = await asUser(viewer, (tx) => listInvoices(tx, { awaitingPayment: true, limit: 1 }));
    expect(page.invoices.map((entry) => entry.id)).toEqual([awaitingIds[0]]);
    const next = await asUser(viewer, (tx) =>
      listInvoices(tx, { awaitingPayment: true, limit: 1, beforeId: page.nextBeforeId }),
    );
    expect(next.invoices.map((entry) => entry.id)).toEqual([awaitingIds[1]]);
    await expect(asUser(viewer, (tx) => listInvoices(tx, { awaitingPayment: "maybe" }))).rejects.toThrow(
      "awaitingPayment must be true or false.",
    );
  });

  it("the database refuses payments that don't split into invoice part and overpayment correctly, payments against unapproved invoices, and any change but a single void", async () => {
    const invoice = await approved();
    const { payment } = await pay(invoice.id, { amount: "100.00" });
    const drafted = await draft();
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));
    const insert = (invoiceId: string, amount: string, paymentDate = "2026-05-20", currency = "NZD", status = "active") =>
      sql(
        `insert into customer_payments (command_source, idempotency_key, request_hash, status, invoice_id, payment_date,
                                        amount, currency_code, bank_account_id, journal_id)
         values ('sql', $1, 'h', $2, $3, $4, $5::numeric, $6, $7, $8)`,
        [key("sql"), status, invoiceId, paymentDate, amount, currency, payment.bankAccountId, payment.journalId],
      );

    // 15.01 against 15.00 due must record an overpayment of 0.01 (OP1); this one says 0.
    await expect(insert(invoice.id, "15.01")).rejects.toThrow(
      `The overpayment on a payment against invoice ${invoice.invoiceNumber} must be what it pays beyond the amount due (15.00)`,
    );
    await expect(insert(drafted.id, "1.00")).rejects.toThrow("Payments can only be recorded against approved invoices");
    await expect(insert(invoice.id, "1.00", "2026-05-09")).rejects.toThrow("A payment can't be dated before its invoice");
    await expect(insert(invoice.id, "1.00", "2026-05-20", "USD")).rejects.toThrow("A payment must be in its invoice's currency");
    await expect(insert(invoice.id, "1.00", "2026-05-20", "NZD", "voided")).rejects.toThrow(
      "A payment is recorded as active and voided afterwards",
    );
    await expect(insert(invoice.id, "0")).rejects.toThrow(/check constraint/);

    await expect(sql("update customer_payments set amount = 10 where id = $1", [payment.id])).rejects.toThrow(
      "Customer payments can't be changed, only voided once",
    );
    // Voiding may only add the void details.
    await expect(
      sql(
        `update customer_payments
            set status = 'voided', void_date = '2026-06-01', void_journal_id = $2, void_command_source = 'sql',
                void_idempotency_key = 'sql-void', void_request_hash = 'h', voided_at = now(), reference = 'sneaky'
          where id = $1`,
        [payment.id, invoice.approvalJournalId],
      ),
    ).rejects.toThrow("Customer payments can't be changed, only voided once");
    await expect(sql("delete from customer_payments where id = $1", [payment.id])).rejects.toThrow(
      "Customer payments can't be deleted; void them instead",
    );
    // Overpayment applications and refunds refer to payments, so a plain truncate is refused before the trigger runs.
    await expect(sql("truncate customer_payments cascade")).rejects.toThrow(/can't be truncated/);

    // An invoice with active payments can't be voided, even directly.
    await expect(
      sql(
        `update sales_invoices
            set status = 'voided', void_date = '2026-06-01', void_journal_id = $2, void_command_source = 'sql',
                void_idempotency_key = 'sql-void', void_request_hash = 'h', voided_at = now()
          where id = $1`,
        [invoice.id, payment.journalId],
      ),
    ).rejects.toThrow(`Invoice ${invoice.invoiceNumber} has payments against it, so it can't be voided. Void its payments first`);

    // Once voided, a payment can't change again.
    const { payment: voided } = await voidPay(invoice.id, payment.id, "2026-06-01");
    await expect(sql("update customer_payments set status = 'active' where id = $1", [voided.id])).rejects.toThrow(
      "Customer payments can't be changed, only voided once",
    );
    expect(await paymentsOf(invoice.id)).toEqual([voided]);
  });

  it("migration 0004 upgrades an organisation database on 0003, keeping its data", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_payments`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();

    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      const before = tenantMigrations.filter((migration) => migration.version < "0004");
      expect((await applyMigrations(client, before, "test:upgrade")).applied).toEqual(["0001", "0002", "0003"]);
      await client.query(
        `insert into organisation_settings (organisation_id, display_name, base_currency) values ('upgrade-co', 'Upgrade Co', 'NZD')`,
      );
      await client.query(
        `insert into accounts (code, name, account_class, account_type, system_key) values
           ('1000', 'Bank', 'asset', 'bank', 'bank'),
           ('1100', 'Accounts receivable', 'asset', 'current_asset', 'accounts_receivable')`,
      );

      const upgraded = await applyMigrations(client, tenantMigrations, "test:upgrade");
      expect(upgraded.applied).toContain("0004");
      expect((await client.query("select display_name from organisation_settings")).rows).toEqual([
        { display_name: "Upgrade Co" },
      ]);
      expect((await client.query("select code, system_key from accounts order by code")).rows).toEqual([
        { code: "1000", system_key: "bank" },
        { code: "1100", system_key: "accounts_receivable" },
        // Added by migration 0028 (expense claims, EC1).
        { code: "2010", system_key: "expense_claims_payable" },
        // Added by migration 0036 (the equity conversion account, IM1, IM21).
        { code: "3900", system_key: "conversion_clearing" },
        // Added by migration 0033 (foreign-currency bank accounts, FXB5).
        { code: "7020", system_key: "realised_fx" },
        // Added by migration 0029 (fixed assets, FA1).
        { code: "7030", system_key: "fixed_asset_disposal" },
        { code: "7040", system_key: "fixed_asset_capital_gain" },
        // Added by migration 0045 (rounding gains and losses, MC31).
        { code: "7050", system_key: "fx_rounding" },
      ]);
      expect((await client.query("select count(*)::int as count from customer_payments")).rows).toEqual([{ count: 0 }]);
      const origin = await client.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'ledger_journals_origin_check'",
      );
      expect(origin.rows[0].definition).toContain("'invoice'");
      expect(origin.rows[0].definition).toContain("'customer_payment'");
    } finally {
      await client.end();
    }
  });
});

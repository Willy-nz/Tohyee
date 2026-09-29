import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as paymentVoidRoute from "@/app/api/bills/[billId]/payments/[paymentId]/void/route";
import * as paymentsRoute from "@/app/api/bills/[billId]/payments/route";
import * as billsRoute from "@/app/api/bills/route";
import { createAccount, updateAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import {
  listSupplierPayments,
  recordSupplierPayment,
  type SupplierPayment,
  voidSupplierPayment,
} from "@/lib/bills/payments";
import { approveBill, type Bill, type BillSummary, createBill, getBill, listBills, voidBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
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

const ORG = "supplier-payments-co";
const noContext = undefined as unknown;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

let numberCounter = 0;
/** A supplier invoice number no other bill in this file uses. */
function nextNumber(): string {
  numberCounter += 1;
  return `SP-${numberCounter}`;
}

/** Examples SP1-SP8 in docs/ACCOUNTING-EXAMPLES.md ("Supplier payments"). */
describeWithDatabase("supplier payments", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let supplier: Contact;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  /** Saves a draft of example B1: 1 x $200.00 at 15% exclusive to 6010, total 230.00, dated 10 May 2026. */
  const draft = async (): Promise<Bill> =>
    (
      await asUser(bookkeeper, (tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: supplier.id,
          billDate: "2026-05-10",
          dueDate: "2026-06-20",
          supplierInvoiceNumber: nextNumber(),
          amountsMode: "exclusive",
          lines: [{ description: "Year-end accounts", quantity: "1", unitPrice: "200.00", accountCode: "6010", taxCode: "GST" }],
        }),
      )
    ).bill;
  /** An approved copy of example B1, with 230.00 due. */
  const approved = async (): Promise<Bill> => {
    const saved = await draft();
    return (await asUser(bookkeeper, (tx) => approveBill(tx, saved.id, { idempotencyKey: key("approve") }))).bill;
  };
  /** Pays 230.00 from 1000 on 20 May 2026 unless told otherwise. */
  const pay = (billId: string, fields: Record<string, unknown> = {}) =>
    asUser(bookkeeper, (tx) =>
      recordSupplierPayment(tx, billId, {
        idempotencyKey: key("pay"),
        paymentDate: "2026-05-20",
        amount: "230.00",
        bankAccountCode: "1000",
        ...fields,
      }),
    );
  const voidPay = (billId: string, paymentId: string, voidDate: string, idempotencyKey = key("void-pay")) =>
    asUser(bookkeeper, (tx) => voidSupplierPayment(tx, billId, paymentId, { idempotencyKey, voidDate }));
  const voidTheBill = (billId: string, voidDate: string, idempotencyKey = key("void")) =>
    asUser(bookkeeper, (tx) => voidBill(tx, billId, { idempotencyKey, voidDate }));
  const paymentsOf = (billId: string) => asUser(viewer, (tx) => listSupplierPayments(tx, billId));
  const billNow = (billId: string) => asUser(viewer, (tx) => getBill(tx, billId));
  const listed = async (billId: string): Promise<BillSummary | undefined> =>
    (await asUser(viewer, (tx) => listBills(tx))).bills.find((entry) => entry.id === billId);
  const journal = (journalId: string) => asUser(owner, (tx) => getJournal(tx, journalId));
  /** A journal's lines as [account, debit, credit]. */
  const postedLines = async (journalId: string) =>
    (await journal(journalId)).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);
  const journalCount = async () =>
    Number(
      (await asUser(owner, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals")))
        .rows[0].count,
    );
  /** Starts the requests while holding the bill's lock, so they all queue behind it, then lets them go. */
  const atOnce = async <T>(billId: string, requests: Array<() => Promise<T>>) => {
    const { settling } = await asUser(owner, async (tx) => {
      await tx.query("select id from bills where id = $1 for update", [billId]);
      const queued = requests.map((request) => request());
      // Handle their results now: one refused as soon as the lock is released mustn't be an unhandled rejection.
      const handled = Promise.allSettled(queued);
      await waitForLockWaiters(tx, queued.length);
      return { settling: handled };
    });
    return settling;
  };

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
    supplier = (
      await asUser(bookkeeper, (tx) =>
        createContact(tx, { idempotencyKey: key("contact"), name: "Kauri Supplies", isSupplier: true }),
      )
    ).contact;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("SP1: paying bill B1 (230.00) from 1000 posts Dr 2000 230.00 / Cr 1000 230.00 on the payment date; 0.00 due, paid", async () => {
    const bill = await approved();
    expect(bill).toMatchObject({ total: "230.00", amountPaid: "0.00", amountDue: "230.00", paidStatus: "unpaid" });

    const { created, payment, bill: paid } = await pay(bill.id, { reference: "Kauri May" });
    expect(created).toBe(true);
    expect(payment).toMatchObject({
      billId: bill.id,
      supplierInvoiceNumber: bill.supplierInvoiceNumber,
      status: "active",
      paymentDate: "2026-05-20",
      amount: "230.00",
      currencyCode: "NZD",
      bankAccountCode: "1000",
      bankAccountName: "Business bank account",
      reference: "Kauri May",
      createdByEmail: bookkeeper.email,
      voidDate: null,
      voidJournalId: null,
      voidedByEmail: null,
    });
    expect(paid).toMatchObject({ id: bill.id, status: "approved", amountPaid: "230.00", amountDue: "0.00", paidStatus: "paid" });
    expect(await billNow(bill.id)).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });

    expect(await journal(payment.journalId)).toMatchObject({
      origin: "supplier_payment",
      postingDate: "2026-05-20",
      reference: "Kauri May",
      description: `Payment to Kauri Supplies for bill ${bill.supplierInvoiceNumber}`,
      currencyCode: "NZD",
      relatedJournalId: null,
      correctionKind: null,
      totalDebit: "230.00",
      createdByEmail: bookkeeper.email,
    });
    expect(await postedLines(payment.journalId)).toEqual([
      ["2000", "230.00", "0.00"],
      ["1000", "0.00", "230.00"],
    ]);
    expect(await paymentsOf(bill.id)).toEqual([payment]);

    const audit = await asUser(owner, (tx) =>
      tx.query<{ entity_id: string; actor_email: string; details: Record<string, unknown> }>(
        "select entity_id, actor_email, details from audit_events where event_type = 'supplier_payment.recorded'",
      ),
    );
    expect(audit.rows).toEqual([
      {
        entity_id: payment.id,
        actor_email: bookkeeper.email,
        details: expect.objectContaining({
          supplierInvoiceNumber: bill.supplierInvoiceNumber,
          amount: "230.00",
          journalId: payment.journalId,
        }),
      },
    ]);
  });

  it("SP2: paid 100.00 then 130.00, it's 130.00 due and part paid after the first, and 0.00 due and paid after the second", async () => {
    const bill = await approved();
    const first = await pay(bill.id, { amount: "100.00" });
    expect(first.bill).toMatchObject({ amountPaid: "100.00", amountDue: "130.00", paidStatus: "part_paid" });
    expect(await listed(bill.id)).toMatchObject({ amountDue: "130.00", paidStatus: "part_paid" });

    const second = await pay(bill.id, { amount: "130.00", paymentDate: "2026-05-25" });
    expect(second.bill).toMatchObject({ amountPaid: "230.00", amountDue: "0.00", paidStatus: "paid" });
    expect(await listed(bill.id)).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });
    expect(await postedLines(second.payment.journalId)).toEqual([
      ["2000", "130.00", "0.00"],
      ["1000", "0.00", "130.00"],
    ]);
    expect((await journal(second.payment.journalId)).postingDate).toBe("2026-05-25");
    expect((await paymentsOf(bill.id)).map((entry) => [entry.paymentDate, entry.amount, entry.status])).toEqual([
      ["2026-05-20", "100.00", "active"],
      ["2026-05-25", "130.00", "active"],
    ]);
  });

  it("SP3: overpayments, payments against drafts or voided bills, payments before the bill date and amounts that aren't positive with at most 2 decimal places are refused", async () => {
    const bill = await approved();
    const journalsBefore = await journalCount();
    await expect(pay(bill.id, { amount: "230.01" })).rejects.toThrow(
      "The payment of 230.01 is more than the amount due (230.00). Overpayments aren't supported yet.",
    );
    await expect(pay(bill.id, { amount: "0.00" })).rejects.toThrow("amount must not be zero.");
    await expect(pay(bill.id, { amount: "-5.00" })).rejects.toThrow("amount can't be negative.");
    await expect(pay(bill.id, { amount: "10.001" })).rejects.toThrow("amount can have at most 2 decimal places.");
    await expect(pay(bill.id, { paymentDate: "2026-05-09" })).rejects.toThrow(
      "The payment date can't be before the bill date (2026-05-10). Prepayments aren't supported yet.",
    );
    expect(await journalCount()).toBe(journalsBefore);
    expect(await paymentsOf(bill.id)).toEqual([]);

    // Paying exactly what's due is fine, to the cent; after that nothing more can be paid.
    await pay(bill.id, { amount: "200.00" });
    await expect(pay(bill.id, { amount: "30.01" })).rejects.toThrow("is more than the amount due (30.00)");
    expect((await pay(bill.id, { amount: "30" })).bill).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });
    await expect(pay(bill.id, { amount: "0.01" })).rejects.toThrow(
      `Bill ${bill.supplierInvoiceNumber} from Kauri Supplies is already paid in full.`,
    );

    const drafted = await draft();
    const voided = await approved();
    await voidTheBill(voided.id, "2026-05-15");
    const journalsNow = await journalCount();
    await expect(pay(drafted.id)).rejects.toThrow("This bill is still a draft, so it can't be paid. Approve it first.");
    await expect(pay(voided.id)).rejects.toThrow(
      `Bill ${voided.supplierInvoiceNumber} from Kauri Supplies has been voided, so it can't be paid.`,
    );
    await expect(pay("999999")).rejects.toThrow("Bill not found.");
    expect(await journalCount()).toBe(journalsNow);
    expect(await billNow(drafted.id)).toMatchObject({ status: "draft", amountPaid: "0.00", amountDue: null, paidStatus: null });
    expect(await billNow(voided.id)).toMatchObject({ status: "voided", amountPaid: "0.00", amountDue: null, paidStatus: null });
  });

  it("SP4: voiding the 130.00 payment posts the exact reversal on the void date; 130.00 is due again, part paid; a second void and a void before the payment are refused", async () => {
    const bill = await approved();
    await pay(bill.id, { amount: "100.00" });
    const { payment } = await pay(bill.id, { amount: "130.00", paymentDate: "2026-05-25", reference: "Second instalment" });
    const journalsBefore = await journalCount();

    await expect(voidPay(bill.id, payment.id, "2026-05-24")).rejects.toThrow(
      "The void date can't be before the payment date (2026-05-25).",
    );
    const voidKey = key("void-pay");
    const { created, payment: voided, bill: after } = await voidPay(bill.id, payment.id, "2026-06-15", voidKey);
    expect(created).toBe(true);
    expect(voided).toMatchObject({
      id: payment.id,
      status: "voided",
      amount: "130.00",
      journalId: payment.journalId,
      voidDate: "2026-06-15",
      voidedByEmail: bookkeeper.email,
    });
    expect(after).toMatchObject({ amountPaid: "100.00", amountDue: "130.00", paidStatus: "part_paid" });

    const original = await journal(payment.journalId);
    const reversal = await journal(voided.voidJournalId!);
    expect(reversal).toMatchObject({
      origin: "supplier_payment",
      postingDate: "2026-06-15",
      reference: "VOID-Second instalment",
      description: `Void of payment to Kauri Supplies for bill ${bill.supplierInvoiceNumber}`,
      relatedJournalId: original.id,
      correctionKind: "reversal",
      totalDebit: "130.00",
    });
    expect(reversal.lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount, entry.description])).toEqual(
      original.lines.map((entry) => [entry.accountCode, entry.creditAmount, entry.debitAmount, entry.description]),
    );
    expect(await postedLines(reversal.id)).toEqual([
      ["2000", "0.00", "130.00"],
      ["1000", "130.00", "0.00"],
    ]);

    // A retry of the same void returns it; another void is refused.
    const retried = await voidPay(bill.id, payment.id, "2026-06-15", voidKey);
    expect(retried).toMatchObject({ created: false, payment: { id: payment.id, voidJournalId: reversal.id } });
    await expect(voidPay(bill.id, payment.id, "2026-06-16")).rejects.toThrow("This payment has already been voided.");
    await expect(voidPay(bill.id, payment.id, "2026-06-16", voidKey)).rejects.toThrow(
      /already used for a different payment void/,
    );
    expect(await journalCount()).toBe(journalsBefore + 1);
    expect((await paymentsOf(bill.id)).map((entry) => [entry.amount, entry.status])).toEqual([
      ["100.00", "active"],
      ["130.00", "voided"],
    ]);
    expect(await listed(bill.id)).toMatchObject({ amountDue: "130.00", paidStatus: "part_paid" });

    // The ledger shows the pair, and neither can be corrected there.
    const details = await asUser(owner, (tx) => getJournalDetails(tx, original.id));
    expect(details.canCorrect).toBe(false);
    expect(details.correctionJournals.map((entry) => entry.id)).toEqual([reversal.id]);
    expect((await asUser(owner, (tx) => getJournalDetails(tx, reversal.id))).canCorrect).toBe(false);

    // A void names a payment on that bill.
    const other = await approved();
    await expect(voidPay(other.id, payment.id, "2026-06-16")).rejects.toThrow("Payment not found.");
    await expect(voidPay(bill.id, "999999", "2026-06-16")).rejects.toThrow("Payment not found.");
  });

  it("SP5: voiding bill B1 with an active payment is refused; after its payments are voided, the bill can be voided", async () => {
    const bill = await approved();
    const { payment } = await pay(bill.id);
    const journalsBefore = await journalCount();

    await expect(voidTheBill(bill.id, "2026-06-01")).rejects.toThrow(
      `Bill ${bill.supplierInvoiceNumber} from Kauri Supplies has payments against it, so it can't be voided. Void its payments first.`,
    );
    expect(await billNow(bill.id)).toMatchObject({ status: "approved", voidJournalId: null, paidStatus: "paid" });
    expect(await journalCount()).toBe(journalsBefore);

    await voidPay(bill.id, payment.id, "2026-06-01");
    const { bill: voided } = await voidTheBill(bill.id, "2026-06-01");
    expect(voided).toMatchObject({ status: "voided", voidDate: "2026-06-01", amountPaid: "0.00", amountDue: null, paidStatus: null });
    expect(await journalCount()).toBe(journalsBefore + 2);
  });

  it("SP6: a payment or a void dated in a locked period is refused and nothing is posted", async () => {
    const bill = await approved();
    const earlierKey = key("pay");
    const earlier = await pay(bill.id, { amount: "30.00", idempotencyKey: earlierKey });
    const voidKey = key("void-pay");
    const toVoid = await pay(bill.id, { amount: "20.00" });
    const { payment: voidedEarlier } = await voidPay(bill.id, toVoid.payment.id, "2026-05-25", voidKey);
    const { payment: open } = await pay(bill.id, { amount: "40.00" });
    const journalsBefore = await journalCount();

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    try {
      await expect(pay(bill.id, { amount: "50.00", paymentDate: "2026-05-31" })).rejects.toThrow(
        "2026-05-31 is in a locked period (locked up to 2026-05-31)",
      );
      await expect(voidPay(bill.id, open.id, "2026-05-25")).rejects.toThrow(/2026-05-25 is in a locked period/);
      expect(await journalCount()).toBe(journalsBefore);
      expect((await paymentsOf(bill.id)).map((entry) => [entry.amount, entry.status])).toEqual([
        ["30.00", "active"],
        ["20.00", "voided"],
        ["40.00", "active"],
      ]);
      expect(await billNow(bill.id)).toMatchObject({ amountPaid: "70.00", amountDue: "160.00", paidStatus: "part_paid" });

      // L4: retries of a payment and a void made before the lock still return them.
      const retried = await pay(bill.id, { amount: "30.00", idempotencyKey: earlierKey });
      expect(retried).toMatchObject({ created: false, payment: { id: earlier.payment.id } });
      expect(await voidPay(bill.id, toVoid.payment.id, "2026-05-25", voidKey)).toMatchObject({
        created: false,
        payment: { id: toVoid.payment.id, status: "voided", voidJournalId: voidedEarlier.voidJournalId },
      });
      expect(await journalCount()).toBe(journalsBefore);

      // The bill's own period is locked, but a payment or void dated in an open period is fine.
      const { payment } = await pay(bill.id, { amount: "50.00", paymentDate: "2026-06-01" });
      expect((await journal(payment.journalId)).postingDate).toBe("2026-06-01");
      const { payment: voided } = await voidPay(bill.id, open.id, "2026-06-01");
      expect((await journal(voided.voidJournalId!)).postingDate).toBe("2026-06-01");
      expect(await journalCount()).toBe(journalsBefore + 2);
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null }));
    }
  });

  it("SP3, SP4, SP7: payments and voids at the same moment take turns: a retry queued behind the first returns it; they can't overpay", async () => {
    const bill = await approved();
    const payKey = key("pay");
    const journalsBefore = await journalCount();
    const fulfilled = <T>(outcomes: PromiseSettledResult<T>[]) =>
      outcomes.map((outcome) => {
        if (outcome.status === "rejected") throw outcome.reason;
        return outcome.value;
      });

    // Two copies of the same payment are recorded once.
    const results = fulfilled(
      await atOnce(bill.id, [
        () => pay(bill.id, { amount: "130.00", idempotencyKey: payKey }),
        () => pay(bill.id, { amount: "130.00", idempotencyKey: payKey }),
      ]),
    );
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[1].payment.id).toBe(results[0].payment.id);
    expect(await journalCount()).toBe(journalsBefore + 1);

    // With 100.00 due, two payments of 100.00 queue up: the first is recorded and the second is refused.
    const rivals = await atOnce(bill.id, [() => pay(bill.id, { amount: "100.00" }), () => pay(bill.id, { amount: "100.00" })]);
    expect(rivals.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(rivals.find((outcome) => outcome.status === "rejected")?.reason).toMatchObject({
      message: `Bill ${bill.supplierInvoiceNumber} from Kauri Supplies is already paid in full.`,
    });
    expect(await billNow(bill.id)).toMatchObject({ amountPaid: "230.00", amountDue: "0.00", paidStatus: "paid" });
    expect(await journalCount()).toBe(journalsBefore + 2);

    // Two copies of a payment void void it once.
    const voidKey = key("void-pay");
    const paymentId = results[0].payment.id;
    const voided = fulfilled(
      await atOnce(bill.id, [
        () => voidPay(bill.id, paymentId, "2026-06-01", voidKey),
        () => voidPay(bill.id, paymentId, "2026-06-01", voidKey),
      ]),
    );
    expect(voided.map((result) => result.created).sort()).toEqual([false, true]);
    expect(voided[0].payment.voidJournalId).toEqual(expect.any(String));
    expect(voided[1].payment).toMatchObject({ status: "voided", voidJournalId: voided[0].payment.voidJournalId });
    expect(await billNow(bill.id)).toMatchObject({ amountPaid: "100.00", amountDue: "130.00", paidStatus: "part_paid" });
    expect(await journalCount()).toBe(journalsBefore + 3);
  });

  it("SP7: over HTTP a retry with the same key and content returns the payment (201 then 200); a different amount is a 409", async () => {
    const bill = await approved();
    const [bookkeeperCookie, viewerCookie, outsiderCookie] = await Promise.all(
      [bookkeeper, viewer, outsider].map((user) => sessionCookieFor(user)),
    );
    const record = (cookie: string, fields: Record<string, unknown>, billId = bill.id) =>
      paymentsRoute.POST(
        apiRequest(`/api/bills/${billId}/payments`, { method: "POST", cookie, body: { organisationId: ORG, ...fields } }),
        params({ billId }),
      );
    const list = (cookie: string, billId = bill.id) =>
      paymentsRoute.GET(apiRequest(`/api/bills/${billId}/payments?organisationId=${ORG}`, { cookie }), params({ billId }));
    const voidOver = (cookie: string, paymentId: string, idempotencyKey: string, voidDate: string, billId = bill.id) =>
      paymentVoidRoute.POST(
        apiRequest(`/api/bills/${billId}/payments/${paymentId}/void`, {
          method: "POST",
          cookie,
          body: { organisationId: ORG, source: "ui", idempotencyKey, voidDate },
        }),
        params({ billId, paymentId }),
      );
    const command = {
      source: "ui",
      idempotencyKey: key("http-pay"),
      paymentDate: "2026-05-20",
      amount: "100.00",
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
      payment: { amount: "100.00", reference: "Web payment", createdByEmail: bookkeeper.email },
      bill: { id: bill.id, amountPaid: "100.00", amountDue: "130.00", paidStatus: "part_paid" },
    });
    const payment = first.payment as SupplierPayment;

    const retried = await record(bookkeeperCookie, command);
    expect(retried.status).toBe(200);
    expect(await body(retried)).toMatchObject({ created: false, payment: { id: payment.id }, bill: { amountDue: "130.00" } });
    // "100" is the same amount as "100.00", so this is the same payment too.
    expect((await record(bookkeeperCookie, { ...command, amount: "100" })).status).toBe(200);
    const different = await record(bookkeeperCookie, { ...command, amount: "110.00" });
    expect(different.status).toBe(409);
    expect((await body(different)).error).toMatch(/already used for a different payment/);
    // The key belongs to that payment, so it can't be used for another bill either.
    expect((await record(bookkeeperCookie, command, (await approved()).id)).status).toBe(409);
    const refused = await record(bookkeeperCookie, { ...command, idempotencyKey: key("http-pay"), amount: "130.01" });
    expect(refused.status).toBe(400);
    expect((await body(refused)).error).toMatch(/more than the amount due \(130\.00\)/);
    expect(await journalCount()).toBe(journalsBefore + 2); // the payment, and the other bill's approval

    const listedOver = await list(viewerCookie);
    expect(listedOver.status).toBe(200);
    expect(await body(listedOver)).toEqual({ payments: [payment] });
    expect((await list(viewerCookie, "999999")).status).toBe(404);
    const awaiting = await billsRoute.GET(
      apiRequest(`/api/bills?organisationId=${ORG}&awaitingPayment=true`, { cookie: viewerCookie }),
      noContext,
    );
    expect(awaiting.status).toBe(200);
    expect(((await body(awaiting)).bills as BillSummary[]).find((entry) => entry.id === bill.id)).toMatchObject({
      amountDue: "130.00",
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
      bill: { amountPaid: "0.00", amountDue: "230.00", paidStatus: "unpaid" },
    });
    expect((await voidOver(bookkeeperCookie, payment.id, voidKey, "2026-06-01")).status).toBe(200);
    expect((await voidOver(bookkeeperCookie, payment.id, voidKey, "2026-06-02")).status).toBe(409);
    expect((await voidOver(bookkeeperCookie, payment.id, key("http-void-pay"), "2026-06-02")).status).toBe(409);

    // Non-members can't tell the organisation exists; nobody signed in gets nothing.
    expect((await list(outsiderCookie)).status).toBe(404);
    expect((await record(outsiderCookie, { ...command, idempotencyKey: key("http-pay") })).status).toBe(404);
    expect((await voidOver(outsiderCookie, payment.id, key("x"), "2026-06-01")).status).toBe(404);
    expect(
      (await paymentsRoute.GET(apiRequest(`/api/bills/${bill.id}/payments?organisationId=${ORG}`), params({ billId: bill.id })))
        .status,
    ).toBe(401);
  });

  it("SP8: the bank account must be an active, base-currency account of type bank", async () => {
    const bill = await approved();
    const savings = await asUser(owner, (tx) =>
      createAccount(tx, { code: "1010", name: "Savings account", accountType: "bank" }),
    );
    await asUser(owner, (tx) =>
      createAccount(tx, { code: "1020", name: "USD account", accountType: "bank", currencyCode: "USD" }),
    );
    await asUser(owner, (tx) => updateAccount(tx, savings.id, { isActive: false }));
    const journalsBefore = await journalCount();

    await expect(pay(bill.id, { bankAccountCode: "2000" })).rejects.toThrow(
      "Account 2000 (Accounts payable) isn't a bank account, so payments can't be made from it.",
    );
    await expect(pay(bill.id, { bankAccountCode: "6010" })).rejects.toThrow(/Account 6010 .* isn't a bank account/);
    await expect(pay(bill.id, { bankAccountCode: "1010" })).rejects.toThrow(
      "Account 1010 (Savings account) is archived, so payments can't be made from it.",
    );
    await expect(pay(bill.id, { bankAccountCode: "1020" })).rejects.toThrow(
      "Account 1020 (USD account) is in USD. Payments are made from bank accounts in the base currency (NZD) only.",
    );
    await expect(pay(bill.id, { bankAccountCode: "9999" })).rejects.toThrow("There's no account with the code 9999.");
    await expect(pay(bill.id, { bankAccountCode: "" })).rejects.toThrow("bankAccountCode is required.");
    expect(await journalCount()).toBe(journalsBefore);
    expect(await paymentsOf(bill.id)).toEqual([]);

    // Any active base-currency bank account will do.
    await asUser(owner, (tx) => updateAccount(tx, savings.id, { isActive: true }));
    const { payment } = await pay(bill.id, { bankAccountCode: "1010", amount: "20.00" });
    expect(payment).toMatchObject({ bankAccountId: savings.id, bankAccountCode: "1010", bankAccountName: "Savings account" });
    expect(await postedLines(payment.journalId)).toEqual([
      ["2000", "20.00", "0.00"],
      ["1010", "0.00", "20.00"],
    ]);
  });

  it("SP1, SP4: without a reference the journals use the supplier's invoice number", async () => {
    const bill = await approved();
    await expect(pay(bill.id, { paymentDate: "20/05/2026" })).rejects.toThrow(/paymentDate/);
    await expect(pay(bill.id, { reference: "x".repeat(101) })).rejects.toThrow("reference can be at most 100 characters.");

    const { payment } = await pay(bill.id, { paymentDate: "2026-05-10", amount: "5.00", reference: "  " });
    expect(payment.reference).toBeNull();
    expect(await journal(payment.journalId)).toMatchObject({ reference: bill.supplierInvoiceNumber, postingDate: "2026-05-10" });
    const { payment: voided } = await voidPay(bill.id, payment.id, "2026-05-10");
    expect(await journal(voided.voidJournalId!)).toMatchObject({
      reference: `VOID-${bill.supplierInvoiceNumber}`,
      postingDate: "2026-05-10",
    });
  });

  it("SP1, SP4: supplier payment journals are listed as their own kind and can't be corrected in the ledger", async () => {
    const bill = await approved();
    const { payment } = await pay(bill.id, { amount: "10.00" });
    const { payment: voided } = await voidPay(bill.id, payment.id, "2026-05-21");

    const journals = (await asUser(viewer, (tx) => listJournals(tx, { kind: "supplier_payment" }))).journals;
    expect(journals.every((entry) => entry.origin === "supplier_payment")).toBe(true);
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
              { accountCode: "2000", debitAmount: "10" },
              { accountCode: "1000", creditAmount: "10" },
            ],
          }),
        ),
      ).rejects.toThrow(/was posted by a supplier payment .*, so it can't be corrected in the ledger/);
    }
  });

  it("SP2: the bill list shows amount due and paid status; 'awaiting payment' lists approved bills with something due", async () => {
    const unpaid = await approved();
    const partPaid = await approved();
    await pay(partPaid.id, { amount: "30.00" });
    const paid = await approved();
    await pay(paid.id);
    const drafted = await draft();

    const all = new Map((await asUser(viewer, (tx) => listBills(tx))).bills.map((entry) => [entry.id, entry]));
    expect(all.get(unpaid.id)).toMatchObject({ amountPaid: "0.00", amountDue: "230.00", paidStatus: "unpaid" });
    expect(all.get(partPaid.id)).toMatchObject({ amountPaid: "30.00", amountDue: "200.00", paidStatus: "part_paid" });
    expect(all.get(paid.id)).toMatchObject({ amountPaid: "230.00", amountDue: "0.00", paidStatus: "paid" });
    expect(all.get(drafted.id)).toMatchObject({ status: "draft", amountPaid: "0.00", amountDue: null, paidStatus: null });

    const awaiting = (await asUser(viewer, (tx) => listBills(tx, { awaitingPayment: "true" }))).bills;
    const awaitingIds = awaiting.map((entry) => entry.id);
    expect(awaitingIds).toEqual(expect.arrayContaining([unpaid.id, partPaid.id]));
    expect(awaitingIds).not.toContain(paid.id);
    expect(awaitingIds).not.toContain(drafted.id);
    expect(awaiting.every((entry) => entry.status === "approved" && entry.paidStatus !== "paid")).toBe(true);
    expect(awaitingIds).toEqual([...awaitingIds].sort((a, b) => Number(b) - Number(a)));

    // Paged like the full list.
    const page = await asUser(viewer, (tx) => listBills(tx, { awaitingPayment: true, limit: 1 }));
    expect(page.bills.map((entry) => entry.id)).toEqual([awaitingIds[0]]);
    const next = await asUser(viewer, (tx) => listBills(tx, { awaitingPayment: true, limit: 1, beforeId: page.nextBeforeId }));
    expect(next.bills.map((entry) => entry.id)).toEqual([awaitingIds[1]]);
    await expect(asUser(viewer, (tx) => listBills(tx, { awaitingPayment: "maybe" }))).rejects.toThrow(
      "awaitingPayment must be true or false.",
    );
  });

  it("SP3, SP4, SP5: the database refuses overpayments, payments against unapproved bills, voiding a paid bill, and any change but a single void", async () => {
    const bill = await approved();
    const { payment } = await pay(bill.id, { amount: "200.00" });
    const drafted = await draft();
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));
    const insert = (billId: string, amount: string, paymentDate = "2026-05-20", currency = "NZD", status = "active") =>
      sql(
        `insert into supplier_payments (command_source, idempotency_key, request_hash, status, bill_id, payment_date,
                                        amount, currency_code, bank_account_id, journal_id)
         values ('sql', $1, 'h', $2, $3, $4, $5::numeric, $6, $7, $8)`,
        [key("sql"), status, billId, paymentDate, amount, currency, payment.bankAccountId, payment.journalId],
      );

    await expect(insert(bill.id, "30.01")).rejects.toThrow(`Payments against bill #${bill.id} can't add up to more than its total`);
    await expect(insert(drafted.id, "1.00")).rejects.toThrow("Payments can only be recorded against approved bills");
    await expect(insert(bill.id, "1.00", "2026-05-09")).rejects.toThrow("A payment can't be dated before its bill");
    await expect(insert(bill.id, "1.00", "2026-05-20", "USD")).rejects.toThrow("A payment must be in its bill's currency");
    await expect(insert(bill.id, "1.00", "2026-05-20", "NZD", "voided")).rejects.toThrow(
      "A payment is recorded as active and voided afterwards",
    );
    await expect(insert(bill.id, "0")).rejects.toThrow(/check constraint/);

    await expect(sql("update supplier_payments set amount = 10 where id = $1", [payment.id])).rejects.toThrow(
      "Supplier payments can't be changed, only voided once",
    );
    // Voiding may only add the void details.
    await expect(
      sql(
        `update supplier_payments
            set status = 'voided', void_date = '2026-06-01', void_journal_id = $2, void_command_source = 'sql',
                void_idempotency_key = 'sql-void', void_request_hash = 'h', voided_at = now(), reference = 'sneaky'
          where id = $1`,
        [payment.id, bill.approvalJournalId],
      ),
    ).rejects.toThrow("Supplier payments can't be changed, only voided once");
    await expect(sql("delete from supplier_payments where id = $1", [payment.id])).rejects.toThrow(
      "Supplier payments can't be deleted; void them instead",
    );
    await expect(sql("truncate supplier_payments")).rejects.toThrow("supplier_payments can't be truncated");

    // A bill with active payments can't be voided, even directly.
    await expect(
      sql(
        `update bills
            set status = 'voided', void_date = '2026-06-01', void_journal_id = $2, void_command_source = 'sql',
                void_idempotency_key = 'sql-void', void_request_hash = 'h', voided_at = now()
          where id = $1`,
        [bill.id, payment.journalId],
      ),
    ).rejects.toThrow(`Bill #${bill.id} has payments against it, so it can't be voided. Void its payments first`);

    // Once voided, a payment can't change again.
    const { payment: voided } = await voidPay(bill.id, payment.id, "2026-06-01");
    await expect(sql("update supplier_payments set status = 'active' where id = $1", [voided.id])).rejects.toThrow(
      "Supplier payments can't be changed, only voided once",
    );
    expect(await paymentsOf(bill.id)).toEqual([voided]);
  });

  it("migration 0006 upgrades an organisation database on 0005, keeping its data", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_supplier_payments`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();

    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      const before = tenantMigrations.filter((migration) => migration.version < "0006");
      expect((await applyMigrations(client, before, "test:upgrade")).applied).toEqual([
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
      ]);
      await client.query(
        `insert into organisation_settings (organisation_id, display_name, base_currency) values ('upgrade-co', 'Upgrade Co', 'NZD')`,
      );

      const upgraded = await applyMigrations(client, tenantMigrations, "test:upgrade");
      expect(upgraded.applied).toContain("0006");
      expect((await client.query("select display_name from organisation_settings")).rows).toEqual([
        { display_name: "Upgrade Co" },
      ]);
      expect((await client.query("select count(*)::int as count from supplier_payments")).rows).toEqual([{ count: 0 }]);
      const origin = await client.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'ledger_journals_origin_check'",
      );
      for (const kept of ["'customer_payment'", "'bill'", "'supplier_payment'"]) {
        expect(origin.rows[0].definition).toContain(kept);
      }
    } finally {
      await client.end();
    }
  });
});

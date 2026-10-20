import { afterAll, beforeAll, expect, it } from "vitest";
import * as allocateRoute from "@/app/api/income-tax/payments/[paymentId]/allocations/route";
import * as paymentsRoute from "@/app/api/income-tax/payments/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { correctJournal, postJournal } from "@/lib/ledger/journals";
import { addAllocation, reallocate, removeAllocation, setEffectiveDate } from "@/lib/tax/income/allocations";
import { bookPayments, countBookPayment, setPaymentAccounts } from "@/lib/tax/income/book-payments";
import { buildIca } from "@/lib/tax/income/ica";
import { addIrdDocument } from "@/lib/tax/income/ird-documents";
import { addPayment, buildIncomeTax, getIncomeTaxSettings, listPayments, saveIncomeTaxYear, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

/** Provisional tax payments and allocation (ITX6A-ITX6H; as delegated, not yet reviewed by an accountant). */
describeWithDatabase("income tax: provisional tax payments and where they go", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const org = "tax-alloc-co";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const report = async (today = "2027-02-01") => {
    const built = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today }));
    if (!built.supported || built.provisional.kind !== "schedule") throw new Error("expected a schedule");
    return { built, schedule: built.provisional };
  };
  const evidenced = (paymentId: string, appliesTo: string, amount: string) =>
    as((tx) => addAllocation(tx, { idempotencyKey: key("alloc"), paymentId, appliesTo, amount, status: "evidenced", basis: "myIR transactions page, 3 Feb 2027" }));
  let p1 = "";
  let p2 = "";

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("taxalloc-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("taxalloc-bookkeeper@example.com");
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    // ITX6: a tax agent's extension of time, the 2026 return filed on 10 Oct 2026 (after the first instalment).
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: true, version: settings.version }));
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2025, assessedRit: "12000", returnFiledOn: "2025-06-30", version: 0 }));
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, assessedRit: "17668", returnFiledOn: "2026-10-10", version: 0 }));
  }, 300_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("ITX6E a payment with no allocation is awaiting reconciliation and counts against no instalment", async () => {
    p1 = (await as((tx) => addPayment(tx, { idempotencyKey: key("pay"), incomeYear: 2027, paidOn: "2026-08-28", amount: "6000.00" }))).payment.id;
    const { schedule, built } = await report();
    expect(schedule.instalments.map((entry) => entry.paid)).toEqual(["0.00", "0.00", "0.00"]);
    expect(schedule.allocation).toMatchObject({ awaiting: "6000.00", awaitingCount: 1 });
    expect(built.payments[0]).toMatchObject({ awaiting: "6000.00", allocations: [], reversed: false });
    // The year's total paid still counts it once, for end-of-year tax.
    expect(built.paidTotal).toBe("6000.00");
  });

  it("ITX6A 6,000.00 towards instalment 1: 6,367.60 more by instalment 2, and a final balance of 6,183.80", async () => {
    await evidenced(p1, "instalment_1", "6000.00");
    let { schedule } = await report();
    expect(schedule.instalments.map((entry) => entry.amount)).toEqual(["4400.00", "6367.60", "12551.40"]);
    expect(schedule.instalments[1]).toMatchObject({ remaining: "6367.60" });
    expect(schedule.instalments[0]).toMatchObject({ paid: "6000.00", creditAfter: "1600.00" });
    // Paid through the API with its allocation in the same step.
    const cookie = await sessionCookieFor(owner);
    const response = await paymentsRoute.POST(
      apiRequest("/api/income-tax/payments", {
        method: "POST",
        cookie,
        body: { organisationId: org, idempotencyKey: key("pay"), incomeYear: 2027, paidOn: "2027-01-15", irdEffectiveOn: "2027-01-15", amount: "6367.60", allocation: { appliesTo: "instalment_2", status: "evidenced", basis: "Paid with the IR3 instalment reference for 15 Jan" } },
      }),
      undefined as unknown,
    );
    expect(response.status).toBe(201);
    p2 = ((await response.json()) as { payment: { id: string } }).payment.id;
    ({ schedule } = await report());
    expect(schedule.instalments.map((entry) => entry.amount)).toEqual(["4400.00", "6367.60", "6183.80"]);
    expect(schedule.instalments.map((entry) => entry.remaining)).toEqual(["0.00", "0.00", "6183.80"]);
    expect(schedule.total).toBe("18551.40");
    expect(schedule.allocation.awaiting).toBe("0.00");
  });

  it("ITX6H a payment counts once; a confirmed allocation needs an IRD document", async () => {
    await expect(evidenced(p1, "instalment_2", "0.01")).rejects.toThrow("Only 0.00 of this 6000.00 payment isn't allocated yet");
    const extra = (await as((tx) => addPayment(tx, { idempotencyKey: key("pay"), incomeYear: 2027, paidOn: "2027-03-01", amount: "500.00" }))).payment.id;
    await expect(as((tx) => addAllocation(tx, { idempotencyKey: key("alloc"), paymentId: extra, appliesTo: "instalment_3", amount: "500", status: "confirmed", basis: "IRD said so" }))).rejects.toThrow("needs the IRD document");
    const document = await as((tx) => addIrdDocument(tx, { idempotencyKey: key("doc"), fileName: "statement-march-2027.pdf", content: PDF, incomeYear: 2027 }));
    const confirmed = await as((tx) => addAllocation(tx, { idempotencyKey: key("alloc"), paymentId: extra, appliesTo: "instalment_3", amount: "500", status: "confirmed", basis: "IRD statement of account, March 2027", irdDocumentId: document.document.id }));
    expect(confirmed.allocation).toMatchObject({ status: "confirmed", irdDocumentName: "statement-march-2027.pdf" });
    const { schedule } = await report("2027-03-02");
    expect(schedule.instalments[2]).toMatchObject({ paid: "500.00", remaining: "5683.80" });

    // ITX6G reallocating keeps the old allocation with the reason; taking it off puts it back to awaiting.
    const moved = await as((tx) =>
      reallocate(tx, { idempotencyKey: key("realloc"), allocationId: confirmed.allocation.id, appliesTo: "end_of_year", amount: "500", status: "evidenced", basis: "IRD letter, 10 Mar 2027", reason: "IRD moved it to the 2027 end-of-year tax" }),
    );
    let after = await report("2027-03-12");
    expect(after.schedule.instalments[2]).toMatchObject({ paid: "0.00", remaining: "6183.80" });
    expect(after.schedule.allocation.endOfYear).toBe("500.00");
    const payment = after.built.payments.find((entry) => entry.id === extra)!;
    expect(payment.allocations.map((entry) => entry.appliesTo)).toEqual(["end_of_year"]);
    expect(payment.replacedAllocations.map((entry) => [entry.appliesTo, entry.replaced?.reason])).toEqual([["instalment_3", "IRD moved it to the 2027 end-of-year tax"]]);
    await expect(as((tx) => removeAllocation(tx, { allocationId: confirmed.allocation.id, reason: "again" }))).rejects.toThrow("already changed");
    await as((tx) => removeAllocation(tx, { allocationId: moved.allocation.id, reason: "Not sure yet" }));
    after = await report("2027-03-12");
    expect(after.schedule.allocation).toMatchObject({ awaiting: "500.00", awaitingCount: 1, endOfYear: "0.00" });
  });

  it("ITX6C IRD's effective date, not the bank date, decides whether it was late", async () => {
    await as((tx) => setEffectiveDate(tx, { paymentId: p1, irdEffectiveOn: "2026-09-01" }));
    const { schedule, built } = await report();
    expect(schedule.instalments[0]).toMatchObject({ paid: "6000.00", paidLate: "6000.00" });
    expect(built.payments.find((entry) => entry.id === p1)).toMatchObject({ paidOn: "2026-08-28", irdEffectiveOn: "2026-09-01" });
    expect(built.payments.find((entry) => entry.id === p2)?.irdEffectiveOn).toBe("2027-01-15");
  });

  it("ITX6F a payment counted from the books whose journal is reversed counts for nothing", async () => {
    await as(async (tx) => {
      const account = await tx.query<{ id: string }>("select id::text from accounts where code = '2300'");
      await setPaymentAccounts(tx, { accountIds: [account.rows[0].id] });
    });
    const posted = await as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: "2027-05-07", reference: "IRD provisional", lines: [{ accountCode: "2300", debitAmount: "6183.80" }, { accountCode: "1000", creditAmount: "6183.80" }] }));
    const line = (await as((tx) => bookPayments(tx))).payments.find((entry) => entry.journalId === String(posted.journal.id))!;
    const counted = await as((tx) => countBookPayment(tx, { journalLineId: line.journalLineId, incomeYear: 2027 }));
    await evidenced(counted.paymentId, "instalment_3", "6183.80");
    expect((await report("2027-05-10")).schedule.instalments[2].remaining).toBe("0.00");
    const icaBefore = await as((tx) => buildIca(tx, 2028));
    await as((tx) =>
      correctJournal(tx, { idempotencyKey: key("fix"), originalJournalId: posted.journal.id, postingDate: "2027-05-07", reference: "Was GST", lines: [{ accountCode: "2200", debitAmount: "6183.80" }, { accountCode: "1000", creditAmount: "6183.80" }] }),
    );
    const { schedule, built } = await report("2027-05-10");
    expect(built.payments.find((entry) => entry.id === counted.paymentId)).toMatchObject({ reversed: true, awaiting: "0.00" });
    expect(schedule.instalments[2]).toMatchObject({ paid: "0.00", remaining: "6183.80" });
    expect(schedule.allocation.reversed).toBe("6183.80");
    expect(built.paidTotal).toBe("12867.60");
    await expect(evidenced(counted.paymentId, "instalment_3", "1.00")).rejects.toThrow("reversed");
    const icaAfter = await as((tx) => buildIca(tx, 2028));
    expect(icaAfter.rows.length).toBe(icaBefore.rows.length - 1);
  });

  it("only owners and admins allocate, through the API", async () => {
    const cookie = await sessionCookieFor(bookkeeper);
    const response = await allocateRoute.POST(
      apiRequest(`/api/income-tax/payments/${p1}/allocations`, { method: "POST", cookie, body: { organisationId: org, idempotencyKey: key("alloc"), appliesTo: "instalment_1", amount: "1", status: "evidenced", basis: "x" } }),
      { params: Promise.resolve({ paymentId: p1 }) },
    );
    expect(response.status).toBe(403);
    const payments = await as((tx) => listPayments(tx, 2027));
    expect(payments.length).toBe(4);
  });
});

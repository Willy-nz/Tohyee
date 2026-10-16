import { afterAll, beforeAll, expect, it } from "vitest";
import * as bookPaymentsRoute from "@/app/api/income-tax/book-payments/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { correctJournal, postJournal } from "@/lib/ledger/journals";
import { bookPayments, countBookPayment, setPaymentAccounts } from "@/lib/tax/income/book-payments";
import { buildIca } from "@/lib/tax/income/ica";
import { addPayment, getIncomeTaxSettings, listPayments, removePayment, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

/** IRD payments picked from the books (ITX36-ITX40; chosen by Claude, not yet reviewed). */
describeWithDatabase("income tax: IRD payments from the books", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const org = "tax-books-co";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const journal = (date: string, reference: string, lines: Array<{ accountCode: string; debitAmount?: string; creditAmount?: string }>) =>
    as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: date, reference, lines }));
  const accountId = async (code: string) => (await as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = $1", [code]))).rows[0].id;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("taxbooks-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("taxbooks-bookkeeper@example.com");
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version }));
    await journal("2026-02-09", "IRD end of year", [{ accountCode: "2300", debitAmount: "2000.00" }, { accountCode: "1000", creditAmount: "2000.00" }]);
    await journal("2026-04-07", "IRD EOT", [{ accountCode: "2300", debitAmount: "150.00" }, { accountCode: "1000", creditAmount: "150.00" }]);
    await journal("2026-08-28", "IRD provisional", [{ accountCode: "2300", debitAmount: "6183.80" }, { accountCode: "1000", creditAmount: "6183.80" }]);
    // Not from the bank, and an opening balance: not offered.
    await journal("2026-03-31", "Tax for the year", [{ accountCode: "6070", debitAmount: "500.00" }, { accountCode: "2300", creditAmount: "500.00" }]);
    await journal("2026-06-30", "Reclass", [{ accountCode: "2300", debitAmount: "100.00" }, { accountCode: "2100", creditAmount: "100.00" }]);
    // A refund from IRD into the bank.
    await journal("2026-07-10", "IRD refund", [{ accountCode: "1000", debitAmount: "300.00" }, { accountCode: "2300", creditAmount: "300.00" }]);
  }, 300_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("ITX36 nothing is offered until accounts are chosen, and only balance sheet accounts can be", async () => {
    expect((await as((tx) => bookPayments(tx))).payments).toEqual([]);
    await expect(as(async (tx) => setPaymentAccounts(tx, { accountIds: [await accountId("6070")] }))).rejects.toThrow("balance sheet account");
    await as(async (tx) => setPaymentAccounts(tx, { accountIds: [await accountId("2300")] }));
    const cookie = await sessionCookieFor(bookkeeper);
    expect((await bookPaymentsRoute.GET(apiRequest(`/api/income-tax/book-payments?organisationId=${org}`, { cookie }), noContext)).status).toBe(403);
  });

  it("ITX37, ITX38, ITX40 payments from the bank with suggested years; refunds listed", async () => {
    const found = await as((tx) => bookPayments(tx));
    expect(found.payments.map((line) => [line.date, line.amount, line.suggestedIncomeYear])).toEqual([
      ["2026-02-09", "2000.00", 2025],
      ["2026-04-07", "150.00", 2025],
      ["2026-08-28", "6183.80", 2027],
    ]);
    expect(found.refunds.map((line) => [line.date, line.amount])).toEqual([["2026-07-10", "300.00"]]);
  });

  it("ITX37 a corrected journal: the original isn't offered, the replacement is", async () => {
    const wrong = await journal("2026-09-15", "IRD voluntary", [{ accountCode: "2300", debitAmount: "999.00" }, { accountCode: "1000", creditAmount: "999.00" }]);
    await as((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("fix"),
        originalJournalId: wrong.journal.id,
        postingDate: "2026-09-15",
        reference: "IRD voluntary",
        lines: [{ accountCode: "2300", debitAmount: "900.00" }, { accountCode: "1000", creditAmount: "900.00" }],
      }),
    );
    const amounts = (await as((tx) => bookPayments(tx))).payments.map((line) => line.amount);
    expect(amounts).toContain("900.00");
    expect(amounts).not.toContain("999.00");
  });

  it("ITX39 counting links the line; a matching typed payment is linked, not doubled; removing frees it", async () => {
    // Already typed by hand before the books were used.
    await as((tx) => addPayment(tx, { idempotencyKey: key("pay"), incomeYear: 2027, paidOn: "2026-08-28", amount: "6183.80" }));
    let found = await as((tx) => bookPayments(tx));
    const provisional = found.payments.find((line) => line.amount === "6183.80")!;
    expect(provisional.typedMatch).toMatchObject({ incomeYear: 2027 });
    const linked = await as((tx) => countBookPayment(tx, { journalLineId: provisional.journalLineId, incomeYear: 2027 }));
    expect(linked.linkedTyped).toBe(true);
    expect(await as((tx) => listPayments(tx, 2027))).toHaveLength(1);

    const endOfYear = found.payments.find((line) => line.amount === "2000.00")!;
    const counted = await as((tx) => countBookPayment(tx, { journalLineId: endOfYear.journalLineId, incomeYear: 2025 }));
    expect(counted.linkedTyped).toBe(false);
    expect((await as((tx) => listPayments(tx, 2025))).map((payment) => [payment.paidOn, payment.amount, payment.note])).toEqual([["2026-02-09", "2000.00", "From the books: IRD end of year"]]);
    await expect(as((tx) => countBookPayment(tx, { journalLineId: endOfYear.journalLineId, incomeYear: 2025 }))).rejects.toThrow("already counted");
    found = await as((tx) => bookPayments(tx));
    expect(found.payments.map((line) => line.amount)).toEqual(["150.00", "900.00"]);

    // Counted payments are income tax paid in the ICA (ITX26).
    expect((await as((tx) => buildIca(tx, 2026))).rows.map((row) => [row.kind, row.amount])).toEqual([["tax_paid", "2000.00"]]);

    await as((tx) => removePayment(tx, counted.paymentId));
    expect((await as((tx) => bookPayments(tx))).payments.map((line) => line.amount)).toEqual(["2000.00", "150.00", "900.00"]);
  });
});

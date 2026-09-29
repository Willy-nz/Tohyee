import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as claimRoute from "@/app/api/expense-claims/[claimId]/route";
import * as claimsRoute from "@/app/api/expense-claims/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, suggestionsForLine } from "@/lib/bank/reconcile";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import {
  approveExpenseClaim,
  createExpenseClaim,
  declineExpenseClaim,
  deleteExpenseClaim,
  type ExpenseClaim,
  getExpenseClaim,
  listExpenseClaims,
  recordExpenseClaimPayment,
  submitExpenseClaim,
  updateExpenseClaim,
  voidExpenseClaim,
  voidExpenseClaimPayment,
} from "@/lib/expense-claims/service";
import { getJournal, getJournalDetails } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { addAttachment, getRecordExtras } from "@/lib/records/extras";
import { accountTransactions } from "@/lib/reports/account-transactions";
import { calculateGstReturn, fileGstReturn, getGstReturn } from "@/lib/reports/gst-return";
import { createTrackingValue, getTrackingSetup, updateTrackingCategory } from "@/lib/tracking/service";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  testDatabaseUrl,
  type TestServer,
  withDb,
} from "../helpers/test-server";

const noContext = undefined as unknown;
const b64 = (text: string) => Buffer.from(text).toString("base64");
const PDF = (() => {
  const bytes = new Uint8Array(200).fill(0x41);
  bytes.set(Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1"));
  return bytes;
})();

/** Examples EC1-EC12 in docs/ACCOUNTING-EXAMPLES.md ("Expense claims"). Each test gets its own organisation. */
describeWithDatabase("expense claims", () => {
  let server: TestServer;
  let owner: SessionUser;
  let aroha: SessionUser;
  let sam: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("ec-jess@example.com", { serverAdmin: true });
    aroha = await createTestUser("ec-aroha@example.com");
    sam = await createTestUser("ec-sam@example.com", { displayName: "Sam Rewi" });
    viewer = await createTestUser("ec-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const RECEIPTS = [
    { receiptDate: "2026-06-03", supplierName: "Z Energy", description: "Fuel to Dunedin market", accountCode: "6120", taxCode: "GST", amount: "69.00" },
    { receiptDate: "2026-06-05", supplierName: "Paper Plus", description: "Printer paper", accountCode: "6140", taxCode: "GST", amount: "23.00" },
    { receiptDate: "2026-06-06", supplierName: "Farmers market", description: "Parking", accountCode: "6180", taxCode: null, amount: "8.00" },
  ];

  async function setup() {
    organisations += 1;
    const org = `ec-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [aroha, "bookkeeper"],
      [sam, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const as = asUser(owner);
    const asSam = asUser(sam);
    const asAroha = asUser(aroha);
    const draft = async (receipts: unknown[] = RECEIPTS, idempotencyKey = key("claim")) =>
      (await asSam((tx) => createExpenseClaim(tx, { idempotencyKey, description: "June market trip", receipts }))).claim;
    const submitted = async (receipts: unknown[] = RECEIPTS) => {
      const claim = await draft(receipts);
      return asSam((tx) => submitExpenseClaim(tx, claim.id));
    };
    const approve = async (id: string, claimDate = "2026-06-10", idempotencyKey = key("approve")) =>
      (await asAroha((tx) => approveExpenseClaim(tx, "bookkeeper", id, { idempotencyKey, claimDate }))).claim;
    const approved = async () => approve((await submitted()).id);
    const pay = (id: string, amount: string, paymentDate = "2026-06-15", idempotencyKey = key("pay")) =>
      asAroha((tx) => recordExpenseClaimPayment(tx, "bookkeeper", id, { idempotencyKey, paymentDate, amount, bankAccountCode: "1000" }));
    const journal = async (journalId: string) =>
      (await as((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    return { org, as, asSam, asAroha, draft, submitted, approve, approved, pay, journal, journals };
  }

  it("EC1: a draft claim works out each receipt's GST from the tax inclusive amount and posts nothing", async () => {
    const w = await setup();
    const account = await w.as((tx) => tx.query<{ code: string; name: string }>("select code, name from accounts where system_key = 'expense_claims_payable'"));
    expect(account.rows[0]).toEqual({ code: "2010", name: "Expense claims payable" });
    const claim = await w.draft();
    expect([claim.status, claim.claimantEmail, claim.total, claim.taxTotal, claim.subtotal, claim.reference]).toEqual([
      "draft",
      sam.email,
      "100.00",
      "12.00",
      "88.00",
      `CLAIM-${claim.id}`,
    ]);
    expect(claim.receipts.map((r) => [r.supplierName, r.accountCode, r.taxCode, r.amount, r.netAmount, r.taxAmount])).toEqual([
      ["Z Energy", "6120", "GST", "69.00", "60.00", "9.00"],
      ["Paper Plus", "6140", "GST", "23.00", "20.00", "3.00"],
      ["Farmers market", "6180", null, "8.00", "8.00", "0.00"],
    ]);
    expect(await w.journals()).toBe(0);
    const one = (fields: Record<string, unknown>) => w.draft([{ ...RECEIPTS[0], ...fields }]);
    await expect(one({ accountCode: "1400" })).rejects.toThrow("comes in on bills");
    await expect(one({ accountCode: "1000" })).rejects.toThrow("bank account");
    await expect(one({ accountCode: "2010" })).rejects.toThrow("expense claims payable account");
    await expect(one({ accountCode: "2100" })).rejects.toThrow("GST account");
    await expect(one({ amount: "0.00" })).rejects.toThrow("amount");
    await expect(one({ amount: "1.001" })).rejects.toThrow("at most 2 decimal places");
    await expect(one({ taxCode: "NOPE" })).rejects.toThrow("no tax code NOPE");
    await expect(one({ supplierName: "" })).rejects.toThrow("supplier is required");
    // Only the claimant changes or deletes their draft.
    await expect(w.asAroha((tx) => updateExpenseClaim(tx, claim.id, { description: "Mine now" }))).rejects.toThrow("Only Sam Rewi, who made this claim");
    await expect(w.asAroha((tx) => deleteExpenseClaim(tx, claim.id))).rejects.toThrow("Only Sam Rewi, who made this claim");
    const edited = await w.asSam((tx) => updateExpenseClaim(tx, claim.id, { receipts: RECEIPTS.slice(0, 2) }));
    expect([edited.total, edited.taxTotal]).toEqual(["92.00", "12.00"]);
    await w.asSam((tx) => deleteExpenseClaim(tx, claim.id));
    await expect(w.as((tx) => getExpenseClaim(tx, claim.id))).rejects.toThrow("not found");
  });

  it("EC2: submitting sends a draft for approval and freezes it", async () => {
    const w = await setup();
    const empty = await w.draft([]);
    await expect(w.asSam((tx) => submitExpenseClaim(tx, empty.id))).rejects.toThrow("at least one receipt");
    const claim = await w.submitted();
    expect([claim.status, claim.submittedAt !== null]).toEqual(["submitted", true]);
    expect((await w.asSam((tx) => submitExpenseClaim(tx, claim.id))).status).toBe("submitted");
    await expect(w.asSam((tx) => updateExpenseClaim(tx, claim.id, { description: "Changed" }))).rejects.toThrow("is submitted");
    await expect(w.asSam((tx) => deleteExpenseClaim(tx, claim.id))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update expense_claim_receipts set amount = 1, net_amount = 1, tax_amount = 0 where claim_id = $1", [claim.id]))).rejects.toThrow(
      "only change while their expense claim is a draft",
    );
    await expect(w.as((tx) => tx.query("delete from expense_claims where id = $1", [claim.id]))).rejects.toThrow("Only draft expense claims");
    expect((await w.as((tx) => listExpenseClaims(tx, { status: "submitted" }))).map((c) => c.id)).toEqual([claim.id]);
    expect(await w.journals()).toBe(0);
  });

  it("EC3: approving posts Dr each expense account and GST / Cr expense claims payable on the claim date", async () => {
    const w = await setup();
    const claim = await w.submitted();
    await expect(w.asSam((tx) => approveExpenseClaim(tx, "bookkeeper", claim.id, { idempotencyKey: key("a"), claimDate: "2026-06-10" }))).rejects.toThrow(
      "can't approve your own",
    );
    await expect(w.approve(claim.id, "2026-06-05")).rejects.toThrow("latest receipt (2026-06-06)");
    const k = key("approve");
    const done = await w.approve(claim.id, "2026-06-10", k);
    expect([done.status, done.claimDate, done.approvedByEmail, done.amountDue, done.paidStatus]).toEqual(["approved", "2026-06-10", aroha.email, "100.00", "unpaid"]);
    const posted = await w.as((tx) => getJournal(tx, done.approvalJournalId!));
    expect([posted.postingDate, posted.reference, posted.origin]).toEqual(["2026-06-10", `CLAIM-${claim.id}`, "expense_claim"]);
    // The claimant is named, not shown by email.
    expect(posted.description).toBe(`Expense claim CLAIM-${claim.id} from Sam Rewi`);
    expect(posted.lines.map((line) => line.description)).toEqual(["Sam Rewi", "Sam Rewi", "Sam Rewi", "GST", "Sam Rewi"]);
    expect(await w.journal(done.approvalJournalId!)).toEqual([
      ["6120", "60.00", "0.00"],
      ["6140", "20.00", "0.00"],
      ["6180", "8.00", "0.00"],
      ["2100", "12.00", "0.00"],
      ["2010", "0.00", "100.00"],
    ]);
    // A retry returns the same claim; the same key for another date is refused.
    expect((await w.approve(claim.id, "2026-06-10", k)).approvalJournalId).toBe(done.approvalJournalId);
    await expect(w.approve(claim.id, "2026-06-11", k)).rejects.toThrow("idempotency key");
    // An admin or owner can approve their own claim.
    const own = (await w.as((tx) => createExpenseClaim(tx, { idempotencyKey: key("own"), receipts: [RECEIPTS[1]] }))).claim;
    await w.as((tx) => submitExpenseClaim(tx, own.id));
    const ownApproved = (await w.as((tx) => approveExpenseClaim(tx, "owner", own.id, { idempotencyKey: key("a"), claimDate: "2026-06-10" }))).claim;
    expect(ownApproved.status).toBe("approved");
    await expect(w.as((tx) => tx.query("update expense_claims set description = 'x' where id = $1", [claim.id]))).rejects.toThrow("can't change like that");
  });

  it("EC4: paying the claim clears the liability and shows in bank reconciliation", async () => {
    const w = await setup();
    const claim = await w.approved();
    const { payment, claim: paid } = await w.pay(claim.id, "100.00");
    expect([paid.amountPaid, paid.amountDue, paid.paidStatus]).toEqual(["100.00", "0.00", "paid"]);
    expect(await w.journal(payment.journalId)).toEqual([
      ["2010", "100.00", "0.00"],
      ["1000", "0.00", "100.00"],
    ]);
    expect((await w.as((tx) => getJournal(tx, payment.journalId))).description).toBe(`Payment of expense claim CLAIM-${claim.id} to Sam Rewi`);
    const payable = await w.as((tx) =>
      tx.query<{ balance: string }>(
        "select coalesce(sum(l.credit_amount - l.debit_amount), 0)::text as balance from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = '2010'",
      ),
    );
    expect(payable.rows[0].balance).toBe("0.00");
    const bank = (await w.as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    await w.as((tx) => importStatementFile(tx, bank.id, { idempotencyKey: key("import"), fileName: "june.csv", fileBase64: b64("Date,Amount,Payee\n15/06/2026,-100.00,SAM\n") }));
    const line = (await w.as((tx) => listStatementLines(tx, bank.id, { status: "all" }))).lines[0];
    const suggestions = await w.as((tx) => suggestionsForLine(tx, line.id));
    const match = suggestions.matches.find((entry) => entry.journalId === payment.journalId)!;
    expect(match).toMatchObject({ exact: true, origin: "expense_claim_payment" });
    const { line: reconciled } = await w.as((tx) =>
      reconcileStatementLine(tx, line.id, { idempotencyKey: key("rec"), kind: "match", journalLineIds: [match.journalLineId] }),
    );
    expect(reconciled.status).toBe("reconciled");
    expect((await w.as((tx) => listExpenseClaims(tx, { status: "awaiting_payment" }))).length).toBe(0);
  });

  it("EC5: part payments, overpayments refused, and voiding a payment", async () => {
    const w = await setup();
    const claim = await w.approved();
    const first = await w.pay(claim.id, "40.00");
    expect([first.claim.amountDue, first.claim.paidStatus]).toEqual(["60.00", "part_paid"]);
    expect((await w.as((tx) => listExpenseClaims(tx, { status: "awaiting_payment" }))).map((c) => c.id)).toEqual([claim.id]);
    await expect(w.pay(claim.id, "60.01")).rejects.toThrow("more than the amount due (60.00)");
    await expect(w.pay(claim.id, "10.00", "2026-06-09")).rejects.toThrow("before the claim date");
    const k = key("pay");
    const second = await w.pay(claim.id, "60.00", "2026-06-15", k);
    expect([second.claim.amountDue, second.claim.paidStatus]).toEqual(["0.00", "paid"]);
    expect((await w.pay(claim.id, "60.00", "2026-06-15", k)).payment.id).toBe(second.payment.id);
    await expect(w.pay(claim.id, "1.00", "2026-06-15", k)).rejects.toThrow("idempotency key");
    const voided = await w.asAroha((tx) => voidExpenseClaimPayment(tx, "bookkeeper", claim.id, second.payment.id, { idempotencyKey: key("v"), voidDate: "2026-06-20" }));
    expect(await w.journal(voided.payment.voidJournalId!)).toEqual([
      ["2010", "0.00", "60.00"],
      ["1000", "60.00", "0.00"],
    ]);
    expect([voided.claim.amountDue, voided.claim.paidStatus]).toEqual(["60.00", "part_paid"]);
    await expect(
      w.asAroha((tx) => voidExpenseClaimPayment(tx, "bookkeeper", claim.id, second.payment.id, { idempotencyKey: key("v"), voidDate: "2026-06-20" })),
    ).rejects.toThrow("already been voided");
    await expect(w.as((tx) => tx.query("delete from expense_claim_payments where id = $1", [first.payment.id]))).rejects.toThrow("can't be deleted");
    await expect(
      w.as((tx) =>
        tx.query(
          `insert into expense_claim_payments (command_source, idempotency_key, request_hash, claim_id, payment_date, amount, bank_account_id, journal_id)
           select 'x', 'y', 'z', $1, '2026-06-15', 60.01, a.id, $2 from accounts a where a.code = '1000'`,
          [claim.id, first.payment.journalId],
        ),
      ),
    ).rejects.toThrow("more than its total");
  });

  it("EC6: declining a submitted claim returns it to its claimant with a reason", async () => {
    const w = await setup();
    const claim = await w.submitted();
    await expect(w.asAroha((tx) => declineExpenseClaim(tx, "bookkeeper", claim.id, { reason: "" }))).rejects.toThrow("reason is required");
    const declined = await w.asAroha((tx) => declineExpenseClaim(tx, "bookkeeper", claim.id, { reason: "Parking isn't claimable" }));
    expect([declined.status, declined.declineReason, declined.declinedByEmail, declined.submittedAt]).toEqual([
      "draft",
      "Parking isn't claimable",
      aroha.email,
      null,
    ]);
    await expect(w.asAroha((tx) => declineExpenseClaim(tx, "bookkeeper", claim.id, { reason: "Again" }))).rejects.toThrow("only submitted claims");
    const edited = await w.asSam((tx) => updateExpenseClaim(tx, claim.id, { receipts: RECEIPTS.slice(0, 2) }));
    const again = await w.asSam((tx) => submitExpenseClaim(tx, edited.id));
    expect([again.status, again.total, again.declineReason]).toEqual(["submitted", "92.00", null]);
    const approved = await w.approve(claim.id);
    await expect(w.asAroha((tx) => declineExpenseClaim(tx, "bookkeeper", approved.id, { reason: "Too late" }))).rejects.toThrow("only submitted claims");
    const history = await w.as((tx) => getRecordExtras(tx, "owner", "expense-claim", claim.id));
    expect(history.history.map((entry) => entry.eventType)).toEqual(
      expect.arrayContaining(["expense_claim.created", "expense_claim.submitted", "expense_claim.declined", "expense_claim.approved"]),
    );
  });

  it("EC7: voiding an approved unpaid claim posts the exact reversal", async () => {
    const w = await setup();
    const claim = await w.approved();
    const payment = await w.pay(claim.id, "10.00");
    await expect(w.asAroha((tx) => voidExpenseClaim(tx, "bookkeeper", claim.id, { idempotencyKey: key("v"), voidDate: "2026-06-30" }))).rejects.toThrow(
      "Void its payments first",
    );
    await w.asAroha((tx) => voidExpenseClaimPayment(tx, "bookkeeper", claim.id, payment.payment.id, { idempotencyKey: key("vp"), voidDate: "2026-06-16" }));
    await expect(w.asAroha((tx) => voidExpenseClaim(tx, "bookkeeper", claim.id, { idempotencyKey: key("v"), voidDate: "2026-06-09" }))).rejects.toThrow(
      "before the claim date",
    );
    const voided = (await w.asAroha((tx) => voidExpenseClaim(tx, "bookkeeper", claim.id, { idempotencyKey: key("v"), voidDate: "2026-06-30" }))).claim;
    expect(voided.status).toBe("voided");
    expect(await w.journal(voided.voidJournalId!)).toEqual([
      ["6120", "0.00", "60.00"],
      ["6140", "0.00", "20.00"],
      ["6180", "0.00", "8.00"],
      ["2100", "0.00", "12.00"],
      ["2010", "100.00", "0.00"],
    ]);
    await expect(w.asAroha((tx) => voidExpenseClaim(tx, "bookkeeper", claim.id, { idempotencyKey: key("v"), voidDate: "2026-06-30" }))).rejects.toThrow(
      "already been voided",
    );
    await expect(w.pay(claim.id, "1.00")).rejects.toThrow("voided, so it can't be paid");
  });

  it("EC8: locked periods refuse approving, paying and voiding, and nothing is posted", async () => {
    const w = await setup();
    const claim = await w.submitted();
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-06-30" }));
    const before = await w.journals();
    await expect(w.approve(claim.id, "2026-06-10")).rejects.toThrow(/locked period/);
    expect((await w.as((tx) => getExpenseClaim(tx, claim.id))).status).toBe("submitted");
    const approved = await w.approve(claim.id, "2026-07-01");
    await expect(w.pay(approved.id, "100.00", "2026-06-30")).rejects.toThrow(/before the claim date/);
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-07-01" }));
    await expect(w.pay(approved.id, "100.00", "2026-07-01")).rejects.toThrow(/locked period/);
    await expect(w.asAroha((tx) => voidExpenseClaim(tx, "bookkeeper", approved.id, { idempotencyKey: key("v"), voidDate: "2026-07-01" }))).rejects.toThrow(/locked period/);
    expect(await w.journals()).toBe(before + 1);
  });

  it("EC9: receipts carry tracking onto the journal, and required categories are checked on submit", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await w.as((tx) => getTrackingSetup(tx))).categories.find((c) => c.kind === "department")!.id;
    const retail = (await w.as((tx) => createTrackingValue(tx, { categoryId: department, name: "Retail" }))).categories
      .find((c) => c.id === department)!
      .values.find((v) => v.name === "Retail")!.id;
    await w.as((tx) => updateTrackingCategory(tx, department, { isRequired: true }));
    const untagged = await w.draft([RECEIPTS[0]]);
    await expect(w.asSam((tx) => submitExpenseClaim(tx, untagged.id))).rejects.toThrow("Line 1 needs a Department");
    const tagged = await w.draft([{ ...RECEIPTS[0], tracking: { [department]: retail } }]);
    await w.asSam((tx) => submitExpenseClaim(tx, tagged.id));
    const approved = await w.approve(tagged.id);
    const lines = (await w.as((tx) => getJournal(tx, approved.approvalJournalId!))).lines;
    expect(lines.map((line) => [line.accountCode, line.tracking])).toEqual([
      ["6120", { [department]: retail }],
      ["2100", {}],
      ["2010", {}],
    ]);
  });

  it("EC10: the GST return counts approved claims like bills, on each basis", async () => {
    const w = await setup();
    const claim = await w.approved();
    const june = { periodStart: "2026-06-01", periodEnd: "2026-06-30" };
    const invoiceBasis = await w.as((tx) => calculateGstReturn(tx, june));
    expect([invoiceBasis.boxes.box11, invoiceBasis.boxes.box12]).toEqual(["92.00", "12.00"]);
    const counted = invoiceBasis.lines.filter((line) => line.documentType === "expense_claim");
    expect(counted.map((line) => [line.eventType, line.description, line.amount, line.gst, line.boxes, line.contactId, line.contactName])).toEqual([
      ["expense_claim_approved", "Z Energy: Fuel to Dunedin market", "69.00", "9.00", ["11"], null, "Sam Rewi"],
      ["expense_claim_approved", "Paper Plus: Printer paper", "23.00", "3.00", ["11"], null, "Sam Rewi"],
      ["expense_claim_approved", "Farmers market: Parking", "8.00", "0.00", [], null, "Sam Rewi"],
    ]);
    // Filed, its counted lines keep the claimant and no contact.
    const filed = await w.as((tx) => fileGstReturn(tx, { idempotencyKey: key("file"), ...june }));
    const stored = await w.as((tx) => getGstReturn(tx, filed.gstReturn.id));
    expect(stored.lines.filter((line) => line.documentType === "expense_claim").map((line) => [line.amount, line.contactId, line.contactName])).toEqual([
      ["69.00", null, "Sam Rewi"],
      ["23.00", null, "Sam Rewi"],
    ]);
    const july = { periodStart: "2026-07-01", periodEnd: "2026-07-31" };
    await w.as((tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    expect((await w.as((tx) => calculateGstReturn(tx, july))).boxes.box11).toBe("0.00");
    await w.pay(claim.id, "40.00", "2026-07-15");
    const paymentsBasis = await w.as((tx) => calculateGstReturn(tx, july));
    expect([paymentsBasis.boxes.box11, paymentsBasis.boxes.box12]).toEqual(["36.80", "4.80"]);
    await w.as((tx) => updateOrganisationSettings(tx, { gstBasis: "invoice" }));
    const other = await w.approved();
    await w.asAroha((tx) => voidExpenseClaim(tx, "bookkeeper", other.id, { idempotencyKey: key("v"), voidDate: "2026-06-30" }));
    expect((await w.as((tx) => calculateGstReturn(tx, june))).boxes.box11).toBe("92.00");
  });

  it("EC11: receipts are attached as files; viewers can read claims but not make them", async () => {
    const w = await setup();
    const claim = await w.draft();
    const { attachment } = await w.asSam((tx) => addAttachment(tx, "bookkeeper", "expense-claim", claim.id, { idempotencyKey: key("file"), fileName: "fuel.pdf", content: PDF }));
    expect(attachment.fileName).toBe("fuel.pdf");
    expect((await w.as((tx) => getRecordExtras(tx, "owner", "expense-claim", claim.id))).attachments.map((a) => a.fileName)).toEqual(["fuel.pdf"]);
    const viewerCookie = await sessionCookieFor(viewer);
    const samCookie = await sessionCookieFor(sam);
    const body = { organisationId: w.org, idempotencyKey: key("http"), receipts: RECEIPTS };
    expect((await claimsRoute.POST(apiRequest("/api/expense-claims", { method: "POST", cookie: viewerCookie, body }), noContext)).status).toBe(403);
    const created = await claimsRoute.POST(apiRequest("/api/expense-claims", { method: "POST", cookie: samCookie, body }), noContext);
    expect(created.status).toBe(201);
    const { claim: made } = (await created.json()) as { claim: ExpenseClaim };
    expect(made.claimantEmail).toBe(sam.email);
    const listed = await claimsRoute.GET(apiRequest(`/api/expense-claims?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(((await listed.json()) as { claims: unknown[] }).claims).toHaveLength(2);
    const opened = await claimRoute.GET(apiRequest(`/api/expense-claims/${made.id}?organisationId=${w.org}`, { cookie: viewerCookie }), {
      params: Promise.resolve({ claimId: made.id }),
    });
    expect(opened.status).toBe(200);
  });

  it("EC1: migration 0028 gives an existing organisation the expense claims payable account, at the next free code", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_claims`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      await applyMigrations(client, tenantMigrations.filter((migration) => migration.version < "0028"), "test:upgrade");
      await client.query("insert into organisation_settings (organisation_id, display_name, base_currency) values ('claims-co', 'Claims Co', 'NZD')");
      await client.query(
        `insert into accounts (code, name, account_class, account_type, system_key) values
           ('2000', 'Accounts payable', 'liability', 'current_liability', 'accounts_payable'),
           ('2010', 'Loan from Jess', 'liability', 'current_liability', null)`,
      );
      expect((await applyMigrations(client, tenantMigrations, "test:upgrade")).applied).toContain("0028");
      expect((await client.query("select code, name, account_type, system_key from accounts where code like '201%' order by code")).rows).toEqual([
        { code: "2010", name: "Loan from Jess", account_type: "current_liability", system_key: null },
        { code: "2011", name: "Expense claims payable", account_type: "current_liability", system_key: "expense_claims_payable" },
      ]);
    } finally {
      await client.end();
    }
  });

  it("EC12: claim journals show where they came from and are corrected by voiding the claim", async () => {
    const w = await setup();
    const claim = await w.approved();
    const { payment } = await w.pay(claim.id, "100.00");
    const details = await w.as((tx) => getJournalDetails(tx, claim.approvalJournalId!));
    expect(details.canCorrect).toBe(false);
    expect((await w.as((tx) => getJournalDetails(tx, payment.journalId))).canCorrect).toBe(false);
    const payableId = (await w.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '2010'"))).rows[0].id;
    const report = await w.as((tx) => accountTransactions(tx, { accountId: payableId, from: "2026-06-01", to: "2026-06-30" }));
    expect(report.accounts[0].lines.map((line) => [line.source.label, line.source.href])).toEqual([
      [`Expense claim CLAIM-${claim.id}`, `/operations/expense-claims/${claim.id}`],
      [`Payment of expense claim CLAIM-${claim.id}`, `/operations/expense-claims/${claim.id}`],
    ]);
  });
});

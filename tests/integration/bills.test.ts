import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as approveRoute from "@/app/api/bills/[billId]/approve/route";
import * as billRoute from "@/app/api/bills/[billId]/route";
import * as voidRoute from "@/app/api/bills/[billId]/void/route";
import * as billsRoute from "@/app/api/bills/route";
import { createAccount, updateAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import {
  approveBill,
  type Bill,
  type BillSummary,
  createBill,
  deleteBill,
  getBill,
  listBills,
  updateBill,
  voidBill,
} from "@/lib/bills/service";
import { archiveContact, type Contact, createContact, updateContact } from "@/lib/contacts/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { correctJournal, getJournal, getJournalDetails, listJournals } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
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
  waitForLockWaiters,
  withDb,
} from "../helpers/test-server";

const ORG = "bills-co";
const noContext = undefined as unknown;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

type LineInput = {
  description: string;
  quantity: string;
  unitPrice: string;
  accountCode: string;
  taxCode: string | null;
};

function line(quantity: string, unitPrice: string, taxCode: string | null = "GST", accountCode = "6010"): LineInput {
  return { description: "Year-end accounts", quantity, unitPrice, accountCode, taxCode };
}

let numberCounter = 0;
/** A supplier invoice number no other bill in this file uses. */
function nextNumber(): string {
  numberCounter += 1;
  return `SI-${numberCounter}`;
}

/** Examples B1-B8 in docs/ACCOUNTING-EXAMPLES.md ("Bills"). */
describeWithDatabase("bills", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let supplier: Contact;
  let otherSupplier: Contact;
  let customer: Contact;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  /** Saves a draft: 1 x $200.00 at 15% exclusive to 6010 (example B1) unless told otherwise. */
  const draft = async (fields: Record<string, unknown> = {}): Promise<Bill> =>
    (
      await asUser(bookkeeper, (tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: supplier.id,
          billDate: "2026-05-10",
          dueDate: "2026-06-20",
          supplierInvoiceNumber: nextNumber(),
          amountsMode: "exclusive",
          lines: [line("1", "200.00")],
          ...fields,
        }),
      )
    ).bill;
  const approve = (billId: string, idempotencyKey = key("approve")) =>
    asUser(bookkeeper, (tx) => approveBill(tx, billId, { idempotencyKey }));
  const voidIt = (billId: string, voidDate: string, idempotencyKey = key("void")) =>
    asUser(bookkeeper, (tx) => voidBill(tx, billId, { idempotencyKey, voidDate }));
  const journal = (journalId: string) => asUser(owner, (tx) => getJournal(tx, journalId));
  /** A journal's lines as [account, debit, credit]. */
  const postedLines = async (journalId: string) =>
    (await journal(journalId)).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);
  const journalCount = async () =>
    Number(
      (await asUser(owner, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals")))
        .rows[0].count,
    );
  const newContact = async (name: string, roles: { isCustomer?: boolean; isSupplier?: boolean }) =>
    (await asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...roles }))).contact;

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
    await asUser(owner, async (tx) => {
      await createTaxCode(tx, {
        idempotencyKey: key("tax"),
        code: "GST",
        label: "GST on expenses (15%)",
        category: "standard",
        rate: "0.15",
        effectiveFrom: "2026-01-01",
      });
      await createTaxCode(tx, {
        idempotencyKey: key("tax"),
        code: "EXEMPT",
        label: "Exempt purchases",
        category: "exempt",
        rate: "0",
        effectiveFrom: "2026-01-01",
      });
    });
    supplier = await newContact("Kauri Supplies", { isSupplier: true });
    otherSupplier = await newContact("Tōtara Timber", { isSupplier: true });
    customer = await newContact("Aroha Café Ltd", { isCustomer: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("B1: exclusive 1 x $200.00 at 15% to 6010 is net 200.00, GST 30.00, total 230.00; approving posts Dr 6010 / Dr 2100 / Cr 2000", async () => {
    const saved = await draft({ supplierInvoiceNumber: "KS-1001" });
    expect(saved).toMatchObject({
      status: "draft",
      approvalJournalId: null,
      contactId: supplier.id,
      contactName: "Kauri Supplies",
      supplierInvoiceNumber: "KS-1001",
      billDate: "2026-05-10",
      dueDate: "2026-06-20",
      amountsMode: "exclusive",
      currencyCode: "NZD",
      subtotal: "200.00",
      taxTotal: "30.00",
      total: "230.00",
      createdByEmail: bookkeeper.email,
    });
    expect(saved.lines).toEqual([
      expect.objectContaining({
        lineOrder: 1,
        quantity: "1",
        unitPrice: "200",
        accountCode: "6010",
        accountName: "Accounting fees",
        taxCode: "GST",
        taxRate: "0.15",
        lineAmount: "200.00",
        netAmount: "200.00",
        taxAmount: "30.00",
      }),
    ]);

    const { created, bill } = await approve(saved.id);
    expect(created).toBe(true);
    expect(bill).toMatchObject({ status: "approved", approvedByEmail: bookkeeper.email, total: "230.00" });
    const posted = await journal(bill.approvalJournalId!);
    expect(posted).toMatchObject({
      origin: "bill",
      postingDate: "2026-05-10",
      reference: "KS-1001",
      description: "Bill KS-1001 from Kauri Supplies",
      totalDebit: "230.00",
      relatedJournalId: null,
      correctionKind: null,
      createdByEmail: bookkeeper.email,
    });
    expect(await postedLines(posted.id)).toEqual([
      ["6010", "200.00", "0.00"],
      ["2100", "30.00", "0.00"],
      ["2000", "0.00", "230.00"],
    ]);
  });

  it("B2: inclusive 1 x $46.00 at 15% to 6040 has GST 46.00 x 3/23 = 6.00, net 40.00, total 46.00", async () => {
    const saved = await draft({ amountsMode: "inclusive", lines: [line("1", "46.00", "GST", "6040")] });
    expect(saved).toMatchObject({ subtotal: "40.00", taxTotal: "6.00", total: "46.00" });
    expect(saved.lines[0]).toMatchObject({ accountCode: "6040", lineAmount: "46.00", netAmount: "40.00", taxAmount: "6.00" });
    const { bill } = await approve(saved.id);
    expect(await postedLines(bill.approvalJournalId!)).toEqual([
      ["6040", "40.00", "0.00"],
      ["2100", "6.00", "0.00"],
      ["2000", "0.00", "46.00"],
    ]);
  });

  it("B3: GST is rounded per line: three lines of 1 x $3.33 have GST 0.50 each, 1.50 in all, total 11.49 (same as I3)", async () => {
    const saved = await draft({ lines: [line("1", "3.33"), line("1", "3.33"), line("1", "3.33")] });
    expect(saved.lines.map((entry) => entry.taxAmount)).toEqual(["0.50", "0.50", "0.50"]);
    expect(saved).toMatchObject({ subtotal: "9.99", taxTotal: "1.50", total: "11.49" });
    const { bill } = await approve(saved.id);
    // One debit per account, not one per bill line.
    expect(await postedLines(bill.approvalJournalId!)).toEqual([
      ["6010", "9.99", "0.00"],
      ["2100", "1.50", "0.00"],
      ["2000", "0.00", "11.49"],
    ]);
  });

  it("B4: $100.00 at standard 15% plus $20.00 exempt is GST 15.00, total 135.00", async () => {
    const saved = await draft({ lines: [line("1", "100.00", "GST", "6010"), line("1", "20.00", "EXEMPT", "6150")] });
    expect(saved.lines.map((entry) => [entry.taxCode, entry.taxRate, entry.taxAmount])).toEqual([
      ["GST", "0.15", "15.00"],
      ["EXEMPT", "0", "0.00"],
    ]);
    expect(saved).toMatchObject({ subtotal: "120.00", taxTotal: "15.00", total: "135.00" });
    const { bill } = await approve(saved.id);
    expect(await postedLines(bill.approvalJournalId!)).toEqual([
      ["6010", "100.00", "0.00"],
      ["6150", "20.00", "0.00"],
      ["2100", "15.00", "0.00"],
      ["2000", "0.00", "135.00"],
    ]);
  });

  it("each account is debited with its own net amount, in the order they first appear", async () => {
    const saved = await draft({
      lines: [line("1", "40.00", "GST", "6040"), line("1", "100.00", "GST", "1600"), line("2", "5.00", "EXEMPT", "6040")],
    });
    const { bill } = await approve(saved.id);
    expect(await postedLines(bill.approvalJournalId!)).toEqual([
      ["6040", "50.00", "0.00"],
      ["1600", "100.00", "0.00"],
      ["2100", "21.00", "0.00"],
      ["2000", "0.00", "171.00"],
    ]);
  });

  it("no tax: 1 x $80.00 is total 80.00 and posts no GST line", async () => {
    const saved = await draft({ amountsMode: "no_tax", lines: [line("1", "80.00", null, "5000")] });
    expect(saved).toMatchObject({ subtotal: "80.00", taxTotal: "0.00", total: "80.00" });
    expect(saved.lines[0]).toMatchObject({ taxCode: null, taxRate: "0", taxAmount: "0.00" });
    const { bill } = await approve(saved.id);
    expect(await postedLines(bill.approvalJournalId!)).toEqual([
      ["5000", "80.00", "0.00"],
      ["2000", "0.00", "80.00"],
    ]);
  });

  it("B5: 'inv 42' from the same supplier is refused while 'INV42' isn't voided; after voiding it's allowed; another supplier can use it", async () => {
    const first = (await approve((await draft({ supplierInvoiceNumber: "INV42" })).id)).bill;
    for (const number of ["inv 42", "INV42", " Inv 4 2 "]) {
      await expect(draft({ supplierInvoiceNumber: number }), number).rejects.toThrow(
        `Kauri Supplies already has a bill with the invoice number INV42 (approved bill #${first.id}).`,
      );
    }
    // An edit can't take the number either.
    const other = await draft({ supplierInvoiceNumber: "KS-2001" });
    await expect(asUser(bookkeeper, (tx) => updateBill(tx, other.id, { supplierInvoiceNumber: "inv42" }))).rejects.toThrow(
      /already has a bill with the invoice number INV42/,
    );
    expect((await asUser(viewer, (tx) => getBill(tx, other.id))).supplierInvoiceNumber).toBe("KS-2001");

    // The same number from a different supplier is fine.
    const elsewhere = await draft({ contactId: otherSupplier.id, supplierInvoiceNumber: "INV42" });
    expect((await approve(elsewhere.id)).bill).toMatchObject({ status: "approved", contactName: "Tōtara Timber" });

    // Once the first is voided, the number can be used again (stored as typed).
    await voidIt(first.id, "2026-06-01");
    const second = await draft({ supplierInvoiceNumber: "inv 42" });
    expect(second).toMatchObject({ status: "draft", supplierInvoiceNumber: "inv 42" });
    expect((await approve(second.id)).bill.status).toBe("approved");
  });

  it("B5: drafts aren't voided, so a draft's number can't be used again until the draft is deleted", async () => {
    const first = await draft({ supplierInvoiceNumber: "DRAFT 7" });
    await expect(draft({ supplierInvoiceNumber: "draft7" })).rejects.toThrow(
      `Kauri Supplies already has a bill with the invoice number DRAFT 7 (draft bill #${first.id}).`,
    );
    // Moving another draft to the same supplier with that number is refused too.
    const elsewhere = await draft({ contactId: otherSupplier.id, supplierInvoiceNumber: "Draft7" });
    await expect(asUser(bookkeeper, (tx) => updateBill(tx, elsewhere.id, { contactId: supplier.id }))).rejects.toThrow(
      /already has a bill with the invoice number DRAFT 7/,
    );
    await asUser(bookkeeper, (tx) => deleteBill(tx, first.id));
    expect(await asUser(bookkeeper, (tx) => updateBill(tx, elsewhere.id, { contactId: supplier.id }))).toMatchObject({
      contactName: "Kauri Supplies",
      supplierInvoiceNumber: "Draft7",
    });
  });

  it("B6: voiding B1 on a later open date posts the exact reversal; the bill shows as voided; a second void is refused", async () => {
    const { bill: approved } = await approve((await draft({ supplierInvoiceNumber: "KS-1002" })).id);
    const original = await journal(approved.approvalJournalId!);
    const journalsBefore = await journalCount();

    const voidKey = key("void");
    const { created, bill } = await voidIt(approved.id, "2026-06-15", voidKey);
    expect(created).toBe(true);
    expect(bill).toMatchObject({
      status: "voided",
      voidDate: "2026-06-15",
      supplierInvoiceNumber: "KS-1002",
      approvalJournalId: approved.approvalJournalId,
      voidedByEmail: bookkeeper.email,
      total: "230.00",
    });
    const reversal = await journal(bill.voidJournalId!);
    expect(reversal).toMatchObject({
      origin: "bill",
      postingDate: "2026-06-15",
      reference: "VOID-KS-1002",
      description: "Void of bill KS-1002 from Kauri Supplies",
      relatedJournalId: original.id,
      correctionKind: "reversal",
      totalDebit: "230.00",
    });
    expect(reversal.lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount, entry.description])).toEqual(
      original.lines.map((entry) => [entry.accountCode, entry.creditAmount, entry.debitAmount, entry.description]),
    );
    expect(await postedLines(reversal.id)).toEqual([
      ["6010", "0.00", "200.00"],
      ["2100", "0.00", "30.00"],
      ["2000", "230.00", "0.00"],
    ]);
    expect((await asUser(viewer, (tx) => getBill(tx, approved.id))).status).toBe("voided");

    // A retry of the same void returns it; another void is refused.
    const retried = await voidIt(approved.id, "2026-06-15", voidKey);
    expect(retried).toMatchObject({ created: false, bill: { id: approved.id, voidJournalId: reversal.id } });
    await expect(voidIt(approved.id, "2026-06-16")).rejects.toThrow("Bill KS-1002 from Kauri Supplies has already been voided.");
    await expect(voidIt(approved.id, "2026-06-16", voidKey)).rejects.toThrow(/already used for a different bill void/);
    expect(await journalCount()).toBe(journalsBefore + 1);

    // The ledger shows the pair, and neither can be corrected there.
    const details = await asUser(owner, (tx) => getJournalDetails(tx, original.id));
    expect(details.canCorrect).toBe(false);
    expect(details.correctionJournals.map((entry) => entry.id)).toEqual([reversal.id]);
    expect((await asUser(owner, (tx) => getJournalDetails(tx, reversal.id))).canCorrect).toBe(false);
  });

  it("B6: a void must be dated on or after the bill date, in an open period; drafts are deleted, not voided", async () => {
    const drafted = await draft();
    await expect(voidIt(drafted.id, "2026-06-15")).rejects.toThrow(
      "This bill is still a draft, so there's nothing to void. Delete it instead.",
    );
    const { bill: approved } = await approve(drafted.id);
    await expect(voidIt(approved.id, "2026-05-09")).rejects.toThrow("The void date can't be before the bill date (2026-05-10).");
    await expect(voidIt(approved.id, "15/06/2026")).rejects.toThrow(/voidDate/);

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    try {
      await expect(voidIt(approved.id, "2026-05-20")).rejects.toThrow(/2026-05-20 is in a locked period/);
      expect((await asUser(viewer, (tx) => getBill(tx, approved.id))).status).toBe("approved");
      // The bill's own period is locked, but a void dated in an open period is fine.
      const { bill } = await voidIt(approved.id, "2026-06-01");
      expect(bill).toMatchObject({ status: "voided", voidDate: "2026-06-01" });
      expect((await journal(bill.voidJournalId!)).postingDate).toBe("2026-06-01");
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null }));
    }
  });

  it("B7: approving a bill dated in a locked period is refused; the draft stays a draft", async () => {
    const locked = await draft({ billDate: "2026-03-15", dueDate: "2026-04-15" });
    const journalsBefore = await journalCount();

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-03-31" }));
    try {
      await expect(approve(locked.id)).rejects.toThrow(/2026-03-15 is in a locked period \(locked up to 2026-03-31\)/);
      expect(await asUser(viewer, (tx) => getBill(tx, locked.id))).toMatchObject({
        status: "draft",
        approvalJournalId: null,
        approvedAt: null,
      });
      expect(await journalCount()).toBe(journalsBefore);
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null }));
    }
    // Once the period is open again it can be approved.
    expect((await approve(locked.id)).bill).toMatchObject({ status: "approved", billDate: "2026-03-15" });
  });

  it("B8: retrying an approval with the same key returns the same journal; drafts post nothing", async () => {
    const journalsBefore = await journalCount();
    const first = await draft();
    const second = await draft({ lines: [line("3", "20.00")] });
    await asUser(bookkeeper, (tx) => updateBill(tx, first.id, { dueDate: "2026-06-30" }));
    await asUser(bookkeeper, (tx) => deleteBill(tx, (second.id)));
    const third = await draft();
    expect(await journalCount()).toBe(journalsBefore);

    const approveKey = key("approve");
    const approved = await approve(first.id, approveKey);
    const retried = await approve(first.id, approveKey);
    expect(approved.created).toBe(true);
    expect(retried.created).toBe(false);
    expect(retried.bill.approvalJournalId).toBe(approved.bill.approvalJournalId);
    expect(retried.bill).toMatchObject({ id: first.id, status: "approved", approvedAt: approved.bill.approvedAt });
    expect(await journalCount()).toBe(journalsBefore + 1);

    // The key belongs to that approval; a new request on an approved bill is refused.
    await expect(approve(third.id, approveKey)).rejects.toThrow(/already used for a different bill approval/);
    await expect(approve(first.id)).rejects.toThrow(`Bill ${first.supplierInvoiceNumber} from Kauri Supplies is already approved.`);
    expect((await asUser(viewer, (tx) => getBill(tx, third.id))).status).toBe("draft");
    expect(await journalCount()).toBe(journalsBefore + 1);
  });

  it("B8: a contact that is only a customer, or is archived, can't be the supplier, when saving or approving", async () => {
    await expect(draft({ contactId: customer.id })).rejects.toThrow(
      "Aroha Café Ltd isn't marked as a supplier. Edit the contact first, or pick another one.",
    );
    const gone = await newContact("Gone Supplies", { isSupplier: true });
    await asUser(bookkeeper, (tx) => archiveContact(tx, gone.id));
    await expect(draft({ contactId: gone.id })).rejects.toThrow(
      "Gone Supplies is archived. Unarchive them first, or pick another supplier.",
    );

    // Contacts that change after the draft was saved are caught on approval.
    const leaving = await newContact("Leaving Ltd", { isSupplier: true });
    const forLeaving = await draft({ contactId: leaving.id });
    await asUser(bookkeeper, (tx) => archiveContact(tx, leaving.id));
    await expect(approve(forLeaving.id)).rejects.toThrow(/Leaving Ltd is archived/);

    const switching = await newContact("Switching Ltd", { isSupplier: true });
    const forSwitching = await draft({ contactId: switching.id });
    await asUser(bookkeeper, (tx) => updateContact(tx, switching.id, { isCustomer: true, isSupplier: false }));
    await expect(approve(forSwitching.id)).rejects.toThrow("Switching Ltd isn't marked as a supplier.");

    for (const billId of [forLeaving.id, forSwitching.id]) {
      expect(await asUser(viewer, (tx) => getBill(tx, billId))).toMatchObject({ status: "draft", approvalJournalId: null });
    }
  });

  it("L4, B6, B7, B8: retrying an approval or a void after its period is locked returns the original, not a lock error", async () => {
    const approveKey = key("approve");
    const { bill: approved } = await approve((await draft()).id, approveKey);
    const { bill: toVoid } = await approve((await draft()).id);
    const voidKey = key("void");
    const { bill: voided } = await voidIt(toVoid.id, "2026-05-20", voidKey);
    const waiting = await draft();
    const journalsBefore = await journalCount();

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    try {
      expect(await approve(approved.id, approveKey)).toMatchObject({
        created: false,
        bill: { id: approved.id, status: "approved", approvalJournalId: approved.approvalJournalId },
      });
      expect(await voidIt(toVoid.id, "2026-05-20", voidKey)).toMatchObject({
        created: false,
        bill: { id: toVoid.id, status: "voided", voidDate: "2026-05-20", voidJournalId: voided.voidJournalId },
      });
      // Anything new in the locked period is still refused.
      await expect(approve(waiting.id)).rejects.toThrow(/2026-05-10 is in a locked period/);
      await expect(voidIt(approved.id, "2026-05-20")).rejects.toThrow(/2026-05-20 is in a locked period/);
      expect(await journalCount()).toBe(journalsBefore);
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null }));
    }
  });

  it("B6, B8: approvals and voids at the same moment take turns: a retry queued behind the first returns it; a second one is refused", async () => {
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
    const fulfilled = <T>(outcomes: PromiseSettledResult<T>[]) =>
      outcomes.map((outcome) => {
        if (outcome.status === "rejected") throw outcome.reason;
        return outcome.value;
      });
    const [retried, rival] = [await draft(), await draft()];
    const journalsBefore = await journalCount();

    // Two copies of an approval (the same key) approve it once; the second returns the first.
    const approveKey = key("approve");
    const approvals = fulfilled(
      await atOnce(retried.id, [() => approve(retried.id, approveKey), () => approve(retried.id, approveKey)]),
    );
    expect(approvals.map((result) => result.created).sort()).toEqual([false, true]);
    expect(approvals[0].bill.approvalJournalId).toEqual(expect.any(String));
    expect(approvals[1].bill).toMatchObject({ status: "approved", approvalJournalId: approvals[0].bill.approvalJournalId });
    expect(await journalCount()).toBe(journalsBefore + 1);

    // Two approvals with different keys: one approves it and the other is refused.
    const rivals = await atOnce(rival.id, [() => approve(rival.id), () => approve(rival.id)]);
    expect(rivals.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(rivals.find((outcome) => outcome.status === "rejected")?.reason).toMatchObject({
      message: `Bill ${rival.supplierInvoiceNumber} from Kauri Supplies is already approved.`,
    });
    expect(await journalCount()).toBe(journalsBefore + 2);

    // Two copies of a void post one reversal.
    const voidKey = key("void");
    const voids = fulfilled(
      await atOnce(retried.id, [
        () => voidIt(retried.id, "2026-06-15", voidKey),
        () => voidIt(retried.id, "2026-06-15", voidKey),
      ]),
    );
    expect(voids.map((result) => result.created).sort()).toEqual([false, true]);
    expect(voids[0].bill.voidJournalId).toEqual(expect.any(String));
    expect(voids[1].bill).toMatchObject({ status: "voided", voidJournalId: voids[0].bill.voidJournalId });
    expect(await journalCount()).toBe(journalsBefore + 3);

    // Two voids with different keys: one voids it and the other is refused.
    const rivalVoids = await atOnce(rival.id, [() => voidIt(rival.id, "2026-06-15"), () => voidIt(rival.id, "2026-06-16")]);
    expect(rivalVoids.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(rivalVoids.find((outcome) => outcome.status === "rejected")?.reason).toMatchObject({
      message: `Bill ${rival.supplierInvoiceNumber} from Kauri Supplies has already been voided.`,
    });
    expect(await journalCount()).toBe(journalsBefore + 4);
    for (const billId of [retried.id, rival.id]) {
      expect((await asUser(viewer, (tx) => getBill(tx, billId))).status).toBe("voided");
    }
  });

  it("B5: a number another request saves at the same moment is still refused, by the database", async () => {
    const renumbered = await draft({ supplierInvoiceNumber: "RACE-OTHER" });
    // Save "RACE 1" but keep its transaction open. The requests below can't see it yet, so they pass the
    // service's own check, then wait at the database's unique index until it commits.
    const { settling } = await asUser(bookkeeper, async (tx) => {
      await createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: supplier.id,
        billDate: "2026-05-10",
        dueDate: "2026-06-20",
        supplierInvoiceNumber: "RACE 1",
        amountsMode: "exclusive",
        lines: [line("1", "200.00")],
      });
      const queued = [
        draft({ supplierInvoiceNumber: "race1" }),
        asUser(bookkeeper, (other) => updateBill(other, renumbered.id, { supplierInvoiceNumber: "Race 1" })),
      ];
      // Handle their results now: they're refused as soon as this commits, maybe before it returns.
      const handled = Promise.allSettled(queued);
      await waitForLockWaiters(tx, queued.length);
      return { settling: handled };
    });
    const outcomes = await settling;
    expect(outcomes.map((outcome) => (outcome.status === "rejected" ? (outcome.reason as Error).message : outcome.status))).toEqual(
      ["race1", "Race 1"].map(
        (number) =>
          `Kauri Supplies already has a bill with the invoice number ${number}. Numbers are compared ignoring case and spaces, so check this bill hasn't been entered already.`,
      ),
    );
    const saved = await asUser(owner, (tx) =>
      tx.query<{ supplier_invoice_number: string }>(
        `select supplier_invoice_number from bills
          where contact_id = $1 and lower(regexp_replace(supplier_invoice_number, '[[:space:]]', '', 'g')) = 'race1'`,
        [supplier.id],
      ),
    );
    expect(saved.rows).toEqual([{ supplier_invoice_number: "RACE 1" }]);
    expect((await asUser(viewer, (tx) => getBill(tx, renumbered.id))).supplierInvoiceNumber).toBe("RACE-OTHER");
  });

  it("D1, D2: saving a draft is idempotent: the same key and content return it; different content is refused", async () => {
    const command = {
      idempotencyKey: key("bill"),
      contactId: supplier.id,
      billDate: "2026-05-10",
      dueDate: "2026-06-20",
      supplierInvoiceNumber: "IDEM-1",
      amountsMode: "exclusive",
      lines: [line("2", "50.00")],
    };
    const first = await asUser(bookkeeper, (tx) => createBill(tx, command));
    const again = await asUser(bookkeeper, (tx) =>
      createBill(tx, { ...command, supplierInvoiceNumber: " IDEM-1 ", lines: [{ ...line("2.0", "50"), accountCode: "6010" }] }),
    );
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, bill: { id: first.bill.id } });
    await expect(
      asUser(bookkeeper, (tx) => createBill(tx, { ...command, lines: [line("3", "50.00")] })),
    ).rejects.toThrow(/already used for a different bill/);
  });

  it("drafts can be edited and deleted; approved and voided bills can't", async () => {
    const saved = await draft({ supplierInvoiceNumber: "EDIT-1" });
    const edited = await asUser(bookkeeper, (tx) =>
      updateBill(tx, saved.id, {
        dueDate: "2026-07-01",
        supplierInvoiceNumber: "EDIT-1A",
        amountsMode: "inclusive",
        lines: [line("1", "115.00"), line("4", "2.50", "EXEMPT", "6040")],
      }),
    );
    expect(edited).toMatchObject({
      id: saved.id,
      status: "draft",
      billDate: "2026-05-10",
      dueDate: "2026-07-01",
      supplierInvoiceNumber: "EDIT-1A",
      amountsMode: "inclusive",
      subtotal: "110.00",
      taxTotal: "15.00",
      total: "125.00",
    });
    expect(edited.lines.map((entry) => [entry.lineOrder, entry.accountCode, entry.netAmount])).toEqual([
      [1, "6010", "100.00"],
      [2, "6040", "10.00"],
    ]);
    // Saving it unchanged isn't recorded as an edit.
    await asUser(bookkeeper, (tx) => updateBill(tx, saved.id, { dueDate: "2026-07-01" }));
    const audit = await asUser(owner, (tx) =>
      tx.query<{ event_type: string; actor_email: string; details: Record<string, unknown> }>(
        "select event_type, actor_email, details from audit_events where entity_type = 'bill' and entity_id = $1 order by id",
        [saved.id],
      ),
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({ event_type: "bill.created", actor_email: bookkeeper.email }),
      {
        event_type: "bill.updated",
        actor_email: bookkeeper.email,
        details: {
          changed: ["dueDate", "supplierInvoiceNumber", "amountsMode", "lines"],
          total: { from: "230.00", to: "125.00" },
        },
      },
    ]);

    const doomed = await draft();
    await asUser(bookkeeper, (tx) => deleteBill(tx, doomed.id));
    await expect(asUser(viewer, (tx) => getBill(tx, doomed.id))).rejects.toThrow("Bill not found.");
    const leftover = await asUser(owner, (tx) => tx.query("select 1 from bill_lines where bill_id = $1", [doomed.id]));
    expect(leftover.rowCount).toBe(0);

    const { bill: approved } = await approve(saved.id);
    await expect(asUser(bookkeeper, (tx) => updateBill(tx, approved.id, { dueDate: "2026-07-31" }))).rejects.toThrow(
      "Bill EDIT-1A from Kauri Supplies is approved, so it can't be edited. Void it instead.",
    );
    await expect(asUser(bookkeeper, (tx) => deleteBill(tx, approved.id))).rejects.toThrow(
      "Bill EDIT-1A from Kauri Supplies is approved, so it can't be deleted. Void it instead.",
    );
    await voidIt(approved.id, "2026-06-30");
    await expect(asUser(bookkeeper, (tx) => updateBill(tx, approved.id, { dueDate: "2026-07-31" }))).rejects.toThrow(
      "Bill EDIT-1A from Kauri Supplies is voided, so it can't be edited.",
    );
    await expect(asUser(bookkeeper, (tx) => deleteBill(tx, approved.id))).rejects.toThrow(/is voided, so it can't be deleted/);
    await expect(asUser(bookkeeper, (tx) => deleteBill(tx, "999999"))).rejects.toThrow("Bill not found.");
  });

  it("refuses bills that break the rules", async () => {
    await asUser(owner, (tx) =>
      createAccount(tx, { code: "1210", name: "USD deposit", accountType: "current_asset", currencyCode: "USD" }),
    );
    const retired = await asUser(owner, (tx) => createAccount(tx, { code: "6999", name: "Old expenses", accountType: "expense" }));
    await asUser(owner, (tx) => updateAccount(tx, retired.id, { isActive: false }));

    const refusals: Array<[Record<string, unknown>, RegExp | string]> = [
      [{ contactId: "999999" }, "There's no contact #999999."],
      [{ dueDate: "2026-05-09" }, "The due date can't be before the bill date."],
      [{ supplierInvoiceNumber: undefined }, "supplierInvoiceNumber is required."],
      [{ supplierInvoiceNumber: "   " }, "supplierInvoiceNumber is required."],
      [{ supplierInvoiceNumber: "x".repeat(101) }, "supplierInvoiceNumber can be at most 100 characters."],
      [{ amountsMode: "gross" }, /amountsMode must be one of/],
      [{ lines: [] }, "A bill needs at least one line."],
      [{ lines: Array.from({ length: 201 }, () => line("1", "1")) }, /at most 200/],
      [{ lines: [line("1", "10", "GST", "1000")] }, /^Line 1: account 1000 \(Business bank account\) is a bank account\./],
      [{ lines: [line("1", "10", "GST", "1100")] }, /^Line 1: account 1100 \(Accounts receivable\) is the accounts receivable account\./],
      [{ lines: [line("1", "10", "GST", "2000")] }, /^Line 1: account 2000 \(Accounts payable\) is the accounts payable account\./],
      [{ lines: [line("1", "10", "GST", "2100")] }, /^Line 1: account 2100 \(GST\) is the GST account\./],
      [{ lines: [line("1", "10", "GST", "4000")] }, /^Line 1: account 4000 \(Sales\) is a revenue account\./],
      [{ lines: [line("1", "10", "GST", "2400")] }, /^Line 1: account 2400 \(Credit card\) is a credit card account\./],
      [{ lines: [line("1", "10", "GST", "3100")] }, /^Line 1: account 3100 \(Owner drawings\) is an equity account\./],
      [{ lines: [line("1", "10", "GST", "6300")] }, /^Line 1: account 6300 \(Depreciation\) is a depreciation account\./],
      [{ lines: [line("1", "10", "GST", "1210")] }, /^Line 1: account 1210 \(USD deposit\) is in USD/],
      [{ lines: [line("1", "10", "GST", "6999")] }, "Line 1: account 6999 (Old expenses) is archived."],
      [{ lines: [line("1", "10", "GST", "9999")] }, "Line 1: there's no account with the code 9999."],
      [{ lines: [line("1", "10", null)] }, /Line 1 needs a tax code/],
      [{ lines: [line("1", "10", "NOPE")] }, "Line 1: there's no tax code NOPE."],
      [{ amountsMode: "no_tax", lines: [line("1", "10", "GST")] }, /Line 1 has a tax code, but the bill's amounts have no tax/],
      [{ billDate: "2025-12-31" }, /tax code GST isn't in effect on 2025-12-31 \(it applies from 2026-01-01\)/],
      [{ lines: [line("1.00001", "10")] }, "Line 1 quantity can have at most 4 decimal places."],
      [{ lines: [line("1", "10.12345")] }, "Line 1 unit price can have at most 4 decimal places."],
      [{ lines: [line("0", "10")] }, "Line 1 quantity must not be zero."],
      [{ lines: [line("1", "-10")] }, "Line 1 unit price can't be negative."],
      [{ lines: [line("0.001", "1")] }, /Line 1 comes to 0.00 once rounded/],
      [{ lines: [{ ...line("1", "10"), description: " " }] }, /Line 1 description/],
    ];
    const journalsBefore = await journalCount();
    for (const [fields, message] of refusals) {
      await expect(draft(fields), JSON.stringify(fields).slice(0, 80)).rejects.toThrow(message);
    }
    expect(await journalCount()).toBe(journalsBefore);

    // Expense, direct costs and asset accounts are all fine, and so are four decimal places.
    const allowed = await draft({
      lines: [
        line("1.2345", "10.1234", "GST", "6010"),
        line("1", "10", "GST", "5100"),
        line("1", "10", "GST", "1200"),
        line("1", "10", "GST", "1620"),
      ],
    });
    expect(allowed.lines.map((entry) => entry.accountCode)).toEqual(["6010", "5100", "1200", "1620"]);
    // The inventory account takes only stock items, so stock always equals it (ST1).
    await expect(draft({ lines: [line("1", "10", "GST", "1400")] })).rejects.toThrow("which only stock items go to");
    expect(allowed.lines[0]).toMatchObject({ quantity: "1.2345", unitPrice: "10.1234", lineAmount: "12.50" });
  });

  it("approval checks the draft again: accounts and tax codes must still be usable and its amounts current", async () => {
    // An account archived after the draft was saved.
    const temporary = await asUser(owner, (tx) =>
      createAccount(tx, { code: "6998", name: "Temporary costs", accountType: "expense" }),
    );
    const forTemporary = await draft({ lines: [line("1", "10", "GST", "6998")] });
    await asUser(owner, (tx) => updateAccount(tx, temporary.id, { isActive: false }));
    await expect(approve(forTemporary.id)).rejects.toThrow("Line 1: account 6998 (Temporary costs) is archived.");

    // A tax code whose rate changed after the draft was saved.
    await asUser(owner, (tx) =>
      createTaxCode(tx, {
        idempotencyKey: key("tax"),
        code: "SHIFTY",
        label: "Rate that changes",
        category: "standard",
        rate: "0.15",
        effectiveFrom: "2026-01-01",
      }),
    );
    const stale = await draft({ lines: [line("1", "100", "SHIFTY")] });
    await asUser(owner, (tx) => tx.query("update tax_codes set rate = 0.125 where code = 'SHIFTY'"));
    await expect(approve(stale.id)).rejects.toThrow(/amounts no longer match its tax codes/);
    await asUser(owner, (tx) => tx.query("update tax_codes set is_active = false where code = 'SHIFTY'"));
    await expect(approve(stale.id)).rejects.toThrow("Line 1: tax code SHIFTY is inactive.");

    for (const billId of [forTemporary.id, stale.id]) {
      expect(await asUser(viewer, (tx) => getBill(tx, billId))).toMatchObject({ status: "draft", approvalJournalId: null });
    }
  });

  it("journals posted by bills can't be corrected in the ledger, and can be listed by kind", async () => {
    const { bill } = await approve((await draft({ supplierInvoiceNumber: "FIX-1" })).id);
    await expect(
      asUser(bookkeeper, (tx) =>
        correctJournal(tx, {
          idempotencyKey: key("fix"),
          originalJournalId: bill.approvalJournalId,
          postingDate: "2026-06-01",
          reference: "FIX",
          lines: [
            { accountCode: "6010", debitAmount: "100" },
            { accountCode: "2000", creditAmount: "100" },
          ],
        }),
      ),
    ).rejects.toThrow("posted by a bill (FIX-1), so it can't be corrected in the ledger. To cancel an approved bill, void it.");
    expect((await asUser(owner, (tx) => getJournalDetails(tx, bill.approvalJournalId!))).canCorrect).toBe(false);

    const listed = await asUser(viewer, (tx) => listJournals(tx, { kind: "bill", limit: "200" }));
    expect(listed.journals.map((entry) => entry.id)).toContain(bill.approvalJournalId);
    expect(listed.journals.every((entry) => entry.origin === "bill")).toBe(true);
  });

  it("the database refuses changes to approved bills and their lines, and repeated supplier invoice numbers", async () => {
    const { bill } = await approve((await draft({ supplierInvoiceNumber: "DB-1" })).id);
    const drafted = await draft({ supplierInvoiceNumber: "DB-2" });
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));

    await expect(sql("update bills set total = 1, subtotal = 1, tax_total = 0 where id = $1", [bill.id])).rejects.toThrow(
      `Bill #${bill.id} is approved, so it can't be changed`,
    );
    await expect(sql("update bills set status = 'draft' where id = $1", [bill.id])).rejects.toThrow(/can't be changed/);
    // Voiding may only add the void details.
    await expect(
      sql("update bills set status = 'voided', supplier_invoice_number = 'sneaky' where id = $1", [bill.id]),
    ).rejects.toThrow(/can't be changed/);
    await expect(sql("delete from bills where id = $1", [bill.id])).rejects.toThrow(
      `Bill #${bill.id} is approved, so it can't be deleted`,
    );
    // A draft is deleted, never voided.
    await expect(sql("update bills set status = 'voided' where id = $1", [drafted.id])).rejects.toThrow(
      `Bill #${drafted.id} is a draft, so it can't be voided`,
    );
    await expect(sql("update bill_lines set description = 'x' where bill_id = $1", [bill.id])).rejects.toThrow(
      "Lines of an approved or voided bill can't be changed",
    );
    await expect(sql("delete from bill_lines where bill_id = $1", [bill.id])).rejects.toThrow(
      "Lines of an approved or voided bill can't be changed",
    );
    const accountId = bill.lines[0].accountId;
    await expect(
      sql(
        `insert into bill_lines (bill_id, line_order, description, quantity, unit_price, account_id,
                                 line_amount, net_amount, tax_amount)
         values ($1, 9, 'extra', 1, 1, $2, 1, 1, 0)`,
        [bill.id, accountId],
      ),
    ).rejects.toThrow("Lines can only be added to a draft bill");
    await expect(sql("truncate bill_lines")).rejects.toThrow("bill_lines can't be truncated");
    await expect(sql("truncate bills cascade")).rejects.toThrow(/can't be truncated/);

    // Quantities and unit prices have at most 4 decimal places.
    await expect(
      sql(
        `insert into bill_lines (bill_id, line_order, description, quantity, unit_price, account_id,
                                 line_amount, net_amount, tax_amount)
         values ($1, 9, 'extra', 1.00001, 1, $2, 1, 1, 0)`,
        [drafted.id, accountId],
      ),
    ).rejects.toThrow(/check constraint/);

    const insertBill = (supplierInvoiceNumber: string, total = "230") =>
      sql(
        `insert into bills (command_source, idempotency_key, request_hash, contact_id, bill_date, due_date,
                            supplier_invoice_number, amounts_mode, currency_code, subtotal, tax_total, total)
         values ('sql', $1, 'h', $2, '2026-05-10', '2026-05-10', $3, 'exclusive', 'NZD', 200, 30, $4::numeric)`,
        [key("sql"), supplier.id, supplierInvoiceNumber, total],
      );
    // Totals must add up, and the supplier's invoice number is required.
    await expect(insertBill("DB-3", "231")).rejects.toThrow(/check constraint/);
    await expect(insertBill("   ")).rejects.toThrow(/check constraint/);
    // Two bills from one supplier that aren't voided can't share a number, ignoring case and spaces.
    await expect(insertBill("d b-1")).rejects.toThrow(/bills_supplier_invoice_number_key/);
    await expect(insertBill(" db -2\t")).rejects.toThrow(/bills_supplier_invoice_number_key/);
    // Only case and spaces are ignored: DB2 isn't DB-2.
    await insertBill("DB2");
    expect((await asUser(viewer, (tx) => getBill(tx, bill.id))).total).toBe("230.00");
  });

  it("lists bills newest first, filtered by status and paged", async () => {
    const all = await asUser(viewer, (tx) => listBills(tx, { limit: "200" }));
    expect(all.bills.length).toBeGreaterThan(5);
    expect(all.bills.map((entry) => Number(entry.id))).toEqual(
      [...all.bills.map((entry) => Number(entry.id))].sort((a, b) => b - a),
    );
    for (const status of ["draft", "approved", "voided"] as const) {
      const filtered = await asUser(viewer, (tx) => listBills(tx, { status }));
      expect(filtered.bills.length).toBeGreaterThan(0);
      expect(filtered.bills.every((entry) => entry.status === status)).toBe(true);
    }
    const page = await asUser(viewer, (tx) => listBills(tx, { limit: "2" }));
    expect(page.bills.map((entry) => entry.id)).toEqual(all.bills.slice(0, 2).map((entry) => entry.id));
    const next = await asUser(viewer, (tx) => listBills(tx, { limit: "2", beforeId: page.nextBeforeId }));
    expect(next.bills.map((entry) => entry.id)).toEqual(all.bills.slice(2, 4).map((entry) => entry.id));
    await expect(asUser(viewer, (tx) => listBills(tx, { status: "paid" }))).rejects.toThrow(/status must be one of/);
  });

  it("over HTTP: viewers can read; bookkeepers can do everything else; non-members get 404", async () => {
    const [bookkeeperCookie, viewerCookie, outsiderCookie] = await Promise.all(
      [bookkeeper, viewer, outsider].map((user) => sessionCookieFor(user)),
    );
    const post = (cookie: string, fields: Record<string, unknown>) =>
      billsRoute.POST(apiRequest("/api/bills", { method: "POST", cookie, body: { organisationId: ORG, ...fields } }), noContext);
    const list = (cookie: string, query = "") =>
      billsRoute.GET(apiRequest(`/api/bills?organisationId=${ORG}${query}`, { cookie }), noContext);
    const get = (cookie: string, billId: string) =>
      billRoute.GET(apiRequest(`/api/bills/${billId}?organisationId=${ORG}`, { cookie }), params({ billId }));
    const patch = (cookie: string, billId: string, fields: Record<string, unknown>) =>
      billRoute.PATCH(
        apiRequest(`/api/bills/${billId}`, { method: "PATCH", cookie, body: { organisationId: ORG, ...fields } }),
        params({ billId }),
      );
    const remove = (cookie: string, billId: string) =>
      billRoute.DELETE(
        apiRequest(`/api/bills/${billId}?organisationId=${ORG}`, { method: "DELETE", cookie }),
        params({ billId }),
      );
    const approveOver = (cookie: string, billId: string, idempotencyKey: string) =>
      approveRoute.POST(
        apiRequest(`/api/bills/${billId}/approve`, {
          method: "POST",
          cookie,
          body: { organisationId: ORG, source: "ui", idempotencyKey },
        }),
        params({ billId }),
      );
    const voidOver = (cookie: string, billId: string, idempotencyKey: string, voidDate: string) =>
      voidRoute.POST(
        apiRequest(`/api/bills/${billId}/void`, {
          method: "POST",
          cookie,
          body: { organisationId: ORG, source: "ui", idempotencyKey, voidDate },
        }),
        params({ billId }),
      );
    const command = {
      source: "ui",
      idempotencyKey: key("http"),
      contactId: supplier.id,
      billDate: "2026-06-02",
      dueDate: "2026-06-30",
      supplierInvoiceNumber: "HTTP-1",
      amountsMode: "exclusive",
      lines: [line("2", "50.00")],
    };

    expect((await post(viewerCookie, command)).status).toBe(403);
    const created = await post(bookkeeperCookie, command);
    expect(created.status).toBe(201);
    const bill = (await body(created)).bill as Bill;
    expect(bill).toMatchObject({ status: "draft", supplierInvoiceNumber: "HTTP-1", total: "115.00", createdByEmail: bookkeeper.email });
    const retried = await post(bookkeeperCookie, command);
    expect(retried.status).toBe(200);
    expect(await body(retried)).toMatchObject({ created: false, bill: { id: bill.id } });
    expect((await post(bookkeeperCookie, { ...command, supplierInvoiceNumber: "HTTP-2" })).status).toBe(409);
    const repeated = await post(bookkeeperCookie, { ...command, idempotencyKey: key("http"), supplierInvoiceNumber: "http - 1" });
    expect(repeated.status).toBe(409);
    expect((await body(repeated)).error).toMatch(/already has a bill with the invoice number HTTP-1/);
    const refused = await post(bookkeeperCookie, {
      ...command,
      idempotencyKey: key("http"),
      supplierInvoiceNumber: "HTTP-3",
      contactId: customer.id,
    });
    expect(refused.status).toBe(400);
    expect((await body(refused)).error).toMatch(/isn't marked as a supplier/);

    const viewerList = await list(viewerCookie, "&status=draft");
    expect(viewerList.status).toBe(200);
    expect(((await body(viewerList)).bills as BillSummary[]).map((entry) => entry.id)).toContain(bill.id);
    expect((await list(viewerCookie, "&status=paid")).status).toBe(400);
    const viewed = await get(viewerCookie, bill.id);
    expect(viewed.status).toBe(200);
    expect((await body(viewed)).bill).toMatchObject({ id: bill.id, lines: [expect.objectContaining({ taxCode: "GST" })] });
    expect((await get(viewerCookie, "999999")).status).toBe(404);

    expect((await patch(viewerCookie, bill.id, { dueDate: "2026-07-01" })).status).toBe(403);
    const edited = await patch(bookkeeperCookie, bill.id, { lines: [line("3", "50.00")] });
    expect(edited.status).toBe(200);
    expect((await body(edited)).bill).toMatchObject({ supplierInvoiceNumber: "HTTP-1", total: "172.50" });

    const approveKey = key("http-approve");
    expect((await approveOver(viewerCookie, bill.id, approveKey)).status).toBe(403);
    const approved = await approveOver(bookkeeperCookie, bill.id, approveKey);
    expect(approved.status).toBe(201);
    const approvedBill = (await body(approved)).bill as Bill;
    expect(approvedBill).toMatchObject({ status: "approved", approvedByEmail: bookkeeper.email });
    const approvedAgain = await approveOver(bookkeeperCookie, bill.id, approveKey);
    expect(approvedAgain.status).toBe(200);
    expect(await body(approvedAgain)).toMatchObject({
      created: false,
      bill: { approvalJournalId: approvedBill.approvalJournalId },
    });
    expect((await approveOver(bookkeeperCookie, bill.id, key("http-approve"))).status).toBe(409);
    expect((await patch(bookkeeperCookie, bill.id, { dueDate: "2026-07-01" })).status).toBe(409);
    expect((await remove(bookkeeperCookie, bill.id)).status).toBe(409);

    const voidKey = key("http-void");
    expect((await voidOver(viewerCookie, bill.id, voidKey, "2026-06-20")).status).toBe(403);
    const voided = await voidOver(bookkeeperCookie, bill.id, voidKey, "2026-06-20");
    expect(voided.status).toBe(201);
    expect((await body(voided)).bill).toMatchObject({ status: "voided", voidedByEmail: bookkeeper.email });
    expect((await voidOver(bookkeeperCookie, bill.id, voidKey, "2026-06-20")).status).toBe(200);
    expect((await voidOver(bookkeeperCookie, bill.id, key("http-void"), "2026-06-21")).status).toBe(409);

    const scrap = (await body(await post(bookkeeperCookie, { ...command, idempotencyKey: key("http"), supplierInvoiceNumber: "HTTP-4" })))
      .bill as Bill;
    expect((await remove(viewerCookie, scrap.id)).status).toBe(403);
    const removed = await remove(bookkeeperCookie, scrap.id);
    expect(removed.status).toBe(200);
    expect(await body(removed)).toEqual({ ok: true });
    expect((await get(viewerCookie, scrap.id)).status).toBe(404);

    // Non-members can't tell the organisation exists; nobody signed in gets nothing.
    expect((await list(outsiderCookie)).status).toBe(404);
    expect((await get(outsiderCookie, bill.id)).status).toBe(404);
    expect((await post(outsiderCookie, { ...command, idempotencyKey: key("http") })).status).toBe(404);
    expect((await approveOver(outsiderCookie, bill.id, key("x"))).status).toBe(404);
    const kept = (await body(await post(bookkeeperCookie, { ...command, idempotencyKey: key("http"), supplierInvoiceNumber: "HTTP-5" })))
      .bill as Bill;
    expect((await patch(outsiderCookie, kept.id, { dueDate: "2026-07-01" })).status).toBe(404);
    expect((await remove(outsiderCookie, kept.id)).status).toBe(404);
    expect((await approveOver(bookkeeperCookie, kept.id, key("http-approve"))).status).toBe(201);
    expect((await voidOver(outsiderCookie, kept.id, key("x"), "2026-06-20")).status).toBe(404);
    expect((await body(await get(viewerCookie, kept.id))).bill).toMatchObject({ status: "approved", dueDate: "2026-06-30" });
    expect((await billsRoute.GET(apiRequest(`/api/bills?organisationId=${ORG}`), noContext)).status).toBe(401);
  });

  it("migration 0005 upgrades an organisation database on 0004, keeping its data", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_bills`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();

    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      const before = tenantMigrations.filter((migration) => migration.version < "0005");
      expect((await applyMigrations(client, before, "test:upgrade")).applied).toEqual(["0001", "0002", "0003", "0004"]);
      await client.query(
        `insert into organisation_settings (organisation_id, display_name, base_currency) values ('upgrade-co', 'Upgrade Co', 'NZD')`,
      );
      await client.query(
        `insert into accounts (code, name, account_class, account_type, system_key) values
           ('1000', 'Bank', 'asset', 'bank', 'bank'),
           ('1100', 'Accounts receivable', 'asset', 'current_asset', 'accounts_receivable'),
           ('2000', 'Accounts payable', 'liability', 'current_liability', null),
           ('2100', 'GST', 'liability', 'current_liability', 'gst'),
           ('6010', 'Accounting fees', 'expense', 'expense', null)`,
      );

      const upgraded = await applyMigrations(client, tenantMigrations, "test:upgrade");
      expect(upgraded.applied).toContain("0005");
      expect((await client.query("select display_name from organisation_settings")).rows).toEqual([
        { display_name: "Upgrade Co" },
      ]);
      expect((await client.query("select code, system_key from accounts order by code")).rows).toEqual([
        { code: "1000", system_key: "bank" },
        { code: "1100", system_key: "accounts_receivable" },
        { code: "2000", system_key: "accounts_payable" },
        { code: "2100", system_key: "gst" },
        { code: "6010", system_key: null },
      ]);
      expect((await client.query("select count(*)::int as count from bills")).rows).toEqual([{ count: 0 }]);
      const origin = await client.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'ledger_journals_origin_check'",
      );
      expect(origin.rows[0].definition).toContain("'bill'");
      expect(origin.rows[0].definition).toContain("'customer_payment'");
    } finally {
      await client.end();
    }
  });
});

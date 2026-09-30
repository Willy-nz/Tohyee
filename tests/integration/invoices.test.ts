import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as approveRoute from "@/app/api/invoices/[invoiceId]/approve/route";
import * as invoiceRoute from "@/app/api/invoices/[invoiceId]/route";
import * as voidRoute from "@/app/api/invoices/[invoiceId]/void/route";
import * as invoicesRoute from "@/app/api/invoices/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { archiveContact, type Contact, createContact } from "@/lib/contacts/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import {
  approveInvoice,
  createInvoice,
  deleteInvoice,
  getInvoice,
  type Invoice,
  type InvoiceSummary,
  listInvoices,
  updateInvoice,
  voidInvoice,
} from "@/lib/invoices/service";
import { correctJournal, getJournal, getJournalDetails } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { getOrganisationSettings, updateOrganisationSettings } from "@/lib/organisations/settings";
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

const ORG = "invoices-co";
const OTHER_ORG = "invoices-two";
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

function line(quantity: string, unitPrice: string, taxCode: string | null = "GST", accountCode = "4000"): LineInput {
  return { description: "Consulting", quantity, unitPrice, accountCode, taxCode };
}

/** Examples I1-I9 in docs/ACCOUNTING-EXAMPLES.md ("Sales invoices"). */
describeWithDatabase("sales invoices", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let customer: Contact;
  let supplier: Contact;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>, organisationId = ORG) =>
    inOrganisation(organisationId, { userId: user.id, email: user.email }, work);

  /** Saves a draft: 2 x $50.00 at 15% exclusive (example I1) unless told otherwise. */
  const draft = async (fields: Record<string, unknown> = {}, organisationId = ORG): Promise<Invoice> =>
    (
      await asUser(
        bookkeeper,
        (tx) =>
          createInvoice(tx, {
            idempotencyKey: key("invoice"),
            contactId: customer.id,
            invoiceDate: "2026-05-10",
            dueDate: "2026-06-20",
            amountsMode: "exclusive",
            lines: [line("2", "50.00")],
            ...fields,
          }),
        organisationId,
      )
    ).invoice;
  const approve = (invoiceId: string, idempotencyKey = key("approve"), organisationId = ORG) =>
    asUser(bookkeeper, (tx) => approveInvoice(tx, invoiceId, { idempotencyKey }), organisationId);
  const voidIt = (invoiceId: string, voidDate: string, idempotencyKey = key("void")) =>
    asUser(bookkeeper, (tx) => voidInvoice(tx, invoiceId, { idempotencyKey, voidDate }));
  const journal = (journalId: string) => asUser(owner, (tx) => getJournal(tx, journalId));
  /** A journal's lines as [account, debit, credit]. */
  const postedLines = async (journalId: string) =>
    (await journal(journalId)).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);
  const journalCount = async () =>
    Number(
      (await asUser(owner, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals")))
        .rows[0].count,
    );
  const sequenceOf = (invoice: InvoiceSummary) => Number(invoice.invoiceNumber!.replace("INV-", ""));
  const lastApproved = async () =>
    (await asUser(owner, (tx) => listInvoices(tx, { status: "approved", limit: 1 }))).invoices[0] ?? null;

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
    supplier = (
      await asUser(bookkeeper, (tx) =>
        createContact(tx, { idempotencyKey: key("contact"), name: "Kauri Supplies", isSupplier: true }),
      )
    ).contact;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("I1: exclusive 2 x $50.00 at 15% is net 100.00, GST 15.00, total 115.00; approving posts Dr 1100 / Cr 4000 / Cr 2100", async () => {
    const saved = await draft({ reference: "PO 4471" });
    expect(saved).toMatchObject({
      status: "draft",
      invoiceNumber: null,
      approvalJournalId: null,
      contactName: "Aroha Café Ltd",
      reference: "PO 4471",
      currencyCode: "NZD",
      subtotal: "100.00",
      taxTotal: "15.00",
      total: "115.00",
      createdByEmail: bookkeeper.email,
    });
    expect(saved.lines).toEqual([
      expect.objectContaining({
        lineOrder: 1,
        quantity: "2",
        unitPrice: "50",
        accountCode: "4000",
        taxCode: "GST",
        taxRate: "0.15",
        lineAmount: "100.00",
        netAmount: "100.00",
        taxAmount: "15.00",
      }),
    ]);

    const { created, invoice } = await approve(saved.id);
    expect(created).toBe(true);
    expect(invoice).toMatchObject({ status: "approved", approvedByEmail: bookkeeper.email, total: "115.00" });
    expect(invoice.invoiceNumber).toMatch(/^INV-\d{4}$/);
    const posted = await journal(invoice.approvalJournalId!);
    expect(posted).toMatchObject({
      origin: "invoice",
      postingDate: "2026-05-10",
      reference: invoice.invoiceNumber,
      description: `Invoice ${invoice.invoiceNumber} to Aroha Café Ltd`,
      totalDebit: "115.00",
      relatedJournalId: null,
      correctionKind: null,
      createdByEmail: bookkeeper.email,
    });
    expect(await postedLines(posted.id)).toEqual([
      ["1100", "115.00", "0.00"],
      ["4000", "0.00", "100.00"],
      ["2100", "0.00", "15.00"],
    ]);
  });

  it("I2: inclusive 1 x $115.00 at 15% is net 100.00, GST 15.00, total 115.00", async () => {
    const saved = await draft({ amountsMode: "inclusive", lines: [line("1", "115.00")] });
    expect(saved).toMatchObject({ subtotal: "100.00", taxTotal: "15.00", total: "115.00" });
    expect(saved.lines[0]).toMatchObject({ lineAmount: "115.00", netAmount: "100.00", taxAmount: "15.00" });
    const { invoice } = await approve(saved.id);
    expect(await postedLines(invoice.approvalJournalId!)).toEqual([
      ["1100", "115.00", "0.00"],
      ["4000", "0.00", "100.00"],
      ["2100", "0.00", "15.00"],
    ]);
  });

  it("I3: GST is rounded per line: three lines of 1 x $3.33 have GST 0.50 each, 1.50 in all, total 11.49", async () => {
    const saved = await draft({ lines: [line("1", "3.33"), line("1", "3.33"), line("1", "3.33")] });
    expect(saved.lines.map((entry) => entry.taxAmount)).toEqual(["0.50", "0.50", "0.50"]);
    expect(saved).toMatchObject({ subtotal: "9.99", taxTotal: "1.50", total: "11.49" });
    const { invoice } = await approve(saved.id);
    // One credit per revenue account, not one per invoice line.
    expect(await postedLines(invoice.approvalJournalId!)).toEqual([
      ["1100", "11.49", "0.00"],
      ["4000", "0.00", "9.99"],
      ["2100", "0.00", "1.50"],
    ]);
  });

  it("I4: inclusive 1 x $10.00 at 15% has GST 10.00 x 3/23 = 1.3043, so 1.30, and net 8.70", async () => {
    const saved = await draft({ amountsMode: "inclusive", lines: [line("1", "10.00")] });
    expect(saved).toMatchObject({ subtotal: "8.70", taxTotal: "1.30", total: "10.00" });
    const { invoice } = await approve(saved.id);
    expect(await postedLines(invoice.approvalJournalId!)).toEqual([
      ["1100", "10.00", "0.00"],
      ["4000", "0.00", "8.70"],
      ["2100", "0.00", "1.30"],
    ]);
  });

  it("I5: $100.00 at standard 15% plus $50.00 zero-rated is GST 15.00, total 165.00, Cr 4000 150.00", async () => {
    const saved = await draft({ lines: [line("1", "100.00", "GST"), line("1", "50.00", "ZERO")] });
    expect(saved.lines.map((entry) => [entry.taxCode, entry.taxRate, entry.taxAmount])).toEqual([
      ["GST", "0.15", "15.00"],
      ["ZERO", "0", "0.00"],
    ]);
    expect(saved).toMatchObject({ subtotal: "150.00", taxTotal: "15.00", total: "165.00" });
    const { invoice } = await approve(saved.id);
    expect(await postedLines(invoice.approvalJournalId!)).toEqual([
      ["1100", "165.00", "0.00"],
      ["4000", "0.00", "150.00"],
      ["2100", "0.00", "15.00"],
    ]);
  });

  it("I5: each revenue account is credited with its own net amount, in the order they first appear", async () => {
    const saved = await draft({
      lines: [line("1", "40.00", "GST", "4100"), line("1", "100.00", "GST", "4000"), line("2", "5.00", "ZERO", "4100")],
    });
    const { invoice } = await approve(saved.id);
    expect(await postedLines(invoice.approvalJournalId!)).toEqual([
      ["1100", "171.00", "0.00"],
      ["4100", "0.00", "50.00"],
      ["4000", "0.00", "100.00"],
      ["2100", "0.00", "21.00"],
    ]);
  });

  it("I6: no tax, 1 x $80.00 is total 80.00 and posts no GST line", async () => {
    const saved = await draft({ amountsMode: "no_tax", lines: [line("1", "80.00", null)] });
    expect(saved).toMatchObject({ subtotal: "80.00", taxTotal: "0.00", total: "80.00" });
    expect(saved.lines[0]).toMatchObject({ taxCode: null, taxRate: "0", taxAmount: "0.00" });
    const { invoice } = await approve(saved.id);
    expect(await postedLines(invoice.approvalJournalId!)).toEqual([
      ["1100", "80.00", "0.00"],
      ["4000", "0.00", "80.00"],
    ]);
  });

  it("I7: voiding posts the exact reversal on the void date; the invoice shows as voided; a second void is refused", async () => {
    const { invoice: approved } = await approve((await draft()).id);
    const original = await journal(approved.approvalJournalId!);
    const journalsBefore = await journalCount();

    const voidKey = key("void");
    const { created, invoice } = await voidIt(approved.id, "2026-06-15", voidKey);
    expect(created).toBe(true);
    expect(invoice).toMatchObject({
      status: "voided",
      voidDate: "2026-06-15",
      invoiceNumber: approved.invoiceNumber,
      approvalJournalId: approved.approvalJournalId,
      voidedByEmail: bookkeeper.email,
      total: "115.00",
    });
    const reversal = await journal(invoice.voidJournalId!);
    expect(reversal).toMatchObject({
      origin: "invoice",
      postingDate: "2026-06-15",
      reference: `VOID-${approved.invoiceNumber}`,
      relatedJournalId: original.id,
      correctionKind: "reversal",
      totalDebit: "115.00",
    });
    expect(reversal.lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount, entry.description])).toEqual(
      original.lines.map((entry) => [entry.accountCode, entry.creditAmount, entry.debitAmount, entry.description]),
    );
    expect(await postedLines(reversal.id)).toEqual([
      ["1100", "0.00", "115.00"],
      ["4000", "100.00", "0.00"],
      ["2100", "15.00", "0.00"],
    ]);

    // A retry of the same void returns it; another void is refused.
    const retried = await voidIt(approved.id, "2026-06-15", voidKey);
    expect(retried).toMatchObject({ created: false, invoice: { id: approved.id, voidJournalId: reversal.id } });
    await expect(voidIt(approved.id, "2026-06-16")).rejects.toThrow(`Invoice ${approved.invoiceNumber} has already been voided.`);
    await expect(voidIt(approved.id, "2026-06-16", voidKey)).rejects.toThrow(/already used for a different invoice void/);
    expect(await journalCount()).toBe(journalsBefore + 1);

    // The ledger shows the pair, and neither can be corrected there.
    const details = await asUser(owner, (tx) => getJournalDetails(tx, original.id));
    expect(details.canCorrect).toBe(false);
    expect(details.correctionJournals.map((entry) => entry.id)).toEqual([reversal.id]);
    expect((await asUser(owner, (tx) => getJournalDetails(tx, reversal.id))).canCorrect).toBe(false);
  });

  it("I7: a void must be dated on or after the invoice date, in an open period; drafts are deleted, not voided", async () => {
    const drafted = await draft();
    await expect(voidIt(drafted.id, "2026-06-15")).rejects.toThrow(/still a draft, so there's nothing to void/);
    const { invoice: approved } = await approve(drafted.id);
    await expect(voidIt(approved.id, "2026-05-09")).rejects.toThrow(
      "The void date can't be before the invoice date (2026-05-10).",
    );
    await expect(voidIt(approved.id, "15/06/2026")).rejects.toThrow(/voidDate/);

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    try {
      await expect(voidIt(approved.id, "2026-05-20")).rejects.toThrow(/2026-05-20 is in a locked period/);
      expect((await asUser(viewer, (tx) => getInvoice(tx, approved.id))).status).toBe("approved");
      // The invoice's own period is locked, but a void dated in an open period is fine.
      const { invoice } = await voidIt(approved.id, "2026-06-01");
      expect(invoice).toMatchObject({ status: "voided", voidDate: "2026-06-01" });
      expect((await journal(invoice.voidJournalId!)).postingDate).toBe("2026-06-01");
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null }));
    }
  });

  it("I8: approving an invoice dated in a locked period is refused; the draft stays a draft and no number is used", async () => {
    const before = (await approve((await draft()).id)).invoice;
    const locked = await draft({ invoiceDate: "2026-03-15", dueDate: "2026-04-15" });
    const journalsBefore = await journalCount();

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-03-31" }));
    try {
      await expect(approve(locked.id)).rejects.toThrow(/2026-03-15 is in a locked period \(locked up to 2026-03-31\)/);
      const after = await asUser(viewer, (tx) => getInvoice(tx, locked.id));
      expect(after).toMatchObject({ status: "draft", invoiceNumber: null, approvalJournalId: null });
      expect(await journalCount()).toBe(journalsBefore);

      // No gap: the next approval takes the number the refused one would have had.
      const next = (await approve((await draft()).id)).invoice;
      expect(sequenceOf(next)).toBe(sequenceOf(before) + 1);
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null }));
    }
    // Once the period is open again it can be approved.
    expect((await approve(locked.id)).invoice).toMatchObject({ status: "approved", invoiceDate: "2026-03-15" });
  });

  it("I9: retrying an approval with the same key returns the same number and journal; drafts post nothing", async () => {
    const journalsBefore = await journalCount();
    const first = await draft();
    const second = await draft({ lines: [line("3", "20.00")] });
    await asUser(bookkeeper, (tx) => updateInvoice(tx, first.id, { reference: "Edited while a draft" }));
    expect(await journalCount()).toBe(journalsBefore);

    const approveKey = key("approve");
    const approved = await approve(first.id, approveKey);
    const retried = await approve(first.id, approveKey);
    expect(approved.created).toBe(true);
    expect(retried.created).toBe(false);
    expect(retried.invoice.invoiceNumber).toBe(approved.invoice.invoiceNumber);
    expect(retried.invoice.approvalJournalId).toBe(approved.invoice.approvalJournalId);
    expect(await journalCount()).toBe(journalsBefore + 1);

    // The key belongs to that approval; a new request on an approved invoice is refused.
    await expect(approve(second.id, approveKey)).rejects.toThrow(/already used for a different invoice approval/);
    await expect(approve(first.id)).rejects.toThrow(`Invoice ${approved.invoice.invoiceNumber} is already approved.`);
    expect((await asUser(viewer, (tx) => getInvoice(tx, second.id))).status).toBe("draft");
    expect(await journalCount()).toBe(journalsBefore + 1);
  });

  it("L4, I7, I9: retrying an approval or a void after its period is locked returns the original, not a lock error", async () => {
    const approveKey = key("approve");
    const { invoice: approved } = await approve((await draft()).id, approveKey);
    const { invoice: toVoid } = await approve((await draft()).id);
    const voidKey = key("void");
    const { invoice: voided } = await voidIt(toVoid.id, "2026-05-20", voidKey);
    const journalsBefore = await journalCount();

    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    try {
      expect(await approve(approved.id, approveKey)).toMatchObject({
        created: false,
        invoice: {
          id: approved.id,
          status: "approved",
          invoiceNumber: approved.invoiceNumber,
          approvalJournalId: approved.approvalJournalId,
        },
      });
      expect(await voidIt(toVoid.id, "2026-05-20", voidKey)).toMatchObject({
        created: false,
        invoice: { id: toVoid.id, status: "voided", voidDate: "2026-05-20", voidJournalId: voided.voidJournalId },
      });
      // Something new in the locked period is still refused.
      await expect(voidIt(approved.id, "2026-05-20")).rejects.toThrow(/2026-05-20 is in a locked period/);
      expect(await journalCount()).toBe(journalsBefore);
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null }));
    }
  });

  it("I7, I9: approvals and voids at the same moment take turns: a retry queued behind the first returns it; numbers stay gap-free", async () => {
    const drafted = await draft();
    const approveKey = key("approve");
    const [left, right] = [await draft(), await draft()];
    const journalsBefore = await journalCount();

    // Hold the invoice's lock so both copies of the request pass the first key check and queue behind it.
    const copies = await asUser(owner, async (tx) => {
      await tx.query("select id from sales_invoices where id = $1 for update", [drafted.id]);
      const queued = [approve(drafted.id, approveKey), approve(drafted.id, approveKey)];
      await waitForLockWaiters(tx, 2);
      return queued;
    });
    const results = await Promise.all(copies);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[1].invoice).toMatchObject({
      status: "approved",
      invoiceNumber: results[0].invoice.invoiceNumber,
      approvalJournalId: results[0].invoice.approvalJournalId,
    });
    expect(await journalCount()).toBe(journalsBefore + 1);

    // Two invoices queued behind the number counter get the next two numbers.
    const pair = await asUser(owner, async (tx) => {
      await tx.query("select last_number from sales_invoice_numbering where id = true for update");
      const queued = [approve(left.id), approve(right.id)];
      await waitForLockWaiters(tx, 2);
      return queued;
    });
    const numbers = (await Promise.all(pair)).map(({ invoice }) => sequenceOf(invoice)).sort((a, b) => a - b);
    const first = sequenceOf(results[0].invoice);
    expect(numbers).toEqual([first + 1, first + 2]);
    expect(await journalCount()).toBe(journalsBefore + 3);

    // Two copies of a void queued behind the invoice's lock void it once.
    const voidKey = key("void");
    const voids = await asUser(owner, async (tx) => {
      await tx.query("select id from sales_invoices where id = $1 for update", [left.id]);
      const queued = [voidIt(left.id, "2026-06-15", voidKey), voidIt(left.id, "2026-06-15", voidKey)];
      await waitForLockWaiters(tx, 2);
      return queued;
    });
    const voided = await Promise.all(voids);
    expect(voided.map((result) => result.created).sort()).toEqual([false, true]);
    expect(voided[0].invoice.voidJournalId).toEqual(expect.any(String));
    expect(voided[1].invoice).toMatchObject({ status: "voided", voidJournalId: voided[0].invoice.voidJournalId });
    expect(await journalCount()).toBe(journalsBefore + 4);
  });

  it("numbers are per organisation and run INV-0001, INV-0002, ... in approval order", async () => {
    await createTestOrganisation(owner, OTHER_ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [
      OTHER_ORG,
      bookkeeper.id,
    ]);
    const otherCustomer = await asUser(
      bookkeeper,
      async (tx) => {
        return (await createContact(tx, { idempotencyKey: key("contact"), name: "Tūī Traders", isCustomer: true }))
          .contact;
      },
      OTHER_ORG,
    );
    const first = await draft({ contactId: otherCustomer.id }, OTHER_ORG);
    const second = await draft({ contactId: otherCustomer.id, invoiceDate: "2026-04-01" }, OTHER_ORG);
    // Numbered when approved, not when saved or by date.
    expect((await approve(second.id, key("approve"), OTHER_ORG)).invoice.invoiceNumber).toBe("INV-0001");
    expect((await approve(first.id, key("approve"), OTHER_ORG)).invoice.invoiceNumber).toBe("INV-0002");
    expect(sequenceOf((await lastApproved())!)).toBeGreaterThan(2);
  });

  it("saving a draft is idempotent: the same key and content return it; different content is refused", async () => {
    const command = {
      idempotencyKey: key("invoice"),
      contactId: customer.id,
      invoiceDate: "2026-05-10",
      dueDate: "2026-06-20",
      amountsMode: "exclusive",
      lines: [line("2", "50.00")],
    };
    const first = await asUser(bookkeeper, (tx) => createInvoice(tx, command));
    const again = await asUser(bookkeeper, (tx) =>
      createInvoice(tx, { ...command, lines: [{ ...line("2.0", "50"), accountCode: "4000" }] }),
    );
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, invoice: { id: first.invoice.id } });
    await expect(
      asUser(bookkeeper, (tx) => createInvoice(tx, { ...command, lines: [line("3", "50.00")] })),
    ).rejects.toThrow(/already used for a different invoice/);
  });

  it("drafts can be edited and deleted; approved and voided invoices can't", async () => {
    const saved = await draft();
    const edited = await asUser(bookkeeper, (tx) =>
      updateInvoice(tx, saved.id, {
        dueDate: "2026-07-01",
        amountsMode: "inclusive",
        lines: [line("1", "115.00"), line("4", "2.50", "ZERO", "4100")],
      }),
    );
    expect(edited).toMatchObject({
      id: saved.id,
      status: "draft",
      invoiceDate: "2026-05-10",
      dueDate: "2026-07-01",
      amountsMode: "inclusive",
      subtotal: "110.00",
      taxTotal: "15.00",
      total: "125.00",
    });
    expect(edited.lines.map((entry) => [entry.lineOrder, entry.accountCode, entry.netAmount])).toEqual([
      [1, "4000", "100.00"],
      [2, "4100", "10.00"],
    ]);
    // Saving it unchanged isn't recorded as an edit.
    await asUser(bookkeeper, (tx) => updateInvoice(tx, saved.id, { dueDate: "2026-07-01" }));
    const audit = await asUser(owner, (tx) =>
      tx.query<{ event_type: string; actor_email: string; details: Record<string, unknown> }>(
        "select event_type, actor_email, details from audit_events where entity_type = 'sales_invoice' and entity_id = $1 order by id",
        [saved.id],
      ),
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({ event_type: "invoice.created", actor_email: bookkeeper.email }),
      {
        event_type: "invoice.updated",
        actor_email: bookkeeper.email,
        details: { changed: ["dueDate", "amountsMode", "lines"], total: { from: "115.00", to: "125.00" } },
      },
    ]);

    const doomed = await draft();
    await asUser(bookkeeper, (tx) => deleteInvoice(tx, doomed.id));
    await expect(asUser(viewer, (tx) => getInvoice(tx, doomed.id))).rejects.toThrow("Invoice not found.");
    const leftover = await asUser(owner, (tx) =>
      tx.query("select 1 from sales_invoice_lines where invoice_id = $1", [doomed.id]),
    );
    expect(leftover.rowCount).toBe(0);

    const { invoice: approved } = await approve(saved.id);
    await expect(asUser(bookkeeper, (tx) => updateInvoice(tx, approved.id, { reference: "Too late" }))).rejects.toThrow(
      `Invoice ${approved.invoiceNumber} is approved, so it can't be edited. Void it instead.`,
    );
    await expect(asUser(bookkeeper, (tx) => deleteInvoice(tx, approved.id))).rejects.toThrow(
      `Invoice ${approved.invoiceNumber} is approved, so it can't be deleted. Void it instead.`,
    );
    await voidIt(approved.id, "2026-06-30");
    await expect(asUser(bookkeeper, (tx) => updateInvoice(tx, approved.id, { reference: "Too late" }))).rejects.toThrow(
      `Invoice ${approved.invoiceNumber} is voided, so it can't be edited.`,
    );
    await expect(asUser(bookkeeper, (tx) => deleteInvoice(tx, approved.id))).rejects.toThrow(/is voided, so it can't be deleted/);
    await expect(asUser(bookkeeper, (tx) => deleteInvoice(tx, "999999"))).rejects.toThrow("Invoice not found.");
  });

  it("refuses invoices that break the rules", async () => {
    const archived = (
      await asUser(bookkeeper, (tx) =>
        createContact(tx, { idempotencyKey: key("contact"), name: "Gone Café", isCustomer: true }),
      )
    ).contact;
    await asUser(bookkeeper, (tx) => archiveContact(tx, archived.id));

    const refusals: Array<[Record<string, unknown>, RegExp | string]> = [
      [{ contactId: supplier.id }, "Kauri Supplies isn't marked as a customer. Edit the contact first, or pick another one."],
      [{ contactId: archived.id }, /Gone Café is archived/],
      [{ contactId: "999999" }, "There's no contact #999999."],
      [{ dueDate: "2026-05-09" }, "The due date can't be before the invoice date."],
      [{ amountsMode: "gross" }, /amountsMode must be one of/],
      [{ lines: [] }, "An invoice needs at least one line."],
      [{ lines: Array.from({ length: 201 }, () => line("1", "1")) }, /at most 200/],
      [{ lines: [line("1", "10", "GST", "1000")] }, /account 1000 \(Business bank account\) isn't a revenue account/],
      [{ lines: [line("1", "10", "GST", "9999")] }, "Line 1: there's no account with the code 9999."],
      [{ lines: [line("1", "10", null)] }, /Line 1 needs a tax code/],
      [{ lines: [line("1", "10", "NOPE")] }, "Line 1: there's no tax code NOPE."],
      [{ amountsMode: "no_tax", lines: [line("1", "10", "GST")] }, /Line 1 has a tax code, but the invoice's amounts have no tax/],
      [{ invoiceDate: "2010-09-30" }, /tax code GST isn't in effect on 2010-09-30 \(it applies from 2010-10-01\)/],
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

    // Four decimal places are fine.
    expect((await draft({ lines: [line("1.2345", "10.1234")] })).lines[0]).toMatchObject({
      quantity: "1.2345",
      unitPrice: "10.1234",
      lineAmount: "12.50",
    });
  });

  it("approval checks the draft again: customer, accounts and tax codes must still be usable and its amounts current", async () => {
    // A customer archived after the draft was saved.
    const leaving = (
      await asUser(bookkeeper, (tx) =>
        createContact(tx, { idempotencyKey: key("contact"), name: "Leaving Ltd", isCustomer: true }),
      )
    ).contact;
    const forLeaving = await draft({ contactId: leaving.id });
    await asUser(bookkeeper, (tx) => archiveContact(tx, leaving.id));
    await expect(approve(forLeaving.id)).rejects.toThrow(/Leaving Ltd is archived/);

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

    for (const invoiceId of [forLeaving.id, stale.id]) {
      expect(await asUser(viewer, (tx) => getInvoice(tx, invoiceId))).toMatchObject({ status: "draft", invoiceNumber: null });
    }
  });

  it("journals posted by invoices can't be corrected in the ledger", async () => {
    const { invoice } = await approve((await draft()).id);
    await expect(
      asUser(bookkeeper, (tx) =>
        correctJournal(tx, {
          idempotencyKey: key("fix"),
          originalJournalId: invoice.approvalJournalId,
          postingDate: "2026-06-01",
          reference: "FIX",
          lines: [
            { accountCode: "1100", debitAmount: "100" },
            { accountCode: "4000", creditAmount: "100" },
          ],
        }),
      ),
    ).rejects.toThrow(`posted by a sales invoice (${invoice.invoiceNumber}), so it can't be corrected in the ledger`);
  });

  it("the database refuses changes to approved invoices, their lines and the number counter", async () => {
    const { invoice } = await approve((await draft()).id);
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));

    await expect(sql("update sales_invoices set total = 1, subtotal = 1, tax_total = 0 where id = $1", [invoice.id])).rejects.toThrow(
      `Invoice ${invoice.invoiceNumber} is approved, so it can't be changed`,
    );
    await expect(sql("update sales_invoices set status = 'draft' where id = $1", [invoice.id])).rejects.toThrow(/can't be changed/);
    // Voiding may only add the void details.
    await expect(
      sql("update sales_invoices set status = 'voided', reference = 'sneaky' where id = $1", [invoice.id]),
    ).rejects.toThrow(/can't be changed/);
    await expect(sql("delete from sales_invoices where id = $1", [invoice.id])).rejects.toThrow(
      `Invoice ${invoice.invoiceNumber} is approved, so it can't be deleted`,
    );
    await expect(sql("update sales_invoice_lines set description = 'x' where invoice_id = $1", [invoice.id])).rejects.toThrow(
      "Lines of an approved or voided invoice can't be changed",
    );
    await expect(sql("delete from sales_invoice_lines where invoice_id = $1", [invoice.id])).rejects.toThrow(
      "Lines of an approved or voided invoice can't be changed",
    );
    const accountId = invoice.lines[0].accountId;
    await expect(
      sql(
        `insert into sales_invoice_lines (invoice_id, line_order, description, quantity, unit_price, account_id,
                                          line_amount, net_amount, tax_amount)
         values ($1, 9, 'extra', 1, 1, $2, 1, 1, 0)`,
        [invoice.id, accountId],
      ),
    ).rejects.toThrow("Lines can only be added to a draft invoice");
    await expect(sql("truncate sales_invoice_lines")).rejects.toThrow("sales_invoice_lines can't be truncated");
    await expect(sql("truncate sales_invoices cascade")).rejects.toThrow(/can't be truncated/);

    await expect(sql("update sales_invoice_numbering set last_number = last_number + 5")).rejects.toThrow(
      "Invoice numbers only move forward one at a time",
    );
    await expect(sql("update sales_invoice_numbering set last_number = last_number - 1")).rejects.toThrow(/one at a time/);
    await expect(sql("delete from sales_invoice_numbering")).rejects.toThrow(/one at a time/);

    // Totals must add up and numbers must match their sequence.
    await expect(
      sql(
        `insert into sales_invoices (command_source, idempotency_key, request_hash, contact_id, invoice_date, due_date,
                                     amounts_mode, currency_code, subtotal, tax_total, total)
         values ('sql', $1, 'h', $2, '2026-05-10', '2026-05-10', 'exclusive', 'NZD', 100, 15, 116)`,
        [key("sql"), customer.id],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(sql("update sales_invoices set invoice_number = 'INV-7' where id = $1", [invoice.id])).rejects.toThrow(
      /can't be changed/,
    );
    expect((await asUser(viewer, (tx) => getInvoice(tx, invoice.id))).total).toBe("115.00");
  });

  it("lists invoices newest first, filtered by status and paged", async () => {
    const all = await asUser(viewer, (tx) => listInvoices(tx));
    expect(all.invoices.length).toBeGreaterThan(5);
    expect(all.invoices.map((entry) => Number(entry.id))).toEqual(
      [...all.invoices.map((entry) => Number(entry.id))].sort((a, b) => b - a),
    );
    for (const status of ["draft", "approved", "voided"] as const) {
      const filtered = await asUser(viewer, (tx) => listInvoices(tx, { status }));
      expect(filtered.invoices.length).toBeGreaterThan(0);
      expect(filtered.invoices.every((entry) => entry.status === status)).toBe(true);
    }
    const page = await asUser(viewer, (tx) => listInvoices(tx, { limit: "2" }));
    expect(page.invoices.map((entry) => entry.id)).toEqual(all.invoices.slice(0, 2).map((entry) => entry.id));
    const next = await asUser(viewer, (tx) => listInvoices(tx, { limit: "2", beforeId: page.nextBeforeId }));
    expect(next.invoices.map((entry) => entry.id)).toEqual(all.invoices.slice(2, 4).map((entry) => entry.id));
    await expect(asUser(viewer, (tx) => listInvoices(tx, { status: "paid" }))).rejects.toThrow(/status must be one of/);
  });

  it("over HTTP: viewers can read; bookkeepers can do everything else; non-members get 404", async () => {
    const [bookkeeperCookie, viewerCookie, outsiderCookie] = await Promise.all(
      [bookkeeper, viewer, outsider].map((user) => sessionCookieFor(user)),
    );
    const post = (cookie: string, fields: Record<string, unknown>) =>
      invoicesRoute.POST(apiRequest("/api/invoices", { method: "POST", cookie, body: { organisationId: ORG, ...fields } }), noContext);
    const list = (cookie: string, query = "") =>
      invoicesRoute.GET(apiRequest(`/api/invoices?organisationId=${ORG}${query}`, { cookie }), noContext);
    const get = (cookie: string, invoiceId: string) =>
      invoiceRoute.GET(apiRequest(`/api/invoices/${invoiceId}?organisationId=${ORG}`, { cookie }), params({ invoiceId }));
    const patch = (cookie: string, invoiceId: string, fields: Record<string, unknown>) =>
      invoiceRoute.PATCH(
        apiRequest(`/api/invoices/${invoiceId}`, { method: "PATCH", cookie, body: { organisationId: ORG, ...fields } }),
        params({ invoiceId }),
      );
    const remove = (cookie: string, invoiceId: string) =>
      invoiceRoute.DELETE(
        apiRequest(`/api/invoices/${invoiceId}?organisationId=${ORG}`, { method: "DELETE", cookie }),
        params({ invoiceId }),
      );
    const approveOver = (cookie: string, invoiceId: string, idempotencyKey: string) =>
      approveRoute.POST(
        apiRequest(`/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          cookie,
          body: { organisationId: ORG, source: "ui", idempotencyKey },
        }),
        params({ invoiceId }),
      );
    const voidOver = (cookie: string, invoiceId: string, idempotencyKey: string, voidDate: string) =>
      voidRoute.POST(
        apiRequest(`/api/invoices/${invoiceId}/void`, {
          method: "POST",
          cookie,
          body: { organisationId: ORG, source: "ui", idempotencyKey, voidDate },
        }),
        params({ invoiceId }),
      );
    const command = {
      source: "ui",
      idempotencyKey: key("http"),
      contactId: customer.id,
      invoiceDate: "2026-06-02",
      dueDate: "2026-06-30",
      reference: "Web order 88",
      amountsMode: "exclusive",
      lines: [line("2", "50.00")],
    };

    expect((await post(viewerCookie, command)).status).toBe(403);
    const created = await post(bookkeeperCookie, command);
    expect(created.status).toBe(201);
    const invoice = (await body(created)).invoice as Invoice;
    expect(invoice).toMatchObject({ status: "draft", total: "115.00", createdByEmail: bookkeeper.email });
    const retried = await post(bookkeeperCookie, command);
    expect(retried.status).toBe(200);
    expect(await body(retried)).toMatchObject({ created: false, invoice: { id: invoice.id } });
    expect((await post(bookkeeperCookie, { ...command, reference: "Changed" })).status).toBe(409);
    const refused = await post(bookkeeperCookie, { ...command, idempotencyKey: key("http"), contactId: supplier.id });
    expect(refused.status).toBe(400);
    expect((await body(refused)).error).toMatch(/isn't marked as a customer/);

    const viewerList = await list(viewerCookie, "&status=draft");
    expect(viewerList.status).toBe(200);
    expect(((await body(viewerList)).invoices as InvoiceSummary[]).map((entry) => entry.id)).toContain(invoice.id);
    expect((await list(viewerCookie, "&status=paid")).status).toBe(400);
    const viewed = await get(viewerCookie, invoice.id);
    expect(viewed.status).toBe(200);
    expect((await body(viewed)).invoice).toMatchObject({ id: invoice.id, lines: [expect.objectContaining({ taxCode: "GST" })] });
    expect((await get(viewerCookie, "999999")).status).toBe(404);

    expect((await patch(viewerCookie, invoice.id, { reference: "Viewer edit" })).status).toBe(403);
    const edited = await patch(bookkeeperCookie, invoice.id, { lines: [line("3", "50.00")] });
    expect(edited.status).toBe(200);
    expect((await body(edited)).invoice).toMatchObject({ reference: "Web order 88", total: "172.50" });

    const approveKey = key("http-approve");
    expect((await approveOver(viewerCookie, invoice.id, approveKey)).status).toBe(403);
    const approved = await approveOver(bookkeeperCookie, invoice.id, approveKey);
    expect(approved.status).toBe(201);
    const approvedInvoice = (await body(approved)).invoice as Invoice;
    expect(approvedInvoice).toMatchObject({ status: "approved", approvedByEmail: bookkeeper.email });
    const approvedAgain = await approveOver(bookkeeperCookie, invoice.id, approveKey);
    expect(approvedAgain.status).toBe(200);
    expect(await body(approvedAgain)).toMatchObject({
      created: false,
      invoice: { invoiceNumber: approvedInvoice.invoiceNumber, approvalJournalId: approvedInvoice.approvalJournalId },
    });
    expect((await approveOver(bookkeeperCookie, invoice.id, key("http-approve"))).status).toBe(409);
    expect((await patch(bookkeeperCookie, invoice.id, { reference: "Too late" })).status).toBe(409);
    expect((await remove(bookkeeperCookie, invoice.id)).status).toBe(409);

    const voidKey = key("http-void");
    expect((await voidOver(viewerCookie, invoice.id, voidKey, "2026-06-20")).status).toBe(403);
    const voided = await voidOver(bookkeeperCookie, invoice.id, voidKey, "2026-06-20");
    expect(voided.status).toBe(201);
    expect((await body(voided)).invoice).toMatchObject({ status: "voided", voidedByEmail: bookkeeper.email });
    expect((await voidOver(bookkeeperCookie, invoice.id, voidKey, "2026-06-20")).status).toBe(200);
    expect((await voidOver(bookkeeperCookie, invoice.id, key("http-void"), "2026-06-21")).status).toBe(409);

    const scrap = (await body(await post(bookkeeperCookie, { ...command, idempotencyKey: key("http") }))).invoice as Invoice;
    expect((await remove(viewerCookie, scrap.id)).status).toBe(403);
    const removed = await remove(bookkeeperCookie, scrap.id);
    expect(removed.status).toBe(200);
    expect(await body(removed)).toEqual({ ok: true });
    expect((await get(viewerCookie, scrap.id)).status).toBe(404);

    // Non-members can't tell the organisation exists; nobody signed in gets nothing.
    expect((await list(outsiderCookie)).status).toBe(404);
    expect((await get(outsiderCookie, invoice.id)).status).toBe(404);
    expect((await post(outsiderCookie, { ...command, idempotencyKey: key("http") })).status).toBe(404);
    expect((await approveOver(outsiderCookie, invoice.id, key("x"))).status).toBe(404);
    const kept = (await body(await post(bookkeeperCookie, { ...command, idempotencyKey: key("http") }))).invoice as Invoice;
    expect((await patch(outsiderCookie, kept.id, { reference: "Outsider edit" })).status).toBe(404);
    expect((await remove(outsiderCookie, kept.id)).status).toBe(404);
    expect((await approveOver(bookkeeperCookie, kept.id, key("http-approve"))).status).toBe(201);
    expect((await voidOver(outsiderCookie, kept.id, key("x"), "2026-06-20")).status).toBe(404);
    expect((await body(await get(viewerCookie, kept.id))).invoice).toMatchObject({ status: "approved", reference: "Web order 88" });
    expect((await invoicesRoute.GET(apiRequest(`/api/invoices?organisationId=${ORG}`), noContext)).status).toBe(401);
  });

  it("the GST basis defaults to invoice basis, can be changed by admins and is checked", async () => {
    expect((await asUser(viewer, (tx) => getOrganisationSettings(tx))).gstBasis).toBe("invoice");
    const updated = await asUser(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    expect(updated.gstBasis).toBe("payments");
    expect((await asUser(viewer, (tx) => getOrganisationSettings(tx))).gstBasis).toBe("payments");
    await expect(asUser(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "cash" }))).rejects.toThrow(
      /gstBasis must be one of/,
    );

    const [ownerCookie, bookkeeperCookie] = await Promise.all([owner, bookkeeper].map((user) => sessionCookieFor(user)));
    const patch = (cookie: string, fields: Record<string, unknown>) =>
      settingsRoute.PATCH(
        apiRequest(`/api/organisations/${ORG}/settings`, { method: "PATCH", cookie, body: fields }),
        params({ organisationId: ORG }),
      );
    expect((await patch(bookkeeperCookie, { gstBasis: "hybrid" })).status).toBe(403);
    const response = await patch(ownerCookie, { gstBasis: "hybrid" });
    expect(response.status).toBe(200);
    expect((await body(response)).settings).toMatchObject({ gstBasis: "hybrid", baseCurrency: "NZD" });
    const audit = await asUser(owner, (tx) =>
      tx.query<{ details: Record<string, unknown> }>(
        "select details from audit_events where event_type = 'organisation.settings_updated' order by id desc limit 1",
      ),
    );
    expect(audit.rows[0].details).toMatchObject({ gstBasis: "hybrid" });
    await asUser(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "invoice" }));
  });

  it("migration 0003 upgrades an organisation database on 0002, keeping its data", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_invoices`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();

    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      const before = tenantMigrations.filter((migration) => migration.version < "0003");
      expect((await applyMigrations(client, before, "test:upgrade")).applied).toEqual(["0001", "0002"]);
      await client.query(
        `insert into organisation_settings (organisation_id, display_name, base_currency) values ('upgrade-co', 'Upgrade Co', 'NZD')`,
      );
      await client.query(
        `insert into accounts (code, name, account_class, account_type, system_key) values
           ('1000', 'Bank', 'asset', 'bank', 'bank'),
           ('1100', 'Accounts receivable', 'asset', 'current_asset', null),
           ('2100', 'GST', 'liability', 'current_liability', null),
           ('4000', 'Sales', 'revenue', 'revenue', null)`,
      );

      const upgraded = await applyMigrations(client, tenantMigrations, "test:upgrade");
      expect(upgraded.applied).toContain("0003");
      expect((await client.query("select display_name, gst_basis from organisation_settings")).rows).toEqual([
        { display_name: "Upgrade Co", gst_basis: "invoice" },
      ]);
      expect((await client.query("select code, system_key from accounts order by code")).rows).toEqual([
        { code: "1000", system_key: "bank" },
        { code: "1100", system_key: "accounts_receivable" },
        // Added by migration 0028 (expense claims, EC1).
        { code: "2010", system_key: "expense_claims_payable" },
        { code: "2100", system_key: "gst" },
        // Added by migration 0036 (the equity conversion account, IM1, IM21).
        { code: "3900", system_key: "conversion_clearing" },
        { code: "4000", system_key: null },
        // Added by migration 0033 (foreign-currency bank accounts, FXB5).
        { code: "7020", system_key: "realised_fx" },
        // Added by migration 0029 (fixed assets, FA1).
        { code: "7030", system_key: "fixed_asset_disposal" },
        { code: "7040", system_key: "fixed_asset_capital_gain" },
      ]);
      expect((await client.query("select last_number from sales_invoice_numbering")).rows).toEqual([{ last_number: 0 }]);
      const origin = await client.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'ledger_journals_origin_check'",
      );
      expect(origin.rows[0].definition).toContain("'invoice'");
    } finally {
      await client.end();
    }
  });
});

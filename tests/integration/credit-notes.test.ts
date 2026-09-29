import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as applicationRemoveRoute from "@/app/api/credit-notes/[creditNoteId]/applications/[applicationId]/remove/route";
import * as applicationsRoute from "@/app/api/credit-notes/[creditNoteId]/applications/route";
import * as approveRoute from "@/app/api/credit-notes/[creditNoteId]/approve/route";
import * as refundVoidRoute from "@/app/api/credit-notes/[creditNoteId]/refunds/[refundId]/void/route";
import * as refundsRoute from "@/app/api/credit-notes/[creditNoteId]/refunds/route";
import * as creditNoteRoute from "@/app/api/credit-notes/[creditNoteId]/route";
import * as creditNoteVoidRoute from "@/app/api/credit-notes/[creditNoteId]/void/route";
import * as creditNotesRoute from "@/app/api/credit-notes/route";
import * as invoiceRoute from "@/app/api/invoices/[invoiceId]/route";
import { createAccount, updateAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact } from "@/lib/contacts/service";
import {
  applyCreditNote,
  type CreditNoteApplication,
  listApplications,
  listInvoiceCredit,
  removeApplication,
} from "@/lib/credit-notes/applications";
import { listRefunds, refundCreditNote, voidRefund } from "@/lib/credit-notes/refunds";
import {
  approveCreditNote,
  createCreditNote,
  type CreditNote,
  deleteCreditNote,
  getCreditNote,
  listCreditNotes,
  updateCreditNote,
  voidCreditNote,
} from "@/lib/credit-notes/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment } from "@/lib/invoices/payments";
import {
  approveInvoice,
  createInvoice,
  getInvoice,
  type Invoice,
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
  withDb,
} from "../helpers/test-server";

const noContext = undefined as unknown;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Examples CN1-CN12 in docs/ACCOUNTING-EXAMPLES.md ("Sales credit notes").
 * Each example gets its own organisation with the setup: customer Kobe Ltd,
 * INV-0001 = I1 (total 115.00) and INV-0002 = I6 (no tax, 80.00), both
 * dated 10 May 2026. Credit notes are dated 15 May 2026 unless told otherwise.
 */
describeWithDatabase("sales credit notes", () => {
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
    const org = `credit-${organisations}-co`;
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
    const newCustomer = async (name: string): Promise<Contact> =>
      (await asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), name, isCustomer: true })))
        .contact;
    const kobe = await newCustomer("Kobe Ltd");

    /** A draft invoice for Kobe Ltd: I1 (2 x 50.00 at 15%) unless told otherwise. */
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
    const approveTheInvoice = async (invoice: Invoice): Promise<Invoice> =>
      (await asUser(bookkeeper, (tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve-invoice") }))).invoice;
    const approvedInvoice = async (fields: Record<string, unknown> = {}) => approveTheInvoice(await draftInvoice(fields));

    const i1 = await approvedInvoice();
    const i6 = await approvedInvoice({
      amountsMode: "no_tax",
      lines: [{ description: "Workshop", quantity: "1", unitPrice: "80.00", accountCode: "4000" }],
    });

    /** A draft credit note for Kobe Ltd: 1 x 20.00 at 15% exclusive to 4000 (example CN1) unless told otherwise. */
    const draft = async (fields: Record<string, unknown> = {}): Promise<CreditNote> =>
      (
        await asUser(bookkeeper, (tx) =>
          createCreditNote(tx, {
            idempotencyKey: key("credit-note"),
            contactId: kobe.id,
            creditNoteDate: "2026-05-15",
            amountsMode: "exclusive",
            lines: [{ description: "Discount", quantity: "1", unitPrice: "20.00", accountCode: "4000", taxCode: "GST" }],
            ...fields,
          }),
        )
      ).creditNote;
    const approve = (creditNoteId: string, idempotencyKey = key("approve")) =>
      asUser(bookkeeper, (tx) => approveCreditNote(tx, creditNoteId, { idempotencyKey }));
    const approved = async (fields: Record<string, unknown> = {}): Promise<CreditNote> =>
      (await approve((await draft(fields)).id)).creditNote;
    /** Applies credit on 20 May 2026 unless told otherwise. */
    const apply = (
      creditNoteId: string,
      applications: Array<{ invoiceId: string; amount: unknown }>,
      fields: Record<string, unknown> = {},
    ) =>
      asUser(bookkeeper, (tx) =>
        applyCreditNote(tx, creditNoteId, {
          idempotencyKey: key("apply"),
          applicationDate: "2026-05-20",
          applications,
          ...fields,
        }),
      );
    const remove = (creditNoteId: string, applicationId: string, removalDate: string, idempotencyKey = key("remove")) =>
      asUser(bookkeeper, (tx) => removeApplication(tx, creditNoteId, applicationId, { idempotencyKey, removalDate }));
    /** Refunds from 1000 on 28 May 2026 unless told otherwise. */
    const refund = (creditNoteId: string, fields: Record<string, unknown>) =>
      asUser(bookkeeper, (tx) =>
        refundCreditNote(tx, creditNoteId, {
          idempotencyKey: key("refund"),
          refundDate: "2026-05-28",
          bankAccountCode: "1000",
          amount: "0",
          ...fields,
        }),
      );
    const voidTheRefund = (creditNoteId: string, refundId: string, voidDate: string, idempotencyKey = key("void-refund")) =>
      asUser(bookkeeper, (tx) => voidRefund(tx, creditNoteId, refundId, { idempotencyKey, voidDate }));
    const voidTheCreditNote = (creditNoteId: string, voidDate: string, idempotencyKey = key("void")) =>
      asUser(bookkeeper, (tx) => voidCreditNote(tx, creditNoteId, { idempotencyKey, voidDate }));
    const voidTheInvoice = (invoiceId: string, voidDate: string) =>
      asUser(bookkeeper, (tx) => voidInvoice(tx, invoiceId, { idempotencyKey: key("void-invoice"), voidDate }));
    const invoiceNow = (invoiceId: string) => asUser(viewer, (tx) => getInvoice(tx, invoiceId));
    const creditNoteNow = (creditNoteId: string) => asUser(viewer, (tx) => getCreditNote(tx, creditNoteId));
    const applicationsOf = (creditNoteId: string) => asUser(viewer, (tx) => listApplications(tx, creditNoteId));
    const refundsOf = (creditNoteId: string) => asUser(viewer, (tx) => listRefunds(tx, creditNoteId));
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
    const lastNumber = async () =>
      Number(
        (
          await asUser(owner, (tx) =>
            tx.query<{ last_number: number }>("select last_number from sales_credit_note_numbering"),
          )
        ).rows[0].last_number,
      );
    const lock = (lockDate: string | null) => asUser(owner, (tx) => updatePeriodControls(tx, { lockDate }));
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));

    return {
      org,
      asUser,
      kobe,
      newCustomer,
      i1,
      i6,
      draftInvoice,
      approveTheInvoice,
      approvedInvoice,
      draft,
      approve,
      approved,
      apply,
      remove,
      refund,
      voidTheRefund,
      voidTheCreditNote,
      voidTheInvoice,
      invoiceNow,
      creditNoteNow,
      applicationsOf,
      refundsOf,
      journal,
      postedLines,
      count,
      journalCount,
      lastNumber,
      lock,
      sql,
    };
  }

  /** The setup plus example CN3: CN-0001 (23.00) applied in full to INV-0001 on 20 May 2026. */
  async function afterCn3() {
    const world = await setup();
    const creditNote = await world.approved();
    const { applications } = await world.apply(creditNote.id, [{ invoiceId: world.i1.id, amount: "23.00" }]);
    return { ...world, cn1: creditNote, application: applications[0] };
  }

  /** The setup plus examples CN3 and CN4: CN-0002 (115.00) with 80.00 applied to INV-0002 and 20.00 to INV-0001. */
  async function afterCn4() {
    const world = await afterCn3();
    const cn2 = await world.approved({
      lines: [{ description: "Returned goods", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
    });
    await world.apply(cn2.id, [
      { invoiceId: world.i6.id, amount: "80.00" },
      { invoiceId: world.i1.id, amount: "20.00" },
    ]);
    return { ...world, cn2 };
  }

  it("setup: INV-0001 is I1 (115.00) and INV-0002 is I6 (80.00) for Kobe Ltd", async () => {
    const world = await setup();
    expect(world.i1).toMatchObject({
      invoiceNumber: "INV-0001",
      contactName: "Kobe Ltd",
      total: "115.00",
      amountPaid: "0.00",
      amountCredited: "0.00",
      amountDue: "115.00",
      paidStatus: "unpaid",
    });
    expect(await world.postedLines(world.i1.approvalJournalId!)).toEqual([
      ["1100", "115.00", "0.00"],
      ["4000", "0.00", "100.00"],
      ["2100", "0.00", "15.00"],
    ]);
    expect(world.i6).toMatchObject({ invoiceNumber: "INV-0002", total: "80.00", taxTotal: "0.00", amountDue: "80.00" });
  });

  it("CN1: a draft credit note (1 x 20.00 at 15% exclusive to 4000) posts nothing, can be edited and deleted, and uses no number", async () => {
    const world = await setup();
    const journalsBefore = await world.journalCount();
    const drafted = await world.draft({ reference: "Returned item" });
    expect(drafted).toMatchObject({
      status: "draft",
      creditNoteNumber: null,
      contactId: world.kobe.id,
      contactName: "Kobe Ltd",
      creditNoteDate: "2026-05-15",
      reference: "Returned item",
      amountsMode: "exclusive",
      currencyCode: "NZD",
      subtotal: "20.00",
      taxTotal: "3.00",
      total: "23.00",
      amountApplied: "0.00",
      amountRefunded: "0.00",
      remainingCredit: null,
      creditStatus: null,
      approvalJournalId: null,
      createdByEmail: bookkeeper.email,
    });
    expect(drafted.lines).toEqual([
      expect.objectContaining({
        lineOrder: 1,
        description: "Discount",
        accountCode: "4000",
        taxCode: "GST",
        lineAmount: "20.00",
        netAmount: "20.00",
        taxAmount: "3.00",
      }),
    ]);
    expect(await world.journalCount()).toBe(journalsBefore);

    const edited = await world.asUser(bookkeeper, (tx) =>
      updateCreditNote(tx, drafted.id, {
        lines: [{ description: "Discount", quantity: "2", unitPrice: "20.00", accountCode: "4000", taxCode: "GST" }],
      }),
    );
    expect(edited).toMatchObject({ status: "draft", creditNoteNumber: null, subtotal: "40.00", taxTotal: "6.00", total: "46.00" });
    expect(edited.reference).toBe("Returned item");

    const listed = (await world.asUser(viewer, (tx) => listCreditNotes(tx, { status: "draft" }))).creditNotes;
    expect(listed.map((entry) => entry.id)).toEqual([drafted.id]);

    await world.asUser(bookkeeper, (tx) => deleteCreditNote(tx, drafted.id));
    await expect(world.creditNoteNow(drafted.id)).rejects.toThrow("Credit note not found.");
    expect(await world.count("sales_credit_note_lines")).toBe(0);
    expect(await world.journalCount()).toBe(journalsBefore);
    expect(await world.lastNumber()).toBe(0);

    const audit = await world.sql(
      "select event_type from audit_events where entity_type = 'sales_credit_note' order by id",
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "credit_note.created",
      "credit_note.updated",
      "credit_note.deleted",
    ]);
  });

  it("CN1: the customer, lines and tax codes follow the invoice rules", async () => {
    const world = await setup();
    const supplier = (
      await world.asUser(bookkeeper, (tx) =>
        createContact(tx, { idempotencyKey: key("contact"), name: "Only a supplier", isSupplier: true }),
      )
    ).contact;
    await expect(world.draft({ contactId: supplier.id })).rejects.toThrow("Only a supplier isn't marked as a customer.");
    await expect(world.draft({ lines: [] })).rejects.toThrow("A credit note needs at least one line.");
    await expect(
      world.draft({ lines: [{ description: "x", quantity: "1", unitPrice: "20.00", accountCode: "1000", taxCode: "GST" }] }),
    ).rejects.toThrow(/isn't a revenue account/);
    await expect(
      world.draft({ lines: [{ description: "x", quantity: "1", unitPrice: "20.00", accountCode: "4000" }] }),
    ).rejects.toThrow("Line 1 needs a tax code");
    await expect(
      world.draft({
        amountsMode: "no_tax",
        lines: [{ description: "x", quantity: "1", unitPrice: "20.00", accountCode: "4000", taxCode: "GST" }],
      }),
    ).rejects.toThrow(/Line 1 has a tax code, but the credit note's amounts have no tax/);
    await expect(
      world.draft({ lines: [{ description: "x", quantity: "1", unitPrice: "20.00001", accountCode: "4000", taxCode: "GST" }] }),
    ).rejects.toThrow(/at most 4 decimal places/);
    expect(await world.count("sales_credit_notes")).toBe(0);
  });

  it("CN2: approving it gives CN-0001, net 20.00, GST 3.00, total 23.00; Dr 4000 20.00 / Dr 2100 3.00 / Cr 1100 23.00; 23.00 remaining, open", async () => {
    const world = await setup();
    const drafted = await world.draft();
    const journalsBefore = await world.journalCount();
    const { created, creditNote } = await world.approve(drafted.id);
    expect(created).toBe(true);
    expect(creditNote).toMatchObject({
      id: drafted.id,
      status: "approved",
      creditNoteNumber: "CN-0001",
      subtotal: "20.00",
      taxTotal: "3.00",
      total: "23.00",
      amountApplied: "0.00",
      amountRefunded: "0.00",
      remainingCredit: "23.00",
      creditStatus: "open",
      approvedByEmail: bookkeeper.email,
    });
    expect(await world.journalCount()).toBe(journalsBefore + 1);
    expect(await world.journal(creditNote.approvalJournalId!)).toMatchObject({
      origin: "sales_credit_note",
      postingDate: "2026-05-15",
      reference: "CN-0001",
      description: "Credit note CN-0001 to Kobe Ltd",
      totalDebit: "23.00",
      correctionKind: null,
    });
    expect(await world.postedLines(creditNote.approvalJournalId!)).toEqual([
      ["4000", "20.00", "0.00"],
      ["2100", "3.00", "0.00"],
      ["1100", "0.00", "23.00"],
    ]);

    // Approved credit notes are frozen.
    await expect(
      world.asUser(bookkeeper, (tx) => updateCreditNote(tx, drafted.id, { reference: "Changed" })),
    ).rejects.toThrow("Credit note CN-0001 is approved, so it can't be edited. Void it instead.");
    await expect(world.asUser(bookkeeper, (tx) => deleteCreditNote(tx, drafted.id))).rejects.toThrow(
      "Credit note CN-0001 is approved, so it can't be deleted.",
    );
    await expect(world.approve(drafted.id)).rejects.toThrow("Credit note CN-0001 is already approved.");
    expect(await world.creditNoteNow(drafted.id)).toEqual(creditNote);

    // With no GST, there's no GST line.
    const noTax = await world.approved({
      amountsMode: "no_tax",
      lines: [{ description: "Goodwill", quantity: "1", unitPrice: "10.00", accountCode: "4000" }],
    });
    expect(noTax).toMatchObject({ creditNoteNumber: "CN-0002", taxTotal: "0.00", total: "10.00" });
    expect(await world.postedLines(noTax.approvalJournalId!)).toEqual([
      ["4000", "10.00", "0.00"],
      ["1100", "0.00", "10.00"],
    ]);
  });

  it("CN3: applying 23.00 of CN-0001 to INV-0001 posts no journal; INV-0001 credited 23.00, 92.00 due, part paid; CN-0001 0.00 remaining, used", async () => {
    const world = await setup();
    const creditNote = await world.approved();
    const journalsBefore = await world.journalCount();
    const { created, applications, creditNote: used } = await world.apply(creditNote.id, [
      { invoiceId: world.i1.id, amount: "23.00" },
    ]);
    expect(created).toBe(true);
    expect(applications).toEqual([
      expect.objectContaining({
        creditNoteId: creditNote.id,
        creditNoteNumber: "CN-0001",
        invoiceId: world.i1.id,
        invoiceNumber: "INV-0001",
        status: "active",
        applicationDate: "2026-05-20",
        amount: "23.00",
        currencyCode: "NZD",
        createdByEmail: bookkeeper.email,
        removalDate: null,
      }),
    ]);
    expect(used).toMatchObject({ amountApplied: "23.00", amountRefunded: "0.00", remainingCredit: "0.00", creditStatus: "used" });
    expect(await world.journalCount()).toBe(journalsBefore);
    expect(await world.invoiceNow(world.i1.id)).toMatchObject({
      amountPaid: "0.00",
      amountCredited: "23.00",
      amountDue: "92.00",
      paidStatus: "part_paid",
    });
    expect(await world.asUser(viewer, (tx) => listInvoiceCredit(tx, world.i1.id))).toEqual(applications);
    expect(await world.applicationsOf(creditNote.id)).toEqual(applications);

    // Still awaiting payment, with the credit taken off.
    const awaiting = (await world.asUser(viewer, (tx) => listInvoices(tx, { awaitingPayment: "true" }))).invoices;
    expect(awaiting.find((entry) => entry.id === world.i1.id)).toMatchObject({ amountCredited: "23.00", amountDue: "92.00" });

    const audit = await world.sql(
      "select entity_id, actor_email, details from audit_events where event_type = 'credit_note.applied'",
    );
    expect(audit.rows).toEqual([
      {
        entity_id: applications[0].id,
        actor_email: bookkeeper.email,
        details: expect.objectContaining({ creditNoteNumber: "CN-0001", invoiceNumber: "INV-0001", amount: "23.00" }),
      },
    ]);
  });

  it("CN4: one command applies 80.00 of CN-0002 to INV-0002 and 20.00 to INV-0001: INV-0002 paid, INV-0001 72.00 due, CN-0002 15.00 remaining, part used", async () => {
    const world = await afterCn3();
    const cn2 = await world.approved({
      lines: [{ description: "Returned goods", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
    });
    expect(cn2).toMatchObject({ creditNoteNumber: "CN-0002", total: "115.00", remainingCredit: "115.00" });
    const journalsBefore = await world.journalCount();

    const { applications, creditNote } = await world.apply(cn2.id, [
      { invoiceId: world.i6.id, amount: "80.00" },
      { invoiceId: world.i1.id, amount: "20.00" },
    ]);
    expect(applications.map((entry) => [entry.invoiceNumber, entry.amount])).toEqual(
      expect.arrayContaining([
        ["INV-0002", "80.00"],
        ["INV-0001", "20.00"],
      ]),
    );
    expect(applications).toHaveLength(2);
    expect(creditNote).toMatchObject({ amountApplied: "100.00", remainingCredit: "15.00", creditStatus: "part_used" });
    expect(await world.invoiceNow(world.i6.id)).toMatchObject({ amountCredited: "80.00", amountDue: "0.00", paidStatus: "paid" });
    expect(await world.invoiceNow(world.i1.id)).toMatchObject({ amountCredited: "43.00", amountDue: "72.00", paidStatus: "part_paid" });
    expect(await world.journalCount()).toBe(journalsBefore);

    // A paid invoice isn't awaiting payment.
    const awaiting = (await world.asUser(viewer, (tx) => listInvoices(tx, { awaitingPayment: true }))).invoices;
    expect(awaiting.map((entry) => entry.id)).toEqual([world.i1.id]);
    // Kobe Ltd's credit notes with credit left.
    const withCredit = await world.asUser(viewer, (tx) =>
      listCreditNotes(tx, { contactId: world.kobe.id, hasRemainingCredit: "true" }),
    );
    expect(withCredit.creditNotes.map((entry) => entry.creditNoteNumber)).toEqual(["CN-0002"]);
  });

  it("CN5: over-applying, other customers, unapproved invoices or credit notes, early dates and bad amounts are refused, and nothing changes", async () => {
    const world = await setup();
    const cn1 = await world.approved();
    const cn2 = await world.approved({
      lines: [{ description: "Returned goods", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
    });
    const other = await world.newCustomer("Other Ltd");
    const otherInvoice = await world.approvedInvoice({ contactId: other.id });
    const draftInvoice = await world.draftInvoice();
    const voidedInvoice = await world.approvedInvoice();
    await world.voidTheInvoice(voidedInvoice.id, "2026-05-12");
    const lateInvoice = await world.approvedInvoice({ invoiceDate: "2026-05-25", dueDate: "2026-06-25" });
    const draftCreditNote = await world.draft();
    const voidedCreditNote = await world.approved();
    await world.voidTheCreditNote(voidedCreditNote.id, "2026-05-16");
    const journalsBefore = await world.journalCount();
    const i1 = world.i1.id;
    const i6 = world.i6.id;

    // More than the remaining credit (23.00), on one invoice or across several.
    await expect(world.apply(cn1.id, [{ invoiceId: i1, amount: "23.01" }])).rejects.toThrow(
      "The credit applied (23.01) is more than Credit note CN-0001's remaining credit (23.00).",
    );
    await expect(
      world.apply(cn1.id, [
        { invoiceId: i1, amount: "20.00" },
        { invoiceId: i6, amount: "5.00" },
      ]),
    ).rejects.toThrow(/The credit applied \(25\.00\) is more than Credit note CN-0001's remaining credit/);
    // More than an invoice's amount due: one bad line fails the whole command.
    await expect(
      world.apply(cn2.id, [
        { invoiceId: i1, amount: "10.00" },
        { invoiceId: i6, amount: "80.01" },
      ]),
    ).rejects.toThrow("Application 2: 80.01 is more than the amount due on invoice INV-0002 (80.00).");
    await expect(world.apply(cn1.id, [{ invoiceId: otherInvoice.id, amount: "1.00" }])).rejects.toThrow(
      `Application 1: invoice ${otherInvoice.invoiceNumber} is for Other Ltd, not Kobe Ltd.`,
    );
    await expect(world.apply(cn1.id, [{ invoiceId: draftInvoice.id, amount: "1.00" }])).rejects.toThrow(
      /is still a draft, so credit can't be applied to it/,
    );
    await expect(world.apply(cn1.id, [{ invoiceId: voidedInvoice.id, amount: "1.00" }])).rejects.toThrow(
      /has been voided, so credit can't be applied to it/,
    );
    await expect(world.apply(draftCreditNote.id, [{ invoiceId: i1, amount: "1.00" }])).rejects.toThrow(
      "This credit note is still a draft, so its credit can't be applied. Approve it first.",
    );
    await expect(world.apply(voidedCreditNote.id, [{ invoiceId: i1, amount: "1.00" }])).rejects.toThrow(
      /has been voided, so its credit can't be applied/,
    );
    await expect(
      world.apply(cn1.id, [{ invoiceId: i1, amount: "1.00" }], { applicationDate: "2026-05-14" }),
    ).rejects.toThrow("The application date can't be before the credit note date (2026-05-15).");
    await expect(world.apply(cn1.id, [{ invoiceId: lateInvoice.id, amount: "1.00" }])).rejects.toThrow(
      /the application date can't be before the invoice date of invoice .* \(2026-05-25\)/,
    );
    await expect(world.apply(cn1.id, [{ invoiceId: i1, amount: "0.00" }])).rejects.toThrow("Application 1 amount");
    await expect(world.apply(cn1.id, [{ invoiceId: i1, amount: "-1.00" }])).rejects.toThrow("Application 1 amount");
    await expect(world.apply(cn1.id, [{ invoiceId: i1, amount: "1.001" }])).rejects.toThrow(
      /Application 1 amount .*2 decimal places/,
    );
    await expect(
      world.apply(cn1.id, [
        { invoiceId: i1, amount: "1.00" },
        { invoiceId: i1, amount: "1.00" },
      ]),
    ).rejects.toThrow(/Apply credit to each invoice once/);
    await expect(world.apply(cn1.id, [])).rejects.toThrow("Apply credit to at least one invoice.");
    await expect(world.apply(cn1.id, [{ invoiceId: "999999", amount: "1.00" }])).rejects.toThrow(
      "Application 1: there's no invoice #999999.",
    );

    expect(await world.count("sales_credit_note_applications")).toBe(0);
    expect(await world.journalCount()).toBe(journalsBefore);
    expect(await world.creditNoteNow(cn1.id)).toMatchObject({ remainingCredit: "23.00", creditStatus: "open" });
    expect(await world.creditNoteNow(cn2.id)).toMatchObject({ remainingCredit: "115.00", creditStatus: "open" });
    expect(await world.invoiceNow(i1)).toMatchObject({ amountCredited: "0.00", amountDue: "115.00" });
    expect(await world.invoiceNow(i6)).toMatchObject({ amountCredited: "0.00", amountDue: "80.00" });
  });

  it("CN6: after CN3, a payment of 92.00 makes INV-0001 paid; 92.01 instead pays 92.00 and overpays 0.01 (OP1)", async () => {
    const world = await afterCn3();
    const pay = (amount: string) =>
      world.asUser(bookkeeper, (tx) =>
        recordPayment(tx, world.i1.id, {
          idempotencyKey: key("pay"),
          paymentDate: "2026-05-22",
          amount,
          bankAccountCode: "1000",
        }),
      );
    const { invoice } = await pay("92.00");
    expect(invoice).toMatchObject({ amountPaid: "92.00", amountCredited: "23.00", amountDue: "0.00", paidStatus: "paid" });
    const other = await afterCn3();
    const overpaid = await other.asUser(bookkeeper, (tx) =>
      recordPayment(tx, other.i1.id, {
        idempotencyKey: key("pay"),
        paymentDate: "2026-05-22",
        amount: "92.01",
        bankAccountCode: "1000",
      }),
    );
    expect(overpaid.payment).toMatchObject({ amount: "92.01", invoiceAmount: "92.00", overpaymentAmount: "0.01" });
    expect(overpaid.invoice).toMatchObject({ amountPaid: "92.00", amountCredited: "23.00", amountDue: "0.00", paidStatus: "paid" });
    // The database refuses it too.
    await expect(
      world.sql(
        `insert into customer_payments (command_source, idempotency_key, request_hash, invoice_id, payment_date, amount,
                                        currency_code, bank_account_id, journal_id)
         select 'sql', 'sql-over', 'h', $1, '2026-05-22', 0.01, 'NZD', bank_account_id, journal_id
           from customer_payments limit 1`,
        [world.i1.id],
      ),
    ).rejects.toThrow("must be what it pays beyond the amount due (0.00)");
  });

  it("CN7: removing the CN3 application later posts nothing; INV-0001 115.00 due, CN-0001 23.00 remaining, open; a second or early removal is refused", async () => {
    const world = await afterCn3();
    const journalsBefore = await world.journalCount();
    await expect(world.remove(world.cn1.id, world.application.id, "2026-05-19")).rejects.toThrow(
      "The removal date can't be before the application date (2026-05-20).",
    );
    const { created, application, creditNote } = await world.remove(world.cn1.id, world.application.id, "2026-05-25");
    expect(created).toBe(true);
    expect(application).toMatchObject({
      id: world.application.id,
      status: "removed",
      amount: "23.00",
      removalDate: "2026-05-25",
      removedByEmail: bookkeeper.email,
    });
    expect(creditNote).toMatchObject({ amountApplied: "0.00", remainingCredit: "23.00", creditStatus: "open" });
    expect(await world.invoiceNow(world.i1.id)).toMatchObject({
      amountCredited: "0.00",
      amountDue: "115.00",
      paidStatus: "unpaid",
    });
    expect(await world.journalCount()).toBe(journalsBefore);
    await expect(world.remove(world.cn1.id, world.application.id, "2026-05-26")).rejects.toThrow(
      "This application has already been removed.",
    );
    // The row stays, with its removal details.
    expect(await world.applicationsOf(world.cn1.id)).toEqual([application]);
    await expect(world.remove(world.cn1.id, "999999", "2026-05-26")).rejects.toThrow("Application not found.");
    const audit = await world.sql(
      "select entity_id from audit_events where event_type = 'credit_note.application_removed'",
    );
    expect(audit.rows).toEqual([{ entity_id: world.application.id }]);
  });

  it("CN8: refunding CN-0002's 15.00 from 1000 posts Dr 1100 / Cr 1000; over-refunds and wrong accounts are refused; voiding it reverses it", async () => {
    const world = await afterCn4();
    const savings = await world.asUser(owner, (tx) =>
      createAccount(tx, { code: "1010", name: "Savings account", accountType: "bank" }),
    );
    await world.asUser(owner, (tx) => updateAccount(tx, savings.id, { isActive: false }));
    const journalsBefore = await world.journalCount();

    await expect(world.refund(world.cn2.id, { amount: "15.01" })).rejects.toThrow(
      "The refund of 15.01 is more than the remaining credit (15.00).",
    );
    await expect(world.refund(world.cn2.id, { amount: "15.00", bankAccountCode: "1100" })).rejects.toThrow(
      "Account 1100 (Accounts receivable) isn't a bank account, so refunds can't be paid from it.",
    );
    await expect(world.refund(world.cn2.id, { amount: "15.00", bankAccountCode: "1010" })).rejects.toThrow(
      "Account 1010 (Savings account) is archived, so refunds can't be paid from it.",
    );
    await expect(world.refund(world.cn2.id, { amount: "15.00", refundDate: "2026-05-14" })).rejects.toThrow(
      "The refund date can't be before the credit note date (2026-05-15).",
    );
    await expect(world.refund(world.cn1.id, { amount: "1.00" })).rejects.toThrow(
      "Credit note CN-0001 has no credit left to refund.",
    );
    expect(await world.journalCount()).toBe(journalsBefore);

    const { created, refund, creditNote } = await world.refund(world.cn2.id, { amount: "15.00", reference: "Kobe refund" });
    expect(created).toBe(true);
    expect(refund).toMatchObject({
      creditNoteId: world.cn2.id,
      creditNoteNumber: "CN-0002",
      status: "active",
      refundDate: "2026-05-28",
      amount: "15.00",
      bankAccountCode: "1000",
      reference: "Kobe refund",
      createdByEmail: bookkeeper.email,
    });
    expect(creditNote).toMatchObject({ amountRefunded: "15.00", remainingCredit: "0.00", creditStatus: "used" });
    expect(await world.journal(refund.journalId)).toMatchObject({
      origin: "sales_credit_note_refund",
      postingDate: "2026-05-28",
      reference: "Kobe refund",
      description: "Refund to Kobe Ltd for CN-0002",
    });
    expect(await world.postedLines(refund.journalId)).toEqual([
      ["1100", "15.00", "0.00"],
      ["1000", "0.00", "15.00"],
    ]);
    await expect(world.refund(world.cn2.id, { amount: "0.01" })).rejects.toThrow(/has no credit left to refund/);

    await expect(world.voidTheRefund(world.cn2.id, refund.id, "2026-05-27")).rejects.toThrow(
      "The void date can't be before the refund date (2026-05-28).",
    );
    const voided = await world.voidTheRefund(world.cn2.id, refund.id, "2026-06-02");
    expect(voided.refund).toMatchObject({ status: "voided", voidDate: "2026-06-02", voidedByEmail: bookkeeper.email });
    expect(voided.creditNote).toMatchObject({ amountRefunded: "0.00", remainingCredit: "15.00", creditStatus: "part_used" });
    expect(await world.journal(voided.refund.voidJournalId!)).toMatchObject({
      origin: "sales_credit_note_refund",
      postingDate: "2026-06-02",
      correctionKind: "reversal",
      relatedJournalId: refund.journalId,
      reference: "VOID-Kobe refund",
    });
    expect(await world.postedLines(voided.refund.voidJournalId!)).toEqual([
      ["1100", "0.00", "15.00"],
      ["1000", "15.00", "0.00"],
    ]);
    await expect(world.voidTheRefund(world.cn2.id, refund.id, "2026-06-03")).rejects.toThrow(
      "This refund has already been voided.",
    );
    await expect(world.voidTheRefund(world.cn1.id, refund.id, "2026-06-03")).rejects.toThrow("Refund not found.");
    expect(await world.refundsOf(world.cn2.id)).toEqual([voided.refund]);
    expect(await world.journalCount()).toBe(journalsBefore + 2);
  });

  it("CN9: voiding CN-0001 or INV-0001 while credit is applied is refused; after removing it, voiding CN-0001 posts Dr 1100 23.00 / Cr 4000 20.00 / Cr 2100 3.00", async () => {
    const world = await afterCn3();
    const journalsBefore = await world.journalCount();
    await expect(world.voidTheCreditNote(world.cn1.id, "2026-05-30")).rejects.toThrow(
      "Credit note CN-0001 has credit applied or refunded, so it can't be voided. Remove its applications and refunds first.",
    );
    await expect(world.voidTheInvoice(world.i1.id, "2026-05-30")).rejects.toThrow(
      "Invoice INV-0001 has credit applied to it, so it can't be voided. Remove its credit first.",
    );
    expect(await world.journalCount()).toBe(journalsBefore);

    await world.remove(world.cn1.id, world.application.id, "2026-05-25");
    await expect(world.voidTheCreditNote(world.cn1.id, "2026-05-14")).rejects.toThrow(
      "The void date can't be before the credit note date (2026-05-15).",
    );
    const { created, creditNote } = await world.voidTheCreditNote(world.cn1.id, "2026-05-30");
    expect(created).toBe(true);
    expect(creditNote).toMatchObject({
      status: "voided",
      voidDate: "2026-05-30",
      voidedByEmail: bookkeeper.email,
      remainingCredit: null,
      creditStatus: null,
    });
    expect(await world.journal(creditNote.voidJournalId!)).toMatchObject({
      origin: "sales_credit_note",
      postingDate: "2026-05-30",
      reference: "VOID-CN-0001",
      correctionKind: "reversal",
      relatedJournalId: creditNote.approvalJournalId,
    });
    expect(await world.postedLines(creditNote.voidJournalId!)).toEqual([
      ["4000", "0.00", "20.00"],
      ["2100", "0.00", "3.00"],
      ["1100", "23.00", "0.00"],
    ]);
    await expect(world.voidTheCreditNote(world.cn1.id, "2026-05-31")).rejects.toThrow(
      "Credit note CN-0001 has already been voided.",
    );
    await expect(world.voidTheCreditNote((await world.draft()).id, "2026-05-31")).rejects.toThrow(
      "This credit note is still a draft, so there's nothing to void. Delete it instead.",
    );
    // With its credit removed, INV-0001 can be voided too.
    expect((await world.voidTheInvoice(world.i1.id, "2026-05-30")).invoice.status).toBe("voided");

    // An active refund blocks a void as well.
    const refunded = await world.approved();
    const { refund } = await world.refund(refunded.id, { amount: "5.00" });
    await expect(world.voidTheCreditNote(refunded.id, "2026-05-30")).rejects.toThrow(
      /Remove its applications and refunds first/,
    );
    await world.voidTheRefund(refunded.id, refund.id, "2026-05-29");
    expect((await world.voidTheCreditNote(refunded.id, "2026-05-30")).creditNote.status).toBe("voided");
  });

  it("CN10: inclusive 1 x 15.00 at 15% gives GST 1.96, net 13.04, total 15.00", async () => {
    const world = await setup();
    const creditNote = await world.approved({
      amountsMode: "inclusive",
      lines: [{ description: "Refund of fee", quantity: "1", unitPrice: "15.00", accountCode: "4000", taxCode: "GST" }],
    });
    expect(creditNote).toMatchObject({ subtotal: "13.04", taxTotal: "1.96", total: "15.00", remainingCredit: "15.00" });
    expect(creditNote.lines[0]).toMatchObject({ lineAmount: "15.00", netAmount: "13.04", taxAmount: "1.96" });
    expect(await world.postedLines(creditNote.approvalJournalId!)).toEqual([
      ["4000", "13.04", "0.00"],
      ["2100", "1.96", "0.00"],
      ["1100", "0.00", "15.00"],
    ]);
  });

  it("CN11: approving, applying, removing, refunding or voiding in a locked period is refused and nothing is posted or numbered", async () => {
    const world = await setup();
    const early = await world.draft({ creditNoteDate: "2026-05-15" });
    await world.lock("2026-05-31");
    try {
      const journalsBefore = await world.journalCount();
      await expect(world.approve(early.id)).rejects.toThrow(/2026-05-15 is in a locked period/);
      expect(await world.creditNoteNow(early.id)).toMatchObject({ status: "draft", creditNoteNumber: null });
      expect(await world.lastNumber()).toBe(0);
      expect(await world.journalCount()).toBe(journalsBefore);
    } finally {
      await world.lock(null);
    }

    const creditNote = (await world.approve(early.id)).creditNote;
    const { applications } = await world.apply(creditNote.id, [{ invoiceId: world.i1.id, amount: "10.00" }]);
    const { refund } = await world.refund(creditNote.id, { amount: "5.00", refundDate: "2026-05-20" });
    await world.lock("2026-05-31");
    try {
      const journalsBefore = await world.journalCount();
      await expect(world.apply(creditNote.id, [{ invoiceId: world.i6.id, amount: "1.00" }], { applicationDate: "2026-05-31" })).rejects.toThrow(
        /2026-05-31 is in a locked period/,
      );
      await expect(world.remove(creditNote.id, applications[0].id, "2026-05-25")).rejects.toThrow(
        /2026-05-25 is in a locked period/,
      );
      await expect(world.refund(creditNote.id, { amount: "1.00", refundDate: "2026-05-30" })).rejects.toThrow(
        /2026-05-30 is in a locked period/,
      );
      await expect(world.voidTheRefund(creditNote.id, refund.id, "2026-05-30")).rejects.toThrow(
        /2026-05-30 is in a locked period/,
      );
      expect(await world.count("sales_credit_note_applications")).toBe(1);
      expect(await world.refundsOf(creditNote.id)).toEqual([refund]);
      expect(await world.applicationsOf(creditNote.id)).toEqual(applications);
      expect(await world.journalCount()).toBe(journalsBefore);

      // After the lock date, everything works again.
      await world.remove(creditNote.id, applications[0].id, "2026-06-01");
      await world.voidTheRefund(creditNote.id, refund.id, "2026-06-01");
      await expect(world.voidTheCreditNote(creditNote.id, "2026-05-31")).rejects.toThrow(
        /2026-05-31 is in a locked period/,
      );
      expect((await world.creditNoteNow(creditNote.id)).status).toBe("approved");
      expect((await world.voidTheCreditNote(creditNote.id, "2026-06-01")).creditNote.status).toBe("voided");
    } finally {
      await world.lock(null);
    }
  });

  it("CN11: approving gives CN-0001 then CN-0002 with no gap, even with a refused approval between; drafts take no number; INV- numbering is unaffected", async () => {
    const world = await setup();
    const first = await world.approved();
    expect(first.creditNoteNumber).toBe("CN-0001");
    const locked = await world.draft({ creditNoteDate: "2026-05-15" });
    await world.lock("2026-05-20");
    try {
      await expect(world.approve(locked.id)).rejects.toThrow(/locked period/);
    } finally {
      await world.lock(null);
    }
    await world.draft();
    const second = await world.approved({ creditNoteDate: "2026-05-21" });
    expect(second.creditNoteNumber).toBe("CN-0002");
    expect((await world.approve(locked.id)).creditNote.creditNoteNumber).toBe("CN-0003");
    expect(await world.lastNumber()).toBe(3);
    // Invoices keep their own numbers.
    expect((await world.approvedInvoice()).invoiceNumber).toBe("INV-0003");
    const numbers = (await world.asUser(viewer, (tx) => listCreditNotes(tx))).creditNotes.map(
      (entry) => entry.creditNoteNumber,
    );
    expect(numbers).toEqual(expect.arrayContaining(["CN-0001", "CN-0002", "CN-0003", null]));
  });

  it("CN12: retrying approve, apply, remove, refund or void with the same key and content returns the same result; the same key with different content is refused", async () => {
    const world = await setup();
    const drafted = await world.draft();
    const approveKey = key("approve");
    const approvedFirst = await world.approve(drafted.id, approveKey);
    const approvedAgain = await world.approve(drafted.id, approveKey);
    expect(approvedAgain).toEqual({ created: false, creditNote: approvedFirst.creditNote });
    await expect(world.approve((await world.draft()).id, approveKey)).rejects.toThrow(
      "That idempotency key was already used for a different credit note approval.",
    );
    expect(await world.lastNumber()).toBe(1);

    const applyKey = key("apply");
    const lines = [
      { invoiceId: world.i1.id, amount: "10.00" },
      { invoiceId: world.i6.id, amount: "5" },
    ];
    const applied = await world.apply(drafted.id, lines, { idempotencyKey: applyKey });
    const reapplied = await world.apply(drafted.id, [lines[0], { ...lines[1], amount: "5.00" }], { idempotencyKey: applyKey });
    expect(reapplied.created).toBe(false);
    expect(reapplied.applications).toEqual(applied.applications);
    expect(reapplied.creditNote).toMatchObject({ remainingCredit: "8.00" });
    await expect(
      world.apply(drafted.id, [{ invoiceId: world.i1.id, amount: "11.00" }], { idempotencyKey: applyKey }),
    ).rejects.toThrow("That idempotency key was already used for a different credit note application.");
    expect(await world.count("sales_credit_note_applications")).toBe(2);

    const removeKey = key("remove");
    const removed = await world.remove(drafted.id, applied.applications[0].id, "2026-05-21", removeKey);
    expect(await world.remove(drafted.id, applied.applications[0].id, "2026-05-21", removeKey)).toEqual({
      ...removed,
      created: false,
    });
    await expect(world.remove(drafted.id, applied.applications[0].id, "2026-05-22", removeKey)).rejects.toThrow(
      "That idempotency key was already used for a different application removal.",
    );

    const refundKey = key("refund");
    const refunded = await world.refund(drafted.id, { idempotencyKey: refundKey, amount: "3.00" });
    const journalsAfterRefund = await world.journalCount();
    const rerefunded = await world.refund(drafted.id, { idempotencyKey: refundKey, amount: "3" });
    expect(rerefunded.created).toBe(false);
    expect(rerefunded.refund).toEqual(refunded.refund);
    await expect(world.refund(drafted.id, { idempotencyKey: refundKey, amount: "4.00" })).rejects.toThrow(
      "That idempotency key was already used for a different refund.",
    );
    expect(await world.journalCount()).toBe(journalsAfterRefund);

    const voidRefundKey = key("void-refund");
    const refundVoided = await world.voidTheRefund(drafted.id, refunded.refund.id, "2026-06-01", voidRefundKey);
    expect((await world.voidTheRefund(drafted.id, refunded.refund.id, "2026-06-01", voidRefundKey)).refund).toEqual(
      refundVoided.refund,
    );
    await expect(world.voidTheRefund(drafted.id, refunded.refund.id, "2026-06-02", voidRefundKey)).rejects.toThrow(
      "That idempotency key was already used for a different refund void.",
    );

    await world.remove(drafted.id, applied.applications[1].id, "2026-05-21");
    const voidKey = key("void");
    const voided = await world.voidTheCreditNote(drafted.id, "2026-06-01", voidKey);
    const journalsAfterVoid = await world.journalCount();
    expect(await world.voidTheCreditNote(drafted.id, "2026-06-01", voidKey)).toEqual({
      created: false,
      creditNote: voided.creditNote,
    });
    await expect(world.voidTheCreditNote(drafted.id, "2026-06-02", voidKey)).rejects.toThrow(
      "That idempotency key was already used for a different credit note void.",
    );
    expect(await world.journalCount()).toBe(journalsAfterVoid);
  });

  it("CN3, CN8: two commands at once can't both use the same remaining credit", async () => {
    const world = await setup();
    const creditNote = await world.approved();
    const results = await Promise.allSettled([
      world.apply(creditNote.id, [{ invoiceId: world.i1.id, amount: "20.00" }]),
      world.apply(creditNote.id, [{ invoiceId: world.i6.id, amount: "20.00" }]),
      world.refund(creditNote.id, { amount: "20.00" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      expect(String((result as PromiseRejectedResult).reason)).toMatch(/more than .*remaining credit \(3\.00\)/);
    }
    expect(await world.creditNoteNow(creditNote.id)).toMatchObject({ remainingCredit: "3.00", creditStatus: "part_used" });
  });

  it("credit note and refund journals are listed as their own kinds and can't be corrected in the ledger", async () => {
    const world = await setup();
    const creditNote = await world.approved();
    const { refund } = await world.refund(creditNote.id, { amount: "3.00" });
    const kinds = await world.asUser(viewer, async (tx) => ({
      creditNotes: (await listJournals(tx, { kind: "sales_credit_note" })).journals.map((entry) => entry.id),
      refunds: (await listJournals(tx, { kind: "sales_credit_note_refund" })).journals.map((entry) => entry.id),
    }));
    expect(kinds).toEqual({ creditNotes: [creditNote.approvalJournalId], refunds: [refund.journalId] });

    for (const [journalId, message] of [
      [creditNote.approvalJournalId!, /was posted by a sales credit note \(CN-0001\), so it can't be corrected in the ledger/],
      [refund.journalId, /was posted by a credit note refund \(CN-0001\), so it can't be corrected in the ledger/],
    ] as const) {
      expect((await world.asUser(viewer, (tx) => getJournalDetails(tx, journalId))).canCorrect).toBe(false);
      await expect(
        world.asUser(bookkeeper, (tx) =>
          correctJournal(tx, {
            idempotencyKey: key("fix"),
            originalJournalId: journalId,
            postingDate: "2026-06-01",
            reference: "FIX",
            lines: [
              { accountCode: "1000", debitAmount: "3" },
              { accountCode: "1100", creditAmount: "3" },
            ],
          }),
        ),
      ).rejects.toThrow(message);
    }
  });

  it("the database refuses changes to approved credit notes, over-applying, applications across customers, and edits to applications and refunds", async () => {
    const world = await setup();
    const creditNote = await world.approved();
    const drafted = await world.draft();
    const other = await world.newCustomer("Other Ltd");
    const otherInvoice = await world.approvedInvoice({ contactId: other.id });
    const draftInvoice = await world.draftInvoice();
    const { applications } = await world.apply(creditNote.id, [{ invoiceId: world.i1.id, amount: "10.00" }]);
    const { refund } = await world.refund(creditNote.id, { amount: "3.00" });
    const sql = world.sql;
    const insertApplication = (
      creditNoteId: string,
      invoiceId: string,
      amount: string,
      applicationDate = "2026-05-20",
      status = "active",
    ) =>
      sql(
        `insert into sales_credit_note_applications (command_source, idempotency_key, request_hash, status, credit_note_id,
                                                     invoice_id, application_date, amount, currency_code)
         values ('sql', $1, 'h', $2, $3, $4, $5, $6::numeric, 'NZD')`,
        [key("sql"), status, creditNoteId, invoiceId, applicationDate, amount],
      );

    await expect(insertApplication(creditNote.id, world.i1.id, "10.01")).rejects.toThrow(
      "Credit applied and refunded from credit note CN-0001 can't add up to more than its total",
    );
    await expect(insertApplication(drafted.id, world.i1.id, "1.00")).rejects.toThrow(
      "Only approved credit notes can be applied",
    );
    await expect(insertApplication(creditNote.id, draftInvoice.id, "1.00")).rejects.toThrow(
      "Credit can only be applied to approved invoices",
    );
    await expect(insertApplication(creditNote.id, otherInvoice.id, "1.00")).rejects.toThrow(
      "Credit can only be applied to invoices of the same customer",
    );
    await expect(insertApplication(creditNote.id, world.i1.id, "1.00", "2026-05-14")).rejects.toThrow(
      "An application can't be dated before its credit note or invoice",
    );
    await expect(insertApplication(creditNote.id, world.i1.id, "1.00", "2026-05-20", "removed")).rejects.toThrow(
      "An application is recorded as active and removed afterwards",
    );
    // Payments and credit together can't pass an invoice's total.
    const bigger = await world.approved({
      lines: [{ description: "Big", quantity: "1", unitPrice: "200.00", accountCode: "4000", taxCode: "GST" }],
    });
    await expect(insertApplication(bigger.id, world.i1.id, "105.01")).rejects.toThrow(
      "Payments and credit applied to invoice INV-0001 can't add up to more than its total",
    );

    await expect(
      sql("update sales_credit_note_applications set amount = 1 where id = $1", [applications[0].id]),
    ).rejects.toThrow("Credit note applications can't be changed, only removed once");
    await expect(sql("delete from sales_credit_note_applications where id = $1", [applications[0].id])).rejects.toThrow(
      "Credit note applications can't be deleted; remove them instead",
    );
    await expect(sql("truncate sales_credit_note_applications")).rejects.toThrow(
      "sales_credit_note_applications can't be truncated",
    );
    await expect(sql("update sales_credit_note_refunds set amount = 1 where id = $1", [refund.id])).rejects.toThrow(
      "Credit note refunds can't be changed, only voided once",
    );
    await expect(sql("delete from sales_credit_note_refunds where id = $1", [refund.id])).rejects.toThrow(
      "Credit note refunds can't be deleted; void them instead",
    );
    await expect(sql("truncate sales_credit_note_refunds")).rejects.toThrow("sales_credit_note_refunds can't be truncated");
    await expect(
      sql(
        `insert into sales_credit_note_refunds (command_source, idempotency_key, request_hash, credit_note_id, refund_date,
                                                amount, currency_code, bank_account_id, journal_id)
         values ('sql', 'sql-refund', 'h', $1, '2026-05-20', 10.01, 'NZD', $2, $3)`,
        [creditNote.id, refund.bankAccountId, refund.journalId],
      ),
    ).rejects.toThrow("Credit applied and refunded from credit note CN-0001 can't add up to more than its total");

    // Approved credit notes and their lines are frozen, and can't be voided while credit is used.
    await expect(sql("update sales_credit_notes set reference = 'x' where id = $1", [creditNote.id])).rejects.toThrow(
      "Credit note CN-0001 is approved, so it can't be changed",
    );
    await expect(sql("delete from sales_credit_notes where id = $1", [creditNote.id])).rejects.toThrow(
      "Credit note CN-0001 is approved, so it can't be deleted",
    );
    await expect(
      sql("update sales_credit_note_lines set description = 'x' where credit_note_id = $1", [creditNote.id]),
    ).rejects.toThrow("Lines of an approved or voided credit note can't be changed");
    await expect(sql("truncate sales_credit_notes cascade")).rejects.toThrow(/can't be truncated/);
    await expect(
      sql(
        `update sales_credit_notes
            set status = 'voided', void_date = '2026-06-01', void_journal_id = $2, void_command_source = 'sql',
                void_idempotency_key = 'sql-void', void_request_hash = 'h', voided_at = now()
          where id = $1`,
        [creditNote.id, refund.journalId],
      ),
    ).rejects.toThrow("Credit note CN-0001 has credit applied or refunded, so it can't be voided");
    await expect(
      sql(
        `update sales_invoices
            set status = 'voided', void_date = '2026-06-01', void_journal_id = $2, void_command_source = 'sql',
                void_idempotency_key = 'sql-void', void_request_hash = 'h', voided_at = now()
          where id = $1`,
        [world.i1.id, refund.journalId],
      ),
    ).rejects.toThrow("Invoice INV-0001 has credit applied to it, so it can't be voided. Remove its credit first");
    await expect(
      sql("update sales_credit_note_numbering set last_number = last_number + 2"),
    ).rejects.toThrow("Credit note numbers only move forward one at a time");

    // Once removed, an application can't change again.
    const { application } = await world.remove(creditNote.id, applications[0].id, "2026-05-21");
    await expect(
      sql("update sales_credit_note_applications set status = 'active' where id = $1", [application.id]),
    ).rejects.toThrow("Credit note applications can't be changed, only removed once");
  });

  it("migration 0007 upgrades an organisation database on 0006, keeping its data", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_credit_notes`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();

    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      const before = tenantMigrations.filter((migration) => migration.version < "0007");
      expect((await applyMigrations(client, before, "test:upgrade")).applied).toEqual([
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
      ]);
      await client.query(
        `insert into organisation_settings (organisation_id, display_name, base_currency) values ('upgrade-co', 'Upgrade Co', 'NZD')`,
      );
      const upgraded = await applyMigrations(client, tenantMigrations, "test:upgrade");
      expect(upgraded.applied).toContain("0007");
      expect((await client.query("select display_name from organisation_settings")).rows).toEqual([
        { display_name: "Upgrade Co" },
      ]);
      expect((await client.query("select last_number from sales_credit_note_numbering")).rows).toEqual([
        { last_number: 0 },
      ]);
      for (const table of ["sales_credit_notes", "sales_credit_note_applications", "sales_credit_note_refunds"]) {
        expect((await client.query(`select count(*)::int as count from ${table}`)).rows).toEqual([{ count: 0 }]);
      }
      const origin = await client.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'ledger_journals_origin_check'",
      );
      expect(origin.rows[0].definition).toContain("'sales_credit_note'");
      expect(origin.rows[0].definition).toContain("'sales_credit_note_refund'");
      expect(origin.rows[0].definition).toContain("'supplier_payment'");
    } finally {
      await client.end();
    }
  });

  it("CN12: over HTTP viewers read, bookkeepers do everything else; retries are 200 and a reused key is 409; outsiders get 404", async () => {
    const world = await setup();
    const org = world.org;
    const [bookkeeperCookie, viewerCookie, outsiderCookie] = await Promise.all(
      [bookkeeper, viewer, outsider].map((user) => sessionCookieFor(user)),
    );
    const post = (cookie: string, path: string, fields: Record<string, unknown>) =>
      apiRequest(path, { method: "POST", cookie, body: { organisationId: org, ...fields } });
    const draftBody = {
      source: "ui",
      idempotencyKey: key("http-draft"),
      contactId: world.kobe.id,
      creditNoteDate: "2026-05-15",
      amountsMode: "exclusive",
      lines: [{ description: "Discount", quantity: "1", unitPrice: "20.00", accountCode: "4000", taxCode: "GST" }],
    };

    expect((await creditNotesRoute.POST(post(viewerCookie, "/api/credit-notes", draftBody), noContext)).status).toBe(403);
    expect((await creditNotesRoute.POST(post(outsiderCookie, "/api/credit-notes", draftBody), noContext)).status).toBe(404);
    const created = await creditNotesRoute.POST(post(bookkeeperCookie, "/api/credit-notes", draftBody), noContext);
    expect(created.status).toBe(201);
    const creditNoteId = ((await body(created)).creditNote as CreditNote).id;
    expect((await creditNotesRoute.POST(post(bookkeeperCookie, "/api/credit-notes", draftBody), noContext)).status).toBe(200);
    const context = params({ creditNoteId });

    const patched = await creditNoteRoute.PATCH(
      apiRequest(`/api/credit-notes/${creditNoteId}`, {
        method: "PATCH",
        cookie: bookkeeperCookie,
        body: { organisationId: org, reference: "Web" },
      }),
      context,
    );
    expect(patched.status).toBe(200);
    expect((await body(patched)).creditNote).toMatchObject({ reference: "Web", total: "23.00" });
    const read = await creditNoteRoute.GET(
      apiRequest(`/api/credit-notes/${creditNoteId}?organisationId=${org}`, { cookie: viewerCookie }),
      context,
    );
    expect(read.status).toBe(200);
    expect((await body(read)).creditNote).toMatchObject({ id: creditNoteId, status: "draft" });

    const approveKey = key("http-approve");
    const approveOver = (cookie: string) =>
      approveRoute.POST(post(cookie, `/api/credit-notes/${creditNoteId}/approve`, { idempotencyKey: approveKey }), context);
    expect((await approveOver(viewerCookie)).status).toBe(403);
    expect((await approveOver(bookkeeperCookie)).status).toBe(201);
    expect((await approveOver(bookkeeperCookie)).status).toBe(200);

    const applyBody = {
      idempotencyKey: key("http-apply"),
      applicationDate: "2026-05-20",
      applications: [{ invoiceId: world.i1.id, amount: "23.00" }],
    };
    const applyOver = (cookie: string, fields = applyBody) =>
      applicationsRoute.POST(post(cookie, `/api/credit-notes/${creditNoteId}/applications`, fields), context);
    expect((await applyOver(viewerCookie)).status).toBe(403);
    const applied = await applyOver(bookkeeperCookie);
    expect(applied.status).toBe(201);
    const application = ((await body(applied)).applications as CreditNoteApplication[])[0];
    expect((await applyOver(bookkeeperCookie)).status).toBe(200);
    expect(
      (await applyOver(bookkeeperCookie, { ...applyBody, applications: [{ invoiceId: world.i1.id, amount: "22.00" }] }))
        .status,
    ).toBe(409);
    const tooMuch = await applyOver(bookkeeperCookie, { ...applyBody, idempotencyKey: key("http-apply") });
    expect(tooMuch.status).toBe(400);
    expect((await body(tooMuch)).error).toMatch(/remaining credit \(0\.00\)/);
    const listedApplications = await applicationsRoute.GET(
      apiRequest(`/api/credit-notes/${creditNoteId}/applications?organisationId=${org}`, { cookie: viewerCookie }),
      context,
    );
    expect(await body(listedApplications)).toEqual({ applications: [application] });

    // The invoice shows the credit applied to it.
    const invoiceOver = await invoiceRoute.GET(
      apiRequest(`/api/invoices/${world.i1.id}?organisationId=${org}`, { cookie: viewerCookie }),
      params({ invoiceId: world.i1.id }),
    );
    expect(invoiceOver.status).toBe(200);
    expect(await body(invoiceOver)).toMatchObject({
      invoice: { id: world.i1.id, amountCredited: "23.00", amountDue: "92.00" },
      creditApplied: [{ creditNoteNumber: "CN-0001", amount: "23.00", applicationDate: "2026-05-20", status: "active" }],
    });

    const removeOver = (cookie: string, idempotencyKey: string) =>
      applicationRemoveRoute.POST(
        post(cookie, `/api/credit-notes/${creditNoteId}/applications/${application.id}/remove`, {
          idempotencyKey,
          removalDate: "2026-05-22",
        }),
        params({ creditNoteId, applicationId: application.id }),
      );
    const removeKey = key("http-remove");
    expect((await removeOver(viewerCookie, removeKey)).status).toBe(403);
    expect((await removeOver(bookkeeperCookie, removeKey)).status).toBe(201);
    expect((await removeOver(bookkeeperCookie, removeKey)).status).toBe(200);
    expect((await removeOver(bookkeeperCookie, key("http-remove"))).status).toBe(409);

    const refundBody = { idempotencyKey: key("http-refund"), refundDate: "2026-05-28", amount: "23.00", bankAccountCode: "1000" };
    const refundOver = (cookie: string, fields = refundBody) =>
      refundsRoute.POST(post(cookie, `/api/credit-notes/${creditNoteId}/refunds`, fields), context);
    expect((await refundOver(viewerCookie)).status).toBe(403);
    const refunded = await refundOver(bookkeeperCookie);
    expect(refunded.status).toBe(201);
    const refundId = ((await body(refunded)).refund as { id: string }).id;
    expect((await refundOver(bookkeeperCookie)).status).toBe(200);
    expect((await refundOver(bookkeeperCookie, { ...refundBody, amount: "22.00" })).status).toBe(409);
    const listedRefunds = await refundsRoute.GET(
      apiRequest(`/api/credit-notes/${creditNoteId}/refunds?organisationId=${org}`, { cookie: viewerCookie }),
      context,
    );
    expect(((await body(listedRefunds)).refunds as unknown[]).length).toBe(1);

    const voidRefundOver = (cookie: string, idempotencyKey: string) =>
      refundVoidRoute.POST(
        post(cookie, `/api/credit-notes/${creditNoteId}/refunds/${refundId}/void`, { idempotencyKey, voidDate: "2026-05-29" }),
        params({ creditNoteId, refundId }),
      );
    const voidRefundKey = key("http-void-refund");
    expect((await voidRefundOver(viewerCookie, voidRefundKey)).status).toBe(403);
    expect((await voidRefundOver(bookkeeperCookie, voidRefundKey)).status).toBe(201);
    expect((await voidRefundOver(bookkeeperCookie, voidRefundKey)).status).toBe(200);

    const voidKey = key("http-void");
    const voidOver = (cookie: string, voidDate = "2026-05-30") =>
      creditNoteVoidRoute.POST(post(cookie, `/api/credit-notes/${creditNoteId}/void`, { idempotencyKey: voidKey, voidDate }), context);
    expect((await voidOver(viewerCookie)).status).toBe(403);
    expect((await voidOver(bookkeeperCookie)).status).toBe(201);
    expect((await voidOver(bookkeeperCookie)).status).toBe(200);
    expect((await voidOver(bookkeeperCookie, "2026-05-31")).status).toBe(409);

    const list = await creditNotesRoute.GET(
      apiRequest(`/api/credit-notes?organisationId=${org}&status=voided&contactId=${world.kobe.id}`, { cookie: viewerCookie }),
      noContext,
    );
    expect(list.status).toBe(200);
    expect(((await body(list)).creditNotes as CreditNote[]).map((entry) => entry.id)).toEqual([creditNoteId]);
    expect(
      (await creditNotesRoute.GET(apiRequest(`/api/credit-notes?organisationId=${org}`, { cookie: outsiderCookie }), noContext))
        .status,
    ).toBe(404);
    expect((await creditNotesRoute.GET(apiRequest(`/api/credit-notes?organisationId=${org}`), noContext)).status).toBe(401);

    // Drafts are deleted by bookkeepers only.
    const another = await world.draft();
    const deleteOver = (cookie: string) =>
      creditNoteRoute.DELETE(
        apiRequest(`/api/credit-notes/${another.id}?organisationId=${org}`, { method: "DELETE", cookie }),
        params({ creditNoteId: another.id }),
      );
    expect((await deleteOver(viewerCookie)).status).toBe(403);
    expect((await deleteOver(bookkeeperCookie)).status).toBe(200);
  });
});

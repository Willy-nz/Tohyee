import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as billRoute from "@/app/api/bills/[billId]/route";
import * as applicationRemoveRoute from "@/app/api/supplier-credit-notes/[creditNoteId]/applications/[applicationId]/remove/route";
import * as applicationsRoute from "@/app/api/supplier-credit-notes/[creditNoteId]/applications/route";
import * as approveRoute from "@/app/api/supplier-credit-notes/[creditNoteId]/approve/route";
import * as refundVoidRoute from "@/app/api/supplier-credit-notes/[creditNoteId]/refunds/[refundId]/void/route";
import * as refundsRoute from "@/app/api/supplier-credit-notes/[creditNoteId]/refunds/route";
import * as creditNoteRoute from "@/app/api/supplier-credit-notes/[creditNoteId]/route";
import * as creditNoteVoidRoute from "@/app/api/supplier-credit-notes/[creditNoteId]/void/route";
import * as creditNotesRoute from "@/app/api/supplier-credit-notes/route";
import { createAccount, updateAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, type Bill, createBill, getBill, listBills, voidBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { correctJournal, getJournal, getJournalDetails, listJournals } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import {
  applySupplierCreditNote,
  listBillCredit,
  listSupplierCreditNoteApplications,
  removeSupplierCreditNoteApplication,
  type SupplierCreditNoteApplication,
} from "@/lib/supplier-credit-notes/applications";
import {
  listSupplierCreditNoteRefunds,
  refundSupplierCreditNote,
  voidSupplierCreditNoteRefund,
} from "@/lib/supplier-credit-notes/refunds";
import {
  approveSupplierCreditNote,
  createSupplierCreditNote,
  deleteSupplierCreditNote,
  getSupplierCreditNote,
  listSupplierCreditNotes,
  type SupplierCreditNote,
  updateSupplierCreditNote,
  voidSupplierCreditNote,
} from "@/lib/supplier-credit-notes/service";
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
 * Examples SCN1-SCN12 in docs/ACCOUNTING-EXAMPLES.md ("Supplier credit
 * notes"). Each example gets its own organisation with the setup: supplier
 * Paw Supplies, bill PS-101 = B1 (total 230.00) and bill PS-102 = BX (no tax,
 * 80.00), both dated 10 May 2026. Supplier credit notes are dated 15 May 2026
 * unless told otherwise, and numbered CR-7, CR-8, ... in the order they're drafted.
 */
describeWithDatabase("supplier credit notes", () => {
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
    const org = `supplier-credit-${organisations}-co`;
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
    const newSupplier = async (name: string): Promise<Contact> =>
      (await asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), name, isSupplier: true })))
        .contact;
    const paw = await newSupplier("Paw Supplies");

    let billNumbers = 100;
    /** A draft bill from Paw Supplies: B1 (1 x 200.00 at 15% exclusive to 6010) unless told otherwise. */
    const draftBill = async (fields: Record<string, unknown> = {}): Promise<Bill> => {
      billNumbers += 1;
      return (
        await asUser(bookkeeper, (tx) =>
          createBill(tx, {
            idempotencyKey: key("bill"),
            contactId: paw.id,
            billDate: "2026-05-10",
            dueDate: "2026-06-20",
            supplierInvoiceNumber: `PS-${billNumbers}`,
            amountsMode: "exclusive",
            lines: [{ description: "Year-end accounts", quantity: "1", unitPrice: "200.00", accountCode: "6010", taxCode: "GST" }],
            ...fields,
          }),
        )
      ).bill;
    };
    const approveTheBill = async (bill: Bill): Promise<Bill> =>
      (await asUser(bookkeeper, (tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve-bill") }))).bill;
    const approvedBill = async (fields: Record<string, unknown> = {}) => approveTheBill(await draftBill(fields));

    const b1 = await approvedBill();
    const bx = await approvedBill({
      amountsMode: "no_tax",
      lines: [{ description: "Software", quantity: "1", unitPrice: "80.00", accountCode: "6040" }],
    });

    let creditNumbers = 6;
    /** A draft supplier credit note from Paw Supplies: CR-7 (1 x 40.00 at 15% exclusive to 6010, example SCN1) unless told otherwise. */
    const draft = async (fields: Record<string, unknown> = {}): Promise<SupplierCreditNote> => {
      creditNumbers += 1;
      return (
        await asUser(bookkeeper, (tx) =>
          createSupplierCreditNote(tx, {
            idempotencyKey: key("credit-note"),
            contactId: paw.id,
            creditNoteDate: "2026-05-15",
            supplierCreditNoteNumber: `CR-${creditNumbers}`,
            amountsMode: "exclusive",
            lines: [{ description: "Returned stock", quantity: "1", unitPrice: "40.00", accountCode: "6010", taxCode: "GST" }],
            ...fields,
          }),
        )
      ).creditNote;
    };
    const approve = (creditNoteId: string, idempotencyKey = key("approve")) =>
      asUser(bookkeeper, (tx) => approveSupplierCreditNote(tx, creditNoteId, { idempotencyKey }));
    const approved = async (fields: Record<string, unknown> = {}): Promise<SupplierCreditNote> =>
      (await approve((await draft(fields)).id)).creditNote;
    /** Applies credit on 20 May 2026 unless told otherwise. */
    const apply = (
      creditNoteId: string,
      applications: Array<{ billId: string; amount: unknown }>,
      fields: Record<string, unknown> = {},
    ) =>
      asUser(bookkeeper, (tx) =>
        applySupplierCreditNote(tx, creditNoteId, {
          idempotencyKey: key("apply"),
          applicationDate: "2026-05-20",
          applications,
          ...fields,
        }),
      );
    const remove = (creditNoteId: string, applicationId: string, removalDate: string, idempotencyKey = key("remove")) =>
      asUser(bookkeeper, (tx) =>
        removeSupplierCreditNoteApplication(tx, creditNoteId, applicationId, { idempotencyKey, removalDate }),
      );
    /** A refund received into 1000 on 28 May 2026 unless told otherwise. */
    const refund = (creditNoteId: string, fields: Record<string, unknown>) =>
      asUser(bookkeeper, (tx) =>
        refundSupplierCreditNote(tx, creditNoteId, {
          idempotencyKey: key("refund"),
          refundDate: "2026-05-28",
          bankAccountCode: "1000",
          amount: "0",
          ...fields,
        }),
      );
    const voidTheRefund = (creditNoteId: string, refundId: string, voidDate: string, idempotencyKey = key("void-refund")) =>
      asUser(bookkeeper, (tx) => voidSupplierCreditNoteRefund(tx, creditNoteId, refundId, { idempotencyKey, voidDate }));
    const voidTheCreditNote = (creditNoteId: string, voidDate: string, idempotencyKey = key("void")) =>
      asUser(bookkeeper, (tx) => voidSupplierCreditNote(tx, creditNoteId, { idempotencyKey, voidDate }));
    const voidTheBill = (billId: string, voidDate: string) =>
      asUser(bookkeeper, (tx) => voidBill(tx, billId, { idempotencyKey: key("void-bill"), voidDate }));
    const billNow = (billId: string) => asUser(viewer, (tx) => getBill(tx, billId));
    const creditNoteNow = (creditNoteId: string) => asUser(viewer, (tx) => getSupplierCreditNote(tx, creditNoteId));
    const applicationsOf = (creditNoteId: string) =>
      asUser(viewer, (tx) => listSupplierCreditNoteApplications(tx, creditNoteId));
    const refundsOf = (creditNoteId: string) => asUser(viewer, (tx) => listSupplierCreditNoteRefunds(tx, creditNoteId));
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
    const lock = (lockDate: string | null) => asUser(owner, (tx) => updatePeriodControls(tx, { lockDate }));
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));

    return {
      org,
      asUser,
      paw,
      newSupplier,
      b1,
      bx,
      draftBill,
      approveTheBill,
      approvedBill,
      draft,
      approve,
      approved,
      apply,
      remove,
      refund,
      voidTheRefund,
      voidTheCreditNote,
      voidTheBill,
      billNow,
      creditNoteNow,
      applicationsOf,
      refundsOf,
      journal,
      postedLines,
      count,
      journalCount,
      lock,
      sql,
    };
  }

  /** The setup plus example SCN3: CR-7 (46.00) applied in full to B1 on 20 May 2026. */
  async function afterScn3() {
    const world = await setup();
    const cr7 = await world.approved();
    const { applications } = await world.apply(cr7.id, [{ billId: world.b1.id, amount: "46.00" }]);
    return { ...world, cr7, application: applications[0] };
  }

  /** The setup plus examples SCN3 and SCN4: CR-8 (115.00) with 80.00 applied to BX and 20.00 to B1. */
  async function afterScn4() {
    const world = await afterScn3();
    const cr8 = await world.approved({
      lines: [{ description: "Damaged goods", quantity: "1", unitPrice: "100.00", accountCode: "6010", taxCode: "GST" }],
    });
    await world.apply(cr8.id, [
      { billId: world.bx.id, amount: "80.00" },
      { billId: world.b1.id, amount: "20.00" },
    ]);
    return { ...world, cr8 };
  }

  it("setup: B1 (230.00) and BX (no tax, 80.00) are approved bills from Paw Supplies", async () => {
    const world = await setup();
    expect(world.b1).toMatchObject({
      contactName: "Paw Supplies",
      total: "230.00",
      amountPaid: "0.00",
      amountCredited: "0.00",
      amountDue: "230.00",
      paidStatus: "unpaid",
    });
    expect(await world.postedLines(world.b1.approvalJournalId!)).toEqual([
      ["6010", "200.00", "0.00"],
      ["2100", "30.00", "0.00"],
      ["2000", "0.00", "230.00"],
    ]);
    expect(world.bx).toMatchObject({ total: "80.00", taxTotal: "0.00", amountDue: "80.00" });
  });

  it("SCN1: a draft supplier credit note CR-7 (1 x 40.00 at 15% exclusive to 6010) posts nothing and can be edited and deleted", async () => {
    const world = await setup();
    const journalsBefore = await world.journalCount();
    const drafted = await world.draft({ reference: "Returned leads" });
    expect(drafted).toMatchObject({
      status: "draft",
      supplierCreditNoteNumber: "CR-7",
      contactId: world.paw.id,
      contactName: "Paw Supplies",
      creditNoteDate: "2026-05-15",
      reference: "Returned leads",
      amountsMode: "exclusive",
      currencyCode: "NZD",
      subtotal: "40.00",
      taxTotal: "6.00",
      total: "46.00",
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
        description: "Returned stock",
        accountCode: "6010",
        taxCode: "GST",
        lineAmount: "40.00",
        netAmount: "40.00",
        taxAmount: "6.00",
      }),
    ]);
    expect(await world.journalCount()).toBe(journalsBefore);

    const edited = await world.asUser(bookkeeper, (tx) =>
      updateSupplierCreditNote(tx, drafted.id, {
        supplierCreditNoteNumber: "CR-7A",
        lines: [{ description: "Returned stock", quantity: "2", unitPrice: "40.00", accountCode: "6010", taxCode: "GST" }],
      }),
    );
    expect(edited).toMatchObject({
      status: "draft",
      supplierCreditNoteNumber: "CR-7A",
      subtotal: "80.00",
      taxTotal: "12.00",
      total: "92.00",
    });
    expect(edited.reference).toBe("Returned leads");

    const listed = (await world.asUser(viewer, (tx) => listSupplierCreditNotes(tx, { status: "draft" }))).creditNotes;
    expect(listed.map((entry) => entry.id)).toEqual([drafted.id]);

    await world.asUser(bookkeeper, (tx) => deleteSupplierCreditNote(tx, drafted.id));
    await expect(world.creditNoteNow(drafted.id)).rejects.toThrow("Supplier credit note not found.");
    expect(await world.count("supplier_credit_note_lines")).toBe(0);
    expect(await world.journalCount()).toBe(journalsBefore);

    const audit = await world.sql(
      "select event_type from audit_events where entity_type = 'supplier_credit_note' order by id",
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "supplier_credit_note.created",
      "supplier_credit_note.updated",
      "supplier_credit_note.deleted",
    ]);
  });

  it("SCN1: the supplier, number, lines and tax codes follow the bill rules", async () => {
    const world = await setup();
    const customer = (
      await world.asUser(bookkeeper, (tx) =>
        createContact(tx, { idempotencyKey: key("contact"), name: "Only a customer", isCustomer: true }),
      )
    ).contact;
    await expect(world.draft({ contactId: customer.id })).rejects.toThrow("Only a customer isn't marked as a supplier.");
    await expect(world.draft({ supplierCreditNoteNumber: "" })).rejects.toThrow(/supplierCreditNoteNumber/);
    await expect(world.draft({ supplierCreditNoteNumber: "   " })).rejects.toThrow(/supplierCreditNoteNumber/);
    await expect(world.draft({ lines: [] })).rejects.toThrow("A credit note needs at least one line.");
    for (const accountCode of ["1000", "2000", "2100"]) {
      await expect(
        world.draft({ lines: [{ description: "x", quantity: "1", unitPrice: "40.00", accountCode, taxCode: "GST" }] }),
      ).rejects.toThrow(/Bill lines go to/);
    }
    await expect(
      world.draft({ lines: [{ description: "x", quantity: "1", unitPrice: "40.00", accountCode: "6010" }] }),
    ).rejects.toThrow("Line 1 needs a tax code");
    await expect(
      world.draft({
        amountsMode: "no_tax",
        lines: [{ description: "x", quantity: "1", unitPrice: "40.00", accountCode: "6010", taxCode: "GST" }],
      }),
    ).rejects.toThrow(/Line 1 has a tax code, but the credit note's amounts have no tax/);
    await expect(
      world.draft({ lines: [{ description: "x", quantity: "1", unitPrice: "40.00001", accountCode: "6010", taxCode: "GST" }] }),
    ).rejects.toThrow(/at most 4 decimal places/);
    expect(await world.count("supplier_credit_notes")).toBe(0);
  });

  it("SCN2: approving CR-7 gives net 40.00, GST 6.00, total 46.00; Dr 2000 46.00 / Cr 6010 40.00 / Cr 2100 6.00; 46.00 remaining, open", async () => {
    const world = await setup();
    const drafted = await world.draft();
    const journalsBefore = await world.journalCount();
    const { created, creditNote } = await world.approve(drafted.id);
    expect(created).toBe(true);
    expect(creditNote).toMatchObject({
      id: drafted.id,
      status: "approved",
      supplierCreditNoteNumber: "CR-7",
      subtotal: "40.00",
      taxTotal: "6.00",
      total: "46.00",
      amountApplied: "0.00",
      amountRefunded: "0.00",
      remainingCredit: "46.00",
      creditStatus: "open",
      approvedByEmail: bookkeeper.email,
    });
    expect(await world.journalCount()).toBe(journalsBefore + 1);
    expect(await world.journal(creditNote.approvalJournalId!)).toMatchObject({
      origin: "supplier_credit_note",
      postingDate: "2026-05-15",
      reference: "CR-7",
      description: "Supplier credit note CR-7 from Paw Supplies",
      totalDebit: "46.00",
      correctionKind: null,
    });
    expect(await world.postedLines(creditNote.approvalJournalId!)).toEqual([
      ["2000", "46.00", "0.00"],
      ["6010", "0.00", "40.00"],
      ["2100", "0.00", "6.00"],
    ]);

    // Approved supplier credit notes are frozen.
    await expect(
      world.asUser(bookkeeper, (tx) => updateSupplierCreditNote(tx, drafted.id, { reference: "Changed" })),
    ).rejects.toThrow("Supplier credit note CR-7 from Paw Supplies is approved, so it can't be edited. Void it instead.");
    await expect(world.asUser(bookkeeper, (tx) => deleteSupplierCreditNote(tx, drafted.id))).rejects.toThrow(
      "Supplier credit note CR-7 from Paw Supplies is approved, so it can't be deleted.",
    );
    await expect(world.approve(drafted.id)).rejects.toThrow("Supplier credit note CR-7 from Paw Supplies is already approved.");
    expect(await world.creditNoteNow(drafted.id)).toEqual(creditNote);

    // With no GST, there's no GST line.
    const noTax = await world.approved({
      amountsMode: "no_tax",
      lines: [{ description: "Goodwill", quantity: "1", unitPrice: "10.00", accountCode: "6040" }],
    });
    expect(noTax).toMatchObject({ supplierCreditNoteNumber: "CR-8", taxTotal: "0.00", total: "10.00" });
    expect(await world.postedLines(noTax.approvalJournalId!)).toEqual([
      ["2000", "10.00", "0.00"],
      ["6040", "0.00", "10.00"],
    ]);
  });

  it("SCN3: applying 46.00 of CR-7 to B1 posts no journal; B1 credited 46.00, 184.00 due, part paid; CR-7 0.00 remaining, used", async () => {
    const world = await setup();
    const creditNote = await world.approved();
    const journalsBefore = await world.journalCount();
    const { created, applications, creditNote: used } = await world.apply(creditNote.id, [
      { billId: world.b1.id, amount: "46.00" },
    ]);
    expect(created).toBe(true);
    expect(applications).toEqual([
      expect.objectContaining({
        creditNoteId: creditNote.id,
        supplierCreditNoteNumber: "CR-7",
        billId: world.b1.id,
        supplierInvoiceNumber: world.b1.supplierInvoiceNumber,
        status: "active",
        applicationDate: "2026-05-20",
        amount: "46.00",
        currencyCode: "NZD",
        createdByEmail: bookkeeper.email,
        removalDate: null,
      }),
    ]);
    expect(used).toMatchObject({ amountApplied: "46.00", amountRefunded: "0.00", remainingCredit: "0.00", creditStatus: "used" });
    expect(await world.journalCount()).toBe(journalsBefore);
    expect(await world.billNow(world.b1.id)).toMatchObject({
      amountPaid: "0.00",
      amountCredited: "46.00",
      amountDue: "184.00",
      paidStatus: "part_paid",
    });
    expect(await world.asUser(viewer, (tx) => listBillCredit(tx, world.b1.id))).toEqual(applications);
    expect(await world.applicationsOf(creditNote.id)).toEqual(applications);

    // Still awaiting payment, with the credit taken off.
    const awaiting = (await world.asUser(viewer, (tx) => listBills(tx, { awaitingPayment: "true" }))).bills;
    expect(awaiting.find((entry) => entry.id === world.b1.id)).toMatchObject({ amountCredited: "46.00", amountDue: "184.00" });

    const audit = await world.sql(
      "select entity_id, actor_email, details from audit_events where event_type = 'supplier_credit_note.applied'",
    );
    expect(audit.rows).toEqual([
      {
        entity_id: applications[0].id,
        actor_email: bookkeeper.email,
        details: expect.objectContaining({
          supplierCreditNoteNumber: "CR-7",
          supplierInvoiceNumber: world.b1.supplierInvoiceNumber,
          amount: "46.00",
        }),
      },
    ]);
  });

  it("SCN4: one command applies 80.00 of CR-8 to BX and 20.00 to B1: BX paid, B1 164.00 due, CR-8 15.00 remaining, part used", async () => {
    const world = await afterScn3();
    const cr8 = await world.approved({
      lines: [{ description: "Damaged goods", quantity: "1", unitPrice: "100.00", accountCode: "6010", taxCode: "GST" }],
    });
    expect(cr8).toMatchObject({ supplierCreditNoteNumber: "CR-8", total: "115.00", remainingCredit: "115.00" });
    const journalsBefore = await world.journalCount();

    const { applications, creditNote } = await world.apply(cr8.id, [
      { billId: world.bx.id, amount: "80.00" },
      { billId: world.b1.id, amount: "20.00" },
    ]);
    expect(applications.map((entry) => [entry.billId, entry.amount])).toEqual(
      expect.arrayContaining([
        [world.bx.id, "80.00"],
        [world.b1.id, "20.00"],
      ]),
    );
    expect(applications).toHaveLength(2);
    expect(creditNote).toMatchObject({ amountApplied: "100.00", remainingCredit: "15.00", creditStatus: "part_used" });
    expect(await world.billNow(world.bx.id)).toMatchObject({ amountCredited: "80.00", amountDue: "0.00", paidStatus: "paid" });
    expect(await world.billNow(world.b1.id)).toMatchObject({ amountCredited: "66.00", amountDue: "164.00", paidStatus: "part_paid" });
    expect(await world.journalCount()).toBe(journalsBefore);

    // A paid bill isn't awaiting payment.
    const awaiting = (await world.asUser(viewer, (tx) => listBills(tx, { awaitingPayment: true }))).bills;
    expect(awaiting.map((entry) => entry.id)).toEqual([world.b1.id]);
    // Paw Supplies' credit notes with credit left.
    const withCredit = await world.asUser(viewer, (tx) =>
      listSupplierCreditNotes(tx, { contactId: world.paw.id, hasRemainingCredit: "true" }),
    );
    expect(withCredit.creditNotes.map((entry) => entry.supplierCreditNoteNumber)).toEqual(["CR-8"]);
    // Paw Supplies' bills.
    const pawBills = (await world.asUser(viewer, (tx) => listBills(tx, { contactId: world.paw.id }))).bills;
    expect(pawBills.map((entry) => entry.id).sort()).toEqual([world.b1.id, world.bx.id].sort());
  });

  it("SCN5: over-applying, other suppliers, unapproved bills or credit notes, early dates and bad amounts are refused, and nothing changes", async () => {
    const world = await setup();
    const cr7 = await world.approved();
    const cr8 = await world.approved({
      lines: [{ description: "Damaged goods", quantity: "1", unitPrice: "100.00", accountCode: "6010", taxCode: "GST" }],
    });
    const other = await world.newSupplier("Other Supplies");
    const otherBill = await world.approvedBill({ contactId: other.id });
    const draftBill = await world.draftBill();
    const voidedBill = await world.approvedBill();
    await world.voidTheBill(voidedBill.id, "2026-05-12");
    const lateBill = await world.approvedBill({ billDate: "2026-05-25", dueDate: "2026-06-25" });
    const draftCreditNote = await world.draft();
    const voidedCreditNote = await world.approved();
    await world.voidTheCreditNote(voidedCreditNote.id, "2026-05-16");
    const journalsBefore = await world.journalCount();
    const b1 = world.b1.id;
    const bx = world.bx.id;

    // More than the remaining credit (46.00), on one bill or across several.
    await expect(world.apply(cr7.id, [{ billId: b1, amount: "46.01" }])).rejects.toThrow(
      "The credit applied (46.01) is more than the remaining credit on Supplier credit note CR-7 from Paw Supplies (46.00).",
    );
    await expect(
      world.apply(cr7.id, [
        { billId: b1, amount: "40.00" },
        { billId: bx, amount: "7.00" },
      ]),
    ).rejects.toThrow(/The credit applied \(47\.00\) is more than the remaining credit/);
    // More than a bill's amount due: one bad line fails the whole command.
    await expect(
      world.apply(cr8.id, [
        { billId: b1, amount: "10.00" },
        { billId: bx, amount: "80.01" },
      ]),
    ).rejects.toThrow(`Application 2: 80.01 is more than the amount due on bill ${world.bx.supplierInvoiceNumber} (80.00).`);
    await expect(world.apply(cr7.id, [{ billId: otherBill.id, amount: "1.00" }])).rejects.toThrow(
      `Application 1: bill ${otherBill.supplierInvoiceNumber} is from Other Supplies, not Paw Supplies. Credit can only be applied to the same supplier's bills.`,
    );
    await expect(world.apply(cr7.id, [{ billId: draftBill.id, amount: "1.00" }])).rejects.toThrow(
      /is still a draft, so credit can't be applied to it/,
    );
    await expect(world.apply(cr7.id, [{ billId: voidedBill.id, amount: "1.00" }])).rejects.toThrow(
      /has been voided, so credit can't be applied to it/,
    );
    await expect(world.apply(draftCreditNote.id, [{ billId: b1, amount: "1.00" }])).rejects.toThrow(
      "This supplier credit note is still a draft, so its credit can't be applied. Approve it first.",
    );
    await expect(world.apply(voidedCreditNote.id, [{ billId: b1, amount: "1.00" }])).rejects.toThrow(
      /has been voided, so its credit can't be applied/,
    );
    await expect(
      world.apply(cr7.id, [{ billId: b1, amount: "1.00" }], { applicationDate: "2026-05-14" }),
    ).rejects.toThrow("The application date can't be before the credit note date (2026-05-15).");
    await expect(world.apply(cr7.id, [{ billId: lateBill.id, amount: "1.00" }])).rejects.toThrow(
      /the application date can't be before the bill date of bill .* \(2026-05-25\)/,
    );
    await expect(world.apply(cr7.id, [{ billId: b1, amount: "0.00" }])).rejects.toThrow("Application 1 amount");
    await expect(world.apply(cr7.id, [{ billId: b1, amount: "-1.00" }])).rejects.toThrow("Application 1 amount");
    await expect(world.apply(cr7.id, [{ billId: b1, amount: "1.001" }])).rejects.toThrow(
      /Application 1 amount .*2 decimal places/,
    );
    await expect(
      world.apply(cr7.id, [
        { billId: b1, amount: "1.00" },
        { billId: b1, amount: "1.00" },
      ]),
    ).rejects.toThrow(/Apply credit to each bill once/);
    await expect(world.apply(cr7.id, [])).rejects.toThrow("Apply credit to at least one bill.");
    await expect(world.apply(cr7.id, [{ billId: "999999", amount: "1.00" }])).rejects.toThrow(
      "Application 1: there's no bill #999999.",
    );

    expect(await world.count("supplier_credit_note_applications")).toBe(0);
    expect(await world.journalCount()).toBe(journalsBefore);
    expect(await world.creditNoteNow(cr7.id)).toMatchObject({ remainingCredit: "46.00", creditStatus: "open" });
    expect(await world.creditNoteNow(cr8.id)).toMatchObject({ remainingCredit: "115.00", creditStatus: "open" });
    expect(await world.billNow(b1)).toMatchObject({ amountCredited: "0.00", amountDue: "230.00" });
    expect(await world.billNow(bx)).toMatchObject({ amountCredited: "0.00", amountDue: "80.00" });
  });

  it("SCN6: after SCN3, a supplier payment of 184.00 makes B1 paid; 184.01 instead is refused", async () => {
    const world = await afterScn3();
    const pay = (amount: string) =>
      world.asUser(bookkeeper, (tx) =>
        recordSupplierPayment(tx, world.b1.id, {
          idempotencyKey: key("pay"),
          paymentDate: "2026-05-22",
          amount,
          bankAccountCode: "1000",
        }),
      );
    await expect(pay("184.01")).rejects.toThrow("The payment of 184.01 is more than the amount due (184.00).");
    const { bill } = await pay("184.00");
    expect(bill).toMatchObject({ amountPaid: "184.00", amountCredited: "46.00", amountDue: "0.00", paidStatus: "paid" });
    // The database refuses it too.
    await expect(
      world.sql(
        `insert into supplier_payments (command_source, idempotency_key, request_hash, bill_id, payment_date, amount,
                                        currency_code, bank_account_id, journal_id)
         select 'sql', 'sql-over', 'h', $1, '2026-05-22', 0.01, 'NZD', bank_account_id, journal_id
           from supplier_payments limit 1`,
        [world.b1.id],
      ),
    ).rejects.toThrow(`Payments against bill #${world.b1.id} can't add up to more than its total`);
  });

  it("SCN7: removing the SCN3 application later posts nothing; B1 230.00 due, CR-7 46.00 remaining, open; a second or early removal is refused", async () => {
    const world = await afterScn3();
    const journalsBefore = await world.journalCount();
    await expect(world.remove(world.cr7.id, world.application.id, "2026-05-19")).rejects.toThrow(
      "The removal date can't be before the application date (2026-05-20).",
    );
    const { created, application, creditNote } = await world.remove(world.cr7.id, world.application.id, "2026-05-25");
    expect(created).toBe(true);
    expect(application).toMatchObject({
      id: world.application.id,
      status: "removed",
      amount: "46.00",
      removalDate: "2026-05-25",
      removedByEmail: bookkeeper.email,
    });
    expect(creditNote).toMatchObject({ amountApplied: "0.00", remainingCredit: "46.00", creditStatus: "open" });
    expect(await world.billNow(world.b1.id)).toMatchObject({
      amountCredited: "0.00",
      amountDue: "230.00",
      paidStatus: "unpaid",
    });
    expect(await world.journalCount()).toBe(journalsBefore);
    await expect(world.remove(world.cr7.id, world.application.id, "2026-05-26")).rejects.toThrow(
      "This application has already been removed.",
    );
    // The row stays, with its removal details.
    expect(await world.applicationsOf(world.cr7.id)).toEqual([application]);
    await expect(world.remove(world.cr7.id, "999999", "2026-05-26")).rejects.toThrow("Application not found.");
    const audit = await world.sql(
      "select entity_id from audit_events where event_type = 'supplier_credit_note.application_removed'",
    );
    expect(audit.rows).toEqual([{ entity_id: world.application.id }]);
  });

  it("SCN8: the supplier refunding CR-8's 15.00 into 1000 posts Dr 1000 / Cr 2000; over-refunds and wrong accounts are refused; voiding it reverses it", async () => {
    const world = await afterScn4();
    const savings = await world.asUser(owner, (tx) =>
      createAccount(tx, { code: "1010", name: "Savings account", accountType: "bank" }),
    );
    await world.asUser(owner, (tx) => updateAccount(tx, savings.id, { isActive: false }));
    const journalsBefore = await world.journalCount();

    await expect(world.refund(world.cr8.id, { amount: "15.01" })).rejects.toThrow(
      "The refund of 15.01 is more than the remaining credit (15.00).",
    );
    await expect(world.refund(world.cr8.id, { amount: "15.00", bankAccountCode: "2000" })).rejects.toThrow(
      "Account 2000 (Accounts payable) isn't a bank account, so refunds can't be received into it.",
    );
    await expect(world.refund(world.cr8.id, { amount: "15.00", bankAccountCode: "1010" })).rejects.toThrow(
      "Account 1010 (Savings account) is archived, so refunds can't be received into it.",
    );
    await expect(world.refund(world.cr8.id, { amount: "15.00", refundDate: "2026-05-14" })).rejects.toThrow(
      "The refund date can't be before the credit note date (2026-05-15).",
    );
    await expect(world.refund(world.cr7.id, { amount: "1.00" })).rejects.toThrow(
      "Supplier credit note CR-7 from Paw Supplies has no credit left to refund.",
    );
    expect(await world.journalCount()).toBe(journalsBefore);

    const { created, refund, creditNote } = await world.refund(world.cr8.id, { amount: "15.00", reference: "Paw refund" });
    expect(created).toBe(true);
    expect(refund).toMatchObject({
      creditNoteId: world.cr8.id,
      supplierCreditNoteNumber: "CR-8",
      status: "active",
      refundDate: "2026-05-28",
      amount: "15.00",
      bankAccountCode: "1000",
      reference: "Paw refund",
      createdByEmail: bookkeeper.email,
    });
    expect(creditNote).toMatchObject({ amountRefunded: "15.00", remainingCredit: "0.00", creditStatus: "used" });
    expect(await world.journal(refund.journalId)).toMatchObject({
      origin: "supplier_credit_note_refund",
      postingDate: "2026-05-28",
      reference: "Paw refund",
      description: "Refund from Paw Supplies for supplier credit note CR-8",
    });
    expect(await world.postedLines(refund.journalId)).toEqual([
      ["1000", "15.00", "0.00"],
      ["2000", "0.00", "15.00"],
    ]);
    await expect(world.refund(world.cr8.id, { amount: "0.01" })).rejects.toThrow(/has no credit left to refund/);

    await expect(world.voidTheRefund(world.cr8.id, refund.id, "2026-05-27")).rejects.toThrow(
      "The void date can't be before the refund date (2026-05-28).",
    );
    const voided = await world.voidTheRefund(world.cr8.id, refund.id, "2026-06-02");
    expect(voided.refund).toMatchObject({ status: "voided", voidDate: "2026-06-02", voidedByEmail: bookkeeper.email });
    expect(voided.creditNote).toMatchObject({ amountRefunded: "0.00", remainingCredit: "15.00", creditStatus: "part_used" });
    expect(await world.journal(voided.refund.voidJournalId!)).toMatchObject({
      origin: "supplier_credit_note_refund",
      postingDate: "2026-06-02",
      correctionKind: "reversal",
      relatedJournalId: refund.journalId,
      reference: "VOID-Paw refund",
    });
    expect(await world.postedLines(voided.refund.voidJournalId!)).toEqual([
      ["1000", "0.00", "15.00"],
      ["2000", "15.00", "0.00"],
    ]);
    await expect(world.voidTheRefund(world.cr8.id, refund.id, "2026-06-03")).rejects.toThrow(
      "This refund has already been voided.",
    );
    await expect(world.voidTheRefund(world.cr7.id, refund.id, "2026-06-03")).rejects.toThrow("Refund not found.");
    expect(await world.refundsOf(world.cr8.id)).toEqual([voided.refund]);
    expect(await world.journalCount()).toBe(journalsBefore + 2);
  });

  it("SCN9: voiding CR-7 or B1 while credit is applied is refused; after removing it, voiding CR-7 posts Dr 6010 40.00 / Dr 2100 6.00 / Cr 2000 46.00", async () => {
    const world = await afterScn3();
    const journalsBefore = await world.journalCount();
    await expect(world.voidTheCreditNote(world.cr7.id, "2026-05-30")).rejects.toThrow(
      "Supplier credit note CR-7 from Paw Supplies has credit applied or refunded, so it can't be voided. Remove its applications and refunds first.",
    );
    await expect(world.voidTheBill(world.b1.id, "2026-05-30")).rejects.toThrow(
      `Bill ${world.b1.supplierInvoiceNumber} from Paw Supplies has credit applied to it, so it can't be voided. Remove its credit first.`,
    );
    expect(await world.journalCount()).toBe(journalsBefore);

    await world.remove(world.cr7.id, world.application.id, "2026-05-25");
    await expect(world.voidTheCreditNote(world.cr7.id, "2026-05-14")).rejects.toThrow(
      "The void date can't be before the credit note date (2026-05-15).",
    );
    const { created, creditNote } = await world.voidTheCreditNote(world.cr7.id, "2026-05-30");
    expect(created).toBe(true);
    expect(creditNote).toMatchObject({
      status: "voided",
      voidDate: "2026-05-30",
      voidedByEmail: bookkeeper.email,
      remainingCredit: null,
      creditStatus: null,
    });
    expect(await world.journal(creditNote.voidJournalId!)).toMatchObject({
      origin: "supplier_credit_note",
      postingDate: "2026-05-30",
      reference: "VOID-CR-7",
      correctionKind: "reversal",
      relatedJournalId: creditNote.approvalJournalId,
    });
    expect(await world.postedLines(creditNote.voidJournalId!)).toEqual([
      ["2000", "0.00", "46.00"],
      ["6010", "40.00", "0.00"],
      ["2100", "6.00", "0.00"],
    ]);
    await expect(world.voidTheCreditNote(world.cr7.id, "2026-05-31")).rejects.toThrow(
      "Supplier credit note CR-7 from Paw Supplies has already been voided.",
    );
    await expect(world.voidTheCreditNote((await world.draft()).id, "2026-05-31")).rejects.toThrow(
      "This supplier credit note is still a draft, so there's nothing to void. Delete it instead.",
    );
    // With its credit removed, B1 can be voided too.
    expect((await world.voidTheBill(world.b1.id, "2026-05-30")).bill.status).toBe("voided");

    // An active refund blocks a void as well.
    const refunded = await world.approved();
    const { refund } = await world.refund(refunded.id, { amount: "5.00" });
    await expect(world.voidTheCreditNote(refunded.id, "2026-05-30")).rejects.toThrow(
      /Remove its applications and refunds first/,
    );
    await world.voidTheRefund(refunded.id, refund.id, "2026-05-29");
    expect((await world.voidTheCreditNote(refunded.id, "2026-05-30")).creditNote.status).toBe("voided");
  });

  it("SCN10: inclusive 1 x 46.00 at 15% gives GST 6.00, net 40.00, total 46.00", async () => {
    const world = await setup();
    const creditNote = await world.approved({
      amountsMode: "inclusive",
      lines: [{ description: "Returned stock", quantity: "1", unitPrice: "46.00", accountCode: "6010", taxCode: "GST" }],
    });
    expect(creditNote).toMatchObject({ subtotal: "40.00", taxTotal: "6.00", total: "46.00", remainingCredit: "46.00" });
    expect(creditNote.lines[0]).toMatchObject({ lineAmount: "46.00", netAmount: "40.00", taxAmount: "6.00" });
    expect(await world.postedLines(creditNote.approvalJournalId!)).toEqual([
      ["2000", "46.00", "0.00"],
      ["6010", "0.00", "40.00"],
      ["2100", "0.00", "6.00"],
    ]);
  });

  it("SCN11: a second Paw Supplies credit note numbered 'cr7' while 'CR 7' isn't voided is refused; after voiding it's allowed; another supplier or a bill may use it", async () => {
    const world = await setup();
    const first = await world.draft({ supplierCreditNoteNumber: "CR 7" });
    const clash = `Paw Supplies already has a supplier credit note numbered CR 7 (draft supplier credit note #${first.id})`;
    // While the first is a draft.
    await expect(world.draft({ supplierCreditNoteNumber: "cr7" })).rejects.toThrow(clash);
    // Editing another draft to the number is refused too.
    const second = await world.draft({ supplierCreditNoteNumber: "CR-99" });
    await expect(
      world.asUser(bookkeeper, (tx) => updateSupplierCreditNote(tx, second.id, { supplierCreditNoteNumber: " Cr7 " })),
    ).rejects.toThrow(clash);
    // While it's approved.
    await world.approve(first.id);
    await expect(world.draft({ supplierCreditNoteNumber: "cr7" })).rejects.toThrow(
      `Paw Supplies already has a supplier credit note numbered CR 7 (approved supplier credit note #${first.id})`,
    );
    // The database refuses it as well.
    await expect(
      world.sql(
        `insert into supplier_credit_notes (command_source, idempotency_key, request_hash, contact_id, credit_note_date,
                                            supplier_credit_note_number, amounts_mode, currency_code, subtotal, tax_total, total)
         values ('sql', 'sql-number', 'h', $1, '2026-05-15', 'c R 7', 'no_tax', 'NZD', 1, 0, 1)`,
        [world.paw.id],
      ),
    ).rejects.toThrow(/supplier_credit_notes_number_key/);
    expect(await world.count("supplier_credit_notes")).toBe(2);

    // Another supplier, or a bill from Paw Supplies, can use the number.
    const other = await world.newSupplier("Other Supplies");
    expect((await world.draft({ contactId: other.id, supplierCreditNoteNumber: "cr7" })).supplierCreditNoteNumber).toBe("cr7");
    expect((await world.approvedBill({ supplierInvoiceNumber: "CR 7" })).supplierInvoiceNumber).toBe("CR 7");

    // After the first is voided, Paw Supplies can use it again.
    await world.voidTheCreditNote(first.id, "2026-05-16");
    const again = await world.approved({ supplierCreditNoteNumber: "cr7" });
    expect(again).toMatchObject({ supplierCreditNoteNumber: "cr7", status: "approved" });
  });

  it("SCN12: approving, applying, removing, refunding or voiding in a locked period is refused and nothing is posted", async () => {
    const world = await setup();
    const early = await world.draft({ creditNoteDate: "2026-05-15" });
    await world.lock("2026-05-31");
    try {
      const journalsBefore = await world.journalCount();
      await expect(world.approve(early.id)).rejects.toThrow(/2026-05-15 is in a locked period/);
      expect(await world.creditNoteNow(early.id)).toMatchObject({ status: "draft", approvalJournalId: null });
      expect(await world.journalCount()).toBe(journalsBefore);
    } finally {
      await world.lock(null);
    }

    const creditNote = (await world.approve(early.id)).creditNote;
    const { applications } = await world.apply(creditNote.id, [{ billId: world.b1.id, amount: "10.00" }]);
    const { refund } = await world.refund(creditNote.id, { amount: "5.00", refundDate: "2026-05-20" });
    await world.lock("2026-05-31");
    try {
      const journalsBefore = await world.journalCount();
      await expect(
        world.apply(creditNote.id, [{ billId: world.bx.id, amount: "1.00" }], { applicationDate: "2026-05-31" }),
      ).rejects.toThrow(/2026-05-31 is in a locked period/);
      await expect(world.remove(creditNote.id, applications[0].id, "2026-05-25")).rejects.toThrow(
        /2026-05-25 is in a locked period/,
      );
      await expect(world.refund(creditNote.id, { amount: "1.00", refundDate: "2026-05-30" })).rejects.toThrow(
        /2026-05-30 is in a locked period/,
      );
      await expect(world.voidTheRefund(creditNote.id, refund.id, "2026-05-30")).rejects.toThrow(
        /2026-05-30 is in a locked period/,
      );
      expect(await world.count("supplier_credit_note_applications")).toBe(1);
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

  it("SCN12: retrying approve, apply, remove, refund or void with the same key and content returns the same result; the same key with different content is refused", async () => {
    const world = await setup();
    const drafted = await world.draft();
    const approveKey = key("approve");
    const approvedFirst = await world.approve(drafted.id, approveKey);
    const approvedAgain = await world.approve(drafted.id, approveKey);
    expect(approvedAgain).toEqual({ created: false, creditNote: approvedFirst.creditNote });
    await expect(world.approve((await world.draft()).id, approveKey)).rejects.toThrow(
      "That idempotency key was already used for a different supplier credit note approval.",
    );

    const applyKey = key("apply");
    const lines = [
      { billId: world.b1.id, amount: "10.00" },
      { billId: world.bx.id, amount: "5" },
    ];
    const applied = await world.apply(drafted.id, lines, { idempotencyKey: applyKey });
    const reapplied = await world.apply(drafted.id, [lines[0], { ...lines[1], amount: "5.00" }], { idempotencyKey: applyKey });
    expect(reapplied.created).toBe(false);
    expect(reapplied.applications).toEqual(applied.applications);
    expect(reapplied.creditNote).toMatchObject({ remainingCredit: "31.00" });
    await expect(
      world.apply(drafted.id, [{ billId: world.b1.id, amount: "11.00" }], { idempotencyKey: applyKey }),
    ).rejects.toThrow("That idempotency key was already used for a different supplier credit note application.");
    expect(await world.count("supplier_credit_note_applications")).toBe(2);

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
      "That idempotency key was already used for a different supplier credit note void.",
    );
    expect(await world.journalCount()).toBe(journalsAfterVoid);
  });

  it("SCN3, SCN8: two commands at once can't both use the same remaining credit", async () => {
    const world = await setup();
    const creditNote = await world.approved();
    const results = await Promise.allSettled([
      world.apply(creditNote.id, [{ billId: world.b1.id, amount: "40.00" }]),
      world.apply(creditNote.id, [{ billId: world.bx.id, amount: "40.00" }]),
      world.refund(creditNote.id, { amount: "40.00" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      expect(String((result as PromiseRejectedResult).reason)).toMatch(/more than the remaining credit.*\(6\.00\)/);
    }
    expect(await world.creditNoteNow(creditNote.id)).toMatchObject({ remainingCredit: "6.00", creditStatus: "part_used" });
  });

  it("SCN2, SCN8: supplier credit note and refund journals are listed as their own kinds and can't be corrected in the ledger", async () => {
    const world = await setup();
    const creditNote = await world.approved();
    const { refund } = await world.refund(creditNote.id, { amount: "3.00" });
    const kinds = await world.asUser(viewer, async (tx) => ({
      creditNotes: (await listJournals(tx, { kind: "supplier_credit_note" })).journals.map((entry) => entry.id),
      refunds: (await listJournals(tx, { kind: "supplier_credit_note_refund" })).journals.map((entry) => entry.id),
    }));
    expect(kinds).toEqual({ creditNotes: [creditNote.approvalJournalId], refunds: [refund.journalId] });

    for (const [journalId, message] of [
      [creditNote.approvalJournalId!, /was posted by a supplier credit note \(CR-7\), so it can't be corrected in the ledger/],
      [refund.journalId, /was posted by a refund received from a supplier \(CR-7\), so it can't be corrected in the ledger/],
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
              { accountCode: "2000", creditAmount: "3" },
            ],
          }),
        ),
      ).rejects.toThrow(message);
    }
  });

  it("the database refuses changes to approved supplier credit notes, over-applying, applications across suppliers, and edits to applications and refunds", async () => {
    const world = await setup();
    const creditNote = await world.approved();
    const drafted = await world.draft();
    const other = await world.newSupplier("Other Supplies");
    const otherBill = await world.approvedBill({ contactId: other.id });
    const draftBill = await world.draftBill();
    const { applications } = await world.apply(creditNote.id, [{ billId: world.b1.id, amount: "40.00" }]);
    const { refund } = await world.refund(creditNote.id, { amount: "3.00" });
    const sql = world.sql;
    const insertApplication = (
      creditNoteId: string,
      billId: string,
      amount: string,
      applicationDate = "2026-05-20",
      status = "active",
    ) =>
      sql(
        `insert into supplier_credit_note_applications (command_source, idempotency_key, request_hash, status, credit_note_id,
                                                        bill_id, application_date, amount, currency_code)
         values ('sql', $1, 'h', $2, $3, $4, $5, $6::numeric, 'NZD')`,
        [key("sql"), status, creditNoteId, billId, applicationDate, amount],
      );

    await expect(insertApplication(creditNote.id, world.bx.id, "3.01")).rejects.toThrow(
      `Credit applied and refunded from supplier credit note #${creditNote.id} can't add up to more than its total`,
    );
    await expect(insertApplication(drafted.id, world.b1.id, "1.00")).rejects.toThrow(
      "Only approved supplier credit notes can be applied",
    );
    await expect(insertApplication(creditNote.id, draftBill.id, "1.00")).rejects.toThrow(
      "Credit can only be applied to approved bills",
    );
    await expect(insertApplication(creditNote.id, otherBill.id, "1.00")).rejects.toThrow(
      "Credit can only be applied to bills of the same supplier",
    );
    await expect(insertApplication(creditNote.id, world.b1.id, "1.00", "2026-05-14")).rejects.toThrow(
      "An application can't be dated before its credit note or bill",
    );
    await expect(insertApplication(creditNote.id, world.b1.id, "1.00", "2026-05-20", "removed")).rejects.toThrow(
      "An application is recorded as active and removed afterwards",
    );
    // Payments and credit together can't pass a bill's total.
    const bigger = await world.approved({
      lines: [{ description: "Big", quantity: "1", unitPrice: "300.00", accountCode: "6010", taxCode: "GST" }],
    });
    await expect(insertApplication(bigger.id, world.b1.id, "190.01")).rejects.toThrow(
      `Payments and credit applied to bill #${world.b1.id} can't add up to more than its total`,
    );

    await expect(
      sql("update supplier_credit_note_applications set amount = 1 where id = $1", [applications[0].id]),
    ).rejects.toThrow("Supplier credit note applications can't be changed, only removed once");
    await expect(
      sql("delete from supplier_credit_note_applications where id = $1", [applications[0].id]),
    ).rejects.toThrow("Supplier credit note applications can't be deleted; remove them instead");
    await expect(sql("truncate supplier_credit_note_applications")).rejects.toThrow(
      "supplier_credit_note_applications can't be truncated",
    );
    await expect(sql("update supplier_credit_note_refunds set amount = 1 where id = $1", [refund.id])).rejects.toThrow(
      "Supplier credit note refunds can't be changed, only voided once",
    );
    await expect(sql("delete from supplier_credit_note_refunds where id = $1", [refund.id])).rejects.toThrow(
      "Supplier credit note refunds can't be deleted; void them instead",
    );
    await expect(sql("truncate supplier_credit_note_refunds")).rejects.toThrow(
      "supplier_credit_note_refunds can't be truncated",
    );
    await expect(
      sql(
        `insert into supplier_credit_note_refunds (command_source, idempotency_key, request_hash, credit_note_id, refund_date,
                                                   amount, currency_code, bank_account_id, journal_id)
         values ('sql', 'sql-refund', 'h', $1, '2026-05-20', 3.01, 'NZD', $2, $3)`,
        [creditNote.id, refund.bankAccountId, refund.journalId],
      ),
    ).rejects.toThrow(`Credit applied and refunded from supplier credit note #${creditNote.id} can't add up to more than its total`);

    // Approved credit notes and their lines are frozen, and can't be voided while credit is used.
    await expect(sql("update supplier_credit_notes set reference = 'x' where id = $1", [creditNote.id])).rejects.toThrow(
      `Supplier credit note #${creditNote.id} is approved, so it can't be changed`,
    );
    await expect(sql("delete from supplier_credit_notes where id = $1", [creditNote.id])).rejects.toThrow(
      `Supplier credit note #${creditNote.id} is approved, so it can't be deleted`,
    );
    await expect(
      sql("update supplier_credit_note_lines set description = 'x' where credit_note_id = $1", [creditNote.id]),
    ).rejects.toThrow("Lines of an approved or voided supplier credit note can't be changed");
    await expect(sql("truncate supplier_credit_notes cascade")).rejects.toThrow(/can't be truncated/);
    await expect(
      sql(
        `update supplier_credit_notes
            set status = 'voided', void_date = '2026-06-01', void_journal_id = $2, void_command_source = 'sql',
                void_idempotency_key = 'sql-void', void_request_hash = 'h', voided_at = now()
          where id = $1`,
        [creditNote.id, refund.journalId],
      ),
    ).rejects.toThrow(`Supplier credit note #${creditNote.id} has credit applied or refunded, so it can't be voided`);
    await expect(
      sql(
        `update bills
            set status = 'voided', void_date = '2026-06-01', void_journal_id = $2, void_command_source = 'sql',
                void_idempotency_key = 'sql-void', void_request_hash = 'h', voided_at = now()
          where id = $1`,
        [world.b1.id, refund.journalId],
      ),
    ).rejects.toThrow(`Bill #${world.b1.id} has credit applied to it, so it can't be voided. Remove its credit first`);

    // Once removed, an application can't change again.
    const { application } = await world.remove(creditNote.id, applications[0].id, "2026-05-21");
    await expect(
      sql("update supplier_credit_note_applications set status = 'active' where id = $1", [application.id]),
    ).rejects.toThrow("Supplier credit note applications can't be changed, only removed once");
  });

  it("migration 0008 upgrades an organisation database on 0007, keeping its data", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_supplier_credit_notes`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();

    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      const before = tenantMigrations.filter((migration) => migration.version < "0008");
      expect((await applyMigrations(client, before, "test:upgrade")).applied).toEqual([
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
      ]);
      await client.query(
        `insert into organisation_settings (organisation_id, display_name, base_currency) values ('upgrade-co', 'Upgrade Co', 'NZD')`,
      );
      const upgraded = await applyMigrations(client, tenantMigrations, "test:upgrade");
      expect(upgraded.applied).toContain("0008");
      expect((await client.query("select display_name from organisation_settings")).rows).toEqual([
        { display_name: "Upgrade Co" },
      ]);
      for (const table of [
        "supplier_credit_notes",
        "supplier_credit_note_lines",
        "supplier_credit_note_applications",
        "supplier_credit_note_refunds",
      ]) {
        expect((await client.query(`select count(*)::int as count from ${table}`)).rows).toEqual([{ count: 0 }]);
      }
      const origin = await client.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'ledger_journals_origin_check'",
      );
      expect(origin.rows[0].definition).toContain("'supplier_credit_note'");
      expect(origin.rows[0].definition).toContain("'supplier_credit_note_refund'");
      expect(origin.rows[0].definition).toContain("'sales_credit_note_refund'");
    } finally {
      await client.end();
    }
  });

  it("SCN12: over HTTP viewers read, bookkeepers do everything else; retries are 200 and a reused key is 409; outsiders get 404", async () => {
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
      contactId: world.paw.id,
      creditNoteDate: "2026-05-15",
      supplierCreditNoteNumber: "CR-7",
      amountsMode: "exclusive",
      lines: [{ description: "Returned stock", quantity: "1", unitPrice: "40.00", accountCode: "6010", taxCode: "GST" }],
    };
    const path = "/api/supplier-credit-notes";

    expect((await creditNotesRoute.POST(post(viewerCookie, path, draftBody), noContext)).status).toBe(403);
    expect((await creditNotesRoute.POST(post(outsiderCookie, path, draftBody), noContext)).status).toBe(404);
    const created = await creditNotesRoute.POST(post(bookkeeperCookie, path, draftBody), noContext);
    expect(created.status).toBe(201);
    const creditNoteId = ((await body(created)).creditNote as SupplierCreditNote).id;
    expect((await creditNotesRoute.POST(post(bookkeeperCookie, path, draftBody), noContext)).status).toBe(200);
    // A second credit note with the same number is a conflict.
    const duplicate = await creditNotesRoute.POST(
      post(bookkeeperCookie, path, { ...draftBody, idempotencyKey: key("http-draft"), supplierCreditNoteNumber: " cr-7" }),
      noContext,
    );
    expect(duplicate.status).toBe(409);
    const context = params({ creditNoteId });

    const patched = await creditNoteRoute.PATCH(
      apiRequest(`${path}/${creditNoteId}`, {
        method: "PATCH",
        cookie: bookkeeperCookie,
        body: { organisationId: org, reference: "Web" },
      }),
      context,
    );
    expect(patched.status).toBe(200);
    expect((await body(patched)).creditNote).toMatchObject({ reference: "Web", total: "46.00" });
    const read = await creditNoteRoute.GET(
      apiRequest(`${path}/${creditNoteId}?organisationId=${org}`, { cookie: viewerCookie }),
      context,
    );
    expect(read.status).toBe(200);
    expect((await body(read)).creditNote).toMatchObject({ id: creditNoteId, status: "draft", supplierCreditNoteNumber: "CR-7" });

    const approveKey = key("http-approve");
    const approveOver = (cookie: string) =>
      approveRoute.POST(post(cookie, `${path}/${creditNoteId}/approve`, { idempotencyKey: approveKey }), context);
    expect((await approveOver(viewerCookie)).status).toBe(403);
    expect((await approveOver(bookkeeperCookie)).status).toBe(201);
    expect((await approveOver(bookkeeperCookie)).status).toBe(200);

    const applyBody = {
      idempotencyKey: key("http-apply"),
      applicationDate: "2026-05-20",
      applications: [{ billId: world.b1.id, amount: "46.00" }],
    };
    const applyOver = (cookie: string, fields = applyBody) =>
      applicationsRoute.POST(post(cookie, `${path}/${creditNoteId}/applications`, fields), context);
    expect((await applyOver(viewerCookie)).status).toBe(403);
    const applied = await applyOver(bookkeeperCookie);
    expect(applied.status).toBe(201);
    const application = ((await body(applied)).applications as SupplierCreditNoteApplication[])[0];
    expect((await applyOver(bookkeeperCookie)).status).toBe(200);
    expect(
      (await applyOver(bookkeeperCookie, { ...applyBody, applications: [{ billId: world.b1.id, amount: "45.00" }] })).status,
    ).toBe(409);
    const tooMuch = await applyOver(bookkeeperCookie, { ...applyBody, idempotencyKey: key("http-apply") });
    expect(tooMuch.status).toBe(400);
    expect((await body(tooMuch)).error).toMatch(/remaining credit .*\(0\.00\)/);
    const listedApplications = await applicationsRoute.GET(
      apiRequest(`${path}/${creditNoteId}/applications?organisationId=${org}`, { cookie: viewerCookie }),
      context,
    );
    expect(await body(listedApplications)).toEqual({ applications: [application] });

    // The bill shows the credit applied to it.
    const billOver = await billRoute.GET(
      apiRequest(`/api/bills/${world.b1.id}?organisationId=${org}`, { cookie: viewerCookie }),
      params({ billId: world.b1.id }),
    );
    expect(billOver.status).toBe(200);
    expect(await body(billOver)).toMatchObject({
      bill: { id: world.b1.id, amountCredited: "46.00", amountDue: "184.00" },
      creditApplied: [{ supplierCreditNoteNumber: "CR-7", amount: "46.00", applicationDate: "2026-05-20", status: "active" }],
    });

    const removeOver = (cookie: string, idempotencyKey: string) =>
      applicationRemoveRoute.POST(
        post(cookie, `${path}/${creditNoteId}/applications/${application.id}/remove`, {
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

    const refundBody = { idempotencyKey: key("http-refund"), refundDate: "2026-05-28", amount: "46.00", bankAccountCode: "1000" };
    const refundOver = (cookie: string, fields = refundBody) =>
      refundsRoute.POST(post(cookie, `${path}/${creditNoteId}/refunds`, fields), context);
    expect((await refundOver(viewerCookie)).status).toBe(403);
    const refunded = await refundOver(bookkeeperCookie);
    expect(refunded.status).toBe(201);
    const refundId = ((await body(refunded)).refund as { id: string }).id;
    expect((await refundOver(bookkeeperCookie)).status).toBe(200);
    expect((await refundOver(bookkeeperCookie, { ...refundBody, amount: "45.00" })).status).toBe(409);
    const listedRefunds = await refundsRoute.GET(
      apiRequest(`${path}/${creditNoteId}/refunds?organisationId=${org}`, { cookie: viewerCookie }),
      context,
    );
    expect(((await body(listedRefunds)).refunds as unknown[]).length).toBe(1);

    const voidRefundOver = (cookie: string, idempotencyKey: string) =>
      refundVoidRoute.POST(
        post(cookie, `${path}/${creditNoteId}/refunds/${refundId}/void`, { idempotencyKey, voidDate: "2026-05-29" }),
        params({ creditNoteId, refundId }),
      );
    const voidRefundKey = key("http-void-refund");
    expect((await voidRefundOver(viewerCookie, voidRefundKey)).status).toBe(403);
    expect((await voidRefundOver(bookkeeperCookie, voidRefundKey)).status).toBe(201);
    expect((await voidRefundOver(bookkeeperCookie, voidRefundKey)).status).toBe(200);

    const voidKey = key("http-void");
    const voidOver = (cookie: string, voidDate = "2026-05-30") =>
      creditNoteVoidRoute.POST(post(cookie, `${path}/${creditNoteId}/void`, { idempotencyKey: voidKey, voidDate }), context);
    expect((await voidOver(viewerCookie)).status).toBe(403);
    expect((await voidOver(bookkeeperCookie)).status).toBe(201);
    expect((await voidOver(bookkeeperCookie)).status).toBe(200);
    expect((await voidOver(bookkeeperCookie, "2026-05-31")).status).toBe(409);

    const list = await creditNotesRoute.GET(
      apiRequest(`${path}?organisationId=${org}&status=voided&contactId=${world.paw.id}`, { cookie: viewerCookie }),
      noContext,
    );
    expect(list.status).toBe(200);
    expect(((await body(list)).creditNotes as SupplierCreditNote[]).map((entry) => entry.id)).toEqual([creditNoteId]);
    expect(
      (await creditNotesRoute.GET(apiRequest(`${path}?organisationId=${org}`, { cookie: outsiderCookie }), noContext)).status,
    ).toBe(404);
    expect((await creditNotesRoute.GET(apiRequest(`${path}?organisationId=${org}`), noContext)).status).toBe(401);

    // Drafts are deleted by bookkeepers only.
    const another = await world.draft();
    const deleteOver = (cookie: string) =>
      creditNoteRoute.DELETE(
        apiRequest(`${path}/${another.id}?organisationId=${org}`, { method: "DELETE", cookie }),
        params({ creditNoteId: another.id }),
      );
    expect((await deleteOver(viewerCookie)).status).toBe(403);
    expect((await deleteOver(bookkeeperCookie)).status).toBe(200);
  });
});

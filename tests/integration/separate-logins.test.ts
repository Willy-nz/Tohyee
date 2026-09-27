import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { listSupplierPayments, recordSupplierPayment, voidSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill, deleteBill, updateBill, voidBill } from "@/lib/bills/service";
import { migrateEverything } from "@/lib/db/migrations";
import { createContact } from "@/lib/contacts/service";
import { applyCreditNote, listApplications, removeApplication } from "@/lib/credit-notes/applications";
import { listRefunds, refundCreditNote, voidRefund } from "@/lib/credit-notes/refunds";
import {
  approveCreditNote,
  createCreditNote,
  deleteCreditNote,
  updateCreditNote,
  voidCreditNote,
} from "@/lib/credit-notes/service";
import type { Actor } from "@/lib/db/org-transaction";
import { listPayments, recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, deleteInvoice, updateInvoice, voidInvoice } from "@/lib/invoices/service";
import { postJournal } from "@/lib/ledger/journals";
import { calculateGstReturn, fileGstReturn, getGstReturn, listGstReturns } from "@/lib/reports/gst-return";
import {
  applySupplierCreditNote,
  listSupplierCreditNoteApplications,
  removeSupplierCreditNoteApplication,
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
  updateSupplierCreditNote,
  voidSupplierCreditNote,
} from "@/lib/supplier-credit-notes/service";
import { createTaxCode } from "@/lib/tax/codes";
import {
  createTestLogin,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  dropTestLogin,
  inOrganisation,
  key,
  startTestServer,
  testDatabaseUrl,
  type TestServer,
  withDb,
  withLogin,
} from "../helpers/test-server";

const ORG = "hardened-co";

async function asLogin<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/**
 * docs/ARCHITECTURE.md, "Database logins": with DATABASE_ADMIN_URL set, the
 * runtime login gets data access only.
 */
describeWithDatabase("separate admin and runtime logins (DATABASE_ADMIN_URL)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let actor: Actor;
  let databaseName = "";

  beforeAll(async () => {
    server = await startTestServer({ separateRuntimeLogin: true });
    owner = await createTestUser("hardened@example.com", { serverAdmin: true });
    actor = { userId: owner.id, email: owner.email };
    databaseName = (await createTestOrganisation(owner, ORG)).databaseName;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("the app works day to day as the runtime login", async () => {
    const result = await inOrganisation(ORG, actor, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("j"),
        postingDate: "2026-06-15",
        reference: "HARD-1",
        lines: [
          { accountCode: "1000", debitAmount: "50.00" },
          { accountCode: "4000", creditAmount: "50.00" },
        ],
      }),
    );
    expect(result.created).toBe(true);

    // Migrations run again on every server start; that must keep access intact.
    const rerun = await migrateEverything();
    expect(rerun.organisations.find((organisation) => organisation.organisationId === ORG)?.ok).toBe(true);
    const listed = await inOrganisation(ORG, actor, (tx) =>
      tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"),
    );
    expect(listed.rows[0].count).toBe("1");
  });

  it("sales invoices can be drafted, edited, deleted, approved and voided as the runtime login", async () => {
    const invoice = await inOrganisation(ORG, actor, async (tx) => {
      await createTaxCode(tx, {
        idempotencyKey: key("tax"),
        code: "GST",
        label: "GST",
        category: "standard",
        rate: "0.15",
        effectiveFrom: "2026-01-01",
      });
      const { contact } = await createContact(tx, { idempotencyKey: key("c"), name: "Hardened Customer", isCustomer: true });
      const draft = (quantity: string) =>
        createInvoice(tx, {
          idempotencyKey: key("i"),
          contactId: contact.id,
          invoiceDate: "2026-06-15",
          dueDate: "2026-07-15",
          amountsMode: "exclusive",
          lines: [{ description: "Service", quantity, unitPrice: "50", accountCode: "4000", taxCode: "GST" }],
        });
      const scrap = (await draft("1")).invoice;
      await deleteInvoice(tx, scrap.id);
      const { invoice: saved } = await draft("1");
      await updateInvoice(tx, saved.id, {
        lines: [{ description: "Service", quantity: "2", unitPrice: "50", accountCode: "4000", taxCode: "GST" }],
      });
      await approveInvoice(tx, saved.id, { idempotencyKey: key("a") });
      return (await voidInvoice(tx, saved.id, { idempotencyKey: key("v"), voidDate: "2026-06-20" })).invoice;
    });
    expect(invoice).toMatchObject({ status: "voided", invoiceNumber: "INV-0001", total: "115.00" });
  });

  it("customer payments can be recorded, listed and voided as the runtime login", async () => {
    const result = await inOrganisation(ORG, actor, async (tx) => {
      const { contact } = await createContact(tx, { idempotencyKey: key("c"), name: "Paying Customer", isCustomer: true });
      const { invoice: saved } = await createInvoice(tx, {
        idempotencyKey: key("i"),
        contactId: contact.id,
        invoiceDate: "2026-06-15",
        dueDate: "2026-07-15",
        amountsMode: "no_tax",
        lines: [{ description: "Service", quantity: "1", unitPrice: "80", accountCode: "4000" }],
      });
      const { invoice } = await approveInvoice(tx, saved.id, { idempotencyKey: key("a") });
      const { payment } = await recordPayment(tx, invoice.id, {
        idempotencyKey: key("p"),
        paymentDate: "2026-06-16",
        amount: "30.00",
        bankAccountCode: "1000",
      });
      const voided = await voidPayment(tx, invoice.id, payment.id, { idempotencyKey: key("vp"), voidDate: "2026-06-17" });
      return { voided, payments: await listPayments(tx, invoice.id) };
    });
    expect(result.voided.payment).toMatchObject({ status: "voided", amount: "30.00", voidDate: "2026-06-17" });
    expect(result.voided.invoice).toMatchObject({ amountPaid: "0.00", amountDue: "80.00", paidStatus: "unpaid" });
    expect(result.payments.map((entry) => entry.status)).toEqual(["voided"]);
  });

  it("bills can be drafted, edited, deleted, approved and voided as the runtime login", async () => {
    const bill = await inOrganisation(ORG, actor, async (tx) => {
      const { contact } = await createContact(tx, { idempotencyKey: key("c"), name: "Hardened Supplier", isSupplier: true });
      const draft = () =>
        createBill(tx, {
          idempotencyKey: key("b"),
          contactId: contact.id,
          billDate: "2026-06-15",
          dueDate: "2026-07-15",
          supplierInvoiceNumber: "H-1",
          amountsMode: "no_tax",
          lines: [{ description: "Accounting", quantity: "1", unitPrice: "200", accountCode: "6010" }],
        });
      const scrap = (await draft()).bill;
      await deleteBill(tx, scrap.id);
      const { bill: saved } = await draft();
      await updateBill(tx, saved.id, {
        lines: [{ description: "Accounting", quantity: "2", unitPrice: "200", accountCode: "6010" }],
      });
      await approveBill(tx, saved.id, { idempotencyKey: key("a") });
      return (await voidBill(tx, saved.id, { idempotencyKey: key("v"), voidDate: "2026-06-20" })).bill;
    });
    expect(bill).toMatchObject({ status: "voided", supplierInvoiceNumber: "H-1", total: "400.00" });
  });

  it("supplier payments can be recorded, listed and voided as the runtime login", async () => {
    const result = await inOrganisation(ORG, actor, async (tx) => {
      const { contact } = await createContact(tx, { idempotencyKey: key("c"), name: "Paid Supplier", isSupplier: true });
      const { bill: saved } = await createBill(tx, {
        idempotencyKey: key("b"),
        contactId: contact.id,
        billDate: "2026-06-15",
        dueDate: "2026-07-15",
        supplierInvoiceNumber: "P-1",
        amountsMode: "no_tax",
        lines: [{ description: "Accounting", quantity: "1", unitPrice: "80", accountCode: "6010" }],
      });
      const { bill } = await approveBill(tx, saved.id, { idempotencyKey: key("a") });
      const { payment } = await recordSupplierPayment(tx, bill.id, {
        idempotencyKey: key("p"),
        paymentDate: "2026-06-16",
        amount: "30.00",
        bankAccountCode: "1000",
      });
      const voided = await voidSupplierPayment(tx, bill.id, payment.id, { idempotencyKey: key("vp"), voidDate: "2026-06-17" });
      return { voided, payments: await listSupplierPayments(tx, bill.id) };
    });
    expect(result.voided.payment).toMatchObject({ status: "voided", amount: "30.00", voidDate: "2026-06-17" });
    expect(result.voided.bill).toMatchObject({ amountPaid: "0.00", amountDue: "80.00", paidStatus: "unpaid" });
    expect(result.payments.map((entry) => entry.status)).toEqual(["voided"]);
  });

  it("sales credit notes can be drafted, approved, applied, refunded and voided as the runtime login", async () => {
    const result = await inOrganisation(ORG, actor, async (tx) => {
      const { contact } = await createContact(tx, { idempotencyKey: key("c"), name: "Credited Customer", isCustomer: true });
      const { invoice: savedInvoice } = await createInvoice(tx, {
        idempotencyKey: key("i"),
        contactId: contact.id,
        invoiceDate: "2026-06-15",
        dueDate: "2026-07-15",
        amountsMode: "no_tax",
        lines: [{ description: "Service", quantity: "1", unitPrice: "80", accountCode: "4000" }],
      });
      const { invoice } = await approveInvoice(tx, savedInvoice.id, { idempotencyKey: key("a") });
      const draft = () =>
        createCreditNote(tx, {
          idempotencyKey: key("cn"),
          contactId: contact.id,
          creditNoteDate: "2026-06-16",
          amountsMode: "no_tax",
          lines: [{ description: "Refund", quantity: "1", unitPrice: "20", accountCode: "4000" }],
        });
      await deleteCreditNote(tx, (await draft()).creditNote.id);
      const { creditNote: saved } = await draft();
      await updateCreditNote(tx, saved.id, {
        lines: [{ description: "Refund", quantity: "1", unitPrice: "30", accountCode: "4000" }],
      });
      await approveCreditNote(tx, saved.id, { idempotencyKey: key("ca") });
      const applied = await applyCreditNote(tx, saved.id, {
        idempotencyKey: key("ap"),
        applicationDate: "2026-06-17",
        applications: [{ invoiceId: invoice.id, amount: "20.00" }],
      });
      await removeApplication(tx, saved.id, applied.applications[0].id, {
        idempotencyKey: key("rm"),
        removalDate: "2026-06-18",
      });
      const { refund } = await refundCreditNote(tx, saved.id, {
        idempotencyKey: key("rf"),
        refundDate: "2026-06-18",
        amount: "30.00",
        bankAccountCode: "1000",
      });
      await voidRefund(tx, saved.id, refund.id, { idempotencyKey: key("vr"), voidDate: "2026-06-19" });
      const voided = await voidCreditNote(tx, saved.id, { idempotencyKey: key("vc"), voidDate: "2026-06-20" });
      return {
        voided: voided.creditNote,
        applications: await listApplications(tx, saved.id),
        refunds: await listRefunds(tx, saved.id),
      };
    });
    expect(result.voided).toMatchObject({ status: "voided", creditNoteNumber: "CN-0001", total: "30.00" });
    expect(result.applications.map((entry) => entry.status)).toEqual(["removed"]);
    expect(result.refunds.map((entry) => entry.status)).toEqual(["voided"]);
  });

  it("supplier credit notes can be drafted, approved, applied, refunded and voided as the runtime login", async () => {
    const result = await inOrganisation(ORG, actor, async (tx) => {
      const { contact } = await createContact(tx, { idempotencyKey: key("c"), name: "Crediting Supplier", isSupplier: true });
      const { bill: savedBill } = await createBill(tx, {
        idempotencyKey: key("b"),
        contactId: contact.id,
        billDate: "2026-06-15",
        dueDate: "2026-07-15",
        supplierInvoiceNumber: "S-1",
        amountsMode: "no_tax",
        lines: [{ description: "Accounting", quantity: "1", unitPrice: "80", accountCode: "6010" }],
      });
      const { bill } = await approveBill(tx, savedBill.id, { idempotencyKey: key("a") });
      const draft = () =>
        createSupplierCreditNote(tx, {
          idempotencyKey: key("scn"),
          contactId: contact.id,
          creditNoteDate: "2026-06-16",
          supplierCreditNoteNumber: "SC-1",
          amountsMode: "no_tax",
          lines: [{ description: "Discount", quantity: "1", unitPrice: "20", accountCode: "6010" }],
        });
      await deleteSupplierCreditNote(tx, (await draft()).creditNote.id);
      const { creditNote: saved } = await draft();
      await updateSupplierCreditNote(tx, saved.id, {
        lines: [{ description: "Discount", quantity: "1", unitPrice: "30", accountCode: "6010" }],
      });
      await approveSupplierCreditNote(tx, saved.id, { idempotencyKey: key("sca") });
      const applied = await applySupplierCreditNote(tx, saved.id, {
        idempotencyKey: key("sap"),
        applicationDate: "2026-06-17",
        applications: [{ billId: bill.id, amount: "20.00" }],
      });
      await removeSupplierCreditNoteApplication(tx, saved.id, applied.applications[0].id, {
        idempotencyKey: key("srm"),
        removalDate: "2026-06-18",
      });
      const { refund } = await refundSupplierCreditNote(tx, saved.id, {
        idempotencyKey: key("srf"),
        refundDate: "2026-06-18",
        amount: "30.00",
        bankAccountCode: "1000",
      });
      await voidSupplierCreditNoteRefund(tx, saved.id, refund.id, { idempotencyKey: key("svr"), voidDate: "2026-06-19" });
      const voided = await voidSupplierCreditNote(tx, saved.id, { idempotencyKey: key("svc"), voidDate: "2026-06-20" });
      return {
        voided: voided.creditNote,
        applications: await listSupplierCreditNoteApplications(tx, saved.id),
        refunds: await listSupplierCreditNoteRefunds(tx, saved.id),
      };
    });
    expect(result.voided).toMatchObject({ status: "voided", supplierCreditNoteNumber: "SC-1", total: "30.00" });
    expect(result.applications.map((entry) => entry.status)).toEqual(["removed"]);
    expect(result.refunds.map((entry) => entry.status)).toEqual(["voided"]);
  });

  it("GST returns can be worked out, filed and read as the runtime login", async () => {
    const period = { periodStart: "2026-06-01", periodEnd: "2026-06-30" };
    const result = await inOrganisation(ORG, actor, async (tx) => {
      const calculated = await calculateGstReturn(tx, period);
      const idempotencyKey = key("gst");
      const { created, gstReturn } = await fileGstReturn(tx, { idempotencyKey, ...period });
      const retried = await fileGstReturn(tx, { idempotencyKey, ...period });
      const listed = await listGstReturns(tx);
      return { calculated, created, gstReturn, retried, listed, read: await getGstReturn(tx, gstReturn.id) };
    });
    expect(result.created).toBe(true);
    expect(result.retried).toMatchObject({ created: false, gstReturn: { id: result.gstReturn.id } });
    expect(result.gstReturn.boxes).toEqual(result.calculated.boxes);
    expect(result.listed.gstReturns.map((entry) => entry.id)).toEqual([result.gstReturn.id]);
    expect(result.read.changedSinceFiled).toBe(false);
  });

  it("the runtime login can't change the schema or rewrite posted history", async () => {
    const runtimeUrl = withDb(process.env.DATABASE_URL!, databaseName);
    await asLogin(runtimeUrl, async (client) => {
      const whoAmI = await client.query<{ current_user: string }>("select current_user");
      expect(whoAmI.rows[0].current_user).toBe(server.runtimeLogin!.role);

      for (const sql of [
        "create table sneaky (id int)",
        "alter table accounts add column sneaky int",
        "update ledger_journals set reference = 'changed'",
        "delete from ledger_journal_lines",
        "truncate audit_events",
        "update gst_returns set box15 = 0",
        "delete from gst_return_lines",
        "truncate gst_return_adjustments",
        "insert into schema_migrations (version, name, checksum) values ('999', 'x', 'x')",
      ]) {
        const error = await client.query(sql).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(pgCode(error), sql).toBe("42501"); // insufficient_privilege
      }
    });
  });

  it("other logins on the same PostgreSQL server can't connect to an organisation's database", async () => {
    const outsider = await createTestLogin("tohyee_outsider");
    try {
      const error = await asLogin(
        withLogin(withDb(testDatabaseUrl!, databaseName), outsider.role, outsider.password),
        async () => null,
      ).catch((caught: unknown) => caught);
      expect(pgCode(error)).toBe("42501");
    } finally {
      await dropTestLogin(outsider.role);
    }
  });
});

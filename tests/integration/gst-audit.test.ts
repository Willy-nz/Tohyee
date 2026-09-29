import { afterAll, beforeAll, expect, it } from "vitest";
import * as gstAuditRoute from "@/app/api/reports/gst-audit/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankTransaction } from "@/lib/bank/transactions";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, type Bill, createBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, type Invoice, voidInvoice } from "@/lib/invoices/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { entriesTotal, type GstAuditReport, gstAuditReport } from "@/lib/reports/gst-audit";
import { calculateGstReturn, fileGstReturn } from "@/lib/reports/gst-return";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import type { GstBasis } from "@/lib/tax/categories";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;
const APR_MAY = { periodStart: "2026-04-01", periodEnd: "2026-05-31" };

/**
 * Examples GA1-GA4 in docs/ACCOUNTING-EXAMPLES.md ("GST audit report"). Each
 * test gets its own organisation with customer Kobe Ltd, supplier Paw
 * Supplies and tax codes GST (15%) and ZERO.
 */
describeWithDatabase("GST audit report", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("gst-audit-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("gst-audit-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(basis: GstBasis = "invoice") {
    organisations += 1;
    const org = `gst-audit-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { gstBasis: basis }));
    const contact = async (name: string, fields: Record<string, unknown>): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...fields }))).contact;
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const paw = await contact("Paw Supplies", { isSupplier: true });
    const line = (description: string, unitPrice: string, taxCode = "GST", accountCode = "4000") => ({ description, quantity: "1", unitPrice, accountCode, taxCode });
    const invoice = async (fields: Record<string, unknown> = {}): Promise<Invoice> => {
      const { invoice: drafted } = await as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("invoice"),
          contactId: kobe.id,
          invoiceDate: "2026-04-10",
          dueDate: "2026-07-31",
          amountsMode: "exclusive",
          lines: [line("Consulting", "100.00")],
          ...fields,
        }),
      );
      return (await as((tx) => approveInvoice(tx, drafted.id, { idempotencyKey: key("approve") }))).invoice;
    };
    let bills = 0;
    const bill = async (fields: Record<string, unknown> = {}): Promise<Bill> => {
      bills += 1;
      const { bill: drafted } = await as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: paw.id,
          billDate: "2026-04-12",
          dueDate: "2026-07-31",
          supplierInvoiceNumber: `S-${bills}`,
          amountsMode: "exclusive",
          lines: [line("Stationery", "200.00", "GST", "6010")],
          ...fields,
        }),
      );
      return (await as((tx) => approveBill(tx, drafted.id, { idempotencyKey: key("approve") }))).bill;
    };
    const audit = (input: Record<string, unknown> = APR_MAY) => as((tx) => gstAuditReport(tx, input));
    const returnFor = (input: { periodStart: string; periodEnd: string; adjustments?: unknown } = APR_MAY) => as((tx) => calculateGstReturn(tx, input));
    return { org, as, kobe, paw, line, invoice, bill, audit, returnFor };
  }

  const entries = (box: GstAuditReport["box5"]) => box.entries.map((e) => [e.eventType, e.eventDate, e.documentNumber, e.amount]);

  /** The documents of GA1 and GA2. */
  async function invoiceBasis() {
    const w = await setup("invoice");
    await w.invoice();
    await w.invoice({ invoiceDate: "2026-04-12", lines: [w.line("Consulting", "100.00"), w.line("Export freight", "50.00", "ZERO")] });
    await w.invoice({ invoiceDate: "2026-04-14", amountsMode: "no_tax", lines: [{ description: "Workshop", quantity: "1", unitPrice: "80.00", accountCode: "4000" }] });
    const inv4 = await w.invoice({ invoiceDate: "2026-04-20" });
    await w.as((tx) => voidInvoice(tx, inv4.id, { idempotencyKey: key("void"), voidDate: "2026-05-15" }));
    const { creditNote } = await w.as((tx) =>
      createCreditNote(tx, { idempotencyKey: key("cn"), contactId: w.kobe.id, creditNoteDate: "2026-05-05", amountsMode: "exclusive", lines: [w.line("Discount", "20.00")] }),
    );
    await w.as((tx) => approveCreditNote(tx, creditNote.id, { idempotencyKey: key("approve") }));
    const bank = (await w.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0];
    await w.as((tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("spend"),
        kind: "spend",
        accountId: bank.id,
        contactId: w.paw.id,
        date: "2026-04-03",
        amountsMode: "inclusive",
        lines: [{ description: "Petrol", accountCode: "6010", taxCode: "GST", amount: "57.50" }],
      }),
    );
    await w.bill();
    const { creditNote: cr7 } = await w.as((tx) =>
      createSupplierCreditNote(tx, {
        idempotencyKey: key("scn"),
        contactId: w.paw.id,
        creditNoteDate: "2026-04-16",
        supplierCreditNoteNumber: "CR-7",
        amountsMode: "exclusive",
        lines: [w.line("Returned stock", "40.00", "GST", "6010")],
      }),
    );
    await w.as((tx) => approveSupplierCreditNote(tx, cr7.id, { idempotencyKey: key("approve") }));
    return { w, bankId: bank.id };
  }

  it("GA1: every document behind Boxes 5, 6 and 11 adds up to the return to the cent", async () => {
    const { w, bankId } = await invoiceBasis();
    const report = await w.audit();
    expect(report.box5.total).toBe("257.00");
    expect(entries(report.box5)).toEqual([
      ["invoice_approved", "2026-04-10", "INV-0001", "115.00"],
      ["invoice_approved", "2026-04-12", "INV-0002", "165.00"],
      ["invoice_approved", "2026-04-20", "INV-0004", "115.00"],
      ["credit_note_approved", "2026-05-05", "CN-0001", "-23.00"],
      ["invoice_voided", "2026-05-15", "INV-0004", "-115.00"],
    ]);
    expect(report.box5.entries.find((e) => e.documentNumber === "INV-0002")!.lineCount).toBe(2);
    expect([report.box6.total, entries(report.box6)]).toEqual(["50.00", [["invoice_approved", "2026-04-12", "INV-0002", "50.00"]]]);
    expect(report.box11.total).toBe("241.50");
    expect(report.box11.entries.map((e) => [e.documentType, e.documentNumber.startsWith("BT-") ? "BT" : e.documentNumber, e.amount])).toEqual([
      ["bank_transaction", "BT", "57.50"],
      ["bill", "S-1", "230.00"],
      ["supplier_credit_note", "CR-7", "-46.00"],
    ]);
    expect(report.box11.entries[0].href).toBe(`/operations/bank-accounts/${bankId}`);
    expect(report.box5.entries[0].href).toMatch(/^\/operations\/invoices\/\d+$/);
    expect(report.boxes).toMatchObject({ box5: "257.00", box6: "50.00", box7: "207.00", box8: "27.00", box11: "241.50", box12: "31.50", box15: "-4.50" });
    expect([report.leftOut.total, entries(report.leftOut as GstAuditReport["box5"])]).toEqual(["80.00", [["invoice_approved", "2026-04-14", "INV-0003", "80.00"]]]);
    // Each list adds up to its box, and every box is the GST return's.
    const gstReturn = await w.returnFor();
    expect(report.boxes).toEqual(gstReturn.boxes);
    expect([entriesTotal(report.box5.entries), entriesTotal(report.box6.entries), entriesTotal(report.box11.entries)]).toEqual([
      gstReturn.boxes.box5,
      gstReturn.boxes.box6,
      gstReturn.boxes.box11,
    ]);
  });

  it("GA2: adjustments are listed and change Boxes 10, 14 and 15 as on the return", async () => {
    const { w } = await invoiceBasis();
    const adjustments = [
      { box: "9", description: "Bad debt recovered", amount: "3.00" },
      { box: "13", description: "Change of use", amount: "1.50" },
    ];
    const report = await w.audit({ ...APR_MAY, adjustments });
    expect(report.adjustments).toEqual(adjustments);
    expect(report.boxes).toMatchObject({ box9: "3.00", box10: "30.00", box13: "1.50", box14: "33.00", box15: "-3.00" });
    expect(report.boxes).toEqual((await w.returnFor({ ...APR_MAY, adjustments })).boxes);
  });

  it("GA3: on the payments basis each settlement is an entry; the hybrid basis mixes them", async () => {
    const w = await setup("payments");
    const i5 = await w.invoice({ lines: [w.line("Consulting", "100.00"), w.line("Export freight", "50.00", "ZERO")] });
    await w.as((tx) => recordPayment(tx, i5.id, { idempotencyKey: key("pay"), paymentDate: "2026-04-15", amount: "82.50", bankAccountCode: "1000" }));
    const b1 = await w.bill();
    await w.as((tx) => recordSupplierPayment(tx, b1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-20", amount: "115.00", bankAccountCode: "1000" }));
    const payments = await w.audit();
    expect(payments.basis).toBe("payments");
    expect(payments.box5.entries.map((e) => [e.eventType, e.documentNumber, e.amount, e.settledAmount, e.documentTotal])).toEqual([
      ["customer_payment", "INV-0001", "82.50", "82.50", "165.00"],
    ]);
    expect([payments.box5.total, payments.box6.total]).toEqual(["82.50", "25.00"]);
    expect(payments.box11.entries.map((e) => [e.eventType, e.documentNumber, e.amount, e.settledAmount, e.documentTotal])).toEqual([
      ["supplier_payment", "S-1", "115.00", "115.00", "230.00"],
    ]);
    expect(payments.boxes.box15).toBe("-7.50");
    expect(payments.boxes).toEqual((await w.returnFor()).boxes);

    await w.as((tx) => updateOrganisationSettings(tx, { gstBasis: "hybrid" }));
    const hybrid = await w.audit();
    expect(entries(hybrid.box5)).toEqual([["invoice_approved", "2026-04-10", "INV-0001", "165.00"]]);
    expect([hybrid.box6.total, hybrid.box11.total, hybrid.boxes.box15]).toEqual(["50.00", "115.00", "0.00"]);
    expect(hybrid.boxes).toEqual((await w.returnFor()).boxes);
  });

  it("GA4: a filed return is audited as it was filed", async () => {
    const w = await setup("invoice");
    await w.invoice();
    await w.bill();
    const filed = await w.as((tx) => fileGstReturn(tx, { idempotencyKey: key("file"), ...APR_MAY }));
    await w.bill({ billDate: "2026-05-10", lines: [w.line("Paper", "100.00", "GST", "6010")] });
    const asFiled = await w.audit({ gstReturnId: filed.gstReturn.id });
    expect(asFiled.gstReturnId).toBe(filed.gstReturn.id);
    expect([asFiled.box11.total, asFiled.box11.entries.length]).toEqual(["230.00", 1]);
    expect(asFiled.boxes).toEqual(filed.gstReturn.boxes);
    const now = await w.audit();
    expect([now.box11.total, now.box11.entries.length]).toEqual(["345.00", 2]);
  });

  it("over HTTP: a viewer can open it, with or without adjustments", async () => {
    const { w } = await invoiceBasis();
    const cookie = await sessionCookieFor(viewer);
    const got = await gstAuditRoute.GET(
      apiRequest(`/api/reports/gst-audit?organisationId=${w.org}&periodStart=2026-04-01&periodEnd=2026-05-31`, { cookie }),
      noContext,
    );
    expect(got.status).toBe(200);
    expect(((await got.json()) as GstAuditReport).box5.total).toBe("257.00");
    const posted = await gstAuditRoute.POST(
      apiRequest("/api/reports/gst-audit", {
        method: "POST",
        cookie,
        body: { organisationId: w.org, ...APR_MAY, adjustments: [{ box: "9", description: "Bad debt recovered", amount: "3.00" }] },
      }),
      noContext,
    );
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as GstAuditReport).boxes.box10).toBe("30.00");
    const bad = await gstAuditRoute.GET(
      apiRequest(`/api/reports/gst-audit?organisationId=${w.org}&periodStart=2026-04-02&periodEnd=2026-05-31`, { cookie }),
      noContext,
    );
    expect(bad.status).toBe(400);
  });
});

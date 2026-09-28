import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as gstReturnRoute from "@/app/api/gst-returns/[gstReturnId]/route";
import * as gstReturnsRoute from "@/app/api/gst-returns/route";
import * as gstReturnReportRoute from "@/app/api/reports/gst-return/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, type Bill, createBill, voidBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { applyCreditNote } from "@/lib/credit-notes/applications";
import { refundCreditNote } from "@/lib/credit-notes/refunds";
import { approveCreditNote, createCreditNote, type CreditNote, voidCreditNote } from "@/lib/credit-notes/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, type Invoice, voidInvoice } from "@/lib/invoices/service";
import { postJournal } from "@/lib/ledger/journals";
import { calculateGstReturn, fileGstReturn, getGstReturn, listGstReturns } from "@/lib/reports/gst-return";
import { applySupplierCreditNote } from "@/lib/supplier-credit-notes/applications";
import {
  approveSupplierCreditNote,
  createSupplierCreditNote,
  type SupplierCreditNote,
  voidSupplierCreditNote,
} from "@/lib/supplier-credit-notes/service";
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
  withDb,
} from "../helpers/test-server";

const noContext = undefined as unknown;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

const APR_MAY = { periodStart: "2026-04-01", periodEnd: "2026-05-31" };

const ZERO_BOXES = {
  box5: "0.00",
  box6: "0.00",
  box7: "0.00",
  box8: "0.00",
  box9: "0.00",
  box10: "0.00",
  box11: "0.00",
  box12: "0.00",
  box13: "0.00",
  box14: "0.00",
  box15: "0.00",
};

/**
 * Examples G1-G9 in docs/ACCOUNTING-EXAMPLES.md ("GST return"). Each example
 * gets its own organisation with customer Kobe Ltd, supplier Paw Supplies and
 * tax codes GST (15%), ZERO (zero rated) and EXEMPT. Documents are dated in
 * April and May 2026 unless told otherwise.
 */
describeWithDatabase("GST return", () => {
  let server: TestServer;
  let owner: SessionUser;
  let admin: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    admin = await createTestUser("admin@example.com");
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
    outsider = await createTestUser("outsider@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `gst-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [admin, "admin"],
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
    const taxCode = (code: string, category: string, rate: string) =>
      asUser(owner, (tx) =>
        createTaxCode(tx, {
          idempotencyKey: key("tax"),
          code,
          label: code,
          category,
          rate,
          effectiveFrom: "2026-01-01",
        }),
      );
    await taxCode("GST", "standard", "0.15");
    await taxCode("ZERO", "zero_rated", "0");
    await taxCode("EXEMPT", "exempt", "0");
    const contact = async (name: string, fields: Record<string, unknown>): Promise<Contact> =>
      (
        await asUser(bookkeeper, (tx) =>
          createContact(tx, {
            idempotencyKey: key("contact"),
            name,
            ...fields,
          }),
        )
      ).contact;
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const paw = await contact("Paw Supplies", { isSupplier: true });

    /** A draft invoice for Kobe Ltd: I1 (2 x 50.00 at 15% exclusive) on 10 Apr 2026 unless told otherwise. */
    const draftInvoice = async (fields: Record<string, unknown> = {}): Promise<Invoice> =>
      (
        await asUser(bookkeeper, (tx) =>
          createInvoice(tx, {
            idempotencyKey: key("invoice"),
            contactId: kobe.id,
            invoiceDate: "2026-04-10",
            dueDate: "2026-06-30",
            amountsMode: "exclusive",
            lines: [
              {
                description: "Consulting",
                quantity: "2",
                unitPrice: "50.00",
                accountCode: "4000",
                taxCode: "GST",
              },
            ],
            ...fields,
          }),
        )
      ).invoice;
    const invoice = async (fields: Record<string, unknown> = {}): Promise<Invoice> => {
      const drafted = await draftInvoice(fields);
      return (await asUser(bookkeeper, (tx) => approveInvoice(tx, drafted.id, { idempotencyKey: key("approve") })))
        .invoice;
    };
    /** An approved bill from Paw Supplies: B1 (1 x 200.00 at 15% exclusive to 6010) on 12 Apr 2026 unless told otherwise. */
    let bills = 0;
    const bill = async (fields: Record<string, unknown> = {}): Promise<Bill> => {
      bills += 1;
      const { bill: drafted } = await asUser(bookkeeper, (tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: paw.id,
          billDate: "2026-04-12",
          dueDate: "2026-06-30",
          supplierInvoiceNumber: `S-${bills}`,
          amountsMode: "exclusive",
          lines: [
            {
              description: "Stationery",
              quantity: "1",
              unitPrice: "200.00",
              accountCode: "6010",
              taxCode: "GST",
            },
          ],
          ...fields,
        }),
      );
      return (await asUser(bookkeeper, (tx) => approveBill(tx, drafted.id, { idempotencyKey: key("approve") }))).bill;
    };
    /** An approved credit note for Kobe Ltd: CN-0001 (1 x 20.00 at 15% exclusive) on 15 Apr 2026 unless told otherwise. */
    const creditNote = async (fields: Record<string, unknown> = {}): Promise<CreditNote> => {
      const { creditNote: drafted } = await asUser(bookkeeper, (tx) =>
        createCreditNote(tx, {
          idempotencyKey: key("credit-note"),
          contactId: kobe.id,
          creditNoteDate: "2026-04-15",
          amountsMode: "exclusive",
          lines: [
            {
              description: "Discount",
              quantity: "1",
              unitPrice: "20.00",
              accountCode: "4000",
              taxCode: "GST",
            },
          ],
          ...fields,
        }),
      );
      return (await asUser(bookkeeper, (tx) => approveCreditNote(tx, drafted.id, { idempotencyKey: key("approve") })))
        .creditNote;
    };
    /** An approved supplier credit note from Paw Supplies: CR-7 (1 x 40.00 at 15% exclusive, total 46.00) on 16 Apr 2026. */
    const supplierCreditNote = async (fields: Record<string, unknown> = {}): Promise<SupplierCreditNote> => {
      const { creditNote: drafted } = await asUser(bookkeeper, (tx) =>
        createSupplierCreditNote(tx, {
          idempotencyKey: key("supplier-credit-note"),
          contactId: paw.id,
          creditNoteDate: "2026-04-16",
          supplierCreditNoteNumber: "CR-7",
          amountsMode: "exclusive",
          lines: [
            {
              description: "Returned stock",
              quantity: "1",
              unitPrice: "40.00",
              accountCode: "6010",
              taxCode: "GST",
            },
          ],
          ...fields,
        }),
      );
      return (
        await asUser(bookkeeper, (tx) =>
          approveSupplierCreditNote(tx, drafted.id, {
            idempotencyKey: key("approve"),
          }),
        )
      ).creditNote;
    };
    const calculate = (period: { periodStart: string; periodEnd: string } = APR_MAY, adjustments?: unknown) =>
      asUser(viewer, (tx) => calculateGstReturn(tx, { ...period, adjustments }));
    const file = (
      fields: {
        periodStart?: string;
        periodEnd?: string;
        adjustments?: unknown;
        idempotencyKey?: string;
      } = {},
      user: SessionUser = admin,
    ) =>
      asUser(user, (tx) =>
        fileGstReturn(tx, {
          idempotencyKey: key("file"),
          ...APR_MAY,
          ...fields,
        }),
      );
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));
    return {
      org,
      asUser,
      kobe,
      paw,
      draftInvoice,
      invoice,
      bill,
      creditNote,
      supplierCreditNote,
      calculate,
      file,
      sql,
    };
  }

  /** G1: I1 (115.00) and B1 (230.00) in April 2026. */
  async function g1() {
    const world = await setup();
    const i1 = await world.invoice();
    const b1 = await world.bill();
    return { ...world, i1, b1 };
  }

  it("G1: I1 (standard, 115.00) and B1 (standard, 230.00) give Box 15 -15.00, a refund of 15.00", async () => {
    const world = await g1();
    const report = await world.calculate();
    expect(report).toMatchObject({
      ...APR_MAY,
      months: 2,
      basis: "invoice",
      currencyCode: "NZD",
      adjustments: [],
      filedReturns: [],
    });
    expect(report.boxes).toEqual({
      box5: "115.00",
      box6: "0.00",
      box7: "115.00",
      box8: "15.00",
      box9: "0.00",
      box10: "15.00",
      box11: "230.00",
      box12: "30.00",
      box13: "0.00",
      box14: "30.00",
      box15: "-15.00",
    });
    expect(report.gstOnTransactions).toEqual({
      sales: "15.00",
      purchases: "30.00",
      salesDifference: "0.00",
      purchasesDifference: "0.00",
    });
    // Drill-down: the lines in each box, with their document, contact, event, category, amount and GST.
    expect(report.lines).toEqual([
      {
        side: "sales",
        eventType: "invoice_approved",
        eventDate: "2026-04-10",
        documentType: "sales_invoice",
        documentId: world.i1.id,
        documentNumber: "INV-0001",
        reference: null,
        contactId: world.kobe.id,
        contactName: "Kobe Ltd",
        documentLineOrder: 1,
        description: "Consulting",
        taxCode: "GST",
        category: "standard",
        taxRate: "0.15",
        amount: "115.00",
        gst: "15.00",
        boxes: ["5"],
        settledAmount: null,
        documentTotal: null,
      },
      {
        side: "purchases",
        eventType: "bill_approved",
        eventDate: "2026-04-12",
        documentType: "bill",
        documentId: world.b1.id,
        documentNumber: "S-1",
        reference: null,
        contactId: world.paw.id,
        contactName: "Paw Supplies",
        documentLineOrder: 1,
        description: "Stationery",
        taxCode: "GST",
        category: "standard",
        taxRate: "0.15",
        amount: "230.00",
        gst: "30.00",
        boxes: ["11"],
        settledAmount: null,
        documentTotal: null,
      },
    ]);
  });

  it("G2: I5 (100.00 standard + 50.00 zero rated, exclusive, total 165.00) puts 165.00 in Box 5 and 50.00 in Box 6", async () => {
    const world = await setup();
    const i5 = await world.invoice({
      lines: [
        {
          description: "Standard",
          quantity: "1",
          unitPrice: "100.00",
          accountCode: "4000",
          taxCode: "GST",
        },
        {
          description: "Export",
          quantity: "1",
          unitPrice: "50.00",
          accountCode: "4000",
          taxCode: "ZERO",
        },
      ],
    });
    expect(i5.total).toBe("165.00");
    const report = await world.calculate();
    expect(report.boxes).toMatchObject({
      box5: "165.00",
      box6: "50.00",
      box7: "115.00",
      box8: "15.00",
      box15: "15.00",
    });
    expect(report.lines.map((line) => [line.description, line.category, line.amount, line.gst, line.boxes])).toEqual([
      ["Standard", "standard", "115.00", "15.00", ["5"]],
      ["Export", "zero_rated", "50.00", "0.00", ["5", "6"]],
    ]);
  });

  it("G3: no-tax and exempt sales lines, and exempt and zero-rated bill lines, are left out", async () => {
    const world = await setup();
    await world.invoice({
      amountsMode: "no_tax",
      lines: [
        {
          description: "Workshop",
          quantity: "1",
          unitPrice: "80.00",
          accountCode: "4000",
        },
      ],
    });
    await world.invoice({
      lines: [
        {
          description: "Residential rent",
          quantity: "1",
          unitPrice: "60.00",
          accountCode: "4000",
          taxCode: "EXEMPT",
        },
      ],
    });
    const b4 = await world.bill({
      lines: [
        {
          description: "Supplies",
          quantity: "1",
          unitPrice: "100.00",
          accountCode: "6010",
          taxCode: "GST",
        },
        {
          description: "Bank fees",
          quantity: "1",
          unitPrice: "20.00",
          accountCode: "6010",
          taxCode: "EXEMPT",
        },
      ],
    });
    expect(b4.total).toBe("135.00");
    await world.bill({
      lines: [
        {
          description: "Exported service",
          quantity: "1",
          unitPrice: "50.00",
          accountCode: "6010",
          taxCode: "ZERO",
        },
      ],
    });
    const report = await world.calculate();
    expect(report.boxes).toMatchObject({
      box5: "0.00",
      box6: "0.00",
      box8: "0.00",
      box11: "115.00",
      box12: "15.00",
    });
    expect(report.lines.map((line) => [line.description, line.category, line.amount, line.boxes])).toEqual([
      ["Workshop", "out_of_scope", "80.00", []],
      ["Residential rent", "exempt", "60.00", []],
      ["Supplies", "standard", "115.00", ["11"]],
      ["Bank fees", "exempt", "20.00", []],
      ["Exported service", "zero_rated", "50.00", []],
    ]);
  });

  it("G4: credit notes reduce Box 5 and Box 11; credit applications, payments and refunds change nothing", async () => {
    const world = await g1();
    const cn = await world.creditNote();
    expect(cn).toMatchObject({ creditNoteNumber: "CN-0001", total: "23.00" });
    const cr7 = await world.supplierCreditNote();
    expect(cr7.total).toBe("46.00");
    const report = await world.calculate();
    expect(report.boxes).toMatchObject({
      box5: "92.00",
      box8: "12.00",
      box11: "184.00",
      box12: "24.00",
      box15: "-12.00",
    });
    expect(
      report.lines
        .filter((line) => line.eventType.includes("credit_note"))
        .map((line) => [line.documentNumber, line.amount, line.gst]),
    ).toEqual([
      ["CN-0001", "-23.00", "-3.00"],
      ["CR-7", "-46.00", "-6.00"],
    ]);

    await world.asUser(bookkeeper, async (tx) => {
      await applyCreditNote(tx, cn.id, {
        idempotencyKey: key("apply"),
        applicationDate: "2026-04-20",
        applications: [{ invoiceId: world.i1.id, amount: "20.00" }],
      });
      await refundCreditNote(tx, cn.id, {
        idempotencyKey: key("refund"),
        refundDate: "2026-04-21",
        amount: "3.00",
        bankAccountCode: "1000",
      });
      await recordPayment(tx, world.i1.id, {
        idempotencyKey: key("pay"),
        paymentDate: "2026-04-22",
        amount: "95.00",
        bankAccountCode: "1000",
      });
      await applySupplierCreditNote(tx, cr7.id, {
        idempotencyKey: key("apply"),
        applicationDate: "2026-04-20",
        applications: [{ billId: world.b1.id, amount: "46.00" }],
      });
      await recordSupplierPayment(tx, world.b1.id, {
        idempotencyKey: key("pay"),
        paymentDate: "2026-04-23",
        amount: "184.00",
        bankAccountCode: "1000",
      });
      await postJournal(tx, {
        idempotencyKey: key("journal"),
        postingDate: "2026-04-24",
        reference: "Expense by hand",
        lines: [
          { accountCode: "6010", debitAmount: "5.00" },
          { accountCode: "1000", creditAmount: "5.00" },
        ],
      });
    });
    const after = await world.calculate();
    expect(after.boxes).toEqual(report.boxes);
    expect(after.lines).toEqual(report.lines);
  });

  it("G5: an invoice dated 31 Mar and voided 15 Apr counts in Feb-Mar and the other way in Apr-May; drafts and payments don't count", async () => {
    const world = await setup();
    const i1 = await world.invoice({ invoiceDate: "2026-03-31" });
    await world.asUser(bookkeeper, (tx) =>
      voidInvoice(tx, i1.id, {
        idempotencyKey: key("void"),
        voidDate: "2026-04-15",
      }),
    );
    const paid = await world.invoice({ invoiceDate: "2026-03-20" });
    await world.asUser(bookkeeper, (tx) =>
      recordPayment(tx, paid.id, {
        idempotencyKey: key("pay"),
        paymentDate: "2026-04-20",
        amount: "115.00",
        bankAccountCode: "1000",
      }),
    );
    await world.draftInvoice({ invoiceDate: "2026-04-25" });

    const febMar = await world.calculate({
      periodStart: "2026-02-01",
      periodEnd: "2026-03-31",
    });
    expect(febMar.boxes).toMatchObject({ box5: "230.00", box8: "30.00" });
    expect(
      febMar.lines
        .filter((line) => line.documentId === i1.id)
        .map((line) => [line.eventType, line.eventDate, line.amount]),
    ).toEqual([["invoice_approved", "2026-03-31", "115.00"]]);

    const aprMay = await world.calculate();
    expect(aprMay.boxes).toMatchObject({
      box5: "-115.00",
      box7: "-115.00",
      box8: "-15.00",
      box15: "-15.00",
    });
    expect(
      aprMay.lines.map((line) => [line.documentNumber, line.eventType, line.eventDate, line.amount, line.gst]),
    ).toEqual([["INV-0001", "invoice_voided", "2026-04-15", "-115.00", "-15.00"]]);
  });

  it("G5: voided credit notes, bills and supplier credit notes count the other way on their void dates", async () => {
    const world = await setup();
    const cn = await world.creditNote({ creditNoteDate: "2026-03-15" });
    const b1 = await world.bill({ billDate: "2026-03-10" });
    const cr7 = await world.supplierCreditNote({
      creditNoteDate: "2026-03-16",
    });
    await world.asUser(bookkeeper, async (tx) => {
      await voidCreditNote(tx, cn.id, {
        idempotencyKey: key("void"),
        voidDate: "2026-04-02",
      });
      await voidSupplierCreditNote(tx, cr7.id, {
        idempotencyKey: key("void"),
        voidDate: "2026-04-03",
      });
      await voidBill(tx, b1.id, {
        idempotencyKey: key("void"),
        voidDate: "2026-04-04",
      });
    });
    const febMar = await world.calculate({
      periodStart: "2026-02-01",
      periodEnd: "2026-03-31",
    });
    expect(febMar.boxes).toMatchObject({
      box5: "-23.00",
      box8: "-3.00",
      box11: "184.00",
      box12: "24.00",
    });
    const aprMay = await world.calculate();
    expect(aprMay.boxes).toMatchObject({
      box5: "23.00",
      box8: "3.00",
      box11: "-184.00",
      box12: "-24.00",
      box15: "27.00",
    });
    expect(aprMay.lines.map((line) => [line.eventType, line.eventDate, line.amount])).toEqual([
      ["credit_note_voided", "2026-04-02", "23.00"],
      ["supplier_credit_note_voided", "2026-04-03", "46.00"],
      ["bill_voided", "2026-04-04", "-230.00"],
    ]);
    // Approved and voided in the same period: the two events cancel out.
    const marApr = await world.calculate({
      periodStart: "2026-03-01",
      periodEnd: "2026-04-30",
    });
    expect(marApr.boxes).toEqual(ZERO_BOXES);
    expect(marApr.lines).toHaveLength(6);
  });

  it("G6: three invoices of 1 x 10.00 inclusive at 15% give Box 8 3.91 against GST on transactions of 3.90", async () => {
    const world = await setup();
    for (let index = 0; index < 3; index += 1) {
      const invoice = await world.invoice({
        amountsMode: "inclusive",
        lines: [
          {
            description: "Coffee",
            quantity: "1",
            unitPrice: "10.00",
            accountCode: "4000",
            taxCode: "GST",
          },
        ],
      });
      expect(invoice.taxTotal).toBe("1.30");
    }
    const report = await world.calculate();
    expect(report.boxes).toMatchObject({
      box5: "30.00",
      box7: "30.00",
      box8: "3.91",
    });
    expect(report.gstOnTransactions).toMatchObject({
      sales: "3.90",
      salesDifference: "0.01",
    });
  });

  it("G7: Box 9 and Box 13 adjustments update Box 10, 14 and 15; 0.00, -1.00 and 1.001 are refused", async () => {
    const world = await g1();
    const adjustments = [
      { box: "9", description: "Bad debt recovered", amount: "23.00" },
      { box: "13", description: "Bad debt written off", amount: "11.50" },
    ];
    const report = await world.calculate(APR_MAY, adjustments);
    expect(report.boxes).toMatchObject({
      box9: "23.00",
      box10: "38.00",
      box13: "11.50",
      box14: "41.50",
      box15: "-3.50",
    });
    expect(report.adjustments).toEqual(adjustments);
    for (const amount of ["0.00", "-1.00", "1.001"]) {
      await expect(world.calculate(APR_MAY, [{ box: "9", description: "Oops", amount }])).rejects.toThrow(
        /must not be zero|can't be negative|at most 2 decimal places/,
      );
      await expect(
        world.file({
          adjustments: [{ box: "13", description: "Oops", amount }],
        }),
      ).rejects.toThrow(/must not be zero|can't be negative|at most 2 decimal places/);
    }
    expect((await world.asUser(viewer, (tx) => listGstReturns(tx))).gstReturns).toEqual([]);
  });

  it("G8: filing stores the boxes, adjustments and lines; a retry returns the same return; overlaps are refused", async () => {
    const world = await g1();
    const adjustments = [{ box: "9", description: "Bad debt recovered", amount: "23.00" }];
    const idempotencyKey = key("file-g1");
    const filed = await world.file({ idempotencyKey, adjustments });
    expect(filed.created).toBe(true);
    expect(filed.gstReturn).toMatchObject({
      ...APR_MAY,
      months: 2,
      basis: "invoice",
      currencyCode: "NZD",
      filedByEmail: admin.email,
      adjustments,
      changedSinceFiled: false,
      changes: [],
      currentError: null,
    });
    expect(filed.gstReturn.boxes).toEqual({
      box5: "115.00",
      box6: "0.00",
      box7: "115.00",
      box8: "15.00",
      box9: "23.00",
      box10: "38.00",
      box11: "230.00",
      box12: "30.00",
      box13: "0.00",
      box14: "30.00",
      box15: "8.00",
    });
    expect(filed.gstReturn.lines.map((line) => [line.documentNumber, line.amount, line.boxes])).toEqual([
      ["INV-0001", "115.00", ["5"]],
      ["S-1", "230.00", ["11"]],
    ]);

    const retried = await world.file({ idempotencyKey, adjustments });
    expect(retried.created).toBe(false);
    expect(retried.gstReturn.id).toBe(filed.gstReturn.id);
    await expect(world.file({ idempotencyKey, adjustments: [] })).rejects.toThrow(
      /already used for a different GST return/,
    );

    for (const period of [
      { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
      { periodStart: "2026-03-01", periodEnd: "2026-04-30" },
      { periodStart: "2026-04-01", periodEnd: "2026-09-30" },
    ]) {
      await expect(world.file(period)).rejects.toThrow(/2026-04-01 to 2026-05-31 has already been filed/);
    }
    // The next period is fine.
    const next = await world.file({
      periodStart: "2026-06-01",
      periodEnd: "2026-07-31",
    });
    expect(next.gstReturn.boxes).toEqual(ZERO_BOXES);
    expect(next.gstReturn.lines).toEqual([]);

    const listed = await world.asUser(viewer, (tx) => listGstReturns(tx));
    expect(listed.gstReturns.map((entry) => [entry.periodStart, entry.periodEnd, entry.boxes.box15])).toEqual([
      ["2026-06-01", "2026-07-31", "0.00"],
      ["2026-04-01", "2026-05-31", "8.00"],
    ]);
    // Working the period out again shows the filed return that covers it.
    expect((await world.calculate()).filedReturns.map((entry) => entry.id)).toEqual([filed.gstReturn.id]);
    const audit = await world.sql(
      "select entity_id, actor_email from audit_events where event_type = 'gst_return.filed' order by id",
    );
    expect(audit.rows).toEqual([
      { entity_id: filed.gstReturn.id, actor_email: admin.email },
      { entity_id: next.gstReturn.id, actor_email: admin.email },
    ]);
  });

  it("G8: only admins and owners can file; a viewer or bookkeeper can't", async () => {
    const world = await g1();
    for (const user of [viewer, bookkeeper]) {
      const cookie = await sessionCookieFor(user);
      const response = await gstReturnsRoute.POST(
        apiRequest("/api/gst-returns", {
          method: "POST",
          cookie,
          body: {
            organisationId: world.org,
            idempotencyKey: key("file"),
            ...APR_MAY,
          },
        }),
        noContext,
      );
      expect(response.status).toBe(403);
    }
    expect((await world.sql("select count(*)::int as count from gst_returns")).rows).toEqual([{ count: 0 }]);
    expect((await world.file({}, owner)).created).toBe(true);
  });

  it("G8: after filing, approving a bill dated 10 May shows 'Changed since filed' with Box 11 and Box 12 filed vs current", async () => {
    const world = await g1();
    const idempotencyKey = key("file-g8");
    const { gstReturn: filed } = await world.file({ idempotencyKey });
    await world.bill({ billDate: "2026-05-10" });
    const now = await world.asUser(viewer, (tx) => getGstReturn(tx, filed.id));
    expect(now.boxes).toEqual(filed.boxes);
    expect(now.lines).toEqual(filed.lines);
    expect(now.changedSinceFiled).toBe(true);
    expect(now.current?.boxes).toMatchObject({
      box11: "460.00",
      box12: "60.00",
      box15: "-45.00",
    });
    expect(now.changes).toEqual([
      { box: "box11", filed: "230.00", current: "460.00" },
      { box: "box12", filed: "30.00", current: "60.00" },
      { box: "box14", filed: "30.00", current: "60.00" },
      { box: "box15", filed: "-15.00", current: "-45.00" },
    ]);
    // A retry of the filing still returns what was filed.
    const retried = await world.file({ idempotencyKey });
    expect(retried.created).toBe(false);
    expect(retried.gstReturn).toMatchObject({
      id: filed.id,
      boxes: filed.boxes,
      changedSinceFiled: true,
    });
  });

  it("G8: the database refuses to change, delete, truncate, add to or overlap filed returns", async () => {
    const world = await g1();
    const { gstReturn: filed } = await world.file({
      adjustments: [{ box: "13", description: "Imported goods", amount: "5.00" }],
    });
    for (const [statement, message] of [
      [`update gst_returns set box15 = 0 where id = ${filed.id}`, "can't be changed or deleted"],
      [`delete from gst_returns where id = ${filed.id}`, "can't be changed or deleted"],
      ["truncate gst_returns cascade", "can't be truncated"],
      [`update gst_return_lines set amount = 0 where gst_return_id = ${filed.id}`, "can't be changed or deleted"],
      [`delete from gst_return_lines where gst_return_id = ${filed.id}`, "can't be changed or deleted"],
      ["truncate gst_return_lines", "can't be truncated"],
      [`update gst_return_adjustments set amount = 1 where gst_return_id = ${filed.id}`, "can't be changed or deleted"],
      [`delete from gst_return_adjustments where gst_return_id = ${filed.id}`, "can't be changed or deleted"],
      ["truncate gst_return_adjustments", "can't be truncated"],
      [
        `insert into gst_return_adjustments (gst_return_id, line_order, box, description, amount) values (${filed.id}, 2, '9', 'Sneaky', 1)`,
        "can't be changed",
      ],
      [
        `insert into gst_return_lines (gst_return_id, line_order, side, event_type, event_date, document_type, document_id,
           document_number, contact_id, contact_name, document_line_order, description, category, tax_rate, amount,
           gst_amount, boxes)
         select gst_return_id, 3, side, event_type, event_date, document_type, document_id, document_number, contact_id,
                contact_name, document_line_order, description, category, tax_rate, amount, gst_amount, boxes
           from gst_return_lines where gst_return_id = ${filed.id} and line_order = 1`,
        "can't be changed",
      ],
    ] as const) {
      await expect(world.sql(statement), statement).rejects.toThrow(message);
    }
    const insertReturn = (periodStart: string, periodEnd: string, box5: string) =>
      world.sql(
        `insert into gst_returns (command_source, idempotency_key, request_hash, period_start, period_end, gst_basis,
                                  currency_code, box5, box6, box7, box8, box9, box10, box11, box12, box13, box14, box15,
                                  sales_gst, purchases_gst, adjustment_count, line_count, filed_by_email)
         values ('test', $1, 'x', $2, $3, 'invoice', 'NZD', $4::numeric, 0, $4::numeric, round($4::numeric * 3 / 23, 2),
                 0, round($4::numeric * 3 / 23, 2), 0, 0, 0, 0, round($4::numeric * 3 / 23, 2), 0, 0, 0, 0, 'x@example.com')`,
        [key("raw"), periodStart, periodEnd, box5],
      );
    // Overlapping by one day is refused by the exclusion constraint.
    await expect(insertReturn("2026-05-01", "2026-05-31", "0")).rejects.toMatchObject({ code: "23P01" });
    // Periods that aren't 1, 2 or 6 whole months are refused.
    await expect(insertReturn("2026-06-02", "2026-06-30", "0")).rejects.toMatchObject({ code: "23514" });
    await expect(insertReturn("2026-06-01", "2026-08-31", "0")).rejects.toMatchObject({ code: "23514" });
    // Boxes must add up to the return's lines at commit.
    await expect(insertReturn("2026-06-01", "2026-06-30", "115.00")).rejects.toThrow(/don't add up/);
    expect((await world.sql(`select box15::text from gst_returns where id = ${filed.id}`)).rows).toEqual([
      { box15: "-20.00" },
    ]);
  });

  it("G9: 1, 2 and 6 whole-month periods are allowed; other periods and other rates are refused", async () => {
    const world = await setup();
    for (const [periodStart, periodEnd, months] of [
      ["2026-04-01", "2026-04-30", 1],
      ["2026-04-01", "2026-05-31", 2],
      ["2026-04-01", "2026-09-30", 6],
    ] as const) {
      expect((await world.calculate({ periodStart, periodEnd })).months).toBe(months);
    }
    for (const [periodStart, periodEnd, message] of [
      ["2026-04-02", "2026-05-31", /starts on the 1st/],
      ["2026-04-01", "2026-06-30", /1, 2 or 6 whole months, not 3/],
      ["2026-04-01", "2026-05-15", /ends on the last day of a month/],
    ] as const) {
      await expect(world.calculate({ periodStart, periodEnd })).rejects.toThrow(message);
      await expect(world.file({ periodStart, periodEnd })).rejects.toThrow(message);
    }

    await world.asUser(owner, (tx) =>
      createTaxCode(tx, {
        idempotencyKey: key("tax"),
        code: "GST10",
        label: "GST 10%",
        category: "standard",
        rate: "0.10",
        effectiveFrom: "2026-01-01",
      }),
    );
    await world.invoice();
    await world.invoice({
      lines: [
        {
          description: "Odd rate",
          quantity: "1",
          unitPrice: "100.00",
          accountCode: "4000",
          taxCode: "GST10",
        },
      ],
    });
    await world.bill({
      lines: [
        {
          description: "Odd rate",
          quantity: "1",
          unitPrice: "100.00",
          accountCode: "6010",
          taxCode: "GST10",
        },
      ],
    });
    const refused =
      /at another rate: invoice INV-0002 \(Kobe Ltd\); bill S-1 \(Paw Supplies\)\. Other GST rates aren't supported yet\./;
    await expect(world.calculate()).rejects.toThrow(refused);
    await expect(world.file()).rejects.toThrow(refused);
    // Outside the period it doesn't matter.
    expect(
      (
        await world.calculate({
          periodStart: "2026-06-01",
          periodEnd: "2026-06-30",
        })
      ).boxes,
    ).toEqual(ZERO_BOXES);
    expect((await world.sql("select count(*)::int as count from gst_returns")).rows).toEqual([{ count: 0 }]);
  });

  it("over HTTP: viewers work returns out and read filed ones, admins file; retries are 200 and outsiders get 404", async () => {
    const world = await g1();
    const [adminCookie, viewerCookie, outsiderCookie] = await Promise.all(
      [admin, viewer, outsider].map((user) => sessionCookieFor(user)),
    );
    const query = `organisationId=${world.org}&periodStart=2026-04-01&periodEnd=2026-05-31`;
    const worked = await gstReturnReportRoute.GET(
      apiRequest(`/api/reports/gst-return?${query}`, { cookie: viewerCookie }),
      noContext,
    );
    expect(worked.status).toBe(200);
    expect(((await body(worked)).boxes as Record<string, string>).box15).toBe("-15.00");

    const adjustments = [{ box: "9", description: "Bad debt recovered", amount: "23.00" }];
    const calculated = await gstReturnReportRoute.POST(
      apiRequest("/api/reports/gst-return", {
        method: "POST",
        cookie: viewerCookie,
        body: { organisationId: world.org, ...APR_MAY, adjustments },
      }),
      noContext,
    );
    expect(calculated.status).toBe(200);
    expect(((await body(calculated)).boxes as Record<string, string>).box15).toBe("8.00");

    const badPeriod = await gstReturnReportRoute.GET(
      apiRequest(`/api/reports/gst-return?organisationId=${world.org}&periodStart=2026-04-01&periodEnd=2026-06-30`, {
        cookie: viewerCookie,
      }),
      noContext,
    );
    expect(badPeriod.status).toBe(400);

    const fileBody = {
      organisationId: world.org,
      source: "ui",
      idempotencyKey: key("http-file"),
      ...APR_MAY,
      adjustments,
    };
    const filed = await gstReturnsRoute.POST(
      apiRequest("/api/gst-returns", {
        method: "POST",
        cookie: adminCookie,
        body: fileBody,
      }),
      noContext,
    );
    expect(filed.status).toBe(201);
    const gstReturnId = ((await body(filed)).gstReturn as { id: string }).id;
    const retried = await gstReturnsRoute.POST(
      apiRequest("/api/gst-returns", {
        method: "POST",
        cookie: adminCookie,
        body: fileBody,
      }),
      noContext,
    );
    expect(retried.status).toBe(200);
    const reused = await gstReturnsRoute.POST(
      apiRequest("/api/gst-returns", {
        method: "POST",
        cookie: adminCookie,
        body: { ...fileBody, adjustments: [] },
      }),
      noContext,
    );
    expect(reused.status).toBe(409);
    const overlap = await gstReturnsRoute.POST(
      apiRequest("/api/gst-returns", {
        method: "POST",
        cookie: adminCookie,
        body: {
          ...fileBody,
          idempotencyKey: key("http-file"),
          periodStart: "2026-05-01",
          periodEnd: "2026-05-31",
        },
      }),
      noContext,
    );
    expect(overlap.status).toBe(409);

    const listed = await gstReturnsRoute.GET(
      apiRequest(`/api/gst-returns?organisationId=${world.org}`, {
        cookie: viewerCookie,
      }),
      noContext,
    );
    expect(listed.status).toBe(200);
    expect(((await body(listed)).gstReturns as Array<{ id: string }>).map((entry) => entry.id)).toEqual([gstReturnId]);
    const read = await gstReturnRoute.GET(
      apiRequest(`/api/gst-returns/${gstReturnId}?organisationId=${world.org}`, { cookie: viewerCookie }),
      params({ gstReturnId }),
    );
    expect(read.status).toBe(200);
    expect((await body(read)).gstReturn).toMatchObject({
      id: gstReturnId,
      changedSinceFiled: false,
      adjustments,
    });
    const missing = await gstReturnRoute.GET(
      apiRequest(`/api/gst-returns/999999?organisationId=${world.org}`, {
        cookie: viewerCookie,
      }),
      params({ gstReturnId: "999999" }),
    );
    expect(missing.status).toBe(404);

    for (const response of [
      await gstReturnReportRoute.GET(
        apiRequest(`/api/reports/gst-return?${query}`, {
          cookie: outsiderCookie,
        }),
        noContext,
      ),
      await gstReturnsRoute.GET(
        apiRequest(`/api/gst-returns?organisationId=${world.org}`, {
          cookie: outsiderCookie,
        }),
        noContext,
      ),
      await gstReturnsRoute.POST(
        apiRequest("/api/gst-returns", {
          method: "POST",
          cookie: outsiderCookie,
          body: { ...fileBody, idempotencyKey: key("x") },
        }),
        noContext,
      ),
    ]) {
      expect(response.status).toBe(404);
    }
    const signedOut = await gstReturnReportRoute.GET(apiRequest(`/api/reports/gst-return?${query}`), noContext);
    expect(signedOut.status).toBe(401);
  });

  it("migration 0009 upgrades an organisation database on 0008, keeping its data", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_gst_returns`;
    const adminClient = new pg.Client({ connectionString: testDatabaseUrl! });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    await adminClient.end();

    const client = new pg.Client({
      connectionString: withDb(testDatabaseUrl!, databaseName),
    });
    await client.connect();
    try {
      const before = tenantMigrations.filter((migration) => migration.version < "0009");
      expect((await applyMigrations(client, before, "test:upgrade")).applied).toEqual([
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
        "0008",
      ]);
      await client.query(
        `insert into organisation_settings (organisation_id, display_name, base_currency) values ('upgrade-co', 'Upgrade Co', 'NZD')`,
      );
      const upgraded = await applyMigrations(
        client,
        tenantMigrations.filter((migration) => migration.version <= "0009"),
        "test:upgrade",
      );
      expect(upgraded.applied).toEqual(["0009"]);
      expect((await client.query("select display_name, gst_basis from organisation_settings")).rows).toEqual([
        { display_name: "Upgrade Co", gst_basis: "invoice" },
      ]);
      for (const table of ["gst_returns", "gst_return_adjustments", "gst_return_lines"]) {
        expect((await client.query(`select count(*)::int as count from ${table}`)).rows).toEqual([{ count: 0 }]);
      }
    } finally {
      await client.end();
    }
  });
});

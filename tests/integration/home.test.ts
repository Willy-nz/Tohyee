import { afterAll, beforeAll, expect, it } from "vitest";
import * as homeRoute from "@/app/api/home/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listStatementLines, setStatementLineExcluded } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import { applyCreditNote } from "@/lib/credit-notes/applications";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, voidInvoice } from "@/lib/invoices/service";
import { fileGstReturn } from "@/lib/reports/gst-return";
import { getHomeSummary, type HomeSummary } from "@/lib/reports/home";
import { createTaxCode } from "@/lib/tax/codes";
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

const JUNE_1 = "2026-06-01";
const CSV = `Date,Amount,Payee,Particulars,Code,Reference
20/05/2026,115.00,KOBE LTD,INV-0001,,
21/05/2026,-46.00,Z ENERGY,,,
22/05/2026,-500.00,TRANSFER,SAVINGS,,
`;

/** Examples H1-H4 in docs/ACCOUNTING-EXAMPLES.md ("Home"). */
describeWithDatabase("Home", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("home-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("home-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `home-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: Parameters<typeof inOrganisation<T>>[2]) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const kobe = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true }))).contact;
    const paw = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paw Supplies", isSupplier: true }))).contact;
    const invoice = async (invoiceDate: string, dueDate: string, unitPrice: string, approve = true) => {
      const { invoice: draft } = await as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("invoice"),
          contactId: kobe.id,
          invoiceDate,
          dueDate,
          amountsMode: "exclusive",
          lines: [{ description: "Consulting", quantity: "1", unitPrice, accountCode: "4000", taxCode: "GST" }],
        }),
      );
      return approve ? (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }))).invoice : draft;
    };
    const bill = async (billDate: string, dueDate: string, lines: Array<{ unitPrice: string; taxCode: string }>) => {
      const { bill: draft } = await as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: paw.id,
          billDate,
          dueDate,
          supplierInvoiceNumber: key("S"),
          amountsMode: "exclusive",
          lines: lines.map((line) => ({ description: "Stationery", quantity: "1", accountCode: "6010", ...line })),
        }),
      );
      return (await as((tx) => approveBill(tx, draft.id, { idempotencyKey: key("approve") }))).bill;
    };
    const home = (today = JUNE_1) => as((tx) => getHomeSummary(tx, { today }));
    return { org, as, kobe, paw, invoice, bill, home };
  }

  it("H1: a card for each active bank account with its balances and what's left to reconcile", async () => {
    const world = await setup();
    await world.as((tx) => createBankAccount(tx, { code: "1010", name: "Savings", accountType: "bank" }));
    const before = await world.home();
    const bank = before.bankAccounts.find((account) => account.code === "1000")!;
    expect(bank).toMatchObject({ unreconciledCount: 0, statementBalance: null });
    await world.as((tx) =>
      importStatementFile(tx, bank.id, {
        idempotencyKey: key("import"),
        fileName: "statement.csv",
        fileBase64: Buffer.from(CSV).toString("base64"),
      }),
    );
    const lines = (await world.as((tx) => listStatementLines(tx, bank.id, { status: "all" }))).lines;
    await world.as((tx) => setStatementLineExcluded(tx, lines.find((line) => line.amount === "-500.00")!.id, true));
    const after = await world.home();
    // Excluded lines don't count: 2 of the 3 are left to reconcile.
    expect(after.bankAccounts.find((account) => account.code === "1000")).toMatchObject({
      unreconciledCount: 2,
      ledgerBalance: "0.00",
    });
    expect(after.bankAccounts.find((account) => account.code === "1010")).toMatchObject({ unreconciledCount: 0 });
    // Archived accounts aren't shown.
    await world.as((tx) => tx.query("update accounts set is_active = false where code = '1010'"));
    expect((await world.home()).bankAccounts.map((account) => account.code)).not.toContain("1010");
  });

  it("H2: money owed to you, with the overdue part; drafts, voids and applied credit handled", async () => {
    const world = await setup();
    const inv1 = await world.invoice("2026-05-10", "2026-06-20", "100.00");
    await world.as((tx) => recordPayment(tx, inv1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-20", amount: "50.00", bankAccountCode: "1000" }));
    await world.invoice("2026-04-10", "2026-05-10", "200.00");
    // Due today isn't overdue; drafts, voided and paid invoices don't count.
    const dueToday = await world.invoice("2026-05-01", JUNE_1, "10.00");
    await world.invoice("2026-05-01", "2026-05-02", "999.00", false);
    const voided = await world.invoice("2026-05-01", "2026-05-02", "50.00");
    await world.as((tx) => voidInvoice(tx, voided.id, { idempotencyKey: key("void"), voidDate: "2026-05-03" }));
    const paid = await world.invoice("2026-05-01", "2026-05-02", "20.00");
    await world.as((tx) => recordPayment(tx, paid.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-05", amount: "23.00", bankAccountCode: "1000" }));

    expect((await world.home()).owedToYou).toEqual({ total: "306.50", count: 3, overdueTotal: "230.00", overdueCount: 1 });

    // Without the invoice due today: exactly H2's 295.00 on 2, 230.00 overdue on 1.
    await world.as((tx) => recordPayment(tx, dueToday.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-20", amount: "11.50", bankAccountCode: "1000" }));
    expect((await world.home()).owedToYou).toEqual({ total: "295.00", count: 2, overdueTotal: "230.00", overdueCount: 1 });

    // Credit applied lowers what's owed; credit not yet applied doesn't.
    const { creditNote } = await world.as((tx) =>
      createCreditNote(tx, {
        idempotencyKey: key("cn"),
        contactId: world.kobe.id,
        creditNoteDate: "2026-05-25",
        amountsMode: "exclusive",
        lines: [{ description: "Discount", quantity: "1", unitPrice: "20.00", accountCode: "4000", taxCode: "GST" }],
      }),
    );
    const approved = (await world.as((tx) => approveCreditNote(tx, creditNote.id, { idempotencyKey: key("approve") }))).creditNote;
    expect((await world.home()).owedToYou.total).toBe("295.00");
    await world.as((tx) =>
      applyCreditNote(tx, approved.id, { idempotencyKey: key("apply"), applicationDate: "2026-05-26", applications: [{ invoiceId: inv1.id, amount: "23.00" }] }),
    );
    expect((await world.home()).owedToYou).toEqual({ total: "272.00", count: 2, overdueTotal: "230.00", overdueCount: 1 });
  });

  it("H3: bills to pay, less supplier payments, with the overdue part", async () => {
    const world = await setup();
    const b1 = await world.bill("2026-05-10", "2026-06-30", [{ unitPrice: "200.00", taxCode: "GST" }]);
    await world.as((tx) => recordSupplierPayment(tx, b1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-20", amount: "115.00", bankAccountCode: "1000" }));
    await world.bill("2026-05-01", "2026-05-20", [
      { unitPrice: "100.00", taxCode: "GST" },
      { unitPrice: "20.00", taxCode: "EXEMPT" },
    ]);
    expect((await world.home()).billsToPay).toEqual({ total: "250.00", count: 2, overdueTotal: "135.00", overdueCount: 1 });
  });

  it("H4: the next GST return follows the latest filed one, with its Box 15 so far; none filed says so", async () => {
    const world = await setup();
    expect((await world.home()).nextGstReturn).toEqual({ status: "none_filed" });
    await world.as((tx) => fileGstReturn(tx, { idempotencyKey: key("file"), periodStart: "2026-02-01", periodEnd: "2026-03-31" }));
    await world.invoice("2026-04-10", "2026-05-10", "100.00");
    await world.bill("2026-04-12", "2026-05-12", [{ unitPrice: "200.00", taxCode: "GST" }]);
    expect((await world.home()).nextGstReturn).toEqual({
      status: "ready",
      periodStart: "2026-04-01",
      periodEnd: "2026-05-31",
      basis: "invoice",
      box15: "-15.00",
    });

    // A one-month return filed last: the next one is one month too.
    const monthly = await setup();
    await monthly.as((tx) => fileGstReturn(tx, { idempotencyKey: key("file"), periodStart: "2026-04-01", periodEnd: "2026-04-30" }));
    expect((await monthly.home()).nextGstReturn).toMatchObject({ periodStart: "2026-05-01", periodEnd: "2026-05-31" });

    // A GST return that can't be worked out says why.
    await monthly.as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST10", label: "GST 10%", category: "standard", rate: "0.10", effectiveFrom: "2026-01-01" }),
    );
    const { invoice } = await monthly.as((tx) =>
      createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: monthly.kobe.id,
        invoiceDate: "2026-05-05",
        dueDate: "2026-05-30",
        amountsMode: "exclusive",
        lines: [{ description: "Odd rate", quantity: "1", unitPrice: "10.00", accountCode: "4000", taxCode: "GST10" }],
      }),
    );
    await monthly.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    const next = (await monthly.home()).nextGstReturn;
    expect(next.status).toBe("error");
    expect(next.status === "error" ? next.message : "").toMatch(/only handle standard-rated GST at 15%/);
  });

  it("viewers can open Home over the API", async () => {
    const world = await setup();
    const response = await homeRoute.GET(
      apiRequest(`/api/home?organisationId=${world.org}&today=${JUNE_1}`, { cookie: await sessionCookieFor(viewer) }),
      undefined as unknown,
    );
    expect(response.status).toBe(200);
    const summary = (await response.json()) as HomeSummary;
    expect(summary).toMatchObject({ today: JUNE_1, currencyCode: "NZD", owedToYou: { total: "0.00", count: 0 } });
    const badDate = await homeRoute.GET(
      apiRequest(`/api/home?organisationId=${world.org}&today=not-a-date`, { cookie: await sessionCookieFor(viewer) }),
      undefined as unknown,
    );
    expect(badDate.status).toBe(400);
  });
});

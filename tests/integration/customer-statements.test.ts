import { afterAll, beforeAll, expect, it } from "vitest";
import * as statementRoute from "@/app/api/reports/customer-statement/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact } from "@/lib/contacts/service";
import { refundCreditNote } from "@/lib/credit-notes/refunds";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, voidInvoice } from "@/lib/invoices/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { recordPaymentBatch, voidPaymentBatch } from "@/lib/payments/batches";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { type ActivityStatement, activityStatement, type OutstandingStatement, outstandingStatement } from "@/lib/reports/customer-statements";
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

/** Examples CST1-CST5 in docs/ACCOUNTING-EXAMPLES.md ("Customer statements"). Each test gets its own organisation. */
describeWithDatabase("customer statements", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("statements-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("statements-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  /** The setup of CST1-CST5. */
  async function setup() {
    organisations += 1;
    const org = `statements-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const contact = async (name: string, fields: Record<string, unknown>): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, ...fields }))).contact;
    const group = await contact("Kobe Group Ltd", { isCustomer: true, postalAddress: "1 Wharf St, Dunedin" });
    const auckland = await contact("Kobe Auckland", { isCustomer: true, parentContactId: group.id });
    const dunedin = await contact("Kobe Dunedin", { isCustomer: true, parentContactId: group.id });
    const paw = await contact("Paw Supplies", { isSupplier: true });
    const line = (amount: string) => ({ description: "Item", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "GST" });
    const invoice = async (contactId: string, amount: string, invoiceDate: string, dueDate: string) => {
      const draft = (
        await as((tx) => createInvoice(tx, { idempotencyKey: key("invoice"), contactId, invoiceDate, dueDate, amountsMode: "exclusive", lines: [line(amount)] }))
      ).invoice;
      return (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }))).invoice;
    };
    const pay = (invoiceId: string, amount: string, paymentDate: string) =>
      as((tx) => recordPayment(tx, invoiceId, { idempotencyKey: key("pay"), paymentDate, amount, bankAccountCode: "1000" }));

    const inv1 = await invoice(auckland.id, "200.00", "2026-05-15", "2026-06-15");
    const inv2 = await invoice(auckland.id, "100.00", "2026-06-01", "2026-07-01");
    await pay(inv1.id, "100.00", "2026-06-10");
    const draftCredit = (
      await as((tx) => createCreditNote(tx, { idempotencyKey: key("cn"), contactId: auckland.id, creditNoteDate: "2026-06-12", amountsMode: "exclusive", lines: [line("20.00")] }))
    ).creditNote;
    const cn1 = (await as((tx) => approveCreditNote(tx, draftCredit.id, { idempotencyKey: key("approve") }))).creditNote;
    const inv3 = await invoice(auckland.id, "50.00", "2026-06-15", "2026-07-15");
    await as((tx) => voidInvoice(tx, inv3.id, { idempotencyKey: key("void"), voidDate: "2026-06-20" }));
    const inv4 = await invoice(dunedin.id, "100.00", "2026-06-20", "2026-07-20");
    const overpaid = await pay(inv2.id, "125.00", "2026-06-25");
    expect(overpaid.payment.overpaymentAmount).toBe("10.00");
    await as((tx) => refundCreditNote(tx, cn1.id, { idempotencyKey: key("refund"), refundDate: "2026-06-28", amount: "11.50", bankAccountCode: "1000" }));
    return { org, as, group, auckland, dunedin, paw, invoice, inv1, inv2, inv4 };
  }

  const activityLines = (statement: ActivityStatement) =>
    statement.lines.map((l) => [l.date, l.description, l.amount, l.payment, l.balance]);

  it("CST1: Kobe Auckland's activity statement for June 2026", async () => {
    const w = await setup();
    const statement = await w.as((tx) => activityStatement(tx, { contactId: w.auckland.id, from: "2026-06-01", to: "2026-06-30" }));
    expect(statement.opening).toBe("230.00");
    expect(activityLines(statement)).toEqual([
      ["2026-06-01", "Invoice INV-0002", "115.00", "0.00", "345.00"],
      ["2026-06-10", "Payment on INV-0001", "0.00", "100.00", "245.00"],
      ["2026-06-12", "Credit note CN-0001", "0.00", "23.00", "222.00"],
      ["2026-06-15", "Invoice INV-0003", "57.50", "0.00", "279.50"],
      ["2026-06-20", "Invoice INV-0003 voided", "0.00", "57.50", "222.00"],
      ["2026-06-25", "Payment on INV-0002", "0.00", "125.00", "97.00"],
      ["2026-06-28", "Refund of credit note CN-0001", "11.50", "0.00", "108.50"],
    ]);
    expect([statement.totalAmount, statement.totalPayment, statement.closing]).toEqual(["184.00", "305.50", "108.50"]);
    expect(statement.ageing).toEqual({
      current: "0.00",
      days1to30: "130.00",
      days31to60: "0.00",
      days61to90: "0.00",
      over90: "0.00",
      credit: "21.50",
      total: "108.50",
    });
    expect(statement.lines[0].href).toBe(`/operations/invoices/${w.inv2.id}`);
    const aged = await w.as((tx) => agedReceivables(tx, { asAt: "2026-06-30" }));
    expect(aged.rows.find((r) => r.contactId === w.auckland.id)?.amounts.total).toBe("108.50");
  });

  it("CST2: Kobe Auckland's outstanding statement as at 30 June 2026", async () => {
    const w = await setup();
    const statement = await w.as((tx) => outstandingStatement(tx, { contactId: w.auckland.id, asAt: "2026-06-30" }));
    expect(statement.lines.map((l) => [l.type, l.number, l.original, l.outstanding, l.daysOverdue])).toEqual([
      ["invoice", "INV-0001", "230.00", "130.00", 15],
      ["credit_note", "CN-0001", "23.00", "-11.50", 0],
      ["overpayment", "Overpayment on INV-0002", "10.00", "-10.00", 0],
    ]);
    expect(statement.balance).toBe("108.50");
    expect([statement.ageing.days1to30, statement.ageing.credit, statement.ageing.total]).toEqual(["130.00", "21.50", "108.50"]);
    expect(statement.lines[2].href).toMatch(/^\/operations\/overpayments\/\d+$/);
  });

  it("CST3: a parent with its sub-customers, and on its own", async () => {
    const w = await setup();
    const rolled = await w.as((tx) => activityStatement(tx, { contactId: w.group.id, from: "2026-06-01", to: "2026-06-30", includeSubCustomers: true }));
    expect(rolled.customers.map((c) => c.name)).toEqual(["Kobe Group Ltd", "Kobe Auckland", "Kobe Dunedin"]);
    expect(rolled.customer).toMatchObject({ name: "Kobe Group Ltd", billingAddress: "1 Wharf St, Dunedin" });
    expect(rolled.opening).toBe("230.00");
    expect(rolled.lines.map((l) => [l.date, l.description, l.contactName, l.balance])).toEqual([
      ["2026-06-01", "Invoice INV-0002", "Kobe Auckland", "345.00"],
      ["2026-06-10", "Payment on INV-0001", "Kobe Auckland", "245.00"],
      ["2026-06-12", "Credit note CN-0001", "Kobe Auckland", "222.00"],
      ["2026-06-15", "Invoice INV-0003", "Kobe Auckland", "279.50"],
      ["2026-06-20", "Invoice INV-0004", "Kobe Dunedin", "394.50"],
      ["2026-06-20", "Invoice INV-0003 voided", "Kobe Auckland", "337.00"],
      ["2026-06-25", "Payment on INV-0002", "Kobe Auckland", "212.00"],
      ["2026-06-28", "Refund of credit note CN-0001", "Kobe Auckland", "223.50"],
    ]);
    expect(rolled.closing).toBe("223.50");
    expect([rolled.ageing.current, rolled.ageing.days1to30, rolled.ageing.credit, rolled.ageing.total]).toEqual(["115.00", "130.00", "21.50", "223.50"]);
    const aged = await w.as((tx) => agedReceivables(tx, { asAt: "2026-06-30", rollUp: true }));
    expect(aged.rows.find((r) => r.contactId === w.group.id)?.rolledUp?.total).toBe("223.50");
    const own = await w.as((tx) => activityStatement(tx, { contactId: w.group.id, from: "2026-06-01", to: "2026-06-30" }));
    expect([own.opening, own.lines.length, own.closing]).toEqual(["0.00", 0, "0.00"]);
  });

  it("CST4: a payment for several invoices, voided, is one line each way", async () => {
    const w = await setup();
    const inv5 = await w.invoice(w.dunedin.id, "50.00", "2026-07-01", "2026-07-31");
    const batch = await w.as((tx) =>
      recordPaymentBatch(tx, "customer", {
        idempotencyKey: key("receive"),
        paymentDate: "2026-07-05",
        amount: "172.50",
        bankAccountCode: "1000",
        documents: [
          { id: w.inv4.id, amount: "115.00" },
          { id: inv5.id, amount: "57.50" },
        ],
      }),
    );
    await w.as((tx) => voidPaymentBatch(tx, "customer", batch.batch.id, { idempotencyKey: key("void"), voidDate: "2026-07-08" }));
    const statement = await w.as((tx) => activityStatement(tx, { contactId: w.dunedin.id, from: "2026-07-01", to: "2026-07-31" }));
    expect(statement.opening).toBe("115.00");
    expect(activityLines(statement)).toEqual([
      ["2026-07-01", "Invoice INV-0005", "57.50", "0.00", "172.50"],
      ["2026-07-05", "Payment", "0.00", "172.50", "0.00"],
      ["2026-07-08", "Payment voided", "172.50", "0.00", "172.50"],
    ]);
    expect(statement.lines[1].href).toBe(`/operations/customer-payments/${batch.batch.id}`);
    expect([statement.closing, statement.ageing.current, statement.ageing.days1to30, statement.ageing.total]).toEqual(["172.50", "57.50", "115.00", "172.50"]);
  });

  it("CST5: refused for a supplier and for dates the wrong way round; viewers can open both kinds", async () => {
    const w = await setup();
    await expect(w.as((tx) => activityStatement(tx, { contactId: w.paw.id, from: "2026-06-01", to: "2026-06-30" }))).rejects.toThrow("isn't a customer");
    await expect(w.as((tx) => activityStatement(tx, { contactId: w.auckland.id, from: "2026-06-30", to: "2026-06-01" }))).rejects.toThrow(
      "on or before the end date",
    );
    const cookie = await sessionCookieFor(viewer);
    const activity = await statementRoute.GET(
      apiRequest(`/api/reports/customer-statement?organisationId=${w.org}&contactId=${w.group.id}&kind=activity&from=2026-06-01&to=2026-06-30&includeSubCustomers=true`, { cookie }),
      noContext,
    );
    expect(activity.status).toBe(200);
    expect(((await activity.json()) as ActivityStatement).closing).toBe("223.50");
    const outstanding = await statementRoute.GET(
      apiRequest(`/api/reports/customer-statement?organisationId=${w.org}&contactId=${w.auckland.id}&kind=outstanding&asAt=2026-06-30`, { cookie }),
      noContext,
    );
    expect(outstanding.status).toBe(200);
    expect(((await outstanding.json()) as OutstandingStatement).balance).toBe("108.50");
    const supplier = await statementRoute.GET(
      apiRequest(`/api/reports/customer-statement?organisationId=${w.org}&contactId=${w.paw.id}&kind=outstanding`, { cookie }),
      noContext,
    );
    expect(supplier.status).toBe(400);
  });
});

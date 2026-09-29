import { afterAll, beforeAll, expect, it } from "vitest";
import * as approveRoute from "@/app/api/invoices/[invoiceId]/approve/route";
import * as agedRoute from "@/app/api/reports/aged-receivables/route";
import * as termsRoute from "@/app/api/customers/payment-terms/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact, getContact, updateContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { createPerson, updatePerson } from "@/lib/crm/service";
import {
  createCustomerGroup,
  createPaymentTerm,
  createPriceLevel,
  customerBalance,
  getCustomerSetup,
  setCreditLimitAction,
  updateCustomerGroup,
  updatePaymentTerm,
  updatePriceLevel,
} from "@/lib/customers/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice, getInvoice, updateInvoice, voidInvoice } from "@/lib/invoices/service";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { type AgedReceivables, agedReceivables } from "@/lib/reports/aged-receivables";
import { balanceSheet } from "@/lib/reports/financial";
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
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;

/** Examples RC1-RC12 in docs/ACCOUNTING-EXAMPLES.md ("Richer customers"). Each test gets its own organisation. */
describeWithDatabase("richer customers", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { advanced?: boolean } = {}) {
    organisations += 1;
    const org = `cust-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    if (options.advanced !== false) await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const terms = (await as((tx) => getCustomerSetup(tx))).paymentTerms;
    const term = (name: string) => terms.find((t) => t.name === name)!.id;
    const customer = async (name: string, extra: Record<string, unknown> = {}): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, isCustomer: true, ...extra }))).contact;
    const line = (amount: string) => ({ description: "Item", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "GST" });
    const invoice = async (contactId: string, amount: string, extra: Record<string, unknown> = {}) =>
      (
        await as((tx) =>
          createInvoice(tx, {
            idempotencyKey: key("invoice"),
            contactId,
            invoiceDate: "2026-06-15",
            dueDate: "2026-07-15",
            amountsMode: "exclusive",
            lines: [line(amount)],
            ...extra,
          }),
        )
      ).invoice;
    const approve = (id: string) => as((tx) => approveInvoice(tx, id, { idempotencyKey: key("approve") }));
    const pay = (invoiceId: string, amount: string, paymentDate: string) =>
      as((tx) => recordPayment(tx, invoiceId, { idempotencyKey: key("pay"), paymentDate, amount, bankAccountCode: "1000" }));
    const creditNote = async (contactId: string, amount: string, creditNoteDate: string) => {
      const draft = (
        await as((tx) =>
          createCreditNote(tx, { idempotencyKey: key("cn"), contactId, creditNoteDate, amountsMode: "exclusive", lines: [line(amount)] }),
        )
      ).creditNote;
      return (await as((tx) => approveCreditNote(tx, draft.id, { idempotencyKey: key("approve") }))).creditNote;
    };
    return { org, as, term, customer, line, invoice, approve, pay, creditNote };
  }

  it("RC1: new invoices take their due date from the customer's payment terms", async () => {
    const w = await setup({ advanced: false });
    const kobe = await w.customer("Kobe Ltd", { paymentTermId: w.term("20th of the following month") });
    expect(kobe.paymentTermId).toBe(w.term("20th of the following month"));
    expect((await w.invoice(kobe.id, "10.00", { dueDate: undefined })).dueDate).toBe("2026-07-20");
    expect((await w.invoice(kobe.id, "10.00", { dueDate: "", invoiceDate: "2026-12-31" })).dueDate).toBe("2027-01-20");
    const typed = await w.invoice(kobe.id, "10.00", { dueDate: "2026-06-30" });
    expect(typed.dueDate).toBe("2026-06-30");
    expect((await w.as((tx) => updateInvoice(tx, typed.id, { dueDate: "2026-08-01" }))).dueDate).toBe("2026-08-01");

    const due = async (termName: string) => {
      await w.as((tx) => updateContact(tx, kobe.id, { paymentTermId: w.term(termName) }));
      return (await w.invoice(kobe.id, "10.00", { dueDate: null })).dueDate;
    };
    expect(await due("30 days")).toBe("2026-07-15");
    expect(await due("30 days after the end of the month")).toBe("2026-07-30");
    expect(await due("Due on receipt")).toBe("2026-06-15");
    const thirtyFirst = (await w.as((tx) => createPaymentTerm(tx, { name: "31st of the following month", kind: "day_of_next_month", days: 31 }))).paymentTerms.at(-1)!;
    await w.as((tx) => updateContact(tx, kobe.id, { paymentTermId: thirtyFirst.id }));
    expect((await w.invoice(kobe.id, "10.00", { dueDate: null, invoiceDate: "2026-01-10" })).dueDate).toBe("2026-02-28");

    const rata = await w.customer("Rata Ltd");
    await expect(w.invoice(rata.id, "10.00", { dueDate: null })).rejects.toThrow("no payment terms");

    // A retry with the same key returns the same invoice.
    const retryKey = key("retry");
    const first = await w.invoice(kobe.id, "10.00", { dueDate: null, idempotencyKey: retryKey });
    const again = await w.invoice(kobe.id, "10.00", { dueDate: null, idempotencyKey: retryKey });
    expect(again.id).toBe(first.id);
  });

  it("RC2: terms are unique, never deleted, archived; changes don't touch saved invoices", async () => {
    const w = await setup({ advanced: false });
    await expect(w.as((tx) => createPaymentTerm(tx, { name: "30 DAYS", kind: "days_after_invoice", days: 30 }))).rejects.toThrow(
      "There's already a payment term called 30 DAYS.",
    );
    await expect(w.as((tx) => createPaymentTerm(tx, { name: "Bad", kind: "day_of_next_month", days: 32 }))).rejects.toThrow("1 to 31");
    await expect(w.as((tx) => tx.query("delete from payment_terms where id = $1", [w.term("30 days")]))).rejects.toThrow(/can't be deleted/);
    const kobe = await w.customer("Kobe Ltd", { paymentTermId: w.term("30 days") });
    const saved = await w.invoice(kobe.id, "10.00", { dueDate: null });
    expect(saved.dueDate).toBe("2026-07-15");
    await w.as((tx) => updatePaymentTerm(tx, w.term("30 days"), { isActive: false }));
    await expect(w.customer("Rata Ltd", { paymentTermId: w.term("30 days") })).rejects.toThrow("30 days is archived.");
    expect((await w.as((tx) => getContact(tx, kobe.id))).paymentTermId).toBe(w.term("30 days"));
    await expect(w.invoice(kobe.id, "10.00", { dueDate: null })).rejects.toThrow("no payment terms");
    await w.as((tx) => updateContact(tx, kobe.id, { paymentTermId: w.term("7 days") }));
    expect((await w.as((tx) => getInvoice(tx, saved.id))).dueDate).toBe("2026-07-15");
    expect((await w.invoice(kobe.id, "10.00", { dueDate: null })).dueDate).toBe("2026-06-22");
  });

  it("RC3: over the credit limit with 'warn' approves and says so", async () => {
    const w = await setup();
    const kobe = await w.customer("Kobe Ltd", { creditLimit: "1000" });
    expect(kobe.creditLimit).toBe("1000.00");
    const a = await w.approve((await w.invoice(kobe.id, "500.00")).id);
    expect(a.creditWarning).toBeUndefined();
    expect(await w.as((tx) => customerBalance(tx, kobe.id))).toBe("575.00");
    const b = await w.approve((await w.invoice(kobe.id, "400.00")).id);
    expect(b.invoice.status).toBe("approved");
    expect(b.creditWarning).toBe(
      "Kobe Ltd owes 575.00, so this invoice for 460.00 takes them to 1035.00, 35.00 over their credit limit of 1000.00.",
    );
    const journal = await w.as((tx) => getJournal(tx, b.invoice.approvalJournalId!));
    expect(journal.lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount])).toEqual([
      ["1100", "460.00", "0.00"],
      ["4000", "0.00", "400.00"],
      ["2100", "0.00", "60.00"],
    ]);
    const history = await w.as((tx) =>
      tx.query<{ details: { creditLimitWarning?: string } }>("select details from audit_events where event_type = 'invoice.approved' and entity_id = $1", [b.invoice.id]),
    );
    expect(history.rows[0].details.creditLimitWarning).toContain("35.00 over");
  });

  it("RC4: 'block' refuses and uses no number; a payment makes room", async () => {
    const w = await setup();
    await w.as((tx) => setCreditLimitAction(tx, "block"));
    const kobe = await w.customer("Kobe Ltd", { creditLimit: "1000.00" });
    const a = (await w.approve((await w.invoice(kobe.id, "500.00")).id)).invoice;
    const b = await w.invoice(kobe.id, "400.00");
    await expect(w.approve(b.id)).rejects.toThrow(
      "Kobe Ltd owes 575.00, so this invoice for 460.00 takes them to 1035.00, 35.00 over their credit limit of 1000.00. Approving is blocked",
    );
    expect((await w.as((tx) => getInvoice(tx, b.id))).status).toBe("draft");
    await w.pay(a.id, "100.00", "2026-06-20");
    expect(await w.as((tx) => customerBalance(tx, kobe.id))).toBe("475.00");
    const approved = await w.approve(b.id);
    expect([approved.invoice.invoiceNumber, approved.creditWarning]).toEqual(["INV-0002", undefined]);
  });

  it("RC5: unused credit notes and overpayments count; exactly at the limit is fine", async () => {
    const w = await setup();
    await w.as((tx) => setCreditLimitAction(tx, "block"));
    const kobe = await w.customer("Kobe Ltd");
    await w.approve((await w.invoice(kobe.id, "500.00")).id);
    await w.creditNote(kobe.id, "100.00", "2026-06-16");
    const c = (await w.approve((await w.invoice(kobe.id, "500.00")).id)).invoice;
    await w.pay(c.id, "690.00", "2026-06-17");
    await w.as((tx) => updateContact(tx, kobe.id, { creditLimit: "804.99" }));
    expect(await w.as((tx) => customerBalance(tx, kobe.id))).toBe("345.00");
    const b = await w.invoice(kobe.id, "400.00");
    await expect(w.approve(b.id)).rejects.toThrow("takes them to 805.00, 0.01 over their credit limit of 804.99");
    await w.as((tx) => updateContact(tx, kobe.id, { creditLimit: "805" }));
    expect((await w.approve(b.id)).creditWarning).toBeUndefined();

    // No limit: nothing is checked.
    const rata = await w.customer("Rata Ltd");
    expect((await w.approve((await w.invoice(rata.id, "99999.00")).id)).creditWarning).toBeUndefined();
  });

  it("RC6: billing and delivery addresses; contact people with one primary", async () => {
    const w = await setup();
    const kobe = await w.customer("Kobe Ltd", { postalAddress: "PO Box 1\nDunedin 9054", deliveryAddress: "12 Wharf St, Dunedin 9016" });
    expect([kobe.postalAddress, kobe.deliveryAddress, kobe.primaryPerson]).toEqual(["PO Box 1\nDunedin 9054", "12 Wharf St, Dunedin 9016", null]);
    // Advanced reporting on, CRM off: people can still be managed.
    const aroha = await w.as((tx) =>
      createPerson(tx, { contactId: kobe.id, firstName: "Aroha", lastName: "Ngata", jobTitle: "Accounts", email: "aroha@kobe.nz", isPrimary: true }),
    );
    const ben = await w.as((tx) => createPerson(tx, { contactId: kobe.id, firstName: "Ben", phone: "021 555 0100" }));
    expect([aroha.isPrimary, ben.isPrimary]).toEqual([true, false]);
    expect((await w.as((tx) => getContact(tx, kobe.id))).primaryPerson).toEqual({ id: aroha.id, name: "Aroha Ngata", email: "aroha@kobe.nz" });
    await w.as((tx) => updatePerson(tx, ben.id, { isPrimary: true }));
    expect((await w.as((tx) => getContact(tx, kobe.id))).primaryPerson?.id).toBe(ben.id);
    await expect(w.as((tx) => createPerson(tx, { firstName: "Cara", isPrimary: true }))).rejects.toThrow("Only someone at a company");
    await expect(w.as((tx) => updatePerson(tx, aroha.id, { isArchived: true, isPrimary: true }))).rejects.toThrow("archived person");
    await w.as((tx) => updatePerson(tx, ben.id, { isArchived: true }));
    expect((await w.as((tx) => getContact(tx, kobe.id))).primaryPerson).toBeNull();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    await expect(w.as((tx) => createPerson(tx, { contactId: kobe.id, firstName: "Dan" }))).rejects.toThrow("The CRM is off");
  });

  it("RC7: customer groups and price levels; invoices unchanged", async () => {
    const w = await setup();
    await w.as((tx) => createCustomerGroup(tx, { name: "Retail" }));
    await w.as((tx) => createCustomerGroup(tx, { name: "Wholesale" }));
    await w.as((tx) => createPriceLevel(tx, { name: "Wholesale", markupPercent: "-10" }));
    const lists = await w.as((tx) => createPriceLevel(tx, { name: "Trade plus", markupPercent: "5" }));
    expect(lists.priceLevels.map((l) => [l.name, l.markupPercent])).toEqual([
      ["Trade plus", "5"],
      ["Wholesale", "-10"],
    ]);
    const group = lists.customerGroups.find((g) => g.name === "Wholesale")!.id;
    const level = lists.priceLevels.find((l) => l.name === "Wholesale")!.id;
    const kobe = await w.customer("Kobe Ltd", { customerGroupId: group, priceLevelId: level });
    expect([kobe.customerGroupId, kobe.priceLevelId]).toEqual([group, level]);
    expect((await w.invoice(kobe.id, "100.00")).total).toBe("115.00");
    await expect(w.as((tx) => createPriceLevel(tx, { name: "Free", markupPercent: "-100" }))).rejects.toThrow("less than 100%");
    await expect(w.as((tx) => createPriceLevel(tx, { name: "Huge", markupPercent: "1000.01" }))).rejects.toThrow("at most 1000%");
    await expect(w.as((tx) => createCustomerGroup(tx, { name: "retail" }))).rejects.toThrow("There's already a customer group called retail.");
    await w.as((tx) => updateCustomerGroup(tx, group, { isActive: false }));
    await w.as((tx) => updatePriceLevel(tx, level, { isActive: false }));
    await expect(w.customer("Rata Ltd", { customerGroupId: group })).rejects.toThrow("Wholesale is archived.");
    await expect(w.customer("Rata Ltd", { priceLevelId: level })).rejects.toThrow("Wholesale is archived.");
    const kept = await w.as((tx) => updateContact(tx, kobe.id, { phone: "03 555 0100" }));
    expect([kept.customerGroupId, kept.priceLevelId]).toEqual([group, level]);
    await expect(w.as((tx) => tx.query("delete from customer_groups where id = $1", [group]))).rejects.toThrow(/can't be deleted/);
    await expect(w.as((tx) => tx.query("delete from price_levels where id = $1", [level]))).rejects.toThrow(/can't be deleted/);
  });

  async function kobeTree(w: Awaited<ReturnType<typeof setup>>) {
    const group = await w.customer("Kobe Group Ltd");
    const auckland = await w.customer("Kobe Auckland", { parentContactId: group.id });
    const dunedin = await w.customer("Kobe Dunedin", { parentContactId: group.id });
    const mosgiel = await w.customer("Kobe Mosgiel", { parentContactId: dunedin.id });
    return { group, auckland, dunedin, mosgiel };
  }

  it("RC8: parent customers: no loops, at most 4 levels, parents are customers", async () => {
    const w = await setup();
    const t = await kobeTree(w);
    expect(t.mosgiel.parentContactId).toBe(t.dunedin.id);
    await expect(w.as((tx) => updateContact(tx, t.group.id, { parentContactId: t.mosgiel.id }))).rejects.toThrow("sub-customers");
    await expect(w.as((tx) => updateContact(tx, t.group.id, { parentContactId: t.group.id }))).rejects.toThrow("its own parent");
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("s"), name: "Supplies Ltd", isSupplier: true }))).contact;
    await expect(w.customer("Kobe Invercargill", { parentContactId: supplier.id })).rejects.toThrow("Supplies Ltd isn't a customer");
    const north = await w.customer("Kobe Mosgiel North", { parentContactId: t.mosgiel.id });
    await expect(w.customer("Kobe Mosgiel North East", { parentContactId: north.id })).rejects.toThrow("at most 4 levels");
    await expect(w.as((tx) => updateContact(tx, t.group.id, { isCustomer: false, isSupplier: true }))).rejects.toThrow("must stay a customer");
    // The database refuses a loop even without the app's check.
    await expect(w.as((tx) => tx.query("update contacts set parent_contact_id = $2 where id = $1", [t.group.id, t.mosgiel.id]))).rejects.toThrow(
      "under one of its own sub-customers",
    );
  });

  /** The documents of RC9-RC11. */
  async function receivables() {
    const w = await setup();
    const t = await kobeTree(w);
    const rata = await w.customer("Rata Ltd");
    const rataInvoice = (await w.approve((await w.invoice(rata.id, "400.00", { invoiceDate: "2026-03-01", dueDate: "2026-03-31" })).id)).invoice;
    const rataPayment = (await w.pay(rataInvoice.id, "60.00", "2026-04-10")).payment;
    await w.approve((await w.invoice(t.auckland.id, "300.00", { invoiceDate: "2026-05-01", dueDate: "2026-05-15" })).id);
    const voided = (await w.approve((await w.invoice(t.auckland.id, "100.00", { invoiceDate: "2026-05-01", dueDate: "2026-05-15" })).id)).invoice;
    await w.as((tx) => voidInvoice(tx, voided.id, { idempotencyKey: key("void"), voidDate: "2026-05-10" }));
    await w.creditNote(t.auckland.id, "20.00", "2026-06-01");
    await w.approve((await w.invoice(t.dunedin.id, "100.00", { invoiceDate: "2026-06-20", dueDate: "2026-07-20" })).id);
    await w.approve((await w.invoice(t.dunedin.id, "200.00", { invoiceDate: "2026-07-21", dueDate: "2026-08-20" })).id);
    await w.approve((await w.invoice(t.mosgiel.id, "100.00", { invoiceDate: "2026-08-05", dueDate: "2026-08-20" })).id);
    return { w, t, rata, rataInvoice, rataPayment };
  }

  const figures = (amounts: AgedReceivables["total"]) => [
    amounts.current,
    amounts.days1to30,
    amounts.days31to60,
    amounts.days61to90,
    amounts.over90,
    amounts.credit,
    amounts.total,
  ];

  it("RC9: aged receivables as at 31 July 2026 ties to accounts receivable", async () => {
    const { w } = await receivables();
    const report = await w.as((tx) => agedReceivables(tx, { asAt: "2026-07-31" }));
    expect(figures(report.total)).toEqual(["230.00", "115.00", "0.00", "345.00", "400.00", "23.00", "1067.00"]);
    expect(report.rows.map((r) => [r.name, r.amounts.total])).toEqual([
      ["Kobe Auckland", "322.00"],
      ["Kobe Dunedin", "345.00"],
      ["Rata Ltd", "400.00"],
    ]);
    expect(report.rows.find((r) => r.name === "Rata Ltd")!.invoices.map((i) => [i.daysOverdue, i.amountDue])).toEqual([[122, "400.00"]]);
    expect(report.rows.find((r) => r.name === "Kobe Auckland")!.invoices.map((i) => i.daysOverdue)).toEqual([77]);
    expect(report.rows.find((r) => r.name === "Kobe Dunedin")!.invoices.map((i) => i.daysOverdue)).toEqual([11, 0]);
    const sheet = await w.as((tx) => balanceSheet(tx, { asAt: "2026-07-31" }));
    const receivable = sheet.assets.sections.flatMap((s) => s.lines).find((l) => l.code === "1100");
    expect(receivable?.amount).toBe("1067.00");
  });

  it("RC10: rolled up, a parent shows itself and its subs", async () => {
    const { w, t } = await receivables();
    const report = await w.as((tx) => agedReceivables(tx, { asAt: "2026-07-31", rollUp: true }));
    expect(report.rows.map((r) => [r.name, r.depth, r.amounts.total, r.rolledUp?.total ?? null])).toEqual([
      ["Kobe Group Ltd", 0, "0.00", "667.00"],
      ["Kobe Auckland", 1, "322.00", null],
      ["Kobe Dunedin", 1, "345.00", null],
      ["Rata Ltd", 0, "400.00", null],
    ]);
    expect(figures(report.rows[0].rolledUp!)).toEqual(["230.00", "115.00", "0.00", "345.00", "0.00", "23.00", "667.00"]);
    expect(report.rows.some((r) => r.contactId === t.mosgiel.id)).toBe(false);
    expect(report.total.total).toBe("1067.00");
  });

  it("RC11: as at 30 June, and a payment voided later", async () => {
    const { w, rataInvoice, rataPayment } = await receivables();
    const june = await w.as((tx) => agedReceivables(tx, { asAt: "2026-06-30" }));
    expect(figures(june.total)).toEqual(["115.00", "0.00", "345.00", "0.00", "400.00", "23.00", "837.00"]);
    expect(june.rows.find((r) => r.name === "Kobe Auckland")!.invoices[0].daysOverdue).toBe(46);
    expect(june.rows.find((r) => r.name === "Rata Ltd")!.invoices[0].daysOverdue).toBe(91);
    await w.as((tx) => voidPayment(tx, rataInvoice.id, rataPayment.id, { idempotencyKey: key("void"), voidDate: "2026-08-10" }));
    const july = await w.as((tx) => agedReceivables(tx, { asAt: "2026-07-31" }));
    expect(july.rows.find((r) => r.name === "Rata Ltd")!.amounts.total).toBe("400.00");
    const august = await w.as((tx) => agedReceivables(tx, { asAt: "2026-08-10" }));
    expect(august.rows.find((r) => r.name === "Rata Ltd")!.amounts.total).toBe("460.00");
  });

  it("RC12: with Advanced reporting off, details are kept but not set or checked", async () => {
    const w = await setup();
    await w.as((tx) => setCreditLimitAction(tx, "block"));
    const group = (await w.as((tx) => createCustomerGroup(tx, { name: "Retail" }))).customerGroups[0].id;
    const parent = await w.customer("Kobe Group Ltd");
    const kobe = await w.customer("Kobe Ltd", { creditLimit: "100", customerGroupId: group, parentContactId: parent.id });
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    const kept = await w.as((tx) => updateContact(tx, kobe.id, { email: "a@kobe.nz" }));
    expect([kept.creditLimit, kept.customerGroupId, kept.parentContactId]).toEqual(["100.00", group, parent.id]);
    await expect(w.as((tx) => updateContact(tx, kobe.id, { creditLimit: "200" }))).rejects.toThrow("Advanced reporting is off");
    await expect(w.customer("Rata Ltd", { customerGroupId: group })).rejects.toThrow("Advanced reporting is off");
    await expect(w.as((tx) => createCustomerGroup(tx, { name: "Trade" }))).rejects.toThrow("Advanced reporting is off");
    expect((await w.approve((await w.invoice(kobe.id, "500.00")).id)).creditWarning).toBeUndefined();
    const withTerms = await w.customer("Rata Ltd", { paymentTermId: w.term("7 days"), deliveryAddress: "1 Main Rd" });
    expect((await w.invoice(withTerms.id, "10.00", { dueDate: null })).dueDate).toBe("2026-06-22");
    // Clearing a value is allowed with the setting off.
    expect((await w.as((tx) => updateContact(tx, kobe.id, { creditLimit: null }))).creditLimit).toBeNull();
  });

  it("over HTTP: approving returns the warning; viewers read the report; only admins add terms", async () => {
    const w = await setup();
    const kobe = await w.customer("Kobe Ltd", { creditLimit: "100" });
    const draft = await w.invoice(kobe.id, "100.00");
    const cookie = await sessionCookieFor(owner);
    const viewerCookie = await sessionCookieFor(viewer);
    const approved = await approveRoute.POST(
      apiRequest(`/api/invoices/${draft.id}/approve`, { method: "POST", cookie, body: { organisationId: w.org, idempotencyKey: key("a") } }),
      params({ invoiceId: draft.id }),
    );
    expect(approved.status).toBe(201);
    expect(((await approved.json()) as { creditWarning: string }).creditWarning).toContain("15.00 over their credit limit of 100.00");
    const report = await agedRoute.GET(apiRequest(`/api/reports/aged-receivables?organisationId=${w.org}&asAt=2026-07-31&rollUp=true`, { cookie: viewerCookie }), noContext);
    expect(report.status).toBe(200);
    expect(((await report.json()) as AgedReceivables).total.total).toBe("115.00");
    const body = { organisationId: w.org, name: "60 days", kind: "days_after_invoice", days: 60 };
    expect((await termsRoute.POST(apiRequest("/api/customers/payment-terms", { method: "POST", cookie: viewerCookie, body }), noContext)).status).toBe(403);
    expect((await termsRoute.POST(apiRequest("/api/customers/payment-terms", { method: "POST", cookie, body }), noContext)).status).toBe(201);
  });
});

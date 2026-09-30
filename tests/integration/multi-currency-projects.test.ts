import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { type Contact, createContact, updateContact } from "@/lib/contacts/service";
import { createOpportunity, listCompanies, listOpportunities, makeInvoiceFromOpportunity, updateOpportunity } from "@/lib/crm/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { approveInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  createProject,
  createTask,
  createTimeEntry,
  getProject,
  invoiceProject,
  linkProjectExpense,
  listExpenseSources,
  projectProfitability,
  setStaffRate,
  timeReport,
  updateProject,
  updateProjectExpense,
} from "@/lib/projects/service";
import { trialBalance } from "@/lib/reports/financial";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples MC61-MC70 in docs/ACCOUNTING-EXAMPLES.md (projects and CRM
 * opportunities in a foreign currency, not yet approved by Jess), one
 * organisation worked through in order: 1000, 1100, 4000, 6040; customers
 * Acme Inc (USD) and Harbour Cafe (NZD), supplier Paw Supplies (NZD); Jess's
 * staff cost rate NZD 40.00 an hour.
 */
describeWithDatabase("multi-currency projects and CRM", () => {
  let server: TestServer;
  let owner: SessionUser;
  const ORG = "mcp-co";
  let acme: Contact;
  let harbour: Contact;
  let paw: Contact;
  let yamato: Contact;
  let website: string;
  let cafe: string;
  let development: string;
  let setup: string;
  let hostingExpense: string;
  let firstInvoice: string;
  let retainer: string;
  let reprint: string;

  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const posted = async (journalId: string) =>
    (await run((tx) => getJournal(tx, journalId))).lines.map((line) => [
      line.accountCode,
      line.debitAmount,
      line.creditAmount,
      ...(line.foreign ? [`${line.foreign.currencyCode} ${line.foreign.amount} ${line.foreign.kind}`] : []),
    ]);
  const journals = async () => Number((await run((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
  const contact = async (name: string, fields: Record<string, unknown>) => (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...fields }))).contact;
  const project = async (name: string, contactId: string, estimate?: string) =>
    (await run((tx) => createProject(tx, { idempotencyKey: key("project"), name, contactId, estimate }))).project;
  const task = async (projectId: string, fields: Record<string, unknown>) =>
    (await run((tx) => createTask(tx, projectId, { idempotencyKey: key("task"), ...fields }))).taskId;
  const time = async (projectId: string, taskId: string, entryDate: string, hours: string, minutes = "0") =>
    (await run((tx) => createTimeEntry(tx, "owner", projectId, { idempotencyKey: key("time"), taskId, entryDate, hours, minutes, description: "Work" }))).entry;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("mcp-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    acme = await contact("Acme Inc", { isCustomer: true, currencyCode: "USD" });
    harbour = await contact("Harbour Cafe", { isCustomer: true });
    paw = await contact("Paw Supplies", { isSupplier: true });
    yamato = await contact("Yamato KK", { isCustomer: true, currencyCode: "JPY" });
    await run((tx) => setStaffRate(tx, "owner", { userId: owner.id, costRate: "40.00" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("MC61: a project is in its customer's currency, and the customer's currency is then fixed", async () => {
    const before = await journals();
    const site = await project("Website build", acme.id, "3000.00");
    const menu = await project("Cafe menu", harbour.id);
    website = site.id;
    cafe = menu.id;
    expect([site.currencyCode, site.estimate]).toEqual(["USD", "3000.00"]);
    expect(menu.currencyCode).toBe("NZD");
    expect(await journals()).toBe(before);
    await expect(run((tx) => updateContact(tx, acme.id, { currencyCode: "EUR" }))).rejects.toThrow(
      /Acme Inc has projects or CRM opportunities in USD, so its currency can't change/,
    );
    await expect(run((tx) => tx.query("update contacts set currency_code = 'EUR' where id = $1", [acme.id]))).rejects.toThrow(
      /has projects or opportunities, so its currency can't change/,
    );
    await expect(run((tx) => tx.query("update projects set currency_code = 'NZD' where id = $1", [website]))).rejects.toThrow(
      /This contact's documents are in USD, not NZD/,
    );
    await expect(run((tx) => tx.query("update projects set currency_code = null where id = $1", [website]))).rejects.toThrow();
  });

  it("MC62: rates and prices are in the project's currency; staff cost stays NZD", async () => {
    development = await task(website, { name: "Development", chargeType: "hourly", rate: "120.00" });
    setup = await task(website, { name: "Setup", chargeType: "fixed", rate: "500.00" });
    const entry = await time(website, development, "2026-07-01", "2", "30");
    expect([entry.minutes, entry.costRate, entry.cost]).toEqual([150, "40.00", "100.00"]);
    const site = await run((tx) => getProject(tx, website));
    expect([site.figures.unbilledTime, site.figures.unbilledFixed, site.figures.unbilled, site.figures.timeCost]).toEqual(["300.00", "500.00", "800.00", "100.00"]);
    const design = await task(cafe, { name: "Design", chargeType: "hourly", rate: "90.00" });
    await time(cafe, design, "2026-07-02", "1");
    const menu = await run((tx) => getProject(tx, cafe));
    expect([menu.figures.unbilled, menu.figures.costs]).toEqual(["90.00", "40.00"]);
  });

  it("MC63: expenses on a USD project are costs only", async () => {
    const { bill } = await run((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: paw.id,
        billDate: "2026-07-03",
        dueDate: "2026-07-20",
        supplierInvoiceNumber: "PS-1",
        amountsMode: "exclusive",
        lines: [{ description: "Hosting", quantity: "1", unitPrice: "50.00", accountCode: "6040", taxCode: "GST" }],
      }),
    );
    await run((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }));
    const line = (await run((tx) => listExpenseSources(tx))).find((source) => source.description === "Hosting")!;
    const before = await journals();
    await expect(
      run((tx) => linkProjectExpense(tx, website, { idempotencyKey: key("link"), sourceType: line.sourceType, lineId: line.lineId, chargeable: true })),
    ).rejects.toThrow(/Project Website build is in USD, and expense costs are in NZD\. Charging an expense on a USD project isn't supported yet/);
    await expect(
      run((tx) =>
        tx.query(
          `insert into project_expenses (command_source, idempotency_key, request_hash, project_id, source_type, bill_line_id, cost, chargeable)
           values ('test', 'mc63', 'x', $1, 'bill_line', $2, 50, true)`,
          [website, line.lineId],
        ),
      ),
    ).rejects.toThrow(/Expenses on a project in another currency can't be chargeable yet/);
    const linked = await run((tx) => linkProjectExpense(tx, website, { idempotencyKey: key("link"), sourceType: line.sourceType, lineId: line.lineId, chargeable: false }));
    hostingExpense = linked.expenseId;
    expect(linked.project.expenses.map((expense) => [expense.cost, expense.chargeable])).toEqual([["50.00", false]]);
    await expect(run((tx) => updateProjectExpense(tx, hostingExpense, { chargeable: true }))).rejects.toThrow(/Charging an expense on a USD project isn't supported yet/);
    expect(await journals()).toBe(before);
  });

  it("MC64: invoicing a USD project makes a USD invoice at a rate for its date", async () => {
    const everything = { invoiceDate: "2026-07-10", dueDate: "2026-08-20", accountCode: "4000", timeEntryIds: (await run((tx) => getProject(tx, website))).timeEntries.map((entry) => entry.id), taskIds: [setup] };
    await expect(run((tx) => invoiceProject(tx, website, { idempotencyKey: key("inv"), ...everything, taxCode: "GST", exchangeRate: "1.60" }))).rejects.toThrow(
      /GST on foreign-currency invoices, bills and credit notes isn't supported yet/,
    );
    await expect(run((tx) => invoiceProject(tx, website, { idempotencyKey: key("inv"), ...everything, taxCode: "ZERO" }))).rejects.toThrow(
      /Type the exchange rate for this invoice \(NZD per 1 USD\): no USD rate has been used on or before 2026-07-10 yet/,
    );
    expect((await run((tx) => getProject(tx, website))).figures.unbilled).toBe("800.00");
    const idempotencyKey = key("inv");
    const { invoice, project: site } = await run((tx) => invoiceProject(tx, website, { idempotencyKey, ...everything, taxCode: "ZERO", exchangeRate: "1.60" }));
    expect(invoice).toMatchObject({ status: "draft", currencyCode: "USD", exchangeRate: "1.6", subtotal: "800.00", taxTotal: "0.00", total: "800.00", baseTotal: "1280.00" });
    expect(invoice.lines.map((line) => [line.description, line.quantity, line.unitPrice, line.lineAmount, line.baseNetAmount])).toEqual([
      ["Development (2 h 30 min)", "2.5", "120", "300.00", "480.00"],
      ["Setup", "1", "500", "500.00", "800.00"],
    ]);
    expect(site.figures.unbilled).toBe("0.00");
    const again = await run((tx) => invoiceProject(tx, website, { idempotencyKey, ...everything, taxCode: "ZERO", exchangeRate: "1.60" }));
    expect([again.created, again.invoice.id]).toEqual([false, invoice.id]);
    const approved = await run((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    firstInvoice = approved.invoice.id;
    expect(await posted(approved.invoice.approvalJournalId!)).toEqual([
      ["1100", "1280.00", "0.00", "USD 800.00 document"],
      ["4000", "0.00", "1280.00"],
    ]);
  });

  it("MC65: with no rate typed, a project invoice takes the rate a new invoice for its date starts with", async () => {
    const entry = await time(website, development, "2026-07-12", "1");
    const { invoice } = await run((tx) =>
      invoiceProject(tx, website, { idempotencyKey: key("inv"), invoiceDate: "2026-07-20", dueDate: "2026-08-20", accountCode: "4000", taxCode: "ZERO", timeEntryIds: [entry.id] }),
    );
    expect(invoice).toMatchObject({ currencyCode: "USD", exchangeRate: "1.6", subtotal: "120.00", baseTotal: "192.00" });
    expect(invoice.lines.map((line) => [line.description, line.lineAmount])).toEqual([["Development (1 h)", "120.00"]]);
    const approved = await run((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    expect(await posted(approved.invoice.approvalJournalId!)).toEqual([
      ["1100", "192.00", "0.00", "USD 120.00 document"],
      ["4000", "0.00", "192.00"],
    ]);
  });

  it("MC66: profitability is NZD for costs and profit, the project's currency for what's charged", async () => {
    const site = await run((tx) => getProject(tx, website));
    expect(site.invoices.map((invoice) => [invoice.subtotal, invoice.baseSubtotal, invoice.exchangeRate])).toEqual([
      ["800.00", "1280.00", "1.6"],
      ["120.00", "192.00", "1.6"],
    ]);
    expect(site.figures).toMatchObject({
      invoiced: "920.00",
      invoicedBase: "1472.00",
      timeCost: "140.00",
      expenseCost: "50.00",
      costs: "190.00",
      profit: "1282.00",
      unbilled: "0.00",
      estimateLeft: "2080.00",
    });
    const report = await run((tx) => projectProfitability(tx));
    expect(report.projects.map((p) => [p.name, p.currencyCode, p.figures.invoicedBase, p.figures.costs, p.figures.profit, p.figures.unbilled]).sort()).toEqual([
      ["Cafe menu", "NZD", "0.00", "40.00", "-40.00", "90.00"],
      ["Website build", "USD", "1472.00", "190.00", "1282.00", "0.00"],
    ]);
    expect(report.totals).toMatchObject({ invoicedBase: "1472.00", invoiced: "0.00", costs: "230.00", profit: "1242.00", unbilled: "90.00" });
    expect(report.otherCurrencies).toEqual([
      expect.objectContaining({ currencyCode: "USD", invoiced: "920.00", unbilled: "0.00", onDraftInvoices: "0.00" }),
    ]);
    const tb = await run((tx) => trialBalance(tx, { asAt: "2026-07-31" }));
    expect(tb.rows.find((row) => row.code === "4000")).toMatchObject({ credit: "1472.00" });
    const times = await run((tx) => timeReport(tx, { from: "2026-07-01", to: "2026-07-31" }));
    expect([times.totalMinutes, times.totalCost]).toEqual([270, "180.00"]);
  });

  it("MC67: a project's currency is fixed once it has anything on it", async () => {
    await expect(run((tx) => updateProject(tx, website, { contactId: harbour.id }))).rejects.toThrow(/has invoices, so its customer can't change/);
    const discovery = await project("Discovery", acme.id);
    await task(discovery.id, { name: "Workshop", chargeType: "fixed", rate: "200.00" });
    await expect(run((tx) => updateProject(tx, discovery.id, { contactId: harbour.id }))).rejects.toThrow(
      /Project Discovery has tasks, time or expenses in USD, so it can't move to a customer in NZD/,
    );
    await expect(
      run((tx) => tx.query("update projects set contact_id = $2, currency_code = 'NZD' where id = $1", [discovery.id, harbour.id])),
    ).rejects.toThrow(/has tasks, time, expenses or invoices in USD, so its currency can't change/);
    const scoping = await project("Scoping", acme.id);
    expect(scoping.currencyCode).toBe("USD");
    const moved = await run((tx) => updateProject(tx, scoping.id, { contactId: harbour.id }));
    expect([moved.contactName, moved.currencyCode]).toEqual(["Harbour Cafe", "NZD"]);
  });

  it("MC68: an opportunity is in its company's currency, and the pipeline totals each currency on its own", async () => {
    await run((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const annual = await run((tx) => createOpportunity(tx, { name: "Annual retainer", contactId: acme.id, amount: "2000.00", stage: "new" }));
    const menu = await run((tx) => createOpportunity(tx, { name: "Menu reprint", contactId: harbour.id, amount: "500.00", stage: "new" }));
    retainer = annual.id;
    reprint = menu.id;
    expect([annual.currencyCode, annual.amount, menu.currencyCode, menu.amount]).toEqual(["USD", "2000.00", "NZD", "500.00"]);
    const byCurrency = (await run((tx) => listOpportunities(tx)))
      .filter((o) => o.stage === "new")
      .reduce<Record<string, number>>((sums, o) => ({ ...sums, [o.currencyCode]: (sums[o.currencyCode] ?? 0) + Number(o.amount) }), {});
    expect(byCurrency).toEqual({ NZD: 500, USD: 2000 });
    const companies = await run((tx) => listCompanies(tx));
    expect(companies.find((c) => c.name === "Acme Inc")).toMatchObject({ currencyCode: "USD", openPipeline: "2000.00" });
    expect(companies.find((c) => c.name === "Harbour Cafe")).toMatchObject({ currencyCode: "NZD", openPipeline: "500.00" });
    const movedAway = await run((tx) => updateOpportunity(tx, reprint, { contactId: acme.id }));
    expect([movedAway.currencyCode, movedAway.amount]).toEqual(["USD", "500.00"]);
    const movedBack = await run((tx) => updateOpportunity(tx, reprint, { contactId: harbour.id }));
    expect(movedBack.currencyCode).toBe("NZD");
    await expect(run((tx) => createOpportunity(tx, { name: "Paw prints", contactId: yamato.id, amount: "1000.50" }))).rejects.toThrow(
      /The amount is in JPY, which has no cents, so it must be a whole number/,
    );
    const yen = await run((tx) => createOpportunity(tx, { name: "Paw prints", contactId: yamato.id, amount: "1000" }));
    expect([yen.currencyCode, yen.amount]).toEqual(["JPY", "1000.00"]);
    await expect(run((tx) => tx.query("update crm_opportunities set currency_code = 'NZD' where id = $1", [retainer]))).rejects.toThrow(
      /This contact's documents are in USD, not NZD/,
    );
  });

  it("MC69: a won opportunity's invoice is in its company's currency, zero-rated", async () => {
    const before = await journals();
    await run((tx) => updateOpportunity(tx, retainer, { stage: "won" }));
    const { created, invoice } = await run((tx) => makeInvoiceFromOpportunity(tx, retainer));
    expect(created).toBe(true);
    expect(invoice).toMatchObject({ status: "draft", currencyCode: "USD", exchangeRate: "1.6", invoiceDate: todayIsoDate(), subtotal: "2000.00", total: "2000.00", baseTotal: "3200.00" });
    expect(invoice.lines.map((line) => [line.description, line.accountCode, line.taxCode, line.lineAmount])).toEqual([["Annual retainer", "4000", "ZERO", "2000.00"]]);
    const again = await run((tx) => makeInvoiceFromOpportunity(tx, retainer));
    expect([again.created, again.invoice.id]).toEqual([false, invoice.id]);
    await expect(run((tx) => updateOpportunity(tx, retainer, { contactId: harbour.id }))).rejects.toThrow(/has made an invoice, so its company can't change/);
    await expect(run((tx) => tx.query("update crm_opportunities set contact_id = $2, currency_code = 'NZD' where id = $1", [retainer, harbour.id]))).rejects.toThrow(
      /has made an invoice, so its company and currency can't change/,
    );
    const logo = await run((tx) => createOpportunity(tx, { name: "Logo licence", contactId: acme.id, amount: "100.00", stage: "won" }));
    const typed = await run((tx) => makeInvoiceFromOpportunity(tx, logo.id, { exchangeRate: "1.58" }));
    expect(typed.invoice).toMatchObject({ currencyCode: "USD", exchangeRate: "1.58", total: "100.00", baseTotal: "158.00" });
    await run((tx) => updateOpportunity(tx, reprint, { stage: "won" }));
    await expect(run((tx) => makeInvoiceFromOpportunity(tx, reprint, { exchangeRate: "1.2" }))).rejects.toThrow(
      /This opportunity is in NZD, so its invoice has no exchange rate/,
    );
    const nzd = await run((tx) => makeInvoiceFromOpportunity(tx, reprint));
    expect(nzd.invoice).toMatchObject({ currencyCode: "NZD", exchangeRate: null, subtotal: "500.00", taxTotal: "75.00", total: "575.00" });
    expect(nzd.invoice.lines[0].taxCode).toBe("GST");
    expect(await journals()).toBe(before);

    // An organisation with no USD rate used yet: the rate must be typed.
    const other = "mcp-other-co";
    await createTestOrganisation(owner, other);
    const inOther = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(other, { userId: owner.id, email: owner.email }, work);
    await inOther((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const buyer = (await inOther((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Acme Inc", isCustomer: true, currencyCode: "USD" }))).contact;
    const deal = await inOther((tx) => createOpportunity(tx, { name: "Retainer", contactId: buyer.id, amount: "10.00", stage: "won" }));
    await expect(inOther((tx) => makeInvoiceFromOpportunity(tx, deal.id))).rejects.toThrow(/Type the exchange rate for this invoice \(NZD per 1 USD\)/);
  });

  it("MC70: what's refused rather than guessed", async () => {
    await expect(project("Paw prints", yamato.id)).rejects.toThrow(/Yamato KK is in JPY, which has no cents\. Projects in JPY aren't supported yet/);
    const before = await journals();
    const extras = await project("Extras", acme.id);
    const extra = await task(extras.id, { name: "Extra", chargeType: "fixed", rate: "50.00" });
    await run((tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    try {
      await expect(
        run((tx) => invoiceProject(tx, extras.id, { idempotencyKey: key("inv"), invoiceDate: "2026-07-25", dueDate: "2026-08-20", accountCode: "4000", taxCode: "ZERO", taskIds: [extra], exchangeRate: "1.6" })),
      ).rejects.toThrow(/Foreign-currency invoices aren't supported yet while sales count for GST when they're paid/);
      const deal = await run((tx) => createOpportunity(tx, { name: "Extra work", contactId: acme.id, amount: "10.00", stage: "won" }));
      await expect(run((tx) => makeInvoiceFromOpportunity(tx, deal.id))).rejects.toThrow(/Foreign-currency invoices aren't supported yet while sales count for GST when they're paid/);
    } finally {
      await run((tx) => updateOrganisationSettings(tx, { gstBasis: "invoice" }));
    }
    expect((await run((tx) => getProject(tx, extras.id))).figures.unbilled).toBe("50.00");
    expect(await journals()).toBe(before);
    expect(firstInvoice).toBeTruthy();
    expect(hostingExpense).toBeTruthy();
  });
});

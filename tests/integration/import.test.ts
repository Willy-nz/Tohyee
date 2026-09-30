import { afterAll, beforeAll, expect, it } from "vitest";
import * as conversionRoute from "@/app/api/import/conversion/route";
import * as exportRoute from "@/app/api/import/export/route";
import * as readRoute from "@/app/api/import/read/route";
import * as recordsRoute from "@/app/api/import/records/route";
import { listAccounts } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { parseDelimited } from "@/lib/bank/formats/table";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, suggestionsForLine } from "@/lib/bank/reconcile";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { getBill, listBills } from "@/lib/bills/service";
import { createContact, listContacts } from "@/lib/contacts/service";
import { createCustomField } from "@/lib/custom-fields/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { applyMapping, autoMap, findHeaderRow, type ImportKind, type ImportRecord } from "@/lib/import/fields";
import { conversionStatus, importConversion } from "@/lib/import/conversion";
import { exportCsv, importMasterRecords } from "@/lib/import/service";
import { createItem, listItems } from "@/lib/items/service";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice, listInvoices } from "@/lib/invoices/service";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { bankReconciliationReport } from "@/lib/reports/bank-reconciliation";
import { agedPayables } from "@/lib/reports/aged-payables";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { activityStatement } from "@/lib/reports/customer-statements";
import { inventoryValuation, trialBalance } from "@/lib/reports/financial";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { salesBySalesperson } from "@/lib/reports/sales-by-salesperson";
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

/** A CSV file as the import screen would read it: rows of cells. */
function csv(text: string): string[][] {
  return parseDelimited(text.trim());
}

/** Maps a file's rows the way the import screen does (headings matched automatically). */
function mapped(kind: ImportKind, text: string, preset: "tohyee" | "other_system" = "tohyee"): ImportRecord[] {
  const rows = csv(text);
  const headerRow = findHeaderRow(kind, rows);
  const headings = rows[headerRow];
  return applyMapping(rows, headerRow, autoMap(kind, headings, preset));
}

const TRIAL_BALANCE = `Account code,Account,Debit,Credit
1000,Business bank account,12450.00,
1100,Accounts receivable,1725.00,
1400,Inventory,810.00,
1600,Office equipment,3000.00,
2000,Accounts payable,,460.00
2100,GST,,1380.00
3000,Owner funds introduced,,10000.00
3200,Retained earnings,,6145.00
,Total,17985.00,17985.00`;

const OPEN_INVOICES = `Invoice number,Customer,Invoice date,Due date,Amount due
INV-0107,Kobe Ltd,15/03/2026,20/04/2026,1150.00
INV-0112,Harbour Cafe,28/03/2026,20/04/2026,575.00`;

const OPEN_BILLS = `Invoice number,Supplier,Bill date,Due date,Amount due
K-311,Kauri Supplies,20/03/2026,20/04/2026,460.00`;

/** IM17: the same open invoices and bill with the GST in what's still owed. */
const OPEN_INVOICES_GST = `Invoice number,Customer,Invoice date,Due date,Amount due,GST
INV-0107,Kobe Ltd,15/03/2026,20/04/2026,1150.00,150.00
INV-0112,Harbour Cafe,28/03/2026,20/04/2026,575.00,75.00`;

const OPEN_BILLS_GST = `Invoice number,Supplier,Bill date,Due date,Amount due,GST
K-311,Kauri Supplies,20/03/2026,20/04/2026,460.00,60.00`;

const STOCK = `Item code,Quantity,Value
MUG,40,800.00
VASE,3,10.00`;

/**
 * Examples IM1-IM16 in docs/ACCOUNTING-EXAMPLES.md ("Bringing in existing
 * books"). Each example gets its own organisation, Tui Traders Ltd, with the
 * starting chart of accounts.
 */
describeWithDatabase("bringing in existing books", () => {
  let server: TestServer;
  let owner: SessionUser;
  let admin: SessionUser;
  let bookkeeper: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    admin = await createTestUser("admin@example.com");
    bookkeeper = await createTestUser("bookkeeper@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { people?: boolean; items?: boolean } = {}) {
    organisations += 1;
    const org = `tui-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [admin, "admin"],
      [bookkeeper, "bookkeeper"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const contacts: Record<string, string> = {};
    if (options.people !== false) {
      for (const [name, flags] of [
        ["Kobe Ltd", { isCustomer: true }],
        ["Harbour Cafe", { isCustomer: true }],
        ["Kauri Supplies", { isSupplier: true }],
      ] as const) {
        contacts[name] = (await asUser(admin, (tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...flags }))).contact.id;
      }
    }
    if (options.items !== false) {
      for (const code of ["MUG", "VASE"]) {
        await asUser(admin, (tx) => createItem(tx, { idempotencyKey: key("item"), code, name: code, itemType: "stock" }));
      }
    }
    const conversion = (files: { tb?: string; invoices?: string; bills?: string; stock?: string } = {}, commit = true, idempotencyKey = key("conversion")) =>
      asUser(admin, (tx) =>
        importConversion(
          tx,
          {
            idempotencyKey,
            conversionDate: "2026-03-31",
            trialBalance: mapped("trial_balance", files.tb ?? TRIAL_BALANCE),
            openInvoices: mapped("open_invoices", files.invoices ?? OPEN_INVOICES),
            openBills: mapped("open_bills", files.bills ?? OPEN_BILLS),
            stock: mapped("stock", files.stock ?? STOCK),
          },
          commit,
        ),
      );
    const master = (kind: "accounts" | "contacts" | "items", text: string, commit = true, extra: Record<string, unknown> = {}) =>
      asUser(admin, (tx) =>
        importMasterRecords(tx, {
          kind,
          records: mapped(kind, text, (extra.preset as "tohyee" | "other_system" | undefined) ?? "other_system"),
          idempotencyKey: key("import"),
          commit,
          options: extra.options,
        }),
      );
    const tb = async (asAt: string) =>
      Object.fromEntries(
        (await asUser(admin, (tx) => trialBalance(tx, { asAt }))).rows.map((row) => [row.code, row.debit !== "0.00" ? `${row.debit} Dr` : `${row.credit} Cr`]),
      );
    const journalLines = async (journalId: string) =>
      (await asUser(admin, (tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    const count = async (sql: string) => Number((await asUser(admin, (tx) => tx.query<{ n: string }>(`select count(*)::text as n from ${sql}`))).rows[0].n);
    return { org, asUser, contacts, conversion, master, tb, journalLines, count };
  }

  it("IM1, IM6: opening balances post through 3900 Opening balance: the opening journal, invoices, bill and stock", async () => {
    const world = await setup();
    // IM1: it's in the starting chart, equity.
    const clearing = (await world.asUser(admin, (tx) => listAccounts(tx))).find((account) => account.code === "3900")!;
    expect(clearing).toMatchObject({ name: "Opening balance", accountType: "equity", accountClass: "equity", systemKey: "conversion_clearing" });
    const check = await world.conversion({}, false);
    expect(check).toMatchObject({ ok: true, committed: false, problems: [] });
    expect(check.plan.clearingAccountCode).toBe("3900");
    expect(check.plan.skipped).toEqual([expect.objectContaining({ kind: "trial_balance", row: 10 })]);
    expect(await world.count("ledger_journals")).toBe(0);

    const posted = await world.conversion();
    expect(posted).toMatchObject({ ok: true, committed: true });
    expect(await world.count("accounts where system_key = 'conversion_clearing'")).toBe(1);

    const journal = await world.asUser(admin, (tx) => getJournal(tx, posted.journalId!));
    expect(journal).toMatchObject({ origin: "opening_balance", postingDate: "2026-03-31", reference: "OPENING", totalDebit: "17985.00" });
    expect(await world.journalLines(posted.journalId!)).toEqual([
      ["1000", "12450.00", "0.00"],
      ["3900", "1725.00", "0.00"],
      ["3900", "810.00", "0.00"],
      ["1600", "3000.00", "0.00"],
      ["3900", "0.00", "460.00"],
      ["2100", "0.00", "1380.00"],
      ["3000", "0.00", "10000.00"],
      ["3200", "0.00", "6145.00"],
    ]);

    const invoices = (await world.asUser(admin, (tx) => listInvoices(tx))).invoices;
    const inv107 = invoices.find((invoice) => invoice.invoiceNumber === "INV-0107")!;
    expect(inv107).toMatchObject({
      status: "approved",
      isOpeningBalance: true,
      invoiceDate: "2026-03-15",
      dueDate: "2026-04-20",
      total: "1150.00",
      taxTotal: "0.00",
      amountDue: "1150.00",
      contactName: "Kobe Ltd",
    });
    const full = await world.asUser(admin, (tx) => getInvoice(tx, inv107.id));
    expect(full.lines).toEqual([expect.objectContaining({ description: "Owed at 2026-03-31 (opening balance)", accountCode: "3900", taxCode: null, lineAmount: "1150.00" })]);
    expect(await world.journalLines(inv107.approvalJournalId!)).toEqual([
      ["1100", "1150.00", "0.00"],
      ["3900", "0.00", "1150.00"],
    ]);
    const inv112 = invoices.find((invoice) => invoice.invoiceNumber === "INV-0112")!;
    expect(await world.journalLines(inv112.approvalJournalId!)).toEqual([
      ["1100", "575.00", "0.00"],
      ["3900", "0.00", "575.00"],
    ]);
    expect((await world.asUser(admin, (tx) => getJournal(tx, inv112.approvalJournalId!))).postingDate).toBe("2026-03-31");

    const bill = (await world.asUser(admin, (tx) => listBills(tx))).bills[0];
    expect(bill).toMatchObject({ supplierInvoiceNumber: "K-311", status: "approved", isOpeningBalance: true, total: "460.00", billDate: "2026-03-20" });
    expect(await world.journalLines(bill.approvalJournalId!)).toEqual([
      ["3900", "460.00", "0.00"],
      ["2000", "0.00", "460.00"],
    ]);

    const stock = await world.asUser(admin, (tx) => inventoryValuation(tx));
    expect(stock.items.map((item) => [item.itemCode, item.quantity, item.value])).toEqual([
      ["MUG", "40", "800.00"],
      ["VASE", "3", "10.00"],
    ]);
    const movements = await world.asUser(admin, (tx) =>
      tx.query<{ item_code: string; unit_cost: string; value_delta: string; offset: string }>(
        "select m.item_code, m.unit_cost::text, m.value_delta::text, a.code as offset from inventory_movements m join accounts a on a.id = m.offset_account_id order by m.id",
      ),
    );
    expect(movements.rows).toEqual([
      { item_code: "MUG", unit_cost: "20", value_delta: "800.00", offset: "3900" },
      expect.objectContaining({ item_code: "VASE", value_delta: "10.00", offset: "3900" }),
    ]);
  });

  it("IM7: the trial balance at the conversion date is the imported one, 3900 is 0.00, and the period can be locked", async () => {
    const world = await setup();
    await world.conversion();
    expect(await world.tb("2026-03-31")).toEqual({
      "1000": "12450.00 Dr",
      "1100": "1725.00 Dr",
      "1400": "810.00 Dr",
      "1600": "3000.00 Dr",
      "2000": "460.00 Cr",
      "2100": "1380.00 Cr",
      "3000": "10000.00 Cr",
      "3200": "6145.00 Cr",
    });
    const status = await world.asUser(admin, (tx) => conversionStatus(tx));
    expect(status).toMatchObject({ matches: true, clearingBalance: "0.00", locked: false, conversion: { conversionDate: "2026-03-31", invoiceCount: 2, billCount: 1, stockCount: 2 } });
    expect(status.lines.find((line) => line.code === "1100")).toMatchObject({ imported: "1725.00", inTohyee: "1725.00", difference: "0.00" });
    expect(status.lines.find((line) => line.code === "3900")).toMatchObject({ imported: "0.00", inTohyee: "0.00" });

    const aged = await world.asUser(admin, (tx) => agedReceivables(tx, { asAt: "2026-03-31" }));
    expect(aged.rows.map((row) => [row.name, row.amounts.current])).toEqual([
      ["Harbour Cafe", "575.00"],
      ["Kobe Ltd", "1150.00"],
    ]);
    expect(aged.total.total).toBe("1725.00");
    const payables = await world.asUser(admin, (tx) => agedPayables(tx, { asAt: "2026-03-31" }));
    expect(payables.total.total).toBe("460.00");
    expect(payables.payablesAccount).toMatchObject({ balance: "460.00", difference: "0.00" });
    const stock = await world.asUser(admin, (tx) => inventoryValuation(tx));
    expect(stock).toMatchObject({ totalValue: "810.00", inventoryAccountBalance: "810.00" });

    await world.asUser(admin, (tx) => updatePeriodControls(tx, { lockDate: "2026-03-31" }));
    expect((await world.asUser(admin, (tx) => conversionStatus(tx))).locked).toBe(true);
    await expect(
      world.asUser(admin, (tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate: "2026-03-31",
          reference: "LATE",
          lines: [
            { accountCode: "1000", debitAmount: "1.00" },
            { accountCode: "3000", creditAmount: "1.00" },
          ],
        }),
      ),
    ).rejects.toThrow("locked period");
  });

  it("IM8: accounts receivable, payable and inventory must equal the open invoices, bills and stock", async () => {
    const world = await setup();
    const receivables = await world.conversion({ invoices: OPEN_INVOICES.replace("575.00", "500.00") });
    expect(receivables).toMatchObject({ ok: false, committed: false });
    expect(receivables.problems).toEqual([
      {
        kind: "trial_balance",
        row: 3,
        message:
          "Accounts receivable (1100) is 1725.00 in the trial balance, but the open invoices add up to 1650.00: a difference of 75.00. They have to be equal, since the open invoices are what make up the balance.",
      },
    ]);
    const payables = await world.conversion({ bills: OPEN_BILLS.replace("460.00", "450.00") });
    expect(payables.problems[0].message).toContain("Accounts payable (2000) is 460.00 in the trial balance, but the open bills add up to 450.00");
    const stock = await world.conversion({ stock: STOCK.replace("VASE,3,10.00", "VASE,3,9.99") });
    expect(stock.problems[0].message).toContain("Inventory (1400) is 810.00 in the trial balance, but the stock values add up to 809.99");
    expect(await world.count("ledger_journals")).toBe(0);
    expect(await world.count("sales_invoices")).toBe(0);
  });

  it("IM9: an unbalanced trial balance is refused, showing the difference", async () => {
    const world = await setup();
    const result = await world.conversion({ tb: TRIAL_BALANCE.replace(",6145.00", ",6110.00") });
    expect(result.ok).toBe(false);
    expect(result.plan).toMatchObject({ totalDebit: "17985.00", totalCredit: "17950.00", difference: "35.00" });
    expect(result.problems.map((problem) => problem.message)).toContain(
      "The trial balance doesn't balance: debits 17985.00, credits 17950.00, a difference of 35.00. Opening balances have to balance exactly.",
    );
    // Rows are named: an unknown account, and a figure that isn't an amount.
    const bad = await world.conversion({ tb: `${TRIAL_BALANCE.replace("1600,Office equipment", "1690,Mystery")}\n6000,Advertising,abc,` });
    expect(bad.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "trial_balance", row: 5, message: expect.stringContaining("no account with the code 1690") }),
        expect.objectContaining({ kind: "trial_balance", row: 11, message: expect.stringContaining('"abc" isn\'t an amount') }),
      ]),
    );
    expect(await world.count("ledger_journals")).toBe(0);
  });

  it("IM10: opening invoices keep their numbers; Tohyee's numbering passes over them", async () => {
    const world = await setup();
    const invoices = OPEN_INVOICES.replace("INV-0107", "INV-0001");
    await world.conversion({ invoices });
    const drafted = await world.asUser(admin, (tx) =>
      createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: world.contacts["Kobe Ltd"],
        invoiceDate: "2026-04-10",
        dueDate: "2026-04-20",
        amountsMode: "exclusive",
        lines: [{ description: "Mugs", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
      }),
    );
    const approved = await world.asUser(admin, (tx) => approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("approve") }));
    expect(approved.invoice.invoiceNumber).toBe("INV-0002");

    // IM14: nothing may be posted on or before the conversion date already.
    const again = await setup();
    await again.asUser(admin, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("journal"),
        postingDate: "2026-03-15",
        reference: "EARLY",
        lines: [
          { accountCode: "1000", debitAmount: "10.00" },
          { accountCode: "3000", creditAmount: "10.00" },
        ],
      }),
    );
    const clash = await again.conversion({ invoices });
    expect(clash.problems).toEqual([
      expect.objectContaining({ row: 0, message: expect.stringContaining("Something is already posted on or before 2026-03-31 (EARLY on 2026-03-15)") }),
    ]);
    // An April invoice doesn't stop a 31 March conversion, but INV-0001 is taken.
    const later = await setup();
    await later.asUser(admin, async (tx) => {
      const draft = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: later.contacts["Kobe Ltd"],
        invoiceDate: "2026-04-02",
        dueDate: "2026-04-20",
        amountsMode: "no_tax",
        lines: [{ description: "Mugs", quantity: "1", unitPrice: "10.00", accountCode: "4000" }],
      });
      await approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") });
    });
    const taken = await later.conversion({ invoices });
    expect(taken.problems).toEqual([expect.objectContaining({ kind: "open_invoices", row: 2, message: "There's already an invoice numbered INV-0001 in Tohyee." })]);
  });

  it("IM11: opening invoices and bills stay out of the first GST return and sales by salesperson", async () => {
    const world = await setup();
    await world.conversion();
    const i1 = await world.asUser(admin, async (tx) => {
      const draft = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: world.contacts["Harbour Cafe"],
        invoiceDate: "2026-04-10",
        dueDate: "2026-04-20",
        amountsMode: "exclusive",
        lines: [{ description: "Mugs", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
      });
      return (await approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") })).invoice;
    });
    const inv107 = (await world.asUser(admin, (tx) => listInvoices(tx))).invoices.find((invoice) => invoice.invoiceNumber === "INV-0107")!;
    await world.asUser(admin, (tx) =>
      recordPayment(tx, inv107.id, { idempotencyKey: key("pay"), paymentDate: "2026-04-20", amount: "1150.00", bankAccountCode: "1000" }),
    );
    const aprMay = await world.asUser(admin, (tx) => calculateGstReturn(tx, { periodStart: "2026-04-01", periodEnd: "2026-05-31" }));
    expect(aprMay.boxes).toMatchObject({ box5: "115.00", box8: "15.00", box11: "0.00", box15: "15.00" });
    expect(aprMay.lines.map((line) => line.documentNumber)).toEqual([i1.invoiceNumber]);
    const febMar = await world.asUser(admin, (tx) => calculateGstReturn(tx, { periodStart: "2026-02-01", periodEnd: "2026-03-31" }));
    expect(febMar.boxes).toMatchObject({ box5: "0.00", box11: "0.00", box15: "0.00" });
    expect(febMar.lines).toEqual([]);
    expect((await world.tb("2026-05-31"))["2100"]).toBe("1395.00 Cr");
    const sales = await world.asUser(admin, (tx) => salesBySalesperson(tx, { from: "2026-03-01", to: "2026-05-31" }));
    expect(JSON.stringify(sales)).not.toContain("INV-0107");
    expect(JSON.stringify(sales)).toContain(i1.invoiceNumber!);

    // With GST columns, on the invoice basis: that GST was returned before the conversion, so paying still counts nothing.
    const withGst = await setup();
    await withGst.conversion({ invoices: OPEN_INVOICES_GST, bills: OPEN_BILLS_GST });
    const opening = (await withGst.asUser(admin, (tx) => listInvoices(tx))).invoices.find((invoice) => invoice.invoiceNumber === "INV-0107")!;
    expect(opening.taxTotal).toBe("150.00");
    await withGst.asUser(admin, (tx) =>
      recordPayment(tx, opening.id, { idempotencyKey: key("pay"), paymentDate: "2026-04-20", amount: "1150.00", bankAccountCode: "1000" }),
    );
    expect((await withGst.asUser(admin, (tx) => calculateGstReturn(tx, { periodStart: "2026-04-01", periodEnd: "2026-05-31" }))).lines).toEqual([]);
    expect((await withGst.asUser(admin, (tx) => conversionStatus(tx))).gst).toMatchObject({ openInvoicesReturnedWhenPaid: false, fromReturns: "1380.00" });
  });

  it("IM12: opening invoices and bills are paid later like any other; aged reports and statements show them", async () => {
    const world = await setup();
    await world.conversion();
    const invoices = (await world.asUser(admin, (tx) => listInvoices(tx))).invoices;
    const inv107 = invoices.find((invoice) => invoice.invoiceNumber === "INV-0107")!;
    const paid = await world.asUser(admin, (tx) =>
      recordPayment(tx, inv107.id, { idempotencyKey: key("pay"), paymentDate: "2026-04-20", amount: "1150.00", bankAccountCode: "1000" }),
    );
    expect(await world.journalLines(paid.payment.journalId)).toEqual([
      ["1000", "1150.00", "0.00"],
      ["1100", "0.00", "1150.00"],
    ]);
    expect((await world.asUser(admin, (tx) => getInvoice(tx, inv107.id))).paidStatus).toBe("paid");
    const bill = (await world.asUser(admin, (tx) => listBills(tx))).bills[0];
    const billPaid = await world.asUser(admin, (tx) =>
      recordSupplierPayment(tx, bill.id, { idempotencyKey: key("pay"), paymentDate: "2026-04-22", amount: "460.00", bankAccountCode: "1000" }),
    );
    expect(await world.journalLines(billPaid.payment.journalId)).toEqual([
      ["2000", "460.00", "0.00"],
      ["1000", "0.00", "460.00"],
    ]);
    expect((await world.asUser(admin, (tx) => getBill(tx, bill.id))).paidStatus).toBe("paid");

    const aged = await world.asUser(admin, (tx) => agedReceivables(tx, { asAt: "2026-04-30" }));
    expect(aged.rows.map((row) => [row.name, row.amounts.total, row.invoices[0].daysOverdue])).toEqual([["Harbour Cafe", "575.00", 10]]);
    const statement = await world.asUser(admin, (tx) =>
      activityStatement(tx, { contactId: world.contacts["Kobe Ltd"], from: "2026-04-01", to: "2026-04-30" }),
    );
    expect(statement).toMatchObject({ opening: "1150.00", closing: "0.00" });
    expect((await world.tb("2026-04-30"))["1100"]).toBe("575.00 Dr");
  });

  it("IM13: where GST counts when paid, open invoices and bills need their GST; elsewhere it's optional", async () => {
    const world = await setup();
    await world.asUser(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    const payments = await world.conversion({}, false);
    // (Accounts receivable and payable then don't tie either, since those rows are refused.)
    expect(payments.problems.filter((problem) => problem.kind !== "trial_balance").map((problem) => [problem.kind, problem.row, problem.message.slice(0, 40)])).toEqual([
      ["open_bills", 2, "Bill K-311 needs its GST: this organisat"],
      ["open_invoices", 2, "Invoice INV-0107 needs its GST: this org"],
      ["open_invoices", 3, "Invoice INV-0112 needs its GST: this org"],
    ]);
    expect(payments.problems.find((problem) => problem.kind === "open_invoices")!.message).toBe(
      "Invoice INV-0107 needs its GST: this organisation accounts for GST on sales when they're paid (the payments basis), so the GST in what's still owed is returned when it's paid. Map a GST column (0.00 if there's none) or a GST code.",
    );
    expect((await world.conversion({ invoices: OPEN_INVOICES_GST, bills: OPEN_BILLS_GST }, false)).problems).toEqual([]);
    await world.asUser(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "hybrid" }));
    const hybrid = await world.conversion({}, false);
    expect(hybrid.problems.filter((problem) => problem.kind !== "trial_balance").map((problem) => problem.kind)).toEqual(["open_bills"]);
    await world.asUser(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "invoice" }));
    expect((await world.conversion({}, false)).problems).toEqual([]);
    expect(await world.count("ledger_journals")).toBe(0);
  });

  it("IM17: a payments-basis conversion: open documents carry their GST, posted as IM6, and the GST account splits", async () => {
    const world = await setup();
    await world.asUser(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    const posted = await world.conversion({ invoices: OPEN_INVOICES_GST, bills: OPEN_BILLS_GST });
    expect(posted).toMatchObject({ ok: true, committed: true, problems: [] });
    expect(posted.plan.invoices.map((invoice) => [invoice.number, invoice.amount, invoice.gst])).toEqual([
      ["INV-0107", "1150.00", "150.00"],
      ["INV-0112", "575.00", "75.00"],
    ]);
    const expectedGst = {
      basis: "payments",
      accountCode: "2100",
      balance: "1380.00",
      openInvoices: "225.00",
      openInvoicesReturnedWhenPaid: true,
      openBills: "60.00",
      openBillsClaimedWhenPaid: true,
      fromReturns: "1215.00",
    };
    expect(posted.plan.gst).toEqual(expectedGst);

    const invoices = (await world.asUser(admin, (tx) => listInvoices(tx))).invoices;
    const inv107 = invoices.find((invoice) => invoice.invoiceNumber === "INV-0107")!;
    expect(inv107).toMatchObject({ isOpeningBalance: true, amountsMode: "inclusive", subtotal: "1000.00", taxTotal: "150.00", total: "1150.00", amountDue: "1150.00" });
    const full = await world.asUser(admin, (tx) => getInvoice(tx, inv107.id));
    expect(full.lines).toEqual([
      expect.objectContaining({ description: "Owed at 2026-03-31 (opening balance)", accountCode: "3900", taxCode: "GST", lineAmount: "1150.00", taxAmount: "150.00" }),
    ]);
    // The GST is already in the trial balance's GST line, so the journal doesn't post it again.
    expect(await world.journalLines(inv107.approvalJournalId!)).toEqual([
      ["1100", "1150.00", "0.00"],
      ["3900", "0.00", "1150.00"],
    ]);
    const bill = (await world.asUser(admin, (tx) => listBills(tx))).bills[0];
    expect(bill).toMatchObject({ taxTotal: "60.00", total: "460.00" });
    expect(await world.journalLines(bill.approvalJournalId!)).toEqual([
      ["3900", "460.00", "0.00"],
      ["2000", "0.00", "460.00"],
    ]);
    expect(await world.tb("2026-03-31")).toEqual({
      "1000": "12450.00 Dr",
      "1100": "1725.00 Dr",
      "1400": "810.00 Dr",
      "1600": "3000.00 Dr",
      "2000": "460.00 Cr",
      "2100": "1380.00 Cr",
      "3000": "10000.00 Cr",
      "3200": "6145.00 Cr",
    });
    const status = await world.asUser(admin, (tx) => conversionStatus(tx));
    expect(status).toMatchObject({ matches: true, clearingBalance: "0.00", gst: expectedGst });
    // Nothing counts before the conversion.
    const febMar = await world.asUser(admin, (tx) => calculateGstReturn(tx, { periodStart: "2026-02-01", periodEnd: "2026-03-31" }));
    expect(febMar.lines).toEqual([]);
  });

  async function firstReturnWorld(basis: "payments" | "hybrid") {
    const world = await setup();
    await world.asUser(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: basis }));
    await world.conversion({ invoices: OPEN_INVOICES_GST, bills: OPEN_BILLS_GST });
    const i1 = await world.asUser(admin, async (tx) => {
      const draft = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: world.contacts["Harbour Cafe"],
        invoiceDate: "2026-04-10",
        dueDate: "2026-04-20",
        amountsMode: "exclusive",
        lines: [{ description: "Mugs", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
      });
      return (await approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") })).invoice;
    });
    const invoices = (await world.asUser(admin, (tx) => listInvoices(tx))).invoices;
    const byNumber = (number: string) => invoices.find((invoice) => invoice.invoiceNumber === number)!;
    const pay = (number: string, paymentDate: string, amount: string) =>
      world.asUser(admin, (tx) => recordPayment(tx, byNumber(number).id, { idempotencyKey: key("pay"), paymentDate, amount, bankAccountCode: "1000" }));
    await pay("INV-0107", "2026-04-20", "1150.00");
    await pay("INV-0112", "2026-05-25", "230.00");
    const bill = (await world.asUser(admin, (tx) => listBills(tx))).bills[0];
    await world.asUser(admin, (tx) =>
      recordSupplierPayment(tx, bill.id, { idempotencyKey: key("pay"), paymentDate: "2026-04-22", amount: "460.00", bankAccountCode: "1000" }),
    );
    const gstReturn = (periodStart: string, periodEnd: string) => world.asUser(admin, (tx) => calculateGstReturn(tx, { periodStart, periodEnd }));
    return { world, i1, pay, gstReturn };
  }

  it("IM18: the first payments-basis return after the conversion counts what was paid on the opening invoices and bill", async () => {
    const { world, i1, pay, gstReturn } = await firstReturnWorld("payments");
    const aprMay = await gstReturn("2026-04-01", "2026-05-31");
    expect(aprMay.boxes).toMatchObject({
      box5: "1380.00",
      box6: "0.00",
      box7: "1380.00",
      box8: "180.00",
      box11: "460.00",
      box12: "60.00",
      box15: "120.00",
    });
    expect(aprMay.gstOnTransactions).toMatchObject({ sales: "180.00", purchases: "60.00" });
    expect(aprMay.lines.map((line) => [line.documentNumber, line.eventType, line.eventDate, line.amount, line.gst, line.settledAmount, line.documentTotal])).toEqual([
      ["INV-0107", "customer_payment", "2026-04-20", "1150.00", "150.00", "1150.00", "1150.00"],
      ["INV-0112", "customer_payment", "2026-05-25", "230.00", "30.00", "230.00", "575.00"],
      ["K-311", "supplier_payment", "2026-04-22", "460.00", "60.00", "460.00", "460.00"],
    ]);
    expect(aprMay.lines.some((line) => line.documentNumber === i1.invoiceNumber)).toBe(false);
    // 2100: 1,215.00 from the old returns + 120.00 this return + 60.00 not returned yet (INV-0112's 45.00 and I1's 15.00).
    expect((await world.tb("2026-05-31"))["2100"]).toBe("1395.00 Cr");
    await pay("INV-0112", "2026-06-10", "345.00");
    const junJul = await gstReturn("2026-06-01", "2026-07-31");
    expect(junJul.boxes).toMatchObject({ box5: "345.00", box8: "45.00" });
  });

  it("IM19: on the hybrid basis the opening invoices' GST was returned before; the opening bill's counts when paid", async () => {
    const { world, gstReturn } = await firstReturnWorld("hybrid");
    const aprMay = await gstReturn("2026-04-01", "2026-05-31");
    expect(aprMay.boxes).toMatchObject({ box5: "115.00", box8: "15.00", box11: "460.00", box12: "60.00", box15: "-45.00" });
    expect(aprMay.lines.map((line) => [line.documentNumber, line.eventType])).toEqual([
      [expect.stringMatching(/^INV-/), "invoice_approved"],
      ["K-311", "supplier_payment"],
    ]);
    expect(aprMay.lines.some((line) => line.documentNumber === "INV-0107")).toBe(false);
    expect((await world.asUser(admin, (tx) => conversionStatus(tx))).gst).toMatchObject({
      basis: "hybrid",
      openInvoicesReturnedWhenPaid: false,
      openBillsClaimedWhenPaid: true,
      fromReturns: "1440.00",
    });
  });

  it("IM20: GST from a GST code, from the whole invoice's GST and total, split when it's less than 3/23, and refused when it's more", async () => {
    const world = await setup();
    await world.asUser(owner, (tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    // A GST code only: 575.00 x 3/23 = 75.00.
    const byCode = await world.conversion(
      {
        invoices: `Invoice number,Customer,Invoice date,Due date,Amount due,GST code
INV-0107,Kobe Ltd,15/03/2026,20/04/2026,1150.00,15% GST on Income
INV-0112,Harbour Cafe,28/03/2026,20/04/2026,575.00,GST`,
        bills: OPEN_BILLS_GST,
      },
      false,
    );
    expect(byCode.plan.invoices.map((invoice) => invoice.gst)).toEqual(["150.00", "75.00"]);
    // Another system's export: the whole invoice's total and GST, and what's still owed (a row per invoice line).
    const xero = await world.conversion(
      {
        invoices: `*ContactName,*InvoiceNumber,*InvoiceDate,*DueDate,Total,TaxTotal,InvoiceAmountDue,*Description
Kobe Ltd,INV-0107,15/03/2026,20/04/2026,1150.00,150.00,1150.00,Mugs
Harbour Cafe,INV-0112,28/03/2026,20/04/2026,805.00,105.00,575.00,Vases
Harbour Cafe,INV-0112,28/03/2026,20/04/2026,805.00,105.00,575.00,Delivery`,
        bills: OPEN_BILLS_GST,
      },
      false,
    );
    expect(xero.problems).toEqual([]);
    expect(xero.plan.invoices.map((invoice) => [invoice.number, invoice.gst])).toEqual([
      ["INV-0107", "150.00"],
      ["INV-0112", "75.00"],
    ]);
    // Less than 3/23: a standard-rated part of 30.00 x 23 / 3 = 230.00 and the rest with no GST.
    const split = await world.conversion({ invoices: OPEN_INVOICES_GST, bills: OPEN_BILLS_GST.replace("460.00,60.00", "460.00,30.00") }, false);
    expect(split.plan.bills[0].lines).toEqual([
      { amount: "230.00", gst: "30.00", taxCode: "GST", rate: "0.15", part: "standard" },
      { amount: "230.00", gst: "0.00", taxCode: null, rate: "0", part: "rest" },
    ]);
    // Line-by-line rounding is allowed for (within 0.05); more than 3/23 isn't; a zero-rated code with GST isn't.
    const rounding = await world.conversion({ invoices: OPEN_INVOICES_GST, bills: OPEN_BILLS_GST.replace("460.00,60.00", "460.00,60.04") }, false);
    expect(rounding.plan.bills[0].lines).toEqual([{ amount: "460.00", gst: "60.04", taxCode: "GST", rate: "0.15", part: null }]);
    const tooMuch = await world.conversion({ invoices: OPEN_INVOICES_GST, bills: OPEN_BILLS_GST.replace("460.00,60.00", "460.00,70.00") }, false);
    expect(tooMuch.problems).toContainEqual({ kind: "open_bills", row: 2, message: "The GST (70.00) is more than GST at 15% on what's owed would be (60.00)." });
    const zeroRated = await world.conversion({ invoices: OPEN_INVOICES_GST, bills: `${OPEN_BILLS_GST.replace("Amount due,GST", "Amount due,GST,GST code")},ZERO` }, false);
    expect(zeroRated.problems).toContainEqual({ kind: "open_bills", row: 2, message: "The GST is 60.00 but the GST code ZERO has no GST." });

    // Posting the split bill and paying it: Box 11 230.00, Box 12 30.00.
    await world.conversion({ invoices: OPEN_INVOICES_GST, bills: OPEN_BILLS_GST.replace("460.00,60.00", "460.00,30.00") });
    const bill = (await world.asUser(admin, (tx) => listBills(tx))).bills[0];
    expect(bill).toMatchObject({ total: "460.00", taxTotal: "30.00" });
    await world.asUser(admin, (tx) =>
      recordSupplierPayment(tx, bill.id, { idempotencyKey: key("pay"), paymentDate: "2026-04-22", amount: "460.00", bankAccountCode: "1000" }),
    );
    const aprMay = await world.asUser(admin, (tx) => calculateGstReturn(tx, { periodStart: "2026-04-01", periodEnd: "2026-05-31" }));
    expect(aprMay.boxes).toMatchObject({ box11: "230.00", box12: "30.00" });
    expect((await world.asUser(admin, (tx) => conversionStatus(tx))).gst).toMatchObject({ openBills: "30.00", fromReturns: "1185.00" });
  });

  it("IM21: an older organisation's 2990 Conversion clearing becomes 3900 Opening balance if nothing is posted to it", async () => {
    const world = await setup();
    const changeOver = tenantMigrations.find((migration) => migration.version === "0036")!.sql;
    const section = changeOver.slice(changeOver.indexOf("update accounts a"));
    // As a 0035 organisation had it: 2990 Conversion clearing, a current liability.
    const asBefore = (tx: OrgTx) =>
      tx.query(
        "update accounts set code = '2990', name = 'Conversion clearing', account_class = 'liability', account_type = 'current_liability' where system_key = 'conversion_clearing'",
      );
    await world.asUser(owner, async (tx) => {
      await asBefore(tx);
      await tx.query(section);
    });
    expect((await world.asUser(admin, (tx) => listAccounts(tx))).find((account) => account.systemKey === "conversion_clearing")).toMatchObject({
      code: "3900",
      name: "Historical adjustment",
      accountType: "equity",
    });
    // Migration 0038 then gives it NetSuite's name, "Opening balance".
    const rename = tenantMigrations.find((migration) => migration.version === "0038")!.sql;
    await world.asUser(owner, async (tx) => {
      await tx.query(rename);
    });
    expect((await world.asUser(admin, (tx) => listAccounts(tx))).find((account) => account.systemKey === "conversion_clearing")).toMatchObject({
      code: "3900",
      name: "Opening balance",
      accountType: "equity",
    });
    // With something posted to it, it's left as it is (its class is fixed once it has postings), and still used.
    const posted = await setup();
    await posted.asUser(owner, asBefore);
    await posted.conversion();
    await posted.asUser(owner, (tx) => tx.query(section));
    expect((await posted.asUser(admin, (tx) => listAccounts(tx))).find((account) => account.systemKey === "conversion_clearing")).toMatchObject({
      code: "2990",
      name: "Conversion clearing",
      accountType: "current_liability",
    });
    expect((await posted.asUser(admin, (tx) => conversionStatus(tx))).clearingBalance).toBe("0.00");
    // Another system's chart names its own historical adjustment account: Tohyee's is re-coded to it and stays equity.
    const other = await setup({ people: false, items: false });
    const result = await other.master("accounts", "*Code,*Name,*Type\n840,Historical Adjustment,Current Liability");
    expect(result.problems).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ action: "update", detail: "Tohyee's opening balance account, re-coded from 3900 (it stays Equity, not Current liability)" });
    expect((await other.asUser(admin, (tx) => listAccounts(tx))).find((account) => account.code === "840")).toMatchObject({
      name: "Historical Adjustment",
      accountType: "equity",
      systemKey: "conversion_clearing",
    });
  });

  it("IM14: opening balances are brought in once; a retry returns the first", async () => {
    const world = await setup();
    const idempotencyKey = key("conversion");
    const first = await world.conversion({}, true, idempotencyKey);
    const retry = await world.conversion({}, true, idempotencyKey);
    expect(retry).toMatchObject({ committed: true, journalId: first.journalId });
    await expect(world.conversion()).rejects.toThrow("Opening balances were already brought in as at 2026-03-31.");
    expect(await world.count("ledger_journals where origin = 'opening_balance'")).toBe(1);
    expect(await world.count("sales_invoices")).toBe(2);
    await expect(world.asUser(owner, (tx) => tx.query("delete from conversion_balance_lines"))).rejects.toThrow("append-only");

    // Only admins and owners.
    const cookie = await sessionCookieFor(bookkeeper);
    const response = await conversionRoute.POST(
      apiRequest("/api/import/conversion", { method: "POST", cookie, body: { organisationId: world.org, commit: false, conversionDate: "2026-03-31" } }),
      noContext,
    );
    expect(response.status).toBe(403);
  });

  it("IM15: the opening bank balance isn't an item on the bank reconciliation", async () => {
    const world = await setup();
    await world.conversion();
    const bank = (await world.asUser(admin, (tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    await world.asUser(admin, (tx) =>
      importStatementFile(tx, bank.id, {
        idempotencyKey: key("statement"),
        fileName: "statement.csv",
        fileBase64: Buffer.from("Date,Amount,Payee,Balance\n02/04/2026,-46.00,Z ENERGY,12404.00\n").toString("base64"),
      }),
    );
    const line = (await world.asUser(admin, (tx) => listStatementLines(tx, bank.id, { status: "all" }))).lines[0];
    const suggestions = await world.asUser(admin, (tx) => suggestionsForLine(tx, line.id));
    expect(JSON.stringify(suggestions)).not.toContain("OPENING");
    await world.asUser(admin, (tx) =>
      reconcileStatementLine(tx, line.id, {
        idempotencyKey: key("reconcile"),
        kind: "bank_transaction",
        contactId: world.contacts["Kauri Supplies"],
        amountsMode: "inclusive",
        lines: [{ description: "Petrol", accountCode: "6120", taxCode: "GST", amount: "46.00" }],
      }),
    );
    const report = await world.asUser(admin, (tx) => bankReconciliationReport(tx, { accountId: bank.id, asAt: "2026-04-30" }));
    expect(report).toMatchObject({ ledgerBalance: "12404.00", statementBalance: "12404.00", explained: true });
    expect(report.tohyeeNotInBank.items).toEqual([]);
  });

  it("IM2, IM16: the chart of accounts adds, updates and re-codes by code and role; exports read back unchanged", async () => {
    const world = await setup({ people: false, items: false });
    const file = `*Code,*Name,*Type,*Tax Code,Description
200,Sales,Revenue,15% GST on Income,
610,Accounts Receivable,Current Asset,No GST,
6000,Advertising,Overhead,GST on Expenses,
7500,Donations,Expense,No GST,Gifts to charities`;
    const check = await world.master("accounts", file, false);
    expect(check).toMatchObject({ committed: false, problems: [], counts: { create: 2, update: 2, unchanged: 0 } });
    expect(check.outcomes.find((outcome) => outcome.row === 3)).toMatchObject({ action: "update", detail: "Tohyee's accounts receivable account, re-coded from 1100" });
    expect((await world.asUser(admin, (tx) => listAccounts(tx))).some((account) => account.code === "200")).toBe(false);

    const done = await world.master("accounts", file);
    expect(done).toMatchObject({ committed: true, counts: { create: 2, update: 2, unchanged: 0 } });
    const accounts = await world.asUser(admin, (tx) => listAccounts(tx));
    const byCode = (code: string) => accounts.find((account) => account.code === code);
    expect(byCode("200")).toMatchObject({ name: "Sales", accountType: "revenue", defaultTaxCode: "GST" });
    expect(byCode("610")).toMatchObject({ name: "Accounts Receivable", systemKey: "accounts_receivable", accountType: "current_asset", defaultTaxCode: "NONE" });
    expect(byCode("1100")).toBeUndefined();
    expect(byCode("6000")).toMatchObject({ name: "Advertising", accountType: "expense", defaultTaxCode: "GST" });
    expect(byCode("7500")).toMatchObject({ name: "Donations", accountType: "expense", defaultTaxCode: "NONE", description: "Gifts to charities" });

    const again = await world.master("accounts", file);
    expect(again.counts).toEqual({ create: 0, update: 0, unchanged: 4 });

    // IM16: the export reads back in with nothing changed.
    const exported = await world.asUser(admin, (tx) => exportCsv(tx, "accounts"));
    expect(exported.csv.split("\r\n")[0]).toBe("Code,Name,Type,GST code,Description");
    expect(exported.csv).toContain("7500,Donations,Expense,NONE,Gifts to charities");
    const roundTrip = await world.asUser(admin, (tx) =>
      importMasterRecords(tx, { kind: "accounts", records: mapped("accounts", exported.csv.replace(/\r\n/g, "\n"), "tohyee"), idempotencyKey: key("import"), commit: true }),
    );
    expect(roundTrip.problems).toEqual([]);
    expect(roundTrip.counts).toMatchObject({ create: 0, update: 0 });

    // Over HTTP: admins only, and the export is a CSV download.
    const cookie = await sessionCookieFor(admin);
    const response = await exportRoute.GET(apiRequest(`/api/import/export?organisationId=${world.org}&kind=contacts`, { cookie }), noContext);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect((await response.text()).split("\r\n")[0]).toBe("Name,Customer (yes/no),Supplier (yes/no),Email,Phone,Billing (postal) address,Delivery address,GST number,Payment terms");
    const bookkeeperCookie = await sessionCookieFor(bookkeeper);
    const refused = await recordsRoute.POST(
      apiRequest("/api/import/records", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: world.org, kind: "accounts", records: [], idempotencyKey: key("x") } }),
      noContext,
    );
    expect(refused.status).toBe(403);
    const read = await readRoute.POST(
      apiRequest("/api/import/read", {
        method: "POST",
        cookie,
        body: { organisationId: world.org, kind: "trial_balance", fileName: "tb.csv", fileBase64: Buffer.from(`Trial Balance\nTui Traders Ltd\n\n${TRIAL_BALANCE}`).toString("base64") },
      }),
      noContext,
    );
    const readBody = (await read.json()) as { file: { headerRow: number; headings: string[] } };
    expect(readBody.file).toMatchObject({ headerRow: 3, headings: ["Account code", "Account", "Debit", "Credit"] });
  });

  it("IM3: one refused row means nothing in the file is imported", async () => {
    const world = await setup({ people: false, items: false });
    const result = await world.master(
      "accounts",
      `Code,Name,Type
1000,Business bank account,Current asset
8000,Sundry income,
8100,Rent received,Other income
8100,Rent received again,Other income`,
      true,
      { preset: "tohyee" },
    );
    expect(result.committed).toBe(false);
    expect(result.problems).toEqual([
      { row: 2, message: "1000 (Business bank account) is used by Tohyee for automatic postings, so its type stays Bank, not Current asset." },
      { row: 3, message: "Type is needed for a new account (for example Expense or Current asset)." },
      { row: 5, message: "Code 8100 is on row 4 too. Each can be in the file once." },
    ]);
    const accounts = await world.asUser(admin, (tx) => listAccounts(tx));
    expect(accounts.some((account) => account.code === "8100")).toBe(false);
    expect(accounts.find((account) => account.code === "1000")?.accountType).toBe("bank");
  });

  it("IM4: contacts are added or updated by name, with addresses, GST numbers, payment terms and custom fields", async () => {
    const world = await setup({ people: false, items: false });
    const file = `*ContactName,EmailAddress,POAddressLine1,POCity,POPostalCode,TaxNumber
Kobe Ltd,accounts@kobe.co.nz,1 Queen Street,Auckland,1010,123-456-789
Harbour Cafe,,,,,`;
    const result = await world.master("contacts", file, true, { options: { defaultRole: "both" } });
    expect(result).toMatchObject({ committed: true, counts: { create: 2, update: 0 } });
    let contacts = await world.asUser(admin, (tx) => listContacts(tx));
    expect(contacts.find((contact) => contact.name === "Kobe Ltd")).toMatchObject({
      isCustomer: true,
      isSupplier: true,
      email: "accounts@kobe.co.nz",
      postalAddress: "1 Queen Street\nAuckland\n1010",
      gstNumber: "123456789",
    });

    const update = await world.master("contacts", "*ContactName,EmailAddress\nKOBE LTD,hello@kobe.co.nz");
    expect(update.counts).toEqual({ create: 0, update: 1, unchanged: 0 });
    contacts = await world.asUser(admin, (tx) => listContacts(tx));
    expect(contacts.find((contact) => contact.name === "Kobe Ltd")).toMatchObject({ email: "hello@kobe.co.nz", gstNumber: "123456789" });

    await world.asUser(owner, (tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const setupFields = await world.asUser(admin, (tx) =>
      createCustomField(tx, { record: "contact", label: "Region", type: "list", usedOn: ["customer"], options: ["North", "South"] }),
    );
    const region = setupFields.fields.find((field) => field.label === "Region")!;
    const rows = csv("Name,Payment terms,Region\nHarbour Cafe,20th of the following month,South");
    const records = applyMapping(rows, 0, { name: ["Name"], paymentTerms: ["Payment terms"], [`custom:${region.id}`]: ["Region"] });
    const withCustom = await world.asUser(admin, (tx) => importMasterRecords(tx, { kind: "contacts", records, idempotencyKey: key("import"), commit: true }));
    expect(withCustom.problems).toEqual([]);
    const cafe = (await world.asUser(admin, (tx) => listContacts(tx))).find((contact) => contact.name === "Harbour Cafe")!;
    expect(cafe.customFields).toEqual({ [region.id]: region.options.find((option) => option.name === "South")!.id });
    expect(cafe.paymentTermId).not.toBeNull();

    const bad = await world.master("contacts", "*ContactName,EmailAddress\nNew Co,not-an-email");
    expect(bad).toMatchObject({ committed: false, problems: [{ row: 2, message: "Enter a valid email address, like accounts@example.co.nz." }] });
    expect((await world.asUser(admin, (tx) => listContacts(tx))).some((contact) => contact.name === "New Co")).toBe(false);
  });

  it("IM5: products and services come in as stock, service or non-stock items", async () => {
    const world = await setup({ people: false, items: false });
    const result = await world.master(
      "items",
      `*ItemCode,ItemName,PurchasesUnitPrice,PurchasesAccount,PurchasesTaxRate,SalesUnitPrice,SalesAccount,SalesTaxRate,InventoryAssetAccount,Quantity
MUG,Kowhai mug,8.00,,15% GST on Expenses,20.00,4000,15% GST on Income,1400,40
DELIVERY,Delivery,,,,12.50,4000,15% GST on Income,,
BOX,Gift box,1.50,5000,15% GST on Expenses,,,,,`,
    );
    expect(result).toMatchObject({ committed: true, problems: [], counts: { create: 3 } });
    const items = (await world.asUser(admin, (tx) => listItems(tx))).items;
    expect(items.find((item) => item.code === "MUG")).toMatchObject({
      itemType: "stock",
      purchaseAccountCode: "1400",
      purchasePrice: "8",
      salePrice: "20",
      salesTaxCode: "GST",
      purchaseTaxCode: "GST",
    });
    expect(items.find((item) => item.code === "DELIVERY")).toMatchObject({ itemType: "service", salePrice: "12.5", incomeAccountCode: "4000" });
    expect(items.find((item) => item.code === "BOX")).toMatchObject({ itemType: "non_stock", purchaseAccountCode: "5000" });
    expect(await world.count("inventory_movements")).toBe(0);
  });
});

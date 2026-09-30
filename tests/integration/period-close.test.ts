import { afterAll, beforeAll, expect, it } from "vitest";
import * as periodCloseRoute from "@/app/api/ledger/period-close/route";
import { updateAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { approveBill, createBill, deleteBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { createFixedAsset, createFixedAssetType } from "@/lib/fixed-assets/service";
import { runDepreciation } from "@/lib/fixed-assets/runs";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { postFxRevaluation } from "@/lib/ledger/fx-revaluation";
import { postJournal } from "@/lib/ledger/journals";
import { closePeriod, listPeriods, type PeriodCheck, periodChecklist, reopenPeriod } from "@/lib/ledger/period-close";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { getOrganisationSettings, updateOrganisationSettings } from "@/lib/organisations/settings";
import { getHomeSummary } from "@/lib/reports/home";
import { balanceSheet, profitAndLoss, trialBalance } from "@/lib/reports/financial";
import { accountTransactions } from "@/lib/reports/account-transactions";
import { fileGstReturn, listGstReturns } from "@/lib/reports/gst-return";
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

const b64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * Examples YE1-YE4 and PC1-PC12 ("Year end and period close") in
 * docs/ACCOUNTING-EXAMPLES.md. Each test gets its own organisation.
 */
describeWithDatabase("year end and period close", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("close-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("close-bookkeeper@example.com");
    viewer = await createTestUser("close-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `close-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => asUser(owner, work);
    const contact = async (name: string, flags: Record<string, unknown>): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...flags }))).contact;
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const paw = await contact("Paw Supplies", { isSupplier: true });
    const journal = (postingDate: string, lines: Array<[string, string, string]>, extra: Record<string, unknown> = {}) =>
      as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate,
          reference: "J",
          lines: lines.map(([accountCode, debitAmount, creditAmount]) => ({ accountCode, debitAmount, creditAmount })),
          ...extra,
        }),
      );
    const draftInvoice = async (invoiceDate: string, unitPrice = "100.00") =>
      (
        await asUser(bookkeeper, (tx) =>
          createInvoice(tx, {
            idempotencyKey: key("invoice"),
            contactId: kobe.id,
            invoiceDate,
            dueDate: "2026-08-20",
            amountsMode: "exclusive",
            lines: [{ description: "Keepsake", quantity: "1", unitPrice, accountCode: "4000", taxCode: "GST" }],
          }),
        )
      ).invoice;
    const draftBill = async (billDate: string, unitPrice = "200.00") =>
      (
        await asUser(bookkeeper, (tx) =>
          createBill(tx, {
            idempotencyKey: key("bill"),
            contactId: paw.id,
            billDate,
            dueDate: "2026-08-20",
            supplierInvoiceNumber: key("PS"),
            amountsMode: "exclusive",
            lines: [{ description: "Supplies", quantity: "1", unitPrice, accountCode: "6010", taxCode: "GST" }],
          }),
        )
      ).bill;
    const checklist = (periodEnd: string, user = viewer) => asUser(user, (tx) => periodChecklist(tx, { periodEnd }));
    const check = async (periodEnd: string, checkKey: PeriodCheck["key"]) => (await checklist(periodEnd)).checks.find((entry) => entry.key === checkKey)!;
    const statuses = async (periodEnd: string) => Object.fromEntries((await checklist(periodEnd)).checks.map((entry) => [entry.key, entry.status]));
    const close = (periodEnd: string, user: SessionUser, role: "owner" | "admin" | "bookkeeper" | "viewer", acknowledgeWarnings?: boolean) =>
      asUser(user, (tx) => closePeriod(tx, role, { periodEnd, acknowledgeWarnings }));
    const reopen = (periodEnd: string, reason: unknown, user = owner, role: "owner" | "admin" | "bookkeeper" = "owner") =>
      asUser(user, (tx) => reopenPeriod(tx, role, { periodEnd, reason }));
    const lockDate = async () => (await as((tx) => getPeriodControls(tx))).lockDate;
    const audit = async (eventType: string) =>
      (
        await as((tx) =>
          tx.query<{ actor_email: string; details: Record<string, unknown> }>(
            "select actor_email, details from audit_events where event_type = $1 order by id",
            [eventType],
          ),
        )
      ).rows;
    return { org, as, asUser, kobe, paw, journal, draftInvoice, draftBill, checklist, check, statuses, close, reopen, lockDate, audit };
  }

  type World = Awaited<ReturnType<typeof setup>>;

  /** The YE setup: FY26 (to 31 Mar 2026) makes 12,345.67. */
  async function yearEnd(): Promise<World> {
    const w = await setup();
    await w.journal("2025-04-01", [
      ["1000", "10000.00", ""],
      ["3000", "", "10000.00"],
    ]);
    await w.journal("2025-07-10", [
      ["1000", "15000.00", ""],
      ["4000", "", "15000.00"],
    ]);
    await w.journal("2026-02-20", [
      ["6010", "2654.33", ""],
      ["1000", "", "2654.33"],
    ]);
    await w.journal("2026-04-15", [
      ["1000", "1000.00", ""],
      ["4000", "", "1000.00"],
    ]);
    return w;
  }

  const equityOf = (sheet: Awaited<ReturnType<typeof balanceSheet>>) => ({
    accounts: sheet.equity.sections.flatMap((section) => section.lines.map((line) => [line.code, line.amount])),
    retained: sheet.equity.retainedEarnings.total,
    current: sheet.equity.currentYearEarnings,
    total: sheet.equity.total,
    bank: sheet.assets.sections.flatMap((section) => section.lines).find((line) => line.code === "1000")?.amount,
    balanced: sheet.balanced,
  });

  it("YE1: at 31 Mar 2026 the year's 12,345.67 is current year earnings", async () => {
    const w = await yearEnd();
    const sheet = await w.as((tx) => balanceSheet(tx, { asAt: "2026-03-31" }));
    expect(sheet.financialYearStart).toBe("2025-04-01");
    expect(equityOf(sheet)).toEqual({
      accounts: [["3000", "10000.00"]],
      retained: "0.00",
      current: "12345.67",
      total: "22345.67",
      bank: "22345.67",
      balanced: true,
    });
    const pnl = await w.as((tx) => profitAndLoss(tx, { to: "2026-03-31" }));
    expect([pnl.from, pnl.netProfit]).toEqual(["2025-04-01", "12345.67"]);
  });

  it("YE2: from 1 Apr 2026 it's retained earnings, with no closing journal", async () => {
    const w = await yearEnd();
    const first = await w.as((tx) => balanceSheet(tx, { asAt: "2026-04-01" }));
    expect(equityOf(first)).toMatchObject({ retained: "12345.67", current: "0.00", total: "22345.67", balanced: true });
    const april = await w.as((tx) => balanceSheet(tx, { asAt: "2026-04-30" }));
    expect(equityOf(april)).toEqual({
      accounts: [["3000", "10000.00"]],
      retained: "12345.67",
      current: "1000.00",
      total: "23345.67",
      bank: "23345.67",
      balanced: true,
    });
    const pnl = await w.as((tx) => profitAndLoss(tx, { to: "2026-04-30" }));
    expect([pnl.from, pnl.netProfit]).toEqual(["2026-04-01", "1000.00"]);
    const journals = await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"));
    expect(journals.rows[0].n).toBe("4");
    // TB2: NetSuite's trial balance: last year's profit is in retained earnings.
    const tb = await w.as((tx) => trialBalance(tx, { asAt: "2026-04-30" }));
    expect(tb.rows.map((row) => [row.code, row.debit, row.credit])).toEqual([
      ["1000", "23345.67", "0.00"],
      ["3000", "0.00", "10000.00"],
      ["3200", "0.00", "12345.67"],
      ["4000", "0.00", "1000.00"],
    ]);
    expect([tb.totalDebit, tb.totalCredit, tb.balanced]).toEqual(["23345.67", "23345.67", true]);
  });

  it("TB1-TB4: the trial balance shows income and expenses for this financial year, earlier profit in retained earnings", async () => {
    const w = await yearEnd();
    const rowsOf = async (asAt: string) => {
      const tb = await w.as((tx) => trialBalance(tx, { asAt }));
      return { tb, rows: tb.rows.map((row) => [row.code, row.debit, row.credit]) };
    };
    // TB1: at 31 Mar 2026 the whole year is still income and expenses.
    const march = await rowsOf("2026-03-31");
    expect(march.rows).toEqual([
      ["1000", "22345.67", "0.00"],
      ["3000", "0.00", "10000.00"],
      ["4000", "0.00", "15000.00"],
      ["6010", "2654.33", "0.00"],
    ]);
    expect([march.tb.financialYearStart, march.tb.previousYearsEarnings, march.tb.totalDebit, march.tb.totalCredit]).toEqual([
      "2025-04-01",
      "0.00",
      "25000.00",
      "25000.00",
    ]);
    // TB2: the next day it's retained earnings (the same as the balance sheet's), and 6010 has nothing this year.
    const april = await rowsOf("2026-04-01");
    expect(april.rows).toEqual([
      ["1000", "22345.67", "0.00"],
      ["3000", "0.00", "10000.00"],
      ["3200", "0.00", "12345.67"],
    ]);
    expect(april.tb.rows.find((row) => row.code === "3200")).toMatchObject({ previousYearsEarnings: "12345.67" });
    expect((await w.as((tx) => balanceSheet(tx, { asAt: "2026-04-01" }))).equity.retainedEarnings.total).toBe("12345.67");
    // Each income or expense line is the account's movement in account transactions since the
    // start of the financial year (account transactions keep every posting, so 4000's balance
    // still runs from 15,000.00 Cr to 16,000.00 Cr).
    const sales = (await w.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '4000'"))).rows[0].id;
    const salesThisYear = await w.as((tx) => accountTransactions(tx, { accountId: sales, from: "2026-04-01", to: "2026-04-30" }));
    expect([salesThisYear.accounts[0].opening, salesThisYear.accounts[0].totalDebit, salesThisYear.accounts[0].totalCredit, salesThisYear.accounts[0].closing]).toEqual([
      "-15000.00",
      "0.00",
      "1000.00",
      "-16000.00",
    ]);
    expect((await rowsOf("2026-04-30")).rows).toContainEqual(["4000", "0.00", "1000.00"]);

    // TB3: a dividend of 500.00 out of retained earnings on 20 Apr 2026.
    await w.journal("2026-04-20", [
      ["3200", "500.00", ""],
      ["1000", "", "500.00"],
    ]);
    const dividend = await rowsOf("2026-04-30");
    expect(dividend.rows).toEqual([
      ["1000", "22845.67", "0.00"],
      ["3000", "0.00", "10000.00"],
      ["3200", "0.00", "11845.67"],
      ["4000", "0.00", "1000.00"],
    ]);
    expect([dividend.tb.totalDebit, dividend.tb.totalCredit, dividend.tb.balanced]).toEqual(["22845.67", "22845.67", true]);
    const retained = (await w.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '3200'"))).rows[0].id;
    const register = await w.as((tx) => accountTransactions(tx, { accountId: retained, from: "2026-04-01", to: "2026-04-30" }));
    expect(register.accounts[0].closing).toBe("500.00");

    // TB4: with a 30 June year end the year started 1 Jul 2025, so there's nothing from previous years.
    await w.as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 6 }));
    const june = await rowsOf("2026-04-30");
    expect(june.rows).toEqual([
      ["1000", "22845.67", "0.00"],
      ["3000", "0.00", "10000.00"],
      ["3200", "500.00", "0.00"],
      ["4000", "0.00", "16000.00"],
      ["6010", "2654.33", "0.00"],
    ]);
    expect([june.tb.financialYearStart, june.tb.previousYearsEarnings, june.tb.totalDebit, june.tb.totalCredit]).toEqual([
      "2025-07-01",
      "0.00",
      "26000.00",
      "26000.00",
    ]);
  });

  it("YE3: a journal to 3200 is part of retained earnings, not listed on its own", async () => {
    const w = await yearEnd();
    await w.journal("2026-04-20", [
      ["3200", "500.00", ""],
      ["1000", "", "500.00"],
    ]);
    const sheet = await w.as((tx) => balanceSheet(tx, { asAt: "2026-04-30" }));
    expect(equityOf(sheet)).toEqual({
      accounts: [["3000", "10000.00"]],
      retained: "11845.67",
      current: "1000.00",
      total: "22845.67",
      bank: "22845.67",
      balanced: true,
    });
    expect(sheet.equity.retainedEarnings).toMatchObject({ account: { code: "3200" }, accountBalance: "-500.00", previousYearsEarnings: "12345.67" });
  });

  it("YE4: changing the year end moves the split, and is refused while a year is closed", async () => {
    const w = await yearEnd();
    await w.journal("2026-04-20", [
      ["3200", "500.00", ""],
      ["1000", "", "500.00"],
    ]);
    await w.as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 6 }));
    const june = await w.as((tx) => balanceSheet(tx, { asAt: "2026-04-30" }));
    expect(june.financialYearStart).toBe("2025-07-01");
    expect(equityOf(june)).toMatchObject({ retained: "-500.00", current: "13345.67", total: "22845.67", balanced: true });
    await w.as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 3 }));

    for (const periodEnd of ["2025-04-30", "2025-07-31", "2026-02-28", "2026-03-31"]) {
      expect((await w.close(periodEnd, owner, "owner", true)).changed).toBe(true);
    }
    expect(await w.lockDate()).toBe("2026-03-31");
    await expect(w.as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 6 }))).rejects.toThrow(
      "The financial year ending 31 Mar 2026 is closed",
    );
    await w.reopen("2026-03-31", "Balance date change");
    expect(await w.lockDate()).toBe("2026-02-28");
    await w.as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 6 }));
    expect((await w.as((tx) => balanceSheet(tx, { asAt: "2026-04-30" }))).equity.currentYearEarnings).toBe("13345.67");
  });

  it("PC1: periods by financial year, closed in order; closing the last month closes the year", async () => {
    const w = await yearEnd();
    const list = await w.as((tx) => listPeriods(tx, { today: "2026-05-10" }));
    expect(list.years.map((year) => [year.end, year.status, year.months.map((month) => month.label)])).toEqual([
      ["2027-03-31", "open", ["May 2026", "April 2026"]],
      [
        "2026-03-31",
        "open",
        ["March 2026", "February 2026", "January 2026", "December 2025", "November 2025", "October 2025", "September 2025", "August 2025", "July 2025", "June 2025", "May 2025", "April 2025"],
      ],
    ]);
    const months = (periods: typeof list) => periods.years.flatMap((year) => year.months);
    expect(months(list).filter((month) => month.hasPostings).map((month) => month.end)).toEqual(["2026-04-30", "2026-02-28", "2025-07-31", "2025-04-30"]);
    expect(months(list).every((month) => month.status === "open")).toBe(true);
    expect(months(list).filter((month) => month.canClose).map((month) => month.end)).toEqual(["2025-04-30"]);
    expect(list.nextToClose).toBe("2025-04-30");

    await w.close("2025-04-30", owner, "owner", true);
    const afterApril = await w.as((tx) => listPeriods(tx, { today: "2026-05-10" }));
    expect(months(afterApril).filter((month) => month.canClose).map((month) => month.end)).toEqual(["2025-07-31", "2025-06-30", "2025-05-31"]);
    await expect(w.close("2026-03-31", owner, "owner", true)).rejects.toThrow("Close July 2025 first");

    for (const periodEnd of ["2025-07-31", "2026-02-28", "2026-03-31"]) await w.close(periodEnd, owner, "owner", true);
    const closed = await w.as((tx) => listPeriods(tx, { today: "2026-05-10" }));
    expect(closed.years.map((year) => [year.end, year.status])).toEqual([
      ["2027-03-31", "open"],
      ["2026-03-31", "closed"],
    ]);
    expect(months(closed).find((month) => month.end === "2025-05-31")?.status).toBe("closed");
    expect(closed.nextToClose).toBe("2026-04-30");
    const closes = await w.audit("ledger.period_closed");
    expect(closes.map((row) => [row.details.periodEnd, row.details.financialYearClosed])).toEqual([
      ["2025-04-30", false],
      ["2025-07-31", false],
      ["2026-02-28", false],
      ["2026-03-31", true],
    ]);
    expect(closed.history[0]).toMatchObject({ eventType: "ledger.period_closed", periodEnd: "2026-03-31", from: "2026-02-28", to: "2026-03-31" });
  });

  it("PC2: drafts dated in the period need attention until approved or deleted", async () => {
    const w = await setup();
    const invoice = await w.draftInvoice("2026-06-12");
    const bill = await w.draftBill("2026-06-20");
    await w.draftInvoice("2026-07-01");
    const drafts = await w.check("2026-06-30", "drafts");
    expect(drafts.status).toBe("warning");
    expect(drafts.items).toEqual([
      { label: "Invoice, 12 Jun 2026", detail: "Kobe Ltd, 115.00", href: `/operations/invoices/${invoice.id}` },
      { label: "Bill, 20 Jun 2026", detail: "Paw Supplies, 230.00", href: `/operations/bills/${bill.id}` },
    ]);
    await expect(w.close("2026-06-30", bookkeeper, "bookkeeper")).rejects.toThrow("no drafts left in the period");
    await w.asUser(bookkeeper, (tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    await w.asUser(bookkeeper, (tx) => deleteBill(tx, bill.id));
    expect(Object.values(await w.statuses("2026-06-30")).every((status) => status !== "warning")).toBe(true);
    expect((await w.close("2026-06-30", bookkeeper, "bookkeeper")).changed).toBe(true);
    expect(await w.lockDate()).toBe("2026-06-30");
  });

  it("PC3: bank accounts must be reconciled to the month end", async () => {
    const w = await setup();
    const posted = await w.journal("2026-06-01", [
      ["1000", "1000.00", ""],
      ["3000", "", "1000.00"],
    ]);
    const bank = (await w.as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    expect((await w.check("2026-06-30", "bank")).items).toEqual([
      { label: "1000 Business bank account", detail: "No statement balance is known at 30 Jun 2026: no bank statement or feed covers that date, so Tohyee can't check this account against the bank. Import the statement to that date, or, if this account has no statements (cash, a loan or a clearing account), an owner or admin can accept this warning when closing.", href: `/operations/bank-accounts/${bank.id}` },
    ]);
    await w.asUser(bookkeeper, (tx) =>
      importStatementFile(tx, bank.id, {
        idempotencyKey: key("import"),
        fileName: "statement.csv",
        fileBase64: b64(
          "Date,Amount,Payee,Particulars,Code,Reference,Balance\n01/06/2026,1000.00,J KELLY,CAPITAL,,,1000.00\n28/06/2026,-12.00,MONTHLY FEE,,,,988.00\n02/07/2026,-50.00,Z ENERGY,,,,938.00\n",
        ),
      }),
    );
    const lines = (await w.as((tx) => listStatementLines(tx, bank.id, { status: "all" }))).lines;
    const lineOn = (amount: string) => lines.find((line) => line.amount === amount)!;
    const journalLine = (
      await w.as((tx) => tx.query<{ id: string }>("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [posted.journal.id, bank.id]))
    ).rows[0].id;
    await w.asUser(bookkeeper, (tx) => reconcileStatementLine(tx, lineOn("1000.00").id, { idempotencyKey: key("rec"), kind: "match", journalLineIds: [journalLine] }));
    const unreconciled = await w.check("2026-06-30", "bank");
    expect(unreconciled.status).toBe("warning");
    expect(unreconciled.items.map((item) => item.detail)).toEqual(["1 statement line on or before 30 Jun 2026 not reconciled (-12.00)."]);
    await w.asUser(bookkeeper, (tx) =>
      reconcileStatementLine(tx, lineOn("-12.00").id, {
        idempotencyKey: key("rec"),
        kind: "bank_transaction",
        contactId: w.paw.id,
        amountsMode: "inclusive",
        lines: [{ description: "Bank fee", accountCode: "6010", taxCode: "NONE", amount: "12.00" }],
      }),
    );
    expect(await w.check("2026-06-30", "bank")).toMatchObject({ status: "pass", summary: "The account is reconciled to 30 Jun 2026." });
  });

  it("PC4: depreciation must be run to the month end when there are fixed assets", async () => {
    const w = await setup();
    expect((await w.check("2026-06-30", "depreciation")).status).toBe("not_applicable");
    await w.journal("2026-06-01", [
      ["1600", "1200.00", ""],
      ["3000", "", "1200.00"],
    ]);
    const type = (
      await w.as((tx) =>
        createFixedAssetType(tx, {
          idempotencyKey: key("type"),
          name: "Office equipment",
          assetAccountCode: "1600",
          accumulatedDepreciationAccountCode: "1610",
          depreciationExpenseAccountCode: "6300",
          method: "sl",
          rate: "20",
        }),
      )
    ).type;
    await w.as((tx) => createFixedAsset(tx, { idempotencyKey: key("asset"), name: "Desk", typeId: type.id, purchaseDate: "2026-06-01", cost: "1200.00" }));
    expect(await w.check("2026-06-30", "depreciation")).toMatchObject({
      status: "warning",
      summary: "Depreciation of 20.00 to 30 Jun 2026 hasn't been run (never run).",
      fix: { href: "/operations/fixed-assets/depreciation" },
    });
    await w.as((tx) => runDepreciation(tx, { idempotencyKey: key("run"), periodEnd: "2026-06-30" }));
    expect(await w.check("2026-06-30", "depreciation")).toMatchObject({ status: "pass", summary: "Depreciation has been run to 30 Jun 2026." });
  });

  it("PC5: foreign-currency balances must be revalued at the month end", async () => {
    const w = await setup();
    expect((await w.check("2026-06-30", "fx_revaluation")).status).toBe("not_applicable");
    await w.as(async (tx) => {
      const account = await tx.query<{ id: string }>("select id::text from accounts where code = '1000'");
      await updateAccount(tx, account.rows[0].id, { currencyCode: "USD", name: "USD account" });
    });
    await w.as((tx) =>
      postJournal(tx, {
        idempotencyKey: key("usd"),
        postingDate: "2026-06-01",
        reference: "USD-IN",
        lines: [
          { accountCode: "1000", debitAmount: "1600", foreignAmount: "1000", exchangeRate: "1.6" },
          { accountCode: "3000", creditAmount: "1600" },
        ],
      }),
    );
    const fx = await w.check("2026-06-30", "fx_revaluation");
    expect(fx.status).toBe("warning");
    expect(fx.items.map((item) => item.label)).toEqual(["1000 USD account"]);
    await w.as((tx) =>
      postFxRevaluation(tx, {
        idempotencyKey: key("fx"),
        reference: "FX-2026-06",
        revaluationDate: "2026-06-30",
        reversalPostingDate: "2026-07-01",
        rateDate: "2026-06-30",
        rateSource: "RBNZ close",
        unrealisedGainAccountCode: "7000",
        unrealisedLossAccountCode: "7010",
        balances: [{ accountCode: "1000", closingRate: "1.6543" }],
      }),
    );
    expect(await w.check("2026-06-30", "fx_revaluation")).toMatchObject({ status: "pass", summary: "Revalued on 30 Jun 2026." });
    expect((await w.check("2026-06-30", "bank")).status).toBe("warning");
  });

  it("PC6: stock below zero needs attention; stock always equals 1400", async () => {
    const w = await setup();
    expect(await w.statuses("2026-06-30")).toMatchObject({ stock: "not_applicable", negative_stock: "not_applicable" });
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    await w.as((tx) => updateOrganisationSettings(tx, { allowNegativeStock: true }));
    const widget = (
      await w.as((tx) =>
        createItem(tx, {
          idempotencyKey: key("item"),
          code: "WIDGET",
          name: "Widget",
          itemType: "stock",
          salePrice: "12.00",
          purchasePrice: "5.00",
          incomeAccountCode: "4000",
          salesTaxCode: "GST",
          purchaseAccountCode: "1400",
          purchaseTaxCode: "GST",
        }),
      )
    ).item;
    const bill = async (billDate: string, quantity: string, unitPrice: string) => {
      const draft = await w.as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: w.paw.id,
          billDate,
          dueDate: "2026-07-20",
          supplierInvoiceNumber: key("S"),
          amountsMode: "exclusive",
          lines: [{ itemId: widget.id, quantity, unitPrice }],
        }),
      );
      await w.as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("a") }));
    };
    await bill("2026-06-01", "2", "5.00");
    const invoice = await w.as((tx) =>
      createInvoice(tx, {
        idempotencyKey: key("inv"),
        contactId: w.kobe.id,
        invoiceDate: "2026-06-10",
        dueDate: "2026-07-20",
        amountsMode: "exclusive",
        lines: [{ itemId: widget.id, quantity: "3", unitPrice: "12.00" }],
      }),
    );
    await w.as((tx) => approveInvoice(tx, invoice.invoice.id, { idempotencyKey: key("a") }));
    const below = await w.check("2026-06-30", "negative_stock");
    expect(below.status).toBe("warning");
    expect(below.items).toEqual([{ label: "WIDGET", detail: "-1 on hand", href: null }]);
    expect(await w.check("2026-06-30", "stock")).toMatchObject({ status: "pass", summary: "Stock on hand -5.00 equals 1400 at 30 Jun 2026." });
    await bill("2026-06-20", "4", "6.00");
    expect(await w.statuses("2026-06-30")).toMatchObject({ stock: "pass", negative_stock: "pass" });
    expect((await w.check("2026-06-30", "stock")).summary).toBe("Stock on hand 18.00 equals 1400 at 30 Jun 2026.");
  });

  it("PC7: receivables and payables must equal their control accounts", async () => {
    const w = await setup();
    const invoice = await w.draftInvoice("2026-06-12");
    await w.asUser(bookkeeper, (tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    const bill = await w.draftBill("2026-06-20");
    await w.asUser(bookkeeper, (tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }));
    expect(await w.statuses("2026-06-30")).toMatchObject({ receivables: "pass", payables: "pass" });
    expect((await w.check("2026-06-30", "payables")).summary).toBe("Aged payables 230.00 equals 2000 Accounts payable at 30 Jun 2026.");
    await w.journal("2026-06-15", [
      ["1100", "50.00", ""],
      ["4000", "", "50.00"],
    ]);
    const receivables = await w.check("2026-06-30", "receivables");
    expect(receivables.status).toBe("warning");
    expect(receivables.summary).toBe(
      "Aged receivables 115.00 but 1100 Accounts receivable 165.00 at 30 Jun 2026 (difference -50.00): something was posted to the control account directly.",
    );
    await w.journal("2026-06-16", [
      ["4000", "50.00", ""],
      ["1100", "", "50.00"],
    ]);
    expect((await w.check("2026-06-30", "receivables")).status).toBe("pass");
  });

  it("PC8: GST returns ending by the month end must be filed", async () => {
    const w = await setup();
    expect((await w.check("2026-06-30", "gst")).status).toBe("not_applicable");
    await w.as((tx) => updateOrganisationSettings(tx, { gstNumber: "123-456-789" }));
    expect((await w.check("2026-06-30", "gst")).status).toBe("warning");
    await w.as((tx) => fileGstReturn(tx, { idempotencyKey: key("file"), periodStart: "2026-04-01", periodEnd: "2026-05-31" }));
    expect(await w.check("2026-06-30", "gst")).toMatchObject({
      status: "pass",
      summary: "Filed to 31 May 2026. No GST period setting, so each period is as long as the latest filed return (set it in Settings).",
    });
    const july = await w.check("2026-07-31", "gst");
    expect(july.status).toBe("warning");
    expect(july.items.map((item) => item.label)).toEqual(["1 Jun 2026 to 31 Jul 2026"]);
  });

  it("GP3, GP5, GP6: the GST period setting decides the next GST return on Home, the GST return and the period close", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { gstNumber: "123-456-789" }));
    // GP6: the setting (admins, in Settings); refused values change nothing.
    expect((await w.as((tx) => getOrganisationSettings(tx))).gstPeriod).toBeNull();
    await expect(w.as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 3, gstPeriodEndMonth: 3 }))).rejects.toThrow("six-monthly (6)");
    await expect(w.as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 2, gstPeriodEndMonth: 13 }))).rejects.toThrow("from 1 to 12");
    // With no filed return and no setting, the GST return has no suggestion (it opens on this month, as before).
    expect((await w.as((tx) => listGstReturns(tx, { today: "2026-10-01" }))).suggestedPeriod).toBeNull();
    // Two-monthly with a 31 March balance date: no month given, so periods end in March's months (odd).
    const odd = await w.as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 2 }));
    expect(odd.gstPeriod).toEqual({ months: 2, endMonth: 1 });
    const audit = await w.audit("organisation.settings_updated");
    expect(audit.at(-1)?.details).toMatchObject({ gstPeriod: { months: 2, endMonth: 1 } });
    // GP4: nothing filed, so the GST return opens on the latest period that has ended.
    expect((await w.as((tx) => listGstReturns(tx, { today: "2026-10-01" }))).suggestedPeriod).toEqual({ periodStart: "2026-08-01", periodEnd: "2026-09-30" });

    await w.as((tx) => fileGstReturn(tx, { idempotencyKey: key("file"), periodStart: "2026-04-01", periodEnd: "2026-05-31" }));
    // GP5, odd months: June passes; July needs June-July.
    expect(await w.check("2026-06-30", "gst")).toMatchObject({
      status: "pass",
      summary: "Filed to 31 May 2026. GST period setting: Two-monthly, ending in odd months (January, March, May, July, September, November).",
    });
    expect((await w.check("2026-07-31", "gst")).items.map((item) => item.label)).toEqual(["1 Jun 2026 to 31 Jul 2026"]);
    // Even months: the next return is June alone (the changeover), then July-August.
    await w.as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 2, gstPeriodEndMonth: 8 }));
    expect((await w.check("2026-06-30", "gst")).items.map((item) => item.label)).toEqual(["1 Jun 2026 to 30 Jun 2026"]);
    expect((await w.check("2026-08-31", "gst")).items.map((item) => item.label)).toEqual(["1 Jun 2026 to 30 Jun 2026", "1 Jul 2026 to 31 Aug 2026"]);
    // GP3: Home and the GST return use the same next period.
    const home = await w.as((tx) => getHomeSummary(tx, { today: "2026-07-05" }));
    expect(home.nextGstReturn).toMatchObject({ status: "ready", periodStart: "2026-06-01", periodEnd: "2026-06-30" });
    expect((await w.as((tx) => listGstReturns(tx, { today: "2026-07-05" }))).suggestedPeriod).toEqual({ periodStart: "2026-06-01", periodEnd: "2026-06-30" });
    // Monthly: June, then July.
    await w.as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 1 }));
    expect((await w.check("2026-07-31", "gst")).items.map((item) => item.label)).toEqual(["1 Jun 2026 to 30 Jun 2026", "1 Jul 2026 to 31 Jul 2026"]);
    // Cleared: back to the latest filed return's length (PC8).
    const cleared = await w.as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: null }));
    expect(cleared.gstPeriod).toBeNull();
    expect((await w.check("2026-07-31", "gst")).items.map((item) => item.label)).toEqual(["1 Jun 2026 to 31 Jul 2026"]);
  });

  it("PC9: the opening balance account must be 0.00", async () => {
    const w = await setup();
    await w.journal("2026-06-10", [
      ["6010", "100.00", ""],
      ["3900", "", "100.00"],
    ]);
    expect(await w.check("2026-06-30", "opening_balance")).toMatchObject({
      status: "warning",
      summary: "3900 Opening balance is 100.00 Cr at 30 Jun 2026: opening balances don't add up yet.",
    });
    await w.journal("2026-06-11", [
      ["3900", "100.00", ""],
      ["3000", "", "100.00"],
    ]);
    expect((await w.check("2026-06-30", "opening_balance")).status).toBe("pass");
  });

  it("PC10: closing locks the month; warnings need an owner or admin who confirms", async () => {
    const w = await setup();
    await w.journal("2026-06-10", [
      ["6010", "50.00", ""],
      ["3000", "", "50.00"],
    ]);
    const june = await w.checklist("2026-06-30");
    expect(june.warnings).toBe(0);
    expect(june.checks.map((entry) => [entry.key, entry.status])).toEqual([
      ["bank", "not_applicable"],
      ["drafts", "pass"],
      ["depreciation", "not_applicable"],
      ["fx_revaluation", "not_applicable"],
      ["stock", "not_applicable"],
      ["negative_stock", "not_applicable"],
      ["receivables", "pass"],
      ["payables", "pass"],
      ["gst", "not_applicable"],
      ["opening_balance", "pass"],
    ]);

    // A viewer can't close, over HTTP.
    const viewerCookie = await sessionCookieFor(viewer);
    const denied = await periodCloseRoute.POST(
      apiRequest("/api/ledger/period-close", { method: "POST", cookie: viewerCookie, body: { organisationId: w.org, action: "close", periodEnd: "2026-06-30" } }),
      undefined as never,
    );
    expect(denied.status).toBe(403);

    const bookkeeperCookie = await sessionCookieFor(bookkeeper);
    const closed = await periodCloseRoute.POST(
      apiRequest("/api/ledger/period-close", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: w.org, action: "close", periodEnd: "2026-06-30" } }),
      undefined as never,
    );
    expect(closed.status).toBe(200);
    expect(await w.lockDate()).toBe("2026-06-30");
    expect(await w.audit("ledger.period_closed")).toEqual([
      expect.objectContaining({ actor_email: bookkeeper.email, details: expect.objectContaining({ periodEnd: "2026-06-30", warningsAccepted: [] }) }),
    ]);
    await expect(
      w.journal("2026-06-30", [
        ["6010", "1.00", ""],
        ["3000", "", "1.00"],
      ]),
    ).rejects.toThrow("locked period");
    await expect(
      w.as((tx) =>
        tx.query(
          `insert into ledger_journals (command_source, idempotency_key, request_hash, posting_date, reference, currency_code, total_debit, total_credit, created_by_email)
           values ('test', 'direct', 'x', '2026-06-30', 'DIRECT', 'NZD', 1, 1, 'test@example.com')`,
        ),
      ),
    ).rejects.toThrow("closed period");
    expect((await w.close("2026-06-30", bookkeeper, "bookkeeper")).changed).toBe(false);

    await w.draftInvoice("2026-07-05");
    await expect(w.close("2026-07-31", bookkeeper, "bookkeeper")).rejects.toThrow("ask an owner or admin to close it anyway");
    await expect(w.close("2026-07-31", owner, "owner")).rejects.toThrow("Confirm to close it anyway");
    expect((await w.close("2026-07-31", owner, "owner", true)).changed).toBe(true);
    expect(await w.lockDate()).toBe("2026-07-31");
    const july = (await w.audit("ledger.period_closed"))[1];
    expect(july.actor_email).toBe(owner.email);
    expect(july.details.warningsAccepted).toEqual([expect.objectContaining({ key: "drafts", title: "No drafts left in the period" })]);
  });

  it("PC11: months with postings are closed in order", async () => {
    const w = await setup();
    for (const date of ["2026-06-10", "2026-07-10"]) {
      await w.journal(date, [
        ["6010", "10.00", ""],
        ["3000", "", "10.00"],
      ]);
    }
    await expect(w.close("2026-07-31", owner, "owner", true)).rejects.toThrow("Close June 2026 first");
    await w.close("2026-05-31", bookkeeper, "bookkeeper");
    expect(await w.lockDate()).toBe("2026-05-31");
    await w.close("2026-06-30", bookkeeper, "bookkeeper");
    await w.close("2026-07-31", bookkeeper, "bookkeeper");
    expect(await w.lockDate()).toBe("2026-07-31");
  });

  it("PC12: reopening needs an owner or admin and a reason, and reopens every later month", async () => {
    const w = await setup();
    for (const date of ["2026-06-10", "2026-07-10"]) {
      await w.journal(date, [
        ["6010", "10.00", ""],
        ["3000", "", "10.00"],
      ]);
    }
    for (const periodEnd of ["2026-05-31", "2026-06-30", "2026-07-31"]) await w.close(periodEnd, bookkeeper, "bookkeeper");
    await expect(w.reopen("2026-06-30", "Missing supplier bill", bookkeeper, "bookkeeper")).rejects.toThrow("Only an owner or admin");
    await expect(w.reopen("2026-06-30", "  ")).rejects.toThrow("reason is required");
    expect((await w.reopen("2026-06-30", "Missing supplier bill")).changed).toBe(true);
    expect(await w.lockDate()).toBe("2026-05-31");
    const periods = await w.as((tx) => listPeriods(tx, { today: "2026-08-15" }));
    const statusOf = (end: string) => periods.years.flatMap((year) => year.months).find((month) => month.end === end)?.status;
    expect([statusOf("2026-05-31"), statusOf("2026-06-30"), statusOf("2026-07-31")]).toEqual(["closed", "open", "open"]);
    expect(
      (
        await w.journal("2026-07-15", [
          ["6010", "5.00", ""],
          ["3000", "", "5.00"],
        ])
      ).created,
    ).toBe(true);
    const reopened = await w.audit("ledger.period_reopened");
    expect(reopened).toEqual([
      expect.objectContaining({
        actor_email: owner.email,
        details: expect.objectContaining({ periodEnd: "2026-06-30", reason: "Missing supplier bill", from: { lockDate: "2026-07-31" }, to: { lockDate: "2026-05-31" } }),
      }),
    ]);
    expect((await w.reopen("2026-06-30", "Again")).changed).toBe(false);
    await w.reopen("2026-05-31", "Start again");
    expect(await w.lockDate()).toBe("2026-04-30");
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import * as accountTransactionsRoute from "@/app/api/reports/account-transactions/route";
import * as agedPayablesRoute from "@/app/api/reports/aged-payables/route";
import * as journalReportRoute from "@/app/api/reports/journal-report/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { recordSupplierPayment, voidSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill, voidBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, voidInvoice } from "@/lib/invoices/service";
import { correctJournal, postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { dec, sub, toFixedString } from "@/lib/money/decimal";
import { type AccountTransactions, accountTransactions } from "@/lib/reports/account-transactions";
import { type AgedPayables, agedPayables } from "@/lib/reports/aged-payables";
import { balanceSheet, profitAndLoss, profitAndLossSplit, trialBalance } from "@/lib/reports/financial";
import { journalReport } from "@/lib/reports/journal-report";
import { applySupplierCreditNote } from "@/lib/supplier-credit-notes/applications";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { createTrackingValue, getTrackingSetup, type TrackingSetup } from "@/lib/tracking/service";
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

/**
 * Examples AGP1-AGP3 ("Aged payables"), ATX1-ATX5 ("Account transactions")
 * and JR1-JR3 ("Journal report") in docs/ACCOUNTING-EXAMPLES.md. Each test
 * gets its own organisation.
 */
describeWithDatabase("ledger reports", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `ledger-reports-${organisations}-co`;
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
    const line = (amount: string, accountCode: string, extra: Record<string, unknown> = {}) => ({
      description: "Item",
      quantity: "1",
      unitPrice: amount,
      accountCode,
      taxCode: "GST",
      ...extra,
    });
    const bill = async (contactId: string, number: string, amount: string, billDate: string, dueDate: string, user = owner) => {
      const draft = (
        await asUser(user, (tx) =>
          createBill(tx, {
            idempotencyKey: key("bill"),
            contactId,
            billDate,
            dueDate,
            supplierInvoiceNumber: number,
            amountsMode: "exclusive",
            lines: [line(amount, "6010")],
          }),
        )
      ).bill;
      return (await asUser(user, (tx) => approveBill(tx, draft.id, { idempotencyKey: key("approve") }))).bill;
    };
    const payBill = (billId: string, amount: string, paymentDate: string) =>
      as((tx) => recordSupplierPayment(tx, billId, { idempotencyKey: key("pay"), paymentDate, amount, bankAccountCode: "1000" }));
    const invoice = async (contactId: string, lines: unknown[], invoiceDate: string) => {
      const draft = (
        await as((tx) =>
          createInvoice(tx, { idempotencyKey: key("invoice"), contactId, invoiceDate, dueDate: "2026-07-31", amountsMode: "exclusive", lines }),
        )
      ).invoice;
      return (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }))).invoice;
    };
    return { org, as, asUser, contact, line, bill, payBill, invoice };
  }

  type World = Awaited<ReturnType<typeof setup>>;

  /** The documents of AGP1-AGP3. */
  async function payables() {
    const w = await setup();
    const paw = await w.contact("Paw Supplies", { isSupplier: true });
    const kiwi = await w.contact("Kiwi Freight", { isSupplier: true });
    const rata = await w.contact("Rata Print", { isSupplier: true });
    const ps101 = await w.bill(paw.id, "PS-101", "200.00", "2026-03-01", "2026-03-31");
    const ps101Payment = (await w.payBill(ps101.id, "30.00", "2026-04-10")).payment;
    const kf1 = await w.bill(kiwi.id, "KF-1", "300.00", "2026-05-01", "2026-05-15");
    const kf2 = await w.bill(kiwi.id, "KF-2", "100.00", "2026-05-01", "2026-05-15");
    await w.as((tx) => voidBill(tx, kf2.id, { idempotencyKey: key("void"), voidDate: "2026-05-10" }));
    const draftCredit = (
      await w.as((tx) =>
        createSupplierCreditNote(tx, {
          idempotencyKey: key("scn"),
          contactId: kiwi.id,
          creditNoteDate: "2026-06-01",
          supplierCreditNoteNumber: "KF-CR1",
          amountsMode: "exclusive",
          lines: [w.line("20.00", "6010")],
        }),
      )
    ).creditNote;
    const kfCredit = (await w.as((tx) => approveSupplierCreditNote(tx, draftCredit.id, { idempotencyKey: key("approve") }))).creditNote;
    await w.bill(rata.id, "RP-1", "100.00", "2026-06-20", "2026-07-20");
    await w.bill(rata.id, "RP-2", "200.00", "2026-07-21", "2026-08-20");
    await w.bill(rata.id, "RP-3", "100.00", "2026-08-05", "2026-08-20");
    return { w, ps101, ps101Payment, kf1, kfCredit };
  }

  const figures = (amounts: AgedPayables["total"]) => [
    amounts.current,
    amounts.days1to30,
    amounts.days31to60,
    amounts.days61to90,
    amounts.over90,
    amounts.credit,
    amounts.total,
  ];

  async function payableOnBalanceSheet(w: World, asAt: string) {
    const sheet = await w.as((tx) => balanceSheet(tx, { asAt }));
    return sheet.liabilities.sections.flatMap((s) => s.lines).find((l) => l.code === "2000")?.amount;
  }

  it("AGP1: aged payables as at 31 July 2026 ties to accounts payable", async () => {
    const { w } = await payables();
    const report = await w.as((tx) => agedPayables(tx, { asAt: "2026-07-31" }));
    expect(figures(report.total)).toEqual(["230.00", "115.00", "0.00", "345.00", "200.00", "23.00", "867.00"]);
    expect(report.rows.map((r) => [r.name, r.amounts.total])).toEqual([
      ["Kiwi Freight", "322.00"],
      ["Paw Supplies", "200.00"],
      ["Rata Print", "345.00"],
    ]);
    expect(report.rows.find((r) => r.name === "Paw Supplies")!.bills.map((b) => [b.supplierInvoiceNumber, b.daysOverdue, b.amountDue])).toEqual([
      ["PS-101", 122, "200.00"],
    ]);
    expect(report.rows.find((r) => r.name === "Kiwi Freight")!.bills.map((b) => [b.supplierInvoiceNumber, b.daysOverdue])).toEqual([["KF-1", 77]]);
    expect(report.rows.find((r) => r.name === "Kiwi Freight")!.credits.map((c) => [c.supplierCreditNoteNumber, c.unused])).toEqual([["KF-CR1", "23.00"]]);
    expect(report.rows.find((r) => r.name === "Rata Print")!.bills.map((b) => [b.supplierInvoiceNumber, b.daysOverdue])).toEqual([
      ["RP-1", 11],
      ["RP-2", 0],
    ]);
    expect(report.payablesAccount).toEqual({ code: "2000", name: "Accounts payable", balance: "867.00", difference: "0.00" });
    expect(await payableOnBalanceSheet(w, "2026-07-31")).toBe("867.00");
  });

  it("AGP2: as at 30 June 2026", async () => {
    const { w } = await payables();
    const report = await w.as((tx) => agedPayables(tx, { asAt: "2026-06-30" }));
    expect(figures(report.total)).toEqual(["115.00", "0.00", "345.00", "0.00", "200.00", "23.00", "637.00"]);
    expect(report.rows.find((r) => r.name === "Kiwi Freight")!.bills[0].daysOverdue).toBe(46);
    expect(report.rows.find((r) => r.name === "Paw Supplies")!.bills[0].daysOverdue).toBe(91);
    expect(report.payablesAccount?.difference).toBe("0.00");
    expect(await payableOnBalanceSheet(w, "2026-06-30")).toBe("637.00");
  });

  it("AGP3: credit applied and a payment voided later don't change an earlier date", async () => {
    const { w, ps101, ps101Payment, kf1, kfCredit } = await payables();
    await w.as((tx) =>
      applySupplierCreditNote(tx, kfCredit.id, { idempotencyKey: key("apply"), applicationDate: "2026-08-05", applications: [{ billId: kf1.id, amount: "23.00" }] }),
    );
    await w.as((tx) => voidSupplierPayment(tx, ps101.id, ps101Payment.id, { idempotencyKey: key("void"), voidDate: "2026-08-10" }));
    const july = await w.as((tx) => agedPayables(tx, { asAt: "2026-07-31" }));
    const kiwiJuly = july.rows.find((r) => r.name === "Kiwi Freight")!;
    expect([kiwiJuly.bills[0].amountDue, kiwiJuly.amounts.credit, kiwiJuly.amounts.total]).toEqual(["345.00", "23.00", "322.00"]);
    expect(july.rows.find((r) => r.name === "Paw Supplies")!.amounts.total).toBe("200.00");
    const fifth = await w.as((tx) => agedPayables(tx, { asAt: "2026-08-05" }));
    const kiwiFifth = fifth.rows.find((r) => r.name === "Kiwi Freight")!;
    expect([kiwiFifth.bills[0].amountDue, kiwiFifth.amounts.credit, kiwiFifth.amounts.total]).toEqual(["322.00", "0.00", "322.00"]);
    const tenth = await w.as((tx) => agedPayables(tx, { asAt: "2026-08-10" }));
    expect(tenth.rows.find((r) => r.name === "Paw Supplies")!.amounts.total).toBe("230.00");
    expect(tenth.payablesAccount?.difference).toBe("0.00");
  });

  /** The documents of ATX1-ATX3 and JR1-JR2. */
  async function ledger() {
    const w = await setup();
    const kobe = await w.contact("Kobe Ltd", { isCustomer: true });
    const paw = await w.contact("Paw Supplies", { isSupplier: true });
    await w.as((tx) =>
      postJournal(tx, {
        idempotencyKey: key("open"),
        postingDate: "2026-03-15",
        reference: "OPEN",
        lines: [
          { accountCode: "1000", debitAmount: "5000.00", creditAmount: "0" },
          { accountCode: "3000", debitAmount: "0", creditAmount: "5000.00" },
        ],
      }),
    );
    const inv1 = await w.invoice(kobe.id, [w.line("100.00", "4000")], "2026-04-10");
    await w.as((tx) => recordPayment(tx, inv1.id, { idempotencyKey: key("pay"), paymentDate: "2026-04-20", amount: "115.00", bankAccountCode: "1000" }));
    const ps101 = await w.bill(paw.id, "PS-101", "200.00", "2026-04-25", "2026-05-25", bookkeeper);
    const inv2 = await w.invoice(kobe.id, [w.line("50.00", "4000")], "2026-04-30");
    await w.as((tx) => voidInvoice(tx, inv2.id, { idempotencyKey: key("void"), voidDate: "2026-05-05" }));
    await w.payBill(ps101.id, "230.00", "2026-05-15");
    return { w, kobe, paw, inv1, inv2, ps101 };
  }

  const accountOf = (report: AccountTransactions, code: string) => report.accounts.find((a) => a.code === code)!;
  const trialOf = async (w: World, asAt: string) => {
    const tb = await w.as((tx) => trialBalance(tx, { asAt }));
    return new Map(tb.rows.map((row) => [row.code, row]));
  };

  it("ATX1: account 1000 from 1 Apr to 31 May, with links to the documents", async () => {
    const { w, inv1, ps101 } = await ledger();
    const bankId = (await w.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
    const report = await w.as((tx) => accountTransactions(tx, { accountId: bankId, from: "2026-04-01", to: "2026-05-31" }));
    expect(report.accounts).toHaveLength(1);
    const bank = report.accounts[0];
    expect(bank.opening).toBe("5000.00");
    expect(bank.lines.map((l) => [l.date, l.source.label, l.source.contactName, l.debit, l.credit, l.balance, l.source.href])).toEqual([
      ["2026-04-20", "Payment on invoice INV-0001", "Kobe Ltd", "115.00", "0.00", "5115.00", `/operations/invoices/${inv1.id}`],
      ["2026-05-15", "Payment of bill PS-101", "Paw Supplies", "0.00", "230.00", "4885.00", `/operations/bills/${ps101.id}`],
    ]);
    expect([bank.totalDebit, bank.totalCredit, bank.closing]).toEqual(["115.00", "230.00", "4885.00"]);
    expect((await trialOf(w, "2026-05-31")).get("1000")?.debit).toBe("4885.00");
  });

  it("P1/P2: P&L activity and balance sheet balances match the linked account transactions", async () => {
    const { w } = await ledger();
    const linkedFigures = await w.as(async (tx) => {
      const pnl = await profitAndLoss(tx, { from: "2026-04-01", to: "2026-05-31" });
      const sheet = await balanceSheet(tx, { asAt: "2026-05-31" });
      const accountRows = await tx.query<{ id: string; code: string }>("select id::text, code from accounts where code in ('1000', '4000')");
      const accountIds = new Map(accountRows.rows.map((row) => [row.code, row.id]));
      const sales = await accountTransactions(tx, {
        accountId: accountIds.get("4000"),
        from: "2026-04-01",
        to: "2026-05-31",
      });
      const bank = await accountTransactions(tx, {
        accountId: accountIds.get("1000"),
        from: sheet.financialYearStart,
        to: sheet.asAt,
      });
      return {
        pnlAmount: pnl.revenue.sections.flatMap((section) => section.lines).find((line) => line.code === "4000")!.amount,
        salesNet: toFixedString(sub(dec(sales.accounts[0].totalCredit), dec(sales.accounts[0].totalDebit)), 2),
        balanceSheetAmount: sheet.assets.sections.flatMap((section) => section.lines).find((line) => line.code === "1000")!.amount,
        bankClosing: bank.accounts[0].closing,
      };
    });
    expect(linkedFigures.salesNet).toBe(linkedFigures.pnlAmount);
    expect(linkedFigures.bankClosing).toBe(linkedFigures.balanceSheetAmount);
  });

  it("ATX2: income shows the void as its own line", async () => {
    const { w } = await ledger();
    const report = await w.as((tx) => accountTransactions(tx, { from: "2026-04-01", to: "2026-05-31" }));
    const sales = accountOf(report, "4000");
    expect(sales.opening).toBe("0.00");
    expect(sales.lines.map((l) => [l.date, l.source.label, l.debit, l.credit, l.balance])).toEqual([
      ["2026-04-10", "Invoice INV-0001", "0.00", "100.00", "-100.00"],
      ["2026-04-30", "Invoice INV-0002", "0.00", "50.00", "-150.00"],
      ["2026-05-05", "Void of invoice INV-0002", "50.00", "0.00", "-100.00"],
    ]);
    expect(sales.closing).toBe("-100.00");
    expect((await trialOf(w, "2026-05-31")).get("4000")?.credit).toBe("100.00");
  });

  it("ATX3: every account from the start of the financial year ties to the trial balance", async () => {
    const { w } = await ledger();
    const report = await w.as((tx) => accountTransactions(tx, { to: "2026-05-31" }));
    expect(report.from).toBe("2026-04-01");
    expect(report.accounts.map((a) => [a.code, a.closing, a.lines.length])).toEqual([
      ["1000", "4885.00", 2],
      ["1100", "0.00", 4],
      ["2000", "0.00", 2],
      ["2100", "15.00", 4],
      ["3000", "-5000.00", 0],
      ["4000", "-100.00", 3],
      ["6010", "200.00", 1],
    ]);
    expect(accountOf(report, "2100").lines.map((l) => [l.debit, l.credit])).toEqual([
      ["0.00", "15.00"],
      ["30.00", "0.00"],
      ["0.00", "7.50"],
      ["7.50", "0.00"],
    ]);
    expect([report.totalDebit, report.totalCredit]).toEqual(["805.00", "805.00"]);
    const tb = await trialOf(w, "2026-05-31");
    for (const account of report.accounts) {
      const row = tb.get(account.code);
      const signed = row ? (row.debit !== "0.00" ? row.debit : `-${row.credit}`) : "0.00";
      expect([account.code, account.closing]).toEqual([account.code, signed]);
    }
  });

  it("ATX4: filtered by a tracking value and everything under it", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const setupNow = await w.as((tx) => getTrackingSetup(tx));
    const location = setupNow.categories.find((c) => c.kind === "location")!.id;
    const department = setupNow.categories.find((c) => c.kind === "department")!.id;
    const values: Record<string, string> = {};
    const find = (s: TrackingSetup, category: string, name: string) => s.categories.find((c) => c.id === category)!.values.find((v) => v.name === name)!.id;
    for (const [category, name, parent] of [
      [location, "Otago", null],
      [location, "Dunedin", "Otago"],
      [location, "Canterbury", null],
      [department, "Retail", null],
    ] as const) {
      const s = await w.as((tx) => createTrackingValue(tx, { categoryId: category, name, parentId: parent ? values[parent] : null }));
      values[name] = find(s, category, name);
    }
    const kobe = await w.contact("Kobe Ltd", { isCustomer: true });
    await w.invoice(
      kobe.id,
      [w.line("100.00", "4000", { tracking: { [location]: values.Dunedin } }), w.line("40.00", "4000", { tracking: { [location]: values.Canterbury } })],
      "2026-05-12",
    );
    const salesId = (await w.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '4000'"))).rows[0].id;
    const run = (valueId?: string, categoryId = location) =>
      w.as((tx) =>
        accountTransactions(tx, { accountId: salesId, from: "2026-05-01", to: "2026-05-31", trackingCategoryId: valueId ? categoryId : null, trackingValueId: valueId ?? null }),
      );
    const otago = (await run(values.Otago)).accounts[0];
    expect(otago.lines.map((l) => l.credit)).toEqual(["100.00"]);
    expect(otago.closing).toBe("-100.00");
    expect((await run(values.Otago)).filter?.label).toBe("Location: Otago");
    const split = await w.as((tx) => profitAndLossSplit(tx, { from: "2026-05-01", to: "2026-05-31", categoryId: location }));
    const splitSales = split.revenue.sections.flatMap((section) => section.lines).find((line) => line.accountId === salesId)!;
    expect(splitSales.amounts[values.Otago]).toBe(otago.totalCredit);
    expect((await run(values.Canterbury)).accounts[0].lines.map((l) => l.credit)).toEqual(["40.00"]);
    expect((await run()).accounts[0].closing).toBe("-140.00");
    await w.invoice(kobe.id, [w.line("20.00", "4000")], "2026-06-01");
    const notSet = await w.as((tx) =>
      accountTransactions(tx, {
        accountId: salesId,
        from: "2026-06-01",
        to: "2026-06-30",
        trackingCategoryId: location,
        trackingValueId: "unassigned",
      }),
    );
    expect([notSet.accounts[0].totalCredit, notSet.filter?.label]).toEqual(["20.00", "Location: Not set"]);
    await expect(run(values.Retail)).rejects.toThrow("isn't in that category");
  });

  /** The ATX5 / JR3 correction. */
  async function corrected(w: World) {
    const posted = await w.as((tx) =>
      postJournal(tx, {
        idempotencyKey: key("fees"),
        postingDate: "2026-05-01",
        reference: "Fees",
        lines: [
          { accountCode: "6010", debitAmount: "80.00", creditAmount: "0" },
          { accountCode: "1000", debitAmount: "0", creditAmount: "80.00" },
        ],
      }),
    );
    await w.as((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("fix"),
        originalJournalId: posted.journal.id,
        postingDate: "2026-05-10",
        reference: "Fees",
        lines: [
          { accountCode: "6100", debitAmount: "80.00" },
          { accountCode: "1000", creditAmount: "80.00" },
        ],
      }),
    );
    return posted.journal.id;
  }

  it("ATX5: a correction's reversal and replacement are their own lines", async () => {
    const { w } = await ledger();
    const originalId = await corrected(w);
    const report = await w.as((tx) => accountTransactions(tx, { from: "2026-05-01", to: "2026-05-31" }));
    const fees = accountOf(report, "6010");
    expect(fees.opening).toBe("200.00");
    expect(fees.lines.map((l) => [l.date, l.source.label, l.debit, l.credit, l.balance])).toEqual([
      ["2026-05-01", "Manual journal Fees", "80.00", "0.00", "280.00"],
      ["2026-05-10", "Reversal REV-Fees", "0.00", "80.00", "200.00"],
    ]);
    expect(fees.lines[0].source.href).toBe(`/operations/ledger-journals?journal=${originalId}`);
    expect(fees.closing).toBe("200.00");
    expect(accountOf(report, "6100").lines.map((l) => [l.date, l.source.label, l.debit])).toEqual([["2026-05-10", "Replacement Fees", "80.00"]]);
  });

  it("JR1: every journal in the range with its lines, source and who posted it", async () => {
    const { w } = await ledger();
    const report = await w.as((tx) => journalReport(tx, { from: "2026-04-01", to: "2026-05-31" }));
    expect(report.journals.map((j) => [j.date, j.source.label, j.totalDebit])).toEqual([
      ["2026-04-10", "Invoice INV-0001", "115.00"],
      ["2026-04-20", "Payment on invoice INV-0001", "115.00"],
      ["2026-04-25", "Bill PS-101", "230.00"],
      ["2026-04-30", "Invoice INV-0002", "57.50"],
      ["2026-05-05", "Void of invoice INV-0002", "57.50"],
      ["2026-05-15", "Payment of bill PS-101", "230.00"],
    ]);
    expect(report.journals[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
      ["1100", "115.00", "0.00"],
      ["4000", "0.00", "100.00"],
      ["2100", "0.00", "15.00"],
    ]);
    expect(report.journals[2].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
      ["6010", "200.00", "0.00"],
      ["2100", "30.00", "0.00"],
      ["2000", "0.00", "230.00"],
    ]);
    expect(report.journals[2].postedByEmail).toBe("bookkeeper@example.com");
    expect(report.journals[0].postedByEmail).toBe("owner@example.com");
    expect([report.totalDebit, report.totalCredit]).toEqual(["805.00", "805.00"]);
    expect(report.truncated).toBe(false);
    // Who posted each journal is the same user as its audit event.
    const audit = await w.as((tx) =>
      tx.query<{ entity_id: string; actor_email: string }>("select entity_id, actor_email from audit_events where event_type = 'ledger.journal_posted'"),
    );
    const byJournal = new Map(audit.rows.map((row) => [row.entity_id, row.actor_email]));
    for (const journal of report.journals) expect(byJournal.get(journal.journalId)).toBe(journal.postedByEmail);
  });

  it("JR2: the opening journal, an empty range, and dates the wrong way round", async () => {
    const { w } = await ledger();
    const march = await w.as((tx) => journalReport(tx, { from: "2026-03-01", to: "2026-05-31" }));
    expect([march.journals[0].date, march.journals[0].source.label, march.journals[0].totalDebit]).toEqual(["2026-03-15", "Manual journal OPEN", "5000.00"]);
    expect([march.totalDebit, march.totalCredit]).toEqual(["5805.00", "5805.00"]);
    const june = await w.as((tx) => journalReport(tx, { from: "2026-06-01", to: "2026-06-30" }));
    expect([june.journals.length, june.totalDebit, june.totalCredit]).toEqual([0, "0.00", "0.00"]);
    await expect(w.as((tx) => journalReport(tx, { from: "2026-06-30", to: "2026-06-01" }))).rejects.toThrow("on or before the end date");
  });

  it("JR3: corrections list the reversal and replacement as their own journals", async () => {
    const { w } = await ledger();
    await corrected(w);
    const report = await w.as((tx) => journalReport(tx, { from: "2026-05-01", to: "2026-05-31" }));
    expect(report.journals.map((j) => [j.date, j.source.label])).toEqual([
      ["2026-05-01", "Manual journal Fees"],
      ["2026-05-05", "Void of invoice INV-0002"],
      ["2026-05-10", "Reversal REV-Fees"],
      ["2026-05-10", "Replacement Fees"],
      ["2026-05-15", "Payment of bill PS-101"],
    ]);
  });

  it("over HTTP: viewers can read the three reports; outsiders can't", async () => {
    const { w } = await payables();
    const cookie = await sessionCookieFor(viewer);
    const aged = await agedPayablesRoute.GET(apiRequest(`/api/reports/aged-payables?organisationId=${w.org}&asAt=2026-07-31`, { cookie }), noContext);
    expect(aged.status).toBe(200);
    expect(((await aged.json()) as AgedPayables).total.total).toBe("867.00");
    const atx = await accountTransactionsRoute.GET(
      apiRequest(`/api/reports/account-transactions?organisationId=${w.org}&from=2026-04-01&to=2026-07-31`, { cookie }),
      noContext,
    );
    expect(atx.status).toBe(200);
    const journals = await journalReportRoute.GET(apiRequest(`/api/reports/journal-report?organisationId=${w.org}&from=2026-03-01&to=2026-08-31`, { cookie }), noContext);
    expect(journals.status).toBe(200);
    const outsider = await createTestUser(`outsider-${organisations}@example.com`);
    const refused = await agedPayablesRoute.GET(
      apiRequest(`/api/reports/aged-payables?organisationId=${w.org}`, { cookie: await sessionCookieFor(outsider) }),
      noContext,
    );
    expect(refused.status).toBe(404);
  });
});

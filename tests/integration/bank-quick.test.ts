import { afterAll, beforeAll, expect, it } from "vitest";
import * as confidentRoute from "@/app/api/bank-accounts/[accountId]/confident-matches/route";
import * as okRoute from "@/app/api/statement-lines/[lineId]/ok/route";
import * as cashCodingRoute from "@/app/api/bank-accounts/[accountId]/cash-coding/route";
import { cashCodeStatementLines } from "@/lib/bank/cash-coding";
import type { SessionUser } from "@/lib/auth/sessions";
import * as bankRecReportRoute from "@/app/api/reports/bank-reconciliation/route";
import { createBankAccount, listBankAccounts, listStatementLines, setStatementLineExcluded } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { confidentMatches, okConfidentMatches, okStatementLine } from "@/lib/bank/confident";
import { reconcileStatementLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import { createBankRule } from "@/lib/bank/rules";
import { createBankTransaction, getBankTransaction, voidBankTransaction } from "@/lib/bank/transactions";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill, getBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { bankReconciliationReport } from "@/lib/reports/bank-reconciliation";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { dec, sub, toFixedString } from "@/lib/money/decimal";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
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

const CSV = `Date,Amount,Payee,Particulars,Code,Reference
20/05/2026,115.00,KOBE LTD,INV-0001,,
21/05/2026,-46.00,Z ENERGY,,,
22/05/2026,-500.00,TRANSFER,SAVINGS,,
`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * Examples BK17 onwards in docs/ACCOUNTING-EXAMPLES.md (quicker bank
 * reconciliation, not yet approved by Jess). The same set-up as BK1-BK16:
 * 1000 Business bank account, 1010 Savings account, GST at 15%, Kobe Ltd with
 * INV-0001 (115.00) and Kauri Supplies with B1 (230.00), both 10 May 2026,
 * and the contact Z Energy.
 */
describeWithDatabase("quicker bank reconciliation", () => {
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
    const org = `quick-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
      inOrganisation(org, { userId: user.id, email: user.email }, work);
    const run: OrgRunner = (work) => asUser(bookkeeper, work);
    const contact = async (name: string, flags: { isCustomer?: boolean; isSupplier?: boolean }): Promise<Contact> =>
      (await asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...flags }))).contact;
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const kauri = await contact("Kauri Supplies", { isSupplier: true });
    const zEnergy = await contact("Z Energy", { isSupplier: true });
    await asUser(owner, (tx) => createBankAccount(tx, { code: "1010", name: "Savings account", accountType: "bank" }));
    const bank = (await asUser(viewer, (tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const invoice = (date: string, unitPrice = "50.00") =>
      asUser(bookkeeper, async (tx) => {
        const drafted = await createInvoice(tx, {
          idempotencyKey: key("invoice"),
          contactId: kobe.id,
          invoiceDate: date,
          dueDate: "2026-06-20",
          amountsMode: "exclusive",
          lines: [{ description: "Consulting", quantity: "2", unitPrice, accountCode: "4000", taxCode: "GST" }],
        });
        return (await approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("approve") })).invoice;
      });
    const i1 = await invoice("2026-05-10");
    const b1 = await asUser(bookkeeper, async (tx) => {
      const drafted = await createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: kauri.id,
        billDate: "2026-05-10",
        dueDate: "2026-06-20",
        supplierInvoiceNumber: "K-100",
        amountsMode: "exclusive",
        lines: [{ description: "Year-end accounts", quantity: "1", unitPrice: "200.00", accountCode: "6010", taxCode: "GST" }],
      });
      return (await approveBill(tx, drafted.bill.id, { idempotencyKey: key("approve") })).bill;
    });
    const importFile = (text: string, accountId = bank.id) =>
      asUser(bookkeeper, (tx) => importStatementFile(tx, accountId, { idempotencyKey: key("import"), fileName: "statement.csv", fileBase64: b64(text) }));
    const lines = async (status = "all", accountId = bank.id) =>
      (await asUser(viewer, (tx) => listStatementLines(tx, accountId, { status }))).lines;
    const lineOn = async (amount: string, date?: string) =>
      (await lines()).find((line) => line.amount === amount && (!date || line.date === date))!;
    const confident = () => asUser(viewer, (tx) => confidentMatches(tx, bank.id));
    const confidentFor = async (lineId: string) => (await confident()).find((entry) => entry.lineId === lineId)!;
    const reconcile = (lineId: string, command: Record<string, unknown>) =>
      asUser(bookkeeper, (tx) => reconcileStatementLine(tx, lineId, { idempotencyKey: key("reconcile"), ...command }));
    const postedLines = async (journalId: string) =>
      (await asUser(owner, (tx) => getJournal(tx, journalId))).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);
    const journalCount = async () =>
      Number((await asUser(owner, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count);
    const lock = (lockDate: string | null) => asUser(owner, (tx) => updatePeriodControls(tx, { lockDate }));
    const zRule = () =>
      asUser(bookkeeper, (tx) =>
        createBankRule(tx, {
          name: "Z Energy",
          matchText: "Z ENERGY",
          direction: "out",
          contactId: zEnergy.id,
          targetAccountCode: "6120",
          taxCode: "GST",
          amountsMode: "inclusive",
        }),
      );
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));
    return {
      org, asUser, run, kobe, kauri, zEnergy, bank, i1, b1, invoice, importFile, lines, lineOn, confident, confidentFor,
      reconcile, postedLines, journalCount, lock, zRule, sql,
    };
  }

  it("BK17: a confident suggestion is the only exact candidate; ties, competing lines and posted-before-rule", async () => {
    const world = await setup();
    await world.importFile(CSV);
    const income = await world.lineOn("115.00");
    const fuel = await world.lineOn("-46.00");
    const transfer = await world.lineOn("-500.00");
    expect(await world.confidentFor(income.id)).toMatchObject({
      candidateCount: 1,
      competing: false,
      suggestion: { kind: "payment", key: `invoice:${world.i1.id}`, documentKind: "invoice", number: world.i1.invoiceNumber, amountDue: "115.00" },
    });
    expect(await world.confidentFor(fuel.id)).toMatchObject({ candidateCount: 0, suggestion: null });
    expect(await world.confidentFor(transfer.id)).toMatchObject({ candidateCount: 0, suggestion: null });
    const rule = await world.zRule();
    expect(await world.confidentFor(fuel.id)).toMatchObject({
      suggestion: { kind: "rule", key: `rule:${rule.id}`, contactId: world.zEnergy.id, accountCode: "6120", taxCode: "GST", amountsMode: "inclusive" },
    });

    // An invoice dated after the line isn't a candidate.
    await world.invoice("2026-05-21");
    expect((await world.confidentFor(income.id)).candidateCount).toBe(1);
    // A tie: a second 115.00 invoice dated before the line.
    await world.invoice("2026-05-12");
    expect(await world.confidentFor(income.id)).toMatchObject({ candidateCount: 2, suggestion: null });
  });

  it("BK17: two lines competing for one invoice get no OK; a posted payment is the candidate, until it's voided", async () => {
    const world = await setup();
    await world.importFile(CSV);
    await world.importFile("Date,Amount,Payee\n25/05/2026,115.00,KOBE LIMITED\n");
    const first = await world.lineOn("115.00", "2026-05-20");
    const second = await world.lineOn("115.00", "2026-05-25");
    expect(await world.confidentFor(first.id)).toMatchObject({ candidateCount: 1, competing: true, suggestion: null });
    expect(await world.confidentFor(second.id)).toMatchObject({ candidateCount: 1, competing: true, suggestion: null });

    const other = await setup();
    await other.importFile(CSV);
    const income = await other.lineOn("115.00");
    const { payment } = await other.asUser(bookkeeper, (tx) =>
      recordPayment(tx, other.i1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-19", amount: "115.00", bankAccountCode: "1000" }),
    );
    const bankLine = (await other.sql("select id::text from ledger_journal_lines where journal_id = $1 and debit_amount > 0", [payment.journalId])).rows[0]
      .id as string;
    expect(await other.confidentFor(income.id)).toMatchObject({
      candidateCount: 1,
      suggestion: { kind: "match", key: `match:${bankLine}`, journalId: payment.journalId, amount: "115.00", postingDate: "2026-05-19" },
    });
    await other.asUser(bookkeeper, (tx) => voidPayment(tx, other.i1.id, payment.id, { idempotencyKey: key("void"), voidDate: "2026-05-19" }));
    // Voided: neither the payment nor its reversal is a candidate, and INV-0001 is due again.
    expect(await other.confidentFor(income.id)).toMatchObject({ candidateCount: 1, suggestion: { kind: "payment", documentId: other.i1.id } });
  });

  it("BK17: spend money already posted wins over a bank rule, so nothing is posted twice", async () => {
    const world = await setup();
    await world.importFile(CSV);
    await world.zRule();
    const { bankTransaction } = await world.asUser(bookkeeper, (tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("spend"),
        kind: "spend",
        accountId: world.bank.id,
        contactId: world.zEnergy.id,
        date: "2026-05-21",
        amountsMode: "inclusive",
        lines: [{ description: "Petrol", accountCode: "6120", taxCode: "GST", amount: "46.00" }],
      }),
    );
    const fuel = await world.lineOn("-46.00");
    expect(await world.confidentFor(fuel.id)).toMatchObject({ candidateCount: 1, suggestion: { kind: "match", journalId: bankTransaction.journalId } });
    const before = await world.journalCount();
    await world.asUser(bookkeeper, (tx) => okStatementLine(tx, fuel.id, { idempotencyKey: key("ok") }));
    expect(await world.journalCount()).toBe(before);
    expect((await world.lineOn("-46.00")).status).toBe("reconciled");
  });

  it("BK18: OK pays INV-0001 or applies the rule through the reconcile command; a changed suggestion is refused", async () => {
    const world = await setup();
    await world.importFile(CSV);
    await world.zRule();
    const income = await world.lineOn("115.00");
    const fuel = await world.lineOn("-46.00");
    const okKey = key("ok");
    const done = await world.asUser(bookkeeper, (tx) => okStatementLine(tx, income.id, { idempotencyKey: okKey, expect: `invoice:${world.i1.id}` }));
    expect(done.created).toBe(true);
    expect(done.line).toMatchObject({ status: "reconciled", reconciliation: { kind: "payments" } });
    const paymentJournal = done.line.reconciliation!.items[0].journalId;
    expect(await world.postedLines(paymentJournal)).toEqual([
      ["1000", "115.00", "0.00"],
      ["1100", "0.00", "115.00"],
    ]);
    expect((await world.sql("select payment_date::text from customer_payments where journal_id = $1", [paymentJournal])).rows[0].payment_date).toBe(
      "2026-05-20",
    );
    expect(await world.asUser(viewer, (tx) => getInvoice(tx, world.i1.id))).toMatchObject({ paidStatus: "paid", amountDue: "0.00" });
    // A retry returns the same line and posts nothing more.
    const journals = await world.journalCount();
    expect(await world.asUser(bookkeeper, (tx) => okStatementLine(tx, income.id, { idempotencyKey: okKey, expect: `invoice:${world.i1.id}` }))).toEqual({
      ...done,
      created: false,
    });
    expect(await world.journalCount()).toBe(journals);

    // A suggestion that changed since it was shown is refused.
    await expect(
      world.asUser(bookkeeper, (tx) => okStatementLine(tx, fuel.id, { idempotencyKey: key("ok"), expect: `invoice:${world.i1.id}` })),
    ).rejects.toThrow(/has changed since it was shown/);
    expect(await world.journalCount()).toBe(journals);
    const ruled = await world.asUser(bookkeeper, (tx) => okStatementLine(tx, fuel.id, { idempotencyKey: key("ok") }));
    expect(ruled.line.reconciliation!.kind).toBe("bank_transaction");
    expect(await world.postedLines(ruled.line.reconciliation!.items[0].journalId)).toEqual([
      ["6120", "40.00", "0.00"],
      ["2100", "6.00", "0.00"],
      ["1000", "0.00", "46.00"],
    ]);
    // Nothing confident on the transfer line.
    const transfer = await world.lineOn("-500.00");
    await expect(world.asUser(bookkeeper, (tx) => okStatementLine(tx, transfer.id, { idempotencyKey: key("ok") }))).rejects.toThrow(
      /no confident match/,
    );
  });

  it("BK18: over HTTP viewers read suggestions but can't OK; bookkeepers can", async () => {
    const world = await setup();
    await world.importFile(CSV);
    const income = await world.lineOn("115.00");
    const [bookkeeperCookie, viewerCookie] = await Promise.all([bookkeeper, viewer].map((user) => sessionCookieFor(user)));
    const listed = await confidentRoute.GET(
      apiRequest(`/api/bank-accounts/${world.bank.id}/confident-matches?organisationId=${world.org}`, { cookie: viewerCookie }),
      params({ accountId: world.bank.id }),
    );
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { confidentCount: number }).confidentCount).toBe(1);
    const httpKey = key("http");
    const post = (cookie: string) =>
      okRoute.POST(
        apiRequest(`/api/statement-lines/${income.id}/ok`, {
          method: "POST",
          cookie,
          body: { organisationId: world.org, idempotencyKey: httpKey, expect: `invoice:${world.i1.id}` },
        }),
        params({ lineId: income.id }),
      );
    expect((await post(viewerCookie)).status).toBe(403);
    expect((await post(bookkeeperCookie)).status).toBe(201);
    expect((await post(bookkeeperCookie)).status).toBe(200);
    const bulk = (cookie: string) =>
      confidentRoute.POST(
        apiRequest(`/api/bank-accounts/${world.bank.id}/confident-matches`, {
          method: "POST",
          cookie,
          body: { organisationId: world.org, idempotencyKey: key("bulk") },
        }),
        params({ accountId: world.bank.id }),
      );
    expect((await bulk(viewerCookie)).status).toBe(403);
    expect(await (await bulk(bookkeeperCookie)).json()).toEqual({ results: [], succeeded: 0, failed: 0 });
  });

  it("BK19: OK all confident matches does each line on its own: 1 succeeded, 1 failed in a locked period", async () => {
    const world = await setup();
    await world.importFile(CSV);
    await world.zRule();
    await world.lock("2026-05-20");
    const income = await world.lineOn("115.00");
    const fuel = await world.lineOn("-46.00");
    const shown = (await world.confident()).filter((entry) => entry.suggestion).map((entry) => ({ lineId: entry.lineId, expect: entry.suggestion!.key }));
    expect(shown.map((entry) => entry.lineId)).toEqual([income.id, fuel.id]);
    const bulkKey = key("bulk");
    const result = await okConfidentMatches(world.run, world.bank.id, { idempotencyKey: bulkKey, items: shown });
    expect(result).toMatchObject({ succeeded: 1, failed: 1 });
    expect(result.results).toEqual([
      {
        lineId: income.id,
        ok: false,
        error: "2026-05-20 is in a locked period (locked up to 2026-05-20). Use a later date, or ask an admin to open an unlock window.",
      },
      expect.objectContaining({ lineId: fuel.id, ok: true, created: true }),
    ]);
    expect((await world.lineOn("-46.00")).status).toBe("reconciled");
    expect((await world.lineOn("115.00")).status).toBe("unreconciled");
    expect((await world.lineOn("-500.00")).status).toBe("unreconciled");
    const journals = await world.journalCount();
    const again = await okConfidentMatches(world.run, world.bank.id, { idempotencyKey: bulkKey, items: shown });
    expect(again.results[1]).toMatchObject({ lineId: fuel.id, ok: true, created: false });
    expect(await world.journalCount()).toBe(journals);
    // Unlocked, OK all (without a list) does what's confident now.
    await world.lock(null);
    const rest = await okConfidentMatches(world.run, world.bank.id, { idempotencyKey: key("bulk") });
    expect(rest).toMatchObject({ succeeded: 1, failed: 0, results: [expect.objectContaining({ lineId: income.id, ok: true })] });
  });

  const BK20_CSV = `Date,Amount,Payee,Particulars,Code,Reference,Balance
01/05/2026,1000.00,J KELLY,CAPITAL,,,1000.00
20/05/2026,115.00,KOBE LTD,INV-0001,,,1115.00
21/05/2026,-46.00,Z ENERGY,,,,1069.00
28/05/2026,-12.00,MONTHLY FEE,,,,1057.00
02/06/2026,-230.00,KAURI SUPPLIES,K-100,,,827.00
`;

  async function bk20World() {
    const world = await setup();
    await world.importFile(BK20_CSV);
    const { journal } = await world.asUser(bookkeeper, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("capital"),
        postingDate: "2026-05-01",
        reference: "Capital",
        lines: [
          { accountCode: "1000", debitAmount: "1000.00" },
          { accountCode: "3000", creditAmount: "1000.00" },
        ],
      }),
    );
    const capitalLine = (await world.sql("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [journal.id, world.bank.id]))
      .rows[0].id as string;
    await world.reconcile((await world.lineOn("1000.00")).id, { kind: "match", journalLineIds: [capitalLine] });
    await world.reconcile((await world.lineOn("115.00")).id, { kind: "payments", allocations: [{ invoiceId: world.i1.id, amount: "115.00" }] });
    await world.reconcile((await world.lineOn("-46.00")).id, {
      kind: "bank_transaction",
      contactId: world.zEnergy.id,
      amountsMode: "inclusive",
      lines: [{ description: "Petrol", accountCode: "6120", taxCode: "GST", amount: "46.00" }],
    });
    const { payment } = await world.asUser(bookkeeper, (tx) =>
      recordSupplierPayment(tx, world.b1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-30", amount: "230.00", bankAccountCode: "1000" }),
    );
    const paymentLine = (await world.sql("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [payment.journalId, world.bank.id]))
      .rows[0].id as string;
    await world.reconcile((await world.lineOn("-230.00")).id, { kind: "match", journalLineIds: [paymentLine] });
    const { bankTransaction } = await world.asUser(bookkeeper, (tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("receive"),
        kind: "receive",
        accountId: world.bank.id,
        contactId: world.kobe.id,
        date: "2026-05-31",
        amountsMode: "inclusive",
        lines: [{ description: "Cash sale", accountCode: "4000", taxCode: "GST", amount: "57.50" }],
      }),
    );
    const report = (asAt: string) => world.asUser(viewer, (tx) => bankReconciliationReport(tx, { accountId: world.bank.id, asAt }));
    return { ...world, payment, bankTransaction, report };
  }

  it("BK20: as at 31 May, 896.50 in Tohyee, -12.00 in the bank only, -172.50 in Tohyee only, explain the 1,057.00 statement balance", async () => {
    const world = await bk20World();
    const before = await world.journalCount();
    const may = await world.report("2026-05-31");
    expect(may).toMatchObject({
      asAt: "2026-05-31",
      ledgerBalance: "896.50",
      statementBalance: "1057.00",
      statementBalanceSource: { kind: "line_balance", date: "2026-05-28", balance: "1057.00", linesAfter: 0, linesAfterTotal: "0.00" },
      bankNotInTohyee: { total: "-12.00" },
      tohyeeNotInBank: { total: "-172.50" },
      expectedStatementBalance: "1057.00",
      notExplained: "0.00",
      explained: true,
    });
    expect(may.bankNotInTohyee.items.map((item) => [item.date, item.description, item.amount, item.why])).toEqual([
      ["2026-05-28", "MONTHLY FEE", "-12.00", "unreconciled"],
    ]);
    expect(may.tohyeeNotInBank.items.map((item) => [item.date, item.origin, item.amount, item.reconciledOn])).toEqual([
      ["2026-05-30", "supplier_payment", "-230.00", "2026-06-02"],
      ["2026-05-31", "bank_transaction", "57.50", null],
    ]);
    expect(await world.report("2026-06-30")).toMatchObject({
      ledgerBalance: "896.50",
      statementBalance: "827.00",
      statementBalanceSource: { kind: "line_balance", date: "2026-06-02" },
      bankNotInTohyee: { total: "-12.00" },
      tohyeeNotInBank: { total: "57.50" },
      expectedStatementBalance: "827.00",
      explained: true,
    });
    const earlier = await world.report("2026-05-25");
    expect(earlier).toMatchObject({ ledgerBalance: "1069.00", statementBalance: "1069.00", expectedStatementBalance: "1069.00", explained: true });
    expect(earlier.bankNotInTohyee.items).toEqual([]);
    expect(earlier.tohyeeNotInBank.items).toEqual([]);
    expect(await world.journalCount()).toBe(before);
    // Viewers can read it over HTTP.
    const cookie = await sessionCookieFor(viewer);
    const response = await bankRecReportRoute.GET(
      apiRequest(`/api/reports/bank-reconciliation?organisationId=${world.org}&accountId=${world.bank.id}&asAt=2026-05-31`, { cookie }),
      undefined,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ statementBalance: "1057.00", explained: true });
  });

  it("BK20: a statement line matched to a journal dated after the report date is still in the bank, not in Tohyee", async () => {
    const world = await setup();
    await world.importFile("Date,Amount,Payee,Balance\n28/05/2026,-230.00,KAURI SUPPLIES,-230.00\n");
    const { payment } = await world.asUser(bookkeeper, (tx) =>
      recordSupplierPayment(tx, world.b1.id, { idempotencyKey: key("pay"), paymentDate: "2026-06-01", amount: "230.00", bankAccountCode: "1000" }),
    );
    const paymentLine = (await world.sql("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [payment.journalId, world.bank.id]))
      .rows[0].id as string;
    await world.reconcile((await world.lineOn("-230.00")).id, { kind: "match", journalLineIds: [paymentLine] });
    const report = await world.asUser(viewer, (tx) => bankReconciliationReport(tx, { accountId: world.bank.id, asAt: "2026-05-31" }));
    expect(report).toMatchObject({ ledgerBalance: "0.00", statementBalance: "-230.00", expectedStatementBalance: "-230.00", explained: true });
    expect(report.bankNotInTohyee.items).toEqual([
      expect.objectContaining({ amount: "-230.00", why: "matched_later", matchedJournalId: payment.journalId, matchedDate: "2026-06-01" }),
    ]);
  });

  it("BK20: a spend money voided by the date isn't listed (it and its reversal cancel out); before the void it is", async () => {
    const world = await bk20World();
    const { bankTransaction } = await world.asUser(bookkeeper, (tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("spend"),
        kind: "spend",
        accountId: world.bank.id,
        contactId: world.zEnergy.id,
        date: "2026-05-29",
        amountsMode: "no_tax",
        lines: [{ description: "Wrong account", accountCode: "6120", amount: "20.00" }],
      }),
    );
    await world.asUser(bookkeeper, (tx) => voidBankTransaction(tx, bankTransaction.id, { idempotencyKey: key("void"), voidDate: "2026-05-30" }));
    const may = await world.report("2026-05-31");
    expect(may).toMatchObject({ ledgerBalance: "896.50", tohyeeNotInBank: { total: "-172.50" }, statementBalance: "1057.00", explained: true });
    expect(may.tohyeeNotInBank.items.map((item) => item.amount)).toEqual(["-230.00", "57.50"]);
    const before = await world.report("2026-05-29");
    expect(before).toMatchObject({
      ledgerBalance: "1049.00",
      bankNotInTohyee: { total: "-12.00" },
      tohyeeNotInBank: { total: "-20.00" },
      statementBalance: "1057.00",
      expectedStatementBalance: "1057.00",
      explained: true,
    });
  });

  it("BK21: statement balance not known, from a bank feed balance, and a difference that isn't explained", async () => {
    const world = await setup();
    await world.importFile(CSV);
    const report = (asAt: string) => world.asUser(viewer, (tx) => bankReconciliationReport(tx, { accountId: world.bank.id, asAt }));
    expect(await report("2026-05-31")).toMatchObject({
      statementBalance: null,
      statementBalanceSource: null,
      ledgerBalance: "0.00",
      bankNotInTohyee: { total: "-431.00" },
      expectedStatementBalance: "-431.00",
      notExplained: null,
      explained: false,
    });
    // 10:00 on 21 May in New Zealand is 22:00 on 20 May UTC.
    await world.sql("update bank_account_settings set statement_balance = 69.00, statement_balance_at = '2026-05-20T22:00:00Z' where account_id = $1", [
      world.bank.id,
    ]);
    expect(await report("2026-05-31")).toMatchObject({
      statementBalance: "-431.00",
      statementBalanceSource: { kind: "feed_balance", date: "2026-05-21", balance: "69.00", linesAfter: 1, linesAfterTotal: "-500.00" },
      expectedStatementBalance: "-431.00",
      notExplained: "0.00",
      explained: true,
    });
    expect(await report("2026-05-20")).toMatchObject({ statementBalance: null, explained: false });

    const bk20 = await bk20World();
    const fee = await bk20.lineOn("-12.00");
    await bk20.asUser(bookkeeper, (tx) => setStatementLineExcluded(tx, fee.id, true));
    expect(await bk20.report("2026-05-31")).toMatchObject({
      statementBalance: "1057.00",
      expectedStatementBalance: "1069.00",
      notExplained: "-12.00",
      explained: false,
    });
  });

  const CASH_CSV = `Date,Amount,Payee,Particulars,Code,Reference
21/05/2026,-46.00,Z ENERGY,,,
24/05/2026,-11.50,Z ENERGY,,,
26/05/2026,-69.00,Z ENERGY,,,
28/05/2026,-12.00,MONTHLY FEE,,,
`;

  async function cashWorld() {
    const world = await setup();
    const anz = (await world.asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), name: "ANZ", isSupplier: true }))).contact;
    await world.importFile(CASH_CSV);
    const [fuel21, fuel24, fuel26, fee] = await Promise.all(["-46.00", "-11.50", "-69.00", "-12.00"].map((amount) => world.lineOn(amount)));
    const code = (input: Record<string, unknown>) => cashCodeStatementLines(world.run, world.bank.id, input);
    const bankTransactionFor = async (lineId: string) => {
      const line = (await world.lines()).find((entry) => entry.id === lineId)!;
      const journalId = line.reconciliation!.items[0].journalId;
      const row = (await world.sql("select id::text from bank_transactions where journal_id = $1", [journalId])).rows[0];
      return { journalId, bankTransaction: await world.asUser(viewer, (tx) => getBankTransaction(tx, row.id)) };
    };
    const gst = () => world.asUser(viewer, (tx) => calculateGstReturn(tx, { periodStart: "2026-05-01", periodEnd: "2026-05-31" }));
    return { ...world, anz, fuel21, fuel24, fuel26, fee, code, bankTransactionFor, gst };
  }

  it("BK22: cash coding four lines, one with its own account, GST, contact and description: four spend money, each reconciled", async () => {
    const world = await cashWorld();
    const before = await world.gst();
    const journals = await world.journalCount();
    const result = await world.code({
      idempotencyKey: key("cash"),
      accountCode: "6120",
      taxCode: "GST",
      description: "Fuel",
      lines: [
        { lineId: world.fuel21.id },
        { lineId: world.fuel24.id },
        { lineId: world.fuel26.id },
        { lineId: world.fee.id, accountCode: "6020", taxCode: null, contactId: world.anz.id, description: "Account fee" },
      ],
    });
    expect(result).toMatchObject({ succeeded: 4, failed: 0 });
    expect(result.results.map((entry) => [entry.lineId, entry.ok])).toEqual([
      [world.fuel21.id, true],
      [world.fuel24.id, true],
      [world.fuel26.id, true],
      [world.fee.id, true],
    ]);
    expect(await world.journalCount()).toBe(journals + 4);
    const expected: Array<[string, string, string, string, string[][]]> = [
      [world.fuel21.id, "2026-05-21", "Z Energy", "Fuel", [["6120", "40.00", "0.00"], ["2100", "6.00", "0.00"], ["1000", "0.00", "46.00"]]],
      [world.fuel24.id, "2026-05-24", "Z Energy", "Fuel", [["6120", "10.00", "0.00"], ["2100", "1.50", "0.00"], ["1000", "0.00", "11.50"]]],
      [world.fuel26.id, "2026-05-26", "Z Energy", "Fuel", [["6120", "60.00", "0.00"], ["2100", "9.00", "0.00"], ["1000", "0.00", "69.00"]]],
      [world.fee.id, "2026-05-28", "ANZ", "Account fee", [["6020", "12.00", "0.00"], ["1000", "0.00", "12.00"]]],
    ];
    for (const [lineId, date, contactName, description, posted] of expected) {
      const { journalId, bankTransaction } = await world.bankTransactionFor(lineId);
      expect(bankTransaction).toMatchObject({ kind: "spend", date, contactName, status: "posted" });
      expect(bankTransaction.lines.map((line) => line.description)).toEqual([description]);
      expect(await world.postedLines(journalId)).toEqual(posted);
    }
    expect(await world.lines("unreconciled")).toEqual([]);
    const after = await world.gst();
    expect(toFixedString(sub(dec(after.boxes.box11), dec(before.boxes.box11)), 2)).toBe("126.50");
    expect(toFixedString(sub(dec(after.gstOnTransactions.purchases), dec(before.gstOnTransactions.purchases)), 2)).toBe("16.50");
  });

  it("BK23: cash coding does each line on its own: a locked period and a missing contact fail, the rest post; retries post nothing", async () => {
    const world = await cashWorld();
    await world.lock("2026-05-21");
    const cashKey = key("cash");
    const all = [world.fuel21, world.fuel24, world.fuel26, world.fee].map((line) => ({ lineId: line.id }));
    const journals = await world.journalCount();
    const result = await world.code({ idempotencyKey: cashKey, accountCode: "6120", taxCode: "GST", lines: all });
    expect(result).toMatchObject({ succeeded: 2, failed: 2 });
    expect(result.results).toEqual([
      {
        lineId: world.fuel21.id,
        ok: false,
        error: "2026-05-21 is in a locked period (locked up to 2026-05-21). Use a later date, or ask an admin to open an unlock window.",
      },
      expect.objectContaining({ lineId: world.fuel24.id, ok: true, created: true }),
      expect.objectContaining({ lineId: world.fuel26.id, ok: true, created: true }),
      { lineId: world.fee.id, ok: false, error: "No contact was chosen, and there's no contact called “MONTHLY FEE”. Choose a contact for this line." },
    ]);
    expect(await world.journalCount()).toBe(journals + 2);
    const { journalId, bankTransaction } = await world.bankTransactionFor(world.fuel24.id);
    expect(bankTransaction.lines.map((line) => line.description)).toEqual([world.fuel24.description]);
    expect(await world.postedLines(journalId)).toEqual([
      ["6120", "10.00", "0.00"],
      ["2100", "1.50", "0.00"],
      ["1000", "0.00", "11.50"],
    ]);

    // Retrying the same request posts nothing more.
    const again = await world.code({ idempotencyKey: cashKey, accountCode: "6120", taxCode: "GST", lines: all });
    expect(again.results.map((entry) => [entry.lineId, entry.ok, entry.ok ? entry.created : null])).toEqual([
      [world.fuel21.id, false, null],
      [world.fuel24.id, true, false],
      [world.fuel26.id, true, false],
      [world.fee.id, false, null],
    ]);
    // The same key with different content is refused for the lines done.
    const changed = await world.code({ idempotencyKey: cashKey, accountCode: "6130", taxCode: "GST", lines: all });
    expect(changed.results.filter((entry) => entry.ok)).toEqual([]);
    expect(changed.results[1]).toMatchObject({ ok: false, error: expect.stringMatching(/idempotency key/i) });
    expect(await world.journalCount()).toBe(journals + 2);

    // Unlocked, the other two go through.
    await world.lock(null);
    const rest = await world.code({
      idempotencyKey: key("cash"),
      accountCode: "6120",
      taxCode: "GST",
      lines: [{ lineId: world.fuel21.id }, { lineId: world.fee.id, accountCode: "6020", taxCode: "", contactId: world.anz.id }],
    });
    expect(rest).toMatchObject({ succeeded: 2, failed: 0 });
    expect(await world.postedLines((await world.bankTransactionFor(world.fee.id)).journalId)).toEqual([
      ["6020", "12.00", "0.00"],
      ["1000", "0.00", "12.00"],
    ]);
    expect(await world.lines("unreconciled")).toEqual([]);

    // No account, a line already reconciled, and a line on another account.
    const savings = (await world.asUser(viewer, (tx) => listBankAccounts(tx))).find((account) => account.code === "1010")!;
    await world.importFile("Date,Amount,Payee\n29/05/2026,-5.00,Z ENERGY\n", savings.id);
    const other = (await world.lines("all", savings.id))[0];
    const refused = await world.code({
      idempotencyKey: key("cash"),
      taxCode: "GST",
      lines: [{ lineId: world.fuel21.id, accountCode: "6120" }, { lineId: other.id }, { lineId: world.fee.id, accountCode: "" }],
    });
    expect(refused.results).toEqual([
      { lineId: world.fuel21.id, ok: false, error: "This line is already reconciled." },
      { lineId: other.id, ok: false, error: "This line is on another account." },
      { lineId: world.fee.id, ok: false, error: "Choose an account for this line." },
    ]);

    // Over HTTP: viewers can't cash code; bookkeepers can.
    await world.importFile("Date,Amount,Payee\n29/05/2026,-23.00,Z ENERGY\n");
    const line = await world.lineOn("-23.00");
    const [bookkeeperCookie, viewerCookie] = await Promise.all([bookkeeper, viewer].map((user) => sessionCookieFor(user)));
    const post = (cookie: string) =>
      cashCodingRoute.POST(
        apiRequest(`/api/bank-accounts/${world.bank.id}/cash-coding`, {
          method: "POST",
          cookie,
          body: { organisationId: world.org, idempotencyKey: key("http"), accountCode: "6120", taxCode: "GST", lines: [{ lineId: line.id }] },
        }),
        params({ accountId: world.bank.id }),
      );
    expect((await post(viewerCookie)).status).toBe(403);
    const response = await post(bookkeeperCookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ succeeded: 1, failed: 0 });
  });

  async function adjustmentWorld(csv: string) {
    const world = await setup();
    await world.importFile(csv);
    const gst = () => world.asUser(viewer, (tx) => calculateGstReturn(tx, { periodStart: "2026-05-01", periodEnd: "2026-05-31" }));
    const items = async (lineId: string) => {
      const line = (await world.lines()).find((entry) => entry.id === lineId)!;
      return line.reconciliation!.items.map((item) => ({ origin: item.origin, journalId: item.journalId }));
    };
    return { ...world, gst, items };
  }
  const FEE = { accountCode: "6020", description: "Merchant fee" };

  it("BK24: paying INV-0001 115.00 from a 113.50 line with a 1.50 bank fee adjustment; 0.50 over to 4100 with GST; a bill; matching", async () => {
    const world = await adjustmentWorld("Date,Amount,Payee\n20/05/2026,113.50,KOBE LTD\n21/05/2026,-231.50,KAURI SUPPLIES\n");
    const before = await world.gst();
    const short = await world.lineOn("113.50");
    const journals = await world.journalCount();
    const { line } = await world.reconcile(short.id, {
      kind: "payments",
      allocations: [{ invoiceId: world.i1.id, amount: "115.00" }],
      adjustment: FEE,
    });
    expect(line.status).toBe("reconciled");
    expect(await world.journalCount()).toBe(journals + 2);
    const [payment, fee] = await world.items(short.id);
    expect([payment.origin, fee.origin]).toEqual(["customer_payment", "bank_transaction"]);
    expect(await world.postedLines(payment.journalId)).toEqual([
      ["1000", "115.00", "0.00"],
      ["1100", "0.00", "115.00"],
    ]);
    expect(await world.postedLines(fee.journalId)).toEqual([
      ["6020", "1.50", "0.00"],
      ["1000", "0.00", "1.50"],
    ]);
    const feeRow = (await world.sql("select id::text from bank_transactions where journal_id = $1", [fee.journalId])).rows[0];
    expect(await world.asUser(viewer, (tx) => getBankTransaction(tx, feeRow.id))).toMatchObject({
      kind: "spend",
      date: "2026-05-20",
      contactName: "Kobe Ltd",
      lines: [expect.objectContaining({ description: "Merchant fee", accountCode: "6020", taxCode: null })],
    });
    expect(await world.asUser(viewer, (tx) => getInvoice(tx, world.i1.id))).toMatchObject({ paidStatus: "paid", amountDue: "0.00" });
    const after = await world.gst();
    expect(after.boxes.box11).toBe(before.boxes.box11);
    expect(after.lines.filter((entry) => entry.documentType === "bank_transaction")).toEqual([
      expect.objectContaining({ amount: "1.50", gst: "0.00", boxes: [], category: "out_of_scope" }),
    ]);

    // A bill: -231.50 pays B1 230.00 and 1.50 goes to bank fees.
    const bill = await world.lineOn("-231.50");
    await world.reconcile(bill.id, { kind: "payments", allocations: [{ billId: world.b1.id, amount: "230.00" }], adjustment: { accountCode: "6020" } });
    const [billPayment, billFee] = await world.items(bill.id);
    expect(await world.postedLines(billPayment.journalId)).toEqual([
      ["2000", "230.00", "0.00"],
      ["1000", "0.00", "230.00"],
    ]);
    expect(await world.postedLines(billFee.journalId)).toEqual([
      ["6020", "1.50", "0.00"],
      ["1000", "0.00", "1.50"],
    ]);
    const billFeeRow = (await world.sql("select id::text from bank_transactions where journal_id = $1", [billFee.journalId])).rows[0];
    expect(await world.asUser(viewer, (tx) => getBankTransaction(tx, billFeeRow.id))).toMatchObject({
      kind: "spend",
      contactName: "Kauri Supplies",
      lines: [expect.objectContaining({ description: "Adjustment" })],
    });
    expect(await world.asUser(viewer, (tx) => getBill(tx, world.b1.id))).toMatchObject({ paidStatus: "paid", amountDue: "0.00" });

    // 0.50 over, kept as other revenue with GST.
    const over = await adjustmentWorld("Date,Amount,Payee\n20/05/2026,115.50,KOBE LTD\n");
    const overBefore = await over.gst();
    const extra = await over.lineOn("115.50");
    await over.reconcile(extra.id, {
      kind: "payments",
      allocations: [{ invoiceId: over.i1.id, amount: "115.00" }],
      adjustment: { accountCode: "4100", taxCode: "GST" },
    });
    const [overPayment, overAdjustment] = await over.items(extra.id);
    expect(await over.postedLines(overAdjustment.journalId)).toEqual([
      ["4100", "0.00", "0.43"],
      ["2100", "0.00", "0.07"],
      ["1000", "0.50", "0.00"],
    ]);
    expect(
      (await over.sql("select overpayment_amount::text from customer_payments where journal_id = $1", [overPayment.journalId])).rows[0]
        .overpayment_amount,
    ).toBe("0.00");
    const overAfter = await over.gst();
    expect(toFixedString(sub(dec(overAfter.boxes.box5), dec(overBefore.boxes.box5)), 2)).toBe("0.50");

    // Matching a payment already recorded, with a contact chosen for the adjustment.
    const matched = await adjustmentWorld("Date,Amount,Payee\n20/05/2026,113.50,KOBE LTD\n");
    const { payment: recorded } = await matched.asUser(bookkeeper, (tx) =>
      recordPayment(tx, matched.i1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-19", amount: "115.00", bankAccountCode: "1000" }),
    );
    const recordedLine = (await matched.sql("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [recorded.journalId, matched.bank.id]))
      .rows[0].id as string;
    const matchedLine = await matched.lineOn("113.50");
    const beforeMatch = await matched.journalCount();
    await matched.reconcile(matchedLine.id, { kind: "match", journalLineIds: [recordedLine], adjustment: { ...FEE, contactId: matched.kobe.id } });
    expect(await matched.journalCount()).toBe(beforeMatch + 1);
    const [matchedPayment, matchedFee] = await matched.items(matchedLine.id);
    expect(matchedPayment.journalId).toBe(recorded.journalId);
    expect(await matched.postedLines(matchedFee.journalId)).toEqual([
      ["6020", "1.50", "0.00"],
      ["1000", "0.00", "1.50"],
    ]);
  });

  it("BK25: adjustments are refused without an account, a contact when matching, or a difference; nothing is posted; retries", async () => {
    const world = await adjustmentWorld("Date,Amount,Payee\n20/05/2026,113.50,KOBE LTD\n21/05/2026,-46.00,Z ENERGY\n");
    const short = await world.lineOn("113.50");
    const fuel = await world.lineOn("-46.00");
    const pay = (adjustment: Record<string, unknown>, amount = "115.00", idempotencyKey = key("reconcile")) =>
      world.asUser(bookkeeper, (tx) =>
        reconcileStatementLine(tx, short.id, { idempotencyKey, kind: "payments", allocations: [{ invoiceId: world.i1.id, amount }], adjustment }),
      );
    const journals = await world.journalCount();
    await expect(pay({ description: "Fee" })).rejects.toThrow("Choose the account for the 1.50 difference.");
    await expect(pay(FEE, "113.50")).rejects.toThrow("The payments already add up to the line, so there's no difference for an adjustment.");
    await expect(pay({ accountCode: "1100" })).rejects.toThrow(/accounts receivable/);
    const { payment } = await world.asUser(bookkeeper, (tx) =>
      recordPayment(tx, world.i1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-19", amount: "10.00", bankAccountCode: "1000" }),
    );
    const paymentLine = (await world.sql("select id::text from ledger_journal_lines where journal_id = $1 and account_id = $2", [payment.journalId, world.bank.id]))
      .rows[0].id as string;
    const withPayment = await world.journalCount();
    await expect(world.reconcile(short.id, { kind: "match", journalLineIds: [paymentLine], adjustment: FEE })).rejects.toThrow(
      "Choose a contact for the 103.50 adjustment.",
    );
    await expect(
      world.reconcile(fuel.id, {
        kind: "bank_transaction",
        contactId: world.zEnergy.id,
        amountsMode: "inclusive",
        lines: [{ description: "Petrol", accountCode: "6120", taxCode: "GST", amount: "46.00" }],
        adjustment: FEE,
      }),
    ).rejects.toThrow("An adjustment is only for a difference when matching, or paying invoices or bills.");
    await expect(world.reconcile(fuel.id, { kind: "transfer", otherAccountCode: "1010", adjustment: FEE })).rejects.toThrow(/only for a difference/);
    expect(await world.journalCount()).toBe(withPayment);
    expect(withPayment).toBe(journals + 1);
    await world.asUser(bookkeeper, (tx) => voidPayment(tx, world.i1.id, payment.id, { idempotencyKey: key("void"), voidDate: "2026-05-19" }));

    // A locked period refuses the whole thing: no payment, no adjustment.
    await world.lock("2026-05-20");
    const locked = await world.journalCount();
    await expect(pay(FEE)).rejects.toThrow(/locked period/);
    expect(await world.journalCount()).toBe(locked);
    expect(await world.asUser(viewer, (tx) => getInvoice(tx, world.i1.id))).toMatchObject({ amountDue: "115.00" });
    await world.lock(null);

    // Retries return the line and post nothing more; another account with the same key is refused.
    const retryKey = key("reconcile");
    const first = await pay(FEE, "115.00", retryKey);
    const posted = await world.journalCount();
    expect(await pay(FEE, "115.00", retryKey)).toEqual({ ...first, created: false });
    await expect(pay({ ...FEE, accountCode: "6070" }, "115.00", retryKey)).rejects.toThrow(/idempotency key/i);
    expect(await world.journalCount()).toBe(posted);

    // Unreconciling leaves the payment and the adjustment; the adjustment can then be voided on its own.
    const [, fee] = await world.items(short.id);
    await world.asUser(bookkeeper, (tx) => unreconcileStatementLine(tx, short.id, { idempotencyKey: key("unreconcile") }));
    expect(await world.asUser(viewer, (tx) => getInvoice(tx, world.i1.id))).toMatchObject({ paidStatus: "paid" });
    const feeRow = (await world.sql("select id::text from bank_transactions where journal_id = $1", [fee.journalId])).rows[0];
    const voided = await world.asUser(bookkeeper, (tx) => voidBankTransaction(tx, feeRow.id, { idempotencyKey: key("void"), voidDate: "2026-05-20" }));
    expect(voided.bankTransaction.status).toBe("voided");
  });
});

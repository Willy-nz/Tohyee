import pg from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as reconcileRoute from "@/app/api/statement-lines/[lineId]/reconcile/route";
import * as linesRoute from "@/app/api/bank-accounts/[accountId]/statement-lines/route";
import * as importsRoute from "@/app/api/bank-accounts/[accountId]/imports/route";
import * as akahuSettingsRoute from "@/app/api/bank-feeds/akahu/settings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import {
  createBankAccount,
  getBankAccount,
  getStatementLine,
  listBankAccounts,
  listStatementLines,
  setStatementLineExcluded,
  type StatementLine,
} from "@/lib/bank/accounts";
import { setAkahuFetchForTests } from "@/lib/bank/akahu/client";
import { linkBankFeed } from "@/lib/bank/akahu/settings";
import { syncBankFeedAccount } from "@/lib/bank/akahu/sync";
import { deleteImport, importStatementFile, previewImport } from "@/lib/bank/imports";
import { reconcileStatementLine, suggestionsForLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import { createBankRule } from "@/lib/bank/rules";
import { createBankTransaction, voidBankTransaction, voidTransfer } from "@/lib/bank/transactions";
import { approveBill, createBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { correctJournal, getJournal, listJournals } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { getOrganisation } from "@/lib/organisations/registry";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
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

const CSV = `Date,Amount,Payee,Particulars,Code,Reference
20/05/2026,115.00,KOBE LTD,INV-0001,,
21/05/2026,-46.00,Z ENERGY,,,
22/05/2026,-500.00,TRANSFER,SAVINGS,,
`;
const b64 = (text: string) => Buffer.from(text).toString("base64");
const APR_MAY = { periodStart: "2026-04-01", periodEnd: "2026-05-31" };

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Examples BK1-BK16 and BK29 in docs/ACCOUNTING-EXAMPLES.md ("Bank accounts,
 * statements and reconciliation"). Each example gets its own organisation:
 * 1000 Business bank account, 1010 Savings account, 2400 Credit card, GST at
 * 15%, Kobe Ltd with INV-0001 (I1, 115.00) and Kauri Supplies with B1
 * (230.00), both dated 10 May 2026, and the contact Z Energy.
 */
describeWithDatabase("bank accounts, statements and reconciliation", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    setAkahuFetchForTests(null);
    await server?.teardown();
  });

  afterEach(() => setAkahuFetchForTests(null));

  async function setup() {
    organisations += 1;
    const org = `bank-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
      inOrganisation(org, { userId: user.id, email: user.email }, work);
    const contact = async (name: string, flags: { isCustomer?: boolean; isSupplier?: boolean }): Promise<Contact> =>
      (await asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...flags }))).contact;
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const kauri = await contact("Kauri Supplies", { isSupplier: true });
    const zEnergy = await contact("Z Energy", { isSupplier: true });
    const savings = await asUser(owner, (tx) => createBankAccount(tx, { code: "1010", name: "Savings account", accountType: "bank" }));
    const accounts = await asUser(viewer, (tx) => listBankAccounts(tx));
    const bank = accounts.find((account) => account.code === "1000")!;
    const card = accounts.find((account) => account.code === "2400")!;
    const i1 = await asUser(bookkeeper, async (tx) => {
      const drafted = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: kobe.id,
        invoiceDate: "2026-05-10",
        dueDate: "2026-06-20",
        amountsMode: "exclusive",
        lines: [{ description: "Consulting", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
      });
      return (await approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("approve") })).invoice;
    });
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
    const importFile = (accountId: string, text: string, fileName = "statement.csv", fields: Record<string, unknown> = {}) =>
      asUser(bookkeeper, (tx) => importStatementFile(tx, accountId, { idempotencyKey: key("import"), fileName, fileBase64: b64(text), ...fields }));
    const lines = async (accountId: string, status = "all") =>
      (await asUser(viewer, (tx) => listStatementLines(tx, accountId, { status }))).lines;
    const lineOn = async (accountId: string, amount: string) => (await lines(accountId, "all")).find((line) => line.amount === amount)!;
    const reconcile = (lineId: string, command: Record<string, unknown>) =>
      asUser(bookkeeper, (tx) => reconcileStatementLine(tx, lineId, { idempotencyKey: key("reconcile"), ...command }));
    const unreconcile = (lineId: string, idempotencyKey = key("unreconcile")) =>
      asUser(bookkeeper, (tx) => unreconcileStatementLine(tx, lineId, { idempotencyKey }));
    const journal = (journalId: string) => asUser(owner, (tx) => getJournal(tx, journalId));
    const postedLines = async (journalId: string) =>
      (await journal(journalId)).lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount]);
    const journalCount = async () =>
      Number((await asUser(owner, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count);
    const gst = () => asUser(viewer, (tx) => calculateGstReturn(tx, APR_MAY));
    const spendLine = { description: "Petrol", accountCode: "6120", taxCode: "GST", amount: "46.00" };
    const lock = (lockDate: string | null) => asUser(owner, (tx) => updatePeriodControls(tx, { lockDate, reason: "Test set-up" }));
    const sql = (text: string, values: unknown[] = []) => asUser(owner, (tx) => tx.query(text, values));
    return {
      org, asUser, kobe, kauri, zEnergy, bank, savings, card, i1, b1, importFile, lines, lineOn, reconcile, unreconcile,
      journal, postedLines, journalCount, gst, spendLine, lock, sql,
    };
  }

  async function afterBk1() {
    const world = await setup();
    const imported = await world.importFile(world.bank.id, CSV);
    return { ...world, bk1: imported.import };
  }

  it("setup: 2400 Credit card is a credit card account, and bank and card accounts are listed with balances", async () => {
    const world = await setup();
    expect(world.card).toMatchObject({ code: "2400", accountType: "credit_card", ledgerBalance: "0.00", unreconciledCount: 0 });
    expect(world.bank).toMatchObject({ code: "1000", accountType: "bank" });
    expect(world.savings).toMatchObject({ code: "1010", accountType: "bank", feed: { lastSyncStatus: "never", active: false } });
  });

  it("BK1: importing the CSV into 1000 adds three unreconciled lines and posts nothing; the reconcile count is 3", async () => {
    const world = await setup();
    const before = await world.journalCount();
    const preview = await world.asUser(bookkeeper, (tx) =>
      previewImport(tx, world.bank.id, { fileName: "statement.csv", fileBase64: b64(CSV) }),
    );
    expect(preview).toMatchObject({
      format: "csv", lineCount: 3, newCount: 3, duplicateCount: 0, firstDate: "2026-05-20", lastDate: "2026-05-22",
      moneyIn: "115.00", moneyOut: "546.00", errors: [],
    });
    const { created, import: imported } = await world.importFile(world.bank.id, CSV);
    expect(created).toBe(true);
    expect(imported).toMatchObject({ source: "file", fileFormat: "csv", lineCount: 3, duplicateCount: 0, status: "active" });
    expect(await world.journalCount()).toBe(before);
    const lines = await world.lines(world.bank.id, "unreconciled");
    expect(lines.map((line) => [line.date, line.amount, line.description, line.status])).toEqual([
      ["2026-05-20", "115.00", "KOBE LTD INV-0001", "unreconciled"],
      ["2026-05-21", "-46.00", "Z ENERGY", "unreconciled"],
      ["2026-05-22", "-500.00", "TRANSFER SAVINGS", "unreconciled"],
    ]);
    expect(await world.asUser(viewer, (tx) => getBankAccount(tx, world.bank.id))).toMatchObject({
      unreconciledCount: 3,
      lastLineDate: "2026-05-22",
      importLayout: expect.objectContaining({ headerRow: 0, dateOrder: "dmy" }),
    });
  });

  it("BK1: a layout chosen by hand is saved and reused for files with the same columns", async () => {
    const world = await setup();
    const layout = { headerRow: 0, columns: { date: "Date", amount: "Amount", description: "Details" }, dateOrder: "dmy", invertAmounts: true };
    await world.importFile(world.card.id, "Date,Amount,Details\n05/05/2026,20.00,CAFE\n", "card.csv", { layout });
    expect((await world.lines(world.card.id))[0]).toMatchObject({ amount: "-20.00" });
    const next = await world.asUser(bookkeeper, (tx) =>
      previewImport(tx, world.card.id, { fileName: "card.csv", fileBase64: b64("Date,Amount,Details\n06/05/2026,15.00,BAKERY\n") }),
    );
    expect(next).toMatchObject({ errors: [], sample: [expect.objectContaining({ amount: "-15.00", description: "BAKERY" })] });
    const different = await world.asUser(bookkeeper, (tx) =>
      previewImport(tx, world.card.id, { fileName: "other.csv", fileBase64: b64("Date,Amount,Description\n06/05/2026,15.00,BAKERY\n") }),
    );
    expect(different).toMatchObject({ errors: [], sample: [expect.objectContaining({ amount: "15.00" })] });
  });

  it("BK2: the same file adds nothing, one more row adds one, and genuine identical rows are kept", async () => {
    const world = await afterBk1();
    expect((await world.importFile(world.bank.id, CSV)).import).toMatchObject({ lineCount: 0, duplicateCount: 3 });
    const more = `${CSV}23/05/2026,-12.00,CAFE,,,\n`;
    expect((await world.importFile(world.bank.id, more)).import).toMatchObject({ lineCount: 1, duplicateCount: 3 });
    const coffees = "Date,Amount,Payee\n21/05/2026,-4.50,CAFE\n21/05/2026,-4.50,CAFE\n";
    expect((await world.importFile(world.bank.id, coffees)).import).toMatchObject({ lineCount: 2, duplicateCount: 0 });
    expect((await world.importFile(world.bank.id, coffees)).import).toMatchObject({ lineCount: 0, duplicateCount: 2 });
    expect((await world.lines(world.bank.id, "unreconciled")).length).toBe(6);
    // A file with a line that can't be read is refused as a whole.
    await expect(world.importFile(world.bank.id, "Date,Amount\n24/05/2026,1.00\n32/05/2026,2.00\n")).rejects.toThrow(
      /1 problem, so nothing was imported: Row 3: "32\/05\/2026" isn't a date\./,
    );
    expect((await world.lines(world.bank.id, "unreconciled")).length).toBe(6);
  });

  it("BK3: OFX lines keep the bank's ids; the CSV afterwards is flagged as possible duplicates, not skipped", async () => {
    const world = await setup();
    const ofx = `OFXHEADER:100\n<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>20260520<TRNAMT>115.00<FITID>A1<NAME>KOBE LTD<MEMO>INV-0001
<STMTTRN><DTPOSTED>20260521<TRNAMT>-46.00<FITID>A2<NAME>Z ENERGY
<STMTTRN><DTPOSTED>20260522<TRNAMT>-500.00<FITID>A3<NAME>TRANSFER<MEMO>SAVINGS
</BANKTRANLIST></OFX>`;
    expect((await world.importFile(world.bank.id, ofx, "statement.ofx")).import).toMatchObject({ fileFormat: "ofx", lineCount: 3 });
    expect((await world.importFile(world.bank.id, ofx, "statement.ofx")).import).toMatchObject({ lineCount: 0, duplicateCount: 3 });
    const csv = (await world.importFile(world.bank.id, CSV)).import;
    expect(csv).toMatchObject({ lineCount: 3, duplicateCount: 0, possibleDuplicateCount: 3 });
    const all = await world.lines(world.bank.id, "unreconciled");
    const ofxLines = all.filter((line) => line.externalId?.startsWith("ofx:"));
    const csvLines = all.filter((line) => !line.externalId);
    expect(ofxLines.map((line) => line.externalId)).toEqual(["ofx:A1", "ofx:A2", "ofx:A3"]);
    expect(csvLines.map((line) => line.possibleDuplicateOf)).toEqual(ofxLines.map((line) => line.id));
  });

  it("BK4: matching the +115.00 line to the customer payment posts nothing; bad matches are refused", async () => {
    const world = await afterBk1();
    const { payment } = await world.asUser(bookkeeper, (tx) =>
      recordPayment(tx, world.i1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-20", amount: "115.00", bankAccountCode: "1000" }),
    );
    const line = await world.lineOn(world.bank.id, "115.00");
    const suggestions = await world.asUser(viewer, (tx) => suggestionsForLine(tx, line.id));
    const paymentLine = suggestions.matches.find((match) => match.journalId === payment.journalId)!;
    expect(paymentLine).toMatchObject({ amount: "115.00", exact: true, origin: "customer_payment", postingDate: "2026-05-20" });
    const before = await world.journalCount();
    // Refused: the wrong total, a line on another account, or already reconciled.
    const other = await world.lineOn(world.bank.id, "-46.00");
    await expect(world.reconcile(other.id, { kind: "match", journalLineIds: [paymentLine.journalLineId] })).rejects.toThrow(
      "The chosen transactions add up to 115.00, but the line is -46.00.",
    );
    const incomeLine = (
      await world.sql(
        "select l.id from ledger_journal_lines l join accounts a on a.id = l.account_id where l.journal_id = $1 and a.code = '4000'",
        [world.i1.approvalJournalId],
      )
    ).rows[0].id as string;
    await expect(world.reconcile(line.id, { kind: "match", journalLineIds: [incomeLine] })).rejects.toThrow(/isn't on this account/);
    // More than 60 days away is refused.
    const late = (await world.importFile(world.bank.id, "Date,Amount,Payee\n25/07/2026,115.00,LATE\n")).import;
    expect(late.lineCount).toBe(1);
    const lateLine = (await world.lines(world.bank.id, "unreconciled")).find((entry) => entry.description === "LATE")!;
    await expect(world.reconcile(lateLine.id, { kind: "match", journalLineIds: [paymentLine.journalLineId] })).rejects.toThrow(/more than 60 days/);
    const { line: reconciled } = await world.reconcile(line.id, { kind: "match", journalLineIds: [paymentLine.journalLineId] });
    expect(reconciled).toMatchObject({ status: "reconciled", reconciliation: { kind: "match", items: [expect.objectContaining({ journalId: payment.journalId, amount: "115.00" })] } });
    expect(await world.journalCount()).toBe(before);
    // Three BK1 lines and the late line; the +115.00 line is done.
    expect((await world.asUser(viewer, (tx) => getBankAccount(tx, world.bank.id))).unreconciledCount).toBe(3);
    // The payment's journal line can't be used twice.
    const second = (await world.importFile(world.bank.id, "Date,Amount,Payee\n20/05/2026,115.00,KOBE AGAIN\n")).import;
    expect(second.lineCount).toBe(1);
    const twin = (await world.lines(world.bank.id, "unreconciled")).find((entry) => entry.description === "KOBE AGAIN")!;
    await expect(world.reconcile(twin.id, { kind: "match", journalLineIds: [paymentLine.journalLineId] })).rejects.toThrow(
      /already reconciled with another statement line/,
    );
  });

  it("BK4: a voided payment and its reversal can still be matched, but are flagged and listed after live transactions", async () => {
    const world = await afterBk1();
    const { payment: voidedPayment } = await world.asUser(bookkeeper, (tx) =>
      recordPayment(tx, world.i1.id, { idempotencyKey: key("pay-1"), paymentDate: "2026-05-20", amount: "115.00", bankAccountCode: "1000" }),
    );
    const paymentId = (await world.sql("select id from customer_payments where journal_id = $1", [voidedPayment.journalId])).rows[0].id as string;
    const { payment: voidJournal } = await world.asUser(bookkeeper, (tx) =>
      voidPayment(tx, world.i1.id, paymentId, { idempotencyKey: key("void-pay"), voidDate: "2026-05-20" }),
    );
    const { payment: live } = await world.asUser(bookkeeper, (tx) =>
      recordPayment(tx, world.i1.id, { idempotencyKey: key("pay-2"), paymentDate: "2026-05-20", amount: "115.00", bankAccountCode: "1000" }),
    );
    const moneyIn = await world.lineOn(world.bank.id, "115.00");
    const { matches } = await world.asUser(viewer, (tx) => suggestionsForLine(tx, moneyIn.id));
    expect(matches.map((match) => [match.journalId, match.exact, match.voided])).toEqual([
      [live.journalId, true, false],
      [voidedPayment.journalId, true, true],
    ]);
    // The reversal (money out of 1000) is listed for money-out lines, flagged too.
    const moneyOut = await world.lineOn(world.bank.id, "-46.00");
    const reversal = (await world.asUser(viewer, (tx) => suggestionsForLine(tx, moneyOut.id))).matches.find(
      (match) => match.journalId === voidJournal.voidJournalId,
    );
    expect(reversal).toMatchObject({ amount: "-115.00", voided: true });
  });

  it("BK5: paying INV-0001 and B1 from lines records the payments dated the line date and reconciles", async () => {
    const world = await afterBk1();
    const line = await world.lineOn(world.bank.id, "115.00");
    await expect(world.reconcile(line.id, { kind: "payments", allocations: [{ invoiceId: world.i1.id, amount: "100.00" }] })).rejects.toThrow(
      "The payments add up to 100.00, but the line is 115.00.",
    );
    const { line: done } = await world.reconcile(line.id, { kind: "payments", allocations: [{ invoiceId: world.i1.id, amount: "115.00" }] });
    expect(done.status).toBe("reconciled");
    const journalId = done.reconciliation!.items[0].journalId;
    expect(await world.journal(journalId)).toMatchObject({ origin: "customer_payment", postingDate: "2026-05-20" });
    expect(await world.postedLines(journalId)).toEqual([
      ["1000", "115.00", "0.00"],
      ["1100", "0.00", "115.00"],
    ]);
    expect(await world.asUser(viewer, (tx) => getInvoice(tx, world.i1.id))).toMatchObject({ paidStatus: "paid" });
    await world.importFile(world.bank.id, "Date,Amount,Payee\n24/05/2026,-230.00,KAURI SUPPLIES\n");
    const billLine = await world.lineOn(world.bank.id, "-230.00");
    const suggestions = await world.asUser(viewer, (tx) => suggestionsForLine(tx, billLine.id));
    expect(suggestions.documents).toEqual([expect.objectContaining({ kind: "bill", id: world.b1.id, amountDue: "230.00" })]);
    const { line: paid } = await world.reconcile(billLine.id, { kind: "payments", allocations: [{ billId: world.b1.id, amount: "230.00" }] });
    expect(await world.postedLines(paid.reconciliation!.items[0].journalId)).toEqual([
      ["2000", "230.00", "0.00"],
      ["1000", "0.00", "230.00"],
    ]);
  });

  it("BK6: spend money from the -46.00 line: GST 6.00, net 40.00; Dr 6120 / Dr 2100 / Cr 1000; adds 46.00 to Box 11", async () => {
    const world = await afterBk1();
    const before = await world.gst();
    const line = await world.lineOn(world.bank.id, "-46.00");
    await expect(
      world.reconcile(line.id, { kind: "bank_transaction", contactId: world.zEnergy.id, amountsMode: "inclusive", lines: [{ ...world.spendLine, amount: "45.00" }] }),
    ).rejects.toThrow("The bank transaction comes to 45.00, but the statement line is 46.00.");
    const { line: done } = await world.reconcile(line.id, {
      kind: "bank_transaction",
      contactId: world.zEnergy.id,
      amountsMode: "inclusive",
      lines: [world.spendLine],
    });
    const journalId = done.reconciliation!.items[0].journalId;
    expect(await world.journal(journalId)).toMatchObject({ origin: "bank_transaction", postingDate: "2026-05-21" });
    expect(await world.postedLines(journalId)).toEqual([
      ["6120", "40.00", "0.00"],
      ["2100", "6.00", "0.00"],
      ["1000", "0.00", "46.00"],
    ]);
    const after = await world.gst();
    expect(Number(after.boxes.box11) - Number(before.boxes.box11)).toBeCloseTo(46, 6);
    expect(Number(after.gstOnTransactions.purchases) - Number(before.gstOnTransactions.purchases)).toBeCloseTo(6, 6);
    expect(after.lines.filter((entry) => entry.documentType === "bank_transaction")).toEqual([
      expect.objectContaining({ side: "purchases", eventType: "bank_transaction_posted", amount: "46.00", gst: "6.00", boxes: ["11"], contactName: "Z Energy" }),
    ]);
    // Bank and control accounts can't take bank transaction lines.
    await world.importFile(world.bank.id, "Date,Amount,Payee\n24/05/2026,-10.00,X\n");
    const x = await world.lineOn(world.bank.id, "-10.00");
    for (const [code, message] of [
      ["1010", /is a bank or credit card account \(use a transfer instead\)/],
      ["1100", /accounts receivable account/],
      ["2100", /the GST account/],
    ] as const) {
      await expect(
        world.reconcile(x.id, { kind: "bank_transaction", contactId: world.zEnergy.id, amountsMode: "no_tax", lines: [{ description: "x", accountCode: code, amount: "10.00" }] }),
      ).rejects.toThrow(message);
    }
  });

  it("BK7: receive money with GST adds 57.50 to Box 5; interest with no tax is in no box", async () => {
    const world = await setup();
    await world.importFile(world.bank.id, "Date,Amount,Payee\n23/05/2026,57.50,CASH SALE\n31/05/2026,2.30,INTEREST\n");
    const before = await world.gst();
    const sale = await world.lineOn(world.bank.id, "57.50");
    const { line: saleDone } = await world.reconcile(sale.id, {
      kind: "bank_transaction",
      contactId: world.kobe.id,
      amountsMode: "inclusive",
      lines: [{ description: "Cash sale", accountCode: "4000", taxCode: "GST", amount: "57.50" }],
    });
    expect(await world.postedLines(saleDone.reconciliation!.items[0].journalId)).toEqual([
      ["4000", "0.00", "50.00"],
      ["2100", "0.00", "7.50"],
      ["1000", "57.50", "0.00"],
    ]);
    const interest = await world.lineOn(world.bank.id, "2.30");
    const { line: interestDone } = await world.reconcile(interest.id, {
      kind: "bank_transaction",
      contactId: world.kobe.id,
      amountsMode: "no_tax",
      lines: [{ description: "Interest", accountCode: "4200", amount: "2.30" }],
    });
    expect(await world.postedLines(interestDone.reconciliation!.items[0].journalId)).toEqual([
      ["4200", "0.00", "2.30"],
      ["1000", "2.30", "0.00"],
    ]);
    const after = await world.gst();
    expect(Number(after.boxes.box5) - Number(before.boxes.box5)).toBeCloseTo(57.5, 6);
    expect(after.lines.filter((entry) => entry.documentType === "bank_transaction").map((entry) => [entry.side, entry.amount, entry.boxes])).toEqual([
      ["sales", "57.50", ["5"]],
      ["sales", "2.30", []],
    ]);
  });

  it("BK8: a transfer to 1010 from the -500.00 line; 1010's +500.00 line matches the transfer", async () => {
    const world = await afterBk1();
    const line = await world.lineOn(world.bank.id, "-500.00");
    const { line: done } = await world.reconcile(line.id, { kind: "transfer", otherAccountCode: "1010" });
    const journalId = done.reconciliation!.items[0].journalId;
    expect(await world.journal(journalId)).toMatchObject({ origin: "bank_transfer", postingDate: "2026-05-22" });
    expect(await world.postedLines(journalId)).toEqual([
      ["1010", "500.00", "0.00"],
      ["1000", "0.00", "500.00"],
    ]);
    await world.importFile(world.savings.id, "Date,Amount,Payee\n22/05/2026,500.00,FROM CHEQUE\n");
    const savingsLine = await world.lineOn(world.savings.id, "500.00");
    const suggestion = (await world.asUser(viewer, (tx) => suggestionsForLine(tx, savingsLine.id))).matches[0];
    expect(suggestion).toMatchObject({ journalId, amount: "500.00", exact: true });
    const { line: matched } = await world.reconcile(savingsLine.id, { kind: "match", journalLineIds: [suggestion.journalLineId] });
    expect(matched.status).toBe("reconciled");
    // Neither side's journal can be reversed now.
    const transferId = (await world.sql("select id from bank_transfers where journal_id = $1", [journalId])).rows[0].id as string;
    await expect(world.asUser(bookkeeper, (tx) => voidTransfer(tx, transferId, { idempotencyKey: key("void"), voidDate: "2026-05-25" }))).rejects.toThrow(
      "This transfer is reconciled with a bank statement line. Unreconcile it first.",
    );
  });

  it("BK9: credit card spend money, paying the card by transfer, and a supplier payment from the card", async () => {
    const world = await setup();
    await world.importFile(world.card.id, "Date,Amount,Description\n21/05/2026,-86.25,OFFICEMAX\n28/05/2026,86.25,PAYMENT THANK YOU\n");
    const purchase = await world.lineOn(world.card.id, "-86.25");
    const { line: bought } = await world.reconcile(purchase.id, {
      kind: "bank_transaction",
      contactId: world.kauri.id,
      amountsMode: "inclusive",
      lines: [{ description: "Stationery", accountCode: "6130", taxCode: "GST", amount: "86.25" }],
    });
    expect(await world.postedLines(bought.reconciliation!.items[0].journalId)).toEqual([
      ["6130", "75.00", "0.00"],
      ["2100", "11.25", "0.00"],
      ["2400", "0.00", "86.25"],
    ]);
    await world.importFile(world.bank.id, "Date,Amount,Payee\n28/05/2026,-86.25,CARD PAYMENT\n");
    const payCard = await world.lineOn(world.bank.id, "-86.25");
    const { line: paid } = await world.reconcile(payCard.id, { kind: "transfer", otherAccountCode: "2400" });
    const transferJournal = paid.reconciliation!.items[0].journalId;
    expect(await world.postedLines(transferJournal)).toEqual([
      ["2400", "86.25", "0.00"],
      ["1000", "0.00", "86.25"],
    ]);
    const cardPayment = await world.lineOn(world.card.id, "86.25");
    const match = (await world.asUser(viewer, (tx) => suggestionsForLine(tx, cardPayment.id))).matches.find((entry) => entry.journalId === transferJournal)!;
    await world.reconcile(cardPayment.id, { kind: "match", journalLineIds: [match.journalLineId] });
    expect(await world.asUser(viewer, (tx) => getBankAccount(tx, world.card.id))).toMatchObject({ ledgerBalance: "0.00", unreconciledCount: 0 });
    // A supplier payment can come from the credit card.
    await world.importFile(world.card.id, "Date,Amount,Description\n29/05/2026,-230.00,KAURI\n");
    const billLine = await world.lineOn(world.card.id, "-230.00");
    const { line: billPaid } = await world.reconcile(billLine.id, { kind: "payments", allocations: [{ billId: world.b1.id, amount: "230.00" }] });
    expect(await world.postedLines(billPaid.reconciliation!.items[0].journalId)).toEqual([
      ["2000", "230.00", "0.00"],
      ["2400", "0.00", "230.00"],
    ]);
  });

  it("BK10: a bank rule suggests the spend money and posts nothing until confirmed", async () => {
    const world = await afterBk1();
    await world.asUser(bookkeeper, (tx) =>
      createBankRule(tx, {
        name: "Fuel",
        matchText: "z energy",
        direction: "out",
        contactId: world.zEnergy.id,
        targetAccountCode: "6120",
        taxCode: "GST",
        amountsMode: "inclusive",
      }),
    );
    const before = await world.journalCount();
    const line = await world.lineOn(world.bank.id, "-46.00");
    const { rule } = await world.asUser(viewer, (tx) => suggestionsForLine(tx, line.id));
    expect(rule).toMatchObject({
      name: "Fuel",
      contactName: "Z Energy",
      amountsMode: "inclusive",
      suggestedLine: { description: "Z ENERGY", accountCode: "6120", taxCode: "GST", amount: "46.00" },
    });
    const incoming = await world.lineOn(world.bank.id, "115.00");
    expect((await world.asUser(viewer, (tx) => suggestionsForLine(tx, incoming.id))).rule).toBeNull();
    expect(await world.journalCount()).toBe(before);
  });

  it("BK11: unreconciling posts nothing; a reconciled bank transaction or payment can't be voided until unreconciled", async () => {
    const world = await afterBk1();
    const line = await world.lineOn(world.bank.id, "-46.00");
    const { line: done } = await world.reconcile(line.id, { kind: "bank_transaction", contactId: world.zEnergy.id, amountsMode: "inclusive", lines: [world.spendLine] });
    const transaction = (await world.sql("select id from bank_transactions")).rows[0].id as string;
    await expect(world.asUser(bookkeeper, (tx) => voidBankTransaction(tx, transaction, { idempotencyKey: key("void"), voidDate: "2026-06-02" }))).rejects.toThrow(
      "This bank transaction is reconciled with a bank statement line. Unreconcile it first.",
    );
    // The database refuses a reversal of a reconciled journal too, e.g. a ledger correction.
    await expect(
      world.asUser(owner, (tx) =>
        tx.query(
          `insert into ledger_journals (command_source, idempotency_key, request_hash, origin, posting_date, reference, currency_code,
                                        total_debit, total_credit, related_journal_id, correction_kind)
           values ('sql', 'x', 'h', 'correction', '2026-06-02', 'X', 'NZD', 46, 46, $1, 'reversal')`,
          [done.reconciliation!.items[0].journalId],
        ),
      ),
    ).rejects.toThrow(/reconciled with a bank statement line .* Unreconcile it first/);
    const before = await world.journalCount();
    const { line: undone } = await world.unreconcile(line.id);
    expect(undone).toMatchObject({ status: "unreconciled", reconciliation: null });
    expect(await world.journalCount()).toBe(before);
    const voided = await world.asUser(bookkeeper, (tx) => voidBankTransaction(tx, transaction, { idempotencyKey: key("void"), voidDate: "2026-06-02" }));
    expect(await world.postedLines(voided.bankTransaction.voidJournalId!)).toEqual([
      ["6120", "0.00", "40.00"],
      ["2100", "0.00", "6.00"],
      ["1000", "46.00", "0.00"],
    ]);
    const june = await world.asUser(viewer, (tx) => calculateGstReturn(tx, { periodStart: "2026-06-01", periodEnd: "2026-07-31" }));
    expect(june.boxes.box11).toBe("-46.00");
    // The same rule for a customer payment reconciled from a line.
    const kobe = await world.lineOn(world.bank.id, "115.00");
    const { line: paid } = await world.reconcile(kobe.id, { kind: "payments", allocations: [{ invoiceId: world.i1.id, amount: "115.00" }] });
    const paymentId = (await world.sql("select id from customer_payments where journal_id = $1", [paid.reconciliation!.items[0].journalId])).rows[0].id as string;
    await expect(
      world.asUser(bookkeeper, (tx) => voidPayment(tx, world.i1.id, paymentId, { idempotencyKey: key("void-pay"), voidDate: "2026-05-30" })),
    ).rejects.toThrow(/reconciled with a bank statement line/);
    await expect(world.unreconcile(line.id)).rejects.toThrow("This line isn't reconciled.");
  });

  it("BK12: excluding lines, and deleting an import only while none of its lines is reconciled", async () => {
    const world = await afterBk1();
    const line = await world.lineOn(world.bank.id, "-500.00");
    expect((await world.asUser(bookkeeper, (tx) => setStatementLineExcluded(tx, line.id, true))).status).toBe("excluded");
    expect((await world.asUser(viewer, (tx) => getBankAccount(tx, world.bank.id))).unreconciledCount).toBe(2);
    await expect(world.reconcile(line.id, { kind: "transfer", otherAccountCode: "1010" })).rejects.toThrow(/excluded/);
    expect((await world.asUser(bookkeeper, (tx) => setStatementLineExcluded(tx, line.id, false))).status).toBe("unreconciled");
    const kobe = await world.lineOn(world.bank.id, "115.00");
    await world.reconcile(kobe.id, { kind: "payments", allocations: [{ invoiceId: world.i1.id, amount: "115.00" }] });
    await expect(world.asUser(bookkeeper, (tx) => setStatementLineExcluded(tx, kobe.id, true))).rejects.toThrow(/Unreconcile it before excluding it/);
    await expect(world.asUser(bookkeeper, (tx) => deleteImport(tx, world.bk1.id))).rejects.toThrow(/1 of this import's lines is reconciled/);
    await world.unreconcile(kobe.id);
    const deleted = await world.asUser(bookkeeper, (tx) => deleteImport(tx, world.bk1.id));
    expect(deleted).toMatchObject({ status: "deleted" });
    expect(await world.lines(world.bank.id, "all")).toEqual([]);
    expect((await world.lines(world.bank.id, "deleted")).length).toBe(3);
    // Deleted lines don't block importing the file again.
    expect((await world.importFile(world.bank.id, CSV)).import.lineCount).toBe(3);
  });

  it("BK13: reconciling or unreconciling a line dated in a locked period is refused", async () => {
    const world = await afterBk1();
    const kobe = await world.lineOn(world.bank.id, "115.00");
    const other = await world.lineOn(world.bank.id, "-46.00");
    await world.reconcile(kobe.id, { kind: "payments", allocations: [{ invoiceId: world.i1.id, amount: "115.00" }] });
    await world.lock("2026-05-31");
    try {
      await expect(world.unreconcile(kobe.id)).rejects.toThrow(/2026-05-20 is in a locked period/);
      await expect(
        world.reconcile(other.id, { kind: "bank_transaction", contactId: world.zEnergy.id, amountsMode: "inclusive", lines: [world.spendLine] }),
      ).rejects.toThrow(/2026-05-21 is in a locked period/);
      expect((await world.asUser(viewer, (tx) => getStatementLine(tx, kobe.id))).status).toBe("reconciled");
    } finally {
      await world.lock(null);
    }
  });

  it("BK14: retrying import, reconcile, unreconcile and void with the same key returns the same result; different content is 409", async () => {
    const world = await setup();
    const importKey = key("import");
    const first = await world.importFile(world.bank.id, CSV, "statement.csv", { idempotencyKey: importKey });
    expect(await world.importFile(world.bank.id, CSV, "statement.csv", { idempotencyKey: importKey })).toEqual({ ...first, created: false });
    await expect(world.importFile(world.bank.id, `${CSV}23/05/2026,1.00,X,,,\n`, "statement.csv", { idempotencyKey: importKey })).rejects.toThrow(
      /already used for a different statement import/,
    );
    const line = await world.lineOn(world.bank.id, "-46.00");
    const reconcileKey = key("reconcile");
    const command = { kind: "bank_transaction", contactId: world.zEnergy.id, amountsMode: "inclusive", lines: [world.spendLine], idempotencyKey: reconcileKey };
    const done = await world.reconcile(line.id, command);
    const journals = await world.journalCount();
    expect(await world.reconcile(line.id, command)).toEqual({ ...done, created: false });
    await expect(world.reconcile(line.id, { ...command, reference: "Other" })).rejects.toThrow(/already used for a different reconciliation/);
    const undoKey = key("undo");
    const undone = await world.unreconcile(line.id, undoKey);
    expect(await world.unreconcile(line.id, undoKey)).toEqual({ ...undone, created: false });
    expect(await world.journalCount()).toBe(journals);
    // Over HTTP: viewers read, bookkeepers reconcile; a retry is 200.
    const [bookkeeperCookie, viewerCookie] = await Promise.all([bookkeeper, viewer].map((user) => sessionCookieFor(user)));
    const listed = await linesRoute.GET(
      apiRequest(`/api/bank-accounts/${world.bank.id}/statement-lines?organisationId=${world.org}&status=unreconciled`, { cookie: viewerCookie }),
      params({ accountId: world.bank.id }),
    );
    expect(((await body(listed)).lines as StatementLine[]).length).toBe(3);
    const httpKey = key("http");
    const post = (cookie: string) =>
      reconcileRoute.POST(
        apiRequest(`/api/statement-lines/${line.id}/reconcile`, {
          method: "POST",
          cookie,
          body: { organisationId: world.org, idempotencyKey: httpKey, kind: "transfer", otherAccountCode: "1010" },
        }),
        params({ lineId: line.id }),
      );
    expect((await post(viewerCookie)).status).toBe(403);
    expect((await post(bookkeeperCookie)).status).toBe(201);
    expect((await post(bookkeeperCookie)).status).toBe(200);
    const upload = await importsRoute.POST(
      apiRequest(`/api/bank-accounts/${world.bank.id}/imports`, {
        method: "POST",
        cookie: bookkeeperCookie,
        body: { organisationId: world.org, idempotencyKey: key("http-import"), fileName: "s.csv", fileBase64: b64(CSV) },
      }),
      params({ accountId: world.bank.id }),
    );
    expect(upload.status).toBe(201);
    expect(((await body(upload)).import as { duplicateCount: number }).duplicateCount).toBe(3);
  });

  it("the database refuses edited lines, reconciliations that don't add up, and changed reconciliations", async () => {
    const world = await afterBk1();
    const line = await world.lineOn(world.bank.id, "115.00");
    await expect(world.sql("update bank_statement_lines set amount = 1 where id = $1", [line.id])).rejects.toThrow(
      "Statement lines can't be changed, only reconciled, excluded or deleted",
    );
    await expect(world.sql("delete from bank_statement_lines where id = $1", [line.id])).rejects.toThrow("Statement lines can't be deleted");
    await expect(world.sql("update bank_statement_lines set status = 'reconciled' where id = $1", [line.id])).rejects.toThrow(
      /marked reconciled without a reconciliation/,
    );
    const { payment } = await world.asUser(bookkeeper, (tx) =>
      recordPayment(tx, world.i1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-20", amount: "100.00", bankAccountCode: "1000" }),
    );
    const journalLine = (await world.sql("select id from ledger_journal_lines where journal_id = $1 and debit_amount > 0", [payment.journalId])).rows[0].id;
    await expect(
      world.asUser(owner, async (tx) => {
        const rec = await tx.query<{ id: string }>(
          "insert into bank_reconciliations (command_source, idempotency_key, request_hash, statement_line_id, kind) values ('sql', 'x', 'h', $1, 'match') returning id",
          [line.id],
        );
        await tx.query("insert into bank_reconciliation_items (reconciliation_id, journal_line_id, amount) values ($1, $2, 100)", [rec.rows[0].id, journalLine]);
        await tx.query("update bank_statement_lines set status = 'reconciled' where id = $1", [line.id]);
      }),
    ).rejects.toThrow(/reconciled against journal lines adding up to 100/);
    const fuel = await world.lineOn(world.bank.id, "-46.00");
    await world.reconcile(fuel.id, { kind: "bank_transaction", contactId: world.zEnergy.id, amountsMode: "inclusive", lines: [world.spendLine] });
    await expect(world.sql("update bank_reconciliations set kind = 'transfer'")).rejects.toThrow("Reconciliations can't be changed, only removed once");
    await expect(world.sql("delete from bank_reconciliation_items")).rejects.toThrow("Reconciliations can't be deleted");
  });

  it("bank transaction and transfer journals are their own kinds and can't be corrected in the ledger", async () => {
    const world = await afterBk1();
    const line = await world.lineOn(world.bank.id, "-46.00");
    const { line: done } = await world.reconcile(line.id, { kind: "bank_transaction", contactId: world.zEnergy.id, amountsMode: "inclusive", lines: [world.spendLine] });
    const journalId = done.reconciliation!.items[0].journalId;
    const kinds = await world.asUser(viewer, async (tx) => (await listJournals(tx, { kind: "bank_transaction" })).journals.map((entry) => entry.id));
    expect(kinds).toEqual([journalId]);
    await expect(
      world.asUser(bookkeeper, (tx) =>
        correctJournal(tx, {
          idempotencyKey: key("fix"),
          originalJournalId: journalId,
          postingDate: "2026-06-01",
          reference: "FIX",
          lines: [
            { accountCode: "6120", debitAmount: "46" },
            { accountCode: "1000", creditAmount: "46" },
          ],
        }),
      ),
    ).rejects.toThrow(/posted by a bank transaction .* can't be corrected in the ledger/);
    // A standalone bank transaction (not from a line) works too.
    const standalone = await world.asUser(bookkeeper, (tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("bt"),
        kind: "spend",
        accountId: world.bank.id,
        contactId: world.zEnergy.id,
        date: "2026-05-25",
        amountsMode: "exclusive",
        lines: [{ description: "Fuel", accountCode: "6120", taxCode: "GST", amount: "100.00" }],
      }),
    );
    expect(standalone.bankTransaction).toMatchObject({ subtotal: "100.00", taxTotal: "15.00", total: "115.00", status: "posted" });
  });

  it("secrets are encrypted with TOHYEE_SECRET_KEY and can't be read with another key", () => {
    const stored = encryptSecret("user_token_abc");
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain("user_token_abc");
    expect(decryptSecret(stored)).toBe("user_token_abc");
    const original = process.env.TOHYEE_SECRET_KEY;
    process.env.TOHYEE_SECRET_KEY = "another-secret-key-that-is-long-enough-000";
    try {
      expect(() => decryptSecret(stored)).toThrow(/can't be read with this server's TOHYEE_SECRET_KEY/);
    } finally {
      process.env.TOHYEE_SECRET_KEY = original;
    }
  });

  it("BK15, BK16: an Akahu feed brings in settled transactions once, flags a CSV twin, and keeps the balance", async () => {
    const world = await setup();
    // Each organisation saves its own Akahu personal app. Only admins can, and the tokens are checked with Akahu first.
    const saveTokens = async (user: SessionUser, fields: Record<string, unknown>) =>
      akahuSettingsRoute.PUT(
        apiRequest("/api/bank-feeds/akahu/settings", {
          method: "PUT",
          cookie: await sessionCookieFor(user),
          body: { organisationId: world.org, ...fields },
        }),
        undefined as unknown,
      );
    setAkahuFetchForTests(async () => new Response(JSON.stringify({ success: false, message: "Invalid token" }), { status: 401 }));
    expect((await saveTokens(bookkeeper, { appToken: "app_token_abc", userToken: "user_token_xyz" })).status).toBe(403);
    const refused = await saveTokens(owner, { appToken: "app_token_abc", userToken: "user_token_bad" });
    expect(refused.status).toBe(400);
    expect(((await body(refused)) as { error: string }).error).toBe("Akahu refused the tokens: Invalid token. Check the App ID token and user token.");
    const accountsReply = { success: true, items: [{ _id: "acc_1", name: "Business", type: "CHECKING", balance: { current: 1023.5 } }] };
    setAkahuFetchForTests(async () => new Response(JSON.stringify(accountsReply), { status: 200 }));
    const saved = await saveTokens(owner, { appToken: "app_token_abc", userToken: "user_token_xyz", syncEveryHours: 4 });
    expect(saved.status).toBe(200);
    expect(await body(saved)).toMatchObject({
      accountCount: 1,
      akahu: { configured: true, syncEveryHours: 4, appTokenHint: "app_token_…_abc" },
    });
    // Blank tokens keep the saved ones.
    expect(await body(await saveTokens(owner, { syncEveryHours: 6 }))).toMatchObject({ akahu: { configured: true, syncEveryHours: 6 } });
    const stored = await world.sql("select app_token_ciphertext, user_token_ciphertext, status from akahu_connections order by id");
    // New tokens for the same login replace its tokens in place, so its links carry on (#182, BK34).
    expect(stored.rows.map((row) => row.status)).toEqual(["active"]);
    expect(JSON.stringify(stored.rows)).not.toMatch(/user_token_xyz|app_token_abc/);
    const read = await body(
      await akahuSettingsRoute.GET(
        apiRequest(`/api/bank-feeds/akahu/settings?organisationId=${world.org}`, { cookie: await sessionCookieFor(viewer) }),
        undefined as unknown,
      ),
    );
    expect(read).toMatchObject({ akahu: { configured: true } });
    expect(JSON.stringify(read)).not.toContain("user_token_xyz");

    // A CSV line already there for 20 May.
    await world.importFile(world.bank.id, "Date,Amount,Payee\n20/05/2026,115.00,KOBE LTD\n");
    const requests: string[] = [];
    setAkahuFetchForTests(async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      expect((init?.headers as Record<string, string>)["X-Akahu-Id"]).toBe("app_token_abc");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer user_token_xyz");
      if (url.includes("/transactions")) {
        const page = new URL(url).searchParams.get("cursor");
        const items = page
          ? [{ _id: "trans_2", _account: "acc_1", date: "2026-05-20T00:30:00.000Z", description: "KOBE LTD", amount: 115, balance: 1069, meta: { particulars: "INV-0001" } }]
          : [
              { _id: "trans_1", _account: "acc_1", date: "2026-05-21T03:00:00.000Z", description: "Z ENERGY", amount: -46, balance: 1023, merchant: { name: "Z Energy" } },
              { _id: "trans_0", _account: "acc_1", date: "2026-04-01T03:00:00.000Z", description: "OLD", amount: -1, balance: 1 },
            ];
        return new Response(JSON.stringify({ success: true, items, cursor: { next: page ? null : "page2" } }), { status: 200 });
      }
      if (url.endsWith("/accounts")) {
        return new Response(JSON.stringify({ success: true, items: [{ _id: "acc_1", name: "Business", type: "CHECKING", balance: { current: 1023.5 } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    await world.asUser(owner, (tx) =>
      linkBankFeed(tx, world.bank.id, { akahuAccountId: "acc_1", akahuAccountName: "Business", startDate: "2026-05-01" }),
    );
    const organisation = (await getOrganisation(world.org))!;
    const first = await syncBankFeedAccount(organisation, world.bank.id);
    expect(first).toMatchObject({ added: 2, duplicates: 0, possibleDuplicates: 1 });
    const lines = await world.lines(world.bank.id, "unreconciled");
    const feed = lines.filter((line) => line.source === "akahu");
    expect(feed.map((line) => [line.date, line.amount, line.description, line.payee, line.particulars, line.externalId])).toEqual([
      ["2026-05-20", "115.00", "KOBE LTD", null, "INV-0001", "akahu:trans_2"],
      ["2026-05-21", "-46.00", "Z ENERGY", "Z Energy", null, "akahu:trans_1"],
    ]);
    const csvLine = lines.find((line) => line.source === "file")!;
    expect(feed[0].possibleDuplicateOf).toBe(csvLine.id);
    expect(await syncBankFeedAccount(organisation, world.bank.id)).toMatchObject({ added: 0, duplicates: 2 });
    expect(await world.asUser(viewer, (tx) => getBankAccount(tx, world.bank.id))).toMatchObject({
      statementBalance: "1023.50",
      feed: { akahuAccountId: "acc_1", active: true, lastSyncStatus: "ok", lastSyncError: null, startDate: "2026-05-01" },
    });
    expect(requests.some((request) => request.startsWith("GET https://api.akahu.io/v1/accounts/acc_1/transactions?start="))).toBe(true);
    // A failed sync keeps the error and changes nothing.
    setAkahuFetchForTests(async () => new Response(JSON.stringify({ success: false, message: "Token revoked" }), { status: 401 }));
    await expect(syncBankFeedAccount(organisation, world.bank.id)).rejects.toThrow("Akahu refused the tokens: Token revoked");
    expect(await world.asUser(viewer, (tx) => getBankAccount(tx, world.bank.id))).toMatchObject({
      // BK33: the login needs new tokens (its row says so too).
      feed: { lastSyncStatus: "failed", lastSyncError: "Akahu needs new tokens. Akahu refused the tokens: Token revoked. Check the App ID token and user token." },
    });
    expect((await world.lines(world.bank.id, "unreconciled")).length).toBe(3);
  });

  it("BK29: an Akahu sync reads 30 days back, so a back-dated transaction comes in and a deleted line stays deleted (#147)", async () => {
    const world = await setup();
    // Akahu as it behaves: only transactions after `start` (exclusive) come back.
    type Item = { _id: string; _account: string; date: string; description: string; amount: number; balance?: number };
    let items: Item[] = [];
    let balance = 1000;
    const starts: string[] = [];
    setAkahuFetchForTests(async (url) => {
      if (url.includes("/transactions")) {
        const start = new URL(url).searchParams.get("start")!;
        starts.push(start);
        const after = items.filter((item) => Date.parse(item.date) > Date.parse(start));
        return new Response(JSON.stringify({ success: true, items: after, cursor: { next: null } }), { status: 200 });
      }
      if (url.endsWith("/accounts")) {
        return new Response(JSON.stringify({ success: true, items: [{ _id: "acc_1", name: "Business", type: "CHECKING", balance: { current: balance } }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const saved = await akahuSettingsRoute.PUT(
      apiRequest("/api/bank-feeds/akahu/settings", {
        method: "PUT",
        cookie: await sessionCookieFor(owner),
        body: { organisationId: world.org, appToken: "app_token_abc", userToken: "user_token_xyz" },
      }),
      undefined as unknown,
    );
    expect(saved.status).toBe(200);
    await world.asUser(owner, (tx) =>
      linkBankFeed(tx, world.bank.id, { akahuAccountId: "acc_1", akahuAccountName: "Business", startDate: "2026-05-20" }),
    );
    const organisation = (await getOrganisation(world.org))!;
    const sync = () => syncBankFeedAccount(organisation, world.bank.id);
    const feedLines = async (status = "all") =>
      (await world.lines(world.bank.id, status))
        .filter((line) => line.source === "akahu")
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((line) => [line.date, line.amount, line.externalId]);

    // Amounts arrive as JSON numbers; each is read exactly, to the cent, never through floating point rounding.
    items = [
      { _id: "t_a", _account: "acc_1", date: "2026-06-04T03:00:00.000Z", description: "CAFE", amount: 0.1, balance: 0.3 },
      { _id: "t_b", _account: "acc_1", date: "2026-06-05T04:00:00.000Z", description: "CAFE", amount: 0.2, balance: 1234567.89 },
    ];
    balance = 1023.5;
    expect(await sync()).toMatchObject({ added: 2, duplicates: 0 });
    expect(await feedLines()).toEqual([
      ["2026-06-04", "0.10", "akahu:t_a"],
      ["2026-06-05", "0.20", "akahu:t_b"],
    ]);
    expect((await world.lines(world.bank.id)).map((line) => [line.externalId, line.balance]).sort()).toEqual([
      ["akahu:t_a", "0.30"],
      ["akahu:t_b", "1234567.89"],
    ]);
    expect(await world.asUser(viewer, (tx) => getBankAccount(tx, world.bank.id))).toMatchObject({ statementBalance: "1023.50" });

    // The next sync brings in 20 June. Then the first import (the 4 and 5 June lines) is deleted.
    items.push({ _id: "t_c", _account: "acc_1", date: "2026-06-20T03:00:00.000Z", description: "Z ENERGY", amount: -46 });
    expect(await sync()).toMatchObject({ added: 1, duplicates: 2 });
    const firstImport = (
      await world.sql(
        `select i.id::text from bank_statement_imports i join bank_statement_lines b on b.import_id = i.id where b.external_id = 'akahu:t_a'`,
      )
    ).rows[0].id as string;
    await world.asUser(bookkeeper, (tx) => deleteImport(tx, firstImport));

    // A card purchase from 10 June settles late under its own date, 10 days before the newest line (20 June).
    // The sync reads from 30 days before 20 June (less two days for the time zone): it comes in, and the
    // deleted 4 and 5 June lines, also in that window, aren't brought back.
    items.push({ _id: "t_d", _account: "acc_1", date: "2026-06-10T03:00:00.000Z", description: "KAURI SUPPLIES", amount: -230 });
    expect(await sync()).toMatchObject({ added: 1, duplicates: 3 });
    expect(starts.at(-1)).toBe("2026-05-19T00:00:00.000Z");
    expect(await feedLines("unreconciled")).toEqual([
      ["2026-06-10", "-230.00", "akahu:t_d"],
      ["2026-06-20", "-46.00", "akahu:t_c"],
    ]);
    expect(await feedLines("deleted")).toEqual([
      ["2026-06-04", "0.10", "akahu:t_a"],
      ["2026-06-05", "0.20", "akahu:t_b"],
    ]);
    // The window never reaches before the start date (20 May): the first two syncs asked from two days before it.
    expect(starts).toEqual(["2026-05-18T00:00:00.000Z", "2026-05-18T00:00:00.000Z", "2026-05-19T00:00:00.000Z"]);

    // An amount finer than a cent is refused, not rounded, and nothing is added.
    items.push({ _id: "t_e", _account: "acc_1", date: "2026-06-21T03:00:00.000Z", description: "ODD", amount: 1.005 });
    await expect(sync()).rejects.toThrow("Akahu's amount for transaction t_e can have at most 2 decimal places.");
    expect((await feedLines("unreconciled")).length).toBe(2);

    // Lines from a file are different: deleting an OFX import and importing the file again by hand brings them back (BK12, BF6).
    const ofx = `OFXHEADER:100\n<OFX><BANKTRANLIST>\n<STMTTRN><DTPOSTED>20260601<TRNAMT>-9.00<FITID>F1<NAME>PARKING\n</BANKTRANLIST></OFX>`;
    const ofxImport = (await world.importFile(world.bank.id, ofx, "statement.ofx")).import;
    expect(ofxImport).toMatchObject({ lineCount: 1 });
    await world.asUser(bookkeeper, (tx) => deleteImport(tx, ofxImport.id));
    expect((await world.importFile(world.bank.id, ofx, "statement.ofx")).import).toMatchObject({ lineCount: 1, duplicateCount: 0 });
  });

  it("migration 0011 upgrades an organisation database on 0010, turning the starting chart's credit card into a credit card account", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_bank`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      await applyMigrations(client, tenantMigrations.filter((migration) => migration.version < "0011"), "test:upgrade");
      await client.query(`insert into organisation_settings (organisation_id, display_name, base_currency) values ('upgrade-co', 'Upgrade Co', 'NZD')`);
      await client.query(`insert into accounts (code, name, account_class, account_type) values ('2400', 'Credit card', 'liability', 'current_liability')`);
      expect((await applyMigrations(client, tenantMigrations.filter((migration) => migration.version <= "0011"), "test:upgrade")).applied).toEqual(["0011"]);
      expect((await client.query("select account_type from accounts where code = '2400'")).rows).toEqual([{ account_type: "credit_card" }]);
      const origin = await client.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'ledger_journals_origin_check'",
      );
      expect(origin.rows[0].definition).toContain("'bank_transaction'");
    } finally {
      await client.end();
    }
  });
});

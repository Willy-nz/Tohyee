import { afterAll, beforeAll, expect, it } from "vitest";
import * as confidentRoute from "@/app/api/bank-accounts/[accountId]/confident-matches/route";
import * as okRoute from "@/app/api/statement-lines/[lineId]/ok/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { confidentMatches, okConfidentMatches, okStatementLine } from "@/lib/bank/confident";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { createBankRule } from "@/lib/bank/rules";
import { createBankTransaction } from "@/lib/bank/transactions";
import { approveBill, createBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
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
});

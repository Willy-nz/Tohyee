import { afterAll, beforeAll, expect, it } from "vitest";
import * as openingRoute from "@/app/api/bank-accounts/[accountId]/opening-foreign-balance/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getBankAccount, listStatementLines, type StatementLine } from "@/lib/bank/accounts";
import { linkBankFeed } from "@/lib/bank/akahu/settings";
import { confidentMatches, okStatementLine } from "@/lib/bank/confident";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import { createBankTransaction, createTransfer, getBankTransaction, voidBankTransaction, voidTransfer } from "@/lib/bank/transactions";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { recordForeignOpeningBalance } from "@/lib/ledger/foreign";
import { postFxRevaluation } from "@/lib/ledger/fx-revaluation";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { dec, sub, toFixedString } from "@/lib/money/decimal";
import { bankReconciliationReport } from "@/lib/reports/bank-reconciliation";
import { trialBalance } from "@/lib/reports/financial";
import { calculateGstReturn } from "@/lib/reports/gst-return";
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

const b64 = (text: string) => Buffer.from(text).toString("base64");

const USD_CSV = `Date,Amount,Payee,Particulars,Code,Reference,Balance
03/07/2026,1000.00,ETSY PAYMENTS,,,,2000.00
05/07/2026,-50.00,AMAZON WEB SERVICES,,,,1950.00
10/07/2026,-500.00,TRANSFER TO NZD,,,,1450.00
20/07/2026,610.00,TRANSFER FROM NZD,,,,2060.00
05/08/2026,-2060.00,TRANSFER TO NZD,,,,0.00
`;

const NZD_CSV = `Date,Amount,Payee,Particulars,Code,Reference
10/07/2026,820.00,TRANSFER FROM USD,,,
20/07/2026,-1000.00,TRANSFER TO USD,,,
05/08/2026,3400.00,TRANSFER FROM USD,,,
`;

/**
 * Examples FXB1-FXB11 in docs/ACCOUNTING-EXAMPLES.md (foreign-currency bank
 * accounts, not yet approved by Jess), one organisation worked through in
 * order: 1000 Business bank account (NZD) and 1030 USD account, set to USD
 * before Tohyee kept foreign amounts, with one NZD-only posting on 1 Jun 2026
 * (Dr 1030 1,600.00 / Cr 3000 1,600.00).
 */
describeWithDatabase("foreign-currency bank accounts", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const ORG = "fx-bank-co";
  let usd: { id: string };
  let nzd: { id: string };
  let etsy: Contact;
  let aws: Contact;
  let kobe: Contact;
  let invoiceId: string;

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => as(bookkeeper, work);
  const lines = async (accountId: string) => (await run((tx) => listStatementLines(tx, accountId, { status: "all" }))).lines;
  const lineOn = async (accountId: string, date: string, amount: string): Promise<StatementLine> =>
    (await lines(accountId)).find((line) => line.date === date && line.amount === amount)!;
  const posted = async (journalId: string) =>
    (await run((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
  const foreignOf = async (journalId: string, accountCode: string) =>
    (await run((tx) => getJournal(tx, journalId))).lines.find((line) => line.accountCode === accountCode)!.foreign;
  const reconcile = (lineId: string, command: Record<string, unknown>) =>
    run((tx) => reconcileStatementLine(tx, lineId, { idempotencyKey: key("reconcile"), ...command }));
  const journalOf = (line: StatementLine) => line.reconciliation!.items[0].journalId;
  const balances = async () => {
    const account = await run((tx) => getBankAccount(tx, usd.id));
    return [account.foreignBalance, account.ledgerBalance];
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("fx-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("fx-bookkeeper@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, bookkeeper.id]);
    const contact = async (name: string, flags: Record<string, boolean>) =>
      (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...flags }))).contact;
    etsy = await contact("Etsy", { isCustomer: true });
    aws = await contact("Amazon Web Services", { isSupplier: true });
    kobe = await contact("Kobe Ltd", { isCustomer: true });
    invoiceId = await run(async (tx) => {
      const drafted = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: kobe.id,
        invoiceDate: "2026-05-10",
        dueDate: "2026-06-20",
        amountsMode: "exclusive",
        lines: [{ description: "Consulting", quantity: "2", unitPrice: "50.00", accountCode: "4000", taxCode: "GST" }],
      });
      return (await approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("approve") })).invoice.id;
    });
    nzd = (await run((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0];
    // 1030 was set to USD before Tohyee kept foreign amounts: its 1 June posting has only the NZD.
    usd = await as(owner, (tx) => createBankAccount(tx, { code: "1030", name: "USD account", accountType: "bank" }));
    await run((tx) =>
      postJournal(tx, {
        idempotencyKey: key("old"),
        postingDate: "2026-06-01",
        reference: "USD-IN",
        lines: [
          { accountCode: "1030", debitAmount: "1600.00" },
          { accountCode: "3000", creditAmount: "1600.00" },
        ],
      }),
    );
    await as(owner, async (tx) => {
      await tx.query("alter table accounts disable trigger accounts_currency_guard");
      await tx.query("update accounts set currency_code = 'USD' where id = $1", [usd.id]);
      await tx.query("alter table accounts enable trigger accounts_currency_guard");
    });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FXB1: an account with NZD-only postings needs its opening foreign balance once; it posts nothing", async () => {
    const needs = /has postings from before Tohyee kept foreign amounts\. Enter its USD balance as at a date \(its opening foreign balance\) first/;
    await expect(
      run((tx) => importStatementFile(tx, usd.id, { idempotencyKey: key("import"), fileName: "usd.csv", fileBase64: b64(USD_CSV) })),
    ).rejects.toThrow(needs);
    await expect(
      run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: "2026-07-01",
          reference: "X",
          lines: [
            { accountCode: "1030", debitAmount: "16.00", foreignAmount: "10.00", exchangeRate: "1.6" },
            { accountCode: "3000", creditAmount: "16.00" },
          ],
        }),
      ),
    ).rejects.toThrow(needs);
    // The database refuses a line on a foreign-currency account without a foreign amount.
    await expect(
      run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: "2026-07-01",
          reference: "X",
          lines: [
            { accountCode: "1030", debitAmount: "16.00" },
            { accountCode: "3000", creditAmount: "16.00" },
          ],
        }),
      ),
    ).rejects.toThrow(/account 1030 \(USD account\) is in USD\. Give the USD amount and the exchange rate/);
    expect((await run((tx) => getBankAccount(tx, usd.id))).needsOpeningBalance).toBe(true);

    const opening = (input: Record<string, unknown>, accountId = usd.id) =>
      run((tx) => recordForeignOpeningBalance(tx, accountId, { idempotencyKey: key("opening"), asAtDate: "2026-06-30", foreignBalance: "1000.00", ...input }));
    await expect(opening({ asAtDate: "2026-05-31" })).rejects.toThrow(/has postings up to 2026-06-01/);
    await expect(opening({ foreignBalance: "-1000.00" })).rejects.toThrow(/its USD balance must be more than 0/);
    await expect(opening({}, nzd.id)).rejects.toThrow(/is in NZD, so it has no opening foreign balance/);
    const empty = await as(owner, (tx) => createBankAccount(tx, { code: "1040", name: "USD savings", accountType: "bank", currencyCode: "USD" }));
    await expect(opening({}, empty.id)).rejects.toThrow(/doesn't need an opening foreign balance/);

    const before = await run((tx) => trialBalance(tx, { asAt: "2026-06-30" }));
    const body = { organisationId: ORG, idempotencyKey: key("opening"), asAtDate: "2026-06-30", foreignBalance: "1000.00" };
    const cookie = await sessionCookieFor(bookkeeper);
    const response = await openingRoute.POST(
      apiRequest(`/api/bank-accounts/${usd.id}/opening-foreign-balance`, { method: "POST", cookie, body }),
      params({ accountId: usd.id }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { openingBalance: { foreignBalance: string; baseBalance: string; asAtDate: string } };
    expect(created.openingBalance).toMatchObject({ foreignBalance: "1000.00", baseBalance: "1600.00", asAtDate: "2026-06-30" });
    const retry = await openingRoute.POST(
      apiRequest(`/api/bank-accounts/${usd.id}/opening-foreign-balance`, { method: "POST", cookie, body }),
      params({ accountId: usd.id }),
    );
    expect(retry.status).toBe(200);
    expect(await run((tx) => trialBalance(tx, { asAt: "2026-06-30" }))).toEqual(before);
    expect(await balances()).toEqual(["1000.00", "1600.00"]);
    await expect(opening({})).rejects.toThrow(/already has its opening foreign balance/);
    await expect(
      run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: "2026-06-30",
          reference: "X",
          lines: [
            { accountCode: "1030", debitAmount: "16.00", foreignAmount: "10.00", exchangeRate: "1.6" },
            { accountCode: "3000", creditAmount: "16.00" },
          ],
        }),
      ),
    ).rejects.toThrow(/has an opening foreign balance as at 2026-06-30, so nothing can be posted to it dated on or before then/);
    // The database refuses it too, whatever the app does.
    await expect(
      run(async (tx) => {
        const journal = await tx.query<{ id: string }>(
          `insert into ledger_journals (command_source, idempotency_key, request_hash, origin, posting_date, reference, currency_code, total_debit, total_credit)
           values ('test', $1, 'x', 'manual', '2026-06-15', 'X', 'NZD', 16, 16) returning id`,
          [key("raw")],
        );
        await tx.query(
          `insert into ledger_journal_lines (journal_id, line_order, account_id, debit_amount, credit_amount, foreign_currency_code, foreign_amount, exchange_rate, fx_kind)
           values ($1, 1, $2, 16, 0, 'USD', 10, 1.6, 'rate')`,
          [journal.rows[0].id, usd.id],
        );
      }),
    ).rejects.toThrow(/nothing can be posted to it dated on or before then/);
  });

  it("FXB10: a statement in another currency is refused; one that doesn't say is in the account's currency; no Akahu feed", async () => {
    const withCurrency = `Date,Amount,Payee,Currency\n03/07/2026,1000.00,ETSY PAYMENTS,NZD\n`;
    await expect(
      run((tx) => importStatementFile(tx, usd.id, { idempotencyKey: key("import"), fileName: "nzd.csv", fileBase64: b64(withCurrency) })),
    ).rejects.toThrow("This file is in NZD, but 1030 (USD account) is in USD. Nothing was imported.");
    const ofx = `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD\n<BANKTRANLIST>\n<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260703<TRNAMT>1000.00<FITID>A1<NAME>ETSY</STMTTRN>\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    await expect(
      run((tx) => importStatementFile(tx, nzd.id, { idempotencyKey: key("import"), fileName: "usd.ofx", fileBase64: b64(ofx) })),
    ).rejects.toThrow("This file is in USD, but 1000 (Business bank account) is in NZD. Nothing was imported.");
    await expect(
      as(owner, (tx) => linkBankFeed(tx, usd.id, { akahuAccountId: "acc_1", startDate: "2026-07-01" })),
    ).rejects.toThrow(/Akahu bank feeds can't be used for foreign-currency accounts yet: Akahu's transactions don't say their currency/);

    await run((tx) => importStatementFile(tx, usd.id, { idempotencyKey: key("import"), fileName: "usd.csv", fileBase64: b64(USD_CSV) }));
    await run((tx) => importStatementFile(tx, nzd.id, { idempotencyKey: key("import"), fileName: "nzd.csv", fileBase64: b64(NZD_CSV) }));
    const imported = await lines(usd.id);
    expect(imported.map((line) => [line.date, line.amount, line.currencyCode])).toEqual([
      ["2026-08-05", "-2060.00", "USD"],
      ["2026-07-20", "610.00", "USD"],
      ["2026-07-10", "-500.00", "USD"],
      ["2026-07-05", "-50.00", "USD"],
      ["2026-07-03", "1000.00", "USD"],
    ]);
    expect((await lines(nzd.id)).every((line) => line.currencyCode === "NZD" && line.suggestedRate === null)).toBe(true);
  });

  it("FXB2: receive USD 1,000.00 at 1.6543 is NZD 1,654.30; zero-rated, it's in Boxes 5 and 6", async () => {
    const line = await lineOn(usd.id, "2026-07-03", "1000.00");
    expect([line.suggestedRate, line.baseAmount]).toEqual([null, null]);
    const receive = { kind: "bank_transaction", contactId: etsy.id, amountsMode: "inclusive", lines: [{ description: "Etsy sales", accountCode: "4000", taxCode: "ZERO", amount: "1000.00" }] };
    await expect(reconcile(line.id, receive)).rejects.toThrow(/is in USD\. Type the exchange rate \(NZD per 1 USD\)/);
    const gstBefore = await run((tx) => calculateGstReturn(tx, { periodStart: "2026-07-01", periodEnd: "2026-07-31" }));
    const done = await reconcile(line.id, { ...receive, exchangeRate: "1.6543" });
    expect(done.line.status).toBe("reconciled");
    expect(done.line.baseAmount).toBe("1654.30");
    const journalId = journalOf(done.line);
    expect(await posted(journalId)).toEqual([
      ["4000", "0.00", "1654.30"],
      ["1030", "1654.30", "0.00"],
    ]);
    expect(await foreignOf(journalId, "1030")).toEqual({ currencyCode: "USD", amount: "1000.00", rate: "1.6543", kind: "rate" });
    const transaction = await run(async (tx) =>
      getBankTransaction(tx, (await tx.query<{ id: string }>("select id::text from bank_transactions where journal_id = $1", [journalId])).rows[0].id),
    );
    expect(transaction).toMatchObject({ currencyCode: "USD", total: "1000.00", exchangeRate: "1.6543", baseTotal: "1654.30" });
    const gst = await run((tx) => calculateGstReturn(tx, { periodStart: "2026-07-01", periodEnd: "2026-07-31" }));
    expect(toFixedString(sub(dec(gst.boxes.box5), dec(gstBefore.boxes.box5)), 2)).toBe("1654.30");
    expect(toFixedString(sub(dec(gst.boxes.box6), dec(gstBefore.boxes.box6)), 2)).toBe("1654.30");
    expect(await balances()).toEqual(["2000.00", "3254.30"]);
  });

  it("FXB3: the next line shows the last USD rate; spend USD 50.00 at 1.66 is NZD 83.00", async () => {
    const line = await lineOn(usd.id, "2026-07-05", "-50.00");
    expect(line.suggestedRate).toEqual({ rate: "1.6543", date: "2026-07-03", source: "posted" });
    expect(line.baseAmount).toBe("-82.72");
    const done = await reconcile(line.id, {
      kind: "bank_transaction",
      contactId: aws.id,
      amountsMode: "no_tax",
      exchangeRate: "1.66",
      lines: [{ description: "Hosting", accountCode: "6040", amount: "50.00" }],
    });
    expect(await posted(journalOf(done.line))).toEqual([
      ["6040", "83.00", "0.00"],
      ["1030", "0.00", "83.00"],
    ]);
    expect(await foreignOf(journalOf(done.line), "1030")).toEqual({ currencyCode: "USD", amount: "50.00", rate: "1.66", kind: "rate" });
    expect(await balances()).toEqual(["1950.00", "3171.30"]);
    expect((await lineOn(usd.id, "2026-07-10", "-500.00")).suggestedRate?.rate).toBe("1.66");
  });

  it("FXB4: no standard-rated GST in a foreign currency; split lines must add up after rounding", async () => {
    const spend = (fields: Record<string, unknown>, accountId = usd.id) =>
      run((tx) =>
        createBankTransaction(tx, {
          idempotencyKey: key("spend"),
          kind: "spend",
          accountId,
          contactId: aws.id,
          date: "2026-07-05",
          amountsMode: "inclusive",
          exchangeRate: "1.66",
          lines: [{ description: "Hosting", accountCode: "6040", taxCode: "GST", amount: "50.00" }],
          ...fields,
        }),
      );
    await expect(spend({})).rejects.toThrow(
      "Line 1: GST on foreign-currency spend and receive money isn't supported yet. Use zero-rated (ZERO), exempt (EXEMPT) or no GST (NONE), or record it in NZD.",
    );
    await expect(
      spend({
        amountsMode: "no_tax",
        exchangeRate: "1.5",
        lines: [
          { description: "A", accountCode: "6040", amount: "10.01" },
          { description: "B", accountCode: "6040", amount: "10.01" },
        ],
      }),
    ).rejects.toThrow(/the lines come to NZD 30\.04 but the total is NZD 30\.03 \(USD 20\.02 x 1\.5\)/);
    await expect(spend({ amountsMode: "no_tax", exchangeRate: "0", lines: [{ description: "A", accountCode: "6040", amount: "1.00" }] })).rejects.toThrow(
      /must not be zero/,
    );
    await expect(
      spend({ amountsMode: "no_tax", exchangeRate: "1.123456789", lines: [{ description: "A", accountCode: "6040", amount: "1.00" }] }),
    ).rejects.toThrow(/at most 8 decimal places/);
    await expect(spend({ amountsMode: "no_tax", lines: [{ description: "A", accountCode: "6040", amount: "1.00" }] }, nzd.id)).rejects.toThrow(
      /is in NZD, so a bank transaction on it has no exchange rate/,
    );
    // Two lines that do add up are allowed (then voided, so the balances below don't change).
    const split = await spend({
      amountsMode: "no_tax",
      lines: [
        { description: "A", accountCode: "6040", amount: "30.00" },
        { description: "B", accountCode: "6040", amount: "20.00" },
      ],
    });
    expect(await posted(split.bankTransaction.journalId)).toEqual([
      ["6040", "49.80", "0.00"],
      ["6040", "33.20", "0.00"],
      ["1030", "0.00", "83.00"],
    ]);
    await run((tx) => voidBankTransaction(tx, split.bankTransaction.id, { idempotencyKey: key("void"), voidDate: "2026-07-05" }));
    expect(await balances()).toEqual(["1950.00", "3171.30"]);
  });

  it("FXB5: transfer USD 500.00 out, NZD 820.00 received: carrying value 813.15, gain 6.85 to 7020", async () => {
    const line = await lineOn(usd.id, "2026-07-10", "-500.00");
    await expect(reconcile(line.id, { kind: "transfer", otherAccountCode: "1000" })).rejects.toThrow(
      "Give the NZD amount that arrived in 1000 for this USD 500.00.",
    );
    await expect(
      run((tx) => createTransfer(tx, { idempotencyKey: key("t"), fromAccountCode: "1030", toAccountCode: "1000", date: "2026-07-10", amount: "1950.01", toAmount: "3000" })),
    ).rejects.toThrow("Account 1030 holds USD 1950.00, so USD 1950.01 can't be transferred out of it.");
    await expect(
      run((tx) => createTransfer(tx, { idempotencyKey: key("t"), fromAccountCode: "1030", toAccountCode: "1040", date: "2026-07-10", amount: "10", toAmount: "10" })),
    ).rejects.toThrow(/Transfers between two foreign-currency accounts .* aren't supported yet/);
    const done = await reconcile(line.id, { kind: "transfer", otherAccountCode: "1000", otherAmount: "820.00" });
    const journalId = journalOf(done.line);
    expect(await posted(journalId)).toEqual([
      ["1000", "820.00", "0.00"],
      ["1030", "0.00", "813.15"],
      ["7020", "0.00", "6.85"],
    ]);
    expect(await foreignOf(journalId, "1030")).toMatchObject({ amount: "500.00", kind: "carrying_value" });
    expect(await balances()).toEqual(["1450.00", "2358.15"]);
    // The NZD account's own line matches the transfer's NZD journal line.
    const nzdLine = await lineOn(nzd.id, "2026-07-10", "820.00");
    const confident = (await run((tx) => confidentMatches(tx, nzd.id))).find((entry) => entry.lineId === nzdLine.id)!;
    expect(confident.suggestion).toMatchObject({ kind: "match", journalId });
    await run((tx) => okStatementLine(tx, nzdLine.id, { idempotencyKey: key("ok"), expect: confident.suggestion!.key }));
  });

  it("FXB6: transfer NZD 1,000.00 into the USD account as USD 610.00; the USD line then matches it", async () => {
    const nzdLine = await lineOn(nzd.id, "2026-07-20", "-1000.00");
    const done = await reconcile(nzdLine.id, { kind: "transfer", otherAccountCode: "1030", otherAmount: "610.00" });
    const journalId = journalOf(done.line);
    expect(await posted(journalId)).toEqual([
      ["1030", "1000.00", "0.00"],
      ["1000", "0.00", "1000.00"],
    ]);
    expect(await foreignOf(journalId, "1030")).toEqual({ currencyCode: "USD", amount: "610.00", rate: "1.63934426", kind: "implied" });
    const usdLine = await lineOn(usd.id, "2026-07-20", "610.00");
    const confident = (await run((tx) => confidentMatches(tx, usd.id))).find((entry) => entry.lineId === usdLine.id)!;
    expect(confident.suggestion).toMatchObject({ kind: "match", journalId, amount: "610.00" });
    const matched = await run((tx) => okStatementLine(tx, usdLine.id, { idempotencyKey: key("ok"), expect: confident.suggestion!.key }));
    expect(matched.line.reconciliation!.items).toEqual([expect.objectContaining({ amount: "610.00", baseAmount: "1000.00" })]);
    expect(matched.line.baseAmount).toBe("1000.00");
    expect(await balances()).toEqual(["2060.00", "3358.15"]);
    await expect(
      run((tx) =>
        createBankTransaction(tx, {
          idempotencyKey: key("late"),
          kind: "spend",
          accountId: usd.id,
          contactId: aws.id,
          date: "2026-07-09",
          amountsMode: "no_tax",
          exchangeRate: "1.66",
          lines: [{ description: "Late", accountCode: "6040", amount: "1.00" }],
        }),
      ),
    ).rejects.toThrow(/had money transferred out on 2026-07-10, at its carrying value; nothing can be posted to it dated before then/);
  });

  it("FXB7: revaluation uses the ledger's USD 2,060.00; the reconciliation report is in USD", async () => {
    const revalue = (balance: Record<string, unknown>) =>
      run((tx) =>
        postFxRevaluation(tx, {
          idempotencyKey: key("fx"),
          reference: "FX-2026-07",
          revaluationDate: "2026-07-31",
          reversalPostingDate: "2026-08-01",
          rateDate: "2026-07-31",
          rateSource: "RBNZ",
          unrealisedGainAccountCode: "7000",
          unrealisedLossAccountCode: "7010",
          balances: [{ accountCode: "1030", closingRate: "1.64", ...balance }],
        }),
      );
    await expect(revalue({ foreignAmount: "2000.00" })).rejects.toThrow(
      "Account 1030: the ledger has USD 2060.00 on 2026-07-31, not 2000.00. Leave the foreign amount blank to use the ledger's.",
    );
    const { run: revaluation } = await revalue({});
    expect(revaluation.items[0]).toMatchObject({ foreignAmount: "2060.00", carryingAmount: "3358.15", revaluedAmount: "3378.40", deltaAmount: "20.25" });
    expect(await posted(revaluation.revaluationJournalId)).toEqual([
      ["1030", "20.25", "0.00"],
      ["7000", "0.00", "20.25"],
    ]);
    expect(await foreignOf(revaluation.revaluationJournalId, "1030")).toEqual({ currencyCode: "USD", amount: "0.00", rate: "1.64", kind: "revaluation" });
    expect(await foreignOf(revaluation.reversalJournalId, "1030")).toEqual({ currencyCode: "USD", amount: "0.00", rate: "1.64", kind: "revaluation" });

    const report = await run((tx) => bankReconciliationReport(tx, { accountId: usd.id, asAt: "2026-07-31" }));
    expect(report).toMatchObject({
      currencyCode: "USD",
      ledgerBalance: "2060.00",
      baseLedgerBalance: "3378.40",
      statementBalance: "2060.00",
      explained: true,
    });
    expect(report.bankNotInTohyee.items).toEqual([]);
    expect(report.tohyeeNotInBank.items).toEqual([]);
    expect((await lineOn(usd.id, "2026-08-05", "-2060.00")).suggestedRate).toEqual({ rate: "1.64", date: "2026-07-31", source: "revaluation" });
  });

  it("FXB8: transfer everything left: the whole NZD 3,358.15 leaves; gain 41.85 (a loss when less arrives)", async () => {
    const loss = await run((tx) =>
      createTransfer(tx, { idempotencyKey: key("t"), fromAccountCode: "1030", toAccountCode: "1000", date: "2026-08-05", amount: "2060.00", toAmount: "3300.00" }),
    );
    expect(await posted(loss.transfer.journalId)).toEqual([
      ["1000", "3300.00", "0.00"],
      ["1030", "0.00", "3358.15"],
      ["7020", "58.15", "0.00"],
    ]);
    expect(loss.transfer).toMatchObject({ amount: "2060.00", currencyCode: "USD", toAmount: "3300.00", toCurrencyCode: "NZD", carryingAmount: "3358.15", realisedGain: "-58.15" });
    await run((tx) => voidTransfer(tx, loss.transfer.id, { idempotencyKey: key("void"), voidDate: "2026-08-05" }));
    expect(await balances()).toEqual(["2060.00", "3358.15"]);

    const line = await lineOn(usd.id, "2026-08-05", "-2060.00");
    const done = await reconcile(line.id, { kind: "transfer", otherAccountCode: "1000", otherAmount: "3400.00" });
    expect(await posted(journalOf(done.line))).toEqual([
      ["1000", "3400.00", "0.00"],
      ["1030", "0.00", "3358.15"],
      ["7020", "0.00", "41.85"],
    ]);
    expect(await balances()).toEqual(["0.00", "0.00"]);
  });

  it("FXB11: after FXB1-FXB8 the trial balance still balances in NZD", async () => {
    const tb = await run((tx) => trialBalance(tx, { asAt: "2026-08-31" }));
    expect(tb.balanced).toBe(true);
    const row = (code: string) => tb.rows.find((entry) => entry.code === code);
    expect(row("1030")).toBeUndefined();
    expect(row("7020")).toMatchObject({ debit: "0.00", credit: "48.70" });
    expect(row("7000")).toBeUndefined();
    // 1,654.30 from FXB2 plus INV-0001's 100.00.
    expect(row("4000")).toMatchObject({ credit: "1754.30" });
    expect(row("6040")).toMatchObject({ debit: "83.00" });
  });

  it("FXB9: NZD invoices can't be paid from a USD line; voiding keeps the foreign amount", async () => {
    await run((tx) =>
      importStatementFile(tx, usd.id, { idempotencyKey: key("import"), fileName: "more.csv", fileBase64: b64("Date,Amount,Payee\n06/08/2026,115.00,KOBE LTD\n") }),
    );
    const line = await lineOn(usd.id, "2026-08-06", "115.00");
    await expect(reconcile(line.id, { kind: "payments", allocations: [{ invoiceId, amount: "115.00" }] })).rejects.toThrow(
      /Invoices and bills are in NZD, so they can't be paid from a USD statement line yet/,
    );
    expect((await run((tx) => confidentMatches(tx, usd.id))).find((entry) => entry.lineId === line.id)!.suggestion).toBeNull();
    await expect(
      reconcile(line.id, { kind: "match", journalLineIds: ["1"], adjustment: { accountCode: "6020", contactId: kobe.id } }),
    ).rejects.toThrow(/Adjustments aren't available on USD statement lines yet/);

    const spendLine = await lineOn(usd.id, "2026-07-05", "-50.00");
    const transactionId = (
      await run((tx) => tx.query<{ id: string }>("select id::text from bank_transactions where journal_id = $1", [journalOf(spendLine)]))
    ).rows[0].id;
    await run((tx) => unreconcileStatementLine(tx, spendLine.id, { idempotencyKey: key("un") }));
    const voided = await run((tx) => voidBankTransaction(tx, transactionId, { idempotencyKey: key("void"), voidDate: "2026-08-06" }));
    expect(await posted(voided.bankTransaction.voidJournalId!)).toEqual([
      ["6040", "0.00", "83.00"],
      ["1030", "83.00", "0.00"],
    ]);
    expect(await foreignOf(voided.bankTransaction.voidJournalId!, "1030")).toEqual({ currencyCode: "USD", amount: "50.00", rate: "1.66", kind: "rate" });
    expect(await balances()).toEqual(["50.00", "83.00"]);
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { Actor } from "@/lib/db/org-transaction";
import { correctJournal, getJournalDetails, listJournals, postJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { add, dec, sub, toFixedString } from "@/lib/money/decimal";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { balanceSheet, profitAndLoss, trialBalance } from "@/lib/reports/financial";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "ledger-co";

function journal(date: string, amount: string, idempotencyKey = key("j"), extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey,
    postingDate: date,
    reference: `INV-${idempotencyKey.slice(-4)}`,
    lines: [
      { accountCode: "1000", debitAmount: amount },
      { accountCode: "4000", creditAmount: amount },
    ],
    ...extra,
  };
}

describeWithDatabase("ledger", () => {
  let server: TestServer;
  let owner: SessionUser;
  let actor: Actor;
  const inOrg = <T>(work: Parameters<typeof inOrganisation<T>>[2]) => inOrganisation(ORG, actor, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("books@example.com", { serverAdmin: true });
    actor = { userId: owner.id, email: owner.email };
    await createTestOrganisation(owner, ORG);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("R2: posts a balanced journal against real accounts, stored in cents", async () => {
    const result = await inOrg((tx) => postJournal(tx, journal("2026-06-15", "115.00")));
    expect(result.created).toBe(true);
    expect(result.journal.postingDate).toBe("2026-06-15");
    expect(result.journal.currencyCode).toBe("NZD");
    expect(result.journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1000", "115.00", "0.00"],
      ["4000", "0.00", "115.00"],
    ]);
    expect(result.journal.createdByEmail).toBe(owner.email);
  });

  it("R2/R4/R5: refuses unbalanced journals, unknown accounts, sub-cent amounts and other currencies", async () => {
    await expect(
      inOrg((tx) =>
        postJournal(tx, {
          ...journal("2026-06-15", "10"),
          lines: [
            { accountCode: "1000", debitAmount: "10" },
            { accountCode: "4000", creditAmount: "9.99" },
          ],
        }),
      ),
    ).rejects.toThrow(/doesn't balance/);
    await expect(
      inOrg((tx) =>
        postJournal(tx, {
          ...journal("2026-06-15", "10"),
          lines: [
            { accountCode: "9999", debitAmount: "10" },
            { accountCode: "4000", creditAmount: "10" },
          ],
        }),
      ),
    ).rejects.toThrow(/no account with the code 9999/);
    await expect(inOrg((tx) => postJournal(tx, journal("2026-06-15", "3.333")))).rejects.toThrow(
      /at most 2 decimal places/,
    );
    await expect(
      inOrg((tx) => postJournal(tx, journal("2026-06-15", "10", key(), { currencyCode: "USD" }))),
    ).rejects.toThrow(/base currency \(NZD\)/);
  });

  it("R4: the database itself refuses an unbalanced journal and edits to posted history", async () => {
    await expect(
      inOrg(async (tx) => {
        const header = await tx.query<{ id: string }>(
          `insert into ledger_journals (command_source, idempotency_key, request_hash, posting_date, reference, currency_code, total_debit, total_credit)
           values ('sql', 'raw-1', 'h', '2026-06-01', 'RAW', 'NZD', 10, 10) returning id`,
        );
        const account = await tx.query<{ id: string }>("select id from accounts where code = '1000'");
        await tx.query(
          "insert into ledger_journal_lines (journal_id, line_order, account_id, debit_amount) values ($1, 1, $2, 10)",
          [header.rows[0].id, account.rows[0].id],
        );
      }),
    ).rejects.toThrow(/needs at least two lines|does not balance/);

    await expect(inOrg((tx) => tx.query("update ledger_journals set reference = 'changed'"))).rejects.toThrow(
      /append-only/,
    );
    await expect(inOrg((tx) => tx.query("delete from ledger_journal_lines"))).rejects.toThrow(/append-only/);
  });

  it("every posted-history table has triggers refusing UPDATE, DELETE and TRUNCATE", async () => {
    const UPDATE_DELETE_TRUNCATE = 8 | 16 | 32; // pg_trigger.tgtype bits
    const covered = await inOrg((tx) =>
      tx.query<{ table_name: string; events: number }>(
        `select c.relname as table_name, bit_or(t.tgtype::int & $1) as events
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid
          where not t.tgisinternal and p.proname = 'toeyee_forbid_mutation'
          group by c.relname
          order by c.relname`,
        [UPDATE_DELETE_TRUNCATE],
      ),
    );
    expect(covered.rows.map((row) => [row.table_name, row.events])).toEqual(
      [
        "audit_events",
        "conversion_balance_lines",
        "conversion_balances",
        "inventory_movements",
        "ledger_foreign_opening_balances",
        "ledger_fx_revaluation_run_items",
        "ledger_fx_revaluation_runs",
        "ledger_journal_lines",
        "ledger_journals",
        "stock_transfers",
      ].map((table) => [table, UPDATE_DELETE_TRUNCATE]),
    );
    await expect(inOrg((tx) => tx.query("truncate audit_events"))).rejects.toThrow(/append-only/);
  });

  it("D1/D2: an identical retry returns the original journal; reusing a key for something else is refused", async () => {
    const command = journal("2026-06-16", "20");
    const first = await inOrg((tx) => postJournal(tx, command));
    const retry = await inOrg((tx) => postJournal(tx, command));
    expect(retry.created).toBe(false);
    expect(retry.journal.id).toBe(first.journal.id);

    await expect(
      inOrg((tx) => postJournal(tx, { ...command, reference: "SOMETHING-ELSE" })),
    ).rejects.toThrow(/already used for a different journal/);
  });

  it("L1-L4: lock dates block on/before the lock, allow after it, and reopening moves the lock back", async () => {
    await inOrg((tx) => updatePeriodControls(tx, { lockDate: "2026-03-31" }));

    // Regression: an earlier version rejected every date once any lock was set.
    const after = await inOrg((tx) => postJournal(tx, journal("2026-04-01", "5")));
    expect(after.created).toBe(true);
    await expect(inOrg((tx) => postJournal(tx, journal("2026-03-31", "5")))).rejects.toThrow(/locked period/);
    await expect(inOrg((tx) => postJournal(tx, journal("2026-02-10", "5")))).rejects.toThrow(/locked period/);

    // L3: reopening February (with a reason) moves the lock to 31 Jan, so
    // March reopens too; moving the lock back without a reason is refused.
    await expect(inOrg((tx) => updatePeriodControls(tx, { lockDate: "2026-01-31" }))).rejects.toThrow(/reason/);
    await inOrg((tx) => updatePeriodControls(tx, { lockDate: "2026-01-31", reason: "Late February invoice" }));
    const reopened = await inOrg((tx) => postJournal(tx, journal("2026-02-10", "5")));
    expect(reopened.created).toBe(true);
    await expect(inOrg((tx) => postJournal(tx, journal("2026-01-15", "5")))).rejects.toThrow(/locked period/);

    // A retry of something already posted still succeeds after the period locks.
    const retryKey = key("late-retry");
    await inOrg((tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
    await inOrg((tx) => postJournal(tx, journal("2026-01-20", "7", retryKey)));
    await inOrg((tx) => updatePeriodControls(tx, { lockDate: "2026-03-31" }));
    const lateRetry = await inOrg((tx) => postJournal(tx, journal("2026-01-20", "7", retryKey)));
    expect(lateRetry.created).toBe(false);
    await inOrg((tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
  });

  it("C1-C4: corrections reverse and replace, can be chained, and can't be repeated", async () => {
    const original = await inOrg((tx) => postJournal(tx, journal("2026-07-01", "100")));
    const correctionKey = key("fix");
    const correction = await inOrg((tx) =>
      correctJournal(tx, {
        idempotencyKey: correctionKey,
        originalJournalId: original.journal.id,
        postingDate: "2026-07-02",
        reference: "INV-FIXED",
        lines: [
          { accountCode: "1000", debitAmount: "125" },
          { accountCode: "4000", creditAmount: "125" },
        ],
      }),
    );
    // C1: the reversal undoes the original exactly, the replacement posts the new amount, both on 2 Jul.
    const linesOf = (entry: { lines: Array<{ accountCode: string; debitAmount: string; creditAmount: string }> }) =>
      entry.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    expect(linesOf(correction.reversalJournal)).toEqual([
      ["1000", "0.00", "100.00"],
      ["4000", "100.00", "0.00"],
    ]);
    expect(linesOf(correction.replacementJournal)).toEqual([
      ["1000", "125.00", "0.00"],
      ["4000", "0.00", "125.00"],
    ]);
    expect([correction.reversalJournal.postingDate, correction.replacementJournal.postingDate]).toEqual([
      "2026-07-02",
      "2026-07-02",
    ]);

    // Correcting the same journal again is refused...
    await expect(
      inOrg((tx) =>
        correctJournal(tx, {
          idempotencyKey: key("fix-again"),
          originalJournalId: original.journal.id,
          postingDate: "2026-07-03",
          reference: "X",
          lines: [
            { accountCode: "1000", debitAmount: "1" },
            { accountCode: "4000", creditAmount: "1" },
          ],
        }),
      ),
    ).rejects.toThrow(/already been corrected/);

    // ...but retrying the same correction is fine,
    const retry = await inOrg((tx) =>
      correctJournal(tx, {
        idempotencyKey: correctionKey,
        originalJournalId: original.journal.id,
        postingDate: "2026-07-02",
        reference: "INV-FIXED",
        lines: [
          { accountCode: "1000", debitAmount: "125" },
          { accountCode: "4000", creditAmount: "125" },
        ],
      }),
    );
    expect(retry.created).toBe(false);
    expect([retry.reversalJournal.id, retry.replacementJournal.id]).toEqual([
      correction.reversalJournal.id,
      correction.replacementJournal.id,
    ]);

    // ...and the replacement itself can be corrected later.
    const second = await inOrg((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("fix-2"),
        originalJournalId: correction.replacementJournal.id,
        postingDate: "2026-07-03",
        reference: "INV-FIXED-2",
        lines: [
          { accountCode: "1000", debitAmount: "120" },
          { accountCode: "4000", creditAmount: "120" },
        ],
      }),
    );
    expect(second.replacementJournal.totalDebit).toBe("120.00");

    const details = await inOrg((tx) => getJournalDetails(tx, original.journal.id));
    expect(details.canCorrect).toBe(false);
    // The original itself is untouched.
    expect(linesOf(details.journal)).toEqual(linesOf(original.journal));
    expect(details.journal.postingDate).toBe("2026-07-01");
    expect(details.correctionJournals.map((entry) => entry.correctionKind).sort()).toEqual(["replacement", "reversal"]);
  });

  it("C5/C7: a reversal can't be corrected, and corrections must use an open period", async () => {
    const original = await inOrg((tx) => postJournal(tx, journal("2026-07-10", "40")));
    const correction = await inOrg((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("fix-c5"),
        originalJournalId: original.journal.id,
        postingDate: "2026-07-11",
        reference: "C5",
        lines: [
          { accountCode: "1000", debitAmount: "41" },
          { accountCode: "4000", creditAmount: "41" },
        ],
      }),
    );
    await expect(
      inOrg((tx) =>
        correctJournal(tx, {
          idempotencyKey: key("fix-reversal"),
          originalJournalId: correction.reversalJournal.id,
          postingDate: "2026-07-12",
          reference: "NOPE",
          lines: [
            { accountCode: "1000", debitAmount: "1" },
            { accountCode: "4000", creditAmount: "1" },
          ],
        }),
      ),
    ).rejects.toThrow(/reversal can't itself be corrected/);

    await inOrg((tx) => updatePeriodControls(tx, { lockDate: "2026-07-31" }));
    await expect(
      inOrg((tx) =>
        correctJournal(tx, {
          idempotencyKey: key("fix-locked"),
          originalJournalId: correction.replacementJournal.id,
          postingDate: "2026-07-15",
          reference: "LOCKED",
          lines: [
            { accountCode: "1000", debitAmount: "42" },
            { accountCode: "4000", creditAmount: "42" },
          ],
        }),
      ),
    ).rejects.toThrow(/locked period/);
    await inOrg((tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test set-up" }));
  });

  it("lists journals newest first with paging", async () => {
    const page = await inOrg((tx) => listJournals(tx, { limit: 2 }));
    expect(page.journals).toHaveLength(2);
    expect(page.nextBeforeId).not.toBeNull();
    const next = await inOrg((tx) => listJournals(tx, { limit: 2, beforeId: page.nextBeforeId }));
    expect(Number(next.journals[0].id)).toBeLessThan(Number(page.journals[1].id));
  });

  it("P1-P3: reports balance, and earnings split at the start of the financial year", async () => {
    // Costs and other income this financial year, so every P&L line is used.
    await inOrg((tx) =>
      postJournal(tx, {
        idempotencyKey: key("costs"),
        postingDate: "2026-08-01",
        reference: "COSTS",
        lines: [
          { accountCode: "5000", debitAmount: "30.00" },
          { accountCode: "6020", debitAmount: "5.00" },
          { accountCode: "4200", creditAmount: "2.00" },
          { accountCode: "1000", creditAmount: "33.00" },
        ],
      }),
    );

    // P1
    const tb = await inOrg((tx) => trialBalance(tx, { asAt: "2026-12-31" }));
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    // P3: without a "from" date the P&L covers the financial year to date
    // (the default year end is 31 March).
    const pnl = await inOrg((tx) => profitAndLoss(tx, { to: "2026-12-31" }));
    expect(pnl.from).toBe("2026-04-01");
    expect([pnl.costOfSales.total, pnl.otherIncome.total, pnl.expenses.total]).toEqual(["30.00", "2.00", "5.00"]);
    expect(pnl.grossProfit).toBe(toFixedString(sub(dec(pnl.revenue.total), dec("30.00")), 2));
    expect(pnl.netProfit).toBe(toFixedString(sub(add(dec(pnl.grossProfit), dec("2.00")), dec("5.00")), 2));

    // P2: assets = liabilities + equity + earnings from previous years + current year earnings.
    const bs = await inOrg((tx) => balanceSheet(tx, { asAt: "2026-12-31" }));
    expect(bs.balanced).toBe(true);
    expect(bs.financialYearStart).toBe("2026-04-01");
    expect(bs.equity.currentYearEarnings).toBe(pnl.netProfit);
    // Before 1 April: the 20 Jan (7.00) and 10 Feb (5.00) journals.
    expect(bs.equity.previousYearsEarnings).toBe("12.00");
    // Everything posted is bank against income or costs, so total earnings equal the bank balance.
    const bank = tb.rows.find((row) => row.code === "1000")!;
    expect(toFixedString(add(dec(bs.equity.previousYearsEarnings), dec(bs.equity.currentYearEarnings)), 2)).toBe(
      bank.debit,
    );

    // A December year end makes the financial year the calendar year.
    await inOrg((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 12 }));
    const calendar = await inOrg((tx) => balanceSheet(tx, { asAt: "2026-12-31" }));
    expect(calendar.financialYearStart).toBe("2026-01-01");
    expect(calendar.equity.previousYearsEarnings).toBe("0.00");
    expect(calendar.balanced).toBe(true);
    await expect(inOrg((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 13 }))).rejects.toThrow(
      /month number from 1 to 12/,
    );
    await inOrg((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 3 }));
  });
});

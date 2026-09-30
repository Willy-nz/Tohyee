import { getBankAccount } from "@/lib/bank/accounts";
import { businessTimeZone, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { add, dec, isZero, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Bank reconciliation report (examples BK20, BK21): for one bank or credit
 * card account as at a date, the bank's balance, Tohyee's balance, and the
 * items that explain the difference:
 *
 * - **In the bank, not in Tohyee**: statement lines dated on or before the
 *   date that aren't reconciled, and the parts of reconciled lines matched to
 *   journal lines dated after the date.
 * - **In Tohyee, not in the bank**: journal lines on the account dated on or
 *   before the date that aren't reconciled to a statement line dated on or
 *   before it (unpresented payments, deposits not yet cleared); for a
 *   journal line split across several statement lines (BK28), the part
 *   that's not on lines dated on or before the date. A journal
 *   and its reversal (a void), both dated on or before the date and neither
 *   reconciled, are left out, since they cancel out.
 *
 * Statement balance = Tohyee balance + in the bank not in Tohyee - in Tohyee
 * not in the bank. What's left over is shown as "not explained".
 *
 * The statement balance comes from the latest of:
 * - the running balance on the latest statement line (not deleted) dated on
 *   or before the date that has one (the last brought in on that day), taken
 *   as the balance at the end of that day; or
 * - the bank feed's balance (BK16), taken as the balance at the end of the
 *   New Zealand day it was fetched, when that's on or before the date;
 * plus the lines dated after it, up to the date (excluded and deleted lines
 * don't count). With neither, the statement balance isn't known. Excluded
 * lines are never counted, as they're duplicates or not the organisation's.
 */
export type StatementBalanceSource =
  | { kind: "line_balance"; date: string; balance: string; lineId: string; linesAfter: number; linesAfterTotal: string }
  | { kind: "feed_balance"; date: string; balance: string; linesAfter: number; linesAfterTotal: string };

export type BankNotInTohyeeItem = {
  lineId: string;
  date: string;
  description: string;
  reference: string | null;
  amount: string;
  /** Unreconciled, or reconciled to a journal line dated after the report date. */
  why: "unreconciled" | "matched_later";
  matchedJournalId: string | null;
  matchedDate: string | null;
};

export type TohyeeNotInBankItem = {
  journalLineId: string;
  journalId: string;
  date: string;
  origin: string;
  reference: string;
  description: string | null;
  amount: string;
  /** When it's reconciled to a statement line dated after the report date, that line's date. */
  reconciledOn: string | null;
};

export type BankReconciliationReport = {
  account: { id: string; code: string; name: string; accountType: "bank" | "credit_card" };
  asAt: string;
  currencyCode: string;
  statementBalance: string | null;
  statementBalanceSource: StatementBalanceSource | null;
  ledgerBalance: string;
  bankNotInTohyee: { items: BankNotInTohyeeItem[]; total: string };
  tohyeeNotInBank: { items: TohyeeNotInBankItem[]; total: string };
  /** Tohyee's balance + in the bank not in Tohyee - in Tohyee not in the bank. */
  expectedStatementBalance: string;
  /** Statement balance - expected; null when the statement balance isn't known. */
  notExplained: string | null;
  explained: boolean;
};

const money = (value: string) => toFixedString(dec(value), 2);
const total = (amounts: string[]) => money(toFixedString(amounts.reduce((sum, amount) => add(sum, dec(amount)), ZERO_DECIMAL), 2));

async function statementBalance(
  tx: OrgTx,
  accountId: string,
  asAt: string,
): Promise<{ balance: string | null; source: StatementBalanceSource | null }> {
  const lineBalance = (
    await tx.query<{ id: string; line_date: string; balance: string }>(
      `select id, line_date::text, balance::text from bank_statement_lines
        where account_id = $1 and status <> 'deleted' and balance is not null and line_date <= $2
        order by line_date desc, id desc limit 1`,
      [accountId, asAt],
    )
  ).rows[0];
  const feed = (
    await tx.query<{ balance: string; balance_date: string }>(
      `select statement_balance::text as balance, (statement_balance_at at time zone $3)::date::text as balance_date
         from bank_account_settings
        where account_id = $1 and statement_balance is not null and statement_balance_at is not null
          and (statement_balance_at at time zone $3)::date <= $2`,
      [accountId, asAt, businessTimeZone()],
    )
  ).rows[0];
  const anchor =
    lineBalance && (!feed || lineBalance.line_date >= feed.balance_date)
      ? { kind: "line_balance" as const, date: lineBalance.line_date, balance: money(lineBalance.balance), lineId: lineBalance.id }
      : feed
        ? { kind: "feed_balance" as const, date: feed.balance_date, balance: money(feed.balance) }
        : null;
  if (!anchor) return { balance: null, source: null };
  const after = (
    await tx.query<{ count: string; total: string }>(
      `select count(*)::text as count, coalesce(sum(amount), 0)::text as total from bank_statement_lines
        where account_id = $1 and status in ('unreconciled', 'reconciled') and line_date > $2 and line_date <= $3`,
      [accountId, anchor.date, asAt],
    )
  ).rows[0];
  const linesAfterTotal = money(after.total);
  return {
    balance: money(toFixedString(add(dec(anchor.balance), dec(linesAfterTotal)), 2)),
    source: { ...anchor, linesAfter: Number(after.count), linesAfterTotal },
  };
}

export async function bankReconciliationReport(
  tx: OrgTx,
  input: { accountId: unknown; asAt?: unknown },
): Promise<BankReconciliationReport> {
  const account = await getBankAccount(tx, input.accountId);
  const asAt = parseOptionalIsoDate(input.asAt, "asAt") ?? todayIsoDate();
  const ledger = (
    await tx.query<{ balance: string }>(
      `select coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as balance
         from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
        where l.account_id = $1 and j.posting_date <= $2`,
      [account.id, asAt],
    )
  ).rows[0];
  const unreconciled = await tx.query<{ id: string; line_date: string; description: string; reference: string | null; amount: string }>(
    `select id, line_date::text, description, reference, amount::text from bank_statement_lines
      where account_id = $1 and status = 'unreconciled' and line_date <= $2
      order by line_date, id`,
    [account.id, asAt],
  );
  const matchedLater = await tx.query<{
    id: string;
    line_date: string;
    description: string;
    reference: string | null;
    amount: string;
    journal_id: string;
    posting_date: string;
  }>(
    `select b.id, b.line_date::text, b.description, b.reference, i.amount::text, j.id as journal_id, j.posting_date::text
       from bank_statement_lines b
       join bank_reconciliations r on r.statement_line_id = b.id and r.status = 'active'
       join bank_reconciliation_items i on i.reconciliation_id = r.id
       join ledger_journal_lines l on l.id = i.journal_line_id
       join ledger_journals j on j.id = l.journal_id
      where b.account_id = $1 and b.status = 'reconciled' and b.line_date <= $2 and j.posting_date > $2
      order by b.line_date, b.id, l.id`,
    [account.id, asAt],
  );
  const bankItems: BankNotInTohyeeItem[] = [
    ...unreconciled.rows.map((row) => ({
      lineId: row.id,
      date: row.line_date,
      description: row.description,
      reference: row.reference,
      amount: money(row.amount),
      why: "unreconciled" as const,
      matchedJournalId: null,
      matchedDate: null,
    })),
    ...matchedLater.rows.map((row) => ({
      lineId: row.id,
      date: row.line_date,
      description: row.description,
      reference: row.reference,
      amount: money(row.amount),
      why: "matched_later" as const,
      matchedJournalId: row.journal_id,
      matchedDate: row.posting_date,
    })),
  ].sort((a, b) => (a.date === b.date ? Number(a.lineId) - Number(b.lineId) : a.date < b.date ? -1 : 1));
  const tohyee = await tx.query<{
    id: string;
    journal_id: string;
    posting_date: string;
    origin: string;
    reference: string;
    description: string | null;
    amount: string;
    reconciled_on: string | null;
    correction_kind: string | null;
    related_journal_id: string | null;
    journal_reconciled: boolean;
  }>(
    `select l.id, l.journal_id, j.posting_date::text, j.origin, j.reference, coalesce(l.description, j.description) as description,
            (l.debit_amount - l.credit_amount - rec.on_statement)::text as amount, rec.reconciled_on::text as reconciled_on,
            j.correction_kind, j.related_journal_id,
            exists (select 1 from bank_reconciliation_items ri join ledger_journal_lines rl on rl.id = ri.journal_line_id
                     where ri.active and rl.journal_id = j.id and rl.account_id = $1) as journal_reconciled
       from ledger_journal_lines l
       join ledger_journals j on j.id = l.journal_id
       cross join lateral (
         -- The part of the journal line on statement lines dated on or before
         -- the date (all of it, or for a split (BK28) some of it), and the
         -- latest date of a line after it that has the rest.
         select coalesce(sum(i.amount) filter (where b.line_date <= $2), 0) as on_statement,
                max(b.line_date) filter (where b.line_date > $2) as reconciled_on
           from bank_reconciliation_items i
           join bank_reconciliations r on r.id = i.reconciliation_id
           join bank_statement_lines b on b.id = r.statement_line_id
          where i.journal_line_id = l.id and i.active
       ) rec
      where l.account_id = $1 and j.posting_date <= $2 and l.debit_amount - l.credit_amount <> rec.on_statement
      order by j.posting_date, l.id`,
    [account.id, asAt],
  );
  // A voided payment or transaction and its reversal, both dated on or before
  // the date and neither reconciled, cancel out: leave both off the list.
  const byJournal = new Map<string, { amount: string; reconciled: boolean }>();
  for (const row of tohyee.rows) {
    const entry = byJournal.get(row.journal_id) ?? { amount: "0", reconciled: row.journal_reconciled };
    byJournal.set(row.journal_id, { amount: toFixedString(add(dec(entry.amount), dec(row.amount)), 2), reconciled: entry.reconciled });
  }
  const cancelled = new Set<string>();
  for (const row of tohyee.rows) {
    if (row.correction_kind !== "reversal" || !row.related_journal_id) continue;
    const reversal = byJournal.get(row.journal_id);
    const original = byJournal.get(row.related_journal_id);
    if (!reversal || !original || reversal.reconciled || original.reconciled) continue;
    if (isZero(add(dec(reversal.amount), dec(original.amount)))) {
      cancelled.add(row.journal_id);
      cancelled.add(row.related_journal_id);
    }
  }
  const tohyeeItems: TohyeeNotInBankItem[] = tohyee.rows.filter((row) => !cancelled.has(row.journal_id)).map((row) => ({
    journalLineId: row.id,
    journalId: row.journal_id,
    date: row.posting_date,
    origin: row.origin,
    reference: row.reference,
    description: row.description,
    amount: money(row.amount),
    reconciledOn: row.reconciled_on,
  }));
  const ledgerBalance = money(ledger.balance);
  const bankTotal = total(bankItems.map((item) => item.amount));
  const tohyeeTotal = total(tohyeeItems.map((item) => item.amount));
  const expected = money(toFixedString(sub(add(dec(ledgerBalance), dec(bankTotal)), dec(tohyeeTotal)), 2));
  const statement = await statementBalance(tx, account.id, asAt);
  const notExplained = statement.balance === null ? null : money(toFixedString(sub(dec(statement.balance), dec(expected)), 2));
  return {
    account: { id: account.id, code: account.code, name: account.name, accountType: account.accountType },
    asAt,
    currencyCode: tx.baseCurrency,
    statementBalance: statement.balance,
    statementBalanceSource: statement.source,
    ledgerBalance,
    bankNotInTohyee: { items: bankItems, total: bankTotal },
    tohyeeNotInBank: { items: tohyeeItems, total: tohyeeTotal },
    expectedStatementBalance: expected,
    notExplained,
    explained: notExplained !== null && isZero(dec(notExplained)),
  };
}

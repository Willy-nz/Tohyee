import type { AccountClass } from "@/lib/accounts/types";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { financialYearStart } from "@/lib/financial-year";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { financialYearEndMonth } from "@/lib/reports/financial";
import { dayBefore } from "@/lib/reports/ageing";
import { JOURNAL_SOURCES_SQL, type JournalSource, journalSource, SOURCE_COLUMNS, SOURCE_JOINS, type SourceRow } from "@/lib/reports/journal-sources";
import { parseTrackingFilter } from "@/lib/reports/tracking-filter";
import type { TrackingTags } from "@/lib/tracking/service";

export { parseTrackingFilter };
import type { CustomValues } from "@/lib/custom-fields/values";
import { optionalId } from "@/lib/validation";

/**
 * Account transactions (general ledger detail, examples ATX1-ATX6): for one
 * account, several or all of them, the balance before the period (for an
 * income or expense account only this financial year's, ATX6), every posted
 * journal line in it (with its date, source, description, contact, debit,
 * credit and running balance) and the balance at the end. Balances are
 * debits less credits (a credit balance is negative) over all postings
 * before the date. A balance sheet account's closing balance is its trial
 * balance line; an income or expense account's trial balance line is its
 * debits less credits from the first day of the financial year (TB2), and
 * retained earnings' is its closing balance plus earlier years' profit,
 * which is worked out and never posted, so it isn't a line here (as in
 * NetSuite's account registers). Voids and corrections are their own lines. With
 * a tracking filter only lines tagged with the value (or one under it)
 * count, opening balance included.
 */

export type AccountTransactionLine = {
  journalId: string;
  lineOrder: number;
  date: string;
  source: JournalSource;
  reference: string;
  description: string;
  debit: string;
  credit: string;
  /** Debits less credits so far, including the opening balance. */
  balance: string;
  tracking: TrackingTags;
  customFields: CustomValues;
  columnValues?: Record<string, string>;
};

export type AccountTransactionsAccount = {
  accountId: string;
  code: string;
  name: string;
  accountClass: AccountClass;
  opening: string;
  lines: AccountTransactionLine[];
  totalDebit: string;
  totalCredit: string;
  closing: string;
};

export type AccountTransactions = {
  from: string;
  to: string;
  /** The first day of `from`'s financial year: income and expense accounts open from here (ATX6). */
  financialYearStart: string;
  /** The range starts in one financial year and ends in a later one (ATX6). */
  crossesYearEnd: boolean;
  currencyCode: string;
  filter: { categoryId: string; valueId: string; label: string } | null;
  accounts: AccountTransactionsAccount[];
  totalDebit: string;
  totalCredit: string;
};

/** From and to dates: `to` defaults to today and `from` to the start of `to`'s financial year. */
export async function parseReportPeriod(tx: OrgTx, fromInput: unknown, toInput: unknown): Promise<{ from: string; to: string }> {
  const to = parseOptionalIsoDate(toInput, "to") ?? todayIsoDate();
  const from = fromInput == null || fromInput === "" ? financialYearStart(to, await financialYearEndMonth(tx)) : parseIsoDate(fromInput, "from");
  if (from > to) throw new ValidationError("The start date must be on or before the end date.");
  return { from, to };
}

/** Several accounts, as "12,15" or a list (a custom report's group total, decision 1356); null for none. */
function parseAccountIds(input: unknown): string[] | null {
  if (input == null || input === "") return null;
  const parts = Array.isArray(input) ? input : String(input).split(",");
  if (parts.length > 500) throw new ValidationError("Choose at most 500 accounts.");
  const ids = [...new Set(parts.map((part) => String(part).trim()))];
  for (const id of ids) if (!/^[1-9]\d{0,17}$/.test(id)) throw new ValidationError("accountIds must be account ids separated by commas.");
  return ids;
}

type LineRow = SourceRow & {
  journal_id: string;
  line_order: number;
  account_id: string;
  posting_date: string;
  origin: string;
  reference: string;
  correction_kind: string | null;
  journal_description: string | null;
  line_description: string | null;
  debit_amount: string;
  credit_amount: string;
  tracking: TrackingTags;
  custom_fields: CustomValues;
};

export async function accountTransactions(
  tx: OrgTx,
  input: { accountId?: unknown; accountIds?: unknown; from?: unknown; to?: unknown; trackingCategoryId?: unknown; trackingValueId?: unknown },
): Promise<AccountTransactions> {
  const { from, to } = await parseReportPeriod(tx, input.from, input.to);
  const accountId = optionalId(input.accountId, "accountId");
  const accountIds = parseAccountIds(input.accountIds);
  const yearEndMonth = await financialYearEndMonth(tx);
  const yearStart = financialYearStart(from, yearEndMonth);
  const filter = await parseTrackingFilter(tx, input.trackingCategoryId, input.trackingValueId);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);

  const accountRows = await tx.query<{ id: string; code: string; name: string; account_class: AccountClass }>(
    "select id::text, code, name, account_class from accounts where ($1::bigint is null or id = $1) and ($2::bigint[] is null or id = any($2::bigint[])) order by code",
    [accountId, accountIds],
  );
  if (accountId && accountRows.rows.length === 0) throw new NotFoundError("Account not found.");
  if (accountIds && accountRows.rows.length !== accountIds.length) throw new NotFoundError("One of those accounts wasn't found.");
  const openingTagged = `($2::text is null or ($5::boolean and l.tracking ->> $2::text is null) or (not $5::boolean and (l.tracking ->> $2::text) = any($3::text[])))`;
  const lineTagged = `($2::text is null or ($6::boolean and l.tracking ->> $2::text is null) or (not $6::boolean and (l.tracking ->> $2::text) = any($3::text[])))`;
  // Income and expense accounts open from the start of the financial year,
  // as on the trial balance (ATX6, TB2); balance sheet accounts from the start.
  const openingRows = await tx.query<{ account_id: string; balance: string }>(
    `select l.account_id::text, sum(l.debit_amount - l.credit_amount)::text as balance
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
       join accounts a on a.id = l.account_id
      where j.posting_date <= $1 and ${openingTagged} and ($4::bigint is null or l.account_id = $4)
        and ($6::bigint[] is null or l.account_id = any($6::bigint[]))
        and (a.account_class not in ('revenue', 'expense') or j.posting_date >= $7)
      group by l.account_id`,
    [dayBefore(from), filter?.categoryId ?? null, filter?.valueIds ?? [], accountId, filter?.valueId === "unassigned", accountIds, yearStart],
  );
  const lineRows = await tx.query<LineRow>(
    `with ${JOURNAL_SOURCES_SQL}
     select l.journal_id::text, l.line_order, l.account_id::text, j.posting_date, j.origin, j.reference, j.correction_kind,
            j.description as journal_description, l.description as line_description,
            l.debit_amount::text, l.credit_amount::text, l.tracking, l.custom_fields, ${SOURCE_COLUMNS}
       from ledger_journal_lines l
       join ledger_journals j on j.id = l.journal_id
       ${SOURCE_JOINS}
      where j.posting_date between $1 and $5 and ${lineTagged} and ($4::bigint is null or l.account_id = $4)
        and ($7::bigint[] is null or l.account_id = any($7::bigint[]))
      order by j.posting_date, j.id, l.line_order`,
    [from, filter?.categoryId ?? null, filter?.valueIds ?? [], accountId, to, filter?.valueId === "unassigned", accountIds],
  );

  const opening = new Map(openingRows.rows.map((row) => [row.account_id, dec(row.balance)]));
  const byAccount = new Map<string, LineRow[]>();
  for (const row of lineRows.rows) byAccount.set(row.account_id, [...(byAccount.get(row.account_id) ?? []), row]);

  const accounts: AccountTransactionsAccount[] = [];
  const allDebits: Decimal[] = [];
  const allCredits: Decimal[] = [];
  for (const account of accountRows.rows) {
    const rows = byAccount.get(account.id) ?? [];
    const start = opening.get(account.id) ?? ZERO_DECIMAL;
    // One account asked for is always shown; with all accounts, only those with a balance or lines.
    if (!accountId && !accountIds && rows.length === 0 && cmp(start, ZERO_DECIMAL) === 0) continue;
    let balance = start;
    const lines = rows.map((row): AccountTransactionLine => {
      balance = add(balance, sub(dec(row.debit_amount), dec(row.credit_amount)));
      const source = journalSource({ id: row.journal_id, origin: row.origin, reference: row.reference, correctionKind: row.correction_kind }, row);
      return {
        journalId: row.journal_id,
        lineOrder: row.line_order,
        date: row.posting_date,
        source,
        reference: row.reference,
        description: row.line_description ?? row.journal_description ?? row.reference,
        debit: money(dec(row.debit_amount)),
        credit: money(dec(row.credit_amount)),
        balance: money(balance),
        tracking: row.tracking ?? {},
        customFields: row.custom_fields ?? {},
      };
    });
    const debits = sum(rows.map((row) => dec(row.debit_amount)));
    const credits = sum(rows.map((row) => dec(row.credit_amount)));
    allDebits.push(debits);
    allCredits.push(credits);
    accounts.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      accountClass: account.account_class,
      opening: money(start),
      lines,
      totalDebit: money(debits),
      totalCredit: money(credits),
      closing: money(balance),
    });
  }
  return {
    from,
    to,
    financialYearStart: yearStart,
    crossesYearEnd: financialYearStart(to, yearEndMonth) !== yearStart,
    currencyCode: tx.baseCurrency,
    filter: filter ? { categoryId: filter.categoryId, valueId: filter.valueId, label: filter.label } : null,
    accounts,
    totalDebit: money(sum(allDebits)),
    totalCredit: money(sum(allCredits)),
  };
}

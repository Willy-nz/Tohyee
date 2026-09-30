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
import { type TrackingTags, valueWithDescendants } from "@/lib/tracking/service";
import { optionalId } from "@/lib/validation";

/**
 * Account transactions (general ledger detail, examples ATX1-ATX5): for one
 * account or all of them, the balance before the period, every posted
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
  currencyCode: string;
  filter: { categoryId: string; valueId: string; label: string } | null;
  accounts: AccountTransactionsAccount[];
  totalDebit: string;
  totalCredit: string;
};

/** A tracking filter from a category and value (the value and everything under it), or null. */
export async function parseTrackingFilter(
  tx: OrgTx,
  categoryInput: unknown,
  valueInput: unknown,
): Promise<{ categoryId: string; valueId: string; valueIds: string[]; label: string } | null> {
  const categoryId = optionalId(categoryInput, "trackingCategoryId");
  const valueId = optionalId(valueInput, "trackingValueId");
  if (!categoryId && !valueId) return null;
  if (!categoryId || !valueId) throw new ValidationError("Choose both a tracking category and a value to filter by.");
  const found = await tx.query<{ category: string; value: string }>(
    "select c.name as category, v.name as value from tracking_values v join tracking_categories c on c.id = v.category_id where v.id = $1 and c.id = $2",
    [valueId, categoryId],
  );
  if (!found.rows[0]) throw new ValidationError("That tracking value isn't in that category.");
  return { categoryId, valueId, valueIds: await valueWithDescendants(tx, valueId), label: `${found.rows[0].category}: ${found.rows[0].value}` };
}

/** From and to dates: `to` defaults to today and `from` to the start of `to`'s financial year. */
export async function parseReportPeriod(tx: OrgTx, fromInput: unknown, toInput: unknown): Promise<{ from: string; to: string }> {
  const to = parseOptionalIsoDate(toInput, "to") ?? todayIsoDate();
  const from = fromInput == null || fromInput === "" ? financialYearStart(to, await financialYearEndMonth(tx)) : parseIsoDate(fromInput, "from");
  if (from > to) throw new ValidationError("The start date must be on or before the end date.");
  return { from, to };
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
};

export async function accountTransactions(
  tx: OrgTx,
  input: { accountId?: unknown; from?: unknown; to?: unknown; trackingCategoryId?: unknown; trackingValueId?: unknown },
): Promise<AccountTransactions> {
  const { from, to } = await parseReportPeriod(tx, input.from, input.to);
  const accountId = optionalId(input.accountId, "accountId");
  const filter = await parseTrackingFilter(tx, input.trackingCategoryId, input.trackingValueId);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);

  const accountRows = await tx.query<{ id: string; code: string; name: string; account_class: AccountClass }>(
    "select id::text, code, name, account_class from accounts where ($1::bigint is null or id = $1) order by code",
    [accountId],
  );
  if (accountId && accountRows.rows.length === 0) throw new NotFoundError("Account not found.");
  const tagged = `($2::text is null or (l.tracking ->> $2::text) = any($3::text[]))`;
  const openingRows = await tx.query<{ account_id: string; balance: string }>(
    `select l.account_id::text, sum(l.debit_amount - l.credit_amount)::text as balance
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
      where j.posting_date <= $1 and ${tagged} and ($4::bigint is null or l.account_id = $4)
      group by l.account_id`,
    [dayBefore(from), filter?.categoryId ?? null, filter?.valueIds ?? [], accountId],
  );
  const lineRows = await tx.query<LineRow>(
    `with ${JOURNAL_SOURCES_SQL}
     select l.journal_id::text, l.line_order, l.account_id::text, j.posting_date, j.origin, j.reference, j.correction_kind,
            j.description as journal_description, l.description as line_description,
            l.debit_amount::text, l.credit_amount::text, l.tracking, ${SOURCE_COLUMNS}
       from ledger_journal_lines l
       join ledger_journals j on j.id = l.journal_id
       ${SOURCE_JOINS}
      where j.posting_date between $1 and $5 and ${tagged} and ($4::bigint is null or l.account_id = $4)
      order by j.posting_date, j.id, l.line_order`,
    [from, filter?.categoryId ?? null, filter?.valueIds ?? [], accountId, to],
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
    if (!accountId && rows.length === 0 && cmp(start, ZERO_DECIMAL) === 0) continue;
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
    currencyCode: tx.baseCurrency,
    filter: filter ? { categoryId: filter.categoryId, valueId: filter.valueId, label: filter.label } : null,
    accounts,
    totalDebit: money(sum(allDebits)),
    totalCredit: money(sum(allCredits)),
  };
}

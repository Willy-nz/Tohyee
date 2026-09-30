import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, isNegative, isPositive, isZero, mulDiv, parseDecimalInput, sub, toFixedString, toPlainString } from "@/lib/money/decimal";
import { optionalSource, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Foreign-currency accounts (examples FXB1-FXB11). Following NetSuite, every
 * journal line on a foreign-currency account posted since Tohyee kept
 * foreign amounts has the foreign amount beside the base amount, so an
 * account's foreign balance is its lines' foreign amounts (debits less
 * credits), plus its opening foreign balance when it had postings from
 * before (FXB1).
 */
export type ForeignOpeningBalance = {
  id: string;
  accountId: string;
  currencyCode: string;
  asAtDate: string;
  /** Signed like statement lines: money in the account positive, owed negative. */
  foreignBalance: string;
  baseBalance: string;
  createdByEmail: string | null;
  createdAt: string;
};

export type ForeignAccountState = {
  accountId: string;
  code: string;
  name: string;
  /** The account's currency when it isn't the base currency, otherwise null. */
  currencyCode: string | null;
  opening: ForeignOpeningBalance | null;
  /** Postings from before Tohyee kept foreign amounts, and no opening foreign balance yet. */
  needsOpeningBalance: boolean;
  /** The base-currency balance (debits less credits) as at the date. */
  baseBalance: string;
  /** The foreign balance as at the date, signed like statement lines; null when it isn't known. */
  foreignBalance: string | null;
};

type OpeningRow = {
  id: string;
  account_id: string;
  currency_code: string;
  as_at_date: string;
  foreign_balance: string;
  base_balance: string;
  created_by_email: string | null;
  created_at: string;
};

function toOpening(row: OpeningRow): ForeignOpeningBalance {
  const scale = currencyMinorUnits(row.currency_code);
  return {
    id: row.id,
    accountId: row.account_id,
    currencyCode: row.currency_code,
    asAtDate: row.as_at_date,
    foreignBalance: toFixedString(dec(row.foreign_balance), scale),
    baseBalance: toFixedString(dec(row.base_balance), 2),
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

const OPENING_SELECT = `select id::text, account_id::text, currency_code, as_at_date::text, foreign_balance::text, base_balance::text,
         created_by_email, created_at from ledger_foreign_opening_balances`;

/**
 * An account's foreign and base balances as at a date (today's when not
 * given). The foreign balance isn't known for an account that still needs
 * its opening foreign balance, or before that balance's date.
 */
export async function foreignAccountState(tx: OrgTx, accountId: string, asAt: string | null = null): Promise<ForeignAccountState> {
  const account = (
    await tx.query<{ id: string; code: string; name: string; currency_code: string | null }>(
      "select id::text, code, name, currency_code from accounts where id = $1",
      [accountId],
    )
  ).rows[0];
  if (!account) throw new NotFoundError("Account not found.");
  const currencyCode = account.currency_code && account.currency_code !== tx.baseCurrency ? account.currency_code : null;
  const totals = (
    await tx.query<{ base: string; foreign: string; base_only: boolean }>(
      `select coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as base,
              coalesce(sum(l.account_amount) filter (where l.foreign_amount is not null), 0)::text as foreign,
              exists (select 1 from ledger_journal_lines b where b.account_id = $1 and b.foreign_amount is null) as base_only
         from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
        where l.account_id = $1 and ($2::date is null or j.posting_date <= $2)`,
      [accountId, asAt],
    )
  ).rows[0];
  const baseBalance = toFixedString(dec(totals.base), currencyMinorUnits(tx.baseCurrency));
  if (!currencyCode) {
    return { accountId, code: account.code, name: account.name, currencyCode: null, opening: null, needsOpeningBalance: false, baseBalance, foreignBalance: null };
  }
  const openingRow = (await tx.query<OpeningRow>(`${OPENING_SELECT} where account_id = $1`, [accountId])).rows[0];
  const opening = openingRow ? toOpening(openingRow) : null;
  const scale = currencyMinorUnits(currencyCode);
  let foreignBalance: string | null = null;
  if (opening) {
    if (asAt === null || asAt >= opening.asAtDate) {
      foreignBalance = toFixedString(add(dec(opening.foreignBalance), dec(totals.foreign)), scale);
    }
  } else if (!totals.base_only) {
    foreignBalance = toFixedString(dec(totals.foreign), scale);
  }
  return {
    accountId,
    code: account.code,
    name: account.name,
    currencyCode,
    opening,
    needsOpeningBalance: !opening && totals.base_only,
    baseBalance,
    foreignBalance,
  };
}

export async function getForeignOpeningBalance(tx: OrgTx, accountId: string): Promise<ForeignOpeningBalance | null> {
  const row = (await tx.query<OpeningRow>(`${OPENING_SELECT} where account_id = $1`, [accountId])).rows[0];
  return row ? toOpening(row) : null;
}

/**
 * Enters a foreign-currency account's opening foreign balance (example FXB1):
 * once, as at a date on or after its last posting, for an account with
 * postings from before Tohyee kept foreign amounts. It records that the
 * account's base balance at that date is this foreign balance, and posts
 * nothing. The database checks it again and never lets it change.
 */
export async function recordForeignOpeningBalance(
  tx: OrgTx,
  accountIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; asAtDate: unknown; foreignBalance: unknown },
): Promise<{ created: boolean; openingBalance: ForeignOpeningBalance }> {
  const accountId = requireId(accountIdInput, "accountId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const asAtDate = parseIsoDate(input.asAtDate, "asAtDate");
  const raw = parseDecimalInput(input.foreignBalance, "foreignBalance", { maxScale: 4, allowNegative: true, allowZero: true });
  const hash = requestHash("foreign_opening_balance", { accountId, asAtDate, foreignBalance: raw });
  const earlier = await tx.query<OpeningRow & { request_hash: string }>(
    `${OPENING_SELECT.replace("from ledger_foreign_opening_balances", ", request_hash from ledger_foreign_opening_balances")}
      where command_source = $1 and idempotency_key = $2`,
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "opening foreign balance");
    return { created: false, openingBalance: toOpening(earlier.rows[0]) };
  }
  await tx.query("select id from accounts where id = $1 for update", [accountId]);
  const state = await foreignAccountState(tx, accountId);
  const label = `Account ${state.code} (${state.name})`;
  if (!state.currencyCode) {
    throw new ValidationError(`${label} is in ${tx.baseCurrency}, so it has no opening foreign balance.`);
  }
  if (state.opening) {
    throw new ValidationError(`${label} already has its opening foreign balance (${state.currencyCode} ${state.opening.foreignBalance} as at ${state.opening.asAtDate}). It can't be changed.`);
  }
  if (!state.needsOpeningBalance) {
    throw new ValidationError(
      `${label} has no postings from before Tohyee kept foreign amounts, so it doesn't need an opening foreign balance.`,
    );
  }
  const scale = currencyMinorUnits(state.currencyCode);
  const foreign = dec(raw);
  if (dec(toPlainString(foreign)).scale > scale) {
    throw new ValidationError(`The ${state.currencyCode} balance can have at most ${scale} decimal places.`);
  }
  const latest = (
    await tx.query<{ latest: string | null }>(
      `select max(j.posting_date)::text as latest from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
        where l.account_id = $1`,
      [accountId],
    )
  ).rows[0].latest;
  if (latest && asAtDate < latest) {
    throw new ValidationError(`${label} has postings up to ${latest}, so its opening foreign balance must be as at ${latest} or later.`);
  }
  const base = dec(state.baseBalance);
  const sameSign = (isZero(base) && isZero(foreign)) || (isPositive(base) && isPositive(foreign)) || (isNegative(base) && isNegative(foreign));
  if (!sameSign) {
    throw new ValidationError(
      `${label}'s balance is ${tx.baseCurrency} ${state.baseBalance}, so its ${state.currencyCode} balance must be ${
        isZero(base) ? "0" : isPositive(base) ? "more than 0 (money in the account)" : "less than 0 (owed)"
      }.`,
    );
  }
  const inserted = await tx.query<OpeningRow>(
    `insert into ledger_foreign_opening_balances (command_source, idempotency_key, request_hash, account_id, currency_code, as_at_date,
                                                  foreign_balance, base_balance, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, $10)
     returning id::text, account_id::text, currency_code, as_at_date::text, foreign_balance::text, base_balance::text, created_by_email, created_at`,
    [source, idempotencyKey, hash, accountId, state.currencyCode, asAtDate, toFixedString(foreign, scale), state.baseBalance, tx.actor.userId, tx.actor.email],
  );
  const openingBalance = toOpening(inserted.rows[0]);
  await writeAuditEvent(tx, {
    eventType: "account.foreign_opening_balance",
    entityType: "account",
    entityId: accountId,
    details: { asAtDate, currencyCode: state.currencyCode, foreignBalance: openingBalance.foreignBalance, baseBalance: openingBalance.baseBalance },
  });
  return { created: true, openingBalance };
}

export type RateUsed = {
  rate: string;
  date: string;
  /** Where it came from: a posted line converted at it, or a revaluation's closing rate. */
  source: "posted" | "revaluation";
};

/**
 * The rates used for each currency, newest first (D4): rates posted lines were
 * converted at ("rate" and "implied" lines, any account, and foreign-currency
 * invoices', bills' and credit notes' own rates, MC3), payments' rates and
 * revaluations' closing rates. Money leaving at its carrying value isn't a market rate and
 * isn't included.
 */
export async function ratesUsed(tx: OrgTx, currencies: readonly string[]): Promise<Map<string, RateUsed[]>> {
  const wanted = [...new Set(currencies)].filter((code) => code !== tx.baseCurrency);
  const byCurrency = new Map<string, RateUsed[]>(wanted.map((code) => [code, []]));
  if (wanted.length === 0) return byCurrency;
  const rows = await tx.query<{ currency_code: string; rate: string; rate_date: string; source: "posted" | "revaluation" }>(
    `select currency_code, rate, rate_date, source from (
       select l.foreign_currency_code as currency_code, l.exchange_rate::text as rate, j.posting_date::text as rate_date,
              'posted' as source, j.created_at, l.id as ord
         from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
        where l.foreign_currency_code = any($1::text[]) and l.fx_kind in ('rate', 'implied', 'document') and j.correction_kind is distinct from 'reversal'
       union all
       -- Payments of foreign-currency invoices and bills at their own rate (MC3), whichever bank account they used.
       select i.currency_code, p.exchange_rate::text, p.payment_date::text, 'posted', p.created_at, -p.id
         from customer_payments p join sales_invoices i on i.id = p.invoice_id
        where p.exchange_rate is not null and p.status = 'active' and i.currency_code = any($1::text[])
       union all
       select b.currency_code, p.exchange_rate::text, p.payment_date::text, 'posted', p.created_at, -p.id
         from supplier_payments p join bills b on b.id = p.bill_id
        where p.exchange_rate is not null and p.status = 'active' and b.currency_code = any($1::text[])
       union all
       select i.currency_code, i.closing_rate::text, i.revaluation_date::text, 'revaluation', r.created_at, i.id
         from ledger_fx_revaluation_run_items i join ledger_fx_revaluation_runs r on r.id = i.run_id
        where i.currency_code = any($1::text[])
     ) rates
     order by rate_date desc, created_at desc, ord desc`,
    [wanted],
  );
  for (const row of rows.rows) {
    byCurrency.get(row.currency_code)?.push({ rate: toPlainString(dec(row.rate)), date: row.rate_date, source: row.source });
  }
  return byCurrency;
}

/** The last rate used for a currency on or before a date (D4), from `ratesUsed`, or null. */
export function lastRateOnOrBefore(rates: readonly RateUsed[] | undefined, date: string): RateUsed | null {
  return (rates ?? []).find((entry) => entry.date <= date) ?? null;
}

export async function lastRateFor(tx: OrgTx, currency: string, date: string): Promise<RateUsed | null> {
  return lastRateOnOrBefore((await ratesUsed(tx, [currency])).get(currency), date);
}

export { convertAtRate, impliedRate } from "@/lib/money/fx";

/**
 * The base value of foreign money leaving an account at its carrying value
 * (FXB5, FXB8): base balance x amount / foreign balance, rounded once; all
 * that's left takes the whole base balance. Refused beyond the foreign balance.
 */
export function carryingValueOut(
  state: { baseBalance: string; foreignBalance: string; currencyCode: string; code: string },
  amount: string,
): string {
  const foreign = dec(state.foreignBalance);
  const out = dec(amount);
  if (!isPositive(foreign) || cmp(out, foreign) > 0) {
    throw new ValidationError(
      `Account ${state.code} holds ${state.currencyCode} ${state.foreignBalance}, so ${state.currencyCode} ${toFixedString(out, currencyMinorUnits(state.currencyCode))} can't be transferred out of it.`,
    );
  }
  if (cmp(out, foreign) === 0) return state.baseBalance;
  return toFixedString(mulDiv(dec(state.baseBalance), out, foreign, 2), 2);
}

/** Base amount less another, as a cents string (for gains and losses). */
export function difference(a: string, b: string): string {
  return toFixedString(sub(dec(a), dec(b)), 2);
}

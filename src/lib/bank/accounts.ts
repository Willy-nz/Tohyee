import { createHash } from "node:crypto";
import { createAccount } from "@/lib/accounts/service";
import { isBankOrCreditCard, type AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import type { ParsedStatementLine } from "@/lib/bank/formats/common";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { convertAtRate, foreignAccountState, type ForeignOpeningBalance, defaultRates, lastRateOnOrBefore, type RateUsed } from "@/lib/ledger/foreign";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, mulDiv, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalString, requireId, requireOneOf } from "@/lib/validation";

/**
 * Bank accounts and credit cards (examples BK1-BK16): the accounts that hold
 * statement lines from bank feeds and imported files. Statement lines are
 * what the bank says happened; they aren't ledger entries until reconciled.
 */
export type BankFeedStatus = {
  akahuAccountId: string | null;
  akahuAccountName: string | null;
  akahuConnectionName: string | null;
  startDate: string | null;
  active: boolean;
  lastSyncedAt: string | null;
  lastSyncStatus: "never" | "ok" | "failed";
  lastSyncError: string | null;
};

/** The account's SimpleFIN feed (decision 388), when it has one. */
export type SimpleFinFeedStatus = { active: true; lastSyncedAt: string | null; lastSyncStatus: "never" | "ok" | "failed" };

export type BankAccount = {
  id: string;
  code: string;
  name: string;
  accountType: "bank" | "credit_card";
  currencyCode: string | null;
  isActive: boolean;
  /** The currency its statement lines are in: its own, or the base currency (FXB1-FXB11). */
  statementCurrency: string;
  /** In a currency other than the base currency. */
  isForeign: boolean;
  /** Debits less credits in the base currency, signed like statement lines: a card's negative balance is owed. */
  ledgerBalance: string;
  /** For a foreign-currency account, its balance in that currency (null until it's known, FXB1). */
  foreignBalance: string | null;
  /** A foreign-currency account with postings from before Tohyee kept foreign amounts and no opening foreign balance yet. */
  needsOpeningBalance: boolean;
  openingBalance: ForeignOpeningBalance | null;
  statementBalance: string | null;
  statementBalanceAt: string | null;
  unreconciledCount: number;
  lastLineDate: string | null;
  importLayout: unknown;
  feed: BankFeedStatus;
  simplefin: SimpleFinFeedStatus | null;
};

type BankAccountRow = {
  id: string;
  code: string;
  name: string;
  account_type: "bank" | "credit_card";
  currency_code: string | null;
  is_active: boolean;
  ledger_balance: string;
  statement_balance: string | null;
  statement_balance_at: string | null;
  unreconciled_count: string;
  last_line_date: string | null;
  import_layout: unknown;
  akahu_account_id: string | null;
  akahu_account_name: string | null;
  akahu_connection_name: string | null;
  feed_start_date: string | null;
  feed_active: boolean | null;
  last_synced_at: string | null;
  last_sync_status: "never" | "ok" | "failed" | null;
  last_sync_error: string | null;
  simplefin_active: boolean | null;
  simplefin_synced_at: string | null;
  simplefin_status: "never" | "ok" | "failed" | null;
};

const BANK_ACCOUNT_SELECT = `
  select a.id, a.code, a.name, a.account_type, a.currency_code, a.is_active,
         coalesce((select sum(l.debit_amount - l.credit_amount) from ledger_journal_lines l where l.account_id = a.id), 0)::text
           as ledger_balance,
         s.statement_balance::text, s.statement_balance_at,
         (select count(*) from bank_statement_lines b where b.account_id = a.id and b.status = 'unreconciled')::text
           as unreconciled_count,
         (select max(b.line_date) from bank_statement_lines b where b.account_id = a.id and b.status <> 'deleted')::text
           as last_line_date,
         s.import_layout, s.akahu_account_id, s.akahu_account_name, s.akahu_connection_name, s.feed_start_date::text,
         s.feed_active, s.last_synced_at, s.last_sync_status, s.last_sync_error,
         sf.active as simplefin_active, sf.last_synced_at as simplefin_synced_at, sf.last_sync_status as simplefin_status
    from accounts a
    left join bank_account_settings s on s.account_id = a.id
    left join simplefin_links sf on sf.account_id = a.id and sf.active
   where a.account_type in ('bank', 'credit_card')`;

function toBankAccount(row: BankAccountRow, scale: number, baseCurrency: string): BankAccount {
  const foreign = row.currency_code !== null && row.currency_code !== baseCurrency;
  const statementScale = foreign ? currencyMinorUnits(row.currency_code!) : scale;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    currencyCode: row.currency_code,
    isActive: row.is_active,
    statementCurrency: foreign ? row.currency_code! : baseCurrency,
    isForeign: foreign,
    ledgerBalance: toFixedString(dec(row.ledger_balance), scale),
    foreignBalance: null,
    needsOpeningBalance: false,
    openingBalance: null,
    statementBalance: row.statement_balance === null ? null : toFixedString(dec(row.statement_balance), statementScale),
    statementBalanceAt: row.statement_balance_at,
    unreconciledCount: Number(row.unreconciled_count),
    lastLineDate: row.last_line_date,
    importLayout: row.import_layout ?? null,
    feed: {
      akahuAccountId: row.akahu_account_id,
      akahuAccountName: row.akahu_account_name,
      akahuConnectionName: row.akahu_connection_name,
      startDate: row.feed_start_date,
      active: row.feed_active ?? false,
      lastSyncedAt: row.last_synced_at,
      lastSyncStatus: row.last_sync_status ?? "never",
      lastSyncError: row.last_sync_error,
    },
    simplefin: row.simplefin_active
      ? { active: true, lastSyncedAt: row.simplefin_synced_at, lastSyncStatus: row.simplefin_status ?? "never" }
      : null,
  };
}

/** Every bank and credit card account, active first, by code. */
export async function listBankAccounts(tx: OrgTx, options: { includeArchived?: boolean } = {}): Promise<BankAccount[]> {
  const result = await tx.query<BankAccountRow>(
    `${BANK_ACCOUNT_SELECT} and ($1::boolean or a.is_active) order by a.is_active desc, a.code`,
    [options.includeArchived ?? false],
  );
  const scale = currencyMinorUnits(tx.baseCurrency);
  const accounts = result.rows.map((row) => toBankAccount(row, scale, tx.baseCurrency));
  for (const account of accounts) await addForeignState(tx, account);
  return accounts;
}

/** A foreign-currency account's balance in its currency and its opening foreign balance (FXB1). */
async function addForeignState(tx: OrgTx, account: BankAccount): Promise<void> {
  if (account.statementCurrency === tx.baseCurrency) return;
  const state = await foreignAccountState(tx, account.id);
  account.foreignBalance = state.foreignBalance;
  account.needsOpeningBalance = state.needsOpeningBalance;
  account.openingBalance = state.opening;
}

export async function getBankAccount(tx: OrgTx, accountIdInput: unknown): Promise<BankAccount> {
  const accountId = requireId(accountIdInput, "accountId");
  const result = await tx.query<BankAccountRow>(`${BANK_ACCOUNT_SELECT} and a.id = $1`, [accountId]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Bank or credit card account not found.");
  }
  const account = toBankAccount(row, currencyMinorUnits(tx.baseCurrency), tx.baseCurrency);
  await addForeignState(tx, account);
  return account;
}

/**
 * Locks a bank or credit card account for statement changes (imports, feed
 * syncs, deleting imports) until the transaction ends, so two imports into
 * one account take turns. Statement lines need an active account; a
 * foreign-currency one needs its opening foreign balance if it had postings
 * from before Tohyee kept foreign amounts (FXB1), and can't have an Akahu
 * feed, since Akahu's transactions don't say their currency (FXB10).
 */
export async function lockStatementAccount(
  tx: OrgTx,
  accountId: string,
  purpose: "lines" | "feed" | "simplefin" | "delete" = "lines",
): Promise<{ id: string; code: string; name: string; accountType: AccountType; currencyCode: string }> {
  const result = await tx.query<{
    id: string;
    code: string;
    name: string;
    account_type: AccountType;
    currency_code: string | null;
    is_active: boolean;
  }>("select id, code, name, account_type, currency_code, is_active from accounts where id = $1 for update", [accountId]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Account not found.");
  const label = `Account ${row.code} (${row.name})`;
  if (!isBankOrCreditCard(row.account_type)) {
    throw new ValidationError(`${label} isn't a bank or credit card account, so it can't hold statement lines.`);
  }
  if (!row.is_active) throw new ValidationError(`${label} is archived.`);
  const foreign = row.currency_code !== null && row.currency_code !== tx.baseCurrency;
  if (foreign && purpose === "feed") {
    throw new ValidationError(
      `${label} is in ${row.currency_code}. Akahu bank feeds can't be used for foreign-currency accounts yet: Akahu's transactions don't say their currency. Import statement files instead.`,
    );
  }
  if (foreign && (purpose === "lines" || purpose === "simplefin") && (await foreignAccountState(tx, row.id)).needsOpeningBalance) {
    throw new ValidationError(
      `${label} has postings from before Tohyee kept foreign amounts. Enter its ${row.currency_code} balance as at a date (its opening foreign balance) first.`,
    );
  }
  await tx.query("insert into bank_account_settings (account_id) values ($1) on conflict do nothing", [row.id]);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    currencyCode: foreign ? row.currency_code! : tx.baseCurrency,
  };
}

/** Adds a bank or credit card account to the chart of accounts. */
export async function createBankAccount(
  tx: OrgTx,
  input: { code: unknown; name: unknown; accountType: unknown; description?: unknown; currencyCode?: unknown },
): Promise<BankAccount> {
  const accountType = requireOneOf(input.accountType, "accountType", ["bank", "credit_card"] as const);
  const account = await createAccount(tx, {
    code: input.code,
    name: input.name,
    accountType,
    description: optionalString(input.description, "description", { maxLength: 500 }),
    // A foreign-currency account (FXB1-FXB11); blank for the base currency.
    currencyCode: input.currencyCode,
  });
  await tx.query("insert into bank_account_settings (account_id) values ($1) on conflict do nothing", [account.id]);
  return getBankAccount(tx, account.id);
}

function normalise(text: string | null): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** How lines without the bank's own id are compared: date, amount, description and reference. */
export function matchKey(line: Pick<ParsedStatementLine, "date" | "amount" | "description" | "reference">): string {
  return createHash("sha256")
    .update(`${line.date}|${toFixedString(dec(line.amount), 2)}|${normalise(line.description)}|${normalise(line.reference)}`)
    .digest("hex")
    .slice(0, 40);
}

/** Where a line's own id came from ("ofx", "akahu", ...), or "none". */
function sourceKind(externalId: string | null): string {
  return externalId ? externalId.split(":")[0] : "none";
}

export type AddLinesResult = { added: number; duplicates: number; possibleDuplicates: number };

/**
 * Works out which parsed lines are new (example BK2): a line with the bank's
 * own id is added unless a line with that id is already on the account;
 * lines without one are added only when the batch has more of that line than
 * the account already has. New lines that match a line from another source
 * on date and amount are flagged as possible duplicates (BK3, BK15). The
 * account must be locked (lockStatementAccount).
 */
export async function addStatementLines(
  tx: OrgTx,
  accountId: string,
  importId: string | null,
  lines: readonly ParsedStatementLine[],
  options: { dryRun?: boolean } = {},
): Promise<AddLinesResult> {
  const keyed = lines.map((line) => ({ ...line, amount: toFixedString(dec(line.amount), 2), matchKey: matchKey(line) }));
  const existingIds = new Set(
    (
      await tx.query<{ external_id: string }>(
        `select external_id from bank_statement_lines
          where account_id = $1 and status <> 'deleted' and external_id = any($2::text[])`,
        [accountId, keyed.flatMap((line) => (line.externalId ? [line.externalId] : []))],
      )
    ).rows.map((row) => row.external_id),
  );
  const existingKeyCounts = new Map(
    (
      await tx.query<{ match_key: string; count: string }>(
        `select match_key, count(*)::text as count from bank_statement_lines
          where account_id = $1 and status <> 'deleted' and external_id is null and match_key = any($2::text[])
          group by match_key`,
        [accountId, keyed.filter((line) => !line.externalId).map((line) => line.matchKey)],
      )
    ).rows.map((row) => [row.match_key, Number(row.count)]),
  );
  const sameDay = (
    await tx.query<{ id: string; line_date: string; amount: string; external_id: string | null }>(
      `select id, line_date::text, amount::text, external_id from bank_statement_lines
        where account_id = $1 and status <> 'deleted' and line_date = any($2::date[])
        order by id`,
      [accountId, [...new Set(keyed.map((line) => line.date))]],
    )
  ).rows;

  const seenKeys = new Map<string, number>();
  const toAdd: Array<(typeof keyed)[number] & { possibleDuplicateOf: string | null }> = [];
  let duplicates = 0;
  for (const line of keyed) {
    if (line.externalId) {
      if (existingIds.has(line.externalId)) {
        duplicates += 1;
        continue;
      }
      existingIds.add(line.externalId);
    } else {
      const seen = (seenKeys.get(line.matchKey) ?? 0) + 1;
      seenKeys.set(line.matchKey, seen);
      if (seen <= (existingKeyCounts.get(line.matchKey) ?? 0)) {
        duplicates += 1;
        continue;
      }
    }
    const other = sameDay.find(
      (row) =>
        row.line_date === line.date &&
        toFixedString(dec(row.amount), 2) === line.amount &&
        sourceKind(row.external_id) !== sourceKind(line.externalId),
    );
    toAdd.push({ ...line, possibleDuplicateOf: other?.id ?? null });
  }
  const possibleDuplicates = toAdd.filter((line) => line.possibleDuplicateOf).length;
  if (!options.dryRun && toAdd.length > 0) {
    if (!importId) throw new Error("addStatementLines needs an import id to add lines.");
    // Each line is in the account's currency (checked by the database too): FXB10.
    const currency = (
      await tx.query<{ currency: string }>("select coalesce(currency_code, $2) as currency from accounts where id = $1", [
        accountId,
        tx.baseCurrency,
      ])
    ).rows[0].currency;
    await tx.query(
      `insert into bank_statement_lines (
         account_id, import_id, line_date, amount, description, payee, particulars, code, reference, balance,
         external_id, match_key, possible_duplicate_of, currency_code
       )
       select $1, $2, x.line_date, x.amount, x.description, x.payee, x.particulars, x.code, x.reference, x.balance,
              x.external_id, x.match_key, x.possible_duplicate_of, $4
         from jsonb_to_recordset($3::jsonb) as x(
           ord integer, line_date date, amount numeric, description text, payee text, particulars text, code text,
           reference text, balance numeric, external_id text, match_key text, possible_duplicate_of bigint
         )
        order by x.ord`,
      [
        accountId,
        importId,
        JSON.stringify(
          toAdd.map((line, index) => ({
            ord: index,
            line_date: line.date,
            amount: line.amount,
            description: line.description,
            payee: line.payee,
            particulars: line.particulars,
            code: line.code,
            reference: line.reference,
            balance: line.balance,
            external_id: line.externalId,
            match_key: line.matchKey,
            possible_duplicate_of: line.possibleDuplicateOf,
          })),
        ),
        currency,
      ],
    );
  }
  return { added: toAdd.length, duplicates, possibleDuplicates };
}

export const STATEMENT_LINE_STATUSES = ["unreconciled", "reconciled", "excluded", "deleted"] as const;
export type StatementLineStatus = (typeof STATEMENT_LINE_STATUSES)[number];

export type ReconciledItem = {
  journalId: string;
  journalLineId: string;
  /** In the statement line's currency. */
  amount: string;
  /** The journal line's base-currency amount, signed the same way. */
  baseAmount: string;
  postingDate: string;
  origin: string;
  reference: string;
  description: string | null;
};

export type StatementLine = {
  id: string;
  accountId: string;
  importId: string;
  date: string;
  amount: string;
  description: string;
  payee: string | null;
  particulars: string | null;
  code: string | null;
  reference: string | null;
  balance: string | null;
  externalId: string | null;
  status: StatementLineStatus;
  possibleDuplicateOf: string | null;
  source: "file" | "akahu" | "simplefin";
  /** The line's currency (the account's). */
  currencyCode: string;
  /**
   * For a line in a foreign currency: the last rate used for that currency on
   * or before its date (D4), to fill in, and its base value at that rate
   * (reconciled lines: what they were reconciled at). Null otherwise.
   */
  suggestedRate: RateUsed | null;
  baseAmount: string | null;
  reconciliation: {
    id: string;
    kind: string;
    createdAt: string;
    createdByEmail: string | null;
    items: ReconciledItem[];
    /** For a line reconciled with others against one journal line (BK26): the split and all its lines. */
    split: { id: string; journalAmount: string; lines: Array<{ id: string; date: string; amount: string }> } | null;
  } | null;
};

type StatementLineRow = {
  id: string;
  account_id: string;
  import_id: string;
  line_date: string;
  amount: string;
  description: string;
  payee: string | null;
  particulars: string | null;
  code: string | null;
  reference: string | null;
  balance: string | null;
  external_id: string | null;
  status: StatementLineStatus;
  possible_duplicate_of: string | null;
  source: "file" | "akahu" | "simplefin";
  currency_code: string | null;
  reconciliation: StatementLine["reconciliation"];
};

const LINE_SELECT = `
  select b.id, b.account_id, b.import_id, b.line_date::text, b.amount::text, b.description, b.payee, b.particulars,
         b.code, b.reference, b.balance::text, b.external_id, b.status, b.possible_duplicate_of, i.source, b.currency_code,
         (select jsonb_build_object(
                   'id', r.id::text, 'kind', r.kind, 'createdAt', r.created_at, 'createdByEmail', r.created_by_email,
                   'items', (select coalesce(jsonb_agg(jsonb_build_object(
                                'journalId', j.id::text, 'journalLineId', jl.id::text, 'amount', ri.amount::text,
                                'baseAmount', (jl.debit_amount - jl.credit_amount)::text,
                                'postingDate', j.posting_date::text, 'origin', j.origin, 'reference', j.reference,
                                'description', j.description) order by jl.id), '[]'::jsonb)
                               from bank_reconciliation_items ri
                               join ledger_journal_lines jl on jl.id = ri.journal_line_id
                               join ledger_journals j on j.id = jl.journal_id
                              where ri.reconciliation_id = r.id),
                   'split', (select jsonb_build_object(
                               'id', s.id::text,
                               'journalAmount', sj.account_amount::text,
                               'lines', (select jsonb_agg(jsonb_build_object('id', sb.id::text, 'date', sb.line_date::text, 'amount', sb.amount::text)
                                                          order by sb.line_date, sb.id)
                                           from bank_reconciliations sr join bank_statement_lines sb on sb.id = sr.statement_line_id
                                          where sr.split_id = s.id and sr.status = r.status))
                               from bank_reconciliation_splits s join ledger_journal_lines sj on sj.id = s.journal_line_id
                              where s.id = r.split_id))
            from bank_reconciliations r where r.statement_line_id = b.id and r.status = 'active') as reconciliation
    from bank_statement_lines b
    join bank_statement_imports i on i.id = b.import_id`;

function toStatementLine(row: StatementLineRow, baseCurrency: string): StatementLine {
  const money = (value: string) => toFixedString(dec(value), 2);
  const currencyCode = row.currency_code ?? baseCurrency;
  return {
    id: row.id,
    accountId: row.account_id,
    importId: row.import_id,
    date: row.line_date,
    amount: money(row.amount),
    description: row.description,
    payee: row.payee,
    particulars: row.particulars,
    code: row.code,
    reference: row.reference,
    balance: row.balance === null ? null : money(row.balance),
    externalId: row.external_id,
    status: row.status,
    possibleDuplicateOf: row.possible_duplicate_of,
    source: row.source,
    currencyCode,
    suggestedRate: null,
    baseAmount: null,
    reconciliation: row.reconciliation
      ? {
          ...row.reconciliation,
          items: row.reconciliation.items.map((item) => ({ ...item, amount: money(item.amount), baseAmount: money(item.baseAmount) })),
          split: row.reconciliation.split
            ? {
                id: row.reconciliation.split.id,
                journalAmount: money(row.reconciliation.split.journalAmount),
                lines: row.reconciliation.split.lines.map((entry) => ({ ...entry, amount: money(entry.amount) })),
              }
            : null,
        }
      : null,
  };
}

/**
 * Foreign-currency lines (D4): an unreconciled line gets the last rate used
 * for its currency on or before its date and its base value at that rate; a
 * reconciled one, the base value of what it was reconciled with (a split
 * line, its share at the journal line's own rate).
 */
async function withBaseAmounts(tx: OrgTx, lines: StatementLine[]): Promise<StatementLine[]> {
  const foreign = lines.filter((line) => line.currencyCode !== tx.baseCurrency);
  if (foreign.length === 0) return lines;
  const rates = await defaultRates(tx, foreign.map((line) => line.currencyCode));
  const baseScale = currencyMinorUnits(tx.baseCurrency);
  for (const line of foreign) {
    line.suggestedRate = lastRateOnOrBefore(rates.get(line.currencyCode), line.date);
    const items = line.reconciliation?.items ?? [];
    if (line.reconciliation && !line.reconciliation.split && items.length > 0) {
      line.baseAmount = toFixedString(items.reduce((total, item) => add(total, dec(item.baseAmount)), ZERO_DECIMAL), baseScale);
    } else if (line.reconciliation?.split && items[0]) {
      const whole = dec(line.reconciliation.split.journalAmount);
      line.baseAmount = toFixedString(mulDiv(dec(items[0].baseAmount), dec(line.amount), whole, baseScale), baseScale);
    } else if (line.suggestedRate) {
      line.baseAmount = convertAtRate(line.amount, line.suggestedRate.rate, baseScale);
    }
  }
  return lines;
}

export async function getStatementLine(tx: OrgTx, lineIdInput: unknown): Promise<StatementLine> {
  const lineId = requireId(lineIdInput, "lineId");
  const result = await tx.query<StatementLineRow>(`${LINE_SELECT} where b.id = $1`, [lineId]);
  if (!result.rows[0]) throw new NotFoundError("Statement line not found.");
  return (await withBaseAmounts(tx, [toStatementLine(result.rows[0], tx.baseCurrency)]))[0];
}

/**
 * An account's statement lines, oldest first for unreconciled lines (the
 * order they're worked through) and newest first otherwise, 100 at a time.
 */
export async function listStatementLines(
  tx: OrgTx,
  accountIdInput: unknown,
  filters: { status?: unknown; limit?: unknown; offset?: unknown; search?: unknown } = {},
): Promise<{ lines: StatementLine[]; total: number }> {
  const accountId = requireId(accountIdInput, "accountId");
  const status =
    filters.status == null || filters.status === "" || filters.status === "all"
      ? null
      : requireOneOf(filters.status, "status", STATEMENT_LINE_STATUSES);
  const limitRaw = Number(filters.limit ?? 100);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;
  const offsetRaw = Number(filters.offset ?? 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const search = optionalString(filters.search, "search", { maxLength: 100 });
  const where = `b.account_id = $1 and ($2::text is null or b.status = $2) and ($2::text is not null or b.status <> 'deleted')
     and ($3::text is null or b.description ilike '%' || $3 || '%' or b.amount::text = $3)`;
  const order = status === "unreconciled" ? "b.line_date, b.id" : "b.line_date desc, b.id desc";
  const [rows, count] = await Promise.all([
    tx.query<StatementLineRow>(`${LINE_SELECT} where ${where} order by ${order} limit $4 offset $5`, [
      accountId,
      status,
      search,
      limit,
      offset,
    ]),
    tx.query<{ count: string }>(`select count(*)::text as count from bank_statement_lines b where ${where}`, [
      accountId,
      status,
      search,
    ]),
  ]);
  return {
    lines: await withBaseAmounts(
      tx,
      rows.rows.map((row) => toStatementLine(row, tx.baseCurrency)),
    ),
    total: Number(count.rows[0].count),
  };
}

/** Locks a statement line until the transaction ends. */
export async function lockStatementLine(tx: OrgTx, lineId: string): Promise<StatementLine> {
  const locked = await tx.query("select id from bank_statement_lines where id = $1 for update", [lineId]);
  if (locked.rowCount === 0) throw new NotFoundError("Statement line not found.");
  return getStatementLine(tx, lineId);
}

/**
 * Excludes an unreconciled line (e.g. a duplicate) or brings an excluded one
 * back (example BK12). Reconciled lines can't be excluded.
 */
export async function setStatementLineExcluded(tx: OrgTx, lineIdInput: unknown, excluded: boolean): Promise<StatementLine> {
  const lineId = requireId(lineIdInput, "lineId");
  const line = await lockStatementLine(tx, lineId);
  if (line.status === "reconciled") {
    throw new ValidationError("This line is reconciled. Unreconcile it before excluding it.");
  }
  if (line.status === "deleted") throw new ValidationError("This line's import was deleted.");
  const next = excluded ? "excluded" : "unreconciled";
  if (line.status !== next) {
    await tx.query("update bank_statement_lines set status = $2, updated_at = now() where id = $1", [lineId, next]);
    await writeAuditEvent(tx, {
      eventType: excluded ? "statement_line.excluded" : "statement_line.included",
      entityType: "bank_statement_line",
      entityId: lineId,
      details: { accountId: line.accountId, date: line.date, amount: line.amount },
    });
  }
  return getStatementLine(tx, lineId);
}

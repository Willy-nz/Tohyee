import { parseAccountCodeInput } from "@/lib/accounts/service";
import { isBankOrCreditCard, type AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { AMOUNTS_MODES, calculateInvoice, type AmountsMode } from "@/lib/invoices/amounts";
import { controlAccountCode, GST_ACCOUNT } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, isZero, parseDecimalInput, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  asRecord,
  optionalSource,
  optionalString,
  requireArray,
  requireId,
  requireIdempotencyKey,
  requireOneOf,
  requireString,
} from "@/lib/validation";

/**
 * Bank transactions (examples BK6, BK7, BK9, BK11): spend money out of a bank
 * or credit card account, or receive money into one, with invoice-style lines
 * (the same amounts modes, per-line GST and line maths). Posting is
 * immediate and posts one journal; a bank transaction can't be edited, only
 * voided (not while reconciled), which posts the exact reversal. They count
 * in the GST return: spend money like a bill, receive money like an invoice.
 */
export type BankTransactionKind = "spend" | "receive";

export type BankTransactionLine = {
  lineOrder: number;
  description: string;
  accountCode: string;
  accountName: string;
  taxCode: string | null;
  taxRate: string;
  lineAmount: string;
  netAmount: string;
  taxAmount: string;
};

export type BankTransaction = {
  id: string;
  kind: BankTransactionKind;
  status: "posted" | "voided";
  accountId: string;
  accountCode: string;
  accountName: string;
  contactId: string;
  contactName: string;
  date: string;
  reference: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  journalId: string;
  voidDate: string | null;
  voidJournalId: string | null;
  createdByEmail: string | null;
  createdAt: string;
  lines: BankTransactionLine[];
};

type Row = {
  id: string;
  kind: BankTransactionKind;
  status: "posted" | "voided";
  account_id: string;
  account_code: string;
  account_name: string;
  contact_id: string;
  contact_name: string;
  transaction_date: string;
  reference: string | null;
  amounts_mode: AmountsMode;
  currency_code: string;
  subtotal: string;
  tax_total: string;
  total: string;
  journal_id: string;
  void_date: string | null;
  void_journal_id: string | null;
  created_by_email: string | null;
  created_at: string;
  lines: Array<Omit<BankTransactionLine, "lineAmount" | "netAmount" | "taxAmount"> & Record<"lineAmount" | "netAmount" | "taxAmount", string>>;
};

const SELECT = `
  select t.id, t.kind, t.status, t.account_id, a.code as account_code, a.name as account_name, t.contact_id,
         c.name as contact_name, t.transaction_date::text, t.reference, t.amounts_mode, t.currency_code,
         t.subtotal::text, t.tax_total::text, t.total::text, t.journal_id, t.void_date::text, t.void_journal_id,
         t.created_by_email, t.created_at,
         (select jsonb_agg(jsonb_build_object(
                   'lineOrder', l.line_order, 'description', l.description, 'accountCode', la.code,
                   'accountName', la.name, 'taxCode', tc.code, 'taxRate', l.tax_rate::text,
                   'lineAmount', l.line_amount::text, 'netAmount', l.net_amount::text, 'taxAmount', l.tax_amount::text)
                 order by l.line_order)
            from bank_transaction_lines l
            join accounts la on la.id = l.account_id
            left join tax_codes tc on tc.id = l.tax_code_id
           where l.bank_transaction_id = t.id) as lines
    from bank_transactions t
    join accounts a on a.id = t.account_id
    join contacts c on c.id = t.contact_id`;

function toTransaction(row: Row): BankTransaction {
  const scale = currencyMinorUnits(row.currency_code);
  const money = (value: string) => toFixedString(dec(value), scale);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    contactId: row.contact_id,
    contactName: row.contact_name,
    date: row.transaction_date,
    reference: row.reference,
    amountsMode: row.amounts_mode,
    currencyCode: row.currency_code,
    subtotal: money(row.subtotal),
    taxTotal: money(row.tax_total),
    total: money(row.total),
    journalId: row.journal_id,
    voidDate: row.void_date,
    voidJournalId: row.void_journal_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    lines: (row.lines ?? []).map((line) => ({
      ...line,
      lineAmount: money(line.lineAmount),
      netAmount: money(line.netAmount),
      taxAmount: money(line.taxAmount),
    })),
  };
}

export async function getBankTransaction(tx: OrgTx, idInput: unknown): Promise<BankTransaction> {
  const id = requireId(idInput, "bankTransactionId");
  const result = await tx.query<Row>(`${SELECT} where t.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Bank transaction not found.");
  return toTransaction(result.rows[0]);
}

export async function listBankTransactions(
  tx: OrgTx,
  filters: { accountId?: unknown; limit?: unknown } = {},
): Promise<BankTransaction[]> {
  const accountId = filters.accountId ? requireId(filters.accountId, "accountId") : null;
  const limitRaw = Number(filters.limit ?? 100);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;
  const result = await tx.query<Row>(
    `${SELECT} where ($1::bigint is null or t.account_id = $1) order by t.transaction_date desc, t.id desc limit $2`,
    [accountId, limit],
  );
  return result.rows.map(toTransaction);
}

const CONTROL_KEYS: Record<string, string> = {
  accounts_receivable: "the accounts receivable account (record a customer payment instead)",
  accounts_payable: "the accounts payable account (record a supplier payment instead)",
  gst: "the GST account (GST is worked out from the tax codes)",
};

/** Why an account can't take a bank transaction line, or null if it can. */
export function bankTransactionLineAccountProblem(account: {
  accountType: AccountType | string;
  systemKey: string | null;
  currencyCode: string | null;
}): string | null {
  const control = account.systemKey ? CONTROL_KEYS[account.systemKey] : undefined;
  if (control) return control;
  if (isBankOrCreditCard(account.accountType)) return "a bank or credit card account (use a transfer instead)";
  if (account.accountType === "inventory") return "an inventory account (stock moves through stock movements)";
  if (account.currencyCode) return `in ${account.currencyCode}, but bank transactions are in the base currency`;
  return null;
}

export type BankTransactionInput = {
  source?: unknown;
  idempotencyKey: unknown;
  kind: unknown;
  accountId: unknown;
  contactId: unknown;
  date: unknown;
  reference?: unknown;
  amountsMode: unknown;
  lines: unknown;
};

type ParsedInput = {
  kind: BankTransactionKind;
  accountId: string;
  contactId: string;
  date: string;
  reference: string | null;
  amountsMode: AmountsMode;
  lines: Array<{ description: string; accountCode: string; taxCode: string | null; amount: string }>;
};

function parseInput(tx: OrgTx, input: BankTransactionInput): ParsedInput {
  const scale = currencyMinorUnits(tx.baseCurrency);
  const rawLines = requireArray(input.lines, "lines", 100);
  if (rawLines.length === 0) throw new ValidationError("Add at least one line.");
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  return {
    kind: requireOneOf(input.kind, "kind", ["spend", "receive"] as const),
    accountId: requireId(input.accountId, "accountId"),
    contactId: requireId(input.contactId, "contactId"),
    date: parseIsoDate(input.date, "date"),
    reference: optionalString(input.reference, "reference", { maxLength: 100 }),
    amountsMode,
    lines: rawLines.map((raw, index) => {
      const label = `Line ${index + 1}`;
      const entry = asRecord(raw, label);
      const taxCode = optionalString(entry.taxCode, `${label} taxCode`, { maxLength: 20 });
      return {
        description: requireString(entry.description, `${label} description`, { maxLength: 500 }),
        accountCode: parseAccountCodeInput(entry.accountCode, `${label} accountCode`),
        taxCode: amountsMode === "no_tax" ? null : taxCode,
        amount: parseDecimalInput(entry.amount, `${label} amount`, { maxScale: scale }),
      };
    }),
  };
}

type Resolved = ParsedInput & {
  account: { id: string; code: string; name: string };
  contactName: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  resolvedLines: Array<{
    description: string;
    accountId: string;
    accountCode: string;
    taxCodeId: string | null;
    taxRate: string;
    lineAmount: string;
    netAmount: string;
    taxAmount: string;
  }>;
};

async function resolveInput(tx: OrgTx, input: ParsedInput): Promise<Resolved> {
  const bank = await tx.query<{ id: string; code: string; name: string; account_type: string; currency_code: string | null; is_active: boolean }>(
    "select id, code, name, account_type, currency_code, is_active from accounts where id = $1",
    [input.accountId],
  );
  const account = bank.rows[0];
  if (!account) throw new ValidationError("There's no such bank or credit card account.");
  const label = `Account ${account.code} (${account.name})`;
  if (!isBankOrCreditCard(account.account_type)) throw new ValidationError(`${label} isn't a bank or credit card account.`);
  if (!account.is_active) throw new ValidationError(`${label} is archived.`);
  if (account.currency_code && account.currency_code !== tx.baseCurrency) {
    throw new ValidationError(`${label} is in ${account.currency_code}. Bank transactions are in the base currency only.`);
  }
  const contact = await tx.query<{ name: string; is_archived: boolean }>("select name, is_archived from contacts where id = $1", [
    input.contactId,
  ]);
  if (!contact.rows[0]) throw new ValidationError(`There's no contact #${input.contactId}.`);
  if (contact.rows[0].is_archived) throw new ValidationError(`${contact.rows[0].name} is archived.`);

  const accounts = await tx.query<{
    id: string;
    code: string;
    name: string;
    account_type: string;
    system_key: string | null;
    currency_code: string | null;
    is_active: boolean;
  }>(
    "select id, code, name, account_type, system_key, currency_code, is_active from accounts where lower(code) = any($1::text[])",
    [[...new Set(input.lines.map((line) => line.accountCode.toLowerCase()))]],
  );
  const byCode = new Map(accounts.rows.map((row) => [row.code.toLowerCase(), row]));
  const taxCodes = await tx.query<{ id: string; code: string; rate: string; is_active: boolean; effective_from: string; effective_to: string | null }>(
    "select id, code, rate, is_active, effective_from::text, effective_to::text from tax_codes where code = any($1::text[])",
    [[...new Set(input.lines.flatMap((line) => (line.taxCode ? [line.taxCode] : [])))]],
  );
  const taxByCode = new Map(taxCodes.rows.map((row) => [row.code, row]));
  const lines = input.lines.map((line, index) => {
    const lineLabel = `Line ${index + 1}`;
    const target = byCode.get(line.accountCode.toLowerCase());
    if (!target) throw new ValidationError(`${lineLabel}: there's no account with the code ${line.accountCode}.`);
    if (!target.is_active) throw new ValidationError(`${lineLabel}: account ${target.code} (${target.name}) is archived.`);
    const problem = bankTransactionLineAccountProblem({
      accountType: target.account_type,
      systemKey: target.system_key,
      currencyCode: target.currency_code === tx.baseCurrency ? null : target.currency_code,
    });
    if (problem) throw new ValidationError(`${lineLabel}: account ${target.code} (${target.name}) is ${problem}.`);
    let taxCodeId: string | null = null;
    let taxRate = "0";
    if (line.taxCode) {
      const taxCode = taxByCode.get(line.taxCode);
      if (!taxCode) throw new ValidationError(`${lineLabel}: there's no tax code ${line.taxCode}.`);
      if (!taxCode.is_active) throw new ValidationError(`${lineLabel}: tax code ${taxCode.code} is inactive.`);
      if (taxCode.effective_from > input.date || (taxCode.effective_to !== null && taxCode.effective_to < input.date)) {
        throw new ValidationError(`${lineLabel}: tax code ${taxCode.code} isn't in effect on ${input.date}.`);
      }
      taxCodeId = taxCode.id;
      taxRate = toPlainString(dec(taxCode.rate));
    }
    return { ...line, accountId: target.id, accountCode: target.code, taxCodeId, taxRate };
  });
  const scale = currencyMinorUnits(tx.baseCurrency);
  const amounts = calculateInvoice(
    input.amountsMode,
    lines.map((line) => ({ quantity: "1", unitPrice: line.amount, taxRate: line.taxRate })),
    scale,
  );
  return {
    ...input,
    account: { id: account.id, code: account.code, name: account.name },
    contactName: contact.rows[0].name,
    subtotal: amounts.subtotal,
    taxTotal: amounts.taxTotal,
    total: amounts.total,
    resolvedLines: lines.map((line, index) => ({
      description: line.description,
      accountId: line.accountId,
      accountCode: line.accountCode,
      taxCodeId: line.taxCodeId,
      taxRate: line.taxRate,
      ...amounts.lines[index],
    })),
  };
}

type Result = { created: boolean; bankTransaction: BankTransaction };

/**
 * Posts a bank transaction (examples BK6, BK7, BK9) on its date: spend money
 * is Dr each line's account for its net amount and Dr GST for the GST /
 * Cr the bank or credit card account for the total; receive money is the
 * other way round. `expectedTotal`, when given, must equal the total (a
 * bank transaction made from a statement line must add up to the line).
 */
export async function createBankTransaction(
  tx: OrgTx,
  input: BankTransactionInput,
  options: { expectedTotal?: string } = {},
): Promise<Result> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const parsed = parseInput(tx, input);
  const hash = requestHash("bank_transaction", { ...parsed });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id, request_hash from bank_transactions where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "bank transaction");
    return { created: false, bankTransaction: await getBankTransaction(tx, earlier.rows[0].id) };
  }
  const resolved = await resolveInput(tx, parsed);
  if (options.expectedTotal !== undefined && toFixedString(dec(options.expectedTotal), 2) !== resolved.total) {
    throw new ValidationError(
      `The bank transaction comes to ${resolved.total}, but the statement line is ${toFixedString(dec(options.expectedTotal), 2)}.`,
    );
  }
  const gst = isZero(dec(resolved.taxTotal)) ? null : await controlAccountCode(tx, GST_ACCOUNT, "bank transactions with GST can't be posted");
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('bank_transactions', 'id'))::text as id");
  const id = next.rows[0].id;
  const spend = resolved.kind === "spend";
  const side = (amount: string) => (spend ? { debitAmount: amount, creditAmount: "0" } : { debitAmount: "0", creditAmount: amount });
  const opposite = (amount: string) => (spend ? { debitAmount: "0", creditAmount: amount } : { debitAmount: amount, creditAmount: "0" });
  const journalLines = resolved.resolvedLines
    .filter((line) => !isZero(dec(line.netAmount)))
    .map((line) => ({ accountCode: line.accountCode, ...side(line.netAmount), description: line.description }));
  if (gst) journalLines.push({ accountCode: gst, ...side(resolved.taxTotal), description: "GST" });
  journalLines.push({ accountCode: resolved.account.code, ...opposite(resolved.total), description: resolved.contactName });
  const posted = await postJournalBody(
    tx,
    "bank_transaction:post",
    id,
    parseJournalBody(tx, {
      postingDate: resolved.date,
      reference: resolved.reference ?? `${spend ? "Spend" : "Receive"} ${resolved.contactName}`.slice(0, 100),
      description: `${spend ? "Spend money to" : "Receive money from"} ${resolved.contactName}`,
      lines: journalLines,
    }),
    { origin: "bank_transaction" },
  );
  await tx.query(
    `insert into bank_transactions (
       id, command_source, idempotency_key, request_hash, kind, account_id, contact_id, transaction_date, reference,
       amounts_mode, currency_code, subtotal, tax_total, total, journal_id, created_by_user_id, created_by_email
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, $13::numeric, $14::numeric, $15, $16, $17)`,
    [
      id,
      source,
      idempotencyKey,
      hash,
      resolved.kind,
      resolved.account.id,
      resolved.contactId,
      resolved.date,
      resolved.reference,
      resolved.amountsMode,
      tx.baseCurrency,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      posted.journal.id,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  for (const [index, line] of resolved.resolvedLines.entries()) {
    await tx.query(
      `insert into bank_transaction_lines (
         bank_transaction_id, line_order, description, quantity, unit_price, account_id, tax_code_id, tax_rate,
         line_amount, net_amount, tax_amount
       ) values ($1, $2, $3, 1, $4::numeric, $5, $6, $7::numeric, $4::numeric, $8::numeric, $9::numeric)`,
      [id, index + 1, line.description, line.lineAmount, line.accountId, line.taxCodeId, line.taxRate, line.netAmount, line.taxAmount],
    );
  }
  await writeAuditEvent(tx, {
    eventType: "bank_transaction.posted",
    entityType: "bank_transaction",
    entityId: id,
    details: { kind: resolved.kind, accountCode: resolved.account.code, total: resolved.total, journalId: posted.journal.id },
  });
  return { created: true, bankTransaction: await getBankTransaction(tx, id) };
}

async function reconciledJournal(tx: OrgTx, journalId: string): Promise<boolean> {
  const result = await tx.query(
    `select 1 from bank_reconciliation_items i join ledger_journal_lines l on l.id = i.journal_line_id
      where i.active and l.journal_id = $1 limit 1`,
    [journalId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Refuses when a journal is reconciled with a statement line (example BK11). The database refuses it too. */
export async function assertNotReconciled(tx: OrgTx, journalId: string, what: string): Promise<void> {
  if (await reconciledJournal(tx, journalId)) {
    throw new ConflictError(`${what} is reconciled with a bank statement line. Unreconcile it first.`);
  }
}

/**
 * Voids a bank transaction (example BK11): posts the exact reversal on the
 * void date, which must be in an open period and not before the transaction.
 * Refused while it's reconciled.
 */
export async function voidBankTransaction(
  tx: OrgTx,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<Result> {
  const id = requireId(idInput, "bankTransactionId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const hash = requestHash("bank_transaction_void", { id, voidDate });
  const earlier = await tx.query<{ id: string; hash: string }>(
    "select id, void_request_hash as hash from bank_transactions where void_command_source = $1 and void_idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].hash, hash, "bank transaction void");
    return { created: false, bankTransaction: await getBankTransaction(tx, earlier.rows[0].id) };
  }
  const locked = await tx.query("select id from bank_transactions where id = $1 for update", [id]);
  if (locked.rowCount === 0) throw new NotFoundError("Bank transaction not found.");
  const current = await getBankTransaction(tx, id);
  if (current.status === "voided") throw new ConflictError("This bank transaction has already been voided.");
  if (voidDate < current.date) throw new ValidationError(`The void date can't be before the transaction date (${current.date}).`);
  await assertNotReconciled(tx, current.journalId, "This bank transaction");
  const original = await getJournal(tx, current.journalId);
  const posted = await postJournalBody(
    tx,
    "bank_transaction:void",
    id,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of ${original.description ?? "bank transaction"}`.slice(0, 500),
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
      })),
    }),
    { origin: "bank_transaction", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  await tx.query(
    `update bank_transactions set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4,
            void_idempotency_key = $5, void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8, voided_at = now()
      where id = $1`,
    [id, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_transaction.voided",
    entityType: "bank_transaction",
    entityId: id,
    details: { voidDate, journalId: posted.journal.id },
  });
  return { created: true, bankTransaction: await getBankTransaction(tx, id) };
}

export type BankTransfer = {
  id: string;
  status: "posted" | "voided";
  fromAccountId: string;
  fromAccountCode: string;
  toAccountId: string;
  toAccountCode: string;
  date: string;
  amount: string;
  reference: string | null;
  journalId: string;
  voidDate: string | null;
  voidJournalId: string | null;
  createdAt: string;
};

type TransferRow = {
  id: string;
  status: "posted" | "voided";
  from_account_id: string;
  from_code: string;
  to_account_id: string;
  to_code: string;
  transfer_date: string;
  amount: string;
  reference: string | null;
  journal_id: string;
  void_date: string | null;
  void_journal_id: string | null;
  created_at: string;
};

const TRANSFER_SELECT = `
  select t.id, t.status, t.from_account_id, f.code as from_code, t.to_account_id, o.code as to_code,
         t.transfer_date::text, t.amount::text, t.reference, t.journal_id, t.void_date::text, t.void_journal_id, t.created_at
    from bank_transfers t join accounts f on f.id = t.from_account_id join accounts o on o.id = t.to_account_id`;

function toTransfer(tx: OrgTx, row: TransferRow): BankTransfer {
  return {
    id: row.id,
    status: row.status,
    fromAccountId: row.from_account_id,
    fromAccountCode: row.from_code,
    toAccountId: row.to_account_id,
    toAccountCode: row.to_code,
    date: row.transfer_date,
    amount: toFixedString(dec(row.amount), currencyMinorUnits(tx.baseCurrency)),
    reference: row.reference,
    journalId: row.journal_id,
    voidDate: row.void_date,
    voidJournalId: row.void_journal_id,
    createdAt: row.created_at,
  };
}

async function getTransfer(tx: OrgTx, id: string): Promise<BankTransfer> {
  const result = await tx.query<TransferRow>(`${TRANSFER_SELECT} where t.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Transfer not found.");
  return toTransfer(tx, row);
}

/** Transfers into or out of an account (or all), newest first. */
export async function listTransfers(tx: OrgTx, filters: { accountId?: unknown; limit?: unknown } = {}): Promise<BankTransfer[]> {
  const accountId = filters.accountId ? requireId(filters.accountId, "accountId") : null;
  const limitRaw = Number(filters.limit ?? 100);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;
  const result = await tx.query<TransferRow>(
    `${TRANSFER_SELECT} where ($1::bigint is null or t.from_account_id = $1 or t.to_account_id = $1)
      order by t.transfer_date desc, t.id desc limit $2`,
    [accountId, limit],
  );
  return result.rows.map((row) => toTransfer(tx, row));
}

async function transferAccount(tx: OrgTx, code: string, field: string): Promise<{ id: string; code: string; name: string }> {
  const result = await tx.query<{ id: string; code: string; name: string; account_type: string; currency_code: string | null; is_active: boolean }>(
    "select id, code, name, account_type, currency_code, is_active from accounts where lower(code) = lower($1)",
    [code],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationError(`${field}: there's no account with the code ${code}.`);
  const label = `Account ${row.code} (${row.name})`;
  if (!isBankOrCreditCard(row.account_type)) throw new ValidationError(`${label} isn't a bank or credit card account.`);
  if (!row.is_active) throw new ValidationError(`${label} is archived.`);
  if (row.currency_code && row.currency_code !== tx.baseCurrency) {
    throw new ValidationError(`${label} is in ${row.currency_code}. Transfers are between base-currency accounts only.`);
  }
  return row;
}

/** Moves money between two bank or credit card accounts (examples BK8, BK9): Dr to / Cr from on the date. */
export async function createTransfer(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; fromAccountCode: unknown; toAccountCode: unknown; date: unknown; amount: unknown; reference?: unknown },
): Promise<{ created: boolean; transfer: BankTransfer }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const fromCode = parseAccountCodeInput(input.fromAccountCode, "fromAccountCode");
  const toCode = parseAccountCodeInput(input.toAccountCode, "toAccountCode");
  const date = parseIsoDate(input.date, "date");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const amount = toFixedString(dec(parseDecimalInput(input.amount, "amount", { maxScale: scale })), scale);
  const reference = optionalString(input.reference, "reference", { maxLength: 100 });
  const hash = requestHash("bank_transfer", { fromCode: fromCode.toLowerCase(), toCode: toCode.toLowerCase(), date, amount, reference });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id, request_hash from bank_transfers where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "transfer");
    return { created: false, transfer: await getTransfer(tx, earlier.rows[0].id) };
  }
  const from = await transferAccount(tx, fromCode, "fromAccountCode");
  const to = await transferAccount(tx, toCode, "toAccountCode");
  if (from.id === to.id) throw new ValidationError("A transfer needs two different accounts.");
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('bank_transfers', 'id'))::text as id");
  const id = next.rows[0].id;
  const posted = await postJournalBody(
    tx,
    "bank_transfer:post",
    id,
    parseJournalBody(tx, {
      postingDate: date,
      reference: reference ?? `Transfer ${from.code} to ${to.code}`,
      description: `Transfer from ${from.name} to ${to.name}`,
      lines: [
        { accountCode: to.code, debitAmount: amount, creditAmount: "0", description: `From ${from.name}` },
        { accountCode: from.code, debitAmount: "0", creditAmount: amount, description: `To ${to.name}` },
      ],
    }),
    { origin: "bank_transfer" },
  );
  await tx.query(
    `insert into bank_transfers (
       id, command_source, idempotency_key, request_hash, from_account_id, to_account_id, transfer_date, amount,
       currency_code, reference, journal_id, created_by_user_id, created_by_email
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13)`,
    [id, source, idempotencyKey, hash, from.id, to.id, date, amount, tx.baseCurrency, reference, posted.journal.id, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_transfer.posted",
    entityType: "bank_transfer",
    entityId: id,
    details: { from: from.code, to: to.code, date, amount, journalId: posted.journal.id },
  });
  return { created: true, transfer: await getTransfer(tx, id) };
}

/** Voids a transfer (not while either side is reconciled): posts the exact reversal. */
export async function voidTransfer(
  tx: OrgTx,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<{ created: boolean; transfer: BankTransfer }> {
  const id = requireId(idInput, "transferId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const hash = requestHash("bank_transfer_void", { id, voidDate });
  const earlier = await tx.query<{ id: string; hash: string }>(
    "select id, void_request_hash as hash from bank_transfers where void_command_source = $1 and void_idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].hash, hash, "transfer void");
    return { created: false, transfer: await getTransfer(tx, earlier.rows[0].id) };
  }
  const locked = await tx.query("select id from bank_transfers where id = $1 for update", [id]);
  if (locked.rowCount === 0) throw new NotFoundError("Transfer not found.");
  const current = await getTransfer(tx, id);
  if (current.status === "voided") throw new ConflictError("This transfer has already been voided.");
  if (voidDate < current.date) throw new ValidationError(`The void date can't be before the transfer date (${current.date}).`);
  await assertNotReconciled(tx, current.journalId, "This transfer");
  const original = await getJournal(tx, current.journalId);
  const posted = await postJournalBody(
    tx,
    "bank_transfer:void",
    id,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of ${original.description ?? "transfer"}`.slice(0, 500),
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
      })),
    }),
    { origin: "bank_transfer", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  await tx.query(
    `update bank_transfers set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4,
            void_idempotency_key = $5, void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8, voided_at = now()
      where id = $1`,
    [id, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "bank_transfer.voided", entityType: "bank_transfer", entityId: id, details: { voidDate } });
  return { created: true, transfer: await getTransfer(tx, id) };
}

export { getTransfer };

/** Sums line amounts, for callers checking totals before posting. */
export function sumAmounts(amounts: readonly string[]): string {
  return toFixedString(
    amounts.reduce((total, amount) => add(total, dec(amount)), ZERO_DECIMAL),
    2,
  );
}

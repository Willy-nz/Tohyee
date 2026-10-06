import { parseAccountCodeInput } from "@/lib/accounts/service";
import { assertRequiredFields, parseCustomInput, resolveDocumentCustom } from "@/lib/custom-fields/service";
import type { CustomValues } from "@/lib/custom-fields/values";
import { type AccountClass, isBankOrCreditCard, type AccountType } from "@/lib/accounts/types";
import { assertRequiredTags, checkNewTags, hashableLine, loadTrackingContext, parseTrackingInput, sortedTags, type TrackingTags } from "@/lib/tracking/service";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { AMOUNTS_MODES, calculateInvoice, type AmountsMode } from "@/lib/invoices/amounts";
import { controlAccountCode, GST_ACCOUNT } from "@/lib/invoices/service";
import { type AvailableOn, sideRefusal } from "@/lib/tax/available-on";
import { carryingValueOut, convertAtRate, foreignAccountState, impliedRate, revaluationReversedAfter } from "@/lib/ledger/foreign";
import { type ForeignAmount, getJournal, parseExchangeRate, parseJournalBody, postJournalBody, sameForeign } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, isZero, parseDecimalInput, significantScale, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
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
  /** On a foreign-currency account: the line's base-currency amounts (FXB2, FXB3); null otherwise. */
  baseNetAmount: string | null;
  baseTaxAmount: string | null;
  /** Tracking categories (TC10): category id -> value id. */
  tracking: TrackingTags;
  /** Custom field values (CF10), field id -> value. */
  customFields: CustomValues;
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
  /** On a foreign-currency account (FXB2, FXB3): the rate and the total in the base currency; null otherwise. */
  exchangeRate: string | null;
  baseTotal: string | null;
  journalId: string;
  voidDate: string | null;
  voidJournalId: string | null;
  createdByEmail: string | null;
  createdAt: string;
  customFields: CustomValues;
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
  exchange_rate: string | null;
  base_total: string | null;
  journal_id: string;
  void_date: string | null;
  void_journal_id: string | null;
  created_by_email: string | null;
  created_at: string;
  custom_fields: CustomValues;
  lines: Array<
    Omit<BankTransactionLine, "lineAmount" | "netAmount" | "taxAmount" | "baseNetAmount" | "baseTaxAmount"> &
      Record<"lineAmount" | "netAmount" | "taxAmount", string> &
      Record<"baseNetAmount" | "baseTaxAmount", string | null>
  >;
};

const SELECT = `
  select t.id, t.kind, t.status, t.account_id, a.code as account_code, a.name as account_name, t.contact_id,
         c.name as contact_name, t.transaction_date::text, t.reference, t.amounts_mode, t.currency_code,
         t.subtotal::text, t.tax_total::text, t.total::text, t.exchange_rate::text, t.base_total::text,
         t.journal_id, t.void_date::text, t.void_journal_id,
         t.created_by_email, t.created_at, t.custom_fields,
         (select jsonb_agg(jsonb_build_object(
                   'lineOrder', l.line_order, 'description', l.description, 'accountCode', la.code,
                   'accountName', la.name, 'taxCode', tc.code, 'taxRate', l.tax_rate::text,
                   'lineAmount', l.line_amount::text, 'netAmount', l.net_amount::text, 'taxAmount', l.tax_amount::text,
                   'baseNetAmount', l.base_net_amount::text, 'baseTaxAmount', l.base_tax_amount::text,
                   'tracking', l.tracking, 'customFields', l.custom_fields)
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
    exchangeRate: row.exchange_rate === null ? null : toPlainString(dec(row.exchange_rate)),
    baseTotal: row.base_total === null ? null : toFixedString(dec(row.base_total), 2),
    journalId: row.journal_id,
    voidDate: row.void_date,
    voidJournalId: row.void_journal_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    customFields: row.custom_fields ?? {},
    lines: (row.lines ?? []).map((line) => ({
      ...line,
      lineAmount: money(line.lineAmount),
      netAmount: money(line.netAmount),
      taxAmount: money(line.taxAmount),
      baseNetAmount: line.baseNetAmount === null ? null : toFixedString(dec(line.baseNetAmount), 2),
      baseTaxAmount: line.baseTaxAmount === null ? null : toFixedString(dec(line.baseTaxAmount), 2),
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
  expense_claims_payable: "the expense claims payable account (pay the expense claim instead)",
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
  customFields?: unknown;
  /** On a foreign-currency account: base currency per 1 unit (FXB2, FXB3). */
  exchangeRate?: unknown;
};

type ParsedInput = {
  kind: BankTransactionKind;
  accountId: string;
  contactId: string;
  date: string;
  reference: string | null;
  amountsMode: AmountsMode;
  lines: Array<{
    description: string;
    accountCode: string;
    taxCode: string | null;
    amount: string;
    tracking: TrackingTags;
    customFields: Record<string, unknown> | undefined;
  }>;
  customInput: Record<string, unknown> | undefined;
  exchangeRate: string | null;
};

function parseInput(tx: OrgTx, input: BankTransactionInput): ParsedInput {
  // Checked against the account's currency once it's known (resolveInput).
  const scale = 4;
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
        tracking: sortedTags(parseTrackingInput(entry.tracking, label)),
        customFields: parseCustomInput(entry.customFields, `${label}: `),
      };
    }),
    customInput: parseCustomInput(input.customFields, ""),
    exchangeRate: input.exchangeRate == null || input.exchangeRate === "" ? null : parseExchangeRate(input.exchangeRate),
  };
}

type Resolved = ParsedInput & {
  account: { id: string; code: string; name: string };
  /** The account's currency when it isn't the base currency (FXB2-FXB4). */
  foreignCurrency: string | null;
  contactName: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  baseTotal: string | null;
  resolvedLines: Array<{
    description: string;
    accountId: string;
    accountCode: string;
    taxCodeId: string | null;
    taxRate: string;
    lineAmount: string;
    netAmount: string;
    taxAmount: string;
    baseNetAmount: string | null;
    baseTaxAmount: string | null;
    tracking: TrackingTags;
    accountClass: AccountClass;
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
  const foreignCurrency = account.currency_code && account.currency_code !== tx.baseCurrency ? account.currency_code : null;
  if (!foreignCurrency && input.exchangeRate !== null) {
    throw new ValidationError(`${label} is in ${tx.baseCurrency}, so a bank transaction on it has no exchange rate.`);
  }
  if (foreignCurrency && input.exchangeRate === null) {
    throw new ValidationError(
      `${label} is in ${foreignCurrency}. Type the exchange rate (${tx.baseCurrency} per 1 ${foreignCurrency}) to work out the ${tx.baseCurrency} amount.`,
    );
  }
  const amountScale = currencyMinorUnits(foreignCurrency ?? tx.baseCurrency);
  input.lines.forEach((line, index) => {
    if (significantScale(dec(line.amount)) > amountScale) {
      throw new ValidationError(`Line ${index + 1} amount can have at most ${amountScale} decimal places.`);
    }
  });
  const contact = await tx.query<{ name: string; is_archived: boolean }>("select name, is_archived from contacts where id = $1", [
    input.contactId,
  ]);
  if (!contact.rows[0]) throw new ValidationError(`There's no contact #${input.contactId}.`);
  if (contact.rows[0].is_archived) throw new ValidationError(`${contact.rows[0].name} is archived.`);

  const accounts = await tx.query<{
    id: string;
    code: string;
    name: string;
    account_class: AccountClass;
    account_type: string;
    system_key: string | null;
    currency_code: string | null;
    is_active: boolean;
  }>(
    "select id, code, name, account_class, account_type, system_key, currency_code, is_active from accounts where lower(code) = any($1::text[])",
    [[...new Set(input.lines.map((line) => line.accountCode.toLowerCase()))]],
  );
  const byCode = new Map(accounts.rows.map((row) => [row.code.toLowerCase(), row]));
  const taxCodes = await tx.query<{
    id: string;
    code: string;
    rate: string;
    category: string;
    is_active: boolean;
    effective_from: string;
    effective_to: string | null;
    available_on: AvailableOn;
  }>(
    "select id, code, rate, category, is_active, effective_from::text, effective_to::text, available_on from tax_codes where code = any($1::text[])",
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
      // Receive money is sales, spend money purchases (TAO4).
      const offSide = sideRefusal(lineLabel, taxCode.code, taxCode.available_on, input.kind === "receive" ? "sales" : "purchases");
      if (offSide) throw new ValidationError(offSide);
      if (taxCode.effective_from > input.date || (taxCode.effective_to !== null && taxCode.effective_to < input.date)) {
        throw new ValidationError(`${lineLabel}: tax code ${taxCode.code} isn't in effect on ${input.date}.`);
      }
      if (foreignCurrency && taxCode.category === "standard") {
        throw new ValidationError(
          `${lineLabel}: GST on foreign-currency spend and receive money isn't supported yet. Use zero-rated (ZERO), exempt (EXEMPT) or no GST (NONE), or record it in ${tx.baseCurrency}.`,
        );
      }
      taxCodeId = taxCode.id;
      taxRate = toPlainString(dec(taxCode.rate));
    }
    return { ...line, accountId: target.id, accountCode: target.code, accountClass: target.account_class, taxCodeId, taxRate };
  });
  const amounts = calculateInvoice(
    input.amountsMode,
    lines.map((line) => ({ quantity: "1", unitPrice: line.amount, taxRate: line.taxRate })),
    amountScale,
  );
  // Foreign currency (D2): each amount x the rate, rounded once. The lines'
  // base amounts must add up to the total's, or the split is refused (FXB4).
  const baseScale = currencyMinorUnits(tx.baseCurrency);
  const toBase = (amount: string) => convertAtRate(amount, input.exchangeRate!, baseScale);
  const baseTotal = foreignCurrency ? toBase(amounts.total) : null;
  const baseLines = amounts.lines.map((line) =>
    foreignCurrency ? { baseNetAmount: toBase(line.netAmount), baseTaxAmount: toBase(line.taxAmount) } : { baseNetAmount: null, baseTaxAmount: null },
  );
  if (foreignCurrency && baseTotal !== null) {
    const linesTotal = toFixedString(
      baseLines.reduce((total, line) => add(add(total, dec(line.baseNetAmount!)), dec(line.baseTaxAmount!)), ZERO_DECIMAL),
      baseScale,
    );
    if (linesTotal !== baseTotal) {
      throw new ValidationError(
        `At ${input.exchangeRate}, the lines come to ${tx.baseCurrency} ${linesTotal} but the total is ${tx.baseCurrency} ${baseTotal} (${foreignCurrency} ${amounts.total} x ${input.exchangeRate}), because each line is rounded. Record it as one line, or split it so the lines add up.`,
      );
    }
  }
  return {
    ...input,
    account: { id: account.id, code: account.code, name: account.name },
    foreignCurrency,
    contactName: contact.rows[0].name,
    subtotal: amounts.subtotal,
    taxTotal: amounts.taxTotal,
    total: amounts.total,
    baseTotal,
    resolvedLines: lines.map((line, index) => ({
      description: line.description,
      accountId: line.accountId,
      accountCode: line.accountCode,
      taxCodeId: line.taxCodeId,
      taxRate: line.taxRate,
      ...amounts.lines[index],
      ...baseLines[index],
      tracking: line.tracking,
      accountClass: line.accountClass,
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
  const { customInput, exchangeRate, ...hashed } = parsed;
  // Values that weren't sent stay out, so older requests hash the same.
  const hash = requestHash("bank_transaction", {
    ...hashed,
    ...(exchangeRate !== null ? { exchangeRate } : {}),
    ...(customInput !== undefined ? { customFields: customInput } : {}),
    lines: parsed.lines.map(hashableLine),
  });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id, request_hash from bank_transactions where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "bank transaction");
    return { created: false, bankTransaction: await getBankTransaction(tx, earlier.rows[0].id) };
  }
  const resolved = await resolveInput(tx, parsed);
  const tracking = await loadTrackingContext(tx);
  resolved.resolvedLines.forEach((line, index) => checkNewTags(tracking, line.tracking, `Line ${index + 1}`));
  assertRequiredTags(
    tracking,
    resolved.resolvedLines.map((line) => ({ tags: line.tracking, accountClass: line.accountClass })),
  );
  const custom = await resolveDocumentCustom(tx, resolved.kind, parsed.customInput, parsed.lines.map((line) => line.customFields));
  assertRequiredFields(
    custom.ctx,
    resolved.kind,
    custom.body,
    resolved.resolvedLines.map((line, index) => ({ values: custom.lines[index], accountClass: line.accountClass })),
  );
  // At the line's currency's own decimal places (FXB14: JPY 1,000 is "1000", not "1000.00").
  const lineScale = currencyMinorUnits(resolved.foreignCurrency ?? tx.baseCurrency);
  if (options.expectedTotal !== undefined && toFixedString(dec(options.expectedTotal), lineScale) !== resolved.total) {
    throw new ValidationError(
      `The bank transaction comes to ${resolved.total}, but the statement line is ${toFixedString(dec(options.expectedTotal), lineScale)}.`,
    );
  }
  const gst = isZero(dec(resolved.taxTotal)) ? null : await controlAccountCode(tx, GST_ACCOUNT, "bank transactions with GST can't be posted");
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('bank_transactions', 'id'))::text as id");
  const id = next.rows[0].id;
  const spend = resolved.kind === "spend";
  const side = (amount: string) => (spend ? { debitAmount: amount, creditAmount: "0" } : { debitAmount: "0", creditAmount: amount });
  const opposite = (amount: string) => (spend ? { debitAmount: "0", creditAmount: amount } : { debitAmount: amount, creditAmount: "0" });
  // In a foreign currency, every line but the bank's is in the base currency; the bank's has both (FXB2, FXB3).
  const journalLines = resolved.resolvedLines
    .filter((line) => !isZero(dec(line.baseNetAmount ?? line.netAmount)))
    .map(
      (line): { accountCode: string; debitAmount: string; creditAmount: string; description: string; tracking?: TrackingTags; foreign?: ForeignAmount } => ({
        accountCode: line.accountCode,
        ...side(line.baseNetAmount ?? line.netAmount),
        description: line.description,
        tracking: line.tracking,
      }),
    );
  if (gst) journalLines.push({ accountCode: gst, ...side(resolved.taxTotal), description: "GST" });
  journalLines.push({
    accountCode: resolved.account.code,
    ...opposite(resolved.baseTotal ?? resolved.total),
    description: resolved.contactName,
    ...(resolved.foreignCurrency
      ? { foreign: { currencyCode: resolved.foreignCurrency, amount: resolved.total, rate: resolved.exchangeRate!, kind: "rate" as const } }
      : {}),
  });
  const posted = await postJournalBody(
    tx,
    "bank_transaction:post",
    id,
    parseJournalBody(
      tx,
      {
        postingDate: resolved.date,
        reference: resolved.reference ?? `${spend ? "Spend" : "Receive"} ${resolved.contactName}`.slice(0, 100),
        description: `${spend ? "Spend money to" : "Receive money from"} ${resolved.contactName}`,
        lines: journalLines,
      },
      { internal: true },
    ),
    { origin: "bank_transaction" },
  );
  await tx.query(
    `insert into bank_transactions (
       id, command_source, idempotency_key, request_hash, kind, account_id, contact_id, transaction_date, reference,
       amounts_mode, currency_code, subtotal, tax_total, total, journal_id, created_by_user_id, created_by_email, custom_fields,
       exchange_rate, base_total
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, $13::numeric, $14::numeric, $15, $16, $17, $18::jsonb,
               $19::numeric, $20::numeric)`,
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
      resolved.foreignCurrency ?? tx.baseCurrency,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      posted.journal.id,
      tx.actor.userId,
      tx.actor.email,
      JSON.stringify(custom.body),
      resolved.foreignCurrency ? resolved.exchangeRate : null,
      resolved.baseTotal,
    ],
  );
  for (const [index, line] of resolved.resolvedLines.entries()) {
    await tx.query(
      `insert into bank_transaction_lines (
         bank_transaction_id, line_order, description, quantity, unit_price, account_id, tax_code_id, tax_rate,
         line_amount, net_amount, tax_amount, tracking, custom_fields, base_line_amount, base_net_amount, base_tax_amount
       ) values ($1, $2, $3, 1, $4::numeric, $5, $6, $7::numeric, $4::numeric, $8::numeric, $9::numeric, $10::jsonb, $11::jsonb,
                 $12::numeric, $13::numeric, $14::numeric)`,
      [
        id,
        index + 1,
        line.description,
        line.lineAmount,
        line.accountId,
        line.taxCodeId,
        line.taxRate,
        line.netAmount,
        line.taxAmount,
        JSON.stringify(line.tracking),
        JSON.stringify(custom.lines[index]),
        line.baseNetAmount === null ? null : toFixedString(add(dec(line.baseNetAmount), dec(line.baseTaxAmount!)), 2),
        line.baseNetAmount,
        line.baseTaxAmount,
      ],
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
        tracking: line.tracking,
        ...sameForeign(line),
      })),
    }, { internal: true }),
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
  /** What left the from account, in its currency (`currencyCode`). */
  amount: string;
  currencyCode: string;
  /** Between a base-currency and a foreign-currency account (FXB5, FXB6): what arrived, in the to account's currency. */
  toAmount: string | null;
  toCurrencyCode: string | null;
  /** Out of a foreign-currency account: the base value that left at its carrying value, and the realised gain (negative for a loss). */
  carryingAmount: string | null;
  realisedGain: string | null;
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
  currency_code: string;
  to_amount: string | null;
  to_currency_code: string | null;
  carrying_amount: string | null;
  realised_gain: string | null;
  reference: string | null;
  journal_id: string;
  void_date: string | null;
  void_journal_id: string | null;
  created_at: string;
};

const TRANSFER_SELECT = `
  select t.id, t.status, t.from_account_id, f.code as from_code, t.to_account_id, o.code as to_code,
         t.transfer_date::text, t.amount::text, t.currency_code, t.to_amount::text, t.to_currency_code, t.carrying_amount::text,
         t.realised_gain::text, t.reference, t.journal_id, t.void_date::text, t.void_journal_id, t.created_at
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
    amount: toFixedString(dec(row.amount), currencyMinorUnits(row.currency_code)),
    currencyCode: row.currency_code,
    toAmount: row.to_amount === null ? null : toFixedString(dec(row.to_amount), currencyMinorUnits(row.to_currency_code!)),
    toCurrencyCode: row.to_currency_code,
    carryingAmount: row.carrying_amount === null ? null : toFixedString(dec(row.carrying_amount), currencyMinorUnits(tx.baseCurrency)),
    realisedGain: row.realised_gain === null ? null : toFixedString(dec(row.realised_gain), currencyMinorUnits(tx.baseCurrency)),
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

async function transferAccount(
  tx: OrgTx,
  code: string,
  field: string,
): Promise<{ id: string; code: string; name: string; foreignCurrency: string | null }> {
  const result = await tx.query<{ id: string; code: string; name: string; account_type: string; currency_code: string | null; is_active: boolean }>(
    "select id, code, name, account_type, currency_code, is_active from accounts where lower(code) = lower($1)",
    [code],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationError(`${field}: there's no account with the code ${code}.`);
  const label = `Account ${row.code} (${row.name})`;
  if (!isBankOrCreditCard(row.account_type)) throw new ValidationError(`${label} isn't a bank or credit card account.`);
  if (!row.is_active) throw new ValidationError(`${label} is archived.`);
  return { id: row.id, code: row.code, name: row.name, foreignCurrency: row.currency_code && row.currency_code !== tx.baseCurrency ? row.currency_code : null };
}

/**
 * Moves money between two bank or credit card accounts (examples BK8, BK9):
 * Dr to / Cr from on the date. `amount` is what left the from account, in its
 * currency. Between a base-currency account and a foreign-currency one,
 * `toAmount` is what arrived, in the to account's currency (FXB5, FXB6):
 * - into a foreign account, it's booked at the base amount that left (the rate
 *   is stored for information);
 * - out of a foreign account, the foreign amount leaves at its carrying value
 *   (base balance x amount / foreign balance, rounded once; all that's left
 *   takes the whole base balance), and the difference from the base amount
 *   received is a realised gain or loss (FXB5, FXB8).
 * Transfers between two foreign-currency accounts aren't supported yet.
 */
export async function createTransfer(
  tx: OrgTx,
  input: {
    source?: unknown;
    idempotencyKey: unknown;
    fromAccountCode: unknown;
    toAccountCode: unknown;
    date: unknown;
    amount: unknown;
    toAmount?: unknown;
    reference?: unknown;
  },
): Promise<{ created: boolean; transfer: BankTransfer }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const fromCode = parseAccountCodeInput(input.fromAccountCode, "fromAccountCode");
  const toCode = parseAccountCodeInput(input.toAccountCode, "toAccountCode");
  const date = parseIsoDate(input.date, "date");
  const rawAmount = parseDecimalInput(input.amount, "amount", { maxScale: 4 });
  const rawToAmount = input.toAmount == null || input.toAmount === "" ? null : parseDecimalInput(input.toAmount, "toAmount", { maxScale: 4 });
  const reference = optionalString(input.reference, "reference", { maxLength: 100 });
  const hash = requestHash("bank_transfer", {
    fromCode: fromCode.toLowerCase(),
    toCode: toCode.toLowerCase(),
    date,
    // As before for base-currency transfers, so their hashes don't change.
    amount: rawToAmount === null ? toFixedString(dec(rawAmount), currencyMinorUnits(tx.baseCurrency)) : rawAmount,
    reference,
    ...(rawToAmount !== null ? { toAmount: rawToAmount } : {}),
  });
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
  const base = tx.baseCurrency;
  const fixed = (value: string, currency: string, field: string) => {
    const scale = currencyMinorUnits(currency);
    if (significantScale(dec(value)) > scale) throw new ValidationError(`${field} can have at most ${scale} decimal places.`);
    return toFixedString(dec(value), scale);
  };
  const amount = fixed(rawAmount, from.foreignCurrency ?? base, "amount");
  const plan = await planTransfer(tx, { from, to, date, amount, rawToAmount, fixed });
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('bank_transfers', 'id'))::text as id");
  const id = next.rows[0].id;
  const posted = await postJournalBody(
    tx,
    "bank_transfer:post",
    id,
    parseJournalBody(
      tx,
      {
        postingDate: date,
        reference: reference ?? `Transfer ${from.code} to ${to.code}`,
        description: `Transfer from ${from.name} to ${to.name}`,
        lines: plan.lines,
      },
      { internal: true },
    ),
    { origin: "bank_transfer" },
  );
  await tx.query(
    `insert into bank_transfers (
       id, command_source, idempotency_key, request_hash, from_account_id, to_account_id, transfer_date, amount,
       currency_code, reference, journal_id, created_by_user_id, created_by_email, to_currency_code, to_amount,
       carrying_amount, realised_gain
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15::numeric, $16::numeric, $17::numeric)`,
    [
      id,
      source,
      idempotencyKey,
      hash,
      from.id,
      to.id,
      date,
      amount,
      from.foreignCurrency ?? base,
      reference,
      posted.journal.id,
      tx.actor.userId,
      tx.actor.email,
      plan.toAmount === null ? null : to.foreignCurrency ?? base,
      plan.toAmount,
      plan.carryingAmount,
      plan.realisedGain,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_transfer.posted",
    entityType: "bank_transfer",
    entityId: id,
    details: {
      from: from.code,
      to: to.code,
      date,
      amount,
      ...(plan.toAmount !== null ? { toAmount: plan.toAmount, carryingAmount: plan.carryingAmount, realisedGain: plan.realisedGain } : {}),
      journalId: posted.journal.id,
    },
  });
  return { created: true, transfer: await getTransfer(tx, id) };
}

type TransferLine = { accountCode: string; debitAmount: string; creditAmount: string; description: string; foreign?: ForeignAmount };

/** The journal lines for a transfer, and for one across currencies what arrived, its carrying value and the gain (FXB5, FXB6, FXB8). */
async function planTransfer(
  tx: OrgTx,
  args: {
    from: { id: string; code: string; name: string; foreignCurrency: string | null };
    to: { id: string; code: string; name: string; foreignCurrency: string | null };
    date: string;
    amount: string;
    rawToAmount: string | null;
    fixed: (value: string, currency: string, field: string) => string;
  },
): Promise<{ lines: TransferLine[]; toAmount: string | null; carryingAmount: string | null; realisedGain: string | null }> {
  const { from, to, date, amount, rawToAmount, fixed } = args;
  const base = tx.baseCurrency;
  if (!from.foreignCurrency && !to.foreignCurrency) {
    if (rawToAmount !== null && fixed(rawToAmount, base, "toAmount") !== amount) {
      throw new ValidationError(`Both accounts are in ${base}, so the same amount arrives as leaves.`);
    }
    return {
      lines: [
        { accountCode: to.code, debitAmount: amount, creditAmount: "0", description: `From ${from.name}` },
        { accountCode: from.code, debitAmount: "0", creditAmount: amount, description: `To ${to.name}` },
      ],
      toAmount: null,
      carryingAmount: null,
      realisedGain: null,
    };
  }
  if (from.foreignCurrency && to.foreignCurrency) {
    throw new ValidationError(
      `Transfers between two foreign-currency accounts (${from.code} in ${from.foreignCurrency}, ${to.code} in ${to.foreignCurrency}) aren't supported yet. Transfer through a ${base} account.`,
    );
  }
  if (rawToAmount === null) {
    throw new ValidationError(
      from.foreignCurrency
        ? `Give the ${base} amount that arrived in ${to.code} for the ${from.foreignCurrency} ${amount}.`
        : `Give the ${to.foreignCurrency} amount that arrived in ${to.code} for the ${base} ${amount}.`,
    );
  }
  if (to.foreignCurrency) {
    // Into a foreign account (FXB6): booked at the base amount that left.
    const toAmount = fixed(rawToAmount, to.foreignCurrency, "toAmount");
    return {
      lines: [
        {
          accountCode: to.code,
          debitAmount: amount,
          creditAmount: "0",
          description: `From ${from.name}`,
          foreign: { currencyCode: to.foreignCurrency, amount: toAmount, rate: impliedRate(amount, toAmount), kind: "implied" },
        },
        { accountCode: from.code, debitAmount: "0", creditAmount: amount, description: `To ${to.name}` },
      ],
      toAmount,
      carryingAmount: null,
      realisedGain: null,
    };
  }
  // Out of a foreign account (FXB5, FXB8): at its carrying value, the rest a realised gain or loss.
  const currency = from.foreignCurrency!;
  const received = fixed(rawToAmount, base, "toAmount");
  // FXB12: not before a revaluation's reversal, or the unrealised amount would leave as carrying value.
  const revaluation = await revaluationReversedAfter(tx, from.id, date);
  if (revaluation) {
    throw new ValidationError(
      `${from.code} (${from.name}) was revalued on ${revaluation.revaluationDate} (${revaluation.reference}), and that isn't reversed until ${revaluation.reversalPostingDate}. A transfer out dated before then isn't supported: void the revaluation, post the transfer, then revalue again, or date the transfer ${revaluation.reversalPostingDate} or later.`,
    );
  }
  const state = await foreignAccountState(tx, from.id, date);
  if (state.foreignBalance === null) {
    throw new ValidationError(
      state.needsOpeningBalance
        ? `Account ${from.code} (${from.name}) has postings from before Tohyee kept foreign amounts. Enter its ${currency} balance as at a date (its opening foreign balance) first.`
        : `Account ${from.code} (${from.name})'s ${currency} balance on ${date} isn't known (it's before its opening foreign balance).`,
    );
  }
  const carrying = carryingValueOut({ ...state, foreignBalance: state.foreignBalance, currencyCode: currency, code: from.code }, amount);
  if (!(dec(carrying).units > BigInt(0))) {
    throw new ValidationError(`Account ${from.code} has a ${base} balance of ${state.baseBalance} on ${date}, so there's no carrying value to transfer out.`);
  }
  const gain = sub(dec(received), dec(carrying));
  const gainAmount = toFixedString(gain, currencyMinorUnits(base));
  const lines: TransferLine[] = [
    { accountCode: to.code, debitAmount: received, creditAmount: "0", description: `From ${from.name}` },
    {
      accountCode: from.code,
      debitAmount: "0",
      creditAmount: carrying,
      description: `To ${to.name}`,
      foreign: { currencyCode: currency, amount, rate: impliedRate(carrying, amount), kind: "carrying_value" },
    },
  ];
  if (!isZero(gain)) {
    const realised = await tx.query<{ code: string }>("select code from accounts where system_key = 'realised_fx' and is_active");
    if (!realised.rows[0]) {
      throw new ValidationError("There's no active account marked for realised currency gains and losses (7020 in the starting chart).");
    }
    const unsigned = toFixedString(gain.units < BigInt(0) ? { units: -gain.units, scale: gain.scale } : gain, currencyMinorUnits(base));
    lines.push({
      accountCode: realised.rows[0].code,
      debitAmount: gain.units < BigInt(0) ? unsigned : "0",
      creditAmount: gain.units < BigInt(0) ? "0" : unsigned,
      description: `Realised currency ${gain.units < BigInt(0) ? "loss" : "gain"} on ${currency} ${amount}`,
    });
  }
  return { lines, toAmount: received, carryingAmount: carrying, realisedGain: gainAmount };
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
        tracking: line.tracking,
        ...sameForeign(line),
      })),
    }, { internal: true }),
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

import { isBankOrCreditCard } from "@/lib/accounts/types";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { listedRateOn } from "@/lib/fx/rates";
import { getRateSource, missingSetRateReason } from "@/lib/fx/sources";
import { lastRateFor } from "@/lib/ledger/foreign";
import { parseExchangeRate } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, isZero, mul, mulDiv, neg, roundHalfUp, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { convertAtRate } from "@/lib/money/fx";
import { countsWhenSettled } from "@/lib/reports/gst-boxes";
import type { GstBasis } from "@/lib/tax/categories";

/**
 * Foreign-currency invoices, bills and credit notes (examples MC1-MC13),
 * following NetSuite: a contact has a currency (its primary currency), its
 * documents are in it at an exchange rate for their date (the last rate
 * used on or before it, which can be changed), each line is converted to
 * the base currency on its own and rounded once, and accounts receivable or
 * payable holds the document's foreign amount beside its base value. A
 * payment or credit clears the document at its carrying value; the
 * difference from what moved is a realised gain or loss (7020).
 */

export type DocumentKind = "invoice" | "bill" | "credit_note" | "supplier_credit_note";

const DOCUMENT_NOUNS: Record<DocumentKind, string> = {
  invoice: "invoice",
  bill: "bill",
  credit_note: "credit note",
  supplier_credit_note: "supplier credit note",
};

/** The contact's currency: its own, or the base currency when it has none (MC1). */
export async function contactCurrency(tx: OrgTx, contactId: string): Promise<string> {
  const row = (await tx.query<{ currency_code: string | null }>("select currency_code from contacts where id = $1", [contactId])).rows[0];
  return row?.currency_code ?? tx.baseCurrency;
}

/**
 * The exchange rate for a foreign-currency document or payment (MC2, MC3):
 * the one typed, or else the currency exchange rates list's rate effective
 * on the date (MC48), or else the last rate used for the currency on or
 * before the date (like a statement line's, D4; MC49). Null in the base
 * currency, where a typed rate is refused. With no rate to use, it must be
 * typed. With uploaded rate sets as the source, only a set covering the
 * date counts, and the message says which set is missing (FX4, FX5).
 */
export async function exchangeRateFor(
  tx: OrgTx,
  input: { currencyCode: string; date: string; typed: unknown; what: string },
): Promise<string | null> {
  return (await exchangeRateWithSource(tx, input))?.rate ?? null;
}

/**
 * `exchangeRateFor` with where the rate came from, for documents to record
 * (FX4): "Typed" when typed (or `typedSource` when the typed value is the
 * document's own saved rate, so an edit keeps where it came from), else the
 * list entry's source ("ECB", an uploaded set's name, "Exchange rates
 * list") or "Last rate used".
 */
export async function exchangeRateWithSource(
  tx: OrgTx,
  input: { currencyCode: string; date: string; typed: unknown; what: string; typedSource?: string | null },
): Promise<{ rate: string; source: string | null } | null> {
  const blank = input.typed === undefined || input.typed === null || input.typed === "";
  if (input.currencyCode === tx.baseCurrency) {
    if (!blank) throw new ValidationError(`This ${input.what} is in ${tx.baseCurrency}, so it has no exchange rate.`);
    return null;
  }
  if (!blank) return { rate: parseExchangeRate(input.typed, "exchangeRate"), source: input.typedSource === undefined ? "Typed" : input.typedSource };
  const last = await lastRateFor(tx, input.currencyCode, input.date);
  if (!last) {
    if ((await getRateSource(tx)) === "uploaded") {
      throw new ValidationError(
        `Type the exchange rate for this ${input.what} (${tx.baseCurrency} per 1 ${input.currencyCode}). ${await missingSetRateReason(tx, input.currencyCode, input.date)}`,
      );
    }
    throw new ValidationError(
      `Type the exchange rate for this ${input.what} (${tx.baseCurrency} per 1 ${input.currencyCode}): no ${input.currencyCode} rate has been used on or before ${input.date} yet, and the exchange rates list (Accounting › Exchange rates) has none effective by then.`,
    );
  }
  return { rate: last.rate, source: last.source === "list" ? (last.label ?? "Exchange rates list") : "Last rate used" };
}

/**
 * On an edit, where the rate came from when it's still the document's saved
 * rate (sent again unchanged, or not sent): the saved source, so saving a
 * draft doesn't turn an ECB or set rate into "Typed" (FX4). Undefined when
 * the rate changed.
 */
export function keptRateSource(sent: string | null | undefined, savedRate: string | null, savedSource: string | null): string | null | undefined {
  if (sent == null || savedRate === null || cmp(dec(sent), dec(savedRate)) !== 0) return undefined;
  // An older draft's source isn't known (null), and stays unknown rather than guessed.
  return savedSource;
}

/** An exchange rate as sent: undefined when not sent, null when sent blank, else the text. */
export function parseRateInput(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  return parseExchangeRate(input, "exchangeRate");
}

/**
 * What can't be on a foreign-currency document yet (MC11), refused rather
 * than guessed: item lines with a blank price (an item's prices are in the
 * base currency). Standard-rated GST is allowed (MC71-MC80): it's worked out
 * in the document's currency exactly as on a base-currency document, and
 * each line's GST is converted at the document's rate (`convertDocumentLines`).
 * Stock items are allowed (MC29): stock is valued in the base currency, at
 * the document's rate.
 */
export function assertForeignLinesSupported(
  kind: DocumentKind,
  currencyCode: string,
  base: string,
  sent: ReadonlyArray<{ itemId: string | null; unitPrice: string }>,
): void {
  const noun = DOCUMENT_NOUNS[kind];
  sent.forEach((line, index) => {
    if (line.itemId !== null && line.unitPrice === "") {
      throw new ValidationError(
        `Line ${index + 1}: this ${noun} is in ${currencyCode}, and item prices are in ${base}, so type the unit price in ${currencyCode}.`,
      );
    }
  });
}

/**
 * Foreign-currency sales documents while sales count when they're settled
 * (the payments basis) aren't supported yet: which rate the GST return
 * should count a part payment at isn't settled (MC11).
 */
export async function assertForeignSalesBasis(tx: OrgTx, kind: DocumentKind, currencyCode: string): Promise<void> {
  if (currencyCode === tx.baseCurrency || (kind !== "invoice" && kind !== "credit_note")) return;
  const basis = (await tx.query<{ gst_basis: GstBasis }>("select gst_basis from organisation_settings where id = true")).rows[0]?.gst_basis;
  if (basis && countsWhenSettled(basis, "sales")) {
    throw new ValidationError(
      `Foreign-currency ${DOCUMENT_NOUNS[kind]}s aren't supported yet while sales count for GST when they're paid (the payments basis): refused rather than guessed.`,
    );
  }
}

export type BaseAmounts = {
  lines: Array<{ baseNetAmount: string; baseTaxAmount: string }>;
  baseSubtotal: string;
  baseTaxTotal: string;
  baseTotal: string;
};

/**
 * A document's base-currency amounts (MC2, MC4, MC71-MC73): each line's net
 * amount and GST x the rate, rounded once, as NetSuite converts line by line
 * (its base-currency tax is the transaction-currency tax at the
 * transaction's rate). The totals are the sums of the lines, so the
 * journal's receivable (or payable) line is exactly its income (or expense)
 * lines plus its GST line. A cent between that and the foreign total x the
 * rate stays in the document's carrying value, and is rounding (7050) when
 * the document is settled (MC73), never GST.
 */
export function convertDocumentLines(
  lines: ReadonlyArray<{ netAmount: string; taxAmount: string }>,
  rate: string,
  baseScale: number,
): BaseAmounts {
  let subtotal = ZERO_DECIMAL;
  let tax = ZERO_DECIMAL;
  const converted = lines.map((line) => {
    const baseNetAmount = convertAtRate(line.netAmount, rate, baseScale);
    const baseTaxAmount = convertAtRate(line.taxAmount, rate, baseScale);
    subtotal = add(subtotal, dec(baseNetAmount));
    tax = add(tax, dec(baseTaxAmount));
    return { baseNetAmount, baseTaxAmount };
  });
  return {
    lines: converted,
    baseSubtotal: toFixedString(subtotal, baseScale),
    baseTaxTotal: toFixedString(tax, baseScale),
    baseTotal: toFixedString(add(subtotal, tax), baseScale),
  };
}

/**
 * The base value of `amount` (in the document's currency) cleared from an
 * open document: its open base value x amount / its open amount, rounded
 * once; clearing all that's open takes all its open base value (so nothing
 * is left at zero, like FXB8). More than what's open is refused by the
 * caller first.
 */
export function clearedBase(open: { amount: string; base: string }, amount: string, baseScale = 2): string {
  const openAmount = dec(open.amount);
  if (cmp(dec(amount), openAmount) >= 0 || isZero(openAmount)) return toFixedString(dec(open.base), baseScale);
  return toFixedString(mulDiv(dec(open.base), dec(amount), openAmount, baseScale), baseScale);
}

/** The account realised currency gains and losses go to (7020 in the starting chart). */
export async function realisedFxAccountCode(tx: OrgTx): Promise<string> {
  const found = await tx.query<{ code: string }>("select code from accounts where system_key = 'realised_fx' and is_active");
  if (!found.rows[0]) {
    throw new ValidationError(
      "No active account is set up for realised currency gains and losses (7020 in the starting chart), so this can't be posted.",
    );
  }
  return found.rows[0].code;
}

/**
 * The journal lines of a realised gain (credit) or loss (debit), or none
 * when it's 0.00.
 */
export function realisedLines(accountCode: string, gain: string, description: string) {
  const value = dec(gain);
  if (isZero(value)) return [];
  const positive = cmp(value, ZERO_DECIMAL) > 0;
  const amount = toFixedString(positive ? value : { units: -value.units, scale: value.scale }, 2);
  return [
    {
      accountCode,
      debitAmount: positive ? "0" : amount,
      creditAmount: positive ? amount : "0",
      description: `${positive ? "Realised currency gain" : "Realised currency loss"}: ${description}`,
    },
  ];
}

/** The account rounding on settlements goes to (7050 Rounding gains and losses in the starting chart; MC31). */
export async function roundingFxAccountCode(tx: OrgTx): Promise<string> {
  const found = await tx.query<{ code: string }>("select code from accounts where system_key = 'fx_rounding' and is_active");
  if (!found.rows[0]) {
    throw new ValidationError("No active account is set up for rounding gains and losses (7050 in the starting chart), so this can't be posted.");
  }
  return found.rows[0].code;
}

/**
 * A settlement's gain (a loss is negative) split the way NetSuite splits it
 * (MC31-MC45): the realised gain or loss is (the rate of the side debited -
 * the rate of the side credited) x the foreign amount settled, with the full
 * rates, rounded once to cents (NetSuite's "Variance = (Payment FX Rate -
 * Source FX Rate) x Payment"); whatever is left of the whole difference is
 * rounding, for the Rounding Gain/Loss account.
 */
export type GainSplit = { gain: string; realised: string; rounding: string };

export function splitGain(gain: string, amount: string, debitRate: string, creditRate: string, baseScale = 2): GainSplit {
  const realised = roundHalfUp(mul(sub(dec(debitRate), dec(creditRate)), dec(amount)), baseScale);
  return {
    gain: toFixedString(dec(gain), baseScale),
    realised: toFixedString(realised, baseScale),
    rounding: toFixedString(sub(dec(gain), realised), baseScale),
  };
}

/**
 * The journal lines of a settlement's gain or loss (MC31): the realised part
 * on 7020 and any rounding on 7050, each only when it isn't 0.00.
 */
export async function settlementGainLines(tx: OrgTx, split: GainSplit, description: string) {
  const realised = isZero(dec(split.realised)) ? [] : realisedLines(await realisedFxAccountCode(tx), split.realised, description);
  const roundingValue = dec(split.rounding);
  if (isZero(roundingValue)) return realised;
  const positive = cmp(roundingValue, ZERO_DECIMAL) > 0;
  const amount = toFixedString(positive ? roundingValue : neg(roundingValue), 2);
  return [
    ...realised,
    {
      accountCode: await roundingFxAccountCode(tx),
      debitAmount: positive ? "0" : amount,
      creditAmount: positive ? amount : "0",
      description: `${positive ? "Currency rounding gain" : "Currency rounding loss"}: ${description}`,
    },
  ];
}

/**
 * The open (not yet cleared) base value of a foreign-currency document, or
 * of a payment's overpayment, from its settlements (payments, applications
 * and refunds; MC14-MC18).
 */
export async function openBase(tx: OrgTx, kind: DocumentKind | "overpayment", id: string): Promise<string> {
  const sql: Record<DocumentKind | "overpayment", string> = {
    invoice: "select (d.base_total - tohyee_invoice_base_settled(d.id))::text as open from sales_invoices d where d.id = $1",
    bill: "select (d.base_total - tohyee_bill_base_settled(d.id))::text as open from bills d where d.id = $1",
    credit_note: "select (d.base_total - tohyee_credit_note_base_used(d.id))::text as open from sales_credit_notes d where d.id = $1",
    supplier_credit_note:
      "select (d.base_total - tohyee_supplier_credit_note_base_used(d.id))::text as open from supplier_credit_notes d where d.id = $1",
    overpayment:
      "select (coalesce(p.base_overpayment, 0) - tohyee_overpayment_base_used(p.id))::text as open from customer_payments p where p.id = $1",
  };
  const row = (await tx.query<{ open: string | null }>(sql[kind], [id])).rows[0];
  return toFixedString(dec(row?.open ?? "0"), currencyMinorUnits(tx.baseCurrency));
}

/**
 * The bank account money in a foreign currency moves through (MC5, MC16-MC18,
 * MC21, MC30): an active bank or credit card account in that currency or in
 * the base currency. NetSuite expects the payment currency to match the
 * transaction's ("If the account currency is different from the base
 * currency, only bills that use the account currency show in the list"), so
 * a bank account in a third currency is refused.
 */
export async function resolveForeignBankAccount(
  tx: OrgTx,
  code: string,
  currency: string,
  what: { document: string; verb: string },
): Promise<{ id: string; code: string; name: string; currencyCode: string | null }> {
  const result = await tx.query<{ id: string; code: string; name: string; account_type: string; currency_code: string | null; is_active: boolean }>(
    "select id, code, name, account_type, currency_code, is_active from accounts where lower(code) = lower($1)",
    [code],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationError(`There's no account with the code ${code}.`);
  const label = `Account ${row.code} (${row.name})`;
  if (!row.is_active) throw new ValidationError(`${label} is archived, so ${what.verb}.`);
  if (!isBankOrCreditCard(row.account_type)) {
    throw new ValidationError(`${label} isn't a bank account, so ${what.verb}. Choose a bank or credit card account.`);
  }
  const accountCurrency = row.currency_code === tx.baseCurrency ? null : row.currency_code;
  if (accountCurrency !== null && accountCurrency !== currency) {
    throw new ValidationError(thirdCurrencyMessage(label, accountCurrency, currency, what.document, tx.baseCurrency));
  }
  return { id: row.id, code: row.code, name: row.name, currencyCode: accountCurrency };
}

/**
 * Why a bank account in a third currency can't pay a foreign-currency
 * document (MC30), following NetSuite, where the payment is in the
 * transaction's currency and a foreign-currency bank account only pays
 * transactions in its own currency.
 */
export function thirdCurrencyMessage(label: string, accountCurrency: string, currency: string, document: string, base: string): string {
  return (
    `${label} is in ${accountCurrency}, but this ${document} is in ${currency}. Like NetSuite, money for a ${currency} ${document} moves in ${currency}, ` +
    `through a ${currency} or ${base} bank account; paying it from an account in a third currency isn't supported. ` +
    `Transfer the money to a ${currency} or ${base} account first.`
  );
}

export type ForeignRefund = {
  bank: { id: string; code: string; name: string; currencyCode: string | null };
  rate: string;
  /** What moved in the bank account: amount x rate, rounded once. */
  baseAmount: string;
  /** The credit's carrying value of what's refunded. */
  baseCleared: string;
  /** Customer side: carrying value less the bank amount; supplier side: the bank amount less carrying value. */
  gain: string;
  /** The gain split into NetSuite's realised gain ((rate debited - rate credited) x amount, on 7020) and rounding (on 7050; MC31). */
  realised: string;
  rounding: string;
  /** Journal lines: the control account at carrying value, the bank at the rate, and any realised gain or loss. */
  lines: Array<Record<string, unknown>>;
};

/**
 * A refund of foreign-currency credit (MC16-MC18): in the credit's currency at
 * the refund's own rate (typed, or the last rate used), from (or into) a bank
 * account in that currency or the base currency. The control account
 * (receivable or payable) is cleared at the credit's carrying value; the
 * bank moves amount x rate; the difference is a realised gain or loss on
 * 7020, as NetSuite posts realised gain or loss when a transaction settles at
 * a rate other than its own.
 */
export async function foreignRefund(
  tx: OrgTx,
  input: {
    side: "customer" | "supplier";
    currency: string;
    amount: string;
    open: { amount: string; base: string };
    date: string;
    typedRate: unknown;
    bankAccountCode: string;
    controlAccountCode: string;
    creditRate: string;
    document: string;
    label: string;
    description: string;
  },
): Promise<ForeignRefund> {
  const bank = await resolveForeignBankAccount(tx, input.bankAccountCode, input.currency, {
    document: input.document,
    verb: input.side === "customer" ? "refunds can't be paid from it" : "refunds can't be received into it",
  });
  const rate = (await exchangeRateFor(tx, { currencyCode: input.currency, date: input.date, typed: input.typedRate, what: "refund" }))!;
  const baseAmount = convertAtRate(input.amount, rate);
  const baseCleared = clearedBase(input.open, input.amount);
  const customer = input.side === "customer";
  const gain = toFixedString(customer ? sub(dec(baseCleared), dec(baseAmount)) : sub(dec(baseAmount), dec(baseCleared)), 2);
  const bankForeign = bank.currencyCode ? { foreign: { currencyCode: input.currency, amount: input.amount, rate, kind: "rate" as const } } : {};
  const controlForeign = { foreign: { currencyCode: input.currency, amount: input.amount, rate: input.creditRate, kind: "carrying_value" as const } };
  const control = { accountCode: input.controlAccountCode, description: input.description, ...controlForeign };
  const bankLine = { accountCode: bank.code, description: input.description, ...bankForeign };
  const lines = customer
    ? [
        { ...control, debitAmount: baseCleared, creditAmount: "0" },
        { ...bankLine, debitAmount: "0", creditAmount: baseAmount },
      ]
    : [
        { ...bankLine, debitAmount: baseAmount, creditAmount: "0" },
        { ...control, debitAmount: "0", creditAmount: baseCleared },
      ];
  // Customer side: the credit is debited at its own rate and the bank credited at the refund's; supplier side the other way.
  const split = customer ? splitGain(gain, input.amount, input.creditRate, rate) : splitGain(gain, input.amount, rate, input.creditRate);
  const gainLines = await settlementGainLines(tx, split, `${input.label} refunded at ${rate}`);
  return { bank, rate, baseAmount, baseCleared, gain, realised: split.realised, rounding: split.rounding, lines: [...lines, ...gainLines] };
}

/** A refund's foreign-currency fields (MC16-MC18) as read from its row; null for a base-currency refund. */
export function foreignRefundFields(row: {
  exchange_rate: string | null;
  base_amount: string | null;
  base_cleared: string | null;
  realised_gain: string | null;
  rounding_gain: string | null;
}): { exchangeRate: string | null; baseAmount: string | null; baseCleared: string | null; realisedGain: string | null; roundingGain: string | null } {
  const money = (value: string | null) => (value === null ? null : toFixedString(dec(value), 2));
  return {
    exchangeRate: row.exchange_rate === null ? null : toPlainString(dec(row.exchange_rate)),
    baseAmount: money(row.base_amount),
    baseCleared: money(row.base_cleared),
    realisedGain: money(row.realised_gain),
    roundingGain: roundingField(row),
  };
}

/**
 * A settlement's rounding (MC31) as read from its row: 0.00 for a foreign
 * one from before rounding was kept apart (all of it went to 7020), null for
 * a base-currency one.
 */
export function roundingField(row: { realised_gain: string | null; rounding_gain: string | null }): string | null {
  if (row.realised_gain === null) return null;
  return toFixedString(dec(row.rounding_gain ?? "0"), 2);
}

/**
 * A repeating invoice or bill in another currency set to be approved (MC26,
 * MC27, MC51) is approved only when the currency exchange rates list has a
 * rate effective on its date, which it took: a rate someone entered for
 * that time, like NetSuite's Currency Exchange Rates. With only the last
 * rate used in the books (which may be stale), it's left as a draft and the
 * reason shows in the template's history.
 */
export async function assertListedRateForRepeating(
  tx: OrgTx,
  input: { currencyCode: string; date: string; exchangeRate: string | null; document: "invoice" | "bill" },
): Promise<void> {
  if (input.currencyCode === tx.baseCurrency) return;
  const listed = await listedRateOn(tx, input.currencyCode, input.date);
  if (!listed) {
    throw new ValidationError(
      `The exchange rates list has no ${input.currencyCode} rate effective on or before ${input.date}, so this ${input.document} took the last ${input.currencyCode} rate used${input.exchangeRate ? ` (${input.exchangeRate})` : ""}. Check its rate, then approve it; or add rates under Accounting › Exchange rates.`,
    );
  }
}

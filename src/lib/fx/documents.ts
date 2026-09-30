import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { lastRateFor } from "@/lib/ledger/foreign";
import { parseExchangeRate } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, isZero, mulDiv, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { convertAtRate } from "@/lib/money/fx";
import type { ResolvedLineItem } from "@/lib/items/lines";
import { countsWhenSettled } from "@/lib/reports/gst-boxes";
import type { GstBasis, TaxCategory } from "@/lib/tax/categories";

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
 * the one typed, or else the last rate used for the currency on or before
 * the date (like a statement line's, D4). Null in the base currency, where
 * a typed rate is refused. With no rate to use, it must be typed.
 */
export async function exchangeRateFor(
  tx: OrgTx,
  input: { currencyCode: string; date: string; typed: unknown; what: string },
): Promise<string | null> {
  const blank = input.typed === undefined || input.typed === null || input.typed === "";
  if (input.currencyCode === tx.baseCurrency) {
    if (!blank) throw new ValidationError(`This ${input.what} is in ${tx.baseCurrency}, so it has no exchange rate.`);
    return null;
  }
  if (!blank) return parseExchangeRate(input.typed, "exchangeRate");
  const last = await lastRateFor(tx, input.currencyCode, input.date);
  if (!last) {
    throw new ValidationError(
      `Type the exchange rate for this ${input.what} (${tx.baseCurrency} per 1 ${input.currencyCode}): no ${input.currencyCode} rate has been used on or before ${input.date} yet.`,
    );
  }
  return last.rate;
}

/** An exchange rate as sent: undefined when not sent, null when sent blank, else the text. */
export function parseRateInput(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  return parseExchangeRate(input, "exchangeRate");
}

/**
 * What can't be on a foreign-currency document yet (MC11), refused rather
 * than guessed: standard-rated GST (GST on foreign-currency supplies needs
 * the IRD rules settled first), stock items (stock is costed in the base
 * currency), and item lines with a blank price (an item's prices are in the
 * base currency).
 */
export function assertForeignLinesSupported(
  kind: DocumentKind,
  currencyCode: string,
  base: string,
  lines: ReadonlyArray<{ taxCategory: TaxCategory | null; itemType?: ResolvedLineItem["itemType"] }>,
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
  lines.forEach((line, index) => {
    if (line.taxCategory === "standard") {
      throw new ValidationError(
        `Line ${index + 1}: GST on foreign-currency invoices, bills and credit notes isn't supported yet (refused rather than guessed). Use zero-rated (ZERO), exempt (EXEMPT) or no GST (NONE), or raise it in ${base}.`,
      );
    }
    if (line.itemType === "stock" || line.itemType === "kit") {
      throw new ValidationError(
        `Line ${index + 1}: stock items on foreign-currency ${noun}s aren't supported yet (refused rather than guessed): stock is valued in ${base}. Use a line without the item, or raise it in ${base}.`,
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
 * A document's base-currency amounts (MC2, MC4): each line's net amount and
 * GST x the rate, rounded once, as NetSuite converts line by line; the totals
 * are the sums of the lines.
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

/** The open (not yet cleared) base value of a foreign-currency document, from its settlements. */
export async function openBase(tx: OrgTx, kind: DocumentKind, id: string): Promise<string> {
  const sql: Record<DocumentKind, string> = {
    invoice: `select (d.base_total
                 - coalesce((select sum(p.base_cleared) from customer_payments p where p.invoice_id = d.id and p.status = 'active'), 0)
                 - coalesce((select sum(a.invoice_base) from sales_credit_note_applications a where a.invoice_id = d.id and a.status = 'active'), 0))::text as open
                from sales_invoices d where d.id = $1`,
    bill: `select (d.base_total
                 - coalesce((select sum(p.base_cleared) from supplier_payments p where p.bill_id = d.id and p.status = 'active'), 0)
                 - coalesce((select sum(a.bill_base) from supplier_credit_note_applications a where a.bill_id = d.id and a.status = 'active'), 0))::text as open
             from bills d where d.id = $1`,
    credit_note: `select (d.base_total
                 - coalesce((select sum(a.credit_note_base) from sales_credit_note_applications a where a.credit_note_id = d.id and a.status = 'active'), 0))::text as open
                from sales_credit_notes d where d.id = $1`,
    supplier_credit_note: `select (d.base_total
                 - coalesce((select sum(a.credit_note_base) from supplier_credit_note_applications a where a.credit_note_id = d.id and a.status = 'active'), 0))::text as open
                from supplier_credit_notes d where d.id = $1`,
  };
  const row = (await tx.query<{ open: string | null }>(sql[kind], [id])).rows[0];
  return toFixedString(dec(row?.open ?? "0"), currencyMinorUnits(tx.baseCurrency));
}

import { parseAccountCodeInput } from "@/lib/accounts/service";
import { parseSalespersonInput, resolveSalesperson } from "@/lib/salespeople/service";
import { assertRequiredFields, type CustomFieldContext, keptCustom, parseCustomInput, resolveDocumentCustom } from "@/lib/custom-fields/service";
import { type CustomValues, customValuesKey } from "@/lib/custom-fields/values";
import type { AccountClass } from "@/lib/accounts/types";
import { assertRequiredTags, checkNewTags, hashableLine, keptValues, loadTrackingContext, parseTrackingInput, sortedTags, trackingKey, type TrackingTags } from "@/lib/tracking/service";
import { writeAuditEvent } from "@/lib/audit";
import { planDocumentStock, planDocumentVoid } from "@/lib/inventory/stock";
import { fillLinesFromItems, isBlank, LINE_ITEM_COLUMNS, LINE_ITEM_JOINS, lineForHash, lineItemFields, type LineItemFields, type LineItemRef, type LineItemRow, parseLineItem, resolveLineItems, type ResolvedLineItem } from "@/lib/items/lines";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import {
  AMOUNTS_MODES,
  calculateInvoice,
  creditNoteCreditStatus,
  type AmountsMode,
  type CreditStatus,
} from "@/lib/invoices/amounts";
import { controlAccountCode, GST_ACCOUNT, RECEIVABLE_ACCOUNT, setBaseLineAmounts } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody, sameForeign } from "@/lib/ledger/journals";
import {
  assertForeignLinesSupported,
  assertForeignSalesBasis,
  contactCurrency,
  convertDocumentLines,
  exchangeRateFor,
  parseRateInput,
} from "@/lib/fx/documents";
import type { TaxCategory } from "@/lib/tax/categories";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { currencyMinorUnits } from "@/lib/money/currency";
import {
  add,
  dec,
  isZero,
  sub,
  parseDecimalInput,
  toFixedString,
  toPlainString,
  ZERO_DECIMAL,
  type Decimal,
} from "@/lib/money/decimal";
import {
  asRecord,
  optionalBoolean,
  optionalId,
  optionalSource,
  optionalString,
  requireArray,
  requireId,
  requireIdempotencyKey,
  requireOneOf,
  requireString,
} from "@/lib/validation";
import { removeRecordExtras } from "@/lib/records/extras";

/**
 * Sales credit notes. A draft can be edited and deleted and posts nothing.
 * Approving gives it the next number (CN-0001, ...) and posts its journal,
 * Dr each line's account and GST / Cr accounts receivable; after that it
 * can't change, only be voided, which posts the exact reversal. Lines follow
 * the invoice rules and maths (`@/lib/invoices/amounts`). Approved credit is
 * applied to invoices in `@/lib/credit-notes/applications` and refunded in
 * `@/lib/credit-notes/refunds` (examples CN1-CN12).
 */
export const CREDIT_NOTE_STATUSES = ["draft", "approved", "voided"] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];

export type CreditNoteLine = LineItemFields & {
  lineOrder: number;
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  taxCodeId: string | null;
  taxCode: string | null;
  /** The tax code's rate when the line was saved, as a fraction (0.15). */
  taxRate: string;
  lineAmount: string;
  netAmount: string;
  taxAmount: string;
  /** Tracking categories (TC4, TC10): category id -> value id. */
  tracking: TrackingTags;
  customFields: CustomValues;
  /** On a foreign-currency credit note: the net amount and GST in the base currency (MC7); null otherwise. */
  baseNetAmount: string | null;
  baseTaxAmount: string | null;
};

export type CreditNoteSummary = {
  id: string;
  status: CreditNoteStatus;
  creditNoteNumber: string | null;
  contactId: string;
  contactName: string;
  creditNoteDate: string;
  reference: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  /** Base currency per 1 unit of the credit note's currency; null for a base-currency credit note (MC7). */
  exchangeRate: string | null;
  baseSubtotal: string | null;
  baseTaxTotal: string | null;
  baseTotal: string | null;
  /** On an approved foreign-currency credit note: the base value of the credit left, at its rate. */
  remainingCreditBase: string | null;
  /** The sum of the credit note's active applications to invoices. */
  amountApplied: string;
  /** The sum of the credit note's active refunds. */
  amountRefunded: string;
  /** What's left to apply or refund on an approved credit note; null for drafts and voided credit notes. */
  remainingCredit: string | null;
  /** Worked out from its active applications and refunds; null for drafts and voided credit notes. */
  creditStatus: CreditStatus | null;
  approvalJournalId: string | null;
  approvedAt: string | null;
  approvedByEmail: string | null;
  voidDate: string | null;
  voidJournalId: string | null;
  voidedAt: string | null;
  voidedByEmail: string | null;
  createdByEmail: string | null;
  /** Custom field values (CF4), field id -> value. */
  customFields: CustomValues;
  /** The salesperson (SR1), or null. */
  salespersonId: string | null;
  salespersonName: string | null;
  /** The approved invoice stock on this credit note came from (ST5), restocked at that sale's cost. */
  returnInvoiceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreditNote = CreditNoteSummary & { lines: CreditNoteLine[] };

/** What a person enters. An edit leaves out anything it doesn't change; `lines` replaces every line. */
export type CreditNoteInput = {
  contactId?: unknown;
  creditNoteDate?: unknown;
  reference?: unknown;
  amountsMode?: unknown;
  lines?: unknown;
  customFields?: unknown;
  salespersonId?: unknown;
  returnInvoiceId?: unknown;
  /** For a customer in another currency: base currency per 1 unit (MC7). Left out, the last rate used is taken. */
  exchangeRate?: unknown;
};

const MAX_LINES = 200;
/** Quantities and unit prices allow up to 4 decimal places, as on invoices. */
const LINE_INPUT_SCALE = 4;

type CreditNoteRow = {
  id: string;
  status: CreditNoteStatus;
  credit_note_number: string | null;
  contact_id: string;
  contact_name: string;
  credit_note_date: string;
  reference: string | null;
  amounts_mode: AmountsMode;
  currency_code: string;
  subtotal: string;
  tax_total: string;
  total: string;
  amount_applied: string;
  amount_refunded: string;
  exchange_rate: string | null;
  base_subtotal: string | null;
  base_tax_total: string | null;
  base_total: string | null;
  base_applied: string;
  approval_journal_id: string | null;
  approved_at: string | null;
  approved_by_email: string | null;
  void_date: string | null;
  void_journal_id: string | null;
  voided_at: string | null;
  voided_by_email: string | null;
  created_by_email: string | null;
  custom_fields: CustomValues;
  salesperson_id: string | null;
  return_invoice_id: string | null;
  salesperson_name: string | null;
  created_at: string;
  updated_at: string;
};

const SUMMARY_COLUMNS = `n.id, n.status, n.credit_note_number, n.contact_id, c.name as contact_name, n.credit_note_date,
  n.reference, n.amounts_mode, n.currency_code, n.subtotal, n.tax_total, n.total, applied.amount_applied,
  refunded.amount_refunded, n.approval_journal_id, n.approved_at, n.approved_by_email, n.void_date, n.void_journal_id,
  n.voided_at, n.voided_by_email, n.created_by_email, n.created_at, n.updated_at, n.custom_fields,
  n.salesperson_id, sp.name as salesperson_name, n.return_invoice_id,
  n.exchange_rate::text, n.base_subtotal::text, n.base_tax_total::text, n.base_total::text, applied.base_applied::text`;

/** Credit notes with their customer and the sums of their active applications and refunds. */
const SUMMARY_FROM = `sales_credit_notes n
  join contacts c on c.id = n.contact_id
  left join salespeople sp on sp.id = n.salesperson_id
  cross join lateral (
    -- The base value used includes refunds' (MC17).
    select coalesce(sum(a.amount), 0) as amount_applied, tohyee_credit_note_base_used(n.id) as base_applied
      from sales_credit_note_applications a
     where a.credit_note_id = n.id and a.status = 'active'
  ) applied
  cross join lateral (
    select coalesce(sum(r.amount), 0) as amount_refunded
      from sales_credit_note_refunds r
     where r.credit_note_id = n.id and r.status = 'active'
  ) refunded`;

type LineRow = LineItemRow & {
  line_order: number;
  description: string;
  quantity: string;
  unit_price: string;
  account_id: string;
  account_code: string;
  account_name: string;
  tax_code_id: string | null;
  tax_code: string | null;
  tax_rate: string;
  line_amount: string;
  net_amount: string;
  tax_amount: string;
  tracking: TrackingTags;
  custom_fields: CustomValues;
  base_net_amount: string | null;
  base_tax_amount: string | null;
};

const baseMoney = (value: string | null) => (value === null ? null : toFixedString(dec(value), 2));

function toSummary(row: CreditNoteRow): CreditNoteSummary {
  const credit = creditNoteCreditStatus(
    row.total,
    row.amount_applied,
    row.amount_refunded,
    currencyMinorUnits(row.currency_code),
  );
  const approved = row.status === "approved";
  return {
    id: row.id,
    status: row.status,
    creditNoteNumber: row.credit_note_number,
    contactId: row.contact_id,
    contactName: row.contact_name,
    creditNoteDate: row.credit_note_date,
    reference: row.reference,
    amountsMode: row.amounts_mode,
    currencyCode: row.currency_code,
    subtotal: row.subtotal,
    taxTotal: row.tax_total,
    total: row.total,
    exchangeRate: row.exchange_rate === null ? null : toPlainString(dec(row.exchange_rate)),
    baseSubtotal: baseMoney(row.base_subtotal),
    baseTaxTotal: baseMoney(row.base_tax_total),
    baseTotal: baseMoney(row.base_total),
    remainingCreditBase: approved && row.base_total !== null ? toFixedString(sub(dec(row.base_total), dec(row.base_applied)), 2) : null,
    amountApplied: credit.amountApplied,
    amountRefunded: credit.amountRefunded,
    remainingCredit: approved ? credit.remainingCredit : null,
    creditStatus: approved ? credit.creditStatus : null,
    approvalJournalId: row.approval_journal_id,
    approvedAt: row.approved_at,
    approvedByEmail: row.approved_by_email,
    voidDate: row.void_date,
    voidJournalId: row.void_journal_id,
    voidedAt: row.voided_at,
    voidedByEmail: row.voided_by_email,
    createdByEmail: row.created_by_email,
    customFields: row.custom_fields ?? {},
    salespersonId: row.salesperson_id,
    returnInvoiceId: row.return_invoice_id,
    salespersonName: row.salesperson_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLine(row: LineRow): CreditNoteLine {
  return {
    ...lineItemFields(row),
    lineOrder: row.line_order,
    description: row.description,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    taxCodeId: row.tax_code_id,
    taxCode: row.tax_code,
    taxRate: row.tax_rate,
    lineAmount: row.line_amount,
    netAmount: row.net_amount,
    taxAmount: row.tax_amount,
    tracking: row.tracking ?? {},
    customFields: row.custom_fields ?? {},
    baseNetAmount: baseMoney(row.base_net_amount),
    baseTaxAmount: baseMoney(row.base_tax_amount),
  };
}

/** A draft as entered, validated but not yet checked against the organisation's data. */
type DraftDetails = {
  contactId: string;
  creditNoteDate: string;
  reference: string | null;
  amountsMode: AmountsMode;
  lines: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    accountCode: string;
    taxCode: string | null;
    tracking: TrackingTags;
    customFields: Record<string, unknown> | undefined;
    itemId: string | null;
    unitId: string | null;
  }>;
  customInput: Record<string, unknown> | undefined;
  /** As sent: undefined when not sent (the customer's default applies), null for none. */
  salespersonInput: string | null | undefined;
  returnInvoiceId: string | null;
  /** As sent: undefined or null when not given (a foreign-currency credit note then takes the last rate used). */
  exchangeRateInput?: string | null;
};

/** A draft checked against the chart of accounts, tax codes and contacts, with its amounts. */
type ResolvedDraft = DraftDetails & {
  contactName: string;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  exchangeRate: string | null;
  baseSubtotal: string | null;
  baseTaxTotal: string | null;
  baseTotal: string | null;
  customFields: CustomValues;
  customCtx: CustomFieldContext;
  salespersonId: string | null;
  resolvedLines: Array<ResolvedLineItem & {
    description: string;
    quantity: string;
    unitPrice: string;
    accountId: string;
    accountCode: string;
    taxCodeId: string | null;
    taxRate: string;
    lineAmount: string;
    netAmount: string;
    taxAmount: string;
    tracking: TrackingTags;
    accountClass: AccountClass;
    customFields: CustomValues;
    baseNetAmount: string | null;
    baseTaxAmount: string | null;
  }>;
};

function parseDraft(input: CreditNoteInput): DraftDetails {
  const contactId = requireId(input.contactId, "contactId");
  const creditNoteDate = parseIsoDate(input.creditNoteDate, "creditNoteDate");
  const reference = optionalString(input.reference, "reference", { maxLength: 100 });
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  const rawLines = requireArray(input.lines, "lines", MAX_LINES);
  if (rawLines.length === 0) {
    throw new ValidationError("A credit note needs at least one line.");
  }
  const lines = rawLines.map((raw, index) => {
    const label = `Line ${index + 1}`;
    const line = asRecord(raw, label);
    // A line with an item can leave these blank: the item fills them (IT2).
    const item = parseLineItem(line, label);
    const fillable = item.itemId !== null;
    const taxCode = optionalString(line.taxCode, `${label} tax code`, { maxLength: 20 })?.toUpperCase() ?? null;
    if (amountsMode === "no_tax" && taxCode !== null) {
      throw new ValidationError(
        `${label} has a tax code, but the credit note's amounts have no tax. Remove the tax code or change the amounts to tax exclusive or inclusive.`,
      );
    }
    if (amountsMode !== "no_tax" && taxCode === null && !fillable) {
      throw new ValidationError(`${label} needs a tax code (use a zero-rated code for sales without GST).`);
    }
    return {
      description: fillable && isBlank(line.description) ? "" : requireString(line.description, `${label} description`, { maxLength: 500 }),
      quantity: parseDecimalInput(line.quantity, `${label} quantity`, { maxScale: LINE_INPUT_SCALE }),
      unitPrice: fillable && isBlank(line.unitPrice) ? "" : parseDecimalInput(line.unitPrice, `${label} unit price`, { maxScale: LINE_INPUT_SCALE }),
      accountCode: fillable && isBlank(line.accountCode) ? "" : parseAccountCodeInput(line.accountCode, `${label} account`),
      ...item,
      taxCode,
      tracking: sortedTags(parseTrackingInput(line.tracking, label)),
      customFields: parseCustomInput(line.customFields, `${label}: `),
    };
  });
  return {
    contactId,
    creditNoteDate,
    reference,
    amountsMode,
    lines,
    customInput: parseCustomInput(input.customFields, ""),
    salespersonInput: parseSalespersonInput(input.salespersonId),
    returnInvoiceId: optionalId(input.returnInvoiceId, "returnInvoiceId"),
    exchangeRateInput: parseRateInput(input.exchangeRate),
  };
}

/** Normalised content for the idempotency fingerprint. */
function hashPayload(draft: DraftDetails): Record<string, unknown> {
  return {
    contactId: draft.contactId,
    creditNoteDate: draft.creditNoteDate,
    reference: draft.reference,
    amountsMode: draft.amountsMode,
    lines: draft.lines.map((line) => hashableLine(lineForHash({ ...line, accountCode: line.accountCode.toLowerCase() }))),
    // Values that weren't sent stay out, so older requests hash the same.
    ...(draft.customInput !== undefined ? { customFields: draft.customInput } : {}),
    ...(draft.salespersonInput !== undefined ? { salespersonId: draft.salespersonInput } : {}),
    ...(draft.returnInvoiceId !== null ? { returnInvoiceId: draft.returnInvoiceId } : {}),
    ...(draft.exchangeRateInput != null ? { exchangeRate: draft.exchangeRateInput } : {}),
  };
}

/**
 * Checks a draft against the organisation's data and works out its amounts,
 * with the same rules as an invoice. Run when a draft is saved and again when
 * it's approved: the customer must be an active contact marked as a
 * customer, each line's account an active revenue account, and each tax code
 * active and in effect on the credit note date.
 */
async function resolveDraft(
  tx: OrgTx,
  sent: DraftDetails,
  kept: ReadonlySet<string> = new Set(),
  keptFields: ReadonlySet<string> = new Set(),
  keptSalesperson: string | null = null,
  keptItems: ReadonlyArray<LineItemRef> = [],
): Promise<ResolvedDraft> {
  // A customer in another currency gets credit notes in it (MC7).
  const currencyCode = await contactCurrency(tx, sent.contactId);
  if (currencyCode !== tx.baseCurrency) {
    assertForeignLinesSupported("credit_note", currencyCode, tx.baseCurrency, sent.lines);
  }
  // Blanks on item lines are filled from the item (IT2); what was sent is kept.
  const draft: DraftDetails = { ...sent, lines: await fillLinesFromItems(tx, sent.lines, { side: "sale", contactId: sent.contactId, noTax: sent.amountsMode === "no_tax" }) };
  const salesperson = await resolveSalesperson(tx, draft.salespersonInput, { contactId: draft.contactId, kept: keptSalesperson });
  const custom = await resolveDocumentCustom(tx, "credit_note", draft.customInput, draft.lines.map((line) => line.customFields), keptFields);
  const tracking = await loadTrackingContext(tx);
  draft.lines.forEach((line, index) => checkNewTags(tracking, line.tracking, `Line ${index + 1}`, kept));
  const contact = await tx.query<{ name: string; is_customer: boolean; is_archived: boolean }>(
    "select name, is_customer, is_archived from contacts where id = $1",
    [draft.contactId],
  );
  const customer = contact.rows[0];
  if (!customer) {
    throw new ValidationError(`There's no contact #${draft.contactId}.`);
  }
  if (customer.is_archived) {
    throw new ValidationError(`${customer.name} is archived. Unarchive them first, or pick another customer.`);
  }
  if (!customer.is_customer) {
    throw new ValidationError(`${customer.name} isn't marked as a customer. Edit the contact first, or pick another one.`);
  }

  const accounts = await tx.query<{ id: string; code: string; name: string; account_class: string; is_active: boolean }>(
    "select id, code, name, account_class, is_active from accounts where lower(code) = any($1::text[])",
    [[...new Set(draft.lines.map((line) => line.accountCode.toLowerCase()))]],
  );
  const accountsByCode = new Map(accounts.rows.map((row) => [row.code.toLowerCase(), row]));

  const wantedTaxCodes = [...new Set(draft.lines.flatMap((line) => (line.taxCode ? [line.taxCode] : [])))];
  const taxCodes = await tx.query<{
    id: string;
    code: string;
    rate: string;
    category: TaxCategory;
    is_active: boolean;
    effective_from: string;
    effective_to: string | null;
  }>("select id, code, rate, category, is_active, effective_from, effective_to from tax_codes where code = any($1::text[])", [
    wantedTaxCodes,
  ]);
  const taxCodesByCode = new Map(taxCodes.rows.map((row) => [row.code, row]));

  const lines = draft.lines.map((line, index) => {
    const label = `Line ${index + 1}`;
    const account = accountsByCode.get(line.accountCode.toLowerCase());
    if (!account) {
      throw new ValidationError(`${label}: there's no account with the code ${line.accountCode}.`);
    }
    if (!account.is_active) {
      throw new ValidationError(`${label}: account ${account.code} (${account.name}) is archived.`);
    }
    if (account.account_class !== "revenue") {
      throw new ValidationError(
        `${label}: account ${account.code} (${account.name}) isn't a revenue account. Credit note lines go to revenue accounts, like Sales.`,
      );
    }
    let taxCodeId: string | null = null;
    let taxRate = "0";
    let taxCategory: TaxCategory | null = null;
    if (line.taxCode !== null) {
      const taxCode = taxCodesByCode.get(line.taxCode);
      if (!taxCode) {
        throw new ValidationError(`${label}: there's no tax code ${line.taxCode}.`);
      }
      if (!taxCode.is_active) {
        throw new ValidationError(`${label}: tax code ${taxCode.code} is inactive.`);
      }
      if (
        taxCode.effective_from > draft.creditNoteDate ||
        (taxCode.effective_to !== null && taxCode.effective_to < draft.creditNoteDate)
      ) {
        throw new ValidationError(
          `${label}: tax code ${taxCode.code} isn't in effect on ${draft.creditNoteDate} (it applies from ${taxCode.effective_from}${
            taxCode.effective_to ? ` to ${taxCode.effective_to}` : ""
          }).`,
        );
      }
      taxCodeId = taxCode.id;
      taxRate = toPlainString(dec(taxCode.rate));
      taxCategory = taxCode.category;
    }
    return { ...line, accountId: account.id, accountCode: account.code, accountClass: account.account_class as AccountClass, taxCodeId, taxRate, taxCategory };
  });

  const lineItems = await resolveLineItems(tx, draft.lines, "sale", keptItems);
  const scale = currencyMinorUnits(currencyCode);
  const amounts = calculateInvoice(draft.amountsMode, lines, scale);
  amounts.lines.forEach((line, index) => {
    if (isZero(dec(line.lineAmount))) {
      throw new ValidationError(
        `Line ${index + 1} comes to ${line.lineAmount} once rounded to ${currencyCode}. Check its quantity and unit price.`,
      );
    }
  });
  // A foreign-currency credit note (MC7): as a foreign-currency invoice.
  let exchangeRate: string | null = null;
  let base: ReturnType<typeof convertDocumentLines> | null = null;
  if (currencyCode !== tx.baseCurrency) {
    await assertForeignSalesBasis(tx, "credit_note", currencyCode);
    exchangeRate = await exchangeRateFor(tx, { currencyCode, date: draft.creditNoteDate, typed: draft.exchangeRateInput, what: "credit note" });
    base = convertDocumentLines(amounts.lines, exchangeRate!, currencyMinorUnits(tx.baseCurrency));
  }

  return {
    ...draft,
    customFields: custom.body,
    customCtx: custom.ctx,
    salespersonId: salesperson.id,
    contactName: customer.name,
    currencyCode,
    subtotal: amounts.subtotal,
    taxTotal: amounts.taxTotal,
    total: amounts.total,
    exchangeRate,
    baseSubtotal: base?.baseSubtotal ?? null,
    baseTaxTotal: base?.baseTaxTotal ?? null,
    baseTotal: base?.baseTotal ?? null,
    resolvedLines: lines.map((line, index) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      accountCode: line.accountCode,
      taxCodeId: line.taxCodeId,
      taxRate: line.taxRate,
      ...amounts.lines[index],
      ...lineItems[index],
      tracking: line.tracking,
      accountClass: line.accountClass,
      customFields: custom.lines[index],
      baseNetAmount: base?.lines[index].baseNetAmount ?? null,
      baseTaxAmount: base?.lines[index].baseTaxAmount ?? null,
    })),
  };
}

type StoredLine = {
  itemId: string | null;
  unitId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxCodeId: string | null;
  taxRate: string;
  lineAmount: string;
  netAmount: string;
  taxAmount: string;
  tracking: TrackingTags;
  customFields: CustomValues;
};

type StoredHeader = {
  contactId: string;
  creditNoteDate: string;
  reference: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  customFields: CustomValues;
  salespersonId: string | null;
  returnInvoiceId: string | null;
  exchangeRate: string | null;
  baseTotal: string | null;
};

const plain = (value: string) => toPlainString(dec(value));

/** What's stored for a draft's header and lines, to tell whether an edit changed anything. */
function headerState(creditNote: StoredHeader): string {
  return JSON.stringify([
    creditNote.contactId,
    creditNote.creditNoteDate,
    creditNote.reference,
    creditNote.amountsMode,
    creditNote.currencyCode,
    plain(creditNote.subtotal),
    plain(creditNote.taxTotal),
    plain(creditNote.total),
    customValuesKey(creditNote.customFields),
    creditNote.salespersonId,
    creditNote.returnInvoiceId,
    creditNote.exchangeRate === null ? null : plain(creditNote.exchangeRate),
    creditNote.baseTotal === null ? null : plain(creditNote.baseTotal),
  ]);
}

function linesState(lines: readonly StoredLine[]): string {
  return JSON.stringify(
    lines.map((line) => [
      line.description,
      plain(line.quantity),
      plain(line.unitPrice),
      line.accountId,
      line.taxCodeId,
      plain(line.taxRate),
      plain(line.lineAmount),
      plain(line.netAmount),
      plain(line.taxAmount),
      trackingKey(line.tracking),
      customValuesKey(line.customFields),
      line.itemId ?? null,
      line.unitId ?? null,
    ]),
  );
}

function sameAsStored(resolved: ResolvedDraft, current: CreditNote): { header: boolean; lines: boolean } {
  return {
    header: headerState(resolved) === headerState(current),
    lines: linesState(resolved.resolvedLines) === linesState(current.lines),
  };
}

/** The saved draft, in the shape a person would send it. */
function draftOf(creditNote: CreditNote): DraftDetails {
  return {
    contactId: creditNote.contactId,
    creditNoteDate: creditNote.creditNoteDate,
    reference: creditNote.reference,
    amountsMode: creditNote.amountsMode,
    lines: creditNote.lines.map((line) => ({
      description: line.description,
      quantity: toPlainString(dec(line.quantity)),
      unitPrice: toPlainString(dec(line.unitPrice)),
      accountCode: line.accountCode,
      taxCode: line.taxCode,
      tracking: line.tracking,
      customFields: line.customFields,
      itemId: line.itemId,
      unitId: line.unitId,
    })),
    customInput: creditNote.customFields,
    salespersonInput: creditNote.salespersonId,
    returnInvoiceId: creditNote.returnInvoiceId,
    exchangeRateInput: creditNote.exchangeRate,
  };
}

async function insertLines(tx: OrgTx, creditNoteId: string, lines: ResolvedDraft["resolvedLines"]): Promise<void> {
  const values: unknown[] = [];
  const tuples = lines.map((line, index) => {
    values.push(
      creditNoteId,
      index + 1,
      line.description,
      line.quantity,
      line.unitPrice,
      line.accountId,
      line.taxCodeId,
      line.taxRate,
      line.lineAmount,
      line.netAmount,
      line.taxAmount,
      JSON.stringify(line.tracking),
      JSON.stringify(line.customFields),
      line.itemId,
      line.unitId,
      line.baseQuantity,
    );
    const base = index * 16;
    const p = (offset: number) => `$${base + offset}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}::numeric, ${p(5)}::numeric, ${p(6)}, ${p(7)}, ${p(8)}::numeric, ${p(9)}::numeric, ${p(10)}::numeric, ${p(11)}::numeric, ${p(12)}::jsonb, ${p(13)}::jsonb, ${p(14)}, ${p(15)}, ${p(16)}::numeric)`;
  });
  await tx.query(
    `insert into sales_credit_note_lines (credit_note_id, line_order, description, quantity, unit_price, account_id,
                                          tax_code_id, tax_rate, line_amount, net_amount, tax_amount, tracking, custom_fields, item_id, unit_id, base_quantity)
     values ${tuples.join(", ")}`,
    values,
  );
  await setBaseLineAmounts(tx, "sales_credit_note_lines", "credit_note_id", creditNoteId, lines);
}

const KEY_COLUMNS = {
  create: { source: "command_source", key: "idempotency_key", hash: "request_hash" },
  approve: { source: "approve_command_source", key: "approve_idempotency_key", hash: "approve_request_hash" },
  void: { source: "void_command_source", key: "void_idempotency_key", hash: "void_request_hash" },
} as const;

async function findByKey(
  tx: OrgTx,
  command: keyof typeof KEY_COLUMNS,
  source: string,
  idempotencyKey: string,
): Promise<{ id: string; hash: string } | null> {
  const columns = KEY_COLUMNS[command];
  const result = await tx.query<{ id: string; hash: string }>(
    `select id, ${columns.hash} as hash from sales_credit_notes where ${columns.source} = $1 and ${columns.key} = $2`,
    [source, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

export function creditNoteLabel(creditNote: CreditNoteSummary): string {
  return creditNote.creditNoteNumber ? `Credit note ${creditNote.creditNoteNumber}` : `Draft credit note #${creditNote.id}`;
}

export async function getCreditNote(tx: OrgTx, creditNoteIdInput: unknown): Promise<CreditNote> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const result = await tx.query<CreditNoteRow>(`select ${SUMMARY_COLUMNS} from ${SUMMARY_FROM} where n.id = $1`, [
    creditNoteId,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Credit note not found.");
  }
  const lines = await tx.query<LineRow>(
    `select l.line_order, l.description, l.quantity, l.unit_price, l.account_id, a.code as account_code,
            a.name as account_name, l.tax_code_id, t.code as tax_code, l.tax_rate, l.line_amount,
            l.net_amount, l.tax_amount, l.tracking, l.custom_fields, ${LINE_ITEM_COLUMNS},
            l.base_net_amount::text, l.base_tax_amount::text
       from sales_credit_note_lines l
       join accounts a on a.id = l.account_id
       left join tax_codes t on t.id = l.tax_code_id
       ${LINE_ITEM_JOINS}
      where l.credit_note_id = $1
      order by l.line_order`,
    [creditNoteId],
  );
  return { ...toSummary(row), lines: lines.rows.map(toLine) };
}

/** Loads a credit note and locks it until the transaction ends. */
export async function lockCreditNote(tx: OrgTx, creditNoteId: string): Promise<CreditNote> {
  const locked = await tx.query("select id from sales_credit_notes where id = $1 for update", [creditNoteId]);
  if (locked.rowCount === 0) {
    throw new NotFoundError("Credit note not found.");
  }
  return getCreditNote(tx, creditNoteId);
}

function assertDraft(creditNote: CreditNote, action: "edited" | "deleted"): void {
  if (creditNote.status !== "draft") {
    throw new ConflictError(
      `${creditNoteLabel(creditNote)} is ${creditNote.status}, so it can't be ${action}.${
        creditNote.status === "approved" ? " Void it instead." : ""
      }`,
    );
  }
}

/**
 * Newest first, 50 at a time; `status` filters, `contactId` keeps one
 * customer's credit notes, `hasRemainingCredit` keeps only approved credit
 * notes with credit left to apply or refund, and `beforeId` pages.
 */
export async function listCreditNotes(
  tx: OrgTx,
  filters: {
    status?: unknown;
    contactId?: unknown;
    hasRemainingCredit?: unknown;
    beforeId?: unknown;
    limit?: unknown;
  } = {},
): Promise<{ creditNotes: CreditNoteSummary[]; nextBeforeId: string | null }> {
  const status =
    filters.status == null || filters.status === ""
      ? null
      : requireOneOf(filters.status, "status", CREDIT_NOTE_STATUSES);
  const contactId = optionalId(filters.contactId, "contactId");
  const hasRemainingCredit = optionalBoolean(filters.hasRemainingCredit, "hasRemainingCredit") ?? false;
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const limitRaw = Number(filters.limit ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
  const result = await tx.query<CreditNoteRow>(
    `select ${SUMMARY_COLUMNS} from ${SUMMARY_FROM}
      where ($1::text is null or n.status = $1) and ($2::bigint is null or n.contact_id = $2)
        and (not $3::boolean
             or (n.status = 'approved' and applied.amount_applied + refunded.amount_refunded < n.total))
        and ($4::bigint is null or n.id < $4)
      order by n.id desc
      limit ${limit + 1}`,
    [status, contactId, hasRemainingCredit, beforeId],
  );
  const rows = result.rows.slice(0, limit);
  return {
    creditNotes: rows.map(toSummary),
    nextBeforeId: result.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

/** Saves a new draft (example CN1). Drafts post nothing and have no number. */
export async function createCreditNote(
  tx: OrgTx,
  input: CreditNoteInput & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; creditNote: CreditNote }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const draft = parseDraft(input);
  const hash = requestHash("sales_credit_note", hashPayload(draft));

  const existing = await findByKey(tx, "create", source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.hash, hash, "credit note");
    return { created: false, creditNote: await getCreditNote(tx, existing.id) };
  }

  const resolved = await resolveDraft(tx, draft);
  const inserted = await tx.query<{ id: string }>(
    `insert into sales_credit_notes (command_source, idempotency_key, request_hash, contact_id, credit_note_date,
                                     reference, amounts_mode, currency_code, subtotal, tax_total, total,
                                     created_by_user_id, created_by_email,
                                     exchange_rate, base_subtotal, base_tax_total, base_total)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11::numeric, $12, $13,
             $14::numeric, $15::numeric, $16::numeric, $17::numeric)
     on conflict (command_source, idempotency_key) do nothing
     returning id`,
    [
      source,
      idempotencyKey,
      hash,
      resolved.contactId,
      resolved.creditNoteDate,
      resolved.reference,
      resolved.amountsMode,
      resolved.currencyCode,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      tx.actor.userId,
      tx.actor.email,
      resolved.exchangeRate,
      resolved.baseSubtotal,
      resolved.baseTaxTotal,
      resolved.baseTotal,
    ],
  );
  const creditNoteId = inserted.rows[0]?.id;
  if (!creditNoteId) {
    // Another request with the same key committed first.
    const winner = await findByKey(tx, "create", source, idempotencyKey);
    if (!winner) {
      throw new ConflictError("That credit note is being saved by another request. Try again.");
    }
    assertSameRequest(winner.hash, hash, "credit note");
    return { created: false, creditNote: await getCreditNote(tx, winner.id) };
  }
  await insertLines(tx, creditNoteId, resolved.resolvedLines);
  await tx.query("update sales_credit_notes set custom_fields = $2::jsonb, salesperson_id = $3, return_invoice_id = $4 where id = $1", [
    creditNoteId,
    JSON.stringify(resolved.customFields),
    resolved.salespersonId,
    resolved.returnInvoiceId,
  ]);
  await writeAuditEvent(tx, {
    eventType: "credit_note.created",
    entityType: "sales_credit_note",
    entityId: creditNoteId,
    details: {
      contactId: resolved.contactId,
      creditNoteDate: resolved.creditNoteDate,
      amountsMode: resolved.amountsMode,
      total: resolved.total,
      lines: resolved.resolvedLines.length,
    },
  });
  return { created: true, creditNote: await getCreditNote(tx, creditNoteId) };
}

/**
 * Edits a draft. Fields that aren't sent keep their values; `lines` replaces
 * all the lines. Everything is checked and the amounts worked out again. An
 * edit that changes nothing isn't saved or audited.
 */
export async function updateCreditNote(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  input: CreditNoteInput,
): Promise<CreditNote> {
  const current = await lockCreditNote(tx, requireId(creditNoteIdInput, "creditNoteId"));
  assertDraft(current, "edited");
  const saved = draftOf(current);
  const draft = parseDraft({
    contactId: input.contactId === undefined ? saved.contactId : input.contactId,
    creditNoteDate: input.creditNoteDate === undefined ? saved.creditNoteDate : input.creditNoteDate,
    reference: input.reference === undefined ? saved.reference : input.reference,
    amountsMode: input.amountsMode === undefined ? saved.amountsMode : input.amountsMode,
    lines: input.lines === undefined ? saved.lines : input.lines,
    customFields: input.customFields === undefined ? saved.customInput : input.customFields,
    salespersonId: input.salespersonId === undefined ? saved.salespersonInput : input.salespersonId,
    returnInvoiceId: input.returnInvoiceId === undefined ? saved.returnInvoiceId : input.returnInvoiceId,
    // Not sent: the saved rate stays while the customer does.
    exchangeRate:
      input.exchangeRate !== undefined
        ? input.exchangeRate
        : input.contactId === undefined || String(input.contactId) === saved.contactId
          ? saved.exchangeRateInput
          : undefined,
  });
  const resolved = await resolveDraft(
    tx,
    draft,
    keptValues(current.lines),
    keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)),
    current.salespersonId,
    current.lines,
  );
  const same = sameAsStored(resolved, current);
  if (same.header && same.lines) {
    return current;
  }

  const changed: string[] = (["contactId", "creditNoteDate", "reference", "amountsMode", "exchangeRate"] as const).filter(
    (field) => resolved[field] !== current[field],
  );
  if (!same.lines) {
    changed.push("lines");
  }
  if (customValuesKey(resolved.customFields) !== customValuesKey(current.customFields)) {
    changed.push("customFields");
  }
  if (resolved.returnInvoiceId !== current.returnInvoiceId) {
    changed.push("returnInvoiceId");
  }
  if (resolved.salespersonId !== current.salespersonId) {
    changed.push("salespersonId");
  }
  await tx.query(
    `update sales_credit_notes
        set contact_id = $2, credit_note_date = $3, reference = $4, amounts_mode = $5,
            currency_code = $6, subtotal = $7::numeric, tax_total = $8::numeric, total = $9::numeric,
            exchange_rate = $10::numeric, base_subtotal = $11::numeric, base_tax_total = $12::numeric, base_total = $13::numeric,
            updated_at = now()
      where id = $1`,
    [
      current.id,
      resolved.contactId,
      resolved.creditNoteDate,
      resolved.reference,
      resolved.amountsMode,
      resolved.currencyCode,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      resolved.exchangeRate,
      resolved.baseSubtotal,
      resolved.baseTaxTotal,
      resolved.baseTotal,
    ],
  );
  await tx.query("delete from sales_credit_note_lines where credit_note_id = $1", [current.id]);
  await insertLines(tx, current.id, resolved.resolvedLines);
  await tx.query("update sales_credit_notes set custom_fields = $2::jsonb, salesperson_id = $3, return_invoice_id = $4 where id = $1", [
    current.id,
    JSON.stringify(resolved.customFields),
    resolved.salespersonId,
    resolved.returnInvoiceId,
  ]);
  await writeAuditEvent(tx, {
    eventType: "credit_note.updated",
    entityType: "sales_credit_note",
    entityId: current.id,
    details: { changed, total: { from: current.total, to: resolved.total } },
  });
  return getCreditNote(tx, current.id);
}

/** Deletes a draft (approved credit notes are voided instead). */
export async function deleteCreditNote(tx: OrgTx, creditNoteIdInput: unknown): Promise<void> {
  const current = await lockCreditNote(tx, requireId(creditNoteIdInput, "creditNoteId"));
  assertDraft(current, "deleted");
  // Its notes and files go with it (NF12).
  await removeRecordExtras(tx, "sales_credit_note", current.id);
  await tx.query("delete from sales_credit_note_lines where credit_note_id = $1", [current.id]);
  await tx.query("delete from sales_credit_notes where id = $1", [current.id]);
  await writeAuditEvent(tx, {
    eventType: "credit_note.deleted",
    entityType: "sales_credit_note",
    entityId: current.id,
    details: {
      contactId: current.contactId,
      contactName: current.contactName,
      creditNoteDate: current.creditNoteDate,
      total: current.total,
    },
  });
}

async function creditNoteControlAccounts(tx: OrgTx): Promise<{ receivable: string; gst: string }> {
  const refused = "credit notes can't be approved";
  return {
    receivable: await controlAccountCode(tx, RECEIVABLE_ACCOUNT, refused),
    gst: await controlAccountCode(tx, GST_ACCOUNT, refused),
  };
}

export function formatCreditNoteNumber(sequence: number): string {
  return `CN-${String(sequence).padStart(4, "0")}`;
}

/**
 * Takes the next credit note number from its own counter (not the invoice
 * one). The counter row stays locked until the transaction ends, and a
 * refused approval rolls it back, so there are no gaps (example CN11).
 */
async function takeCreditNoteNumber(tx: OrgTx): Promise<{ sequence: number; creditNoteNumber: string }> {
  const result = await tx.query<{ last_number: number }>(
    "update sales_credit_note_numbering set last_number = last_number + 1 where id = true returning last_number",
  );
  const sequence = Number(result.rows[0].last_number);
  return { sequence, creditNoteNumber: formatCreditNoteNumber(sequence) };
}

/**
 * Approves a draft (examples CN2, CN10-CN12): gives it the next number and
 * posts one journal on the credit note date, Dr each line's account for its
 * net amount, Dr GST for the GST and Cr accounts receivable for the total.
 * Refused in a locked period, leaving the draft as it was.
 */
export async function approveCreditNote(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; creditNote: CreditNote }> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("credit_note_approval", { creditNoteId });
  const replay = async () => {
    const earlier = await findByKey(tx, "approve", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "credit note approval");
    return { created: false, creditNote: await getCreditNote(tx, earlier.id) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const current = await lockCreditNote(tx, creditNoteId);
  // The original of a retry may have committed while this request waited for the lock.
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (current.status !== "draft") {
    throw new ConflictError(`${creditNoteLabel(current)} is already ${current.status}.`);
  }
  const resolved = await resolveDraft(
    tx,
    draftOf(current),
    keptValues(current.lines),
    keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)),
    current.salespersonId,
    current.lines,
  );
  const same = sameAsStored(resolved, current);
  if (!same.header || !same.lines) {
    throw new ConflictError(
      "This draft's amounts no longer match its tax codes. Open it and save it again, then check the totals before approving.",
    );
  }
  assertRequiredTags(
    await loadTrackingContext(tx),
    resolved.resolvedLines.map((line) => ({ tags: line.tracking, accountClass: line.accountClass })),
  );
  assertRequiredFields(
    resolved.customCtx,
    "credit_note",
    resolved.customFields,
    resolved.resolvedLines.map((line) => ({ values: line.customFields, accountClass: line.accountClass })),
  );
  const accounts = await creditNoteControlAccounts(tx);
  await assertPostingDateAllowed(tx, current.creditNoteDate);

  const { sequence, creditNoteNumber } = await takeCreditNoteNumber(tx);
  const scale = currencyMinorUnits(tx.baseCurrency);
  // A foreign-currency credit note posts its base amounts, with its foreign amount on accounts receivable (MC7).
  const foreignCurrency = resolved.exchangeRate !== null;
  // One line per account and set of tracking tags (TC4, TC10).
  const revenue = new Map<string, { code: string; amount: Decimal; tracking: TrackingTags }>();
  for (const line of resolved.resolvedLines) {
    const key = `${line.accountId}|${trackingKey(line.tracking)}`;
    const entry = revenue.get(key) ?? { code: line.accountCode, amount: ZERO_DECIMAL, tracking: line.tracking };
    entry.amount = add(entry.amount, dec(foreignCurrency ? line.baseNetAmount! : line.netAmount));
    revenue.set(key, entry);
  }
  const customer = resolved.contactName;
  const taxTotal = foreignCurrency ? resolved.baseTaxTotal! : resolved.taxTotal;
  const journalLines = [
    ...[...revenue.values()]
      .filter((entry) => !isZero(entry.amount))
      .map((entry) => ({
        accountCode: entry.code,
        debitAmount: toFixedString(entry.amount, scale),
        creditAmount: "0",
        description: customer,
        tracking: entry.tracking,
      })),
    ...(isZero(dec(taxTotal)) ? [] : [{ accountCode: accounts.gst, debitAmount: taxTotal, creditAmount: "0", description: "GST" }]),
    {
      accountCode: accounts.receivable,
      debitAmount: "0",
      creditAmount: foreignCurrency ? resolved.baseTotal! : resolved.total,
      description: customer,
      ...(foreignCurrency
        ? { foreign: { currencyCode: resolved.currencyCode, amount: resolved.total, rate: resolved.exchangeRate!, kind: "document" as const } }
        : {}),
    },
  ];
  // Stock items move stock and post cost of sales in the same journal (ST1-ST11).
  const stock = await planDocumentStock(
    tx,
    "credit_note",
    { id: creditNoteId, date: current.creditNoteDate, reference: creditNoteNumber, contactId: current.contactId, returnInvoiceId: current.returnInvoiceId },
    resolved.resolvedLines,
    `Stock returned, credit note ${creditNoteNumber}`,
  );
  if (stock) journalLines.push(...stock.journalLines);
  const posted = await postJournalBody(
    tx,
    "sales_credit_note:approval",
    creditNoteId,
    parseJournalBody(
      tx,
      {
        postingDate: current.creditNoteDate,
        reference: creditNoteNumber,
        description: `Credit note ${creditNoteNumber} to ${customer}`,
        lines: journalLines,
      },
      { internal: true },
    ),
    { origin: "sales_credit_note" },
  );
  await stock?.planner.record(posted.journal.id);

  try {
    await tx.query(
      `update sales_credit_notes
          set status = 'approved', credit_note_sequence = $2, credit_note_number = $3, approval_journal_id = $4,
              approve_command_source = $5, approve_idempotency_key = $6, approve_request_hash = $7,
              approved_by_user_id = $8, approved_by_email = $9, approved_at = now(), updated_at = now()
        where id = $1`,
      [
        creditNoteId,
        sequence,
        creditNoteNumber,
        posted.journal.id,
        source,
        idempotencyKey,
        hash,
        tx.actor.userId,
        tx.actor.email,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The same key was used to approve another credit note by a request that committed first.
      throw new ConflictError(
        "That idempotency key was already used for a different credit note approval. Use a new key for a new credit note approval.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "credit_note.approved",
    entityType: "sales_credit_note",
    entityId: creditNoteId,
    details: {
      creditNoteNumber,
      journalId: posted.journal.id,
      creditNoteDate: current.creditNoteDate,
      total: resolved.total,
    },
  });
  return { created: true, creditNote: await getCreditNote(tx, creditNoteId) };
}

/**
 * Voids an approved credit note (example CN9): posts the exact reversal of
 * its journal on the void date, which must be in an open period and not
 * before the credit note. A credit note can only be voided once, a draft is
 * deleted rather than voided, and one with active applications or refunds is
 * refused until they're removed or voided.
 */
export async function voidCreditNote(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<{ created: boolean; creditNote: CreditNote }> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const hash = requestHash("credit_note_void", { creditNoteId, voidDate });
  const replay = async () => {
    const earlier = await findByKey(tx, "void", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "credit note void");
    return { created: false, creditNote: await getCreditNote(tx, earlier.id) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const current = await lockCreditNote(tx, creditNoteId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (current.status === "draft") {
    throw new ConflictError("This credit note is still a draft, so there's nothing to void. Delete it instead.");
  }
  if (current.status === "voided") {
    throw new ConflictError(`${creditNoteLabel(current)} has already been voided.`);
  }
  if (!isZero(dec(current.amountApplied)) || !isZero(dec(current.amountRefunded))) {
    // Example CN9. The database refuses it too.
    throw new ConflictError(
      `${creditNoteLabel(current)} has credit applied or refunded, so it can't be voided. Remove its applications and refunds first.`,
    );
  }
  if (voidDate < current.creditNoteDate) {
    throw new ValidationError(`The void date can't be before the credit note date (${current.creditNoteDate}).`);
  }

  const original = await getJournal(tx, current.approvalJournalId!);
  const voidStock = await planDocumentVoid(
    tx,
    "credit_note",
    { id: creditNoteId, date: voidDate, reference: `VOID-${original.reference}`.slice(0, 100) },
    (lineIndex) => current.lines[lineIndex]?.tracking ?? {},
    `Stock back on void of ${original.reference}`,
  );
  const posted = await postJournalBody(
    tx,
    "sales_credit_note:void",
    creditNoteId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${current.creditNoteNumber}`,
      description: `Void of credit note ${current.creditNoteNumber}`,
      lines: [
        ...original.lines.map((line) => ({
          accountCode: line.accountCode,
          debitAmount: line.creditAmount,
          creditAmount: line.debitAmount,
          description: line.description,
          tracking: line.tracking,
          ...sameForeign(line),
        })),
        ...(voidStock?.journalLines ?? []),
      ],
    }, { internal: true }),
    { origin: "sales_credit_note", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  await voidStock?.planner.record(posted.journal.id);

  try {
    await tx.query(
      `update sales_credit_notes
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4,
              void_idempotency_key = $5, void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8,
              voided_at = now(), updated_at = now()
        where id = $1`,
      [creditNoteId, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "That idempotency key was already used for a different credit note void. Use a new key for a new credit note void.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "credit_note.voided",
    entityType: "sales_credit_note",
    entityId: creditNoteId,
    details: { creditNoteNumber: current.creditNoteNumber, voidDate, journalId: posted.journal.id },
  });
  return { created: true, creditNote: await getCreditNote(tx, creditNoteId) };
}

import { openingAmounts, openingLineDescription, type OpeningLine } from "@/lib/import/opening-gst";
import { parseAccountCodeInput } from "@/lib/accounts/service";
import { checkCreditLimit, dueDateFromTerms } from "@/lib/customers/service";
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
  invoicePaymentStatus,
  type AmountsMode,
  type PaidStatus,
} from "@/lib/invoices/amounts";
import { getJournal, parseJournalBody, postJournalBody, sameForeign } from "@/lib/ledger/journals";
import {
  assertForeignLinesSupported,
  assertForeignSalesBasis,
  contactCurrency,
  convertDocumentLines,
  exchangeRateFor,
  parseRateInput,
} from "@/lib/fx/documents";
import { type AvailableOn, sideRefusal } from "@/lib/tax/available-on";
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
 * Sales invoices. A draft can be edited and deleted and posts nothing.
 * Approving gives it the next number (INV-0001, ...) and posts its journal;
 * after that it can't change, only be voided, which posts the exact reversal.
 * The amounts are worked out in `@/lib/invoices/amounts` (examples I1-I9).
 * Payments against approved invoices are in `@/lib/invoices/payments`, and
 * credit applied from credit notes in `@/lib/credit-notes/applications`.
 */
export const INVOICE_STATUSES = ["draft", "approved", "voided"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export type InvoiceLine = LineItemFields & {
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
  /** Tracking categories (TC3): category id -> value id. */
  tracking: TrackingTags;
  customFields: CustomValues;
  /** On a foreign-currency invoice: the net amount and GST in the base currency (MC2); null otherwise. */
  baseNetAmount: string | null;
  baseTaxAmount: string | null;
};

export type InvoiceSummary = {
  id: string;
  status: InvoiceStatus;
  invoiceNumber: string | null;
  contactId: string;
  contactName: string;
  invoiceDate: string;
  dueDate: string;
  reference: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  /** Base currency per 1 unit of the invoice's currency; null for a base-currency invoice (MC2). */
  exchangeRate: string | null;
  /** The base-currency amounts of a foreign-currency invoice (its lines converted one by one); null otherwise. */
  baseSubtotal: string | null;
  baseTaxTotal: string | null;
  baseTotal: string | null;
  /** On an approved foreign-currency invoice: the base value of what's still due, at the invoice's rate (MC6). */
  amountDueBase: string | null;
  /** The sum of the invoice's active payments (examples CP1-CP4). */
  amountPaid: string;
  /** The sum of the credit applied to the invoice from credit notes (examples CN3, CN4, CN7). */
  amountCredited: string;
  /** What's still to be paid on an approved invoice; null for drafts and voided invoices. */
  amountDue: string | null;
  /** Worked out from the invoice's active payments and credit; null for drafts and voided invoices. */
  paidStatus: PaidStatus | null;
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
  /** Owed at the conversion date when the books were brought in (IM5): keeps its old number, no GST. */
  isOpeningBalance: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Invoice = InvoiceSummary & { lines: InvoiceLine[] };

/** What a person enters. An edit leaves out anything it doesn't change; `lines` replaces every line. */
export type InvoiceInput = {
  contactId?: unknown;
  invoiceDate?: unknown;
  dueDate?: unknown;
  reference?: unknown;
  amountsMode?: unknown;
  lines?: unknown;
  customFields?: unknown;
  salespersonId?: unknown;
  /** For a customer in another currency: base currency per 1 unit (MC2). Left out, the last rate used is taken. */
  exchangeRate?: unknown;
};

/**
 * Whether a path may make documents in a currency other than the base (MC11).
 * `template`: a quote, repeating template or purchase order (MC25-MC28), in
 * the contact's currency but with no rate: it posts nothing, and the
 * invoice or bill made from it takes a rate for its own date.
 */
export type ForeignOption = { foreignCurrency?: boolean; feature?: string; template?: boolean };

const MAX_LINES = 200;
/** Quantities and unit prices allow up to 4 decimal places. */
const LINE_INPUT_SCALE = 4;

type InvoiceRow = {
  id: string;
  status: InvoiceStatus;
  invoice_number: string | null;
  contact_id: string;
  contact_name: string;
  invoice_date: string;
  due_date: string;
  reference: string | null;
  amounts_mode: AmountsMode;
  currency_code: string;
  subtotal: string;
  tax_total: string;
  total: string;
  amount_paid: string;
  amount_credited: string;
  exchange_rate: string | null;
  base_subtotal: string | null;
  base_tax_total: string | null;
  base_total: string | null;
  base_settled: string;
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
  salesperson_name: string | null;
  is_opening_balance: boolean;
  created_at: string;
  updated_at: string;
};

const SUMMARY_COLUMNS = `i.id, i.status, i.invoice_number, i.contact_id, c.name as contact_name, i.invoice_date,
  i.due_date, i.reference, i.amounts_mode, i.currency_code, i.subtotal, i.tax_total, i.total,
  paid.amount_paid, credited.amount_credited, i.approval_journal_id, i.approved_at, i.approved_by_email, i.void_date, i.void_journal_id,
  i.voided_at, i.voided_by_email, i.created_by_email, i.created_at, i.updated_at, i.custom_fields,
  i.salesperson_id, sp.name as salesperson_name, i.is_opening_balance,
  i.exchange_rate::text, i.base_subtotal::text, i.base_tax_total::text, i.base_total::text, base_settled.base_settled::text`;

/**
 * Invoices with their customer, what their active payments paid on them (a
 * payment less its overpayment, example OP1) and the credit applied to them
 * from credit notes and from overpayments on the customer's other invoices.
 */
const SUMMARY_FROM = `sales_invoices i
  join contacts c on c.id = i.contact_id
  left join salespeople sp on sp.id = i.salesperson_id
  cross join lateral (
    select coalesce(sum(p.amount - p.overpayment_amount), 0) as amount_paid
      from customer_payments p
     where p.invoice_id = i.id and p.status = 'active'
  ) paid
  cross join lateral (
    select coalesce((select sum(a.amount) from sales_credit_note_applications a
                      where a.invoice_id = i.id and a.status = 'active'), 0)
         + coalesce((select sum(o.amount) from customer_overpayment_applications o
                      where o.invoice_id = i.id and o.status = 'active'), 0) as amount_credited
  ) credited
  cross join lateral (
    select tohyee_invoice_base_settled(i.id) as base_settled
  ) base_settled`;

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

function toSummary(row: InvoiceRow): InvoiceSummary {
  const scale = currencyMinorUnits(row.currency_code);
  const payment = invoicePaymentStatus(row.total, row.amount_paid, scale, row.amount_credited);
  const approved = row.status === "approved";
  return {
    id: row.id,
    status: row.status,
    invoiceNumber: row.invoice_number,
    contactId: row.contact_id,
    contactName: row.contact_name,
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
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
    amountDueBase: approved && row.base_total !== null ? toFixedString(sub(dec(row.base_total), dec(row.base_settled)), 2) : null,
    amountPaid: payment.amountPaid,
    amountCredited: toFixedString(dec(row.amount_credited), scale),
    amountDue: approved ? payment.amountDue : null,
    paidStatus: approved ? payment.paidStatus : null,
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
    salespersonName: row.salesperson_name,
    isOpeningBalance: row.is_opening_balance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLine(row: LineRow): InvoiceLine {
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
export type SalesDraft = DraftDetails;
type DraftDetails = {
  contactId: string;
  invoiceDate: string;
  dueDate: string;
  /** A new invoice sent without a due date takes it from the customer's payment terms (RC1). */
  dueFromTerms?: boolean;
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
  /** As sent: undefined or null when not given (a foreign-currency invoice then takes the last rate used, MC3). */
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

export type SalesLineDraft = DraftDetails["lines"][number];

/**
 * Parses sales document lines as sent, the same way for invoices, quotes
 * (QT1) and repeating invoice templates (RI2). `noun` names the document in
 * the "needs at least one line" message.
 */
export function parseSalesLines(input: unknown, amountsMode: AmountsMode, noun = "An invoice"): SalesLineDraft[] {
  const rawLines = requireArray(input, "lines", MAX_LINES);
  if (rawLines.length === 0) {
    throw new ValidationError(`${noun} needs at least one line.`);
  }
  const documentName = noun.replace(/^An? /, "").toLowerCase();
  return rawLines.map((raw, index) => {
    const label = `Line ${index + 1}`;
    const line = asRecord(raw, label);
    // A line with an item can leave these blank: the item fills them (IT2).
    const item = parseLineItem(line, label);
    const fillable = item.itemId !== null;
    const taxCode = optionalString(line.taxCode, `${label} tax code`, { maxLength: 20 })?.toUpperCase() ?? null;
    if (amountsMode === "no_tax" && taxCode !== null) {
      throw new ValidationError(
        `${label} has a tax code, but the ${documentName}'s amounts have no tax. Remove the tax code or change the amounts to tax exclusive or inclusive.`,
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
}

/** Lines for an idempotency fingerprint, normalised the way invoices hash them. */
export function hashSalesLines(lines: readonly SalesLineDraft[]): unknown[] {
  return lines.map((line) => hashableLine(lineForHash({ ...line, accountCode: line.accountCode.toLowerCase() })));
}

function parseDraft(input: InvoiceInput, options: { dueFromTerms?: boolean } = {}): DraftDetails {
  const contactId = requireId(input.contactId, "contactId");
  const invoiceDate = parseIsoDate(input.invoiceDate, "invoiceDate");
  const dueFromTerms = options.dueFromTerms === true && (input.dueDate == null || (typeof input.dueDate === "string" && !input.dueDate.trim()));
  // Filled in from the customer's terms once the idempotency key has been checked.
  const dueDate = dueFromTerms ? invoiceDate : parseIsoDate(input.dueDate, "dueDate");
  if (dueDate < invoiceDate) {
    throw new ValidationError("The due date can't be before the invoice date.");
  }
  const reference = optionalString(input.reference, "reference", { maxLength: 100 });
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  const lines = parseSalesLines(input.lines, amountsMode);
  return {
    contactId,
    invoiceDate,
    dueDate,
    ...(dueFromTerms ? { dueFromTerms } : {}),
    reference,
    amountsMode,
    lines,
    customInput: parseCustomInput(input.customFields, ""),
    salespersonInput: parseSalespersonInput(input.salespersonId),
    exchangeRateInput: parseRateInput(input.exchangeRate),
  };
}

/** Normalised content for the idempotency fingerprint. */
function hashPayload(draft: DraftDetails): Record<string, unknown> {
  return {
    contactId: draft.contactId,
    invoiceDate: draft.invoiceDate,
    // Sent without a due date: the terms decide it, so the hash says so (RC1).
    dueDate: draft.dueFromTerms ? null : draft.dueDate,
    reference: draft.reference,
    amountsMode: draft.amountsMode,
    lines: hashSalesLines(draft.lines),
    // Values that weren't sent stay out, so older requests hash the same.
    ...(draft.customInput !== undefined ? { customFields: draft.customInput } : {}),
    ...(draft.salespersonInput !== undefined ? { salespersonId: draft.salespersonInput } : {}),
    ...(draft.exchangeRateInput != null ? { exchangeRate: draft.exchangeRateInput } : {}),
  };
}

/**
 * Checks a draft against the organisation's data and works out its amounts.
 * Run when a draft is saved and again when it's approved: the customer must be
 * an active contact marked as a customer, each line's account an active
 * revenue account, and each tax code active and in effect on the invoice date.
 */
export type ResolvedSalesDraft = ResolvedDraft;

export async function resolveSalesDraft(
  tx: OrgTx,
  sent: DraftDetails,
  kept: ReadonlySet<string> = new Set(),
  keptFields: ReadonlySet<string> = new Set(),
  keptSalesperson: string | null = null,
  keptItems: ReadonlyArray<LineItemRef> = [],
  foreign: ForeignOption = {},
): Promise<ResolvedDraft> {
  return resolveDraft(tx, sent, kept, keptFields, keptSalesperson, keptItems, foreign);
}

async function resolveDraft(
  tx: OrgTx,
  sent: DraftDetails,
  kept: ReadonlySet<string> = new Set(),
  keptFields: ReadonlySet<string> = new Set(),
  keptSalesperson: string | null = null,
  keptItems: ReadonlyArray<LineItemRef> = [],
  foreign: ForeignOption = { foreignCurrency: true },
): Promise<ResolvedDraft> {
  // A customer in another currency gets invoices in it (MC1), entered directly only (MC11).
  const currencyCode = await contactCurrency(tx, sent.contactId);
  if (currencyCode !== tx.baseCurrency) {
    if (!foreign.foreignCurrency) {
      const name = (await tx.query<{ name: string }>("select name from contacts where id = $1", [sent.contactId])).rows[0]?.name ?? "This customer";
      throw new ValidationError(
        `${name} is in ${currencyCode}. ${foreign.feature ?? "This"} for customers in a currency other than ${tx.baseCurrency} isn't supported yet (refused rather than guessed): raise a ${currencyCode} invoice directly instead.`,
      );
    }
    // Item prices are in the base currency, so a foreign-currency line gives its own (MC11).
    assertForeignLinesSupported("invoice", currencyCode, tx.baseCurrency, sent.lines);
  }
  // Blanks on item lines are filled from the item (IT2); what was sent is kept.
  const draft: DraftDetails = { ...sent, lines: await fillLinesFromItems(tx, sent.lines, { side: "sale", contactId: sent.contactId, noTax: sent.amountsMode === "no_tax" }) };
  const salesperson = await resolveSalesperson(tx, draft.salespersonInput, { contactId: draft.contactId, kept: keptSalesperson });
  const custom = await resolveDocumentCustom(tx, "invoice", draft.customInput, draft.lines.map((line) => line.customFields), keptFields);
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
    available_on: AvailableOn;
  }>("select id, code, rate, category, is_active, effective_from, effective_to, available_on from tax_codes where code = any($1::text[])", [
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
        `${label}: account ${account.code} (${account.name}) isn't a revenue account. Invoice lines go to revenue accounts, like Sales.`,
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
      // Only codes available on sales (TAO2-TAO4); a draft with one that no longer is can't be saved or approved (TAO9).
      const offSide = sideRefusal(label, taxCode.code, taxCode.available_on, "sales");
      if (offSide) throw new ValidationError(offSide);
      if (taxCode.effective_from > draft.invoiceDate || (taxCode.effective_to !== null && taxCode.effective_to < draft.invoiceDate)) {
        throw new ValidationError(
          `${label}: tax code ${taxCode.code} isn't in effect on ${draft.invoiceDate} (it applies from ${taxCode.effective_from}${
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
  // A foreign-currency invoice (MC2, MC71): a rate for its date; each line (GST included) converted.
  let exchangeRate: string | null = null;
  let base: ReturnType<typeof convertDocumentLines> | null = null;
  if (currencyCode !== tx.baseCurrency) {
    await assertForeignSalesBasis(tx, "invoice", currencyCode);
    if (!foreign.template) {
      exchangeRate = await exchangeRateFor(tx, { currencyCode, date: draft.invoiceDate, typed: draft.exchangeRateInput, what: "invoice" });
      base = convertDocumentLines(amounts.lines, exchangeRate!, currencyMinorUnits(tx.baseCurrency));
    }
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
  invoiceDate: string;
  dueDate: string;
  reference: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  customFields: CustomValues;
  salespersonId: string | null;
  exchangeRate: string | null;
  baseTotal: string | null;
};

const plain = (value: string) => toPlainString(dec(value));

/** What's stored for a draft's header and lines, to tell whether an edit changed anything. */
function headerState(invoice: StoredHeader): string {
  return JSON.stringify([
    invoice.contactId,
    invoice.invoiceDate,
    invoice.dueDate,
    invoice.reference,
    invoice.amountsMode,
    invoice.currencyCode,
    plain(invoice.subtotal),
    plain(invoice.taxTotal),
    plain(invoice.total),
    customValuesKey(invoice.customFields),
    invoice.salespersonId,
    invoice.exchangeRate === null ? null : plain(invoice.exchangeRate),
    invoice.baseTotal === null ? null : plain(invoice.baseTotal),
  ]);
}

export function linesState(lines: readonly StoredLine[]): string {
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

function sameAsStored(resolved: ResolvedDraft, current: Invoice): { header: boolean; lines: boolean } {
  return {
    header: headerState(resolved) === headerState(current),
    lines: linesState(resolved.resolvedLines) === linesState(current.lines),
  };
}

/** Saved lines, in the shape a person would send them. */
export function linesAsSent(lines: readonly InvoiceLine[]): SalesLineDraft[] {
  return lines.map((line) => ({
    description: line.description,
    quantity: toPlainString(dec(line.quantity)),
    unitPrice: toPlainString(dec(line.unitPrice)),
    accountCode: line.accountCode,
    taxCode: line.taxCode,
    tracking: line.tracking,
    customFields: line.customFields,
    itemId: line.itemId,
    unitId: line.unitId,
  }));
}

/** The saved draft, in the shape a person would send it. */
function draftOf(invoice: Invoice): DraftDetails {
  return {
    contactId: invoice.contactId,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    reference: invoice.reference,
    amountsMode: invoice.amountsMode,
    lines: invoice.lines.map((line) => ({
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
    customInput: invoice.customFields,
    salespersonInput: invoice.salespersonId,
    exchangeRateInput: invoice.exchangeRate,
  };
}

async function insertLines(tx: OrgTx, invoiceId: string, lines: ResolvedDraft["resolvedLines"]): Promise<void> {
  await insertSalesLines(tx, "sales_invoice_lines", invoiceId, lines);
  await setBaseLineAmounts(tx, "sales_invoice_lines", "invoice_id", invoiceId, lines);
}

/** A foreign-currency document's lines' base amounts (MC2), set on a draft's lines once they're saved. */
export async function setBaseLineAmounts(
  tx: OrgTx,
  table: "sales_invoice_lines" | "sales_credit_note_lines" | "bill_lines" | "supplier_credit_note_lines",
  parentColumn: "invoice_id" | "credit_note_id" | "bill_id",
  parentId: string,
  lines: ReadonlyArray<{ baseNetAmount: string | null; baseTaxAmount: string | null }>,
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (line.baseNetAmount === null) continue;
    await tx.query(
      `update ${table} set base_net_amount = $3::numeric, base_tax_amount = $4::numeric where ${parentColumn} = $1 and line_order = $2`,
      [parentId, index + 1, line.baseNetAmount, line.baseTaxAmount],
    );
  }
}

/** The line tables that hold sales lines: invoices, quotes (QT1) and repeating invoice templates (RI2). */
export type SalesLineTable = "sales_invoice_lines" | "quote_lines" | "repeating_invoice_lines";
const SALES_LINE_PARENT: Record<SalesLineTable, string> = {
  sales_invoice_lines: "invoice_id",
  quote_lines: "quote_id",
  repeating_invoice_lines: "repeating_invoice_id",
};

export async function insertSalesLines(
  tx: OrgTx,
  table: SalesLineTable,
  parentId: string,
  lines: ResolvedDraft["resolvedLines"],
): Promise<void> {
  const parentColumn = SALES_LINE_PARENT[table];
  const values: unknown[] = [];
  const tuples = lines.map((line, index) => {
    values.push(
      parentId,
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
    `insert into ${table} (${parentColumn}, line_order, description, quantity, unit_price, account_id,
                                      tax_code_id, tax_rate, line_amount, net_amount, tax_amount, tracking, custom_fields, item_id, unit_id, base_quantity)
     values ${tuples.join(", ")}`,
    values,
  );
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
    `select id, ${columns.hash} as hash from sales_invoices where ${columns.source} = $1 and ${columns.key} = $2`,
    [source, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function invoiceLabel(invoice: InvoiceSummary): string {
  return invoice.invoiceNumber ? `Invoice ${invoice.invoiceNumber}` : `Draft invoice #${invoice.id}`;
}

export async function getInvoice(tx: OrgTx, invoiceIdInput: unknown): Promise<Invoice> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const result = await tx.query<InvoiceRow>(
    `select ${SUMMARY_COLUMNS} from ${SUMMARY_FROM} where i.id = $1`,
    [invoiceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Invoice not found.");
  }
  return { ...toSummary(row), lines: await loadSalesLines(tx, "sales_invoice_lines", invoiceId) };
}

/** A sales document's lines, in order. */
export async function loadSalesLines(tx: OrgTx, table: SalesLineTable, parentId: string): Promise<InvoiceLine[]> {
  const lines = await tx.query<LineRow>(
    `select l.line_order, l.description, l.quantity, l.unit_price, l.account_id, a.code as account_code,
            a.name as account_name, l.tax_code_id, t.code as tax_code, l.tax_rate, l.line_amount,
            l.net_amount, l.tax_amount, l.tracking, l.custom_fields, ${LINE_ITEM_COLUMNS},
            ${table === "sales_invoice_lines" ? "l.base_net_amount::text, l.base_tax_amount::text" : "null as base_net_amount, null as base_tax_amount"}
       from ${table} l
       join accounts a on a.id = l.account_id
       left join tax_codes t on t.id = l.tax_code_id
       ${LINE_ITEM_JOINS}
      where l.${SALES_LINE_PARENT[table]} = $1
      order by l.line_order`,
    [parentId],
  );
  return lines.rows.map(toLine);
}

/** Loads an invoice and locks it until the transaction ends. */
export async function lockInvoice(tx: OrgTx, invoiceId: string): Promise<Invoice> {
  const locked = await tx.query("select id from sales_invoices where id = $1 for update", [invoiceId]);
  if (locked.rowCount === 0) {
    throw new NotFoundError("Invoice not found.");
  }
  return getInvoice(tx, invoiceId);
}

function assertDraft(invoice: Invoice, action: "edited" | "deleted"): void {
  if (invoice.status !== "draft") {
    throw new ConflictError(`${invoiceLabel(invoice)} is ${invoice.status}, so it can't be ${action}.${
      invoice.status === "approved" ? " Void it instead." : ""
    }`);
  }
}

/**
 * Newest first, 50 at a time; `status` filters, `awaitingPayment` keeps only
 * approved invoices with something still due (after payments and credit),
 * `contactId` keeps one customer's invoices, and `beforeId` pages.
 */
export async function listInvoices(
  tx: OrgTx,
  filters: { status?: unknown; awaitingPayment?: unknown; contactId?: unknown; beforeId?: unknown; limit?: unknown } = {},
): Promise<{ invoices: InvoiceSummary[]; nextBeforeId: string | null }> {
  const status =
    filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", INVOICE_STATUSES);
  const awaitingPayment = optionalBoolean(filters.awaitingPayment, "awaitingPayment") ?? false;
  const contactId = optionalId(filters.contactId, "contactId");
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const limitRaw = Number(filters.limit ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
  const result = await tx.query<InvoiceRow>(
    `select ${SUMMARY_COLUMNS} from ${SUMMARY_FROM}
      where ($1::text is null or i.status = $1) and ($2::bigint is null or i.id < $2)
        and (not $3::boolean or (i.status = 'approved' and paid.amount_paid + credited.amount_credited < i.total))
        and ($4::bigint is null or i.contact_id = $4)
      order by i.id desc
      limit ${limit + 1}`,
    [status, beforeId, awaitingPayment, contactId],
  );
  const rows = result.rows.slice(0, limit);
  return {
    invoices: rows.map(toSummary),
    nextBeforeId: result.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

/** Saves a new draft. Drafts post nothing. */
export async function createInvoice(
  tx: OrgTx,
  input: InvoiceInput & { source?: unknown; idempotencyKey: unknown },
  foreign: ForeignOption = {},
): Promise<{ created: boolean; invoice: Invoice }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const draft = parseDraft(input, { dueFromTerms: true });
  const hash = requestHash("sales_invoice", hashPayload(draft));

  const existing = await findByKey(tx, "create", source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.hash, hash, "invoice");
    return { created: false, invoice: await getInvoice(tx, existing.id) };
  }
  if (draft.dueFromTerms) {
    const fromTerms = await dueDateFromTerms(tx, draft.contactId, draft.invoiceDate);
    if (fromTerms === null) {
      throw new ValidationError("dueDate is required (YYYY-MM-DD): this customer has no payment terms to work it out from.");
    }
    draft.dueDate = fromTerms;
  }

  const resolved = await resolveDraft(tx, draft, new Set(), new Set(), null, [], foreign);
  const inserted = await tx.query<{ id: string }>(
    `insert into sales_invoices (command_source, idempotency_key, request_hash, contact_id, invoice_date, due_date,
                                 reference, amounts_mode, currency_code, subtotal, tax_total, total,
                                 created_by_user_id, created_by_email,
                                 exchange_rate, base_subtotal, base_tax_total, base_total)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $12::numeric, $13, $14,
             $15::numeric, $16::numeric, $17::numeric, $18::numeric)
     on conflict (command_source, idempotency_key) do nothing
     returning id`,
    [
      source,
      idempotencyKey,
      hash,
      resolved.contactId,
      resolved.invoiceDate,
      resolved.dueDate,
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
  const invoiceId = inserted.rows[0]?.id;
  if (!invoiceId) {
    // Another request with the same key committed first.
    const winner = await findByKey(tx, "create", source, idempotencyKey);
    if (!winner) {
      throw new ConflictError("That invoice is being saved by another request. Try again.");
    }
    assertSameRequest(winner.hash, hash, "invoice");
    return { created: false, invoice: await getInvoice(tx, winner.id) };
  }
  await insertLines(tx, invoiceId, resolved.resolvedLines);
  await tx.query("update sales_invoices set custom_fields = $2::jsonb, salesperson_id = $3 where id = $1", [
    invoiceId,
    JSON.stringify(resolved.customFields),
    resolved.salespersonId,
  ]);
  await writeAuditEvent(tx, {
    eventType: "invoice.created",
    entityType: "sales_invoice",
    entityId: invoiceId,
    details: {
      contactId: resolved.contactId,
      invoiceDate: resolved.invoiceDate,
      amountsMode: resolved.amountsMode,
      total: resolved.total,
      lines: resolved.resolvedLines.length,
    },
  });
  return { created: true, invoice: await getInvoice(tx, invoiceId) };
}

/**
 * Edits a draft. Fields that aren't sent keep their values; `lines` replaces
 * all the lines. Everything is checked and the amounts worked out again. An
 * edit that changes nothing isn't saved or audited.
 */
export async function updateInvoice(tx: OrgTx, invoiceIdInput: unknown, input: InvoiceInput): Promise<Invoice> {
  const current = await lockInvoice(tx, requireId(invoiceIdInput, "invoiceId"));
  assertDraft(current, "edited");
  const saved = draftOf(current);
  const draft = parseDraft({
    contactId: input.contactId === undefined ? saved.contactId : input.contactId,
    invoiceDate: input.invoiceDate === undefined ? saved.invoiceDate : input.invoiceDate,
    dueDate: input.dueDate === undefined ? saved.dueDate : input.dueDate,
    reference: input.reference === undefined ? saved.reference : input.reference,
    amountsMode: input.amountsMode === undefined ? saved.amountsMode : input.amountsMode,
    lines: input.lines === undefined ? saved.lines : input.lines,
    customFields: input.customFields === undefined ? saved.customInput : input.customFields,
    salespersonId: input.salespersonId === undefined ? saved.salespersonInput : input.salespersonId,
    // Not sent: the saved rate stays while the customer does (MC3).
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

  const changed: string[] = (["contactId", "invoiceDate", "dueDate", "reference", "amountsMode", "exchangeRate"] as const).filter(
    (field) => resolved[field] !== current[field],
  );
  if (!same.lines) {
    changed.push("lines");
  }
  if (customValuesKey(resolved.customFields) !== customValuesKey(current.customFields)) {
    changed.push("customFields");
  }
  if (resolved.salespersonId !== current.salespersonId) {
    changed.push("salespersonId");
  }
  await tx.query(
    `update sales_invoices
        set contact_id = $2, invoice_date = $3, due_date = $4, reference = $5, amounts_mode = $6,
            currency_code = $7, subtotal = $8::numeric, tax_total = $9::numeric, total = $10::numeric,
            exchange_rate = $11::numeric, base_subtotal = $12::numeric, base_tax_total = $13::numeric, base_total = $14::numeric,
            updated_at = now()
      where id = $1`,
    [
      current.id,
      resolved.contactId,
      resolved.invoiceDate,
      resolved.dueDate,
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
  await tx.query("delete from sales_invoice_lines where invoice_id = $1", [current.id]);
  await insertLines(tx, current.id, resolved.resolvedLines);
  await tx.query("update sales_invoices set custom_fields = $2::jsonb, salesperson_id = $3 where id = $1", [
    current.id,
    JSON.stringify(resolved.customFields),
    resolved.salespersonId,
  ]);
  await writeAuditEvent(tx, {
    eventType: "invoice.updated",
    entityType: "sales_invoice",
    entityId: current.id,
    details: { changed, total: { from: current.total, to: resolved.total } },
  });
  return getInvoice(tx, current.id);
}

/** Deletes a draft (approved invoices are voided instead). */
export async function deleteInvoice(tx: OrgTx, invoiceIdInput: unknown): Promise<void> {
  const current = await lockInvoice(tx, requireId(invoiceIdInput, "invoiceId"));
  assertDraft(current, "deleted");
  // QT7: the invoice an accepted quote made stays, so the quote keeps its invoice.
  const fromQuote = await tx.query<{ quote_number: string }>("select quote_number from quotes where invoice_id = $1", [current.id]);
  if (fromQuote.rows[0]) {
    throw new ConflictError(
      `This draft was made by accepting quote ${fromQuote.rows[0].quote_number}, so it can't be deleted. Edit it, or approve it and void it.`,
    );
  }
  // Its notes and files go with it (NF12).
  await removeRecordExtras(tx, "sales_invoice", current.id);
  await tx.query("delete from sales_invoice_lines where invoice_id = $1", [current.id]);
  await tx.query("delete from sales_invoices where id = $1", [current.id]);
  await writeAuditEvent(tx, {
    eventType: "invoice.deleted",
    entityType: "sales_invoice",
    entityId: current.id,
    details: {
      contactId: current.contactId,
      contactName: current.contactName,
      invoiceDate: current.invoiceDate,
      total: current.total,
    },
  });
}

export type ControlAccount = { systemKey: string; label: string; accountClass: string };

export const RECEIVABLE_ACCOUNT: ControlAccount = { systemKey: "accounts_receivable", label: "accounts receivable", accountClass: "asset" };
export const GST_ACCOUNT: ControlAccount = { systemKey: "gst", label: "GST", accountClass: "liability" };

/**
 * A control account, found by its system key (see the default chart: 1100
 * for accounts receivable, 2000 for accounts payable and 2100 for GST).
 * `refused` says what can't be done without it.
 */
export async function controlAccountCode(tx: OrgTx, control: ControlAccount, refused: string): Promise<string> {
  const result = await tx.query<{ code: string; name: string; account_class: string; currency_code: string | null }>(
    "select code, name, account_class, currency_code from accounts where system_key = $1",
    [control.systemKey],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ValidationError(
      `No account is set up as ${control.label}, so ${refused}. A new organisation gets one in its starting chart of accounts.`,
    );
  }
  if (row.account_class !== control.accountClass) {
    throw new ValidationError(
      `Account ${row.code} (${row.name}) is used for ${control.label}, so it has to be an ${control.accountClass} account.`,
    );
  }
  if (row.currency_code !== null) {
    throw new ValidationError(
      `Account ${row.code} (${row.name}) is used for ${control.label}, so it has to be in the base currency, not ${row.currency_code}.`,
    );
  }
  return row.code;
}

async function invoiceControlAccounts(tx: OrgTx): Promise<{ receivable: string; gst: string }> {
  const refused = "invoices can't be approved";
  return {
    receivable: await controlAccountCode(tx, RECEIVABLE_ACCOUNT, refused),
    gst: await controlAccountCode(tx, GST_ACCOUNT, refused),
  };
}

/** The accounts receivable account that customer payments are credited to. */
export async function receivableAccountCode(tx: OrgTx): Promise<string> {
  return controlAccountCode(tx, RECEIVABLE_ACCOUNT, "payments can't be recorded");
}

export function formatInvoiceNumber(sequence: number): string {
  return `INV-${String(sequence).padStart(4, "0")}`;
}

/**
 * Takes the next invoice number. The counter row stays locked until the
 * transaction ends, and a refused approval rolls it back, so there are no gaps.
 * A number already used by an invoice brought in with the opening balances
 * (IM7) is passed over: that invoice has it.
 */
async function takeInvoiceNumber(tx: OrgTx): Promise<{ sequence: number; invoiceNumber: string }> {
  for (;;) {
    const result = await tx.query<{ last_number: number }>(
      "update sales_invoice_numbering set last_number = last_number + 1 where id = true returning last_number",
    );
    const sequence = Number(result.rows[0].last_number);
    const invoiceNumber = formatInvoiceNumber(sequence);
    const taken = await tx.query("select 1 from sales_invoices where invoice_number = $1 and is_opening_balance", [invoiceNumber]);
    if (taken.rowCount === 0) return { sequence, invoiceNumber };
  }
}

/**
 * Approves a draft (examples I1-I6, I8, I9): gives it the next number and
 * posts one journal on the invoice date, Dr accounts receivable for the total,
 * Cr each revenue account for its net amount and Cr GST for the GST. Refused
 * in a locked period, leaving the draft as it was.
 */
export async function approveInvoice(
  tx: OrgTx,
  invoiceIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; invoice: Invoice; creditWarning?: string }> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("invoice_approval", { invoiceId });
  const replay = async () => {
    const earlier = await findByKey(tx, "approve", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "invoice approval");
    return { created: false, invoice: await getInvoice(tx, earlier.id) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const current = await lockInvoice(tx, invoiceId);
  // The original of a retry may have committed while this request waited for the lock.
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (current.status !== "draft") {
    throw new ConflictError(`${invoiceLabel(current)} is already ${current.status}.`);
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
    "invoice",
    resolved.customFields,
    resolved.resolvedLines.map((line) => ({ values: line.customFields, accountClass: line.accountClass })),
  );
  const accounts = await invoiceControlAccounts(tx);
  await assertPostingDateAllowed(tx, current.invoiceDate);
  // Over the customer's credit limit: refused when set to block, else approved with a warning (RC3-RC5).
  const creditWarning = await checkCreditLimit(tx, { contactId: current.contactId, contactName: resolved.contactName, total: resolved.total });

  const { sequence, invoiceNumber } = await takeInvoiceNumber(tx);
  const scale = currencyMinorUnits(tx.baseCurrency);
  // A foreign-currency invoice posts its base amounts, with its foreign amount on accounts receivable (MC2).
  const foreignCurrency = resolved.exchangeRate !== null;
  // One revenue line per account and set of tracking tags (TC3).
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
    {
      accountCode: accounts.receivable,
      debitAmount: foreignCurrency ? resolved.baseTotal! : resolved.total,
      creditAmount: "0",
      description: customer,
      ...(foreignCurrency
        ? { foreign: { currencyCode: resolved.currencyCode, amount: resolved.total, rate: resolved.exchangeRate!, kind: "document" as const } }
        : {}),
    },
    ...[...revenue.values()]
      .filter((entry) => !isZero(entry.amount))
      .map((entry) => ({
        accountCode: entry.code,
        debitAmount: "0",
        creditAmount: toFixedString(entry.amount, scale),
        description: customer,
        tracking: entry.tracking,
      })),
    ...(isZero(dec(taxTotal)) ? [] : [{ accountCode: accounts.gst, debitAmount: "0", creditAmount: taxTotal, description: "GST" }]),
  ];
  // Stock items move stock and post cost of sales in the same journal (ST1-ST11).
  const stock = await planDocumentStock(
    tx,
    "invoice",
    { id: invoiceId, date: current.invoiceDate, reference: invoiceNumber, contactId: current.contactId },
    resolved.resolvedLines,
    `Cost of sales, invoice ${invoiceNumber}`,
  );
  if (stock) journalLines.push(...stock.journalLines);
  const posted = await postJournalBody(
    tx,
    "invoice:approval",
    invoiceId,
    parseJournalBody(
      tx,
      {
        postingDate: current.invoiceDate,
        reference: invoiceNumber,
        description: `Invoice ${invoiceNumber} to ${customer}`,
        lines: journalLines,
      },
      { internal: true },
    ),
    { origin: "invoice" },
  );
  await stock?.planner.record(posted.journal.id);

  try {
    await tx.query(
      `update sales_invoices
          set status = 'approved', invoice_sequence = $2, invoice_number = $3, approval_journal_id = $4,
              approve_command_source = $5, approve_idempotency_key = $6, approve_request_hash = $7,
              approved_by_user_id = $8, approved_by_email = $9, approved_at = now(), updated_at = now()
        where id = $1`,
      [invoiceId, sequence, invoiceNumber, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The same key was used to approve another invoice by a request that committed first.
      throw new ConflictError(
        "That idempotency key was already used for a different invoice approval. Use a new key for a new invoice approval.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "invoice.approved",
    entityType: "sales_invoice",
    entityId: invoiceId,
    details: {
      invoiceNumber,
      journalId: posted.journal.id,
      invoiceDate: current.invoiceDate,
      total: resolved.total,
      ...(creditWarning ? { creditLimitWarning: creditWarning } : {}),
    },
  });
  return { created: true, invoice: await getInvoice(tx, invoiceId), ...(creditWarning ? { creditWarning } : {}) };
}

/**
 * Voids an approved invoice (example I7): posts the exact reversal of its
 * journal on the void date, which must be in an open period. An invoice can
 * only be voided once, a draft is deleted rather than voided, and an invoice
 * with active payments is refused until they're voided (example CP5), or with
 * credit applied until that's removed (example CN9).
 */
export async function voidInvoice(
  tx: OrgTx,
  invoiceIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<{ created: boolean; invoice: Invoice }> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const hash = requestHash("invoice_void", { invoiceId, voidDate });
  const replay = async () => {
    const earlier = await findByKey(tx, "void", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "invoice void");
    return { created: false, invoice: await getInvoice(tx, earlier.id) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const current = await lockInvoice(tx, invoiceId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (current.status === "draft") {
    throw new ConflictError("This invoice is still a draft, so there's nothing to void. Delete it instead.");
  }
  if (current.status === "voided") {
    throw new ConflictError(`${invoiceLabel(current)} has already been voided.`);
  }
  // A payment that was all overpayment (example OP4) pays nothing on the invoice, so check for any active payment.
  const activePayments = await tx.query(
    "select 1 from customer_payments where invoice_id = $1 and status = 'active' limit 1",
    [invoiceId],
  );
  if (activePayments.rowCount !== 0) {
    // Example CP5. The database refuses it too.
    throw new ConflictError(
      `${invoiceLabel(current)} has payments against it, so it can't be voided. Void its payments first.`,
    );
  }
  if (!isZero(dec(current.amountCredited))) {
    // Example CN9. The database refuses it too.
    throw new ConflictError(
      `${invoiceLabel(current)} has credit applied to it, so it can't be voided. Remove its credit first.`,
    );
  }
  if (voidDate < current.invoiceDate) {
    throw new ValidationError(`The void date can't be before the invoice date (${current.invoiceDate}).`);
  }

  const original = await getJournal(tx, current.approvalJournalId!);
  const voidStock = await planDocumentVoid(
    tx,
    "invoice",
    { id: invoiceId, date: voidDate, reference: `VOID-${original.reference}`.slice(0, 100) },
    (lineIndex) => current.lines[lineIndex]?.tracking ?? {},
    `Stock back on void of ${original.reference}`,
  );
  const posted = await postJournalBody(
    tx,
    "invoice:void",
    invoiceId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${current.invoiceNumber}`,
      description: `Void of invoice ${current.invoiceNumber}`,
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
    { origin: "invoice", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  await voidStock?.planner.record(posted.journal.id);

  try {
    await tx.query(
      `update sales_invoices
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4,
              void_idempotency_key = $5, void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8,
              voided_at = now(), updated_at = now()
        where id = $1`,
      [invoiceId, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "That idempotency key was already used for a different invoice void. Use a new key for a new invoice void.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "invoice.voided",
    entityType: "sales_invoice",
    entityId: invoiceId,
    details: { invoiceNumber: current.invoiceNumber, voidDate, journalId: posted.journal.id },
  });
  return { created: true, invoice: await getInvoice(tx, invoiceId) };
}

/**
 * An invoice still owed at the conversion date, brought in with the opening
 * balances (examples IM5-IM9). It keeps the number it had, has one line for
 * the amount still owed (including GST, with no tax code: its GST was
 * accounted for before the conversion) on the conversion clearing account,
 * and is approved at once: Dr accounts receivable / Cr conversion clearing,
 * dated the conversion date. It can then be paid, credited and voided like
 * any other invoice, and never counts in a GST return or sales report.
 * Called only by the opening balances import (`@/lib/import/conversion`),
 * which checks the contact, number and dates first.
 */
export async function createOpeningInvoice(
  tx: OrgTx,
  input: {
    idempotencyKey: string;
    conversionDate: string;
    clearingAccountCode: string;
    contactId: string;
    contactName: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate: string;
    reference: string | null;
    amount: string;
    /** Including GST, with the GST in each (IM13, IM17-IM20); their amounts add up to `amount`. */
    lines: OpeningLine[];
  },
): Promise<Invoice> {
  const source = "import";
  const hash = requestHash("opening_invoice", { ...input });
  const opening = openingAmounts(input.amount, input.lines);
  const inserted = await tx.query<{ id: string }>(
    `insert into sales_invoices (command_source, idempotency_key, request_hash, contact_id, invoice_date, due_date,
                                 reference, amounts_mode, currency_code, subtotal, tax_total, total, is_opening_balance,
                                 created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $12::numeric, true, $13, $14)
     returning id`,
    [source, input.idempotencyKey, hash, input.contactId, input.invoiceDate, input.dueDate, input.reference, opening.amountsMode, tx.baseCurrency, opening.subtotal, opening.taxTotal, input.amount, tx.actor.userId, tx.actor.email],
  );
  const invoiceId = inserted.rows[0].id;
  for (const [index, line] of input.lines.entries()) {
    await tx.query(
      `insert into sales_invoice_lines (invoice_id, line_order, description, quantity, unit_price, account_id, tax_code_id, tax_rate,
                                        line_amount, net_amount, tax_amount)
       select $1, $2, $3, 1, $4::numeric, a.id, (select id from tax_codes where code = $5), $6::numeric, $4::numeric,
              $4::numeric - $7::numeric, $7::numeric
         from accounts a where a.code = $8`,
      [invoiceId, index + 1, openingLineDescription(input.conversionDate, line), line.amount, line.taxCode, line.rate, line.gst, input.clearingAccountCode],
    );
  }
  const receivable = await controlAccountCode(tx, RECEIVABLE_ACCOUNT, "opening invoices can't be brought in");
  const posted = await postJournalBody(
    tx,
    "invoice:approval",
    invoiceId,
    parseJournalBody(tx, {
      postingDate: input.conversionDate,
      reference: input.invoiceNumber,
      description: `Opening balance: invoice ${input.invoiceNumber} to ${input.contactName}`,
      lines: [
        { accountCode: receivable, debitAmount: input.amount, creditAmount: "0", description: input.contactName },
        { accountCode: input.clearingAccountCode, debitAmount: "0", creditAmount: input.amount, description: `Invoice ${input.invoiceNumber}` },
      ],
    }),
    { origin: "invoice" },
  );
  try {
    await tx.query(
      `update sales_invoices
          set status = 'approved', invoice_number = $2, approval_journal_id = $3,
              approve_command_source = $4, approve_idempotency_key = $5, approve_request_hash = $6,
              approved_by_user_id = $7, approved_by_email = $8, approved_at = now(), updated_at = now()
        where id = $1`,
      [invoiceId, input.invoiceNumber, posted.journal.id, source, input.idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already an invoice numbered ${input.invoiceNumber}.`);
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "invoice.opening_balance",
    entityType: "sales_invoice",
    entityId: invoiceId,
    details: { invoiceNumber: input.invoiceNumber, invoiceDate: input.invoiceDate, amount: input.amount, gst: opening.taxTotal, journalId: posted.journal.id },
  });
  return getInvoice(tx, invoiceId);
}

import { openingAmounts, openingLineDescription, type OpeningLine } from "@/lib/import/opening-gst";
import { parseAccountCodeInput } from "@/lib/accounts/service";
import { assertRequiredFields, type CustomFieldContext, keptCustom, parseCustomInput, resolveDocumentCustom } from "@/lib/custom-fields/service";
import { type CustomValues, customValuesKey } from "@/lib/custom-fields/values";
import { assertRequiredTags, checkNewTags, hashableLine, keptValues, loadTrackingContext, parseTrackingInput, sortedTags, trackingKey, type TrackingTags } from "@/lib/tracking/service";
import type { AccountClass, AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { assertInventoryLines, planDocumentStock, planDocumentVoid } from "@/lib/inventory/stock";
import { fillLinesFromItems, isBlank, LINE_ITEM_COLUMNS, LINE_ITEM_JOINS, lineForHash, lineItemFields, type LineItemFields, type LineItemRef, type LineItemRow, parseLineItem, resolveLineItems, type ResolvedLineItem } from "@/lib/items/lines";
import { billLineAccountProblem } from "@/lib/bills/accounts";
import { dueDateFromSupplierTerms } from "@/lib/customers/service";
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
import { controlAccountCode, GST_ACCOUNT, setBaseLineAmounts, type ControlAccount, type ForeignOption } from "@/lib/invoices/service";
import { assertForeignLinesSupported, contactCurrency, convertDocumentLines, exchangeRateFor, parseRateInput } from "@/lib/fx/documents";
import type { TaxCategory } from "@/lib/tax/categories";
import { getJournal, parseJournalBody, postJournalBody, sameForeign } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { currencyMinorUnits } from "@/lib/money/currency";
import {
  add,
  cmp,
  dec,
  isZero,
  parseDecimalInput,
  toFixedString,
  sub,
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
 * Bills from suppliers, the purchase side of sales invoices. A draft can be
 * edited and deleted and posts nothing. Approving posts its journal (Dr each
 * line's account and GST / Cr accounts payable); after that it can't change,
 * only be voided, which posts the exact reversal. The amounts are worked out
 * the same way as invoices, in `@/lib/invoices/amounts` (examples B1-B4). A
 * bill is known by its supplier's own invoice number; Tohyee doesn't number
 * bills itself. Payments against approved bills are in `@/lib/bills/payments`,
 * and supplier credit applied to them in `@/lib/supplier-credit-notes/applications`.
 */
export const BILL_STATUSES = ["draft", "approved", "voided"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export type BillLine = LineItemFields & {
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
  /** The purchase order line this line was billed against (PO3-PO6), or null. */
  purchaseOrderLineId: string | null;
  /** On a foreign-currency bill: the net amount and GST in the base currency (MC10); null otherwise. */
  baseNetAmount: string | null;
  baseTaxAmount: string | null;
};

export type BillSummary = {
  id: string;
  status: BillStatus;
  contactId: string;
  contactName: string;
  billDate: string;
  dueDate: string;
  /**
   * The supplier's own number for the invoice they sent, as it was typed. A
   * draft can be saved without one (RB11, like NetSuite's optional reference
   * number); approving needs it, so approved and voided bills always have it.
   */
  supplierInvoiceNumber: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  /** Base currency per 1 unit of the bill's currency; null for a base-currency bill (MC10). */
  exchangeRate: string | null;
  /** The base-currency amounts of a foreign-currency bill (its lines converted one by one); null otherwise. */
  baseSubtotal: string | null;
  baseTaxTotal: string | null;
  baseTotal: string | null;
  /** On an approved foreign-currency bill: the base value of what's still due, at the bill's rate. */
  amountDueBase: string | null;
  /** The sum of the bill's active payments (examples SP1-SP4). */
  amountPaid: string;
  /** The sum of the supplier credit applied to the bill (examples SCN3, SCN4). */
  amountCredited: string;
  /** What's still to be paid on an approved bill; null for drafts and voided bills. */
  amountDue: string | null;
  /** Worked out from the bill's active payments and credit applied; null for drafts and voided bills. */
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
  /** The purchase order the bill was copied from (PO3), or null. */
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  /** Owed at the conversion date when the books were brought in (IM5): no GST. */
  isOpeningBalance: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Bill = BillSummary & { lines: BillLine[] };

/** What a person enters. An edit leaves out anything it doesn't change; `lines` replaces every line. */
export type BillInput = {
  contactId?: unknown;
  billDate?: unknown;
  dueDate?: unknown;
  supplierInvoiceNumber?: unknown;
  amountsMode?: unknown;
  lines?: unknown;
  customFields?: unknown;
  /** For a supplier in another currency: base currency per 1 unit (MC10). Left out, the last rate used is taken. */
  exchangeRate?: unknown;
};

const MAX_LINES = 200;
/** Quantities and unit prices allow up to 4 decimal places. */
const LINE_INPUT_SCALE = 4;

type BillRow = {
  id: string;
  status: BillStatus;
  contact_id: string;
  contact_name: string;
  bill_date: string;
  due_date: string;
  supplier_invoice_number: string | null;
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
  purchase_order_id: string | null;
  po_number: string | null;
  is_opening_balance: boolean;
  created_at: string;
  updated_at: string;
};

const SUMMARY_COLUMNS = `b.id, b.status, b.contact_id, c.name as contact_name, b.bill_date, b.due_date,
  b.supplier_invoice_number, b.amounts_mode, b.currency_code, b.subtotal, b.tax_total, b.total,
  paid.amount_paid, credited.amount_credited, b.approval_journal_id, b.approved_at, b.approved_by_email, b.void_date, b.void_journal_id, b.voided_at,
  b.voided_by_email, b.created_by_email, b.created_at, b.updated_at, b.custom_fields, b.purchase_order_id, po.po_number,
  b.is_opening_balance, b.exchange_rate::text, b.base_subtotal::text, b.base_tax_total::text, b.base_total::text,
  base_settled.base_settled::text`;

/** Bills with their supplier and the sums of their active payments and supplier credit applied. */
const SUMMARY_FROM = `bills b
  join contacts c on c.id = b.contact_id
  left join purchase_orders po on po.id = b.purchase_order_id
  cross join lateral (
    select coalesce(sum(p.amount), 0) as amount_paid
      from supplier_payments p
     where p.bill_id = b.id and p.status = 'active'
  ) paid
  cross join lateral (
    select coalesce(sum(a.amount), 0) as amount_credited
      from supplier_credit_note_applications a
     where a.bill_id = b.id and a.status = 'active'
  ) credited
  cross join lateral (
    select tohyee_bill_base_settled(b.id) as base_settled
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
  purchase_order_line_id?: string | null;
  base_net_amount?: string | null;
  base_tax_amount?: string | null;
};

const baseMoney = (value: string | null | undefined) => (value == null ? null : toFixedString(dec(value), 2));

function toSummary(row: BillRow): BillSummary {
  const scale = currencyMinorUnits(row.currency_code);
  const payment = invoicePaymentStatus(row.total, row.amount_paid, scale, row.amount_credited);
  const approved = row.status === "approved";
  return {
    id: row.id,
    status: row.status,
    contactId: row.contact_id,
    contactName: row.contact_name,
    billDate: row.bill_date,
    dueDate: row.due_date,
    supplierInvoiceNumber: row.supplier_invoice_number,
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
    purchaseOrderId: row.purchase_order_id,
    purchaseOrderNumber: row.po_number,
    isOpeningBalance: row.is_opening_balance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLine(row: LineRow): BillLine {
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
    purchaseOrderLineId: row.purchase_order_line_id ?? null,
    baseNetAmount: baseMoney(row.base_net_amount),
    baseTaxAmount: baseMoney(row.base_tax_amount),
  };
}

/** A purchase line as entered (bills and purchase orders). */
export type PurchaseLineInput = {
  description: string;
  quantity: string;
  unitPrice: string;
  accountCode: string;
  taxCode: string | null;
  tracking: TrackingTags;
  customFields: Record<string, unknown> | undefined;
  itemId: string | null;
  unitId: string | null;
  /** Bills only: the purchase order line it's billed against (PO3-PO6). */
  purchaseOrderLineId: string | null;
};

/** A draft as entered, validated but not yet checked against the organisation's data. */
export type DraftDetails = {
  contactId: string;
  billDate: string;
  dueDate: string;
  /** A new bill sent without a due date takes it from the supplier's payment terms (SPT2). */
  dueFromTerms?: boolean;
  /** Null: a draft without the supplier's invoice number yet (RB11). */
  supplierInvoiceNumber: string | null;
  amountsMode: AmountsMode;
  lines: PurchaseLineInput[];
  customInput: Record<string, unknown> | undefined;
  /** As sent: undefined or null when not given (a foreign-currency bill then takes the last rate used). */
  exchangeRateInput?: string | null;
};

/** A draft checked against the chart of accounts, tax codes and contacts, with its amounts. */
export type ResolvedDraft = DraftDetails & {
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
    purchaseOrderLineId: string | null;
    baseNetAmount: string | null;
    baseTaxAmount: string | null;
  }>;
};

function blankInput(input: unknown): boolean {
  return input === null || input === undefined || (typeof input === "string" && input.trim() === "");
}

/**
 * The supplier's invoice number as sent: blank is null (a draft still waiting
 * for the supplier's invoice, RB11); approving needs one.
 */
export function parseSupplierInvoiceNumber(input: unknown): string | null {
  return blankInput(input) ? null : requireString(input, "supplierInvoiceNumber", { maxLength: 100 });
}

function parseDraft(input: BillInput, options: { dueFromTerms?: boolean } = {}): DraftDetails {
  const contactId = requireId(input.contactId, "contactId");
  const billDate = parseIsoDate(input.billDate, "billDate");
  const dueFromTerms = options.dueFromTerms === true && blankInput(input.dueDate);
  // Filled in from the supplier's terms once the idempotency key has been checked (SPT2).
  const dueDate = dueFromTerms ? billDate : parseIsoDate(input.dueDate, "dueDate");
  if (dueDate < billDate) {
    throw new ValidationError("The due date can't be before the bill date.");
  }
  const supplierInvoiceNumber = parseSupplierInvoiceNumber(input.supplierInvoiceNumber);
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  const lines = parsePurchaseLines(input.lines, amountsMode, "A bill", { purchaseOrderLinks: true });
  return {
    contactId,
    billDate,
    dueDate,
    ...(dueFromTerms ? { dueFromTerms } : {}),
    supplierInvoiceNumber,
    amountsMode,
    lines,
    customInput: parseCustomInput(input.customFields, ""),
    exchangeRateInput: parseRateInput(input.exchangeRate),
  };
}

/**
 * Parses purchase lines (bills and purchase orders): each needs a
 * description, quantity, unit price and account unless an item fills them,
 * and a tax code unless the amounts have no tax.
 */
export function parsePurchaseLines(
  input: unknown,
  amountsMode: AmountsMode,
  noun: string,
  options: { purchaseOrderLinks?: boolean } = {},
): PurchaseLineInput[] {
  const rawLines = requireArray(input, "lines", MAX_LINES);
  if (rawLines.length === 0) {
    throw new ValidationError(`${noun} needs at least one line.`);
  }
  return rawLines.map((raw, index) => {
    const label = `Line ${index + 1}`;
    const line = asRecord(raw, label);
    // A line with an item can leave these blank: the item fills them (IT2).
    const item = parseLineItem(line, label);
    const fillable = item.itemId !== null;
    const taxCode = optionalString(line.taxCode, `${label} tax code`, { maxLength: 20 })?.toUpperCase() ?? null;
    if (amountsMode === "no_tax" && taxCode !== null) {
      throw new ValidationError(
        `${label} has a tax code, but ${noun.replace(/^An? /, "the ")}'s amounts have no tax. Remove the tax code or change the amounts to tax exclusive or inclusive.`,
      );
    }
    if (amountsMode !== "no_tax" && taxCode === null && !fillable) {
      throw new ValidationError(
        `${label} needs a tax code (use an exempt or zero-rated code for purchases without GST).`,
      );
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
      purchaseOrderLineId: options.purchaseOrderLinks ? optionalId(line.purchaseOrderLineId, `${label} purchase order line`) : null,
    };
  });
}

/** Normalised content for the idempotency fingerprint. */
function hashPayload(draft: DraftDetails): Record<string, unknown> {
  return {
    contactId: draft.contactId,
    billDate: draft.billDate,
    // Sent without a due date: the supplier's terms decide it, so the hash says so (SPT2).
    dueDate: draft.dueFromTerms ? null : draft.dueDate,
    supplierInvoiceNumber: draft.supplierInvoiceNumber,
    amountsMode: draft.amountsMode,
    lines: hashPurchaseLines(draft.lines),
    // Values that weren't sent stay out, so older requests hash the same.
    ...(draft.customInput !== undefined ? { customFields: draft.customInput } : {}),
    ...(draft.exchangeRateInput != null ? { exchangeRate: draft.exchangeRateInput } : {}),
  };
}

/** Purchase lines for an idempotency hash; a purchase order link only when there is one, so older requests hash the same. */
export function hashPurchaseLines(lines: readonly PurchaseLineInput[]): unknown[] {
  return lines.map(({ purchaseOrderLineId, ...line }) => ({
    ...hashableLine(lineForHash({ ...line, accountCode: line.accountCode.toLowerCase() })),
    ...(purchaseOrderLineId ? { purchaseOrderLineId } : {}),
  }));
}

/**
 * Checks a draft against the organisation's data and works out its amounts.
 * Run when a draft is saved and again when it's approved: the supplier must be
 * an active contact marked as a supplier, each line's account an active
 * account that can take bill lines (`billLineAccountProblem`), and each tax
 * code active and in effect on the bill date.
 */
export async function resolveDraft(
  tx: OrgTx,
  sent: DraftDetails,
  kept: ReadonlySet<string> = new Set(),
  keptFields: ReadonlySet<string> = new Set(),
  keptItems: ReadonlyArray<LineItemRef> = [],
  foreign: ForeignOption = {},
): Promise<ResolvedDraft> {
  // A supplier in another currency gets bills in it (MC1), entered directly only (MC11).
  const currencyCode = await contactCurrency(tx, sent.contactId);
  if (currencyCode !== tx.baseCurrency) {
    if (!foreign.foreignCurrency) {
      const name = (await tx.query<{ name: string }>("select name from contacts where id = $1", [sent.contactId])).rows[0]?.name ?? "This supplier";
      throw new ValidationError(
        `${name} is in ${currencyCode}. ${foreign.feature ?? "This"} for suppliers in a currency other than ${tx.baseCurrency} isn't supported yet (refused rather than guessed): enter a ${currencyCode} bill directly instead.`,
      );
    }
    assertForeignLinesSupported("bill", currencyCode, tx.baseCurrency, [], sent.lines);
  }
  // Blanks on item lines are filled from the item (IT2); what was sent is kept.
  const draft: DraftDetails = { ...sent, lines: await fillLinesFromItems(tx, sent.lines, { side: "purchase", contactId: sent.contactId, noTax: sent.amountsMode === "no_tax" }) };
  const custom = await resolveDocumentCustom(tx, "bill", draft.customInput, draft.lines.map((line) => line.customFields), keptFields);
  const tracking = await loadTrackingContext(tx);
  draft.lines.forEach((line, index) => checkNewTags(tracking, line.tracking, `Line ${index + 1}`, kept));
  const contact = await tx.query<{ name: string; is_supplier: boolean; is_archived: boolean }>(
    "select name, is_supplier, is_archived from contacts where id = $1",
    [draft.contactId],
  );
  const supplier = contact.rows[0];
  if (!supplier) {
    throw new ValidationError(`There's no contact #${draft.contactId}.`);
  }
  if (supplier.is_archived) {
    throw new ValidationError(`${supplier.name} is archived. Unarchive them first, or pick another supplier.`);
  }
  if (!supplier.is_supplier) {
    throw new ValidationError(`${supplier.name} isn't marked as a supplier. Edit the contact first, or pick another one.`);
  }

  const accounts = await tx.query<{
    id: string;
    code: string;
    name: string;
    account_class: AccountClass;
    account_type: AccountType;
    system_key: string | null;
    currency_code: string | null;
    is_active: boolean;
  }>(
    `select id, code, name, account_class, account_type, system_key, currency_code, is_active
       from accounts where lower(code) = any($1::text[])`,
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
    const problem = billLineAccountProblem({
      accountClass: account.account_class,
      accountType: account.account_type,
      systemKey: account.system_key,
      currencyCode: account.currency_code === tx.baseCurrency ? null : account.currency_code,
    });
    if (problem) {
      throw new ValidationError(`${label}: account ${account.code} (${account.name}) is ${problem}`);
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
      if (taxCode.effective_from > draft.billDate || (taxCode.effective_to !== null && taxCode.effective_to < draft.billDate)) {
        throw new ValidationError(
          `${label}: tax code ${taxCode.code} isn't in effect on ${draft.billDate} (it applies from ${taxCode.effective_from}${
            taxCode.effective_to ? ` to ${taxCode.effective_to}` : ""
          }).`,
        );
      }
      taxCodeId = taxCode.id;
      taxRate = toPlainString(dec(taxCode.rate));
      taxCategory = taxCode.category;
    }
    return { ...line, accountId: account.id, accountCode: account.code, accountClass: account.account_class as AccountClass, accountSystemKey: account.system_key, taxCodeId, taxRate, taxCategory };
  });

  const lineItems = await resolveLineItems(tx, draft.lines, "purchase", keptItems);
  // Stock items go to the inventory account, and only they do (ST1, ST6).
  assertInventoryLines(lines.map((line, index) => ({ ...lineItems[index], accountSystemKey: line.accountSystemKey, accountCode: line.accountCode })));
  const scale = currencyMinorUnits(currencyCode);
  const amounts = calculateInvoice(draft.amountsMode, lines, scale);
  amounts.lines.forEach((line, index) => {
    if (isZero(dec(line.lineAmount))) {
      throw new ValidationError(
        `Line ${index + 1} comes to ${line.lineAmount} once rounded to ${currencyCode}. Check its quantity and unit price.`,
      );
    }
  });
  // A foreign-currency bill (MC10): no standard-rated GST or stock yet; a rate for its date; each line converted.
  let exchangeRate: string | null = null;
  let base: ReturnType<typeof convertDocumentLines> | null = null;
  if (currencyCode !== tx.baseCurrency) {
    assertForeignLinesSupported(
      "bill",
      currencyCode,
      tx.baseCurrency,
      lines.map((line, index) => ({ taxCategory: line.taxCategory, itemType: lineItems[index].itemType })),
      [],
    );
    exchangeRate = await exchangeRateFor(tx, { currencyCode, date: draft.billDate, typed: draft.exchangeRateInput, what: "bill" });
    base = convertDocumentLines(amounts.lines, exchangeRate!, currencyMinorUnits(tx.baseCurrency));
  }

  return {
    ...draft,
    customFields: custom.body,
    customCtx: custom.ctx,
    contactName: supplier.name,
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
      purchaseOrderLineId: line.purchaseOrderLineId,
      baseNetAmount: base?.lines[index].baseNetAmount ?? null,
      baseTaxAmount: base?.lines[index].baseTaxAmount ?? null,
    })),
  };
}

/** The expression the unique index on non-voided bills uses: no whitespace, lower case. */
const COMPARABLE_NUMBER = (column: string) => `lower(regexp_replace(${column}, '[[:space:]]', '', 'g'))`;
const NUMBER_INDEX = "bills_supplier_invoice_number_key";

function numberTaken(supplier: string, number: string | null, existing?: { id: string; status: BillStatus }): ConflictError {
  return new ConflictError(
    `${supplier} already has a bill with the invoice number ${number}${
      existing ? ` (${existing.status} bill #${existing.id})` : ""
    }. Numbers are compared ignoring case and spaces, so check this bill hasn't been entered already.`,
  );
}

/**
 * Example B5: a supplier can't have two bills that aren't voided with the
 * same invoice number, ignoring case and spaces. The database's unique index
 * refuses it too; this finds the other bill to say which one it is.
 */
async function assertNumberFree(
  tx: OrgTx,
  draft: { contactId: string; contactName: string; supplierInvoiceNumber: string | null },
  exceptBillId: string | null,
): Promise<void> {
  if (draft.supplierInvoiceNumber === null) return;
  const clash = await tx.query<{ id: string; status: BillStatus; supplier_invoice_number: string }>(
    `select id, status, supplier_invoice_number from bills
      where contact_id = $1 and status <> 'voided'
        and ${COMPARABLE_NUMBER("supplier_invoice_number")} = ${COMPARABLE_NUMBER("$2::text")}
        and ($3::bigint is null or id <> $3)
      order by id
      limit 1`,
    [draft.contactId, draft.supplierInvoiceNumber, exceptBillId],
  );
  const existing = clash.rows[0];
  if (existing) {
    throw numberTaken(draft.contactName, existing.supplier_invoice_number, existing);
  }
}

/**
 * Waits for a statement that saves a bill's supplier and number. If another
 * request saved the same number after `assertNumberFree` looked, the unique
 * index refuses this one, and the person is told why.
 */
async function savingNumber<T>(draft: ResolvedDraft, statement: Promise<T>): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    if (isUniqueViolation(error, NUMBER_INDEX)) {
      throw numberTaken(draft.contactName, draft.supplierInvoiceNumber);
    }
    throw error;
  }
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
  purchaseOrderLineId?: string | null;
};

type StoredHeader = {
  contactId: string;
  billDate: string;
  dueDate: string;
  supplierInvoiceNumber: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  customFields: CustomValues;
  exchangeRate: string | null;
  baseTotal: string | null;
};

const plain = (value: string) => toPlainString(dec(value));

/** What's stored for a draft's header and lines, to tell whether an edit changed anything. */
function headerState(bill: StoredHeader): string {
  return JSON.stringify([
    bill.contactId,
    bill.billDate,
    bill.dueDate,
    bill.supplierInvoiceNumber,
    bill.amountsMode,
    bill.currencyCode,
    plain(bill.subtotal),
    plain(bill.taxTotal),
    plain(bill.total),
    customValuesKey(bill.customFields),
    bill.exchangeRate === null ? null : plain(bill.exchangeRate),
    bill.baseTotal === null ? null : plain(bill.baseTotal),
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
      line.purchaseOrderLineId ?? null,
    ]),
  );
}

function sameAsStored(resolved: ResolvedDraft, current: Bill): { header: boolean; lines: boolean } {
  return {
    header: headerState(resolved) === headerState(current),
    lines: linesState(resolved.resolvedLines) === linesState(current.lines),
  };
}

/** The saved draft, in the shape a person would send it. */
function draftOf(bill: Bill): DraftDetails {
  return {
    contactId: bill.contactId,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    supplierInvoiceNumber: bill.supplierInvoiceNumber,
    amountsMode: bill.amountsMode,
    lines: bill.lines.map((line) => ({
      description: line.description,
      quantity: toPlainString(dec(line.quantity)),
      unitPrice: toPlainString(dec(line.unitPrice)),
      accountCode: line.accountCode,
      taxCode: line.taxCode,
      tracking: line.tracking,
      customFields: line.customFields,
      itemId: line.itemId,
      unitId: line.unitId,
      purchaseOrderLineId: line.purchaseOrderLineId,
    })),
    customInput: bill.customFields,
    exchangeRateInput: bill.exchangeRate,
  };
}

/** The tables that hold purchase lines, and the column naming each line's parent. */
export type PurchaseLineTable = "bill_lines" | "purchase_order_lines" | "repeating_bill_lines";
const PURCHASE_LINE_PARENT: Record<PurchaseLineTable, string> = {
  bill_lines: "bill_id",
  purchase_order_lines: "purchase_order_id",
  repeating_bill_lines: "repeating_bill_id",
};

/**
 * Saves purchase lines: a bill's (with any purchase order links), a purchase
 * order's or a repeating bill template's (RB1), which have the same columns
 * otherwise.
 */
export async function insertPurchaseLines(
  tx: OrgTx,
  table: PurchaseLineTable,
  parentId: string,
  lines: ResolvedDraft["resolvedLines"],
): Promise<void> {
  const bill = table === "bill_lines";
  const width = bill ? 17 : 16;
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
    if (bill) values.push(line.purchaseOrderLineId);
    const base = index * width;
    const p = (offset: number) => `$${base + offset}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}::numeric, ${p(5)}::numeric, ${p(6)}, ${p(7)}, ${p(8)}::numeric, ${p(9)}::numeric, ${p(10)}::numeric, ${p(11)}::numeric, ${p(12)}::jsonb, ${p(13)}::jsonb, ${p(14)}, ${p(15)}, ${p(16)}::numeric${bill ? `, ${p(17)}` : ""})`;
  });
  await tx.query(
    `insert into ${table} (${PURCHASE_LINE_PARENT[table]}, line_order, description, quantity, unit_price, account_id,
                             tax_code_id, tax_rate, line_amount, net_amount, tax_amount, tracking, custom_fields, item_id, unit_id, base_quantity${bill ? ", purchase_order_line_id" : ""})
     values ${tuples.join(", ")}`,
    values,
  );
}

async function insertLines(tx: OrgTx, billId: string, lines: ResolvedDraft["resolvedLines"]): Promise<void> {
  await insertPurchaseLines(tx, "bill_lines", billId, lines);
  await setBaseLineAmounts(tx, "bill_lines", "bill_id", billId, lines);
}

/** A bill's, purchase order's or repeating bill template's lines, in order. */
export async function loadPurchaseLines(tx: OrgTx, table: PurchaseLineTable, parentId: string): Promise<BillLine[]> {
  const bill = table === "bill_lines";
  const lines = await tx.query<LineRow & { id: string }>(
    `select l.id, l.line_order, l.description, l.quantity, l.unit_price, l.account_id, a.code as account_code,
            a.name as account_name, l.tax_code_id, t.code as tax_code, l.tax_rate, l.line_amount,
            l.net_amount, l.tax_amount, l.tracking, l.custom_fields, ${LINE_ITEM_COLUMNS}${
              bill ? ", l.purchase_order_line_id, l.base_net_amount::text, l.base_tax_amount::text" : ""
            }
       from ${table} l
       join accounts a on a.id = l.account_id
       left join tax_codes t on t.id = l.tax_code_id
       ${LINE_ITEM_JOINS}
      where l.${PURCHASE_LINE_PARENT[table]} = $1
      order by l.line_order`,
    [parentId],
  );
  return lines.rows.map(toLine);
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
    `select id, ${columns.hash} as hash from bills where ${columns.source} = $1 and ${columns.key} = $2`,
    [source, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const { code, constraint: violated } = error as { code?: string; constraint?: string };
  return code === "23505" && (constraint === undefined || violated === constraint);
}

function billLabel(bill: BillSummary): string {
  return bill.supplierInvoiceNumber === null ? `The draft bill from ${bill.contactName}` : `Bill ${bill.supplierInvoiceNumber} from ${bill.contactName}`;
}

export async function getBill(tx: OrgTx, billIdInput: unknown): Promise<Bill> {
  const billId = requireId(billIdInput, "billId");
  const result = await tx.query<BillRow>(`select ${SUMMARY_COLUMNS} from ${SUMMARY_FROM} where b.id = $1`, [billId]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Bill not found.");
  }
  return { ...toSummary(row), lines: await loadPurchaseLines(tx, "bill_lines", billId) };
}

/** Loads a bill and locks it until the transaction ends. */
export async function lockBill(tx: OrgTx, billId: string): Promise<Bill> {
  const locked = await tx.query("select id from bills where id = $1 for update", [billId]);
  if (locked.rowCount === 0) {
    throw new NotFoundError("Bill not found.");
  }
  return getBill(tx, billId);
}

function assertDraft(bill: Bill, action: "edited" | "deleted"): void {
  if (bill.status !== "draft") {
    throw new ConflictError(
      `${billLabel(bill)} is ${bill.status}, so it can't be ${action}.${bill.status === "approved" ? " Void it instead." : ""}`,
    );
  }
}

/**
 * Newest first, 50 at a time; `status` filters, `awaitingPayment` keeps only
 * approved bills with something still due, `contactId` keeps one supplier's
 * bills, and `beforeId` pages.
 */
export async function listBills(
  tx: OrgTx,
  filters: { status?: unknown; awaitingPayment?: unknown; contactId?: unknown; beforeId?: unknown; limit?: unknown } = {},
): Promise<{ bills: BillSummary[]; nextBeforeId: string | null }> {
  const status =
    filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", BILL_STATUSES);
  const awaitingPayment = optionalBoolean(filters.awaitingPayment, "awaitingPayment") ?? false;
  const contactId = optionalId(filters.contactId, "contactId");
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const limitRaw = Number(filters.limit ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
  const result = await tx.query<BillRow>(
    `select ${SUMMARY_COLUMNS} from ${SUMMARY_FROM}
      where ($1::text is null or b.status = $1) and ($2::bigint is null or b.id < $2)
        and (not $3::boolean or (b.status = 'approved' and paid.amount_paid + credited.amount_credited < b.total))
        and ($4::bigint is null or b.contact_id = $4)
      order by b.id desc
      limit ${limit + 1}`,
    [status, beforeId, awaitingPayment, contactId],
  );
  const rows = result.rows.slice(0, limit);
  return {
    bills: rows.map(toSummary),
    nextBeforeId: result.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

/**
 * Lines billed against a purchase order (PO3-PO6): the bill must be from
 * that purchase order (approved, same supplier), each linked line keeps its
 * purchase order line's item and unit, and the bills that aren't voided
 * never add up to more than was ordered on a line. Locks the purchase order
 * so two bills can't both take what's left. The database checks the same.
 */
async function checkPurchaseOrderLinks(
  tx: OrgTx,
  purchaseOrderId: string | null,
  draft: ResolvedDraft,
  exceptBillId: string | null,
): Promise<void> {
  const linked = draft.resolvedLines.flatMap((line, index) => (line.purchaseOrderLineId ? [{ line, index }] : []));
  if (purchaseOrderId === null) {
    if (linked.length > 0) {
      throw new ValidationError(`Line ${linked[0].index + 1} is from a purchase order line, but this bill wasn't made from a purchase order.`);
    }
    return;
  }
  const po = await tx.query<{ status: string; contact_id: string; po_number: string | null }>(
    "select status, contact_id, po_number from purchase_orders where id = $1 for update",
    [purchaseOrderId],
  );
  const order = po.rows[0];
  if (!order) throw new NotFoundError("Purchase order not found.");
  if (order.status !== "approved") {
    throw new ConflictError(`Purchase order ${order.po_number ?? `#${purchaseOrderId}`} is ${order.status}, so it can't be billed.`);
  }
  if (order.contact_id !== draft.contactId) {
    throw new ValidationError(`This bill is from purchase order ${order.po_number}, so its supplier can't change.`);
  }
  if (linked.length === 0) return;
  const poLines = await tx.query<{ id: string; line_order: number; quantity: string; item_id: string | null; unit_id: string | null; other_bills: string }>(
    `select l.id, l.line_order, l.quantity::text, l.item_id, l.unit_id,
            coalesce((select sum(bl.quantity) from bill_lines bl join bills b on b.id = bl.bill_id
                       where bl.purchase_order_line_id = l.id and b.status <> 'voided'
                         and ($2::bigint is null or b.id <> $2)), 0)::text as other_bills
       from purchase_order_lines l where l.purchase_order_id = $1`,
    [purchaseOrderId, exceptBillId],
  );
  const byId = new Map(poLines.rows.map((row) => [row.id, row]));
  const onThisBill = new Map<string, Decimal>();
  for (const { line, index } of linked) {
    const label = `Line ${index + 1}`;
    const poLine = byId.get(line.purchaseOrderLineId!);
    if (!poLine) throw new ValidationError(`${label} isn't from ${order.po_number}'s lines.`);
    if ((line.itemId ?? null) !== poLine.item_id || (line.unitId ?? null) !== poLine.unit_id) {
      throw new ValidationError(
        `${label} is from ${order.po_number} line ${poLine.line_order}, so it keeps that line's item and unit. Remove the line and add a new one for something else.`,
      );
    }
    const total = add(onThisBill.get(poLine.id) ?? ZERO_DECIMAL, dec(line.quantity));
    onThisBill.set(poLine.id, total);
    const left = sub(dec(poLine.quantity), dec(poLine.other_bills));
    if (cmp(total, left) > 0) {
      throw new ValidationError(
        `${label}: ${order.po_number} line ${poLine.line_order} ordered ${toPlainString(dec(poLine.quantity))}, and ${toPlainString(dec(poLine.other_bills))} of it is on other bills, so at most ${toPlainString(left)} can be billed here. Put anything extra on a line of its own.`,
      );
    }
  }
}

/** Saves a new draft (examples B1-B5, B8). Drafts post nothing. `purchaseOrderId` is for copying a purchase order to a bill (PO3). */
export async function createBill(
  tx: OrgTx,
  input: BillInput & { source?: unknown; idempotencyKey: unknown },
  link: { purchaseOrderId: string } | null = null,
  foreign: ForeignOption = {},
): Promise<{ created: boolean; bill: Bill }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const draft = parseDraft(input, { dueFromTerms: true });
  const hash = requestHash("bill", { ...hashPayload(draft), ...(link ? { purchaseOrderId: link.purchaseOrderId } : {}) });

  const existing = await findByKey(tx, "create", source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.hash, hash, "bill");
    return { created: false, bill: await getBill(tx, existing.id) };
  }
  if (draft.dueFromTerms) {
    const fromTerms = await dueDateFromSupplierTerms(tx, draft.contactId, draft.billDate);
    if (fromTerms === null) {
      throw new ValidationError("dueDate is required (YYYY-MM-DD): this supplier has no payment terms to work it out from.");
    }
    draft.dueDate = fromTerms;
  }

  const resolved = await resolveDraft(tx, draft, new Set(), new Set(), [], foreign);
  await checkPurchaseOrderLinks(tx, link?.purchaseOrderId ?? null, resolved, null);
  await assertNumberFree(tx, resolved, null);
  const inserted = await savingNumber(
    resolved,
    tx.query<{ id: string }>(
      `insert into bills (command_source, idempotency_key, request_hash, contact_id, bill_date, due_date,
                          supplier_invoice_number, amounts_mode, currency_code, subtotal, tax_total, total,
                          created_by_user_id, created_by_email, purchase_order_id,
                          exchange_rate, base_subtotal, base_tax_total, base_total)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $12::numeric, $13, $14, $15,
               $16::numeric, $17::numeric, $18::numeric, $19::numeric)
       on conflict (command_source, idempotency_key) do nothing
       returning id`,
      [
        source,
        idempotencyKey,
        hash,
        resolved.contactId,
        resolved.billDate,
        resolved.dueDate,
        resolved.supplierInvoiceNumber,
        resolved.amountsMode,
        resolved.currencyCode,
        resolved.subtotal,
        resolved.taxTotal,
        resolved.total,
        tx.actor.userId,
        tx.actor.email,
        link?.purchaseOrderId ?? null,
        resolved.exchangeRate,
        resolved.baseSubtotal,
        resolved.baseTaxTotal,
        resolved.baseTotal,
      ],
    ),
  );
  const billId = inserted.rows[0]?.id;
  if (!billId) {
    // Another request with the same key committed first.
    const winner = await findByKey(tx, "create", source, idempotencyKey);
    if (!winner) {
      throw new ConflictError("That bill is being saved by another request. Try again.");
    }
    assertSameRequest(winner.hash, hash, "bill");
    return { created: false, bill: await getBill(tx, winner.id) };
  }
  await insertLines(tx, billId, resolved.resolvedLines);
  await tx.query("update bills set custom_fields = $2::jsonb where id = $1", [billId, JSON.stringify(resolved.customFields)]);
  await writeAuditEvent(tx, {
    eventType: "bill.created",
    entityType: "bill",
    entityId: billId,
    details: {
      contactId: resolved.contactId,
      supplierInvoiceNumber: resolved.supplierInvoiceNumber,
      billDate: resolved.billDate,
      amountsMode: resolved.amountsMode,
      total: resolved.total,
      lines: resolved.resolvedLines.length,
      ...(link ? { purchaseOrderId: link.purchaseOrderId } : {}),
    },
  });
  return { created: true, bill: await getBill(tx, billId) };
}

/**
 * Edits a draft. Fields that aren't sent keep their values; `lines` replaces
 * all the lines. Everything is checked and the amounts worked out again. An
 * edit that changes nothing isn't saved or audited.
 */
export async function updateBill(tx: OrgTx, billIdInput: unknown, input: BillInput): Promise<Bill> {
  const current = await lockBill(tx, requireId(billIdInput, "billId"));
  assertDraft(current, "edited");
  const saved = draftOf(current);
  const draft = parseDraft({
    contactId: input.contactId === undefined ? saved.contactId : input.contactId,
    billDate: input.billDate === undefined ? saved.billDate : input.billDate,
    dueDate: input.dueDate === undefined ? saved.dueDate : input.dueDate,
    supplierInvoiceNumber:
      input.supplierInvoiceNumber === undefined ? saved.supplierInvoiceNumber : input.supplierInvoiceNumber,
    amountsMode: input.amountsMode === undefined ? saved.amountsMode : input.amountsMode,
    lines: input.lines === undefined ? saved.lines : input.lines,
    customFields: input.customFields === undefined ? saved.customInput : input.customFields,
    // Not sent: the saved rate stays while the supplier does.
    exchangeRate:
      input.exchangeRate !== undefined
        ? input.exchangeRate
        : input.contactId === undefined || String(input.contactId) === saved.contactId
          ? saved.exchangeRateInput
          : undefined,
  });
  const resolved = await resolveDraft(tx, draft, keptValues(current.lines), keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)), current.lines, { foreignCurrency: true });
  const same = sameAsStored(resolved, current);
  if (same.header && same.lines) {
    return current;
  }
  await checkPurchaseOrderLinks(tx, current.purchaseOrderId, resolved, current.id);
  await assertNumberFree(tx, resolved, current.id);

  const changed: string[] = (
    ["contactId", "billDate", "dueDate", "supplierInvoiceNumber", "amountsMode", "exchangeRate"] as const
  ).filter((field) => resolved[field] !== current[field]);
  if (!same.lines) {
    changed.push("lines");
  }
  if (customValuesKey(resolved.customFields) !== customValuesKey(current.customFields)) {
    changed.push("customFields");
  }
  await savingNumber(
    resolved,
    tx.query(
      `update bills
          set contact_id = $2, bill_date = $3, due_date = $4, supplier_invoice_number = $5, amounts_mode = $6,
              currency_code = $7, subtotal = $8::numeric, tax_total = $9::numeric, total = $10::numeric,
              exchange_rate = $11::numeric, base_subtotal = $12::numeric, base_tax_total = $13::numeric, base_total = $14::numeric,
              updated_at = now()
        where id = $1`,
      [
        current.id,
        resolved.contactId,
        resolved.billDate,
        resolved.dueDate,
        resolved.supplierInvoiceNumber,
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
    ),
  );
  await tx.query("delete from bill_lines where bill_id = $1", [current.id]);
  await insertLines(tx, current.id, resolved.resolvedLines);
  await tx.query("update bills set custom_fields = $2::jsonb where id = $1", [current.id, JSON.stringify(resolved.customFields)]);
  await writeAuditEvent(tx, {
    eventType: "bill.updated",
    entityType: "bill",
    entityId: current.id,
    details: { changed, total: { from: current.total, to: resolved.total } },
  });
  return getBill(tx, current.id);
}

/** Deletes a draft (approved bills are voided instead). */
export async function deleteBill(tx: OrgTx, billIdInput: unknown): Promise<void> {
  const current = await lockBill(tx, requireId(billIdInput, "billId"));
  assertDraft(current, "deleted");
  // Its notes and files go with it (NF12).
  await removeRecordExtras(tx, "bill", current.id);
  await tx.query("delete from bill_lines where bill_id = $1", [current.id]);
  await tx.query("delete from bills where id = $1", [current.id]);
  await writeAuditEvent(tx, {
    eventType: "bill.deleted",
    entityType: "bill",
    entityId: current.id,
    details: {
      contactId: current.contactId,
      contactName: current.contactName,
      supplierInvoiceNumber: current.supplierInvoiceNumber,
      billDate: current.billDate,
      total: current.total,
    },
  });
}

export const PAYABLE_ACCOUNT: ControlAccount = { systemKey: "accounts_payable", label: "accounts payable", accountClass: "liability" };

/** The accounts payable account that supplier payments are debited to. */
export async function payableAccountCode(tx: OrgTx): Promise<string> {
  return controlAccountCode(tx, PAYABLE_ACCOUNT, "payments can't be recorded");
}

async function billControlAccounts(tx: OrgTx): Promise<{ payable: string; gst: string }> {
  const refused = "bills can't be approved";
  return {
    payable: await controlAccountCode(tx, PAYABLE_ACCOUNT, refused),
    gst: await controlAccountCode(tx, GST_ACCOUNT, refused),
  };
}

/**
 * Approves a draft (examples B1-B4, B7, B8): posts one journal on the bill
 * date, Dr each line's account for its net amount, Dr GST for the GST and
 * Cr accounts payable for the total. Refused in a locked period, leaving the
 * draft as it was.
 */
export async function approveBill(
  tx: OrgTx,
  billIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; bill: Bill }> {
  const billId = requireId(billIdInput, "billId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("bill_approval", { billId });
  const replay = async () => {
    const earlier = await findByKey(tx, "approve", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "bill approval");
    return { created: false, bill: await getBill(tx, earlier.id) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const current = await lockBill(tx, billId);
  // The original of a retry may have committed while this request waited for the lock.
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (current.status !== "draft") {
    throw new ConflictError(`${billLabel(current)} is already ${current.status}.`);
  }
  // RB11: a draft can wait for the supplier's invoice, but an approved bill needs its number (B5). The database refuses it too.
  const number = current.supplierInvoiceNumber;
  if (number === null) {
    throw new ValidationError(
      `Add the supplier's invoice number before approving: this draft bill from ${current.contactName} doesn't have one yet. Type it from their invoice when it arrives.`,
    );
  }

  const resolved = await resolveDraft(tx, draftOf(current), keptValues(current.lines), keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)), current.lines, { foreignCurrency: true });
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
    "bill",
    resolved.customFields,
    resolved.resolvedLines.map((line) => ({ values: line.customFields, accountClass: line.accountClass })),
  );
  const accounts = await billControlAccounts(tx);
  await assertPostingDateAllowed(tx, current.billDate);

  const scale = currencyMinorUnits(tx.baseCurrency);
  // A foreign-currency bill posts its base amounts, with its foreign amount on accounts payable (MC10).
  const foreignCurrency = resolved.exchangeRate !== null;
  // One line per account and set of tracking tags (TC4, TC10).
  const costs = new Map<string, { code: string; amount: Decimal; tracking: TrackingTags }>();
  for (const line of resolved.resolvedLines) {
    const key = `${line.accountId}|${trackingKey(line.tracking)}`;
    const entry = costs.get(key) ?? { code: line.accountCode, amount: ZERO_DECIMAL, tracking: line.tracking };
    entry.amount = add(entry.amount, dec(foreignCurrency ? line.baseNetAmount! : line.netAmount));
    costs.set(key, entry);
  }
  const supplier = resolved.contactName;
  const taxTotal = foreignCurrency ? resolved.baseTaxTotal! : resolved.taxTotal;
  const journalLines = [
    ...[...costs.values()]
      .filter((entry) => !isZero(entry.amount))
      .map((entry) => ({
        accountCode: entry.code,
        debitAmount: toFixedString(entry.amount, scale),
        creditAmount: "0",
        description: supplier,
        tracking: entry.tracking,
      })),
    ...(isZero(dec(taxTotal)) ? [] : [{ accountCode: accounts.gst, debitAmount: taxTotal, creditAmount: "0", description: "GST" }]),
    {
      accountCode: accounts.payable,
      debitAmount: "0",
      creditAmount: foreignCurrency ? resolved.baseTotal! : resolved.total,
      description: supplier,
      ...(foreignCurrency
        ? { foreign: { currencyCode: resolved.currencyCode, amount: resolved.total, rate: resolved.exchangeRate!, kind: "document" as const } }
        : {}),
    },
  ];
  // Stock items move stock and post cost of sales in the same journal (ST1-ST11).
  const stock = await planDocumentStock(
    tx,
    "bill",
    { id: billId, date: current.billDate, reference: number, contactId: current.contactId },
    resolved.resolvedLines,
    `Stock received, bill ${number}`,
  );
  if (stock) journalLines.push(...stock.journalLines);
  const posted = await postJournalBody(
    tx,
    "bill:approval",
    billId,
    parseJournalBody(
      tx,
      {
        postingDate: current.billDate,
        reference: number,
        description: `Bill ${number} from ${supplier}`,
        lines: journalLines,
      },
      { internal: true },
    ),
    { origin: "bill" },
  );
  await stock?.planner.record(posted.journal.id);

  try {
    await tx.query(
      `update bills
          set status = 'approved', approval_journal_id = $2, approve_command_source = $3,
              approve_idempotency_key = $4, approve_request_hash = $5, approved_by_user_id = $6,
              approved_by_email = $7, approved_at = now(), updated_at = now()
        where id = $1`,
      [billId, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The same key was used to approve another bill by a request that committed first.
      throw new ConflictError(
        "That idempotency key was already used for a different bill approval. Use a new key for a new bill approval.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "bill.approved",
    entityType: "bill",
    entityId: billId,
    details: {
      supplierInvoiceNumber: number,
      journalId: posted.journal.id,
      billDate: current.billDate,
      total: resolved.total,
    },
  });
  return { created: true, bill: await getBill(tx, billId) };
}

/**
 * Voids an approved bill (example B6): posts the exact reversal of its
 * journal on the void date, which must be in an open period and not before
 * the bill date. A bill can only be voided once, a draft is deleted rather
 * than voided, and a bill with active payments is refused until they're
 * voided (example SP5).
 */
export async function voidBill(
  tx: OrgTx,
  billIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<{ created: boolean; bill: Bill }> {
  const billId = requireId(billIdInput, "billId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const hash = requestHash("bill_void", { billId, voidDate });
  const replay = async () => {
    const earlier = await findByKey(tx, "void", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "bill void");
    return { created: false, bill: await getBill(tx, earlier.id) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const current = await lockBill(tx, billId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (current.status === "draft") {
    throw new ConflictError("This bill is still a draft, so there's nothing to void. Delete it instead.");
  }
  if (current.status === "voided") {
    throw new ConflictError(`${billLabel(current)} has already been voided.`);
  }
  if (!isZero(dec(current.amountPaid))) {
    // Example SP5. The database refuses it too.
    throw new ConflictError(
      `${billLabel(current)} has payments against it, so it can't be voided. Void its payments first.`,
    );
  }
  if (!isZero(dec(current.amountCredited))) {
    // Example SCN9. The database refuses it too.
    throw new ConflictError(`${billLabel(current)} has credit applied to it, so it can't be voided. Remove its credit first.`);
  }
  if (voidDate < current.billDate) {
    throw new ValidationError(`The void date can't be before the bill date (${current.billDate}).`);
  }

  const original = await getJournal(tx, current.approvalJournalId!);
  const voidStock = await planDocumentVoid(
    tx,
    "bill",
    { id: billId, date: voidDate, reference: `VOID-${original.reference}`.slice(0, 100) },
    (lineIndex) => current.lines[lineIndex]?.tracking ?? {},
    `Stock back on void of ${original.reference}`,
  );
  const posted = await postJournalBody(
    tx,
    "bill:void",
    billId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of bill ${current.supplierInvoiceNumber} from ${current.contactName}`,
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
    { origin: "bill", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  await voidStock?.planner.record(posted.journal.id);

  try {
    await tx.query(
      `update bills
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4,
              void_idempotency_key = $5, void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8,
              voided_at = now(), updated_at = now()
        where id = $1`,
      [billId, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "That idempotency key was already used for a different bill void. Use a new key for a new bill void.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "bill.voided",
    entityType: "bill",
    entityId: billId,
    details: { supplierInvoiceNumber: current.supplierInvoiceNumber, voidDate, journalId: posted.journal.id },
  });
  return { created: true, bill: await getBill(tx, billId) };
}

/**
 * A bill still owed at the conversion date, brought in with the opening
 * balances (examples IM5-IM9): one line for the amount still owed
 * (including GST, with no tax code: its GST was claimed before the
 * conversion) on the conversion clearing account, approved at once:
 * Dr conversion clearing / Cr accounts payable, dated the conversion date. It
 * can then be paid, credited and voided like any other bill, and never counts
 * in a GST return. Called only by the opening balances import
 * (`@/lib/import/conversion`), which checks the supplier, number and dates.
 */
export async function createOpeningBill(
  tx: OrgTx,
  input: {
    idempotencyKey: string;
    conversionDate: string;
    clearingAccountCode: string;
    contactId: string;
    contactName: string;
    supplierInvoiceNumber: string;
    billDate: string;
    dueDate: string;
    amount: string;
    /** Including GST, with the GST in each (IM13, IM17-IM20); their amounts add up to `amount`. */
    lines: OpeningLine[];
  },
): Promise<Bill> {
  const source = "import";
  const hash = requestHash("opening_bill", { ...input });
  const opening = openingAmounts(input.amount, input.lines);
  let billId: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into bills (command_source, idempotency_key, request_hash, contact_id, bill_date, due_date, supplier_invoice_number,
                          amounts_mode, currency_code, subtotal, tax_total, total, is_opening_balance, created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $12::numeric, true, $13, $14)
       returning id`,
      [source, input.idempotencyKey, hash, input.contactId, input.billDate, input.dueDate, input.supplierInvoiceNumber, opening.amountsMode, tx.baseCurrency, opening.subtotal, opening.taxTotal, input.amount, tx.actor.userId, tx.actor.email],
    );
    billId = inserted.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error, NUMBER_INDEX)) throw numberTaken(input.contactName, input.supplierInvoiceNumber);
    throw error;
  }
  for (const [index, line] of input.lines.entries()) {
    await tx.query(
      `insert into bill_lines (bill_id, line_order, description, quantity, unit_price, account_id, tax_code_id, tax_rate,
                               line_amount, net_amount, tax_amount)
       select $1, $2, $3, 1, $4::numeric, a.id, (select id from tax_codes where code = $5), $6::numeric, $4::numeric,
              $4::numeric - $7::numeric, $7::numeric
         from accounts a where a.code = $8`,
      [billId, index + 1, openingLineDescription(input.conversionDate, line), line.amount, line.taxCode, line.rate, line.gst, input.clearingAccountCode],
    );
  }
  const payable = await controlAccountCode(tx, PAYABLE_ACCOUNT, "opening bills can't be brought in");
  const posted = await postJournalBody(
    tx,
    "bill:approval",
    billId,
    parseJournalBody(tx, {
      postingDate: input.conversionDate,
      reference: input.supplierInvoiceNumber.slice(0, 100),
      description: `Opening balance: bill ${input.supplierInvoiceNumber} from ${input.contactName}`,
      lines: [
        { accountCode: input.clearingAccountCode, debitAmount: input.amount, creditAmount: "0", description: `Bill ${input.supplierInvoiceNumber}` },
        { accountCode: payable, debitAmount: "0", creditAmount: input.amount, description: input.contactName },
      ],
    }),
    { origin: "bill" },
  );
  await tx.query(
    `update bills
        set status = 'approved', approval_journal_id = $2, approve_command_source = $3, approve_idempotency_key = $4,
            approve_request_hash = $5, approved_by_user_id = $6, approved_by_email = $7, approved_at = now(), updated_at = now()
      where id = $1`,
    [billId, posted.journal.id, source, input.idempotencyKey, hash, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bill.opening_balance",
    entityType: "bill",
    entityId: billId,
    details: { supplierInvoiceNumber: input.supplierInvoiceNumber, billDate: input.billDate, amount: input.amount, gst: opening.taxTotal, journalId: posted.journal.id },
  });
  return getBill(tx, billId);
}

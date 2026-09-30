import { parseAccountCodeInput } from "@/lib/accounts/service";
import { assertRequiredFields, type CustomFieldContext, keptCustom, parseCustomInput, resolveDocumentCustom } from "@/lib/custom-fields/service";
import { type CustomValues, customValuesKey } from "@/lib/custom-fields/values";
import { assertRequiredTags, checkNewTags, hashableLine, keptValues, loadTrackingContext, parseTrackingInput, sortedTags, trackingKey, type TrackingTags } from "@/lib/tracking/service";
import type { AccountClass, AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { assertInventoryLines, planDocumentStock, planDocumentVoid, stockLinesAtBase } from "@/lib/inventory/stock";
import { fillLinesFromItems, isBlank, LINE_ITEM_COLUMNS, LINE_ITEM_JOINS, lineForHash, lineItemFields, type LineItemFields, type LineItemRef, type LineItemRow, parseLineItem, resolveLineItems, type ResolvedLineItem } from "@/lib/items/lines";
import { billLineAccountProblem } from "@/lib/bills/accounts";
import { PAYABLE_ACCOUNT } from "@/lib/bills/service";
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
import { controlAccountCode, GST_ACCOUNT, setBaseLineAmounts } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody, sameForeign } from "@/lib/ledger/journals";
import { assertForeignLinesSupported, contactCurrency, convertDocumentLines, exchangeRateFor, parseRateInput } from "@/lib/fx/documents";
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
 * Supplier credit notes, the bills side of sales credit notes. A draft can be
 * edited and deleted and posts nothing. Approving posts its journal,
 * Dr accounts payable / Cr each line's account and GST; after that it can't
 * change, only be voided, which posts the exact reversal. Lines follow the
 * bill account rules (`@/lib/bills/accounts`) and the invoice maths
 * (`@/lib/invoices/amounts`). Like a bill, a supplier credit note is known by
 * the supplier's own number; Tohyee doesn't number it. Approved credit is
 * applied to bills in `@/lib/supplier-credit-notes/applications` and refunds
 * received are in `@/lib/supplier-credit-notes/refunds` (examples SCN1-SCN12).
 */
export const SUPPLIER_CREDIT_NOTE_STATUSES = ["draft", "approved", "voided"] as const;
export type SupplierCreditNoteStatus = (typeof SUPPLIER_CREDIT_NOTE_STATUSES)[number];

export type SupplierCreditNoteLine = LineItemFields & {
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
  /** On a foreign-currency supplier credit note: the net amount and GST in the base currency (MC12); null otherwise. */
  baseNetAmount: string | null;
  baseTaxAmount: string | null;
};

export type SupplierCreditNoteSummary = {
  id: string;
  status: SupplierCreditNoteStatus;
  /** The supplier's own number for the credit note they sent, as it was typed. */
  supplierCreditNoteNumber: string;
  contactId: string;
  contactName: string;
  creditNoteDate: string;
  reference: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  /** Base currency per 1 unit of the credit note's currency; null for a base-currency one (MC12). */
  exchangeRate: string | null;
  baseSubtotal: string | null;
  baseTaxTotal: string | null;
  baseTotal: string | null;
  /** On an approved foreign-currency supplier credit note: the base value of the credit left, at its rate. */
  remainingCreditBase: string | null;
  /** The sum of the credit note's active applications to bills. */
  amountApplied: string;
  /** The sum of the credit note's active refunds received. */
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
  createdAt: string;
  updatedAt: string;
};

export type SupplierCreditNote = SupplierCreditNoteSummary & { lines: SupplierCreditNoteLine[] };

/** What a person enters. An edit leaves out anything it doesn't change; `lines` replaces every line. */
export type SupplierCreditNoteInput = {
  contactId?: unknown;
  creditNoteDate?: unknown;
  supplierCreditNoteNumber?: unknown;
  reference?: unknown;
  amountsMode?: unknown;
  lines?: unknown;
  customFields?: unknown;
  /** For a supplier in another currency: base currency per 1 unit (MC12). Left out, the last rate used is taken. */
  exchangeRate?: unknown;
};

const MAX_LINES = 200;
/** Quantities and unit prices allow up to 4 decimal places, as on bills. */
const LINE_INPUT_SCALE = 4;

type CreditNoteRow = {
  id: string;
  status: SupplierCreditNoteStatus;
  supplier_credit_note_number: string;
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
  created_at: string;
  updated_at: string;
};

const SUMMARY_COLUMNS = `n.id, n.status, n.supplier_credit_note_number, n.contact_id, c.name as contact_name, n.credit_note_date,
  n.reference, n.amounts_mode, n.currency_code, n.subtotal, n.tax_total, n.total, applied.amount_applied,
  refunded.amount_refunded, n.approval_journal_id, n.approved_at, n.approved_by_email, n.void_date, n.void_journal_id,
  n.voided_at, n.voided_by_email, n.created_by_email, n.created_at, n.updated_at, n.custom_fields,
  n.exchange_rate::text, n.base_subtotal::text, n.base_tax_total::text, n.base_total::text, applied.base_applied::text`;

/** Supplier credit notes with their supplier and the sums of their active applications and refunds. */
const SUMMARY_FROM = `supplier_credit_notes n
  join contacts c on c.id = n.contact_id
  cross join lateral (
    -- The base value used includes refunds' (MC18).
    select coalesce(sum(a.amount), 0) as amount_applied, tohyee_supplier_credit_note_base_used(n.id) as base_applied
      from supplier_credit_note_applications a
     where a.credit_note_id = n.id and a.status = 'active'
  ) applied
  cross join lateral (
    select coalesce(sum(r.amount), 0) as amount_refunded
      from supplier_credit_note_refunds r
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

function toSummary(row: CreditNoteRow): SupplierCreditNoteSummary {
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
    supplierCreditNoteNumber: row.supplier_credit_note_number,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLine(row: LineRow): SupplierCreditNoteLine {
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
  supplierCreditNoteNumber: string;
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
  /** As sent: undefined or null when not given (a foreign-currency one then takes the last rate used). */
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

function parseDraft(input: SupplierCreditNoteInput): DraftDetails {
  const contactId = requireId(input.contactId, "contactId");
  const creditNoteDate = parseIsoDate(input.creditNoteDate, "creditNoteDate");
  const supplierCreditNoteNumber = requireString(input.supplierCreditNoteNumber, "supplierCreditNoteNumber", {
    maxLength: 100,
  });
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
    };
  });
  return {
    contactId,
    creditNoteDate,
    supplierCreditNoteNumber,
    reference,
    amountsMode,
    lines,
    customInput: parseCustomInput(input.customFields, ""),
    exchangeRateInput: parseRateInput(input.exchangeRate),
  };
}

/** Normalised content for the idempotency fingerprint. */
function hashPayload(draft: DraftDetails): Record<string, unknown> {
  return {
    contactId: draft.contactId,
    creditNoteDate: draft.creditNoteDate,
    supplierCreditNoteNumber: draft.supplierCreditNoteNumber,
    reference: draft.reference,
    amountsMode: draft.amountsMode,
    lines: draft.lines.map((line) => hashableLine(lineForHash({ ...line, accountCode: line.accountCode.toLowerCase() }))),
    // Values that weren't sent stay out, so older requests hash the same.
    ...(draft.customInput !== undefined ? { customFields: draft.customInput } : {}),
    ...(draft.exchangeRateInput != null ? { exchangeRate: draft.exchangeRateInput } : {}),
  };
}

/**
 * Checks a draft against the organisation's data and works out its amounts,
 * with the same rules as a bill. Run when a draft is saved and again when
 * it's approved: the supplier must be an active contact marked as a
 * supplier, each line's account an active account that can take bill lines
 * (`billLineAccountProblem`), and each tax code active and in effect on the
 * credit note date.
 */
async function resolveDraft(
  tx: OrgTx,
  sent: DraftDetails,
  kept: ReadonlySet<string> = new Set(),
  keptFields: ReadonlySet<string> = new Set(),
  keptItems: ReadonlyArray<LineItemRef> = [],
): Promise<ResolvedDraft> {
  // A supplier in another currency gets credit notes in it (MC12).
  const currencyCode = await contactCurrency(tx, sent.contactId);
  if (currencyCode !== tx.baseCurrency) {
    assertForeignLinesSupported("supplier_credit_note", currencyCode, tx.baseCurrency, sent.lines);
  }
  // Blanks on item lines are filled from the item (IT2); what was sent is kept.
  const draft: DraftDetails = { ...sent, lines: await fillLinesFromItems(tx, sent.lines, { side: "purchase", contactId: sent.contactId, noTax: sent.amountsMode === "no_tax" }) };
  const custom = await resolveDocumentCustom(tx, "supplier_credit_note", draft.customInput, draft.lines.map((line) => line.customFields), keptFields);
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
  // A foreign-currency supplier credit note (MC12): as a foreign-currency bill.
  let exchangeRate: string | null = null;
  let base: ReturnType<typeof convertDocumentLines> | null = null;
  if (currencyCode !== tx.baseCurrency) {
    exchangeRate = await exchangeRateFor(tx, { currencyCode, date: draft.creditNoteDate, typed: draft.exchangeRateInput, what: "supplier credit note" });
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
      baseNetAmount: base?.lines[index].baseNetAmount ?? null,
      baseTaxAmount: base?.lines[index].baseTaxAmount ?? null,
    })),
  };
}

/** The expression the unique index on non-voided supplier credit notes uses: no whitespace, lower case. */
const COMPARABLE_NUMBER = (column: string) => `lower(regexp_replace(${column}, '[[:space:]]', '', 'g'))`;
const NUMBER_INDEX = "supplier_credit_notes_number_key";

function numberTaken(
  supplier: string,
  number: string,
  existing?: { id: string; status: SupplierCreditNoteStatus },
): ConflictError {
  return new ConflictError(
    `${supplier} already has a supplier credit note numbered ${number}${
      existing ? ` (${existing.status} supplier credit note #${existing.id})` : ""
    }. Numbers are compared ignoring case and spaces, so check this credit note hasn't been entered already.`,
  );
}

/**
 * Example SCN11: a supplier can't have two supplier credit notes that aren't
 * voided with the same number, ignoring case and spaces. Bill numbers are
 * separate. The database's unique index refuses it too; this finds the other
 * credit note to say which one it is.
 */
async function assertNumberFree(tx: OrgTx, draft: ResolvedDraft, exceptCreditNoteId: string | null): Promise<void> {
  const clash = await tx.query<{ id: string; status: SupplierCreditNoteStatus; supplier_credit_note_number: string }>(
    `select id, status, supplier_credit_note_number from supplier_credit_notes
      where contact_id = $1 and status <> 'voided'
        and ${COMPARABLE_NUMBER("supplier_credit_note_number")} = ${COMPARABLE_NUMBER("$2::text")}
        and ($3::bigint is null or id <> $3)
      order by id
      limit 1`,
    [draft.contactId, draft.supplierCreditNoteNumber, exceptCreditNoteId],
  );
  const existing = clash.rows[0];
  if (existing) {
    throw numberTaken(draft.contactName, existing.supplier_credit_note_number, existing);
  }
}

/**
 * Waits for a statement that saves a supplier credit note's supplier and
 * number. If another request saved the same number after `assertNumberFree`
 * looked, the unique index refuses this one, and the person is told why.
 */
async function savingNumber<T>(draft: ResolvedDraft, statement: Promise<T>): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    if (isUniqueViolation(error, NUMBER_INDEX)) {
      throw numberTaken(draft.contactName, draft.supplierCreditNoteNumber);
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
};

type StoredHeader = {
  contactId: string;
  creditNoteDate: string;
  supplierCreditNoteNumber: string;
  reference: string | null;
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
function headerState(creditNote: StoredHeader): string {
  return JSON.stringify([
    creditNote.contactId,
    creditNote.creditNoteDate,
    creditNote.supplierCreditNoteNumber,
    creditNote.reference,
    creditNote.amountsMode,
    creditNote.currencyCode,
    plain(creditNote.subtotal),
    plain(creditNote.taxTotal),
    plain(creditNote.total),
    customValuesKey(creditNote.customFields),
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

function sameAsStored(resolved: ResolvedDraft, current: SupplierCreditNote): { header: boolean; lines: boolean } {
  return {
    header: headerState(resolved) === headerState(current),
    lines: linesState(resolved.resolvedLines) === linesState(current.lines),
  };
}

/** The saved draft, in the shape a person would send it. */
function draftOf(creditNote: SupplierCreditNote): DraftDetails {
  return {
    contactId: creditNote.contactId,
    creditNoteDate: creditNote.creditNoteDate,
    supplierCreditNoteNumber: creditNote.supplierCreditNoteNumber,
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
    `insert into supplier_credit_note_lines (credit_note_id, line_order, description, quantity, unit_price, account_id,
                                             tax_code_id, tax_rate, line_amount, net_amount, tax_amount, tracking, custom_fields, item_id, unit_id, base_quantity)
     values ${tuples.join(", ")}`,
    values,
  );
  await setBaseLineAmounts(tx, "supplier_credit_note_lines", "credit_note_id", creditNoteId, lines);
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
    `select id, ${columns.hash} as hash from supplier_credit_notes where ${columns.source} = $1 and ${columns.key} = $2`,
    [source, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const { code, constraint: violated } = error as { code?: string; constraint?: string };
  return code === "23505" && (constraint === undefined || violated === constraint);
}

export function supplierCreditNoteLabel(creditNote: SupplierCreditNoteSummary): string {
  return `Supplier credit note ${creditNote.supplierCreditNoteNumber} from ${creditNote.contactName}`;
}

export async function getSupplierCreditNote(tx: OrgTx, creditNoteIdInput: unknown): Promise<SupplierCreditNote> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const result = await tx.query<CreditNoteRow>(`select ${SUMMARY_COLUMNS} from ${SUMMARY_FROM} where n.id = $1`, [
    creditNoteId,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Supplier credit note not found.");
  }
  const lines = await tx.query<LineRow>(
    `select l.line_order, l.description, l.quantity, l.unit_price, l.account_id, a.code as account_code,
            a.name as account_name, l.tax_code_id, t.code as tax_code, l.tax_rate, l.line_amount,
            l.net_amount, l.tax_amount, l.tracking, l.custom_fields, ${LINE_ITEM_COLUMNS},
            l.base_net_amount::text, l.base_tax_amount::text
       from supplier_credit_note_lines l
       join accounts a on a.id = l.account_id
       left join tax_codes t on t.id = l.tax_code_id
       ${LINE_ITEM_JOINS}
      where l.credit_note_id = $1
      order by l.line_order`,
    [creditNoteId],
  );
  return { ...toSummary(row), lines: lines.rows.map(toLine) };
}

/** Loads a supplier credit note and locks it until the transaction ends. */
export async function lockSupplierCreditNote(tx: OrgTx, creditNoteId: string): Promise<SupplierCreditNote> {
  const locked = await tx.query("select id from supplier_credit_notes where id = $1 for update", [creditNoteId]);
  if (locked.rowCount === 0) {
    throw new NotFoundError("Supplier credit note not found.");
  }
  return getSupplierCreditNote(tx, creditNoteId);
}

function assertDraft(creditNote: SupplierCreditNote, action: "edited" | "deleted"): void {
  if (creditNote.status !== "draft") {
    throw new ConflictError(
      `${supplierCreditNoteLabel(creditNote)} is ${creditNote.status}, so it can't be ${action}.${
        creditNote.status === "approved" ? " Void it instead." : ""
      }`,
    );
  }
}

/**
 * Newest first, 50 at a time; `status` filters, `contactId` keeps one
 * supplier's credit notes, `hasRemainingCredit` keeps only approved credit
 * notes with credit left to apply or refund, and `beforeId` pages.
 */
export async function listSupplierCreditNotes(
  tx: OrgTx,
  filters: {
    status?: unknown;
    contactId?: unknown;
    hasRemainingCredit?: unknown;
    beforeId?: unknown;
    limit?: unknown;
  } = {},
): Promise<{ creditNotes: SupplierCreditNoteSummary[]; nextBeforeId: string | null }> {
  const status =
    filters.status == null || filters.status === ""
      ? null
      : requireOneOf(filters.status, "status", SUPPLIER_CREDIT_NOTE_STATUSES);
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

/** Saves a new draft (examples SCN1, SCN11). Drafts post nothing. */
export async function createSupplierCreditNote(
  tx: OrgTx,
  input: SupplierCreditNoteInput & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; creditNote: SupplierCreditNote }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const draft = parseDraft(input);
  const hash = requestHash("supplier_credit_note", hashPayload(draft));

  const existing = await findByKey(tx, "create", source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.hash, hash, "supplier credit note");
    return { created: false, creditNote: await getSupplierCreditNote(tx, existing.id) };
  }

  const resolved = await resolveDraft(tx, draft);
  await assertNumberFree(tx, resolved, null);
  const inserted = await savingNumber(
    resolved,
    tx.query<{ id: string }>(
      `insert into supplier_credit_notes (command_source, idempotency_key, request_hash, contact_id, credit_note_date,
                                          supplier_credit_note_number, reference, amounts_mode, currency_code,
                                          subtotal, tax_total, total, created_by_user_id, created_by_email,
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
        resolved.creditNoteDate,
        resolved.supplierCreditNoteNumber,
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
    ),
  );
  const creditNoteId = inserted.rows[0]?.id;
  if (!creditNoteId) {
    // Another request with the same key committed first.
    const winner = await findByKey(tx, "create", source, idempotencyKey);
    if (!winner) {
      throw new ConflictError("That supplier credit note is being saved by another request. Try again.");
    }
    assertSameRequest(winner.hash, hash, "supplier credit note");
    return { created: false, creditNote: await getSupplierCreditNote(tx, winner.id) };
  }
  await insertLines(tx, creditNoteId, resolved.resolvedLines);
  await tx.query("update supplier_credit_notes set custom_fields = $2::jsonb where id = $1", [creditNoteId, JSON.stringify(resolved.customFields)]);
  await writeAuditEvent(tx, {
    eventType: "supplier_credit_note.created",
    entityType: "supplier_credit_note",
    entityId: creditNoteId,
    details: {
      contactId: resolved.contactId,
      supplierCreditNoteNumber: resolved.supplierCreditNoteNumber,
      creditNoteDate: resolved.creditNoteDate,
      amountsMode: resolved.amountsMode,
      total: resolved.total,
      lines: resolved.resolvedLines.length,
    },
  });
  return { created: true, creditNote: await getSupplierCreditNote(tx, creditNoteId) };
}

/**
 * Edits a draft. Fields that aren't sent keep their values; `lines` replaces
 * all the lines. Everything is checked and the amounts worked out again. An
 * edit that changes nothing isn't saved or audited.
 */
export async function updateSupplierCreditNote(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  input: SupplierCreditNoteInput,
): Promise<SupplierCreditNote> {
  const current = await lockSupplierCreditNote(tx, requireId(creditNoteIdInput, "creditNoteId"));
  assertDraft(current, "edited");
  const saved = draftOf(current);
  const draft = parseDraft({
    contactId: input.contactId === undefined ? saved.contactId : input.contactId,
    creditNoteDate: input.creditNoteDate === undefined ? saved.creditNoteDate : input.creditNoteDate,
    supplierCreditNoteNumber:
      input.supplierCreditNoteNumber === undefined ? saved.supplierCreditNoteNumber : input.supplierCreditNoteNumber,
    reference: input.reference === undefined ? saved.reference : input.reference,
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
  const resolved = await resolveDraft(tx, draft, keptValues(current.lines), keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)), current.lines);
  const same = sameAsStored(resolved, current);
  if (same.header && same.lines) {
    return current;
  }
  await assertNumberFree(tx, resolved, current.id);

  const changed: string[] = (
    ["contactId", "creditNoteDate", "supplierCreditNoteNumber", "reference", "amountsMode", "exchangeRate"] as const
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
      `update supplier_credit_notes
          set contact_id = $2, credit_note_date = $3, supplier_credit_note_number = $4, reference = $5,
              amounts_mode = $6, currency_code = $7, subtotal = $8::numeric, tax_total = $9::numeric,
              total = $10::numeric, exchange_rate = $11::numeric, base_subtotal = $12::numeric,
              base_tax_total = $13::numeric, base_total = $14::numeric, updated_at = now()
        where id = $1`,
      [
        current.id,
        resolved.contactId,
        resolved.creditNoteDate,
        resolved.supplierCreditNoteNumber,
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
    ),
  );
  await tx.query("delete from supplier_credit_note_lines where credit_note_id = $1", [current.id]);
  await insertLines(tx, current.id, resolved.resolvedLines);
  await tx.query("update supplier_credit_notes set custom_fields = $2::jsonb where id = $1", [current.id, JSON.stringify(resolved.customFields)]);
  await writeAuditEvent(tx, {
    eventType: "supplier_credit_note.updated",
    entityType: "supplier_credit_note",
    entityId: current.id,
    details: { changed, total: { from: current.total, to: resolved.total } },
  });
  return getSupplierCreditNote(tx, current.id);
}

/** Deletes a draft (approved supplier credit notes are voided instead). */
export async function deleteSupplierCreditNote(tx: OrgTx, creditNoteIdInput: unknown): Promise<void> {
  const current = await lockSupplierCreditNote(tx, requireId(creditNoteIdInput, "creditNoteId"));
  assertDraft(current, "deleted");
  // Its notes and files go with it (NF12).
  await removeRecordExtras(tx, "supplier_credit_note", current.id);
  await tx.query("delete from supplier_credit_note_lines where credit_note_id = $1", [current.id]);
  await tx.query("delete from supplier_credit_notes where id = $1", [current.id]);
  await writeAuditEvent(tx, {
    eventType: "supplier_credit_note.deleted",
    entityType: "supplier_credit_note",
    entityId: current.id,
    details: {
      contactId: current.contactId,
      contactName: current.contactName,
      supplierCreditNoteNumber: current.supplierCreditNoteNumber,
      creditNoteDate: current.creditNoteDate,
      total: current.total,
    },
  });
}

async function creditNoteControlAccounts(tx: OrgTx): Promise<{ payable: string; gst: string }> {
  const refused = "supplier credit notes can't be approved";
  return {
    payable: await controlAccountCode(tx, PAYABLE_ACCOUNT, refused),
    gst: await controlAccountCode(tx, GST_ACCOUNT, refused),
  };
}

/**
 * Approves a draft (examples SCN2, SCN10, SCN12): posts one journal on the
 * credit note date, Dr accounts payable for the total, Cr each line's account
 * for its net amount and Cr GST for the GST. Refused in a locked period,
 * leaving the draft as it was.
 */
export async function approveSupplierCreditNote(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; creditNote: SupplierCreditNote }> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("supplier_credit_note_approval", { creditNoteId });
  const replay = async () => {
    const earlier = await findByKey(tx, "approve", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "supplier credit note approval");
    return { created: false, creditNote: await getSupplierCreditNote(tx, earlier.id) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const current = await lockSupplierCreditNote(tx, creditNoteId);
  // The original of a retry may have committed while this request waited for the lock.
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (current.status !== "draft") {
    throw new ConflictError(`${supplierCreditNoteLabel(current)} is already ${current.status}.`);
  }
  const resolved = await resolveDraft(tx, draftOf(current), keptValues(current.lines), keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)), current.lines);
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
    "supplier_credit_note",
    resolved.customFields,
    resolved.resolvedLines.map((line) => ({ values: line.customFields, accountClass: line.accountClass })),
  );
  const accounts = await creditNoteControlAccounts(tx);
  await assertPostingDateAllowed(tx, current.creditNoteDate);

  const scale = currencyMinorUnits(tx.baseCurrency);
  // A foreign-currency supplier credit note posts its base amounts, with its foreign amount on accounts payable (MC12).
  const foreignCurrency = resolved.exchangeRate !== null;
  // One line per account and set of tracking tags (TC4, TC10).
  const credited = new Map<string, { code: string; amount: Decimal; tracking: TrackingTags }>();
  for (const line of resolved.resolvedLines) {
    const key = `${line.accountId}|${trackingKey(line.tracking)}`;
    const entry = credited.get(key) ?? { code: line.accountCode, amount: ZERO_DECIMAL, tracking: line.tracking };
    entry.amount = add(entry.amount, dec(foreignCurrency ? line.baseNetAmount! : line.netAmount));
    credited.set(key, entry);
  }
  const supplier = resolved.contactName;
  const number = current.supplierCreditNoteNumber;
  const taxTotal = foreignCurrency ? resolved.baseTaxTotal! : resolved.taxTotal;
  const journalLines = [
    {
      accountCode: accounts.payable,
      debitAmount: foreignCurrency ? resolved.baseTotal! : resolved.total,
      creditAmount: "0",
      description: supplier,
      ...(foreignCurrency
        ? { foreign: { currencyCode: resolved.currencyCode, amount: resolved.total, rate: resolved.exchangeRate!, kind: "document" as const } }
        : {}),
    },
    ...[...credited.values()]
      .filter((entry) => !isZero(entry.amount))
      .map((entry) => ({
        accountCode: entry.code,
        debitAmount: "0",
        creditAmount: toFixedString(entry.amount, scale),
        description: supplier,
        tracking: entry.tracking,
      })),
    ...(isZero(dec(taxTotal)) ? [] : [{ accountCode: accounts.gst, debitAmount: "0", creditAmount: taxTotal, description: "GST" }]),
  ];
  // Stock items move stock and post cost of sales in the same journal (ST1-ST11).
  const stock = await planDocumentStock(
    tx,
    "supplier_credit_note",
    { id: creditNoteId, date: current.creditNoteDate, reference: current.supplierCreditNoteNumber, contactId: current.contactId },
    // Stock is valued in the base currency (MC29): a foreign-currency line's stock is its base net amount.
    stockLinesAtBase(resolved.resolvedLines),
    `Stock returned, supplier credit note ${current.supplierCreditNoteNumber}`,
  );
  if (stock) journalLines.push(...stock.journalLines);
  const posted = await postJournalBody(
    tx,
    "supplier_credit_note:approval",
    creditNoteId,
    parseJournalBody(
      tx,
      {
        postingDate: current.creditNoteDate,
        reference: number,
        description: `Supplier credit note ${number} from ${supplier}`,
        lines: journalLines,
      },
      { internal: true },
    ),
    { origin: "supplier_credit_note" },
  );
  await stock?.planner.record(posted.journal.id);

  try {
    await tx.query(
      `update supplier_credit_notes
          set status = 'approved', approval_journal_id = $2,
              approve_command_source = $3, approve_idempotency_key = $4, approve_request_hash = $5,
              approved_by_user_id = $6, approved_by_email = $7, approved_at = now(), updated_at = now()
        where id = $1`,
      [creditNoteId, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The same key was used to approve another supplier credit note by a request that committed first.
      throw new ConflictError(
        "That idempotency key was already used for a different supplier credit note approval. Use a new key for a new supplier credit note approval.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "supplier_credit_note.approved",
    entityType: "supplier_credit_note",
    entityId: creditNoteId,
    details: {
      supplierCreditNoteNumber: number,
      journalId: posted.journal.id,
      creditNoteDate: current.creditNoteDate,
      total: resolved.total,
    },
  });
  return { created: true, creditNote: await getSupplierCreditNote(tx, creditNoteId) };
}

/**
 * Voids an approved supplier credit note (examples SCN9, SCN11, SCN12): posts
 * the exact reversal of its journal on the void date, which must be in an
 * open period and not before the credit note. A credit note can only be
 * voided once, a draft is deleted rather than voided, and one with active
 * applications or refunds is refused until they're removed or voided. Once
 * voided, its number can be used again.
 */
export async function voidSupplierCreditNote(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<{ created: boolean; creditNote: SupplierCreditNote }> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const hash = requestHash("supplier_credit_note_void", { creditNoteId, voidDate });
  const replay = async () => {
    const earlier = await findByKey(tx, "void", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "supplier credit note void");
    return { created: false, creditNote: await getSupplierCreditNote(tx, earlier.id) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const current = await lockSupplierCreditNote(tx, creditNoteId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (current.status === "draft") {
    throw new ConflictError("This supplier credit note is still a draft, so there's nothing to void. Delete it instead.");
  }
  if (current.status === "voided") {
    throw new ConflictError(`${supplierCreditNoteLabel(current)} has already been voided.`);
  }
  if (!isZero(dec(current.amountApplied)) || !isZero(dec(current.amountRefunded))) {
    // Example SCN9. The database refuses it too.
    throw new ConflictError(
      `${supplierCreditNoteLabel(current)} has credit applied or refunded, so it can't be voided. Remove its applications and refunds first.`,
    );
  }
  if (voidDate < current.creditNoteDate) {
    throw new ValidationError(`The void date can't be before the credit note date (${current.creditNoteDate}).`);
  }

  const original = await getJournal(tx, current.approvalJournalId!);
  const voidStock = await planDocumentVoid(
    tx,
    "supplier_credit_note",
    { id: creditNoteId, date: voidDate, reference: `VOID-${original.reference}`.slice(0, 100) },
    (lineIndex) => current.lines[lineIndex]?.tracking ?? {},
    `Stock back on void of ${original.reference}`,
  );
  const posted = await postJournalBody(
    tx,
    "supplier_credit_note:void",
    creditNoteId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of supplier credit note ${current.supplierCreditNoteNumber} from ${current.contactName}`,
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
    { origin: "supplier_credit_note", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  await voidStock?.planner.record(posted.journal.id);

  try {
    await tx.query(
      `update supplier_credit_notes
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4,
              void_idempotency_key = $5, void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8,
              voided_at = now(), updated_at = now()
        where id = $1`,
      [creditNoteId, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "That idempotency key was already used for a different supplier credit note void. Use a new key for a new supplier credit note void.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "supplier_credit_note.voided",
    entityType: "supplier_credit_note",
    entityId: creditNoteId,
    details: { supplierCreditNoteNumber: current.supplierCreditNoteNumber, voidDate, journalId: posted.journal.id },
  });
  return { created: true, creditNote: await getSupplierCreditNote(tx, creditNoteId) };
}

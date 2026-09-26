import { parseAccountCodeInput } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
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
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { currencyMinorUnits } from "@/lib/money/currency";
import {
  add,
  dec,
  isZero,
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

/**
 * Sales invoices. A draft can be edited and deleted and posts nothing.
 * Approving gives it the next number (INV-0001, ...) and posts its journal;
 * after that it can't change, only be voided, which posts the exact reversal.
 * The amounts are worked out in `@/lib/invoices/amounts` (examples I1-I9).
 * Payments against approved invoices are in `@/lib/invoices/payments`.
 */
export const INVOICE_STATUSES = ["draft", "approved", "voided"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export type InvoiceLine = {
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
  /** The sum of the invoice's active payments (examples CP1-CP4). */
  amountPaid: string;
  /** What's still to be paid on an approved invoice; null for drafts and voided invoices. */
  amountDue: string | null;
  /** Worked out from the invoice's active payments; null for drafts and voided invoices. */
  paidStatus: PaidStatus | null;
  approvalJournalId: string | null;
  approvedAt: string | null;
  approvedByEmail: string | null;
  voidDate: string | null;
  voidJournalId: string | null;
  voidedAt: string | null;
  voidedByEmail: string | null;
  createdByEmail: string | null;
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
};

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
  approval_journal_id: string | null;
  approved_at: string | null;
  approved_by_email: string | null;
  void_date: string | null;
  void_journal_id: string | null;
  voided_at: string | null;
  voided_by_email: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

const SUMMARY_COLUMNS = `i.id, i.status, i.invoice_number, i.contact_id, c.name as contact_name, i.invoice_date,
  i.due_date, i.reference, i.amounts_mode, i.currency_code, i.subtotal, i.tax_total, i.total,
  paid.amount_paid, i.approval_journal_id, i.approved_at, i.approved_by_email, i.void_date, i.void_journal_id,
  i.voided_at, i.voided_by_email, i.created_by_email, i.created_at, i.updated_at`;

/** Invoices with their customer and the sum of their active payments. */
const SUMMARY_FROM = `sales_invoices i
  join contacts c on c.id = i.contact_id
  cross join lateral (
    select coalesce(sum(p.amount), 0) as amount_paid
      from customer_payments p
     where p.invoice_id = i.id and p.status = 'active'
  ) paid`;

type LineRow = {
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
};

function toSummary(row: InvoiceRow): InvoiceSummary {
  const payment = invoicePaymentStatus(row.total, row.amount_paid, currencyMinorUnits(row.currency_code));
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
    amountPaid: payment.amountPaid,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLine(row: LineRow): InvoiceLine {
  return {
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
  };
}

/** A draft as entered, validated but not yet checked against the organisation's data. */
type DraftDetails = {
  contactId: string;
  invoiceDate: string;
  dueDate: string;
  reference: string | null;
  amountsMode: AmountsMode;
  lines: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    accountCode: string;
    taxCode: string | null;
  }>;
};

/** A draft checked against the chart of accounts, tax codes and contacts, with its amounts. */
type ResolvedDraft = DraftDetails & {
  contactName: string;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  resolvedLines: Array<{
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
  }>;
};

function parseDraft(input: InvoiceInput): DraftDetails {
  const contactId = requireId(input.contactId, "contactId");
  const invoiceDate = parseIsoDate(input.invoiceDate, "invoiceDate");
  const dueDate = parseIsoDate(input.dueDate, "dueDate");
  if (dueDate < invoiceDate) {
    throw new ValidationError("The due date can't be before the invoice date.");
  }
  const reference = optionalString(input.reference, "reference", { maxLength: 100 });
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  const rawLines = requireArray(input.lines, "lines", MAX_LINES);
  if (rawLines.length === 0) {
    throw new ValidationError("An invoice needs at least one line.");
  }
  const lines = rawLines.map((raw, index) => {
    const label = `Line ${index + 1}`;
    const line = asRecord(raw, label);
    const taxCode = optionalString(line.taxCode, `${label} tax code`, { maxLength: 20 })?.toUpperCase() ?? null;
    if (amountsMode === "no_tax" && taxCode !== null) {
      throw new ValidationError(
        `${label} has a tax code, but the invoice's amounts have no tax. Remove the tax code or change the amounts to tax exclusive or inclusive.`,
      );
    }
    if (amountsMode !== "no_tax" && taxCode === null) {
      throw new ValidationError(`${label} needs a tax code (use a zero-rated code for sales without GST).`);
    }
    return {
      description: requireString(line.description, `${label} description`, { maxLength: 500 }),
      quantity: parseDecimalInput(line.quantity, `${label} quantity`, { maxScale: LINE_INPUT_SCALE }),
      unitPrice: parseDecimalInput(line.unitPrice, `${label} unit price`, { maxScale: LINE_INPUT_SCALE }),
      accountCode: parseAccountCodeInput(line.accountCode, `${label} account`),
      taxCode,
    };
  });
  return { contactId, invoiceDate, dueDate, reference, amountsMode, lines };
}

/** Normalised content for the idempotency fingerprint. */
function hashPayload(draft: DraftDetails): Record<string, unknown> {
  return {
    contactId: draft.contactId,
    invoiceDate: draft.invoiceDate,
    dueDate: draft.dueDate,
    reference: draft.reference,
    amountsMode: draft.amountsMode,
    lines: draft.lines.map((line) => ({ ...line, accountCode: line.accountCode.toLowerCase() })),
  };
}

/**
 * Checks a draft against the organisation's data and works out its amounts.
 * Run when a draft is saved and again when it's approved: the customer must be
 * an active contact marked as a customer, each line's account an active
 * revenue account, and each tax code active and in effect on the invoice date.
 */
async function resolveDraft(tx: OrgTx, draft: DraftDetails): Promise<ResolvedDraft> {
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
    is_active: boolean;
    effective_from: string;
    effective_to: string | null;
  }>("select id, code, rate, is_active, effective_from, effective_to from tax_codes where code = any($1::text[])", [
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
    if (line.taxCode !== null) {
      const taxCode = taxCodesByCode.get(line.taxCode);
      if (!taxCode) {
        throw new ValidationError(`${label}: there's no tax code ${line.taxCode}.`);
      }
      if (!taxCode.is_active) {
        throw new ValidationError(`${label}: tax code ${taxCode.code} is inactive.`);
      }
      if (taxCode.effective_from > draft.invoiceDate || (taxCode.effective_to !== null && taxCode.effective_to < draft.invoiceDate)) {
        throw new ValidationError(
          `${label}: tax code ${taxCode.code} isn't in effect on ${draft.invoiceDate} (it applies from ${taxCode.effective_from}${
            taxCode.effective_to ? ` to ${taxCode.effective_to}` : ""
          }).`,
        );
      }
      taxCodeId = taxCode.id;
      taxRate = toPlainString(dec(taxCode.rate));
    }
    return { ...line, accountId: account.id, accountCode: account.code, taxCodeId, taxRate };
  });

  const scale = currencyMinorUnits(tx.baseCurrency);
  const amounts = calculateInvoice(draft.amountsMode, lines, scale);
  amounts.lines.forEach((line, index) => {
    if (isZero(dec(line.lineAmount))) {
      throw new ValidationError(
        `Line ${index + 1} comes to ${line.lineAmount} once rounded to ${tx.baseCurrency}. Check its quantity and unit price.`,
      );
    }
  });

  return {
    ...draft,
    contactName: customer.name,
    currencyCode: tx.baseCurrency,
    subtotal: amounts.subtotal,
    taxTotal: amounts.taxTotal,
    total: amounts.total,
    resolvedLines: lines.map((line, index) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      accountCode: line.accountCode,
      taxCodeId: line.taxCodeId,
      taxRate: line.taxRate,
      ...amounts.lines[index],
    })),
  };
}

type StoredLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxCodeId: string | null;
  taxRate: string;
  lineAmount: string;
  netAmount: string;
  taxAmount: string;
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
    ]),
  );
}

function sameAsStored(resolved: ResolvedDraft, current: Invoice): { header: boolean; lines: boolean } {
  return {
    header: headerState(resolved) === headerState(current),
    lines: linesState(resolved.resolvedLines) === linesState(current.lines),
  };
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
    })),
  };
}

async function insertLines(tx: OrgTx, invoiceId: string, lines: ResolvedDraft["resolvedLines"]): Promise<void> {
  const values: unknown[] = [];
  const tuples = lines.map((line, index) => {
    values.push(
      invoiceId,
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
    );
    const base = index * 11;
    const p = (offset: number) => `$${base + offset}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}::numeric, ${p(5)}::numeric, ${p(6)}, ${p(7)}, ${p(8)}::numeric, ${p(9)}::numeric, ${p(10)}::numeric, ${p(11)}::numeric)`;
  });
  await tx.query(
    `insert into sales_invoice_lines (invoice_id, line_order, description, quantity, unit_price, account_id,
                                      tax_code_id, tax_rate, line_amount, net_amount, tax_amount)
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
  const lines = await tx.query<LineRow>(
    `select l.line_order, l.description, l.quantity, l.unit_price, l.account_id, a.code as account_code,
            a.name as account_name, l.tax_code_id, t.code as tax_code, l.tax_rate, l.line_amount,
            l.net_amount, l.tax_amount
       from sales_invoice_lines l
       join accounts a on a.id = l.account_id
       left join tax_codes t on t.id = l.tax_code_id
      where l.invoice_id = $1
      order by l.line_order`,
    [invoiceId],
  );
  return { ...toSummary(row), lines: lines.rows.map(toLine) };
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
 * approved invoices with something still due, and `beforeId` pages.
 */
export async function listInvoices(
  tx: OrgTx,
  filters: { status?: unknown; awaitingPayment?: unknown; beforeId?: unknown; limit?: unknown } = {},
): Promise<{ invoices: InvoiceSummary[]; nextBeforeId: string | null }> {
  const status =
    filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", INVOICE_STATUSES);
  const awaitingPayment = optionalBoolean(filters.awaitingPayment, "awaitingPayment") ?? false;
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const limitRaw = Number(filters.limit ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
  const result = await tx.query<InvoiceRow>(
    `select ${SUMMARY_COLUMNS} from ${SUMMARY_FROM}
      where ($1::text is null or i.status = $1) and ($2::bigint is null or i.id < $2)
        and (not $3::boolean or (i.status = 'approved' and paid.amount_paid < i.total))
      order by i.id desc
      limit ${limit + 1}`,
    [status, beforeId, awaitingPayment],
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
): Promise<{ created: boolean; invoice: Invoice }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const draft = parseDraft(input);
  const hash = requestHash("sales_invoice", hashPayload(draft));

  const existing = await findByKey(tx, "create", source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.hash, hash, "invoice");
    return { created: false, invoice: await getInvoice(tx, existing.id) };
  }

  const resolved = await resolveDraft(tx, draft);
  const inserted = await tx.query<{ id: string }>(
    `insert into sales_invoices (command_source, idempotency_key, request_hash, contact_id, invoice_date, due_date,
                                 reference, amounts_mode, currency_code, subtotal, tax_total, total,
                                 created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $12::numeric, $13, $14)
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
  });
  const resolved = await resolveDraft(tx, draft);
  const same = sameAsStored(resolved, current);
  if (same.header && same.lines) {
    return current;
  }

  const changed: string[] = (["contactId", "invoiceDate", "dueDate", "reference", "amountsMode"] as const).filter(
    (field) => resolved[field] !== current[field],
  );
  if (!same.lines) {
    changed.push("lines");
  }
  await tx.query(
    `update sales_invoices
        set contact_id = $2, invoice_date = $3, due_date = $4, reference = $5, amounts_mode = $6,
            currency_code = $7, subtotal = $8::numeric, tax_total = $9::numeric, total = $10::numeric,
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
    ],
  );
  await tx.query("delete from sales_invoice_lines where invoice_id = $1", [current.id]);
  await insertLines(tx, current.id, resolved.resolvedLines);
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

type ControlAccount = { systemKey: string; label: string; accountClass: string };

const RECEIVABLE_ACCOUNT: ControlAccount = { systemKey: "accounts_receivable", label: "accounts receivable", accountClass: "asset" };
const GST_ACCOUNT: ControlAccount = { systemKey: "gst", label: "GST", accountClass: "liability" };

/**
 * A control account, found by its system key (see the default chart: 1100
 * for accounts receivable and 2100 for GST). `refused` says what can't be done
 * without it.
 */
async function controlAccountCode(tx: OrgTx, control: ControlAccount, refused: string): Promise<string> {
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
 */
async function takeInvoiceNumber(tx: OrgTx): Promise<{ sequence: number; invoiceNumber: string }> {
  const result = await tx.query<{ last_number: number }>(
    "update sales_invoice_numbering set last_number = last_number + 1 where id = true returning last_number",
  );
  const sequence = Number(result.rows[0].last_number);
  return { sequence, invoiceNumber: formatInvoiceNumber(sequence) };
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
): Promise<{ created: boolean; invoice: Invoice }> {
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
  if (current.currencyCode !== tx.baseCurrency) {
    throw new ValidationError(
      `This draft was saved in ${current.currencyCode}, but the base currency is now ${tx.baseCurrency}. Open it and save it again first.`,
    );
  }

  const resolved = await resolveDraft(tx, draftOf(current));
  const same = sameAsStored(resolved, current);
  if (!same.header || !same.lines) {
    throw new ConflictError(
      "This draft's amounts no longer match its tax codes. Open it and save it again, then check the totals before approving.",
    );
  }
  const accounts = await invoiceControlAccounts(tx);
  await assertPostingDateAllowed(tx, current.invoiceDate);

  const { sequence, invoiceNumber } = await takeInvoiceNumber(tx);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const revenue = new Map<string, { code: string; amount: Decimal }>();
  for (const line of resolved.resolvedLines) {
    const entry = revenue.get(line.accountId) ?? { code: line.accountCode, amount: ZERO_DECIMAL };
    entry.amount = add(entry.amount, dec(line.netAmount));
    revenue.set(line.accountId, entry);
  }
  const customer = resolved.contactName;
  const journalLines = [
    { accountCode: accounts.receivable, debitAmount: resolved.total, creditAmount: "0", description: customer },
    ...[...revenue.values()]
      .filter((entry) => !isZero(entry.amount))
      .map((entry) => ({
        accountCode: entry.code,
        debitAmount: "0",
        creditAmount: toFixedString(entry.amount, scale),
        description: customer,
      })),
    ...(isZero(dec(resolved.taxTotal))
      ? []
      : [{ accountCode: accounts.gst, debitAmount: "0", creditAmount: resolved.taxTotal, description: "GST" }]),
  ];
  const posted = await postJournalBody(
    tx,
    "invoice:approval",
    invoiceId,
    parseJournalBody(tx, {
      postingDate: current.invoiceDate,
      reference: invoiceNumber,
      description: `Invoice ${invoiceNumber} to ${customer}`,
      lines: journalLines,
    }),
    { origin: "invoice" },
  );

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
    details: { invoiceNumber, journalId: posted.journal.id, invoiceDate: current.invoiceDate, total: resolved.total },
  });
  return { created: true, invoice: await getInvoice(tx, invoiceId) };
}

/**
 * Voids an approved invoice (example I7): posts the exact reversal of its
 * journal on the void date, which must be in an open period. An invoice can
 * only be voided once, a draft is deleted rather than voided, and an invoice
 * with active payments is refused until they're voided (example CP5).
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
  if (!isZero(dec(current.amountPaid))) {
    // Example CP5. The database refuses it too.
    throw new ConflictError(
      `${invoiceLabel(current)} has payments against it, so it can't be voided. Void its payments first.`,
    );
  }
  if (voidDate < current.invoiceDate) {
    throw new ValidationError(`The void date can't be before the invoice date (${current.invoiceDate}).`);
  }

  const original = await getJournal(tx, current.approvalJournalId!);
  const posted = await postJournalBody(
    tx,
    "invoice:void",
    invoiceId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${current.invoiceNumber}`,
      description: `Void of invoice ${current.invoiceNumber}`,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
      })),
    }),
    { origin: "invoice", relatedJournalId: original.id, correctionKind: "reversal" },
  );

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

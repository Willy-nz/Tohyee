import { writeAuditEvent } from "@/lib/audit";
import { keptCustom, parseCustomInput } from "@/lib/custom-fields/service";
import { type CustomValues, customValuesKey } from "@/lib/custom-fields/values";
import { dueDateFromTerms } from "@/lib/customers/service";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import {
  createInvoice,
  getInvoice,
  hashSalesLines,
  insertSalesLines,
  type Invoice,
  type InvoiceLine,
  linesAsSent,
  linesState,
  loadSalesLines,
  parseSalesLines,
  resolveSalesDraft,
  type ResolvedSalesDraft,
  type SalesDraft,
} from "@/lib/invoices/service";
import { dec, toPlainString } from "@/lib/money/decimal";
import { parseSalespersonInput } from "@/lib/salespeople/service";
import { keptValues } from "@/lib/tracking/service";
import {
  optionalId,
  optionalSource,
  optionalString,
  requireId,
  requireIdempotencyKey,
  requireOneOf,
} from "@/lib/validation";

/**
 * Quotes (examples QT1-QT8), like Xero's. A draft has the same lines as an
 * invoice and can be edited, copied and deleted. Finalising gives it the next
 * number (QU-0001, no gaps) and locks it. A finalised quote is then accepted,
 * which makes a draft invoice carrying its lines (linked both ways), or
 * declined, which closes it. Expired is worked out from the expiry date, never
 * stored. Quotes post nothing to the ledger; only the invoice does, when it's
 * approved.
 */
export const QUOTE_STATUSES = ["draft", "finalised", "accepted", "declined"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export type QuoteSummary = {
  id: string;
  status: QuoteStatus;
  /** A finalised quote past its expiry date (QT5); worked out, not stored. */
  expired: boolean;
  quoteNumber: string | null;
  contactId: string;
  contactName: string;
  quoteDate: string;
  expiryDate: string | null;
  reference: string | null;
  terms: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  customFields: CustomValues;
  salespersonId: string | null;
  salespersonName: string | null;
  copiedFromQuoteId: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  finalisedAt: string | null;
  finalisedByEmail: string | null;
  closedAt: string | null;
  closedByEmail: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Quote = QuoteSummary & { lines: InvoiceLine[] };

export type QuoteInput = {
  contactId?: unknown;
  quoteDate?: unknown;
  expiryDate?: unknown;
  reference?: unknown;
  terms?: unknown;
  amountsMode?: unknown;
  lines?: unknown;
  customFields?: unknown;
  salespersonId?: unknown;
};

type QuoteRow = {
  id: string;
  status: QuoteStatus;
  quote_number: string | null;
  contact_id: string;
  contact_name: string;
  quote_date: string;
  expiry_date: string | null;
  reference: string | null;
  terms: string | null;
  amounts_mode: AmountsMode;
  currency_code: string;
  subtotal: string;
  tax_total: string;
  total: string;
  custom_fields: CustomValues;
  salesperson_id: string | null;
  salesperson_name: string | null;
  copied_from_quote_id: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  finalised_at: string | null;
  finalised_by_email: string | null;
  closed_at: string | null;
  closed_by_email: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

const SUMMARY_SQL = `select q.id, q.status, q.quote_number, q.contact_id, c.name as contact_name, q.quote_date, q.expiry_date,
       q.reference, q.terms, q.amounts_mode, q.currency_code, q.subtotal, q.tax_total, q.total, q.custom_fields,
       q.salesperson_id, sp.name as salesperson_name, q.copied_from_quote_id, q.invoice_id, i.invoice_number,
       q.finalised_at, q.finalised_by_email, q.closed_at, q.closed_by_email, q.created_by_email, q.created_at, q.updated_at
  from quotes q
  join contacts c on c.id = q.contact_id
  left join salespeople sp on sp.id = q.salesperson_id
  left join sales_invoices i on i.id = q.invoice_id`;

/** Whether a quote shows as expired on `today` (QT5): finalised, not yet accepted or declined, and past its expiry date. */
export function isQuoteExpired(quote: { status: QuoteStatus; expiryDate: string | null }, today: string): boolean {
  return quote.status === "finalised" && quote.expiryDate !== null && quote.expiryDate < today;
}

function toSummary(row: QuoteRow, today: string): QuoteSummary {
  const summary: QuoteSummary = {
    id: row.id,
    status: row.status,
    expired: false,
    quoteNumber: row.quote_number,
    contactId: row.contact_id,
    contactName: row.contact_name,
    quoteDate: row.quote_date,
    expiryDate: row.expiry_date,
    reference: row.reference,
    terms: row.terms,
    amountsMode: row.amounts_mode,
    currencyCode: row.currency_code,
    subtotal: row.subtotal,
    taxTotal: row.tax_total,
    total: row.total,
    customFields: row.custom_fields ?? {},
    salespersonId: row.salesperson_id,
    salespersonName: row.salesperson_name,
    copiedFromQuoteId: row.copied_from_quote_id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    finalisedAt: row.finalised_at,
    finalisedByEmail: row.finalised_by_email,
    closedAt: row.closed_at,
    closedByEmail: row.closed_by_email,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  summary.expired = isQuoteExpired(summary, today);
  return summary;
}

function quoteLabel(quote: QuoteSummary): string {
  return quote.quoteNumber ? `Quote ${quote.quoteNumber}` : `Draft quote #${quote.id}`;
}

type ParsedQuote = { draft: SalesDraft; expiryDate: string | null; terms: string | null };

function parseQuote(input: QuoteInput): ParsedQuote {
  const contactId = requireId(input.contactId, "contactId");
  const quoteDate = parseIsoDate(input.quoteDate, "quoteDate");
  const expiryDate = parseOptionalIsoDate(input.expiryDate, "expiryDate");
  if (expiryDate !== null && expiryDate < quoteDate) {
    throw new ValidationError("The expiry date can't be before the quote date.");
  }
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  return {
    draft: {
      contactId,
      invoiceDate: quoteDate,
      dueDate: quoteDate,
      reference: optionalString(input.reference, "reference", { maxLength: 100 }),
      amountsMode,
      lines: parseSalesLines(input.lines, amountsMode, "A quote"),
      customInput: parseCustomInput(input.customFields, ""),
      salespersonInput: parseSalespersonInput(input.salespersonId),
    },
    expiryDate,
    terms: optionalString(input.terms, "terms", { maxLength: 2000 }),
  };
}

function hashPayload(parsed: ParsedQuote): Record<string, unknown> {
  const { draft } = parsed;
  return {
    contactId: draft.contactId,
    quoteDate: draft.invoiceDate,
    expiryDate: parsed.expiryDate,
    reference: draft.reference,
    terms: parsed.terms,
    amountsMode: draft.amountsMode,
    lines: hashSalesLines(draft.lines),
    ...(draft.customInput !== undefined ? { customFields: draft.customInput } : {}),
    ...(draft.salespersonInput !== undefined ? { salespersonId: draft.salespersonInput } : {}),
  };
}

function asSent(quote: Quote): QuoteInput {
  return {
    contactId: quote.contactId,
    quoteDate: quote.quoteDate,
    expiryDate: quote.expiryDate,
    reference: quote.reference,
    terms: quote.terms,
    amountsMode: quote.amountsMode,
    lines: linesAsSent(quote.lines),
    customFields: quote.customFields,
    salespersonId: quote.salespersonId,
  };
}

async function resolveFor(tx: OrgTx, draft: SalesDraft, current?: Quote): Promise<ResolvedSalesDraft> {
  // Quotes use the invoice's custom fields and tracking, since their lines become an invoice's (QT3).
  return current
    ? resolveSalesDraft(
        tx,
        draft,
        keptValues(current.lines),
        keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)),
        current.salespersonId,
        current.lines,
      )
    : resolveSalesDraft(tx, draft);
}

export async function getQuote(tx: OrgTx, quoteIdInput: unknown): Promise<Quote> {
  const quoteId = requireId(quoteIdInput, "quoteId");
  const result = await tx.query<QuoteRow>(`${SUMMARY_SQL} where q.id = $1`, [quoteId]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Quote not found.");
  return { ...toSummary(row, todayIsoDate()), lines: await loadSalesLines(tx, "quote_lines", quoteId) };
}

async function lockQuote(tx: OrgTx, quoteId: string): Promise<Quote> {
  const locked = await tx.query("select id from quotes where id = $1 for update", [quoteId]);
  if (locked.rowCount === 0) throw new NotFoundError("Quote not found.");
  return getQuote(tx, quoteId);
}

/** The quote an invoice was made from (QT3), if any. */
export async function quoteForInvoice(tx: OrgTx, invoiceId: string): Promise<{ id: string; quoteNumber: string } | null> {
  const found = await tx.query<{ id: string; quote_number: string }>("select id, quote_number from quotes where invoice_id = $1", [invoiceId]);
  const row = found.rows[0];
  return row ? { id: row.id, quoteNumber: row.quote_number } : null;
}

export const QUOTE_FILTERS = ["draft", "finalised", "expired", "accepted", "declined"] as const;

/** Newest first, 50 at a time. `status` is one of QUOTE_FILTERS ("expired" is finalised quotes past their expiry date). */
export async function listQuotes(
  tx: OrgTx,
  filters: { status?: unknown; contactId?: unknown; beforeId?: unknown } = {},
): Promise<{ quotes: QuoteSummary[]; nextBeforeId: string | null }> {
  const status = filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", QUOTE_FILTERS);
  const contactId = optionalId(filters.contactId, "contactId");
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const today = todayIsoDate();
  const limit = 50;
  const result = await tx.query<QuoteRow>(
    `${SUMMARY_SQL}
      where ($1::text is null
             or ($1 = 'expired' and q.status = 'finalised' and q.expiry_date < $4::date)
             or ($1 = 'finalised' and q.status = 'finalised' and (q.expiry_date is null or q.expiry_date >= $4::date))
             or ($1 not in ('expired', 'finalised') and q.status = $1))
        and ($2::bigint is null or q.id < $2) and ($3::bigint is null or q.contact_id = $3)
      order by q.id desc
      limit ${limit + 1}`,
    [status, beforeId, contactId, today],
  );
  const rows = result.rows.slice(0, limit);
  return {
    quotes: rows.map((row) => toSummary(row, today)),
    nextBeforeId: result.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

async function findByKey(tx: OrgTx, kind: "create" | "finalise" | "close", source: string, key: string) {
  const columns = {
    create: ["command_source", "idempotency_key", "request_hash"],
    finalise: ["finalise_command_source", "finalise_idempotency_key", "finalise_request_hash"],
    close: ["close_command_source", "close_idempotency_key", "close_request_hash"],
  }[kind];
  const found = await tx.query<{ id: string; hash: string }>(
    `select id, ${columns[2]} as hash from quotes where ${columns[0]} = $1 and ${columns[1]} = $2`,
    [source, key],
  );
  return found.rows[0] ?? null;
}

async function insertQuote(
  tx: OrgTx,
  command: { source: string; idempotencyKey: string; hash: string },
  parsed: ParsedQuote,
  resolved: ResolvedSalesDraft,
  copiedFrom: string | null,
): Promise<string | null> {
  const inserted = await tx.query<{ id: string }>(
    `insert into quotes (command_source, idempotency_key, request_hash, contact_id, quote_date, expiry_date, reference, terms,
                         amounts_mode, currency_code, subtotal, tax_total, total, custom_fields, salesperson_id,
                         copied_from_quote_id, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12::numeric, $13::numeric, $14::jsonb, $15, $16, $17, $18)
     on conflict (command_source, idempotency_key) do nothing
     returning id`,
    [
      command.source,
      command.idempotencyKey,
      command.hash,
      resolved.contactId,
      resolved.invoiceDate,
      parsed.expiryDate,
      resolved.reference,
      parsed.terms,
      resolved.amountsMode,
      resolved.currencyCode,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      JSON.stringify(resolved.customFields),
      resolved.salespersonId,
      copiedFrom,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const id = inserted.rows[0]?.id ?? null;
  if (id) await insertSalesLines(tx, "quote_lines", id, resolved.resolvedLines);
  return id;
}

/** Saves a new draft quote (QT1). Quotes post nothing. */
export async function createQuote(
  tx: OrgTx,
  input: QuoteInput & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; quote: Quote }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const parsed = parseQuote(input);
  const hash = requestHash("quote", hashPayload(parsed));
  const existing = await findByKey(tx, "create", source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.hash, hash, "quote");
    return { created: false, quote: await getQuote(tx, existing.id) };
  }
  const resolved = await resolveFor(tx, parsed.draft);
  const id = await insertQuote(tx, { source, idempotencyKey, hash }, parsed, resolved, null);
  if (!id) {
    const winner = await findByKey(tx, "create", source, idempotencyKey);
    if (!winner) throw new ConflictError("That quote is being saved by another request. Try again.");
    assertSameRequest(winner.hash, hash, "quote");
    return { created: false, quote: await getQuote(tx, winner.id) };
  }
  await writeAuditEvent(tx, {
    eventType: "quote.created",
    entityType: "quote",
    entityId: id,
    details: { contactId: resolved.contactId, quoteDate: resolved.invoiceDate, total: resolved.total, lines: resolved.resolvedLines.length },
  });
  return { created: true, quote: await getQuote(tx, id) };
}

function assertDraft(quote: Quote, action: string): void {
  if (quote.status !== "draft") {
    throw new ConflictError(`${quoteLabel(quote)} is ${quote.status}, so it can't be ${action}. Copy it to make a new draft.`);
  }
}

/** Edits a draft quote. Fields left out keep their values; `lines` replaces every line. */
export async function updateQuote(tx: OrgTx, quoteIdInput: unknown, input: QuoteInput): Promise<Quote> {
  const current = await lockQuote(tx, requireId(quoteIdInput, "quoteId"));
  assertDraft(current, "edited");
  const saved = asSent(current);
  const pick = <K extends keyof QuoteInput>(key: K) => (input[key] === undefined ? saved[key] : input[key]);
  const parsed = parseQuote({
    contactId: pick("contactId"),
    quoteDate: pick("quoteDate"),
    expiryDate: pick("expiryDate"),
    reference: pick("reference"),
    terms: pick("terms"),
    amountsMode: pick("amountsMode"),
    lines: pick("lines"),
    customFields: pick("customFields"),
    salespersonId: pick("salespersonId"),
  });
  const resolved = await resolveFor(tx, parsed.draft, current);
  await tx.query(
    `update quotes set contact_id = $2, quote_date = $3, expiry_date = $4, reference = $5, terms = $6, amounts_mode = $7,
            currency_code = $8, subtotal = $9::numeric, tax_total = $10::numeric, total = $11::numeric, custom_fields = $12::jsonb,
            salesperson_id = $13, updated_at = now()
      where id = $1`,
    [
      current.id,
      resolved.contactId,
      resolved.invoiceDate,
      parsed.expiryDate,
      resolved.reference,
      parsed.terms,
      resolved.amountsMode,
      resolved.currencyCode,
      resolved.subtotal,
      resolved.taxTotal,
      resolved.total,
      JSON.stringify(resolved.customFields),
      resolved.salespersonId,
    ],
  );
  await tx.query("delete from quote_lines where quote_id = $1", [current.id]);
  await insertSalesLines(tx, "quote_lines", current.id, resolved.resolvedLines);
  await writeAuditEvent(tx, {
    eventType: "quote.updated",
    entityType: "quote",
    entityId: current.id,
    details: { total: { from: current.total, to: resolved.total } },
  });
  return getQuote(tx, current.id);
}

/** Deletes a draft quote. A finalised quote is declined instead. */
export async function deleteQuote(tx: OrgTx, quoteIdInput: unknown): Promise<void> {
  const current = await lockQuote(tx, requireId(quoteIdInput, "quoteId"));
  assertDraft(current, "deleted");
  const copies = await tx.query("select 1 from quotes where copied_from_quote_id = $1 limit 1", [current.id]);
  if (copies.rowCount) {
    throw new ConflictError("Another quote was copied from this draft, so it can't be deleted.");
  }
  await tx.query("delete from quote_lines where quote_id = $1", [current.id]);
  await tx.query("delete from quotes where id = $1", [current.id]);
  await writeAuditEvent(tx, {
    eventType: "quote.deleted",
    entityType: "quote",
    entityId: current.id,
    details: { contactId: current.contactId, contactName: current.contactName, quoteDate: current.quoteDate, total: current.total },
  });
}

export function formatQuoteNumber(sequence: number): string {
  return `QU-${String(sequence).padStart(4, "0")}`;
}

function sameAsStored(resolved: ResolvedSalesDraft, current: Quote): boolean {
  const header = (value: { subtotal: string; taxTotal: string; total: string; customFields: CustomValues; salespersonId: string | null }) =>
    JSON.stringify([toPlainString(dec(value.subtotal)), toPlainString(dec(value.taxTotal)), toPlainString(dec(value.total)), customValuesKey(value.customFields), value.salespersonId]);
  return header(resolved) === header(current) && linesState(resolved.resolvedLines) === linesState(current.lines);
}

/**
 * Finalises a draft (QT2): checks it again, gives it the next QU- number and
 * locks it. The counter row stays locked until the transaction ends and a
 * refused finalise rolls it back, so numbers have no gaps.
 */
export async function finaliseQuote(
  tx: OrgTx,
  quoteIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; quote: Quote }> {
  const quoteId = requireId(quoteIdInput, "quoteId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("quote_finalise", { quoteId });
  const replay = async () => {
    const earlier = await findByKey(tx, "finalise", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, "quote finalise");
    return { created: false, quote: await getQuote(tx, earlier.id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const current = await lockQuote(tx, quoteId);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  if (current.status !== "draft") throw new ConflictError(`${quoteLabel(current)} is already ${current.status}.`);
  const resolved = await resolveFor(tx, parseQuote(asSent(current)).draft, current);
  if (!sameAsStored(resolved, current)) {
    throw new ConflictError("This draft's amounts no longer match its tax codes. Open it and save it again, then check the totals.");
  }
  const counter = await tx.query<{ last_number: number }>(
    "update quote_numbering set last_number = last_number + 1 where id = true returning last_number",
  );
  const sequence = Number(counter.rows[0].last_number);
  const quoteNumber = formatQuoteNumber(sequence);
  try {
    await tx.query(
      `update quotes set status = 'finalised', quote_sequence = $2, quote_number = $3, finalise_command_source = $4,
              finalise_idempotency_key = $5, finalise_request_hash = $6, finalised_by_user_id = $7, finalised_by_email = $8,
              finalised_at = now(), updated_at = now()
        where id = $1`,
      [quoteId, sequence, quoteNumber, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ConflictError("That idempotency key was already used for a different quote finalise. Use a new key.");
    }
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "quote.finalised", entityType: "quote", entityId: quoteId, details: { quoteNumber, total: current.total } });
  return { created: true, quote: await getQuote(tx, quoteId) };
}

async function closeCommand(
  tx: OrgTx,
  quoteId: string,
  kind: "accept" | "decline",
  command: { source?: unknown; idempotencyKey: unknown },
  payload: Record<string, unknown>,
) {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash(`quote_${kind}`, { quoteId, ...payload });
  const replay = async () => {
    const earlier = await findByKey(tx, "close", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, `quote ${kind}`);
    return getQuote(tx, earlier.id);
  };
  return { source, idempotencyKey, hash, replay };
}

/**
 * Accepts a finalised quote (QT3): makes a draft invoice for the same
 * customer carrying the quote's lines, amounts, custom fields and salesperson,
 * dated `invoiceDate`, due on `dueDate` or else the customer's payment terms,
 * with the quote number as its reference unless the quote had one. The quote
 * and invoice are linked both ways. Accepting again with the same key returns
 * the same invoice; an accepted or declined quote can't be accepted.
 */
export async function acceptQuote(
  tx: OrgTx,
  quoteIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; invoiceDate: unknown; dueDate?: unknown },
): Promise<{ created: boolean; quote: Quote; invoice: Invoice }> {
  const quoteId = requireId(quoteIdInput, "quoteId");
  const invoiceDate = parseIsoDate(input.invoiceDate, "invoiceDate");
  const sentDue = parseOptionalIsoDate(input.dueDate, "dueDate");
  const command = await closeCommand(tx, quoteId, "accept", input, { invoiceDate, dueDate: sentDue });
  const earlier = await command.replay();
  if (earlier) return { created: false, quote: earlier, invoice: await getInvoice(tx, earlier.invoiceId!) };
  const current = await lockQuote(tx, quoteId);
  const meanwhile = await command.replay();
  if (meanwhile) return { created: false, quote: meanwhile, invoice: await getInvoice(tx, meanwhile.invoiceId!) };
  if (current.status === "draft") throw new ConflictError("Finalise this quote before it's accepted.");
  if (current.status !== "finalised") throw new ConflictError(`${quoteLabel(current)} is already ${current.status}.`);
  if (invoiceDate < current.quoteDate) throw new ValidationError(`The invoice date can't be before the quote date (${current.quoteDate}).`);
  const dueDate = sentDue ?? (await dueDateFromTerms(tx, current.contactId, invoiceDate));
  if (dueDate === null) {
    throw new ValidationError("dueDate is required (YYYY-MM-DD): this customer has no payment terms to work it out from.");
  }
  const { invoice } = await createInvoice(tx, {
    source: "quote",
    idempotencyKey: `quote-${current.id}-accept`,
    contactId: current.contactId,
    invoiceDate,
    dueDate,
    reference: current.reference ?? current.quoteNumber,
    amountsMode: current.amountsMode,
    lines: linesAsSent(current.lines),
    customFields: current.customFields,
    salespersonId: current.salespersonId,
  });
  await tx.query(
    `update quotes set status = 'accepted', invoice_id = $2, close_command_source = $3, close_idempotency_key = $4,
            close_request_hash = $5, closed_by_user_id = $6, closed_by_email = $7, closed_at = now(), updated_at = now()
      where id = $1`,
    [current.id, invoice.id, command.source, command.idempotencyKey, command.hash, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "quote.accepted",
    entityType: "quote",
    entityId: current.id,
    details: { quoteNumber: current.quoteNumber, invoiceId: invoice.id },
  });
  await writeAuditEvent(tx, {
    eventType: "invoice.created_from_quote",
    entityType: "sales_invoice",
    entityId: invoice.id,
    details: { quoteId: current.id, quoteNumber: current.quoteNumber },
  });
  return { created: true, quote: await getQuote(tx, current.id), invoice };
}

/** Declines a finalised quote (QT4): it's closed and can't be accepted or invoiced. */
export async function declineQuote(
  tx: OrgTx,
  quoteIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; quote: Quote }> {
  const quoteId = requireId(quoteIdInput, "quoteId");
  const command = await closeCommand(tx, quoteId, "decline", input, {});
  const earlier = await command.replay();
  if (earlier) return { created: false, quote: earlier };
  const current = await lockQuote(tx, quoteId);
  const meanwhile = await command.replay();
  if (meanwhile) return { created: false, quote: meanwhile };
  if (current.status === "draft") throw new ConflictError("This quote is still a draft. Delete it instead.");
  if (current.status !== "finalised") throw new ConflictError(`${quoteLabel(current)} is already ${current.status}.`);
  await tx.query(
    `update quotes set status = 'declined', close_command_source = $2, close_idempotency_key = $3, close_request_hash = $4,
            closed_by_user_id = $5, closed_by_email = $6, closed_at = now(), updated_at = now()
      where id = $1`,
    [current.id, command.source, command.idempotencyKey, command.hash, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "quote.declined", entityType: "quote", entityId: current.id, details: { quoteNumber: current.quoteNumber } });
  return { created: true, quote: await getQuote(tx, current.id) };
}

/**
 * Copies any quote into a new draft (QT6) with the same customer, lines,
 * amounts and terms, dated `quoteDate`; the expiry date keeps the same number
 * of days after the quote date as the original had.
 */
export async function copyQuote(
  tx: OrgTx,
  quoteIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; quoteDate: unknown },
): Promise<{ created: boolean; quote: Quote }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const original = await getQuote(tx, requireId(quoteIdInput, "quoteId"));
  const quoteDate = parseIsoDate(input.quoteDate, "quoteDate");
  const hash = requestHash("quote_copy", { quoteId: original.id, quoteDate });
  const existing = await findByKey(tx, "create", source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.hash, hash, "quote copy");
    return { created: false, quote: await getQuote(tx, existing.id) };
  }
  let expiryDate: string | null = null;
  if (original.expiryDate) {
    const days = Math.round((Date.parse(`${original.expiryDate}T00:00:00Z`) - Date.parse(`${original.quoteDate}T00:00:00Z`)) / 86_400_000);
    const moved = new Date(Date.parse(`${quoteDate}T00:00:00Z`) + days * 86_400_000);
    expiryDate = moved.toISOString().slice(0, 10);
  }
  const parsed = parseQuote({ ...asSent(original), quoteDate, expiryDate });
  // A copy is a new draft, so archived customers, items, tracking options and
  // salespeople aren't kept from the original: it's checked like a new quote.
  const resolved = await resolveFor(tx, parsed.draft);
  const id = await insertQuote(tx, { source, idempotencyKey, hash }, parsed, resolved, original.id);
  if (!id) throw new ConflictError("That quote is being copied by another request. Try again.");
  await writeAuditEvent(tx, { eventType: "quote.copied", entityType: "quote", entityId: id, details: { fromQuoteId: original.id } });
  return { created: true, quote: await getQuote(tx, id) };
}

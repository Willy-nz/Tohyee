import { writeAuditEvent } from "@/lib/audit";
import { assertRequiredFields, keptCustom, parseCustomInput } from "@/lib/custom-fields/service";
import { type CustomValues, customValuesKey } from "@/lib/custom-fields/values";
import { parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { parseRateInput } from "@/lib/fx/documents";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import {
  createInvoice,
  getInvoice,
  hashSalesLines,
  insertSalesLines,
  type Invoice,
  type InvoiceLine,
  type InvoiceStatus,
  linesAsSent,
  linesState,
  loadSalesLines,
  parseSalesLines,
  resolveSalesDraft,
  type ResolvedSalesDraft,
  type SalesDraft,
} from "@/lib/invoices/service";
import { cmp, dec, isPositive, isZero, parseDecimalInput, sub, toPlainString } from "@/lib/money/decimal";
import { parseSalespersonInput } from "@/lib/salespeople/service";
import { assertRequiredTags, keptValues, loadTrackingContext } from "@/lib/tracking/service";
import {
  asRecord,
  optionalId,
  optionalSource,
  optionalString,
  requireArray,
  requireId,
  requireIdempotencyKey,
  requireOneOf,
} from "@/lib/validation";

/**
 * Sales orders, stage 1 (examples SO1-SO12), following NetSuite's ("Sales
 * Orders", "Viewing the Status of Sales Orders", "Billing or Invoicing a
 * Sales Order", "Closing a Sales Order"). A draft to a customer has the same
 * lines as an invoice and can be edited and deleted. Approving checks it
 * again, numbers it (SO-0001, no gaps) and locks it. Sales orders post
 * nothing to the ledger and don't touch stock or GST.
 *
 * "Invoice" makes a draft invoice for what's left on each line (or less),
 * each invoice line pointing back to its order line. What's been invoiced is
 * worked out from those invoices, never stored: approved invoices count as
 * invoiced, draft invoices as "on draft invoices", voided ones not at all.
 * The status is worked out from those figures; only closing and cancelling
 * are stored, as they're decisions. Stock reservation and deliveries are
 * later stages: cost of sales is still posted when the invoice is approved.
 */
export const SALES_ORDER_STATUSES = ["draft", "pending_billing", "partly_billed", "billed", "closed", "cancelled"] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

export type SalesOrderSummary = {
  id: string;
  /** Worked out from the linked invoices (SO2-SO5), except draft, closed and cancelled. */
  status: SalesOrderStatus;
  soNumber: string | null;
  contactId: string;
  contactName: string;
  orderDate: string;
  expectedDate: string | null;
  reference: string | null;
  memo: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  customFields: CustomValues;
  salespersonId: string | null;
  salespersonName: string | null;
  approvedAt: string | null;
  approvedByEmail: string | null;
  closedAt: string | null;
  closedByEmail: string | null;
  cancelledAt: string | null;
  cancelledByEmail: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SalesOrderLine = InvoiceLine & {
  id: string;
  /** On approved invoices (SO3, SO4). */
  invoicedQuantity: string;
  /** On draft invoices, not yet approved. */
  onDraftInvoicesQuantity: string;
  /** Still to be invoiced: ordered less what's on invoices that aren't voided. */
  remainingQuantity: string;
};

export type SalesOrderInvoice = {
  id: string;
  status: InvoiceStatus;
  invoiceNumber: string | null;
  invoiceDate: string;
  total: string;
};

export type SalesOrder = SalesOrderSummary & {
  lines: SalesOrderLine[];
  invoices: SalesOrderInvoice[];
  /** The quote accepted as this order (SO9), if any. */
  fromQuote: { id: string; quoteNumber: string } | null;
};

export type SalesOrderInput = {
  contactId?: unknown;
  orderDate?: unknown;
  expectedDate?: unknown;
  reference?: unknown;
  memo?: unknown;
  amountsMode?: unknown;
  lines?: unknown;
  customFields?: unknown;
  salespersonId?: unknown;
};

type Row = {
  id: string;
  status: SalesOrderStatus;
  so_number: string | null;
  contact_id: string;
  contact_name: string;
  order_date: string;
  expected_date: string | null;
  reference: string | null;
  memo: string | null;
  amounts_mode: AmountsMode;
  currency_code: string;
  subtotal: string;
  tax_total: string;
  total: string;
  custom_fields: CustomValues;
  salesperson_id: string | null;
  salesperson_name: string | null;
  approved_at: string | null;
  approved_by_email: string | null;
  closed_at: string | null;
  closed_by_email: string | null;
  cancelled_at: string | null;
  cancelled_by_email: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

/** What's on approved invoices for an order line `l`. */
const INVOICED = `coalesce((select sum(il.quantity) from sales_invoice_lines il join sales_invoices i on i.id = il.invoice_id
                             where il.sales_order_line_id = l.id and i.status = 'approved'), 0)`;

/**
 * The status, worked out each time it's read (NetSuite's sales order
 * statuses): billed once approved invoices cover every line, partly billed
 * once anything is invoiced, pending billing before that.
 */
const STATUS_SQL = `case
    when s.status <> 'approved' then s.status
    when not exists (select 1 from sales_order_lines l where l.sales_order_id = s.id and l.quantity > ${INVOICED}) then 'billed'
    when exists (select 1 from sales_order_lines l where l.sales_order_id = s.id and ${INVOICED} > 0) then 'partly_billed'
    else 'pending_billing'
  end`;

const SUMMARY_SQL = `select s.id, ${STATUS_SQL} as status, s.so_number, s.contact_id, c.name as contact_name,
       s.order_date, s.expected_date, s.reference, s.memo, s.amounts_mode, s.currency_code, s.subtotal, s.tax_total, s.total,
       s.custom_fields, s.salesperson_id, sp.name as salesperson_name, s.approved_at, s.approved_by_email, s.closed_at,
       s.closed_by_email, s.cancelled_at, s.cancelled_by_email, s.created_by_email, s.created_at, s.updated_at
  from sales_orders s
  join contacts c on c.id = s.contact_id
  left join salespeople sp on sp.id = s.salesperson_id`;

function toSummary(row: Row): SalesOrderSummary {
  return {
    id: row.id,
    status: row.status,
    soNumber: row.so_number,
    contactId: row.contact_id,
    contactName: row.contact_name,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    reference: row.reference,
    memo: row.memo,
    amountsMode: row.amounts_mode,
    currencyCode: row.currency_code,
    subtotal: row.subtotal,
    taxTotal: row.tax_total,
    total: row.total,
    customFields: row.custom_fields ?? {},
    salespersonId: row.salesperson_id,
    salespersonName: row.salesperson_name,
    approvedAt: row.approved_at,
    approvedByEmail: row.approved_by_email,
    closedAt: row.closed_at,
    closedByEmail: row.closed_by_email,
    cancelledAt: row.cancelled_at,
    cancelledByEmail: row.cancelled_by_email,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** How a status reads in messages and on screens ("partly billed"). */
export function salesOrderStatusLabel(status: SalesOrderStatus): string {
  return status.replace("_", " ");
}

function label(order: SalesOrderSummary): string {
  return order.soNumber ? `Sales order ${order.soNumber}` : `Draft sales order #${order.id}`;
}

type Parsed = { draft: SalesDraft; expectedDate: string | null; memo: string | null };

function parseOrder(input: SalesOrderInput): Parsed {
  const contactId = requireId(input.contactId, "contactId");
  const orderDate = parseIsoDate(input.orderDate, "orderDate");
  const expectedDate = parseOptionalIsoDate(input.expectedDate, "expectedDate");
  if (expectedDate !== null && expectedDate < orderDate) {
    throw new ValidationError("The expected date can't be before the order date.");
  }
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  return {
    // The invoice line rules and maths apply (I1-I6, IT2); an order has no due date.
    draft: {
      contactId,
      invoiceDate: orderDate,
      dueDate: orderDate,
      reference: optionalString(input.reference, "reference", { maxLength: 100 }),
      amountsMode,
      lines: parseSalesLines(input.lines, amountsMode, "A sales order"),
      customInput: parseCustomInput(input.customFields, ""),
      salespersonInput: parseSalespersonInput(input.salespersonId),
    },
    expectedDate,
    memo: optionalString(input.memo, "memo", { maxLength: 1000 }),
  };
}

function hashPayload(parsed: Parsed): Record<string, unknown> {
  const { draft } = parsed;
  return {
    contactId: draft.contactId,
    orderDate: draft.invoiceDate,
    expectedDate: parsed.expectedDate,
    reference: draft.reference,
    memo: parsed.memo,
    amountsMode: draft.amountsMode,
    lines: hashSalesLines(draft.lines),
    ...(draft.customInput !== undefined ? { customFields: draft.customInput } : {}),
    ...(draft.salespersonInput !== undefined ? { salespersonId: draft.salespersonInput } : {}),
  };
}

function asSent(order: SalesOrder): SalesOrderInput {
  return {
    contactId: order.contactId,
    orderDate: order.orderDate,
    expectedDate: order.expectedDate,
    reference: order.reference,
    memo: order.memo,
    amountsMode: order.amountsMode,
    lines: linesAsSent(order.lines),
    customFields: order.customFields,
    salespersonId: order.salespersonId,
  };
}

/**
 * A sales order for a customer in another currency (SO10) is in that
 * currency, like a quote (MC25; NetSuite: "the currency from the original
 * transaction is maintained"), with no rate: it posts nothing. Each invoice
 * made from it takes a rate for its own date.
 */
const ORDER_FOREIGN = { foreignCurrency: true, template: true, feature: "Sales orders" } as const;

async function resolveFor(tx: OrgTx, draft: SalesDraft, current?: SalesOrder): Promise<ResolvedSalesDraft> {
  // Sales orders use the invoice's custom fields and tracking, since their lines become an invoice's (SO3).
  return current
    ? resolveSalesDraft(
        tx,
        draft,
        keptValues(current.lines),
        keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)),
        current.salespersonId,
        current.lines,
        ORDER_FOREIGN,
      )
    : resolveSalesDraft(tx, draft, undefined, undefined, undefined, undefined, ORDER_FOREIGN);
}

/** A sales order's lines with what's been invoiced on each, from its invoices (SO3-SO5). */
async function loadLines(tx: OrgTx, id: string): Promise<SalesOrderLine[]> {
  const lines = await loadSalesLines(tx, "sales_order_lines", id);
  const invoicing = await tx.query<{ id: string; line_order: number; invoiced: string; on_drafts: string }>(
    `select l.id, l.line_order,
            coalesce(sum(il.quantity) filter (where i.status = 'approved'), 0)::text as invoiced,
            coalesce(sum(il.quantity) filter (where i.status = 'draft'), 0)::text as on_drafts
       from sales_order_lines l
       left join sales_invoice_lines il on il.sales_order_line_id = l.id
       left join sales_invoices i on i.id = il.invoice_id
      where l.sales_order_id = $1
      group by l.id, l.line_order`,
    [id],
  );
  const byOrder = new Map(invoicing.rows.map((row) => [row.line_order, row]));
  return lines.map((line) => {
    const row = byOrder.get(line.lineOrder)!;
    const invoiced = dec(row.invoiced);
    const onDrafts = dec(row.on_drafts);
    return {
      ...line,
      id: row.id,
      invoicedQuantity: toPlainString(invoiced),
      onDraftInvoicesQuantity: toPlainString(onDrafts),
      remainingQuantity: toPlainString(sub(sub(dec(line.quantity), invoiced), onDrafts)),
    };
  });
}

export async function getSalesOrder(tx: OrgTx, idInput: unknown): Promise<SalesOrder> {
  const id = requireId(idInput, "salesOrderId");
  const result = await tx.query<Row>(`${SUMMARY_SQL} where s.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Sales order not found.");
  const invoices = await tx.query<{ id: string; status: InvoiceStatus; invoice_number: string | null; invoice_date: string; total: string }>(
    "select id, status, invoice_number, invoice_date, total from sales_invoices where sales_order_id = $1 order by id",
    [id],
  );
  const quote = await tx.query<{ id: string; quote_number: string }>("select id, quote_number from quotes where sales_order_id = $1", [id]);
  return {
    ...toSummary(row),
    lines: await loadLines(tx, id),
    invoices: invoices.rows.map((invoice) => ({
      id: invoice.id,
      status: invoice.status,
      invoiceNumber: invoice.invoice_number,
      invoiceDate: invoice.invoice_date,
      total: invoice.total,
    })),
    fromQuote: quote.rows[0] ? { id: quote.rows[0].id, quoteNumber: quote.rows[0].quote_number } : null,
  };
}

async function lockOrder(tx: OrgTx, id: string): Promise<SalesOrder> {
  const locked = await tx.query("select id from sales_orders where id = $1 for update", [id]);
  if (locked.rowCount === 0) throw new NotFoundError("Sales order not found.");
  return getSalesOrder(tx, id);
}

/** Newest first, 50 at a time. `status` is one of SALES_ORDER_STATUSES (SO12). */
export async function listSalesOrders(
  tx: OrgTx,
  filters: { status?: unknown; contactId?: unknown; beforeId?: unknown } = {},
): Promise<{ salesOrders: SalesOrderSummary[]; nextBeforeId: string | null }> {
  const status = filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", SALES_ORDER_STATUSES);
  const contactId = optionalId(filters.contactId, "contactId");
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const limit = 50;
  const result = await tx.query<Row>(
    `select * from (${SUMMARY_SQL}) s
      where ($1::text is null or s.status = $1)
        and ($2::bigint is null or s.id < $2) and ($3::bigint is null or s.contact_id = $3)
      order by s.id desc
      limit ${limit + 1}`,
    [status, beforeId, contactId],
  );
  const rows = result.rows.slice(0, limit);
  return {
    salesOrders: rows.map(toSummary),
    nextBeforeId: result.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

const KEY_COLUMNS = {
  create: ["command_source", "idempotency_key", "request_hash"],
  approve: ["approve_command_source", "approve_idempotency_key", "approve_request_hash"],
  close: ["close_command_source", "close_idempotency_key", "close_request_hash"],
  cancel: ["cancel_command_source", "cancel_idempotency_key", "cancel_request_hash"],
} as const;

async function findByKey(tx: OrgTx, kind: keyof typeof KEY_COLUMNS, source: string, key: string) {
  const [sourceColumn, keyColumn, hashColumn] = KEY_COLUMNS[kind];
  const found = await tx.query<{ id: string; hash: string }>(
    `select id, ${hashColumn} as hash from sales_orders where ${sourceColumn} = $1 and ${keyColumn} = $2`,
    [source, key],
  );
  return found.rows[0] ?? null;
}

function stored(parsed: Parsed, resolved: ResolvedSalesDraft) {
  return [
    resolved.contactId,
    resolved.invoiceDate,
    parsed.expectedDate,
    resolved.reference,
    parsed.memo,
    resolved.amountsMode,
    resolved.currencyCode,
    resolved.subtotal,
    resolved.taxTotal,
    resolved.total,
    JSON.stringify(resolved.customFields),
    resolved.salespersonId,
  ];
}

/**
 * Saves a new draft sales order (SO1). Sales orders post nothing. The
 * customer must be an active contact marked as a customer (checked by the
 * invoice rules).
 */
export async function createSalesOrder(
  tx: OrgTx,
  input: SalesOrderInput & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; salesOrder: SalesOrder }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const parsed = parseOrder(input);
  const hash = requestHash("sales_order", hashPayload(parsed));
  const existing = await findByKey(tx, "create", source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.hash, hash, "sales order");
    return { created: false, salesOrder: await getSalesOrder(tx, existing.id) };
  }
  const resolved = await resolveFor(tx, parsed.draft);
  const inserted = await tx.query<{ id: string }>(
    `insert into sales_orders (command_source, idempotency_key, request_hash, contact_id, order_date, expected_date, reference, memo,
                               amounts_mode, currency_code, subtotal, tax_total, total, custom_fields, salesperson_id,
                               created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12::numeric, $13::numeric, $14::jsonb, $15, $16, $17)
     on conflict (command_source, idempotency_key) do nothing
     returning id`,
    [source, idempotencyKey, hash, ...stored(parsed, resolved), tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0]?.id;
  if (!id) {
    const winner = await findByKey(tx, "create", source, idempotencyKey);
    if (!winner) throw new ConflictError("That sales order is being saved by another request. Try again.");
    assertSameRequest(winner.hash, hash, "sales order");
    return { created: false, salesOrder: await getSalesOrder(tx, winner.id) };
  }
  await insertSalesLines(tx, "sales_order_lines", id, resolved.resolvedLines);
  await writeAuditEvent(tx, {
    eventType: "sales_order.created",
    entityType: "sales_order",
    entityId: id,
    details: { contactId: resolved.contactId, orderDate: resolved.invoiceDate, total: resolved.total, lines: resolved.resolvedLines.length },
  });
  return { created: true, salesOrder: await getSalesOrder(tx, id) };
}

function assertDraft(order: SalesOrder, action: string): void {
  if (order.status !== "draft") {
    throw new ConflictError(`${label(order)} is approved (${salesOrderStatusLabel(order.status)}), so it can't be ${action}.`);
  }
}

/** Edits a draft. Fields left out keep their values; `lines` replaces every line. */
export async function updateSalesOrder(tx: OrgTx, idInput: unknown, input: SalesOrderInput): Promise<SalesOrder> {
  const current = await lockOrder(tx, requireId(idInput, "salesOrderId"));
  assertDraft(current, "edited");
  const saved = asSent(current);
  const pick = <K extends keyof SalesOrderInput>(key: K) => (input[key] === undefined ? saved[key] : input[key]);
  const parsed = parseOrder({
    contactId: pick("contactId"),
    orderDate: pick("orderDate"),
    expectedDate: pick("expectedDate"),
    reference: pick("reference"),
    memo: pick("memo"),
    amountsMode: pick("amountsMode"),
    lines: pick("lines"),
    customFields: pick("customFields"),
    salespersonId: pick("salespersonId"),
  });
  if (current.fromQuote && parsed.draft.contactId !== current.contactId) {
    throw new ValidationError(`This draft was made by accepting quote ${current.fromQuote.quoteNumber}, so its customer can't change.`);
  }
  const resolved = await resolveFor(tx, parsed.draft, current);
  await tx.query(
    `update sales_orders set contact_id = $2, order_date = $3, expected_date = $4, reference = $5, memo = $6, amounts_mode = $7,
            currency_code = $8, subtotal = $9::numeric, tax_total = $10::numeric, total = $11::numeric, custom_fields = $12::jsonb,
            salesperson_id = $13, updated_at = now()
      where id = $1`,
    [current.id, ...stored(parsed, resolved)],
  );
  await tx.query("delete from sales_order_lines where sales_order_id = $1", [current.id]);
  await insertSalesLines(tx, "sales_order_lines", current.id, resolved.resolvedLines);
  await writeAuditEvent(tx, {
    eventType: "sales_order.updated",
    entityType: "sales_order",
    entityId: current.id,
    details: { total: { from: current.total, to: resolved.total } },
  });
  return getSalesOrder(tx, current.id);
}

/** Deletes a draft. An approved order is closed or cancelled instead (SO7, SO8). */
export async function deleteSalesOrder(tx: OrgTx, idInput: unknown): Promise<void> {
  const current = await lockOrder(tx, requireId(idInput, "salesOrderId"));
  assertDraft(current, "deleted");
  // SO9: the order an accepted quote made stays, so the quote keeps its order (as QT7).
  if (current.fromQuote) {
    throw new ConflictError(
      `This draft was made by accepting quote ${current.fromQuote.quoteNumber}, so it can't be deleted. Edit it, or approve it and cancel it.`,
    );
  }
  await tx.query("delete from sales_order_lines where sales_order_id = $1", [current.id]);
  await tx.query("delete from sales_orders where id = $1", [current.id]);
  await writeAuditEvent(tx, {
    eventType: "sales_order.deleted",
    entityType: "sales_order",
    entityId: current.id,
    details: { contactId: current.contactId, contactName: current.contactName, orderDate: current.orderDate, total: current.total },
  });
}

export function formatSalesOrderNumber(sequence: number): string {
  return `SO-${String(sequence).padStart(4, "0")}`;
}

function sameAsStored(resolved: ResolvedSalesDraft, current: SalesOrder): boolean {
  const header = (value: { subtotal: string; taxTotal: string; total: string; customFields: CustomValues; salespersonId: string | null }) =>
    JSON.stringify([toPlainString(dec(value.subtotal)), toPlainString(dec(value.taxTotal)), toPlainString(dec(value.total)), customValuesKey(value.customFields), value.salespersonId]);
  return header(resolved) === header(current) && linesState(resolved.resolvedLines) === linesState(current.lines);
}

type Command = { source?: unknown; idempotencyKey: unknown };

/** The replay check for approve, close and cancel: the same key returns the original; a different request with it is refused. */
function commandFor(tx: OrgTx, id: string, kind: "approve" | "close" | "cancel", command: Command) {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash(`sales_order_${kind}`, { salesOrderId: id });
  const replay = async () => {
    const earlier = await findByKey(tx, kind, source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, `sales order ${kind}`);
    return { created: false, salesOrder: await getSalesOrder(tx, earlier.id) };
  };
  return { source, idempotencyKey, hash, replay };
}

function keyReused(error: unknown, kind: string): never {
  if ((error as { code?: string }).code === "23505") {
    throw new ConflictError(`That idempotency key was already used for a different sales order ${kind}. Use a new key.`);
  }
  throw error;
}

/**
 * Approves a draft (SO2): checks it again as an invoice would be (customer,
 * accounts, tax codes, items, required tracking and custom fields), gives it
 * the next SO- number and locks it. The counter row stays locked until the
 * transaction ends and a refused approval rolls it back, so numbers have no
 * gaps. Posts nothing.
 */
export async function approveSalesOrder(tx: OrgTx, idInput: unknown, input: Command): Promise<{ created: boolean; salesOrder: SalesOrder }> {
  const id = requireId(idInput, "salesOrderId");
  const command = commandFor(tx, id, "approve", input);
  const earlier = await command.replay();
  if (earlier) return earlier;
  const current = await lockOrder(tx, id);
  const meanwhile = await command.replay();
  if (meanwhile) return meanwhile;
  if (current.status !== "draft") throw new ConflictError(`${label(current)} is already approved (${salesOrderStatusLabel(current.status)}).`);
  const resolved = await resolveFor(tx, parseOrder(asSent(current)).draft, current);
  if (!sameAsStored(resolved, current)) {
    throw new ConflictError("This draft's amounts no longer match its tax codes. Open it and save it again, then check the totals.");
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
  const counter = await tx.query<{ last_number: number }>(
    "update sales_order_numbering set last_number = last_number + 1 where id = true returning last_number",
  );
  const sequence = Number(counter.rows[0].last_number);
  const soNumber = formatSalesOrderNumber(sequence);
  try {
    await tx.query(
      `update sales_orders set status = 'approved', so_sequence = $2, so_number = $3, approve_command_source = $4,
              approve_idempotency_key = $5, approve_request_hash = $6, approved_by_user_id = $7, approved_by_email = $8,
              approved_at = now(), updated_at = now()
        where id = $1`,
      [id, sequence, soNumber, command.source, command.idempotencyKey, command.hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    keyReused(error, "approval");
  }
  await writeAuditEvent(tx, { eventType: "sales_order.approved", entityType: "sales_order", entityId: id, details: { soNumber, total: current.total } });
  return { created: true, salesOrder: await getSalesOrder(tx, id) };
}

function invoiceNames(invoices: SalesOrderInvoice[]): string {
  return invoices.map((invoice) => invoice.invoiceNumber ?? `a draft dated ${invoice.invoiceDate}`).join(", ");
}

/**
 * Closes an approved order (SO7; NetSuite's "Closing a Sales Order"): nothing
 * more will be invoiced on it. Refused once it's billed (nothing is left) and
 * while it has draft invoices. The database refuses the drafts case too.
 */
export async function closeSalesOrder(tx: OrgTx, idInput: unknown, input: Command): Promise<{ created: boolean; salesOrder: SalesOrder }> {
  const id = requireId(idInput, "salesOrderId");
  const command = commandFor(tx, id, "close", input);
  const earlier = await command.replay();
  if (earlier) return earlier;
  const current = await lockOrder(tx, id);
  const meanwhile = await command.replay();
  if (meanwhile) return meanwhile;
  if (current.status === "draft") throw new ConflictError("This sales order is still a draft. Delete it instead.");
  if (current.status === "closed" || current.status === "cancelled") {
    throw new ConflictError(`${label(current)} is already ${current.status}.`);
  }
  if (current.status === "billed") {
    throw new ConflictError(`${label(current)} is billed: there's nothing left to invoice, so there's nothing to close.`);
  }
  const drafts = current.invoices.filter((invoice) => invoice.status === "draft");
  if (drafts.length > 0) {
    throw new ConflictError(
      `${label(current)} has ${drafts.length === 1 ? "a draft invoice" : `${drafts.length} draft invoices`} (${invoiceNames(drafts)}), so it can't be closed. Approve or delete ${drafts.length === 1 ? "it" : "them"} first.`,
    );
  }
  try {
    await tx.query(
      `update sales_orders set status = 'closed', close_command_source = $2, close_idempotency_key = $3, close_request_hash = $4,
              closed_by_user_id = $5, closed_by_email = $6, closed_at = now(), updated_at = now()
        where id = $1`,
      [id, command.source, command.idempotencyKey, command.hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    keyReused(error, "close");
  }
  await writeAuditEvent(tx, { eventType: "sales_order.closed", entityType: "sales_order", entityId: id, details: { soNumber: current.soNumber } });
  return { created: true, salesOrder: await getSalesOrder(tx, id) };
}

/**
 * Cancels an approved order that has no invoices, other than voided ones
 * (SO8). Drafts are deleted instead; a closed order stays closed. The
 * database refuses it too.
 */
export async function cancelSalesOrder(tx: OrgTx, idInput: unknown, input: Command): Promise<{ created: boolean; salesOrder: SalesOrder }> {
  const id = requireId(idInput, "salesOrderId");
  const command = commandFor(tx, id, "cancel", input);
  const earlier = await command.replay();
  if (earlier) return earlier;
  const current = await lockOrder(tx, id);
  const meanwhile = await command.replay();
  if (meanwhile) return meanwhile;
  if (current.status === "draft") throw new ConflictError("This sales order is still a draft. Delete it instead.");
  if (current.status === "cancelled") throw new ConflictError(`${label(current)} is already cancelled.`);
  if (current.status === "closed") throw new ConflictError(`${label(current)} is closed, so it can't be cancelled.`);
  const open = current.invoices.filter((invoice) => invoice.status !== "voided");
  if (open.length > 0) {
    throw new ConflictError(
      `${label(current)} has ${open.length === 1 ? "an invoice" : `${open.length} invoices`} (${invoiceNames(open)}), so it can't be cancelled. Void or delete ${open.length === 1 ? "it" : "them"} first.`,
    );
  }
  try {
    await tx.query(
      `update sales_orders set status = 'cancelled', cancel_command_source = $2, cancel_idempotency_key = $3, cancel_request_hash = $4,
              cancelled_by_user_id = $5, cancelled_by_email = $6, cancelled_at = now(), updated_at = now()
        where id = $1`,
      [id, command.source, command.idempotencyKey, command.hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    keyReused(error, "cancel");
  }
  await writeAuditEvent(tx, { eventType: "sales_order.cancelled", entityType: "sales_order", entityId: id, details: { soNumber: current.soNumber } });
  return { created: true, salesOrder: await getSalesOrder(tx, id) };
}

/** The quantities asked for: each order line named at most once, zero or more, at most what's left. */
function parseQuantities(input: unknown, order: SalesOrder): Array<{ line: SalesOrderLine; quantity: string }> {
  if (input === undefined || input === null) {
    return order.lines.filter((line) => isPositive(dec(line.remainingQuantity))).map((line) => ({ line, quantity: line.remainingQuantity }));
  }
  const raw = requireArray(input, "lines", order.lines.length);
  const byId = new Map(order.lines.map((line) => [line.id, line]));
  const seen = new Set<string>();
  const wanted: Array<{ line: SalesOrderLine; quantity: string }> = [];
  raw.forEach((entry, index) => {
    const item = asRecord(entry, `Line ${index + 1}`);
    const lineId = requireId(item.salesOrderLineId, `Line ${index + 1} sales order line`);
    const line = byId.get(lineId);
    if (!line) throw new ValidationError(`Line ${index + 1} isn't one of ${order.soNumber}'s lines.`);
    if (seen.has(lineId)) throw new ValidationError(`${order.soNumber} line ${line.lineOrder} is listed twice.`);
    seen.add(lineId);
    const quantity = parseDecimalInput(item.quantity, `${order.soNumber} line ${line.lineOrder} quantity`, { maxScale: 4, allowZero: true });
    if (cmp(dec(quantity), dec(line.remainingQuantity)) > 0) {
      throw new ValidationError(
        `${order.soNumber} line ${line.lineOrder} (${line.description}): only ${line.remainingQuantity} left to invoice, so ${quantity} can't be invoiced. Put anything extra on a line of its own on the invoice.`,
      );
    }
    if (!isZero(dec(quantity))) wanted.push({ line, quantity });
  });
  return wanted.sort((a, b) => a.line.lineOrder - b.line.lineOrder);
}

const INVOICE_SOURCE = "sales_order";

/**
 * Invoices an approved sales order (SO3, SO4; NetSuite's "Billing or
 * Invoicing a Sales Order"): makes a draft invoice with what's left on each
 * line, or the quantities given in `lines` (less, or zero to leave a line
 * off; lines not listed are left off), with the order line's description,
 * price, account, tax code, item, unit, tracking and custom fields, linked
 * back to it, and the order's salesperson, custom fields and reference (or
 * number). The invoice's own rules apply from then on. The due date is given
 * or, left out, comes from the customer's payment terms. An order in another
 * currency (SO10) makes an invoice in it at a rate for the invoice date:
 * `exchangeRate`, or else the last rate used (MC3).
 */
export async function invoiceSalesOrder(
  tx: OrgTx,
  idInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; invoiceDate: unknown; dueDate?: unknown; exchangeRate?: unknown; lines?: unknown },
): Promise<{ created: boolean; salesOrder: SalesOrder; invoice: Invoice }> {
  const id = requireId(idInput, "salesOrderId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const invoiceDate = parseIsoDate(input.invoiceDate, "invoiceDate");
  // Left out, the customer's payment terms fill it when the invoice is made.
  const dueDate = parseOptionalIsoDate(input.dueDate, "dueDate");
  const typedRate = parseRateInput(input.exchangeRate);
  const invoiceKey = `${id}:${source}:${idempotencyKey}`;
  const replay = async () => {
    const found = await tx.query<{ id: string; sales_order_id: string | null; invoice_date: string }>(
      "select id, sales_order_id, invoice_date from sales_invoices where command_source = $1 and idempotency_key = $2",
      [INVOICE_SOURCE, invoiceKey],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.sales_order_id !== id || row.invoice_date !== invoiceDate) {
      throw new ConflictError("That idempotency key was already used for a different invoice from a sales order. Use a new key.");
    }
    return { created: false, salesOrder: await getSalesOrder(tx, id), invoice: await getInvoice(tx, row.id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const current = await lockOrder(tx, id);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  if (current.status === "draft") throw new ConflictError("Approve this sales order before it's invoiced.");
  if (current.status === "closed" || current.status === "cancelled") {
    throw new ConflictError(`${label(current)} is ${current.status}, so it can't be invoiced.`);
  }
  if (invoiceDate < current.orderDate) throw new ValidationError(`The invoice date can't be before the order date (${current.orderDate}).`);
  if (!current.lines.some((line) => isPositive(dec(line.remainingQuantity)))) {
    throw new ConflictError(
      `There's nothing left to invoice on ${current.soNumber}: everything is on invoices${current.lines.some((line) => isPositive(dec(line.onDraftInvoicesQuantity))) ? " (some of them drafts)" : ""}. Void or delete an invoice to invoice it again.`,
    );
  }
  const wanted = parseQuantities(input.lines, current);
  if (wanted.length === 0) throw new ValidationError("Give a quantity to invoice on at least one line.");
  const { invoice } = await createInvoice(
    tx,
    {
      source: INVOICE_SOURCE,
      idempotencyKey: invoiceKey,
      contactId: current.contactId,
      invoiceDate,
      ...(dueDate === null ? {} : { dueDate }),
      reference: current.reference ?? current.soNumber,
      amountsMode: current.amountsMode,
      lines: wanted.map(({ line, quantity }) => ({
        description: line.description,
        quantity,
        unitPrice: toPlainString(dec(line.unitPrice)),
        accountCode: line.accountCode,
        taxCode: line.taxCode,
        tracking: line.tracking,
        customFields: line.customFields,
        itemId: line.itemId,
        unitId: line.unitId,
        salesOrderLineId: line.id,
      })),
      customFields: current.customFields,
      salespersonId: current.salespersonId,
      ...(typedRate != null ? { exchangeRate: typedRate } : {}),
    },
    { foreignCurrency: true, feature: "Sales orders" },
    { salesOrderId: current.id },
  );
  await writeAuditEvent(tx, {
    eventType: "sales_order.invoiced",
    entityType: "sales_order",
    entityId: current.id,
    details: { soNumber: current.soNumber, invoiceId: invoice.id, lines: wanted.map(({ line, quantity }) => ({ salesOrderLineId: line.id, quantity })) },
  });
  return { created: true, salesOrder: await getSalesOrder(tx, current.id), invoice };
}

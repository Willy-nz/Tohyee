import { writeAuditEvent } from "@/lib/audit";
import {
  type Bill,
  type BillLine,
  createBill,
  type DraftDetails,
  getBill,
  hashPurchaseLines,
  insertPurchaseLines,
  linesState,
  loadPurchaseLines,
  parsePurchaseLines,
  type ResolvedDraft,
  resolveDraft,
} from "@/lib/bills/service";
import { assertRequiredFields, keptCustom, parseCustomInput } from "@/lib/custom-fields/service";
import { type CustomValues, customValuesKey } from "@/lib/custom-fields/values";
import { parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import { dec, isPositive, sub, toPlainString } from "@/lib/money/decimal";
import { assertRequiredTags, keptValues, loadTrackingContext } from "@/lib/tracking/service";
import {
  optionalId,
  optionalSource,
  optionalString,
  requireId,
  requireIdempotencyKey,
  requireOneOf,
  requireString,
} from "@/lib/validation";

/**
 * Purchase orders (examples PO1-PO9), like Xero's. A draft to a supplier
 * has the same lines as a bill (items fill the supplier's price, IT6), a
 * delivery date and address, and can be edited and deleted. Approving checks
 * it again, numbers it (PO-0001, no gaps) and locks it. Purchase orders post
 * nothing to the ledger.
 *
 * "Copy to bill" makes a draft bill with what's left to bill on each line,
 * each bill line pointing back to its purchase order line. What's been
 * billed is worked out from those bills, never stored: approved bills count
 * as billed, draft bills as "on draft bills", voided bills not at all. A
 * purchase order shows as billed once approved bills cover every line. An
 * approved purchase order with no bills (other than voided ones) can be
 * cancelled. Stock comes in on the bill (ST1), not here.
 */
export const PURCHASE_ORDER_STATUSES = ["draft", "approved", "billed", "cancelled"] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export type PurchaseOrderSummary = {
  id: string;
  /** "billed" is worked out: approved, and approved bills cover every line (PO3). */
  status: PurchaseOrderStatus;
  poNumber: string | null;
  contactId: string;
  contactName: string;
  orderDate: string;
  deliveryDate: string | null;
  deliveryAddress: string | null;
  deliveryInstructions: string | null;
  reference: string | null;
  amountsMode: AmountsMode;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  customFields: CustomValues;
  approvedAt: string | null;
  approvedByEmail: string | null;
  cancelledAt: string | null;
  cancelledByEmail: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PurchaseOrderLine = BillLine & {
  id: string;
  /** On approved bills (PO3, PO4). */
  billedQuantity: string;
  /** On draft bills, not yet approved. */
  onDraftBillsQuantity: string;
  /** Still to be copied to a bill: ordered less what's on bills that aren't voided. */
  remainingQuantity: string;
};

export type PurchaseOrderBill = {
  id: string;
  status: Bill["status"];
  supplierInvoiceNumber: string | null;
  billDate: string;
  total: string;
};

export type PurchaseOrder = PurchaseOrderSummary & { lines: PurchaseOrderLine[]; bills: PurchaseOrderBill[] };

export type PurchaseOrderInput = {
  contactId?: unknown;
  orderDate?: unknown;
  deliveryDate?: unknown;
  deliveryAddress?: unknown;
  deliveryInstructions?: unknown;
  reference?: unknown;
  amountsMode?: unknown;
  lines?: unknown;
  customFields?: unknown;
};

type Row = {
  id: string;
  status: "draft" | "approved" | "cancelled";
  fully_billed: boolean;
  po_number: string | null;
  contact_id: string;
  contact_name: string;
  order_date: string;
  delivery_date: string | null;
  delivery_address: string | null;
  delivery_instructions: string | null;
  reference: string | null;
  amounts_mode: AmountsMode;
  currency_code: string;
  subtotal: string;
  tax_total: string;
  total: string;
  custom_fields: CustomValues;
  approved_at: string | null;
  approved_by_email: string | null;
  cancelled_at: string | null;
  cancelled_by_email: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

/** Every line fully on approved bills; worked out each time it's read. */
const FULLY_BILLED = `not exists (
    select 1 from purchase_order_lines l
     where l.purchase_order_id = p.id
       and l.quantity > coalesce((select sum(bl.quantity) from bill_lines bl join bills b on b.id = bl.bill_id
                                   where bl.purchase_order_line_id = l.id and b.status = 'approved'), 0))`;

const SUMMARY_SQL = `select p.id, p.status, (p.status = 'approved' and ${FULLY_BILLED}) as fully_billed, p.po_number, p.contact_id,
       c.name as contact_name, p.order_date, p.delivery_date, p.delivery_address, p.delivery_instructions, p.reference,
       p.amounts_mode, p.currency_code, p.subtotal, p.tax_total, p.total, p.custom_fields, p.approved_at, p.approved_by_email,
       p.cancelled_at, p.cancelled_by_email, p.created_by_email, p.created_at, p.updated_at
  from purchase_orders p
  join contacts c on c.id = p.contact_id`;

function toSummary(row: Row): PurchaseOrderSummary {
  return {
    id: row.id,
    status: row.fully_billed ? "billed" : row.status,
    poNumber: row.po_number,
    contactId: row.contact_id,
    contactName: row.contact_name,
    orderDate: row.order_date,
    deliveryDate: row.delivery_date,
    deliveryAddress: row.delivery_address,
    deliveryInstructions: row.delivery_instructions,
    reference: row.reference,
    amountsMode: row.amounts_mode,
    currencyCode: row.currency_code,
    subtotal: row.subtotal,
    taxTotal: row.tax_total,
    total: row.total,
    customFields: row.custom_fields ?? {},
    approvedAt: row.approved_at,
    approvedByEmail: row.approved_by_email,
    cancelledAt: row.cancelled_at,
    cancelledByEmail: row.cancelled_by_email,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function label(order: PurchaseOrderSummary): string {
  return order.poNumber ? `Purchase order ${order.poNumber}` : `Draft purchase order #${order.id}`;
}

type Parsed = {
  draft: DraftDetails;
  deliveryDate: string | null;
  deliveryAddress: string | null;
  deliveryInstructions: string | null;
  reference: string | null;
};

function parseOrder(input: PurchaseOrderInput): Parsed {
  const contactId = requireId(input.contactId, "contactId");
  const orderDate = parseIsoDate(input.orderDate, "orderDate");
  const deliveryDate = parseOptionalIsoDate(input.deliveryDate, "deliveryDate");
  if (deliveryDate !== null && deliveryDate < orderDate) {
    throw new ValidationError("The delivery date can't be before the order date.");
  }
  const amountsMode = requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES);
  return {
    // The bill line rules and maths apply (B1-B4, ST1, IT6); a purchase order has no supplier invoice number or due date.
    draft: {
      contactId,
      billDate: orderDate,
      dueDate: orderDate,
      supplierInvoiceNumber: "",
      amountsMode,
      lines: parsePurchaseLines(input.lines, amountsMode, "A purchase order"),
      customInput: parseCustomInput(input.customFields, ""),
    },
    deliveryDate,
    deliveryAddress: optionalString(input.deliveryAddress, "deliveryAddress", { maxLength: 500 }),
    deliveryInstructions: optionalString(input.deliveryInstructions, "deliveryInstructions", { maxLength: 1000 }),
    reference: optionalString(input.reference, "reference", { maxLength: 100 }),
  };
}

function hashPayload(parsed: Parsed): Record<string, unknown> {
  const { draft } = parsed;
  return {
    contactId: draft.contactId,
    orderDate: draft.billDate,
    deliveryDate: parsed.deliveryDate,
    deliveryAddress: parsed.deliveryAddress,
    deliveryInstructions: parsed.deliveryInstructions,
    reference: parsed.reference,
    amountsMode: draft.amountsMode,
    lines: hashPurchaseLines(draft.lines),
    ...(draft.customInput !== undefined ? { customFields: draft.customInput } : {}),
  };
}

function asSent(order: PurchaseOrder): PurchaseOrderInput {
  return {
    contactId: order.contactId,
    orderDate: order.orderDate,
    deliveryDate: order.deliveryDate,
    deliveryAddress: order.deliveryAddress,
    deliveryInstructions: order.deliveryInstructions,
    reference: order.reference,
    amountsMode: order.amountsMode,
    lines: order.lines.map((line) => ({
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
    customFields: order.customFields,
  };
}

async function resolveFor(tx: OrgTx, draft: DraftDetails, current?: PurchaseOrder): Promise<ResolvedDraft> {
  // Purchase orders use the bill's custom fields and tracking, since their lines become a bill's (PO3).
  return current
    ? resolveDraft(tx, draft, keptValues(current.lines), keptCustom(current.customFields, ...current.lines.map((line) => line.customFields)), current.lines)
    : resolveDraft(tx, draft);
}

/** A purchase order's lines with what's been billed on each, from its bills (PO3-PO5). */
async function loadLines(tx: OrgTx, id: string): Promise<PurchaseOrderLine[]> {
  const lines = await loadPurchaseLines(tx, "purchase_order_lines", id);
  const billing = await tx.query<{ id: string; line_order: number; billed: string; on_drafts: string }>(
    `select l.id, l.line_order,
            coalesce(sum(bl.quantity) filter (where b.status = 'approved'), 0)::text as billed,
            coalesce(sum(bl.quantity) filter (where b.status = 'draft'), 0)::text as on_drafts
       from purchase_order_lines l
       left join bill_lines bl on bl.purchase_order_line_id = l.id
       left join bills b on b.id = bl.bill_id
      where l.purchase_order_id = $1
      group by l.id, l.line_order`,
    [id],
  );
  const byOrder = new Map(billing.rows.map((row) => [row.line_order, row]));
  return lines.map((line) => {
    const row = byOrder.get(line.lineOrder)!;
    const billed = dec(row.billed);
    const onDrafts = dec(row.on_drafts);
    return {
      ...line,
      id: row.id,
      billedQuantity: toPlainString(billed),
      onDraftBillsQuantity: toPlainString(onDrafts),
      remainingQuantity: toPlainString(sub(sub(dec(line.quantity), billed), onDrafts)),
    };
  });
}

export async function getPurchaseOrder(tx: OrgTx, idInput: unknown): Promise<PurchaseOrder> {
  const id = requireId(idInput, "purchaseOrderId");
  const result = await tx.query<Row>(`${SUMMARY_SQL} where p.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Purchase order not found.");
  const bills = await tx.query<{ id: string; status: Bill["status"]; supplier_invoice_number: string | null; bill_date: string; total: string }>(
    "select id, status, supplier_invoice_number, bill_date, total from bills where purchase_order_id = $1 order by id",
    [id],
  );
  return {
    ...toSummary(row),
    lines: await loadLines(tx, id),
    bills: bills.rows.map((bill) => ({
      id: bill.id,
      status: bill.status,
      supplierInvoiceNumber: bill.supplier_invoice_number,
      billDate: bill.bill_date,
      total: bill.total,
    })),
  };
}

async function lockOrder(tx: OrgTx, id: string): Promise<PurchaseOrder> {
  const locked = await tx.query("select id from purchase_orders where id = $1 for update", [id]);
  if (locked.rowCount === 0) throw new NotFoundError("Purchase order not found.");
  return getPurchaseOrder(tx, id);
}

/** Newest first, 50 at a time. `status` is one of PURCHASE_ORDER_STATUSES ("approved" leaves out billed ones). */
export async function listPurchaseOrders(
  tx: OrgTx,
  filters: { status?: unknown; contactId?: unknown; beforeId?: unknown } = {},
): Promise<{ purchaseOrders: PurchaseOrderSummary[]; nextBeforeId: string | null }> {
  const status = filters.status == null || filters.status === "" ? null : requireOneOf(filters.status, "status", PURCHASE_ORDER_STATUSES);
  const contactId = optionalId(filters.contactId, "contactId");
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const limit = 50;
  const result = await tx.query<Row>(
    `select * from (${SUMMARY_SQL}) p
      where ($1::text is null
             or ($1 = 'billed' and p.fully_billed)
             or ($1 = 'approved' and p.status = 'approved' and not p.fully_billed)
             or ($1 not in ('billed', 'approved') and p.status = $1))
        and ($2::bigint is null or p.id < $2) and ($3::bigint is null or p.contact_id = $3)
      order by p.id desc
      limit ${limit + 1}`,
    [status, beforeId, contactId],
  );
  const rows = result.rows.slice(0, limit);
  return {
    purchaseOrders: rows.map(toSummary),
    nextBeforeId: result.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

const KEY_COLUMNS = {
  create: ["command_source", "idempotency_key", "request_hash"],
  approve: ["approve_command_source", "approve_idempotency_key", "approve_request_hash"],
  cancel: ["cancel_command_source", "cancel_idempotency_key", "cancel_request_hash"],
} as const;

async function findByKey(tx: OrgTx, kind: keyof typeof KEY_COLUMNS, source: string, key: string) {
  const [sourceColumn, keyColumn, hashColumn] = KEY_COLUMNS[kind];
  const found = await tx.query<{ id: string; hash: string }>(
    `select id, ${hashColumn} as hash from purchase_orders where ${sourceColumn} = $1 and ${keyColumn} = $2`,
    [source, key],
  );
  return found.rows[0] ?? null;
}

/** The supplier must be an active contact marked as a supplier (checked by the bill rules, B8). */
function stored(parsed: Parsed, resolved: ResolvedDraft) {
  return [
    resolved.contactId,
    resolved.billDate,
    parsed.deliveryDate,
    parsed.deliveryAddress,
    parsed.deliveryInstructions,
    parsed.reference,
    resolved.amountsMode,
    resolved.currencyCode,
    resolved.subtotal,
    resolved.taxTotal,
    resolved.total,
    JSON.stringify(resolved.customFields),
  ];
}

/** Saves a new draft purchase order (PO1). Purchase orders post nothing. */
export async function createPurchaseOrder(
  tx: OrgTx,
  input: PurchaseOrderInput & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; purchaseOrder: PurchaseOrder }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const parsed = parseOrder(input);
  const hash = requestHash("purchase_order", hashPayload(parsed));
  const existing = await findByKey(tx, "create", source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.hash, hash, "purchase order");
    return { created: false, purchaseOrder: await getPurchaseOrder(tx, existing.id) };
  }
  const resolved = await resolveFor(tx, parsed.draft);
  const inserted = await tx.query<{ id: string }>(
    `insert into purchase_orders (command_source, idempotency_key, request_hash, contact_id, order_date, delivery_date, delivery_address,
                                  delivery_instructions, reference, amounts_mode, currency_code, subtotal, tax_total, total, custom_fields,
                                  created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, $13::numeric, $14::numeric, $15::jsonb, $16, $17)
     on conflict (command_source, idempotency_key) do nothing
     returning id`,
    [source, idempotencyKey, hash, ...stored(parsed, resolved), tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0]?.id;
  if (!id) {
    const winner = await findByKey(tx, "create", source, idempotencyKey);
    if (!winner) throw new ConflictError("That purchase order is being saved by another request. Try again.");
    assertSameRequest(winner.hash, hash, "purchase order");
    return { created: false, purchaseOrder: await getPurchaseOrder(tx, winner.id) };
  }
  await insertPurchaseLines(tx, "purchase_order_lines", id, resolved.resolvedLines);
  await writeAuditEvent(tx, {
    eventType: "purchase_order.created",
    entityType: "purchase_order",
    entityId: id,
    details: { contactId: resolved.contactId, orderDate: resolved.billDate, total: resolved.total, lines: resolved.resolvedLines.length },
  });
  return { created: true, purchaseOrder: await getPurchaseOrder(tx, id) };
}

function assertDraft(order: PurchaseOrder, action: string): void {
  if (order.status !== "draft") {
    throw new ConflictError(`${label(order)} is ${order.status}, so it can't be ${action}.`);
  }
}

/** Edits a draft. Fields left out keep their values; `lines` replaces every line. */
export async function updatePurchaseOrder(tx: OrgTx, idInput: unknown, input: PurchaseOrderInput): Promise<PurchaseOrder> {
  const current = await lockOrder(tx, requireId(idInput, "purchaseOrderId"));
  assertDraft(current, "edited");
  const saved = asSent(current);
  const pick = <K extends keyof PurchaseOrderInput>(key: K) => (input[key] === undefined ? saved[key] : input[key]);
  const parsed = parseOrder({
    contactId: pick("contactId"),
    orderDate: pick("orderDate"),
    deliveryDate: pick("deliveryDate"),
    deliveryAddress: pick("deliveryAddress"),
    deliveryInstructions: pick("deliveryInstructions"),
    reference: pick("reference"),
    amountsMode: pick("amountsMode"),
    lines: pick("lines"),
    customFields: pick("customFields"),
  });
  const resolved = await resolveFor(tx, parsed.draft, current);
  await tx.query(
    `update purchase_orders set contact_id = $2, order_date = $3, delivery_date = $4, delivery_address = $5, delivery_instructions = $6,
            reference = $7, amounts_mode = $8, currency_code = $9, subtotal = $10::numeric, tax_total = $11::numeric,
            total = $12::numeric, custom_fields = $13::jsonb, updated_at = now()
      where id = $1`,
    [current.id, ...stored(parsed, resolved)],
  );
  await tx.query("delete from purchase_order_lines where purchase_order_id = $1", [current.id]);
  await insertPurchaseLines(tx, "purchase_order_lines", current.id, resolved.resolvedLines);
  await writeAuditEvent(tx, {
    eventType: "purchase_order.updated",
    entityType: "purchase_order",
    entityId: current.id,
    details: { total: { from: current.total, to: resolved.total } },
  });
  return getPurchaseOrder(tx, current.id);
}

/** Deletes a draft. An approved purchase order is cancelled instead (PO7). */
export async function deletePurchaseOrder(tx: OrgTx, idInput: unknown): Promise<void> {
  const current = await lockOrder(tx, requireId(idInput, "purchaseOrderId"));
  assertDraft(current, "deleted");
  await tx.query("delete from purchase_order_lines where purchase_order_id = $1", [current.id]);
  await tx.query("delete from purchase_orders where id = $1", [current.id]);
  await writeAuditEvent(tx, {
    eventType: "purchase_order.deleted",
    entityType: "purchase_order",
    entityId: current.id,
    details: { contactId: current.contactId, contactName: current.contactName, orderDate: current.orderDate, total: current.total },
  });
}

export function formatPurchaseOrderNumber(sequence: number): string {
  return `PO-${String(sequence).padStart(4, "0")}`;
}

function sameAsStored(resolved: ResolvedDraft, current: PurchaseOrder): boolean {
  const header = (value: { subtotal: string; taxTotal: string; total: string; customFields: CustomValues }) =>
    JSON.stringify([toPlainString(dec(value.subtotal)), toPlainString(dec(value.taxTotal)), toPlainString(dec(value.total)), customValuesKey(value.customFields)]);
  return header(resolved) === header(current) && linesState(resolved.resolvedLines) === linesState(current.lines);
}

/**
 * Approves a draft (PO2): checks it again as a bill would be (supplier,
 * accounts, tax codes, items, required tracking and custom fields), gives it
 * the next PO- number and locks it. The counter row stays locked until the
 * transaction ends and a refused approval rolls it back, so numbers have no
 * gaps. Posts nothing.
 */
export async function approvePurchaseOrder(
  tx: OrgTx,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; purchaseOrder: PurchaseOrder }> {
  const id = requireId(idInput, "purchaseOrderId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("purchase_order_approval", { purchaseOrderId: id });
  const replay = async () => {
    const earlier = await findByKey(tx, "approve", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, "purchase order approval");
    return { created: false, purchaseOrder: await getPurchaseOrder(tx, earlier.id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const current = await lockOrder(tx, id);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  if (current.status !== "draft") throw new ConflictError(`${label(current)} is already ${current.status}.`);
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
    "bill",
    resolved.customFields,
    resolved.resolvedLines.map((line) => ({ values: line.customFields, accountClass: line.accountClass })),
  );
  const counter = await tx.query<{ last_number: number }>(
    "update purchase_order_numbering set last_number = last_number + 1 where id = true returning last_number",
  );
  const sequence = Number(counter.rows[0].last_number);
  const poNumber = formatPurchaseOrderNumber(sequence);
  try {
    await tx.query(
      `update purchase_orders set status = 'approved', po_sequence = $2, po_number = $3, approve_command_source = $4,
              approve_idempotency_key = $5, approve_request_hash = $6, approved_by_user_id = $7, approved_by_email = $8,
              approved_at = now(), updated_at = now()
        where id = $1`,
      [id, sequence, poNumber, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ConflictError("That idempotency key was already used for a different purchase order approval. Use a new key.");
    }
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "purchase_order.approved", entityType: "purchase_order", entityId: id, details: { poNumber, total: current.total } });
  return { created: true, purchaseOrder: await getPurchaseOrder(tx, id) };
}

/**
 * Cancels an approved purchase order that has no bills, other than voided
 * ones (PO7). Drafts are deleted instead. The database refuses it too.
 */
export async function cancelPurchaseOrder(
  tx: OrgTx,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; purchaseOrder: PurchaseOrder }> {
  const id = requireId(idInput, "purchaseOrderId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("purchase_order_cancel", { purchaseOrderId: id });
  const replay = async () => {
    const earlier = await findByKey(tx, "cancel", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, "purchase order cancel");
    return { created: false, purchaseOrder: await getPurchaseOrder(tx, earlier.id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const current = await lockOrder(tx, id);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  if (current.status === "draft") throw new ConflictError("This purchase order is still a draft. Delete it instead.");
  if (current.status === "cancelled") throw new ConflictError(`${label(current)} is already cancelled.`);
  const open = current.bills.filter((bill) => bill.status !== "voided");
  if (open.length > 0) {
    throw new ConflictError(
      `${label(current)} has ${open.length === 1 ? "a bill" : `${open.length} bills`} (${open.map((bill) => bill.supplierInvoiceNumber ?? "a draft with no number yet").join(", ")}), so it can't be cancelled. Void or delete ${open.length === 1 ? "it" : "them"} first.`,
    );
  }
  try {
    await tx.query(
      `update purchase_orders set status = 'cancelled', cancel_command_source = $2, cancel_idempotency_key = $3, cancel_request_hash = $4,
              cancelled_by_user_id = $5, cancelled_by_email = $6, cancelled_at = now(), updated_at = now()
        where id = $1`,
      [id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ConflictError("That idempotency key was already used for a different purchase order cancel. Use a new key.");
    }
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "purchase_order.cancelled", entityType: "purchase_order", entityId: id, details: { poNumber: current.poNumber } });
  return { created: true, purchaseOrder: await getPurchaseOrder(tx, id) };
}

const COPY_SOURCE = "purchase_order";

/**
 * Copies what's left to bill on an approved purchase order to a new draft
 * bill (PO3, PO4): each line with anything left, at that quantity, with the
 * purchase order line's description, price, account, tax code, item, unit,
 * tracking and custom fields, linked back to it. The bill's own rules apply
 * from then on; it can be edited (less, or a different price) before it's
 * approved. The supplier's invoice number is given; the due date is given
 * or, left out, comes from the supplier's payment terms (SPT4), as on any
 * new bill.
 */
export async function copyPurchaseOrderToBill(
  tx: OrgTx,
  idInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; billDate: unknown; dueDate?: unknown; supplierInvoiceNumber: unknown },
): Promise<{ created: boolean; purchaseOrder: PurchaseOrder; bill: Bill }> {
  const id = requireId(idInput, "purchaseOrderId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const billDate = parseIsoDate(input.billDate, "billDate");
  // Left out, the supplier's payment terms fill it when the bill is made (SPT4).
  const dueDate = parseOptionalIsoDate(input.dueDate, "dueDate");
  const supplierInvoiceNumber = requireString(input.supplierInvoiceNumber, "supplierInvoiceNumber", { maxLength: 100 });
  const billKey = `${id}:${source}:${idempotencyKey}`;
  const replay = async () => {
    const found = await tx.query<{ id: string; purchase_order_id: string | null; bill_date: string; supplier_invoice_number: string }>(
      "select id, purchase_order_id, bill_date, supplier_invoice_number from bills where command_source = $1 and idempotency_key = $2",
      [COPY_SOURCE, billKey],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.purchase_order_id !== id || row.bill_date !== billDate || row.supplier_invoice_number !== supplierInvoiceNumber) {
      throw new ConflictError("That idempotency key was already used for a different copy to a bill. Use a new key.");
    }
    return { created: false, purchaseOrder: await getPurchaseOrder(tx, id), bill: await getBill(tx, row.id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const current = await lockOrder(tx, id);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  if (current.status === "draft") throw new ConflictError("Approve this purchase order before it's copied to a bill.");
  if (current.status === "cancelled") throw new ConflictError(`${label(current)} is cancelled, so it can't be billed.`);
  const remaining = current.lines.filter((line) => isPositive(dec(line.remainingQuantity)));
  if (remaining.length === 0) {
    throw new ConflictError(
      `Everything on ${current.poNumber} is already on bills${current.lines.some((line) => isPositive(dec(line.onDraftBillsQuantity))) ? " (some of them drafts)" : ""}. Void or delete a bill to bill it again.`,
    );
  }
  const { bill } = await createBill(
    tx,
    {
      source: COPY_SOURCE,
      idempotencyKey: billKey,
      contactId: current.contactId,
      billDate,
      ...(dueDate === null ? {} : { dueDate }),
      supplierInvoiceNumber,
      amountsMode: current.amountsMode,
      lines: remaining.map((line) => ({
        description: line.description,
        quantity: line.remainingQuantity,
        unitPrice: line.unitPrice,
        accountCode: line.accountCode,
        taxCode: line.taxCode,
        tracking: line.tracking,
        customFields: line.customFields,
        itemId: line.itemId,
        unitId: line.unitId,
        purchaseOrderLineId: line.id,
      })),
      customFields: current.customFields,
    },
    { purchaseOrderId: current.id },
  );
  await writeAuditEvent(tx, {
    eventType: "purchase_order.copied_to_bill",
    entityType: "purchase_order",
    entityId: current.id,
    details: { poNumber: current.poNumber, billId: bill.id, lines: remaining.length },
  });
  return { created: true, purchaseOrder: await getPurchaseOrder(tx, current.id), bill };
}

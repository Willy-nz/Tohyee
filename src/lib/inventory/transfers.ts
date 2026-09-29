import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { QUANTITY_SCALE } from "@/lib/inventory/movements";
import { loadStockContext, StockPlanner } from "@/lib/inventory/stock";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { dec, parseDecimalInput, toFixedString } from "@/lib/money/decimal";
import { optionalId, optionalSource, optionalString, requireId, requireIdempotencyKey, requireString } from "@/lib/validation";

/**
 * Stock transfers between locations (examples TR1-TR6). A quantity of a
 * stock item leaves one location at that location's weighted average cost
 * (exact, rounded once to cents, taking the whole remaining value when
 * everything left is moved, W3/W4) and arrives at the other at the same
 * value, so the inventory account's total never changes.
 *
 * Bills tag their inventory lines with the line's Location (ST1), so the
 * inventory account does carry Location tags; a transfer posts a journal
 * that moves the value between them: Dr inventory tagged with the location
 * it goes to, Cr inventory tagged with the one it comes from, on the
 * transfer date. Both stock movements (transfer out and in) point at it.
 *
 * Refused: the same location at both ends, a zero quantity, anything but a
 * stock item, no locations set up, backdating (a date before either
 * location's latest movement), a locked period, an archived destination,
 * going below zero while negative stock is off, and coming into a location
 * that's below zero (a bill fills a shortfall, ST10). Transfers can't be
 * edited or voided; a transfer back undoes one.
 */
export type StockTransfer = {
  id: string;
  transferDate: string;
  itemId: string;
  itemCode: string;
  fromLocationValueId: string;
  fromLocationName: string;
  toLocationValueId: string;
  toLocationName: string;
  quantity: string;
  value: string;
  reference: string;
  description: string | null;
  journalId: string;
  createdByEmail: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  request_hash: string;
  transfer_date: string;
  item_id: string;
  item_code: string;
  from_location_value_id: string;
  from_name: string;
  to_location_value_id: string;
  to_name: string;
  quantity: string;
  value: string;
  reference: string;
  description: string | null;
  journal_id: string;
  created_by_email: string | null;
  created_at: string;
};

const SELECT = `select t.id, t.request_hash, t.transfer_date, t.item_id, t.item_code, t.from_location_value_id, f.name as from_name,
       t.to_location_value_id, d.name as to_name, t.quantity::text, t.value::text, t.reference, t.description, t.journal_id,
       t.created_by_email, t.created_at
  from stock_transfers t
  join tracking_values f on f.id = t.from_location_value_id
  join tracking_values d on d.id = t.to_location_value_id`;

function toTransfer(row: Row): StockTransfer {
  return {
    id: row.id,
    transferDate: row.transfer_date,
    itemId: row.item_id,
    itemCode: row.item_code,
    fromLocationValueId: row.from_location_value_id,
    fromLocationName: row.from_name,
    toLocationValueId: row.to_location_value_id,
    toLocationName: row.to_name,
    quantity: row.quantity,
    value: row.value,
    reference: row.reference,
    description: row.description,
    journalId: row.journal_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

async function findByKey(tx: OrgTx, source: string, key: string): Promise<Row | null> {
  const found = await tx.query<Row>(`${SELECT} where t.command_source = $1 and t.idempotency_key = $2`, [source, key]);
  return found.rows[0] ?? null;
}

/** Moves stock from one location to another (TR1-TR6), with its journal, in one transaction. */
export async function transferStock(
  tx: OrgTx,
  input: {
    source?: unknown;
    idempotencyKey: unknown;
    transferDate: unknown;
    itemId: unknown;
    fromLocationValueId: unknown;
    toLocationValueId: unknown;
    quantity: unknown;
    reference: unknown;
    description?: unknown;
  },
): Promise<{ created: boolean; transfer: StockTransfer }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const transferDate = parseIsoDate(input.transferDate, "transferDate");
  const itemId = requireId(input.itemId, "itemId");
  const from = requireId(input.fromLocationValueId, "fromLocationValueId");
  const to = requireId(input.toLocationValueId, "toLocationValueId");
  const quantity = parseDecimalInput(input.quantity, "quantity", { maxScale: QUANTITY_SCALE });
  const reference = requireString(input.reference, "reference", { maxLength: 100 });
  const description = optionalString(input.description, "description", { maxLength: 500 });
  if (from === to) {
    throw new ValidationError("Stock is transferred between two different locations. Choose another location to move it to.");
  }
  const hash = requestHash("stock_transfer", { transferDate, itemId, from, to, quantity, reference, description });
  const existing = await findByKey(tx, source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "stock transfer");
    return { created: false, transfer: toTransfer(existing) };
  }

  const item = await tx.query<{ code: string; item_type: string }>("select code, item_type from items where id = $1", [itemId]);
  if (!item.rows[0]) throw new ValidationError(`There's no item #${itemId}.`);
  const itemCode = item.rows[0].code;
  if (item.rows[0].item_type !== "stock") throw new ValidationError(`${itemCode} isn't a stock item, so it has no stock to transfer.`);

  const ctx = await loadStockContext(tx, "stock can't be transferred");
  if (!ctx.locationsInUse || !ctx.locationCategoryId) {
    throw new ValidationError("There are no locations yet, so there's nowhere to transfer stock to. An admin can add them under Tracking categories (Location).");
  }
  const fromName = ctx.locationNames.get(from);
  const toName = ctx.locationNames.get(to);
  if (!fromName) throw new ValidationError("The location to transfer from isn't a Location.");
  if (!toName) throw new ValidationError("The location to transfer to isn't a Location.");
  const active = await tx.query<{ is_active: boolean }>("select is_active from tracking_values where id = $1", [to]);
  if (!active.rows[0]?.is_active) throw new ValidationError(`${toName} is archived, so stock can't be transferred to it.`);

  // The transfer's id is taken first so its movements can point at it.
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('stock_transfers', 'id'))::text as id");
  const transferId = next.rows[0].id;
  const planner = new StockPlanner(tx, ctx, transferDate, { type: "transfer", id: transferId, reference });
  const { value } = await planner.transfer({ itemId, itemCode }, from, to, quantity, "Transfer");
  const amount = toFixedString(dec(value), ctx.scale);
  const text = description ?? `Transfer ${quantity} ${itemCode} from ${fromName} to ${toName}`;
  const posted = await postJournalBody(
    tx,
    `stock_transfer:${source}`,
    idempotencyKey,
    parseJournalBody(tx, {
      postingDate: transferDate,
      reference,
      description: text,
      lines: [
        { accountCode: ctx.inventoryCode, debitAmount: amount, creditAmount: "0", description: `${itemCode} ${quantity} to ${toName}`, tracking: { [ctx.locationCategoryId]: to } },
        { accountCode: ctx.inventoryCode, debitAmount: "0", creditAmount: amount, description: `${itemCode} ${quantity} from ${fromName}`, tracking: { [ctx.locationCategoryId]: from } },
      ],
    }),
    { origin: "inventory" },
  );
  if (!posted.created) {
    throw new ConflictError("That stock transfer is being saved by another request. Try again.");
  }
  await tx.query(
    `insert into stock_transfers (id, command_source, idempotency_key, request_hash, transfer_date, item_id, item_code,
                                  from_location_value_id, to_location_value_id, quantity, value, reference, description, journal_id,
                                  created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $12, $13, $14, $15, $16)`,
    [transferId, source, idempotencyKey, hash, transferDate, itemId, itemCode, from, to, quantity, amount, reference, description, posted.journal.id, tx.actor.userId, tx.actor.email],
  );
  await planner.record(posted.journal.id);
  await writeAuditEvent(tx, {
    eventType: "inventory.transfer_posted",
    entityType: "stock_transfer",
    entityId: transferId,
    details: { transferDate, itemCode, from: fromName, to: toName, quantity, value: amount, journalId: posted.journal.id },
  });
  const saved = await tx.query<Row>(`${SELECT} where t.id = $1`, [transferId]);
  return { created: true, transfer: toTransfer(saved.rows[0]) };
}

/** Newest first, 100 at a time. */
export async function listTransfers(
  tx: OrgTx,
  filters: { beforeId?: unknown } = {},
): Promise<{ transfers: StockTransfer[]; nextBeforeId: string | null }> {
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const limit = 100;
  const result = await tx.query<Row>(`${SELECT} where ($1::bigint is null or t.id < $1) order by t.id desc limit ${limit + 1}`, [beforeId]);
  const rows = result.rows.slice(0, limit);
  return { transfers: rows.map(toTransfer), nextBeforeId: result.rows.length > limit ? rows[rows.length - 1].id : null };
}

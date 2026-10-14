import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, isNegative, isPositive, isZero, mulDiv, parseDecimalInput, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalSource, optionalString, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";
import { postMovement } from "./movements";

/*
 * Landed cost spread across a bill's stock (#259; examples LDC1-LDC5,
 * decision 528). Freight, duty or insurance (excluding GST: import GST is
 * claimed back, so it's never stock cost) is split across the stock the
 * bill received, by value or by quantity. For each line, the share of what
 * was received that's still on hand goes onto the stock (a landed_cost
 * movement, Dr inventory); the rest was sold, so it goes to cost of sales.
 * Both are credited to the account the cost was first coded to (usually
 * Freight inwards).
 */

export const LANDED_COST_METHODS = ["value", "quantity"] as const;
export type LandedCostMethod = (typeof LANDED_COST_METHODS)[number];

export type LandedCostLine = {
  itemCode: string;
  locationValueId: string | null;
  receivedQuantity: string;
  receivedValue: string;
  share: string;
  toStock: string;
  toCostOfSales: string;
  inventoryMovementId: string | null;
};

export type LandedCostAllocation = {
  id: string;
  billId: string;
  allocationDate: string;
  amount: string;
  method: LandedCostMethod;
  offsetAccountCode: string;
  reference: string;
  costOfSalesJournalId: string | null;
  lines: LandedCostLine[];
  createdByEmail: string;
  createdAt: string;
};

type Receipt = { item_code: string; location_value_id: string | null; quantity: string; value: string };

/**
 * Splits `amount` by `weights` to the cent (LDC4): each share rounded half
 * up, and any cent left over goes to the largest weight (the first of
 * equals).
 */
export function splitByWeight(amount: Decimal, weights: readonly Decimal[], scale: number): Decimal[] {
  const total = weights.reduce((sum, weight) => add(sum, weight), ZERO_DECIMAL);
  if (!isPositive(total)) throw new ValidationError("There's nothing to split the cost by: the stock received has no value or quantity.");
  const shares = weights.map((weight) => mulDiv(amount, weight, total, scale));
  const difference = sub(amount, shares.reduce((sum, share) => add(sum, share), ZERO_DECIMAL));
  if (!isZero(difference)) {
    let largest = 0;
    weights.forEach((weight, index) => {
      if (cmp(weight, weights[largest]) > 0) largest = index;
    });
    shares[largest] = add(shares[largest], difference);
  }
  return shares;
}

async function getAllocation(tx: OrgTx, id: string): Promise<LandedCostAllocation> {
  const row = (
    await tx.query<{
      id: string;
      bill_id: string;
      allocation_date: string;
      amount: string;
      method: LandedCostMethod;
      offset_code: string;
      reference: string;
      cost_of_sales_journal_id: string | null;
      created_by_email: string;
      created_at: string;
    }>(
      `select l.id::text, l.bill_id::text, l.allocation_date::text, l.amount::text, l.method, a.code as offset_code, l.reference,
              l.cost_of_sales_journal_id::text, l.created_by_email, to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
         from landed_cost_allocations l join accounts a on a.id = l.offset_account_id where l.id = $1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Landed cost allocation not found.");
  const lines = await tx.query<{
    item_code: string;
    location_value_id: string | null;
    received_quantity: string;
    received_value: string;
    share: string;
    to_stock: string;
    to_cost_of_sales: string;
    inventory_movement_id: string | null;
  }>(
    `select item_code, location_value_id::text, received_quantity::text, received_value::text, share::text, to_stock::text,
            to_cost_of_sales::text, inventory_movement_id::text
       from landed_cost_allocation_lines where allocation_id = $1 order by id`,
    [id],
  );
  return {
    id: row.id,
    billId: row.bill_id,
    allocationDate: row.allocation_date,
    amount: row.amount,
    method: row.method,
    offsetAccountCode: row.offset_code,
    reference: row.reference,
    costOfSalesJournalId: row.cost_of_sales_journal_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    lines: lines.rows.map((line) => ({
      itemCode: line.item_code,
      locationValueId: line.location_value_id,
      receivedQuantity: line.received_quantity,
      receivedValue: line.received_value,
      share: line.share,
      toStock: line.to_stock,
      toCostOfSales: line.to_cost_of_sales,
      inventoryMovementId: line.inventory_movement_id,
    })),
  };
}

export async function listLandedCostAllocations(tx: OrgTx, billIdInput: unknown): Promise<LandedCostAllocation[]> {
  const billId = requireId(billIdInput, "billId");
  const rows = await tx.query<{ id: string }>("select id::text from landed_cost_allocations where bill_id = $1 order by id", [billId]);
  const result: LandedCostAllocation[] = [];
  for (const row of rows.rows) result.push(await getAllocation(tx, row.id));
  return result;
}

/** The stock an approved bill received, by item and location (value includes any cost of coming into negative stock). */
async function billReceipts(tx: OrgTx, billId: string): Promise<{ reference: string; receipts: Receipt[] }> {
  const bill = await tx.query<{ status: string; reference: string }>(
    "select status, coalesce(nullif(supplier_invoice_number, ''), 'Bill ' || id::text) as reference from bills where id = $1",
    [billId],
  );
  if (!bill.rows[0]) throw new NotFoundError("Bill not found.");
  if (bill.rows[0].status !== "approved") throw new ValidationError("Landed cost can only be spread over an approved bill's stock.");
  const receipts = await tx.query<Receipt>(
    `select item_code, location_value_id::text, sum(quantity_delta)::text as quantity, sum(value_delta + cost_adjustment)::text as value
       from inventory_movements
      where source_type = 'bill' and source_id = $1 and movement_type = 'receipt'
      group by item_code, location_value_id
      order by min(id)`,
    [billId],
  );
  if (receipts.rows.length === 0) throw new ValidationError("That bill didn't receive any stock items, so there's nothing to add landed cost to.");
  return { reference: bill.rows[0].reference, receipts: receipts.rows };
}

/**
 * Spreads a landed cost over the stock an approved bill received (LDC1-LDC5).
 * `amount` excludes GST. `offsetAccountCode` is where the cost was coded
 * when its own bill was entered (Freight inwards, say); it's credited.
 */
export async function allocateLandedCost(
  tx: OrgTx,
  input: {
    source?: unknown;
    idempotencyKey: unknown;
    billId: unknown;
    amount: unknown;
    method?: unknown;
    offsetAccountCode: unknown;
    allocationDate?: unknown;
    reference?: unknown;
  },
): Promise<{ created: boolean; allocation: LandedCostAllocation }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const billId = requireId(input.billId, "billId");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const amount = parseDecimalInput(input.amount, "The landed cost", { maxScale: scale });
  const method = input.method === undefined || input.method === null || input.method === "" ? "value" : requireOneOf(input.method, "method", LANDED_COST_METHODS);
  const offsetCode = requireString(input.offsetAccountCode, "The account the cost was coded to", { maxLength: 20 });
  const allocationDate = input.allocationDate ? parseIsoDate(input.allocationDate, "The date") : todayIsoDate();
  const givenReference = optionalString(input.reference, "reference", { maxLength: 100 });

  const hash = requestHash("landed_cost", { billId, amount, method, offset: offsetCode.toLowerCase(), allocationDate, reference: givenReference });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from landed_cost_allocations where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "landed cost allocation");
    return { created: false, allocation: await getAllocation(tx, earlier.rows[0].id) };
  }

  const offset = (
    await tx.query<{ id: string; code: string; is_active: boolean; system_key: string | null; account_type: string; currency_code: string | null }>(
      "select id::text, code, is_active, system_key, account_type, currency_code from accounts where lower(code) = lower($1)",
      [offsetCode],
    )
  ).rows[0];
  if (!offset) throw new ValidationError(`There's no account ${offsetCode}.`);
  if (!offset.is_active) throw new ValidationError(`Account ${offset.code} is archived.`);
  if (offset.currency_code) throw new ValidationError(`Account ${offset.code} holds a foreign currency.`);
  if (offset.system_key || offset.account_type === "bank" || offset.account_type === "credit_card") {
    throw new ValidationError(`Choose the account the cost was coded to on its bill (Freight inwards, say), not ${offset.code}.`);
  }
  const inventory = (await tx.query<{ code: string }>("select code from accounts where system_key = 'inventory'")).rows[0];
  const costOfSales = (await tx.query<{ code: string }>("select code from accounts where system_key = 'cost_of_goods_sold'")).rows[0];
  if (!inventory || !costOfSales) throw new ValidationError("Landed cost needs the inventory and cost of goods sold accounts.");

  // Keys for the movements and journal this posts, short enough whatever the caller's key.
  const derivedKey = `lc:${createHash("sha256").update(`${source}\u0000${idempotencyKey}`).digest("hex").slice(0, 40)}`;
  const { reference: billReference, receipts } = await billReceipts(tx, billId);
  const reference = givenReference ?? `Landed cost ${billReference}`.slice(0, 100);
  const weights = receipts.map((receipt) => (method === "value" ? dec(receipt.value) : dec(receipt.quantity)));
  const shares = splitByWeight(dec(amount), weights, scale);

  const lines: Array<Omit<LandedCostLine, "inventoryMovementId"> & { movementId: string | null }> = [];
  let toCostOfSalesTotal = ZERO_DECIMAL;
  for (const [index, receipt] of receipts.entries()) {
    const share = shares[index];
    const received = dec(receipt.quantity);
    const balance = await tx.query<{ on_hand: string }>(
      "select on_hand_quantity::text as on_hand from inventory_item_balances where item_code = $1 and location_value_id is not distinct from $2",
      [receipt.item_code, receipt.location_value_id],
    );
    const onHand = dec(balance.rows[0]?.on_hand ?? "0");
    // Only what this bill received can still be on hand from it (LDC3).
    const kept = isNegative(onHand) ? ZERO_DECIMAL : cmp(onHand, received) < 0 ? onHand : received;
    const toStock = isPositive(received) ? mulDiv(share, kept, received, scale) : ZERO_DECIMAL;
    const toCostOfSales = sub(share, toStock);
    let movementId: string | null = null;
    if (isPositive(toStock)) {
      const posted = await postMovement(tx, {
        source: "landed_cost",
        idempotencyKey: `${derivedKey}:${index}`,
        movementType: "landed_cost",
        movementDate: allocationDate,
        itemCode: receipt.item_code,
        reference,
        description: `Landed cost on ${billReference}: ${receipt.item_code}`,
        inventoryAccountCode: inventory.code,
        offsetAccountCode: offset.code,
        amount: toFixedString(toStock, scale),
        locationValueId: receipt.location_value_id,
      });
      movementId = posted.movement.id;
    }
    toCostOfSalesTotal = add(toCostOfSalesTotal, toCostOfSales);
    lines.push({
      itemCode: receipt.item_code,
      locationValueId: receipt.location_value_id,
      receivedQuantity: receipt.quantity,
      receivedValue: receipt.value,
      share: toFixedString(share, scale),
      toStock: toFixedString(toStock, scale),
      toCostOfSales: toFixedString(toCostOfSales, scale),
      movementId,
    });
  }

  let costOfSalesJournalId: string | null = null;
  if (isPositive(toCostOfSalesTotal)) {
    const total = toFixedString(toCostOfSalesTotal, scale);
    const journal = await postJournalBody(
      tx,
      "landed_cost",
      `${derivedKey}:cost_of_sales`,
      parseJournalBody(tx, {
        postingDate: allocationDate,
        reference,
        description: `Landed cost on ${billReference} for stock already sold`,
        lines: [
          { accountCode: costOfSales.code, debitAmount: total, creditAmount: "0" },
          { accountCode: offset.code, debitAmount: "0", creditAmount: total },
        ],
      }),
      { origin: "inventory" },
    );
    costOfSalesJournalId = journal.journal.id;
  }

  const inserted = await tx.query<{ id: string }>(
    `insert into landed_cost_allocations (command_source, idempotency_key, request_hash, bill_id, allocation_date, amount, method,
       offset_account_id, reference, cost_of_sales_journal_id, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12) returning id::text`,
    [source, idempotencyKey, hash, billId, allocationDate, amount, method, offset.id, reference, costOfSalesJournalId, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  for (const line of lines) {
    await tx.query(
      `insert into landed_cost_allocation_lines (allocation_id, item_code, location_value_id, received_quantity, received_value, share,
         to_stock, to_cost_of_sales, inventory_movement_id)
       values ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9)`,
      [id, line.itemCode, line.locationValueId, line.receivedQuantity, line.receivedValue, line.share, line.toStock, line.toCostOfSales, line.movementId],
    );
  }
  await writeAuditEvent(tx, {
    eventType: "inventory.landed_cost_allocated",
    entityType: "bill",
    entityId: billId,
    details: { allocationId: id, amount, method, offset: offset.code, allocationDate, toCostOfSales: toFixedString(toCostOfSalesTotal, scale) },
  });
  return { created: true, allocation: await getAllocation(tx, id) };
}

/** How many items and locations a bill received stock for: landed cost can be spread over those. */
export async function billStockReceiptCount(tx: OrgTx, billIdInput: unknown): Promise<number> {
  const billId = requireId(billIdInput, "billId");
  const row = await tx.query<{ n: number }>(
    `select count(distinct (item_code, location_value_id))::int as n from inventory_movements
      where source_type = 'bill' and source_id = $1 and movement_type = 'receipt'`,
    [billId],
  );
  return row.rows[0].n;
}

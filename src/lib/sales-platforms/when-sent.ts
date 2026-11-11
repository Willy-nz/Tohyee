import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { writeAuditEvent } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { loadStockContext } from "@/lib/inventory/stock";
import { postMovement } from "@/lib/inventory/movements";
import { type AmountsMode, calculateInvoice } from "@/lib/invoices/amounts";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { add, cmp, dec, type Decimal, isPositive, isZero, mul, mulDiv, neg, sub, sum, toFixedString, toPlainString } from "@/lib/money/decimal";
import type { PlatformOrder } from "@/lib/sales-platforms/connector";
import { writeLog } from "@/lib/sales-platforms/log";
import { type HeldUse, localDate, type PlannedLine, type RefundHeld } from "@/lib/sales-platforms/orders";
import { requireString } from "@/lib/validation";

/*
 * Shopify sales when sent (examples SWS1-SWS9, decision 1569). An order
 * brought in while it's on is still invoiced when it's paid, so its GST is
 * counted then, but the lines that will be sent (and the shipping) are coded
 * to Income in advance, with no item. Each fulfilment then moves what it sent
 * to sales and takes stock items out of stock, on the day it was sent.
 * Refunds of what hasn't been sent come out of Income in advance. A line with
 * nothing left to send has anything left held moved to sales, so Income in
 * advance clears.
 */

const SCALE = 2;
const SOURCE = "sales-platform";

/** One line an order holds, as stored. */
type HeldRow = {
  id: string;
  line_kind: "line" | "shipping";
  line_external_id: string;
  description: string;
  item_code: string | null;
  item_type: string | null;
  income_code: string;
  held_code: string;
  quantity: string;
  amount: string;
  sent_quantity: string;
  refunded_quantity: string;
  recognised_amount: string;
  refunded_amount: string;
  closed: boolean;
};

export type HeldLine = { kind: "line" | "shipping"; externalId: string; description: string; itemId: string | null; incomeAccountCode: string; quantity: string; amount: string };

/**
 * The sales order's lines for an order held until it's sent (SWS1): lines to
 * be sent, and the shipping when anything is, go to `heldAccountCode` with no
 * item; what's held is each such line's net amount and quantity.
 */
export function holdLines(
  lines: readonly PlannedLine[],
  rates: readonly string[],
  amountsMode: AmountsMode,
  heldAccountCode: string,
): { lines: PlannedLine[]; held: HeldLine[] } {
  const anythingSent = lines.some((line) => line.source?.kind === "line" && line.source.requiresShipping);
  const held = new Map<string, HeldLine>();
  const out = lines.map((line, index) => {
    const { source, ...rest } = line;
    const holds = source !== undefined && (source.kind === "line" ? source.requiresShipping : anythingSent);
    if (!holds || !source) return rest;
    const net = calculateInvoice(amountsMode, [{ quantity: line.quantity, unitPrice: line.unitPrice, taxRate: rates[index] ?? "0" }], SCALE).lines[0].netAmount;
    const id = `${source.kind}:${source.externalId}`;
    const was = held.get(id);
    held.set(id, {
      kind: source.kind,
      externalId: source.externalId,
      description: line.description,
      itemId: line.itemId,
      incomeAccountCode: line.accountCode,
      quantity: toPlainString(add(dec(was?.quantity ?? "0"), dec(line.quantity))),
      amount: toFixedString(add(dec(was?.amount ?? "0"), dec(net)), SCALE),
    });
    return { ...rest, accountCode: heldAccountCode, itemId: null };
  });
  return { lines: out, held: [...held.values()] };
}

/** Saves what an order holds (SWS1). */
export async function saveHeld(tx: OrgTx, connectionId: string, orderId: string, heldAccountCode: string, held: readonly HeldLine[]): Promise<void> {
  for (const line of held) {
    await tx.query(
      `insert into sales_platform_held_lines (connection_id, order_external_id, line_kind, line_external_id, description, item_id, income_account_id, held_account_id, quantity, amount)
       values ($1, $2, $3, $4, $5, $6, (select id from accounts where lower(code) = lower($7)), (select id from accounts where lower(code) = lower($8)), $9::numeric, $10::numeric)
       on conflict (connection_id, order_external_id, line_kind, line_external_id) do nothing`,
      [connectionId, orderId, line.kind, line.externalId, line.description.slice(0, 500), line.itemId, line.incomeAccountCode, heldAccountCode, line.quantity, line.amount],
    );
  }
}

async function loadHeld(tx: OrgTx, connectionId: string, orderId: string): Promise<HeldRow[]> {
  const result = await tx.query<HeldRow>(
    `select h.id, h.line_kind, h.line_external_id, h.description, i.code as item_code, i.item_type, income.code as income_code, held.code as held_code,
            h.quantity::text, h.amount::text, h.sent_quantity::text, h.refunded_quantity::text, h.recognised_amount::text, h.refunded_amount::text, h.closed
       from sales_platform_held_lines h
       join accounts income on income.id = h.income_account_id
       join accounts held on held.id = h.held_account_id
       left join items i on i.id = h.item_id
      where h.connection_id = $1 and h.order_external_id = $2
      order by h.id
      for update of h`,
    [connectionId, orderId],
  );
  return result.rows;
}

const left = (row: HeldRow): Decimal => sub(sub(dec(row.quantity), dec(row.sent_quantity)), dec(row.refunded_quantity));
const stillHeld = (row: HeldRow): Decimal => sub(sub(dec(row.amount), dec(row.recognised_amount)), dec(row.refunded_amount));

/** What a refund can take from what's held (SWS5, SWS6), or null when the order holds nothing. */
export async function refundHeld(tx: OrgTx, connectionId: string, orderId: string): Promise<RefundHeld | null> {
  const rows = (await loadHeld(tx, connectionId, orderId)).filter((row) => !row.closed);
  if (rows.length === 0) return null;
  return {
    accountCode: rows[0].held_code,
    lines: new Map(rows.filter((row) => row.line_kind === "line").map((row) => [row.line_external_id, left(row)])),
    shipping: new Set(rows.filter((row) => row.line_kind === "shipping" && isZero(dec(row.sent_quantity))).map((row) => row.line_external_id)),
  };
}

/** Nothing more to come: an order cancelled before it was invoiced holds nothing. */
export async function closeHeld(tx: OrgTx, connectionId: string, orderId: string): Promise<void> {
  await tx.query("update sales_platform_held_lines set closed = true, updated_at = now() where connection_id = $1 and order_external_id = $2", [connectionId, orderId]);
}

/** Orders a sync reads again because they still hold something to be sent. */
export async function ordersHeld(tx: OrgTx, connectionId: string, limit = 25): Promise<string[]> {
  const result = await tx.query<{ order_external_id: string }>(
    `select order_external_id from sales_platform_held_lines where connection_id = $1 and not closed
      group by order_external_id order by min(updated_at) limit $2`,
    [connectionId, limit],
  );
  return result.rows.map((row) => row.order_external_id);
}

type Move = { from: string; to: string; amount: Decimal; description: string };

/** Posts the moves out of Income in advance as one journal (origin sales_when_sent), or nothing when they come to nothing. */
async function postMoves(tx: OrgTx, key: string, date: string, reference: string, description: string, moves: readonly Move[]): Promise<string | null> {
  const lines: Array<{ accountCode: string; debitAmount: string; creditAmount: string; description: string }> = [];
  for (const move of moves) {
    if (isZero(move.amount)) continue;
    const amount = toFixedString(isPositive(move.amount) ? move.amount : neg(move.amount), SCALE);
    const [debit, credit] = isPositive(move.amount) ? [move.from, move.to] : [move.to, move.from];
    lines.push({ accountCode: debit, debitAmount: amount, creditAmount: "0", description: move.description });
    lines.push({ accountCode: credit, debitAmount: "0", creditAmount: amount, description: move.description });
  }
  if (lines.length === 0) return null;
  const posted = await postJournalBody(
    tx,
    SOURCE,
    key,
    parseJournalBody(tx, { postingDate: date, reference: reference.slice(0, 100), description: description.slice(0, 500), lines }, { internal: true }),
    { origin: "sales_when_sent" },
  );
  return posted.journal.id;
}

/** Closes lines with nothing left to send, moving anything still held for them to sales (SWS7). */
function finish(rows: HeldRow[], moves: Move[]): void {
  for (const row of rows) {
    if (row.closed) continue;
    const done = row.line_kind === "shipping" ? isPositive(dec(row.sent_quantity)) || isPositive(dec(row.refunded_quantity)) : !isPositive(left(row));
    if (!done) continue;
    const rest = stillHeld(row);
    if (!isZero(rest)) {
      moves.push({ from: row.held_code, to: row.income_code, amount: rest, description: `${row.description}: what was left held` });
      row.recognised_amount = toFixedString(add(dec(row.recognised_amount), rest), SCALE);
    }
    row.closed = true;
  }
}

async function saveRows(tx: OrgTx, rows: readonly HeldRow[]): Promise<void> {
  for (const row of rows) {
    await tx.query(
      `update sales_platform_held_lines set sent_quantity = $2::numeric, refunded_quantity = $3::numeric, recognised_amount = $4::numeric,
              refunded_amount = $5::numeric, closed = $6, updated_at = now() where id = $1`,
      [row.id, row.sent_quantity, row.refunded_quantity, row.recognised_amount, row.refunded_amount, row.closed],
    );
  }
}

/**
 * After a refund's credit note (SWS5-SWS7): what it took from what's held,
 * at the credit note lines' net amounts, then lines with nothing left to send
 * are closed. Returns the journal that cleared anything left, if any.
 */
export async function takeRefundFromHeld(
  tx: OrgTx,
  input: { connectionId: string; order: PlatformOrder; refundId: string; date: string; key: string; uses: readonly HeldUse[]; lines: readonly PlannedLine[]; rates: ReadonlyArray<string | null>; amountsMode: AmountsMode },
): Promise<void> {
  if (input.uses.length === 0) return;
  const rows = await loadHeld(tx, input.connectionId, input.order.externalId);
  for (const use of input.uses) {
    const row = rows.find((entry) => entry.line_kind === use.kind && entry.line_external_id === use.externalId && !entry.closed);
    if (!row) continue;
    const net = sum(
      use.lineIndexes.map((index) => {
        const line = input.lines[index];
        return dec(calculateInvoice(input.amountsMode, [{ quantity: line.quantity, unitPrice: line.unitPrice, taxRate: input.rates[index] ?? "0" }], SCALE).lines[0].netAmount);
      }),
    );
    row.refunded_amount = toFixedString(add(dec(row.refunded_amount), net), SCALE);
    if (use.kind === "line") row.refunded_quantity = toPlainString(add(dec(row.refunded_quantity), dec(use.quantity)));
    // Shipping refunded in full, before anything's sent: nothing left of it to count.
    else if (!isPositive(stillHeld(row))) row.refunded_quantity = "1";
  }
  const moves: Move[] = [];
  finish(rows, moves);
  await postMoves(tx, input.key, input.date, `${input.order.name} refund`, `${input.order.name}: refunded before it was sent; what was left held`, moves);
  await saveRows(tx, rows);
}

/**
 * Counts lines as sent on `date` (SWS2-SWS4, SWS10): each line's share out
 * of Income in advance to its sales account (null `lines`: everything left),
 * the shipping with the first thing sent, and stock items out of stock.
 * Updates `rows` in place; the caller saves them. Returns the journal.
 */
async function send(
  tx: OrgTx,
  input: { rows: HeldRow[]; lines: ReadonlyArray<{ lineItemId: string; quantity: string }> | null; date: string; orderName: string; reference: string; description: string; key: string },
): Promise<string | null> {
  const { rows, date } = input;
  const wanted =
    input.lines ?? rows.filter((row) => row.line_kind === "line" && !row.closed).map((row) => ({ lineItemId: row.line_external_id, quantity: toPlainString(left(row)) }));
  const moves: Move[] = [];
  const stock: Array<{ itemCode: string; itemType: string; quantity: Decimal; description: string; rowId: string }> = [];
  let anything = false;
  for (const sent of wanted) {
    const row = rows.find((entry) => entry.line_kind === "line" && entry.line_external_id === sent.lineItemId && !entry.closed);
    if (!row) continue;
    const remaining = left(row);
    const want = dec(sent.quantity);
    const quantity = cmp(want, remaining) <= 0 ? want : remaining;
    if (!isPositive(quantity)) continue;
    const share = cmp(quantity, remaining) === 0 ? stillHeld(row) : mulDiv(stillHeld(row), quantity, remaining, SCALE);
    moves.push({ from: row.held_code, to: row.income_code, amount: share, description: `${row.description} sent` });
    row.recognised_amount = toFixedString(add(dec(row.recognised_amount), share), SCALE);
    row.sent_quantity = toPlainString(add(dec(row.sent_quantity), quantity));
    if (row.item_code && (row.item_type === "stock" || row.item_type === "kit")) {
      stock.push({ itemCode: row.item_code, itemType: row.item_type, quantity, description: `${input.orderName}: ${row.description} sent`, rowId: row.id });
    }
    anything = true;
  }
  // The shipping counts with the first thing sent (SWS2), or when the whole order is marked sent (SWS10).
  if (anything || input.lines === null) {
    for (const row of rows) {
      if (row.line_kind !== "shipping" || row.closed || isPositive(dec(row.sent_quantity))) continue;
      const share = stillHeld(row);
      moves.push({ from: row.held_code, to: row.income_code, amount: share, description: row.description });
      row.recognised_amount = toFixedString(add(dec(row.recognised_amount), share), SCALE);
      row.sent_quantity = "1";
    }
  }
  finish(rows, moves);
  const journalId = await postMoves(tx, `${input.key}:journal`, date, input.reference, input.description, moves);
  if (stock.length > 0) {
    const ctx = await loadStockContext(tx, "Stock can't be taken out for what was sent");
    for (const entry of stock) {
      const parts =
        entry.itemType === "kit"
          ? (
              await tx.query<{ code: string; quantity: string }>(
                `select i.code, k.quantity::text from kit_components k join items i on i.id = k.component_item_id join items kit on kit.id = k.kit_item_id
                  where lower(kit.code) = lower($1) and i.item_type = 'stock' order by lower(i.code)`,
                [entry.itemCode],
              )
            ).rows.map((component) => ({ code: component.code, quantity: mul(entry.quantity, dec(component.quantity)) }))
          : [{ code: entry.itemCode, quantity: entry.quantity }];
      for (const part of parts) {
        await postMovement(tx, {
          source: SOURCE,
          idempotencyKey: `${input.key}:stock:${entry.rowId}:${part.code}`.slice(0, 200),
          movementType: "issue",
          movementDate: date,
          itemCode: part.code,
          reference: input.orderName,
          description: entry.description,
          inventoryAccountCode: ctx.inventoryCode,
          offsetAccountCode: ctx.costOfSalesCode,
          quantity: toPlainString(part.quantity),
        });
      }
    }
  }
  return journalId;
}

/**
 * Counts what each fulfilment sent (SWS2-SWS4, SWS8): for each successful
 * fulfilment not yet counted (up to `upTo`, oldest first), a journal moves
 * each sent line's share out of Income in advance to its sales account, and
 * the shipping with the first thing sent; stock items come out of stock.
 * Dated the day it was sent, or the invoice date if that's later.
 */
export async function countSent(
  tx: OrgTx,
  input: { connectionId: string; storeDomain: string; order: PlatformOrder; invoiceDate: string; upTo: string | null },
): Promise<{ counted: number }> {
  const { order } = input;
  if (!order.sent) return { counted: 0 };
  const done = await tx.query<{ fulfilment_external_id: string }>(
    "select fulfilment_external_id from sales_platform_sent where connection_id = $1 and order_external_id = $2",
    [input.connectionId, order.externalId],
  );
  const counted = new Set(done.rows.map((row) => row.fulfilment_external_id));
  const waiting = order.sent
    .filter((f) => f.status === "SUCCESS" && !counted.has(f.externalId))
    .filter((f) => input.upTo === null || (f.createdAt !== null && Date.parse(f.createdAt) <= Date.parse(input.upTo)))
    .sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
  if (waiting.length === 0) return { counted: 0 };
  const rows = await loadHeld(tx, input.connectionId, order.externalId);
  let number = 0;
  for (const fulfilment of waiting) {
    if (fulfilment.incomplete) throw new ValidationError(`a fulfilment sent more lines than Tohyee reads, so what it sent can't be counted yet.`);
    const sentOn = fulfilment.createdAt ? localDate(fulfilment.createdAt) : input.invoiceDate;
    const date = sentOn < input.invoiceDate ? input.invoiceDate : sentOn;
    const journalId = await send(tx, {
      rows,
      lines: fulfilment.lines,
      date,
      orderName: order.name,
      reference: `${order.name} sent`,
      description: `${order.name}: sent on ${sentOn}`,
      key: `sp:${input.storeDomain}:sent:${fulfilment.externalId}`.slice(0, 120),
    });
    await tx.query(
      `insert into sales_platform_sent (connection_id, order_external_id, fulfilment_external_id, sent_on, journal_id) values ($1, $2, $3, $4, $5)`,
      [input.connectionId, order.externalId, fulfilment.externalId, sentOn, journalId],
    );
    number += 1;
  }
  await saveRows(tx, rows);
  return { counted: number };
}


export type HeldOrder = { orderId: string; name: string; invoiceDate: string; held: string; lines: string[] };

/** Orders still holding something to be sent, oldest first (SWS10): for Mark as sent. Only invoiced orders. */
export async function listHeldOrders(tx: OrgTx, connectionId: string): Promise<HeldOrder[]> {
  const result = await tx.query<{ order_external_id: string; name: string | null; invoice_date: string; held: string; lines: string[] }>(
    `select h.order_external_id, d.name, i.invoice_date::text,
            to_char(sum(h.amount - h.recognised_amount - h.refunded_amount), 'FM999999990.00') as held,
            array_agg(h.description order by h.id) as lines
       from sales_platform_held_lines h
       join sales_platform_documents d on d.connection_id = h.connection_id and d.record_kind = 'order' and d.external_id = h.order_external_id
       join sales_invoices i on i.id = d.invoice_id
      where h.connection_id = $1 and not h.closed
      group by h.order_external_id, d.name, i.invoice_date
      order by i.invoice_date, h.order_external_id`,
    [connectionId],
  );
  return result.rows.map((row) => ({ orderId: row.order_external_id, name: row.name ?? row.order_external_id, invoiceDate: row.invoice_date, held: row.held, lines: row.lines }));
}

/**
 * Mark as sent (SWS10, decision 1570): for an order Shopify never marked
 * fulfilled, everything it still holds counts as sent on `sentOn`, as a
 * fulfilment would, with who did it in the sync log and audit trail.
 */
export async function markHeldOrderSent(tx: OrgTx, connectionId: string, orderIdInput: unknown, sentOnInput: unknown): Promise<HeldOrder> {
  const orderId = requireString(orderIdInput, "orderId", { maxLength: 100 });
  const sentOn = parseIsoDate(sentOnInput, "sentOn");
  const found = await tx.query<{ name: string | null; invoice_date: string | null; store_domain: string }>(
    `select d.name, i.invoice_date::text, d.store_domain
       from sales_platform_documents d left join sales_invoices i on i.id = d.invoice_id
      where d.connection_id = $1 and d.record_kind = 'order' and d.external_id = $2 for update of d`,
    [connectionId, orderId],
  );
  const doc = found.rows[0];
  if (!doc) throw new NotFoundError("That order isn't in Tohyee.");
  const name = doc.name ?? orderId;
  if (!doc.invoice_date) throw new ValidationError(`${name} isn't invoiced yet (it isn't paid), so it can't be marked as sent.`);
  if (sentOn < doc.invoice_date) throw new ValidationError(`The day it was sent can't be before its invoice (${formatDate(doc.invoice_date)}).`);
  const rows = await loadHeld(tx, connectionId, orderId);
  const open = rows.filter((row) => !row.closed);
  if (open.length === 0) throw new ConflictError(`${name} has nothing left to send.`);
  const held = toFixedString(sum(open.map(stillHeld)), SCALE);
  const lines = open.map((row) => row.description);
  const journalId = await send(tx, {
    rows,
    lines: null,
    date: sentOn,
    orderName: name,
    reference: `${name} marked sent`,
    description: `${name}: marked as sent on ${sentOn} in Tohyee`,
    key: `sp:${doc.store_domain}:marked-sent:${orderId}`.slice(0, 120),
  });
  await saveRows(tx, rows);
  await tx.query(
    `insert into sales_platform_sent (connection_id, order_external_id, fulfilment_external_id, sent_on, journal_id) values ($1, $2, $3, $4, $5)`,
    [connectionId, orderId, `marked:${orderId}`, sentOn, journalId],
  );
  const who = tx.actor.email ?? "someone";
  await writeLog(tx, connectionId, {
    source: "connection",
    action: "posted",
    recordKind: "order",
    externalId: orderId,
    message: `${name} marked as sent on ${formatDate(sentOn)} by ${who}: ${held} moved from Income in advance to sales (${lines.join(", ")}).`,
  });
  await writeAuditEvent(tx, {
    eventType: "sales_platform.order_marked_sent",
    entityType: "sales_platform_connection",
    entityId: connectionId,
    details: { orderId, name, sentOn, held, journalId },
  });
  return { orderId, name, invoiceDate: doc.invoice_date, held, lines };
}

/**
 * Sales when sent for an order invoiced without it (SWS12-SWS14, decision
 * 1583): an order whose sales order was made before Sales when sent was
 * turned on, or one chosen with "Apply to orders already invoiced". Nothing
 * on the invoice changes (it may be paid and in a payout already). One
 * journal on the invoice's date moves what's still to be sent from sales to
 * Income in advance: each line's unsent share, and the shipping when nothing
 * has been sent yet. What Shopify had already sent stays in sales and isn't
 * counted again. The stock already came off with the invoice, so the held
 * lines move none when they're sent. Returns the journal, or null when
 * everything has been sent.
 */
export async function holdAfterInvoicing(
  tx: OrgTx,
  input: {
    connectionId: string;
    order: PlatformOrder;
    invoiceDate: string;
    invoiceNumber: string;
    heldAccountCode: string;
    lines: readonly PlannedLine[];
    rates: readonly string[];
    amountsMode: AmountsMode;
    key: string;
  },
): Promise<{ journalId: string; held: string } | null> {
  const { order } = input;
  const sentFulfilments = (order.sent ?? []).filter((fulfilment) => fulfilment.status === "SUCCESS");
  const sentOf = new Map<string, Decimal>();
  for (const fulfilment of sentFulfilments) {
    if (fulfilment.incomplete) throw new ValidationError("a fulfilment sent more lines than Tohyee reads, so what's still to send can't be worked out yet.");
    for (const line of fulfilment.lines) sentOf.set(line.lineItemId, add(sentOf.get(line.lineItemId) ?? dec("0"), dec(line.quantity)));
  }
  const anythingSent = sentFulfilments.some((fulfilment) => fulfilment.lines.length > 0);
  const { held } = holdLines(input.lines, input.rates, input.amountsMode, input.heldAccountCode);
  const keep: HeldLine[] = [];
  for (const line of held) {
    if (line.kind === "shipping") {
      if (!anythingSent) keep.push({ ...line, itemId: null });
      continue;
    }
    const quantity = dec(line.quantity);
    const unsent = sub(quantity, sentOf.get(line.externalId) ?? dec("0"));
    if (!isPositive(unsent)) continue;
    const amount = cmp(unsent, quantity) >= 0 ? dec(line.amount) : mulDiv(dec(line.amount), unsent, quantity, SCALE);
    keep.push({ ...line, itemId: null, quantity: toPlainString(cmp(unsent, quantity) >= 0 ? quantity : unsent), amount: toFixedString(amount, SCALE) });
  }
  if (keep.length === 0) return null;
  const moves: Move[] = keep.map((line) => ({ from: line.incomeAccountCode, to: input.heldAccountCode, amount: dec(line.amount), description: `${line.description}: to be sent` }));
  const journalId = await postMoves(
    tx,
    `${input.key}:journal`,
    input.invoiceDate,
    order.name,
    `Held until sent: ${order.name} (invoice ${input.invoiceNumber}), invoiced before Sales when sent applied to it`,
    moves,
  );
  if (!journalId) return null;
  await saveHeld(tx, input.connectionId, order.externalId, input.heldAccountCode, keep);
  // What had been sent already stays in sales: those fulfilments aren't counted again.
  for (const fulfilment of sentFulfilments) {
    await tx.query(
      `insert into sales_platform_sent (connection_id, order_external_id, fulfilment_external_id, sent_on, journal_id)
       values ($1, $2, $3, $4, null) on conflict (connection_id, fulfilment_external_id) do nothing`,
      [input.connectionId, order.externalId, fulfilment.externalId, fulfilment.createdAt ? localDate(fulfilment.createdAt) : input.invoiceDate],
    );
  }
  return { journalId, held: toFixedString(sum(keep.map((line) => dec(line.amount))), SCALE) };
}

import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { requestHash } from "@/lib/idempotency";
import { applyMovement, type CostingInput, type CostingResult } from "@/lib/inventory/costing";
import { controlAccountCode, type ControlAccount } from "@/lib/invoices/service";
import type { ItemType } from "@/lib/items/pricing";
import { currencyMinorUnits } from "@/lib/money/currency";
import { abs, add, cmp, dec, type Decimal, isNegative, isPositive, isZero, mul, neg, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { trackingKey, type TrackingTags } from "@/lib/tracking/service";

/**
 * Stock tracking (examples ST1-ST12): stock items on bills, invoices and
 * credit notes move stock in the same transaction as the document's journal,
 * costed at weighted average per item and location (`./costing`).
 *
 * - A location is a value of the Location tracking category, taken from the
 *   line's Location tag. Once the Location category has any values, stock
 *   lines need one (checked when approving); until then each item has one
 *   default pool (ST3).
 * - The document's journal gets the cost of sales lines: whatever the
 *   inventory account must still move so it equals the stock's value, with
 *   cost of goods sold on the other side (ST2, ST5, ST10).
 * - Voids: an invoice's or supplier credit note's stock comes back at the
 *   value it went out at (ST4). A bill's or sales credit note's stock goes
 *   back out exactly, which needs it to be the latest movement for that item
 *   and location; otherwise the void is refused.
 */

export const INVENTORY_ACCOUNT: ControlAccount = { systemKey: "inventory", label: "inventory", accountClass: "asset" };
export const COST_OF_SALES_ACCOUNT: ControlAccount = { systemKey: "cost_of_goods_sold", label: "cost of goods sold", accountClass: "expense" };

export type StockContext = {
  inventoryCode: string;
  inventoryAccountId: string;
  costOfSalesCode: string;
  costOfSalesAccountId: string;
  allowNegative: boolean;
  locationCategoryId: string | null;
  /** Whether the Location category has any values; then stock lines need one (ST3). */
  locationsInUse: boolean;
  locationNames: Map<string, string>;
  scale: number;
};

export async function loadStockContext(tx: OrgTx, refused: string): Promise<StockContext> {
  const inventoryCode = await controlAccountCode(tx, INVENTORY_ACCOUNT, refused);
  const costOfSalesCode = await controlAccountCode(tx, COST_OF_SALES_ACCOUNT, refused);
  const ids = await tx.query<{ id: string; system_key: string }>(
    "select id, system_key from accounts where system_key in ('inventory', 'cost_of_goods_sold')",
  );
  const settings = await tx.query<{ allow_negative_stock: boolean }>("select allow_negative_stock from organisation_settings where id = true");
  const category = await tx.query<{ id: string }>("select id from tracking_categories where kind = 'location'");
  const locationCategoryId = category.rows[0]?.id ?? null;
  const values = locationCategoryId
    ? await tx.query<{ id: string; name: string }>("select id, name from tracking_values where category_id = $1", [locationCategoryId])
    : { rows: [] as Array<{ id: string; name: string }> };
  return {
    inventoryCode,
    inventoryAccountId: ids.rows.find((row) => row.system_key === "inventory")!.id,
    costOfSalesCode,
    costOfSalesAccountId: ids.rows.find((row) => row.system_key === "cost_of_goods_sold")!.id,
    allowNegative: settings.rows[0]?.allow_negative_stock === true,
    locationCategoryId,
    locationsInUse: values.rows.length > 0,
    locationNames: new Map(values.rows.map((row) => [row.id, row.name])),
    scale: currencyMinorUnits(tx.baseCurrency),
  };
}

/** The line's location for stock: its Location tag, required once locations are in use (ST3). */
export function stockLocation(ctx: StockContext, tags: TrackingTags, label: string, itemCode: string): string | null {
  if (!ctx.locationsInUse) return null;
  const value = ctx.locationCategoryId ? tags[ctx.locationCategoryId] : undefined;
  if (!value) {
    throw new ValidationError(`${label}: ${itemCode} is a stock item, so it needs a Location (stock is kept by location).`);
  }
  return value;
}

function placeLabel(ctx: StockContext, itemCode: string, location: string | null): string {
  return location ? `${itemCode} at ${ctx.locationNames.get(location) ?? `location #${location}`}` : itemCode;
}

type BalanceState = { quantity: string; value: string; lastDate: string | null };

export type MovementRow = {
  id: string;
  movement_type: string;
  movement_date: string;
  item_code: string;
  item_id: string | null;
  location_value_id: string | null;
  quantity_delta: string;
  value_delta: string;
  cost_adjustment: string;
  unit_cost: string | null;
  original_movement_id: string | null;
  idempotency_key: string;
};

const MOVEMENT_COLUMNS = `id, movement_type, movement_date, item_code, item_id, location_value_id, quantity_delta::text,
  value_delta::text, cost_adjustment::text, unit_cost::text, original_movement_id, idempotency_key`;

type Planned = {
  key: string;
  movementType: "receipt" | "issue" | "customer_return" | "supplier_return" | "reversal";
  itemId: string | null;
  itemCode: string;
  location: string | null;
  result: CostingResult;
  offsetAccountId: string;
  originalMovementId: string | null;
  reversalOf: string | null;
  /** Which document line it's for, to tag the cost of sales line. */
  lineIndex: number;
};

export type DocumentSource =
  | "invoice"
  | "invoice_void"
  | "bill"
  | "bill_void"
  | "credit_note"
  | "credit_note_void"
  | "supplier_credit_note"
  | "supplier_credit_note_void";

/**
 * Plans a document's stock movements against locked balances, then records
 * them once its journal is posted. Movements for the same item and location
 * in one document follow on from each other.
 */
export class StockPlanner {
  readonly planned: Planned[] = [];
  private readonly balances = new Map<string, BalanceState>();

  constructor(
    private readonly tx: OrgTx,
    readonly ctx: StockContext,
    private readonly date: string,
    private readonly source: { type: DocumentSource; id: string; reference: string },
  ) {}

  private balanceKey(itemCode: string, location: string | null): string {
    return `${itemCode}|${location ?? ""}`;
  }

  private async balance(itemCode: string, location: string | null): Promise<BalanceState> {
    const key = this.balanceKey(itemCode, location);
    const cached = this.balances.get(key);
    if (cached) return cached;
    await this.tx.query(
      `insert into inventory_item_balances (item_code, location_value_id) values ($1, $2)
       on conflict on constraint inventory_item_balances_key do nothing`,
      [itemCode, location],
    );
    const found = await this.tx.query<{ on_hand_quantity: string; carrying_value: string; last_movement_date: string | null }>(
      `select on_hand_quantity::text, carrying_value::text, last_movement_date from inventory_item_balances
        where item_code = $1 and location_value_id is not distinct from $2 for update`,
      [itemCode, location],
    );
    const row = found.rows[0];
    const state = { quantity: row.on_hand_quantity, value: row.carrying_value, lastDate: row.last_movement_date };
    this.balances.set(key, state);
    return state;
  }

  /** The unit cost for stock going out with none on hand (ST11): the last cost it came in at here, else the item's purchase price. */
  private async fallbackCost(itemId: string | null, itemCode: string, location: string | null): Promise<string | null> {
    const last = await this.tx.query<{ unit_cost: string }>(
      `select unit_cost::text from inventory_movements
        where item_code = $1 and location_value_id is not distinct from $2 and quantity_delta > 0 and unit_cost is not null
        order by id desc limit 1`,
      [itemCode, location],
    );
    if (last.rows[0]) return last.rows[0].unit_cost;
    if (!itemId) return null;
    const item = await this.tx.query<{ purchase_price: string | null }>("select purchase_price::text from items where id = $1", [itemId]);
    return item.rows[0]?.purchase_price ?? null;
  }

  private async apply(
    entry: Omit<Planned, "result" | "offsetAccountId"> & { offsetAccountId?: string },
    input: CostingInput,
    label: string,
  ): Promise<CostingResult> {
    const state = await this.balance(entry.itemCode, entry.location);
    const place = placeLabel(this.ctx, entry.itemCode, entry.location);
    if (state.lastDate && this.date < state.lastDate) {
      throw new ValidationError(
        `${label}: ${place} already has stock movements dated ${state.lastDate}. Backdated stock movements aren't supported yet, because every later sale would need re-costing. Use ${state.lastDate} or later.`,
      );
    }
    let fallbackUnitCost: string | null = null;
    if (this.ctx.allowNegative && isZero(dec(state.quantity)) && (input.type === "issue" || input.type === "supplier_return")) {
      fallbackUnitCost = await this.fallbackCost(entry.itemId, entry.itemCode, entry.location);
    }
    let result: CostingResult;
    try {
      result = applyMovement({ quantity: state.quantity, value: state.value }, input, this.ctx.scale, {
        allowNegative: this.ctx.allowNegative,
        fallbackUnitCost,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        const turnOn = !this.ctx.allowNegative && /negative|no stock on hand/i.test(error.message) ? " (Negative stock is off in Settings.)" : "";
        throw new ValidationError(`${label}: ${place}: ${error.message}${turnOn}`);
      }
      throw error;
    }
    state.quantity = result.quantityAfter;
    state.value = result.valueAfter;
    state.lastDate = this.date;
    this.planned.push({ ...entry, offsetAccountId: entry.offsetAccountId ?? this.ctx.costOfSalesAccountId, result });
    return result;
  }

  async issue(line: StockLine, quantity: string, key: string, label: string): Promise<void> {
    await this.apply(
      { key, movementType: "issue", itemId: line.itemId, itemCode: line.itemCode, location: line.location, originalMovementId: null, reversalOf: null, lineIndex: line.lineIndex },
      { type: "issue", quantity },
      label,
    );
  }

  async supplierReturn(line: StockLine, quantity: string, key: string, label: string, offsetAccountId: string): Promise<void> {
    await this.apply(
      { key, movementType: "supplier_return", itemId: line.itemId, itemCode: line.itemCode, location: line.location, originalMovementId: null, reversalOf: null, lineIndex: line.lineIndex, offsetAccountId },
      { type: "supplier_return", quantity },
      label,
    );
  }

  async receipt(line: StockLine, quantity: string, value: string, key: string, label: string, offsetAccountId: string): Promise<void> {
    await this.apply(
      { key, movementType: "receipt", itemId: line.itemId, itemCode: line.itemCode, location: line.location, originalMovementId: null, reversalOf: null, lineIndex: line.lineIndex, offsetAccountId },
      { type: "receipt", quantity, value },
      label,
    );
  }

  /** Restocks part of an earlier sale at that sale's cost (ST5, W8, W9). */
  async customerReturn(line: StockLine, quantity: string, original: MovementRow, returned: { quantity: string; value: string }, key: string, label: string): Promise<CostingResult> {
    return this.apply(
      { key, movementType: "customer_return", itemId: line.itemId, itemCode: line.itemCode, location: line.location, originalMovementId: original.id, reversalOf: null, lineIndex: line.lineIndex },
      {
        type: "customer_return",
        quantity,
        original: {
          quantity: toPlainString(abs(dec(original.quantity_delta))),
          value: toPlainString(abs(dec(original.value_delta))),
          returnedQuantity: returned.quantity,
          returnedValue: returned.value,
        },
      },
      label,
    );
  }

  /**
   * Undoes an earlier movement for a void. Stock that went out comes back at
   * the value it went out at (ST4). Stock that came in goes back out exactly,
   * which needs it to be the latest movement there.
   */
  async undo(original: MovementRow, lineIndex: number, label: string): Promise<void> {
    const base = {
      key: `${original.idempotency_key}:void`,
      movementType: "reversal" as const,
      itemId: original.item_id,
      itemCode: original.item_code,
      location: original.location_value_id,
      // A reversed customer return gives the sale back its returnable quantity.
      originalMovementId: original.movement_type === "customer_return" ? original.original_movement_id : null,
      reversalOf: original.id,
      lineIndex,
    };
    const quantity = dec(original.quantity_delta);
    if (isNegative(quantity)) {
      await this.apply(base, { type: "receipt", quantity: toPlainString(neg(quantity)), value: toPlainString(neg(dec(original.value_delta))) }, label);
      return;
    }
    // The document's own later movements (another line for the same item) are being undone too.
    const later = await this.tx.query<{ id: string; movement_date: string }>(
      `select id, movement_date from inventory_movements
        where item_code = $1 and location_value_id is not distinct from $2 and id > $3
          and not (source_id = $4 and source_type in ($5, $6))
        order by id limit 1`,
      [original.item_code, original.location_value_id, original.id, this.source.id, this.source.type, this.source.type.replace(/_void$/, "")],
    );
    if (later.rows[0]) {
      throw new ConflictError(
        `${label}: ${placeLabel(this.ctx, original.item_code, original.location_value_id)} has moved since (on ${later.rows[0].movement_date}), so this can't be voided without re-costing later movements, which isn't supported yet.`,
      );
    }
    await this.apply(
      base,
      { type: "reversal", quantityDelta: original.quantity_delta, valueDelta: original.value_delta, costAdjustment: original.cost_adjustment },
      label,
    );
  }

  /** Records the planned movements against the posted journal and saves the balances. */
  async record(journalId: string): Promise<void> {
    for (const entry of this.planned) {
      const commandSource = `stock:${this.source.type}`;
      const key = `${this.source.id}:${entry.key}`;
      await this.tx.query(
        `insert into inventory_movements (
           command_source, idempotency_key, request_hash, movement_type, movement_date, item_code, item_id, location_value_id,
           quantity_delta, unit_cost, value_delta, cost_adjustment, quantity_after, value_after, reference, description,
           inventory_account_id, offset_account_id, original_movement_id, reversal_of_movement_id, ledger_journal_id,
           source_type, source_id, created_by_user_id, created_by_email
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric,
                   $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
        [
          commandSource,
          key,
          requestHash("stock_movement", { commandSource, key }),
          entry.movementType,
          this.date,
          entry.itemCode,
          entry.itemId,
          entry.location,
          entry.result.quantityDelta,
          entry.result.unitCost,
          toFixedString(dec(entry.result.valueDelta), this.ctx.scale),
          toFixedString(dec(entry.result.costAdjustment), this.ctx.scale),
          entry.result.quantityAfter,
          toFixedString(dec(entry.result.valueAfter), this.ctx.scale),
          this.source.reference.slice(0, 100),
          `${entry.itemCode} ${entry.result.quantityDelta}`,
          this.ctx.inventoryAccountId,
          entry.offsetAccountId,
          entry.originalMovementId,
          entry.reversalOf,
          journalId,
          this.source.type,
          this.source.id,
          this.tx.actor.userId,
          this.tx.actor.email,
        ],
      );
    }
    for (const [key, state] of this.balances) {
      const [itemCode, location] = key.split("|");
      await this.tx.query(
        `update inventory_item_balances
            set on_hand_quantity = $3::numeric, carrying_value = $4::numeric, last_movement_date = $5, updated_at = now()
          where item_code = $1 and location_value_id is not distinct from $2`,
        [itemCode, location === "" ? null : location, state.quantity, toFixedString(dec(state.value), this.ctx.scale), state.lastDate],
      );
    }
  }

  /**
   * The journal lines that bring the inventory account to the stock's new
   * value, with cost of goods sold on the other side, tagged like the
   * document line they're for. `alreadyMoved` is what the document's own
   * lines already move the inventory account by, per line (a bill's stock
   * line, ST1).
   */
  journalLines(tagsOf: (lineIndex: number) => TrackingTags, alreadyMoved: (lineIndex: number) => Decimal = () => ZERO_DECIMAL, description: string) {
    const perLine = new Map<number, Decimal>();
    for (const entry of this.planned) {
      perLine.set(entry.lineIndex, add(perLine.get(entry.lineIndex) ?? ZERO_DECIMAL, dec(entry.result.valueDelta)));
    }
    const cost = new Map<string, { tracking: TrackingTags; amount: Decimal }>();
    for (const [lineIndex, stockChange] of perLine) {
      // Inventory must still move by this; positive means Dr inventory / Cr cost of sales.
      const extra = sub(stockChange, alreadyMoved(lineIndex));
      if (isZero(extra)) continue;
      const tracking = tagsOf(lineIndex);
      const groupKey = trackingKey(tracking);
      const group = cost.get(groupKey) ?? { tracking, amount: ZERO_DECIMAL };
      group.amount = add(group.amount, extra);
      cost.set(groupKey, group);
    }
    return stockJournalLines(this.ctx, [...cost.values()], description);
  }
}

/** Debits then credits: cost of sales tagged per line, inventory untagged, one line per direction. */
export function stockJournalLines(
  ctx: StockContext,
  groups: Array<{ tracking: TrackingTags; amount: Decimal }>,
  description: string,
): Array<{ accountCode: string; debitAmount: string; creditAmount: string; description: string; tracking?: TrackingTags }> {
  const money = (value: Decimal) => toFixedString(value, ctx.scale);
  let inventoryUp = ZERO_DECIMAL;
  let inventoryDown = ZERO_DECIMAL;
  const debits: ReturnType<typeof stockJournalLines> = [];
  const credits: ReturnType<typeof stockJournalLines> = [];
  for (const group of groups) {
    if (isZero(group.amount)) continue;
    if (isNegative(group.amount)) {
      inventoryDown = add(inventoryDown, neg(group.amount));
      debits.push({ accountCode: ctx.costOfSalesCode, debitAmount: money(neg(group.amount)), creditAmount: "0", description, tracking: group.tracking });
    } else {
      inventoryUp = add(inventoryUp, group.amount);
      credits.push({ accountCode: ctx.costOfSalesCode, debitAmount: "0", creditAmount: money(group.amount), description, tracking: group.tracking });
    }
  }
  if (!isZero(inventoryUp)) debits.push({ accountCode: ctx.inventoryCode, debitAmount: money(inventoryUp), creditAmount: "0", description });
  if (!isZero(inventoryDown)) credits.push({ accountCode: ctx.inventoryCode, debitAmount: "0", creditAmount: money(inventoryDown), description });
  return [...debits, ...credits];
}

// ---------------------------------------------------------------------------
// Document lines

export type StockLine = {
  lineIndex: number;
  itemId: string;
  itemCode: string;
  location: string | null;
};

type DocumentLine = {
  itemId: string | null;
  itemType: ItemType | null;
  itemCode: string | null;
  baseQuantity: string | null;
  tracking: TrackingTags;
};

/**
 * The stock a document's lines move (ST6-ST8): a stock item moves its base
 * quantity (ST7), a kit moves each stock item in it (ST8), and services and
 * non-stock items move nothing (ST6).
 */
export async function stockParts(
  tx: OrgTx,
  ctx: StockContext,
  lines: readonly DocumentLine[],
): Promise<Array<{ line: StockLine; quantity: string; key: string; label: string }>> {
  const kitIds = [...new Set(lines.flatMap((line) => (line.itemType === "kit" && line.itemId ? [line.itemId] : [])))];
  const components = kitIds.length
    ? await tx.query<{ kit_item_id: string; id: string; code: string; item_type: ItemType; quantity: string }>(
        `select k.kit_item_id, i.id, i.code, i.item_type, k.quantity::text from kit_components k join items i on i.id = k.component_item_id
          where k.kit_item_id = any($1::bigint[]) order by k.kit_item_id, lower(i.code)`,
        [kitIds],
      )
    : { rows: [] };
  const parts: Array<{ line: StockLine; quantity: string; key: string; label: string }> = [];
  lines.forEach((line, lineIndex) => {
    const label = `Line ${lineIndex + 1}`;
    if (!line.itemId || !line.itemCode || line.baseQuantity === null) return;
    if (line.itemType === "stock") {
      const location = stockLocation(ctx, line.tracking, label, line.itemCode);
      parts.push({ line: { lineIndex, itemId: line.itemId, itemCode: line.itemCode, location }, quantity: line.baseQuantity, key: `L${lineIndex + 1}`, label });
    } else if (line.itemType === "kit") {
      const stockComponents = components.rows.filter((component) => component.kit_item_id === line.itemId && component.item_type === "stock");
      if (stockComponents.length === 0) return;
      const location = stockLocation(ctx, line.tracking, label, line.itemCode);
      for (const component of stockComponents) {
        parts.push({
          line: { lineIndex, itemId: component.id, itemCode: component.code, location },
          quantity: toPlainString(mul(dec(line.baseQuantity), dec(component.quantity))),
          key: `L${lineIndex + 1}:${component.id}`,
          label,
        });
      }
    }
  });
  return parts;
}

/** A document's own movements, oldest first. */
export async function documentMovements(tx: OrgTx, source: DocumentSource, id: string): Promise<MovementRow[]> {
  const result = await tx.query<MovementRow>(
    `select ${MOVEMENT_COLUMNS} from inventory_movements where source_type = $1 and source_id = $2 order by id`,
    [source, id],
  );
  return result.rows;
}

/** Which document line a document movement was for, from its key ("<doc>:L2..."). */
export function movementLineIndex(movement: MovementRow): number {
  const match = /:L(\d+)/.exec(movement.idempotency_key);
  return match ? Number(match[1]) - 1 : 0;
}

/** How much of each sale has been returned (net of voided returns), by movement id. */
export async function returnedSoFar(tx: OrgTx, movementIds: readonly string[]): Promise<Map<string, { quantity: string; value: string }>> {
  if (movementIds.length === 0) return new Map();
  const result = await tx.query<{ original_movement_id: string; quantity: string; value: string }>(
    `select original_movement_id, coalesce(sum(quantity_delta), 0)::text as quantity,
            coalesce(sum(value_delta + cost_adjustment), 0)::text as value
       from inventory_movements where original_movement_id = any($1::bigint[]) group by original_movement_id`,
    [movementIds],
  );
  return new Map(result.rows.map((row) => [row.original_movement_id, { quantity: row.quantity, value: row.value }]));
}

/** Plans undoing a document's movements for its void, newest first; returns the extra journal lines. */
export async function planVoid(planner: StockPlanner, movements: readonly MovementRow[], tagsOf: (lineIndex: number) => TrackingTags, description: string) {
  for (const movement of [...movements].reverse()) {
    const lineIndex = movementLineIndex(movement);
    await planner.undo(movement, lineIndex, `Line ${lineIndex + 1}`);
  }
  // The void journal already reverses the original journal, which moved the
  // inventory account by what the movements moved the stock; any difference
  // (restocking into negative stock, ST10) goes to cost of sales.
  const originalByLine = new Map<number, Decimal>();
  for (const movement of movements) {
    const lineIndex = movementLineIndex(movement);
    originalByLine.set(lineIndex, add(originalByLine.get(lineIndex) ?? ZERO_DECIMAL, dec(movement.value_delta)));
  }
  return planner.journalLines(tagsOf, (lineIndex) => neg(originalByLine.get(lineIndex) ?? ZERO_DECIMAL), description);
}


// ---------------------------------------------------------------------------
// What each document does (ST1-ST8)

export type DocumentKind = "invoice" | "bill" | "credit_note" | "supplier_credit_note";

export type StockDocumentLine = DocumentLine & { netAmount: string };

export type StockPlan = {
  planner: StockPlanner;
  journalLines: ReturnType<typeof stockJournalLines>;
};

const REFUSED: Record<DocumentKind, string> = {
  invoice: "invoices with stock items can't be approved",
  bill: "bills with stock items can't be approved",
  credit_note: "credit notes with stock items can't be approved",
  supplier_credit_note: "supplier credit notes with stock items can't be approved",
};

function movesStock(lines: readonly DocumentLine[]): boolean {
  return lines.some((line) => line.itemType === "stock" || line.itemType === "kit");
}

async function payableAccountId(tx: OrgTx): Promise<string> {
  const found = await tx.query<{ id: string }>("select id from accounts where system_key = 'accounts_payable'");
  if (!found.rows[0]) throw new ValidationError("No account is set up as accounts payable.");
  return found.rows[0].id;
}

/**
 * Plans the stock a document moves when it's approved, and the cost of sales
 * lines for its journal; null when it has no stock items (ST6).
 *
 * - Invoice (ST2, ST3, ST7-ST11): stock goes out at the location's average.
 * - Bill (ST1, ST10): stock comes in at the line's net amount, which the
 *   bill already debits to inventory; coming into negative stock, the
 *   difference goes to cost of sales.
 * - Credit note (ST5): stock comes back at the cost of the sale it came from,
 *   on the invoice the credit note returns (`returnInvoiceId`).
 * - Supplier credit note: stock goes back out at the location's average (the
 *   supplier_return costing); the line's net amount is credited to inventory
 *   by the document, and any difference goes to cost of sales.
 */
export async function planDocumentStock(
  tx: OrgTx,
  kind: DocumentKind,
  doc: { id: string; date: string; reference: string; contactId: string; returnInvoiceId?: string | null },
  lines: readonly StockDocumentLine[],
  description: string,
): Promise<StockPlan | null> {
  if (!movesStock(lines)) return null;
  const ctx = await loadStockContext(tx, REFUSED[kind]);
  const planner = new StockPlanner(tx, ctx, doc.date, { type: kind, id: doc.id, reference: doc.reference });
  const parts = await stockParts(tx, ctx, lines);
  if (parts.length === 0) return null;
  const tagsOf = (lineIndex: number) => lines[lineIndex].tracking;
  const net = (lineIndex: number) => dec(lines[lineIndex].netAmount);

  switch (kind) {
    case "invoice": {
      for (const part of parts) await planner.issue(part.line, part.quantity, part.key, part.label);
      return { planner, journalLines: planner.journalLines(tagsOf, undefined, description) };
    }
    case "bill": {
      const payable = await payableAccountId(tx);
      for (const part of parts) await planner.receipt(part.line, part.quantity, lines[part.line.lineIndex].netAmount, part.key, part.label, payable);
      return { planner, journalLines: planner.journalLines(tagsOf, net, description) };
    }
    case "supplier_credit_note": {
      const payable = await payableAccountId(tx);
      for (const part of parts) await planner.supplierReturn(part.line, part.quantity, part.key, part.label, payable);
      return { planner, journalLines: planner.journalLines(tagsOf, (lineIndex) => neg(net(lineIndex)), description) };
    }
    case "credit_note": {
      const sales = await returnableSales(tx, doc, parts[0].label);
      const used = await returnedSoFar(tx, sales.map((sale) => sale.id));
      for (const part of parts) {
        let remaining = dec(part.quantity);
        for (const sale of sales) {
          if (isZero(remaining)) break;
          if (sale.item_code !== part.line.itemCode || sale.location_value_id !== part.line.location) continue;
          const so = used.get(sale.id) ?? { quantity: "0", value: "0" };
          const available = sub(abs(dec(sale.quantity_delta)), dec(so.quantity));
          if (!isPositive(available)) continue;
          const take = cmp(remaining, available) <= 0 ? remaining : available;
          const result = await planner.customerReturn(part.line, toPlainString(take), sale, so, `${part.key}:S${sale.id}`, part.label);
          used.set(sale.id, {
            quantity: toPlainString(add(dec(so.quantity), take)),
            value: toPlainString(add(dec(so.value), add(dec(result.valueDelta), dec(result.costAdjustment)))),
          });
          remaining = sub(remaining, take);
        }
        if (isPositive(remaining)) {
          throw new ValidationError(
            `${part.label}: ${toPlainString(sub(dec(part.quantity), remaining))} of ${placeLabel(ctx, part.line.itemCode, part.line.location)} can still be returned from that invoice, not ${part.quantity}.`,
          );
        }
      }
      return { planner, journalLines: planner.journalLines(tagsOf, undefined, description) };
    }
  }
}

/** The approved invoice a credit note returns stock from, and its sales (ST5). */
async function returnableSales(
  tx: OrgTx,
  doc: { contactId: string; returnInvoiceId?: string | null },
  label: string,
): Promise<MovementRow[]> {
  if (!doc.returnInvoiceId) {
    throw new ValidationError(
      `${label} returns a stock item, so the credit note needs the invoice it was sold on (the stock goes back at that sale's cost). Choose it under "Stock returned from", or use a line without the item for a price adjustment.`,
    );
  }
  const invoice = await tx.query<{ status: string; contact_id: string; invoice_number: string | null }>(
    "select status, contact_id, invoice_number from sales_invoices where id = $1",
    [doc.returnInvoiceId],
  );
  const row = invoice.rows[0];
  if (!row || row.contact_id !== doc.contactId) throw new ValidationError("The invoice stock is returned from must be one of this customer's.");
  if (row.status !== "approved") throw new ValidationError(`Invoice ${row.invoice_number ?? `#${doc.returnInvoiceId}`} is ${row.status}, so no stock can be returned from it.`);
  return (await documentMovements(tx, "invoice", doc.returnInvoiceId)).filter((movement) => movement.movement_type === "issue");
}

/**
 * Plans undoing a document's stock when it's voided, and the extra journal
 * lines beyond the reversal of its journal (ST4); null when it moved none.
 */
export async function planDocumentVoid(
  tx: OrgTx,
  kind: DocumentKind,
  doc: { id: string; date: string; reference: string },
  tagsOf: (lineIndex: number) => TrackingTags,
  description: string,
): Promise<StockPlan | null> {
  const movements = await documentMovements(tx, kind, doc.id);
  if (movements.length === 0) return null;
  if (kind === "invoice") {
    // Stock a credit note returned from this invoice would otherwise come back twice.
    const returned = await returnedSoFar(tx, movements.map((movement) => movement.id));
    if ([...returned.values()].some((entry) => isPositive(dec(entry.quantity)))) {
      throw new ConflictError("Some of this invoice's stock has been returned on a credit note. Void that credit note first.");
    }
  }
  const ctx = await loadStockContext(tx, `${kind.replace(/_/g, " ")}s with stock can't be voided`);
  const planner = new StockPlanner(tx, ctx, doc.date, { type: `${kind}_void` as DocumentSource, id: doc.id, reference: doc.reference });
  const journalLines = await planVoid(planner, movements, tagsOf, description);
  return { planner, journalLines };
}

/**
 * Bill and supplier credit note lines (ST1, ST6): a stock item goes to the
 * inventory account, and only stock items go there, so stock always equals
 * the inventory account.
 */
export function assertInventoryLines(
  lines: ReadonlyArray<{ itemType: ItemType | null; itemCode: string | null; accountSystemKey: string | null; accountCode: string }>,
): void {
  lines.forEach((line, index) => {
    const label = `Line ${index + 1}`;
    const toInventory = line.accountSystemKey === "inventory";
    if (line.itemType === "stock" && !toInventory) {
      throw new ValidationError(`${label}: ${line.itemCode} is a stock item, so it goes to the inventory account, not ${line.accountCode}.`);
    }
    if (line.itemType !== "stock" && toInventory) {
      throw new ValidationError(
        `${label}: account ${line.accountCode} is the inventory account, which only stock items go to (so stock always matches it). Pick a stock item, or another account.`,
      );
    }
  });
}

import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { getItem } from "@/lib/items/service";
import { baseQuantity, type ItemType, lineDefaults, type LineDefaults } from "@/lib/items/pricing";
import { currencyMinorUnits } from "@/lib/money/currency";
import { dec, toPlainString } from "@/lib/money/decimal";
import { advancedFeaturesOn } from "@/lib/tracking/service";
import { optionalId, requireId, requireOneOf } from "@/lib/validation";

/**
 * Items on document lines (examples IT2-IT6). A line can name an item and
 * the unit it's counted in; lines without an item work as before. The
 * quantity in the item's base unit is worked out exactly and stored with the
 * line. What picking an item fills in (description, price, account, tax
 * code) comes from `itemLineDefaults`; the line keeps whatever was sent, so
 * it can still be changed on a draft.
 */

export type LineItemRef = { itemId: string | null; unitId: string | null };

/** A line's item and unit as sent. A unit needs an item. */
export function parseLineItem(line: Record<string, unknown>, label: string): LineItemRef {
  const itemId = optionalId(line.itemId, `${label} item`);
  const unitId = optionalId(line.unitId, `${label} unit`);
  if (unitId !== null && itemId === null) throw new ValidationError(`${label} has a unit but no item.`);
  return { itemId, unitId };
}

/** Item fields for the idempotency hash: left out when there's no item, so older requests hash the same. */
export function hashableItem(ref: LineItemRef): Record<string, string> {
  return ref.itemId === null ? {} : { itemId: ref.itemId, ...(ref.unitId === null ? {} : { unitId: ref.unitId }) };
}

export type ResolvedLineItem = {
  itemId: string | null;
  unitId: string | null;
  /** The quantity in the item's base unit; null without an item. */
  baseQuantity: string | null;
  itemType: ItemType | null;
  itemCode: string | null;
  itemName: string | null;
};

export const NO_ITEM: ResolvedLineItem = { itemId: null, unitId: null, baseQuantity: null, itemType: null, itemCode: null, itemName: null };

/**
 * Checks each line's item and unit: the item must exist and be active (an
 * archived one a draft already had can stay), the unit must be one of the
 * item's units, and kits are only sold, never bought (IT7). Works out the
 * base quantity exactly.
 */
export async function resolveLineItems(
  tx: OrgTx,
  lines: ReadonlyArray<LineItemRef & { quantity: string }>,
  side: "sale" | "purchase",
  kept: ReadonlyArray<LineItemRef> = [],
): Promise<ResolvedLineItem[]> {
  const itemIds = [...new Set(lines.flatMap((line) => (line.itemId ? [line.itemId] : [])))];
  if (itemIds.length === 0) return lines.map(() => NO_ITEM);
  const items = await tx.query<{ id: string; code: string; name: string; item_type: ItemType; is_active: boolean }>(
    "select id, code, name, item_type, is_active from items where id = any($1::bigint[])",
    [itemIds],
  );
  const units = await tx.query<{ id: string; item_id: string; name: string; factor: string; is_active: boolean }>(
    "select id, item_id, name, factor::text, is_active from item_units where item_id = any($1::bigint[])",
    [itemIds],
  );
  const itemsById = new Map(items.rows.map((row) => [row.id, row]));
  const unitsById = new Map(units.rows.map((row) => [row.id, row]));
  const keptItems = new Set(kept.flatMap((ref) => (ref.itemId ? [ref.itemId] : [])));
  const keptUnits = new Set(kept.flatMap((ref) => (ref.unitId ? [ref.unitId] : [])));
  return lines.map((line, index) => {
    const label = `Line ${index + 1}`;
    if (line.itemId === null) return NO_ITEM;
    const item = itemsById.get(line.itemId);
    if (!item) throw new ValidationError(`${label}: there's no item #${line.itemId}.`);
    if (!item.is_active && !keptItems.has(item.id)) throw new ValidationError(`${label}: ${item.code} is archived.`);
    if (side === "purchase" && item.item_type === "kit") {
      throw new ValidationError(`${label}: ${item.code} is a kit. Kits are sold, not bought; put its parts on the bill instead.`);
    }
    let factor: string | null = null;
    if (line.unitId !== null) {
      const unit = unitsById.get(line.unitId);
      if (!unit || unit.item_id !== item.id) throw new ValidationError(`${label}: that unit isn't one of ${item.code}'s units.`);
      if (!unit.is_active && !keptUnits.has(unit.id)) throw new ValidationError(`${label}: ${unit.name} is archived.`);
      factor = unit.factor;
    }
    return {
      itemId: item.id,
      unitId: line.unitId,
      baseQuantity: baseQuantity(line.quantity, factor),
      itemType: item.item_type,
      itemCode: item.code,
      itemName: item.name,
    };
  });
}

export type ItemLineDefaults = LineDefaults & {
  itemId: string;
  /** The unit the line starts in: the item's sale or purchase unit, or null for the base unit. */
  unitId: string | null;
};

/**
 * What picking an item fills on a line (IT2-IT6). Sales lines get the price
 * for the customer's default price level and purchase lines the supplier's
 * own price, both only while Advanced reporting is on; otherwise the item's
 * sale or purchase price.
 */
export async function itemLineDefaults(
  tx: OrgTx,
  input: { itemId: unknown; side: unknown; contactId?: unknown; unitId?: unknown },
): Promise<ItemLineDefaults> {
  const item = await getItem(tx, requireId(input.itemId, "itemId"));
  const side = requireOneOf(input.side, "side", ["sale", "purchase"] as const);
  const contactId = optionalId(input.contactId, "contactId");
  const requestedUnit = input.unitId === undefined ? undefined : optionalId(input.unitId, "unitId");
  const unitId = requestedUnit === undefined ? (side === "sale" ? item.saleUnitId : item.purchaseUnitId) : requestedUnit;
  const unit = unitId === null ? null : item.units.find((entry) => entry.id === unitId);
  if (unitId !== null && !unit) throw new ValidationError(`That unit isn't one of ${item.code}'s units.`);
  const advanced = await advancedFeaturesOn(tx);
  let priceLevel: { id: string; markupPercent: string } | null = null;
  if (side === "sale" && contactId && advanced) {
    const level = await tx.query<{ id: string; markup_percent: string }>(
      "select l.id, l.markup_percent::text from contacts c join price_levels l on l.id = c.price_level_id where c.id = $1",
      [contactId],
    );
    priceLevel = level.rows[0] ? { id: level.rows[0].id, markupPercent: level.rows[0].markup_percent } : null;
  }
  const defaults = lineDefaults(item, {
    side,
    scale: currencyMinorUnits(tx.baseCurrency),
    unitFactor: unit?.factor ?? null,
    priceLevel,
    supplierId: side === "purchase" && advanced ? contactId : null,
  });
  return { ...defaults, itemId: item.id, unitId };
}

type FillableLine = LineItemRef & {
  description: string;
  quantity: string;
  unitPrice: string;
  accountCode: string;
  taxCode: string | null;
};

/**
 * Fills what a line with an item left blank (description, unit price,
 * account and, unless the amounts have no tax, tax code) the same way the
 * editor does when an item is picked (IT2). Anything sent is kept. Blanks
 * are "" (and a null tax code) from the document's parser.
 */
export async function fillLinesFromItems<T extends FillableLine>(
  tx: OrgTx,
  lines: readonly T[],
  options: { side: "sale" | "purchase"; contactId: string; noTax: boolean },
): Promise<T[]> {
  const filled: T[] = [];
  for (const [index, line] of lines.entries()) {
    const label = `Line ${index + 1}`;
    const needs = line.itemId !== null && (line.description === "" || line.unitPrice === "" || line.accountCode === "" || (!options.noTax && line.taxCode === null));
    if (!needs) {
      filled.push(line);
      continue;
    }
    const defaults = await itemLineDefaults(tx, { itemId: line.itemId, side: options.side, contactId: options.contactId, unitId: line.unitId });
    const next = { ...line };
    if (next.description === "") next.description = defaults.description;
    if (next.unitPrice === "") {
      if (defaults.unitPrice === null) {
        throw new ValidationError(`${label}: the item has no ${options.side === "sale" ? "sale" : "purchase"} price, so type a unit price.`);
      }
      next.unitPrice = defaults.unitPrice;
    }
    if (next.accountCode === "") {
      if (defaults.accountCode === null) {
        throw new ValidationError(`${label}: the item has no ${options.side === "sale" ? "income" : "purchase"} account, so choose an account.`);
      }
      next.accountCode = defaults.accountCode;
    }
    if (!options.noTax && next.taxCode === null) {
      if (defaults.taxCode === null) throw new ValidationError(`${label} needs a tax code (the item has none).`);
      next.taxCode = defaults.taxCode;
    }
    filled.push(next);
  }
  return filled;
}

/** Whether a sent value is blank, so an item can fill it. */
export function isBlank(input: unknown): boolean {
  return input === undefined || input === null || (typeof input === "string" && input.trim() === "");
}

/** A line for the idempotency hash: its item and unit only when it has an item, so older requests hash the same. */
export function lineForHash<T extends LineItemRef>(line: T): Omit<T, "itemId" | "unitId"> & Record<string, unknown> {
  const { itemId, unitId, ...rest } = line;
  return { ...rest, ...hashableItem({ itemId, unitId }) };
}

/** The item columns a document line query selects, given the line table's alias `l`. */
export const LINE_ITEM_COLUMNS = `l.item_id, it.code as item_code, l.unit_id, iu.name as unit_name, l.base_quantity::text as base_quantity`;
export const LINE_ITEM_JOINS = `left join items it on it.id = l.item_id left join item_units iu on iu.id = l.unit_id`;

export type LineItemRow = {
  item_id: string | null;
  item_code: string | null;
  unit_id: string | null;
  unit_name: string | null;
  base_quantity: string | null;
};

export type LineItemFields = {
  /** The item on the line (IT2), or null. */
  itemId: string | null;
  itemCode: string | null;
  /** The unit the quantity is in (IT5); null is the item's base unit. */
  unitId: string | null;
  unitName: string | null;
  /** The quantity in the item's base unit (IT5); null without an item. */
  baseQuantity: string | null;
};

export function lineItemFields(row: LineItemRow): LineItemFields {
  return {
    itemId: row.item_id,
    itemCode: row.item_code,
    unitId: row.unit_id,
    unitName: row.unit_name,
    baseQuantity: row.base_quantity === null ? null : toPlain(row.base_quantity),
  };
}

function toPlain(value: string): string {
  return toPlainString(dec(value));
}

import { add, cmp, dec, mul, mulDiv, roundHalfUp, toFixedString, toPlainString, type Decimal } from "@/lib/money/decimal";

// Browser-safe: the line editors use this to fill a line when an item is
// picked, and the server uses it again to fill anything a request left out
// (examples IT2-IT6 in docs/ACCOUNTING-EXAMPLES.md).

export const ITEM_TYPES = ["service", "non_stock", "stock", "kit"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Readonly<Record<ItemType, string>> = {
  service: "Service",
  non_stock: "Non-stock",
  stock: "Stock (tracked)",
  kit: "Kit (bundle)",
};

/** Quantities in units and unit sizes allow up to 4 decimal places, like line quantities. */
export const UNIT_FACTOR_SCALE = 4;
/** Unit prices on lines allow up to 4 decimal places. */
export const LINE_PRICE_SCALE = 4;

const HUNDRED = dec("100");

/**
 * An item's sale price for a price level (IT4): an explicit price for that
 * level wins; otherwise the base sale price adjusted by the level's percent
 * (-10 is 10% off, 5 is 5% on), rounded once to the currency's minor units,
 * half away from zero. Null when the item has no sale price and no override.
 */
export function levelPrice(
  baseSalePrice: string | null,
  level: { markupPercent: string } | null,
  override: string | null,
  scale: number,
): string | null {
  if (override !== null) return toPlainString(dec(override));
  if (baseSalePrice === null) return null;
  if (!level) return toPlainString(dec(baseSalePrice));
  const factor: Decimal = add(HUNDRED, dec(level.markupPercent));
  // price x (100 + percent) / 100, exact, then rounded once.
  return toFixedString(mulDiv(dec(baseSalePrice), factor, HUNDRED, scale), scale);
}

/**
 * The quantity in the item's base unit (IT5): quantity x the unit's size,
 * exactly. A line in the base unit has a size of 1.
 */
export function baseQuantity(quantity: string, unitFactor: string | null): string {
  return toPlainString(mul(dec(quantity), dec(unitFactor ?? "1")));
}

/** A base-unit price for a bigger or smaller unit: price x size, to 4 decimal places (IT5). */
export function unitPriceFor(basePrice: string, unitFactor: string | null): string {
  if (unitFactor === null || cmp(dec(unitFactor), dec("1")) === 0) return toPlainString(dec(basePrice));
  return toPlainString(roundHalfUp(mul(dec(basePrice), dec(unitFactor)), LINE_PRICE_SCALE));
}

/** What a line needs to know about an item to fill itself in. */
export type ItemForLines = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  itemType: ItemType;
  salePrice: string | null;
  purchasePrice: string | null;
  incomeAccountCode: string | null;
  purchaseAccountCode: string | null;
  salesTaxCode: string | null;
  purchaseTaxCode: string | null;
  levelPrices: Array<{ priceLevelId: string; price: string }>;
  suppliers: Array<{ contactId: string; price: string | null }>;
};

export type LineDefaults = {
  description: string;
  unitPrice: string | null;
  accountCode: string | null;
  taxCode: string | null;
};

/**
 * What picking an item fills on a line (IT2-IT6).
 *
 * - Sales side (invoices, credit notes): the item's description (or name),
 *   its income account and sales tax code, and its sale price for the
 *   customer's price level when price levels are in use (IT4).
 * - Purchase side (bills, supplier credit notes): its purchase account and
 *   tax code, and the supplier's own price for it if it has one, else the
 *   item's purchase price (IT6).
 * - With a unit other than the base unit, the price is for that unit (IT5).
 */
export function lineDefaults(
  item: ItemForLines,
  options: {
    side: "sale" | "purchase";
    scale: number;
    unitFactor: string | null;
    /** The customer's price level, when price levels apply. */
    priceLevel?: { id: string; markupPercent: string } | null;
    /** The supplier, when supplier prices apply. */
    supplierId?: string | null;
  },
): LineDefaults {
  let price: string | null;
  if (options.side === "sale") {
    const level = options.priceLevel ?? null;
    const override = level ? (item.levelPrices.find((entry) => entry.priceLevelId === level.id)?.price ?? null) : null;
    price = levelPrice(item.salePrice, level, override, options.scale);
  } else {
    const supplierPrice = options.supplierId
      ? (item.suppliers.find((entry) => entry.contactId === options.supplierId)?.price ?? null)
      : null;
    price = supplierPrice ?? item.purchasePrice;
  }
  return {
    description: item.description ?? item.name,
    unitPrice: price === null ? null : unitPriceFor(price, options.unitFactor),
    accountCode: options.side === "sale" ? item.incomeAccountCode : item.purchaseAccountCode,
    taxCode: options.side === "sale" ? item.salesTaxCode : item.purchaseTaxCode,
  };
}

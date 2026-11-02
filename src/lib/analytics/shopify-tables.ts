/**
 * Shopify in Analytics (#530, decision 1244, examples SPD9-SPD10): the
 * `shopify_*` tables and their plain names. They're copied from what Tohyee
 * already holds about connected Shopify stores; Analytics never calls
 * Shopify itself.
 *
 * Browser-safe.
 */

/** Every Shopify table starts with this; other sources can't use it. */
export const SHOPIFY_TABLE_PREFIX = "shopify_";
/** How a Shopify load is recorded in the load history. */
export const SHOPIFY_LOAD_TABLE_NAME = "shopify_*";
export const SHOPIFY_SOURCE_NAME = "Shopify";
export const SHOPIFY_FILE_NAME = "(Tohyee's copy of the connected Shopify stores)";

export type ShopifyTable = { table: string; label: string; noun: string; description: string };

export const SHOPIFY_TABLES: ShopifyTable[] = [
  { table: "shopify_orders", label: "Shopify orders", noun: "orders", description: "Each Shopify order brought in: its invoice, total, discounts, shipping charged and fulfilment status. Contacts by ID only." },
  { table: "shopify_order_lines", label: "Shopify order lines", noun: "order lines", description: "The lines of the invoices made from Shopify orders, excluding GST." },
  { table: "shopify_refunds", label: "Shopify refunds", noun: "refunds", description: "Each Shopify refund brought in, as its credit note." },
  { table: "shopify_payouts", label: "Shopify payouts", noun: "payouts", description: "Each Shopify Payments payout brought in, and what it became in Tohyee." },
  { table: "shopify_stock", label: "Shopify stock", noun: "stock levels", description: "Shopify's stock per variant and location as last read, beside Tohyee's stock on hand for the matched item." },
  { table: "shopify_locations", label: "Shopify locations", noun: "locations", description: "The store's locations." },
  { table: "shopify_shop_stats", label: "Shopify shop stats by day", noun: "days", description: "Shopify's own daily figures: sessions, orders, conversion rate (a percentage, as Shopify gives it), gross and net sales." },
  { table: "shopify_sales_by_product", label: "Shopify sales by product", noun: "rows", description: "Shopify's daily orders, gross and net sales for each product." },
  { table: "shopify_sales_by_channel", label: "Shopify sales by channel", noun: "rows", description: "Shopify's daily orders, gross and net sales for each sales channel." },
  { table: "shopify_discounts", label: "Shopify discounts", noun: "discounts", description: "Discount codes and automatic discounts: type, value, dates, status and times used." },
  { table: "shopify_order_discounts", label: "Shopify order discounts", noun: "order discounts", description: "Each discount used on each order brought in, and the amount it took off." },
  { table: "shopify_fulfilments", label: "Shopify fulfilments", noun: "fulfilments", description: "Shipments on orders brought in: status, dates, carrier and tracking number." },
  { table: "shopify_gift_cards", label: "Shopify gift cards", noun: "gift cards", description: "Gift cards by their last 4 characters (never the full code): value, balance and expiry." },
  { table: "shopify_gift_card_transactions", label: "Shopify gift card transactions", noun: "gift card transactions", description: "Money put on (positive) and taken off (negative) each gift card." },
];

export const isShopifyTable = (table: string) => table.startsWith(SHOPIFY_TABLE_PREFIX);

/**
 * The parts of a Shopify connection and the access scopes each needs
 * (decisions 52, 665, 1237-1245; examples SPD1-SPD10). A part is on for a
 * store when the store gave the app every scope it needs: nothing to switch
 * on in Tohyee. All are read-only: Tohyee never asks for a write_ scope.
 *
 * Browser-safe (the settings page lists them).
 */

export type ShopifyPartKey = "records" | "orders" | "payouts" | "stock" | "stats" | "discounts" | "giftCards" | "fulfilments";

export type ShopifyPart = {
  key: ShopifyPartKey;
  label: string;
  /** All of these must be granted for the part to be on. */
  scopes: readonly string[];
  /** Asked for too when granted, but the part works without them. */
  optionalScopes?: readonly string[];
  /** What the part brings in, in a few words. */
  brings: string;
  /** Shopify must approve the app first (protected customer data or an approval-only scope). */
  needsApproval?: string;
};

/** In the order the settings page lists them. */
export const SHOPIFY_PARTS: readonly ShopifyPart[] = [
  { key: "records", label: "Customers and products", scopes: ["read_customers", "read_products"], brings: "Customers into contacts, product variants into items." },
  { key: "orders", label: "Orders and refunds", scopes: ["read_orders"], brings: "Orders and refunds into the accounts, when posting is on." },
  {
    key: "payouts",
    label: "Payouts",
    scopes: ["read_shopify_payments_payouts", "read_shopify_payments_accounts"],
    brings: "Shopify Payments payouts and their fees, when posting is on.",
  },
  { key: "stock", label: "Stock levels", scopes: ["read_inventory", "read_locations"], brings: "Shopify's locations and stock per variant. Read only: Tohyee's stock never changes." },
  {
    key: "stats",
    label: "Shop stats",
    scopes: ["read_reports"],
    brings: "Daily sessions, orders, conversion rate and sales, by product and channel, for Analytics.",
    needsApproval: "Shopify also has to approve the app for level 2 protected customer data before it answers shop reports.",
  },
  { key: "discounts", label: "Discounts", scopes: ["read_discounts"], brings: "Discount codes and automatic discounts, and which were used on each order brought in." },
  {
    key: "giftCards",
    label: "Gift cards",
    scopes: ["read_gift_cards", "read_gift_card_transactions"],
    brings: "Gift cards (only their last 4 characters), values, balances and their use.",
  },
  {
    key: "fulfilments",
    label: "Fulfilment and shipping",
    scopes: ["read_orders"],
    optionalScopes: ["read_merchant_managed_fulfillment_orders"],
    brings: "Shipments (carrier, tracking number) and shipping charged, on orders brought in.",
    needsApproval: "Fulfilment order status needs read_merchant_managed_fulfillment_orders, which Shopify may need to approve. Without it shipments still come in.",
  },
];

/** Every scope Tohyee can use, in the order to paste into Shopify's Dev Dashboard. */
export const SHOPIFY_ALL_SCOPES: readonly string[] = [...new Set(SHOPIFY_PARTS.flatMap((part) => [...part.scopes, ...(part.optionalScopes ?? [])]))];

/** The comma-separated line for the Dev Dashboard's "Scopes" box. */
export const SHOPIFY_SCOPES_LINE = SHOPIFY_ALL_SCOPES.join(",");

export type PartState = { key: ShopifyPartKey; label: string; on: boolean; missing: string[]; optionalMissing: string[] };

/** Which parts are on for a store, from the scopes it gave the app. */
export function shopifyPartStates(granted: readonly string[]): PartState[] {
  const has = new Set(granted);
  return SHOPIFY_PARTS.map((part) => {
    const missing = part.scopes.filter((scope) => !has.has(scope));
    return {
      key: part.key,
      label: part.label,
      on: missing.length === 0,
      missing,
      optionalMissing: (part.optionalScopes ?? []).filter((scope) => !has.has(scope)),
    };
  });
}

export function partOn(granted: readonly string[], key: ShopifyPartKey): boolean {
  const part = SHOPIFY_PARTS.find((entry) => entry.key === key);
  return part !== undefined && part.scopes.every((scope) => granted.includes(scope));
}

/** The sync log's line for a part left out for want of scopes (once a day, like payouts). */
export function partOffMessage(key: ShopifyPartKey, granted: readonly string[]): string {
  const part = SHOPIFY_PARTS.find((entry) => entry.key === key)!;
  const missing = part.scopes.filter((scope) => !granted.includes(scope));
  return `${part.label} aren't brought in: the app hasn't been given ${missing.join(" and ")}. Add ${missing.length === 1 ? "it" : "them"} to the app's access scopes in Shopify, then test the connection.`;
}

/** Shopify's answer when it hasn't approved the app for shop reports (shopifyqlQuery needs level 2 protected customer data). */
export const STATS_NOT_APPROVED =
  "Shopify hasn't approved shop reports for this app yet. Shop stats need read_reports and Shopify's approval for level 2 protected customer data (name, email, phone and address) in the app's settings in the Dev Dashboard. The rest of the sync carried on.";

/** Shopify's answer when it refuses fulfilment orders (an approval-required scope). */
export const FULFILMENT_ORDERS_NOT_APPROVED =
  "Shopify hasn't approved fulfilment orders for this app yet (read_merchant_managed_fulfillment_orders). Shipments and shipping charged still came in; fulfilment order status was left out. The rest of the sync carried on.";

import type { OrgTx } from "@/lib/db/org-transaction";
import { cmp, dec, sub, sum, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { ExtrasResult, PlatformOrder } from "@/lib/sales-platforms/connector";

/**
 * Saving Shopify's read-only extras and reading the stock difference view
 * (decisions 1237-1245, examples SPD1-SPD10). Copies of what Shopify said:
 * nothing here posts to the ledger or changes Tohyee's stock (decision
 * 1238). Called inside the sync's write transaction, after Shopify answered.
 */

const BATCH = 500;

async function insertRows(tx: OrgTx, table: string, columns: string[], rows: unknown[][], conflict = ""): Promise<void> {
  for (let start = 0; start < rows.length; start += BATCH) {
    const chunk = rows.slice(start, start + BATCH);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    }).join(", ")})`);
    await tx.query(`insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")} ${conflict}`, values);
  }
}

/** Replaces what was fetched; a part not fetched (null) keeps what's stored. */
export async function saveExtras(tx: OrgTx, connectionId: string, extras: ExtrasResult): Promise<void> {
  if (extras.locations) {
    await tx.query("delete from sales_platform_locations where connection_id = $1", [connectionId]);
    await insertRows(tx, "sales_platform_locations", ["connection_id", "external_id", "name", "is_active"],
      extras.locations.map((l) => [connectionId, l.externalId, l.name, l.active]));
  }
  if (extras.stock) {
    // A partial read (a very big store) adds to and updates what's there rather than dropping the rest.
    if (extras.stockComplete) await tx.query("delete from sales_platform_stock_levels where connection_id = $1", [connectionId]);
    await insertRows(
      tx,
      "sales_platform_stock_levels",
      ["connection_id", "variant_external_id", "location_external_id", "inventory_item_external_id", "sku", "product_title", "variant_title", "available", "on_hand"],
      extras.stock.map((s) => [connectionId, s.variantId, s.locationId, s.inventoryItemId, s.sku?.slice(0, 255) ?? null, s.productTitle?.slice(0, 255) ?? null, s.variantTitle?.slice(0, 255) ?? null, s.available, s.onHand]),
      `on conflict (connection_id, variant_external_id, location_external_id) do update set
         inventory_item_external_id = excluded.inventory_item_external_id, sku = excluded.sku, product_title = excluded.product_title,
         variant_title = excluded.variant_title, available = excluded.available, on_hand = excluded.on_hand, synced_at = now()`,
    );
  }
  if (extras.stats) {
    // The days asked for are replaced: Shopify's recent figures can still change.
    const days = [...new Set([...extras.stats.daily.map((d) => d.day), ...extras.stats.breakdown.map((b) => b.day)])];
    await tx.query("delete from sales_platform_shop_stats where connection_id = $1 and day = any($2::date[])", [connectionId, days]);
    await tx.query("delete from sales_platform_shop_sales where connection_id = $1 and day = any($2::date[])", [connectionId, days]);
    await insertRows(tx, "sales_platform_shop_stats", ["connection_id", "day", "sessions", "conversion_rate", "orders", "gross_sales", "net_sales"],
      extras.stats.daily.map((d) => [connectionId, d.day, d.sessions, d.conversionRate, d.orders, d.grossSales, d.netSales]));
    await insertRows(tx, "sales_platform_shop_sales", ["connection_id", "day", "dimension", "value", "orders", "gross_sales", "net_sales"],
      extras.stats.breakdown.map((b) => [connectionId, b.day, b.dimension, b.value, b.orders, b.grossSales, b.netSales]));
  }
  if (extras.discounts) {
    await tx.query("delete from sales_platform_discounts where connection_id = $1", [connectionId]);
    await insertRows(
      tx,
      "sales_platform_discounts",
      ["connection_id", "external_id", "method", "title", "discount_type", "value_type", "value", "starts_at", "ends_at", "status", "times_used"],
      extras.discounts.map((d) => [connectionId, d.externalId, d.method, d.title, d.discountType, d.valueType, d.value, d.startsAt, d.endsAt, d.status?.slice(0, 40) ?? null, d.timesUsed]),
    );
  }
  if (extras.giftCards) {
    await tx.query("delete from sales_platform_gift_card_transactions where connection_id = $1", [connectionId]);
    await tx.query("delete from sales_platform_gift_cards where connection_id = $1", [connectionId]);
    await insertRows(
      tx,
      "sales_platform_gift_cards",
      ["connection_id", "external_id", "last_characters", "initial_value", "balance", "currency", "expires_on", "enabled", "created_on_platform_at", "deactivated_at"],
      extras.giftCards.map((g) => [connectionId, g.externalId, g.lastCharacters, g.initialValue, g.balance, g.currency, g.expiresOn, g.enabled, g.createdAt, g.deactivatedAt]),
    );
    await insertRows(
      tx,
      "sales_platform_gift_card_transactions",
      ["connection_id", "external_id", "gift_card_external_id", "kind", "amount", "processed_at"],
      extras.giftCards.flatMap((g) => g.transactions.map((t) => [connectionId, t.externalId, g.externalId, t.kind, t.amount, t.processedAt])),
      "on conflict do nothing",
    );
  }
}

/** The order's extras, replacing what was saved for it before. Nothing is posted. */
export async function saveOrderExtras(tx: OrgTx, connectionId: string, order: PlatformOrder): Promise<void> {
  const extras = order.extras;
  if (!extras) return;
  await tx.query(
    `insert into sales_platform_order_details (connection_id, order_external_id, order_name, processed_at, currency, discounts_total, shipping_charged,
                                              fulfilment_status, fulfilment_order_statuses)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (connection_id, order_external_id) do update set
       order_name = excluded.order_name, processed_at = excluded.processed_at, currency = excluded.currency,
       discounts_total = coalesce(excluded.discounts_total, sales_platform_order_details.discounts_total),
       shipping_charged = coalesce(excluded.shipping_charged, sales_platform_order_details.shipping_charged),
       fulfilment_status = coalesce(excluded.fulfilment_status, sales_platform_order_details.fulfilment_status),
       fulfilment_order_statuses = coalesce(excluded.fulfilment_order_statuses, sales_platform_order_details.fulfilment_order_statuses),
       synced_at = now()`,
    [
      connectionId,
      order.externalId,
      order.name.slice(0, 100),
      order.processedAt,
      /^[A-Z]{3}$/.test(order.currency) ? order.currency : null,
      extras.discountsTotal,
      extras.shippingCharged,
      extras.fulfilmentStatus?.slice(0, 40) ?? null,
      extras.fulfilmentOrderStatuses,
    ],
  );
  if (extras.discountApplications) {
    await tx.query("delete from sales_platform_order_discounts where connection_id = $1 and order_external_id = $2", [connectionId, order.externalId]);
    await insertRows(
      tx,
      "sales_platform_order_discounts",
      ["connection_id", "order_external_id", "application_index", "kind", "code", "title", "value_type", "value", "amount"],
      extras.discountApplications.map((a) => [connectionId, order.externalId, a.index, a.kind, a.code, a.title, a.valueType, a.value, a.amount]),
      "on conflict do nothing",
    );
  }
  if (extras.fulfilments) {
    await tx.query("delete from sales_platform_fulfilments where connection_id = $1 and order_external_id = $2", [connectionId, order.externalId]);
    await insertRows(
      tx,
      "sales_platform_fulfilments",
      ["connection_id", "external_id", "order_external_id", "status", "created_on_platform_at", "delivered_at", "carrier", "tracking_number"],
      extras.fulfilments.map((f) => [connectionId, f.externalId, order.externalId, f.status?.slice(0, 40) ?? null, f.createdAt, f.deliveredAt, f.carrier, f.trackingNumber]),
      "on conflict do nothing",
    );
  }
}

// ---------------------------------------------------------------------------
// The difference view (SPD2): Shopify's stock beside Tohyee's, never changing either.

export type StockDifference = {
  variantId: string;
  sku: string | null;
  shopifyName: string;
  /** The Tohyee item: the one the variant is linked to, else the one whose code is its SKU. */
  itemCode: string | null;
  itemName: string | null;
  /** How it was matched. */
  matchedBy: "link" | "sku" | null;
  shopifyOnHand: string;
  shopifyAvailable: string;
  /** Null when Tohyee doesn't keep stock of the item (or there's no item). */
  tohyeeOnHand: string | null;
  /** Shopify on hand less Tohyee on hand; null when there's nothing to compare. */
  difference: string | null;
  locations: Array<{ name: string; onHand: string; available: string }>;
};

export type StockView = { syncedAt: string | null; rows: StockDifference[] };

/**
 * Shopify's on-hand stock (all its locations together) against Tohyee's
 * (all its locations together), for each variant Shopify tracks. Shopify's
 * on hand counts what's committed to unfulfilled orders, as Tohyee does
 * until the invoice is approved, so on hand is what's compared (decision
 * 1238).
 */
export async function stockDifferences(tx: OrgTx, connectionId: string): Promise<StockView> {
  const result = await tx.query<{
    variant_external_id: string;
    sku: string | null;
    product_title: string | null;
    variant_title: string | null;
    location_name: string | null;
    on_hand: string;
    available: string;
    synced_at: Date;
    item_code: string | null;
    item_name: string | null;
    item_type: string | null;
    matched_by: "link" | "sku" | null;
    tohyee_on_hand: string | null;
  }>(
    `select s.variant_external_id, s.sku, s.product_title, s.variant_title, l.name as location_name, s.on_hand::text, s.available::text, s.synced_at,
            i.code as item_code, i.name as item_name, i.item_type,
            case when m.item_id is not null then 'link' when i.id is not null then 'sku' end as matched_by,
            (select coalesce(sum(b.on_hand_quantity), 0)::text from inventory_item_balances b where b.item_code = i.code) as tohyee_on_hand
       from sales_platform_stock_levels s
       left join sales_platform_locations l on l.connection_id = s.connection_id and l.external_id = s.location_external_id
       left join sales_platform_mappings m
         on m.connection_id = s.connection_id and m.record_kind = 'product_variant' and m.external_id = s.variant_external_id
       left join lateral (select x.id from items x where m.item_id is null and s.sku is not null and lower(x.code) = lower(s.sku) order by x.id limit 1) by_sku on true
       left join items i on i.id = coalesce(m.item_id, by_sku.id)
      where s.connection_id = $1
      order by coalesce(i.code, s.sku, s.product_title), s.variant_external_id, l.name, s.location_external_id`,
    [connectionId],
  );
  const byVariant = new Map<string, StockDifference>();
  let syncedAt: number | null = null;
  for (const row of result.rows) {
    syncedAt = Math.max(syncedAt ?? 0, new Date(row.synced_at).getTime());
    let entry = byVariant.get(row.variant_external_id);
    if (!entry) {
      const stockItem = row.item_type === "stock";
      entry = {
        variantId: row.variant_external_id,
        sku: row.sku,
        shopifyName: [row.product_title, row.variant_title && row.variant_title !== "Default Title" ? row.variant_title : null].filter(Boolean).join(" - ") || (row.sku ?? "Variant"),
        itemCode: row.item_code,
        itemName: row.item_name,
        matchedBy: row.matched_by,
        shopifyOnHand: "0",
        shopifyAvailable: "0",
        tohyeeOnHand: stockItem ? toPlainString(dec(row.tohyee_on_hand ?? "0")) : null,
        difference: null,
        locations: [],
      };
      byVariant.set(row.variant_external_id, entry);
    }
    entry.locations.push({ name: row.location_name ?? "Unknown location", onHand: toPlainString(dec(row.on_hand)), available: toPlainString(dec(row.available)) });
  }
  const rows = [...byVariant.values()].map((entry) => {
    const onHand = sum(entry.locations.map((l) => dec(l.onHand)));
    const available = sum(entry.locations.map((l) => dec(l.available)));
    return {
      ...entry,
      shopifyOnHand: toPlainString(onHand),
      shopifyAvailable: toPlainString(available),
      difference: entry.tohyeeOnHand === null ? null : toPlainString(sub(onHand, dec(entry.tohyeeOnHand))),
    };
  });
  return { syncedAt: syncedAt === null ? null : new Date(syncedAt).toISOString(), rows };
}

/** Whether a row's figures differ (for the "only differences" filter and counts). */
export function differs(row: StockDifference): boolean {
  return row.difference !== null && cmp(dec(row.difference), ZERO_DECIMAL) !== 0;
}

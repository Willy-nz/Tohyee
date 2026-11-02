import { replaceTableSet, type TableCopy } from "@/lib/analytics/engine";
import { rebuildShapedTablesForTables } from "@/lib/analytics/shaped-tables";
import {
  SHOPIFY_FILE_NAME,
  SHOPIFY_LOAD_TABLE_NAME,
  SHOPIFY_SOURCE_NAME,
  SHOPIFY_TABLE_PREFIX,
} from "@/lib/analytics/shopify-tables";
import { type LoadRun, requireAnalytics, RUN_COLUMNS, type RunRow, toRun } from "@/lib/analytics/sources";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";
import { dec, sub, toPlainString } from "@/lib/money/decimal";
import type { OrganisationRecord } from "@/lib/organisations/registry";

/**
 * Shopify as an Analytics source (#530, decision 1244, examples
 * SPD9-SPD10): Tohyee's own copy of what it holds about connected Shopify
 * stores, as `shopify_*` tables. It reads this organisation's database
 * only; it never calls Shopify (the sales platform sync does that). Orders,
 * lines, refunds and payouts are the documents they became in Tohyee, so
 * they agree with the books; the rest is what Shopify last said. Customers
 * are by contact ID only: no names, emails or addresses are copied here.
 * Gift cards only ever have their last characters.
 */

const MONEY = "DECIMAL(18,2)";
const QUANTITY = "DECIMAL(18,4)";
const RATE = "DECIMAL(18,6)";
const v = (name: string, type = "VARCHAR") => ({ name, type });

type Row = Record<string, string | null>;

/** Every `shopify_*` table, read in the caller's (read-only) transaction. */
export async function readShopifyTables(tx: OrgTx): Promise<TableCopy[]> {
  const tables: TableCopy[] = [];
  const read = async (sql: string) => (await tx.query<Row>(sql)).rows;
  const store = "(select c.store_domain from sales_platform_connections c where c.id = %s.connection_id) as store";
  const storeOf = (alias: string) => store.replace("%s", alias);

  // Orders: the document each became (decision 52), with what Shopify said beyond it.
  const orders = await read(
    `select coalesce(d.store_domain, (select c.store_domain from sales_platform_connections c where c.id = od.connection_id)) as store,
            coalesce(d.external_id, od.order_external_id) as order_id, coalesce(d.name, od.order_name) as order_name,
            od.processed_at::text as processed_at, d.state, d.contact_id::text, d.sales_order_id::text, d.invoice_id::text,
            i.invoice_number, i.invoice_date::text, i.status as invoice_status, i.subtotal::text as net, i.tax_total::text as gst,
            i.total::text as total, coalesce(i.currency_code, od.currency) as currency,
            od.discounts_total::text, od.shipping_charged::text, od.fulfilment_status,
            array_to_string(od.fulfilment_order_statuses, ', ') as fulfilment_orders
       from (select * from sales_platform_documents where platform = 'shopify' and record_kind = 'order') d
       full join sales_platform_order_details od
         on od.connection_id = d.connection_id and od.order_external_id = d.external_id
       left join sales_invoices i on i.id = d.invoice_id
      where (d.external_id is not null or exists (select 1 from sales_platform_connections c where c.id = od.connection_id and c.platform = 'shopify'))
      order by coalesce(i.invoice_date::text, od.processed_at::text), 2`,
  );
  tables.push({
    name: "shopify_orders",
    columns: [
      v("store"), v("order_id"), v("order_name"), v("processed_at", "TIMESTAMP"), v("state"), v("contact_id", "BIGINT"), v("sales_order_id", "BIGINT"),
      v("invoice_id", "BIGINT"), v("invoice_number"), v("invoice_date", "DATE"), v("invoice_status"), v("net", MONEY), v("gst", MONEY), v("total", MONEY),
      v("currency"), v("discounts", MONEY), v("shipping_charged", MONEY), v("fulfilment_status"), v("fulfilment_orders"),
    ],
    rows: orders.map((r) => [
      r.store, r.order_id, r.order_name, r.processed_at, r.state, r.contact_id, r.sales_order_id, r.invoice_id, r.invoice_number, r.invoice_date,
      r.invoice_status, r.net, r.gst, r.total, r.currency, r.discounts_total, r.shipping_charged, r.fulfilment_status, r.fulfilment_orders,
    ]),
  });

  const lines = await read(
    `select d.store_domain as store, d.external_id as order_id, d.name as order_name, i.id::text as invoice_id, i.invoice_date::text,
            l.line_order::text, l.description, it.code as item_code, a.code as account_code, t.code as tax_code, l.quantity::text,
            l.unit_price::text, coalesce(l.base_net_amount, l.net_amount)::text as net, coalesce(l.base_tax_amount, l.tax_amount)::text as gst
       from sales_platform_documents d
       join sales_invoices i on i.id = d.invoice_id and i.status in ('approved', 'voided')
       join sales_invoice_lines l on l.invoice_id = i.id
       left join items it on it.id = l.item_id
       left join accounts a on a.id = l.account_id
       left join tax_codes t on t.id = l.tax_code_id
      where d.platform = 'shopify' and d.record_kind = 'order'
      order by i.invoice_date, i.id, l.line_order`,
  );
  tables.push({
    name: "shopify_order_lines",
    columns: [v("store"), v("order_id"), v("order_name"), v("invoice_id", "BIGINT"), v("invoice_date", "DATE"), v("line", "INTEGER"), v("description"),
      v("item_code"), v("account_code"), v("tax_code"), v("quantity", QUANTITY), v("unit_price", RATE), v("net", MONEY), v("gst", MONEY)],
    rows: lines.map((r) => [r.store, r.order_id, r.order_name, r.invoice_id, r.invoice_date, r.line_order, r.description, r.item_code, r.account_code,
      r.tax_code, r.quantity, r.unit_price, r.net, r.gst]),
  });

  const refunds = await read(
    `select d.store_domain as store, d.external_id as refund_id, d.order_external_id as order_id, d.state, d.credit_note_id::text,
            n.credit_note_number, n.credit_note_date::text, n.status, n.subtotal::text as net, n.tax_total::text as gst, n.total::text, n.currency_code
       from sales_platform_documents d
       left join sales_credit_notes n on n.id = d.credit_note_id
      where d.platform = 'shopify' and d.record_kind = 'refund'
      order by n.credit_note_date nulls last, d.id`,
  );
  tables.push({
    name: "shopify_refunds",
    columns: [v("store"), v("refund_id"), v("order_id"), v("state"), v("credit_note_id", "BIGINT"), v("credit_note_number"), v("credit_note_date", "DATE"),
      v("credit_note_status"), v("net", MONEY), v("gst", MONEY), v("total", MONEY), v("currency")],
    rows: refunds.map((r) => [r.store, r.refund_id, r.order_id, r.state, r.credit_note_id, r.credit_note_number, r.credit_note_date, r.status, r.net,
      r.gst, r.total, r.currency_code]),
  });

  const payouts = await read(
    `select d.store_domain as store, d.external_id as payout_id, d.name, d.state,
            coalesce(t.transfer_date, b.transaction_date)::text as date,
            case when t.id is not null then t.amount::text when b.id is not null then (-b.total)::text end as amount,
            coalesce(t.currency_code, b.currency_code) as currency, d.transfer_id::text, d.bank_transaction_id::text
       from sales_platform_documents d
       left join bank_transfers t on t.id = d.transfer_id
       left join bank_transactions b on b.id = d.bank_transaction_id
      where d.platform = 'shopify' and d.record_kind = 'payout'
      order by 5 nulls last, d.id`,
  );
  tables.push({
    name: "shopify_payouts",
    columns: [v("store"), v("payout_id"), v("name"), v("state"), v("date", "DATE"), v("amount", MONEY), v("currency"), v("transfer_id", "BIGINT"),
      v("bank_transaction_id", "BIGINT")],
    rows: payouts.map((r) => [r.store, r.payout_id, r.name, r.state, r.date, r.amount, r.currency, r.transfer_id, r.bank_transaction_id]),
  });

  // Stock: Shopify's figure per location, and Tohyee's on hand for the matched item (all its locations together).
  const stock = await read(
    `select ${storeOf("s")}, s.variant_external_id, s.sku, s.product_title, s.variant_title, s.location_external_id, l.name as location,
            s.available::text, s.on_hand::text, s.synced_at::text, i.code as item_code, i.item_type,
            (select coalesce(sum(b.on_hand_quantity), 0)::text from inventory_item_balances b where b.item_code = i.code) as tohyee_on_hand,
            (select count(*) from sales_platform_stock_levels o where o.connection_id = s.connection_id and o.variant_external_id = s.variant_external_id)::text as locations,
            (select sum(o.on_hand)::text from sales_platform_stock_levels o where o.connection_id = s.connection_id and o.variant_external_id = s.variant_external_id) as shopify_total
       from sales_platform_stock_levels s
       left join sales_platform_locations l on l.connection_id = s.connection_id and l.external_id = s.location_external_id
       left join sales_platform_mappings m on m.connection_id = s.connection_id and m.record_kind = 'product_variant' and m.external_id = s.variant_external_id
       left join lateral (select x.id from items x where m.item_id is null and s.sku is not null and lower(x.code) = lower(s.sku) order by x.id limit 1) k on true
       left join items i on i.id = coalesce(m.item_id, k.id)
      order by 1, s.sku, s.variant_external_id, l.name`,
  );
  const seenVariants = new Set<string>();
  tables.push({
    name: "shopify_stock",
    columns: [v("store"), v("variant_id"), v("sku"), v("product"), v("variant"), v("location_id"), v("location"), v("shopify_available", QUANTITY),
      v("shopify_on_hand", QUANTITY), v("read_at", "TIMESTAMP"), v("item_code"), v("tohyee_on_hand", QUANTITY), v("difference", QUANTITY)],
    rows: stock.map((r) => {
      const tracked = r.item_type === "stock";
      // Tohyee's total and the difference go on the variant's first location only, so adding up rows doesn't count them twice.
      const key = `${r.store}\u0000${r.variant_external_id}`;
      const first = !seenVariants.has(key);
      seenVariants.add(key);
      const tohyee = tracked && first ? r.tohyee_on_hand : null;
      const difference = tohyee !== null && r.shopify_total !== null ? toPlainString(sub(dec(r.shopify_total), dec(tohyee))) : null;
      return [r.store, r.variant_external_id, r.sku, r.product_title, r.variant_title, r.location_external_id, r.location, r.available, r.on_hand,
        r.synced_at, r.item_code, tohyee, difference];
    }),
  });

  const locations = await read(`select ${storeOf("l")}, l.external_id, l.name, l.is_active::text from sales_platform_locations l order by 1, l.name`);
  tables.push({
    name: "shopify_locations",
    columns: [v("store"), v("location_id"), v("location"), v("active", "BOOLEAN")],
    rows: locations.map((r) => [r.store, r.external_id, r.name, r.is_active]),
  });

  const stats = await read(
    `select ${storeOf("s")}, s.day::text, s.sessions::text, s.orders::text, s.conversion_rate::text, s.gross_sales::text, s.net_sales::text
       from sales_platform_shop_stats s order by 1, s.day`,
  );
  tables.push({
    name: "shopify_shop_stats",
    columns: [v("store"), v("date", "DATE"), v("sessions", "BIGINT"), v("orders", "BIGINT"), v("conversion_rate", "DECIMAL(18,4)"), v("gross_sales", MONEY),
      v("net_sales", MONEY)],
    rows: stats.map((r) => [r.store, r.day, r.sessions, r.orders, r.conversion_rate, r.gross_sales, r.net_sales]),
  });
  for (const dimension of ["product", "channel"] as const) {
    const breakdown = await read(
      `select ${storeOf("s")}, s.day::text, s.value, s.orders::text, s.gross_sales::text, s.net_sales::text
         from sales_platform_shop_sales s where s.dimension = '${dimension}' order by 1, s.day, s.value`,
    );
    tables.push({
      name: `shopify_sales_by_${dimension}`,
      columns: [v("store"), v("date", "DATE"), v(dimension), v("orders", "BIGINT"), v("gross_sales", MONEY), v("net_sales", MONEY)],
      rows: breakdown.map((r) => [r.store, r.day, r.value, r.orders, r.gross_sales, r.net_sales]),
    });
  }

  const discounts = await read(
    `select ${storeOf("d")}, d.external_id, d.method, d.title, d.discount_type, d.value_type, d.value::text, d.starts_at::text, d.ends_at::text, d.status,
            d.times_used::text
       from sales_platform_discounts d order by 1, d.starts_at, d.title`,
  );
  tables.push({
    name: "shopify_discounts",
    columns: [v("store"), v("discount_id"), v("method"), v("title"), v("type"), v("value_type"), v("value", "DECIMAL(18,4)"), v("starts_at", "TIMESTAMP"),
      v("ends_at", "TIMESTAMP"), v("status"), v("times_used", "INTEGER")],
    rows: discounts.map((r) => [r.store, r.external_id, r.method, r.title, r.discount_type, r.value_type, r.value, r.starts_at, r.ends_at, r.status, r.times_used]),
  });

  const orderDiscounts = await read(
    `select ${storeOf("o")}, o.order_external_id, od.order_name, od.processed_at::text, o.application_index::text, o.kind, o.code, o.title, o.value_type,
            o.value::text, o.amount::text
       from sales_platform_order_discounts o
       left join sales_platform_order_details od on od.connection_id = o.connection_id and od.order_external_id = o.order_external_id
      order by 1, od.processed_at, o.order_external_id, o.application_index`,
  );
  tables.push({
    name: "shopify_order_discounts",
    columns: [v("store"), v("order_id"), v("order_name"), v("processed_at", "TIMESTAMP"), v("position", "INTEGER"), v("kind"), v("code"), v("title"),
      v("value_type"), v("value", "DECIMAL(18,4)"), v("amount", MONEY)],
    rows: orderDiscounts.map((r) => [r.store, r.order_external_id, r.order_name, r.processed_at, r.application_index, r.kind, r.code, r.title, r.value_type,
      r.value, r.amount]),
  });

  const fulfilments = await read(
    `select ${storeOf("f")}, f.external_id, f.order_external_id, od.order_name, f.status, f.created_on_platform_at::text, f.delivered_at::text, f.carrier,
            f.tracking_number
       from sales_platform_fulfilments f
       left join sales_platform_order_details od on od.connection_id = f.connection_id and od.order_external_id = f.order_external_id
      order by 1, f.created_on_platform_at, f.external_id`,
  );
  tables.push({
    name: "shopify_fulfilments",
    columns: [v("store"), v("fulfilment_id"), v("order_id"), v("order_name"), v("status"), v("created_at", "TIMESTAMP"), v("delivered_at", "TIMESTAMP"),
      v("carrier"), v("tracking_number")],
    rows: fulfilments.map((r) => [r.store, r.external_id, r.order_external_id, r.order_name, r.status, r.created_on_platform_at, r.delivered_at, r.carrier,
      r.tracking_number]),
  });

  const cards = await read(
    `select ${storeOf("g")}, g.external_id, g.last_characters, g.initial_value::text, g.balance::text, g.currency, g.expires_on::text, g.enabled::text,
            g.created_on_platform_at::text, g.deactivated_at::text
       from sales_platform_gift_cards g order by 1, g.created_on_platform_at, g.external_id`,
  );
  tables.push({
    name: "shopify_gift_cards",
    columns: [v("store"), v("gift_card_id"), v("ends_with"), v("initial_value", MONEY), v("balance", MONEY), v("currency"), v("expires_on", "DATE"),
      v("enabled", "BOOLEAN"), v("issued_at", "TIMESTAMP"), v("deactivated_at", "TIMESTAMP")],
    rows: cards.map((r) => [r.store, r.external_id, r.last_characters, r.initial_value, r.balance, r.currency, r.expires_on, r.enabled, r.created_on_platform_at,
      r.deactivated_at]),
  });
  const cardTransactions = await read(
    `select ${storeOf("t")}, t.external_id, t.gift_card_external_id, g.last_characters, t.kind, t.amount::text, t.processed_at::text
       from sales_platform_gift_card_transactions t
       left join sales_platform_gift_cards g on g.connection_id = t.connection_id and g.external_id = t.gift_card_external_id
      order by 1, t.processed_at, t.external_id`,
  );
  tables.push({
    name: "shopify_gift_card_transactions",
    columns: [v("store"), v("transaction_id"), v("gift_card_id"), v("ends_with"), v("kind"), v("amount", MONEY), v("processed_at", "TIMESTAMP")],
    rows: cardTransactions.map((r) => [r.store, r.external_id, r.gift_card_external_id, r.last_characters, r.kind, r.amount, r.processed_at]),
  });
  return tables;
}

/** Whether there's anything to load: a Shopify store is or was connected. */
export async function shopifyLoadsNightly(tx: OrgTx): Promise<boolean> {
  const found = await tx.query("select 1 from sales_platform_connections where platform = 'shopify' limit 1");
  return (found.rowCount ?? 0) > 0;
}

export async function lastShopifyRun(tx: OrgTx): Promise<LoadRun | null> {
  const result = await tx.query<RunRow>(
    `select ${RUN_COLUMNS} from analytics_load_runs where source_id is null and table_name = $1 order by started_at desc, id desc limit 1`,
    [SHOPIFY_LOAD_TABLE_NAME],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

/**
 * Copies the Shopify tables now (nightly with the other sources, or
 * "Refresh now"): read in one read-only transaction, swapped in together,
 * and recorded before and after like the books.
 */
export async function refreshShopify(organisation: OrganisationRecord, actor: Actor, trigger: "schedule" | "manual"): Promise<LoadRun> {
  const runId = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    if (!(await shopifyLoadsNightly(tx))) throw new ConflictError("No Shopify store is connected. An admin can connect one in Settings › Sales platforms.");
    const busy = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [
      SHOPIFY_LOAD_TABLE_NAME,
    ]);
    if (busy.rows.length > 0) throw new ConflictError("The Shopify data is already being copied.");
    const run = await tx.query<{ id: string }>(
      `insert into analytics_load_runs (source_id, source_name, table_name, file_name, trigger, requested_by_email)
       values (null, $1, $2, $3, $4, $5) returning id::text`,
      [SHOPIFY_SOURCE_NAME, SHOPIFY_LOAD_TABLE_NAME, SHOPIFY_FILE_NAME, trigger, trigger === "manual" ? actor.email : null],
    );
    return run.rows[0].id;
  });
  const started = performance.now();
  let rows: number | null = null;
  let error: string | null = null;
  let names: string[] = [];
  try {
    const tables = await withOrganisationTransaction(organisation, actor, (tx) => readShopifyTables(tx), { readOnly: true });
    names = tables.map((table) => table.name);
    rows = await replaceTableSet(organisation.id, SHOPIFY_TABLE_PREFIX, tables, "The Shopify data couldn't be copied");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const run = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const result = await tx.query<RunRow>(
      `update analytics_load_runs set status = $2, finished_at = now(), rows_loaded = $3, milliseconds = $4, error = $5 where id = $1 returning ${RUN_COLUMNS}`,
      [runId, error ? "failed" : "ok", rows === null ? null : String(rows), Math.round(performance.now() - started), error],
    );
    return toRun(result.rows[0]);
  });
  if (run.status === "ok") {
    try {
      await rebuildShapedTablesForTables(organisation, actor, names, trigger);
    } catch (caught) {
      console.warn("[tohyee] Shaped tables after copying Shopify:", caught instanceof Error ? caught.message : caught);
    }
  }
  return run;
}

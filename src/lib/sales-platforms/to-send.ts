import { businessTimeZone } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { dec, sum, toFixedString } from "@/lib/money/decimal";

/*
 * Sales › To send (example SWS11, decision 1571): the live list of Shopify
 * orders not yet fully sent. An order brought in under sales when sent goes
 * by what it still holds (so Mark as sent takes it off, SWS10); any other by
 * Shopify's own fulfilment status. Sent and cancelled orders aren't listed.
 */

export type OrderToSend = {
  connectionId: string;
  orderId: string;
  name: string;
  /** The invoice date, or the order's date before it's invoiced. */
  date: string | null;
  customer: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  total: string | null;
  status: "not_sent" | "part_sent" | "other";
  /** Shopify's status when it's something else (on hold, in progress...). */
  shopifyStatus: string | null;
  /** Held in Income in advance (sales when sent), or null when it isn't held. */
  held: string | null;
  /** What's still to send, when it's held. */
  toSend: string[];
  /** Mark as sent is open to it (SWS10): it's held and invoiced. */
  canMarkSent: boolean;
};

const DONE = ["FULFILLED", "RESTOCKED"];

export async function listOrdersToSend(tx: OrgTx): Promise<{ orders: OrderToSend[]; held: string; whenSentOn: boolean }> {
  const result = await tx.query<{
    connection_id: string;
    order_id: string;
    name: string | null;
    invoice_date: string | null;
    processed_on: string | null;
    customer: string | null;
    invoice_id: string | null;
    invoice_number: string | null;
    total: string | null;
    shopify_status: string | null;
    when_sent: boolean;
    held: string | null;
    part_sent: boolean | null;
    to_send: string[] | null;
  }>(
    `with held as (
       select connection_id, order_external_id,
              to_char(sum(amount - recognised_amount - refunded_amount) filter (where not closed), 'FM999999990.00') as held,
              bool_or(line_kind = 'line' and (sent_quantity > 0 or refunded_quantity > 0)) as part_sent,
              array_agg(description order by id) filter (where line_kind = 'line' and not closed) as to_send
         from sales_platform_held_lines group by connection_id, order_external_id having bool_or(not closed)
     )
     select d.connection_id::text, d.external_id as order_id, coalesce(d.name, od.order_name) as name, i.invoice_date::text,
            (od.processed_at at time zone $2)::date::text as processed_on, c.name as customer, i.id::text as invoice_id, i.invoice_number,
            i.total::text, od.fulfilment_status as shopify_status, d.sales_when_sent as when_sent, h.held, h.part_sent, h.to_send
       from sales_platform_documents d
       join sales_platform_connections conn on conn.id = d.connection_id and conn.platform = 'shopify'
       left join sales_platform_order_details od on od.connection_id = d.connection_id and od.order_external_id = d.external_id
       left join sales_invoices i on i.id = d.invoice_id
       left join contacts c on c.id = d.contact_id
       left join held h on h.connection_id = d.connection_id and h.order_external_id = d.external_id
      where d.record_kind = 'order' and d.state <> 'cancelled'
        and (case when d.sales_when_sent then h.held is not null
                  else od.fulfilment_status is not null and od.fulfilment_status <> all($1::text[]) end)
      order by coalesce(i.invoice_date, (od.processed_at at time zone $2)::date), d.external_id`,
    [DONE, businessTimeZone()],
  );
  const orders = result.rows.map((row): OrderToSend => {
    const status: OrderToSend["status"] = row.when_sent
      ? row.part_sent
        ? "part_sent"
        : "not_sent"
      : row.shopify_status === "UNFULFILLED"
        ? "not_sent"
        : row.shopify_status === "PARTIALLY_FULFILLED"
          ? "part_sent"
          : "other";
    return {
      connectionId: row.connection_id,
      orderId: row.order_id,
      name: row.name ?? row.order_id,
      date: row.invoice_date ?? row.processed_on,
      customer: row.customer,
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      total: row.total,
      status,
      shopifyStatus: status === "other" ? row.shopify_status : null,
      held: row.held,
      toSend: row.when_sent ? (row.to_send ?? []) : [],
      canMarkSent: row.when_sent && row.held !== null && row.invoice_id !== null,
    };
  });
  const held = sum(orders.flatMap((order) => (order.held ? [dec(order.held)] : [])));
  const on = await tx.query("select 1 from sales_platform_connections where platform = 'shopify' and status <> 'disconnected' and sales_when_sent_account_id is not null");
  return { orders, held: toFixedString(held, 2), whenSentOn: (on.rowCount ?? 0) > 0 };
}

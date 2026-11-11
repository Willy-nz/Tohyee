import type { OrgTx } from "@/lib/db/org-transaction";
import { writeAuditEvent } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import { requireArray, requireId } from "@/lib/validation";

/*
 * "Apply Sales when sent to orders already invoiced" (SWS13, decision 1583):
 * Shopify orders invoiced in full to sales before Sales when sent applied to
 * them, that Shopify hasn't marked fully sent. Choosing them marks them for
 * the next sync, which holds what's still to be sent (holdAfterInvoicing):
 * one journal per order, linked in the sync log to its invoice. The invoice
 * and its payment aren't touched.
 */

export type OrderToApply = { orderId: string; name: string | null; invoiceId: string; invoiceNumber: string; invoiceDate: string; total: string; shopifyStatus: string | null; chosen: boolean };

const SENT = ["FULFILLED", "RESTOCKED"];

/** The preview: each such order for this store, with its invoice. */
export async function ordersToApplyWhenSent(tx: OrgTx, connectionIdInput: unknown): Promise<{ held: string | null; orders: OrderToApply[] }> {
  const connectionId = requireId(connectionIdInput, "connectionId");
  const connection = await tx.query<{ held: string | null }>(
    "select a.code as held from sales_platform_connections c left join accounts a on a.id = c.sales_when_sent_account_id where c.id = $1 and c.platform = 'shopify'",
    [connectionId],
  );
  if (!connection.rows[0]) throw new ValidationError("That isn't a Shopify store connected here.");
  const rows = await tx.query<{ order_id: string; name: string | null; invoice_id: string; invoice_number: string; invoice_date: string; total: string; status: string | null; chosen: boolean }>(
    `select d.external_id as order_id, coalesce(d.name, od.order_name) as name, i.id::text as invoice_id, i.invoice_number, i.invoice_date::text, i.total::text,
            od.fulfilment_status as status, d.apply_when_sent as chosen
       from sales_platform_documents d
       join sales_invoices i on i.id = d.invoice_id and i.status <> 'voided'
       left join sales_platform_order_details od on od.connection_id = d.connection_id and od.order_external_id = d.external_id
      where d.connection_id = $1 and d.record_kind = 'order' and d.state = 'done' and not d.sales_when_sent
        and od.fulfilment_status is not null and od.fulfilment_status <> all($2::text[])
      order by i.invoice_date, d.external_id`,
    [connectionId, SENT],
  );
  return {
    held: connection.rows[0].held,
    orders: rows.rows.map((row) => ({
      orderId: row.order_id,
      name: row.name,
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      total: row.total,
      shopifyStatus: row.status,
      chosen: row.chosen,
    })),
  };
}

/** Marks the chosen orders for the next sync (SWS13). Needs Sales when sent on for the store. */
export async function applyWhenSentToInvoiced(tx: OrgTx, input: { connectionId: unknown; orderIds: unknown }): Promise<{ marked: number }> {
  const preview = await ordersToApplyWhenSent(tx, input.connectionId);
  if (!preview.held) throw new ValidationError("Turn on Sales when sent (recognise revenue when fulfilled) for this store first.");
  const wanted = new Set(requireArray(input.orderIds, "orderIds", 1000).map((id) => String(id)));
  const chosen = preview.orders.filter((order) => wanted.has(order.orderId)).map((order) => order.orderId);
  if (chosen.length === 0) throw new ValidationError("None of those orders can have Sales when sent applied.");
  await tx.query(
    "update sales_platform_documents set apply_when_sent = true, retry = true, updated_at = now() where connection_id = $1 and record_kind = 'order' and external_id = any($2::text[])",
    [requireId(input.connectionId, "connectionId"), chosen],
  );
  await writeAuditEvent(tx, { eventType: "sales_platform.apply_when_sent", entityType: "sales_platform_connection", entityId: String(input.connectionId), details: { orders: chosen.length } });
  return { marked: chosen.length };
}

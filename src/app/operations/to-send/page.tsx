"use client";

import Link from "next/link";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { SALES_PLATFORMS_HREF } from "@/components/navigation";
import { Badge, Button, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { todayIsoDate } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import type { OrderToSend } from "@/lib/sales-platforms/to-send";

const STATUS: Record<OrderToSend["status"], { tone: "amber" | "blue" | "neutral"; text: string }> = {
  not_sent: { tone: "amber", text: "Not sent" },
  part_sent: { tone: "blue", text: "Part sent" },
  other: { tone: "neutral", text: "In Shopify" },
};

/**
 * Sales › To send (SWS11, decision 1571): the live list of Shopify orders
 * not yet fully sent. With Sales when sent on, what each holds in Income in
 * advance and Mark as sent (SWS10) for one Shopify never marked fulfilled.
 */
function ToSend({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [version, setVersion] = useState(0);
  const list = useApiData<{ orders: OrderToSend[]; held: string; whenSentOn: boolean }>("/api/sales-platforms/to-send", { organisationId, v: version });
  const [days, setDays] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const today = todayIsoDate("Pacific/Auckland");
  const orders = list.data?.orders ?? [];
  const anyHeld = orders.some((order) => order.held !== null);

  async function mark(order: OrderToSend) {
    const sentOn = days[order.orderId] || today;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/sales-platforms/connections/${order.connectionId}/held/${order.orderId}/sent`, { method: "POST", body: { organisationId, sentOn } });
      setMessage({ tone: "success", text: `${order.name} marked as sent on ${formatDate(sentOn)}: ${order.held} moved to sales.` });
      setVersion((value) => value + 1);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (list.loading && !list.data) return <p className={ui.muted}>Loading…</p>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <p className={ui.muted} style={{ margin: 0 }}>
        {orders.length === 0 ? "Every Shopify order brought in has been sent." : `${orders.length} Shopify ${orders.length === 1 ? "order" : "orders"} not yet fully sent.`}{" "}
        {anyHeld || list.data?.whenSentOn ? (
          <>
            <strong>
              <Money value={list.data?.held ?? "0.00"} />
            </strong>{" "}
            is held in Income in advance until it&apos;s sent.
          </>
        ) : (
          <>
            Their sales count when they&apos;re paid. To count them when they&apos;re sent instead, turn on Sales when sent in{" "}
            <Link href={SALES_PLATFORMS_HREF}>Settings › Sales platforms</Link>.
          </>
        )}
      </p>
      {orders.length === 0 ? (
        <Empty>Nothing to send.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Status</th>
                <th>Still to send</th>
                <th className={ui.num}>Total</th>
                {anyHeld ? <th className={ui.num}>Held</th> : null}
                {anyHeld && can("bookkeeper") ? <th>Sent on</th> : null}
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={`${order.connectionId}:${order.orderId}`}>
                  <td data-label="Order">{order.invoiceId ? <Link href={`/operations/invoices/${order.invoiceId}`}>{order.name}</Link> : order.name}</td>
                  <td data-label="Customer">{order.customer}</td>
                  <td data-label="Date">{order.date ? formatDate(order.date) : ""}</td>
                  <td data-label="Status">
                    <Badge tone={STATUS[order.status].tone}>{order.status === "other" && order.shopifyStatus ? order.shopifyStatus.toLowerCase().replace(/_/g, " ") : STATUS[order.status].text}</Badge>
                  </td>
                  <td data-label="Still to send" className={ui.muted}>
                    {order.toSend.join(", ")}
                  </td>
                  <td data-label="Total" className={ui.num}>
                    <Money value={order.total} />
                  </td>
                  {anyHeld ? (
                    <td data-label="Held" className={ui.num}>
                      <Money value={order.held} />
                    </td>
                  ) : null}
                  {anyHeld && can("bookkeeper") ? (
                    <td data-label="Sent on">
                      {order.canMarkSent ? (
                        <div className={ui.actions}>
                          <input
                            type="date"
                            aria-label={`Day ${order.name} was sent`}
                            min={order.date ?? undefined}
                            max={today}
                            value={days[order.orderId] ?? today}
                            onChange={(event) => setDays({ ...days, [order.orderId]: event.target.value })}
                          />
                          <Button size="small" variant="secondary" disabled={busy} onClick={() => void mark(order)}>
                            Mark as sent
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={ui.muted} style={{ margin: 0 }}>
        Not sent and part sent come from Shopify. If Shopify never marked an order fulfilled but it has gone, mark it fulfilled in Shopify
        {anyHeld ? ", or, for an order held until it's sent, use Mark as sent here" : ""}.
      </p>
    </div>
  );
}

export default function ToSendPage() {
  return (
    <Page>
      <PageHeader title="To send" />
      <RequireOrganisation>{(organisationId) => <ToSend organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

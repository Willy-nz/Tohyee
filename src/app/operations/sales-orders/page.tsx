"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { SalesOrderStatusBadge } from "@/components/sales-orders/sales-order-editor";
import { Button, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { SalesOrderSummary } from "@/lib/sales-orders/service";

type SalesOrderPage = { salesOrders: SalesOrderSummary[]; nextBeforeId: string | null };

type Filter = { label: string; status: string | null; empty: string };

const FILTERS: Filter[] = [
  { label: "All", status: null, empty: "No sales orders yet." },
  { label: "Drafts", status: "draft", empty: "No draft sales orders." },
  { label: "Pending billing", status: "pending_billing", empty: "No sales orders waiting to be invoiced." },
  { label: "Partly billed", status: "partly_billed", empty: "No partly billed sales orders." },
  { label: "Billed", status: "billed", empty: "No billed sales orders." },
  { label: "Closed", status: "closed", empty: "No closed sales orders." },
  { label: "Cancelled", status: "cancelled", empty: "No cancelled sales orders." },
];

function SalesOrderList({ organisationId, filter }: { organisationId: string; filter: Filter }) {
  const { status } = filter;
  const baseCurrency = useWorkspace().current?.baseCurrency;
  const list = useApiData<SalesOrderPage>("/api/sales-orders", { organisationId, status });
  const [more, setMore] = useState<SalesOrderPage | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const salesOrders = [...(list.data?.salesOrders ?? []), ...(more?.salesOrders ?? [])];
  const nextBeforeId = more ? more.nextBeforeId : (list.data?.nextBeforeId ?? null);

  async function loadMore() {
    if (!nextBeforeId) return;
    try {
      const page = await api<SalesOrderPage>("/api/sales-orders", { query: { organisationId, status, beforeId: nextBeforeId } });
      setMore((current) => ({ salesOrders: [...(current?.salesOrders ?? []), ...page.salesOrders], nextBeforeId: page.nextBeforeId }));
    } catch (caught) {
      setMoreError(errorMessage(caught));
    }
  }

  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  if (salesOrders.length === 0) return <Empty>{filter.empty}</Empty>;
  return (
    <>
      {moreError ? <Notice tone="error">{moreError}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Number</th>
              <th>Customer</th>
              <th>Order date</th>
              <th>Expected</th>
              <th>Reference</th>
              <th>Status</th>
              <th className={ui.num}>Total</th>
            </tr>
          </thead>
          <tbody>
            {salesOrders.map((order) => (
              <tr key={order.id}>
                <td data-label="Number">
                  <Link href={`/operations/sales-orders/${order.id}`}>{order.soNumber ?? `Draft #${order.id}`}</Link>
                </td>
                <td data-label="Customer">{order.contactName}</td>
                <td data-label="Order date">{formatDate(order.orderDate)}</td>
                <td data-label="Expected">{order.expectedDate ? formatDate(order.expectedDate) : ""}</td>
                <td data-label="Reference" className={ui.muted}>
                  {order.reference}
                </td>
                <td data-label="Status">
                  <SalesOrderStatusBadge status={order.status} />
                </td>
                <td data-label="Total" className={ui.num}>
                  <Money value={order.total} />
                  {baseCurrency && order.currencyCode !== baseCurrency ? ` ${order.currencyCode}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextBeforeId ? (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load older sales orders
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SalesOrders({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(FILTERS[0]);
  return (
    <Card
      title="Sales orders"
      description="Latest entered first. Sales orders post nothing. Approving numbers an order; invoicing it makes a draft invoice for what's left to invoice."
      actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/sales-orders/new")}>New sales order</Button> : null}
    >
      <div className={ui.tabs} role="tablist" aria-label="Sales order status">
        {FILTERS.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={filter === entry}
            className={`${ui.tab} ${filter === entry ? ui.tabActive : ""}`}
            onClick={() => setFilter(entry)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <SalesOrderList key={filter.label} organisationId={organisationId} filter={filter} />
    </Card>
  );
}

export default function SalesOrdersPage() {
  return (
    <Page>
      <PageHeader title="Sales orders" description="What customers have ordered, and how much of it has been invoiced." />
      <RequireOrganisation>{(organisationId) => <SalesOrders organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

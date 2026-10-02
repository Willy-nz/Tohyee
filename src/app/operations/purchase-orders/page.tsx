"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { PurchaseOrderStatusBadge } from "@/components/purchase-orders/purchase-order-editor";
import { Button, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { PurchaseOrderSummary } from "@/lib/purchase-orders/service";

type ListPage = { purchaseOrders: PurchaseOrderSummary[]; nextBeforeId: string | null };

type Filter = { label: string; status: string | null; empty: string };

const FILTERS: Filter[] = [
  { label: "All", status: null, empty: "No purchase orders yet." },
  { label: "Drafts", status: "draft", empty: "No draft purchase orders." },
  { label: "Approved", status: "approved", empty: "No approved purchase orders waiting to be billed." },
  { label: "Billed", status: "billed", empty: "No billed purchase orders." },
  { label: "Closed", status: "closed", empty: "No closed purchase orders." },
  { label: "Cancelled", status: "cancelled", empty: "No cancelled purchase orders." },
];

function PurchaseOrderList({ organisationId, filter }: { organisationId: string; filter: Filter }) {
  const { status } = filter;
  const list = useApiData<ListPage>("/api/purchase-orders", { organisationId, status });
  const [more, setMore] = useState<ListPage | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const rows = [...(list.data?.purchaseOrders ?? []), ...(more?.purchaseOrders ?? [])];
  const nextBeforeId = more ? more.nextBeforeId : (list.data?.nextBeforeId ?? null);

  async function loadMore() {
    if (!nextBeforeId) return;
    try {
      const page = await api<ListPage>("/api/purchase-orders", { query: { organisationId, status, beforeId: nextBeforeId } });
      setMore((current) => ({ purchaseOrders: [...(current?.purchaseOrders ?? []), ...page.purchaseOrders], nextBeforeId: page.nextBeforeId }));
    } catch (caught) {
      setMoreError(errorMessage(caught));
    }
  }

  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  if (rows.length === 0) return <Empty>{filter.empty}</Empty>;
  return (
    <>
      {moreError ? <Notice tone="error">{moreError}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Number</th>
              <th>Supplier</th>
              <th>Date</th>
              <th>Delivery</th>
              <th>Reference</th>
              <th>Status</th>
              <th className={ui.num}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((order) => (
              <tr key={order.id}>
                <td data-label="Number">
                  <Link href={`/operations/purchase-orders/${order.id}`}>{order.poNumber ?? `Draft #${order.id}`}</Link>
                </td>
                <td data-label="Supplier">{order.contactName}</td>
                <td data-label="Date">{formatDate(order.orderDate)}</td>
                <td data-label="Delivery">{order.deliveryDate ? formatDate(order.deliveryDate) : ""}</td>
                <td data-label="Reference" className={ui.muted}>
                  {order.reference}
                </td>
                <td data-label="Status">
                  <PurchaseOrderStatusBadge status={order.status} />
                </td>
                <td data-label="Total" className={ui.num}>
                  <Money value={order.total} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextBeforeId ? (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load older purchase orders
          </Button>
        </div>
      ) : null}
    </>
  );
}

function PurchaseOrders({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(FILTERS[0]);
  return (
    <Card
      title="Purchase orders"
      description="Latest entered first. Purchase orders post nothing. Approving numbers one; copying it to a bill makes a draft bill with what's still to bill."
      actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/purchase-orders/new")}>New purchase order</Button> : null}
    >
      <div className={ui.tabs} role="tablist" aria-label="Purchase order status">
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
      <PurchaseOrderList key={filter.label} organisationId={organisationId} filter={filter} />
    </Card>
  );
}

export default function PurchaseOrdersPage() {
  return (
    <Page>
      <PageHeader title="Purchase orders" description="Orders to suppliers. An approved purchase order is copied to a bill when the supplier's invoice arrives." />
      <RequireOrganisation>{(organisationId) => <PurchaseOrders organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { SALES_ORDER_STATUS_LABELS, SalesOrderEditor } from "@/components/sales-orders/sales-order-editor";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { SalesOrder } from "@/lib/sales-orders/service";

function EditSalesOrder({ organisationId, salesOrderId }: { organisationId: string; salesOrderId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{ salesOrder: SalesOrder }>(`/api/sales-orders/${encodeURIComponent(salesOrderId)}`, { organisationId });
  const viewHref = `/operations/sales-orders/${encodeURIComponent(salesOrderId)}`;
  if (!can("bookkeeper") || !current) return <Notice tone="info">Only bookkeepers and admins can edit sales orders.</Notice>;
  if (details.error) return <Notice tone="error">{details.error}</Notice>;
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const { salesOrder } = details.data;
  if (salesOrder.status !== "draft") {
    return (
      <Notice tone="warning">
        {salesOrder.soNumber} is approved ({SALES_ORDER_STATUS_LABELS[salesOrder.status].toLowerCase()}), so it can&apos;t be edited.{" "}
        <Link href={viewHref}>Back to the sales order</Link>
      </Notice>
    );
  }
  return (
    <Card title={`Draft #${salesOrder.id}`}>
      <SalesOrderEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        salesOrder={salesOrder}
        onSaved={() => router.push(viewHref)}
        onCancel={() => router.push(viewHref)}
      />
    </Card>
  );
}

export default function EditSalesOrderPage() {
  const { salesOrderId } = useParams<{ salesOrderId: string }>();
  return (
    <Page>
      <PageHeader title="Edit draft sales order" description="Drafts can be changed freely until they're approved." />
      <RequireOrganisation>{(organisationId) => <EditSalesOrder organisationId={organisationId} salesOrderId={salesOrderId} />}</RequireOrganisation>
    </Page>
  );
}

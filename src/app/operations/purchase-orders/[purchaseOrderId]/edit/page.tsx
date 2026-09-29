"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { PurchaseOrderEditor } from "@/components/purchase-orders/purchase-order-editor";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { PurchaseOrder } from "@/lib/purchase-orders/service";

function EditPurchaseOrder({ organisationId, purchaseOrderId }: { organisationId: string; purchaseOrderId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${encodeURIComponent(purchaseOrderId)}`, { organisationId });
  const viewHref = `/operations/purchase-orders/${encodeURIComponent(purchaseOrderId)}`;
  if (!can("bookkeeper") || !current) return <Notice tone="info">Only bookkeepers and admins can edit purchase orders.</Notice>;
  if (details.error) return <Notice tone="error">{details.error}</Notice>;
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const { purchaseOrder } = details.data;
  if (purchaseOrder.status !== "draft") {
    return (
      <Notice tone="warning">
        {purchaseOrder.poNumber} is {purchaseOrder.status}, so it can&apos;t be edited. <Link href={viewHref}>Back to the purchase order</Link>
      </Notice>
    );
  }
  return (
    <Card title={`Draft #${purchaseOrder.id}`}>
      <PurchaseOrderEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        purchaseOrder={purchaseOrder}
        onSaved={() => router.push(viewHref)}
        onCancel={() => router.push(viewHref)}
      />
    </Card>
  );
}

export default function EditPurchaseOrderPage() {
  const { purchaseOrderId } = useParams<{ purchaseOrderId: string }>();
  return (
    <Page>
      <PageHeader title="Edit draft purchase order" description="Drafts can be changed freely until they're approved." />
      <RequireOrganisation>{(organisationId) => <EditPurchaseOrder organisationId={organisationId} purchaseOrderId={purchaseOrderId} />}</RequireOrganisation>
    </Page>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { PurchaseOrderEditor } from "@/components/purchase-orders/purchase-order-editor";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { OrganisationSettings } from "@/lib/organisations/settings";

function NewPurchaseOrder({ organisationId }: { organisationId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const settings = useApiData<{ settings: OrganisationSettings }>(`/api/organisations/${organisationId}/settings`);
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can create purchase orders.</Notice>;
  }
  if (!settings.data && !settings.error) return <p className={ui.muted}>Loading…</p>;
  return (
    <Card title="Draft purchase order">
      <PurchaseOrderEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        deliveryAddressDefault={settings.data?.settings.postalAddress ?? null}
        onSaved={(purchaseOrder) => router.push(`/operations/purchase-orders/${purchaseOrder.id}`)}
        onCancel={() => router.push("/operations/purchase-orders")}
      />
    </Card>
  );
}

export default function NewPurchaseOrderPage() {
  return (
    <Page>
      <PageHeader title="New purchase order" description="Save it as a draft first. Purchase orders never post to the ledger." />
      <RequireOrganisation>{(organisationId) => <NewPurchaseOrder organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

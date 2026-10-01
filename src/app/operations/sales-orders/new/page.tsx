"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { SalesOrderEditor } from "@/components/sales-orders/sales-order-editor";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewSalesOrder({ organisationId }: { organisationId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can create sales orders.</Notice>;
  }
  return (
    <Card title="Draft sales order">
      <SalesOrderEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        onSaved={(salesOrder) => router.push(`/operations/sales-orders/${salesOrder.id}`)}
        onCancel={() => router.push("/operations/sales-orders")}
      />
    </Card>
  );
}

export default function NewSalesOrderPage() {
  return (
    <Page>
      <PageHeader title="New sales order" description="Save it as a draft first. Sales orders never post to the ledger." />
      <RequireOrganisation>{(organisationId) => <NewSalesOrder organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

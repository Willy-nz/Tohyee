"use client";

import { useRouter } from "next/navigation";
import { BillEditor } from "@/components/bills/bill-editor";
import { RequireOrganisation } from "@/components/books";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewBill({ organisationId }: { organisationId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can enter bills.</Notice>;
  }
  return (
    <Card title="Draft bill">
      <BillEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        onSaved={(bill) => router.push(`/operations/bills/${bill.id}`)}
        onCancel={() => router.push("/operations/bills")}
      />
    </Card>
  );
}

export default function NewBillPage() {
  return (
    <Page>
      <PageHeader
        title="New bill"
        description="Enter a supplier's invoice and save it as a draft first. Nothing is posted to the ledger until you approve it."
      />
      <RequireOrganisation>{(organisationId) => <NewBill organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

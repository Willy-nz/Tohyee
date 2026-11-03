"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { RepeatingBillEditor } from "@/components/repeating/repeating-bill-editor";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewRepeatingBill({ organisationId }: { organisationId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can set up repeating bills.</Notice>;
  }
  return (
    <Card title="Repeating bill">
      <RepeatingBillEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        onSaved={(template) => router.push(`/operations/repeating-bills/${template.id}`)}
        onCancel={() => router.push("/operations/repeating-bills")}
      />
    </Card>
  );
}

export default function NewRepeatingBillPage() {
  return (
    <Page>
      <PageHeader title="New repeating bill" />
      <RequireOrganisation>{(organisationId) => <NewRepeatingBill organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

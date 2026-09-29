"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { RepeatingEditor } from "@/components/repeating/repeating-editor";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewRepeating({ organisationId }: { organisationId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can set up repeating invoices.</Notice>;
  }
  return (
    <Card title="Repeating invoice">
      <RepeatingEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        onSaved={(template) => router.push(`/operations/repeating-invoices/${template.id}`)}
        onCancel={() => router.push("/operations/repeating-invoices")}
      />
    </Card>
  );
}

export default function NewRepeatingInvoicePage() {
  return (
    <Page>
      <PageHeader title="New repeating invoice" description="Saving it posts nothing. Invoices are made on their dates by the hourly job." />
      <RequireOrganisation>{(organisationId) => <NewRepeating organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

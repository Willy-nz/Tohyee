"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { InvoiceEditor } from "@/components/invoices/invoice-editor";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewInvoice({ organisationId }: { organisationId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can create invoices.</Notice>;
  }
  return (
    <Card title="Draft invoice">
      <InvoiceEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        onSaved={(invoice) => router.push(`/operations/invoices/${invoice.id}`)}
        onCancel={() => router.push("/operations/invoices")}
      />
    </Card>
  );
}

export default function NewInvoicePage() {
  return (
    <Page>
      <PageHeader
        title="New invoice"
        description="Save it as a draft first. Nothing is posted to the ledger until you approve it."
      />
      <RequireOrganisation>{(organisationId) => <NewInvoice organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

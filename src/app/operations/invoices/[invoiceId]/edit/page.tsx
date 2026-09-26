"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { InvoiceEditor } from "@/components/invoices/invoice-editor";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Invoice } from "@/lib/invoices/service";

function EditInvoice({ organisationId, invoiceId }: { organisationId: string; invoiceId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{ invoice: Invoice }>(`/api/invoices/${encodeURIComponent(invoiceId)}`, { organisationId });
  const viewHref = `/operations/invoices/${encodeURIComponent(invoiceId)}`;

  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can edit invoices.</Notice>;
  }
  if (details.error) {
    return <Notice tone="error">{details.error}</Notice>;
  }
  if (!details.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  const { invoice } = details.data;
  if (invoice.status !== "draft") {
    return (
      <Notice tone="warning">
        {invoice.invoiceNumber} is {invoice.status}, so it can&apos;t be edited.{" "}
        {invoice.status === "approved" ? "Void it instead. " : ""}
        <Link href={viewHref}>Back to the invoice</Link>
      </Notice>
    );
  }
  return (
    <Card title={`Draft #${invoice.id}`}>
      <InvoiceEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        invoice={invoice}
        onSaved={() => router.push(viewHref)}
        onCancel={() => router.push(viewHref)}
      />
    </Card>
  );
}

export default function EditInvoicePage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  return (
    <Page>
      <PageHeader title="Edit draft invoice" description="Drafts can be changed freely until they're approved." />
      <RequireOrganisation>{(organisationId) => <EditInvoice organisationId={organisationId} invoiceId={invoiceId} />}</RequireOrganisation>
    </Page>
  );
}

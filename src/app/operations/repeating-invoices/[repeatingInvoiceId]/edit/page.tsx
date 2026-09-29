"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { RepeatingEditor } from "@/components/repeating/repeating-editor";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { RepeatingInvoice } from "@/lib/repeating/service";

function EditRepeating({ organisationId, id }: { organisationId: string; id: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{ repeatingInvoice: RepeatingInvoice }>(`/api/repeating-invoices/${encodeURIComponent(id)}`, { organisationId });
  const viewHref = `/operations/repeating-invoices/${encodeURIComponent(id)}`;
  if (!can("bookkeeper") || !current) return <Notice tone="info">Only bookkeepers and admins can change repeating invoices.</Notice>;
  if (details.error) return <Notice tone="error">{details.error}</Notice>;
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const template = details.data.repeatingInvoice;
  if (template.status === "ended") {
    return (
      <Notice tone="warning">
        This repeating invoice has ended, so it can&apos;t be changed. <Link href={viewHref}>Back to it</Link>
      </Notice>
    );
  }
  return (
    <Card title={`Repeating invoice to ${template.contactName}`}>
      <RepeatingEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        template={template}
        onSaved={() => router.push(viewHref)}
        onCancel={() => router.push(viewHref)}
      />
    </Card>
  );
}

export default function EditRepeatingInvoicePage() {
  const { repeatingInvoiceId } = useParams<{ repeatingInvoiceId: string }>();
  return (
    <Page>
      <PageHeader
        title="Change repeating invoice"
        description="Invoices already made keep what they had. Changing how often or the first date starts the new schedule from today."
      />
      <RequireOrganisation>{(organisationId) => <EditRepeating organisationId={organisationId} id={repeatingInvoiceId} />}</RequireOrganisation>
    </Page>
  );
}

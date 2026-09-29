"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { QuoteEditor } from "@/components/quotes/quote-editor";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Quote } from "@/lib/quotes/service";

function EditQuote({ organisationId, quoteId }: { organisationId: string; quoteId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{ quote: Quote }>(`/api/quotes/${encodeURIComponent(quoteId)}`, { organisationId });
  const viewHref = `/operations/quotes/${encodeURIComponent(quoteId)}`;
  if (!can("bookkeeper") || !current) return <Notice tone="info">Only bookkeepers and admins can edit quotes.</Notice>;
  if (details.error) return <Notice tone="error">{details.error}</Notice>;
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const { quote } = details.data;
  if (quote.status !== "draft") {
    return (
      <Notice tone="warning">
        {quote.quoteNumber} is {quote.status}, so it can&apos;t be edited. Copy it to make a new draft.{" "}
        <Link href={viewHref}>Back to the quote</Link>
      </Notice>
    );
  }
  return (
    <Card title={`Draft #${quote.id}`}>
      <QuoteEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        quote={quote}
        onSaved={() => router.push(viewHref)}
        onCancel={() => router.push(viewHref)}
      />
    </Card>
  );
}

export default function EditQuotePage() {
  const { quoteId } = useParams<{ quoteId: string }>();
  return (
    <Page>
      <PageHeader title="Edit draft quote" description="Drafts can be changed freely until they're finalised." />
      <RequireOrganisation>{(organisationId) => <EditQuote organisationId={organisationId} quoteId={quoteId} />}</RequireOrganisation>
    </Page>
  );
}

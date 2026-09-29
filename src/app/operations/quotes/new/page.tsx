"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { QuoteEditor } from "@/components/quotes/quote-editor";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewQuote({ organisationId }: { organisationId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can create quotes.</Notice>;
  }
  return (
    <Card title="Draft quote">
      <QuoteEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        onSaved={(quote) => router.push(`/operations/quotes/${quote.id}`)}
        onCancel={() => router.push("/operations/quotes")}
      />
    </Card>
  );
}

export default function NewQuotePage() {
  return (
    <Page>
      <PageHeader title="New quote" description="Save it as a draft first. Quotes never post to the ledger." />
      <RequireOrganisation>{(organisationId) => <NewQuote organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { PrintedDocumentView } from "@/components/documents/printed-document";
import { Page } from "@/components/ui";

export default function PrintPage() {
  const { quoteId } = useParams<{ quoteId: string }>();
  return (
    <Page>
      <RequireOrganisation>{(organisationId) => <PrintedDocumentView organisationId={organisationId} kind="quote" id={quoteId} />}</RequireOrganisation>
    </Page>
  );
}

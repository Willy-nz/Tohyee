"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { PrintedDocumentView } from "@/components/documents/printed-document";
import { Page } from "@/components/ui";

export default function PrintPage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  return (
    <Page>
      <RequireOrganisation>{(organisationId) => <PrintedDocumentView organisationId={organisationId} kind="invoice" id={invoiceId} />}</RequireOrganisation>
    </Page>
  );
}

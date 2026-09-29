"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { PrintedDocumentView } from "@/components/documents/printed-document";
import { Page } from "@/components/ui";

export default function PrintPage() {
  const { creditNoteId } = useParams<{ creditNoteId: string }>();
  return (
    <Page>
      <RequireOrganisation>{(organisationId) => <PrintedDocumentView organisationId={organisationId} kind="credit_note" id={creditNoteId} />}</RequireOrganisation>
    </Page>
  );
}

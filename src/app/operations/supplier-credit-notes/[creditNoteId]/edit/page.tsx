"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { SupplierCreditNoteEditor } from "@/components/supplier-credit-notes/supplier-credit-note-editor";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { SupplierCreditNote } from "@/lib/supplier-credit-notes/service";

function EditSupplierCreditNote({ organisationId, creditNoteId }: { organisationId: string; creditNoteId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{ creditNote: SupplierCreditNote }>(
    `/api/supplier-credit-notes/${encodeURIComponent(creditNoteId)}`,
    { organisationId },
  );
  const viewHref = `/operations/supplier-credit-notes/${encodeURIComponent(creditNoteId)}`;

  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can edit supplier credit notes.</Notice>;
  }
  if (details.error) {
    return <Notice tone="error">{details.error}</Notice>;
  }
  if (!details.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  const { creditNote } = details.data;
  if (creditNote.status !== "draft") {
    return (
      <Notice tone="warning">
        {creditNote.supplierCreditNoteNumber} is {creditNote.status}, so it can&apos;t be edited.{" "}
        {creditNote.status === "approved" ? "Void it instead. " : ""}
        <Link href={viewHref}>Back to the credit note</Link>
      </Notice>
    );
  }
  return (
    <Card title={`Draft ${creditNote.supplierCreditNoteNumber} from ${creditNote.contactName}`}>
      <SupplierCreditNoteEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        creditNote={creditNote}
        onSaved={() => router.push(viewHref)}
        onCancel={() => router.push(viewHref)}
      />
    </Card>
  );
}

export default function EditSupplierCreditNotePage() {
  const { creditNoteId } = useParams<{ creditNoteId: string }>();
  return (
    <Page>
      <PageHeader title="Edit draft supplier credit note" description="Drafts can be changed freely until they're approved." />
      <RequireOrganisation>
        {(organisationId) => <EditSupplierCreditNote organisationId={organisationId} creditNoteId={creditNoteId} />}
      </RequireOrganisation>
    </Page>
  );
}

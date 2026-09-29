"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { CreditNoteEditor, type CreditNoteStart } from "@/components/credit-notes/credit-note-editor";
import { useApiData } from "@/components/hooks";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Invoice } from "@/lib/invoices/service";

/** A new draft for an approved invoice's customer, with the invoice's lines copied for the user to edit. */
function fromInvoice(invoice: Invoice): CreditNoteStart {
  return {
    contactId: invoice.contactId,
    reference: invoice.invoiceNumber,
    amountsMode: invoice.amountsMode,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountCode: line.accountCode,
      taxCode: line.taxCode,
      tracking: line.tracking,
      customFields: line.customFields,
    })),
    customFields: invoice.customFields,
    salespersonId: invoice.salespersonId,
  };
}

function NewCreditNote({ organisationId, invoiceId }: { organisationId: string; invoiceId: string | null }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const invoice = useApiData<{ invoice: Invoice }>(
    invoiceId ? `/api/invoices/${encodeURIComponent(invoiceId)}` : null,
    { organisationId },
  );
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can create credit notes.</Notice>;
  }
  if (invoiceId && invoice.error) {
    return <Notice tone="error">{invoice.error}</Notice>;
  }
  if (invoiceId && !invoice.data) {
    return <p className={ui.muted}>Loading the invoice…</p>;
  }
  const source = invoice.data?.invoice ?? null;
  if (source && source.status !== "approved") {
    return (
      <Notice tone="warning">
        A credit note can only be created from an approved invoice.{" "}
        <Link href={`/operations/invoices/${source.id}`}>Back to the invoice</Link>
      </Notice>
    );
  }
  return (
    <Card
      title="Draft credit note"
      description={
        source ? `For ${source.contactName}, with ${source.invoiceNumber}'s lines copied. Change them to what you're crediting.` : undefined
      }
    >
      <CreditNoteEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        start={source ? fromInvoice(source) : undefined}
        onSaved={(creditNote) => router.push(`/operations/credit-notes/${creditNote.id}`)}
        onCancel={() => router.push(source ? `/operations/invoices/${source.id}` : "/operations/credit-notes")}
      />
    </Card>
  );
}

function NewCreditNoteFromQuery() {
  const invoiceId = useSearchParams().get("fromInvoice");
  return (
    <RequireOrganisation>
      {(organisationId) => <NewCreditNote key={invoiceId ?? ""} organisationId={organisationId} invoiceId={invoiceId} />}
    </RequireOrganisation>
  );
}

export default function NewCreditNotePage() {
  return (
    <Page>
      <PageHeader
        title="New credit note"
        description="Save it as a draft first. Nothing is posted to the ledger until you approve it."
      />
      <Suspense fallback={null}>
        <NewCreditNoteFromQuery />
      </Suspense>
    </Page>
  );
}

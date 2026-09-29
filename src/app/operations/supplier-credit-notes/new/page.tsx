"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import {
  SupplierCreditNoteEditor,
  type SupplierCreditNoteStart,
} from "@/components/supplier-credit-notes/supplier-credit-note-editor";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Bill } from "@/lib/bills/service";

/** A new draft for an approved bill's supplier, with the bill's lines copied for the user to edit. */
function fromBill(bill: Bill): SupplierCreditNoteStart {
  return {
    contactId: bill.contactId,
    reference: bill.supplierInvoiceNumber,
    amountsMode: bill.amountsMode,
    lines: bill.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountCode: line.accountCode,
      taxCode: line.taxCode,
      tracking: line.tracking,
      customFields: line.customFields,
      itemId: line.itemId,
      unitId: line.unitId,
    })),
    customFields: bill.customFields,
  };
}

function NewSupplierCreditNote({ organisationId, billId }: { organisationId: string; billId: string | null }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const bill = useApiData<{ bill: Bill }>(billId ? `/api/bills/${encodeURIComponent(billId)}` : null, {
    organisationId,
  });
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can create supplier credit notes.</Notice>;
  }
  if (billId && bill.error) {
    return <Notice tone="error">{bill.error}</Notice>;
  }
  if (billId && !bill.data) {
    return <p className={ui.muted}>Loading the bill…</p>;
  }
  const source = bill.data?.bill ?? null;
  if (source && source.status !== "approved") {
    return (
      <Notice tone="warning">
        A supplier credit note can only be created from an approved bill.{" "}
        <Link href={`/operations/bills/${source.id}`}>Back to the bill</Link>
      </Notice>
    );
  }
  return (
    <Card
      title="Draft supplier credit note"
      description={
        source
          ? `From ${source.contactName}, with bill ${source.supplierInvoiceNumber}'s lines copied. Change them to what the supplier's credit note says.`
          : undefined
      }
    >
      <SupplierCreditNoteEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        start={source ? fromBill(source) : undefined}
        onSaved={(creditNote) => router.push(`/operations/supplier-credit-notes/${creditNote.id}`)}
        onCancel={() => router.push(source ? `/operations/bills/${source.id}` : "/operations/supplier-credit-notes")}
      />
    </Card>
  );
}

function NewSupplierCreditNoteFromQuery() {
  const billId = useSearchParams().get("fromBill");
  return (
    <RequireOrganisation>
      {(organisationId) => <NewSupplierCreditNote key={billId ?? ""} organisationId={organisationId} billId={billId} />}
    </RequireOrganisation>
  );
}

export default function NewSupplierCreditNotePage() {
  return (
    <Page>
      <PageHeader
        title="New supplier credit note"
        description="Save it as a draft first. Nothing is posted to the ledger until you approve it."
      />
      <Suspense fallback={null}>
        <NewSupplierCreditNoteFromQuery />
      </Suspense>
    </Page>
  );
}

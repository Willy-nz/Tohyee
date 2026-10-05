"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BillEditor } from "@/components/bills/bill-editor";
import { InboxItemPreview } from "@/components/bills/bills-inbox";
import { RequireOrganisation } from "@/components/books";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewBill({ organisationId, inboxItemId }: { organisationId: string; inboxItemId: string | null }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can enter bills.</Notice>;
  }
  const editor = (
    <Card title="Draft bill">
      <BillEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        inboxItemId={inboxItemId ?? undefined}
        onSaved={(bill) => router.push(`/operations/bills/${bill.id}`)}
        onCancel={() => router.push(inboxItemId ? "/operations/bills/inbox" : "/operations/bills")}
      />
    </Card>
  );
  if (!inboxItemId) return editor;
  // BI3: the file from the bills inbox beside the new draft.
  return (
    <>
      <InboxItemPreview organisationId={organisationId} itemId={inboxItemId} />
      {editor}
    </>
  );
}

function NewBillFromQuery() {
  const inboxItemId = useSearchParams().get("inboxItem");
  return <RequireOrganisation>{(organisationId) => <NewBill key={inboxItemId ?? ""} organisationId={organisationId} inboxItemId={inboxItemId} />}</RequireOrganisation>;
}

export default function NewBillPage() {
  return (
    <Page>
      <PageHeader
        title="New bill"
        description="Enter a supplier's invoice and save it as a draft first. Nothing is posted to the ledger until you approve it."
      />
      <Suspense fallback={null}>
        <NewBillFromQuery />
      </Suspense>
    </Page>
  );
}

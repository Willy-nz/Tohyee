"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { BillEditor } from "@/components/bills/bill-editor";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Bill } from "@/lib/bills/service";

function EditBill({ organisationId, billId }: { organisationId: string; billId: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{ bill: Bill }>(`/api/bills/${encodeURIComponent(billId)}`, { organisationId });
  const viewHref = `/operations/bills/${encodeURIComponent(billId)}`;

  if (!can("bookkeeper") || !current) {
    return <Notice tone="info">Only bookkeepers and admins can edit bills.</Notice>;
  }
  if (details.error) {
    return <Notice tone="error">{details.error}</Notice>;
  }
  if (!details.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  const { bill } = details.data;
  if (bill.status !== "draft") {
    return (
      <Notice tone="warning">
        Bill {bill.supplierInvoiceNumber} is {bill.status}, so it can&apos;t be edited.{" "}
        {bill.status === "approved" ? "Void it instead. " : ""}
        <Link href={viewHref}>Back to the bill</Link>
      </Notice>
    );
  }
  return (
    <Card title={`Draft bill #${bill.id}`}>
      <BillEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        bill={bill}
        onSaved={() => router.push(viewHref)}
        onCancel={() => router.push(viewHref)}
      />
    </Card>
  );
}

export default function EditBillPage() {
  const { billId } = useParams<{ billId: string }>();
  return (
    <Page>
      <PageHeader title="Edit draft bill" description="Drafts can be changed freely until they're approved." />
      <RequireOrganisation>{(organisationId) => <EditBill organisationId={organisationId} billId={billId} />}</RequireOrganisation>
    </Page>
  );
}

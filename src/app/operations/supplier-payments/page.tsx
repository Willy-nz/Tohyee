"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { PaymentBatchList } from "@/components/payments/payment-batch";
import { Button, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

export default function SupplierPaymentsPage() {
  const { can } = useWorkspace();
  const router = useRouter();
  return (
    <Page>
      <PageHeader
        title="Payments for several bills"
        description="Each one is posted as one journal with one bank line. Payments for a single bill are on the bill itself."
        actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/supplier-payments/new")}>Pay bills</Button> : null}
      />
      <RequireOrganisation>{(organisationId) => <PaymentBatchList kind="supplier" organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

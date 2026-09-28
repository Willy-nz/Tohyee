"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { PaymentBatchList } from "@/components/payments/payment-batch";
import { Button, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

export default function CustomerPaymentsPage() {
  const { can } = useWorkspace();
  const router = useRouter();
  return (
    <Page>
      <PageHeader
        title="Payments for several invoices"
        description="Each one is posted as one journal with one bank line. Payments for a single invoice are on the invoice itself."
        actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/customer-payments/new")}>Receive a payment</Button> : null}
      />
      <RequireOrganisation>{(organisationId) => <PaymentBatchList kind="customer" organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

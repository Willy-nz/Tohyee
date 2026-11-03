"use client";

import { RequireOrganisation } from "@/components/books";
import { NewPaymentBatch } from "@/components/payments/payment-batch";
import { Page, PageHeader } from "@/components/ui";

export default function NewCustomerPaymentsPage() {
  return (
    <Page>
      <PageHeader title="Receive a payment" />
      <RequireOrganisation>{(organisationId) => <NewPaymentBatch kind="customer" organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

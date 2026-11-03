"use client";

import { RequireOrganisation } from "@/components/books";
import { NewPaymentBatch } from "@/components/payments/payment-batch";
import { Page, PageHeader } from "@/components/ui";

export default function NewSupplierPaymentsPage() {
  return (
    <Page>
      <PageHeader title="Pay bills" />
      <RequireOrganisation>{(organisationId) => <NewPaymentBatch kind="supplier" organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

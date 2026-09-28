"use client";

import { RequireOrganisation } from "@/components/books";
import { NewPaymentBatch } from "@/components/payments/payment-batch";
import { Page, PageHeader } from "@/components/ui";

export default function NewSupplierPaymentsPage() {
  return (
    <Page>
      <PageHeader
        title="Pay bills"
        description="One payment to a supplier for several bills: type what's paid on each. It's posted as one journal with one bank line, so it matches one line on the bank statement."
      />
      <RequireOrganisation>{(organisationId) => <NewPaymentBatch kind="supplier" organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

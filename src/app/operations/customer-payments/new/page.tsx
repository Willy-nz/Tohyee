"use client";

import { RequireOrganisation } from "@/components/books";
import { NewPaymentBatch } from "@/components/payments/payment-batch";
import { Page, PageHeader } from "@/components/ui";

export default function NewCustomerPaymentsPage() {
  return (
    <Page>
      <PageHeader
        title="Receive a payment"
        description="One payment from a customer for several invoices: type what's paid on each. It's posted as one journal with one bank line, so it matches one line on the bank statement."
      />
      <RequireOrganisation>{(organisationId) => <NewPaymentBatch kind="customer" organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

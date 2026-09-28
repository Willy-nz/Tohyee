"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { PaymentBatchView } from "@/components/payments/payment-batch";
import { Page, PageHeader } from "@/components/ui";

function Details() {
  const { batchId } = useParams<{ batchId: string }>();
  const recorded = useSearchParams().get("recorded") === "1";
  return (
    <RequireOrganisation>
      {(organisationId) => <PaymentBatchView kind="supplier" organisationId={organisationId} batchId={batchId} recorded={recorded} />}
    </RequireOrganisation>
  );
}

export default function SupplierPaymentsDetailsPage() {
  return (
    <Page>
      <PageHeader title="Payment for several bills" />
      <Suspense fallback={null}>
        <Details />
      </Suspense>
    </Page>
  );
}

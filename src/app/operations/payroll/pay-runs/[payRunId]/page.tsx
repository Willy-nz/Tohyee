"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayRunView } from "@/components/payroll-pay-runs";
import { Page, PageHeader } from "@/components/ui";

export default function PayRunPage() {
  const { payRunId } = useParams<{ payRunId: string }>();
  return (
    <Page>
      <PageHeader title="Pay run" />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={`${organisationId}:${payRunId}`} organisationId={organisationId}>
            <PayRunView organisationId={organisationId} payRunId={payRunId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}

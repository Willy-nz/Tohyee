"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayRunList } from "@/components/payroll-pay-runs";
import { Page, PageHeader } from "@/components/ui";

export default function PayRunsPage() {
  return (
    <Page>
      <PageHeader title="Pay runs" />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <PayRunList organisationId={organisationId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}

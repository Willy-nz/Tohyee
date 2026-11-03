"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { IrdPayments } from "@/components/payroll-payments";
import { Page, PageHeader } from "@/components/ui";

export default function IrdPaymentsPage() {
  return (
    <Page>
      <PageHeader title="IRD payments" />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <IrdPayments organisationId={organisationId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}

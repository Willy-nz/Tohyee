"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayrollPayItems } from "@/components/payroll-pay-items";
import { Page, PageHeader } from "@/components/ui";

export default function PayrollPayItemsPage() {
  return (
    <Page>
      <PageHeader title="Pay items" description="The earnings, deductions and employer contributions pay runs are made of, and where each is posted." />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <PayrollPayItems organisationId={organisationId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}

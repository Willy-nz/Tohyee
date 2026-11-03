"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayrollEmployees } from "@/components/payroll-employees";
import { Page, PageHeader } from "@/components/ui";

export default function PayrollEmployeesPage() {
  return (
    <Page>
      <PageHeader title="Payroll employees" />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <PayrollEmployees organisationId={organisationId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}

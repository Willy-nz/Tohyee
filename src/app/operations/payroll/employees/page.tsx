"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayrollEmployees } from "@/components/payroll-employees";
import { Page, PageHeader } from "@/components/ui";

export default function PayrollEmployeesPage() {
  return (
    <Page>
      <PageHeader
        title="Payroll employees"
        description="Employee payroll details, pay rates and where their pay is charged. Pay calculations, payments, payslips and payday filing are not supported yet."
      />
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

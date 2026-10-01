"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollEmployees } from "@/components/payroll-employees";
import { Page, PageHeader } from "@/components/ui";

export default function PayrollEmployeesPage() {
  return (
    <Page>
      <PageHeader
        title="Payroll employees"
        description="Employee payroll details only. Pay calculations, payments, payslips and payday filing are not supported yet."
      />
      <RequireOrganisation>{(organisationId) => <PayrollEmployees key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

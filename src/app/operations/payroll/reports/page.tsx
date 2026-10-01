"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayrollReports } from "@/components/payroll-reports";
import { Page, PageHeader } from "@/components/ui";

export default function PayrollReportsPage() {
  return (
    <Page>
      <PageHeader
        title="Payroll reports"
        description="Labour cost, the payroll summary, the reconciliation to the ledger, headcount and FTE, earnings history and PAYE, KiwiSaver and student loan, from approved pay runs by pay date. Only people with payroll access can see them."
      />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <PayrollReports organisationId={organisationId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}

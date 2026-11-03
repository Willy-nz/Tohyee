"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayrollReports } from "@/components/payroll-reports";
import { Page, PageHeader, Notice } from "@/components/ui";

export default function PayrollReportsPage() {
  return (
    <Page>
      <PageHeader title="Payroll reports" />
      <Notice>Only people with payroll access can see these.</Notice>
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

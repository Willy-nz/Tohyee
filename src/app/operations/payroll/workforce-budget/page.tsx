"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { WorkforceBudgets } from "@/components/payroll-workforce";
import { Page, PageHeader, Notice } from "@/components/ui";

export default function WorkforceBudgetPage() {
  return (
    <Page>
      <PageHeader title="Workforce budget" />
      <Notice>Only people with payroll access can see this.</Notice>
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <WorkforceBudgets organisationId={organisationId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}

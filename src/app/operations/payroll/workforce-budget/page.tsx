"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { WorkforceBudgets } from "@/components/payroll-workforce";
import { Page, PageHeader } from "@/components/ui";

export default function WorkforceBudgetPage() {
  return (
    <Page>
      <PageHeader
        title="Workforce budget"
        description="Budget wages by employee or position and month. Each workforce budget writes wages and employer KiwiSaver, by Department, into the budgets it feeds. Only people with payroll access can see it."
      />
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

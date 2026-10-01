"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayrollGroups } from "@/components/payroll-groups";
import { Page, PageHeader } from "@/components/ui";

export default function PayrollGroupsPage() {
  return (
    <Page>
      <PageHeader
        title="Pay groups and employee groups"
        description="Pay groups are the people paid together on one frequency. Employee groups are for reporting."
      />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <PayrollGroups organisationId={organisationId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}

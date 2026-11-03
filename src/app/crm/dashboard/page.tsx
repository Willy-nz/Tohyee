"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { DashboardPage } from "@/components/crm-dashboard";
import { Page, PageHeader } from "@/components/ui";

export default function CrmDashboardPage() {
  return (
    <Page>
      <PageHeader title="Dashboard" />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <DashboardPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

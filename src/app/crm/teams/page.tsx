"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { TeamsPage } from "@/components/crm-teams";
import { Page, PageHeader } from "@/components/ui";

export default function CrmTeamsPage() {
  return (
    <Page>
      <PageHeader title="Teams" description="CRM: sales teams and their managers." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <TeamsPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

"use client";

import { RequireOrganisation } from "@/components/books";
import { CrmHomePage, RequireCrm } from "@/components/crm";
import { Page, PageHeader } from "@/components/ui";

export default function CrmHome() {
  return (
    <Page>
      <PageHeader title="Home" description="CRM: the pipeline, conversion, your next actions and what the team has been doing." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <CrmHomePage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

"use client";

import { RequireOrganisation } from "@/components/books";
import { PipelinePage, RequireCrm } from "@/components/crm";
import { Page, PageHeader } from "@/components/ui";

export default function CrmPipelinePage() {
  return (
    <Page>
      <PageHeader title="Pipeline" description="CRM: opportunities from new to won." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <PipelinePage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

"use client";

import { RequireOrganisation } from "@/components/books";
import { PeoplePage, RequireCrm } from "@/components/crm";
import { Page, PageHeader } from "@/components/ui";

export default function CrmPeoplePage() {
  return (
    <Page>
      <PageHeader title="People" description="CRM: the people at the companies you deal with." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <PeoplePage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

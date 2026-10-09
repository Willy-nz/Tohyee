"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { DuplicatesPage } from "@/components/crm-duplicates";
import { Page, PageHeader } from "@/components/ui";

export default function CrmDuplicatesPage() {
  return (
    <Page>
      <PageHeader title="Duplicates" description="CRM: companies and people that look like the same one." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <DuplicatesPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

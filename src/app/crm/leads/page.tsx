"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { LeadsPage } from "@/components/crm-leads";
import { Page, PageHeader } from "@/components/ui";

export default function CrmLeadsPage() {
  return (
    <Page>
      <PageHeader title="Leads" description="CRM: enquiries to work, qualify and convert." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <LeadsPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

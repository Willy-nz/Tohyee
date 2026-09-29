"use client";

import { RequireOrganisation } from "@/components/books";
import { CompaniesPage, RequireCrm } from "@/components/crm";
import { Page, PageHeader } from "@/components/ui";

export default function CrmCompaniesPage() {
  return (
    <Page>
      <PageHeader title="Companies" description="CRM: your prospects, customers and suppliers." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <CompaniesPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { StagesManager } from "@/components/crm-stages";
import { Page, PageHeader } from "@/components/ui";

export default function CrmStagesPage() {
  return (
    <Page>
      <PageHeader
        title="Opportunity stages"
        description="The organisation's pipeline stages: their order, type, default probability and forecast category, and which stages each opportunity record type uses."
      />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <StagesManager key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

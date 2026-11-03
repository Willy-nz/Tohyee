"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { SequencesPage } from "@/components/crm-sequences";
import { Page, PageHeader } from "@/components/ui";

export default function CrmSequencesPage() {
  return (
    <Page>
      <PageHeader title="Sequences" />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <SequencesPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

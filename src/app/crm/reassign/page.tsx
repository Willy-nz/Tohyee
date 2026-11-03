"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { ReassignPage } from "@/components/crm-reassign";
import { Page, PageHeader } from "@/components/ui";

export default function CrmReassignPage() {
  return (
    <Page>
      <PageHeader title="Reassign records" />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <ReassignPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

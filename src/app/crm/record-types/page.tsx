"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { RecordTypesManager } from "@/components/crm-record-types";
import { Page, PageHeader } from "@/components/ui";

export default function CrmRecordTypesPage() {
  return (
    <Page>
      <PageHeader
        title="Record types"
        description="Kinds of company, person and opportunity, like a standard account or a funding body. Each has its own page layout: which fields show, in which sections, and which are required or read-only."
      />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <RecordTypesManager key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}

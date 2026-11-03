"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { RecordTypesManager } from "@/components/crm-record-types";
import { Page, PageHeader } from "@/components/ui";

export default function CrmRecordTypesPage() {
  return (
    <Page>
      <PageHeader title="Record types" />
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

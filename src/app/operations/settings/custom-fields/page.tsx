"use client";

import { RequireOrganisation } from "@/components/books";
import { CustomFieldsManager } from "@/components/custom-fields";
import { Page, PageHeader } from "@/components/ui";

export default function CustomFieldsSettingsPage() {
  return (
    <Page>
      <PageHeader
        title="Custom fields"
        description="Your own fields on contacts, documents, lines, and the CRM's people and opportunities, like a pet's name, an engraving, a grant code or a lead source. Fields are archived, never deleted."
      />
      <RequireOrganisation>{(organisationId) => <CustomFieldsManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

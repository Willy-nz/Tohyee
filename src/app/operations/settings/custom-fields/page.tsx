"use client";

import { RequireOrganisation } from "@/components/books";
import { CustomFieldsManager } from "@/components/custom-fields";
import { Page, PageHeader } from "@/components/ui";

export default function CustomFieldsSettingsPage() {
  return (
    <Page>
      <PageHeader
        title="Custom fields"
        description="Your own fields on contacts, documents and lines, like a pet's name, an engraving or a grant code. Fields are archived, never deleted."
      />
      <RequireOrganisation>{(organisationId) => <CustomFieldsManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

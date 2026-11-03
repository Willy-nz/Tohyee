"use client";

import { RequireOrganisation } from "@/components/books";
import { CustomFieldsManager } from "@/components/custom-fields";
import { Page, PageHeader } from "@/components/ui";

export default function CustomFieldsSettingsPage() {
  return (
    <Page>
      <PageHeader title="Custom fields" />
      <RequireOrganisation>{(organisationId) => <CustomFieldsManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

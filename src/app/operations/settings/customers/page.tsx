"use client";

import { RequireOrganisation } from "@/components/books";
import { CustomerSettings } from "@/components/customers";
import { Page, PageHeader } from "@/components/ui";

export default function CustomerSettingsPage() {
  return (
    <Page>
      <PageHeader title="Customer settings" />
      <RequireOrganisation>{(organisationId) => <CustomerSettings key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

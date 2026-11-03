"use client";

import { RequireOrganisation } from "@/components/books";
import { SalesPlatformsManager } from "@/components/sales-platforms";
import { Page, PageHeader } from "@/components/ui";

export default function SalesPlatformsSettingsPage() {
  return (
    <Page>
      <PageHeader title="Sales platforms" />
      <RequireOrganisation>{(organisationId) => <SalesPlatformsManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

"use client";

import { RequireOrganisation } from "@/components/books";
import { SalesPlatformsManager } from "@/components/sales-platforms";
import { Page, PageHeader, Notice } from "@/components/ui";

export default function SalesPlatformsSettingsPage() {
  return (
    <Page>
      <PageHeader title="Sales platforms" />
      <Notice>Admins connect shops; everyone can read the sync log.</Notice>
      <RequireOrganisation>{(organisationId) => <SalesPlatformsManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

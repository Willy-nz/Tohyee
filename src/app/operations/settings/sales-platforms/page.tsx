"use client";

import { RequireOrganisation } from "@/components/books";
import { SalesPlatformsManager } from "@/components/sales-platforms";
import { Page, PageHeader } from "@/components/ui";

export default function SalesPlatformsSettingsPage() {
  return (
    <Page>
      <PageHeader
        title="Sales platforms"
        description="Bring a Shopify store's customers and products into Tohyee, by a sync every 15 minutes and as they change. Admins connect stores; everyone can read the sync log."
      />
      <RequireOrganisation>{(organisationId) => <SalesPlatformsManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

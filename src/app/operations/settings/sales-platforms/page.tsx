"use client";

import { RequireOrganisation } from "@/components/books";
import { SalesPlatformsManager } from "@/components/sales-platforms";
import { Page, PageHeader } from "@/components/ui";

export default function SalesPlatformsSettingsPage() {
  return (
    <Page>
      <PageHeader
        title="Sales platforms"
        description="Connect your Shopify or WooCommerce shop, step by step: its customers and products come in, and its sales go into your accounts once you turn posting on. Admins connect shops; everyone can read the sync log."
      />
      <RequireOrganisation>{(organisationId) => <SalesPlatformsManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

"use client";

import { RequireOrganisation } from "@/components/books";
import { FixedAssetTypes } from "@/components/fixed-assets";
import { Page, PageHeader } from "@/components/ui";

export default function FixedAssetTypesPage() {
  return (
    <Page>
      <PageHeader title="Asset types" description="The accounts and default depreciation for each kind of asset, and how part months count." />
      <RequireOrganisation>{(organisationId) => <FixedAssetTypes key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

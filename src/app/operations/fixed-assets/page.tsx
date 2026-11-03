"use client";

import { RequireOrganisation } from "@/components/books";
import { FixedAssetList } from "@/components/fixed-assets";
import { Page, PageHeader } from "@/components/ui";

export default function FixedAssetsPage() {
  return (
    <Page>
      <PageHeader title="Fixed assets" />
      <RequireOrganisation>{(organisationId) => <FixedAssetList key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

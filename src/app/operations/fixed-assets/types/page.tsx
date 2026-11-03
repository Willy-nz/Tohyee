"use client";

import { RequireOrganisation } from "@/components/books";
import { FixedAssetTypes } from "@/components/fixed-assets";
import { Page, PageHeader } from "@/components/ui";

export default function FixedAssetTypesPage() {
  return (
    <Page>
      <PageHeader title="Asset types" />
      <RequireOrganisation>{(organisationId) => <FixedAssetTypes key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

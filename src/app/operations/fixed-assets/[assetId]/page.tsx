"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { FixedAssetView } from "@/components/fixed-assets";
import { Page, PageHeader } from "@/components/ui";

export default function FixedAssetPage() {
  const { assetId } = useParams<{ assetId: string }>();
  return (
    <Page>
      <PageHeader title="Fixed asset" />
      <RequireOrganisation>{(organisationId) => <FixedAssetView key={`${organisationId}:${assetId}`} organisationId={organisationId} assetId={assetId} />}</RequireOrganisation>
    </Page>
  );
}

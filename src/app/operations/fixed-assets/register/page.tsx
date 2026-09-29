"use client";

import { RequireOrganisation } from "@/components/books";
import { FixedAssetRegisterReport } from "@/components/fixed-assets";
import { Page, PageHeader } from "@/components/ui";

export default function FixedAssetRegisterPage() {
  return (
    <Page>
      <PageHeader title="Fixed asset register" />
      <RequireOrganisation>{(organisationId) => <FixedAssetRegisterReport key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

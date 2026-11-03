"use client";

import { RequireOrganisation } from "@/components/books";
import { DepreciationRuns } from "@/components/fixed-assets";
import { Page, PageHeader } from "@/components/ui";

export default function DepreciationPage() {
  return (
    <Page>
      <PageHeader title="Depreciation" />
      <RequireOrganisation>{(organisationId) => <DepreciationRuns key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

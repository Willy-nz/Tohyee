"use client";

import { RequireOrganisation } from "@/components/books";
import { FarmComparisonView } from "@/components/farm-comparison";
import { Page, PageHeader } from "@/components/ui";

export default function CompareFarmsPage() {
  return (
    <Page>
      <PageHeader title="All farms" description="Each farm's area, pasture readings and fertiliser plan side by side, with links to its records." />
      <RequireOrganisation>{(organisationId) => <FarmComparisonView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

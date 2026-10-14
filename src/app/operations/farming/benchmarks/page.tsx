"use client";

import { RequireOrganisation } from "@/components/books";
import { FarmBenchmarksView } from "@/components/farm-benchmarks";
import { Page, PageHeader } from "@/components/ui";

export default function FarmBenchmarksPage() {
  return (
    <Page>
      <PageHeader title="Farm benchmarks" description="Farm working expenses and revenue per kg of milk solids, hectare, cow and stock unit." />
      <RequireOrganisation>{(organisationId) => <FarmBenchmarksView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

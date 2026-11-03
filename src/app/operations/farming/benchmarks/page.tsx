"use client";

import { RequireOrganisation } from "@/components/books";
import { FarmBenchmarksView } from "@/components/farm-benchmarks";
import { Page, PageHeader } from "@/components/ui";

export default function FarmBenchmarksPage() {
  return (
    <Page>
      <PageHeader title="Farm benchmarks" />
      <RequireOrganisation>{(organisationId) => <FarmBenchmarksView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

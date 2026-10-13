"use client";

import { RequireOrganisation } from "@/components/books";
import { SoilHome } from "@/components/soil";
import { Page, PageHeader } from "@/components/ui";

export default function SoilTestsPage() {
  return (
    <Page>
      <PageHeader title="Soil tests" description="Each paddock's soil tests as the lab reported them, with the lab's report attached." />
      <RequireOrganisation>{(organisationId) => <SoilHome key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

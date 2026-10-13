"use client";

import { RequireOrganisation } from "@/components/books";
import { FarmingHome } from "@/components/farming";
import { Page, PageHeader } from "@/components/ui";

export default function FarmingPage() {
  return (
    <Page>
      <PageHeader title="Farms and paddocks" description="Your paddocks, their areas and boundaries, and where each came from." />
      <RequireOrganisation>{(organisationId) => <FarmingHome key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

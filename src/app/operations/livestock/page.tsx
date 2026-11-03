"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockOverview } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockOverviewPage() {
  return (
    <Page>
      <PageHeader title="Livestock" />
      <RequireOrganisation>{(organisationId) => <LivestockOverview key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

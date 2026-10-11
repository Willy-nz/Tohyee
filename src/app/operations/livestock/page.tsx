"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockOverview } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockOverviewPage() {
  return (
    <Page>
      <PageHeader title="Livestock" description="Head counts by class for the year: opening, births, purchases, sales, deaths and ageing, with the year-end count." />
      <RequireOrganisation>{(organisationId) => <LivestockOverview key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

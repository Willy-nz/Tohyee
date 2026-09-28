"use client";

import { RequireOrganisation } from "@/components/books";
import { AreaOverview } from "@/components/home/area-overview";
import { Page, PageHeader } from "@/components/ui";

export default function PurchasesOverviewPage() {
  return (
    <Page>
      <PageHeader title="Purchases" description="Bills, supplier credit notes and supplier payments." />
      <RequireOrganisation>{(organisationId) => <AreaOverview key={organisationId} organisationId={organisationId} area="purchases" />}</RequireOrganisation>
    </Page>
  );
}

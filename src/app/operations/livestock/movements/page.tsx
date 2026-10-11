"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockMovements } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockMovementsPage() {
  return (
    <Page>
      <PageHeader title="Livestock movements" description="Births, purchases, sales, deaths, class changes and moves, and stock held for others." />
      <RequireOrganisation>{(organisationId) => <LivestockMovements key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

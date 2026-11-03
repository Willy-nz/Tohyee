"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockMovements } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockMovementsPage() {
  return (
    <Page>
      <PageHeader title="Livestock movements" />
      <RequireOrganisation>{(organisationId) => <LivestockMovements key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

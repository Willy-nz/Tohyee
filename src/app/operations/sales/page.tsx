"use client";

import { RequireOrganisation } from "@/components/books";
import { AreaOverview } from "@/components/home/area-overview";
import { Page, PageHeader } from "@/components/ui";

export default function SalesOverviewPage() {
  return (
    <Page>
      <PageHeader title="Sales" description="Invoices, credit notes and customer payments." />
      <RequireOrganisation>{(organisationId) => <AreaOverview key={organisationId} organisationId={organisationId} area="sales" />}</RequireOrganisation>
    </Page>
  );
}

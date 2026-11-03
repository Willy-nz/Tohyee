"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockAccountSales } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockAccountSalesPage() {
  return (
    <Page>
      <PageHeader title="Account sales" />
      <RequireOrganisation>{(organisationId) => <LivestockAccountSales key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

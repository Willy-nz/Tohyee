"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockAccountSales } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockAccountSalesPage() {
  return (
    <Page>
      <PageHeader title="Account sales" description="Stock agents' account sales: the stock sold, the agent's deductions and the net the agent owes." />
      <RequireOrganisation>{(organisationId) => <LivestockAccountSales key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}

"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockValuation } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockValuationPage() {
  return (
    <Page>
      <PageHeader title="Livestock valuation" description="The year-end valuation under the herd scheme or national standard cost, the trading statement and the journal an accountant approves." />
      <RequireOrganisation>{(organisationId) => <LivestockValuation key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
